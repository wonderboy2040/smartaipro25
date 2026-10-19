import { describe, it, expect, beforeEach } from 'vitest';
import { fuseDualTf } from '../server/ai/mtfDualBoard.js';
import {
  acquireDirectionLock,
  releaseDirectionLock,
  checkDirectionLock,
  resolveDirection,
  __resetDirectionLocksForTests,
} from '../server/ai/directionLock.js';
import {
  mtfAutoTick,
  setMtfAutoEnabled,
  updateMtfAutoConfig,
  __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import { proTraderGate, PROTRADER_DEFAULTS } from '../server/ai/proTraderAuto.js';
import { evaluateMtfRowWithOllamaTrio } from '../server/ai/llmSentinel.js';
import {
  recordMtfBoardScanRow,
  resolveMtfBoardScanOutcomes,
  computeMtfDirectionScorecard,
  __resetMtfLedgerForTests,
} from '../server/ai/signalLedger.js';

function cleanLongPlan() {
  return {
    ok: true,
    side: 'LONG',
    dir: 1,
    grade: 'A',
    confidence: 88,
    bias: 'BULLISH',
    triggerFired: true,
    alignedWithContext: true,
    counterTrend: false,
    trapVeto: false,
    zoneWallVeto: false,
    context: { dir: 1, score: 86, adx: 28, exhausted: false, earlyIgnition: true },
    trigger: { dir: 1, score: 84, overextended: false, opposingFlow: false, reversalRisk: false, pullbackReclaim: true },
    tfFit: { verdict: 'GOOD', note: 'clean' },
    costs: { costR: 0.12 },
    plan: { entry: 100, stopLoss: 98, stopPct: 2, t1: 103, t2: 106, netRR: { t1: 1.4, t2: 2.8 } },
    worldIndicators: { aligned8Count: 7, alignedCount: 7, estimatedWinRatePct: 92, trapVeto: false, zoneWallVeto: false },
  };
}

describe('P0 direction conflict guards (fuseDualTf + Phase 0–3 Direction Accuracy)', () => {
  beforeEach(() => {
    __resetDirectionLocksForTests();
    __resetMtfLedgerForTests();
  });

  it('baseline: without board conflict, clean LONG plan is auto-eligible', () => {
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: null, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.side).toBe('LONG');
    expect(r.superScore).toBeGreaterThanOrEqual(75);
    expect(r.directionVerified).toBe(true);
    expect(r.autoEligible).toBe(true);
  });

  // v21.23.1 HONEST WIN-RATE — fabricated 95/92 ladder regression guards.
  it('HONEST-1: uncalibrated ELITE row NEVER gets fabricated 95/92 — heuristic band only (52-85), pWinCalibrated null', () => {
    const uncalBoard = {
      side: 'LONG',
      superIntel: { aiScore: 88, winProb: { verdict: 'EDGE', pWin: 64, evR: 0.8, calibrated: false } },
      verify: { action: 'CONFIRM', finalCall: 'LONG', score: 84 },
      agreement: 0.84,
      voters: 12,
    };
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: uncalBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.superScore).toBeGreaterThanOrEqual(80); // still ELITE/STRONG tier
    expect(r.pWinCalibrated).toBeNull();
    expect(r.heuristicConfluencePct).toBeGreaterThanOrEqual(75);
    expect(Number(r.winRatePct)).toBeGreaterThanOrEqual(52);
    expect(Number(r.winRatePct)).toBeLessThanOrEqual(85); // 95/92 fabrication GAYA
    expect(r.winRatePct).not.toBe(95);
    expect(r.winRatePct).not.toBe(92);
  });

  it('HONEST-2: ledger-calibrated winProb is AUTHORITATIVE — winRatePct = clamped pWin, tier eligible as-is', () => {
    const calBoard = {
      side: 'LONG',
      superIntel: { aiScore: 88, winProb: { verdict: 'EDGE', pWin: 61, evR: 0.9, calibrated: true } },
      verify: { action: 'CONFIRM', finalCall: 'LONG', score: 84 },
      agreement: 0.84,
      voters: 12,
    };
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: calBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.pWinCalibrated).toBe(61);
    expect(Number(r.winRatePct)).toBe(61); // exact calibrated number — no inflation
    expect(r.autoEligible).toBe(true);
  });

  it('HONEST-3: conflict rows stay in the honest low band (48-62) — conflict me high win-rate claim jhooth hota', () => {
    const opposingBoard = {
      side: 'SHORT',
      superIntel: { aiScore: 90, winProb: { verdict: 'EDGE', pWin: 68, evR: 0.9, calibrated: true } },
      agreement: 0.85,
      voters: 12,
    };
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: opposingBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.boardSideConflict).toBe(true);
    expect(Number(r.winRatePct)).toBeGreaterThanOrEqual(48);
    expect(Number(r.winRatePct)).toBeLessThanOrEqual(62);
  });

  it('P0-1: board ensemble opposite side (SHORT vs LONG) blocks auto-eligibility and caps score <= 64', () => {
    const opposingBoard = {
      side: 'SHORT',
      superIntel: { aiScore: 90, winProb: { verdict: 'EDGE', pWin: 68, evR: 0.9, calibrated: true } },
      agreement: 0.85,
      voters: 12,
    };
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: opposingBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.boardSideConflict).toBe(true);
    expect(r.boardSide).toBe('SHORT');
    expect(r.superScore).toBeLessThanOrEqual(64);
    expect(r.directionVerified).toBe(false);
    expect(r.pakkaDirectionLabel).toBe('CONFLICT-LONG');
    expect(r.autoEligible).toBe(false);
    expect(r.autoBlockers.some(b => b.includes('direction conflict'))).toBe(true);
  });

  it('P0-2: SVA FLIP verdict blocks auto-eligibility and caps score <= 64', () => {
    const svaFlipBoard = {
      side: 'LONG',
      superIntel: { aiScore: 82 },
      verify: { action: 'FLIP', finalCall: 'SHORT', score: 42 },
    };
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: svaFlipBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.superScore).toBeLessThanOrEqual(64);
    expect(r.directionVerified).toBe(false);
    expect(r.autoEligible).toBe(false);
    expect(r.autoBlockers).toContain('SVA verifier says FLIP / opposite side');
  });

  it('same-side board signal keeps row auto-eligible', () => {
    const alignedBoard = {
      side: 'LONG',
      superIntel: { aiScore: 88, winProb: { verdict: 'EDGE', pWin: 66, evR: 0.8, calibrated: true } },
      verify: { action: 'CONFIRM', finalCall: 'LONG', score: 84 },
      aiCouncil: { verdict: 'CONFIRM', model: 'qwen3:8b' },
      agreement: 0.82,
      voters: 11,
    };
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: alignedBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.boardSideConflict).toBe(false);
    expect(r.superScore).toBeGreaterThanOrEqual(80);
    expect(r.directionVerified).toBe(true);
    expect(r.pakkaDirectionLabel).toBe('PAKKA LONG');
    expect(r.autoEligible).toBe(true);
  });

  it('P0-2b: AI council AVOID / DISAGREE / SKIP blocks auto-eligibility and marks directionVerified = false', () => {
    const councilAvoidBoard = {
      side: 'LONG',
      superIntel: { aiScore: 85 },
      aiCouncil: { verdict: 'AVOID', model: 'deepseek-r1:14b' },
    };
    const r = fuseDualTf({ symbol: 'TEST', market: 'CRYPTO', boardSig: councilAvoidBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.councilConflict).toBe(true);
    expect(r.directionVerified).toBe(false);
    expect(r.pakkaDirectionLabel).toBe('CONFLICT-LONG');
    expect(r.autoEligible).toBe(false);
    expect(r.autoBlockers).toContain('AI council AVOID (hard disagree)');
  });

  it('P0-3: mtfAutoTick live fallback never bypasses autoBlockers or boardSideConflict', async () => {
    __resetMtfAutoForTests();
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ markets: ['CRYPTO'], executionMode: 'live', liveExecution: true, minScore: 75 });

    const conflictedRow = {
      ok: true,
      symbol: 'BTC',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      holdMin: 45,
      side: 'LONG',
      superScore: 88,
      tier: 'ELITE',
      directionVerified: true,
      triggerFired: true,
      dualAligned: true,
      tfFit: 'GOOD',
      boardSideConflict: true,
      boardSide: 'SHORT',
      autoEligible: false,
      autoBlockers: ['board ensemble side SHORT ≠ MTF side LONG (direction conflict)'],
      plan: { entry: 68000, stopLoss: 67200, t1: 69000, t2: 70200, netRR: { t1: 1.2, t2: 2.5 } },
    };

    const res = await mtfAutoTick({
      boards: { CRYPTO: { rows: [conflictedRow] } },
      paper: {
        getPaperSummary: () => ({ open: [], closedToday: [] }),
        openPaperTrade: () => ({ ok: true, trade: { id: 'p-1' } }),
      },
      usdtQuotes: { BTC: 68000 },
      liveExecute: async () => ({ ok: true, orderId: 'ord-1' }),
    });
    expect(res.opened.length).toBe(0);
    expect(res.candidates).toBe(0);
  });

  it('P1-1 & P1-2: exposes scoreBand, heuristicConfluencePct, pWinCalibrated, and non-circular Ollama Trio ruleBasedGuard', () => {
    const uncalBoard = {
      side: 'LONG',
      superIntel: { aiScore: 84, winProb: { verdict: 'EDGE', pWin: 64, evR: 0.7, calibrated: false } },
    };
    const r = fuseDualTf({ symbol: 'SOL', market: 'CRYPTO', boardSig: uncalBoard, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(r.scoreBand).toBe(r.tier);
    expect(r.heuristicConfluencePct).toBeGreaterThanOrEqual(75);
    expect(r.pWinCalibrated).toBeNull();

    // Non-circular Ollama Trio: even with estimatedWinRatePct omitted, clean aligned row gets 3/3 rule-based guard
    const trioClean = evaluateMtfRowWithOllamaTrio({
      symbol: 'SOL',
      side: 'LONG',
      superScore: 85,
      worldAligned8Count: 7,
      aligned: true,
      triggerFired: true,
      netRR_T2: 1.8,
    });
    expect(trioClean.approvedCount).toBe(3);
    expect(trioClean.ruleBasedGuard).toBe(true);
    expect(trioClean.honestLabel).toContain('Rule-Based Guard 3/3');

    // Cross-engine conflict drops Ollama Trio approval below 2
    const trioConflict = evaluateMtfRowWithOllamaTrio({
      symbol: 'SOL',
      side: 'LONG',
      superScore: 85,
      worldAligned8Count: 7,
      aligned: true,
      triggerFired: true,
      boardSideConflict: true,
      netRR_T2: 1.8,
    });
    expect(trioConflict.approvedCount).toBe(0);
  });

  it('P2-1 & P2-3: cross-engine directionLock blocks opposite-side entries across MTF Fuse, PRO AUTO, and MTF Auto while allowing same-side', () => {
    const t0 = 1_700_000_000_000;
    acquireDirectionLock({ symbol: 'B-BTC_USDT', side: 'SHORT', source: 'agent', cooldownMin: 240, now: t0 });

    // Same-side SHORT is allowed
    const checkShort = checkDirectionLock('BTCUSDT', 'SHORT', { now: t0 + 60_000 });
    expect(checkShort.allowed).toBe(true);
    expect(checkShort.conflict).toBe(false);

    // Opposite-side LONG is blocked
    const checkLong = checkDirectionLock('BTC', 'LONG', { now: t0 + 60_000 });
    expect(checkLong.allowed).toBe(false);
    expect(checkLong.conflict).toBe(true);
    expect(checkLong.lockedSide).toBe('SHORT');

    // fuseDualTf caps and blocks a LONG plan when BTC is locked SHORT by another engine
    const fusedLocked = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', boardSig: null, plan: cleanLongPlan(), snap: null, modeId: 'INTRADAY' });
    expect(fusedLocked.superScore).toBeLessThanOrEqual(64);
    expect(fusedLocked.directionVerified).toBe(false);
    expect(fusedLocked.pakkaDirectionLabel).toBe('CONFLICT-LONG');
    expect(fusedLocked.autoEligible).toBe(false);
    expect(fusedLocked.autoBlockers.some(b => b.includes('cross-engine direction lock'))).toBe(true);

    // proTraderGate also blocks opposite-side entry when BTC is locked SHORT
    const proGate = proTraderGate({
      symbol: 'BTC',
      market: 'FUTURES',
      side: 'LONG',
      grade: 'STRONG',
      confidence: 80,
      superIntel: { aiScore: 85 },
      verify: { action: 'CONFIRM', finalCall: 'LONG', score: 85 },
      plan: { entry: 68000, sl: 67000, tp1: 69500 },
    }, PROTRADER_DEFAULTS);
    expect(proGate.pass).toBe(false);
    expect(proGate.reasons).toContain('direction-lock:SHORT');

    // Release active lock and advance past 4h cooldown → LONG allowed again
    releaseDirectionLock('BTC', { now: t0 + 120_000 });
    const afterCooldown = checkDirectionLock('BTC', 'LONG', { now: t0 + 241 * 60_000 });
    expect(afterCooldown.allowed).toBe(true);

    // resolveDirection pure helper
    const resolved = resolveDirection({
      plan: cleanLongPlan(),
      boardSig: { side: 'SHORT' },
      symbol: 'ETH',
      dualAligned: true,
      worldAligned8Count: 7,
    });
    expect(resolved.verified).toBe(false);
    expect(resolved.boardOpposes).toBe(true);
    expect(resolved.label).toBe('CONFLICT-LONG');
  });

  it('P3-1..3: MTF scan ledger records top-6 rows (deduped 30m), resolves T1/SL/timeout outcomes, and computes 30d scorecard', () => {
    const t0 = 1_700_000_000_000;
    const scan1 = recordMtfBoardScanRow({
      symbol: 'BTC',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      side: 'LONG',
      boardSide: 'LONG',
      boardSideConflict: false,
      directionVerified: true,
      superScore: 88,
      tier: 'ELITE',
      holdMin: 45,
      plan: { entry: 100, stopLoss: 98, t1: 103, t2: 106 },
    }, { now: t0 });
    expect(scan1).not.toBeNull();

    // Dedup within same 30m bucket returns the existing record
    const scanDup = recordMtfBoardScanRow({
      symbol: 'BTC',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      side: 'LONG',
      superScore: 89,
      plan: { entry: 100, stopLoss: 98, t1: 103, t2: 106 },
    }, { now: t0 + 60_000 });
    expect(scanDup?.id).toBe(scan1?.id);

    // Second row with a cross-engine conflict that hits SL
    recordMtfBoardScanRow({
      symbol: 'ETH',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      side: 'LONG',
      boardSide: 'SHORT',
      boardSideConflict: true,
      directionVerified: false,
      superScore: 62,
      tier: 'WATCH',
      holdMin: 45,
      plan: { entry: 200, stopLoss: 196, t1: 206, t2: 212 },
    }, { now: t0 });

    // Resolve outcomes: BTC hits T1 (103.5), ETH hits SL (195.5)
    const res = resolveMtfBoardScanOutcomes({
      quotes: { BTC: 103.5, ETH: 195.5 },
      now: t0 + 10 * 60_000,
    });
    expect(res.resolvedNow).toBe(2);

    const card = computeMtfDirectionScorecard({ windowDays: 30, now: t0 + 15 * 60_000 });
    expect(card.totalScans).toBe(2);
    expect(card.resolvedCount).toBe(2);
    expect(card.directionHitRate).toBe(50);
    expect(card.t1HitPct).toBe(50);
    expect(card.slFirstPct).toBe(50);
    expect(card.alignedBucket.n).toBe(1);
    expect(card.alignedBucket.t1HitPct).toBe(100);
    expect(card.conflictBucket.n).toBe(1);
    expect(card.conflictBucket.slFirstPct).toBe(100);
  });
});
