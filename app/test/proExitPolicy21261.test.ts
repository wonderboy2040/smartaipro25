// ============================================================
// test/proExitPolicy21261.test.ts - PRO TRADER EXIT LADDER
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "TP1 reach hone se pehle SL trail bilkul
// nahi hona chahiye - ek ek baar trade pull back karta hai, usse reversal
// mat samjho. TP1 ke baad SL entry/fee-breakeven par trail ho, TP2 ke
// karib aate hi SL TP1 ke karib aaye, aur TP2 hit hote hi trade close.
// Agar TP1 se pehle pakka reversal ho to open+close fees dekh kar no-loss
// close karo. Daily trade quota unlimited kardo."
//
// These tests lock the exact ladder:
//   pre-TP1  -> initial SL LOCKED (no stage trail / no defensive tighten)
//   TP1      -> SL at fee-breakeven
//   TP2 >=80%-> SL at TP1
//   TP2 hit  -> full close
//   reversal -> fee-covered scratch ONLY (otherwise initial SL backstop)
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-pro-exit-21261-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  evaluateActiveTradeDeepMonitor, mtfAutoTick, mtfAutoStatus,
  updateMtfAutoConfig, loadMtfAutoConfig, __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';

const NOW = 1_765_000_000_000;

function dmTrade(over = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 100, openedAt: NOW - 10 * 60_000,
    proExitPolicy: true,
    ...over,
  };
}

function flipRow(side = 'SHORT') {
  return { side, triggerFired: true, superScore: 85 };
}

// Tick harness (same contract as test/mtfAutoLink.test.ts).
function fakePaper() {
  const calls = { opened: [] };
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 700 + calls.opened.length, ...input };
      paper.open.push({
        id: trade.id, symbol: input.symbol, market: input.market,
        status: 'OPEN', direction: input.direction, openedAt: Date.now(),
      });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id) => {
      paper.open = paper.open.filter(t => t.id !== id);
      return { ok: true, trade: { id, realizedPnl: 10 } };
    }),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  return { paper, calls };
}

function boardFixture(symbol = 'BTCUSDT') {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol, market: 'CRYPTO', mode: 'INTRADAY', label: '15m -> 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      drivers: ['dual-TF confirm'],
    }],
  };
}

describe('v21.26.1 PRO ladder - pre-TP1 initial SL is untouchable', () => {
  it('normal +0.22R pop then pullback does NOT trail or close (the -Rs.24 root cause)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.22 }),
      { ltp: 100.05, preTp1Trail: 'off' },
    );
    expect(ev.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(ev.trailedStopLoss).toBe(99);          // initial SL untouched
    expect(ev.slTrailed).toBe(false);
    expect(ev.shouldBookProfitNow).toBe(false);
    expect(ev.shouldClose).toBe(false);
    expect(ev.exitReason).toBeNull();
  });

  it('reversalRisk / exhaustion hint before TP1 never tightens the stop', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      {
        ltp: 100.6,
        preTp1Trail: 'off',
        boardRow: { side: 'LONG', triggerFired: true, superScore: 85, reversalRisk: true, context: { exhausted: true } },
      },
    );
    expect(ev.trailedStopLoss).toBe(99);
    expect(ev.shouldClose).toBe(false);
    expect(ev.stageLabel).not.toContain('Reversal-Risk');
  });

  it('deep giveback (peak 0.95R -> 0.50R) is HOLD pre-TP1, not a reversal book', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.95 }),
      { ltp: 100.5, preTp1Trail: 'off' },
    );
    expect(ev.tp1Hit).toBe(false);
    expect(ev.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(ev.trailedStopLoss).toBe(99);
    expect(ev.shouldBookProfitNow).toBe(false);
  });

  it('a genuine initial-SL hit still protects capital', () => {
    const ev = evaluateActiveTradeDeepMonitor(dmTrade(), { ltp: 98.9 });
    expect(ev.shouldClose).toBe(true);
    expect(ev.exitReason).toBe('INITIAL_SL_PROTECTIVE_EXIT');
  });
});

describe('v21.26.1 PRO ladder - pre-TP1 confirmed reversal = fee-safe scratch', () => {
  it('confirmed board flip with fees covered closes at no loss', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.2 }),
      { ltp: 100.2, boardRow: flipRow('SHORT') },
    );
    // fee-breakeven for FUTURES = entry + 0.12% = 100.12
    expect(ev.feeBreakevenPrice).toBeCloseTo(100.12, 6);
    expect(ev.feeCovered).toBe(true);
    expect(ev.shouldBookProfitNow).toBe(true);
    expect(ev.shouldClose).toBe(true);
    expect(ev.exitReason).toBe('PRE_T1_REVERSAL_FEE_SAFE_SCRATCH');
    expect(ev.trailedStopLoss).toBe(99); // scratch exit, never a tighter stop
  });

  it('confirmed flip below fee-breakeven holds (no-loss is impossible there)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 99.95 }),
      { ltp: 99.9, boardRow: flipRow('SHORT') },
    );
    expect(ev.feeCovered).toBe(false);
    expect(ev.shouldBookProfitNow).toBe(false);
    expect(ev.shouldClose).toBe(false);
    expect(ev.trailedStopLoss).toBe(99);
  });
});

