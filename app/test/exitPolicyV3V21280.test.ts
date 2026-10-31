// ============================================================
// test/exitPolicyV3V21280.test.ts — F4 EXIT_POLICY_V3 (shadow → enforce)
// ------------------------------------------------------------
// Audit finding F4: a TP1 WICK (favourable extreme) latched the ladder and
// jumped the stop to raw fee-breakeven, scratching the runner before TP2.
//
// Locks:
//   • default mode = shadow (decisions unchanged)
//   • enforce = TP1 ladder only after a CLOSED bar closes beyond T1
//   • post-TP1 stop = fee-breakeven + volatility-classed buffer
//   • off / proExitPolicy:false = exact legacy behaviour
//   • honest unknown (null) when no closed-bar series is available
//   • SHORT mirror parity (BE − buffer)
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-policy-v3-21280-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  evaluateActiveTradeDeepMonitor, exitPolicyV3Mode, confirmTp1OnClosedBars,
} from '../server/ai/mtfAutoLink.js';

const NOW = 1_765_000_000_000;
const OPENED_AT = NOW - 10 * 60_000;

function dmTrade(over: Record<string, any> = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 100, openedAt: OPENED_AT,
    proExitPolicy: true,
    ...over,
  };
}

function bar(ts: number, close: number, over: Record<string, any> = {}) {
  return {
    ts,
    open: close - 0.1,
    high: close + 0.5,
    low: close - 0.5,
    close,
    ...over,
  };
}

const confirmedLong = () => [bar(NOW - 5 * 60_000, 100.9), bar(NOW - 300_000, 101.05)];
const wickOnlyLong = () => [bar(NOW - 5 * 60_000, 100.9), bar(NOW - 300_000, 100.8, { high: 101.4 })];

describe('v21.28.0 EXIT_POLICY_V3 — mode parsing', () => {
  const prev = process.env.EXIT_POLICY_V3;
  afterEach(() => {
    if (prev === undefined) delete process.env.EXIT_POLICY_V3;
    else process.env.EXIT_POLICY_V3 = prev;
  });

  it('defaults to shadow when unset', () => {
    delete process.env.EXIT_POLICY_V3;
    expect(exitPolicyV3Mode()).toBe('shadow');
  });

  it('accepts enforce aliases', () => {
    for (const v of ['enforce', 'on', '1', 'true', 'ENFORCE']) {
      process.env.EXIT_POLICY_V3 = v;
      expect(exitPolicyV3Mode()).toBe('enforce');
    }
  });

  it('accepts off aliases', () => {
    for (const v of ['off', '0', 'false', 'disabled']) {
      process.env.EXIT_POLICY_V3 = v;
      expect(exitPolicyV3Mode()).toBe('off');
    }
  });

  it('unknown values fail safe to shadow', () => {
    process.env.EXIT_POLICY_V3 = 'banana';
    expect(exitPolicyV3Mode()).toBe('shadow');
  });
});

describe('v21.28.0 confirmTp1OnClosedBars — close, not wick', () => {
  it('returns null when no usable series exists (honest unknown)', () => {
    expect(confirmTp1OnClosedBars({ closedCandles: null, side: 'LONG', t1: 101 })).toBeNull();
    expect(confirmTp1OnClosedBars({ closedCandles: [], side: 'LONG', t1: 101 })).toBeNull();
    expect(confirmTp1OnClosedBars({ closedCandles: wickOnlyLong(), side: null, t1: 101 })).toBeNull();
    expect(confirmTp1OnClosedBars({ closedCandles: wickOnlyLong(), side: 'LONG', t1: 0 })).toBeNull();
  });

  it('LONG: a bar CLOSE >= T1 confirms; a high wick does not', () => {
    const wick = confirmTp1OnClosedBars({ closedCandles: wickOnlyLong(), side: 'LONG', t1: 101 });
    expect(wick.confirmed).toBe(false);

    const close = confirmTp1OnClosedBars({ closedCandles: confirmedLong(), side: 'LONG', t1: 101 });
    expect(close.confirmed).toBe(true);
    expect(close.confirmedAt).toBe((NOW - 300_000));
  });

  it('SHORT mirror: a bar CLOSE <= T1 confirms', () => {
    const r = confirmTp1OnClosedBars({
      closedCandles: [bar(NOW - 300_000, 99.0, { low: 98.6 })],
      side: 'SHORT', t1: 99,
    });
    expect(r.confirmed).toBe(true);
  });

  it('sinceTs ignores pre-entry bars and rejects timestamp-less bars', () => {
    const bars = [
      bar(OPENED_AT - 300_000, 101.2), // pre-entry wick
      { open: 100, high: 101.5, low: 99.8, close: 101.1 }, // no timestamp
    ];
    const r = confirmTp1OnClosedBars({ closedCandles: bars, side: 'LONG', t1: 101, sinceTs: OPENED_AT });
    expect(r.confirmed).toBe(false);
    expect(r.timestamped).toBe(1);
    expect(r.bars).toBe(2);
  });

  it('without sinceTs an untimestamped close can confirm', () => {
    const r = confirmTp1OnClosedBars({
      closedCandles: [{ open: 100, high: 101.5, low: 99.8, close: 101.1 }],
      side: 'LONG', t1: 101,
    });
    expect(r.confirmed).toBe(true);
  });
});

