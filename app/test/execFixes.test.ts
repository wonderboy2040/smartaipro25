// Regression tests for the v20.7.1 deep-recheck fixes in server/exec/*
import { describe, it, expect } from 'vitest';
// @ts-ignore — plain JS module
import { computeSizing, liqDistancePct } from '../server/exec/sizing.js';

describe('v20.7.1 sizing — capped branches', () => {
  it('liqGuard uses consistent units (percent vs fraction) in the margin-capped branch', () => {
    // 10x with a 4% SL → liq 9.5% < 2.5×4% = 10% → leverage must be reduced; and when capped,
    // liqGuard must reflect the REAL comparison, not an always-true unit mismatch.
    const r = computeSizing({ equity: 1000, freeUSDT: 150, entry: 100, stopLoss: 99, riskPct: 1, tierLeverage: 5 });
    expect(r.verdict).toBe('OK');
    expect(r.guards.marginCapUsed).toBe(true);
    const expected = liqDistancePct(r.leverage) >= 2.5 * r.slDistPct * 100;
    expect(r.guards.liqGuard).toBe(expected);
  });

  it('margin-capped qty below instrument minQty → SKIP_MIN_QTY (never an OK verdict with a sub-min qty)', () => {
    const r = computeSizing({
      equity: 1000, freeUSDT: 150, entry: 60000, stopLoss: 59400, riskPct: 1, tierLeverage: 5,
      instrument: { qtyStep: 0.0001, minQty: 0.05, maxLeverage: 10 },
    });
    // capped notional = 150×0.9×5 = 675 → qty ≈ 0.0112 < minQty 0.05
    expect(r.verdict).toBe('SKIP_MIN_QTY');
  });

  it('qty rounding has no float noise (0.3 not 0.30000000000000004)', () => {
    const r = computeSizing({
      equity: 1234, entry: 100, stopLoss: 95, riskPct: 1,
      instrument: { qtyStep: 0.1, minQty: 0.1, maxLeverage: 10 },
    });
    expect(r.verdict).toBe('OK');
    expect(Number.isInteger(Math.round(r.qty * 10))).toBe(true);
    expect(r.qty).toBe(2.4);
  });
});
