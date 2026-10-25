// ============================================================
// server/ai/lib/priceRound.js — adaptive price-level precision
// ------------------------------------------------------------
// v9.2: the plan/blueprint/position layers used to round every
// price to a FIXED 2 decimals (r2). For sub-1 instruments —
// DOGE ~0.08 USDT, SHIB/PEPE sub-cent, JUP micro-ticks — that
// rounding COLLAPSED the levels onto each other:
//      entry 0.08 · SL 0.09 · T1 0.08 · T2 0.08   (DOGE futures)
//      entry 0.10 · SL  0.10 · T1 0.09            (OP futures)
// An SL that equals the entry is an instant stop-out; targets at
// the entry can never pay. To the user this reads as "SHORT lagaya
// aur trade galat direction me gaya" — the position opens and
// immediately closes on a level that was never really there.
//
// The expert-picks desk already had this as its local pR(); this
// module is the ONE shared source for every layer that rounds a
// PRICE (plan levels, liquidation estimates, peak prices, trail
// stops). Rupee/USDT *amounts* (notional, margin, P&L) keep r2.
//
// Rules (mirror expertPicks.pricePrecision):
//   |v| ≥ 1        → 2 decimals   (₹2,590.35 · 2.52 USDT)
//   |v| ≥ 0.01     → 4 decimals   (0.0848 · 0.6400)
//   |v| ≥ 0.0001   → 6 decimals   (0.00000881-class micro ticks)
//   smaller        → 8 decimals   (PEPE-class)
// ============================================================

import { normalizeSide } from '../directionCertificate.js';

export function pricePrecision(p) {
  const v = Math.abs(Number(p) || 0);
  if (!Number.isFinite(v) || v === 0) return 2;
  if (v >= 1) return 2;
  if (v >= 0.01) return 4;
  if (v >= 0.0001) return 6;
  return 8;
}

/** Round a PRICE to adaptive precision (null/undefined pass through as null). */
export function pRound(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(pricePrecision(n)));
}

// v21.6.1 DISTINCT-LEVELS GUARD — the v9.2 collapse class had a ≥1 cousin:
// pRound() rounds prices ≥1 to 2 decimals, so on e.g. XRP $1.36 a plan with
// risk < 0.005 USDT rounded to `entry 1.36 · T1 1.36` (SHORT T1 ON the entry)
// — a target that can never pay. pRoundLadder() rounds the WHOLE ladder
// (entry + SL + targets) at ONE shared precision, bumping (2→4→6→8→12)
// until every level is DISTINCT and strictly side-ordered, so the card can
// never show an SL/target on the wrong side of its own entry.
const _bump = (p) => (p >= 8 ? 12 : p === 2 ? 4 : p + 2);

/**
 * Round a plan's price ladder consistently.
 * @param {object}  p
 * @param {string}   p.side        'LONG' | 'SHORT'
 * @param {number}   p.entry       raw entry (ltp)
 * @param {number}   p.stopLoss    raw stop
 * @param {number[]} [p.targets]   raw targets in escalating-distance order (T1..Tn)
 * @returns {{ entry:number, stopLoss:number, targets:number[] }} rounded ladder
 *   — strictly ordered (LONG: SL < entry < T1 < …; SHORT: mirror), all at the
 *   SAME precision. Falls back to raw*1e-12 rounding only on a degenerate
 *   zero-distance ladder (caller's logic bug), never throwing.
 */
export function pRoundLadder({ side, entry, stopLoss, targets = [] }) {
  // v21.23.10 [SIDE-VOCAB]: 'SELL' bhi SHORT hai — pehle `!== 'SHORT'`
  // default-long 'SELL' ladders ko ULTA order karta tha (futuresOrderBody
  // fix ki hi class).
  // v21.25.0 [NO SILENT LONG]: missing/unknown side ab `valid:false` ladder
  // deta hai — caller ko reject/fallback karna hai. Pehle khali side LONG
  // ban jaati thi (SHORT ticket ka SL/target geometry ulta).
  const s = normalizeSide(side);
  const e = Number(entry), sl = Number(stopLoss);
  const ts = (Array.isArray(targets) ? targets : []).map(Number);
  const round = (v, p) => Number(Number(v).toFixed(p));
  const allFinite = Number.isFinite(e) && Number.isFinite(sl) && ts.every(Number.isFinite);
  if (!s) {
    return {
      valid: false,
      side: null,
      reason: `invalid side "${String(side ?? '')}" — LONG/BUY or SHORT/SELL required`,
      entry: allFinite ? round(e, pricePrecision(e)) : pRound(e),
      stopLoss: allFinite ? round(sl, pricePrecision(e)) : pRound(sl),
      targets: allFinite ? ts.map((t) => round(t, pricePrecision(e))) : ts.map((t) => pRound(t)),
      precision: allFinite ? pricePrecision(e) : pricePrecision(e),
    };
  }
  const long = s === 'LONG';
  if (!allFinite) {
    return { valid: true, side: s, entry: pRound(e), stopLoss: pRound(sl), targets: ts.map((t) => pRound(t)), precision: pricePrecision(e) };
  }
  const ordered = (er, slr, trs) => {
    if (long) {
      if (!(slr < er)) return false;
      let prev = er;
      for (const t of trs) { if (!(t > prev)) return false; prev = t; }
    } else {
      if (!(slr > er)) return false;
      let prev = er;
      for (const t of trs) { if (!(t < prev)) return false; prev = t; }
    }
    return true;
  };
  let prec = (e >= 1 && e < 25) ? 4 : pricePrecision(e);
  for (let i = 0; i < 6; i++) {
    const er = round(e, prec), slr = round(sl, prec);
    const trs = ts.map((t) => round(t, prec));
    if (ordered(er, slr, trs)) return { valid: true, side: s, entry: er, stopLoss: slr, targets: trs, precision: prec };
    prec = _bump(prec);
  }
  return { valid: true, side: s, entry: round(e, 12), stopLoss: round(sl, 12), targets: ts.map((t) => round(t, 12)), precision: 12 };
}

/** Max sane stop distance as a fraction of price — a stop further than
 *  this (e.g. a 283%-ATR meme coin) puts LONG stops negative / SHORT
 *  targets negative. 30% keeps even the 3R target positive (1 − 3×0.30
 *  = +10% of price) on both sides; anything wider is untradeable noise. */
export const MAX_STOP_FRACTION = 0.30;
