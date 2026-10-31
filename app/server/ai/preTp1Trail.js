// ============================================================
// server/ai/preTp1Trail.js — v21.31.0 PRE-TP1 NO-LOSS SMART SL TRAIL
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "Auto Trade lagne par AI Agent activate ho —
// highest volatility me smartly SL trail ho; TP1 tak wait na karna pade;
// SL no loss only profit ke hisaab se aage badhe; direction/trend realtime
// live market se fetch hota rahe."
//
// WHAT THIS MODULE OWNS
//   • A deterministic, exchange-independent pre-TP1 stop proposal.
//   • Fee-breakeven + volatility buffer as the FLOOR. Once armed, the stop is
//     never allowed back below that floor by this module.
//   • Ratchet-only behaviour: a proposal can only improve the current stop
//     (higher for LONG, lower for SHORT). It never loosens risk.
//   • Volatility class (LOW/NORMAL/HIGH/EXTREME) + momentum scaling: higher
//     volatility needs more room, so arm/giveback/buffer all widen.
//   • Signed live tick trend is used ONLY to tighten (adverse trend). A
//     favourable trend never widens an already-locked stop.
//   • Never proposes a stop at/through LTP (that would be an instant fill).
//
// WHAT IT DOES NOT OWN
//   • No exchange calls, no book writes, no closing decisions.
//   • No profit guarantee. Before the arm threshold the initial SL remains the
//     protection; a leveraged futures position can still lose money.
// ============================================================

export const PRE_TP1_TRAIL_MODES = Object.freeze(['enforce', 'shadow', 'off']);

// Higher volatility = wider stop. armR is the favourable excursion required
// before the fee-protected floor is locked; givebackR is the distance kept
// behind the favourable peak; bufferR is the profit cushion above the exact
// fee-breakeven level.
export const PRE_TP1_VOL_PROFILE = Object.freeze({
  LOW: Object.freeze({ armR: 0.30, givebackR: 0.30, bufferR: 0.06 }),
  NORMAL: Object.freeze({ armR: 0.38, givebackR: 0.42, bufferR: 0.10 }),
  HIGH: Object.freeze({ armR: 0.50, givebackR: 0.60, bufferR: 0.16 }),
  EXTREME: Object.freeze({ armR: 0.65, givebackR: 0.80, bufferR: 0.22 }),
});

const MOMENTUM_FACTOR = Object.freeze({
  SURGING: 1.10,
  STEADY: 1.00,
  FADING: 0.80,
  UNKNOWN: 1.00,
});

const STRONG_ADVERSE_TREND_PCT = -0.02;

function _num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _mode(raw, fallback = 'enforce') {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true' || v === 'active') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled' || v === 'none') return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'dryrun' || v === 'observe') return 'shadow';
  return fallback === 'enforce' || fallback === 'off' ? fallback : 'shadow';
}

function _r6(v) {
  return +Number(v).toFixed(6);
}

function _round2(v) {
  return +Number(v).toFixed(2);
}

function _profile(volClass, momentumState) {
  const key = String(volClass || 'NORMAL').toUpperCase();
  const base = PRE_TP1_VOL_PROFILE[key] || PRE_TP1_VOL_PROFILE.NORMAL;
  const factor = MOMENTUM_FACTOR[String(momentumState || 'STEADY').toUpperCase()]
    ?? MOMENTUM_FACTOR.STEADY;
  return {
    volClass: PRE_TP1_VOL_PROFILE[key] ? key : 'NORMAL',
    momentumState: String(momentumState || 'STEADY').toUpperCase(),
    momentumFactor: factor,
    armR: _round2(base.armR),
    givebackR: _round2(base.givebackR * factor),
    bufferR: _round2(base.bufferR * factor),
  };
}

/**
 * Pure pre-TP1 stop proposal.
 *
 * @param {object} input
 *   mode                enforce | shadow | off
 *   side                LONG | SHORT
 *   entry               entry price
 *   initialStopLoss     original protective stop (risk anchor)
 *   currentStopLoss     currently carried stop (ratchet base)
 *   peakPrice           favourable extreme since entry
 *   ltp                 live last traded price
 *   risk                |entry - initialStopLoss| (R)
 *   feeFloor            exact round-trip fee-breakeven price
 *   volClass            LOW | NORMAL | HIGH | EXTREME
 *   momentumState       SURGING | STEADY | FADING | UNKNOWN
 *   tickTrendPct        signed % trend over the live tick window (+ = with trade)
 *   tickTrendAdverse    true when the live tick trend is confirmed adverse
 *   allowMove           false = compute telemetry but never apply (stale quote)
 *
 * @returns {object} telemetry; `proposedSl` is the ratcheted candidate only
 *   when `applied` is true (enforce) — shadow reports what WOULD happen.
 */
