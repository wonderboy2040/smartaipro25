// ============================================================
// server/bots/core/features.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// CAUSAL indicator core shared by the backtest engine AND the
// live botRunner (plan §5/§6: shared spec — live/backtest feature
// mismatch silently kills the live edge, so both import THIS file).
//
// Causality contract (non-negotiable, plan §5):
//   • Every indicator below ends its window AT the current bar
//     and is computed only from bars <= current bar.
//   • Any feature a DECISION consumes must be read from the
//     PREVIOUS bar (shift(1) discipline) when the decision fires
//     on the current bar's close. NOTE (v20.8.1, honest doc): the
//     engine passes the SIGNAL bar's row to deciders — deciding on
//     bar-i features at bar-i close is causal; only ensembleAdapter
//     additionally implements shift(1) on price. Do not build a gate
//     on a stronger guarantee than this.
//   • NaN is NEVER filled with 0. Every feature returns
//     Number|null and the caller DROPS incomplete candidates
//     (plan §5: "NaN ko 0 se fill nahi karna" — a fabricated
//     "0.00 ATR from EMA" fact is poison for gates and Jev alike).
// ============================================================

/** Number or null — never a silent 0. v20.8.0 FIX: Number(null) === 0
 *  in JS, so an explicit null check MUST come first — otherwise a
 *  missing value silently becomes a "0.00 ATR" fabricated fact
 *  (the exact bug class plan §5 bans).
 *  v20.8.1 FIX (H2): empty/whitespace strings and booleans also used
 *  to pass through as real numbers ('' -> 0, true -> 1) — a bar with
 *  open:'' became a zero-price entry. Now null. */
export function nn(v) {
  if (v == null || typeof v === 'boolean') return null;
  const x = typeof v === 'string'
    ? (v.trim() === '' ? NaN : Number(v))
    : Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * EMA series (causal): ema[i] uses closes[0..i] only.
 * Returns array of Number|null (null until seeded).
 */
export function emaSeries(values, period) {
  const p = Math.max(1, Math.floor(period));
  const out = new Array(values.length).fill(null);
  if (values.length < p) return out;
  const k = 2 / (p + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = nn(values[i]);
    if (v == null) continue;
    if (prev == null) {
      // seed with the first finite window's average (causal: only bars so far)
      if (i >= p - 1) {
        let s = 0, ok = true;
        for (let j = i - p + 1; j <= i; j++) { const x = nn(values[j]); if (x == null) { ok = false; break; } s += x; }
        if (ok) prev = s / p;
      }
      if (prev != null) out[i] = prev;
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/**
 * Wilder ATR series (causal): atr[i] from bars[0..i].
 * Period is in BARS — the caller decides the calendar span
 * (plan §5: NSE 15-min bars => 14 days = 350 bars; do NOT copy
 * the 24h-forex 1344 default).
 */
export function atrSeries(bars, period) {
  const p = Math.max(1, Math.floor(period));
  const out = new Array(bars.length).fill(null);
  if (bars.length < p + 1) return out;
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const h = nn(bars[i].high), l = nn(bars[i].low), pc = nn(bars[i - 1].close);
    if (h == null || l == null || pc == null) continue;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    if (tr[i] == null) continue;
    if (prev == null) {
      if (i >= p) {
        let s = 0, ok = true;
        for (let j = i - p + 1; j <= i; j++) { if (tr[j] == null) { ok = false; break; } s += tr[j]; }
        if (ok) prev = s / p;
      }
      if (prev != null) out[i] = prev;
    } else {
      prev = (prev * (p - 1) + tr[i]) / p;
      out[i] = prev;
    }
  }
  return out;
}

/** Simple rolling mean of last `period` finite values ending AT i (inclusive). */
export function rollingMeanAt(values, i, period) {
  const p = Math.max(1, Math.floor(period));
  if (i < 0 || i >= values.length) return null;
  let s = 0, n = 0;
  for (let j = Math.max(0, i - p + 1); j <= i; j++) {
    const v = nn(values[j]);
    if (v == null) continue;
    s += v; n++;
  }
  return n === p ? s / p : null; // incomplete window -> null, never 0
}

/**
 * Prior-session levels + same-time-of-day volume baseline now live in
 * finishShared's single forward pass (v20.8.0 PERF). The old per-bar
 * backward-scan helpers were removed — O(n^2) with ICU formatting.
 */

/** Bar anatomy (all causal from the bar itself). */
export function barAnatomy(b) {
  const o = nn(b.open), h = nn(b.high), l = nn(b.low), c = nn(b.close);
  if (o == null || h == null || l == null || c == null) return null;
  const range = h - l;
  if (!(range > 0)) return null;
  const body = Math.abs(c - o);
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  return {
    range, body,
    bodyPct: body / range,
    upperWickPct: upperWick / range,
    lowerWickPct: lowerWick / range,
    bullish: c > o,
    bearish: c < o,
  };
}

// ---------------- fast session/time math (IST = fixed UTC+5:30, no DST) ----------------
// v20.8.0 PERF: toLocaleString-based IST math is ICU-expensive and was
// called O(n^2) from finishShared — a 300-bar prepare took ~4s and
// starved the vitest workers. IST has NO daylight saving, so pure
// arithmetic is exact AND fast. Display code may still use Intl.
export const IST_OFFSET_MS = 330 * 60000;

/** Minutes-since-midnight IST (0-1439) — pure arithmetic. */
export function istMinutesFast(tsMs) {
  const t = Number(tsMs);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t + IST_OFFSET_MS) / 60000) % 1440;
}

/** IST calendar day as an integer (epoch-day) — fast bucketing key. */
export function istDayKey(tsMs) {
  const t = Number(tsMs);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t + IST_OFFSET_MS) / 86400000);
}

