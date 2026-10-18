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
import { mtfWire6Payload, rawTfCandles, rawTfCandlesUsdt } from './mtf.js';
import { getCachedDirectionScorecard } from './mtfLedger.js';
import { superTier, SUPER_TIERS } from './superIntel.js';
import { buildPlanFromCandles, PLAN_MODES } from './tradePlanner.js';
import { ollamaStatus, evaluateMtfRowWithOllamaTrio, getOllamaTrioModels } from './llmSentinel.js';
import { feeBreakevenFloor, defaultRoundTripFeePct } from '../exec/sizing.js';
import { fetchFuturesPrices } from './futures.js';

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
export function fuseDualTf({ symbol, market, boardSig = null, plan = null, snap = null, modeId = 'INTRADAY' }) {
  const side = plan?.side ?? null;
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
  const sva = boardSideMatches ? (boardSig?.verify || boardSig?.sva || null) : null;
  const svaAct = String(sva?.action || '').toUpperCase();
  if (sva && (svaAct === 'CONFIRM' || (side === 'LONG' && svaAct === 'STRONG_BUY') || (side === 'SHORT' && svaAct === 'STRONG_SELL')) && (!sva.finalCall || String(sva.finalCall).toUpperCase() === side)) {
    score += 2; drivers.push(`SVA 10-check ${svaAct} ${sva.score ? Math.round(sva.score) : ''}% (+2)`);
  } else if (sva && (sva.veto || svaAct === 'AVOID' || svaAct === 'REJECT')) {
    score -= 6; drivers.push('SVA verifier VETO (−6)');
  }
  const councilV = boardSideMatches ? String(boardSig?.aiCouncil?.verdict || boardSig?.aiConfirm?.verdict || '').toUpperCase() : '';
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
  const svaFinal = String(sva?.finalCall || '').toUpperCase();
  const svaOpposes = Boolean(sva) && (svaAct === 'FLIP' || ((svaFinal === 'LONG' || svaFinal === 'SHORT') && svaFinal !== side));
  // (c) AI Council hard-disagree (AVOID/DISAGREE/SKIP) sirf −5 tha, blocker nahi.
  const councilHardNo = councilV === 'AVOID' || councilV === 'DISAGREE' || councilV === 'SKIP';
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
  // v21.24.0 P2-4 (audit): worldInd missing par GUESSED aligned8Count
  // (dualAligned ? 7 : 5) fabrication hata di — ab null, aur null →
  // directionVerified=false (institutional confluence UNVERIFIED).
  // Production planner hamesha worldIndicators deta hai; sirf partial /
  // synthetic plans me absent rehta hai.
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
    worldAligned8Count >= 6
  );

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

  // v21.24.0 P1-1 HONEST WIN-RATE (audit/direction-guards): pehle ye
  // number if-else se nikalta tha (dualAligned && score>=80 → 95%) —
  // ledger/backtest se nahi. Synthetic random-walk ELITE row bhi 95%
  // dikha rahi thi. Ab sirf LEDGER-CALIBRATED P(win) expose hota hai
  // (winProb.calibrated === true); warna null → UI "P(win) uncalibrated"
  // dikhata hai, koi fake % nahi.
  const pWinCalibrated = (wp && wp.calibrated === true && Number.isFinite(Number(wp.pWin)))
    ? Math.round(Number(wp.pWin))
    : null;
  const scoreBand = tier; // ELITE/STRONG/ACTION/WATCH — honest label, fake % nahi
  const winRatePct = pWinCalibrated; // legacy field: calibrated value ya null (kabhi 95 nahi)

  const ollamaTrio = evaluateMtfRowWithOllamaTrio({
    symbol,
    side,
    mode: modeId,
    superScore: score,
    worldAlignedCount,
    worldAligned8Count,
    // v21.24.0 P1-2 (audit): estimatedWinRatePct input HATA DIYA — wo khud
    // is function ke upar fake 95% se aata tha (circular). Sentinel ab
    // real inputs (score/alignment/trigger) + live Ollama note pe vote karta hai.
    aligned: dualAligned,
    triggerFired: !!plan?.triggerFired,
    counterTrend: !!plan?.counterTrend,
    reversalRisk,
    opposingFlow: !!plan?.trigger?.opposingFlow,
    trapVeto,
    zoneWallVeto,
    netRR_T2: plan?.plan?.netRR?.t2 ?? 1.5,
  });

  // ---- auto-link eligibility (pure) ----
  const blockers = [];
  const autoMin = Number(SUPER_TIERS.ACTION); // 65 floor; the 75 bar is enforced by the auto-link config
  if (!plan?.ok) blockers.push('plan unavailable');
  if (side !== 'LONG' && side !== 'SHORT') blockers.push('no clean side (WAIT/NEUTRAL)');
  if (!plan?.triggerFired) blockers.push('trigger fire pending');
  if (fit !== 'GOOD' && fit !== 'OK') blockers.push(`TF-fit ${fit || 'unknown'} (GOOD/OK chahiye)`);
  if (plan?.counterTrend) blockers.push('counter-trend');
  if (trapVeto) blockers.push('liquidity sweep / trap veto active');
  if (zoneWallVeto) blockers.push('fresh supply/demand zone wall veto');
  if (!directionVerified) blockers.push('direction not pakka verified');
  if (ollamaTrio && ollamaTrio.approvedCount < 2) blockers.push('local AI ensemble caution (<2/3 models verified)');
  if (boardOpposes) blockers.push(`board ensemble side ${boardSideRaw} ≠ MTF side ${side} (direction conflict)`);
  if (svaOpposes) blockers.push('SVA verifier says FLIP / opposite side');
  if (councilHardNo) blockers.push(`AI council ${councilV} (hard disagree)`);
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

  return {
    symbol, market, mode: modeId,
    superScore: score, tier, scoreBand,
    winRatePct, pWinCalibrated,
    directionVerified: directionVerified && !boardOpposes && !svaOpposes && !councilHardNo,
    boardSideConflict: boardOpposes, boardSide: boardSideRaw || null,
    pakkaDirectionLabel: directionVerified && !boardOpposes && !svaOpposes && !councilHardNo && (side === 'LONG' || side === 'SHORT') ? `PAKKA ${side}` : (side ? (boardOpposes ? `CONFLICT-${side}` : `WAIT-${side}`) : 'NEUTRAL'),
    trapVeto,
    zoneWallVeto,
    worldIndicators: worldInd || {
      // v21.24.0 P2-4 (audit): worldInd missing → koi guessed counts /
      // fake "8/8 institutional aligned" list NAHI. null = unverified.
      alignedCount: null,
      totalCount: 8,
      aligned8Count: null,
      total8Count: 8,
      confluencePct: null,
      estimatedWinRatePct: pWinCalibrated,
      directionVerified,
      trapVeto,
      zoneWallVeto,
      highAccuracy95Ready: false,
      institutional8: null,
    },
    ollamaTrio,
    side, dir,
    grade: plan?.grade ?? null,
    bias: plan?.bias ?? null,
    trendDir, triggerDir: trigDir, extendedDir: ext,
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
const ROW_TTL_MS = 6_000;    // v21.22.0: 6s ultra-fast 24x7 direct price & candle refresh
const ROW_CACHE_MAX = 200;

/** v21.20.0 ULTRA-FAST LIVE TICK STAMP: overlays sub-second live LTP onto the latest candle. */
function overlayLiveTick(candles, liveLtp) {
  if (!Array.isArray(candles) || candles.length === 0 || !(Number(liveLtp) > 0)) return candles;
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

// ------------------------------------------------------------
// v21.24.0 P1-3 (audit/direction-guards): REAL 4h+1d extended bias.
// Pehle snap missing par "1d+4h bias" CONTEXT-TF (15m/1h) EMAs se
// fabricate hota tha — wahi data jo contextTrend (30% weight) me already
// score ho chuka tha (double-count) aur label jhootha tha. Ab actual
// 4h + 1d candles se EMA50/200 bias (TTL-cached). Data na mile →
// extendedBias component skip (weights redistribute) + tripleAligned
// bonus nahi — honest degrade, koi fake "1d+4h" claim nahi.
// ------------------------------------------------------------
const _htfBiasCache = new Map(); // `${mkt}:${sym}` → { at, bias }
const HTF_BIAS_TTL_MS = 5 * 60_000;
const _emaAt = (closes, period) => {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, c) => a + c, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return Number.isFinite(e) ? e : null;
};
async function realHtfBias4h1d(sym, mkt) {
  const key = `${mkt}:${sym}`;
  const hit = _htfBiasCache.get(key);
  if (hit && Date.now() - hit.at < HTF_BIAS_TTL_MS) return { ok: true, htfBias: hit.bias, src: 'real-4h+1d-ema' };
  const isUsdt = mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'METALS';
  const [c4, c1] = await Promise.all([
    (isUsdt ? rawTfCandlesUsdt(sym, '4h') : rawTfCandles(sym, mkt, '4h')).catch(() => null),
    (isUsdt ? rawTfCandlesUsdt(sym, '1d') : rawTfCandles(sym, mkt, '1d')).catch(() => null),
  ]);
  const closesOf = (c) => ((c && (Array.isArray(c) ? c : c.candles)) || [])
    .map(x => Number(x?.close)).filter(Number.isFinite);
  const closes4 = closesOf(c4), closes1 = closesOf(c1);
  if (closes4.length < 60 || closes1.length < 60) return null; // honest: component skip
  const biasOf = (closes) => {
    const px = closes[closes.length - 1];
    const e50 = _emaAt(closes, 50);
    const e200 = _emaAt(closes, 200);
    if (!(px > 0) || !(e50 > 0) || !(e200 > 0)) return 0;
    if (px > e50 && e50 >= e200 * 0.995) return 1;
    if (px < e50 && e50 <= e200 * 1.005) return -1;
    return 0;
  };
  const b = biasOf(closes4) + biasOf(closes1);
  const bias = b >= 1 ? 'BULLISH' : b <= -1 ? 'BEARISH' : 'MIXED';
  _htfBiasCache.set(key, { at: Date.now(), bias });
  return { ok: true, htfBias: bias, src: 'real-4h+1d-ema' };
}

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
  const key = `${mkt}:${sym}:${mode.id}:${hold}:${fxTag}`;
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
  // v21.24.0 P1-3 (audit): REAL 4h+1d EMA bias — context-TF EMAs se
  // fabrication hata di. Custom candlesFor (tests/synthetic) path me
  // network fetch nahi karte — snap null rehta hai (honest skip).
  let snapAligned = snap;
  if (!snapAligned && typeof candlesFor !== 'function') {
    snapAligned = await realHtfBias4h1d(sym, mkt).catch(() => null);
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
        ollamaVerdict: fuse.ollamaTrio?.verdict || 'RULE-GUARD (local AI offline)',
        councilVerdict: boardSig?.aiCouncil?.verdict || boardSig?.aiConfirm?.verdict || (fuse.dualAligned ? 'CONFIRM' : 'WAIT'),
        councilNote: boardSig?.aiCouncil?.note || boardSig?.aiCouncil?.analysis || fuse.ollamaTrio?.liveNote || null,
      };
    })(),
    feeProtection: plan?.ok && plan.plan?.entry > 0 ? {
      roundTripFeePct: defaultRoundTripFeePct(isUsdtPerp ? 'FUTURES' : 'INDIA'),
      feeBreakevenPrice: feeBreakevenFloor({ entry: plan.plan.entry, side: fuse.side || 'LONG', market: isUsdtPerp ? 'FUTURES' : 'INDIA' }),
      zeroLossRule: 'T1/T2 auto profit book + dynamic SL trail + confirmed reversal exit above round-trip fees',
    } : null,
    leverageRule: { below10k: 10, above10k: 5, thresholdINR: 10000, walletDeployPct: 95 },
    signals: {
      board: boardSig ? {
        // v21.24.0 P1-4 (audit): board ka side pehle UI ko bhi nahi jata
        // tha (sirf aiScore/grade) — user ko conflict dikhna hi nahi chahiye tha.
        side: boardSig.side ?? null,
        aiScore: boardSig.superIntel?.aiScore ?? null, grade: boardSig.grade ?? null, confidence: boardSig.confidence ?? null,
        winProb: (boardSig.superIntel?.winProb && typeof boardSig.superIntel.winProb === 'object') ? {
          verdict: boardSig.superIntel.winProb.verdict ?? null,
          pWin: boardSig.superIntel.winProb.pWin ?? null,
          evR: boardSig.superIntel.winProb.evRealisticR ?? boardSig.superIntel.winProb.evR ?? null,
          calibrated: !!boardSig.superIntel.winProb.calibrated,
        } : null,
      } : null,
      mtf6: snapAligned?.ok ? { consensus: snapAligned.consensus, agreementPct: snapAligned.agreementPct, phase: snapAligned.phase, htfBias: snapAligned.htfBias, ltfTrigger: snapAligned.ltfTrigger, timing: snapAligned.timing?.quality ?? null, tfs: mtfWire6Payload(snapAligned)?.tfs ?? null } : null,
    },
    barCounts: { ctx: ctxCandles?.length ?? 0, trig: trigCandles?.length ?? 0 },
    asOf: Date.now(),
  };
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
const BOARD_TTL_MS = 6_000;
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
  const directionalRows = rows.filter(r => r && r.ok && SIDEABLE.has(r.side));
  const candidateRows = directionalRows.length > 0 ? [...directionalRows] : [...rows];
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

