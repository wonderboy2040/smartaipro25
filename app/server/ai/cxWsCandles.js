// ============================================================
// server/ai/cxWsCandles.js — v21.23.5 COINDCX ULTRAFAST WS CANDLE OVERLAY
// ------------------------------------------------------------
// USER REQUEST (verbatim): "ye Yahoo 15m — D1 isko direct CoinDCX
// Ultrafast websockets se replace nhi kar sakte kya — hota hai tho
// kardo accurately."
//
// LIVE-VERIFIED REALITY CHECK (probe 2026-10-19, this tree,
// scripts/probe-cx-candle-ws.mjs — 6 candidate channelName formats
// × both documented sockets × 130s = 2+ candle-close windows):
//   • wss://stream-spot.coindcx.com  (EIO=4) — healthy, price book flows
//   • wss://stream.coindcx.com       (EIO=4) — healthy, futures book flows
//   • candlestick channel formats (candlestick@B-BTC_USDT_15m,
//     candlestick_15m_B-BTC_USDT, candlestick_15m_B-BTC_INR, …)
//     → ZERO events on BOTH endpoints. CoinDCX's PUBLIC sockets push
//     ONLY ultrafast price books (currentPrices@spot@1s ~1s/INR ~10s
//     bursts + currentPrices@futures@rt ~1s) — NOT candles.
//
// THE ACCURATE IMPLEMENTATION: keep the proven REST candle chain as
// the SERIES ANCHOR (public.coindcx.com /market_data/candles +
// futures active_candles — official OHLCV, volume, history) and
// overlay the LIVE BAR from the CoinDCX ULTRAFAST WS price books.
// Effect on the 15m — D1 ladder (the MTF-6 votes, dual board rows,
// ultrafast verifier, /api/ai/candles charts):
//   WITHOUT overlay: the last (forming) bar goes stale for up to the
//     REST TTL — 15m bars 180s, 1h/4h/1d 300s, India Yahoo 15m 120s
//     — so every indicator vote computed mid-TTL sees the LAST
//     CLOSE as it was minutes ago (the exact "signal feels wrong /
//     late" experience).
//   WITH overlay: the last bar's close/high/low track the exchange
//     print within ~1s (spot INR bursts ~10s) — EMA/RSI/MACD/ROC
//     votes fire on the LIVE price; a bar roll appends a fresh live
//     bar (volume 0 until the next REST anchor — indicators in the
//     vote path read no volume; next anchor self-heals volume).
//
// DOMAIN SAFETY (the v20.9.3 lesson — an INR candle fed a USDT tick
// reads as a −98% crash):
//   • INR candles  ← spot WS book  `BTCINR`  rows ONLY
//   • USDT perp candles ← futures WS book `B-BTC_USDT` rows ONLY
//   • India .NS candles ← liveFeed `IN_<SYM>` (Groww live quote) ONLY
//   • Binance fallback candles ← NO overlay (cross-domain by design)
//   • ±35% sanity gate: a tick that far from the last close is a
//     domain error/hostile input, never a market move — ignored.
//
// ZERO-REGRESSION CONTRACT (the repo's v10.11 discipline):
//   • Overlay applies ONLY when the domain-matched book has a FRESH
//     tick; books are demand-driven (spot: cryptoStream/ticker demand,
//     futures: cxRtStream SSE clients, India: inStream SSE clients) —
//     no fresh book → the REST series is returned BYTE-IDENTICAL.
//   • Hermetic by construction: enabled-matrix OFF under NODE_ENV=test
//     (books are hermetic there anyway); every existing suite sees
//     exactly the pre-overlay behavior unless it opts in explicitly.
//   • The PURE core never mutates the caller's array (the REST chain
//     serves cached slices — mutation would poison the shared cache).
// ============================================================
import { spotWsPrice } from './cxSpotWs.js';
import { futBookSnapshot } from './cxBookState.js';
import { getTick as liveGetTick } from '../liveFeed.js';
// v21.23.11 MIRROR-SHIELD L2: overlay forming-bar = TRUE newest bar,
// chahe fetch-chain se kisi rare path me descending series aaye.
import { ensureAscending } from './lib/candles.js';

