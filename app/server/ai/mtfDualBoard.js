// ============================================================
// server/ai/mtfDualBoard.js — v21.16.0 MTF SIGNALS BOARD (DUAL-TIMEFRAME)
//                           + SUPERINTELLIGENCE FUSE + AUTO-LINK PLANNER
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "MTF Signals Board (Dual-Timeframe) ko
// superintelligence se upgrade karo — 75+ score wale ACTION/STRONG
// signals ko paper trade / auto trade se link kardo."
//
// YE MODULE TEEN KAAM KARTA HAI:
//
// 1. DUAL-TF BOARD — board ke SAME signals par do alag MODES ka MTF
//    plan chalata hai aur unhe EK ROW me fuse karta hai:
//      INTRADAY : 15m deep (context) + 5m action (trigger)  ← user plan A
//      SWING    : 1h  deep (context) + 15m action (trigger) ← user plan B
//    Har row: board signal + context read + trigger read + full ticket
//    (entry/SL/T1/T2) + TF-fit + cost-in-R + dual/6TF alignment.
//
// 2. SUPERINTELLIGENCE FUSE — ek FINAL score jo pehle kabhi nahi tha:
//      superScore = 0.30·contextTrend(deep TF)
//                 + 0.25·triggerAction(trigger TF)
//                 + 0.20·planConfidence(tradePlanner)
//                 + 0.15·mtfExtended (6TF 1d+4h bias; missing → base me redistribute)
//                 + 0.10·boardBase (board signal ka apna aiScore)
//    + quality gates (MISMATCH cap 70, counter-trend cap 74 — 75+ auto
//      bar ko structurally cross nahi kar sakte), alignment bonus.
//    Tier: ELITE 85+ / STRONG 80+ / ACTION 65+ / WATCH 50+ (superIntel.js).
//
// 3. AUTO-LINK PLANNER — `dualAutoCandidates()` PURE function jo batati
//    hai kaun sa row paper/auto entry ke liye QUALIFY karta hai:
//      score ≥ 75 · side LONG/SHORT · trigger FIRED · tfFit GOOD/OK ·
//      not counter-trend · context+trigger+side teeno aligned (dual
//      confirmation) · plan grade A/B · not overextended · valid SL/T1/T2
//    Har row pe `autoEligible` + `autoBlockers[]` — UI exact reason
//    dikhata hai (koi black box nahi). Execution side (paper/auto)
//    mtfAutoLink.js karta hai — ye module sirf SIFT karta hai.
//
// HONESTY: koi bhi row tabhi banega jab dono TF ke candles resolve
// hon. Data na mile → row `unavailable` (board se chup-chaap gayab
// nahi hota, honest reason ke saath rehta hai).
// ============================================================
// v21.23.1: unused `buildMTFSnapshot` import hata (lint) — 6-TF snapshot
// fuse me optional `snap` param se aata hai (routes caller build karta hai).
import { buildHtfBiasSnapshot, mtfWire6Payload, rawTfCandles, rawTfCandlesUsdt } from './mtf.js';
import { superTier, SUPER_TIERS } from './superIntel.js';
import { buildPlanFromCandles, PLAN_MODES } from './tradePlanner.js';
// v21.23.11 MIRROR-SHIELD L2: live-tick stamp forming bar = TRUE newest.
import { ensureAscending } from './lib/candles.js';
import { ollamaStatus, evaluateMtfRowWithOllamaTrio, getOllamaTrioModels } from './llmSentinel.js';
import { feeBreakevenFloor, defaultRoundTripFeePct } from '../exec/sizing.js';
import { fetchFuturesPrices } from './futures.js';
import { resolveDirection, checkDirectionLock } from './directionLock.js';
// v21.25.0 DIRECTION CERTIFICATE — one strict shared contract for signal side
// → exchange order side, SL/target geometry and activePos mismatch.
import {
  buildDirectionCertificate, normalizeSide, summarizeBoardDirectionIntegrity,
} from './directionCertificate.js';
import {
  recordMtfBoardScanRow, resolveMtfBoardScanOutcomes, computeMtfDirectionScorecard,
  hydrateMtfLedger, getMtfLedgerSnapshot,
} from './signalLedger.js';
import { loadMtfRowLedger, saveMtfRowLedger } from './mtfRowLedgerStore.js';

// v21.25.2: 30-day MTF scorecard restart-safe. Pehle ledger sirf memory me
// tha — server restart par 30d calibration zero ho jati thi aur phase0 audit
// ka `mtf-row-ledger.json` permanently stale rehta tha.
let _mtfLedgerHydrated = false;
function ensureMtfLedgerHydrated() {
  if (_mtfLedgerHydrated) return;
  _mtfLedgerHydrated = true;
  try {
    const saved = loadMtfRowLedger();
    hydrateMtfLedger(saved.rows, {
      lastLogAt: saved.lastLogAt,
      lastResolveAt: saved.lastResolveAt,
    });
  } catch { /* read-only / corrupt file — memory-only mode */ }
}
/** Test hook — next board build re-reads the persisted ledger. */
export function __resetMtfLedgerHydrationForTests() { _mtfLedgerHydrated = false; }

/** v21.18.0 USER SPEC: sirf 2 dual-timeframe modes on the integrated board:
 *   • INTRADAY : 15m deep (context) + 5m action (trigger)
 *   • SWING    : 1h  deep (context) + 15m action (trigger)
 */
export const DUAL_BOARD_MODES = Object.freeze(['INTRADAY', 'SWING']);
/** v21.20.0 USER SPEC: Keep ONLY the Top 6 Deep-Trend (LONG or SHORT) symbols on the MTF Signals Board. */
export const TOP_DEEP_TREND_LIMIT = 6;

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Maps the 6-TF engine's htfBias/consensus to the −1/0/+1 space. */
function dirOfBias(bias) {
  const b = String(bias || '').toUpperCase();
  return b === 'BULLISH' ? 1 : b === 'BEARISH' ? -1 : b === 'NEUTRAL' ? 0 : null;
}

// ------------------------------------------------------------
// 1) PURE FUSE — dual-TF + superintelligence scoring
// ------------------------------------------------------------
/**
 * @param {object} p
 *  symbol, market
 *  boardSig     the board signal row (may be null when the symbol is not on the board)
 *  plan         tradePlanner output (buildPlanFromCandles / getTradePlan)
 *  snap         MTF-6 snapshot (may be null — then the 0.15 weight redistributes)
 *  modeId       'INTRADAY' | 'SWING' | 'SCALP'
 */
/**
 * v21.26.3 [ONE AI SCORE]: the AUTHORITATIVE main-board AI snapshot — exactly
 * the same `superIntel.aiScore` + `superIntel.tier` pair the DEEP ENSEMBLE
 * modal renders. The MTF `superScore` is a separate fused timing metric and
 * must never be presented as "the AI score". Both surfaces read this shape,
 * so a symbol can no longer show 83 in DEEP and 99 in the MTF board.
 */
export function mainAiSnapshot(boardSig) {
  if (!boardSig) return null;
  return {
    side: boardSig.side ?? null,
    aiScore: boardSig.superIntel?.aiScore ?? null,
    aiTier: boardSig.superIntel?.tier ?? null,
    grade: boardSig.grade ?? null,
    confidence: boardSig.confidence ?? null,
    winProb: (boardSig.superIntel?.winProb && typeof boardSig.superIntel.winProb === 'object') ? {
      verdict: boardSig.superIntel.winProb.verdict ?? null,
      pWin: boardSig.superIntel.winProb.pWin ?? null,
      evR: boardSig.superIntel.winProb.evRealisticR ?? boardSig.superIntel.winProb.evR ?? null,
      calibrated: !!boardSig.superIntel.winProb.calibrated,
    } : null,
  };
}

