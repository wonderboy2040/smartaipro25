// ============================================================
// test/preTp1NoLossTrailV21310.test.ts — v21.31.0 PRE-TP1 NO-LOSS SMART TRAIL
// ------------------------------------------------------------
// USER SPEC: Auto Trade lagne ke baad AI agent ko TP1 ka wait nahi karna —
// highest volatility me smart SL trail, no-loss-only-profit floor, live
// direction/trend ke hisaab se tighten. Ratchet-only: SL kabhi loose nahi.
//
// LOCKS:
//   T1  LONG arm → fee-breakeven + vol buffer (not raw entry)
//   T2  below arm threshold = initial SL untouched
//   T3  fee not covered = never arm
//   T4  HIGH/EXTREME arm later + wider giveback (volatility-aware)
//   T5  adverse live trend tightens only (never loosens)
//   T6  SHORT mirror parity
//   T7  shadow/off never move the stop
//   T8  no proposal at/through LTP + strict ratchet
//   T9  stale quote (`allowMove:false`) cannot ratchet
//   T10 deep-monitor integration + stage code
//   T11 trail hit books fee-safe profit; gap-through is labelled honestly
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-tp1-trail-21310-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  evaluatePreTp1NoLossTrail, PRE_TP1_VOL_PROFILE,
} from '../server/ai/preTp1Trail.js';
import {
  evaluateActiveTradeDeepMonitor, preTp1TrailMode,
} from '../server/ai/mtfAutoLink.js';

const NOW = 1_765_000_000_000;

const base = {
  mode: 'enforce',
  side: 'LONG',
  entry: 100,
  initialStopLoss: 99,
  currentStopLoss: 99,
  peakPrice: 100,
  ltp: 100,
  risk: 1,
  feeFloor: 100.12, // FUTURES 0.12% round trip
  volClass: 'NORMAL',
  momentumState: 'STEADY',
};

function dmTrade(over: Record<string, any> = {}) {
  return {
    symbol: 'BTCUSDT', market: 'FUTURES', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, entryPrice: 100, stopLoss: 99, initialStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 100, openedAt: NOW - 10 * 60_000,
    proExitPolicy: true,
    ...over,
  };
}

