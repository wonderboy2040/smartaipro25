// ============================================================
// server/ai/volTrail.js — v21.23.7 VOLATILITY-ADAPTIVE SUPER SMART SL TRAIL
// ------------------------------------------------------------
// USER PROBLEM (verbatim): "jab long or short pe TP1 & TP2 Profit book tak
// reach nhi ho raha hai bada profit amount book nhi ho raha hai bahut kam
// profit book karke trade exit ho raha hai isko advance pro level pe smart
// banao sl trail ko aur improvement karo trade volatile me"
//
// ROOT CAUSES (v21.23.7 audit):
//   C1 — Stage thresholds FIXED (0.18/0.30/0.50/0.80R) — high-volatile market
//        me 0.30R move NORMAL noise hai magar system Stage-1 pe trail shuru
//        kar deta tha aur har pullback SL tighten kar deta tha.
//   C2 — Stage-1/2 trails volatile me bahut aggressive (-0.65R / -0.45R) —
//        ek normal wick hi SL laga deti thi.
//   C3 — Chandelier width fixed (0.50R) — high-vol me 0.50R pullback ROUTINE
//        hai, TP2 se theek pehle SL hit ho jaati thi.
//   C4 — Momentum-aware acceleration missing — fast move deta trail ko room
//        chahiye (WIDEN), momentum fade ho to TIGHTEN.
//   C5 — Giveback thresholds static (45% / 0.28R) — high-vol me ek candle
//        me hi 45% giveback ho jaata hai — true reversal nahi, sirf noise.
//
// THE FIX — volatility classification (boardRow.context.atrPct / trade.atrPct):
//   LOW     (ATR < 0.8%)   → TIGHT trails (price dheere chalta hai)
//   NORMAL  (0.8–1.8%)     → STANDARD trails (v21.23.6 values)
//   HIGH    (1.8–3.5%)     → WIDE trails — stage thresholds UPAR, chandelier
//                            wider, giveback tolerance zyada
//   EXTREME (≥ 3.5%)       → ULTRA-WIDE — maximum room for volatile moves
//
// SAFETY (user spec):
//   • LOW vol behavior identical-or-TIGHTER than v21.23.6 (no regression)
//   • monotonic ratchet guarantees preserved (tightenSl pe hi)
//   • fee-aware guards preserved (deep monitor me as-is)
//   • momentum multipliers clamped (kabhi bhi unbounded loose nahi)
// ============================================================

/** ATR% volatility class boundaries (user spec: <0.8 / <1.8 / <3.5 / ≥3.5). */
export const VOL_CLASS = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  EXTREME: 'EXTREME',
};

/** ATR% → volatility class. null/invalid → NORMAL (v21.23.6 behavior default). */
export function classifyVolatility(atrPct) {
  const a = Number(atrPct);
  if (!Number.isFinite(a) || a <= 0) return VOL_CLASS.NORMAL;
  if (a < 0.8) return VOL_CLASS.LOW;
  if (a < 1.8) return VOL_CLASS.NORMAL;
  if (a < 3.5) return VOL_CLASS.HIGH;
  return VOL_CLASS.EXTREME;
}

/**
 * THE VOLATILITY-ADAPTIVE TRAIL TABLE (user v21.23.7 spec, exact values):
 *
 *  Param                  LOW     NORMAL  HIGH    EXTREME   (v21.23.6 current)
 *  stage1EarlyR           0.18    0.22    0.30    0.40      (0.18)
 *  stage1R                0.30    0.35    0.45    0.55      (0.30)
 *  stage2R                0.50    0.55    0.65    0.75      (0.50)
 *  stage3R                0.80    0.85    0.95    1.05      (0.80)
 *  stage3GivebackR        0.32    0.35    0.42    0.50      (0.32)
 *  stage4GivebackR        0.40    0.45    0.55    0.65      (0.45)
 *  stage5ChandelierR      0.45    0.50    0.65    0.80      (0.50)
 *  givebackRatioPct       42      45      55      65        (45)
 *  givebackAbsFloorR      0.25    0.28    0.38    0.50      (0.28)
 *  hintGivebackR          0.50    0.50    0.65    0.65      (0.50)
 *  tp1ClosePct            0.50    0.50    0.40    0.35      (0.50)
 *
 * stage3GivebackR spec me explicitly nahi tha — Stage-4 ke relative widening
 * ke proportion me scale kiya (monotonic: stage3 ≤ stage4 har class me).
 * stage-1 early-breakeven bar = stage1R + 0.12 (LOW 0.42 = v21.23.6 identical).
 */
