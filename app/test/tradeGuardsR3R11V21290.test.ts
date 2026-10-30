// ============================================================
// test/tradeGuardsR3R11V21290.test.ts — v21.29.0 R3–R11
// ------------------------------------------------------------
// Locks the audit cycle's remaining guards:
//   R3  reversal guard v2 — tier 1 tighten / 2 reduce / 3+ exit,
//       closed-bar evidence, LIVE gated without liveEnabled.
//   R4  event + session filter — blackout/haircut + micro-windows.
//   R5  regime filter — counter-trend / chop / high-vol.
//   R6  perp derivatives veto — funding / long-short / basis.
//   R7  score calibration — per-bucket win-rate, sufficiency gate.
//   R8  runner-after-TP2 + stall exit — PAPER enforce, LIVE gated.
//   R9  correlated-cluster concentration cap.
//   R10 guard telemetry in status/deep-monitor + UI chips.
//   R11 shadow evidence harness — gates + replay, never auto-flips.
// Defaults stay observe-only (shadow/off); only explicit flags can act.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-guards-r3r11-21290-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  GUARD_MODES, normalizeGuardMode, guardActive, guardShadow, guardEnforce,
  normalizeClusterSymbol, correlationClusterOf, evaluateClusterGuard,
  REGIMES, regimeOf, evaluateRegimeFilter,
  evaluatePerpVeto,
  sessionWindowsFor, evaluateEventSessionFilter,
  DEFAULT_CALIBRATION_EDGES, buildScoreCalibration, applyScoreCalibration,
  evaluateScoreCalibrationGate, evaluateReversalGuardV2,
  evaluateRunnerAfterTp2, evaluateStallExit, evaluateEntryGuards,
} from '../server/ai/tradeGuards.js';
import {
  SHADOW_HARNESS_VERSION, SHADOW_MIN_DECISIONS, SHADOW_MIN_WOULD_BLOCK_PCT,
  SHADOW_MAX_WOULD_BLOCK_PCT, emptyShadowStats, emptyShadowStat,
  recordShadowDecision, summarizeShadowStats, shadowHarnessView, replayShadowSeries,
} from '../server/ai/shadowHarness.js';
import {
  mtfAutoTick, updateMtfAutoConfig, __resetMtfAutoForTests, mtfAutoStatus,
  evaluateActiveTradeDeepMonitor, reversalGuardV2Mode, eventSessionFilterMode,
  regimeFilterMode, perpVetoMode, clusterGuardMode, scoreCalibrationMode,
  runnerAfterTp2Mode, stallExitMode,
} from '../server/ai/mtfAutoLink.js';

const SAFE_NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // outside funding/session windows
const ENV_KEYS = [
  'REVERSAL_GUARD_V2', 'EVENT_SESSION_FILTER', 'REGIME_FILTER', 'PERP_VETO',
  'CLUSTER_GUARD', 'SCORE_CALIBRATION', 'RUNNER_AFTER_TP2', 'STALL_EXIT',
  'AI_DISABLE_EVENT_GUARD',
] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
  // Event calendars are date-dependent; the pure R4 test raises its own
  // synthetic eventCheck, while tick tests must stay hermetic.
  process.env.AI_DISABLE_EVENT_GUARD = 'true';
  __resetMtfAutoForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] == null) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  __resetMtfAutoForTests();
});

// ---------------- fixtures ----------------
function boardFixture(symbol = 'BTCUSDT', rowOverrides: Record<string, any> = {}) {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      drivers: ['dual-TF confirm: context+trigger aligned (+4)'],
      ...rowOverrides,
    }],
  };
}

function fakePaper() {
  const calls: any = { opened: [], closed: [] };
  const paper = {
    open: [] as any[],
    openPaperTrade: vi.fn((input: any) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN' });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id: any) => { calls.closed.push(id); return { ok: true, trade: { realizedPnl: 0 } }; }),
    getPaperSummary: vi.fn(() => ({ open: paper.open, closedToday: [] })),
  };
  return { paper, calls };
}

const BEARISH_BARS = [
  { open: 100.2, high: 100.9, low: 99.8, close: 100.6 },
  { open: 100.6, high: 101.1, low: 100.1, close: 100.9 },
  { open: 100.9, high: 101.4, low: 100.4, close: 101.1 },
  { open: 101.1, high: 101.6, low: 100.7, close: 100.9 },
  { open: 100.9, high: 101.2, low: 100.0, close: 100.4 },
  { open: 100.4, high: 100.6, low: 98.7, close: 98.8 },
];

function longTrade(overrides: Record<string, any> = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', side: 'LONG',
    entry: 100, initialStopLoss: 99, stopLoss: 99, trailedStopLoss: 99,
    t1: 102, t2: 104, qty: 1, peakPrice: 102,
    openedAt: SAFE_NOW - 30 * 60_000, executionMode: 'PAPER', status: 'OPEN',
    ...overrides,
  };
}

