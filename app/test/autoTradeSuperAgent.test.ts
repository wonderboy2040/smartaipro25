// ============================================================
// test/autoTradeSuperAgent.test.ts — v21.26.0 AI SUPER AGENT
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "jab bhi AUTO trade lagta hai, us trade ke liye
// ek AI super intelligence agent immediately active ho — WebSocket realtime
// price par TP1/TP2 monitor kare, highest profit trail kare, trade clearly
// against ho to bahut hi kam loss me close kare, aur market pakka opposite
// move kare to purana trade band karke immediately naya trade live direction
// me laga de. TP2 hit + close ke baad agent wapas IDLE ho jaye."
//
// LOCKS:
//   S1 — TP1 partial books ON THE TICK and state becomes TP1_SECURED
//   S2 — TP2 closes the runner and puts the agent back to IDLE
//   S3 — velocity-confirmed adverse move closes at minimal loss, not full SL
//   S4 — a normal pullback NEVER closes (whipsaw firewall)
//   S5 — confirmed board flip → UC_FLIP_MINIMAL_LOSS_EXIT + immediate reverse
//   S6 — TP1 → TP2 lifecycle (one close only)
//   S7 — liveFeed tick router arms the trade + holds the upstream stream
//   S8 — real paper engine: bookPaperT1Partial books 50% and keeps runner
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'super-agent-test-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  mtfAutoSuperAgentManage, __resetMtfAutoForTests, mtfAutoStatus,
  getAutoTradeSuperAgentOpenTrades, getAutoTradeSuperAgentCloseReason,
  syncCoinDcxActivePositionsToDeepMonitor,
} from '../server/ai/mtfAutoLink.js';
import {
  startAutoTradeSuperAgent, refreshAutoTradeSuperAgent,
  autoTradeSuperAgentStatus, __resetAutoTradeSuperAgentForTests,
} from '../server/ai/autoTradeSuperAgent.js';
import { setTick } from '../server/liveFeed.js';
import { dayKeyFor } from '../server/intraday/time.js';
import {
  openPaperTrade, bookPaperT1Partial, getPaperSummary,
  _resetForTests as _resetPaperForTests,
} from '../server/intraday/paperTrading.js';

const NOW = Date.now();
const DAY = dayKeyFor('CRYPTO', new Date(NOW));
const PAPER_DAY = dayKeyFor('FUTURES', new Date(NOW));

/** OPEN AUTO book row with a real paper mirror identity. */
function autoRow(over: Record<string, any> = {}) {
  return {
    paperId: 777,
    executionMode: 'PAPER', traded: true, fullControl: false, openedInLiveMode: false,
    openedBy: 'AUTO', autoTrade: true,
    symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', score: 88, tier: 'ELITE', mode: 'INTRADAY', holdMin: 45,
    entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99,
    peakPrice: 100, t1: 101, t2: 102, qty: 10, leverage: 5,
    feeBreakevenPrice: 100.2,
    atrPct: 1.0, volClass: 'NORMAL', momentumState: 'UNKNOWN', t1ClosePct: 0.5,
    openedAt: NOW - 5 * 60_000, dayKey: DAY, status: 'OPEN',
    directionVerified: true,
    deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
    deepMonitorLabel: 'Stage 0 · Initial SL Guard',
    superAgentState: 'ARMED',
    ...over,
  };
}

