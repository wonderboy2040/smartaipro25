// ============================================================
// test/botlabEngine.test.ts — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// The honesty contract, locked by tests (plan §7.2/§7.5/§7.6):
//   1. NO SAME-BAR LOOKAHEAD — fill at i+1 open, never i's close
//   2. AMBIGUOUS BAR — stop first (pessimistic), counted
//   3. FRICTION — net == ideal − slippage − fees EXACTLY (1e-3)
//   4. RISK SIZING — 0.5% achieved; qty<1 floor-or-skip honest
//   5. ONE POSITION AT A TIME — overlapping candidates blocked
//   6. METRICS — t-stat / PF / DD / halves / stand-aside math
//   7. AUDIT — independent verifier catches fabricated trades
// ============================================================
import { describe, it, expect } from 'vitest';
import { runBacktest, slippagePerSide, istMinutes, hhmmToMin } from '../server/bots/core/engine.js';
import { tStatOnR, profitFactor, maxDrawdownR, computeMetrics, passCriteria, decisionBreakdown, concentration } from '../server/bots/core/metrics.js';
import { auditTrades, auditLine, tradesToCsv } from '../server/bots/core/audit.js';

// ---------------- deterministic bars helper ----------------
function mkBars(n, { base = 100, seedVol = 1000 } = {}) {
  const bars = [];
  let px = base;
  const t0 = Date.UTC(2026, 5, 1, 0, 0, 0); // a UTC crypto-style week
  for (let i = 0; i < n; i++) {
    const open = px;
    const close = open + Math.sin(i / 13) * 0.3;
    bars.push({
      time: t0 + i * 5 * 60000,
      open, close,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      volume: seedVol,
    });
    px = close;
  }
  return bars;
}

const flatCost = { total: 2.5 };

function stubStrategy(detectFn) {
  return { detect: detectFn, desk: 'crypto', instrumentType: 'crypto', lotSize: 1 };
}

