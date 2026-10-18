// ============================================================
// server/ai/resolveDirection.js — v21.24.0 DIRECTION SSOT
// (audit/direction-guards Phase 2, item 3)
// ------------------------------------------------------------
// PROBLEM (audit Section 2): teen alag direction-engines (board ensemble,
// MTF plan, SVA verifier, AI council) ek doosre ko veto NAHI karte the —
// har engine apna apna directionVerified bana leta tha. Isliye ek hi
// coin par LONG ELITE (MTF) + SHORT 90 (board) saath chal sakte the.
//
// YE MODULE EK HI PURE FUNCTION deta hai jo teeno engines ke verdicts
// ko merge karta hai:
//   resolveDirection({ side, boardSide, sva, svaAction, councilVerdict })
//     → { side, boardSide, boardOpposes, svaOpposes, councilHardNo,
//         conflicts[], candleVerified passthrough, verified, label }
//
// fuseDualTf (mtfDualBoard.js) P0 patch ke inline guards EXACT yahi logic
// use karte hain — ye export usi logic ka canonical source hai taaki
// agents (agent.js / proTraderAuto.js / mtfAutoLink.js) aur UI sab ek
// hi jagah se direction truth le sakein. PURE — koi IO nahi.
// ============================================================

const SIDEABLE = new Set(['LONG', 'SHORT']);

/**
 * Cross-engine direction resolution. PURE.
 * @param {object} p
 *   side          MTF/plan side ('LONG'|'SHORT'|null)
 *   boardSide     board ensemble side ('LONG'|'SHORT'|null)
 *   sva           SVA verifier object ({action, finalCall, veto...}|null)
 *   svaAction     pre-resolved SVA action string (fuseDualTf me pehle se resolved)
 *   councilVerdict AI council / Ollama verdict string ('AGREE'|'AVOID'|...)
 *   candleVerified planner-level (candle-only) verified flag — conflict guards
 *                  isse AND karte hain
 * @returns resolved direction object
 */
export function resolveDirection({
  side = null,
  boardSide = null,
  sva = null,
  svaAction = null,
  councilVerdict = null,
  candleVerified = false,
} = {}) {
  const sideUp = String(side || '').toUpperCase();
  const boardSideRaw = String(boardSide || '').toUpperCase();
  const svaAct = String(svaAction || sva?.action || '').toUpperCase();
  const councilV = String(councilVerdict || '').toUpperCase();

  // (a) Board ensemble ne OPPOSITE side bola → direction conflict.
  const boardOpposes = SIDEABLE.has(boardSideRaw) && SIDEABLE.has(sideUp) && boardSideRaw !== sideUp;
  // (b) SVA ka FLIP / opposite finalCall.
  const svaFinal = String(sva?.finalCall || '').toUpperCase();
  const svaOpposes = Boolean(sva) && (svaAct === 'FLIP'
    || (SIDEABLE.has(svaFinal) && svaFinal !== sideUp && SIDEABLE.has(sideUp)));
  // (c) AI Council hard-disagree (AVOID/DISAGREE/SKIP).
  const councilHardNo = councilV === 'AVOID' || councilV === 'DISAGREE' || councilV === 'SKIP';

  const conflicts = [];
  if (boardOpposes) conflicts.push(`board ensemble side ${boardSideRaw} ≠ side ${sideUp} (direction conflict)`);
  if (svaOpposes) conflicts.push('SVA verifier says FLIP / opposite side');
  if (councilHardNo) conflicts.push(`AI council ${councilV} (hard disagree)`);

  const verified = SIDEABLE.has(sideUp) && Boolean(candleVerified) && !boardOpposes && !svaOpposes && !councilHardNo;
  const label = SIDEABLE.has(sideUp)
    ? (verified ? `PAKKA ${sideUp}` : (boardOpposes ? `CONFLICT-${sideUp}` : `WAIT-${sideUp}`))
    : 'NEUTRAL';

  return {
    side: SIDEABLE.has(sideUp) ? sideUp : null,
    boardSide: boardSideRaw || null,
    boardOpposes,
    svaOpposes,
    councilHardNo,
    conflicts,
    verified,
    label,
  };
}

export const __RESOLVE_DIRECTION_TEST_ONLY = { SIDEABLE };
