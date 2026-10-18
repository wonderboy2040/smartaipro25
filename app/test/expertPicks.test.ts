// ============================================================
// test/expertPicks.test.ts — v8.0 ADVANCE PRO TRADER ENGINE
// ------------------------------------------------------------
// Pure-function coverage for the Expert Picks engine:
//   1. expertScoreFactors — side detection + 7-factor composite
//      (bullish stack → LONG, bearish → SHORT, degenerate → null)
//   2. buildExpertBlueprint — the complete trade plan math:
//      entry zone band, 1.6×ATR stop, T1/T2/T3 = 1R/2R/3R,
//      leverage ladder (spot 1× / futures score-scaled /
//      liquidation-aware cap), staged 40/40/20 exit plan,
//      timing window, hold horizon, invalidation
//   3. pricePrecision — low-price coins (DOGE/SHIB-class) never
//      get their levels rounded into lookalikes
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  expertScoreFactors, buildExpertBlueprint, pricePrecision,
  EXPERT_MIN_STRONG, EXPERT_WEIGHTS,
} from '../server/ai/expertPicks.js';

// ---- helpers: synthetic indicator snapshots ----
function bullTv(ltp = 100) {
  return {
    usdPrice: ltp, changePct: 2.4,
    rsi: 61, macd: 1.2, macdSignal: 0.8,
    ema10: ltp * 1.02, ema20: ltp * 1.01, ema50: ltp * 0.97,
    sma20: ltp * 1.0, sma50: ltp * 0.98,
    atr: ltp * 0.015, adx: 32, adxPlus: 28, adxMinus: 10,
    bbUpper: ltp * 1.03, bbLower: ltp * 0.97,
    stochK: 72, stochD: 60, relVolume: 1.9, recommend: 0.6,
  };
}
function bearTv(ltp = 100) {
  return {
    usdPrice: ltp, changePct: -2.6,
    rsi: 38, macd: -1.1, macdSignal: -0.5,
    ema10: ltp * 0.98, ema20: ltp * 0.99, ema50: ltp * 1.03,
    sma20: ltp * 1.0, sma50: ltp * 1.02,
    atr: ltp * 0.018, adx: 30, adxPlus: 9, adxMinus: 29,
    bbUpper: ltp * 1.03, bbLower: ltp * 0.97,
    stochK: 25, stochD: 40, relVolume: 1.7, recommend: -0.5,
  };
}
const bullLtf = (ltp = 100) => ({
  ltp, rsi: 62, macd: { macd: 1.0, signal: 0.7, hist: 0.3 },
  ema10: ltp * 1.02, ema20: ltp * 1.01, ema50: ltp * 0.98,
  atr: ltp * 0.015, atrPct: 60,
  bollinger: { upper: ltp * 1.03, lower: ltp * 0.97, mid: ltp, percentB: 0.82, widthPct: 5 },
  stochastic: { k: 70, d: 58 }, adx: { adx: 30 },
  obvSlope: 0.4, mfi: 62, vwap: ltp * 0.99,
  relVolume: 1.8, patterns: [{ name: 'Bullish Marubozu', bias: 1 }],
  volume: 900, avgVolume20: 500,
});
const bullRegime = { btcChange: 1.4, btcTrend: 'UP' };
const bearRegime = { btcChange: -1.6, btcTrend: 'DOWN' };