/** Hermetic paper fake. Mirrors the real engine's public contract. */
function fakePaper(tradeOver: Record<string, any> = {}) {
  const mirror: any = {
    id: 777, symbol: 'BTC', market: 'FUTURES', direction: 'LONG',
    status: 'OPEN', entry: 100, qty: 10, remainingQty: 10,
    stopLoss: 99, target1: 101, target2: 102,
    realizedPnl: 0, t1Hit: false, parts: [], openedAt: NOW - 5 * 60_000,
    ...tradeOver,
  };
  const calls = { opened: [] as any[], closed: [] as any[], booked: [] as any[], sl: [] as any[] };
  const paper: any = {
    getPaperSummary: vi.fn(() => ({
      open: mirror.status === 'CLOSED' ? [] : [mirror],
      closedToday: mirror.status === 'CLOSED' ? [mirror] : [],
    })),
    bookPaperT1Partial: vi.fn((id: any, px: number) => {
      calls.booked.push({ id, px });
      mirror.t1Hit = true;
      return { ok: true, trade: mirror, t1Pct: 0.5, note: 'booked 50% at T1, trail to entry' };
    }),
    closePaperTrade: vi.fn((id: any, _quotes: any, reason: string) => {
      calls.closed.push({ id, reason });
      mirror.status = 'CLOSED';
      mirror.closeReason = reason;
      mirror.closedAt = Date.now();
      mirror.realizedPnl = +(((Number(_quotes?.['FUTURES|BTC']?.price) || 0) - 100) * 10).toFixed(2);
      return { ok: true, trade: mirror };
    }),
    openPaperTrade: vi.fn((input: any) => {
      calls.opened.push(input);
      const reverse = {
        id: 901, ...input, status: 'OPEN', realizedPnl: 0, t1Hit: false,
        remainingQty: input.qty, parts: [],
      };
      return { ok: true, trade: reverse };
    }),
    updatePaperTradeStopLoss: vi.fn((...args: any[]) => { calls.sl.push(args); return { ok: true }; }),
    updatePaperTradeTarget2: vi.fn(() => ({ ok: true })),
    evaluatePaper: vi.fn(),
  };
  return { paper, calls, mirror };
}

function agentP(paper: any, over: Record<string, any> = {}) {
  return {
    paper,
    quotes: { 'FUTURES|BTC': { price: 100 }, BTC: { price: 100 } },
    getBoardRow: vi.fn(() => null),
    getLiveCtx: vi.fn(async () => ({})),
    notify: vi.fn(async () => {}),
    fx: 102,
    walletEquityINR: 10_000,
    siteLiveByDesk: { crypto: false, india: false },
    killSwitch: false,
    ...over,
  };
}

function bookLatest() {
  return (mtfAutoStatus().book || []).find((b: any) => b.symbol === 'BTC');
}

function flippedShortRow(over: Record<string, any> = {}) {
  return {
    ok: true, symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45,
    superScore: 86, tier: 'ELITE', side: 'SHORT', dir: -1, grade: 'A',
    triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
    directionVerified: true, ensembleSignalAvailable: true,
    autoEligible: true, autoBlockers: [],
    plan: { entry: 100.5, stopLoss: 100.6, t1: 98.5, t2: 97.5 },
    context: { dir: -1 }, ltp: 99.6, drivers: ['fixture'],
    ...over,
  };
}

function seed(over: Record<string, any> = {}) {
  __resetMtfAutoForTests({
    config: { enabled: true, executionMode: 'paper', minScore: 75, desks: { india: false, crypto: true } },
    state: { book: [autoRow(over)] },
  });
}

const flush = (ms = 15) => new Promise(r => setTimeout(r, ms));

describe('v21.26.0 S1 — TP1 partial books on the tick', () => {
  beforeEach(() => seed());
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('T1 touch → bookPaperT1Partial called + state TP1_SECURED', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoSuperAgentManage({
      symbol: 'BTC', market: 'CRYPTO', ltp: 101.2, tickAgeMs: 50, p: agentP(paper),
    });

    expect(out.ok).toBe(true);
    expect(out.action).toBe('TP1_PARTIAL_BOOKED');
    expect(out.state).toBe('TP1_SECURED');
    expect(calls.booked).toHaveLength(1);
    expect(calls.booked[0]).toEqual({ id: 777, px: 101.2 });
    expect(bookLatest()?.t1Hit).toBe(true);
    expect(bookLatest()?.superAgentState).toBe('TP1_SECURED');
  });
});

