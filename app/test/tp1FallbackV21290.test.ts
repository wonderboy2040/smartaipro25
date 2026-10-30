// ============================================================
// test/tp1FallbackV21290.test.ts — v21.29.0 R0b TP1 CONFIRM FALLBACK
// ------------------------------------------------------------
// Locks:
//   • default TP1_CONFIRM_FALLBACK = tick-hold (off = strict candles)
//   • fallback ONLY when the closed-candle series is missing/empty
//   • TWO evaluations + >=5s hold beyond T1 required (first eval unknown)
//   • a wick-only candle series can NEVER be overridden by the fallback
//   • one-way t1CloseConfirmedAt latch survives candle-cache loss
//   • stampTp1ConfirmHold increments the hold and persists the latch
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tp1-fallback-21290-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  evaluateActiveTradeDeepMonitor, tp1ConfirmFallbackMode, stampTp1ConfirmHold,
  TP1_FALLBACK_MIN_MS, TP1_FALLBACK_MIN_TICKS,
} from '../server/ai/mtfAutoLink.js';

const NOW = Date.now();
const OPENED_AT = NOW - 10 * 60_000;

function trade(over: Record<string, any> = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 101.2, openedAt: OPENED_AT,
    proExitPolicy: true,
    ...over,
  };
}
function bar(ts: number, close: number, over: Record<string, any> = {}) {
  return { ts, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, ...over };
}

const prevV3 = process.env.EXIT_POLICY_V3;
const prevFb = process.env.TP1_CONFIRM_FALLBACK;
beforeEach(() => {
  process.env.EXIT_POLICY_V3 = 'enforce';
  delete process.env.TP1_CONFIRM_FALLBACK;
});
afterEach(() => {
  if (prevV3 === undefined) delete process.env.EXIT_POLICY_V3; else process.env.EXIT_POLICY_V3 = prevV3;
  if (prevFb === undefined) delete process.env.TP1_CONFIRM_FALLBACK; else process.env.TP1_CONFIRM_FALLBACK = prevFb;
});

describe('v21.29.0 R0b — fallback mode parsing', () => {
  it('defaults to tick-hold; off disables it', () => {
    delete process.env.TP1_CONFIRM_FALLBACK;
    expect(tp1ConfirmFallbackMode()).toBe('tick-hold');
    for (const v of ['off', '0', 'false', 'disabled']) {
      process.env.TP1_CONFIRM_FALLBACK = v;
      expect(tp1ConfirmFallbackMode()).toBe('off');
    }
  });
});

describe('v21.29.0 R0b — t1 hold fallback', () => {
  it('first evaluation with no candles stays unknown (no fabricated confirm)', () => {
    const ev = evaluateActiveTradeDeepMonitor(trade(), { ltp: 101.2, now: NOW });
    expect(ev.closedCandlesMissing).toBe(true);
    expect(ev.tp1Confirmed).toBe(false);
    expect(ev.tp1ConfirmSource).toBe('none');
    expect(ev.tp1LadderActive).toBe(false);
    expect(ev.tp1FallbackMode).toBe('tick-hold');
  });

  it('>=2 ticks and >=5s beyond T1 confirms only when candles are missing', () => {
    const ev = evaluateActiveTradeDeepMonitor(trade({
      t1BeyondSince: NOW - TP1_FALLBACK_MIN_MS,
      t1BeyondTicks: TP1_FALLBACK_MIN_TICKS,
    }), { ltp: 101.2, now: NOW });
    expect(ev.tp1Confirmed).toBe(true);
    expect(ev.tp1ConfirmSource).toBe('tick-hold-fallback');
    expect(ev.tp1LadderActive).toBe(true);
    expect(ev.tp1ConfirmedAt).toBe(NOW - TP1_FALLBACK_MIN_MS);
    expect(ev.exitPolicyV3.fallbackEligible).toBe(true);
  });

  it('one tick short or 4.9s short stays unconfirmed', () => {
    const oneTick = evaluateActiveTradeDeepMonitor(trade({
      t1BeyondSince: NOW - 60_000, t1BeyondTicks: 1,
    }), { ltp: 101.2, now: NOW });
    expect(oneTick.tp1Confirmed).toBe(false);
    const tooSoon = evaluateActiveTradeDeepMonitor(trade({
      t1BeyondSince: NOW - 4_900, t1BeyondTicks: 9,
    }), { ltp: 101.2, now: NOW });
    expect(tooSoon.tp1Confirmed).toBe(false);
  });

  it('a wick-only candle series NEVER lets the fallback confirm', () => {
    const ev = evaluateActiveTradeDeepMonitor(trade({
      t1BeyondSince: NOW - 60_000, t1BeyondTicks: 9,
    }), {
      ltp: 101.2, now: NOW,
      closedCandles: [
        bar(NOW - 5 * 60_000, 100.9),
        bar(NOW - 300_000, 100.8, { high: 101.4 }),
      ],
    });
    expect(ev.closedCandlesMissing).toBe(false);
    expect(ev.tp1Confirmed).toBe(false);
    expect(ev.tp1ConfirmSource).toBe('closed-candles');
    expect(ev.exitPolicyV3.fallbackEligible).toBe(false);
  });

  it('TP1_CONFIRM_FALLBACK=off keeps strict candle-only behaviour', () => {
    process.env.TP1_CONFIRM_FALLBACK = 'off';
    const ev = evaluateActiveTradeDeepMonitor(trade({
      t1BeyondSince: NOW - 60_000, t1BeyondTicks: 9,
    }), { ltp: 101.2, now: NOW });
    expect(ev.tp1Confirmed).toBe(false);
    expect(ev.tp1ConfirmSource).toBe('none');
    expect(ev.tp1FallbackMode).toBe('off');
  });

  it('persisted t1CloseConfirmedAt is a one-way latch (candles missing)', () => {
    const ev = evaluateActiveTradeDeepMonitor(trade({
      tp1CloseConfirmedAt: NOW - 120_000, peakPrice: 101.2,
    }), { ltp: 100.9, now: NOW });
    expect(ev.tp1Confirmed).toBe(true);
    expect(ev.tp1ConfirmSource).toBe('persisted-latch');
    expect(ev.tp1LadderActive).toBe(true);
    expect(ev.tp1ConfirmedAt).toBe(NOW - 120_000);
  });

  it('SHORT mirror: hold beyond T1 confirms the same way', () => {
    const ev = evaluateActiveTradeDeepMonitor(trade({
      side: 'SHORT', stopLoss: 101, initialStopLoss: 101, t1: 99, t2: 98,
      entry: 100, entryPrice: 100, peakPrice: 98.8,
      t1BeyondSince: NOW - 60_000, t1BeyondTicks: 2,
    }), { ltp: 98.8, now: NOW });
    expect(ev.tp1Confirmed).toBe(true);
    expect(ev.tp1ConfirmSource).toBe('tick-hold-fallback');
  });
});

