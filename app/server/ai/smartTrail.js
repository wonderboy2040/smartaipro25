// ============================================================
// server/ai/smartTrail.js — v21.24.0 SMART TRAIL v2 (PURE module)
// ------------------------------------------------------------
// WHY (live log, 2026-10-24): AVAX SHORT, R = 0.287% of price.
//   Stage 4 fired at peak +1.2R and locked SL at +0.75R (floor 0.65R,
//   giveback 0.45R) => only ~0.4R of room = LESS than one 5m ATR.
//   Normal noise hit the trail, the whole position closed at +0.77R
//   (~Rs 26 gross on a Rs 12,000 notional) — while TP1 (1.69R) and TP2
//   were never reachable. Direction was right; the exit geometry was
//   smaller than market noise.
//
// WHAT v2 CHANGES (all in PRICE terms, not just R):
//   1. NOISE-AWARE DISTANCE — the SL may never sit closer to the peak
//      than  noiseK(momentum) x ATR  (and never < noiseFloorR x R).
//      R is the *entry stop*; it says nothing about how noisy the tape is.
//   2. TIERED RATCHET — fraction of peak profit that is locked grows with
//      the peak (30% at +1R ... 80% at +6R) — small winners get room,
//      big winners are protected.
//   3. FEE-SAFE FLOOR — once active the SL is never below fee break-even.
//   4. ROLLING TP2 — CoinDCX native TP closes the FULL position (there is
//      no partial on LIVE), so a fixed TP2 caps every winner at ~2R.
//      v2 pushes TP2 further (+stepR, max N times) when price APPROACHES
//      it with SURGING/STEADY momentum and no reversal hint — the trailing
//      SL (already >= +1R) keeps that profit safe.
//
// CONTRACT: pure functions, no I/O, no imports. The SL only ever TIGHTENS
// (caller uses tightenSl).
// MODES (env SMART_TRAIL_V2): off | shadow (DEFAULT, telemetry only) |
//   enforce.
// ============================================================

/** off | shadow | enforce — empty/garbage = shadow (safe default). */
export function smartTrailMode(env = process.env) {
  const raw = String(env?.SMART_TRAIL_V2 ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(raw)) return 'off';
  if (['enforce', 'on', '1', 'true', 'yes'].includes(raw)) return 'enforce';
  return 'shadow';
}