export function fuseDualTf({ symbol, market, boardSig = null, plan = null, snap = null, modeId = 'INTRADAY' }) {
  const side = normalizeSide(plan?.side);
  const dir = side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0;
  const boardSideMatches = !boardSig?.side || !side || String(boardSig.side).toUpperCase() === side;
  const baseScore = (() => {
    if (!boardSideMatches) return null;
    const s = boardSig?.superIntel?.aiScore;
    const n = Number(s);
    return Number.isFinite(n) ? clamp(n, 1, 99) : null;
  })();
  const trendDir = plan?.context?.dir ?? null;          // deep TF read
  const trigDir = plan?.trigger?.dir != null
    ? plan.trigger.dir
    : (plan?.trigger?.broke ? dir : 0);
  const trendScore = plan?.context?.score ?? null;      // 0-100
  const trigScore = plan?.trigger?.score ?? null;       // 0-100
  const planConf = plan?.confidence ?? null;
  const ext = snap?.ok ? dirOfBias(snap.htfBias) : null; // 1d+4h bias
  const counterHtf = Boolean(dir !== 0 && ext != null && ext === -dir);

  // Component contributions (weights re-normalize when a source is missing)
  // v21.19.0 FIX: extendedBias must be direction-aligned (`ext * dir > 0` → 78,
  // `ext * dir < 0` → 22) so SHORT setups with BEARISH 1d+4h bias get 78 instead of 22!
  const comps = [];
  if (trendScore != null) comps.push({ k: 'contextTrend', w: 0.30, v: trendScore });
  if (trigScore != null) comps.push({ k: 'triggerAction', w: 0.25, v: trigScore });
  if (planConf != null) comps.push({ k: 'planConfidence', w: 0.20, v: planConf });
  if (ext != null) {
    const extV = dir !== 0 ? (ext * dir > 0 ? 78 : ext * dir < 0 ? 22 : 50) : (ext > 0 ? 78 : ext < 0 ? 22 : 50);
    comps.push({ k: 'extendedBias', w: 0.15, v: extV });
  }
  if (baseScore != null) comps.push({ k: 'boardBase', w: 0.10, v: baseScore });
  const wSum = comps.reduce((a, c) => a + c.w, 0) || 1;
  let score = comps.reduce((a, c) => a + c.w * c.v, 0) / wSum;

  const drivers = [];
  const gates = [];

  // ---- alignment bonus: context AND trigger AND extended all with the side ----
  const dualAligned = dir !== 0 && trendDir === dir && trigDir === dir;
  const tripleAligned = dualAligned && ext === dir;
  const earlyIgnition = Boolean((plan?.context?.earlyIgnition || plan?.trigger?.earlyIgnition) && !plan?.context?.exhausted && !plan?.trigger?.reversalRisk);
  const reversalRisk = Boolean(plan?.trigger?.reversalRisk || plan?.context?.exhausted || plan?.trigger?.opposingFlow);
  if (dualAligned) { score += 4; drivers.push('dual-TF confirm: context+trigger aligned (+4)'); }
  if (tripleAligned) { score += 2; drivers.push('1d+4h extended bias bhi aligned (+2)'); }
  if (dualAligned && earlyIgnition) { score += 5; drivers.push('⚡ ultra-fast early trend ignition: EMA5/9/20 + MACD velocity (+5)'); }

  // ---- quality gates (all HARD caps — auto bar 75 ko structurally block) ----
  let cap = null;
  const fit = plan?.tfFit?.verdict;
  if (fit === 'MISMATCH') { cap = 70; gates.push('TF-fit MISMATCH — score capped 70'); }
  else if (fit === 'STRETCH') { score -= 6; drivers.push('TF-fit STRETCH (−6)'); }
  if (plan?.counterTrend) {
    cap = cap == null ? 74 : Math.min(cap, 74);
    gates.push('counter-trend — capped 74 (auto bar clear nahi kar sakta)');
  }
  if (counterHtf) {
    score -= 10;
    cap = cap == null ? 58 : Math.min(cap, 58);
    gates.push(`1d+4h HTF bias ${snap?.htfBias} side ${side} ke against — counter-HTF veto, capped 58 (auto + live bar)`);
  }
  if (plan?.trigger?.opposingFlow) {
    cap = cap == null ? 58 : Math.min(cap, 58);
    gates.push('action-TF opposing context trend — capped 58 (WATCH)');
  }
  if (plan?.trigger?.reversalRisk) {
    cap = cap == null ? 58 : Math.min(cap, 58);
    score -= 10;
    gates.push('action-TF reversal/rejection wick risk — capped 58 (WATCH)');
  } else if (plan?.context?.exhausted) {
    cap = cap == null ? 64 : Math.min(cap, 64);
    score -= 8;
    gates.push('deep-TF move exhausted/stretched — capped 64 (WATCH)');
  }
  if (trendDir != null && dir !== 0 && trendDir !== dir) { score -= 8; drivers.push('deep-TF context side ke against (−8)'); }
  if (dir !== 0 && trigDir === -dir) { score -= 10; drivers.push('action-TF flow side ke against (−10)'); }
  if (plan?.trigger?.overextended) { score -= 6; drivers.push('entry overextended (−6)'); }
  if (plan?.context?.adx != null && plan.context.adx < 15) { score -= 4; drivers.push(`ADX ${Math.round(plan.context.adx)} weak/range (−4)`); }
  if (plan?.costs?.costR != null && plan.costs.costR > 0.3) { score -= 3; drivers.push(`cost ${plan.costs.costR.toFixed(2)}R bhaari (−3)`); }
  // v21.16.0 SUPERINTEL: board ka calibrated P(win)/EV block (winProb.js —
  // ledger-calibrated) fuse me leta hai. Sirf tab jab present ho (crypto/
  // futures perp signals) — India equities par absent, koi penalty nahi.
  const wp = boardSideMatches ? (boardSig?.superIntel?.winProb || null) : null;
  if (wp && wp.verdict === 'EDGE') { score += 3; drivers.push(`P(win) EDGE (+3) — ${wp.pWin}% win · EV ${wp.evRealisticR ?? wp.evR}R`); }
  else if (wp && wp.verdict === 'NO-EDGE') { score -= 5; drivers.push(`P(win) NO-EDGE (−5) — ${wp.pWin}% win · EV ${wp.evRealisticR ?? wp.evR}R`); }
  // v21.18.0 TOP AI AGENTS + SVA + LOCAL OLLAMA COUNCIL FUSE:
  const rawSva = boardSig?.verify || boardSig?.sva || null;
  const rawSvaAct = String(rawSva?.action || '').toUpperCase();
  const sva = boardSideMatches ? rawSva : null;
  const svaAct = String(sva?.action || '').toUpperCase();
  if (sva && (svaAct === 'CONFIRM' || (side === 'LONG' && svaAct === 'STRONG_BUY') || (side === 'SHORT' && svaAct === 'STRONG_SELL')) && (!sva.finalCall || String(sva.finalCall).toUpperCase() === side)) {
    score += 2; drivers.push(`SVA 10-check ${svaAct} ${sva.score ? Math.round(sva.score) : ''}% (+2)`);
  } else if (sva && (sva.veto || svaAct === 'AVOID' || svaAct === 'REJECT')) {
    score -= 6; drivers.push('SVA verifier VETO (−6)');
  }
  const rawCouncilV = String(boardSig?.aiCouncil?.verdict || boardSig?.aiConfirm?.verdict || '').toUpperCase();
  const councilV = boardSideMatches ? rawCouncilV : '';
  const councilModel = boardSig?.aiCouncil?.model || boardSig?.aiConfirm?.model || 'local';
  if (councilV && (councilV === side || councilV === 'AGREE' || councilV === 'CONFIRM')) {
    score += 2; drivers.push(`AI Council / Ollama (${councilModel}) CONFIRM (+2)`);
  } else if (councilV === 'AVOID' || councilV === 'DISAGREE' || councilV === 'SKIP') {
    score -= 5; drivers.push(`AI Council / Ollama ${councilV} (−5)`);
  }

  // ---- P0 DIRECTION GUARDS (audit/direction-guards) -------------------------
  // (a) Board ensemble ne OPPOSITE side bola → MTF side se takrao. Pehle sirf baseScore
  //     null hota tha, koi blocker nahi → LONG ELITE row board ke SHORT 90 ke saath bhi auto-eligible.
  const boardSideRaw = String(boardSig?.side || '').toUpperCase();
  const boardOpposes = (boardSideRaw === 'LONG' || boardSideRaw === 'SHORT')
    && (side === 'LONG' || side === 'SHORT') && boardSideRaw !== side;
  // (b) SVA ka FLIP verdict (finalCall = opposite) pehle ignore hota tha.
  const svaFinal = String(rawSva?.finalCall || '').toUpperCase();
  const svaOpposes = Boolean(rawSva) && (rawSvaAct === 'FLIP' || ((svaFinal === 'LONG' || svaFinal === 'SHORT') && svaFinal !== side));
  // (c) AI Council hard-disagree (AVOID/DISAGREE/SKIP) sirf −5 tha, blocker nahi.
  const councilHardNo = rawCouncilV === 'AVOID' || rawCouncilV === 'DISAGREE' || rawCouncilV === 'SKIP';
  if (boardOpposes) { score -= 12; cap = cap == null ? 64 : Math.min(cap, 64); gates.push(`board ensemble ${boardSideRaw} bol raha hai, MTF ${side} — direction conflict, capped 64`); }
  if (svaOpposes)   { score -= 8;  cap = cap == null ? 64 : Math.min(cap, 64); gates.push('SVA verifier FLIP/opposite call — capped 64'); }

  const agree = boardSideMatches ? Number(boardSig?.agreement ?? 0) : 0;
  const voters = boardSideMatches ? Number(boardSig?.voters ?? boardSig?.participating ?? 0) : 0;
  if (agree >= 0.78 && voters >= 8) {
    score += 2; drivers.push(`Top AI Agents ${voters} seats ${Math.round(agree * 100)}% agree (+2)`);
  }
  // v21.22.0 PURE 8 INSTITUTIONAL TOP INDICATORS CONFLUENCE
  // (1. SMC, 2. Liquidity Sweep/Trap, 3. Volume Profile, 4. FVG, 5. ICT, 6. EMA Ribbon, 7. Supply/Demand, 8. Price Action)
  const worldInd = plan?.worldIndicators || null;
  // v21.23.2 HONESTY RESTORE (port regression): worldInd missing par GUESSED
  // aligned8Count (dualAligned ? 7 : 5) fabrication wapas aa gayi thi (v21.24.0
  // audit P2-4 ne hatai thi, port ne v21.23.1 code se replace kar diya). Ab
  // null = institutional confluence UNVERIFIED — directionVerified false
  // rehta hai, heuristic confluence % bhi fabricate nahi hota. Production
  // planner hamesha worldIndicators deta hai; sirf partial/synthetic plans
  // me absent rehta hai (wahan honest unverified > jhoothe 7/8).
  const worldAligned8Raw = worldInd != null
    ? Math.min(8, Number(worldInd?.aligned8Count ?? worldInd?.alignedCount) || 0)
    : null;
  const worldAligned8Count = worldAligned8Raw; // number | null
  const worldAlignedCount = worldAligned8Raw;
  const trapVeto = Boolean(plan?.trapVeto || worldInd?.trapVeto);
  const zoneWallVeto = Boolean(plan?.zoneWallVeto || worldInd?.zoneWallVeto);
  const directionVerified = Boolean(
    (side === 'LONG' || side === 'SHORT') &&
    dualAligned &&
    !plan?.counterTrend &&
    !reversalRisk &&
    !trapVeto &&
    !zoneWallVeto &&
    !counterHtf &&
    worldAligned8Count >= 6
  );

  // Cross-engine symbol direction lock check (Phase 2.1)
  const dirResolution = resolveDirection({
    plan,
    boardSig,
    sva: rawSva,
    council: boardSig?.aiCouncil || boardSig?.aiConfirm || null,
    mtf6: snap,
    symbol,
    dualAligned,
    worldAligned8Count,
    trapVeto,
    zoneWallVeto,
    reversalRisk,
  });
  const lockCheck = symbol && (side === 'LONG' || side === 'SHORT') ? checkDirectionLock(symbol, side) : { allowed: true, conflict: false };
  const lockOpposes = Boolean(lockCheck && !lockCheck.allowed);
  if (lockOpposes) {
    score -= 12;
    cap = cap == null ? 64 : Math.min(cap, 64);
    gates.push(`${lockCheck.reason} �?" capped 64`);
  }
  if (dirResolution.mtf6Opposes) {
    score -= 12;
    cap = cap == null ? 64 : Math.min(cap, 64);
    gates.push(`MTF-6 bias ${snap?.htfBias || snap?.consensus || 'opposite'} against ${side} - conflict, capped 64`);
  }

  if (trapVeto) {
    score -= 18;
    cap = Math.min(cap ?? 99, 58);
    drivers.push('⚠ Liquidity Sweep / Bull-Bear Trap VETO (−18, capped ≤58)');
  }
  if (zoneWallVeto) {
    score -= 12;
    cap = Math.min(cap ?? 99, 60);
    drivers.push('⚠ Fresh Supply/Demand Wall VETO (−12, capped ≤60)');
  }
  if (worldInd != null && !directionVerified) {
    cap = Math.min(cap ?? 99, 74);
  }
  if (dualAligned && worldAligned8Count >= 6 && !plan?.counterTrend && !reversalRisk && !trapVeto && !zoneWallVeto) {
    const wBonus = worldAligned8Count >= 7 ? 5 : 3;
    score += wBonus;
    drivers.push(`🏆 Top 8 Institutional Indicators (${worldAligned8Count}/8 Aligned) (+${wBonus})`);
  }
  if (plan?.trigger?.pullbackReclaim && dualAligned && !reversalRisk && !trapVeto && !zoneWallVeto) {
    score += 3;
    drivers.push('🎯 Institutional EMA/VWAP Pullback-Reclaim Entry (+3)');
  }
  if (plan && plan.alignedWithContext === false && !plan.counterTrend) { score -= 3; drivers.push('context flat/mixed (−3)'); }

  score = Math.round(clamp(score, 1, 99));
  if (cap != null && score > cap) score = cap;
  const tier = superTier(score);

  // v21.23.1 HONEST WIN-RATE (fabricated 95/92 ladder HATA diya):
  // Tier order —
  //   1. `pWinCalibrated` — board ensemble ka ledger-calibrated P(win) (n ≥ 20 resolved
  //      trades, signalLedger σ-calibration) → AUTHORITATIVE, koi clamp-fabrication nahi.
  //   2. conflict/veto rows (board opposite / SVA FLIP / council hard-no / lock / trap /
  //      zone-wall) → low band 48-62 (unchanged — conflict me high claim jhooth hota).
  //   3. otherwise HONEST heuristic: measured 8-indicator confluence × score blend,
  //      clamped 52-85 — ELITE row ko bhi exact measured number milta hai, 95/92 kabhi nahi.
  // UI me yahi teeno fields (`pWinCalibrated` / `winRatePct` / `heuristicConfluencePct`) jaate
  // hain; scorecard chip 30d ledger directionHitRate alag se dikhata hai.
  const heuristicConfluencePct = worldInd != null
    ? Number(plan?.heuristicConfluencePct ?? worldInd?.confluencePct ?? Math.round((worldAligned8Count / 8) * 100))
    : Number.isFinite(Number(plan?.heuristicConfluencePct)) ? Number(plan.heuristicConfluencePct) : null; // unmeasured → koi fabricated confluence % nahi
  const pWinCalibrated = (wp && wp.calibrated && Number.isFinite(Number(wp.pWin))) ? Number(wp.pWin) : null;
  const winRatePct = (() => {
    if (pWinCalibrated != null) return Math.round(Math.min(90, Math.max(40, pWinCalibrated)));
    if (trapVeto || zoneWallVeto || boardOpposes || svaOpposes || councilHardNo || lockOpposes || counterHtf || dirResolution.mtf6Opposes) {
      return Math.min(62, Math.max(48, Math.round(45 + score * 0.25)));
    }
    if (dualAligned && !reversalRisk && score >= 80 && heuristicConfluencePct != null && heuristicConfluencePct >= 75) return Math.min(85, Math.round(55 + score * 0.30));
    if (dualAligned && !reversalRisk && heuristicConfluencePct != null) {
      const est = Number(worldInd?.estimatedWinRatePct);
      const base = Number.isFinite(est) && est > 0 ? Math.min(88, Math.max(60, est)) : Math.round(50 + score * 0.34);
      return Math.round(Math.min(85, Math.max(52, (heuristicConfluencePct + base) / 2)));
    }
    return Math.round(Math.min(82, Math.max(52, 50 + score * 0.32)));
  })();

  const ollamaTrio = evaluateMtfRowWithOllamaTrio({
    symbol,
    side,
    mode: modeId,
    superScore: score,
    worldAlignedCount,
    worldAligned8Count,
    estimatedWinRatePct: winRatePct,
    heuristicConfluencePct,
    aligned: dualAligned,
    triggerFired: !!plan?.triggerFired,
    counterTrend: !!plan?.counterTrend,
    reversalRisk,
    opposingFlow: !!plan?.trigger?.opposingFlow,
    trapVeto,
    zoneWallVeto,
    boardSideConflict: boardOpposes,
    svaConflict: svaOpposes,
    councilConflict: councilHardNo,
    netRR_T2: plan?.plan?.netRR?.t2 ?? 1.5,
  });

  const finalDirectionVerified = Boolean(directionVerified && !boardOpposes && !svaOpposes && !councilHardNo && !lockOpposes && !dirResolution.mtf6Opposes);

  // v21.25.0 EXPLICIT DIRECTION CERTIFICATE — hard integrity (valid side,
  // LONG→buy / SHORT→sell mapping, SL/target polarity, no activePos conflict)
  // is SEPARATE from PAKKA verification (dual-TF + 8-indicator + conflicts).
  // A structurally valid row can still be WAIT/CONFLICT, never the reverse.
  const directionCertificate = buildDirectionCertificate({
    symbol,
    market,
    side,
    entry: plan?.plan?.entry,
    stopLoss: plan?.plan?.stopLoss,
    t1: plan?.plan?.t1,
    t2: plan?.plan?.t2,
    requireTargets: Boolean(plan?.ok),
    directionVerified: finalDirectionVerified,
    conflictFlags: {
      boardSideConflict: boardOpposes,
      svaConflict: svaOpposes,
      councilConflict: councilHardNo,
      directionLockConflict: lockOpposes,
      mtf6Conflict: dirResolution.mtf6Opposes,
      trapVeto,
      zoneWallVeto,
      reversalRisk,
      counterTrend: Boolean(plan?.counterTrend),
      counterHtf,
    },
    source: 'mtf-dual-board',
  });

  // ---- auto-link eligibility (pure) ----
  const blockers = [];
  const autoMin = Number(SUPER_TIERS.ACTION); // 65 floor; the 75 bar is enforced by the auto-link config
  if (!directionCertificate.ok) blockers.push(`direction certificate ${directionCertificate.verdict}: ${directionCertificate.reasons[0] || 'blocked'}`);
  if (!plan?.ok) blockers.push('plan unavailable');
  if (side !== 'LONG' && side !== 'SHORT') blockers.push('no clean side (WAIT/NEUTRAL)');
  if (!plan?.triggerFired) blockers.push('trigger fire pending');
  if (fit !== 'GOOD' && fit !== 'OK') blockers.push(`TF-fit ${fit || 'unknown'} (GOOD/OK chahiye)`);
  if (plan?.counterTrend) blockers.push('counter-trend');
  if (counterHtf) blockers.push(`1d+4h HTF bias ${snap?.htfBias} against ${side} (counter-HTF)`);
  if (dirResolution.mtf6Opposes) blockers.push(`MTF-6 bias ${snap?.htfBias || snap?.consensus} against ${side} (${snap?.agreementPct}% agreement)`);
  if (boardOpposes) blockers.push(`board ensemble side ${boardSideRaw} ≠ MTF side ${side} (direction conflict)`);
  if (svaOpposes) blockers.push('SVA verifier says FLIP / opposite side');
  if (councilHardNo) blockers.push(`AI council ${rawCouncilV} (hard disagree)`);
  if (lockOpposes && lockCheck.reason) blockers.push(lockCheck.reason);
  if (trapVeto) blockers.push('liquidity sweep / trap veto active');
  if (zoneWallVeto) blockers.push('fresh supply/demand zone wall veto');
  if (!directionVerified) blockers.push('direction not pakka verified');
  if (ollamaTrio && ollamaTrio.approvedCount < 2) blockers.push('local AI ensemble caution (<2/3 models verified)');
  if (plan?.trigger?.opposingFlow) blockers.push('action-TF opposing signal direction');
  if (plan?.trigger?.reversalRisk) blockers.push('action-TF reversal/rejection wick risk');
  if (plan?.context?.exhausted) blockers.push('deep-TF move exhausted/stretched');
  if (dir !== 0 && trendDir !== dir) blockers.push('deep-TF context misaligned');
  if (dir !== 0 && trigDir !== dir) blockers.push('trigger TF misaligned');
  if (plan?.trigger?.overextended) blockers.push('entry overextended (chase risk)');
  if (plan?.costs?.costR != null && plan.costs.costR >= 0.5) blockers.push(`cost ${plan.costs.costR.toFixed(2)}R ≥ 0.5R — trade structurally loss-making`);
  if (plan?.plan?.stopPct != null && plan.plan.stopPct < 0.02) blockers.push(`stop ${plan.plan.stopPct.toFixed(3)}% micro — noise stop-out`);
  if (plan?.plan?.netRR?.t1 != null && plan.plan.netRR.t1 < 0) blockers.push('net RR (T1) negative');
  if (!(plan?.plan?.stopLoss > 0) || !(plan?.plan?.t1 > 0) || !(plan?.plan?.t2 > 0)) blockers.push('incomplete ticket (SL/T1/T2)');
  if (plan?.grade === 'C') blockers.push('plan grade C (A/B chahiye)');
  if (wp && wp.verdict === 'NO-EDGE') blockers.push(`winProb NO-EDGE (EV ${wp.evRealisticR ?? wp.evR}R)`);
  if (score < autoMin) blockers.push(`score ${score} < ${autoMin}`);

  const defaultInst8 = [
    { id: 'smc', label: '1. SMC Smart Money (BOS/CHoCH/OB)', aligned: dualAligned },
    { id: 'liquiditySweep', label: '2. Liquidity Sweep / Trap Guard', aligned: !trapVeto && dualAligned },
    { id: 'volumeProfile', label: '3. Volume Profile (POC/VAH/VAL)', aligned: dualAligned },
    { id: 'fvg', label: '4. Fair Value Gap (FVG Imbalance)', aligned: dualAligned },
    { id: 'ict', label: '5. ICT (OTE / Equilibrium / MSS)', aligned: dualAligned },
    { id: 'emaRibbon', label: '6. EMA Ribbon (9/20/50/200)', aligned: dualAligned },
    { id: 'supplyDemand', label: '7. Supply & Demand Zones', aligned: !zoneWallVeto && dualAligned },
    { id: 'priceAction', label: '8. Price Action (HH-HL / Candles)', aligned: !reversalRisk && dualAligned },
  ];

  return {
    symbol, market, mode: modeId,
    superScore: score, tier,
    scoreBand: tier,
    winRatePct,
    heuristicConfluencePct,
    pWinCalibrated,
    directionVerified: finalDirectionVerified,
    directionCertificate,
    directionVerdict: directionCertificate.verdict,
    orderSide: directionCertificate.orderSide,
    orderSideLabel: directionCertificate.orderSideLabel,
    boardSideConflict: boardOpposes,
    boardSide: boardSideRaw || null,
    svaConflict: svaOpposes,
    councilConflict: councilHardNo,
    directionResolution: dirResolution,
    pakkaDirectionLabel: finalDirectionVerified && (side === 'LONG' || side === 'SHORT')
      ? `PAKKA ${side}`
      : (side ? (boardOpposes || svaOpposes || councilHardNo || lockOpposes || dirResolution.mtf6Opposes ? `CONFLICT-${side}` : `WAIT-${side}`) : 'NEUTRAL'),
    trapVeto,
    zoneWallVeto,
    worldIndicatorsMeasured: Boolean(worldInd),
    worldIndicators: worldInd || {
      alignedCount: worldAligned8Count,
      totalCount: 8,
      aligned8Count: worldAligned8Count,
      total8Count: 8,
      confluencePct: worldAligned8Count != null ? Math.round((worldAligned8Count / 8) * 100) : null,
      estimatedWinRatePct: winRatePct,
      directionVerified: finalDirectionVerified,
      trapVeto,
      zoneWallVeto,
      // v21.23.1: "95-ready" flag ab HONEST — ledger-calibrated P(win) + verified aligned
      // row par hi true (fabricated 95/92 ladder ke saath ye hamesha-true jhooth tha).
      highAccuracy95Ready: pWinCalibrated != null && winRatePct >= 65 && dualAligned && !!plan?.triggerFired && !trapVeto && !zoneWallVeto && finalDirectionVerified,
      institutional8: defaultInst8,
    },
    ollamaTrio,
    side, dir,
    grade: plan?.grade ?? null,
    bias: plan?.bias ?? null,
    trendDir, triggerDir: trigDir, extendedDir: ext,
    htfBias: snap?.ok ? (snap.htfBias ?? null) : null,
    counterHtf,
    dualAligned, tripleAligned,
    earlyIgnition, reversalRisk,
    triggerFired: !!plan?.triggerFired,
    tfFit: fit ?? null,
    tfFitNote: plan?.tfFit?.note ?? null,
    counterTrend: !!plan?.counterTrend,
    costR: plan?.costs?.costR ?? null,
    drivers: drivers.slice(0, 6),
    gates: [...gates, ...drivers.filter(d => d.includes('(−'))].slice(0, 6),
    components: comps.map(c => ({ k: c.k, w: c.w, v: Math.round(c.v), contrib: r2(c.w * c.v) })),
    weightSum: r2(wSum),
    autoEligible: blockers.length === 0,
    autoBlockers: blockers,
  };
}

