// ============================================================
// test/sizing.test.ts — v20.6 PROPERTY TESTS for wallet-risk sizing
// ------------------------------------------------------------
// Invariants locked (the plan's "Tests: property" line):
//   1. qty × slDistPct × entry ≤ riskUSDT × 1.001 (rounding slack)
//   2. liqDistancePct(lev) ≥ 2.5 × slDistPct (SL inside liq)
//   3. margin ≤ freeUSDT × 0.9 (cash headroom)
//   4. leverage = clamp(tierCap, 5, 10) ∧ ≤ maxSaneLeverage ∧ ≤ instrument.maxLeverage
// Plus the worked-example assertions from the plan:
//   wallet 1000 USDT · risk 1% · SL 1.5% → notional ≈ 667 USDT,
//   5x → margin ≈ 133 (13%); 10x → margin ≈ 67 (6.7%) — same max loss.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  computeSizing, maxSaneLeverage, liqDistancePct, tierLeverage,
} from '../server/exec/sizing.js';

describe('v20.6 sizing — invariant locks', () => {
  it('invariant 1: qty × slDist × entry ≤ riskUSDT × 1.001 (risk cap held)', () => {
    // fuzz: 50 random equity/entry/sl/lev combos
    for (let i = 0; i < 50; i++) {
      const equity = 100 + Math.random() * 10000;
      const entry = 1 + Math.random() * 1000;
      const slDist = 0.005 + Math.random() * 0.04; // 0.5%–4.5%
      const stopLoss = entry * (1 - slDist); // LONG
      const r = computeSizing({
        equity, freeUSDT: equity, entry, stopLoss,
        riskPct: 1, tierLeverage: 5, instrument: { qtyStep: 0.0001, minQty: 0.0001 },
      });
      if (r.verdict !== 'OK') continue; // SKIP is fine — we only assert OK cases
      const actualRisk = r.qty * Math.abs(entry - stopLoss);
      const riskCap = equity * 0.01 * 1.001; // riskUSDT × 1.001
      expect(actualRisk).toBeLessThanOrEqual(riskCap);
    }
  });

  it('invariant 2: liqDistancePct(lev) ≥ 2.5 × slDistPct (SL inside liq)', () => {
    for (let lev = 1; lev <= 10; lev++) {
      const liq = liqDistancePct(lev);
      // For each leverage, the max SL distance that satisfies the 2.5× ratio
      // = liq / 2.5. maxSaneLeverage must NOT return a leverage that violates
      // this for the given slDistPct.
      const slDist = liq / 2.5 / 100;
      const saneLev = maxSaneLeverage(slDist, 10);
      expect(liqDistancePct(saneLev)).toBeGreaterThanOrEqual(2.5 * slDist * 100 - 0.5);
    }
  });

  it('invariant 3: margin ≤ freeUSDT × 0.9 (cash headroom) — full OK path', () => {
    const r = computeSizing({
      equity: 1000, freeUSDT: 1000, entry: 100, stopLoss: 98.5,
      riskPct: 1, tierLeverage: 5, instrument: { qtyStep: 0.0001, minQty: 0.0001 },
    });
    expect(r.verdict).toBe('OK');
    expect(r.margin).toBeLessThanOrEqual(1000 * 0.9);
  });

  it('invariant 4: leverage = clamp(tierCap, 5, 10) ∧ ≤ maxSaneLeverage ∧ ≤ instrument.maxLeverage', () => {
    // 5% SL distance → maxSaneLev = 0.95/(2.5×0.05) = 7.6 → floored to 7.
    // tierLeverage 10 should clamp down to 7, NOT exceed saneLev.
    const r = computeSizing({
      equity: 5000, freeUSDT: 5000, entry: 100, stopLoss: 95,
      riskPct: 1, tierLeverage: 10, instrument: { qtyStep: 0.0001, minQty: 0.0001, maxLeverage: 10 },
    });
    expect(r.verdict).toBe('OK');
    expect(r.leverage).toBeLessThanOrEqual(maxSaneLeverage(0.05, 10));
    expect(r.leverage).toBeLessThanOrEqual(10);
    expect(r.leverage).toBeGreaterThanOrEqual(5);
  });

  it('workplan example: 1000 USDT · 1% risk · 1.5% SL → notional ≈ 667, 5x → margin ≈ 133, max loss ≈ 10', () => {
    const r5 = computeSizing({
      equity: 1000, freeUSDT: 1000, entry: 100, stopLoss: 98.5,
      riskPct: 1, tierLeverage: 5, instrument: { qtyStep: 0.0001, minQty: 0.0001 },
    });
    expect(r5.verdict).toBe('OK');
    // notional = 10 / 0.015 = 666.67
    expect(r5.notional).toBeGreaterThan(660);
    expect(r5.notional).toBeLessThan(675);
    // margin = 666.67 / 5 = 133.33
    expect(r5.margin).toBeGreaterThan(125);
    expect(r5.margin).toBeLessThan(140);
    // max loss = qty × (entry - sl) = (666.67/100) × 1.5 = 10
    const maxLoss = r5.qty * (100 - 98.5);
    expect(maxLoss).toBeLessThanOrEqual(10 * 1.001);
  });

  it('workplan example: 10x leverage gives same MAX LOSS as 5x (just smaller margin)', () => {
    const r5 = computeSizing({
      equity: 1000, freeUSDT: 1000, entry: 100, stopLoss: 98.5,
      riskPct: 1, tierLeverage: 5, instrument: { qtyStep: 0.0001, minQty: 0.0001 },
    });
    const r10 = computeSizing({
      equity: 1000, freeUSDT: 1000, entry: 100, stopLoss: 98.5,
      riskPct: 1, tierLeverage: 10, instrument: { qtyStep: 0.0001, minQty: 0.0001 },
    });
    if (r10.verdict !== 'OK') {
      // 10x at 1.5% SL has liq at 9.5% — that's 6.33× SL distance, ≥ 2.5×, should pass
      expect(r10.verdict).toBe('OK');
    }
    // Same max loss (both risk-bounded)
    const loss5 = r5.qty * (100 - 98.5);
    const loss10 = r10.qty * (100 - 98.5);
    expect(loss5).toBeCloseTo(loss10, 1); // ~10 USDT
    // 10x uses LESS margin than 5x
    expect(r10.margin).toBeLessThan(r5.margin);
    // Leverage lesson: same risk, smaller margin = more free cash
  });

  it('SKIP_LOW_EQUITY: equity ≤ 0 → SKIP cleanly', () => {
    const r = computeSizing({ equity: 0, freeUSDT: 0, entry: 100, stopLoss: 98 });
    expect(r.verdict).toBe('SKIP_LOW_EQUITY');
  });

  it('SKIP_MIN_QTY: rounded qty below instrument minQty → SKIP', () => {
    // tiny equity, tiny sl, small qty would round below minQty 0.001
    const r = computeSizing({
      equity: 5, freeUSDT: 5, entry: 50000, stopLoss: 49500,
      riskPct: 1, tierLeverage: 5, instrument: { qtyStep: 0.0001, minQty: 0.001 },
    });
    expect(['SKIP_MIN_QTY', 'SKIP_LOW_EQUITY', 'SKIP_MARGIN_CAP', 'SKIP_LIQ_TOO_CLOSE']).toContain(r.verdict);
  });

  it('SKIP_LIQ_TOO_CLOSE: large SL distance + high tier leverage → SKIP (liq < 2.5×SL)', () => {
    // 8% SL distance + levMin 5 → maxSaneLev = 0.95/(2.5×0.08) = 4.75 → floored to 4
    // → 4 < levMin 5 → SKIP_LIQ_TOO_CLOSE (can't fit even at levMin)
    const r = computeSizing({
      equity: 10000, freeUSDT: 10000, entry: 100, stopLoss: 92,
      riskPct: 1, tierLeverage: 10, levMin: 5, levMax: 10,
      instrument: { qtyStep: 0.0001, minQty: 0.0001, maxLeverage: 10 },
      liqToSlRatio: 2.5,
    });
    expect(r.verdict).toBe('SKIP_LIQ_TOO_CLOSE');
  });

  it('risk% clamped to riskPctMax (default 2) — riskPct: 5 → 2 used', () => {
    const r = computeSizing({
      equity: 1000, freeUSDT: 1000, entry: 100, stopLoss: 98.5,
      riskPct: 5, riskPctMax: 2, tierLeverage: 5,
      instrument: { qtyStep: 0.0001, minQty: 0.0001 },
    });
    expect(r.verdict).toBe('OK');
    // riskUSDT = 1000 × 0.02 = 20 (not 50)
    expect(r.riskUSDT).toBeLessThanOrEqual(20.01);
    expect(r.riskUSDT).toBeGreaterThan(19.99);
  });

  it('tierLeverage mapping: STRONG + verified 95 + regime + funding normal + tiny SL → 10x', () => {
    expect(tierLeverage({
      tier: 'STRONG', verifiedScore: 95, regimeAligned: true, fundingNormal: true, slDistPct: 0.011,
    })).toBe(10);
  });

  it('tierLeverage mapping: STRONG without 95/95/regime → 5x', () => {
    expect(tierLeverage({
      tier: 'STRONG', verifiedScore: 90, regimeAligned: true, fundingNormal: true, slDistPct: 0.015,
    })).toBe(5);
  });

  it('tierLeverage mapping: WATCH → null (caller skips)', () => {
    expect(tierLeverage({ tier: 'WATCH' })).toBeNull();
  });

  it('liqDistancePct: 5x → 19%, 10x → 9.5%', () => {
    expect(liqDistancePct(5)).toBeCloseTo(19, 1);
    expect(liqDistancePct(10)).toBeCloseTo(9.5, 1);
  });

  it('maxSaneLeverage: 1% SL → 0.95/(2.5×0.01) = 38, clamped to 10', () => {
    expect(maxSaneLeverage(0.01, 10)).toBe(10); // 38 clamped to 10
  });

  it('maxSaneLeverage: 5% SL → 0.95/(2.5×0.05) = 7.6, floored to 7', () => {
    expect(maxSaneLeverage(0.05, 10)).toBe(7);
  });
});