describe('v21.26.0 S2 — TP2 closes runner → agent IDLE', () => {
  beforeEach(() => seed({ t1Hit: true }));
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('TP2 tick closes the paper mirror and returns the agent to IDLE', async () => {
    const { paper, calls } = fakePaper({ t1Hit: true });
    const out = await mtfAutoSuperAgentManage({
      symbol: 'BTC', market: 'CRYPTO', ltp: 102.2, tickAgeMs: 40, p: agentP(paper),
    });

    expect(out.closed).toBe(true);
    expect(out.action).toBe('TP2_TARGET_HIT_FULL_PROFIT');
    expect(out.state).toBe('IDLE');
    expect(calls.closed).toHaveLength(1);
    expect(calls.closed[0].reason).toBe('TP2_TARGET_HIT_FULL_PROFIT');
    const row = bookLatest();
    expect(row?.status).toBe('CLOSED');
    expect(row?.closeReason).toBe('TP2_TARGET_HIT_FULL_PROFIT');
    expect(row?.superAgentState).toBe('IDLE');
  });
});

describe('v21.26.0 S3/S4 — minimal loss only on CONFIRMED adverse move', () => {
  beforeEach(() => seed());
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('velocity-confirmed adverse move closes at minimal loss (before full -1R SL)', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoSuperAgentManage({
      symbol: 'BTC', market: 'CRYPTO', ltp: 99.6, tickAgeMs: 80,
      velocityAdverse: true, velocityPct: 0.42,
      p: agentP(paper),
    });

    expect(out.closed).toBe(true);
    expect(out.flipped).toBe(false);
    expect(out.action).toBe('SUPER_AGENT_MINIMAL_LOSS_EXIT');
    expect(out.state).toBe('IDLE');
    expect(calls.closed).toHaveLength(1);
    expect(calls.closed[0].reason).toBe('SUPER_AGENT_MINIMAL_LOSS_EXIT');
    expect(out.currentR).toBeLessThanOrEqual(-0.35);
  });

  it('a normal pullback with no confirmation does NOT close', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoSuperAgentManage({
      symbol: 'BTC', market: 'CRYPTO', ltp: 99.8, tickAgeMs: 80,
      velocityAdverse: false, p: agentP(paper),
    });

    expect(out.closed).toBe(false);
    expect(out.action).toBeNull();
    expect(out.state).toBe('MONITORING');
    expect(calls.closed).toHaveLength(0);
    expect(bookLatest()?.status).toBe('OPEN');
  });
});

describe('v21.26.0 S5 — confirmed board flip closes + immediate reverse entry', () => {
  beforeEach(() => seed());
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('LONG loss + board SHORT PAKKA → UC_FLIP_MINIMAL_LOSS_EXIT + SHORT reverse', async () => {
    const { paper, calls } = fakePaper();
    const out = await mtfAutoSuperAgentManage({
      symbol: 'BTC', market: 'CRYPTO', ltp: 99.6, tickAgeMs: 30,
      p: agentP(paper, { getBoardRow: vi.fn(() => flippedShortRow()) }),
    });

    expect(out.closed).toBe(true);
    expect(out.flipped).toBe(true);
    expect(out.action).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(out.state).toBe('FLIPPED');
    expect(out.reverseSide).toBe('SHORT');
    expect(calls.closed).toHaveLength(1);
    expect(calls.closed[0].reason).toBe('UC_FLIP_MINIMAL_LOSS_EXIT');
    expect(calls.opened).toHaveLength(1);
    expect(calls.opened[0].direction).toBe('SHORT');
    expect(calls.opened[0].market).toBe('FUTURES');
    expect(calls.opened[0].source).toBe('uc-flip-reverse');

    const reverse = (mtfAutoStatus().book || []).find((b: any) => b.symbol === 'BTC' && b.status === 'OPEN');
    expect(reverse?.side).toBe('SHORT');
    expect(reverse?.superAgentState).toBe('ARMED');
    expect(reverse?.flipEntry).toBe(true);
  });
});

describe('v21.26.0 S6 — full TP1 → TP2 lifecycle', () => {
  beforeEach(() => seed());
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('one TP1 partial, then one TP2 close, then IDLE', async () => {
    const { paper, calls } = fakePaper();

    const t1 = await mtfAutoSuperAgentManage({
      symbol: 'BTC', market: 'CRYPTO', ltp: 101.2, tickAgeMs: 20, p: agentP(paper),
    });
    expect(t1.state).toBe('TP1_SECURED');
    expect(t1.closed).toBe(false);

    const t2 = await mtfAutoSuperAgentManage({
      symbol: 'BTC', market: 'CRYPTO', ltp: 102.1, tickAgeMs: 20, p: agentP(paper),
    });
    expect(t2.closed).toBe(true);
    expect(t2.state).toBe('IDLE');
    expect(calls.booked).toHaveLength(1);
    expect(calls.closed).toHaveLength(1);
    expect(calls.closed[0].reason).toBe('TP2_TARGET_HIT_FULL_PROFIT');
  });
});