describe('expertScoreFactors — side + composite score', () => {
  it('bullish confluence → LONG side with a high score', () => {
    const r = expertScoreFactors({ tv: bullTv(), ltf: bullLtf(), regime: bullRegime, market: 'CRYPTO', smc: { dir: 1, conf: 70 }, structure: { dir: 1, conf: 65 } });
    expect(r).not.toBeNull();
    expect(r!.side).toBe('LONG');
    expect(r!.score).toBeGreaterThanOrEqual(EXPERT_MIN_STRONG);
    // every factor label + weight present, values 0-100
    // v20.7.4: structure seat (BOS/CHoCH + Fib + VP + S&D) ka 8th factor
    expect(r!.factors).toHaveLength(8);
    const wSum = r!.factors.reduce((a, f) => a + f.weight, 0);
    expect(Math.abs(wSum - 1)).toBeLessThan(0.001);
    for (const f of r!.factors) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(100);
    }
    // structure factor bhi same aligned/against math follow karta hai
    const structAligned = expertScoreFactors({ tv: bullTv(), ltf: bullLtf(), regime: bullRegime, market: 'CRYPTO', structure: { dir: 1, conf: 70 } })!;
    const structAgainst = expertScoreFactors({ tv: bullTv(), ltf: bullLtf(), regime: bullRegime, market: 'CRYPTO', structure: { dir: -1, conf: 70 } })!;
    const sA = structAligned.factors.find(f => f.key === 'structure')!.value;
    const sB = structAgainst.factors.find(f => f.key === 'structure')!.value;
    expect(sA).toBeGreaterThan(sB);
  });

  it('bearish confluence → SHORT side (factors grade the short)', () => {
    const r = expertScoreFactors({ tv: bearTv(), ltf: null, regime: bearRegime, market: 'FUTURES', smc: { dir: -1, conf: 65 } });
    expect(r).not.toBeNull();
    expect(r!.side).toBe('SHORT');
    expect(r!.score).toBeGreaterThan(50);
  });

  it('aligned SMC boosts the score, opposite SMC penalises it', () => {
    const withAligned = expertScoreFactors({ tv: bullTv(), ltf: bullLtf(), regime: bullRegime, market: 'CRYPTO', smc: { dir: 1, conf: 80 } })!;
    const withAgainst = expertScoreFactors({ tv: bullTv(), ltf: bullLtf(), regime: bullRegime, market: 'CRYPTO', smc: { dir: -1, conf: 80 } })!;
    expect(withAligned.score).toBeGreaterThan(withAgainst.score);
    const smcA = withAligned.factors.find(f => f.key === 'smc')!.value;
    const smcB = withAgainst.factors.find(f => f.key === 'smc')!.value;
    expect(smcA).toBeGreaterThan(smcB);
  });

  it('degenerate inputs → null (no price / no data)', () => {
    expect(expertScoreFactors({ tv: null, ltf: null, regime: null, market: 'CRYPTO' })).toBeNull();
    expect(expertScoreFactors({ tv: { usdPrice: 0 }, ltf: null, regime: null, market: 'CRYPTO' })).toBeNull();
  });

  it('risk-off regime drags the LONG score down vs risk-on', () => {
    const up = expertScoreFactors({ tv: bullTv(), ltf: bullLtf(), regime: bullRegime, market: 'CRYPTO' })!;
    const down = expertScoreFactors({ tv: bullTv(), ltf: bullLtf(), regime: bearRegime, market: 'CRYPTO' })!;
    expect(up.score).toBeGreaterThan(down.score);
  });

  it('weights dict is the documented composite', () => {
    // v20.7.4: structure seat added — trend/momentum/smcs rebalanced, sum still 1.0
    expect(EXPERT_WEIGHTS.trend).toBe(0.23);
    expect(EXPERT_WEIGHTS.momentum).toBe(0.18);
    expect(EXPERT_WEIGHTS.smc).toBe(0.13);
    expect(EXPERT_WEIGHTS.structure).toBe(0.09);
    const sum = Object.values(EXPERT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.001);
  });
});

