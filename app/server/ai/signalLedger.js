// ============================================================
// server/ai/signalLedger.js — v20.9.0 SIGNAL LEDGER + CALIBRATION
// ------------------------------------------------------------
// AUDIT (B2): "Har SAPTA/ensemble signal ka ledger rakho: {ts, desk,
// symbol, side, aiScore, confidence, verifiedScore, mtfAgree, regime,
// outcomeR, fees}. Weekly job: verified-score aur confidence ke
// BUCKETS ke hisaab se win-rate, avg R, n, Wilson lower bound.
// Threshold wahi jahan bucket ka net avg R > 0 aur n >= 30."
//
// Ye module:
//   1. harvestTrade() — SAPTA journal rows + Bot Lab settle events ko
//      EK normalized ledger-row shape me convert karta hai (pure)
//   2. bucketCalibration() — verified-score / confidence buckets →
//      {n, winRate, wilsonLB, avgR} (pure) — H2 threshold change ab
//      DATA se justify hoga, gut-feel se nahi
//   3. recommendedThreshold() — wilsonLB>0.5 && netAvgR>0 && n>=minN
//      wala sabse UCHA bucket-score (walk-forward apply CALLER ki
//      zimmedari — ye module sirf REPORT deta hai, config kabhi
//      overwrite NAHI karta: audit "user-saved values silently
//      overwrite mat karo" rule)
//   4. plattScale() / isotonicFit() — B5 recalibration utilities
//   5. purgedWalkForwardSplit() — C2: overlapping trades ke beech
//      leakage rokne wala train/test split + embargo gap
// PURE functions only — in-memory arrays pe chalte hain, koi fs nahi.
// ============================================================
import { wilsonLowerBound } from '../risk/hardGate.js';

/** Normalize ek settled trade ko ledger-row me (SAPTA journal row ya
 *  Bot Lab settle event — dono shapes handle). PURE. */
export function harvestTrade(t) {
  if (!t || typeof t !== 'object') return null;
  // SAPTA shape: {ts, day, market, symbol, side, signal:{aiScore, conf,
  // verified, verifyAction, finalCall, mtfAgreePct}, closed:{pnlINR,
  // ts, exitPrice}, entryPrice, sl, ...}
  // Bot Lab shape: settle events {ts?, symbol, exitWhy, grossPnl, netPnl,
  // rNet, fees, candidate?...} — runner events me `at` ISO string hota hai.
  const ts = Number(t.closed?.ts ?? t.ts ?? t.closedTs ?? Date.parse(t.at ?? '') ?? 0) || 0;
  const symbol = String(t.symbol || '?');
  const side = String(t.side || t.candidate?.side || '?');
  const pnl = Number(t.closed?.pnlINR ?? t.pnlINR ?? t.netPnl ?? t.pnl);
  const rNet = Number(t.rNet ?? t.outcomeR);
  const fees = Number(t.fees ?? 0) || 0;
  const sig = t.signal || {};
  const aiScore = Number(sig.aiScore ?? t.aiScore);
  const confidence = Number(sig.conf ?? sig.confidence ?? t.confidence);
  const verifiedScore = Number(sig.verified ?? t.verifiedScore);
  const mtfAgreePct = Number(sig.mtfAgreePct ?? t.mtfAgreePct);
  if (!ts || !Number.isFinite(pnl)) return null;
  return {
    // v20.9.1 [L]: t.mode ('paper'/'live') desk fallback me tha — bucket
    // filtering by desk silently paper/live mix kar sakti thi; ab '?'.
    ts, desk: String(t.market || t.desk || '?'), symbol, side,
    aiScore: Number.isFinite(aiScore) ? aiScore : null,
    confidence: Number.isFinite(confidence) ? confidence : null,
    verifiedScore: Number.isFinite(verifiedScore) ? verifiedScore : null,
    mtfAgreePct: Number.isFinite(mtfAgreePct) ? mtfAgreePct : null,
    regime: t.regime ?? null,
    pnl, rNet: Number.isFinite(rNet) ? rNet : null, fees,
    win: pnl > 0,
  };
}

export const SCORE_BUCKETS = [
  { label: '<60', min: -Infinity, max: 60 },
  { label: '60-70', min: 60, max: 70 },
  { label: '70-80', min: 70, max: 80 },
  { label: '80+', min: 80, max: Infinity },
];

