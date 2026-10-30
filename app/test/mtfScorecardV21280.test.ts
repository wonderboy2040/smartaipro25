// ============================================================
// test/mtfScorecardV21280.test.ts — v21.28.0 PHASE 0 SCORECARD UPGRADES
// ------------------------------------------------------------
// Adds the comparison fields the audit plan needs:
//   • per-tier TP1/TP2/stop-out %, expectancy, MFE/MAE
//   • time-to-TP1 from the actual touch bar (not the sweep timestamp)
//   • signalAtOpenBar / signalAtCloseBar snapshots + stability flag
//     persisted and rehydrated without loss
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordMtfBoardScanRow, resolveMtfBoardScanOutcomes, computeMtfDirectionScorecard,
  hydrateMtfLedger, getMtfLedgerSnapshot, __resetMtfLedgerForTests,
} from '../server/ai/signalLedger.js';

const T0 = 1_790_000_000_000;

const baseRow = (over = {}) => ({
  symbol: 'AAA',
  market: 'CRYPTO',
  mode: 'INTRADAY',
  side: 'LONG',
  boardSide: 'LONG',
  boardSideConflict: false,
  directionVerified: true,
  superScore: 88,
  tier: 'ELITE',
  holdMin: 45,
  plan: { entry: 100, stopLoss: 98, t1: 104, t2: 108 },
  barConfirmation: {
    stable: true,
    openBar: { side: 'LONG', triggerFired: true, directionVerified: true },
    closeBar: { side: 'LONG', triggerFired: true, directionVerified: true, lastClosedBarTime: T0 - 60_000 },
  },
  ...over,
});

beforeEach(() => __resetMtfLedgerForTests());

describe('v21.28.0 — per-tier scorecard + TP touch time', () => {
  it('computes tier-level expectancy/TP1/stop metrics and exact touch lag', () => {
    recordMtfBoardScanRow(baseRow({ symbol: 'ELT' }), { now: T0 });
    recordMtfBoardScanRow(baseRow({
      symbol: 'WCH', tier: 'WATCH', superScore: 55,
      plan: { entry: 200, stopLoss: 196, t1: 206, t2: 212 },
    }), { now: T0 });

    // ELT touches T1 on the 2-minute candle; WCH stops out on its 3-minute candle.
    resolveMtfBoardScanOutcomes({
      candlesBySymbol: {
        ELT: [{ time: T0 + 120_000, high: 104.5, low: 101, close: 104.2 }],
        WCH: [{ time: T0 + 180_000, high: 201, low: 195.5, close: 195.8 }],
      },
      now: T0 + 10 * 60_000,
    });

    const card = computeMtfDirectionScorecard({ windowDays: 30, now: T0 + 15 * 60_000 });
    expect(card.resolvedCount).toBe(2);
    expect(card.byTier.ELITE.n).toBe(1);
    expect(card.byTier.ELITE.tp1Hits).toBe(1);
    expect(card.byTier.ELITE.tp2Hits).toBe(0);
    expect(card.byTier.ELITE.stopOuts).toBe(0);
    expect(card.byTier.ELITE.tp1HitPct).toBe(100);
    expect(card.byTier.ELITE.expectancyR).toBe(2); // (104-100)/2 = +2R
    expect(card.byTier.ELITE.avgTimeToTp1Min).toBe(2);
    expect(card.byTier.WATCH.n).toBe(1);
    expect(card.byTier.WATCH.stopOuts).toBe(1);
    expect(card.byTier.WATCH.stopOutPct).toBe(100);
    expect(card.byTier.WATCH.expectancyR).toBe(-1);
    expect(card.tp1Hits).toBe(1);
    expect(card.tp2Hits).toBe(0);
    expect(card.stopOuts).toBe(1);
    expect(card.avgMfeR).not.toBeNull();
    expect(card.avgMaeR).not.toBeNull();
  });

  it('persists + rehydrates bar snapshots, stability and TP touch times', () => {
    recordMtfBoardScanRow(baseRow({ symbol: 'PER' }), { now: T0 });
    resolveMtfBoardScanOutcomes({
      candlesBySymbol: { PER: [{ time: T0 + 300_000, high: 104.2, low: 101, close: 104 }] },
      now: T0 + 6 * 60_000,
    });
    const saved = JSON.parse(JSON.stringify(getMtfLedgerSnapshot()));

    __resetMtfLedgerForTests();
    hydrateMtfLedger(saved.rows, { lastLogAt: saved.lastLogAt, lastResolveAt: saved.lastResolveAt });
    const hydrated = getMtfLedgerSnapshot().rows.find((r) => r.symbol === 'PER');
    expect(hydrated.signalStable).toBe(true);
    expect(hydrated.signalAtOpenBar).toMatchObject({ side: 'LONG', triggerFired: true });
    expect(hydrated.signalAtCloseBar).toMatchObject({ side: 'LONG', triggerFired: true });
    expect(hydrated.t1HitAt).toBe(T0 + 300_000);
    expect(hydrated.outcome).toBe('T1_HIT');

    const card = computeMtfDirectionScorecard({ windowDays: 30, now: T0 + 20 * 60_000 });
    expect(card.byTier.ELITE.avgTimeToTp1Min).toBe(5);
  });

  it('stores stable:false rows and still scores them honestly', () => {
    recordMtfBoardScanRow(baseRow({
      symbol: 'UNS',
      barConfirmation: {
        stable: false,
        openBar: { side: 'LONG', triggerFired: true },
        closeBar: { side: 'SHORT', triggerFired: false },
      },
    }), { now: T0 });
    const row = getMtfLedgerSnapshot().rows.find((r) => r.symbol === 'UNS');
    expect(row.signalStable).toBe(false);
    expect(row.signalAtOpenBar.side).toBe('LONG');
    expect(row.signalAtCloseBar.side).toBe('SHORT');
  });
});