export async function getDualMtfBoard({ market = 'INDIA', mode = 'INTRADAY', holdMin = null, boardSigs = [], minScore = 75, limit = TOP_DEEP_TREND_LIMIT, fx = null, fresh = false, force = false, candlesFor = null } = {}) {
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
      const fpx = await fetchFuturesPrices({ maxAgeMs: fresh ? 1000 : 2500 });
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
  // v21.24.0 P1-1 (audit): average sirf CALIBRATED rows se — uncalibrated
  // par 88/92 jaisa default number phir se fake claim ban jata.
  const calibratedRows = trimmed.filter(r => Number.isFinite(Number(r.pWinCalibrated)));
  const avgWinRatePct = calibratedRows.length
    ? Math.round(calibratedRows.reduce((s, r) => s + Number(r.pWinCalibrated), 0) / calibratedRows.length)
    : null;
  const payload = {
    ok: true, market: mkt, mode: modeId, modeLabel: mode0.label,
    quoteCcy: isUsdtPerpDesk ? 'USDT' : isGlobalEqDesk ? 'USD' : 'INR',
    fx: rows.find(r => r?.fx != null)?.fx ?? (Number(fx) > 40 ? Number(fx) : 94.95),
    contextTf: mode0.contextTf, triggerTf: mode0.triggerTf, holdMin: hold,
    minScore: Number(minScore) || 75,
    topDeepTrendLimit: TOP_DEEP_TREND_LIMIT,
    scannedCount: rows.length,
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
      targetWinRatePct: null, // v21.24.0 (audit P1-1): hardcoded 95% target hata diya — sirf calibrated avg dikhao
      avgWinRatePct,
      note: avgWinRatePct == null ? 'P(win) uncalibrated — ledger settle hone par hi calibrated numbers aayenge' : null,
    },
    ollamaTrio: getOllamaTrioModels(),
    // v21.24.0 Phase 3 (audit): ledger-measured direction scorecard —
    // "95% target" ki jagah "last 30d n/hit/avgR" (n<30 → insufficient data).
    directionScorecard: getCachedDirectionScorecard(30),
    metalsRows,
    equitySimRows,
    counts: {
      rows: trimmed.length, overBar: q75.length,
      eligible: trimmed.filter(r => r.autoEligible).length,
      strong: trimmed.filter(r => r.tier === 'STRONG' || r.tier === 'ELITE').length,
      fired: trimmed.filter(r => r.triggerFired).length,
      unavailable: trimmed.filter(r => !r.ok).length,
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
      `v21.24.0 Pure 8 Institutional Top Indicators + honest P(win) (sirf ledger-calibrated) + 3-Vote Local Ollama Guard: Full ${rows.length}-symbol desk scan me se Top ${TOP_DEEP_TREND_LIMIT} Deep-Trend setups + Gold/Silver (XAU/XAG) + Equity Sim. Cross-engine direction conflicts (board ensemble / SVA FLIP / AI council) ab hard-blocked hain.`,
      '75+ score = ACTION/STRONG/ELITE tier — Live Auto-Trade ON karne par 100% CoinDCX Wallet amount + leverage ke saath strictly 1 Verified Trade lagta hai aur TP1/TP2 tak Deep Monitor + Trailing SL + Reversal Profit-Booking active rehta hai.',
      'Board rows 6s 24×7 ultra-fast cache + direct live tick overlay par hain.',
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
export function __clearDualBoardCaches() { ROW_CACHE.clear(); _boardCache.clear(); }

/** Exported for tests/UI docs — the fuse weights in one place. */
export const DUAL_FUSE_WEIGHTS = {
  contextTrend: 0.30, triggerAction: 0.25, planConfidence: 0.20, extendedBias: 0.15, boardBase: 0.10,
  dualAlignedBonus: 4, tripleAlignedBonus: 2,
  caps: { mismatch: 70, counterTrend: 74 },
};