describe('v21.26.0 S7 — liveFeed tick router + stream hold', () => {
  beforeEach(() => seed());
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('AUTO row is armed instantly, WS tick reaches the agent, stream hold is taken/released', async () => {
    const { paper } = fakePaper();
    const ensureSubs = vi.fn();
    const releaseSubs = vi.fn();
    const clientUp = vi.fn();
    const clientDown = vi.fn();

    startAutoTradeSuperAgent({
      getOpenTrades: getAutoTradeSuperAgentOpenTrades,
      getQuoteFor: () => null,
      getBoardRow: () => null,
      getQuotes: () => ({}),
      getFx: async () => 102,
      getLiveCtx: async () => ({}),
      isKillSwitch: () => false,
      ensureSubs,
      releaseSubs,
      clientUp,
      clientDown,
      paper,
      notify: async () => {},
    });

    expect(ensureSubs).toHaveBeenCalledWith({ fut: ['BTC'] });
    expect(clientUp).toHaveBeenCalledWith('cxrt');

    setTick('FUT_BTC', { price: 101.2, time: Date.now() }, 'test-ws');
    await flush();

    const st = autoTradeSuperAgentStatus();
    expect(st.running).toBe(true);
    expect(st.pollingMs).toBe(0);
    expect(st.primarySource).toContain('WebSocket');
    expect(st.trades).toHaveLength(1);
    expect(st.trades[0].state).toBe('TP1_SECURED');
    expect(st.trades[0].lastSource).toBe('FUT_BTC');
    expect(st.trades[0].tickCount).toBeGreaterThanOrEqual(1);

    refreshAutoTradeSuperAgent();
    __resetAutoTradeSuperAgentForTests();
    expect(releaseSubs).toHaveBeenCalledWith({ fut: ['BTC'] });
    expect(clientDown).toHaveBeenCalledWith('cxrt');
  });
});

describe('v21.26.0 S9 — cross-domain tick firewall (velocity-ring protection)', () => {
  beforeEach(() => seed());
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('an INR spot tick for the same symbol never enters a USDT trade sample ring', async () => {
    const { paper } = fakePaper();
    startAutoTradeSuperAgent({
      getOpenTrades: getAutoTradeSuperAgentOpenTrades,
      getQuoteFor: () => null,
      getBoardRow: () => null,
      getQuotes: () => ({}),
      getFx: async () => 102,
      getLiveCtx: async () => ({}),
      isKillSwitch: () => false,
      ensureSubs: vi.fn(),
      releaseSubs: vi.fn(),
      clientUp: vi.fn(),
      clientDown: vi.fn(),
      paper,
      notify: async () => {},
    });

    // FUT_BTC is the trade's real key; IN_BTC for BTC is the INR spot feed
    // (~100× USDT) and must be rejected BEFORE the rolling velocity samples.
    setTick('IN_BTC', { price: 9_000_000, time: Date.now() }, 'inr-spot');
    await flush();
    let st = autoTradeSuperAgentStatus();
    expect(st.trades[0].tickCount).toBe(0);
    expect(String(st.trades[0].lastError || '')).toContain('cross-domain');

    setTick('FUT_BTC', { price: 99.8, time: Date.now() }, 'binance-ws');
    await flush();
    st = autoTradeSuperAgentStatus();
    expect(st.trades[0].tickCount).toBe(1);
    expect(st.trades[0].lastSource).toBe('FUT_BTC');
    expect(st.trades[0].state).toBe('MONITORING');
  });
});

