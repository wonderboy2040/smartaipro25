// ============================================================
// test/liveTp1PartialV21280.test.ts — F2 LIVE TP1 PARTIAL (safe reduce)
// ------------------------------------------------------------
// Audit finding F2: the paper engine books a TP1 partial, but LIVE positions
// had no partial at all — the native TP closed the whole position at T2, so a
// TP1 touch banked nothing. This suite locks the new flag-gated path:
//   • default OFF → legacy paper-only mirror (no exchange reduce)
//   • flag ON → exchange reduce FIRST, mirror books only after acceptance
//   • one-shot latch, in-flight lock, 60s retry / 5min ambiguous cooldown
//   • a failed reduce never books the mirror
//   • India rows are never sent to the CoinDCX reducer
// NOTE: real CoinDCX reduce behaviour is still [VERIFY-LIVE].
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tp1-partial-21280-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  mtfAutoSuperAgentManage, __resetMtfAutoForTests, mtfAutoStatus,
} from '../server/ai/mtfAutoLink.js';

const NOW = 1_765_000_000_000;

function liveRow(over: Record<string, any> = {}) {
  return {
    paperId: 777,
    executionMode: 'LIVE', traded: true, fullControl: true, openedInLiveMode: true,
    liveOrderId: 'ord-1', livePositionId: 'pos-1',
    openedBy: 'AUTO', autoTrade: true,
    symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', score: 88, tier: 'ELITE', mode: 'INTRADAY', holdMin: 45,
    entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99,
    peakPrice: 100, t1: 101, t2: 102, qty: 10, originalQty: 10, leverage: 5,
    feeBreakevenPrice: 100.2, atrPct: 1.0, volClass: 'NORMAL',
    momentumState: 'UNKNOWN', t1ClosePct: 0.5,
    openedAt: NOW - 5 * 60_000, status: 'OPEN', directionVerified: true,
    deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
    superAgentState: 'ARMED',
    ...over,
  };
}