describe('v21.31.0 pre-TP1 no-loss trail — pure engine', () => {
  it('T1 LONG arms at +0.38R and locks fee-breakeven + 0.10R buffer', () => {
    const out = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 100.6, ltp: 100.6 });
    expect(out.mode).toBe('enforce');
    expect(out.armed).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.armR).toBe(0.38);
    expect(out.noLossSl).toBeCloseTo(100.22, 6);
    expect(out.proposedSl).toBeCloseTo(100.22, 6);
    expect(out.lockedProfitR).toBe(0.22);
    expect(out.ratchetOnly).toBe(true);
    // Never a raw break-even: the buffer is strictly above fee floor.
    expect(out.proposedSl).toBeGreaterThan(100.12);
  });

  it('T2 a +0.22R pop is below the arm threshold — initial SL untouched', () => {
    const out = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 100.22, ltp: 100.05 });
    expect(out.armed).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.proposedSl).toBeNull();
    expect(out.reason).toBe('below_arm_threshold');
  });

  it('T3 fee not covered never arms, even at a large favourable excursion', () => {
    const out = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.08, ltp: 100.08, feeFloor: 100.5,
    });
    expect(out.armed).toBe(false);
    expect(out.reason).toBe('fee_not_covered');
  });

  it('T4 higher volatility arms later and keeps a wider giveback', () => {
    const normal = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 101, ltp: 101 });
    const high = evaluatePreTp1NoLossTrail({ ...base, volClass: 'HIGH', peakPrice: 101, ltp: 101 });
    const extreme = evaluatePreTp1NoLossTrail({ ...base, volClass: 'EXTREME', peakPrice: 101, ltp: 101 });
    expect(PRE_TP1_VOL_PROFILE.EXTREME.armR).toBeGreaterThan(PRE_TP1_VOL_PROFILE.HIGH.armR);
    expect(PRE_TP1_VOL_PROFILE.HIGH.armR).toBeGreaterThan(PRE_TP1_VOL_PROFILE.NORMAL.armR);
    expect(high.givebackR).toBeGreaterThan(normal.givebackR);
    expect(extreme.givebackR).toBeGreaterThan(high.givebackR);
    expect(extreme.proposedSl).toBeLessThan(high.proposedSl); // wider room, same peak
    expect(extreme.proposedSl).toBeGreaterThan(100.12);         // still fee-safe
  });

  it('T5 adverse live trend tightens the giveback, favourable never loosens it', () => {
    const steady = evaluatePreTp1NoLossTrail({ ...base, peakPrice: 100.6, ltp: 100.6 });
    const adverse = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.6, tickTrendPct: -0.12, tickTrendAdverse: true,
    });
    const favourable = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.6, tickTrendPct: 0.30,
    });
    expect(adverse.trendAdverse).toBe(true);
    expect(adverse.givebackR).toBeLessThan(steady.givebackR);
    expect(adverse.proposedSl).toBeGreaterThan(steady.proposedSl); // LONG tightens upward
    expect(adverse.proposedSl).toBeGreaterThanOrEqual(adverse.noLossSl);
    expect(favourable.proposedSl).toBe(steady.proposedSl);          // no loosening/widening
  });

  it('T6 SHORT mirror: fee floor − buffer, wider adverse lock, strict ratchet', () => {
    const shortBase = {
      ...base, side: 'SHORT', initialStopLoss: 101, currentStopLoss: 101,
      feeFloor: 99.88,
    };
    const out = evaluatePreTp1NoLossTrail({ ...shortBase, peakPrice: 99.2, ltp: 99.2 });
    expect(out.side).toBe('SHORT');
    expect(out.armed).toBe(true);
    expect(out.noLossSl).toBeCloseTo(99.78, 6);
    // At +0.8R the giveback trail (99.62) is tighter than the fee floor and
    // therefore the correct SHORT proposal (lower = more profit locked).
    expect(out.proposedSl).toBeCloseTo(99.62, 6);
    expect(out.proposedSl).toBeLessThanOrEqual(out.noLossSl);
    expect(out.proposedSl).toBeLessThan(99.88);

    const adverse = evaluatePreTp1NoLossTrail({
      ...shortBase, peakPrice: 99.2, ltp: 99.2, tickTrendAdverse: true,
    });
    expect(adverse.proposedSl).toBeLessThan(out.proposedSl); // SHORT tightens downward

    const alreadyTighter = evaluatePreTp1NoLossTrail({
      ...shortBase, currentStopLoss: 99.5, peakPrice: 99.2, ltp: 99.2,
    });
    expect(alreadyTighter.applied).toBe(false);
    expect(alreadyTighter.reason).toBe('no_improvement');
  });

  it('T7 shadow reports the proposal without applying; off is inactive', () => {
    const shadow = evaluatePreTp1NoLossTrail({
      ...base, mode: 'shadow', peakPrice: 100.6, ltp: 100.6,
    });
    expect(shadow.armed).toBe(true);
    expect(shadow.applied).toBe(false);
    expect(shadow.proposedSl).toBeNull();
    expect(shadow.wouldApplySl).toBeCloseTo(100.22, 6);

    const off = evaluatePreTp1NoLossTrail({
      ...base, mode: 'off', peakPrice: 100.6, ltp: 100.6,
    });
    expect(off.available).toBe(false);
    expect(off.armed).toBe(false);
    expect(off.applied).toBe(false);
    expect(off.reason).toBe('mode_off');
  });

  it('T8 never proposes at/through LTP and never loosens an existing stop', () => {
    const cross = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.205,
    });
    expect(cross.armed).toBe(true);
    expect(cross.applied).toBe(false);
    expect(cross.reason).toBe('would_cross_ltp');
    expect(cross.proposedSl).toBeNull();

    const alreadyBetter = evaluatePreTp1NoLossTrail({
      ...base, currentStopLoss: 100.5, peakPrice: 100.6, ltp: 100.6,
    });
    expect(alreadyBetter.applied).toBe(false);
    expect(alreadyBetter.reason).toBe('no_improvement');
  });

  it('T9 stale quote (allowMove:false) computes telemetry but cannot ratchet', () => {
    const stale = evaluatePreTp1NoLossTrail({
      ...base, peakPrice: 100.6, ltp: 100.6, allowMove: false,
    });
    expect(stale.armed).toBe(true);
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('move_not_allowed');
    expect(stale.wouldApplySl).toBeCloseTo(100.22, 6);
  });

  it('invalid side / missing fee floor fail closed', () => {
    expect(evaluatePreTp1NoLossTrail({ ...base, side: 'SIDEWAYS' }).reason).toBe('invalid_side');
    expect(evaluatePreTp1NoLossTrail({ ...base, feeFloor: 0 }).reason).toBe('missing_fee_floor');
  });
});