describe('v21.28.0 EXIT_POLICY_V3 — shadow never changes decisions', () => {
  beforeEach(() => { delete process.env.EXIT_POLICY_V3; });

  it('wick TP1: legacy ladder still locks raw fee-breakeven, profile reported', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: wickOnlyLong() },
    );
    expect(ev.tp1Hit).toBe(true);
    expect(ev.tp1Confirmed).toBe(false);
    expect(ev.tp1LadderActive).toBe(true);
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.trailedStopLoss).toBeCloseTo(100.12, 6);
    expect(ev.exitPolicyV3).toMatchObject({
      mode: 'shadow', applied: false, shadow: true,
      tp1Touch: true, tp1CloseConfirmed: false,
    });
  });

  it('close-confirmed TP1 is reported but the shadow ladder stays at raw BE', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: confirmedLong() },
    );
    expect(ev.tp1Confirmed).toBe(true);
    expect(ev.tp1ConfirmSource).toBe('closed-candles');
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.trailedStopLoss).toBeCloseTo(100.12, 6);
    expect(ev.exitPolicyV3.beBufferR).toBeCloseTo(0.08, 6);
  });
});

describe('v21.28.0 EXIT_POLICY_V3 — enforce close-confirmed ladder', () => {
  const prev = process.env.EXIT_POLICY_V3;
  const prevPreTp1 = process.env.PRE_TP1_TRAIL;
  beforeEach(() => {
    process.env.EXIT_POLICY_V3 = 'enforce';
    // V3 ladder semantics are independent of the v21.31.0 pre-TP1 trail:
    // pin the older policy here so a wick-TP1 assertion never depends on it.
    process.env.PRE_TP1_TRAIL = 'off';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.EXIT_POLICY_V3;
    else process.env.EXIT_POLICY_V3 = prev;
    if (prevPreTp1 === undefined) delete process.env.PRE_TP1_TRAIL;
    else process.env.PRE_TP1_TRAIL = prevPreTp1;
  });

  it('wick-only TP1 does NOT latch: initial SL stands', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: wickOnlyLong() },
    );
    expect(ev.tp1Hit).toBe(true);
    expect(ev.tp1Confirmed).toBe(false);
    expect(ev.tp1LadderActive).toBe(false);
    expect(ev.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(ev.trailedStopLoss).toBe(99);
    expect(ev.stageLabel).toContain('awaiting closed-bar confirm');
    expect(ev.exitPolicyV3).toMatchObject({ mode: 'enforce', applied: true, shadow: false });
  });

  it('LONG close-confirmed TP1 locks fee-BE + volatility buffer (not raw BE)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: confirmedLong() },
    );
    expect(ev.tp1Confirmed).toBe(true);
    expect(ev.tp1LadderActive).toBe(true);
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.stageLabel).toContain('Close-Confirmed');
    expect(ev.trailedStopLoss).toBeCloseTo(100.20, 6); // 100.12 + 0.08R
    expect(ev.exitPolicyV3).toMatchObject({
      beBufferR: 0.08, beBufferPrice: 0.08,
      bePlusBufferSl: 100.2, legacyBeSl: 100.12,
    });
  });

  it('SHORT mirror locks fee-BE − buffer', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({
        side: 'SHORT', stopLoss: 101, initialStopLoss: 101,
        t1: 99, t2: 98, peakPrice: 98.9,
      }),
      { ltp: 99.0, closedCandles: [bar(NOW - 300_000, 98.98, { low: 98.7 })] },
    );
    expect(ev.side).toBe('SHORT');
    expect(ev.tp1Confirmed).toBe(true);
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.trailedStopLoss).toBeCloseTo(99.80, 6); // 99.88 − 0.08R
  });

  it('TP2 approach locks TP1 only after confirmation', () => {
    const confirmed = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.6 }),
      { ltp: 101.6, closedCandles: confirmedLong() },
    );
    expect(confirmed.tp2Approach).toBe(true);
    expect(confirmed.stageCode).toBe('STAGE_5_RUNNER_TO_TP2');
    expect(confirmed.trailedStopLoss).toBeCloseTo(101, 6);

    const wick = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.6 }),
      { ltp: 101.6, closedCandles: wickOnlyLong() },
    );
    expect(wick.tp2Approach).toBe(true);
    expect(wick.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(wick.trailedStopLoss).toBe(99);
  });

  it('no closed-bar data means unknown, never a fabricated confirm', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9 },
    );
    expect(ev.tp1Hit).toBe(true);
    expect(ev.tp1CloseConfirmedKnown).toBe(false);
    expect(ev.tp1Confirmed).toBe(false);
    expect(ev.tp1ConfirmSource).toBe('none');
    expect(ev.tp1LadderActive).toBe(false);
    expect(ev.trailedStopLoss).toBe(99);
  });

  it('an explicit trade stamp overrides candle inference', () => {
    const noCandles = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2, tp1CloseConfirmed: true }),
      { ltp: 100.9 },
    );
    expect(noCandles.tp1ConfirmSource).toBe('trade-stamp');
    expect(noCandles.tp1LadderActive).toBe(true);

    const vetoed = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2, tp1CloseConfirmed: false }),
      { ltp: 100.9, closedCandles: confirmedLong() },
    );
    expect(vetoed.tp1ConfirmSource).toBe('trade-stamp');
    expect(vetoed.tp1LadderActive).toBe(false);
    expect(vetoed.trailedStopLoss).toBe(99);
  });

  it('pre-confirm reversal stays a fee-safe scratch; post-confirm reversal books at T1', () => {
    const pre = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: wickOnlyLong(), reversalConfirmed: true },
    );
    expect(pre.exitReason).toBe('PRE_T1_REVERSAL_FEE_SAFE_SCRATCH');

    const post = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: confirmedLong(), reversalConfirmed: true },
    );
    expect(post.exitReason).toBe('T1_SECURED_REVERSAL_PROFIT_EXIT');
    expect(post.trailedStopLoss).toBeCloseTo(100.20, 6);
  });
});

describe('v21.28.0 EXIT_POLICY_V3 — off restores legacy exactly', () => {
  const prev = process.env.EXIT_POLICY_V3;
  afterEach(() => {
    if (prev === undefined) delete process.env.EXIT_POLICY_V3;
    else process.env.EXIT_POLICY_V3 = prev;
  });

  it('off mode reports inactive and never applies close-confirmation', () => {
    process.env.EXIT_POLICY_V3 = 'off';
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: wickOnlyLong() },
    );
    expect(ev.tp1LadderActive).toBe(true); // legacy touch ladder
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.trailedStopLoss).toBeCloseTo(100.12, 6);
    expect(ev.exitPolicyV3).toMatchObject({ mode: 'off', applied: false, shadow: false });
    expect(ev.exitPolicyV3.note).toContain('V3 inactive');
  });

  it('proExitPolicy:false keeps V3 off even when env says enforce', () => {
    process.env.EXIT_POLICY_V3 = 'enforce';
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 101.2 }),
      { ltp: 100.9, closedCandles: confirmedLong(), proExitPolicy: false },
    );
    expect(ev.exitPolicyV3.applied).toBe(false);
    expect(ev.exitPolicyV3.shadow).toBe(false);
  });
});