// ============================================================
// R3/R5/R6/R9 — pure helpers
// ============================================================
describe('v21.29.0 R3-R9 — pure guard helpers', () => {
  it('R? mode parser: explicit aliases only, unknown falls back safely', () => {
    expect(GUARD_MODES).toEqual(['off', 'shadow', 'enforce']);
    expect(normalizeGuardMode('ENFORCE')).toBe('enforce');
    expect(normalizeGuardMode('on')).toBe('enforce');
    expect(normalizeGuardMode('1')).toBe('enforce');
    expect(normalizeGuardMode('observe')).toBe('shadow');
    expect(normalizeGuardMode('dry-run')).toBe('shadow');
    expect(normalizeGuardMode('off')).toBe('off');
    expect(normalizeGuardMode('false')).toBe('off');
    expect(normalizeGuardMode('bogus')).toBe('shadow');
    expect(normalizeGuardMode('bogus', 'off')).toBe('off');
    expect(normalizeGuardMode(undefined, 'enforce')).toBe('enforce');
    expect(guardActive('shadow')).toBe(true);
    expect(guardShadow('shadow')).toBe(true);
    expect(guardEnforce('enforce')).toBe(true);
    expect(guardActive('off')).toBe(false);
  });

  it('R9 cluster mapping strips ticket suffixes and knows families', () => {
    expect(normalizeClusterSymbol('BTCUSDT')).toBe('BTC');
    expect(normalizeClusterSymbol('B-ETH_USDT')).toBe('ETH');
    expect(normalizeClusterSymbol('XAU/USD')).toBe('XAU');
    expect(correlationClusterOf('BTCUSDT')).toBe('MAJORS');
    expect(correlationClusterOf('B-ETH_USDT')).toBe('ETH');
    expect(correlationClusterOf('SOLUSDT')).toBe('ALT_L1');
    expect(correlationClusterOf('1000PEPEUSDT')).toBe('MEME');
    expect(correlationClusterOf('XAU/USD')).toBe('METALS');
    expect(correlationClusterOf('ZZZUSDT')).toBe('OTHER:ZZZ');
    expect(correlationClusterOf('')).toBe('UNKNOWN');
  });

  it('R9 blocks cluster concentration only in enforce mode', () => {
    const openRows = [
      { symbol: 'AVAXUSDT', execMarket: 'FUTURES', status: 'OPEN' },
      { symbol: 'DOTUSDT', execMarket: 'FUTURES', status: 'OPEN' },
      { symbol: 'BTCUSDT', execMarket: 'FUTURES', status: 'CLOSED' },
    ];
    const shadow = evaluateClusterGuard({
      openRows, candidate: { symbol: 'SOLUSDT', execMarket: 'FUTURES' },
      maxPerCluster: 2, mode: 'shadow',
    });
    expect(shadow.cluster).toBe('ALT_L1');
    expect(shadow.count).toBe(2);
    expect(shadow.wouldBlock).toBe(true);
    expect(shadow.blocked).toBe(false);
    expect(shadow.openSymbols).toEqual(['AVAXUSDT', 'DOTUSDT']);

    const enforce = evaluateClusterGuard({
      openRows, candidate: { symbol: 'SOLUSDT', execMarket: 'FUTURES' },
      maxPerCluster: 2, mode: 'enforce',
    });
    expect(enforce.blocked).toBe(true);
    expect(enforce.reason).toMatch(/ALT_L1 cluster/);

    const off = evaluateClusterGuard({
      openRows, candidate: { symbol: 'SOLUSDT', execMarket: 'FUTURES' },
      maxPerCluster: 2, mode: 'off',
    });
    expect(off.wouldBlock).toBe(true);
    expect(off.blocked).toBe(false);

    const otherMarket = evaluateClusterGuard({
      openRows: openRows.map(r => ({ ...r, execMarket: 'GLOBALFUTURES' })),
      candidate: { symbol: 'SOLUSDT', execMarket: 'FUTURES' },
      maxPerCluster: 2, mode: 'enforce',
    });
    expect(otherMarket.count).toBe(0);
    expect(otherMarket.blocked).toBe(false);

    const crossMarket = evaluateClusterGuard({
      openRows: openRows.map(r => ({ ...r, execMarket: 'GLOBALFUTURES' })),
      candidate: { symbol: 'SOLUSDT', execMarket: 'FUTURES' },
      maxPerCluster: 2, mode: 'enforce', sameMarketOnly: false,
    });
    expect(crossMarket.count).toBe(2);
    expect(crossMarket.blocked).toBe(true);

    const noSymbol = evaluateClusterGuard({ openRows, candidate: {}, mode: 'enforce' });
    expect(noSymbol.wouldBlock).toBe(false);
  });

  it('R5 regime resolves aliases and blocks counter-trend/chop only in enforce', () => {
    expect(REGIMES).toContain('TREND_UP');
    expect(regimeOf({ regime: { label: 'bull' } })).toBe('TREND_UP');
    expect(regimeOf({ regime: 'BEARISH' })).toBe('TREND_DOWN');
    expect(regimeOf({ regime: 'range' })).toBe('CHOP');
    expect(regimeOf({ context: { dir: -1 } })).toBe('TREND_DOWN');
    expect(regimeOf({ atrPct: 3 })).toBe('HIGH_VOL');
    expect(regimeOf({})).toBe('UNKNOWN');

    const against = evaluateRegimeFilter({
      row: { side: 'LONG', context: { regime: 'TREND_DOWN' } }, mode: 'enforce',
    });
    expect(against.wouldBlock).toBe(true);
    expect(against.blocked).toBe(true);

    const aligned = evaluateRegimeFilter({
      row: { side: 'SHORT', context: { regime: 'TREND_DOWN' } }, mode: 'enforce',
    });
    expect(aligned.wouldBlock).toBe(false);

    const chop = evaluateRegimeFilter({ row: { side: 'LONG', regime: 'CHOP' }, mode: 'enforce' });
    expect(chop.wouldBlock).toBe(true);
    const chopAllowed = evaluateRegimeFilter({
      row: { side: 'LONG', regime: 'CHOP' }, mode: 'enforce', blockChop: false,
    });
    expect(chopAllowed.wouldBlock).toBe(false);

    const highVol = evaluateRegimeFilter({
      row: { side: 'LONG', regime: 'HIGH_VOL' }, mode: 'enforce', blockHighVol: true,
    });
    expect(highVol.wouldBlock).toBe(true);

    const shadow = evaluateRegimeFilter({
      row: { side: 'LONG', context: { regime: 'TREND_DOWN' } }, mode: 'shadow',
    });
    expect(shadow.wouldBlock).toBe(true);
    expect(shadow.blocked).toBe(false);
  });

  it('R6 perp veto flags crowded funding / ratio / basis on the correct side', () => {
    const longFunding = evaluatePerpVeto({ side: 'LONG', market: 'FUTURES', fundingBps8h: 30, mode: 'enforce' });
    expect(longFunding.wouldBlock).toBe(true);
    expect(longFunding.blocked).toBe(true);
    expect(longFunding.reason).toMatch(/funding/i);

    const shortFunding = evaluatePerpVeto({ side: 'SHORT', market: 'FUTURES', fundingBps8h: -30, mode: 'enforce' });
    expect(shortFunding.wouldBlock).toBe(true);
    const wrongSideFunding = evaluatePerpVeto({ side: 'SHORT', market: 'FUTURES', fundingBps8h: 30, mode: 'enforce' });
    expect(wrongSideFunding.wouldBlock).toBe(false);

    expect(evaluatePerpVeto({ side: 'LONG', market: 'FUTURES', longShortRatio: 3, mode: 'enforce' }).wouldBlock).toBe(true);
    expect(evaluatePerpVeto({ side: 'LONG', market: 'FUTURES', longShortRatio: 2.9, mode: 'enforce' }).wouldBlock).toBe(false);
    expect(evaluatePerpVeto({ side: 'SHORT', market: 'FUTURES', longShortRatio: 0.3, mode: 'enforce' }).wouldBlock).toBe(true);

    expect(evaluatePerpVeto({ side: 'LONG', market: 'FUTURES', basisPct: 1, mode: 'enforce' }).wouldBlock).toBe(true);
    expect(evaluatePerpVeto({ side: 'SHORT', market: 'FUTURES', basisPct: -1.2, mode: 'enforce' }).wouldBlock).toBe(true);

    const notPerp = evaluatePerpVeto({ side: 'LONG', market: 'INDIA', fundingBps8h: 99, mode: 'enforce' });
    expect(notPerp.applicable).toBe(false);
    expect(notPerp.wouldBlock).toBe(false);

    const shadow = evaluatePerpVeto({ side: 'LONG', market: 'FUTURES', fundingBps8h: 50, mode: 'shadow' });
    expect(shadow.wouldBlock).toBe(true);
    expect(shadow.blocked).toBe(false);
  });

  it('R4 event/session filter catches blackouts and market micro-windows', () => {
    expect(sessionWindowsFor('CRYPTO', SAFE_NOW).find(w => w.key === 'FUNDING_8')).toBeTruthy();

    const calm = evaluateEventSessionFilter({ now: SAFE_NOW, desk: 'CRYPTO', mode: 'enforce' });
    expect(calm.wouldBlock).toBe(false);

    const fundingNow = Date.UTC(2026, 5, 15, 8, 2, 0);
    const funding = evaluateEventSessionFilter({ now: fundingNow, desk: 'CRYPTO', mode: 'enforce' });
    expect(funding.session).toBe('FUNDING_8');
    expect(funding.wouldBlock).toBe(true);
    expect(funding.blocked).toBe(true);

    const istOpen = Date.UTC(2026, 5, 15, 3, 50, 0); // 09:20 IST
    const nse = evaluateEventSessionFilter({ now: istOpen, desk: 'INDIA', mode: 'shadow' });
    expect(nse.session).toBe('NSE_OPEN');
    expect(nse.wouldBlock).toBe(true);
    expect(nse.blocked).toBe(false);

    const syntheticBlackout = {
      action: 'blackout', reason: 'FOMC decision in 10m — pre-event blackout',
      event: { kind: 'FOMC', label: 'FOMC decision', at: SAFE_NOW + 10 * 60_000 },
    };
    const blackout = evaluateEventSessionFilter({
      now: SAFE_NOW, desk: 'CRYPTO', mode: 'enforce', eventCheck: syntheticBlackout,
    });
    expect(blackout.event?.kind).toBe('FOMC');
    expect(blackout.wouldBlock).toBe(true);
    expect(blackout.reason).toMatch(/FOMC/);

    const haircut = evaluateEventSessionFilter({
      now: SAFE_NOW, desk: 'CRYPTO', mode: 'enforce',
      eventCheck: { action: 'haircut', multiplier: 0.5, event: { kind: 'US_CPI' } },
    });
    expect(haircut.wouldBlock).toBe(false);
    expect(haircut.haircutMultiplier).toBe(0.5);

    const noSessions = evaluateEventSessionFilter({
      now: fundingNow, desk: 'CRYPTO', mode: 'enforce', sessions: false,
    });
    expect(noSessions.wouldBlock).toBe(false);

    const unknownDesk = evaluateEventSessionFilter({ now: fundingNow, desk: 'GLOBALFUTURES', mode: 'enforce' });
    expect(unknownDesk.wouldBlock).toBe(false);
  });

  it('R7 calibration buckets only gate when the bucket has enough settled n', () => {
    expect(DEFAULT_CALIBRATION_EDGES).toEqual([75, 80, 85, 90, 95, 101]);
    const rows = [
      { status: 'CLOSED', score: 82, pnl: 10, riskINR: 5 },
      { status: 'CLOSED', score: 83, pnl: -5, riskINR: 5 },
      { status: 'CLOSED', score: 92, pnl: 10, riskINR: 5 },
      { status: 'CLOSED', score: 93, pnl: 20, riskINR: 5 },
      { status: 'OPEN', score: 82, pnl: 99 },
      { status: 'CLOSED', score: 10 }, // settled but no pnl/win → excluded
    ];
    const cal = buildScoreCalibration(rows, { minN: 2 });
    expect(cal.settled).toBe(4);
    expect(cal.overall).toMatchObject({ n: 4, wins: 3, winRate: 75, sufficient: true });
    const b82 = cal.buckets.find(b => b.label === '80–84');
    expect(b82).toMatchObject({ n: 2, wins: 1, losses: 1, winRate: 50, avgPnl: 2.5, expectancyR: 0.5, sufficient: true });
    const b92 = cal.buckets.find(b => b.label === '90–94');
    expect(b92).toMatchObject({ n: 2, wins: 2, winRate: 100, expectancyR: 3, sufficient: true });

    const block = applyScoreCalibration({ score: 82, calibration: cal, minN: 2, minWinRate: 55 });
    expect(block.applied).toBe(true);
    expect(block.calibratedWinProb).toBe(50);
    expect(block.wouldBlock).toBe(true);

    const allow = applyScoreCalibration({ score: 92, calibration: cal, minN: 2, minWinRate: 55 });
    expect(allow.wouldBlock).toBe(false);
    expect(allow.calibratedWinProb).toBe(100);

    const thin = applyScoreCalibration({ score: 82, calibration: cal, minN: 3, minWinRate: 55 });
    expect(thin.applied).toBe(false);
    expect(thin.wouldBlock).toBe(false);
    expect(thin.reason).toMatch(/insufficient/);

    const noScore = applyScoreCalibration({ score: null, calibration: cal });
    expect(noScore.applied).toBe(false);
    expect(noScore.reason).toBe('no-score');

    const enforce = evaluateScoreCalibrationGate({
      row: { superScore: 82 }, calibration: cal, mode: 'enforce', minN: 2, minWinRate: 55,
    });
    expect(enforce.blocked).toBe(true);
    const shadow = evaluateScoreCalibrationGate({
      row: { superScore: 82 }, calibration: cal, mode: 'shadow', minN: 2, minWinRate: 55,
    });
    expect(shadow.wouldBlock).toBe(true);
    expect(shadow.blocked).toBe(false);
    const off = evaluateScoreCalibrationGate({
      row: { superScore: 82 }, calibration: cal, mode: 'off', minN: 2, minWinRate: 55,
    });
    expect(off.active).toBe(false);
    expect(off.blocked).toBe(false);
  });
});