// ---- timeframe ladder (the 15m — D1 MTF-6 set + 1m/5m LTF legs) ----
export const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

// ---- freshness windows (each tick source's honest serve age) ----
const FUT_TICK_FRESH_MS = 45_000;    // futures book rows flow ~1s while subscribed
const INDIA_TICK_FRESH_MS = 180_000; // Groww SSE quotes tick every few seconds; 3m rides quiet gaps
/** A tick deviating more than this from the last close is a domain
 *  error (INR-tick-on-USDT-candles class) or hostile input — never
 *  a legit print inside one bar of a liquid pair. */
const TICK_SANITY_PCT = 0.35;

// ---- enable matrix (the cxSpotWs/cxRtStream pattern) ----
//   AI_CX_CANDLE_OVERLAY=1 → always on
//   AI_CX_CANDLE_OVERLAY=0 → always off
//   unset                 → on in production/development, OFF under
//     vitest (NODE_ENV=test) so no existing suite changes behavior.
let _enabled = process.env.AI_CX_CANDLE_OVERLAY === '1'
  ? true
  : process.env.AI_CX_CANDLE_OVERLAY === '0'
    ? false
    : process.env.NODE_ENV !== 'test';

// ---- test injection ----
let _nowFn = () => Date.now();
let _tickFns = null; // { spotInr(base), fut(base), india(symbol) } — hermetic tick sources
export function _setCxWsCandlesEnabledForTest(v) { _enabled = !!v; }
export function _setCxWsCandlesNowForTest(fn) { _nowFn = fn || (() => Date.now()); }
export function _setCxWsTickFnsForTest(fns) { _tickFns = fns || null; }

// ---- telemetry (bounded, honest — /api diagnostics + tests) ----
const _tel = {
  applied: 0, updated: 0, rolled: 0,
  skippedStale: 0, skippedSanity: 0, skippedNoTick: 0, skippedDisabled: 0,
  lastAt: 0, lastKey: null, lastTickPrice: null,
};

/**
 * Diagnostics: enable state, live telemetry counters, and the health
 * of the underlying books (the same frames the desks' badges read).
 */
export function cxWsCandlesStatus() {
  const now = _nowFn();
  let spotFresh = false;
  let futFresh = false;
  try {
    // a sample liquid pair is enough for "is the book alive at all"
    spotFresh = spotWsPrice('BTCINR') != null || spotWsPrice('BTCUSDT') != null;
  } catch { spotFresh = false; }
  try {
    futFresh = futBookSnapshot(FUT_TICK_FRESH_MS).size > 0;
  } catch { futFresh = false; }
  return {
    enabled: _enabled,
    liveBar: { ..._tel },
    books: { spotFresh, futFresh },
    sanityPct: TICK_SANITY_PCT,
    asOf: now,
  };
}

// ---------------------------------------------------------------
// THE PURE CORE — one live print onto the candle tail.
// ---------------------------------------------------------------
/**
 * Overlay one live tick onto the tail of an ascending candle series.
 * RELATIVE-BAR RULE (deliberately NOT absolute UTC bucketing — the
 * sources mix day anchors: CoinDCX 1d bars are UTC-midnight while
 * Yahoo .NS daily bars anchor at IST midnight, and Yahoo 1h NSE
 * bars sit on :15 IST offsets that never equal UTC hour floors):
 *   atMs <  bar.time            → pre-history print, ignore
 *   atMs <  bar.time + tfMs     → SAME bar → close=price, high/low extend
 *   otherwise                   → ROLL a live bar at bar.time + tfMs
 *     (contiguous with the REST grid — a stale socket never
 *     fabricates a gap; the next REST anchor re-aligns the tail)
 *
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>} candles
 * @param {{price:number, atMs:number}} tick
 * @param {keyof typeof TF_MS} tf
 * @param {object} [counters] optional telemetry sink (module `_tel`)
 * @returns {Array} a NEW array when the overlay applies (input never
 *   mutated — the REST chain serves shared cache slices), else the
 *   SAME reference (zero-cost no-op).
 */
