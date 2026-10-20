// ============================================================
// server/ai/lib/candles.js — v21.23.11 CANDLE CANONICALIZER
// ------------------------------------------------------------
// USER REPORT (verbatim): "site me Jo bhi trade signals de rahe hai
// sab ke sab wrong direction me hai sab opposite jaa rahe hai …
// signals ab bhi systematic opposite jaa rahe hain" — jabki
// v21.23.4 ka direction selftest 13/13 PASS tha aur sandbox live
// probe (Binance chain) 17/20 AGREE nikla.
//
// ROOT-CAUSE CLASS (live-probe 2026-10-20, is tree):
//   CoinDCX candle endpoints apna response wire-format migrate kar
//   rahe hain (docs.coindcx.com: naya /market_data/candles
//   `interval` param + {open,high,low,volume,close,time} —
//   "Response Order: Newest-first (descending)"; Aug-2026 SDKs
//   `.reverse()` karte hain; ek SDK CandleResponse `open_time`
//   field list karta hai — docs `time` bolte hain). LEGACY parse
//   (spot: {o,h,l,c,v,t} · futures candlesticks: {…,time}) me agar
//   timestamp key drift/absent ho jaye to:
//       Number(x.time) = NaN → sort comparator NaN → sort NO-OP
//       → array API ke NEWEST-FIRST order me hi rehti hai
//       → poora series TIME-MIRRORED
//       → har indicator (EMA/RSI/MACD/Supertrend/ROC) ulta compute
//       → SAB SIGNALS SYSTEMATICALLY OPPOSITE (prices WS-overlay
//         se live dikhti rahengi — "site working fine" lagega).
//   Yahi wo layer hai jo internal-consistency tests KABHI catch
//   nahi karte (mocks apne assumed shape me hi bante hain) aur
//   jo datacenter sandbox me reproduce NAHI hota (wahan CoinDCX
//   Cloudflare-blocked → Binance leg chalti hai → direction sahi).
//
// THE FIX — ek canonical invariant, TEEN defense lines:
//   L1 (SOURCE):  har CoinDCX fetcher ab alias-tolerant parse +
//                 orientation-detect + canonicalize karta hai.
//   L2 (OVERLAY): overlayTickOnCandles entry pe ensureAscending —
//                 forming bar hamesha TRUE newest par milega.
//   L3 (COMPUTE): computeIndicatorsFromCandles/_tfVote entry pe
//                 ensureAscending — kisi bhi un-audited path (store,
//                 resample, bots) se mirrored series aaye to compute
//                 se PEHLE wapas seedha ho jata hai.
//   L4 (PROOF):   directionLiveCert.js — REAL live candles pe
//                 per-chain certificate (order + LTP-vs-ticker +
//                 vote-vs-realized-trend). Wire drift dobara kabhi
//                 SILENT mirror nahi ban sakta — certificate FAIL
//                 hoga, loudly, chain ka naam lekar.
//
// DESIGN CONTRACTS:
//   * parseCandleRow: alias-tolerant (t/time/open_time/T/ts; o/open;
//     h/high; l/low; c/close; v/volume/vol) + Binance-style array
//     rows + seconds↔ms normalization (1e12 heuristic) + finite/
//     positive filters. Row parse FAIL = row DROP (honest), kabhi
//     NaN time keep nahi (NaN sort = no-op = mirror).
//   * canonicalizeCandles: parse → drop bad rows → detect
//     orientation → reverse-if-descending → stable ascending sort →
//     invariant assert (first bar oldest, last bar newest).
//   * ensureAscending: O(n) LAST-LINE — orientation scan; desc →
//     reversed COPY; asc → SAME reference (zero-copy hot path).
//     Mixed/unknown → untouched (sort reorder compute layer me
//     kabhi nahi — wahan sirf unambiguous reversal allowed).
//   * Telemetry bounded + test-resettable (hermetic suites).
// ============================================================

// ---- alias tables (wire-format drift absorption) ----
const TIME_KEYS = ['time', 't', 'open_time', 'openTime', 'T', 'timestamp', 'ts'];
const OPEN_KEYS = ['open', 'o', 'openPrice'];
const HIGH_KEYS = ['high', 'h'];
const LOW_KEYS = ['low', 'l'];
const CLOSE_KEYS = ['close', 'c', 'last', 'last_price', 'closePrice'];
const VOL_KEYS = ['volume', 'v', 'vol', 'base_volume'];