// ============================================================
// R3 — reversal guard v2
// ============================================================
describe('v21.29.0 R3 — reversal guard v2 tiers + LIVE gate', () => {
  const base = {
    side: 'LONG', entry: 100, stopLoss: 99, peakPrice: 102, risk: 1,
    closedCandles: BEARISH_BARS,
  };

  it('no evidence = tier 0, even in enforce', () => {
    const ev = evaluateReversalGuardV2({
      ...base, ltp: 100.5, closedCandles: null, mode: 'enforce',
    });
    expect(ev.classCount).toBe(0);
    expect(ev.tier).toBe(0);
    expect(ev.wouldExit).toBe(false);
    expect(ev.shouldExit).toBe(false);
  });

  it('one class → tighten only; two classes → reduce request', () => {
    const tighten = evaluateReversalGuardV2({
      ...base, ltp: 100.5, boardFlipped: true, closedCandles: null, mode: 'enforce',
    });
    expect(tighten.classCount).toBe(1);
    expect(tighten.tierLabel).toBe('TIGHTEN');
    expect(tighten.shouldTighten).toBe(true);
    expect(tighten.shouldReduce).toBe(false);
    expect(tighten.shouldExit).toBe(false);
    expect(tighten.tightenSl).toBe(101.25); // peak 102 − 0.75R

    const reduce = evaluateReversalGuardV2({
      ...base, ltp: 100.5, boardFlipped: true, mode: 'enforce',
    });
    expect(reduce.classCount).toBe(2); // board + bearish closed bar
    expect(reduce.tierLabel).toBe('REDUCE');
    expect(reduce.wouldReduce).toBe(true);
    expect(reduce.reducePct).toBe(50);
    expect(reduce.shouldExit).toBe(false);
  });

  it('3+ classes → CLOSE in PAPER; LIVE needs liveEnabled and fee cover', () => {
    const paper = evaluateReversalGuardV2({
      ...base, ltp: 98.4, boardFlipped: true, reversalRiskHint: true,
      mode: 'enforce', executionMode: 'PAPER',
    });
    expect(paper.classCount).toBeGreaterThanOrEqual(3);
    expect(paper.tierLabel).toBe('CLOSE');
    expect(paper.applied).toBe(true);
    expect(paper.shouldExit).toBe(true);
    expect(paper.liveGated).toBe(false);

    const liveGated = evaluateReversalGuardV2({
      ...base, ltp: 98.4, boardFlipped: true, reversalRiskHint: true,
      mode: 'enforce', executionMode: 'LIVE', liveEnabled: false,
    });
    expect(liveGated.classCount).toBeGreaterThanOrEqual(3);
    expect(liveGated.liveGated).toBe(true);
    expect(liveGated.applied).toBe(false);
    expect(liveGated.shouldExit).toBe(false);
    expect(liveGated.note).toMatch(/LIVE gate is closed/);

    const liveOk = evaluateReversalGuardV2({
      ...base, ltp: 98.4, boardFlipped: true, reversalRiskHint: true,
      mode: 'enforce', executionMode: 'LIVE', liveEnabled: true, feeCovered: true,
    });
    expect(liveOk.applied).toBe(true);
    expect(liveOk.shouldExit).toBe(true);

    const liveFeeLoss = evaluateReversalGuardV2({
      ...base, ltp: 98.4, boardFlipped: true, reversalRiskHint: true,
      mode: 'enforce', executionMode: 'LIVE', liveEnabled: true, feeCovered: false,
    });
    expect(liveFeeLoss.applied).toBe(true);
    expect(liveFeeLoss.shouldExit).toBe(false);
  });

  it('shadow records the tiers but never acts', () => {
    const ev = evaluateReversalGuardV2({
      ...base, ltp: 98.4, boardFlipped: true, reversalRiskHint: true, mode: 'shadow',
    });
    expect(ev.classCount).toBeGreaterThanOrEqual(3);
    expect(ev.wouldExit).toBe(true);
    expect(ev.shouldExit).toBe(false);
    expect(ev.shouldTighten).toBe(false);
    expect(ev.shadow).toBe(true);
    expect(ev.note).toMatch(/SHADOW/);
  });
});