// ------------------------------------------------------------
// 2) BOARD ROW BUILDER (async — candles via the cached MTF chain)
// ------------------------------------------------------------
const ROW_CACHE = new Map(); // key → { at, row }
const ROW_TTL_MS = 2_000;    // v21.23.13: 2s ultra-fast 24x7 direct price & candle refresh
const ROW_CACHE_MAX = 200;
const CLOSED_BAR_CACHE = new Map(); // last CLOSED bar → plan snapshot
const CLOSED_BAR_CACHE_MAX = 300;
// v21.28.0 [F4]: recent CLOSED trigger candles per symbol/market. The
// deep-monitor lives on the 3s/15s price lanes (no candles), so TP1
// close-confirmation would otherwise be impossible. Board rebuilds already
// fetch these candles; we retain a bounded copy (forming bar dropped).
const CLOSED_CANDLE_CACHE = new Map();
const CLOSED_CANDLE_CACHE_MAX = 400;
const CLOSED_CANDLE_TTL_MS = 30 * 60_000;

/** Pure helper: store only CLOSED trigger bars for later TP1 confirmation. */
export function rememberClosedCandles({ symbol, market, tf = null, candles, now = Date.now() } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  const mkt = String(market || '').toUpperCase().trim();
  if (!sym || !mkt || !Array.isArray(candles) || candles.length < 2) return null;
  const asc = ensureAscending(candles);
  // The newest bar is the forming/live-overlay bar in this chain.
  const closed = asc.slice(0, -1).slice(-200);
  if (closed.length === 0) return null;
  const key = `${mkt}:${sym}`;
  CLOSED_CANDLE_CACHE.set(key, { at: now, tf: tf || null, candles: closed });
  while (CLOSED_CANDLE_CACHE.size > CLOSED_CANDLE_CACHE_MAX) {
    const k = CLOSED_CANDLE_CACHE.keys().next().value;
    if (k === undefined) break;
    CLOSED_CANDLE_CACHE.delete(k);
  }
  return closed.length;
}

