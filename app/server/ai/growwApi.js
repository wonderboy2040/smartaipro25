// ============================================================
// server/ai/growwApi.js — v21.6 OFFICIAL Groww Trading API tier
// ------------------------------------------------------------
// THE ASK (user ultrafast-realtime plan): "Intraday Tab Indian
// Market Direct Groww se live Ultrafast Realtime Websocket".
//
// LIVE-VERIFIED FACTS (2026-10-12, docs fetch + endpoint probes):
//   • Groww has NO public websocket — groww.in/socket.io 404s,
//     api.groww.in/v1/stream 404s, and the official Trading API
//     docs (groww.in/trade-api/docs/curl/live-data) list REST only
//     (quote / ltp / ohlc / option-chain). Even Groww's own web app
//     polls the same public tr_live_prices endpoint we use.
//   • THE OFFICIAL FAST PATH: /v1/live-data/ltp accepts up to 50
//     symbols per call at rate limits 10 req/s + 300 req/min for
//     the Live Data type — ONE batched call per second covers the
//     whole desk at TRUE 1s freshness. This module is that path.
//   • Auth: Bearer access token from POST /v1/token/api/access with
//     key_type 'approval' + SHA256(secret + epoch-seconds)
//     checksum (documented flow). Token endpoint budget: 150 calls
//     / 24h — we refresh ~once/day, comfortably inside it.
//
// TIERS (India realtime ladder, this module owns the top rung):
//   1. growwApi (THIS, env GROWW_API_KEY + GROWW_API_SECRET) —
//      official batched LTP @1s, source 'groww-api'.
//   2. growwQuote public CDN tier — per-symbol REST @1.5s
//      (v21.6: was 3s), source 'groww-live'. Always available,
//      zero keys.
//   3. Yahoo fallback (indices / misses), source 'yahoo-delayed'.
//
// LIFECYCLE: fully lazy — nothing runs until a consumer asks
// (inStream's 1s poll asks first). Token auto-refreshes at ~05:00
// IST (tokens die 06:00 IST) or on the first 401. Persistent
// failures arm a 5-minute circuit breaker so a dead/absent key
// costs ZERO upstream calls; consumers fall through to the public
// tier inside growwQuote without noticing. NEVER throws.
//
// Hermetic: no socket, no timer at import time — vitest-safe with
// injected fetch + fake timers.
// ============================================================
import crypto from 'node:crypto';

// ---- env (read once at import; keys are deployment-static) ----
const API_KEY = String(process.env.GROWW_API_KEY || '').trim();
const API_SECRET = String(process.env.GROWW_API_SECRET || '').trim();
const BASE = 'https://api.groww.in';

// ---- tuning ----
const LTP_CACHE_MS = 1000;          // 1s freshness (10 req/s limit, 50 syms/call)
const QUOTE_ENRICH_MS = 30_000;     // full quote (h/l/vol/prevClose) cadence
const TOKEN_REFRESH_AT_IST = 'T05:00:00+05:30'; // refresh before the 06:00 expiry
const BREAKER_FAILS = 3;            // consecutive failed cycles → breaker
const BREAKER_MS = 5 * 60_000;       // then hold off 5 minutes
const LTP_BATCH = 50;                // documented per-call cap
const UPSTREAM_TIMEOUT_MS = 4000;   // 1s tier needs a tight timeout

// ---- state ----
let _token = null;                   // { jwt, expiresHint }
let _tokenAt = 0;                    // epoch ms of last token fetch
let _tokenInFlight = null;          // shared token fetch promise
let _failStreak = 0;
let _breakerUntil = 0;
let _ltpCache = { at: 0, inFlight: null, map: new Map() };  // sym -> ltp number
const _quoteCache = new Map();       // sym -> { ts, promise } (enrichment)
let _fetchImpl = null;              // test injection
let _nowFn = () => Date.now();

// Enable matrix (the cxSpotWs hermetic pattern):
//   GROWW_API=0 → always off; unset/1 → on only when BOTH keys exist,
//   and always OFF under vitest (NODE_ENV=test) so no suite ever
//   touches the network.
const _enabled = process.env.GROWW_API === '0'
  ? false
  : process.env.GROWW_API === '1'
    ? true
    : process.env.NODE_ENV !== 'test';
const _armed = _enabled && API_KEY.length > 0 && API_SECRET.length > 0;

// ---------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------
export function _setGrowwApiFetchForTest(fn) { _fetchImpl = fn; }
export function _setGrowwApiNowForTest(fn) { _nowFn = fn || (() => Date.now()); }
export function _resetGrowwApiForTest() {
  _token = null; _tokenAt = 0; _tokenInFlight = null;
  _failStreak = 0; _breakerUntil = 0;
  _ltpCache = { at: 0, inFlight: null, map: new Map() };
  _quoteCache.clear();
  _fetchImpl = null;
  _nowFn = () => Date.now();
}
export function growwApiArmed() { return _armed; }