// ============================================================
// R8 — runner after TP2 + stall exit
// ============================================================
describe('v21.29.0 R8 — runner + stall exits', () => {
  it('runner is off by default and shadow never acts', () => {
    const off = evaluateRunnerAfterTp2({
      mode: 'off', executionMode: 'PAPER', tp2Hit: true, side: 'LONG',
      entry: 100, tp1: 101, risk: 1, peakPrice: 104, ltp: 104,
    });
    expect(off.applied).toBe(false);
    expect(off.active).toBe(false);
    expect(off.shouldClose).toBe(false);

    const shadow = evaluateRunnerAfterTp2({
      mode: 'shadow', executionMode: 'PAPER', tp2Hit: true, side: 'LONG',
      entry: 100, tp1: 101, risk: 1, peakPrice: 104, ltp: 104,
    });
    expect(shadow.applied).toBe(false);
    expect(shadow.shadow).toBe(true);
    expect(shadow.note).toMatch(/SHADOW/);
  });

  it('PAPER runner holds with a trail, then exits when the trail is hit', () => {
    const hold = evaluateRunnerAfterTp2({
      mode: 'enforce', executionMode: 'PAPER', tp2Hit: true, side: 'LONG',
      entry: 100, tp1: 101, risk: 1, peakPrice: 104, ltp: 104, trailR: 0.75,
    });
    expect(hold.applied).toBe(true);
    expect(hold.active).toBe(true);
    expect(hold.trailSl).toBe(103.25);
    expect(hold.shouldClose).toBe(false);

    const exit = evaluateRunnerAfterTp2({
      mode: 'enforce', executionMode: 'PAPER', tp2Hit: true, side: 'LONG',
      entry: 100, tp1: 101, risk: 1, peakPrice: 104, ltp: 103.1, trailR: 0.75,
    });
    expect(exit.active).toBe(false);
    expect(exit.shouldClose).toBe(true);

    const shortHold = evaluateRunnerAfterTp2({
      mode: 'enforce', executionMode: 'PAPER', tp2Hit: true, side: 'SHORT',
      entry: 100, tp1: 99, risk: 1, peakPrice: 96, ltp: 96.7, trailR: 0.75,
    });
    expect(shortHold.trailSl).toBe(96.75);
    expect(shortHold.active).toBe(true);
  });

  it('LIVE runner stays gated until every R0/R1 prerequisite is proven', () => {
    const gated = evaluateRunnerAfterTp2({
      mode: 'enforce', executionMode: 'LIVE', tp2Hit: true, side: 'LONG',
      entry: 100, tp1: 101, risk: 1, peakPrice: 104, ltp: 104, liveRunner: true,
    });
    expect(gated.liveGated).toBe(true);
    expect(gated.applied).toBe(false);
    expect(gated.note).toMatch(/LIVE gated/);

    const flagsOnly = evaluateRunnerAfterTp2({
      mode: 'enforce', executionMode: 'LIVE', tp2Hit: true, side: 'LONG',
      entry: 100, tp1: 101, risk: 1, peakPrice: 104, ltp: 104,
      liveRunner: true, liveTp1Partial: true,
    });
    expect(flagsOnly.liveGated).toBe(true);
    expect(flagsOnly.applied).toBe(false);

    const armed = evaluateRunnerAfterTp2({
      mode: 'enforce', executionMode: 'LIVE', tp2Hit: true, side: 'LONG',
      entry: 100, tp1: 101, risk: 1, peakPrice: 104, ltp: 104,
      liveRunner: true, liveTp1Partial: true,
      liveSafeReduce: true, liveOrderIdempotency: true,
    });
    expect(armed.liveGated).toBe(false);
    expect(armed.applied).toBe(true);
    expect(armed.active).toBe(true);
  });

  it('stall exit fires only after the configured no-progress window', () => {
    const now = SAFE_NOW;
    const stalled = evaluateStallExit({
      mode: 'enforce', executionMode: 'PAPER', openedAt: now - 60 * 60_000,
      now, stallMin: 45, peakR: 0.1, t1Hit: false,
    });
    expect(stalled.stalled).toBe(true);
    expect(stalled.applied).toBe(true);
    expect(stalled.shouldExit).toBe(true);
    expect(stalled.reason).toMatch(/no progress/);

    expect(evaluateStallExit({
      mode: 'enforce', executionMode: 'PAPER', openedAt: now - 60 * 60_000,
      now, stallMin: 45, peakR: 0.1, t1Hit: true,
    }).stalled).toBe(false);
    expect(evaluateStallExit({
      mode: 'enforce', executionMode: 'PAPER', openedAt: now - 60 * 60_000,
      now, stallMin: 45, peakR: 0.3, t1Hit: false,
    }).stalled).toBe(false);
    expect(evaluateStallExit({
      mode: 'enforce', executionMode: 'PAPER', openedAt: now - 10 * 60_000,
      now, stallMin: 45, peakR: 0.1, t1Hit: false,
    }).stalled).toBe(false);

    const shadow = evaluateStallExit({
      mode: 'shadow', executionMode: 'PAPER', openedAt: now - 60 * 60_000,
      now, stallMin: 45, peakR: 0.1, t1Hit: false,
    });
    expect(shadow.stalled).toBe(true);
    expect(shadow.shouldExit).toBe(false);
    expect(shadow.shadow).toBe(true);

    const liveGated = evaluateStallExit({
      mode: 'enforce', executionMode: 'LIVE', allowLive: false,
      openedAt: now - 60 * 60_000, now, stallMin: 45, peakR: 0.1, t1Hit: false,
    });
    expect(liveGated.liveGated).toBe(true);
    expect(liveGated.applied).toBe(false);

    const liveArmed = evaluateStallExit({
      mode: 'enforce', executionMode: 'LIVE', allowLive: true,
      openedAt: now - 60 * 60_000, now, stallMin: 45, peakR: 0.1, t1Hit: false,
    });
    expect(liveArmed.applied).toBe(true);

    expect(evaluateStallExit({
      mode: 'enforce', executionMode: 'PAPER', openedAt: now - 60 * 60_000,
      now, stallMin: 0, peakR: 0.1, t1Hit: false,
    }).applied).toBe(false);
  });
});