function fakePaper(tradeOver: Record<string, any> = {}) {
  const order: string[] = [];
  const mirror: any = {
    id: 777, symbol: 'BTC', market: 'FUTURES', direction: 'LONG',
    status: 'OPEN', entry: 100, qty: 10, remainingQty: 10,
    stopLoss: 99, target1: 101, target2: 102,
    realizedPnl: 0, t1Hit: false, parts: [], openedAt: NOW - 5 * 60_000,
    ...tradeOver,
  };
  const calls = { booked: [] as any[] };
  const paper: any = {
    getPaperSummary: vi.fn(() => ({
      open: mirror.status === 'CLOSED' ? [] : [mirror],
      closedToday: [],
    })),
    bookPaperT1Partial: vi.fn((id: any, px: number) => {
      order.push('paper');
      calls.booked.push({ id, px });
      mirror.t1Hit = true;
      return { ok: true, trade: mirror, t1Pct: 0.5 };
    }),
    updatePaperTradeT1ClosePct: vi.fn(() => ({ ok: true })),
    updatePaperTradeStopLoss: vi.fn(() => ({ ok: true })),
    updatePaperTradeTarget2: vi.fn(() => ({ ok: true })),
    closePaperTrade: vi.fn(() => ({ ok: true })),
  };
  return { paper, mirror, calls, order };
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
    siteLiveByDesk: { crypto: true, india: false },
    killSwitch: false,
    liveUpdateSl: vi.fn(async () => ({ ok: true })),
    liveClose: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

function seed(rowOver: Record<string, any> = {}, cfgOver: Record<string, any> = {}) {
  __resetMtfAutoForTests({
    config: {
      enabled: true, executionMode: 'live', minScore: 75,
      desks: { india: false, crypto: true },
      ...cfgOver,
    },
    state: { book: [liveRow(rowOver)] },
  });
}

function bookRow() {
  return (mtfAutoStatus().book || []).find((b: any) => b.symbol === 'BTC');
}

const tick = (p: any, now = NOW, ltp = 101.2, over: Record<string, any> = {}) => mtfAutoSuperAgentManage({
  symbol: 'BTC', market: 'CRYPTO', ltp, tickAgeMs: 40,
  now, isRuntimeClock: false, p, ...over,
});

describe('v21.28.0 F2 live TP1 partial — flag OFF keeps legacy behaviour', () => {
  beforeEach(() => seed({}, { liveTp1Partial: false }));
  afterEach(() => __resetMtfAutoForTests());

  it('never calls the exchange reducer and still books the paper mirror', async () => {
    const { paper, calls } = fakePaper();
    const livePartial = vi.fn(async () => ({ ok: true, requestedQty: 5, postQty: 5, verified: true }));
    const out = await tick(agentP(paper, { livePartial }));

    expect(out.ok).toBe(true);
    expect(livePartial).not.toHaveBeenCalled();
    expect(calls.booked).toHaveLength(1);
    expect(bookRow()?.t1Hit).toBe(true);
    expect(bookRow()?.t1PartialBooked).not.toBe(true);
  });
});

describe('v21.28.0 F2 live TP1 partial — success path', () => {
  beforeEach(() => seed({}, { liveTp1Partial: true }));
  afterEach(() => __resetMtfAutoForTests());

  it('reduces the exchange FIRST, then books the mirror with the same size', async () => {
    const { paper, calls, order } = fakePaper();
    const livePartial = vi.fn(async () => {
      order.push('exchange');
      return { ok: true, requestedQty: 5, postQty: 5, orderId: 'red-1', verified: true };
    });
    const out = await tick(agentP(paper, { livePartial }));

    expect(out.ok).toBe(true);
    expect(order).toEqual(['exchange', 'paper']);
    expect(livePartial).toHaveBeenCalledTimes(1);
    expect(livePartial.mock.calls[0][0]).toMatchObject({
      symbol: 'BTC', side: 'LONG', livePositionId: 'pos-1', qty: 5,
    });
    expect(calls.booked[0]).toEqual({ id: 777, px: 101.2 });
    const row = bookRow();
    expect(row?.t1PartialBooked).toBe(true);
    expect(row?.t1PartialQty).toBe(5);
    expect(row?.t1PartialOrderId).toBe('red-1');
    expect(row?.t1PartialVerified).toBe(true);
    expect(row?.qty).toBe(5);
    expect(row?.qtyAfterTp1).toBe(5);
    expect(row?.t1Hit).toBe(true);
  });

  it('latches one-shot: a second tick never reduces again or re-books', async () => {
    const { paper, calls } = fakePaper();
    const livePartial = vi.fn(async () => ({ ok: true, requestedQty: 5, postQty: 5, verified: true }));
    await tick(agentP(paper, { livePartial }), NOW);
    await tick(agentP(paper, { livePartial }), NOW + 5_000, 101.4);

    expect(livePartial).toHaveBeenCalledTimes(1);
    expect(calls.booked).toHaveLength(1);
  });

  it('falls back to qty when originalQty is missing', async () => {
    seed({ originalQty: null }, { liveTp1Partial: true });
    const { paper } = fakePaper();
    const livePartial = vi.fn(async () => ({ ok: true, requestedQty: 5, postQty: 5, verified: true }));
    await tick(agentP(paper, { livePartial }));
    expect(livePartial.mock.calls[0][0].qty).toBe(5);
  });
});

describe('v21.28.0 F2 live TP1 partial — failure/cooldown semantics', () => {
  beforeEach(() => seed({}, { liveTp1Partial: true }));
  afterEach(() => __resetMtfAutoForTests());

  it('a rejected reduce never books the mirror and retries only after 60s', async () => {
    const { paper, calls } = fakePaper();
    const livePartial = vi.fn(async () => ({ ok: false, error: 'reduce rejected' }));
    const out = await tick(agentP(paper, { livePartial }), NOW);

    expect(out.ok).toBe(true);
    expect(calls.booked).toHaveLength(0);
    const row = bookRow();
    expect(row?.t1PartialBooked).not.toBe(true);
    expect(row?.t1PartialNextRetryAt).toBe(NOW + 60_000);
    expect(row?.t1PartialLastError).toContain('reduce rejected');

    await tick(agentP(paper, { livePartial }), NOW + 5_000);
    expect(livePartial).toHaveBeenCalledTimes(1);
    expect(calls.booked).toHaveLength(0);

    livePartial.mockImplementation(async () => ({ ok: true, requestedQty: 5, postQty: 5, verified: true }));
    await tick(agentP(paper, { livePartial }), NOW + 61_000);
    expect(livePartial).toHaveBeenCalledTimes(2);
    expect(calls.booked).toHaveLength(1);
    expect(bookRow()?.t1PartialBooked).toBe(true);
  });

  it('an ambiguous outcome gets a 5-minute cooldown (never a blind retry)', async () => {
    const { paper, calls } = fakePaper();
    const livePartial = vi.fn(async () => ({ ok: false, ambiguous: true, error: 'order state unknown' }));
    await tick(agentP(paper, { livePartial }), NOW);

    const row = bookRow();
    expect(row?.t1PartialAmbiguous).toBe(true);
    expect(row?.t1PartialNextRetryAt).toBe(NOW + 5 * 60_000);
    expect(calls.booked).toHaveLength(0);

    await tick(agentP(paper, { livePartial }), NOW + 61_000);
    expect(livePartial).toHaveBeenCalledTimes(1);

    await tick(agentP(paper, { livePartial }), NOW + 5 * 60_000 + 1);
    expect(livePartial).toHaveBeenCalledTimes(2);
  });

  it('a missing adapter records an error and retries after 60s', async () => {
    const { paper, calls } = fakePaper();
    const out = await tick(agentP(paper)); // no livePartial

    expect(out.ok).toBe(true);
    expect(calls.booked).toHaveLength(0);
    const row = bookRow();
    expect(row?.t1PartialLastError).toContain('livePartial adapter unavailable');
    expect(row?.t1PartialNextRetryAt).toBe(NOW + 60_000);
  });

  it('in-flight lock prevents the 3s/15s lanes double-reducing', async () => {
    const { paper, calls } = fakePaper();
    let release: ((v: any) => void) | null = null;
    const livePartial = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const p = agentP(paper, { livePartial });

    const first = tick(p, NOW);
    // livePartial is invoked synchronously before the first await resolves.
    const second = await tick(p, NOW + 100);

    expect(livePartial).toHaveBeenCalledTimes(1);
    expect(calls.booked).toHaveLength(0);
    expect(second.ok).toBe(true);

    release!({ ok: true, requestedQty: 5, postQty: 5, verified: true });
    const firstOut = await first;
    expect(firstOut.ok).toBe(true);
    expect(calls.booked).toHaveLength(1);
    expect(bookRow()?.t1PartialBooked).toBe(true);
  });
});

describe('v21.28.0 F2 live TP1 partial — market routing safety', () => {
  afterEach(() => __resetMtfAutoForTests());

  it('India LIVE rows never reach the CoinDCX reducer', async () => {
    seed({
      symbol: 'RELIANCE', market: 'INDIA', execMarket: 'INDIA', ccy: 'INR',
      livePositionId: 'in-pos-1', liveOrderId: 'in-ord-1', pair: 'B-RELIANCE',
    }, { liveTp1Partial: true });
    const { paper, calls } = fakePaper({ id: 777, symbol: 'RELIANCE', market: 'INDIA', entry: 100 });
    const livePartial = vi.fn(async () => ({ ok: true }));
    const out = await mtfAutoSuperAgentManage({
      symbol: 'RELIANCE', market: 'INDIA', ltp: 101.2, tickAgeMs: 40,
      now: NOW, isRuntimeClock: false,
      p: agentP(paper, { livePartial, siteLiveByDesk: { crypto: false, india: true } }),
    });

    expect(out.ok).toBe(true);
    expect(livePartial).not.toHaveBeenCalled();
    // Legacy mirror path still books (flag cannot disable India paper parity).
    expect(calls.booked).toHaveLength(1);
  });

  it('V3 enforce waits for close confirmation before reducing', async () => {
    const prev = process.env.EXIT_POLICY_V3;
    process.env.EXIT_POLICY_V3 = 'enforce';
    try {
      seed({ peakPrice: 101.2 }, { liveTp1Partial: true });
      const { paper, calls } = fakePaper();
      const livePartial = vi.fn(async () => ({ ok: true, requestedQty: 5, postQty: 5, verified: true }));
      // No closedCandles are cached for this symbol in this isolated test.
      await tick(agentP(paper, { livePartial }), NOW, 100.9);

      expect(livePartial).not.toHaveBeenCalled();
      expect(calls.booked).toHaveLength(0);
      expect(bookRow()?.t1PartialLastError).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.EXIT_POLICY_V3;
      else process.env.EXIT_POLICY_V3 = prev;
    }
  });
});