describe('v21.31.0 pre-TP1 no-loss trail — deep-monitor integration', () => {
  const prev = process.env.PRE_TP1_TRAIL;
  beforeEach(() => { delete process.env.PRE_TP1_TRAIL; });
  afterEach(() => {
    if (prev === undefined) delete process.env.PRE_TP1_TRAIL;
    else process.env.PRE_TP1_TRAIL = prev;
  });

  it('T10a enforce is the default and ratchets the PRO pre-TP1 stop', () => {
    expect(preTp1TrailMode()).toBe('enforce');
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6 },
    );
    expect(ev.stageCode).toBe('STAGE_0B_PRE_TP1_TRAIL');
    expect(ev.slTrailed).toBe(true);
    expect(ev.trailedStopLoss).toBeCloseTo(100.22, 6);
    expect(ev.preTp1Trail).toMatchObject({
      mode: 'enforce', armed: true, applied: true, volClass: 'NORMAL',
    });
    expect(ev.exitReason).toBeNull();
    expect(ev.shouldClose).toBe(false);
  });

  it('T10b shadow/off are telemetry-only and preserve the initial SL', () => {
    const shadow = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, preTp1Trail: 'shadow' },
    );
    expect(shadow.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(shadow.trailedStopLoss).toBe(99);
    expect(shadow.slTrailed).toBe(false);
    expect(shadow.preTp1Trail?.wouldApplySl).toBeCloseTo(100.22, 6);

    const off = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, preTp1Trail: 'off' },
    );
    expect(off.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(off.trailedStopLoss).toBe(99);
    expect(off.preTp1Trail?.available).toBe(false);
  });

  it('T10c adverse live tick trend tightens the proposal', () => {
    const steady = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6 },
    );
    const adverse = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6 }),
      { ltp: 100.6, tickTrendPct: -0.10, tickTrendAdverse: true },
    );
    expect(adverse.trailedStopLoss).toBeGreaterThan(steady.trailedStopLoss);
    expect(adverse.preTp1Trail?.trendAdverse).toBe(true);
    expect(adverse.trailedStopLoss).toBeLessThan(100.6); // never cross LTP
  });

  it('T10c2 EXTREME volatility keeps a wider giveback than HIGH', () => {
    const high = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.8, atrPct: 2.0 }),
      { ltp: 100.8 },
    );
    const extreme = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.8, atrPct: 4.0 }),
      { ltp: 100.8 },
    );
    expect(high.preTp1Trail?.volClass).toBe('HIGH');
    expect(extreme.preTp1Trail?.volClass).toBe('EXTREME');
    expect(extreme.preTp1Trail!.givebackR!).toBeGreaterThan(high.preTp1Trail!.givebackR!);
    expect(extreme.preTp1Trail!.armR).toBeGreaterThan(high.preTp1Trail!.armR);
    // EXTREME keeps a bigger fee-buffer; both proposals stay above the exact
    // fee floor (the wider giveback must never buy back fee risk).
    expect(extreme.preTp1Trail!.noLossSl!).toBeGreaterThan(high.preTp1Trail!.noLossSl!);
    expect(extreme.trailedStopLoss).toBeGreaterThan(100.12);
    expect(high.trailedStopLoss).toBeGreaterThan(100.12);
  });

  it('T10c3 SHORT mirror trails below entry and never crosses LTP', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({
        side: 'SHORT', stopLoss: 101, initialStopLoss: 101,
        t1: 99, t2: 98, peakPrice: 99.2,
      }),
      { ltp: 99.2 },
    );
    expect(ev.stageCode).toBe('STAGE_0B_PRE_TP1_TRAIL');
    expect(ev.trailedStopLoss).toBeLessThan(99.88); // below fee-breakeven for SHORT
    expect(ev.trailedStopLoss).toBeGreaterThan(99.2); // above LTP (SHORT stop is above price)
    expect(ev.preTp1Trail?.applied).toBe(true);
  });

  it('T10d before the arm threshold the initial SL remains the protection', () => {
    const ev = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.2 }),
      { ltp: 100.05 },
    );
    expect(ev.stageCode).toBe('STAGE_0_INITIAL_GUARD');
    expect(ev.trailedStopLoss).toBe(99);
    expect(ev.preTp1Trail?.armed).toBe(false);

    const hit = evaluateActiveTradeDeepMonitor(dmTrade(), { ltp: 98.9 });
    expect(hit.shouldClose).toBe(true);
    expect(hit.exitReason).toBe('INITIAL_SL_PROTECTIVE_EXIT');
  });

  it('T11 a trail hit books fee-safe profit; a gap-through is labelled honestly', () => {
    // Arm first (persisted stop 100.22), then price trades through it above fees.
    const hit = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6, trailedStopLoss: 100.22, stopLoss: 100.22 }),
      { ltp: 100.18 },
    );
    expect(hit.shouldBookProfitNow).toBe(true);
    expect(hit.exitReason).toBe('TRAILED_SL_PROFIT_BOOKED');

    // Gap below the fee floor: stop did its job but the fill is not fee-safe.
    const gap = evaluateActiveTradeDeepMonitor(
      dmTrade({ peakPrice: 100.6, trailedStopLoss: 100.22, stopLoss: 100.22 }),
      { ltp: 100.05 },
    );
    expect(gap.shouldClose).toBe(true);
    expect(gap.exitReason).toBe('PRE_TP1_TRAIL_FEE_GAP_EXIT');
  });
});

describe('v21.31.0 wiring locks', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  it('deep monitor + tick agent are wired to the pre-TP1 engine', () => {
    const link = read('server/ai/mtfAutoLink.js');
    expect(link).toContain("from './preTp1Trail.js'");
    expect(link).toContain('STAGE_0B_PRE_TP1_TRAIL');
    expect(link).toContain('tickTrendPct');
    expect(link).toContain('allowSlMove');
    expect(link).toContain('preTp1TrailArmedCount');
    // The 15s sweep may read a ≤120s snapshot: telemetry only, never a move.
    expect(link).toContain('allowSlMove: false');
    expect(link).toContain('allowSlMove: hasFreshQuote');
    const agent = read('server/ai/autoTradeSuperAgent.js');
    expect(agent).toContain('trendPct: vel.trendPct');
    expect(agent).toContain('trendAdverse: vel.trendAdverse');
  });
});