// ============================================================
// Entry-guard aggregator
// ============================================================
describe('v21.29.0 R4-R9 — entry-guard aggregator', () => {
  it('all-shadow reports warnings without blocking; enforce has blockers', () => {
    const row = {
      symbol: 'BTCUSDT', side: 'LONG', execMarket: 'FUTURES',
      superScore: 82, context: { regime: 'CHOP', fundingBps8h: 40 },
    };
    const shadowCfg = {
      eventSessionFilter: 'shadow', regimeFilter: 'shadow', perpVeto: 'shadow',
      clusterGuard: 'shadow', scoreCalibration: 'off', clusterGuardMax: 2,
    };
    const calmNow = SAFE_NOW;
    const shadow = evaluateEntryGuards({
      cfg: shadowCfg, row, openRows: [], closedRows: [], now: calmNow, desk: 'FUTURES',
    });
    expect(shadow.blocked).toBe(false);
    expect(shadow.blockers).toEqual([]);
    expect(shadow.shadowWarnings.map(w => w.filter).sort()).toEqual(
      ['perpVeto', 'regimeFilter'].sort(),
    );
    expect(shadow.filters.scoreCalibration.active).toBe(false);

    const enforce = evaluateEntryGuards({
      cfg: { ...shadowCfg, regimeFilter: 'enforce' },
      row, openRows: [], closedRows: [], now: calmNow, desk: 'FUTURES',
    });
    expect(enforce.blocked).toBe(true);
    expect(enforce.blockers[0].filter).toBe('regimeFilter');
    // Other filters stay shadow: their warnings do not become blockers.
    expect(enforce.blockers).toHaveLength(1);
  });

  it('event blackout reaches the aggregator and blocks only in enforce', () => {
    const row = { symbol: 'BTCUSDT', side: 'LONG', execMarket: 'FUTURES', superScore: 82, context: { regime: 'TREND_UP' } };
    const eventCheck = { action: 'blackout', reason: 'FOMC blackout', event: { kind: 'FOMC' } };
    const shadow = evaluateEntryGuards({
      cfg: { eventSessionFilter: 'shadow', regimeFilter: 'off', perpVeto: 'off', clusterGuard: 'off', scoreCalibration: 'off' },
      row, now: SAFE_NOW, desk: 'FUTURES', eventCheck,
    });
    expect(shadow.blocked).toBe(false);
    expect(shadow.filters.eventSessionFilter.wouldBlock).toBe(true);

    const enforce = evaluateEntryGuards({
      cfg: { eventSessionFilter: 'enforce', regimeFilter: 'off', perpVeto: 'off', clusterGuard: 'off', scoreCalibration: 'off' },
      row, now: SAFE_NOW, desk: 'FUTURES', eventCheck,
    });
    expect(enforce.blocked).toBe(true);
    expect(enforce.blockers[0].reason).toBe('FOMC blackout');
  });
});

