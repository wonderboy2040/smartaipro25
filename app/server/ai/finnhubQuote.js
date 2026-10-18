// ============================================================
// server/ai/finnhubQuote.js — v10.11 SHARED Finnhub REST quote
// ------------------------------------------------------------
// THE ASK (user plan #3): the EQUITY SIM (USDC stock-perp) desk's
// fallback chain was CoinDCX RT → Yahoo — slow and single-threaded.
// Finnhub becomes the FIRST fallback (Yahoo only when Finnhub
// fails / is rate-limited / is freshness-gated out).
//
// WHY A SHARED MODULE: index.js already had a private copy of this
// fetcher for the US desk (/api/quote). Two private copies = two
// independent call streams sharing ONE 60/min free-tier key — the
// GLOB desk could silently starve the US desk (or vice versa).
// One module = one micro-cache (in-flight promise sharing across
// BOTH desks — a symbol one desk just fetched is FREE for the
// other) + ONE sliding-window rate limiter that keeps the shared
// key inside the free-tier budget.
//
// HONESTY NOTES (unchanged from the index.js original):
//   • Finnhub free-tier REST /quote returns the PREVIOUS SESSION
//     CLOSE while the US market is OPEN (2026 realtime audit RC1,
//     verified live: REST said QQQ 716.47 Friday-close while
//     Yahoo + the WS trade stream said 713.36). isStaleUsQuote
//     rejects those → callers fall through to Yahoo. So
//     "Finnhub first" can NEVER serve an open-market stale quote.
//   • Outside US hours the last close IS the current price →
//     Finnhub serves it cleanly (exactly when the 24/7 USDC
//     perps need a fallback most).
// ============================================================
import { usMarketOpen, isStaleUsQuote } from '../usStream.js';

const FINNHUB_CACHE_MS = 3000;   // micro-cache + in-flight promise sharing
const FINNHUB_RATE_LIMIT = 55;   // free tier = 60 calls/min → 5 headroom
const _microCache = new Map();   // sym -> { ts, promise }
const _callTimes = [];           // sliding 60s window of REAL upstream calls

// test injection (default: global fetch — Node 18+)
let _fetchImpl = null;
export function _setFinnhubFetchForTest(fn) { _fetchImpl = fn; }
export function __resetFinnhubForTests() {
  _microCache.clear();
  _callTimes.length = 0;
  _fetchImpl = null;
}
export function __finnhubStateForTests() {
  return { cached: _microCache.size, callsLastMin: _callTimes.length };
}

/** Sliding-window budget guard — true when another upstream call
 *  fits inside the shared free-tier minute. */
function _budgetLeft(now = Date.now()) {
  while (_callTimes.length && now - _callTimes[0] > 60_000) _callTimes.shift();
  return _callTimes.length < FINNHUB_RATE_LIMIT;
}

/**
 * Finnhub REST quote for a plain US ticker (AAPL, QQQ, …).
 * Returns { price, change, high, low, volume, prevClose, time,
 * source: 'finnhub-realtime' } — or null (no key / over budget /
 * upstream failure / freshness-gated). NEVER throws.
 */
export async function fetchFinnhubQuote(plainSym) {
  const key = process.env.FINNHUB_API_KEY || '';
  if (!key || !plainSym) return null;
  const sym = String(plainSym).toUpperCase();
  const hit = _microCache.get(sym);
  if (hit && Date.now() - hit.ts < FINNHUB_CACHE_MS) return hit.promise;
  // Shared-key rate guard: over budget → honest null IMMEDIATELY
  // (callers fall to Yahoo; the US desk's WS path is unaffected).
  if (!_budgetLeft()) return null;
  const promise = _fetchFinnhubQuoteUncached(sym, key);
  _microCache.set(sym, { ts: Date.now(), promise });
  // opportunistic cleanup — custom watchlists can't grow this forever
  if (_microCache.size > 500) {
    const cutoff = Date.now() - FINNHUB_CACHE_MS * 2;
    for (const [k, v] of _microCache) if (v.ts < cutoff) _microCache.delete(k);
  }
  return promise;
}

async function _fetchFinnhubQuoteUncached(plainSym, key) {
  try {
    _callTimes.push(Date.now()); // account BEFORE the round-trip (failures cost quota too)
    const f = _fetchImpl || globalThis.fetch;
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(plainSym)}&token=${key}`;
    const r = await f(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    // c=current, d=change, dp=percent, h=high, l=low, pc=prevClose, t=epoch(s)
    if (!j || typeof j.c !== 'number' || j.c <= 0) return null;
    // 2026 realtime audit (RC1): Finnhub free-tier REST /quote returns the
    // PREVIOUS SESSION CLOSE (t = last close, e.g. Friday 4pm ET) while the
    // US market is OPEN — verified live: REST said QQQ 716.47 (Friday close)
    // while Yahoo + the WS trade stream said 713.36/713.68. Rejecting the
    // stale quote here lets callers fall through to the live Yahoo path.
    if (isStaleUsQuote(j.t ? j.t * 1000 : 0, Date.now(), usMarketOpen())) return null;
    return {
      price: j.c,
      change: typeof j.dp === 'number' ? j.dp : (j.pc ? ((j.c - j.pc) / j.pc) * 100 : 0),
      high: j.h || j.c,
      low: j.l || j.c,
      volume: 0,
      prevClose: j.pc || j.c,
      time: (j.t ? j.t * 1000 : Date.now()),
      source: 'finnhub-realtime',
    };
  } catch { return null; }
}