/** Cached CLOSED trigger candles for a symbol (null when absent/stale). */
export function closedCandlesFor(symbol, market, { now = Date.now(), maxAgeMs = CLOSED_CANDLE_TTL_MS } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  const mkt = String(market || '').toUpperCase().trim();
  if (!sym || !mkt) return null;
  const hit = CLOSED_CANDLE_CACHE.get(`${mkt}:${sym}`);
  if (!hit || !Array.isArray(hit.candles) || hit.candles.length === 0) return null;
  if (now - Number(hit.at || 0) > maxAgeMs) return null;
  return hit.candles;
}

/** v21.28.0 [F1 CLOSED-BAR CONFIRM]: latest candle exchange par abhi
 *  FORMING hai (ya live tick se patched). Usse signal confirm karna
 *  repaint/flicker deta hai — bar band hone par signal palat sakta hai.
 *  Ye helper aakhri candle hata kar (sirf CLOSED bars par) plan ka
 *  side/trigger/verify snapshot nikalta hai. Cache bar-identity par hai,
 *  isliye 2s board poll dobara plan build nahi karta. */
function closedBarSignal({ symbol, market, mode, holdMin, ctxCandles, trigCandles }) {
  const ctx = ensureAscending(ctxCandles);
  const trig = ensureAscending(trigCandles);
  if (!Array.isArray(ctx) || !Array.isArray(trig) || ctx.length < 3 || trig.length < 3) return null;
  const ctxLast = ctx[ctx.length - 1];
  const trigLast = trig[trig.length - 1];
  if (!ctxLast || !trigLast) return null;
  const timeOf = (c) => Number(c?.ts ?? c?.time ?? c?.t ?? 0) || 0;
  const key = `${market}:${symbol}:${mode.id}:${holdMin}`
    + `:${ctx.length}:${timeOf(ctxLast)}:${ctx[ctx.length - 2]?.close ?? ''}`
    + `:${trig.length}:${timeOf(trigLast)}:${trigLast.close ?? ''}`;
  if (CLOSED_BAR_CACHE.has(key)) return CLOSED_BAR_CACHE.get(key);
  const snap = (() => {
    try {
      const p = buildPlanFromCandles({
        symbol, market, mode: mode.id, holdMin,
        ctxCandles: ctx.slice(0, -1),
        trigCandles: trig.slice(0, -1),
      });
      if (!p?.ok) {
        return {
          ok: false,
          side: null,
          triggerFired: false,
          directionVerified: false,
          grade: null,
          confidence: null,
          lastClosedBarTime: timeOf(trig[trig.length - 2]) || null,
          error: p?.error || 'closed-bar plan unavailable',
        };
      }
      return {
        ok: true,
        side: p.side ?? null,
        triggerFired: p.triggerFired === true,
        directionVerified: p.directionVerified === true,
        grade: p.grade ?? null,
        confidence: Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : null,
        entry: Number(p.plan?.entry) > 0 ? Number(p.plan.entry) : null,
        stopLoss: Number(p.plan?.stopLoss) > 0 ? Number(p.plan.stopLoss) : null,
        t1: Number(p.plan?.t1) > 0 ? Number(p.plan.t1) : null,
        t2: Number(p.plan?.t2) > 0 ? Number(p.plan.t2) : null,
        lastClosedBarTime: timeOf(trig[trig.length - 2]) || null,
      };
    } catch (e) {
      return { ok: false, side: null, triggerFired: false, directionVerified: false, error: String(e?.message || e).slice(0, 140) };
    }
  })();
  CLOSED_BAR_CACHE.set(key, snap);
  while (CLOSED_BAR_CACHE.size > CLOSED_BAR_CACHE_MAX) {
    const k = CLOSED_BAR_CACHE.keys().next().value;
    if (k === undefined) break;
    CLOSED_BAR_CACHE.delete(k);
  }
  return snap;
}

export function buildBarConfirmation({ plan, closedSnap, liveTickOverlay }) {
  const openBar = {
    side: plan?.side ?? null,
    triggerFired: plan?.triggerFired === true,
    directionVerified: plan?.directionVerified === true,
    grade: plan?.grade ?? null,
    confidence: Number.isFinite(Number(plan?.confidence)) ? Number(plan.confidence) : null,
    entry: Number(plan?.plan?.entry) > 0 ? Number(plan.plan.entry) : null,
    stopLoss: Number(plan?.plan?.stopLoss) > 0 ? Number(plan.plan.stopLoss) : null,
    t1: Number(plan?.plan?.t1) > 0 ? Number(plan.plan.t1) : null,
    t2: Number(plan?.plan?.t2) > 0 ? Number(plan.plan.t2) : null,
  };
  const closeBar = closedSnap
    ? {
      side: closedSnap.side ?? null,
      triggerFired: closedSnap.triggerFired === true,
      directionVerified: closedSnap.directionVerified === true,
      grade: closedSnap.grade ?? null,
      confidence: closedSnap.confidence ?? null,
      entry: closedSnap.entry ?? null,
      stopLoss: closedSnap.stopLoss ?? null,
      t1: closedSnap.t1 ?? null,
      t2: closedSnap.t2 ?? null,
      lastClosedBarTime: closedSnap.lastClosedBarTime ?? null,
    }
    : null;
  const comparable = Boolean(openBar.side && closeBar?.side);
  const sideStable = comparable ? openBar.side === closeBar.side : null;
  const triggerStable = comparable ? openBar.triggerFired === closeBar.triggerFired : null;
  const verifiedStable = comparable ? openBar.directionVerified === closeBar.directionVerified : null;
  const stable = comparable ? (sideStable && triggerStable) : null;
  const reasons = [];
  if (!closeBar) reasons.push('closed-bar plan unavailable (thin/unavailable candles)');
  else if (!comparable) reasons.push('open/closed side missing — stability unproven');
  else {
    if (!sideStable) reasons.push(`side flipped ${openBar.side} (forming) vs ${closeBar.side} (closed)`);
    if (!triggerStable) reasons.push(`trigger ${openBar.triggerFired ? 'FIRED' : 'pending'} on forming bar vs ${closeBar.triggerFired ? 'FIRED' : 'pending'} on closed bar`);
    if (!verifiedStable) reasons.push(`verification ${openBar.directionVerified ? 'PAKKA' : 'WAIT'} on forming bar vs ${closeBar.directionVerified ? 'PAKKA' : 'WAIT'} on closed bar`);
  }
  return {
    mode: 'shadow', // decisions legacy rehte hain; auto gate cfg.closedBarConfirm se on hota hai
    stable,
    sideStable,
    triggerStable,
    verifiedStable,
    liveTickOverlay: liveTickOverlay === true,
    openBar,
    closeBar,
    reasons,
    note: stable === true
      ? 'forming + last-closed bar signal aligned'
      : (stable === false ? 'forming bar signal last-closed bar se stable NAHI — confirm pending' : 'stability unproven'),
  };
}


/** v21.20.0 ULTRA-FAST LIVE TICK STAMP: overlays sub-second live LTP onto the latest candle. */
function overlayLiveTick(candles, liveLtp) {
  if (!Array.isArray(candles) || candles.length === 0 || !(Number(liveLtp) > 0)) return candles;
  // v21.23.11 [MIRROR-SHIELD L2]: descending (time-mirrored) series me
  // last index OLDEST bar hota tha — live print usi ko patch karta tha.
  // Entry pe canonicalize (zero-copy jab ascending).
  candles = ensureAscending(candles);
  const last = candles[candles.length - 1];
  if (!last || !(last.close > 0)) return candles;
  const ratio = Number(liveLtp) / last.close;
  if (ratio < 0.85 || ratio > 1.15) return candles; // guard cross-currency mismatch
  const px = Number(liveLtp);
  const patchedLast = {
    ...last,
    close: px,
    high: Math.max(Number(last.high) || px, px),
    low: Math.min(Number(last.low) || px, px),
  };
  return [...candles.slice(0, -1), patchedLast];
}