// ============================================================
// R11 — shadow evidence harness
// ============================================================
describe('v21.29.0 R11 — shadow harness', () => {
  it('records only shadow observations, with bounded samples', () => {
    const stats: Record<string, any> = emptyShadowStats();
    recordShadowDecision(stats, { filter: 'regimeFilter', mode: 'shadow', wouldBlock: true, reason: 'chop', symbol: 'BTCUSDT', market: 'FUTURES', at: 1000 });
    recordShadowDecision(stats, { filter: 'regimeFilter', mode: 'off', wouldBlock: true, at: 2000 });
    recordShadowDecision(stats, { filter: 'regimeFilter', mode: 'enforce', wouldBlock: true, at: 3000 });
    expect(stats.regimeFilter).toMatchObject({ decisions: 1, wouldBlock: 1, firstAt: 1000, lastAt: 1000 });
    expect(stats.regimeFilter.samples).toHaveLength(1);
    expect(emptyShadowStat('x')).toMatchObject({ filter: 'x', decisions: 0, wouldBlock: 0 });

    for (let i = 0; i < 15; i += 1) {
      recordShadowDecision(stats, { filter: 'perpVeto', mode: 'shadow', wouldBlock: false, at: 10_000 + i });
    }
    expect(stats.perpVeto.decisions).toBe(15);
    expect(stats.perpVeto.samples).toHaveLength(10);
    expect(stats.perpVeto.samples[9].at).toBe(10_014);
    expect(stats.perpVeto.firstAt).toBe(10_000);
  });

  it('acceptance gates require enough decisions and a sane would-block rate', () => {
    expect(SHADOW_HARNESS_VERSION).toBe('r11-v1');
    expect(SHADOW_MIN_DECISIONS).toBe(50);
    expect(SHADOW_MIN_WOULD_BLOCK_PCT).toBe(1);
    expect(SHADOW_MAX_WOULD_BLOCK_PCT).toBe(40);

    const summary = summarizeShadowStats({
      good: { decisions: 50, wouldBlock: 5, firstAt: 1, lastAt: 2 },
      thin: { decisions: 10, wouldBlock: 5, firstAt: 1, lastAt: 2 },
      never: { decisions: 50, wouldBlock: 0, firstAt: 1, lastAt: 2 },
      hot: { decisions: 50, wouldBlock: 25, firstAt: 1, lastAt: 2 },
    }, { now: 3, minDecisions: 50 });
    const gate = (name: string) => summary.gates.find(g => g.filter === name)!;
    expect(gate('good').readyForReview).toBe(true);
    expect(gate('thin').readyForReview).toBe(false);
    expect(gate('thin').reasons.join(' ')).toMatch(/decisions 10\/50/);
    expect(gate('never').reasons.join(' ')).toMatch(/never\/rarely fires/);
    expect(gate('hot').reasons.join(' ')).toMatch(/too aggressive/);
    expect(summary.totals).toMatchObject({ filters: 4, decisions: 160, wouldBlock: 35 });
    expect(summary.note).toMatch(/no flag is auto-flipped/i);

    const view = shadowHarnessView({
      good: { decisions: 50, wouldBlock: 5, firstAt: 1, lastAt: 2 },
    }, { minDecisions: 50, now: 3 });
    expect(view.readyForReview).toEqual(['good']);
    expect(view.manualReviewRequired).toBe(true);
  });

  it('replay compares proposed vs baseline and never throws on evaluator errors', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, block: i < 3 }));
    const replay = replayShadowSeries(rows, {
      evaluate: (r: any) => ({ wouldBlock: r.block, reason: r.block ? 'test' : null }),
      minDecisions: 5,
      now: 123,
    });
    expect(replay.n).toBe(10);
    expect(replay.blocks).toBe(3);
    expect(replay.blockRatePct).toBe(30);
    expect(replay.agreementPct).toBe(70);
    expect(replay.disagreement).toBe(3);
    expect(replay.examples).toHaveLength(3);
    expect(replay.readyForReview).toBe(true);

    const errorReplay = replayShadowSeries([{ symbol: 'X' }], {
      evaluate: () => { throw new Error('boom'); },
      minDecisions: 1,
      now: 1,
    });
    expect(errorReplay.proposedTally.error).toBe(1);
    expect(errorReplay.disagreements[0].proposed).toBe('error');
    expect(errorReplay.blocks).toBe(0);
    expect(errorReplay.readyForReview).toBe(false);
  });
});