function envNum(env, key, dflt, lo, hi) {
  const raw = String(env?.[key] ?? '').trim();
  if (raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** Tunables (env-overridable, hard-clamped). Starting values — tune from shadow data. */
export function smartTrailConfig(env = process.env) {
  const base = envNum(env, 'SMART_TRAIL_NOISE_K', 0.60, 0.20, 1.50);
  return {
    // x ATR(context TF) = minimum SL distance BEHIND THE PEAK
    noiseK: {
      SURGING: +(base * 1.30).toFixed(3),
      STEADY: base,
      FADING: +(base * 0.65).toFixed(3),
      UNKNOWN: base,
    },
    noiseFloorR: envNum(env, 'SMART_TRAIL_NOISE_FLOOR_R', 0.45, 0.20, 1.50),
    noiseCapR: envNum(env, 'SMART_TRAIL_NOISE_CAP_R', 2.0, 0.80, 4.0),
    activationR: envNum(env, 'SMART_TRAIL_ACTIVATION_R', 1.0, 0.50, 3.0),
    // [peakR, fraction of peak profit locked]
    tiers: [[1.0, 0.30], [1.5, 0.40], [2.0, 0.50], [3.0, 0.62], [4.0, 0.72], [6.0, 0.80]],
    fadingFracAdd: 0.10,
    hintNoiseShrink: 0.80,       // exhaustion hint: tighten to 80% of noise distance (never below it entirely)
    tp1FloorMaxR: 1.0,           // after TP1 touched: lock at least min(0.5 x T1R, 1.0R)
    extend: {
      enabled: !['off', '0', 'false', 'no'].includes(String(env?.SMART_TRAIL_TP_EXTEND ?? 'on').trim().toLowerCase()),
      stepR: envNum(env, 'SMART_TRAIL_EXT_STEP_R', 1.0, 0.5, 3.0),
      maxExt: Math.round(envNum(env, 'SMART_TRAIL_MAX_EXT', 3, 0, 8)),
      approachR: envNum(env, 'SMART_TRAIL_EXT_APPROACH_R', 0.35, 0.10, 1.0),
    },
  };
}

/** Linear interpolation of the locked-fraction tier table. */
export function lockFraction(peakR, tiers) {
  const t = Array.isArray(tiers) && tiers.length ? tiers : smartTrailConfig().tiers;
  const p = Number(peakR);
  if (!(p > 0) || p < t[0][0]) return 0;
  if (p >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    const [x1, y1] = t[i];
    const [x0, y0] = t[i - 1];
    if (p <= x1) return y0 + ((p - x0) / (x1 - x0)) * (y1 - y0);
  }
  return t[t.length - 1][1];
}

/**
 * Smart trail plan for ONE evaluation.
 * @param {object} i
 *   isLong, entry, risk (|entry-initialSl|), peakPrice, ltp,
 *   atrPct (context-TF ATR % of price, may be null), momentum,
 *   feeFloor (fee break-even price), peakCoveredFee, tp1Touched, t1,
 *   reversalRiskHint
 * @returns {{active:boolean, slPrice:number|null, lockR:number, ...telemetry}}
 */
export function smartTrailPlan(i = {}, cfg = smartTrailConfig()) {
  const isLong = i.isLong !== false;
  const entry = Number(i.entry) || 0;
  const risk = Math.max(1e-12, Number(i.risk) || 0);
  const peakPrice = Number(i.peakPrice) || entry;
  const momentum = String(i.momentum || 'UNKNOWN').toUpperCase();
  const peakMove = isLong ? peakPrice - entry : entry - peakPrice;
  const peakR = peakMove / risk;

  // ATR in price units. Unknown ATR -> 0.8 x R (same honest estimate the
  // adoption path stamps: atrPct ~ 0.8 x slPct).
  const atrPctN = Number(i.atrPct);
  const atrPx = atrPctN > 0 ? (atrPctN / 100) * (peakPrice > 0 ? peakPrice : entry) : 0.8 * risk;
  const k = cfg.noiseK[momentum] ?? cfg.noiseK.UNKNOWN;
  const noisePxRaw = Math.max(k * atrPx, cfg.noiseFloorR * risk);
  const noisePx = Math.min(noisePxRaw, cfg.noiseCapR * risk);
  const noiseR = noisePx / risk;

  const tp1Touched = Boolean(i.tp1Touched);
  const active = peakR >= cfg.activationR || (tp1Touched && peakR >= 0.5);
  const base = {
    active: false, slPrice: null, lockR: null, peakR: +peakR.toFixed(3),
    noiseR: +noiseR.toFixed(3), noisePx: +noisePx.toFixed(8), atrPx: +atrPx.toFixed(8),
    momentum, tierFrac: 0, ratchetLockR: null, noiseLimitR: null, label: null,
  };
  if (!active) return base;

  let frac = lockFraction(peakR, cfg.tiers);
  if (momentum === 'FADING') frac = Math.min(0.90, frac + cfg.fadingFracAdd);
  const ratchetLockR = frac * peakR;
  const noiseLimitR = peakR - noiseR;
  let lockR = Math.min(ratchetLockR, noiseLimitR);   // looser of the two = never inside the noise

  // exhaustion hint (NOT a confirmed flip): tighten, but only to 80% of the noise gap
  if (i.reversalRiskHint) lockR = Math.max(lockR, peakR - cfg.hintNoiseShrink * noiseR);

  // fee-safe floor (only meaningful once the peak actually covered fees)
  const feeFloor = Number(i.feeFloor) || 0;
  if (feeFloor > 0 && i.peakCoveredFee !== false) {
    const beR = ((isLong ? feeFloor - entry : entry - feeFloor) / risk) + 0.02;
    lockR = Math.max(lockR, beR);
  }
  // after TP1 was touched keep at least half of T1 distance (<= tp1FloorMaxR)
  if (tp1Touched && Number(i.t1) > 0) {
    const t1R = Math.abs(Number(i.t1) - entry) / risk;
    lockR = Math.max(lockR, Math.min(cfg.tp1FloorMaxR, 0.5 * t1R));
  }
  // never put the SL on top of the peak itself
  lockR = Math.min(lockR, peakR - 0.10);
  lockR = Math.max(lockR, 0);

  const slPrice = +(isLong ? entry + lockR * risk : entry - lockR * risk).toFixed(8);
  return {
    ...base, active: true, slPrice, lockR: +lockR.toFixed(3),
    tierFrac: +frac.toFixed(3), ratchetLockR: +ratchetLockR.toFixed(3), noiseLimitR: +noiseLimitR.toFixed(3),
    label: `Smart Trail v2 · +${lockR.toFixed(2)}R locked · noise room ${noiseR.toFixed(2)}R (${momentum})`,
  };
}

/**
 * Rolling TP2: decide whether to push the target further instead of letting
 * a fixed TP2 close the whole position at ~2R.
 * @returns {null | {newT2:number, n:number, stepR:number, reason:string}}
 */
export function smartExtendTarget(i = {}, cfg = smartTrailConfig()) {
  const ex = cfg.extend;
  if (!ex?.enabled) return null;
  const isLong = i.isLong !== false;
  const entry = Number(i.entry) || 0;
  const risk = Math.max(1e-12, Number(i.risk) || 0);
  const t2 = Number(i.t2) || 0;
  const t1 = Number(i.t1) || 0;
  const n = Number(i.t2Extensions) || 0;
  if (!(t2 > 0) || !(entry > 0) || n >= ex.maxExt) return null;
  const momentum = String(i.momentum || 'UNKNOWN').toUpperCase();
  if (momentum !== 'SURGING' && momentum !== 'STEADY') return null;
  if (i.reversalRiskHint) return null;
  const ltp = Number(i.ltp) || 0;
  const fav = isLong ? ltp - entry : entry - ltp;
  const t2Dist = Math.abs(t2 - entry);
  const t1R = t1 > 0 ? Math.abs(t1 - entry) / risk : 1.0;
  const peakR = Number(i.peakR) || fav / risk;
  if (!(Boolean(i.tp1Touched) || peakR >= t1R)) return null;      // T1 must be behind us first
  if (fav < t2Dist - ex.approachR * risk) return null;             // not close enough to T2 yet
  const newT2 = +(isLong ? t2 + ex.stepR * risk : t2 - ex.stepR * risk).toFixed(8);
  if (!(newT2 > 0)) return null;                                   // never emit a non-tradable target
  return { newT2, n: n + 1, stepR: ex.stepR, reason: `price within ${ex.approachR}R of T2 · ${momentum} · no reversal hint → T2 +${ex.stepR}R (#${n + 1}/${ex.maxExt})` };
}