describe('v21.26.0 S8 — real paper engine TP1 partial', () => {
  beforeEach(() => {
    _resetPaperForTests({ trades: [], nextId: 1, dayKey: PAPER_DAY });
  });

  it('books t1ClosePct of a fractional USD position and keeps the runner', () => {
    const opened: any = openPaperTrade({
      symbol: 'BTC', direction: 'LONG', entry: 100, qty: 10,
      stopLoss: 99, target1: 101, target2: 102,
      market: 'FUTURES', leverage: 5, t1ClosePct: 0.5,
      source: 'mtf-auto',
    });
    expect(opened.ok).toBe(true);

    const res: any = bookPaperT1Partial(opened.trade.id, 101.2);
    expect(res.ok).toBe(true);
    expect(res.t1Pct).toBe(0.5);
    expect(res.trade.t1Hit).toBe(true);
    expect(res.trade.remainingQty).toBe(5);
    expect(res.trade.status).toBe('PARTIAL');
    expect(res.trade.parts).toHaveLength(1);
    expect(res.trade.parts[0].reason).toBe('T1_BOOK');

    const again: any = bookPaperT1Partial(opened.trade.id, 101.3);
    expect(again.ok).toBe(false);
    expect(getPaperSummary().open[0]?.remainingQty).toBe(5);
  });

  it('un-splittable 1-unit position moves SL to breakeven instead of double-booking', () => {
    // INR desks are whole-unit only (Math.ceil(1 × 50%) = 1), so the TP1
    // branch must protect the runner at breakeven rather than "split" it.
    const opened: any = openPaperTrade({
      symbol: 'RELIANCE', direction: 'LONG', entry: 100, qty: 1,
      stopLoss: 99, target1: 101, target2: 102,
      market: 'INDIA', t1ClosePct: 0.5,
      source: 'mtf-auto',
    });
    expect(opened.ok).toBe(true);

    const res: any = bookPaperT1Partial(opened.trade.id, 101.1);
    expect(res.ok).toBe(true);
    expect(res.trade.t1Hit).toBe(true);
    expect(res.trade.remainingQty).toBe(1);
    expect(res.trade.stopLoss).toBe(res.trade.entry);
  });
});

describe('v21.26.1 S10 — external exchange close IDLE telemetry', () => {
  afterEach(() => { __resetAutoTradeSuperAgentForTests(); __resetMtfAutoForTests(); });

  it('stamps EXCHANGE_POSITION_CLOSED and never reports a stale trail action as the IDLE reason', async () => {
    seed({
      executionMode: 'LIVE',
      liveOrderId: 'live-order-1',
      livePositionId: 'live-pos-1',
      openedAt: NOW - 5 * 60_000,
      superAgentState: 'MONITORING',
      superAgentIdleReason: null,
    });
    const { paper } = fakePaper();
    startAutoTradeSuperAgent({
      getOpenTrades: getAutoTradeSuperAgentOpenTrades,
      getCloseReason: getAutoTradeSuperAgentCloseReason,
      getQuoteFor: () => null,
      getBoardRow: () => null,
      getQuotes: () => ({}),
      getFx: async () => 102,
      getLiveCtx: async () => ({}),
      isKillSwitch: () => false,
      ensureSubs: vi.fn(),
      releaseSubs: vi.fn(),
      clientUp: vi.fn(),
      clientDown: vi.fn(),
      paper,
      notify: async () => {},
    });
    expect(autoTradeSuperAgentStatus().trades).toHaveLength(1);

    syncCoinDcxActivePositionsToDeepMonitor([], {
      now: Date.now(),
      authoritativeExchangeList: true,
      flatConfirmedSyms: ['BTC'],
    });
    const closedRow = mtfAutoStatus().book.find((b: any) => b.symbol === 'BTC' && b.status === 'CLOSED');
    expect(closedRow?.closeReason).toBe('EXCHANGE_POSITION_CLOSED');
    expect(closedRow?.superAgentState).toBe('IDLE');
    expect(closedRow?.superAgentIdleReason).toBe('EXCHANGE_POSITION_CLOSED');

    refreshAutoTradeSuperAgent();
    const st = autoTradeSuperAgentStatus();
    expect(st.trades).toHaveLength(0);
    expect(st.idle[0]?.reason).toBe('EXCHANGE_POSITION_CLOSED');
  });
});