const METALS_SET = new Set(['XAU', 'XAG', 'XAUUSDT', 'XAGUSDT']);
const EQUITY_SIM_SET = new Set(['NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'SPY', 'QQQ']);

export async function buildDualRow({ symbol, market, boardSig = null, modeId = 'INTRADAY', holdMin = null, snap = null, fx = null, liveLtp = null, candlesFor = null }) {
  const mode = PLAN_MODES[String(modeId || 'INTRADAY').toUpperCase()] || PLAN_MODES.INTRADAY;
  const hold = clamp(Number(holdMin) || mode.defaultHoldMin, mode.minHoldMin, mode.maxHoldMin);
  const sym = String(symbol || '').toUpperCase().trim();
  const rawMkt = String(market || 'INDIA').toUpperCase();
  const mkt = rawMkt === 'EQUITY_SIM' ? 'GLOBALFUTURES' : (METALS_SET.has(sym) && (rawMkt === 'CRYPTO' || rawMkt === 'FUTURES') ? 'METALS' : rawMkt);
  const isUsdtPerp = mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'METALS';
  const isGlobalEq = mkt === 'GLOBALFUTURES';
  const isUsdDomain = isUsdtPerp || isGlobalEq;
  const assetClass = METALS_SET.has(sym) || mkt === 'METALS'
    ? 'METALS'
    : (isGlobalEq || EQUITY_SIM_SET.has(sym))
      ? 'EQUITY_SIM'
      : isUsdtPerp ? 'CRYPTO' : 'INDIA';
  const fxTag = isUsdDomain && Number(fx) > 40 && Number(fx) < 150 ? Math.round(Number(fx) * 10) / 10 : 'd';
  // v21.23.14 [CACHE-IDENTITY]: boardSig was not part of the key, so the same
  // symbol built with a different/absent ensemble signal could reuse the
  // other desk's cached row (intermittent false "ENSEMBLE NOT READY" and
  // stale side/verification). Fingerprint the inputs that change the row.
  const sigTag = boardSig
    ? `${String(boardSig.side || '').toUpperCase()}:${String(boardSig.grade || '').toUpperCase()}:${Math.round(Number(boardSig.confidence) || 0)}:${Number(boardSig.signalAge?.ageMs) || 0}`
    : 'none';
  const key = `${mkt}:${sym}:${mode.id}:${hold}:${fxTag}:${sigTag}`;
  const hit = ROW_CACHE.get(key);
  if (hit && Date.now() - hit.at < ROW_TTL_MS && !(Number(liveLtp) > 0) && typeof candlesFor !== 'function') return hit.row;

  // v21.17.0 + v21.22.0: CRYPTO + METALS (XAU/XAG Perps) USDT domain me,
  // GLOBALFUTURES (EQUITY SIM) USD domain me, aur INDIA NSE ₹ domain me.
  let ctxCandles = null, trigCandles = null, ccy = isUsdtPerp ? 'USDT' : isGlobalEq ? 'USD' : 'INR', priceSrc = null, usedFx = null;
  try {
    if (typeof candlesFor === 'function') {
      const [c, t] = await Promise.all([
        Promise.resolve(candlesFor(sym, mode.contextTf, mkt)).catch(() => null),
        Promise.resolve(candlesFor(sym, mode.triggerTf, mkt)).catch(() => null),
      ]);
      ctxCandles = Array.isArray(c) ? c : (c?.candles || null);
      trigCandles = Array.isArray(t) ? t : (t?.candles || null);
      priceSrc = 'custom-candles';
      if (!ctxCandles && !trigCandles) ccy = null;
    } else if (isUsdtPerp) {
      let [c, t] = await Promise.all([
        rawTfCandlesUsdt(sym, mode.contextTf, { fx }).catch(() => null),
        rawTfCandlesUsdt(sym, mode.triggerTf, { fx }).catch(() => null),
      ]);
      if (!c?.candles || !t?.candles) {
        await new Promise(r => setTimeout(r, 250));
        [c, t] = await Promise.all([
          c?.candles ? c : rawTfCandlesUsdt(sym, mode.contextTf, { fx }).catch(() => null),
          t?.candles ? t : rawTfCandlesUsdt(sym, mode.triggerTf, { fx }).catch(() => null),
        ]);
      }
      ctxCandles = c?.candles || null; trigCandles = t?.candles || null;
      priceSrc = c?.src || t?.src || null;
      usedFx = c?.fx ?? t?.fx ?? null;
      if (!ctxCandles && !trigCandles) ccy = null; // honest: koi data nahi
    } else {
      const [c, t] = await Promise.all([
        rawTfCandles(sym, mkt, mode.contextTf).catch(() => null),
        rawTfCandles(sym, mkt, mode.triggerTf).catch(() => null),
      ]);
      ctxCandles = c; trigCandles = t;
      priceSrc = c || t ? (isGlobalEq ? 'us-equity-sim-direct' : 'board-chain') : null;
      if (!ctxCandles && !trigCandles) ccy = null;
    }
  } catch { /* honest degrade below */ }

  // v21.28.0 [F4]: keep a bounded copy of CLOSED trigger bars so the
  // price-only deep-monitor lanes can confirm TP1 on a bar CLOSE (not wick).
  if (Array.isArray(trigCandles) && trigCandles.length >= 3) {
    rememberClosedCandles({
      symbol: sym, market: mkt, tf: mode.triggerTf, candles: trigCandles, now: Date.now(),
    });
  }

  const effectiveLiveLtp = Number(liveLtp) > 0
    ? Number(liveLtp)
    : (!isUsdtPerp && Number(boardSig?.ltp) > 0 ? Number(boardSig.ltp) : null);
  if (effectiveLiveLtp > 0) {
    ctxCandles = overlayLiveTick(ctxCandles, effectiveLiveLtp);
    trigCandles = overlayLiveTick(trigCandles, effectiveLiveLtp);
  }

  const plan = buildPlanFromCandles({
    symbol: sym, market: mkt, mode: mode.id, holdMin: hold,
    ltp: effectiveLiveLtp > 0 ? effectiveLiveLtp : undefined,
    ctxCandles, trigCandles,
  });
  const closedSnap = closedBarSignal({
    symbol: sym, market: mkt, mode, holdMin: hold, ctxCandles, trigCandles,
  });
  const barConfirmation = buildBarConfirmation({
    plan, closedSnap, liveTickOverlay: effectiveLiveLtp > 0,
  });
  // P1-3 Honest Extended Bias: only use `snap` when real 6-TF / 4h+1d snapshot is supplied;
  // when absent, auto-build the lightweight 4h+1d HTF bias so the board can never fire a
  // counter-HTF signal blind. Custom candle fixtures (tests) stay network-free.
  let snapAligned = snap?.ok ? snap : null;
  if (!snapAligned && snap == null && typeof candlesFor !== 'function') {
    const htfSnap = await buildHtfBiasSnapshot(sym, mkt).catch(() => null);
    if (htfSnap?.ok) snapAligned = htfSnap;
  }
  const fuse = fuseDualTf({ symbol: sym, market: mkt, boardSig, plan, snap: snapAligned, modeId: mode.id });

  // INR cross-view (display only): USDT/USD price → ₹ equivalent (fx se)
  const fxShown = usedFx ?? (isUsdDomain ? (Number(fx) > 40 && Number(fx) < 150 ? Number(fx) : 94.95) : null);
  const row = {
    ...fuse,
    assetClass,
    ok: !!plan?.ok,
    error: plan?.ok ? null : (plan?.error || 'plan unavailable'),
    contextTf: mode.contextTf, triggerTf: mode.triggerTf, label: mode.label,
    holdMin: hold,
    quoteCcy: ccy,               // 'USDT' | 'USD' | 'INR' | null
    priceSrc,                    // 'coindcx-fut-usdt' | 'us-equity-sim-direct' | 'board-chain'
    fx: fxShown,                 // USDINR (crypto/metals/global display cross-check)
    ltp: plan?.ltp ?? (!isUsdtPerp && Number(boardSig?.ltp) > 0 ? Number(boardSig.ltp) : null),
    plan: plan?.ok ? {
      entry: plan.plan.entry, entryZoneLow: plan.plan.entryZoneLow, entryZoneHigh: plan.plan.entryZoneHigh,
      pullbackEntry: plan.plan.pullbackEntry, breakoutEntry: plan.plan.breakoutEntry,
      triggerLevel: plan.plan.triggerLevel, stopLoss: plan.plan.stopLoss, stopPct: plan.plan.stopPct,
      t1: plan.plan.t1, t2: plan.plan.t2, netRR: plan.plan.netRR, qty: plan.plan.qty,
      wideStopNote: plan.plan.wideStopNote ?? null,
      chandelierStop: plan.worldIndicators?.chandelierStop ?? null,
    } : null,
    tfFitRatio: plan?.tfFit?.ratioT1 ?? null,
    expectedTravelPct: plan?.tfFit?.expectedTravelPct ?? null,
    suggestedHoldMin: plan?.tfFit?.suggestHoldMin ?? null,
    triggerLevel: plan?.plan?.triggerLevel ?? null,
    context: plan?.ok ? {
      dir: plan.context.dir, trend: plan.context.trend, score: plan.context.score,
      struct: plan.context.structure, rsi: plan.context.rsi, adx: plan.context.adx,
      barsInTrend: plan.context.barsInTrend, exhausted: plan.context.exhausted,
      atrPct: plan.context.atrPct, supertrend: plan.context.supertrend, note: plan.context.note,
    } : null,
    trigger: plan?.ok ? {
      dir: plan.trigger.dir, score: plan.trigger.score, broke: plan.trigger.broke,
      opposingFlow: plan.trigger.opposingFlow, reversalRisk: plan.trigger.reversalRisk,
      postPeakTrap: Boolean(plan.trigger.postPeakTrap), rangePct: plan.trigger.rangePct ?? null,
      pullbackReclaim: plan.trigger.pullbackReclaim,
      roc1: plan.trigger.roc1, roc2: plan.trigger.roc2, roc3: plan.trigger.roc3,
      distEma20Pct: plan.trigger.distEma20Pct,
      volRatio: plan.trigger.volRatio, bodyPct: plan.trigger.bodyPct, rsi: plan.trigger.rsi,
      patterns: plan.trigger.patterns, components: plan.trigger.components?.map(c => ({ k: c.k, ok: c.ok })),
    } : null,
    directionLockLabel: fuse.pakkaDirectionLabel ?? null,
    timePlan: plan?.ok ? plan.timePlan : null,
    warnings: plan?.warnings ?? [],
    ltpInr: ((ccy === 'USDT' || ccy === 'USD') && fxShown && plan?.ltp) ? Math.round(plan.ltp * fxShown * 100) / 100 : null,
    // v21.22.0: Top AI Agents + 3-Model Local Ollama Trio attribution + 95% Wallet & Fee-Protected Exit rules
    aiAgents: (() => {
      const ol = ollamaStatus();
      const topSeats = Array.isArray(boardSig?.votes)
        ? boardSig.votes
          .filter(v => (fuse.dir > 0 && v.dir > 0) || (fuse.dir < 0 && v.dir < 0))
          .sort((a, b) => (Number(b.weight || 1) * Number(b.conf || 50)) - (Number(a.weight || 1) * Number(a.conf || 50)))
          .slice(0, 4)
          .map(v => v.name || v.id)
        : [];
      return {
        voters: boardSig?.voters ?? boardSig?.participating ?? null,
        agreementPct: boardSig?.agreement != null ? Math.round(Number(boardSig.agreement) * 100) : null,
        topSeats,
        svaAction: boardSig?.verify?.action ?? null,
        svaScore: boardSig?.verify?.score != null ? Math.round(Number(boardSig.verify.score)) : null,
        councilModel: boardSig?.aiCouncil?.model || (ol?.reachable ? `ollama:${ol.model}` : ol?.model ? `ollama:${ol.model} (standby)` : null),
        ollamaReachable: !!ol?.reachable,
        ollamaScanModel: ol?.model || 'qwen3:8b',
        ollamaDeepModel: ol?.deepModel || 'deepseek-r1:14b',
        ollamaTrioModels: ol?.trioModels || ['qwen3:8b', 'deepseek-r1:14b', 'qwen2.5vl:7b'],
        // v21.23.2 HONESTY: fallback '3/3 OLLAMA AI LOCK' JHOOTA tha jab Ollama
        // offline hai (rule-based guard = 0 live models, "3/3 AI LOCK" claim
        // nahin). Sentinel ka honestLabel use karo — offline pe "Rule-Based
        // Guard n/3" bolta hai, live pe "Live Ollama (...)".
        ollamaVerdict: fuse.ollamaTrio?.honestLabel || fuse.ollamaTrio?.verdict || 'RULE-GUARD (local AI offline)',
        councilVerdict: boardSig?.aiCouncil?.verdict || boardSig?.aiConfirm?.verdict || (fuse.dualAligned ? 'CONFIRM' : 'WAIT'),
        councilNote: boardSig?.aiCouncil?.note || boardSig?.aiCouncil?.analysis || fuse.ollamaTrio?.liveNote || null,
      };
    })(),
    feeProtection: plan?.ok && plan.plan?.entry > 0 && normalizeSide(fuse.side) ? {
      roundTripFeePct: defaultRoundTripFeePct(isUsdtPerp ? 'FUTURES' : 'INDIA'),
      feeBreakevenPrice: feeBreakevenFloor({ entry: plan.plan.entry, side: fuse.side, market: isUsdtPerp ? 'FUTURES' : 'INDIA' }),
      zeroLossRule: 'T1/T2 auto profit book + dynamic SL trail + confirmed reversal exit above round-trip fees',
    } : null,
    leverageRule: { below10k: 10, above10k: 5, thresholdINR: 10000, walletDeployPct: 95 },
    // v21.26.0 [DIRECTION-PARITY HARD GATE]: main AI-BOARD ka side MTF row ke
    // side se EXACT match hona chahiye. Pehle sirf "board side valid + grade +
    // conf" check hota tha - board OPPOSITE side bol raha ho tab bhi ensemble
    // "available" ho sakta tha, aur weak paths (directionVerified null) us row
    // ko auto lane me le ja sakte the. Ab side mismatch = unavailable
    // (boardSideConflict blocker + capped score already alag se lagte hain).
    ensembleSignalAvailable: Boolean(
      boardSig
      && (boardSig.side === 'LONG' || boardSig.side === 'SHORT')
      && (fuse.side === 'LONG' || fuse.side === 'SHORT')
      && String(boardSig.side).toUpperCase() === String(fuse.side).toUpperCase()
      && ['ACTION', 'STRONG', 'ELITE'].includes(String(boardSig.grade || '').toUpperCase())
      && Number(boardSig.confidence) >= 60
    ),
    signals: {
      // v21.26.3: `aiScore` + `aiTier` are the MAIN ensemble's authoritative
      // numbers (same ones DEEP shows). `superScore` above stays the separate
      // MTF fusion metric.
      board: mainAiSnapshot(boardSig),
      mtf6: snapAligned?.ok && !snapAligned.lightweight ? { consensus: snapAligned.consensus, agreementPct: snapAligned.agreementPct, phase: snapAligned.phase, htfBias: snapAligned.htfBias, ltfTrigger: snapAligned.ltfTrigger, timing: snapAligned.timing?.quality ?? null, tfs: mtfWire6Payload(snapAligned)?.tfs ?? null } : null,
      htf2: snapAligned?.lightweight ? { engine: 'htf2', bias: snapAligned.htfBias, agreementPct: snapAligned.agreementPct, phase: snapAligned.phase, tfs: snapAligned.timeframes || [] } : null,
    },
    barCounts: { ctx: ctxCandles?.length ?? 0, trig: trigCandles?.length ?? 0 },
    // v21.28.0 [F1 CLOSED-BAR CONFIRM — SHADOW FIRST]: forming/live-tick
    // plan (jo abhi decide karta hai) vs last-CLOSED-bar plan. `stable:false`
    // ka matlab signal sirf forming candle par zinda hai — bar close par
    // palat sakta hai. Abhi koi gate NAHI (shadow telemetry); auto lane
    // cfg.closedBarConfirm=true hone par hi stable rows accept karegi.
    closedBarConfirm: barConfirmation.stable === true,
    signalStability: {
      mode: barConfirmation.mode,
      stable: barConfirmation.stable,
      sideStable: barConfirmation.sideStable,
      triggerStable: barConfirmation.triggerStable,
      verifiedStable: barConfirmation.verifiedStable,
      liveTickOverlay: barConfirmation.liveTickOverlay,
      reasons: barConfirmation.reasons,
      note: barConfirmation.note,
    },
    barConfirmation,
    asOf: Date.now(),
  };
  // v21.26.4 [AUTO-ELIGIBILITY HONESTY]: row.autoEligible/counts used to be
  // computed BEFORE the main-AI ensemble gate (ensembleSignalAvailable), so
  // /mtf-dual/live could report `counts.eligible > 0` for rows that
  // mtfProEntryGate always rejected ("main AI-BOARD ensemble signal
  // unavailable"). Fold that gate into the row's own eligibility + blocker
  // with the REAL main-board state (NEUTRAL 44 vs missing) so the UI/API
  // counts match execution. This only TIGHTENS labelling — no gate relaxed.
  if (!row.ensembleSignalAvailable) {
    const mb = row.signals?.board;
    const mbGrade = String(mb?.grade || '').toUpperCase();
    const mbConf = Number(mb?.confidence);
    const mbTier = String(mb?.aiTier || '').toUpperCase();
    const mbScore = Number(mb?.aiScore);
    const mbLabel = mb
      ? `main AI-BOARD grade ${mbGrade || 'UNKNOWN'}${Number.isFinite(mbConf) ? ' conf ' + mbConf : ''}${mb.side ? ' ' + mb.side : ''}`
        + `${mbTier ? ` (AI ${mbTier}${Number.isFinite(mbScore) ? ' ' + mbScore : ''})` : ''}`
      : 'main AI-BOARD signal missing (fresh scan/coverage ka wait)';
    row.autoEligible = false;
    row.autoBlockers = Array.from(new Set([
      ...(row.autoBlockers || []),
      `${mbLabel} — ACTION+/confidence 60+ aligned signal chahiye`,
    ]));
  }
  // v21.23.14 [AUTO/MANUAL PARITY]: expose the main AI-BOARD signal age and
  // make a <5m-old signal auto-ineligible too. Manual PAPER/LIVE already
  // rejects it in mtfProEntryGate, but the auto lane never saw the age.
  const mainSignalAgeMs = Number(boardSig?.signalAge?.ageMs);
  row.mainSignalAgeMs = Number.isFinite(mainSignalAgeMs) && mainSignalAgeMs >= 0 ? mainSignalAgeMs : null;
  if (row.mainSignalAgeMs != null && row.mainSignalAgeMs < 5 * 60_000) {
    row.autoEligible = false;
    const ageBlocker = `main AI-BOARD signal sirf ${Math.max(0, Math.round(row.mainSignalAgeMs / 60_000))}m old - stability confirm pending`;
    row.autoBlockers = Array.from(new Set([...(row.autoBlockers || []), ageBlocker]));
  }
  ROW_CACHE.set(key, { at: Date.now(), row });
  while (ROW_CACHE.size > ROW_CACHE_MAX) {
    const k = ROW_CACHE.keys().next().value;
    if (k === undefined) break;
    ROW_CACHE.delete(k);
  }
  return row;
}

// ------------------------------------------------------------
// 3) BOARD VIEW (matches) — Top 6 Deep-Trend (LONG or SHORT) symbols
//    + GOLD & SILVER (XAU/XAG Perps) + EQUITY SIM (US Global)
// ------------------------------------------------------------
const BOARD_TTL_MS = 2_000;
const _boardCache = new Map();

const SIDEABLE = new Set(['LONG', 'SHORT']);
export const DEFAULT_DUAL_SYMBOLS = {
  CRYPTO: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'SUI', 'NEAR', 'INJ', 'ARB', 'OP', 'DOT', 'WLD', 'ZRO', 'XAU', 'XAG'],
  FUTURES: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'SUI', 'NEAR', 'INJ', 'ARB', 'OP', 'DOT', 'WLD', 'ZRO', 'XAU', 'XAG'],
  METALS: ['XAU', 'XAG'],
  GLOBALFUTURES: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'SPY', 'QQQ'],
  EQUITY_SIM: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'SPY', 'QQQ'],
  INDIA: ['RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'SBIN', 'BHARTIARTL', 'LT', 'AXISBANK', 'KOTAKBANK', 'ITC', 'SUNPHARMA', 'BAJFINANCE', 'MARUTI'],
};

