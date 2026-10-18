// ============================================================
// server/ai/growwQuote.js — v10.12 SHARED Groww NSE realtime quote
// ------------------------------------------------------------
// THE ASK (user India plan #2 — "faster retry / backoff on Groww
// failures"): previously a failed Groww round-trip just resolved
// null and the symbol waited for the next natural 3s poll tick —
// a single transient network blip cost a full poll interval, and a
// symbol that was erroring PERSISTENTLY kept being hammered at the
// same cadence as the healthy ones (hurting the shared micro-cache
// budget for symbols that WERE working).
//
// This module (lifted verbatim out of index.js, same pattern as
// v10.11's finnhubQuote.js) adds two behaviors on top of the
// byte-identical 3s micro-cache + in-flight promise sharing:
//
//   1. QUICK JITTERED RETRY — one immediate retry after ~300-500ms
//      INSIDE the same fetch cycle. A transient blip recovers in
//      the SAME cycle instead of costing a full 3s poll interval.
//      (The in-flight promise is shared, so every concurrent
//      consumer rides the one retry — no extra upstream cost.)
//
//   2. PER-SYMBOL FAIL-STREAK BACKOFF — after 2 consecutive fully-
//      failed fetch cycles (each already including the retry, i.e.
//      4 upstream misses ≈ 6s of real failure) that ONE symbol is
//      skipped for one poll cycle (~4.5s): calls return null
//      IMMEDIATELY with zero upstream traffic, callers fall back to
//      Yahoo honestly, and the probe resumes after the hold. One
//      success anywhere resets the streak + hold. The steady state
//      for a persistently-erroring symbol is half-rate probing —
//      never silent, never frozen, never hammering.
//
// Consumers unchanged (they all import this from index.js's wiring):
// /api/quote (browser polls), the intraday scanner (87 symbols/scan),
// the SSE quote watcher, the India inStream 3s poller, intraday
// quotes stream, MCP toolContext.
// ============================================================

// v21.6 ULTRAFAST: 3000 → 1500 — the live rate test (2026-10-12) held
// 20 req/s sustained for 10s with 73ms avg latency and ZERO failures on
// this public CDN endpoint, so a 1.5s shared window for the desk's
// bounded watch set (~30 symbols ≈ 20 req/s worst case shared across
// ALL consumers: /api/quote, SSE poller, intraday scanner) is safely
// inside tolerance. In-flight promise sharing unchanged — N concurrent
// consumers still cost ONE round-trip per symbol per window.
const GROWW_CACHE_MS = 1500;
const GROWW_RETRY_MIN_MS = 300;     // quick-retry jitter window (plan: ~300-500ms)
const GROWW_RETRY_MAX_MS = 500;
const GROWW_BACKOFF_AFTER_FAILS = 2; // consecutive failed cycles → skip 1 cycle
const GROWW_BACKOFF_MS = 4500;       // ~one 3s poll cycle + margin
// v10.13 (deep-recheck M-2 stream): NSE-session freshness gate for
// lastTradeTime. The v10.12.1 live find proved Groww can serve a GROSSLY
// stale row that passes the price>0 check (IN_NIFTY 19425 with a Nov-2023
// lastTradeTime). Indices are now excluded upstream, but the same failure
// mode (WAF/CDN serving a previous-session row during market hours) would
// tag a stale stock quote 'groww-live'. While the NSE window is OPEN we
// therefore reject rows whose last trade predates TODAY's 09:15 session
// open (every listed symbol gets an opening-auction print by ~09:15, so a
// pre-session timestamp during live hours is garbage by definition) and
// rows with an absurd future clock (server-side skew/garbage). Same-session
// old timestamps are ACCEPTED — an illiquid stock that simply hasn't traded
// in 20 minutes still has an honest last-traded price.
const GROWW_SESSION_START_IST = 'T09:15:00+05:30';