describe('v21.29.0 R0b — stampTp1ConfirmHold', () => {
  it('first call starts the hold; second call increments; confirmation latches once', () => {
    const b: Record<string, any> = { side: 'LONG', t1: 101, peakPrice: 101.2 };
    const ev0 = evaluateActiveTradeDeepMonitor(trade(), { ltp: 101.2, now: NOW });
    const s1 = stampTp1ConfirmHold(b, ev0, { now: NOW, closedCandles: null });
    expect(s1.holdSince).toBe(NOW);
    expect(s1.holdTicks).toBe(1);
    expect(b.tp1CloseConfirmedAt).toBeUndefined();

    const ev1 = evaluateActiveTradeDeepMonitor({ ...trade(), ...b }, { ltp: 101.2, now: NOW + 1_000 });
    const s2 = stampTp1ConfirmHold(b, ev1, { now: NOW + 1_000, closedCandles: null });
    expect(s2.holdTicks).toBe(2);
    expect(s2.confirmed).toBe(false);

    const ev2 = evaluateActiveTradeDeepMonitor({ ...trade(), ...b }, { ltp: 101.2, now: NOW + 6_000 });
    expect(ev2.tp1Confirmed).toBe(true);
    expect(ev2.tp1ConfirmSource).toBe('tick-hold-fallback');
    const s3 = stampTp1ConfirmHold(b, ev2, { now: NOW + 6_000, closedCandles: null });
    expect(s3.confirmed).toBe(true);
    expect(b.tp1CloseConfirmedAt).toBe(ev2.tp1ConfirmedAt);

    // One-way: a later missing-candle evaluation with a pullback stays latched.
    const later = evaluateActiveTradeDeepMonitor({ ...trade(), ...b }, { ltp: 100.5, now: NOW + 60_000 });
    expect(later.tp1Confirmed).toBe(true);
    expect(later.tp1ConfirmSource).toBe('persisted-latch');
  });

  it('pullback before confirmation resets the hold window', () => {
    const b: Record<string, any> = { side: 'LONG', t1: 101, peakPrice: 101.2, t1BeyondSince: NOW - 3_000, t1BeyondTicks: 1 };
    const evPullback = evaluateActiveTradeDeepMonitor({ ...trade(), peakPrice: 100.8 }, { ltp: 100.8, now: NOW });
    const s = stampTp1ConfirmHold(b, evPullback, { now: NOW, closedCandles: null });
    expect(s.holdSince).toBeNull();
    expect(s.holdTicks).toBe(0);
  });
});