/** Diagnostics for /api/health + logs. Never throws, no upstream call. */
export function growwApiStatus() {
  return {
    armed: _armed,
    hasKey: API_KEY.length > 0,
    token: !!_token,
    tokenAgeMs: _tokenAt ? _nowFn() - _tokenAt : null,
    breakerActive: _nowFn() < _breakerUntil,
    failStreak: _failStreak,
    ltpFresh: _ltpCache.map.size > 0 && (_nowFn() - _ltpCache.at) <= LTP_CACHE_MS * 2,
  };
}

const _fetch = (url, opts) => (_fetchImpl || globalThis.fetch)(url, opts);

// ---------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------
/** Docs contract: checksum = SHA256(apiSecret + epochSeconds). */
function _checksum(secret, epochSec) {
  return crypto.createHash('sha256')
    .update(String(secret) + String(epochSec), 'utf8')
    .digest('hex');
}

/** True when the token is missing, >20h old, or past the next 05:00 IST
 *  refresh point (tokens expire 06:00 IST; refresh at 05:00 = 1h grace). */
function _tokenNeedsRefresh() {
  if (!_token) return true;
  const ageMs = _nowFn() - _tokenAt;
  if (ageMs > 20 * 3600 * 1000) return true;
  try {
    const nextRefresh = Date.parse(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(_nowFn()))
      + TOKEN_REFRESH_AT_IST
    );
    // If we fetched BEFORE today's 05:00 IST and it is now past it, refresh.
    return Number.isFinite(nextRefresh) && _tokenAt < nextRefresh && _nowFn() >= nextRefresh;
  } catch { return false; }
}