// ============================================================
// Config + env plumbing
// ============================================================
describe('v21.29.0 R3-R9 — config and env modes', () => {
  it('sanitizes every guard mode; unknown values fall back to documented defaults', () => {
    const cfg = updateMtfAutoConfig({
      reversalGuardV2: 'ENFORCE',
      eventSessionFilter: 'on',
      regimeFilter: 'observe',
      perpVeto: 'bogus',
      clusterGuard: 'off',
      scoreCalibration: 'true',
      runnerAfterTp2: '1',
      stallExit: 'dry-run',
    });
    expect(cfg.reversalGuardV2).toBe('enforce');
    expect(cfg.eventSessionFilter).toBe('enforce');
    expect(cfg.regimeFilter).toBe('shadow');
    expect(cfg.perpVeto).toBe('shadow');
    expect(cfg.clusterGuard).toBe('off');
    expect(cfg.scoreCalibration).toBe('enforce');
    expect(cfg.runnerAfterTp2).toBe('enforce');
    expect(cfg.stallExit).toBe('shadow');
  });

  it('env wins over persisted config; unknown env falls back safely', () => {
    updateMtfAutoConfig({
      reversalGuardV2: 'enforce',
      eventSessionFilter: 'enforce',
      regimeFilter: 'enforce',
      perpVeto: 'enforce',
      clusterGuard: 'enforce',
      scoreCalibration: 'enforce',
      runnerAfterTp2: 'enforce',
      stallExit: 'enforce',
    });
    expect(reversalGuardV2Mode()).toBe('enforce');
    process.env.REVERSAL_GUARD_V2 = 'off';
    expect(reversalGuardV2Mode()).toBe('off');
    process.env.REVERSAL_GUARD_V2 = 'bogus';
    expect(reversalGuardV2Mode()).toBe('shadow');
    delete process.env.REVERSAL_GUARD_V2;

    process.env.EVENT_SESSION_FILTER = 'off';
    process.env.REGIME_FILTER = 'shadow';
    process.env.PERP_VETO = 'off';
    process.env.CLUSTER_GUARD = 'shadow';
    process.env.SCORE_CALIBRATION = 'off';
    process.env.RUNNER_AFTER_TP2 = 'shadow';
    process.env.STALL_EXIT = 'off';
    expect(eventSessionFilterMode()).toBe('off');
    expect(regimeFilterMode()).toBe('shadow');
    expect(perpVetoMode()).toBe('off');
    expect(clusterGuardMode()).toBe('shadow');
    expect(scoreCalibrationMode()).toBe('off');
    expect(runnerAfterTp2Mode()).toBe('shadow');
    expect(stallExitMode()).toBe('off');
  });
});

// ============================================================
// Tick integration — shadow records, enforce blocks
// ============================================================
describe('v21.29.0 R4-R9 — tick integration', () => {
  it('shadow guards never block, record evidence, and surface in status', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, desks: { india: false, crypto: true },
        eventSessionFilter: 'shadow', regimeFilter: 'shadow', perpVeto: 'shadow',
        clusterGuard: 'shadow', scoreCalibration: 'off',
      },
      state: { book: [] },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick({
      boards: {
        CRYPTO: boardFixture('BTCUSDT', {
          context: { regime: 'CHOP', fundingBps8h: 40 },
        }),
      },
      paper,
      quotes: { BTCUSDT: { price: 100 }, BTC: { price: 100 } },
      now: SAFE_NOW,
    });
    expect(out.opened).toHaveLength(1);
    expect(out.shadow.length).toBeGreaterThan(0);
    const warned = out.shadow[0].warnings.map((w: any) => w.filter);
    expect(warned).toContain('regimeFilter');
    expect(warned).toContain('perpVeto');

    const st = mtfAutoStatus();
    expect(st.guards.modes.regimeFilter).toBe('shadow');
    expect(st.guards.modes.perpVeto).toBe('shadow');
    expect(st.guards.shadowHarness.totals.decisions).toBeGreaterThanOrEqual(3);
    expect(st.guards.shadowHarness.totals.wouldBlock).toBeGreaterThanOrEqual(2);
    expect(st.guards.shadowHarness.note).toBeTruthy();
    expect(st.deepMonitor.guards).toBeTruthy();
  });

  it('enforce blocks the same candidate and leaves the book empty', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, desks: { india: false, crypto: true },
        eventSessionFilter: 'shadow', regimeFilter: 'enforce', perpVeto: 'shadow',
        clusterGuard: 'shadow', scoreCalibration: 'off',
      },
      state: { book: [] },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT', { context: { regime: 'CHOP', fundingBps8h: 40 } }) },
      paper,
      quotes: { BTCUSDT: { price: 100 }, BTC: { price: 100 } },
      now: SAFE_NOW,
    });
    expect(out.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/entry guard blocked/);
    expect(out.skipped.join(' ')).toMatch(/regimeFilter/);
    expect(mtfAutoStatus().guards.shadowHarness.totals.wouldBlock).toBeGreaterThanOrEqual(1);
  });

  it('cluster enforce blocks a third correlated ALT_L1 entry', async () => {
    const now = SAFE_NOW;
    __resetMtfAutoForTests({
      config: {
        enabled: true, desks: { india: false, crypto: true },
        maxOpenPositions: 5, maxTradesPerDay: 20,
        clusterGuard: 'enforce', clusterGuardMax: 2,
        eventSessionFilter: 'off', regimeFilter: 'off', perpVeto: 'off', scoreCalibration: 'off',
      },
      state: {
        book: [
          { symbol: 'DOTUSDT', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG', entry: 100, stopLoss: 99, t1: 101, t2: 102, qty: 1, openedAt: now - 5 * 60_000, status: 'OPEN', traded: true },
          { symbol: 'AVAXUSDT', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG', entry: 100, stopLoss: 99, t1: 101, t2: 102, qty: 1, openedAt: now - 5 * 60_000, status: 'OPEN', traded: true },
        ],
      },
    });
    const { paper } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('SOLUSDT') },
      paper,
      quotes: { SOLUSDT: { price: 100 }, SOL: { price: 100 } },
      now,
    });
    expect(out.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/clusterGuard/);
    expect(out.skipped.join(' ')).toMatch(/ALT_L1/);
  });
});