export function overlayTickOnCandles(candles, tick, tf, counters = null) {
  const tfMs = TF_MS[tf];
  if (!Array.isArray(candles) || candles.length < 2 || !tfMs) return candles || null;
  // v21.23.11 [MIRROR-SHIELD L2]: barTime must be the NEWEST bar's open
  // slot. A descending (time-mirrored) series would read the OLDEST bar
  // as "forming" → live print roll karta ek bogus bar oldest ke baad —
  // poora tail corrupt. Entry pe canonicalize (zero-copy jab asc).
  candles = ensureAscending(candles);
  const price = Number(tick?.price);
  const atMs = Number(tick?.atMs ?? tick?.time);
  if (!(price > 0) || !Number.isFinite(atMs)) return candles;
  const barTime = Number(candles[candles.length - 1]?.time);
  const lastClose = Number(candles[candles.length - 1]?.close);
  if (!Number.isFinite(barTime) || !(lastClose > 0)) return candles;
  // pre-history print (tick older than the last bar's open slot)
  if (atMs < barTime) {
    if (counters) counters.skippedStale++;
    return candles;
  }
  // domain/hostile sanity — |Δ| > 35% inside one bar is a wrong-scale
  // tick (INR on USDT, paise on rupees…), never a liquid-pair print
  if (Math.abs(price - lastClose) / lastClose > TICK_SANITY_PCT) {
    if (counters) counters.skippedSanity++;
    return candles;
  }
  const out = candles.slice();
  const prev = { ...out[out.length - 1] };
  const sameBar = (atMs - barTime) < tfMs;
  if (sameBar) {
    // the forming bar IS this bar — update its tail IN PLACE
    out[out.length - 1] = {
      ...prev,
      close: price,
      high: Math.max(Number(prev.high) || price, price),
      low: Math.min(Number(prev.low) || price, price),
    };
    if (counters) counters.updated++;
  } else {
    // ROLL = APPEND (the documented contract): the stale anchor bar keeps
    // its partial-final OHLC + volume; the live print OPENS the next slot
    // on the REST grid (contiguous — never a fabricated gap). Reads always
    // restart from the anchor (the cache holds the RAW series), so at most
    // ONE roll per read — the tail never compounds.
    out.push({
      time: barTime + tfMs,
      open: price, high: price, low: price, close: price,
      volume: 0, // live print carries no volume — REST anchor self-heals
    });
    if (counters) counters.rolled++;
  }
  if (counters) { counters.applied++; counters.lastAt = _nowFn(); }
  return out;
}

// ---------------------------------------------------------------
// Domain-matched fresh-tick getters (each enforces its own window).
// All return { price, atMs } | null — NEVER a price in another domain.
// ---------------------------------------------------------------
/** Spot WS book, INR row for the base (e.g. BTC → BTCINR). */
function _spotInrTick(base) {
  const price = spotWsPrice(`${base}INR`); // 45s freshness built-in
  if (!(price > 0)) return null;
  return { price, atMs: _nowFn() };
}

/** Futures WS book, USDT-perp row for the base (e.g. BTC → B-BTC_USDT). */
function _futTick(base) {
  const row = futBookSnapshot(FUT_TICK_FRESH_MS).get(`B-${base}_USDT`);
  const price = Number(row?.last || row?.mark) || 0;
  if (!(price > 0)) return null;
  // v21.23.9 [F5]: defensive seconds→ms scale — mergeFutBook ab btST/cmRT
  // normalize karta hai, par purane/edge rows (ts absent updates) kabhi
  // seconds me aa sakte the → atMs < barTime(ms) → overlay SILENT
  // skippedStale. Live data ms me hamesha > 1e12 hota hai (2001 ke baad).
  const tsRaw = Number(row?.ts) || 0;
  const atMs = tsRaw > 0 && tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
  if (!(atMs > 0)) return null;
  return { price, atMs };
}