async function _getToken() {
  if (!_tokenNeedsRefresh()) return _token;
  if (_tokenInFlight) return _tokenInFlight;
  const p = (async () => {
    const epochSec = Math.floor(_nowFn() / 1000);
    const r = await _fetch(`${BASE}/v1/token/api/access`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-VERSION': '1.0',
      },
      body: JSON.stringify({
        key_type: 'approval',
        checksum: _checksum(API_SECRET, epochSec),
        timestamp: String(epochSec),
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`groww token ${r.status}`);
    const j = await r.json();
    const jwt = j?.token || j?.payload?.token;
    if (!jwt || typeof jwt !== 'string') throw new Error('groww token: no jwt');
    _token = { jwt };
    _tokenAt = _nowFn();
    return _token;
  })().catch((e) => { throw e; });
  _tokenInFlight = p;
  try { return await p; } finally { _tokenInFlight = null; }
}

// ---------------------------------------------------------------
// Failure accounting (public-tier falls through on any miss)
// ---------------------------------------------------------------
function _registerFail() {
  _failStreak++;
  if (_failStreak >= BREAKER_FAILS) {
    _breakerUntil = _nowFn() + BREAKER_MS;
    _failStreak = 0;
  }
}
function _registerOk() { _failStreak = 0; }

function _breakerOpen() { return _nowFn() < _breakerUntil; }

// ---------------------------------------------------------------
// Batched LTP — the 1s tier
// ---------------------------------------------------------------
/** ONE official LTP round for up to 50 symbols. Returns Map(sym->ltp).
 *  Chunks larger sets (51+ symbols = 2 calls, still ≤2 req/s). */
async function _ltpRound(symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += LTP_BATCH) {
    const chunk = symbols.slice(i, i + LTP_BATCH);
    const q = `segment=CASH&exchange_symbols=${chunk.map(s => `NSE_${encodeURIComponent(s)}`).join(',')}`;
    const r = await _fetch(`${BASE}/v1/live-data/ltp?${q}`, {
      headers: {
        'Authorization': `Bearer ${(await _getToken()).jwt}`,
        'Accept': 'application/json',
        'X-API-VERSION': '1.0',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (r.status === 401) {
      // token rejected → refresh once, retry this chunk once
      _token = null;
      const r2 = await _fetch(`${BASE}/v1/live-data/ltp?${q}`, {
        headers: {
          'Authorization': `Bearer ${(await _getToken()).jwt}`,
          'Accept': 'application/json',
          'X-API-VERSION': '1.0',
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!r2.ok) throw new Error(`groww ltp ${r2.status}`);
      _mergeLtp(out, await r2.json());
      continue;
    }
    if (!r.ok) throw new Error(`groww ltp ${r.status}`);
    _mergeLtp(out, await r.json());
  }
  return out;
}

function _mergeLtp(out, j) {
  const payload = j?.payload;
  if (!payload || typeof payload !== 'object') return;
  for (const [k, v] of Object.entries(payload)) {
    // key format "NSE_RELIANCE" (documented); value = ltp number
    const sym = String(k).startsWith('NSE_') ? String(k).slice(4) : String(k);
    const price = typeof v === 'number' ? v : parseFloat(String(v));
    if (sym && Number.isFinite(price) && price > 0) out.set(sym, price);
  }
}

/**
 * Batched 1s-fresh LTP for the given clean NSE symbols.
 * Resolves a Map(sym -> ltp) — EMPTY map when the tier is unarmed,
 * the breaker is open, or every upstream leg failed. Never throws.
 * In-flight deduped: N concurrent consumers ride ONE round.
 */
export async function growwApiLtp(symbols) {
  if (!_armed || _breakerOpen()) return new Map();
  const syms = [...new Set((symbols || [])
    .map(s => String(s || '').trim().toUpperCase().replace('.NS', '').replace('.BO', ''))
    .filter(Boolean))];
  if (syms.length === 0) return new Map();

  if (_ltpCache.inFlight) return _ltpCache.inFlight;
  if (_nowFn() - _ltpCache.at < LTP_CACHE_MS && _ltpCache.map.size > 0) {
    // serve from cache, filtered to the asked set
    const out = new Map();
    for (const s of syms) { const v = _ltpCache.map.get(s); if (v) out.set(s, v); }
    return out;
  }

  const p = (async () => {
    try {
      const fresh = await _ltpRound(syms);
      if (fresh.size > 0) {
        _ltpCache = { at: _nowFn(), inFlight: null, map: fresh };
        _registerOk();
        return fresh;
      }
      _registerFail();
    } catch {
      _registerFail();
    }
    // serve the stale map briefly rather than nothing (≤10s old only)
    const out = new Map();
    if (_nowFn() - _ltpCache.at < 10_000) {
      for (const s of syms) { const v = _ltpCache.map.get(s); if (v) out.set(s, v); }
    }
    return out;
  })();
  _ltpCache.inFlight = p;
  try { return await p; } finally { _ltpCache.inFlight = null; }
}

// ---------------------------------------------------------------
// Full-quote enrichment (h/l/volume/prevClose/circuits) — 30s cadence.
// The public tier (growwQuote.js) already carries these fields on its
// own 1.5s cache; this keeps the API tier self-sufficient when it is
// the ONLY armed source (e.g. a fresh deploy where the public cache
// is cold). Consumers merge both.
// ---------------------------------------------------------------
export async function growwApiQuote(sym) {
  if (!_armed || _breakerOpen()) return null;
  const s = String(sym || '').replace('.NS', '').replace('.BO', '').trim().toUpperCase();
  if (!s) return null;
  const hit = _quoteCache.get(s);
  if (hit && _nowFn() - hit.ts < QUOTE_ENRICH_MS) return hit.promise;
  const p = (async () => {
    try {
      const r = await _fetch(
        `${BASE}/v1/live-data/quote?exchange=NSE&segment=CASH&trading_symbol=${encodeURIComponent(s)}`,
        {
          headers: {
            'Authorization': `Bearer ${(await _getToken()).jwt}`,
            'Accept': 'application/json',
            'X-API-VERSION': '1.0',
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      if (!r.ok) throw new Error(`groww quote ${r.status}`);
      const j = await r.json();
      const d = j?.payload;
      if (!d || !(d.last_price > 0)) throw new Error('groww quote: empty');
      // ohlc arrives as a STRING like "{open: 149.50,high: 150.50,...}"
      const ohlc = _parseOhlcString(d.ohlc);
      return {
        price: d.last_price,
        change: typeof d.day_change_perc === 'number' ? d.day_change_perc : 0,
        high: ohlc?.high ?? (d.high_trade_range || d.last_price),
        low: ohlc?.low ?? (d.low_trade_range || d.last_price),
        volume: d.volume || 0,
        prevClose: ohlc?.close ?? undefined,
        time: d.last_trade_time || _nowFn(),
        upperCircuit: d.upper_circuit_limit > 0 ? d.upper_circuit_limit : undefined,
        lowerCircuit: d.lower_circuit_limit > 0 ? d.lower_circuit_limit : undefined,
        source: 'groww-api',
      };
    } catch {
      return null; // honest null — public tier owns this symbol then
    }
  })();
  _quoteCache.set(s, { ts: _nowFn(), promise: p });
  // opportunistic bound
  if (_quoteCache.size > 200) {
    const cutoff = _nowFn() - QUOTE_ENRICH_MS * 2;
    for (const [k, v] of _quoteCache) if (v.ts < cutoff) _quoteCache.delete(k);
  }
  return p;
}

/** Groww's documented ohlc field is a loose "{open: 1,high: 2,...}" STRING. */
function _parseOhlcString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const num = (name) => {
    const m = new RegExp(`${name}\\s*:\\s*([0-9.eE+-]+)`).exec(raw);
    const v = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(v) ? v : undefined;
  };
  const out = { open: num('open'), high: num('high'), low: num('low'), close: num('close') };
  return (out.high != null || out.close != null) ? out : null;
}