// ============================================================
// Deep-monitor integration — R3 / R8 action flags
// ============================================================
describe('v21.29.0 R3/R8 — deep-monitor wiring', () => {
  it('R3 enforce exits a PAPER trade on 3+ reversal classes; shadow does not', () => {
    updateMtfAutoConfig({ reversalGuardV2: 'enforce' });
    const ctx = {
      ltp: 98.4, now: SAFE_NOW, closedCandles: BEARISH_BARS,
      boardRow: { side: 'SHORT', triggerFired: true, superScore: 82, trigger: { reversalRisk: true } },
    };
    const mon = evaluateActiveTradeDeepMonitor(longTrade(), ctx);
    expect(mon.reversalGuardV2.tier).toBeGreaterThanOrEqual(3);
    expect(mon.reversalGuardV2.applied).toBe(true);
    expect(mon.shouldReversalGuardClose).toBe(true);
    expect(mon.shouldBookProfitNow).toBe(true);
    expect(mon.exitReason).toBe('REVERSAL_GUARD_V2_EXIT');

    updateMtfAutoConfig({ reversalGuardV2: 'shadow' });
    const shadow = evaluateActiveTradeDeepMonitor(longTrade(), ctx);
    expect(shadow.reversalGuardV2.shadow).toBe(true);
    expect(shadow.reversalGuardV2.classCount).toBeGreaterThanOrEqual(3);
    expect(shadow.shouldReversalGuardClose).toBe(false);
    expect(shadow.exitReason).not.toBe('REVERSAL_GUARD_V2_EXIT');
  });

  it('R8 PAPER runner holds after TP2 and exits on the trail', () => {
    updateMtfAutoConfig({ reversalGuardV2: 'off', runnerAfterTp2: 'enforce', stallExit: 'off' });
    const trade = longTrade({
      entry: 100, initialStopLoss: 99, stopLoss: 99, t1: 101, t2: 103,
      peakPrice: 104, tp2Hit: true, openedAt: SAFE_NOW - 5 * 60_000,
    });
    const hold = evaluateActiveTradeDeepMonitor(trade, { ltp: 104, now: SAFE_NOW });
    expect(hold.runnerAfterTp2.applied).toBe(true);
    expect(hold.runnerAfterTp2.active).toBe(true);
    expect(hold.runnerAfterTp2.trailSl).toBe(103.25);
    expect(hold.shouldRunnerExit).toBe(false);
    expect(hold.shouldBookProfitNow).toBe(false);
    expect(hold.exitReason).toBeNull();
    expect(hold.stageCode).toBe('STAGE_5_RUNNER_ACTIVE');

    const exit = evaluateActiveTradeDeepMonitor(trade, { ltp: 103.1, now: SAFE_NOW });
    expect(exit.runnerAfterTp2.shouldClose).toBe(true);
    expect(exit.shouldRunnerExit).toBe(true);
    expect(exit.shouldBookProfitNow).toBe(true);
    expect(exit.exitReason).toBe('TP2_RUNNER_TRAIL_EXIT');
  });

  it('R8 stall exit closes a no-progress PAPER trade; LIVE stays gated', () => {
    updateMtfAutoConfig({ reversalGuardV2: 'off', runnerAfterTp2: 'off', stallExit: 'enforce' });
    const trade = longTrade({
      t1: 101, t2: 103, peakPrice: 100.1, tp2Hit: false,
      openedAt: SAFE_NOW - 60 * 60_000,
    });
    const mon = evaluateActiveTradeDeepMonitor(trade, { ltp: 100.1, now: SAFE_NOW });
    expect(mon.stallExit.stalled).toBe(true);
    expect(mon.stallExit.applied).toBe(true);
    expect(mon.shouldStallExit).toBe(true);
    expect(mon.shouldBookProfitNow).toBe(true);
    expect(mon.exitReason).toBe('STALL_EXIT_NO_PROGRESS');

    const live = evaluateActiveTradeDeepMonitor(
      longTrade({ ...trade, executionMode: 'LIVE' }),
      { ltp: 100.1, now: SAFE_NOW },
    );
    expect(live.stallExit.liveGated).toBe(true);
    expect(live.shouldStallExit).toBe(false);
    expect(live.exitReason).toBeNull();
  });

  it('R8 TP2 touch is sticky: a pullback below TP2 cannot un-touch it', () => {
    updateMtfAutoConfig({ reversalGuardV2: 'off', runnerAfterTp2: 'enforce', stallExit: 'off' });
    const trade = longTrade({
      entry: 100, initialStopLoss: 99, stopLoss: 99, t1: 101, t2: 103,
      peakPrice: 104, tp2Hit: false, t2Hit: true,
      openedAt: SAFE_NOW - 5 * 60_000,
    });
    const mon = evaluateActiveTradeDeepMonitor(trade, { ltp: 103.4, now: SAFE_NOW });
    expect(mon.tp2Hit).toBe(true);
    expect(mon.runnerAfterTp2.active).toBe(true);
    expect(mon.shouldRunnerExit).toBe(false);

    // Both deep-monitor call sites latch the touch on the persisted book row;
    // otherwise the next tick derives tp2Hit from LTP alone and the runner
    // trail can never exit after a pullback.
    const link = fs.readFileSync(path.join(process.cwd(), 'server/ai/mtfAutoLink.js'), 'utf8');
    const latches = link.match(/b\.t2Hit = Boolean\(deepEval\.tp2Hit \|\| b\.t2Hit\);/g) || [];
    expect(latches).toHaveLength(2);
  });
});

// ============================================================
// R10 — UI + source pins
// ============================================================
describe('v21.29.0 R10 — guard telemetry surfaces', () => {
  const panel = fs.readFileSync(path.join(process.cwd(), 'src/components/aitrading/SignalRecheckPanel.tsx'), 'utf8');
  const hook = fs.readFileSync(path.join(process.cwd(), 'src/components/aitrading/useAITrading.ts'), 'utf8');
  const link = fs.readFileSync(path.join(process.cwd(), 'server/ai/mtfAutoLink.js'), 'utf8');

  it('status/deep-monitor expose guard modes, shadow evidence and calibration', () => {
    expect(link).toContain('export function mtfAutoGuardTelemetry');
    expect(link).toContain('guards: mtfAutoGuardTelemetry(cfg)');
    expect(link).toContain('recordShadowDecision(');
    expect(link).toContain('REVERSAL_GUARD_V2');
    expect(link).toContain('EVENT_SESSION_FILTER');
    expect(link).toContain('REGIME_FILTER');
    expect(link).toContain('PERP_VETO');
    expect(link).toContain('CLUSTER_GUARD');
    expect(link).toContain('SCORE_CALIBRATION');
    expect(link).toContain('RUNNER_AFTER_TP2');
    expect(link).toContain('STALL_EXIT');
    expect(hook).toContain('guards?: {');
  });

  it('UI renders muted off/shadow and loud enforce chips + shadow/calibration totals', () => {
    expect(panel).toContain('GUARD_MODE_STYLE');
    expect(panel).toContain('GUARD_LABEL');
    expect(panel).toContain('guards?.modes');
    expect(panel).toContain('shadowHarness');
    expect(panel).toContain('calibration');
    expect(panel).toContain('RV2');
    expect(panel).toContain('RUNNER');
    expect(panel).toContain('STALL');
    expect(panel).toContain("enforce: 'bg-emerald-500/15");
    expect(panel).toContain("shadow: 'bg-amber-500/10");
  });
});