export function evaluatePreTp1NoLossTrail(input = {}) {
  const mode = _mode(input.mode, 'enforce');
  const side = String(input.side || '').toUpperCase();
  const isLong = side === 'LONG';
  const entry = _num(input.entry);
  const initialSl = _num(input.initialStopLoss);
  const currentSl = _num(input.currentStopLoss, initialSl);
  const ltp = _num(input.ltp);
  const risk = _num(input.risk, Math.abs(entry - initialSl));
  const feeFloor = _num(input.feeFloor);
  const profile = _profile(input.volClass, input.momentumState);
  const trendPct = input.tickTrendPct == null ? null : _num(input.tickTrendPct);
  const trendAdverse = input.tickTrendAdverse === true
    || (trendPct != null && trendPct <= STRONG_ADVERSE_TREND_PCT);

  const base = {
    mode,
    available: mode !== 'off',
    active: false,
    armed: false,
    applied: false,
    reason: null,
    side: isLong ? 'LONG' : (side === 'SHORT' ? 'SHORT' : null),
    volClass: profile.volClass,
    momentumState: profile.momentumState,
    armR: profile.armR,
    armPrice: null,
    peakR: 0,
    currentR: 0,
    feeFloor: feeFloor > 0 ? _r6(feeFloor) : null,
    feeR: null,
    bufferR: profile.bufferR,
    givebackR: profile.givebackR,
    noLossSl: null,
    trailSl: null,
    proposedSl: null,
    currentStopLoss: currentSl > 0 ? _r6(currentSl) : null,
    lockedProfitR: null,
    trendPct: trendPct == null ? null : _num(trendPct),
    trendAdverse,
    trendTightened: false,
    ratchetOnly: true,
  };

  if (mode === 'off') return { ...base, reason: 'mode_off' };
  if (!isLong && side !== 'SHORT') return { ...base, reason: 'invalid_side' };
  if (!(entry > 0) || !(ltp > 0) || !(risk > 0)) return { ...base, reason: 'invalid_inputs' };
  if (!(feeFloor > 0)) return { ...base, reason: 'missing_fee_floor' };

  const rawPeak = _num(input.peakPrice, entry);
  const peak = isLong
    ? Math.max(rawPeak, entry, ltp)
    : Math.min(rawPeak > 0 ? rawPeak : entry, entry, ltp);
  const peakMove = isLong ? (peak - entry) : (entry - peak);
  const currentMove = isLong ? (ltp - entry) : (entry - ltp);
  const peakR = peakMove / risk;
  const currentR = currentMove / risk;
  const feeDistance = Math.abs(feeFloor - entry);
  const feeR = feeDistance / risk;
  // Arm only when the favourable excursion can pay the round-trip fee AND
  // leave the volatility buffer untouched. Defensive arm is allowed earlier
  // (fee covered) when the live trend has already turned adverse.
  const armR = _round2(Math.max(profile.armR, feeR + 0.10));
  const defensiveArmR = _round2(Math.max(feeR + 0.04, 0.20));
  const peakCoveredFee = isLong ? peak > feeFloor : peak < feeFloor;
  const armedNormal = peakCoveredFee && peakR >= armR;
  const armedDefensive = peakCoveredFee && trendAdverse && peakR >= defensiveArmR;
  const armed = armedNormal || armedDefensive;

  const noLossSl = isLong
    ? feeFloor + profile.bufferR * risk
    : feeFloor - profile.bufferR * risk;
  // Adverse live trend tightens the giveback (never below 0.15R). A favourable
  // trend is deliberately ignored here — it must never widen a locked stop.
  const givebackR = trendAdverse
    ? _round2(Math.max(0.15, profile.givebackR * 0.65))
    : profile.givebackR;
  const trailSl = isLong
    ? peak - givebackR * risk
    : peak + givebackR * risk;
  const candidate = isLong
    ? Math.max(noLossSl, trailSl)
    : Math.min(noLossSl, trailSl);

  const armPrice = isLong ? entry + armR * risk : entry - armR * risk;
  const lockedProfitR = isLong ? (candidate - entry) / risk : (entry - candidate) / risk;

  const out = {
    ...base,
    active: true,
    armed,
    armR,
    defensiveArmR,
    armPrice: _r6(armPrice),
    peakR: _round2(peakR),
    currentR: _round2(currentR),
    feeR: _round2(feeR),
    givebackR,
    trendTightened: Boolean(trendAdverse && profile.givebackR > givebackR),
    noLossSl: _r6(noLossSl),
    trailSl: _r6(trailSl),
    lockedProfitR: _round2(lockedProfitR),
  };

  if (!armed) {
    return {
      ...out,
      reason: peakCoveredFee ? 'below_arm_threshold' : 'fee_not_covered',
    };
  }

  // Never propose a stop at/through the live price: that is an instant fill,
  // not protection. Keep a small honest gap (>= 2% of R and >= 5 bps of LTP).
  const gap = Math.max(risk * 0.02, ltp * 0.0005);
  const crossesLtp = isLong ? candidate >= (ltp - gap) : candidate <= (ltp + gap);
  if (crossesLtp) {
    return { ...out, reason: 'would_cross_ltp' };
  }
  if (!(candidate > 0)) return { ...out, reason: 'invalid_candidate' };

  const improves = currentSl > 0
    ? (isLong ? candidate > currentSl + 1e-9 : candidate < currentSl - 1e-9)
    : true;
  if (!improves) {
    return { ...out, reason: 'no_improvement', proposedSl: null };
  }

  const proposedSl = _r6(candidate);
  const applied = mode === 'enforce' && input.allowMove !== false;
  return {
    ...out,
    applied,
    proposedSl: applied ? proposedSl : null,
    wouldApplySl: applied ? null : proposedSl,
    reason: applied ? 'applied' : (input.allowMove === false ? 'move_not_allowed' : 'shadow'),
  };
}