/** UTC calendar day as an integer — fast bucketing key for crypto sessions. */
export function utcDayKey(tsMs) {
  const t = Number(tsMs);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 86400000);
}

/** EMA slope over `span` bars ending at i (causal). Null when unseeded.
 *  v20.8.1 FIX (H3): during warmup the old Math.max(0, i-span) clamp
 *  silently computed a 1-2 bar "slope" instead of the requested span. */
export function emaSlopeAt(emas, i, span = 3) {
  const a = nn(emas[i]);
  if (i < span) return null;
  const b = nn(emas[i - span]);
  if (a == null || b == null) return null;
  return a - b;
}

/**
 * Prepare a bars array into enriched rows with ALL shared features.
 * Row shape (superset used by every strategy snapshot):
 *  { bar, i, atr, emaFast, emaSlow, emaFastSlope, volRatioTod,
 *    anatomy, priorH, priorL, priorC }
 * Strategies add their own columns on top (openRange etc).
 */
export function prepareShared(bars, { atrPeriod = 350, emaFast = 50, emaSlow = 200 } = {}) {
  const closes = bars.map(b => nn(b.close));
  const atr = atrSeries(bars, atrPeriod);
  const ef = emaSeries(closes, emaFast);
  const es = emaSeries(closes, emaSlow);
  const rows = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    rows[i] = {
      bar: bars[i], i,
      atr: atr[i],
      emaFast: ef[i], emaSlow: es[i],
      emaFastSlope: emaSlopeAt(ef, i, 3),
      volRatioTod: null, anatomy: barAnatomy(bars[i]),
      priorH: null, priorL: null, priorC: null,
    };
  }
  return rows;
}

/**
 * Fill time-of-day volume ratio + prior-session levels (second pass).
 * v20.8.0 PERF: ONE forward pass — prior sessions' [H,L,C] and
 * same-time-of-day volume baselines accumulate as sessions COMPLETE,
 * so every bar's features come from strictly-prior sessions (causal
 * by construction) at O(n) total cost. The old per-bar backward scan
 * (volumeRatioTimeOfDay + priorSessionLevels per i) was O(n^2) with
 * ICU date formatting — ~4s for 300 bars, worker-starving.
 * sessionKey: (bar) => fast bucket key (istDayKey/utcDayKey style).
 */
export function finishShared(rows, bars, opts = {}) {
  const intervalMin = Math.max(1, opts.intervalMin || 5);
  const keyFn = opts.sessionKey || ((b) => utcDayKey(nn(b.time)));
  const bucketMs = intervalMin * 60000;
  const bucketOf = (t) => (t == null ? null : Math.floor((((t % 86400000) + 86400000) % 86400000) / bucketMs));

  let curKey = null, curH = null, curL = null, curC = null;
  let prior = null; // last COMPLETED session's {H, L, C}
  const priorBuckets = new Map(); // bucket -> volumes[] (completed sessions only)
  const curBuckets = new Map();

  for (let i = 0; i < rows.length; i++) {
    const b = bars[i];
    const k = keyFn(b);
    if (k !== curKey) {
      if (curKey != null) {
        prior = { H: curH, L: curL, C: curC };
        for (const [bk, vols] of curBuckets) {
          if (!priorBuckets.has(bk)) priorBuckets.set(bk, []);
          const all = priorBuckets.get(bk);
          for (const v of vols) all.push(v);
        }
        curBuckets.clear();
      }
      curKey = k; curH = null; curL = null; curC = null;
    }
    // prior-session levels: strictly BEFORE this session (causal)
    rows[i].priorH = prior ? prior.H : null;
    rows[i].priorL = prior ? prior.L : null;
    rows[i].priorC = prior ? prior.C : null;
    // same-time-of-day volume ratio vs prior sessions (causal)
    const v = nn(b.volume);
    const bk = bucketOf(nn(b.time));
    const priorVols = bk == null ? null : priorBuckets.get(bk);
    if (v == null || !priorVols || priorVols.length < 3) {
      rows[i].volRatioTod = null;
    } else {
      const sorted = [...priorVols].sort((x, y) => x - y);
      const med = sorted[Math.floor(sorted.length / 2)];
      rows[i].volRatioTod = med > 0 ? v / med : null;
    }
    // accumulate the CURRENT session (becomes "prior" for the next one)
    const h = nn(b.high), l = nn(b.low), c = nn(b.close);
    if (h != null) curH = curH == null ? h : Math.max(curH, h);
    if (l != null) curL = curL == null ? l : Math.min(curL, l);
    curC = c ?? curC;
    if (v != null && bk != null) {
      if (!curBuckets.has(bk)) curBuckets.set(bk, []);
      curBuckets.get(bk).push(v);
    }
  }
  return rows;
}