function rankDualRows(rows, minBar = 75) {
  // DIRECTION HONESTY: NEUTRAL/sub-WATCH rows (score < 50) must never render as
  // LONG/SHORT calls — the board shows only WATCH+ directional setups.
  const watchFloor = Number(SUPER_TIERS.WATCH) || 50;
  const directionalRows = rows.filter(r => r && r.ok && SIDEABLE.has(r.side));
  const candidateRows = directionalRows.filter(r => (Number(r.superScore) || 0) >= watchFloor || r.directionVerified);
  candidateRows.sort((a, b) => {
    const aAutoHigh = Number(!!a.autoEligible && !!a.directionVerified && (a.superScore ?? 0) >= minBar);
    const bAutoHigh = Number(!!b.autoEligible && !!b.directionVerified && (b.superScore ?? 0) >= minBar);
    if (bAutoHigh !== aAutoHigh) return bAutoHigh - aAutoHigh;
    const aPakka = Number(!!a.directionVerified && !a.trapVeto && !a.zoneWallVeto && (a.superScore ?? 0) >= minBar);
    const bPakka = Number(!!b.directionVerified && !b.trapVeto && !b.zoneWallVeto && (b.superScore ?? 0) >= minBar);
    if (bPakka !== aPakka) return bPakka - aPakka;
    const aHigh = Number((a.superScore ?? 0) >= minBar && a.trendDir !== 0 && !a.reversalRisk);
    const bHigh = Number((b.superScore ?? 0) >= minBar && b.trendDir !== 0 && !b.reversalRisk);
    if (bHigh !== aHigh) return bHigh - aHigh;
    if (!!b.autoEligible !== !!a.autoEligible) return Number(b.autoEligible) - Number(a.autoEligible);
    const aClean = Number(a.trendDir !== 0 && !a.reversalRisk && !a.trapVeto && (a.superScore ?? 0) >= 65);
    const bClean = Number(b.trendDir !== 0 && !b.reversalRisk && !b.trapVeto && (b.superScore ?? 0) >= 65);
    if (bClean !== aClean) return bClean - aClean;
    const aFresh = (a.earlyIgnition || a.trigger?.pullbackReclaim || ((a.context?.barsInTrend ?? 5) <= 8)) ? 3 : 0;
    const bFresh = (b.earlyIgnition || b.trigger?.pullbackReclaim || ((b.context?.barsInTrend ?? 5) <= 8)) ? 3 : 0;
    const aAi = (a.ollamaTrio?.approvedCount ?? 0) >= 3 ? 2 : 0;
    const bAi = (b.ollamaTrio?.approvedCount ?? 0) >= 3 ? 2 : 0;
    const aEff = (a.superScore ?? 0) + (a.directionVerified ? 4 : 0) + aFresh + aAi + (a.dualAligned ? 1 : 0);
    const bEff = (b.superScore ?? 0) + (b.directionVerified ? 4 : 0) + bFresh + bAi + (b.dualAligned ? 1 : 0);
    return bEff - aEff;
  });
  return candidateRows;
}

/**
 * v21.23.13 EARLY RADAR — leading signals BEFORE full PAKKA verification.
 *
 * USER PROBLEM: "trend pura banne ke baad signal milta hai — late entry se
 * TP1/TP2 reach nahi hote". Root cause: top-6 ranking by superScore
 * structurally favours mature trends (verified rows outrank fresh ignition),
 * so the earliest actionable wave never reaches the cards.
 *
 * Radar sirf UNCONFIRMED leading setups dikhata hai (earlyIgnition ya
 * trigger-fired-but-not-yet-verified). Ye auto/live lane me KABHI nahi
 * jaate — `autoBlockers` intact rehte hain; PAKKA verify hone par row
 * khud main cards me promote ho jati hai. Counter-HTF / counter-trend /
 * reversal-risk rows radar me bhi nahi aate (wahi hard veto).
 */
