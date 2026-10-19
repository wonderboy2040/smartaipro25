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

// ------------------------------------------------------------
// Phase 3 — Ledger-Based MTF Direction Scorecard (30d rolling)
// ------------------------------------------------------------
const _mtfScanLedger = [];
const _mtfScanDedup = new Map(); // `${sym}:${mode}:${bucket30m}` -> id
const MTF_SCAN_MAX = 1500;
const DEDUP_BUCKET_MS = 30 * 60_000; // 30 minutes

const _r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/**
 * 3.1 Log every MTF Dual Board top-6 row into the MTF scan ledger
 * (deduped per symbol + mode + 30-minute bucket).
 */
export function recordMtfBoardScanRow(row, { now = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return null;
  const symbol = String(row.symbol || '').toUpperCase().trim();
  const side = String(row.side || '').toUpperCase();
  if (!symbol || (side !== 'LONG' && side !== 'SHORT')) return null;
  const entry = Number(row.plan?.entry ?? row.ltp ?? 0);
  const stopLoss = Number(row.plan?.stopLoss ?? 0);
  const t1 = Number(row.plan?.t1 ?? 0);
  const t2 = Number(row.plan?.t2 ?? 0);
  if (!(entry > 0) || !(stopLoss > 0) || !(t1 > 0)) return null;

  const mode = String(row.mode || 'INTRADAY').toUpperCase();
  const bucket = Math.floor((Number(now) || Date.now()) / DEDUP_BUCKET_MS);
  const dedupKey = `${symbol}:${mode}:${bucket}`;
  if (_mtfScanDedup.has(dedupKey)) {
    const existingId = _mtfScanDedup.get(dedupKey);
    return _mtfScanLedger.find((e) => e.id === existingId) || null;
  }

  const risk = Math.max(entry * 0.001, Math.abs(entry - stopLoss));
  const rec = {
    id: `mtf-${symbol}-${mode}-${now}-${Math.random().toString(36).slice(2, 7)}`,
    symbol,
    market: String(row.market || 'CRYPTO').toUpperCase(),
    mode,
    side,
    boardSide: row.boardSide ?? row.signals?.board?.side ?? null,
    boardSideConflict: Boolean(row.boardSideConflict),
    svaConflict: Boolean(row.svaConflict),
    councilConflict: Boolean(row.councilConflict),
    directionVerified: Boolean(row.directionVerified),
    superScore: Number(row.superScore) || 0,
    tier: row.tier || null,
    entry,
    stopLoss,
    t1,
    t2: t2 > 0 ? t2 : t1,
    risk,
    holdMin: Number(row.holdMin) || (mode === 'SWING' ? 240 : 60),
    ts: Number(now) || Date.now(),
    peakFavPrice: entry,
    peakAdvPrice: entry,
    mfeR: 0,
    maeR: 0,
    resolved: false,
    resolvedAt: null,
    outcome: 'PENDING', // 'T1_HIT' | 'T2_HIT' | 'SL_HIT' | 'TIMEOUT' | 'PENDING'
    outcomeR: null,
    directionHit: null,
  };
  _mtfScanLedger.push(rec);
  _mtfScanDedup.set(dedupKey, rec.id);
  while (_mtfScanLedger.length > MTF_SCAN_MAX) {
    _mtfScanLedger.shift();
  }
  return rec;
}

/**
 * 3.2 Update MFE/MAE and resolve MTF scan ledger rows against live quotes or OHLC candles.
 */
export function resolveMtfBoardScanOutcomes({ quotes = {}, candlesBySymbol = {}, now = Date.now() } = {}) {
  let updated = 0;
  let resolvedNow = 0;
  for (const e of _mtfScanLedger) {
    if (e.resolved) continue;
    const isLong = e.side === 'LONG';
    const qRaw = quotes[e.symbol] ?? quotes[`${e.market}|${e.symbol}`];
    const ltp = typeof qRaw === 'object' ? Number(qRaw?.price ?? qRaw?.ltp) : Number(qRaw);
    const candles = Array.isArray(candlesBySymbol[e.symbol]) ? candlesBySymbol[e.symbol] : [];

    const checkPriceRange = (highPx, lowPx) => {
      if (!(highPx > 0) || !(lowPx > 0)) return;
      if (isLong) {
        if (highPx > e.peakFavPrice) e.peakFavPrice = highPx;
        if (lowPx < e.peakAdvPrice) e.peakAdvPrice = lowPx;
      } else {
        if (lowPx < e.peakFavPrice) e.peakFavPrice = lowPx;
        if (highPx > e.peakAdvPrice) e.peakAdvPrice = highPx;
      }
      const favMove = isLong ? Math.max(0, e.peakFavPrice - e.entry) : Math.max(0, e.entry - e.peakFavPrice);
      const advMove = isLong ? Math.max(0, e.entry - e.peakAdvPrice) : Math.max(0, e.peakAdvPrice - e.entry);
      e.mfeR = _r2(favMove / e.risk) ?? 0;
      e.maeR = _r2(advMove / e.risk) ?? 0;

      const hitSl = isLong ? lowPx <= e.stopLoss : highPx >= e.stopLoss;
      const hitT2 = e.t2 > 0 && (isLong ? highPx >= e.t2 : lowPx <= e.t2);
      const hitT1 = isLong ? highPx >= e.t1 : lowPx <= e.t1;

      if (hitSl && !hitT1) {
        e.resolved = true;
        e.resolvedAt = now;
        e.outcome = 'SL_HIT';
        e.outcomeR = -1;
        e.directionHit = false;
        resolvedNow++;
      } else if (hitT2) {
        e.resolved = true;
        e.resolvedAt = now;
        e.outcome = 'T2_HIT';
        e.outcomeR = _r2(Math.abs(e.t2 - e.entry) / e.risk) ?? 2;
        e.directionHit = true;
        resolvedNow++;
      } else if (hitT1) {
        e.resolved = true;
        e.resolvedAt = now;
        e.outcome = 'T1_HIT';
        e.outcomeR = _r2(Math.abs(e.t1 - e.entry) / e.risk) ?? 1;
        e.directionHit = true;
        resolvedNow++;
      }
    };

    for (const c of candles) {
      if (e.resolved) break;
      if (Number(c?.ts ?? c?.time ?? now) < e.ts) continue;
      checkPriceRange(Number(c.high ?? c.close), Number(c.low ?? c.close));
      updated++;
    }
    if (!e.resolved && Number(ltp) > 0) {
      checkPriceRange(ltp, ltp);
      updated++;
    }

    const elapsedMin = Math.max(0, (now - e.ts) / 60_000);
    if (!e.resolved && elapsedMin >= e.holdMin) {
      e.resolved = true;
      e.resolvedAt = now;
      e.outcome = 'TIMEOUT';
      const endPx = Number(ltp) > 0 ? Number(ltp) : e.peakFavPrice;
      const signedMove = isLong ? (endPx - e.entry) : (e.entry - endPx);
      e.outcomeR = _r2(signedMove / e.risk) ?? 0;
      e.directionHit = (e.mfeR >= 0.5 && e.maeR < 1.0) || e.outcomeR > 0;
      resolvedNow++;
    }
  }
  return { updated, resolvedNow, total: _mtfScanLedger.length };
}

/**
 * 3.3 Compute 30-day rolling MTF Direction Scorecard for UI & API.
 */
export function computeMtfDirectionScorecard({ windowDays = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(windowDays) || 30) * 86_400_000;
  const rows = _mtfScanLedger.filter((r) => r.ts >= cutoff);
  const resolved = rows.filter((r) => r.resolved);
  const alignedResolved = resolved.filter((r) => !r.boardSideConflict && !r.svaConflict && !r.councilConflict);
  const conflictResolved = resolved.filter((r) => r.boardSideConflict || r.svaConflict || r.councilConflict);

  const summarize = (list) => {
    const n = list.length;
    if (n === 0) {
      return {
        n: 0,
        directionHitRate: null,
        t1HitPct: null,
        slFirstPct: null,
        wrongWayRate: null,
        avgR: null,
        wilsonLB: null,
      };
    }
    const dirHits = list.filter((r) => r.directionHit || r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT' || (r.mfeR >= 0.5 && r.outcome !== 'SL_HIT')).length;
    const t1Hits = list.filter((r) => r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT').length;
    const slHits = list.filter((r) => r.outcome === 'SL_HIT').length;
    const wrongWay = list.filter((r) => r.outcome === 'SL_HIT' && Number(r.mfeR) < 0.25).length;
    const rs = list.map((r) => Number(r.outcomeR)).filter((x) => Number.isFinite(x));
    return {
      n,
      directionHitRate: _r2((dirHits / n) * 100),
      t1HitPct: _r2((t1Hits / n) * 100),
      slFirstPct: _r2((slHits / n) * 100),
      wrongWayRate: _r2((wrongWay / n) * 100),
      avgR: rs.length ? _r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
      wilsonLB: _r2(wilsonLowerBound(t1Hits, n) * 100),
    };
  };

  const overall = summarize(resolved);
  const alignedBucket = summarize(alignedResolved);
  const conflictBucket = summarize(conflictResolved);

  return {
    windowDays,
    totalScans: rows.length,
    resolvedCount: resolved.length,
    pendingCount: rows.length - resolved.length,
    calibrated: resolved.length >= 20,
    ...overall,
    alignedBucket,
    conflictBucket,
    recentScans: rows.slice(-12).reverse(),
  };
}

export function __resetMtfLedgerForTests() {
  _mtfScanLedger.length = 0;
  _mtfScanDedup.clear();
}
