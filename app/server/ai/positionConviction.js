// ============================================================
// server/ai/positionConviction.js — v10.15 GAP 1: LIVE CONVICTION TRACKER
// ------------------------------------------------------------
// THE GAP (superintelligence upgrade plan): the 14-model ensemble
// that carefully decided "LONG with 82% confidence" goes COMPLETELY
// SILENT the moment the position opens. If 9 of 14 models flip
// bearish 20 minutes later, nothing reacts until price physically
// hits a stop. A pro desk re-evaluates a live position continuously;
// this module makes the ensemble work DURING the trade.
//
//   convictionDelta = currentScore − entryScore   (sign relative to
//                     the position's direction: a LONG whose ensemble
//                     drifts bearish = strongly negative delta)
//   states: STRENGTHENING / HOLDING / WEAKENING / FLIPPED
//
// Wiring (agent.js / indiaAgent.js exit ticks — the SAME loop the
// time-exit/trend-flip sweeps run in, no second scheduler):
//   FLIPPED     (ensemble now votes the OPPOSITE side with quorum)
//               → exit immediately at market, journal `conviction-flip`
//               — the thesis-invalidation exit, BEFORE the stop is hit
//   WEAKENING   → TIGHTEN SL toward breakeven (only ever tightens —
//               never a hard exit; noise must not churn the book)
//   STRENGTHENING → feeds winnerExtend as an additional justification
//               (a strengthening thesis at window earns room even when
//               marginally red; a WEAKENING thesis never does)
//
// The re-vote rides getDeepSignal() — the SAME ensemble path
// (models + regime + adaptive + aggregateVotes) the board uses,
// 30s-cached, so a 30s agent cadence reuses cached indicator data
// with ZERO new upstream calls (the plan's cost contract).
//
// Safety: gated behind AI_ENABLE_CONVICTION_EXIT or the agent config
// knob (default OFF — flag-off behavior is byte-identical to today,
// locked by tests). Conviction EXITS run inside the agent tick's
// existing gauntlet (after the kill-switch/daily-cap early-returns),
// so they can never bypass the daily-trade-cap or kill-switch.
// ============================================================

/** Feature flag: env var (same pattern as MTF/meta-ensemble) OR the
 *  per-agent config knob. OFF by default. */
export function convictionEnabled(cfg) {
  if (['true', '1', 'on', 'yes'].includes(String(process.env.AI_ENABLE_CONVICTION_EXIT || '').trim().toLowerCase())) return true;
  return cfg?.convictionExit === true;
}

/** The side a signal/position is on, normalized to BUY/SELL. */
export function sideOf(raw) {
  const s = String(raw || '').toUpperCase();
  return s === 'SHORT' || s === 'SELL' ? 'SELL' : s === 'LONG' || s === 'BUY' ? 'BUY' : null;
}

/**
 * The conviction state for one open position. PURE.
 * @param {object} a
 *   posSide      'BUY' | 'SELL'        — the position's direction
 *   curSide      'BUY' | 'SELL' | null — the ensemble's CURRENT vote
 *   curScore     number (0-100, side-signed used internally) — the
 *                current signal's superIntel.aiScore
 *   entryScore   number|null — the aiScore recorded at entry
 *   quorumMet    boolean — the current OPPOSITE-side signal carries a
 *                real committee (≥5 voters OR STRONG grade): the bar a
 *                flip must clear before it can exit a position
 *   threshold    score points for STRENGTHENING/WEAKENING (default 8)
 * @returns {{state:'FLIPPED'|'WEAKENING'|'STRENGTHENING'|'HOLDING'|'UNKNOWN',
 *            delta:number|null, currentScore:number|null}}
 */
export function classifyConviction({ posSide, curSide, curScore, entryScore, quorumMet = false, threshold = 8 } = {}) {
  const pos = sideOf(posSide);
  const cur = sideOf(curSide);
  const score = Number(curScore);
  // NB: Number(null) === 0 (NOT NaN) — a null entryScore must stay
  // "missing" or every pre-upgrade position would read delta = full score.
  const entry = entryScore == null ? NaN : Number(entryScore);
  const th = Number(threshold) > 0 ? Number(threshold) : 8;
  if (!pos || !cur || !Number.isFinite(score)) {
    return { state: 'UNKNOWN', delta: null, currentScore: Number.isFinite(score) ? score : null };
  }
  // delta's sign is RELATIVE TO THE POSITION: a same-side vote counts
  // +score, an opposite-side vote counts −score.
  const eff = cur === pos ? score : -score;
  const delta = Number.isFinite(entry) ? Math.round((eff - entry) * 10) / 10 : null;
  if (cur !== pos && quorumMet) return { state: 'FLIPPED', delta, currentScore: score };
  if (delta == null) return { state: 'HOLDING', delta: null, currentScore: score };
  if (delta >= th) return { state: 'STRENGTHENING', delta, currentScore: score };
  if (delta <= -th) return { state: 'WEAKENING', delta, currentScore: score };
  return { state: 'HOLDING', delta, currentScore: score };
}

/** Does a signal carry a committee worth exiting on? (The flip bar.) */
export function quorumOfSignal(s) {
  if (!s) return false;
  const voters = Number(s.voters ?? s.participating ?? 0);
  if (voters >= 5) return true;
  return String(s.grade || '').toUpperCase() === 'STRONG';
}

/**
 * Conviction for one position from a FRESH deep signal (the re-vote).
 * PURE — reads the same shape getDeepSignal/getSignals produce.
 * @returns the classifyConviction result + the fresh side/score.
 */
export function convictionOfPosition(pos, freshSignal, entryScore, opts = {}) {
  const side = sideOf(String(pos.side || pos.direction || ''));
  const score = Number(freshSignal?.superIntel?.aiScore ?? freshSignal?.confidence ?? NaN);
  const curSide = freshSignal?.side ? sideOf(freshSignal.side) : null;
  // an abstaining/neutral ensemble (no side, no score) is UNKNOWN —
  // never exit on missing data
  if (!curSide || !Number.isFinite(score)) {
    return { state: 'UNKNOWN', delta: null, currentScore: null, side: null };
  }
  const out = classifyConviction({
    posSide: side,
    curSide,
    curScore: score,
    entryScore,
    quorumMet: quorumOfSignal(freshSignal),
    threshold: opts.threshold,
  });
  return { ...out, side: curSide };
}

/**
 * Should the WEAKENING response fire? SL tightening only when it
 * genuinely protects: the position must be IN PROFIT (breakeven is a
 * real improvement) — tightening a LOSING position's stop is just a
 * disguised early exit on noise. PURE.
 */
export function weakeningShouldTighten({ state, pnlPct }) {
  if (state !== 'WEAKENING') return false;
  return Number(pnlPct) > 0;
}

/** Winner-extension interplay (feeds extensionEligible). PURE.
 *  STRENGTHENING can justify an extension even marginally red;
 *  WEAKENING/FLIPPED must never earn room. */
export function extensionConvictionVote({ state, pnlPct }) {
  if (state === 'STRENGTHENING') return true;
  if (state === 'WEAKENING' || state === 'FLIPPED') return false;
  return Number(pnlPct) > 0;
}