/** Bucket calibration table (audit B2). PURE.
 *  `field` = 'verifiedScore' | 'confidence' | 'aiScore'. */
export function bucketCalibration(ledger, { field = 'verifiedScore', buckets = SCORE_BUCKETS } = {}) {
  const rows = (Array.isArray(ledger) ? ledger : []).filter((r) => r && Number.isFinite(Number(r[field])));
  return buckets.map((b) => {
    const inB = rows.filter((r) => Number(r[field]) >= b.min && Number(r[field]) < b.max);
    const n = inB.length;
    const wins = inB.filter((r) => r.win).length;
    const rs = inB.map((r) => Number(r.rNet)).filter((x) => Number.isFinite(x));
    return {
      bucket: b.label, field, n,
      winRate: n ? wins / n : null,
      wilsonLB: n ? wilsonLowerBound(wins, n) : null,
      avgR: rs.length ? rs.reduce((a, b2) => a + b2, 0) / rs.length : null,
      netPnl: inB.reduce((a, r) => a + (Number(r.pnl) || 0), 0),
    };
  });
}

/** Data-driven threshold recommendation (audit B2: "Threshold wahi jahan
 *  bucket ka net avg R > 0 aur n >= 30"). REPORT ONLY — apply karne se
 *  pehle walk-forward OOS validation caller pe; saved user config kabhi
 *  overwrite nahi hota. Returns null jab koi bucket qualify na kare. */
export function recommendedThreshold(ledger, { field = 'verifiedScore', minN = 30 } = {}) {
  const cal = bucketCalibration(ledger, { field });
  let best = null;
  for (const b of cal) {
    if (b.n < minN) continue;
    if (b.wilsonLB == null || b.wilsonLB <= 0.5) continue;   // edge not established
    if (b.avgR == null || b.avgR <= 0) continue;              // net R must be positive
    const floor = b.bucket === '<60' ? 0 : b.bucket === '80+' ? 80 : Number(String(b.bucket).split('-')[0]);
    if (best == null || floor > best.threshold) best = { threshold: floor, bucket: b.bucket, n: b.n, wilsonLB: b.wilsonLB, avgR: b.avgR };
  }
  return best;
}

// ------------------------------------------------------------
// B5 — probability recalibration (out-of-sample)
// ------------------------------------------------------------

/** Platt scaling: 1D logistic fit claimed-prob → actual outcome.
 *  inputs: [{p: claimedWinProb, y: 0|1}]. Returns {a, b} with
 *  calibrated = σ(A·p+B) = 1/(1+exp(-(A·p+B))) — v20.9.1: doc-comment
 *  pehle ulta sign likh raha tha (fit+apply dono σ(A·p+B) use karte hain,
 *  self-consistent tha, sirf comment galat tha).
 *  Newton me nahi — gradient descent (100 iter), deterministic init. */
export function plattScale(inputs, { iters = 200, lr = 0.5 } = {}) {
  const rows = (Array.isArray(inputs) ? inputs : [])
    .filter((r) => Number.isFinite(Number(r?.p)) && (r?.y === 0 || r?.y === 1));
  if (rows.length < 10) return null; // too little data — honest refusal
  // target smoothing (Platt's own recommendation avoids 0/1 extremes)
  const yPlus = 1, yMinus = 0;
  let A = 0, B = Math.log((rows.filter((r) => r.y === 1).length + 1) / (rows.length + 2));
  for (let it = 0; it < iters; it++) {
    let gA = 0, gB = 0;
    for (const r of rows) {
      const p = Math.min(0.999, Math.max(0.001, Number(r.p)));
      const z = A * p + B;
      const phat = 1 / (1 + Math.exp(-z));
      const y = r.y === 1 ? yPlus : yMinus;
      gA += (phat - y) * p;
      gB += (phat - y);
    }
    A -= (lr / rows.length) * gA;
    B -= (lr / rows.length) * gB;
  }
  return {
    a: Math.round(A * 1e4) / 1e4, b: Math.round(B * 1e4) / 1e4, n: rows.length,
    apply: (p) => {
      const v = 1 / (1 + Math.exp(-(A * Number(p) + B)));
      return Math.min(0.92, Math.max(0.01, Math.round(v * 1e4) / 1e4)); // cap 92% (audit B5)
    },
  };
}