/** liveFeed IN_<SYM> row (Groww live quote — the same feed the India
 *  desk's price pill reads). 3-min honest window; absent/stale → null. */
function _indiaTick(symbol) {
  const t = liveGetTick(`IN_${String(symbol || '').toUpperCase()}`);
  const price = Number(t?.price) || 0;
  const atMs = Number(t?.time) || 0;
  if (!(price > 0) || !(atMs > 0)) return null;
  if (_nowFn() - atMs > INDIA_TICK_FRESH_MS) return null;
  return { price, atMs };
}

/** YF_TICKER_MINI indices (NIFTY/BANKNIFTY/…) ko liveFeed karta hai
 *  IN_<NAME> rows ke roop me — plain-symbol lookup covers them; the
 *  .NS equity names are the same. No special mapping needed. */

// ---------------------------------------------------------------
// Public wrappers — each takes the FINISHED REST series and returns
// it with the live bar overlaid (or byte-identical when no tick).
// ---------------------------------------------------------------
const _stripBase = (base) => String(base || '').toUpperCase().replace(/^(FUT_|GLOB_)/, '');

function _apply(key, candles, tf, tick) {
  if (!_enabled) { _tel.skippedDisabled++; return candles; }
  if (!tick) { _tel.skippedNoTick++; return candles; }
  const out = overlayTickOnCandles(candles, tick, tf, _tel);
  if (out !== candles) { _tel.lastKey = key; _tel.lastTickPrice = tick.price; }
  return out;
}

/**
 * SPOT INR candles (fetchCoinDcxCandles output) + the spot WS book's
 * ultrafast INR print. Wire: mtf.js `_candlesFor` CRYPTO branch,
 * `rawTfCandlesUsdt` Leg-3 (BEFORE the ÷fx scaling), chartCandles.
 */
export function cxSpotOverlayCandles(base, tf, candles) {
  const b = _stripBase(base);
  const tick = _tickFns?.spotInr ? _tickFns.spotInr(b) : _spotInrTick(b);
  return _apply(`spot-inr:${b}:${tf}`, candles, tf, tick);
}

/**
 * FUTURES USDT-perp candles (fetchFuturesCandles output) + the
 * futures WS book's ultrafast mark/last print. Wire:
 * `rawTfCandlesUsdt` Leg-1, ultrafastVerifier FUTURES branch.
 */
export function cxFutOverlayCandles(base, tf, candles) {
  const b = _stripBase(base);
  const tick = _tickFns?.fut ? _tickFns.fut(b) : _futTick(b);
  return _apply(`fut-usdt:${b}:${tf}`, candles, tf, tick);
}

/**
 * INDIA candles (Yahoo .NS series) + the liveFeed Groww print — the
 * same ultrafast-quote upgrade for the India 15m — D1 ladder. The
 * REST series stays the anchor; only the forming bar goes live.
 * Wire: mtf.js `_indiaCandles` (all TFs incl. the 4h resample tail).
 * GLOBALFUTURES rows ride this path too — US tickers have no IN_
 * liveFeed row, so the getter no-ops honestly (never a cross-domain).
 */
export function indiaOverlayCandles(symbol, tf, candles) {
  const sym = String(symbol || '').toUpperCase().replace(/^GLOB_/, '');
  const tick = _tickFns?.india ? _tickFns.india(sym) : _indiaTick(sym);
  return _apply(`india:${sym}:${tf}`, candles, tf, tick);
}

/** Test hook — full hermetic reset (counters + injections). */
export function _resetCxWsCandlesForTest() {
  _tel.applied = 0; _tel.updated = 0; _tel.rolled = 0;
  _tel.skippedStale = 0; _tel.skippedSanity = 0; _tel.skippedNoTick = 0; _tel.skippedDisabled = 0;
  _tel.lastAt = 0; _tel.lastKey = null; _tel.lastTickPrice = null;
  _tickFns = null;
  _nowFn = () => Date.now();
}