describe('buildExpertBlueprint — the complete trade plan', () => {
  const ltp = 100, atr = 1.5; // 1.5% ATR

  it('LONG: stop 1.6×ATR below, targets 1R/2R/3R above, zone straddles entry', () => {
    const p = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 85, market: 'CRYPTO', ema20: 99.5 })!;
    expect(p.side).toBe('LONG');
    expect(p.stopLoss).toBeLessThan(ltp);
    const r = ltp - p.stopLoss;
    expect(Math.abs(r - 1.6 * atr)).toBeLessThan(0.35); // 1.6×ATR risk (± rounding)
    expect(p.targets.t1).toBeCloseTo(ltp + r, 1);
    expect(p.targets.t2).toBeCloseTo(ltp + 2 * r, 1);
    expect(p.targets.t3).toBeCloseTo(ltp + 3 * r, 1);
    expect(p.entryZone[0]).toBeLessThan(ltp);
    expect(p.entryZone[1]).toBeGreaterThan(ltp);
    // v21.13.x (B4): RR derived from the ACTUAL T1 ladder — T1 = entry+1R
    // → RR 1.0 (pehle hardcoded 2 tha jabki T1 sirf 1R door hai; winProb
    // ka P(NEED) edge-math ~2× optimistic padh raha tha)
    expect(p.rewardRisk).toBeCloseTo(1, 5);
  });

  it('SHORT: mirrored levels (stop above, targets below)', () => {
    const p = buildExpertBlueprint({ side: 'SHORT', ltp, atr, score: 82, market: 'FUTURES', ema20: 100.4 })!;
    expect(p.stopLoss).toBeGreaterThan(ltp);
    const r = p.stopLoss - ltp;
    expect(p.targets.t1).toBeCloseTo(ltp - r, 1);
    expect(p.targets.t2).toBeCloseTo(ltp - 2 * r, 1);
  });

  it('SHORT blueprint: liquidation sits ABOVE the stop (SL first)', () => {
    const p = buildExpertBlueprint({ side: 'SHORT', ltp: 100, atr: 1.5, score: 82, market: 'FUTURES' })!;
    expect(p.liquidation!).toBeGreaterThan(p.stopLoss); // SHORT: liq above SL
  });

  it('leverage ladder: spot = 1×, futures capped by score bracket + sane max', () => {
    const spot = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 85, market: 'CRYPTO' })!;
    expect(spot.leverage).toBe(1);
    expect(spot.liquidation).toBeNull(); // no margin on spot
    const fut80 = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 80, market: 'FUTURES' })!;
    expect(fut80.leverage).toBe(5);
    expect(fut80.liquidation).not.toBeNull();
    // LONG: liquidation must sit BEYOND the stop (below it) — the SL
    // triggers FIRST, that's the risk-managed design.
    expect(fut80.liquidation!).toBeLessThan(fut80.stopLoss);
    const fut88 = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 88, market: 'FUTURES' })!;
    expect(fut88.leverage).toBe(6);
    const india = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 90, market: 'INDIA' })!;
    expect(india.leverage).toBe(1);
  });

  it('wide-ATR coin: sane leverage floor engages (liq never inside the SL)', () => {
    // 8% ATR → stop ~12.8% away → 95/12.8 = 7 sane cap
    const p = buildExpertBlueprint({ side: 'LONG', ltp: 100, atr: 8, score: 95, market: 'FUTURES', maxLeverageCap: 10 })!;
    expect(p.leverage).toBeLessThanOrEqual(6);
    expect(p.maxSaneLeverage).toBeLessThanOrEqual(10);
    expect(p.liquidation!).toBeLessThan(p.stopLoss); // LONG: liq below SL (farther)
  });

  it('staged exit plan: 40/40/20 partials at T1/T2/T3', () => {
    const p = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 85, market: 'FUTURES' })!;
    expect(p.exitPlan).toHaveLength(3);
    expect(p.exitPlan.map(s => s.bookPct)).toEqual([40, 40, 20]);
    expect(p.exitPlan[0].at).toBeCloseTo(p.targets.t1, 1);
    expect(p.exitPlan[2].at).toBeCloseTo(p.targets.t3, 1);
    expect(p.exitPlan[0].action).toMatch(/breakeven/i);
  });

  it('timing: price near EMA20 → IMMEDIATE, far → PULLBACK', () => {
    const near = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 85, market: 'CRYPTO', ema20: 99.8 })!;
    expect(near.timing.mode).toBe('IMMEDIATE');
    const far = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 85, market: 'CRYPTO', ema20: 96 })!;
    expect(far.timing.mode).toBe('PULLBACK');
    expect(far.timing.note).toMatch(/EMA20/);
  });

  it('horizon: calm volatility → SWING, wild → INTRADAY', () => {
    const swing = buildExpertBlueprint({ side: 'LONG', ltp, atr, score: 85, market: 'CRYPTO', atrPctLtp: 1.0 })!;
    expect(swing.horizon.label).toBe('SWING');
    const intraday = buildExpertBlueprint({ side: 'LONG', ltp, atr: 3, score: 85, market: 'CRYPTO', atrPctLtp: 3.0 })!;
    expect(intraday.horizon.label).toBe('INTRADAY');
  });

  it('invalidation note always references the SL — never silent risk', () => {
    const p = buildExpertBlueprint({ side: 'SHORT', ltp, atr, score: 85, market: 'FUTURES' })!;
    expect(p.invalidation).toMatch(/SL/);
  });

  it('degenerate: no ltp → null blueprint', () => {
    expect(buildExpertBlueprint({ side: 'LONG', ltp: 0, atr, score: 85, market: 'CRYPTO' })).toBeNull();
  });
});

describe('pricePrecision — low-price coins keep real levels', () => {
  it('DOGE-class prices use 4+ decimals, majors 2', () => {
    expect(pricePrecision(6400000)).toBe(2);   // BTC INR
    expect(pricePrecision(122.5)).toBe(2);     // AAVE
    expect(pricePrecision(0.084)).toBe(4);      // DOGE
    expect(pricePrecision(0.00421)).toBe(6);    // SHIB-class
    expect(pricePrecision(0.0000123)).toBe(8); // micro-price
  });

  it('blueprint never rounds a DOGE entry to a lookalike of its SL', () => {
    const p = buildExpertBlueprint({ side: 'SHORT', ltp: 0.084, atr: 0.0011, score: 82, market: 'FUTURES' })!;
    expect(p.entry).not.toEqual(p.stopLoss);
    expect(p.targets.t1).not.toEqual(p.targets.t2);
    expect(p.targets.t2).not.toEqual(p.targets.t3);
    expect(p.stopLoss).toBeGreaterThan(p.entry); // SHORT
    expect(p.targets.t3).toBeLessThan(p.targets.t1);
  });
});