describe('v20.8 engine — causality + honesty locks', () => {
  it('1. fills at the NEXT bar open (no same-bar lookahead)', async () => {
    const bars = mkBars(12);
    // candidate at i=5; fill must be bars[6].open, never bars[5].close
    bars[6].open = 101; bars[6].high = 112; bars[6].low = 99; bars[6].close = 111;
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {}, audit: { expectedStop: 90, expectedTarget: 110 } }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2, features: {} })),
      strategy: strat, decider: null, costFn: () => flatCost,
      instrumentType: 'crypto', symbol: 'X',
    });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.iSignal).toBe(5);
    expect(t.iFill).toBe(6);
    expect(t.entry).toBe(101);          // bars[6].open — NOT bars[5].close
    expect(t.exitWhy).toBe('target');   // high 112 >= 110 at the fill bar
    expect(t.exit).toBe(110);
  });

  it('2. ambiguous bar is pessimistic (stop first) and counted', async () => {
    const bars = mkBars(12);
    // fill bar spans BOTH stop and target
    bars[6].open = 101; bars[6].high = 112; bars[6].low = 89.5; bars[6].close = 95;
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {} }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
    });
    expect(r.trades[0].exitWhy).toBe('stop');
    expect(r.trades[0].ambiguous).toBe(true);
    expect(r.meta.ambiguousBars).toBe(1);
    expect(r.meta.ambiguousShare).toBe(1);
  });

  it('3. net reconciles EXACTLY: ideal − slippage − fees (1e-3)', async () => {
    const bars = mkBars(12);
    bars[6].open = 101; bars[6].high = 112; bars[6].low = 99;
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {} }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
    });
    const t = r.trades[0];
    // manual friction: crypto slippage 4bps per side
    const slipIn = slippagePerSide(t.entry, 4);
    const slipOut = slippagePerSide(t.exit, 4);
    const expectSlip = (slipIn + slipOut) * t.qty;
    expect(Math.abs(t.slippage - expectSlip)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(t.fees - 2.5)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(t.netPnl - (t.idealPnl - t.slippage - t.fees))).toBeLessThanOrEqual(1e-3);
    expect(r.meta.errors).toHaveLength(0); // engine's own reconciliation assert
  });

  it('4a. risk sizing: 0.5% achieved on a clean trade', async () => {
    const bars = mkBars(12);
    bars[6].open = 101; bars[6].high = 112; bars[6].low = 99;
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {} }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
    });
    const t = r.trades[0];
    // equity 1,000,000 × 0.5% = 5,000 risk; stopDist |101−90| = 11 → qty ≈ 454.54
    expect(t.qty).toBeCloseTo(5000 / 11, 3);
    expect(t.achievedRiskPct).toBeCloseTo(0.5, 6);
  });

  it('4b. qty<1 unit: floors to 1 within ceiling, skips honestly beyond', async () => {
    const bars = mkBars(12);
    bars[6].open = 101; bars[6].high = 112; bars[6].low = 99;
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 1, target: 110, entry: 100, features: {} } // huge stopDist -> tiny qty at small equity
      : null);
    // small equity (1,000): risk budget 5 -> qty 5/100 = 0.05 < 1 unit
    // with a hard ceiling on the 1-unit floor (1 unit risks 100 > 0.5x5): skip recorded
    const rSkip = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
      cfg: { startingEquity: 1000, qtyUnitMin: 1, qtyUnitMax: 0.5 },
    });
    expect(rSkip.trades).toHaveLength(0);
    expect(rSkip.meta.skips.some(s => s.reason === 'below_min_unit_and_ceiling')).toBe(true);
    // without ceiling: floor to 1 unit, achieved risk REPORTED (named bug #4)
    const rFloor = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
      cfg: { startingEquity: 1000, qtyUnitMin: 1 },
    });
    expect(rFloor.trades).toHaveLength(1);
    expect(rFloor.trades[0].qty).toBe(1);
    expect(rFloor.trades[0].achievedRiskPct).toBeGreaterThan(0.5); // visible, not silent
  });

  it('5. one position at a time — overlapping candidates blocked', async () => {
    const bars = mkBars(20);
    // three candidates: i=5 (fills 6, exits 8), i=7 (BLOCKED), i=8 (allowed)
    bars[6].open = 101; bars[6].high = 105; bars[6].low = 99;
    bars[7].high = 108; bars[7].low = 100;
    bars[8].high = 112; bars[8].low = 100; bars[8].open = 106;
    const detections: number[] = [];
    const strat = stubStrategy((rows, i) => {
      detections.push(i);
      if (i === 5 || i === 7 || i === 8) {
        return { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {} };
      }
      return null;
    });
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
    });
    expect(r.trades).toHaveLength(2);            // i=5 and i=8 (7 was inside the open trade)
    expect(detections).not.toContain(7);        // scanner never even looked at bar 7
    expect(r.trades[1].iSignal).toBe(8);
  });

  it('decider veto produces a decision record with stable reason', async () => {
    const bars = mkBars(12);
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {} }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat,
      decider: async () => ({ action: 'wait', reason: 'low_volume' }),
      costFn: () => flatCost, instrumentType: 'crypto',
    });
    expect(r.trades).toHaveLength(0);
    expect(r.meta.decisions.candidates).toBe(1);
    expect(r.meta.decisions.taken).toBe(0);
    expect(r.meta.decisions.standAsideRate).toBe(1);
    expect(r.meta.decisions.vetoBreakdown['low_volume']).toBe(1);
  });

  // ---------------- v20.8.1 honesty locks ----------------

  it('v20.8.1 6. gap-through-stop NEVER books a fabricated win', async () => {
    const bars = mkBars(12);
    // fill bar OPENS below the stop (LONG, stop 90, open 85) — the old
    // engine recorded exit=90 on an 85 entry => +R profit for a trade
    // that in reality stops out instantly at the open.
    bars[6].open = 85; bars[6].high = 96; bars[6].low = 84; bars[6].close = 95;
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {} }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
    });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.gapThroughStop).toBe(true);
    expect(t.exit).toBe(85);            // stopped at the open, not at 90
    expect(t.idealPnl).toBe(0);         // entry == exit: P&L is -friction only
    expect(t.rGross).toBe(0);
    expect(t.netPnl).toBeLessThanOrEqual(0);
    expect(t.rNet).toBeLessThanOrEqual(0);
  });

  it('v20.8.1 7. maxHoldBars is honored (time stop)', async () => {
    const bars = mkBars(40);
    // drift gently so neither stop nor target is hit
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 50, target: 500, entry: 100, maxHoldBars: 10, features: {} }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
    });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.exitWhy).toBe('time_stop');
    expect(t.iFill).toBe(6);
    expect(t.iFill + 10).toBeLessThanOrEqual(39);
    // exit ts must be the 10th bar after the fill (j - iFill >= 10)
    expect(t.tsOut).toBe(bars[6 + 10].time);
  });

  it('v20.8.1 8. zero/blank prices are skipped, never traded', async () => {
    const bars = mkBars(12);
    bars[6].open = 0; bars[6].high = 112; bars[6].low = 99; // blank/zero open
    const strat = stubStrategy((rows, i) => i === 5
      ? { symbol: 'X', side: 'LONG', stop: 90, target: 110, entry: 100, features: {} }
      : null);
    const r = await runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
    });
    expect(r.trades).toHaveLength(0);
    expect(r.meta.skips.some(s => s.reason === 'bad_price')).toBe(true);
  });

  it('v20.8.1 9. squareOff misconfiguration throws LOUDLY (no silent overnight hold)', async () => {
    const bars = mkBars(12);
    const strat = stubStrategy(() => null);
    await expect(runBacktest({
      rows: bars.map((bar, i) => ({ bar, i, atr: 2 })),
      strategy: strat, costFn: () => flatCost, instrumentType: 'crypto',
      squareOff: { enabled: true, ist: '99:99' },
    })).rejects.toThrow(/squareOff/);
  });
});