describe('v21.26.1 PRO ladder - TP1 / TP2 checkpoints', () => {
  it('TP1 hit locks SL at fee-breakeven (not at +0.65R)', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101 }),
      { ltp: 100.9 },
    );
    expect(ev.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(ev.trailedStopLoss).toBeCloseTo(100.12, 6);
    expect(ev.trailedStopLoss).toBeGreaterThanOrEqual(100);
    expect(ev.shouldClose).toBe(false);
  });

  it('TP2 progress >= 80% moves SL to TP1', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101.6 }),
      { ltp: 101.6 },
    );
    expect(ev.tp2ProgressPct).toBe(80);
    expect(ev.tp2Approach).toBe(true);
    expect(ev.stageCode).toBe('STAGE_5_RUNNER_TO_TP2');
    expect(ev.trailedStopLoss).toBeCloseTo(101, 6);
    expect(ev.shouldClose).toBe(false);
  });

  it('TP2 approach is peak-based: an 80% spike then pullback still locks SL at TP1', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 101.6 }),
      { ltp: 101.2 },
    );
    expect(ev.tp2ProgressPct).toBe(80);
    expect(ev.tp2Approach).toBe(true);
    expect(ev.stageCode).toBe('STAGE_5_RUNNER_TO_TP2');
    expect(ev.trailedStopLoss).toBeCloseTo(101, 6);
    expect(ev.shouldClose).toBe(false); // 101.2 is still above the TP1 lock
  });

  it('TP2 hit closes the full position', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ t1Hit: true, peakPrice: 102 }),
      { ltp: 102 },
    );
    expect(ev.tp2Hit).toBe(true);
    expect(ev.shouldBookProfitNow).toBe(true);
    expect(ev.shouldClose).toBe(true);
    expect(ev.exitReason).toBe('TP2_TARGET_HIT_FULL_PROFIT');
  });

  it('SHORT mirror: TP1 -> fee-BE 99.88, TP2 approach -> TP1 99', () => {
    const shortBase = dmTrade({
      side: 'SHORT', stopLoss: 101, initialStopLoss: 101, t1: 99, t2: 98,
      t1Hit: true, peakPrice: 99,
    });
    const tp1 = evaluateActiveTradeDeepMonitor(shortBase, { ltp: 99.1 });
    expect(tp1.stageCode).toBe('STAGE_4_TP1_LOCKED');
    expect(tp1.trailedStopLoss).toBeCloseTo(99.88, 6);

    const nearTp2 = evaluateActiveTradeDeepMonitor(
      { ...shortBase, peakPrice: 98.4 },
      { ltp: 98.4 },
    );
    expect(nearTp2.tp2ProgressPct).toBe(80);
    expect(nearTp2.stageCode).toBe('STAGE_5_RUNNER_TO_TP2');
    expect(nearTp2.trailedStopLoss).toBeCloseTo(99, 6);
  });
});

describe('v21.26.1 PRO ladder - TP2 is fixed, never rolled', () => {
  it('SURGING board + smart-trail ENFORCE keeps the original TP2 (full exit on time)', () => {
    const prevMode = process.env.SMART_TRAIL_V2;
    process.env.SMART_TRAIL_V2 = 'enforce';
    try {
      const ev = evaluateActiveTradeDeepMonitor(
        dmTrade({ t1Hit: true, peakPrice: 101.8, atrPct: 0.45, momentumState: 'SURGING' }),
        {
          ltp: 101.8,
          proExitPolicy: true,
          boardRow: {
            side: 'LONG', triggerFired: true, superScore: 88,
            trigger: { roc1: 0.2, roc3: 0.6, volRatio: 1.6 },
            context: { atrPct: 0.45 },
          },
        },
      );
      // Shadow telemetry honestly still reports the legacy engine's new target…
      expect(ev.smartTrail?.wouldExtendT2).toBeCloseTo(103, 6);
      expect(ev.smartTrail?.wouldExtendBeforeTarget).toBe(true);
      // …but PRO policy never adopts it: TP2 stays the real full-exit level.
      expect(ev.t2).toBe(102);
      expect(ev.t2Extended).toBe(false);
      expect(ev.t2Extensions).toBe(0);
      expect(ev.tp2ProgressPct).toBe(90);
      expect(ev.shouldClose).toBe(false); // 101.8 still below the fixed 102
    } finally {
      if (prevMode === undefined) delete process.env.SMART_TRAIL_V2;
      else process.env.SMART_TRAIL_V2 = prevMode;
    }
  });
});

describe('v21.26.1 daily trade quota unlimited (0 sentinel)', () => {
  it('config keeps 0 and still clamps hostile 999 -> 25', () => {
    __resetMtfAutoForTests();
    expect(updateMtfAutoConfig({ maxTradesPerDay: 0 }).maxTradesPerDay).toBe(0);
    expect(loadMtfAutoConfig().maxTradesPerDay).toBe(0);
    expect(updateMtfAutoConfig({ maxTradesPerDay: 999 }).maxTradesPerDay).toBe(25);
  });

  it('maxTradesPerDay=0 never blocks entries (quota gate gone)', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', maxTradesPerDay: 0,
        maxOpenPositions: 2, desks: { india: false, crypto: true },
      },
    });
    const { paper, calls } = fakePaper();
    const out1 = await mtfAutoTick({ boards: { CRYPTO: boardFixture('BTCUSDT') }, paper });
    expect(out1.opened).toHaveLength(1);
    expect(out1.skipped.join(' ')).not.toMatch(/daily quota|desk quota/);
    const out2 = await mtfAutoTick({ boards: { CRYPTO: boardFixture('ETHUSDT') }, paper });
    expect(out2.opened).toHaveLength(1);
    expect(out2.skipped.join(' ')).not.toMatch(/daily quota|desk quota/);
    expect(calls.opened).toHaveLength(2);
    const st = mtfAutoStatus();
    expect(st.maxTradesPerDay).toBe(0);
    expect(st.quotaUnlimited).toBe(true);
    expect(st.proExitPolicy).toBe(true);
  });
});