export const TRAIL_TABLE = {
  [VOL_CLASS.LOW]: {
    stage1EarlyR: 0.18, stage1R: 0.30, stage2R: 0.50, stage3R: 0.80,
    stage3GivebackR: 0.32, stage4GivebackR: 0.40, stage5ChandelierR: 0.45,
    givebackRatioPct: 42, givebackAbsFloorR: 0.25,
    hintGivebackR: 0.50, tp1ClosePct: 0.50,
  },
  [VOL_CLASS.NORMAL]: {
    stage1EarlyR: 0.22, stage1R: 0.35, stage2R: 0.55, stage3R: 0.85,
    stage3GivebackR: 0.35, stage4GivebackR: 0.45, stage5ChandelierR: 0.50,
    givebackRatioPct: 45, givebackAbsFloorR: 0.28,
    hintGivebackR: 0.50, tp1ClosePct: 0.50,
  },
  [VOL_CLASS.HIGH]: {
    stage1EarlyR: 0.30, stage1R: 0.45, stage2R: 0.65, stage3R: 0.95,
    stage3GivebackR: 0.42, stage4GivebackR: 0.55, stage5ChandelierR: 0.65,
    givebackRatioPct: 55, givebackAbsFloorR: 0.38,
    hintGivebackR: 0.65, tp1ClosePct: 0.40,
  },
  [VOL_CLASS.EXTREME]: {
    stage1EarlyR: 0.40, stage1R: 0.55, stage2R: 0.75, stage3R: 1.05,
    stage3GivebackR: 0.50, stage4GivebackR: 0.65, stage5ChandelierR: 0.80,
    givebackRatioPct: 65, givebackAbsFloorR: 0.50,
    hintGivebackR: 0.65, tp1ClosePct: 0.35,
  },
};

/** Volatility-aware TP1 partial book pct (spec item 6: HIGH/EXTREME me
 *  TP1 partial REDUCED — runner trend potential ke liye BADA rakhta hai). */
export function tp1ClosePctFor(volClass) {
  const p = TRAIL_TABLE[String(volClass) || VOL_CLASS.NORMAL] || TRAIL_TABLE[VOL_CLASS.NORMAL];
  return p.tp1ClosePct;
}

/** Base (momentum-neutral) trail profile for a volatility class. */
export function trailProfileFor(volClass) {
  const cls = TRAIL_TABLE[String(volClass) || VOL_CLASS.NORMAL]
    ? String(volClass)
    : VOL_CLASS.NORMAL;
  return { volClass: cls, ...TRAIL_TABLE[cls] };
}

// ------------------------------------------------------------
// C4 — MOMENTUM-AWARE ACCELERATION
// "When price is moving FAST toward TP1/TP2 with strong momentum, the trail
//  should WIDEN to give room. When momentum fades, trail should TIGHTEN."
// Data: boardRow.trigger.{roc1, roc3, volRatio} (tradePlanner se) — trade
// direction ke hisaab se signed. Fields absent → UNKNOWN (neutral).
// ------------------------------------------------------------
export const MOMENTUM = {
  SURGING: 'SURGING',   // fast move in trade direction — trail WIDENS
  STEADY: 'STEADY',     // normal — no adjustment
  FADING: 'FADING',     // move exhausting — trail TIGHTENS
  UNKNOWN: 'UNKNOWN',   // no trigger data (3s fast loop w/o boardRow) — neutral
};

/**
 * Momentum state from live board trigger fields, side-aware.
 * roc1/roc3 = 1/3-bar % rate-of-change, volRatio = current/avg volume.
 * dirSign: LONG=+1, SHORT=−1 — roc values ko trade direction me flip karo.
 */
export function momentumStateOf(side, boardRow) {
  const trig = boardRow?.trigger || null;
  if (!trig) return MOMENTUM.UNKNOWN;
  const roc1 = Number(trig.roc1);
  const roc3 = Number(trig.roc3);
  const volRatio = Number(trig.volRatio);
  const dirSign = String(side || '').toUpperCase() === 'SHORT' ? -1 : 1;
  const r1 = Number.isFinite(roc1) ? roc1 * dirSign : null;
  const r3 = Number.isFinite(roc3) ? roc3 * dirSign : null;
  const vr = Number.isFinite(volRatio) ? volRatio : null;
  if (r1 == null && r3 == null) return MOMENTUM.UNKNOWN;
  // SURGING: both horizons in-direction with volume expansion (fast trend).
  const surging = (r1 != null && r1 >= 0.05) && (r3 != null && r3 >= 0.25) && (vr == null || vr >= 1.05);
  if (surging) return MOMENTUM.SURGING;
  // FADING: 1-bar flipped against trade + (3-bar flat/negative or dry volume).
  const fading = (r1 != null && r1 <= -0.03) && ((r3 != null && r3 <= 0) || (vr != null && vr < 0.75));
  if (fading) return MOMENTUM.FADING;
  return MOMENTUM.STEADY;
}