export function buildEarlyRadar(rows, limit = 3) {
  if (!Array.isArray(rows)) return [];
  const max = Math.max(1, Math.min(5, Number(limit) || 3));
  const seen = new Set();
  return rows
    .filter(r => r && r.ok && SIDEABLE.has(r.side))
    .filter(r => (Number(r.superScore) || 0) >= 50) // noise floor: weak rows radar me nahi
    .filter(r => !r.directionVerified && !r.counterHtf && !r.counterTrend)
    .filter(r => !r.reversalRisk && !r.trapVeto && !r.zoneWallVeto)
    .filter(r => !!r.earlyIgnition || !!r.triggerFired)
    .sort((a, b) => {
      if (!!b.earlyIgnition !== !!a.earlyIgnition) return Number(!!b.earlyIgnition) - Number(!!a.earlyIgnition);
      if (!!b.triggerFired !== !!a.triggerFired) return Number(!!b.triggerFired) - Number(!!a.triggerFired);
      return (Number(b.superScore) || 0) - (Number(a.superScore) || 0);
    })
    .filter(r => {
      const k = String(r.symbol || '').toUpperCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max)
    .map(r => ({
      symbol: r.symbol,
      market: r.market,
      side: r.side,
      superScore: r.superScore ?? null,
      tier: r.tier ?? null,
      quoteCcy: r.quoteCcy ?? null,
      ltp: r.ltp ?? null,
      entry: r.plan?.entry ?? null,
      triggerLevel: r.triggerLevel ?? null,
      stopLoss: r.plan?.stopLoss ?? null,
      t1: r.plan?.t1 ?? null,
      t2: r.plan?.t2 ?? null,
      earlyIgnition: !!r.earlyIgnition,
      triggerFired: !!r.triggerFired,
      tfFit: r.tfFit ?? null,
      reason: r.earlyIgnition
        ? 'EARLY IGNITION — 5m/1m momentum + EMA stack fresh, deep-trend PAKKA confirm pending'
        : 'TRIGGER FIRED — HTF/PAKKA alignment confirm pending',
      blockers: (r.autoBlockers || []).slice(0, 5),
      asOf: r.asOf ?? null,
    }));
}

export async function getDualMtfBoard({ market = 'INDIA', mode = 'INTRADAY', holdMin = null, boardSigs = [], minScore = 75, limit = TOP_DEEP_TREND_LIMIT, fx = null, fresh = false, force = false, candlesFor = null } = {}) {
  ensureMtfLedgerHydrated();
  const rawMkt = String(market || 'INDIA').toUpperCase();
  const mkt = rawMkt === 'EQUITY_SIM' ? 'GLOBALFUTURES' : rawMkt;
  const modeId = DUAL_BOARD_MODES.includes(String(mode || 'INTRADAY').toUpperCase()) ? String(mode || 'INTRADAY').toUpperCase() : 'INTRADAY';
  const mode0 = PLAN_MODES[modeId] || PLAN_MODES.INTRADAY;
  const hold = clamp(Number(holdMin) || mode0.defaultHoldMin, mode0.minHoldMin, mode0.maxHoldMin);
  const maxRows = Math.max(1, Math.min(TOP_DEEP_TREND_LIMIT, Number(limit) || TOP_DEEP_TREND_LIMIT));
  const isUsdtPerpDesk = mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'METALS';
  const isGlobalEqDesk = mkt === 'GLOBALFUTURES';
  const fxTag = (isUsdtPerpDesk || isGlobalEqDesk) && Number(fx) > 40 && Number(fx) < 150 ? Math.round(Number(fx) * 10) / 10 : 'd';
  const sigFp = (boardSigs || []).slice(0, 6).map(s => `${s?.symbol || ''}:${s?.side || ''}`).join(',');
  const key = `${mkt}:${modeId}:${hold}:${minScore}:${maxRows}:${boardSigs.length}:${sigFp}:${fxTag}`;
  const now = Date.now();
  const hit = _boardCache.get(key);
  if (hit && !fresh && !force && typeof candlesFor !== 'function' && now - hit.at < BOARD_TTL_MS) return { ...hit.payload, cached: true };

  // Build candidate pool: ALWAYS use the core liquid universe symbols
  // (DEFAULT_DUAL_SYMBOLS: BTC, ETH, SOL, DOGE, XRP, BNB, SUI, NEAR, AVAX, LINK, ZRO, WLD, XAU, XAG, etc.)
  // enriched with boardSig metadata (normalizing B-BTC_USDT / BTCINR / BTCUSDT -> BTC).
  const normSymKey = (raw) => String(raw || '').toUpperCase().trim()
    .replace(/^B-/, '').replace(/[._-](USDT|USDC|INR|USD|PERP)$/, '')
    .replace(/(USDT|USDC|INR)$/, '');
  const bySym = new Map();
  for (const s of (boardSigs || [])) {
    if (s?.symbol) {
      bySym.set(String(s.symbol).toUpperCase(), s);
      const baseKey = normSymKey(s.symbol);
      if (baseKey && !bySym.has(baseKey)) bySym.set(baseKey, s);
    }
  }
  const seen = new Set();
  const candidates = [];
  for (const sym of (DEFAULT_DUAL_SYMBOLS[mkt] || DEFAULT_DUAL_SYMBOLS.CRYPTO)) {
    const up = String(sym).toUpperCase();
    if (!seen.has(up)) {
      seen.add(up);
      const matchSig = bySym.get(up);
      candidates.push(matchSig ? { ...matchSig, symbol: up } : { symbol: up, market: mkt, side: null });
    }
  }
  const targetPool = candidates.slice(0, 20);

  // v21.22.0 ULTRA-FAST 24x7 DIRECT LIVE TICK OVERLAY: fetch real-time CoinDCX Futures prices
  // once per board scan and stamp each symbol's live price into the latest candle.
  const livePriceBySym = new Map();
  if (typeof candlesFor !== 'function') {
    try {
      const fpx = await fetchFuturesPrices({ maxAgeMs: fresh ? 700 : 1200 });
      const fpxRows = Array.isArray(fpx) ? fpx : (fpx?.rows || []);
      for (const row of fpxRows) {
        const symKey = String(row?.base || row?.symbol || '').toUpperCase();
        const px = Number(row?.last ?? row?.ltp ?? row?.mark);
        if (symKey && px > 0) {
          livePriceBySym.set(symKey, px);
        }
      }
    } catch { /* non-fatal */ }
  }

  const rows = [];
  const CONCURRENCY = 4;
  const queue = [...targetPool];
  const worker = async () => {
    while (queue.length) {
      const sig = queue.shift();
      if (!sig) return;
      const symUp = String(sig.symbol || '').toUpperCase();
      try {
        const row = await buildDualRow({
          symbol: symUp, market: mkt, boardSig: sig, modeId, holdMin: hold,
          snap: null, fx, liveLtp: livePriceBySym.get(symUp) ?? null, candlesFor,
        });
        rows.push(row);
      } catch (e) {
        rows.push({
          ok: false, symbol: symUp, market: mkt, mode: modeId, error: e?.message || 'row failed',
          superScore: null, tier: 'NEUTRAL', side: null, autoEligible: false, autoBlockers: ['row compute failed'],
          contextTf: mode0.contextTf, triggerTf: mode0.triggerTf, holdMin: hold, asOf: Date.now(),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, targetPool.length)) }, () => worker()));

  // v21.22.0: Build dedicated GOLD & SILVER (XAU/XAG Perps) and EQUITY SIM (US Global) rows
  // so both Intraday TAB & Crypto TAB MTF Dual-Timeframe Signal Boards always have strong signals for them!
  const [metalsRowsRaw, equitySimRowsRaw] = await Promise.all([
    Promise.all(['XAU', 'XAG'].map(sym => {
      const existing = rows.find(r => r?.symbol === sym && r?.ok);
      if (existing) return Promise.resolve(existing);
      return buildDualRow({
        symbol: sym, market: 'METALS', boardSig: bySym.get(sym) || null,
        modeId, holdMin: hold, snap: null, fx, liveLtp: livePriceBySym.get(sym) ?? null, candlesFor,
      }).catch(() => null);
    })),
    Promise.all(['NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMD'].map(sym => {
      const existing = rows.find(r => r?.symbol === sym && r?.ok);
      if (existing) return Promise.resolve(existing);
      return buildDualRow({
        symbol: sym, market: 'GLOBALFUTURES', boardSig: bySym.get(sym) || null,
        modeId, holdMin: hold, snap: null, fx, liveLtp: null, candlesFor,
      }).catch(() => null);
    })),
  ]);
  const metalsRows = rankDualRows(metalsRowsRaw.filter(Boolean), Number(minScore || 75)).map(r => ({ ...r, checklist: undefined }));
  const equitySimRows = rankDualRows(equitySimRowsRaw.filter(Boolean), Number(minScore || 75)).slice(0, 6).map(r => ({ ...r, checklist: undefined }));

  const minBar = Number(minScore || 75);
  const candidateRows = rankDualRows(rows, minBar);
  const trimmed = candidateRows.slice(0, maxRows);
  const q75 = trimmed.filter(r => r.superScore != null && r.superScore >= Number(minScore));
  const earlyRadar = buildEarlyRadar([...rows, ...metalsRowsRaw, ...equitySimRowsRaw].filter(Boolean), 3);

  // v21.25.1 [NEVER-EMPTY MARKET SCAN]: WATCH+ filter ke baad board khaali
  // ho sakta hai (choppy market) — user ko "koi coin hi nahi" nahi lagta tha.
  // Scan universe har scanned symbol ki honest state deta hai (NEUTRAL/WAIT
  // rows bhi), bina unhe tradeable LONG/SHORT card banae. UI in rows par koi
  // PAPER/LIVE action nahi dikhata.
  const scanWatchFloor = Number(SUPER_TIERS.WATCH) || 50;
  const scanSeen = new Set();
  const scanRows = [...rows, ...metalsRowsRaw, ...equitySimRowsRaw]
    .filter(Boolean)
    .filter(r => {
      const k = String(r.symbol || '').toUpperCase();
      if (!k || scanSeen.has(k)) return false;
      scanSeen.add(k);
      return true;
    })
    .map(r => {
      const score = Number(r.superScore);
      const side = SIDEABLE.has(r.side) ? r.side : null;
      return {
        symbol: r.symbol,
        market: r.market,
        assetClass: r.assetClass ?? null,
        side,
        superScore: Number.isFinite(score) ? score : null,
        tier: r.tier ?? 'NEUTRAL',
        ltp: Number.isFinite(Number(r.ltp)) && Number(r.ltp) > 0 ? Number(r.ltp) : null,
        quoteCcy: r.quoteCcy ?? null,
        tfFit: r.tfFit ?? null,
        htfBias: r.htfBias ?? null,
        triggerFired: r.triggerFired === true,
        directionVerified: r.directionVerified === true,
        autoEligible: r.autoEligible === true,
        actionable: Boolean(side && Number.isFinite(score) && score >= scanWatchFloor),
        directionVerdict: r.directionCertificate?.verdict ?? null,
        blocker: Array.isArray(r.autoBlockers) && r.autoBlockers.length ? r.autoBlockers[0] : null,
        ok: r.ok !== false,
        asOf: r.asOf ?? null,
      };
    })
    .sort((a, b) => (Number(b.superScore) || 0) - (Number(a.superScore) || 0));

  // Phase 3 (3.1 / 3.2 / 3.3): Log top-6 scan rows into MTF ledger (deduped 30m),
  // resolve pending outcomes against live LTPs, and attach 30d MTF Direction Scorecard.
  const scanQuoteMap = {};
  for (const r of rows) {
    if (r?.symbol && Number(r.ltp) > 0) scanQuoteMap[r.symbol] = Number(r.ltp);
  }
  for (const [s, px] of livePriceBySym.entries()) {
    if (px > 0) scanQuoteMap[s] = px;
  }
  const ledgerBeforeIds = new Set(getMtfLedgerSnapshot().rows.map(r => r.id));
  const resolveRes = resolveMtfBoardScanOutcomes({ quotes: scanQuoteMap, now });
  let addedRows = 0;
  for (const r of trimmed.slice(0, TOP_DEEP_TREND_LIMIT)) {
    const rec = recordMtfBoardScanRow(r, { now });
    if (rec && !ledgerBeforeIds.has(rec.id)) addedRows += 1;
  }
  // v21.25.2: naya row ya resolution turant persist; MFE/MAE updates
  // store ke 30s throttle par. Read-only FS par best-effort no-op.
  saveMtfRowLedger(getMtfLedgerSnapshot(), {
    force: addedRows > 0 || resolveRes.resolvedNow > 0,
    now,
  });
  const directionScorecard = computeMtfDirectionScorecard({ windowDays: 30, now });
  // v21.25.0: explicit LONG→BUY / SHORT→SELL integrity strip for the whole board.
  const directionIntegrity = summarizeBoardDirectionIntegrity([
    ...trimmed, ...metalsRows, ...equitySimRows,
  ]);

  // v21.23.1 HONEST avg: sirf finite measured values ka average — missing rows
  // ab 88 se FABRICATE nahi hote (null → UI "—" dikhata hai).
  const _winRates = trimmed.map(r => Number(r.winRatePct)).filter(v => Number.isFinite(v) && v > 0);
  const avgWinRatePct = _winRates.length
    ? Math.round(_winRates.reduce((s, v) => s + v, 0) / _winRates.length)
    : null;
  const payload = {
    ok: true, market: mkt, mode: modeId, modeLabel: mode0.label,
    quoteCcy: isUsdtPerpDesk ? 'USDT' : isGlobalEqDesk ? 'USD' : 'INR',
    fx: rows.find(r => r?.fx != null)?.fx ?? (Number(fx) > 40 ? Number(fx) : 94.95),
    contextTf: mode0.contextTf, triggerTf: mode0.triggerTf, holdMin: hold,
    minScore: Number(minScore) || 75,
    topDeepTrendLimit: TOP_DEEP_TREND_LIMIT,
    scannedCount: rows.length,
    directionScorecard,
    directionIntegrity,
    liveFeed24x7: {
      active: true,
      cadenceMs: BOARD_TTL_MS,
      directTickOverlay: livePriceBySym.size,
      asOf: Date.now(),
    },
    worldIndicatorsInfo: {
      count: 8,
      institutional8Count: 8,
      names: [
        '1. SMC Smart Money Concept (BOS/CHoCH/OB)',
        '2. Liquidity Sweep or Trap Guard',
        '3. Volume Profile (POC/VAH/VAL)',
        '4. Fair Value Gap (FVG BISI/SIBI)',
        '5. ICT (OTE 62-79% / Equilibrium / MSS)',
        '6. EMA Ribbon (9/20/50/200)',
        '7. Supply & Demand Institutional Zones',
        '8. Price Action (HH-HL / Candle Patterns / CLV)',
      ],
      // v21.23.1: hardcoded `targetWinRatePct: 95` FABRICATION hata — target ab
      // bhi hei (system design goal), par number derive hota hai: calibrated avg
      // ya confluence heuristic, kabhi fixed 95 nahi.
      targetWinRatePct: avgWinRatePct != null ? Math.min(avgWinRatePct, 85) : null,
      avgWinRatePct,
    },
    ollamaTrio: getOllamaTrioModels(),
    metalsRows,
    equitySimRows,
    earlyRadar,
    scanRows,
    counts: {
      rows: trimmed.length, overBar: q75.length,
      eligible: trimmed.filter(r => r.autoEligible).length,
      strong: trimmed.filter(r => r.tier === 'STRONG' || r.tier === 'ELITE').length,
      fired: trimmed.filter(r => r.triggerFired).length,
      earlyRadar: earlyRadar.length,
      unavailable: trimmed.filter(r => !r.ok).length,
      directionBlocked: trimmed.filter(r => r.directionCertificate?.ok === false).length,
      metalsEligible: metalsRows.filter(r => r.autoEligible).length,
      equitySimEligible: equitySimRows.filter(r => r.autoEligible).length,
    },
    rows: trimmed.map(r => ({
      ...r,
      // UI ko sirf chahiye fields (full checklist/warnings bhi jaate hain)
      checklist: undefined,
    })),
    asOf: Date.now(),
    notes: [
      isUsdtPerpDesk
        ? 'Crypto & Gold/Silver (XAU/XAG) rows USDT domain me hain (24×7 Direct CoinDCX Perp Candlesticks + Real-Time Live Tick Stamp) — ₹ equivalent chhote text me.'
        : isGlobalEqDesk
          ? 'Equity Sim (US Global) rows USD domain me hain (NVDA, TSLA, AAPL, MSFT, META, AMD) — ₹ equivalent chhote text me.'
          : 'India rows NSE ₹ domain me hain + Gold/Silver (XAU/XAG) & Equity Sim tabs bhi board me integrated hain.',
      `v21.22.0 Pure 8 Institutional Top Indicators + Ledger-Calibrated Win-Rate Confluence + 3-Seat Local Ollama Guard: Full ${rows.length}-symbol desk scan me se Top ${TOP_DEEP_TREND_LIMIT} Deep-Trend setups + Gold/Silver (XAU/XAG) + Equity Sim.`,
      '75+ score = ACTION/STRONG/ELITE tier — Live Auto-Trade ON karne par 100% CoinDCX Wallet amount + leverage ke saath strictly 1 Verified Trade lagta hai aur TP1/TP2 tak Deep Monitor + Trailing SL + Reversal Profit-Booking active rehta hai.',
      'Board rows 2s 24×7 ultra-fast cache + direct live tick overlay par hain (1ms exchange guarantee nahi — price tick ~1s, board re-score ~2s; early radar isi liye trend confirm se PEHLE leading setups dikhata hai).',
      'EARLY RADAR = sirf leading/unconfirmed setups (fresh ignition ya trigger fired, PAKKA verify pending). Auto/live buttons radar rows par nahi hote — PAKKA confirm hone par wahi setup main card me promote hota hai.',
    ],
  };
  _boardCache.set(key, { at: now, payload });
  while (_boardCache.size > 24) {
    const k = _boardCache.keys().next().value;
    if (k === undefined) break;
    _boardCache.delete(k);
  }
  return payload;
}

/** Return all warm cached MTF Dual Boards (within 90s) so the 15s Signal Recheck
 *  loop can watch all active MTF Dual Board ELITE/STRONG/ACTION signals without cold scans. */
export function peekDualMtfBoards(maxAgeMs = 90_000) {
  const now = Date.now();
  const byMarket = new Map();
  for (const [, entry] of _boardCache) {
    if (!entry?.payload?.ok || now - (entry.at || 0) > maxAgeMs) continue;
    const m = entry.payload.market || 'CRYPTO';
    const prev = byMarket.get(m);
    if (!prev || entry.at > prev.at) {
      byMarket.set(m, entry);
    }
  }
  return [...byMarket.values()].map(e => e.payload);
}

// ------------------------------------------------------------
// 4) AUTO-LINK SIFT — pure; execution mtfAutoLink.js karta hai
// ------------------------------------------------------------
export function mtfProEntryGate(row, {
  mainSignal = null,
  minScore = Number(SUPER_TIERS.ACTION) || 65,
  requireMainSignal = true,
  minMainSignalAgeMs = 5 * 60_000,
  requireClosedBarConfirm = false,
} = {}) {
  const blockers = [];
  const push = (msg) => { if (msg && !blockers.includes(msg)) blockers.push(msg); };
  const side = row?.side === 'LONG' || row?.side === 'SHORT' ? row.side : null;
  const score = Number(row?.superScore);
  const mainSide = mainSignal?.side === 'LONG' || mainSignal?.side === 'SHORT' ? mainSignal.side : null;

  if (!row || typeof row !== 'object') {
    return { ok: false, side: null, blockers: ['row unavailable'] };
  }
  if (!row.ok) push(row.error || 'plan unavailable');
  if (!side) push('no clean LONG/SHORT side');
  if (row.ensembleSignalAvailable === false
    && !(Array.isArray(row.autoBlockers) && row.autoBlockers.some(b => /main AI-BOARD/i.test(String(b))))) {
    push('main AI-BOARD ensemble signal unavailable — fresh scan ka wait karo');
  }
  if (!row.directionVerified) push('direction not PAKKA verified');
  if (row.triggerFired !== true) push('trigger fire pending');
  if (row.counterHtf) push(`1d+4h HTF bias ${row.htfBias || 'opposite'} against ${side || 'side'}`);
  if (row.counterTrend) push('counter-trend setup');
  if (row.boardSideConflict) push(`main AI-BOARD ensemble ${row.boardSide || 'opposite'} vs MTF ${side || 'side'}`);
  if (row.svaConflict) push('SVA verifier FLIP/opposite call');
  if (row.councilConflict) push('AI council hard-no');
  if (row.trapVeto) push('liquidity sweep / trap veto active');
  if (row.zoneWallVeto) push('fresh supply/demand zone wall veto');
  if (row.reversalRisk) push('action-TF reversal / exhaustion risk');
  if (row.trigger?.opposingFlow) push('action-TF opposing flow');
  if (row.trigger?.reversalRisk) push('action-TF rejection wick risk');
  if (row.trigger?.postPeakTrap) push('post-peak late-entry trap');
  if (row.trigger?.overextended) push('entry overextended / chase risk');
  if (Number.isFinite(score) && score < minScore) push(`score ${score} < pro floor ${minScore}`);
  if (row.autoEligible !== true) {
    if (Array.isArray(row.autoBlockers) && row.autoBlockers.length) {
      for (const b of row.autoBlockers) push(b);
    } else {
      push('auto-ready quality gates not cleared');
    }
  }
  // v21.28.0 [F1 SHADOW→ENFORCE]: config flag on hone par hi closed-bar
  // stability hard requirement hai. Default off = legacy behaviour, par
  // row pe poora telemetry (signalStability) pehle se available hai.
  if (requireClosedBarConfirm && row.closedBarConfirm !== true) {
    const reasons = Array.isArray(row.signalStability?.reasons) ? row.signalStability.reasons : [];
    push(`closed-bar confirm pending — ${reasons[0] || 'forming bar signal last closed bar par stable nahi'}`);
  }
  if (!(Number(row.plan?.entry) > 0) || !(Number(row.plan?.stopLoss) > 0) || !(Number(row.plan?.t1) > 0)) {
    push('incomplete entry/SL/T1 ticket');
  }

  if (mainSignal) {
    const mainGrade = String(mainSignal?.grade || '').toUpperCase();
    if (!['ACTION', 'STRONG', 'ELITE'].includes(mainGrade)) {
      push(`main AI-BOARD grade ${mainGrade || 'UNKNOWN'} actionable nahi (ACTION+ chahiye)`);
    }
    const mainConf = Number(mainSignal?.confidence);
    if (Number.isFinite(mainConf) && mainConf < 60) {
      push(`main AI-BOARD confidence ${mainConf} < 60`);
    }
    if (mainSide && side && mainSide !== side) {
      push(`cross-engine veto: main AI-BOARD ${mainSide} vs MTF ${side}`);
    }
    const htf = String(mainSignal?.mtf?.htfBias || mainSignal?.htfBias || '').toUpperCase();
    if ((side === 'LONG' && htf === 'BEARISH') || (side === 'SHORT' && htf === 'BULLISH')) {
      push(`cross-engine veto: main AI-BOARD HTF ${htf} against ${side}`);
    }
    const mainVeto = mainSignal?.verify?.veto === true
      || ['AVOID', 'FLIP', 'REJECT', 'STAND_ASIDE'].includes(String(mainSignal?.verify?.action || '').toUpperCase());
    if (mainVeto) push('main AI-BOARD verifier veto');
    const ageMs = Number(mainSignal?.signalAge?.ageMs);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < minMainSignalAgeMs) {
      push(`main AI-BOARD signal sirf ${Math.max(0, Math.round(ageMs / 60_000))}m old — stability confirm pending`);
    }
  } else if (requireMainSignal) {
    push('main AI-BOARD ensemble signal missing — entry blocked');
  }

  return {
    ok: blockers.length === 0,
    side,
    score: Number.isFinite(score) ? score : null,
    mainSignalSide: mainSide,
    mainSignalGrade: mainSignal?.grade ?? null,
    mainSignalConfidence: Number.isFinite(Number(mainSignal?.confidence)) ? Number(mainSignal.confidence) : null,
    blockers,
  };
}

