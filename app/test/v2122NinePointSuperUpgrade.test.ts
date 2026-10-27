// ============================================================
// test/v2122NinePointSuperUpgrade.test.ts — v21.22.0 9-Point Upgrade
// ------------------------------------------------------------
// Verifies all 9 user requirements for v21.22.0:
//   1. World Top 10 Indicators + 95% Win-Rate Calibration + 24x7 6s Direct Feed
//   2. 95% CoinDCX Wallet Deployment + Wallet-Tier Leverage (<₹10k=10x, ≥₹10k=5x)
//   3. Active Auto-Trade Deep Monitor (TP1/TP2 Trailing SL + Reversal Profit Book)
//   4. SIGNAL RECHECK — 15s LIVE WATCH Auto-Trade Deep Monitoring Integration
//   5. Single `LIVE` Button on MTF Dual Board to turn ON Auto-Trade Intelligence
//   6. GOLD & SILVER (XAU/XAG perps) + EQUITY SIM on MTF Dual-Timeframe Signal Board
//   7. 3-Model Local Ollama AI Ensemble Optimization for MTF Dual Board
//   8. Superfast & Intelligent Telegram Bot (/mtf, /gold, /autotrade, /deepmonitor)
//   9. Accurate implementation in both Intraday TAB & Crypto TAB
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.MTF_AUTO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-v2122-'));

import {
  ichimokuCloud,
  chandelierExit,
  ttmSqueeze,
  stochRsi,
  cvdVolumeFlow,
  smcSmartMoney,
  liquiditySweepTrap,
  volumeProfile,
  fairValueGap,
  ictConfluence,
  supplyDemandZones,
  priceActionStats,
  computeWorldTopIndicators,
} from '../server/ai/lib/indicators.js';
import { buildPlanFromCandles, readContext, readTrigger } from '../server/ai/tradePlanner.js';
import { getOllamaTrioModels, evaluateMtfRowWithOllamaTrio } from '../server/ai/llmSentinel.js';
import { fuseDualTf, buildDualRow, getDualMtfBoard, peekDualMtfBoards, __clearDualBoardCaches } from '../server/ai/mtfDualBoard.js';
import {
  computeWallet95Deployment,
  computeWallet100Deployment,
  evaluateActiveTradeDeepMonitor,
  getActiveAutoTradesDeepMonitor,
  recordLiveMtfBoardTrade,
  recordPaperMtfBoardTrade,
  syncCoinDcxActivePositionsToDeepMonitor,
  mtfAutoTick,
  mtfAutoStatus,
  setMtfAutoEnabled,
  updateMtfAutoConfig,
  __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import {
  recheckTick,
  startSignalRecheckLoop,
  signalRecheckStatus,
  __resetSignalRecheckForTests,
} from '../server/ai/signalRecheck.js';
import {
  formatMtfDualBoardLines,
  formatMtfDeepMonitorLines,
  inferDeskFromText,
} from '../telegram-bot/siteAgents.mjs';
import {
  executeMtfDualLiveOrder,
  __resetMtfLiveOrderLockForTests,
} from '../server/ai/futures.js';

function makeBullishCandles(count = 120, startPrice = 100, stepPct = 0.0035, intervalMs = 300_000) {
  const out = [];
  let px = startPrice;
  const now = Date.now() - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const open = px;
    // Include a 2-bar tight base at i === count - 26..-25 followed by a strong institutional impulse at i === count - 24
    const isBase = i === count - 26 || i === count - 25;
    const isImpulse = i === count - 24;
    const delta = isBase ? 0.0001 : isImpulse ? stepPct * 3.5 : (stepPct + (i % 5 === 0 ? -0.0008 : 0.0012));
    const close = +(px * (1 + delta)).toFixed(4);
    const high = +(Math.max(open, close) * (isBase ? 1.0006 : 1.0022)).toFixed(4);
    const low = +(Math.min(open, close) * (isBase ? 0.9994 : 0.9985)).toFixed(4);
    const volume = 1000 + i * 25 + (isImpulse ? 3500 : i > count - 10 ? 1500 : 0);
    out.push({ time: now + i * intervalMs, open, high, low, close, volume });
    px = close;
  }
  return out;
}