// IST calendar key + session-start epoch for TODAY (cached per day).
let _sessionStartCache = { day: '', epochMs: 0 };
function _todayNseSessionStartMs(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now); // YYYY-MM-DD
  if (_sessionStartCache.day === day) return _sessionStartCache.epochMs;
  const epochMs = Date.parse(`${day}${GROWW_SESSION_START_IST}`);
  _sessionStartCache = { day, epochMs };
  return epochMs;
}
function _isStaleGrowwRow(lastTradeMs, nowMs) {
  if (!lastTradeMs || lastTradeMs <= 0) return false; // no timestamp → trust (unchanged behavior)
  // Absurd future clock (>60s ahead) → garbage.
  if (lastTradeMs > nowMs + 60_000) return true;
  // Freshness only matters while the NSE session is live.
  if (!nseWindow()) return false;
  const sessionStart = _todayNseSessionStartMs();
  if (!Number.isFinite(sessionStart)) return false; // date math failed → don't guess
  // During market hours a last trade from BEFORE today's 09:15 open is a
  // stale/previous-session row — exactly the observed garbage shape.
  return lastTradeMs < sessionStart;
}

const _microCache = new Map();      // sym -> { ts, promise }
const _failStreaks = new Map();     // sym -> consecutive failed fetch cycles
const _backoffUntil = new Map();    // sym -> epoch ms until which upstream is skipped

// v10.13 (deep-recheck M-2): keep the failure maps bounded. They were only
// cleared on SUCCESS — a symbol that never resolves (or an anonymous caller
// enumerating random symbol strings through the public /api/quote) left
// permanent entries. Same opportunistic >500 sweep as _microCache: drop
// expired backoffs and stale streaks; if still oversized (abuse), reset the
// streak map wholesale (worst case: a failing symbol re-arms after 2 more
// misses — bounded memory wins).
function _sweepFailureMaps() {
  if (_failStreaks.size <= 500 && _backoffUntil.size <= 500) return;
  const now = Date.now();
  for (const [k, until] of _backoffUntil) {
    if (until < now - 60_000) _backoffUntil.delete(k);
  }
  if (_failStreaks.size > 500) _failStreaks.clear();
}

// v10.13: nseWindow imported from inStream (single source of truth for the
// NSE session check — no circular import: inStream only pulls liveFeed).
import { nseWindow } from '../inStream.js';

