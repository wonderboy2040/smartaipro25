import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-v2118-test-'));
process.env.MTF_AUTO_DATA_DIR = tmpDir;

import {
  WALLET_LEVERAGE_THRESHOLD_INR,
  walletLeverageForEquityINR,
  defaultRoundTripFeePct,
  feeBreakevenFloor,
  evaluateFeeAwareReversalExit,
} from '../server/exec/sizing.js';
import { DUAL_BOARD_MODES, TOP_DEEP_TREND_LIMIT, fuseDualTf } from '../server/ai/mtfDualBoard.js';
import { readContext, readTrigger, buildPlanFromCandles } from '../server/ai/tradePlanner.js';
import { loadCredsForOrder } from '../server/ai/futures.js';
import { __resetCoinDcxForTests } from '../server/mcp/coindcx.js';
import { tapeVote } from '../server/ai/models.js';
import {
  computeMtfWalletLeverage,
  mtfAutoTick,
  updateMtfAutoConfig,
  setMtfAutoEnabled,
  __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import { resolveAgentLeverage } from '../server/ai/agent.js';
import { proTraderWalletLeverage, proTraderReversalCheck } from '../server/ai/proTraderAuto.js';
import { tryParseJson } from '../server/ai/llmChain.js';

describe('v21.18.0 — Dual-TF Superintelligence Board + Local Ollama + Wallet 10x/5x Leverage + Fee-Aware Zero-Loss Exit', () => {
  beforeEach(() => {
    __resetMtfAutoForTests();
  });

  it('1) restricts Dual-TF modes to strictly 2 modes: INTRADAY (15m+5m) and SWING (1h+15m)', () => {
    expect(DUAL_BOARD_MODES).toEqual(['INTRADAY', 'SWING']);
    const panelSrc = fs.readFileSync(path.resolve('src/components/aitrading/MTFDualBoardPanel.tsx'), 'utf8');
    expect(panelSrc).toContain('15m Deep + 5m Action');
    expect(panelSrc).toContain('1h Deep + 15m Action');
    expect(panelSrc).not.toContain("id: 'SCALP'");

    // Integrated inside Section 01 · Superintelligence Signal Board on both desks
    const cxSrc = fs.readFileSync(path.resolve('src/components/tabs/CoinDcxTab.tsx'), 'utf8');
    const inSrc = fs.readFileSync(path.resolve('src/components/tabs/IndiaIntradayTab.tsx'), 'utf8');
    expect(cxSrc).toContain('<MTFDualBoardPanel');
    expect(inSrc).toContain('<MTFDualBoardPanel');
    expect(cxSrc).not.toContain('num="01d"');
    expect(inSrc).not.toContain('num="01d"');
  });

  it('2) upgrades Super Score with Top AI Agents + SVA + Local Ollama Council accuracy', () => {
    const planBase = {
      ok: true,
      symbol: 'BTC',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      confidence: 80,
      grade: 'A',
      bias: 'BULLISH',
      side: 'LONG',
      dir: 1,
      tfFit: { verdict: 'GOOD', note: '15m+5m fit', ratio: 1.0 },
      context: { tf: '15m', dir: 1, score: 82, adx: 28, rsi: 58, supertrend: 'UP', atrPct: 0.9 },
      trigger: { tf: '5m', dir: 1, score: 76, broke: true, triggerFired: true, volRatio: 1.5, patterns: ['BULL_ENGULF'] },
      extended: { dir: 1, dailyDir: 1, h4Dir: 1, note: '1d+4h aligned' },
      plan: { side: 'LONG', entry: 82000, stopLoss: 81400, t1: 82900, t2: 83800, costR: 0.12, netRR: { t1: 1.4, t2: 2.8 } },
    };

    const withoutAgents = fuseDualTf({ plan: planBase, boardSig: { aiScore: 70, side: 'LONG' }, mtf6: null });
    const withTopAgentsAndOllama = fuseDualTf({
      plan: planBase,
      boardSig: {
        aiScore: 84,
        side: 'LONG',
        confidence: 86,
        agreement: 88,
        voters: 14,
        sva: { action: 'STRONG_BUY', score: 92 },
        aiConfirm: { verdict: 'CONFIRM', provider: 'ollama', model: 'qwen3:8b', reason: 'Strong 15m+5m breakout' },
      },
      mtf6: { consensus: 'STRONG BUY', agreementPct: 84 },
    });

    expect(withTopAgentsAndOllama.superScore).toBeGreaterThan(withoutAgents.superScore!);
    expect(withTopAgentsAndOllama.tier).toBe('ELITE');
    expect(withTopAgentsAndOllama.drivers.some((d: string) => d.includes('AI Council / Ollama') && d.includes('CONFIRM'))).toBe(true);
    expect(withTopAgentsAndOllama.drivers.some((d: string) => d.includes('SVA 10-check STRONG_BUY'))).toBe(true);
  });

  it('3) parses Local Ollama JSON responses with thinking blocks and trailing commas cleanly (zero error)', () => {
    const raw = `<think>Analyzing 15m deep trend and 5m trigger...</think>\n` +
      '```json\n{"verdict": "CONFIRM", "confidenceDelta": 6, "reason": "15m HH-HL + 5m volume expansion",}\n```';
    const parsed = tryParseJson(raw) as Record<string, unknown> | null;
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe('CONFIRM');
    expect(parsed?.confidenceDelta).toBe(6);
  });

  it('4) enforces Wallet-Based Leverage: < ₹10,000 → 10x Leverage, ≥ ₹10,000 → 5x Leverage across engines', () => {
    expect(WALLET_LEVERAGE_THRESHOLD_INR).toBe(10000);
    // Below ₹10,000 → 10x
    expect(walletLeverageForEquityINR(5000)).toBe(10);
    expect(walletLeverageForEquityINR(9999)).toBe(10);
    expect(computeMtfWalletLeverage(7500)).toBe(10);
    expect(proTraderWalletLeverage(8000)).toBe(10);
    expect(resolveAgentLeverage({ equityINR: 8500, mode: 'live', cfg: { mode: 'live', walletTierLeverage: true, maxLeverage: 3 } })).toBe(10);

    // ₹10,000 and above → 5x
    expect(walletLeverageForEquityINR(10000)).toBe(5);
    expect(walletLeverageForEquityINR(25000)).toBe(5);
    expect(computeMtfWalletLeverage(15000)).toBe(5);
    expect(proTraderWalletLeverage(50000)).toBe(5);
    expect(resolveAgentLeverage({ equityINR: 18000, mode: 'live', cfg: { mode: 'live', walletTierLeverage: true, maxLeverage: 3 } })).toBe(5);
  });

  it('5) enforces Fee-Protected T1/T2 Profit Booking & Zero-Loss Confirmed Reversal Exit', () => {
    const entry = 1000;
    const feePct = defaultRoundTripFeePct('FUTURES'); // 0.14%
    const feeFloorLong = feeBreakevenFloor({ entry, side: 'LONG', market: 'FUTURES' });
    expect(feeFloorLong).toBeCloseTo(1000 * (1 + feePct / 100), 4);

    // Case A: Reversal confirmed, but LTP (1000.5) has NOT cleared round-trip fees (1001.4) → HOLD (prevent fee loss)
    const holdEval = evaluateFeeAwareReversalExit({
      side: 'LONG',
      entry: 1000,
      ltp: 1000.5,
      stopLoss: 990,
      target1: 1015,
      target2: 1030,
      tp1Hit: false,
      bookedPnl: 0,
      qty: 10,
      market: 'FUTURES',
      reversalConfirmed: true,
    });
    expect(holdEval.shouldExit).toBe(false);
    expect(holdEval.feeCovered).toBe(false);
    expect(holdEval.stage).toBe('REVERSAL_WAIT_FEE_FLOOR');

    // Case B: Reversal confirmed AND LTP (1004) clears round-trip fees → EXIT with ZERO LOSS
    const exitEval = evaluateFeeAwareReversalExit({
      side: 'LONG',
      entry: 1000,
      ltp: 1004,
      stopLoss: 990,
      target1: 1015,
      target2: 1030,
      tp1Hit: false,
      bookedPnl: 0,
      qty: 10,
      market: 'FUTURES',
      reversalConfirmed: true,
    });
    expect(exitEval.shouldExit).toBe(true);
    expect(exitEval.feeCovered).toBe(true);
    expect(exitEval.netTotalPnl).toBeGreaterThan(0);
    expect(exitEval.stage).toBe('REVERSAL_FEE_SAFE_EXIT');

    // Case C: T1 already booked profit (+75), reversal confirmed while above fee-locked SL (1002.0 > 1001.4) → T1_REVERSAL_PROFIT_LOCK
    const t1RevEval = evaluateFeeAwareReversalExit({
      side: 'LONG',
      entry: 1000,
      ltp: 1002.0,
      stopLoss: 1001.4,
      target1: 1015,
      target2: 1030,
      tp1Hit: true,
      bookedPnl: 75,
      qty: 5,
      market: 'FUTURES',
      reversalConfirmed: true,
    });
    expect(t1RevEval.shouldExit).toBe(true);
    expect(t1RevEval.feeCovered).toBe(true);
    expect(t1RevEval.stage).toBe('T1_BOOKED_REVERSAL_EXIT');

    // ProTrader reversal check also respects fee floor
    const ptHold = proTraderReversalCheck({
      trade: { symbol: 'BTC', side: 'LONG', entryPrice: 1000, qty: 2, market: 'FUTURES', tp1Hit: false },
      ltp: 1000.4,
      deepSide: 'SHORT',
      deepConf: 82,
    });
    expect(ptHold.hit).toBe(true);
    expect(ptHold.feeCovered).toBe(false);
    expect(ptHold.feeBePrice).toBeGreaterThan(1000.4);
  });

  it('6) auto-places LIVE order for ELITE/STRONG trades with 10x (<₹10k) / 5x (≥₹10k) leverage when Live Mode is active', async () => {
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', minScore: 75, walletAmountINR: 8000 });

    const liveOrders: Array<Record<string, unknown>> = [];
    const openPaperCalls: Array<Record<string, unknown>> = [];

    const boards = {
      CRYPTO: {
        ok: true,
        market: 'CRYPTO',
        mode: 'INTRADAY',
        holdMin: 45,
        minScore: 75,
        rows: [
          {
            ok: true,
            symbol: 'SOLUSDT',
            market: 'CRYPTO',
            mode: 'INTRADAY',
            label: '15m + 5m',
            holdMin: 45,
            side: 'LONG',
            dir: 1,
            superScore: 88,
            tier: 'ELITE',
            autoEligible: true,
            autoBlockers: [],
            tfFit: 'GOOD',
            dualAligned: true,
            triggerFired: true,
            counterTrend: false,
            grade: 'A',
            costR: 0.12,
            plan: { entry: 150, stopLoss: 147, t1: 154.5, t2: 159 },
          },
        ],
      },
    };

    const tick = await mtfAutoTick({
      boards,
      walletEquityINR: 8000, // < ₹10,000 → 10x leverage
      siteLiveActive: true,
      fx: 85,
      paper: {
        getPaperSummary: () => ({ open: [] }),
        openPaperTrade: (args: Record<string, unknown>) => {
          openPaperCalls.push(args);
          return { ok: true, trade: { id: 101, ...args } };
        },
        closePaperTrade: () => ({ ok: true }),
      },
      liveExecute: async (order: Record<string, unknown>) => {
        liveOrders.push(order);
        return { ok: true, orderId: 'LIVE-SOL-101' };
      },
    });

    expect(tick.opened.length).toBe(1);
    expect(openPaperCalls[0].leverage).toBe(10);
    expect(liveOrders.length).toBe(1);
    expect(liveOrders[0].symbol).toBe('SOL');
    expect(liveOrders[0].leverage).toBe(10);
  });
  it('7) mtfAutoTick holds on confirmed reversal if below fee floor, and exits with zero loss once above fee floor', async () => {
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'paper', minScore: 75, feeAwareReversalExit: true });

    let openPaperTrades = [
      { id: 501, symbol: 'BTC', direction: 'LONG', entry: 1000, stopLoss: 990, target1: 1020, target2: 1040, qty: 2, t1Hit: false, realizedPnl: 0 },
    ];
    const closedPaperIds: number[] = [];

    const paperMock = {
      getPaperSummary: () => ({ open: openPaperTrades }),
      openPaperTrade: (args: Record<string, unknown>) => ({ ok: true, trade: { id: 501, ...args } }),
      closePaperTrade: (id: number) => {
        closedPaperIds.push(id);
        openPaperTrades = openPaperTrades.filter(t => t.id !== id);
        return { ok: true, trade: { id, realizedPnl: 8.5 } };
      },
    };

    // First tick: open the LONG BTC trade at 1000
    await mtfAutoTick({
      boards: {
        CRYPTO: {
          ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
          rows: [{
            ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m + 5m', holdMin: 45,
            side: 'LONG', dir: 1, superScore: 86, tier: 'ELITE', autoEligible: true, autoBlockers: [],
            tfFit: 'GOOD', dualAligned: true, triggerFired: true, counterTrend: false, grade: 'A', costR: 0.1,
            plan: { entry: 1000, stopLoss: 990, t1: 1020, t2: 1040 },
          }],
        },
      },
      fx: 85,
      paper: { ...paperMock, getPaperSummary: () => ({ open: [] }) },
    });

    // Second tick: Board flips SHORT (confirmed reversal), but LTP = 1000.4 (below 1001.4 fee floor) → MUST HOLD
    const holdTick = await mtfAutoTick({
      boards: {
        CRYPTO: {
          ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
          rows: [{
            ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m + 5m', holdMin: 45,
            side: 'SHORT', dir: -1, superScore: 84, tier: 'STRONG', autoEligible: false, autoBlockers: ['wait'],
            triggerFired: true, ltp: 1000.4,
          }],
        },
      },
      usdtQuotes: { BTC: 1000.4 },
      fx: 85,
      paper: paperMock,
    });
    expect(holdTick.closed.length).toBe(0);
    expect(closedPaperIds.length).toBe(0);

    // Third tick: Board still SHORT (confirmed reversal), LTP = 1005.0 (above 1001.4 fee floor) → MUST EXIT ZERO LOSS
    const exitTick = await mtfAutoTick({
      boards: {
        CRYPTO: {
          ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
          rows: [{
            ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m + 5m', holdMin: 45,
            side: 'SHORT', dir: -1, superScore: 84, tier: 'STRONG', autoEligible: false, autoBlockers: ['wait'],
            triggerFired: true, ltp: 1005.0,
          }],
        },
      },
      usdtQuotes: { BTC: 1005.0 },
      fx: 85,
      paper: paperMock,
    });
    expect(exitTick.closed.length).toBe(1);
    expect(exitTick.closed[0].reason).toBe('REVERSAL_FEE_SAFE_EXIT');
    expect(closedPaperIds).toEqual([501]);
  });

  it('8) v21.19.0: completely removes legacy Superintelligence Signal Board UI from CoinDcxTab & IndiaIntradayTab', () => {
    const cxSrc = fs.readFileSync(path.resolve('src/components/tabs/CoinDcxTab.tsx'), 'utf8');
    const inSrc = fs.readFileSync(path.resolve('src/components/tabs/IndiaIntradayTab.tsx'), 'utf8');
    expect(cxSrc).not.toContain('title="Superintelligence Signal Board"');
    expect(inSrc).not.toContain('title="Superintelligence Signal Board"');
    expect(cxSrc).toContain('title="MTF Dual-Timeframe Signal Board"');
    expect(inSrc).toContain('title="MTF Dual-Timeframe Signal Board"');
  });

  it('9) v21.19.0: fixes LONG/SHORT signal inversion on intraday reversals and enforces SL-vs-LTP geometry', () => {
    // Build a 120-bar rally followed by a sharp 6-bar breakdown (WLD/ZRO class: EMA20 > EMA50 still up, but price broke EMA9 & EMA20 down)
    const dumpCandles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    let p = 100;
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 114; i++) {
      const o = p;
      const c = p * 1.0015;
      dumpCandles.push({ time: t0 + i * 900_000, open: o, high: c * 1.001, low: o * 0.999, close: c, volume: 1000 });
      p = c;
    }
    // Sharp 6-bar reversal dump (-3.8% across 6 bars)
    for (let i = 114; i < 120; i++) {
      const o = p;
      const c = p * 0.9935;
      dumpCandles.push({ time: t0 + i * 900_000, open: o, high: o * 1.0005, low: c * 0.999, close: c, volume: 2400 });
      p = c;
    }

    const ctx = readContext(dumpCandles);
    expect(ctx).not.toBeNull();
    expect(ctx!.dir).toBe(-1); // Must detect active SHORT breakdown, NOT lagging LONG!
    expect(ctx!.trend).toBe('DOWN');

    const trig = readTrigger(dumpCandles, 'SHORT');
    expect(trig).not.toBeNull();
    expect(trig!.dir).toBe(-1);
    expect(trig!.broke).toBe(true);

    const plan = buildPlanFromCandles({
      symbol: 'WLDUSDT',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      ctxCandles: dumpCandles,
      trigCandles: dumpCandles,
    });
    expect(plan.ok).toBe(true);
    expect(plan.side).toBe('SHORT');
    expect(plan.plan.stopLoss).toBeGreaterThan(plan.ltp);
    expect(plan.plan.t1).toBeLessThan(plan.plan.entry);

    // Verify fuseDualTf extendedBias symmetry on SHORT + BEARISH 1d+4h
    const fusedShort = fuseDualTf({
      symbol: 'WLDUSDT',
      market: 'CRYPTO',
      plan,
      snap: { ok: true, htfBias: 'BEARISH', consensus: 'BEARISH', agreementPct: 85 },
      modeId: 'INTRADAY',
    });
    const extComp = fusedShort.components.find((c: { k: string; v: number }) => c.k === 'extendedBias');
    expect(extComp?.v).toBe(78); // Aligned BEARISH on SHORT must score 78, not 22!
  });

  it('10) v21.19.0: fetchFuturesCandles uses UPPERCASE pair and tapeVote detects broken EMA10>20 stack', () => {
    const futSrc = fs.readFileSync(path.resolve('server/ai/futures.js'), 'utf8');
    expect(futSrc).toContain('encodeURIComponent(String(pair).toUpperCase())');
    expect(futSrc).not.toContain('encodeURIComponent(String(pair).toLowerCase())');

    // When EMA10 (105) > EMA20 (104), but live price (102) has crashed below both EMA10 & EMA20
    const brokenBullTape = {
      ltp: 102,
      ema10: 105,
      ema20: 104,
      ema50: 103,
      rsi: 42,
      macdHist: -0.4,
      macdSlope: -0.15,
      vwap: 104.5,
      last3Pct: -1.1,
    };
    const tv = tapeVote(brokenBullTape, '15m');
    expect(tv.dir).toBe(-1);
    expect(tv.reasons.join(' ')).toContain('stack broken');
  });

  it('11) v21.20.0: enforces TOP_DEEP_TREND_LIMIT = 6 on MTF Dual-Timeframe Signal Board', () => {
    expect(TOP_DEEP_TREND_LIMIT).toBe(6);
    const boardSrc = fs.readFileSync(path.resolve('server/ai/mtfDualBoard.js'), 'utf8');
    expect(boardSrc).toContain('export const TOP_DEEP_TREND_LIMIT = 6;');
    expect(boardSrc).toContain('Math.min(TOP_DEEP_TREND_LIMIT');
    const panelSrc = fs.readFileSync(path.resolve('src/components/aitrading/MTFDualBoardPanel.tsx'), 'utf8');
    expect(panelSrc).toContain('TOP 6 DEEP-TREND');
    expect(panelSrc).toContain('limit: 6');
  });

  it('12) v21.20.0: rewards Ultra-Fast Early Trend Ignition and blocks Late/Exhausted Reversal Wicks', () => {
    const basePlan = {
      ok: true,
      symbol: 'SOLUSDT',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      side: 'LONG',
      dir: 1,
      grade: 'A',
      confidence: 84,
      alignedWithContext: true,
      counterTrend: false,
      triggerFired: true,
      context: { dir: 1, score: 84, trend: 'UP', structure: 'HH-HL', adx: 26, rsi: 59, earlyIgnition: true, exhausted: false },
      trigger: { dir: 1, score: 82, broke: true, volRatio: 1.7, bodyPct: 68, rsi: 58, earlyIgnition: true, reversalRisk: false, opposingFlow: false, overextended: false },
      plan: { entry: 150, stopLoss: 148.5, t1: 151.5, t2: 153, stopPct: 1.0, netRR: { t1: 0.85, t2: 1.75 } },
      tfFit: { verdict: 'GOOD', ratioT1: 1.5, note: 'good' },
      costs: { costR: 0.12, roundTripPct: 0.1 },
      // v21.23.2: production planner measured worldIndicators ke saath aata
      // hai — fixture me bhi (guessed-count fabrication era khatam).
      worldIndicators: {
        alignedCount: 7, totalCount: 8, aligned8Count: 7, total8Count: 8,
        confluencePct: 88, estimatedWinRatePct: 68, directionVerified: true,
        trapVeto: false, zoneWallVeto: false,
      },
    };

    const earlyFused = fuseDualTf({ symbol: 'SOLUSDT', market: 'CRYPTO', plan: basePlan, modeId: 'INTRADAY' });
    expect(earlyFused.earlyIgnition).toBe(true);
    expect(earlyFused.reversalRisk).toBe(false);
    expect(earlyFused.superScore).toBeGreaterThanOrEqual(85);
    expect(earlyFused.tier).toBe('ELITE');
    expect(earlyFused.autoEligible).toBe(true);
    expect(earlyFused.drivers.some((d: string) => d.includes('early trend ignition'))).toBe(true);

    // Late/reversing bar with rejection wick on action TF → must be capped <= 58 (WATCH) and blocked from auto/top
    const reversingPlan = {
      ...basePlan,
      triggerFired: false,
      context: { ...basePlan.context, earlyIgnition: false, exhausted: true, rsi: 76 },
      trigger: { ...basePlan.trigger, earlyIgnition: false, reversalRisk: true, wickRejection: true, broke: false },
    };
    const revFused = fuseDualTf({ symbol: 'SOLUSDT', market: 'CRYPTO', plan: reversingPlan, modeId: 'INTRADAY' });
    expect(revFused.reversalRisk).toBe(true);
    expect(revFused.superScore).toBeLessThanOrEqual(58);
    expect(revFused.autoEligible).toBe(false);
    expect(revFused.autoBlockers.some((b: string) => b.includes('reversal') || b.includes('exhausted'))).toBe(true);
  });

  it('13) v21.20.0: loads CoinDCX .env credentials directly in loadCredsForOrder and wires /api/ai/mtf-dual/live', () => {
    const prevKey = process.env.COINDCX_API_KEY;
    const prevSec = process.env.COINDCX_SECRET;
    try {
      __resetCoinDcxForTests();
      process.env.COINDCX_API_KEY = 'env-live-key-v2120';
      process.env.COINDCX_SECRET = 'env-live-secret-v2120';
      const creds = loadCredsForOrder();
      expect(creds).not.toBeNull();
      expect(creds?.apiKey).toBe('env-live-key-v2120');
      expect(creds?.secret).toBe('env-live-secret-v2120');
      expect(creds?.source).toBe('env');
    } finally {
      if (prevKey === undefined) delete process.env.COINDCX_API_KEY;
      else process.env.COINDCX_API_KEY = prevKey;
      if (prevSec === undefined) delete process.env.COINDCX_SECRET;
      else process.env.COINDCX_SECRET = prevSec;
      __resetCoinDcxForTests();
    }

    const routesSrc = fs.readFileSync(path.resolve('server/ai/routes.js'), 'utf8');
    expect(routesSrc).toContain("app.post('/api/ai/mtf-dual/live'");
    expect(routesSrc).toContain('executeMtfDualLiveOrder');
    const panelSrc = fs.readFileSync(path.resolve('src/components/aitrading/MTFDualBoardPanel.tsx'), 'utf8');
    expect(panelSrc).toContain('openMtfBoardLive');
    expect(panelSrc).toContain('onAutoLiveExecute');
  });
});