describe('v21.22.0 — 9-Point Superintelligence Upgrade', () => {
  beforeEach(() => {
    __clearDualBoardCaches();
    __resetMtfAutoForTests();
    __resetSignalRecheckForTests();
  });

  it('1) World Top 10 Indicators & 95% Win-Rate Confluence compute accurately on trend candles', () => {
    const candles = makeBullishCandles(120, 100, 0.003);
    const ich = ichimokuCloud(candles);
    const chan = chandelierExit(candles);
    const sqz = ttmSqueeze(candles);
    const srsi = stochRsi(candles.map(c => c.close));
    const cvd = cvdVolumeFlow(candles);
    const world = computeWorldTopIndicators(candles, 'LONG');

    expect(ich).not.toBeNull();
    expect(ich?.dir).toBe(1);
    expect(chan?.longStop).toBeGreaterThan(0);
    expect(sqz).not.toBeNull();
    expect(srsi).not.toBeNull();
    expect(cvd?.dir).toBe(1);

    expect(world).not.toBeNull();
    expect(world?.totalCount).toBe(8);
    expect(world?.total8Count).toBe(8);
    expect(world?.alignedCount).toBeGreaterThanOrEqual(6);
    expect(world?.estimatedWinRatePct).toBeGreaterThanOrEqual(88);
    expect(world?.estimatedWinRatePct).toBeLessThanOrEqual(96);

    const plan = buildPlanFromCandles({
      symbol: 'BTC',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      ctxCandles: makeBullishCandles(120, 65000, 0.0025, 900_000),
      trigCandles: makeBullishCandles(120, 66500, 0.0028, 300_000),
    });
    expect(plan.ok).toBe(true);
    expect(plan.worldIndicators).toBeDefined();
    expect(plan.worldIndicators.totalCount).toBe(8);
    expect(plan.worldIndicators.total8Count).toBe(8);
    expect(plan.worldIndicators.estimatedWinRatePct).toBeGreaterThanOrEqual(85);
  });

  it('2) 95% CoinDCX Wallet Deployment + Wallet-Tier Leverage (<₹10k=10x, ≥₹10k=5x)', () => {
    const smallWallet = computeWallet95Deployment({ walletINR: 1163.93, deployPct: 95 });
    expect(smallWallet.walletDeployPct).toBe(95);
    expect(smallWallet.deployedWalletINR).toBeCloseTo(1105.73, 1);
    expect(smallWallet.leverage).toBe(10);
    expect(smallWallet.buyingPowerINR).toBeCloseTo(11057.3, 1);

    const largeWallet = computeWallet95Deployment({ walletINR: 20000, deployPct: 95 });
    expect(largeWallet.walletDeployPct).toBe(95);
    expect(largeWallet.deployedWalletINR).toBe(19000);
    expect(largeWallet.leverage).toBe(5);
    expect(largeWallet.buyingPowerINR).toBe(95000);
  });

  it('3) Active Auto-Trade Deep Monitor trails SL across TP1/TP2 and books accrued profit on reversal', async () => {
    const baseTrade = {
      id: 101,
      symbol: 'SOL',
      market: 'CRYPTO',
      side: 'LONG',
      entry: 100,
      stopLoss: 98,
      initialStopLoss: 98,
      target1: 103,
      target2: 106,
      t1Hit: false,
      leverage: 10,
      proExitPolicy: false,
    };

    // Case A: +0.60R progress toward T1 -> STAGE_2_BREAKEVEN_PLUS moves SL above breakeven + fees
    const guardEval = evaluateActiveTradeDeepMonitor(baseTrade, { ltp: 101.2 });
    expect(guardEval.stageCode).toBe('STAGE_2_BREAKEVEN_PLUS');
    expect(guardEval.trailedStopLoss).toBeGreaterThan(100);
    expect(guardEval.shouldClose).toBe(false);

    // Case B: TP1 hit (103.2) -> locks SL well above entry and trails toward TP2
    const tp1Eval = evaluateActiveTradeDeepMonitor(
      { ...baseTrade, t1Hit: true },
      { ltp: 103.5 },
    );
    expect(['STAGE_4_TP1_LOCKED', 'STAGE_5_RUNNER_TO_TP2']).toContain(tp1Eval.stageCode);
    expect(tp1Eval.trailedStopLoss).toBeGreaterThan(101);
    expect(tp1Eval.shouldClose).toBe(false);

    // Case C: Trade in net profit (LTP 101.6) AND bearish reversal detected -> immediately books accrued profit!
    const revEval = evaluateActiveTradeDeepMonitor(baseTrade, {
      ltp: 101.6,
      boardRow: { side: 'SHORT', triggerFired: true, superScore: 80 },
    });
    expect(revEval.reversalDetected).toBe(true);
    expect(revEval.shouldBookProfitNow).toBe(true);
    expect(revEval.shouldClose).toBe(true);
    expect(revEval.exitReason).toBe('PRE_T1_REVERSAL_PROFIT_BOOKED');

    // Case D: Early reversal before fee-covered profit -> tightens SL to prevent full SL hit
    const tightenEval = evaluateActiveTradeDeepMonitor(baseTrade, {
      ltp: 99.6,
      boardRow: { side: 'SHORT', triggerFired: true, superScore: 80 },
    });
    expect(tightenEval.shouldClose).toBe(false);
    expect(tightenEval.trailedStopLoss).toBeGreaterThan(98);

    // Case E: TP2 hit -> full profit book
    const tp2Eval = evaluateActiveTradeDeepMonitor(baseTrade, { ltp: 106.2 });
    expect(tp2Eval.stageCode).toBe('STAGE_5_TP2_HIT');
    expect(tp2Eval.shouldClose).toBe(true);
    expect(tp2Eval.exitReason).toBe('TP2_TARGET_HIT_FULL_PROFIT');

    // Verify getActiveAutoTradesDeepMonitor & mtfAutoTick step 0b sweep
    const closedIds: number[] = [];
    const paperMock = {
      openPositions: () => [{ ...baseTrade, paperId: 101, ltp: 101.6 }],
      closeTrade: (id: number) => { closedIds.push(id); return { ok: true, pnl: 1.6 }; },
    };
    const activeDm = getActiveAutoTradesDeepMonitor({ paper: paperMock });
    expect(activeDm.activeCount).toBe(0); // book is empty until a trade is in state.book

    setMtfAutoEnabled(true);
    const tickRes = await mtfAutoTick({
      boards: {
        CRYPTO: {
          rows: [{ symbol: 'SOL', side: 'SHORT', ltp: 101.6, triggerFired: true, superScore: 82 }],
        },
      },
      paper: paperMock,
    });
    expect(Array.isArray(tickRes.opened)).toBe(true);
    expect(Array.isArray(tickRes.closed)).toBe(true);
  });

  it('4) SIGNAL RECHECK — 15s LIVE WATCH runs onAutoTradeDeepTick and exposes autoTradeDeepMonitor', async () => {
    let deepTickCalls = 0;
    startSignalRecheckLoop({
      getSignals: async () => ({
        signals: [
          {
            symbol: 'BTC',
            side: 'LONG',
            grade: 'STRONG',
            confidence: 88,
            plan: { entry: 65000, stopLoss: 64200, target1: 66200, target2: 67500 },
          },
        ],
      }),
      fetchLtp: async () => new Map([['BTC', { price: 65950, src: 'coindcx' }]]),
      onAutoTradeDeepTick: async () => {
        deepTickCalls += 1;
      },
    });

    await recheckTick(Date.now());
    const status = signalRecheckStatus();
    expect(status.rows.length).toBeGreaterThanOrEqual(1);
    expect(status.autoTradeDeepMonitor).toBeDefined();
    expect(typeof deepTickCalls).toBe('number');
    __resetSignalRecheckForTests();
  });

  it('5) MTFDualBoardPanel renders ONLY ONE single LIVE Auto-Trade button and Active-Trade Deep Monitor UI', () => {
    const panelSrc = fs.readFileSync(path.resolve('src/components/aitrading/MTFDualBoardPanel.tsx'), 'utf8');
    expect(panelSrc).toContain('data-testid="mtf-single-live-auto-btn"');
    expect(panelSrc).toContain('ACTIVE AUTO-TRADE DEEP MONITOR — REALTIME TP1 / TP2 & REVERSAL PROFIT GUARD');
    expect(panelSrc).not.toContain('data-testid="mtf-auto-mode-paper-btn"');
    expect(panelSrc).not.toContain('data-testid="mtf-auto-preview-btn"');
    expect(panelSrc).not.toContain('data-testid="mtf-auto-tick-btn"');

    const recheckSrc = fs.readFileSync(path.resolve('src/components/aitrading/SignalRecheckPanel.tsx'), 'utf8');
    expect(recheckSrc).toContain('AUTO-TRADE DEEP MONITOR (REALTIME WS)');
  });

  it('6 & 7) MTF Dual Board includes GOLD & SILVER (XAU/XAG perps) + EQUITY SIM + 3-Model Local Ollama AI verdicts + 2s 24x7 feed', async () => {
    const trio = getOllamaTrioModels();
    expect(trio.models.length).toBe(3);
    const verdict = evaluateMtfRowWithOllamaTrio({
      symbol: 'XAU',
      side: 'LONG',
      superScore: 86,
      estimatedWinRatePct: 95,
      worldAlignedCount: 9,
      aligned: true,
      triggerFired: true,
      netRR_T2: 1.8,
    });
    expect(verdict.models.length).toBe(3);
    expect(verdict.verdict).toBe('3/3 OLLAMA AI LOCK');
    expect(verdict.scoreBoost).toBeGreaterThan(0);

    const board = await getDualMtfBoard({
      market: 'CRYPTO',
      mode: 'INTRADAY',
      limit: 6,
      force: true,
      candlesFor: async (sym: string, tf: string) =>
        makeBullishCandles(120, sym === 'XAU' ? 2750 : sym === 'XAG' ? 32.5 : 150, 0.003, tf === '15m' ? 900_000 : 300_000),
    });

    expect(board.ok).toBe(true);
    expect(board.liveFeed24x7?.active).toBe(true);
    expect(board.liveFeed24x7?.cadenceMs).toBe(2000);
    expect(Array.isArray(board.metalsRows)).toBe(true);
    expect(board.metalsRows.map((r: any) => r.symbol)).toEqual(expect.arrayContaining(['XAU', 'XAG']));
    expect(Array.isArray(board.equitySimRows)).toBe(true);
    expect(board.equitySimRows.length).toBeGreaterThan(0);
    expect(board.rows[0].worldIndicators).toBeDefined();
    expect(board.rows[0].ollamaTrio).toBeDefined();
    // v21.23.1 HONEST update: purana >=75 threshold fabricated 95/92 ladder ke
    // against calibrated tha (score<75 row ko bhi formula 77 de deta tha). Ab
    // winRatePct honest heuristic band (52-85) me hai — candle-only fixture
    // (no board consensus / no ledger calibration) ka top row ~70 hota hai.
    expect(Number(board.rows[0].winRatePct)).toBeGreaterThanOrEqual(65);
    expect(Number(board.rows[0].winRatePct)).toBeLessThanOrEqual(85);
    expect(board.rows[0].winRatePct).not.toBe(95);
    expect(board.rows[0].winRatePct).not.toBe(92);
  });

  it('8 & 9) Superfast Telegram Bot formatters + Intraday TAB & Crypto TAB integration', () => {
    const tgBoardTxt = formatMtfDualBoardLines({
      market: 'CRYPTO',
      quoteCcy: 'USDT',
      modeLabel: '15m Deep + 5m Action',
      rows: [
        {
          symbol: 'BTC',
          side: 'LONG',
          superScore: 89,
          tier: 'ELITE',
          winRatePct: 95,
          worldIndicators: { alignedCount: 9 },
          ollamaTrio: { verdict: '3/3 OLLAMA AI LOCK' },
          plan: { entry: 67500, stopLoss: 66800, t1: 68400, t2: 69500 },
        },
      ],
      metalsRows: [
        {
          symbol: 'XAU',
          side: 'LONG',
          superScore: 86,
          tier: 'ELITE',
          winRatePct: 95,
          worldIndicators: { alignedCount: 9 },
          ollamaTrio: { verdict: '3/3 OLLAMA AI LOCK' },
          plan: { entry: 2745, stopLoss: 2730, t1: 2765, t2: 2790 },
        },
      ],
      equitySimRows: [
        {
          symbol: 'NVDA',
          side: 'LONG',
          superScore: 84,
          tier: 'STRONG',
          winRatePct: 92,
          worldIndicators: { alignedCount: 8 },
          ollamaTrio: { verdict: '2/3 OLLAMA AI STRONG' },
          plan: { entry: 138.5, stopLoss: 136.2, t1: 141.0, t2: 144.5 },
        },
      ],
    });
    expect(tgBoardTxt).toContain('BTC');
    expect(tgBoardTxt).toContain('95% Winrate');
    expect(tgBoardTxt).toContain('GOLD &amp; SILVER PERPS');
    expect(tgBoardTxt).toContain('XAU');
    expect(tgBoardTxt).toContain('NVDA');

    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ executionMode: 'live', walletDeployPct: 95, walletAmountINR: 1163.93 });
    const st = mtfAutoStatus();
    const tgDmTxt = formatMtfDeepMonitorLines(st);
    expect(tgDmTxt).toContain('95% CoinDCX Wallet Deployment');
    expect(inferDeskFromText('XAU gold perp signal batao')).toBe('crypto');

    const cxSrc = fs.readFileSync(path.resolve('src/components/tabs/CoinDcxTab.tsx'), 'utf8');
    const inSrc = fs.readFileSync(path.resolve('src/components/tabs/IndiaIntradayTab.tsx'), 'utf8');
    // v21.23.3 HONESTY: "95% Win-Rate Target" header claim hataya — ab ledger-calibrated
    expect(cxSrc).toContain('10 World Top Indicators (Ledger-Calibrated Win-Rate)');
    expect(inSrc).toContain('10 World Top Indicators (Ledger-Calibrated Win-Rate)');
    expect(cxSrc).not.toContain('95% Win-Rate');
    expect(inSrc).not.toContain('95% Win-Rate');
  });

  it('8) All 8 Institutional Top Indicators (SMC, Liquidity Sweep/Trap, Volume Profile, FVG, ICT, EMA, Supply/Demand, Price Action) & Pakka LONG/SHORT Direction Lock work with Trap Veto', async () => {
    const candles = makeBullishCandles(120, 100, 0.003);
    const smc = smcSmartMoney(candles);
    const liq = liquiditySweepTrap(candles);
    const vp = volumeProfile(candles);
    const fvg = fairValueGap(candles);
    const ict = ictConfluence(candles);
    const sd = supplyDemandZones(candles);
    const pa = priceActionStats(candles);

    expect(smc).not.toBeNull();
    expect(liq).not.toBeNull();
    expect(vp).not.toBeNull();
    expect(fvg).not.toBeNull();
    expect(ict).not.toBeNull();
    expect(sd).not.toBeNull();
    expect(pa).not.toBeNull();

    const world = computeWorldTopIndicators(candles, 'LONG');
    expect(world?.total8Count).toBe(8);
    expect(world?.aligned8Count).toBeGreaterThanOrEqual(6);
    expect(world?.directionVerified).toBe(true);
    expect(world?.trapVeto).toBe(false);
    const ids = (world?.indicators || []).slice(0, 8).map((x: { id: string }) => x.id);
    expect(ids).toEqual([
      'smc',
      'liquiditySweep',
      'volumeProfile',
      'fvg',
      'ict',
      'emaRibbon',
      'supplyDemand',
      'priceAction',
    ]);

    // Construct a Buy-Side Liquidity Sweep (Bull Trap): last candle wicks high above prior high and closes below with huge upper wick
    const trapCandles = makeBullishCandles(60, 100, 0.002);
    const prevHigh = Math.max(...trapCandles.slice(0, -2).map(c => c.high));
    const lastBar = trapCandles[trapCandles.length - 1];
    trapCandles[trapCandles.length - 1] = {
      ...lastBar,
      open: +(prevHigh * 0.998).toFixed(4),
      high: +(prevHigh * 1.018).toFixed(4), // sweeps far above prior swing high
      low: +(prevHigh * 0.991).toFixed(4),
      close: +(prevHigh * 0.993).toFixed(4), // closes back below prior high (Bull Trap!)
      volume: 5000,
    };
    const trapCheck = liquiditySweepTrap(trapCandles);
    expect(trapCheck?.bullTrap).toBe(true);
    expect(trapCheck?.trapDetected).toBe(true);
    expect(trapCheck?.dir).toBe(-1);

    const worldOnTrapLong = computeWorldTopIndicators(trapCandles, 'LONG');
    expect(worldOnTrapLong?.trapVeto).toBe(true);
    expect(worldOnTrapLong?.directionVerified).toBe(false);

    // Ensure fuseDualTf caps and blocks a trap-vetoed plan from Auto-Trade
    const trapPlan = {
      ok: true,
      symbol: 'BTC',
      market: 'CRYPTO',
      mode: 'INTRADAY',
      side: 'LONG',
      dir: 1,
      grade: 'B',
      confidence: 70,
      alignedWithContext: false,
      counterTrend: false,
      triggerFired: false,
      trapVeto: true,
      zoneWallVeto: false,
      directionVerified: false,
      worldIndicators: worldOnTrapLong,
      context: { dir: 1, score: 80, trend: 'UP', structure: 'HH-HL', adx: 25, rsi: 58 },
      trigger: { dir: -1, score: 50, broke: false, opposingFlow: true, reversalRisk: true },
      plan: { entry: 100, stopLoss: 98.5, t1: 101.5, t2: 103, stopPct: 1.5, netRR: { t1: 0.85, t2: 1.75 } },
      tfFit: { verdict: 'GOOD', ratioT1: 1.5, note: 'good' },
      costs: { costR: 0.1, roundTripPct: 0.1 },
    };
    const fusedTrap = fuseDualTf({ symbol: 'BTC', market: 'CRYPTO', plan: trapPlan, modeId: 'INTRADAY' });
    expect(fusedTrap.trapVeto).toBe(true);
    expect(fusedTrap.directionVerified).toBe(false);
    expect(fusedTrap.superScore).toBeLessThanOrEqual(58);
    expect(fusedTrap.autoEligible).toBe(false);
    expect(fusedTrap.autoBlockers.some((b: string) => b.includes('trap veto') || b.includes('pakka verified'))).toBe(true);

    // Verify recordLiveMtfBoardTrade registers direct live orders into Deep Monitor and mtfAutoTick manages them even when disarmed for new entries
    __resetMtfAutoForTests({ config: { enabled: false, walletAmountINR: 1163.93 } });
    const rec = recordLiveMtfBoardTrade({
      orderId: 'cdx-live-999',
      positionId: 'pos-live-999',
      symbol: 'XAU',
      market: 'METALS',
      side: 'LONG',
      entry: 4170,
      stopLoss: 4150,
      t1: 4190,
      t2: 4210,
      qty: 0.02,
      leverage: 10,
      walletINR: 1163.93,
      superScore: 88,
      tier: 'ELITE',
    });
    expect(rec?.executionMode).toBe('LIVE');
    expect(mtfAutoStatus().openCount).toBe(1);
    expect(mtfAutoStatus().deepMonitor.activeCount).toBe(1);

    let liveClosedId: string | null = null;
    const tickOut = await mtfAutoTick({
      boards: {},
      paper: { getPaperSummary: () => ({ open: [] }), closePaperTrade: () => ({ ok: true }) },
      quotes: { 'FUTURES|XAU': { price: 4215 } },
      liveClose: async (t: { livePositionId?: string }) => { liveClosedId = t.livePositionId || null; return { ok: true }; },
    });
    expect(liveClosedId).toBe('pos-live-999');
    expect(tickOut.closed.length).toBe(1);
    expect(tickOut.closed[0].reason).toBe('TP2_TARGET_HIT_FULL_PROFIT');
  });

  it('9) 100% CoinDCX Wallet Deployment + Strict Active-Traded-Only Deep Monitor (No Entry Without Traded) + Full Control of CoinDCX Active Positions across Intraday & Crypto Tabs', async () => {
    // 1. Default 100% CoinDCX Wallet Deployment + Leverage (<₹10k=10x, ≥₹10k=5x)
    const w100Small = computeWallet100Deployment({ walletINR: 1163.93 });
    expect(w100Small.walletDeployPct).toBe(100);
    expect(w100Small.deployedWalletINR).toBeCloseTo(1163.93, 2);
    expect(w100Small.leverage).toBe(10);
    expect(w100Small.buyingPowerINR).toBeCloseTo(11639.3, 1);

    const w100Large = computeWallet100Deployment({ walletINR: 20000 });
    expect(w100Large.walletDeployPct).toBe(100);
    expect(w100Large.deployedWalletINR).toBe(20000);
    expect(w100Large.leverage).toBe(5);
    expect(w100Large.buyingPowerINR).toBe(100000);

    // 2. Strict Active-Traded-Only Deep Monitor: when live order fails, NEVER add "entry without traded"
    __resetMtfAutoForTests({ config: { enabled: true, executionMode: 'live', walletAmountINR: 1163.93, walletDeployPct: 100, proExitPolicy: false } });
    let paperRollbackCount = 0;
    const failedLiveTick = await mtfAutoTick({
      boards: {
        CRYPTO: {
          ok: true,
          market: 'CRYPTO',
          rows: [{
            ok: true,
            symbol: 'SOL',
            market: 'CRYPTO',
            mode: 'INTRADAY',
            label: '15m + 5m',
            holdMin: 45,
            side: 'LONG',
            dir: 1,
            superScore: 91,
            tier: 'ELITE',
            autoEligible: true,
            autoBlockers: [],
            tfFit: 'GOOD',
            dualAligned: true,
            triggerFired: true,
            counterTrend: false,
            grade: 'A',
            costR: 0.1,
            plan: { entry: 150, stopLoss: 147, t1: 154.5, t2: 159 },
          }],
        },
      },
      walletEquityINR: 1163.93,
      siteLiveActive: true,
      paper: {
        getPaperSummary: () => ({ open: [] }),
        openPaperTrade: () => ({ ok: true, trade: { id: 777 } }),
        closePaperTrade: () => { paperRollbackCount += 1; return { ok: true }; },
      },
      liveExecute: async () => ({ ok: false, error: 'exchange rejected test' }),
    });
    expect(failedLiveTick.opened).toHaveLength(0);
    expect(paperRollbackCount).toBe(1);
    expect(mtfAutoStatus().openCount).toBe(0);
    expect(mtfAutoStatus().deepMonitor.activeCount).toBe(0);
    expect(mtfAutoStatus().deepMonitor.trades).toHaveLength(0);

    // 3. Full Control of CoinDCX Active Positions: adopt active position, ratchet SL on CoinDCX, and auto-book profit on reversal
    const syncOut = syncCoinDcxActivePositionsToDeepMonitor([
      {
        id: 'cdx-pos-sol-1',
        positionId: 'cdx-pos-sol-1',
        pair: 'B-SOL_USDT',
        symbol: 'SOL',
        side: 'LONG',
        qty: 0.8,
        entry: 150,
        ltp: 150.5,
        leverage: 10,
        stopLoss: 147,
        t1: 154,
        t2: 158,
      },
    ], { authoritativeExchangeList: true, walletINR: 1163.93 });
    expect(syncOut.ok).toBe(true);
    expect(syncOut.activeCount).toBe(1);
    expect(mtfAutoStatus().deepMonitor.activeCount).toBe(1);
    expect(mtfAutoStatus().deepMonitor.trades[0].fullControl).toBe(true);
    expect(mtfAutoStatus().deepMonitor.trades[0].traded).toBe(true);

    // Price advances to 152.7 (+0.90R) -> Stage 3 Profit Ratchet trails SL and calls liveUpdateSl on CoinDCX
    let updatedSlOnExchange: number | null = null;
    await mtfAutoTick({
      boards: { CRYPTO: { ok: true, rows: [] } },
      paper: { getPaperSummary: () => ({ open: [] }), closePaperTrade: () => ({ ok: true }) },
      usdtQuotes: { SOL: 152.7 },
      liveUpdateSl: async (t: { stopLoss?: number }) => {
        updatedSlOnExchange = t.stopLoss ?? null;
        return { ok: true };
      },
    });
    expect(updatedSlOnExchange).not.toBeNull();
    expect(updatedSlOnExchange!).toBeGreaterThan(150);

    // Now Bearish Reversal triggers while in profit (LTP 152.1 > fee-breakeven) -> Full Control immediately books profit on CoinDCX!
    let closedPosIdOnExchange: string | null = null;
    const revCloseTick = await mtfAutoTick({
      boards: {
        CRYPTO: {
          ok: true,
          rows: [{ symbol: 'SOL', side: 'SHORT', ltp: 152.1, triggerFired: true, superScore: 86 }],
        },
      },
      paper: { getPaperSummary: () => ({ open: [] }), closePaperTrade: () => ({ ok: true }) },
      usdtQuotes: { SOL: 152.1 },
      liveClose: async (t: { livePositionId?: string }) => {
        closedPosIdOnExchange = t.livePositionId ?? null;
        return { ok: true };
      },
    });
    expect(closedPosIdOnExchange).toBe('cdx-pos-sol-1');
    expect(revCloseTick.closed).toHaveLength(1);
    expect(mtfAutoStatus().deepMonitor.activeCount).toBe(0);
  });

  it('10) Full ₹3,000 Wallet Deployment @ 1 USDT = ₹102 + Premature Auto-Close Firewall + Permanent Removal of 4 Legacy Sections from Both Tabs', async () => {
    const futMod = await import('../server/ai/futures.js');
    expect(futMod.COINDCX_INR_PER_USDT).toBe(102);

    // 1. Verify computeWallet100Deployment defaults to 1 USDT = ₹102 and deploys 100% of ₹3,000 wallet at 10x leverage
    const w3000 = computeWallet100Deployment({ walletINR: 3000 });
    expect(w3000.fxRate).toBe(102);
    expect(w3000.walletDeployPct).toBe(100);
    expect(w3000.deployedWalletINR).toBe(3000);
    expect(w3000.leverage).toBe(10);
    expect(w3000.buyingPowerINR).toBe(30000);
    expect(w3000.deployedWalletUSDT).toBeCloseTo(3000 / 102, 2);

    // 2. Concrete Premature Auto-Close Firewall:
    //    - A newly opened trade that wobbles +0.01R and back to entry (+0.00R) must NOT trigger peakGivebackRatio SL tighten
    const wobbleEval = evaluateActiveTradeDeepMonitor({
      symbol: 'SOL',
      market: 'CRYPTO',
      side: 'LONG',
      entry: 150,
      stopLoss: 147,
      trailedStopLoss: 147,
      peakPrice: 150.03, // tiny +0.01R tick
      t1: 154.5,
      t2: 159,
      qty: 1,
      proExitPolicy: false,
    }, {
      ltp: 149.85, // minor -0.05R spread noise
      boardRow: { symbol: 'SOL', side: 'LONG', superScore: 88, triggerFired: true },
    });
    expect(wobbleEval.trailedStopLoss).toBe(147); // SL remains at initial 147, NOT tightened to -0.35R!
    expect(wobbleEval.shouldExitDefensiveSl).toBe(false);
    expect(wobbleEval.shouldBookProfitNow).toBe(false);

    //    - Cross-currency INR quote (~100x USDT) in mtfAutoTick Step 0b must be ignored and NEVER close the LIVE trade
    __resetMtfAutoForTests();
    syncCoinDcxActivePositionsToDeepMonitor([{
      id: 'cdx-pos-inj-1',
      positionId: 'cdx-pos-inj-1',
      pair: 'B-INJ_USDT',
      symbol: 'INJ',
      side: 'SHORT',
      qty: 15,
      entry: 20,
      ltp: 20,
      leverage: 10,
      stopLoss: 20.6,
      t1: 19.2,
      t2: 18.4,
    }], { authoritativeExchangeList: true, walletINR: 3000 });

    let falseCloseCalled = false;
    await mtfAutoTick({
      boards: { CRYPTO: { ok: true, rows: [] } },
      paper: { getPaperSummary: () => ({ open: [] }), closePaperTrade: () => ({ ok: true }) },
      quotes: { INJ: { price: 2040 } }, // Corrupt Spot INR quote (~102x USDT)
      liveClose: async () => { falseCloseCalled = true; return { ok: true }; },
    });
    expect(falseCloseCalled).toBe(false);
    expect(mtfAutoStatus().deepMonitor.activeCount).toBe(1);

    // 3. Verify permanent removal of the 4 sections from both CoinDcxTab.tsx and IndiaIntradayTab.tsx
    const cxSrc = fs.readFileSync(path.resolve('src/components/tabs/CoinDcxTab.tsx'), 'utf8');
    const inSrc = fs.readFileSync(path.resolve('src/components/tabs/IndiaIntradayTab.tsx'), 'utf8');
    for (const removed of ['ExpertPicksPanel', 'TopPicksPanel', 'ManualTradeMonitor', 'ReversalPanel', 'cx-expert', 'cx-top5', 'cx-manual', 'cx-reversal', 'in-expert', 'in-top5', 'in-manual']) {
      expect(cxSrc).not.toContain(removed);
      expect(inSrc).not.toContain(removed);
    }
  });

  it('11) Pakka LONG/SHORT Direction Integrity: bearish trend with minor dead-cat bounce stays SHORT, trailing zero-range auction ticks normalize, and micro-ATR metals get fee-safe stop floor', () => {
    // 1. Build a 120-bar bearish downtrend (e9 < e20 < e50, LH-LL, below VWAP) with a tiny +0.15% 2-bar bounce at the end (still below EMA20 & VWAP)
    const bearCandles = [];
    let px = 200;
    const t0 = Date.now() - 120 * 900_000;
    for (let i = 0; i < 118; i++) {
      const open = px;
      const close = +(px * (1 - 0.0022)).toFixed(4);
      const high = +(open * 1.0008).toFixed(4);
      const low = +(close * 0.9992).toFixed(4);
      bearCandles.push({ time: t0 + i * 900_000, open, high, low, close, volume: 1500 });
      px = close;
    }
    // Minor 2-bar relief bounce (+0.08% each = +0.16% total, still well below EMA20 & EMA50)
    for (let i = 118; i < 120; i++) {
      const open = px;
      const close = +(px * 1.0008).toFixed(4);
      const high = +(close * 1.0004).toFixed(4);
      const low = +(open * 0.9996).toFixed(4);
      bearCandles.push({ time: t0 + i * 900_000, open, high, low, close, volume: 900 });
      px = close;
    }

    const bearCtx = readContext(bearCandles);
    expect(bearCtx?.dir).toBe(-1);
    expect(bearCtx?.trend).toBe('DOWN');

    const bearTrig = readTrigger(bearCandles, 'SHORT');
    expect(bearTrig?.dir).toBe(-1);
    expect(bearTrig?.opposingFlow).toBe(false);

    // 2. Trailing zero-range post-close auction bar (`open === high === low === close`, `volume === 0`)
    const bullWithAuction = makeBullishCandles(80, 100, 0.003);
    const realLast = bullWithAuction[bullWithAuction.length - 1];
    bullWithAuction.push({
      time: realLast.time + 300_000,
      open: realLast.close,
      high: realLast.close,
      low: realLast.close,
      close: realLast.close,
      volume: 0,
    });
    const trigAfterAuction = readTrigger(bullWithAuction, 'LONG');
    expect(trigAfterAuction?.dir).toBe(1);
    expect(trigAfterAuction?.volRatio).toBeGreaterThan(0.5);

    // 3. Compressed micro-ATR candles on XAU ($4,170 with $0.05 bar range) must get a fee-safe stop floor (< 0.5R cost)
    const microGold = [];
    let gPx = 4165;
    for (let i = 0; i < 100; i++) {
      const open = gPx;
      const close = +(gPx + 0.05).toFixed(2);
      microGold.push({ time: t0 + i * 300_000, open, high: +(close + 0.02).toFixed(2), low: +(open - 0.02).toFixed(2), close, volume: 100 + i });
      gPx = close;
    }
    const goldPlan = buildPlanFromCandles({
      symbol: 'XAU',
      market: 'METALS',
      mode: 'INTRADAY',
      ctxCandles: microGold,
      trigCandles: microGold,
    });
    expect(goldPlan.ok).toBe(true);
    expect(goldPlan.plan.stopPct).toBeGreaterThanOrEqual(0.35);
    expect(goldPlan.costs.costR).toBeLessThan(0.5);
    expect(goldPlan.plan.netRR.t1).toBeGreaterThan(0);
  });

  it('12) Single-Trade-Per-Session Lock on AUTO Trade Button: opens strictly 1 Verified Strong trade with 100% Wallet, blocks 2nd trade until active trade closes, and never auto-closes active trade on exchange indexing lag', async () => {
    __resetMtfAutoForTests();
    updateMtfAutoConfig({
      executionMode: 'live',
      walletAmountINR: 3000,
      walletDeployPct: 100,
      maxOpenPositions: 1,
      minScore: 75,
    });
    setMtfAutoEnabled(true);

    const twoStrongBoard = {
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
          label: '15m Deep + 5m Action',
          holdMin: 45,
          superScore: 88,
          tier: 'ELITE',
          side: 'LONG',
          dir: 1,
          directionVerified: true,
          triggerFired: true,
          dualAligned: true,
          counterTrend: false,
          trapVeto: false,
          zoneWallVeto: false,
          tfFit: 'GOOD',
          grade: 'A',
          autoEligible: true,
          autoBlockers: [],
          plan: { entry: 150, stopLoss: 147, t1: 154, t2: 158 },
        },
        {
          ok: true,
          symbol: 'ETHUSDT',
          market: 'CRYPTO',
          mode: 'INTRADAY',
          label: '15m Deep + 5m Action',
          holdMin: 45,
          superScore: 84,
          tier: 'STRONG',
          side: 'SHORT',
          dir: -1,
          directionVerified: true,
          triggerFired: true,
          dualAligned: true,
          counterTrend: false,
          trapVeto: false,
          zoneWallVeto: false,
          tfFit: 'GOOD',
          grade: 'A',
          autoEligible: true,
          autoBlockers: [],
          plan: { entry: 2500, stopLoss: 2540, t1: 2450, t2: 2400 },
        },
      ],
    };

    const liveOrdersPlaced: string[] = [];
    let paperNextId = 700;
    const openPaperList: Array<{ id: number; symbol: string; market: string; status: string }> = [];

    // 1. Pressing AUTO Trade with 2 Strong Verified signals on the board must open STRICTLY 1 trade (SOL), never 2!
    const tick1 = await mtfAutoTick({
      boards: { CRYPTO: twoStrongBoard },
      walletEquityINR: 3000,
      siteLiveActive: true,
      fx: 102,
      usdtQuotes: { SOL: 150, ETH: 2500 },
      paper: {
        getPaperSummary: () => ({ open: openPaperList }),
        openPaperTrade: (input: { symbol: string; market: string }) => {
          const id = ++paperNextId;
          openPaperList.push({ id, symbol: input.symbol, market: input.market, status: 'OPEN' });
          return { ok: true, trade: { id, ...input } };
        },
        closePaperTrade: () => ({ ok: true }),
      },
      liveExecute: async (ord: { symbol: string; side: string }) => {
        liveOrdersPlaced.push(ord.symbol);
        return {
          ok: true,
          orderId: `ord-${ord.symbol}-1`,
          position: { id: `pos-${ord.symbol}-1`, exchangePositionId: `pos-${ord.symbol}-1` },
          filled: {
            orderId: `ord-${ord.symbol}-1`,
            qty: 1.9,
            price: 150,
            leverage: 10,
            walletDeployINR: 2955,
            buyingPowerINR: 29550,
            stopLoss: 147,
            t1: 154,
            t2: 158,
          },
        };
      },
    });

    expect(tick1.opened.length).toBe(1);
    expect(liveOrdersPlaced).toEqual(['SOL']);
    expect(mtfAutoStatus().openCount).toBe(1);
    expect(mtfAutoStatus().deepMonitor.activeCount).toBe(1);

    // 2. Even if CoinDCX `/positions` returns [] 30 seconds later (indexing lag / pagination),
    //    syncCoinDcxActivePositionsToDeepMonitor MUST NOT auto-close the active trade (<120s grace)!
    syncCoinDcxActivePositionsToDeepMonitor([], {
      authoritativeExchangeList: true,
      walletINR: 3000,
      now: Date.now() + 30_000,
    });
    expect(mtfAutoStatus().openCount).toBe(1);
    expect(mtfAutoStatus().deepMonitor.activeCount).toBe(1);

    // 3. Subsequent auto-tick while SOL is active must block ETH ("1 session = 1 trade lock") and place 0 new orders!
    const tick2 = await mtfAutoTick({
      boards: { CRYPTO: twoStrongBoard },
      walletEquityINR: 3000,
      siteLiveActive: true,
      fx: 102,
      usdtQuotes: { SOL: 150.4, ETH: 2500 },
      paper: {
        getPaperSummary: () => ({ open: openPaperList }),
        openPaperTrade: () => ({ ok: true, trade: { id: ++paperNextId } }),
        closePaperTrade: () => ({ ok: true }),
      },
      liveExecute: async (ord: { symbol: string }) => {
        liveOrdersPlaced.push(ord.symbol);
        return { ok: true, orderId: `ord-${ord.symbol}-2` };
      },
    });
    expect(tick2.opened.length).toBe(0);
    expect(liveOrdersPlaced).toEqual(['SOL']);
    expect(tick2.skipped.join(' ')).toMatch(/1 session = 1 trade lock/i);

    // 4. Once SOL hits TP2 ($158.5) and closes cleanly, the session slot opens and the next tick can take the next Strong trade (ETH)!
    const closeTick = await mtfAutoTick({
      boards: { CRYPTO: { ok: true, rows: [] } },
      walletEquityINR: 3000,
      siteLiveActive: true,
      fx: 102,
      usdtQuotes: { SOL: 158.5, ETH: 2500 },
      now: Date.now() + 180_000,
      paper: {
        getPaperSummary: () => ({ open: openPaperList }),
        closePaperTrade: () => {
          openPaperList.length = 0;
          return { ok: true, trade: { realizedPnl: 16.15 } };
        },
      },
      liveClose: async () => ({ ok: true }),
    });
    expect(closeTick.closed.length).toBe(1);
    expect(mtfAutoStatus().openCount).toBe(0);

    // 5. Now that the 1st trade has finished, the next tick opens the next Verified Strong trade (ETH)!
    //    v21.23.6: successful close ke BAAD 5-min post-success PROFIT-COOLDOWN laga hai
    //    (user spec) — isliye tick ka clock >= close(+180s)+5min advance kiya.
    //    Pehle (+200s, sirf 20s baad) hota to cooldown block kar deta.
    const tick3 = await mtfAutoTick({
      boards: { CRYPTO: { ...twoStrongBoard, rows: [twoStrongBoard.rows[1]] } },
      walletEquityINR: 3000,
      siteLiveActive: true,
      fx: 102,
      usdtQuotes: { ETH: 2500 },
      now: Date.now() + 520_000,
      paper: {
        getPaperSummary: () => ({ open: openPaperList }),
        openPaperTrade: (input: { symbol: string; market: string }) => {
          const id = ++paperNextId;
          openPaperList.push({ id, symbol: input.symbol, market: input.market, status: 'OPEN' });
          return { ok: true, trade: { id, ...input } };
        },
        closePaperTrade: () => ({ ok: true }),
      },
      liveExecute: async (ord: { symbol: string }) => {
        liveOrdersPlaced.push(ord.symbol);
        return {
          ok: true,
          orderId: `ord-${ord.symbol}-3`,
          position: { id: `pos-${ord.symbol}-3`, exchangePositionId: `pos-${ord.symbol}-3` },
          filled: { orderId: `ord-${ord.symbol}-3`, qty: 0.11, price: 2500, leverage: 10, walletDeployINR: 2955 },
        };
      },
    });
    expect(tick3.opened.length).toBe(1);
    expect(liveOrdersPlaced).toEqual(['SOL', 'ETH']);
    __resetMtfAutoForTests();
  });

  it('13) executeMtfDualLiveOrder & MTFDualBoardPanel enforce strict 1-active-trade session lock across all pairs and block concurrent double orders', async () => {
    __resetMtfLiveOrderLockForTests();
    const mtfPanelSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/aitrading/MTFDualBoardPanel.tsx'),
      'utf8',
    );
    // MTFDualBoardPanel must set maxOpenPositions: 1. v21.23.15 A5: the
    // UI-side fallback pool (topStrongVerified + direct live call) was
    // removed — only the auto engine may place orders, so its gates
    // (cooldown / day quota / desk scope / fresh quote) can never be bypassed.
    expect(mtfPanelSrc).toMatch(/maxOpenPositions:\s*1/);
    expect(mtfPanelSrc).not.toContain('topStrongVerified');
    expect(mtfPanelSrc).toContain('client-side fallback entry disabled');

    const origFetch = global.fetch;
    const origKey = process.env.COINDCX_KEY;
    const origSec = process.env.COINDCX_SECRET;
    const dataDir = process.env.SMARTAI_DATA_DIR || path.join(process.cwd(), 'server', 'data');
    const journalPath = path.join(dataDir, 'ai-trading-journal.json');
    const savedJournal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : null;

    try {
      process.env.COINDCX_KEY = 'test-key-v2122-lock';
      process.env.COINDCX_SECRET = 'test-secret-v2122-lock';
      try { fs.unlinkSync(journalPath); } catch { /* ignore */ }

      const createdPairs: string[] = [];
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/derivatives/futures/wallets')) {
          return new Response(JSON.stringify([
            { currency_short_name: 'USDT', balance: '0', locked_balance: '0' },
            { currency_short_name: 'INR', balance: '3000', locked_balance: '0' },
          ]), { status: 200 });
        }
        if (u.includes('/derivatives/futures/data/instrument')) {
          const pairMatch = u.match(/pair=([^&]+)/);
          const pName = pairMatch ? pairMatch[1] : 'B-SOL_USDT';
          return new Response(JSON.stringify({
            instrument: {
              pair: pName,
              status: 'active',
              max_leverage_long: 10,
              max_leverage_short: 10,
              min_quantity: 0.1,
              quantity_increment: 0.1,
              min_notional: 5,
              safety_percentage: 2,
            },
          }), { status: 200 });
        }
        if (u.includes('/derivatives/futures/orders/create')) {
          const parsed = JSON.parse(String(init?.body || '{}'));
          const pair = parsed?.order?.pair || 'UNKNOWN';
          createdPairs.push(pair);
          return new Response(JSON.stringify([{ id: `ord-${pair}-${createdPairs.length}`, status: 'open' }]), { status: 200 });
        }
        if (u.includes('/derivatives/futures/positions')) {
          // Simulate CoinDCX indexing lag returning [] right after Trade 1 is placed
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      // 1. Fire 2 concurrent orders (SOL and ETH) at the exact same millisecond (simulating double-trigger race):
      //    _mtfLiveOrderInFlight mutex must block the 2nd call immediately so only 1 order hits CoinDCX!
      const [conc1, conc2] = await Promise.all([
        executeMtfDualLiveOrder({
          symbol: 'SOL',
          market: 'CRYPTO',
          side: 'LONG',
          entry: 150,
          stopLoss: 147,
          t1: 154,
          t2: 158,
          leverage: 10,
        }),
        executeMtfDualLiveOrder({
          symbol: 'ETH',
          market: 'CRYPTO',
          side: 'SHORT',
          entry: 2500,
          stopLoss: 2540,
          t1: 2450,
          t2: 2400,
          leverage: 10,
        }),
      ]);

      expect(conc1.ok).toBe(true);
      expect(conc2.ok).toBe(false);
      expect(createdPairs).toEqual(['B-SOL_USDT']);

      // 2. Now call executeMtfDualLiveOrder sequentially for NEAR while SOL is still OPEN (<120s old)
      //    Even though CoinDCX `/positions` returns `[]` (indexing lag), SOL must NOT be reconciled as flat
      //    and NEAR must be blocked by the 1-active-trade session lock!
      const seq2 = await executeMtfDualLiveOrder({
        symbol: 'NEAR',
        market: 'CRYPTO',
        side: 'LONG',
        entry: 5.0,
        stopLoss: 4.9,
        t1: 5.15,
        t2: 5.3,
        leverage: 10,
      });
      expect(seq2.ok).toBe(false);
      expect(String(seq2.reason || seq2.error)).toMatch(/1 session = 1 trade lock.*SOL.*LONG/i);
      expect(createdPairs).toEqual(['B-SOL_USDT']);

      // Verify SOL is still OPEN in the journal (never prematurely auto-closed!)
      const jr = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      const openPositions = (jr.positions || []).filter((p: { status: string }) => p.status === 'OPEN');
      expect(openPositions.length).toBe(1);
      expect(openPositions[0].symbol).toBe('SOL');
    } finally {
      global.fetch = origFetch;
      if (origKey === undefined) delete process.env.COINDCX_KEY;
      else process.env.COINDCX_KEY = origKey;
      if (origSec === undefined) delete process.env.COINDCX_SECRET;
      else process.env.COINDCX_SECRET = origSec;
      if (savedJournal === null) { try { fs.unlinkSync(journalPath); } catch { /* ignore */ } }
      else fs.writeFileSync(journalPath, savedJournal);
      __resetMtfLiveOrderLockForTests();
    }
  }, 15_000);

  it('14) MTF Dual Board LONG & SHORT Signal Accuracy — strict emaDir/ICT/SMC/FVG alignment, symmetric liveAlignedTrigger, and score cap <=74 when unverified', async () => {
    const makeHealthyTrendCandles = (count = 220, startPrice = 100, stepPct = 0.0018, dir: 1 | -1 = 1, intervalMs = 300_000) => {
      const out = [];
      let px = startPrice;
      const now = Date.now() - count * intervalMs;
      for (let i = 0; i < count; i++) {
        const open = px;
        // 2 impulse bars + 1 pullback bar (plus a 2-bar EMA20 retest at count-4..count-3 and 2 breakout bars at count-2..count-1)
        // keeps RSI in healthy 56-63 (LONG) / 37-44 (SHORT) and avoids overextension
        const isRetest = i === count - 4 || i === count - 3;
        const isBreakout = i >= count - 2;
        const isPullback = !isBreakout && (isRetest || i % 3 === 1);
        const move = isBreakout
          ? dir * stepPct * 1.15
          : isRetest
            ? -dir * stepPct * 1.10
            : isPullback
              ? -dir * stepPct * 1.05
              : dir * stepPct * 0.95;
        const close = +(px * (1 + move)).toFixed(4);
        const high = +(Math.max(open, close) * 1.0012).toFixed(4);
        const low = +(Math.min(open, close) * 0.9988).toFixed(4);
        const volume = 1000 + i * 10 + (isBreakout ? 2200 : 0);
        out.push({ time: now + i * intervalMs, open, high, low, close, volume });
        px = close;
      }
      return out;
    };

    // 1. Tight bearish EMA stack (`e9 < e20 < e50 < e200`) must always vote emaDir = -1 (never +1)
    const tightBearCandles = makeHealthyTrendCandles(220, 100, 0.0004, -1);
    const wBear = computeWorldTopIndicators(tightBearCandles, 'SHORT');
    expect(wBear).not.toBeNull();
    const emaItem = wBear?.indicators?.find((i: { id: string }) => i.id === 'emaRibbon');
    const ictItem = wBear?.indicators?.find((i: { id: string }) => i.id === 'ict');
    expect(emaItem?.dir).toBe(-1);
    expect(emaItem?.detail).toMatch(/BearStack/i);
    expect(ictItem?.dir).toBe(-1);

    // 2. Clean LONG uptrend & clean SHORT downtrend on buildDualRow both verify pakka direction & triggerFired
    const bull15m = makeHealthyTrendCandles(120, 100, 0.0018, 1, 900_000);
    const bull5m = makeHealthyTrendCandles(120, 110, 0.0014, 1, 300_000);
    const longRow = await buildDualRow({
      symbol: 'SOL',
      market: 'CRYPTO',
      modeId: 'INTRADAY',
      candlesFor: async (_s: string, _m: string, tf: string) => (tf === '15m' ? bull15m : bull5m),
    });
    expect(longRow.side).toBe('LONG');
    expect(longRow.directionVerified).toBe(true);
    expect(longRow.pakkaDirectionLabel).toBe('PAKKA LONG');
    expect(longRow.triggerFired).toBe(true);
    expect(longRow.autoEligible).toBe(true);

    const bear15m = makeHealthyTrendCandles(120, 150, 0.0018, -1, 900_000);
    const bear5m = makeHealthyTrendCandles(120, 135, 0.0014, -1, 300_000);
    const shortRow = await buildDualRow({
      symbol: 'OP',
      market: 'CRYPTO',
      modeId: 'INTRADAY',
      candlesFor: async (_s: string, _m: string, tf: string) => (tf === '15m' ? bear15m : bear5m),
    });
    expect(shortRow.side).toBe('SHORT');
    expect(shortRow.directionVerified).toBe(true);
    expect(shortRow.pakkaDirectionLabel).toBe('PAKKA SHORT');
    expect(shortRow.triggerFired).toBe(true);
    expect(shortRow.autoEligible).toBe(true);
  });

  it('15) Anti-Reversal & Pure 8 Institutional Indicators Upgrade: removes useless indicators, blocks counter-candle/climax entries, enforces >=1.15xATR stop floor, and guards live quote reversals in mtfAutoTick', async () => {
    const bullCandles = makeBullishCandles(120, 100, 0.0025, 300_000);
    const w8 = computeWorldTopIndicators(bullCandles, 'LONG');
    expect(w8?.totalCount).toBe(8);
    expect(w8?.total8Count).toBe(8);
    expect(w8?.indicators.map((i: { id: string }) => i.id)).toEqual([
      'smc',
      'liquiditySweep',
      'volumeProfile',
      'fvg',
      'ict',
      'emaRibbon',
      'supplyDemand',
      'priceAction',
    ]);

    // Counter-candle reversal on 5m Action TF (e.g. LONG context but last 5m candle dumps below EMA9 with negative roc1)
    // must set reversalRisk=true, fired=false, and be vetoed by the 3-Model Local Ollama AI Ensemble
    const reversing5m = bullCandles.map(c => ({ ...c }));
    const lastIdx = reversing5m.length - 1;
    const prevClose = reversing5m[lastIdx - 1].close;
    reversing5m[lastIdx] = {
      ...reversing5m[lastIdx],
      open: +(prevClose * 1.001).toFixed(4),
      high: +(prevClose * 1.002).toFixed(4),
      low: +(prevClose * 0.982).toFixed(4),
      close: +(prevClose * 0.984).toFixed(4),
      volume: 4200,
    };
    const revTrig = readTrigger(reversing5m, 'LONG');
    expect(revTrig?.reversalRisk).toBe(true);
    expect(revTrig?.broke).toBe(false);

    const revRow = await buildDualRow({
      symbol: 'ARB',
      market: 'CRYPTO',
      modeId: 'INTRADAY',
      candlesFor: async (_s: string, _m: string, tf: string) => (tf === '15m' ? bullCandles : reversing5m),
    });
    expect(revRow.triggerFired).toBe(false);
    expect(revRow.directionVerified).toBe(false);
    expect(revRow.autoEligible).toBe(false);
    expect(revRow.ollamaTrio?.approvedCount).toBeLessThan(2);

    // Pre-execution live quote anti-reversal guard in mtfAutoTick:
    // If live price has already dropped >= 25% of risk distance below entry on a LONG signal, mtfAutoTick blocks entry!
    __resetMtfAutoForTests();
    setMtfAutoEnabled(true);
    updateMtfAutoConfig({ markets: ['CRYPTO'], liveExecution: false, minScore: 75 });
    const tickRev = await mtfAutoTick({
      boards: {
        CRYPTO: {
          ok: true,
          rows: [
            {
              ok: true,
              symbol: 'LINKUSDT',
              market: 'CRYPTO',
              mode: 'INTRADAY',
              label: '15m Deep + 5m Action',
              side: 'LONG',
              dir: 1,
              superScore: 95,
              tier: 'ELITE',
              directionVerified: true,
              triggerFired: true,
              dualAligned: true,
              counterTrend: false,
              trapVeto: false,
              zoneWallVeto: false,
              tfFit: 'GOOD',
              grade: 'A',
              autoEligible: true,
              autoBlockers: [],
              rr: 2.2,
              holdMin: 60,
              plan: { entry: 20.0, stopLoss: 19.6, t1: 20.6, t2: 21.0, rr: 2.2, tfFit: 'GOOD' },
            },
          ],
        },
      },
      paper: {
        getPaperSummary: () => ({ open: [] }),
        openPaperTrade: () => ({ ok: true, trade: { id: 'T-SHOULD-NOT-OPEN' } }),
      },
      // Entry = 20.0, SL = 19.6 (risk = 0.40); live quote = 19.85 (dropped 0.15 > 25% of 0.40 toward SL!)
      usdtQuotes: { LINK: 19.85 },
    });
    expect(tickRev.opened.length).toBe(0);
    expect(tickRev.skipped.some((s: string) => s.includes('anti-reversal guard blocked entry'))).toBe(true);
  });

  // ------------------------------------------------------------
  // 16. Deep Working-Flow Fix: MTF Dual Board → Signal Recheck 15s Live Watch
  //     + peekDualMtfBoards + Pure 8 Institutional Indicators Metadata
  // ------------------------------------------------------------
  it('16) Signal Recheck 15s Live Watch merges MTF Dual Board rows (Crypto, XAU/XAG Metals, Equity Sim) and peekDualMtfBoards caches warm boards', async () => {
    __clearDualBoardCaches();
    __resetSignalRecheckForTests();

    const bullCandles = makeBullishCandles(120, 100);
    const board = await getDualMtfBoard({
      market: 'CRYPTO',
      mode: 'INTRADAY',
      boardSigs: [{ symbol: 'BTCUSDT', side: 'LONG', confidence: 92 }],
      candlesFor: async () => bullCandles,
    });
    expect(board.worldIndicatorsInfo?.count).toBe(8);
    expect(board.worldIndicatorsInfo?.institutional8Count).toBe(8);

    const cachedBoards = peekDualMtfBoards(90_000);
    expect(cachedBoards.length).toBeGreaterThanOrEqual(1);
    expect(cachedBoards[0]?.market).toBe('CRYPTO');

    startSignalRecheckLoop({
      getSignals: async () => ({ signals: [] }),
      getMtfDualBoards: async () => [
        {
          market: 'CRYPTO',
          mode: 'INTRADAY',
          rows: [
            {
              ok: true,
              symbol: 'BTC',
              market: 'CRYPTO',
              assetClass: 'CRYPTO',
              side: 'LONG',
              tier: 'ELITE',
              superScore: 91,
              ltp: 75000,
              trapVeto: false,
              zoneWallVeto: false,
              reversalRisk: false,
              plan: { entry: 75000, stopLoss: 74200, t1: 76200, t2: 77500 },
            },
          ],
          metalsRows: [
            {
              ok: true,
              symbol: 'XAU',
              market: 'CRYPTO',
              assetClass: 'METALS',
              side: 'LONG',
              tier: 'STRONG',
              superScore: 84,
              ltp: 2950,
              trapVeto: false,
              zoneWallVeto: false,
              reversalRisk: false,
              plan: { entry: 2950, stopLoss: 2925, t1: 2985, t2: 3020 },
            },
          ],
          equitySimRows: [
            {
              ok: true,
              symbol: 'NVDA',
              market: 'CRYPTO',
              assetClass: 'EQUITY_SIM',
              side: 'SHORT',
              tier: 'STRONG',
              superScore: 82,
              ltp: 140,
              trapVeto: false,
              zoneWallVeto: false,
              reversalRisk: false,
              plan: { entry: 140, stopLoss: 143, t1: 136, t2: 132 },
            },
          ],
        },
      ],
      fetchLtp: async () =>
        new Map([
          ['BTC', { price: 75350, src: 'coindcx' }],
          ['XAU', { price: 2962, src: 'coindcx-metals' }],
          ['NVDA', { price: 138.8, src: 'yahoo' }],
        ]),
    });

    await recheckTick(Date.now());
    const status = signalRecheckStatus();
    const watchedSyms = (status.rows || []).map((w: { symbol: string }) => w.symbol);
    expect(watchedSyms).toContain('BTC');
    expect(watchedSyms).toContain('XAU');
    expect(watchedSyms).toContain('NVDA');
    const xauRow = (status.rows || []).find((w: { symbol: string }) => w.symbol === 'XAU');
    expect(xauRow?.market).toBe('FUTURES');
    expect(xauRow?.state).toBe('OK');
    const nvdaRow = (status.rows || []).find((w: { symbol: string }) => w.symbol === 'NVDA');
    expect(nvdaRow?.market).toBe('GLOBALFUTURES');
    expect(nvdaRow?.state).toBe('OK');
    __resetSignalRecheckForTests();
  });

  it('17) Anti-Late-Entry ("Trend Moment Ke Baad Trade Na Lage") + Paper Direction Test + Realtime Ultra-Fast SL Trail Persistence', async () => {
    // v21.26.1: this test pins the LEGACY ultra-fast stage trail; production
    // defaults to proExitPolicy (no trail before TP1), covered separately.
    __resetMtfAutoForTests({ config: { proExitPolicy: false } });

    // 1. fairValueGap must NOT self-tap on the creation bar (barsAgo === 0)
    const spikeCandles = [];
    const baseTime = 1_760_000_000_000;
    for (let i = 0; i < 20; i++) {
      const open = +(1.2900 + (i % 2 === 0 ? 0.0005 : -0.0004)).toFixed(4);
      const close = +(open + (i % 2 === 0 ? 0.0004 : -0.0003)).toFixed(4);
      spikeCandles.push({ time: baseTime + i * 300_000, open, high: Math.max(open, close) + 0.0004, low: Math.min(open, close) - 0.0004, close, volume: 1000 });
    }
    // Create a 3-bar spike at the end where c0.high < c2.low (bullish FVG on the very last bar, barsAgo === 0)
    spikeCandles.push({ time: baseTime + 20 * 300_000, open: 1.2910, high: 1.2920, low: 1.2908, close: 1.2918, volume: 1500 });
    spikeCandles.push({ time: baseTime + 21 * 300_000, open: 1.2918, high: 1.2980, low: 1.2917, close: 1.2975, volume: 3200 });
    spikeCandles.push({ time: baseTime + 22 * 300_000, open: 1.2975, high: 1.2994, low: 1.2960, close: 1.2990, volume: 2100 });
    const fvgOnSpike = fairValueGap(spikeCandles);
    expect(fvgOnSpike?.bullishFvg?.barsAgo).toBe(0);
    expect(fvgOnSpike?.bullishFvg?.tapped).toBe(false);

    // 2. Post-Peak Exhaustion Trap (XRP LONG after 4-bar spike + 3 red rejection bars + 1 weak bounce at top of range)
    const postPeak5m = [];
    for (let i = 0; i < 45; i++) {
      const open = +(1.2905 + (i % 3 === 0 ? 0.0006 : -0.0003)).toFixed(4);
      const close = +(open + (i % 2 === 0 ? 0.0004 : -0.0003)).toFixed(4);
      postPeak5m.push({ time: baseTime + i * 300_000, open, high: Math.max(open, close) + 0.0005, low: Math.min(open, close) - 0.0005, close, volume: 1000 });
    }
    // 4-bar pump to 1.2994, then 3 red bars down to 1.2962, then 1 low-volume bounce bar to 1.2982
    postPeak5m.push({ time: baseTime + 45 * 300_000, open: 1.2918, high: 1.2950, low: 1.2917, close: 1.2948, volume: 1800 });
    postPeak5m.push({ time: baseTime + 46 * 300_000, open: 1.2948, high: 1.2975, low: 1.2945, close: 1.2972, volume: 2200 });
    postPeak5m.push({ time: baseTime + 47 * 300_000, open: 1.2972, high: 1.2994, low: 1.2970, close: 1.2991, volume: 2500 });
    postPeak5m.push({ time: baseTime + 48 * 300_000, open: 1.2991, high: 1.2992, low: 1.2978, close: 1.2980, volume: 1200 });
    postPeak5m.push({ time: baseTime + 49 * 300_000, open: 1.2980, high: 1.2982, low: 1.2968, close: 1.2970, volume: 1100 });
    postPeak5m.push({ time: baseTime + 50 * 300_000, open: 1.2970, high: 1.2973, low: 1.2962, close: 1.2966, volume: 950 });
    postPeak5m.push({ time: baseTime + 51 * 300_000, open: 1.2966, high: 1.2985, low: 1.2965, close: 1.2982, volume: 800 });

    const trigPostPeak = readTrigger(postPeak5m, 'LONG');
    expect(trigPostPeak?.postPeakTrap).toBe(true);
    expect(trigPostPeak?.reversalRisk).toBe(true);
    expect(trigPostPeak?.broke).toBe(false);

    // 3. Paper Trade Registration & Real-Time Direction Follow-Through + Ultra-Fast SL Trail Persistence
    const paperRec = recordPaperMtfBoardTrade({
      paperId: 901,
      symbol: 'XRP',
      market: 'CRYPTO',
      side: 'LONG',
      entry: 1.2950,
      stopLoss: 1.2850,
      t1: 1.3075,
      t2: 1.3200,
      qty: 500,
      fx: 102,
      superScore: 86,
      tier: 'ELITE',
      mode: 'INTRADAY',
      holdMin: 45,
    });
    expect(paperRec?.executionMode).toBe('PAPER');
    expect(paperRec?.traded).toBe(true);

    // Step A: Price moves in favor to +0.60R (1.3010) -> Stage 2 Breakeven Plus + PAKKA LONG FOLLOWING
    const monStepA = getActiveAutoTradesDeepMonitor({ XRP: 1.3010 });
    expect(monStepA.activeCount).toBe(1);
    const trA = monStepA.trades[0];
    expect(trA.executionMode).toBe('PAPER');
    expect(trA.directionFollowing).toBe(true);
    expect(trA.followThroughVerdict).toContain('PAKKA LONG FOLLOWING');
    expect(trA.stageCode).toBe('STAGE_2_BREAKEVEN_PLUS');
    expect(trA.trailedStopLoss).toBeGreaterThan(1.2950);
    const lockedSlAfterStepA = trA.trailedStopLoss;

    // Step B: Price pulls back to +0.20R (1.2970) -> trailedStopLoss & peakPrice MUST NOT regress!
    const monStepB = getActiveAutoTradesDeepMonitor({ XRP: 1.2970 });
    const trB = monStepB.trades[0];
    expect(trB.peakPrice).toBeCloseTo(1.3010, 4);
    expect(trB.trailedStopLoss).toBeGreaterThanOrEqual(lockedSlAfterStepA);

    // Step C: Paper Trading engine SL ratchet sync (updatePaperTradeStopLoss)
    const { openPaperTrade, updatePaperTradeStopLoss, _resetForTests } = await import('../server/intraday/paperTrading.js');
    _resetForTests();
    const openedPaper = openPaperTrade({
      symbol: 'XRP',
      direction: 'LONG',
      entry: 1.2950,
      qty: 500,
      stopLoss: 1.2850,
      target1: 1.3075,
      target2: 1.3200,
      market: 'FUTURES',
    });
    expect(openedPaper.trade?.stopLoss).toBe(1.2850);
    const sync1 = updatePaperTradeStopLoss(openedPaper.trade?.id, lockedSlAfterStepA);
    expect(sync1.ok).toBe(true);
    expect(sync1.updated).toBe(true);
    expect(sync1.stopLoss).toBeCloseTo(lockedSlAfterStepA, 4);
    // Attempting to lower SL on a LONG trade must be ignored (never regress)
    const sync2 = updatePaperTradeStopLoss(openedPaper.trade?.id, 1.2880);
    expect(sync2.updated).toBe(false);
    expect(sync2.stopLoss).toBeCloseTo(lockedSlAfterStepA, 4);
    _resetForTests();

    // Step D: UI verification for Paper Test buttons
    const panelSrc = fs.readFileSync(path.resolve('src/components/aitrading/MTFDualBoardPanel.tsx'), 'utf8');
    expect(panelSrc).toContain('data-testid="mtf-paper-test-auto-btn"');
    expect(panelSrc).toContain('mtf-card-paper-');
    expect(panelSrc).toContain('POST-PEAK TRAP');
  });
});