function pickNumber(obj, keys) {
  for (const k of keys) {
    const v = Number(obj?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** v21.23.12: alias key PRESENT hai par uska value parse nahi hota
 *  (NaN/garbage) — "omitted" vs "present-but-broken" ka honest fark. */
function _hasBrokenKey(obj, keys) {
  if (obj == null || typeof obj !== 'object') return false;
  for (const k of keys) {
    if (k in obj && !Number.isFinite(Number(obj[k]))) return true;
  }
  return false;
}

/**
 * Alias-tolerant single-candle parse.
 * Accepts: legacy CoinDCX spot {o,h,l,c,v,t}; current docs
 * {open,high,low,volume,close,time}; drift shape
 * {open,high,low,close,volume,open_time,close_time}; Binance/Bybit
 * array rows [timeMs,open,high,low,close,volume].
 * Seconds→ms normalization: values < 1e12 are treated as seconds
 * (post-2001 ms timestamps are always > 1e12).
 * @returns {{time:number,open:number,high:number,low:number,close:number,volume:number}|null}
 */
export function parseCandleRow(x) {
  if (x == null) return null;
  if (Array.isArray(x)) {
    const t0 = Number(x[0]);
    if (!Number.isFinite(t0) || !(t0 > 0)) return null;
    const open = Number(x[1]), high = Number(x[2]), low = Number(x[3]), close = Number(x[4]);
    const volume = Number(x[5]);
    return finishRow(t0, open, high, low, close, Number.isFinite(volume) ? volume : 0);
  }
  const time = pickNumber(x, TIME_KEYS);
  if (time == null || !(time > 0)) return null;
  const open = pickNumber(x, OPEN_KEYS);
  const close = pickNumber(x, CLOSE_KEYS);
  if (!(open > 0) || !(close > 0)) return null;
  let high = pickNumber(x, HIGH_KEYS);
  let low = pickNumber(x, LOW_KEYS);
  // honest synth ONLY when the wire omitted the field entirely — a
  // PRESENT-but-broken value (high < open/close, low > open/close:
  // wrong-scale/paise class) is DROPPED, never silently repaired.
  // v21.23.12 [CONTRACT HONESTY]: ye clause pehle sirf GEOMETRY check se
  // enforce hoti thi — ek PRESENT-but-NaN high/low pickNumber me null ban
  // kar synth ho jaati thi (comment ka "DROPPED, never repaired" promise
  // todti thi). Ab present-key-with-broken-value = row DROP.
  if (high == null && _hasBrokenKey(x, HIGH_KEYS)) return null;
  if (low == null && _hasBrokenKey(x, LOW_KEYS)) return null;
  if (high == null) high = Math.max(open, close);
  if (low == null) low = Math.min(open, close);
  if (!(high > 0) || !(low > 0)) return null;
  const volume = pickNumber(x, VOL_KEYS) ?? 0;
  return finishRow(time, open, high, low, close, volume);
}

function finishRow(timeRaw, open, high, low, close, volume) {
  if (!(open > 0) || !(close > 0) || !(high > 0) || !(low > 0)) return null;
  if (!(high >= Math.max(open, close) - 1e-12) || !(low <= Math.min(open, close) + 1e-12)) {
    // geometry sanity — a wrong-scale/paise row is dropped, not kept
    return null;
  }
  const time = timeRaw < 1e12 ? timeRaw * 1000 : timeRaw; // seconds → ms
  if (!Number.isFinite(time) || !(time > 0)) return null;
  // v21.23.11 time-plausibility floor: ARRAY rows ka layout ambiguous ho
  // sakta hai (Binance [t,o,h,l,c,v] vs legacy bare arrays [o,h,l,c,v,t]).
  // Agar position-0 price nikli (layout misread), "time" 1970-class chhota
  // epoch banega. Post-2018 ms (≥1.2e12) / post-2017 seconds (≥1.5e9) se
  // purana = layout misread → row DROP (honest). Named-key rows is floor
  // se kabhi fail nahi hote (unambiguous).
  if (time < 1.2e12) return null;
  return { time, open, high, low, close, volume: volume > 0 ? volume : 0 };
}

/**
 * Detect a series' chronological orientation from adjacent finite
 * time deltas. Conservative: needs ≥3 decisive comparisons and a
 * dominant direction; ambiguous input → 'mixed'/'unknown'.
 * @returns {'asc'|'desc'|'mixed'|'unknown'}
 */
export function seriesOrientation(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return 'unknown';
  let asc = 0, desc = 0;
  for (let i = 1; i < candles.length; i++) {
    // v21.23.12 [KEY-DRIFT BLIND-SPOT CURE]: pehle sirf `.time` padha jaata
    // tha — t/open_time/T/ts keyed rows (jo parseCandleRow ALIAS layer me
    // happily chalti hain) NaN delta deti thi → 'unknown' → ensureAscending
    // UNTOUCHED. Yahi WOHI key-drift class hai jisne original mirror disease
    // ko L2/L3 ke nose ke saamne se nikal diya tha. Ab TIME_KEYS alias se
    // hi padho (canonicalized rows `.time` pe hote hain — zero behavior
    // change unke liye).
    const a = _rowTimeMs(candles[i - 1]);
    const b = _rowTimeMs(candles[i]);
    if (a == null || b == null || a === b) continue;
    if (b > a) asc++; else desc++;
  }
  const decisive = asc + desc;
  if (decisive < 3) return 'unknown';
  if (desc === 0) return 'asc';
  if (asc === 0) return 'desc';
  if (asc > desc * 3) return 'asc';
  if (desc > asc * 3) return 'desc';
  return 'mixed';
}

/** Alias-tolerant row-time read (orientation layer ke liye) — ms me
 *  normalize karta hai jaise parseCandleRow karta hai (s↔ms). */
function _rowTimeMs(c) {
  if (c == null || typeof c !== 'object') return null;
  for (const k of TIME_KEYS) {
    if (k in c) {
      const v = Number(c[k]);
      if (Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
    }
  }
  const t = Number(c?.time);
  return Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : null;
}

/**
 * LAST-LINE orientation fixer for compute/overlay entry points.
 * Unambiguously descending → reversed COPY (caller's array never
 * mutated). Everything else → SAME reference (zero-copy).
 * Never reorders a mixed series (that is a data-quality issue for
 * the honest gates, not something a silent reorder should hide).
 * @param {Array} candles
 * @returns {Array} ascending-oriented series (or input as-is)
 */
export function ensureAscending(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return candles || null;
  return seriesOrientation(candles) === 'desc' ? candles.slice().reverse() : candles;
}

// ---- telemetry (bounded; certificate + /api diagnostics read this) ----
const _stats = {
  canonicalized: 0, reversed: 0, droppedRows: 0,
  lastLabel: null, lastAt: 0,
  lastDetail: null, // { label, rows, dropped, orientation, outBars }
  recent: [],      // v21.23.12: bounded ring — live certificate wire-drift visibility
};
const _RECENT_MAX = 16;
function _pushRecent(entry) {
  _stats.recent.push(entry);
  if (_stats.recent.length > _RECENT_MAX) _stats.recent.splice(0, _stats.recent.length - _RECENT_MAX);
}
export function candleCanonicalStats() {
  return { ..._stats, lastDetail: _stats.lastDetail ? { ..._stats.lastDetail } : null, recent: _stats.recent.map(r => ({ ...r })) };
}
export function __resetCandleCanonicalStatsForTest() {
  _stats.canonicalized = 0; _stats.reversed = 0; _stats.droppedRows = 0;
  _stats.lastLabel = null; _stats.lastAt = 0; _stats.lastDetail = null; _stats.recent = [];
}

/**
 * THE SOURCE-LEVEL KILL SHOT: raw API rows → canonical ascending
 * candle series. Parse (aliases + filters) → orientation detect →
 * reverse-if-descending → stable ascending sort → invariant assert.
 * Mirrored/NaN/shape-drifted wires iske aage KABHI nahi nikal sakte.
 *
 * @param {Array} rawRows wire rows (objects or arrays)
 * @param {{label?:string, minBars?:number}} [opts]
 * @returns {Array|null} ascending {time,open,high,low,close,volume}[]
 */
export function canonicalizeCandles(rawRows, opts = {}) {
  const label = String(opts.label || 'candles');
  const minBars = Math.max(2, Math.floor(Number(opts.minBars) || 2));
  if (!Array.isArray(rawRows) || rawRows.length === 0) return null;
  const parsed = [];
  let dropped = 0;
  for (const x of rawRows) {
    const c = parseCandleRow(x);
    if (c) parsed.push(c); else dropped++;
  }
  if (parsed.length < minBars) {
    _stats.droppedRows += dropped;
    _stats.lastLabel = label; _stats.lastAt = Date.now();
    _stats.lastDetail = { label, rows: rawRows.length, dropped, orientation: 'unknown', outBars: 0, rejected: 'below-minBars' };
    _pushRecent({ label, rows: rawRows.length, dropped, orientation: 'unknown', outBars: 0, at: _stats.lastAt, rejected: 'below-minBars' });
    return null;
  }
  const orientation = seriesOrientation(parsed);
  let out;
  if (orientation === 'desc') {
    out = parsed.slice().reverse(); // O(n) — already monotone, just flipped
    _stats.reversed++;
  } else {
    out = parsed.slice().sort((a, b) => a.time - b.time); // asc/mixed/unknown → stable ascending
  }
  _stats.canonicalized++;
  _stats.lastLabel = label; _stats.lastAt = Date.now();
  _stats.lastDetail = { label, rows: rawRows.length, dropped, orientation, outBars: out.length };
  _pushRecent({ label, rows: rawRows.length, dropped, orientation, outBars: out.length, at: _stats.lastAt });
  // invariant assert (defensive — every caller depends on this)
  if (out.length >= 2 && !(Number(out[0].time) <= Number(out[out.length - 1].time))) return null;
  return out;
}