/** Isotonic regression (PAVA) — monotone non-decreasing calibration map.
 *  inputs: [{p, y}]. Returns {knots: [{p, v}], apply} — piecewise-linear
 *  lookup, clamped, capped 92%. */
export function isotonicFit(inputs, { cap = 0.92 } = {}) {
  const rows = (Array.isArray(inputs) ? inputs : [])
    .filter((r) => Number.isFinite(Number(r?.p)) && (r?.y === 0 || r?.y === 1))
    .sort((x, y2) => Number(x.p) - Number(y2.p));
  if (rows.length < 10) return null;
  // PAVA: pool adjacent violators
  const blocks = rows.map((r) => ({ sum: r.y === 1 ? 1 : 0, n: 1, p: Number(r.p) }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].sum / blocks[i].n > blocks[i + 1].sum / blocks[i + 1].n + 1e-12) {
      blocks[i] = {
        sum: blocks[i].sum + blocks[i + 1].sum,
        n: blocks[i].n + blocks[i + 1].n,
        p: (blocks[i].p * blocks[i].n + blocks[i + 1].p * blocks[i + 1].n) / (blocks[i].n + blocks[i + 1].n),
      };
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  const knots = blocks.map((b) => ({ p: b.p, v: Math.min(cap, b.sum / b.n) }));
  const apply = (p) => {
    const x = Number(p);
    if (!Number.isFinite(x)) return null;
    if (x <= knots[0].p) return knots[0].v;
    if (x >= knots[knots.length - 1].p) return knots[knots.length - 1].v;
    for (let k = 0; k < knots.length - 1; k++) {
      if (x >= knots[k].p && x <= knots[k + 1].p) {
        const t = (x - knots[k].p) / Math.max(1e-12, knots[k + 1].p - knots[k].p);
        return Math.round((knots[k].v + t * (knots[k + 1].v - knots[k].v)) * 1e4) / 1e4;
      }
    }
    return knots[knots.length - 1].v;
  };
  return { knots, apply, n: rows.length };
}

// ------------------------------------------------------------
// C2 — purged walk-forward split with embargo
// ------------------------------------------------------------

/** Purged K-fold split (audit C2: overlapping trades ki wajah se leakage
 *  rokne ke liye train/test ke beech gap). `tsIn`/`tsOut` per trade,
 *  embargoMs test-window ki DONO sides pe gap (default = ek 5m bar) —
 *  v20.9.1 [H3]: pehle sirf LEFT side embargo tha; test fold ke LAST
 *  trade ke baad train ka trade turant aa sakta tha jabki overlap window
 *  (tsOut > tsIn) abhi khuli thi — right-edge leakage OOS calibration
 *  ko optimistic banati thi (de Prado purge+embargo dono sides). */
export function purgedWalkForwardSplit(trades, { folds = 4, embargoMs = 5 * 60000 } = {}) {
  const list = (Array.isArray(trades) ? trades : [])
    .filter((t) => Number.isFinite(Number(t.tsIn)))
    .sort((a, b) => Number(a.tsIn) - Number(b.tsIn));
  if (list.length < folds * 10) return []; // not enough data — honest empty
  const out = [];
  for (let k = 1; k <= folds; k++) {
    const cutStart = list[Math.floor((list.length * (k - 1)) / folds)].tsIn;
    const cutEnd = list[Math.min(list.length - 1, Math.floor((list.length * k) / folds))].tsIn;
    const test = list.filter((t) => t.tsIn >= cutStart && t.tsIn < cutEnd);
    // PURGE: train me wo trades jo test window ke andar ya uske EMBARGO
    // me OVERLAP karte hain (tsOut > testStart - embargo) nahi aa sakte;
    // RIGHT side: test ke baad wale train trades ko bhi embargo milega
    // (tsIn >= testEnd + embargoMs) taki still-open test trades ke
    // overlap window me train na ghus sake.
    const testStart = cutStart, testEnd = cutEnd;
    const train = list.filter((t) => {
      const tsOut = Number.isFinite(Number(t.tsOut)) ? Number(t.tsOut) : Number(t.tsIn);
      return tsOut < testStart - embargoMs || t.tsIn >= testEnd + embargoMs;
    });
    out.push({ fold: k, train, test });
  }
  return out;
}