// test injection (default: global fetch — Node 18+)
let _fetchImpl = null;
export function _setGrowwFetchForTest(fn) { _fetchImpl = fn; }
export function __resetGrowwForTests() {
  _microCache.clear();
  _failStreaks.clear();
  _backoffUntil.clear();
  _fetchImpl = null;
}
export function __growwStateForTests(sym) {
  return {
    failStreak: _failStreaks.get(sym) || 0,
    backoffUntil: _backoffUntil.get(sym) || 0,
    backoffActive: (_backoffUntil.get(sym) || 0) > Date.now(),
  };
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Normalize a caller's symbol to the clean NSE form. */
function _cleanSym(plainSym) {
  return String(plainSym || '').replace('.NS', '').replace('.BO', '').trim().toUpperCase();
}

/** ONE upstream Groww round-trip. Returns the quote object or null. */
async function _growwFetchOnce(sym) {
  try {
    const f = _fetchImpl || globalThis.fetch;
    const url = `https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/NSE/segment/CASH/${encodeURIComponent(sym)}/latest`;
    const r = await f(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const price = (typeof j.ltp === 'number' && j.ltp > 0) ? j.ltp
      : (typeof j.close === 'number' && j.close > 0) ? j.close : 0;
    if (!price) return null;
    const lastTradeMs = (typeof j.lastTradeTime === 'number' && j.lastTradeTime > 0) ? j.lastTradeTime * 1000 : 0;
    // v10.13 (deep-recheck M-2): grossly-stale row guard — a previous-session
    // or garbage-clock lastTradeTime during live hours must NOT be served
    // (and must NOT be tagged groww-live downstream). Returning null here
    // runs the normal failure path: quick retry, then honest Yahoo fallback
    // in the callers.
    if (_isStaleGrowwRow(lastTradeMs, Date.now())) return null;
    // v11.1 GAP 2 (circuit guard): Groww's payload carries the day's
    // price band natively — highPriceRange/lowPriceRange = the upper/
    // lower circuit (±band on prev close) the broker enforces. Same
    // fetch, two extra fields — zero upstream cost. Validated numbers
    // only; absent/garbage bands degrade to null (guard stays inert).
    const bandOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
    const upperCircuit = bandOf(j.highPriceRange);
    const lowerCircuit = bandOf(j.lowPriceRange);
    return {
      price,
      change: typeof j.dayChangePerc === 'number' ? j.dayChangePerc : 0,
      high: j.high || price,
      low: j.low || price,
      volume: j.volume || 0,
      prevClose: (j.ltp && j.dayChange != null) ? (j.ltp - j.dayChange) : price,
      time: (lastTradeMs || Date.now()),
      ...(upperCircuit && lowerCircuit && upperCircuit > lowerCircuit ? { upperCircuit, lowerCircuit } : {}),
      source: 'groww-nse-realtime',
    };
  } catch { return null; }
}

/**
 * REAL-TIME NSE quote via Groww's public live-price endpoint (the genuine
 * NSE last-traded price for stocks AND ETFs; works from cloud servers —
 * NSE's own API blocks datacenter IPs and Yahoo .NS is ~15-min delayed).
 *
 * Resolves the quote object (source: 'groww-nse-realtime') or null on
 * failure / during that symbol's one-cycle backoff hold. NEVER throws.
 * The 3s micro-cache with in-flight promise sharing is preserved
 * byte-for-byte from the old index.js inline copy — N concurrent
 * consumers still cost ONE upstream round-trip (+retry) per symbol.
 */
export async function fetchGrowwNseQuote(plainSym) {
  const sym = _cleanSym(plainSym);
  if (!sym) return null;

  // (#2) Per-symbol backoff hold: a symbol that JUST failed repeatedly is
  // skipped for one poll cycle. Honest null comes back instantly (callers
  // fall back to Yahoo) with ZERO upstream traffic — the shared cache
  // budget stays available for symbols that ARE working.
  const until = _backoffUntil.get(sym);
  if (until && Date.now() < until) return null;

  const hit = _microCache.get(sym);
  if (hit && Date.now() - hit.ts < GROWW_CACHE_MS) return hit.promise; // fresh OR still in-flight

  const promise = _fetchGrowwNseQuoteUncached(sym); // never throws — resolves null on failure
  _microCache.set(sym, { ts: Date.now(), promise });
  // Opportunistic cleanup so the map cannot grow unbounded with custom watchlists.
  if (_microCache.size > 500) {
    const cutoff = Date.now() - GROWW_CACHE_MS * 2;
    for (const [k, v] of _microCache) if (v.ts < cutoff) _microCache.delete(k);
  }
  _sweepFailureMaps(); // v10.13: bounded failure maps (public /api/quote enumeration)
  return promise;
}

async function _fetchGrowwNseQuoteUncached(sym) {
  // (#2.1) quick jittered retry — ONE immediate retry inside this cycle so
  // a transient blip doesn't cost a full 3s poll interval. In-flight
  // sharing means every concurrent consumer rides the same retry.
  let q = await _growwFetchOnce(sym);
  if (!q) {
    await _sleep(GROWW_RETRY_MIN_MS + Math.floor(Math.random() * (GROWW_RETRY_MAX_MS - GROWW_RETRY_MIN_MS)));
    q = await _growwFetchOnce(sym);
  }

  if (q) {
    // Success anywhere resets the symbol's failure state completely.
    _failStreaks.delete(sym);
    _backoffUntil.delete(sym);
    return q;
  }

  // (#2.2) per-symbol fail-streak → skip-one-cycle backoff. The streak
  // counts CONSECUTIVE fully-failed fetch cycles (retry included), so a
  // single blip that the retry absorbs never even reaches 1. While the
  // streak stays ≥ threshold, every failure re-arms the hold → steady
  // state is half-rate probing for THAT symbol only.
  const streak = (_failStreaks.get(sym) || 0) + 1;
  _failStreaks.set(sym, streak);
  if (streak >= GROWW_BACKOFF_AFTER_FAILS) {
    _backoffUntil.set(sym, Date.now() + GROWW_BACKOFF_MS);
  }
  return null;
}