// Momentum multipliers (C4) — clamped so LOW-vol kabhi user table se loose
// nahi hota aur kabhi bhi unbounded widen nahi hota.
const _MOM_WIDEN = {
  chandelier: 1.15,       // SURGING: chandelier ×1.15 (ride the fast move)
  stage4GivebackAdd: 0.10, // +0.10R TP1 ke baad ka room
  stage3GivebackAdd: 0.05, // +0.05R pre-TP1 ratchet room
  hintGivebackAdd: 0.15,   // exhaustion-hint lock ko delay (fast trend me hints routine hote hain)
  ratioPctAdd: 5,           // giveback ratio +5pct
};
const _MOM_TIGHTEN = {
  chandelier: 0.85,        // FADING: chandelier ×0.85 (profit lock karo)
  hintGivebackSub: 0.15,   // hint lock JALDI (move khatam ho raha hai)
  ratioPctSub: 5,
  absFloorSub: 0.03,
};

/**
 * C4: momentum-adjusted trail profile. Base profile ko momentum state ke
 * hisaab se widen/tighten karo (tightenSl ratchet engine me hai — yahan
 * sirf TARGET widths adjust hoti hain, kabhi SL loose nahi hota).
 *
 * Bounds (hard clamps): chandelier ∈ [0.40, 1.00]R, stage4Giveback ≤ 0.70R,
 * hintGiveback ∈ [0.40, 0.80]R, ratio ∈ [35, 75]%, absFloor ≥ 0.20R.
 */
export function applyMomentum(profile, momentumState) {
  const p = { ...profile };
  const m = String(momentumState || MOMENTUM.UNKNOWN).toUpperCase();
  const round2 = (x) => Math.round(x * 100) / 100;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  if (m === MOMENTUM.SURGING) {
    p.stage5ChandelierR = round2(clamp(p.stage5ChandelierR * _MOM_WIDEN.chandelier, 0.40, 1.00));
    p.stage4GivebackR = round2(clamp(p.stage4GivebackR + _MOM_WIDEN.stage4GivebackAdd, 0.35, 0.70));
    p.stage3GivebackR = round2(clamp(p.stage3GivebackR + _MOM_WIDEN.stage3GivebackAdd, 0.28, 0.60));
    p.hintGivebackR = round2(clamp(p.hintGivebackR + _MOM_WIDEN.hintGivebackAdd, 0.40, 0.80));
    p.givebackRatioPct = Math.round(clamp(p.givebackRatioPct + _MOM_WIDEN.ratioPctAdd, 35, 75));
  } else if (m === MOMENTUM.FADING) {
    p.stage5ChandelierR = round2(clamp(p.stage5ChandelierR * _MOM_TIGHTEN.chandelier, 0.40, 1.00));
    p.hintGivebackR = round2(clamp(p.hintGivebackR - _MOM_TIGHTEN.hintGivebackSub, 0.40, 0.80));
    p.givebackRatioPct = Math.round(clamp(p.givebackRatioPct - _MOM_TIGHTEN.ratioPctSub, 35, 75));
    p.givebackAbsFloorR = round2(clamp(p.givebackAbsFloorR - _MOM_TIGHTEN.absFloorSub, 0.20, 0.80));
  }
  p.momentumState = m;
  return p;
}

/**
 * Vol class resolve — LIVE ATR% (boardRow.context.atrPct) > entry-stamped
 * trade.atrPct > previously-stamped trade.volClass > NORMAL (default).
 * 3s fast loop (no boardRow) falls back to 15s-tick-stamped b.* fields —
 * dono loops me SAME vol regime chalta hai.
 */
export function resolveVolClass({ liveAtrPct, tradeAtrPct, tradeVolClass } = {}) {
  const live = Number(liveAtrPct);
  if (Number.isFinite(live) && live > 0) {
    return { volClass: classifyVolatility(live), atrPct: +live.toFixed(4) };
  }
  const stamped = Number(tradeAtrPct);
  if (Number.isFinite(stamped) && stamped > 0) {
    return { volClass: classifyVolatility(stamped), atrPct: +stamped.toFixed(4) };
  }
  const cls = String(tradeVolClass || '').toUpperCase();
  if (TRAIL_TABLE[cls]) return { volClass: cls, atrPct: null };
  return { volClass: VOL_CLASS.NORMAL, atrPct: null };
}

/**
 * Full resolution: vol class + momentum → final trail profile.
 * Pure — deep monitor har evaluation par call karta hai.
 */
export function trailProfileResolved({ side, boardRow, liveAtrPct, tradeAtrPct, tradeVolClass, tradeMomentumState } = {}) {
  const { volClass, atrPct } = resolveVolClass({ liveAtrPct, tradeAtrPct, tradeVolClass });
  let momentum = momentumStateOf(side, boardRow);
  if (momentum === MOMENTUM.UNKNOWN && tradeMomentumState) {
    momentum = String(tradeMomentumState).toUpperCase(); // 15s-tick stamp fallback
  }
  const profile = applyMomentum(trailProfileFor(volClass), momentum);
  return { ...profile, volClass, atrPct };
}