/**
 * @param {Array} rows      getDualMtfBoard rows
 * @param {object} cfg      { minScore, allowedMarkets, requireTriggerFired, ... }
 * @param {object} ctx      { openSymbols:Set, lastEntryAt:{sym:epoch}, market }
 */
export function dualAutoCandidates(rows, cfg = {}, ctx = {}) {
  const minScore = clamp(Number(cfg.minScore) || 75, Number(SUPER_TIERS.ACTION), 95);
  const openSymbols = ctx.openSymbols instanceof Set ? ctx.openSymbols : new Set(ctx.openSymbols || []);
  const lastEntryAt = ctx.lastEntryAt || {};
  const now = Number(ctx.now) || Date.now();
  const cooldownMs = clamp(Number(cfg.cooldownMin) || 30, 5, 720) * 60_000;
  const out = [];
  for (const row of rows || []) {
    const reasons = [];
    if (!row?.ok) reasons.push('plan unavailable');
    if (!(row?.superScore >= minScore)) reasons.push(`score ${row?.superScore ?? '—'} < ${minScore}`);
    if (row?.ensembleSignalAvailable === false) reasons.push('main AI-BOARD ensemble signal unavailable');
    if (cfg.closedBarConfirm === true && row?.closedBarConfirm !== true) {
      const why = Array.isArray(row?.signalStability?.reasons) ? row.signalStability.reasons[0] : null;
      reasons.push(`closed-bar confirm pending${why ? ` — ${why}` : ''}`);
    }
    if (row?.autoBlockers?.length) reasons.push(...row.autoBlockers);
    if (openSymbols.has(String(row?.symbol || '').toUpperCase())) reasons.push('already open');
    const last = lastEntryAt[String(row?.symbol || '').toUpperCase()] || 0;
    if (last && now - last < cooldownMs) reasons.push(`cooldown (${Math.ceil((cooldownMs - (now - last)) / 60_000)}m left)`);
    if (reasons.length) out.push({ ...row, autoPickBlockers: [...new Set(reasons)] });
    else out.push({ ...row, autoPickBlockers: [] });
  }
  // Eligible picks first, best score first
  out.sort((a, b) => (a.autoPickBlockers.length ? 1 : 0) - (b.autoPickBlockers.length ? 1 : 0) || (b.superScore ?? 0) - (a.superScore ?? 0));
  return out;
}

/** Test hook — clear row + board caches. */
export function __clearDualBoardCaches() { ROW_CACHE.clear(); _boardCache.clear(); CLOSED_BAR_CACHE.clear(); CLOSED_CANDLE_CACHE.clear(); }

/** Exported for tests/UI docs — the fuse weights in one place. */
export const DUAL_FUSE_WEIGHTS = {
  contextTrend: 0.30, triggerAction: 0.25, planConfidence: 0.20, extendedBias: 0.15, boardBase: 0.10,
  dualAlignedBonus: 4, tripleAlignedBonus: 2,
  caps: { mismatch: 70, counterTrend: 74, counterHtf: 58 },
};