describe('v20.8 metrics — math locks', () => {
  it('t-stat: known values', () => {
    expect(tStatOnR([1, 1, 1, 1])).toBeNull();          // zero dispersion
    expect(tStatOnR([0.5])).toBeNull();                 // n<2
    // [0.1..0.4]: mean .25, sd .1291, t = .25/(.1291/2) ≈ 3.873
    expect(tStatOnR([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(3.873, 2);
  });
  it('profit factor + max drawdown', () => {
    expect(profitFactor([1, -0.5, 2, -1])).toBeCloseTo(2);
    expect(profitFactor([1, 2])).toBeNull();            // no losers -> null (reported, not bragged)
    expect(maxDrawdownR([1, -0.5, 0.2])).toBeCloseTo(0.5);
  });
  it('computeMetrics: halves on DATE split, gross AND net together', () => {
    const trades = [1, 2, 3, 4, 5, 6].map((k) => ({
      rNet: k % 2 ? 0.3 : -0.1, rGross: k % 2 ? 0.4 : -0.05,
      symbol: k <= 3 ? 'A' : 'B', tsIn: k * 86400000,
    }));
    const m = computeMetrics(trades);
    expect(m.trades).toBe(6);
    expect(m.halves.train.trades).toBe(3);
    expect(m.halves.test.trades).toBe(3);
    expect(m.netR).toBeCloseTo(3 * 0.3 + 3 * -0.1);
    expect(m.grossR).not.toBeNull();
    expect(m.feeDragR).toBeCloseTo(m.grossR! - m.netR!);
  });
  it('pass criteria: small n fails on trades; halves must BOTH clear t>=2', () => {
    const m = computeMetrics([{ rNet: 1, rGross: 1, symbol: 'A', tsIn: 1 }, { rNet: 1, rGross: 1, symbol: 'A', tsIn: 2 }]);
    const p = passCriteria(m, { minTrades: 2, minT: 2 });
    expect(p.checks.trades).toBe(true);
    // identical R's -> t null -> halves fail
    expect(p.checks.tStatBothHalves).toBe(false);
    expect(p.pass).toBe(false);
  });
  it('concentration flags single-symbol edges', () => {
    const one = concentration([{ rNet: 5, symbol: 'A', tsIn: 1 }, { rNet: 5, symbol: 'A', tsIn: 2 }]);
    expect(one.concentrated).toBe(true);
    const spread = concentration([
      { rNet: 1, symbol: 'A', tsIn: 1 }, { rNet: 1, symbol: 'B', tsIn: 32 * 86400000 },
      { rNet: 1, symbol: 'C', tsIn: 61 * 86400000 }, { rNet: 1, symbol: 'D', tsIn: 92 * 86400000 },
    ]);
    expect(spread.concentrated).toBe(false);
  });
});

describe('v20.8 audit — independent verifier', () => {
  const ctx = {
    strategyId: 'orb_in',
    minutesFromOpen: (t) => istMinutes(t) - (9 * 60 + 15),
    lastEntryMinutes: 135,
  };
  const mkTrade = (over = {}) => ({
    symbol: 'X', side: 'LONG', tsIn: Date.UTC(2026, 8, 7, 4, 5), // 09:35 IST
    entry: 101, stop: 100, target: 103,
    expectedStop: 100, expectedTarget: 103,
    rangeSizeAtr: 0.9, confirmOutside: true,
    ...over,
  });
  it('clean trade: 1/1 satisfied', () => {
    const a = auditTrades([mkTrade()], ctx);
    expect(auditLine(a)).toBe('1/1 satisfied');
    expect(a.failures).toHaveLength(0);
  });
  it('fabricated stop: caught by stop_at_range_edge', () => {
    const a = auditTrades([mkTrade({ stop: 99 })], ctx);
    expect(a.satisfied).toBe(0);
    expect(a.failures[0].rule).toBe('stop_at_range_edge');
  });
  it('duplicate same-day trade: caught by one_attempt_per_day', () => {
    const a = auditTrades([mkTrade(), mkTrade({ tsIn: Date.UTC(2026, 8, 7, 5, 35) })], ctx);
    expect(a.satisfied).toBe(1);
    expect(a.failures.some(f => f.rule === 'one_attempt_per_day')).toBe(true);
  });
  it('late entry: caught by entry_before_last_entry', () => {
    const a = auditTrades([mkTrade({ tsIn: Date.UTC(2026, 8, 7, 6, 40) })], ctx); // 12:10 IST
    expect(a.failures.some(f => f.rule === 'entry_before_last_entry')).toBe(true);
  });
  it('CSV export is parseable and complete', () => {
    const csv = tradesToCsv([mkTrade()]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('symbol,side,tsIn');
    expect(lines[1]).toContain('LONG');
  });
  it('v20.8.1: bars-based re-derivation catches a FABRICATED exit price', () => {
    // candles: signal bar 0 (09:30 IST), fill bar 1 opens 101, ranges
    // [99, 102] — stop 95 / target 500 are NEVER hit, so the only
    // differentiator is the recorded exit price vs the exit bar's range.
    const t0 = Date.UTC(2026, 8, 7, 4, 0);
    const bars = [];
    for (let i = 0; i < 8; i++) {
      bars.push({ time: t0 + i * 5 * 60000, open: 100, high: 102, low: 99, close: 101, volume: 1000 });
    }
    bars[1].open = 101; // fill bar
    const mk = (exit: number) => mkTrade({
      entry: 101, stop: 95, expectedStop: 95, target: 500, expectedTarget: 500,
      tsIn: bars[0].time, tsOut: bars[5].time, exit,
    });
    const good = auditTrades([mk(101)], { ...ctx, bars });
    const bad = auditTrades([mk(109)], { ...ctx, bars }); // 109 not in [99, 102]
    expect(bad.satisfied).toBe(0);
    expect(bad.failures.some(f => f.rule === 'exit_outside_bar_range')).toBe(true);
    expect(good.failures.some(f => f.rule === 'exit_outside_bar_range')).toBe(false);
  });
});

describe('v20.8 engine helpers', () => {
  it('slippagePerSide: bps math', () => {
    expect(slippagePerSide(100, 5)).toBeCloseTo(0.05);
    expect(slippagePerSide(null, 5)).toBeNull();
  });
  it('hhmmToMin + istMinutes: IST clock math', () => {
    expect(hhmmToMin('15:10')).toBe(910);
    expect(istMinutes(Date.UTC(2026, 8, 7, 3, 45))).toBe(9 * 60 + 15); // 09:15 IST
    expect(istMinutes(Date.UTC(2026, 8, 7, 10, 0))).toBe(15 * 60 + 30); // 15:30 IST
  });
});
