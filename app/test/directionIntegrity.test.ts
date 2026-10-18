// ============================================================
// test/directionIntegrity.test.ts — v9.2 DIRECTION & PRECISION GUARD
// ------------------------------------------------------------
// The user-reported bug: "SHORT ke trade lagane pe LONG jaa raha hai"
// (signals/trades going the wrong way). The full code audit found the
// engine's direction logic CORRECT — the real killers were:
//   1. FIXED 2-decimal rounding collapsing sub-1 instruments
//      (DOGE 0.0848 → entry 0.08 · SL 0.09 · T1 0.08 · T2 0.08;
//      OP's SL landed ON the entry = instant stop-out; SHIB's
//      entry rounded to 0 = position never tradeable).
//   2. Absurd-ATR plans putting LONG stops / SHORT targets NEGATIVE
//      (JUP expert pick served t1 = −0.0000161).
// These tests pin BOTH the direction pipeline end-to-end AND the
// adaptive precision so a future edit can never re-collapse the
// levels onto each other (or flip a side) silently.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  aggregateVotes, buildTradePlan, computeTrailSl, fitPlanToRiskCap,
  computeLeverageView, buildSignal,
} from '../server/ai/ensemble.js';
import { runQuantModels } from '../server/ai/models.js';
import { pricePrecision, pRound, MAX_STOP_FRACTION } from '../server/ai/lib/priceRound.js';
import { buildExpertBlueprint } from '../server/ai/expertPicks.js';

// ---- helpers ---------------------------------------------------
const v = (id, dir, conf, weight = 1) => ({ id, name: id, role: 'test', weight, dir, conf, reasons: [] });

const bullCtx = {
  market: 'CRYPTO', symbol: 'TEST', ltp: 100, changePct: 2.5,
  ind: {
    ema10: 101, ema20: 100, ema50: 98,               // bullish stack, price above ema10
    rsi: 62, macd: { hist: 0.5, histSlope: 0.1 },     // bullish zone, rising
    stochK: 65, stochD: 55,
    adx: { adx: 32, plusDI: 28, minusDI: 14 },        // trending, +DI leads
    supertrend: { direction: 1 },
    relVolume: 1.6, obvSlope: 0.4, mfi: 62, vwap: 99, // vol-backed upmove, above VWAP
    atr: 2, atrPct: 55,
    bollinger: { percentB: 0.75, widthPct: 3 },
    patterns: [{ name: 'Bullish Engulfing', bias: 1 }],
    high52w: 120, low52w: 60,
    pivot: { p: 99, r1: 101, s1: 97 },
  },
  candles: null, options: null, regime: { btcChange: 1.2 },
};

const bearCtx = {
  market: 'CRYPTO', symbol: 'TEST', ltp: 100, changePct: -2.5,
  ind: {
    ema10: 99, ema20: 100, ema50: 102,               // bearish stack, price below ema10
    rsi: 38, macd: { hist: -0.5, histSlope: -0.1 },   // bearish zone, falling
    stochK: 35, stochD: 45,
    adx: { adx: 32, plusDI: 14, minusDI: 28 },        // trending, -DI leads
    supertrend: { direction: -1 },
    relVolume: 1.6, obvSlope: -0.4, mfi: 38, vwap: 101,
    atr: 2, atrPct: 55,
    bollinger: { percentB: 0.25, widthPct: 3 },
    patterns: [{ name: 'Bearish Engulfing', bias: -1 }],
    high52w: 120, low52w: 60,
    pivot: { p: 101, r1: 103, s1: 99 },
  },
  candles: null, options: null, regime: { btcChange: -1.2 },
};

const voteDir = (votes, id) => votes.find(x => x.id === id)?.dir;

// ================= 1. priceRound lib ============================
describe('priceRound — adaptive precision', () => {
  it('keeps 2 decimals at ₹1 and above (identical to the old r2)', () => {
    expect(pricePrecision(259.3)).toBe(2);
    expect(pRound(259.3333)).toBe(259.33);
    expect(pRound(1129.2)).toBe(1129.2);
    expect(pRound(1.352)).toBe(1.35);
  });
  it('widens to 4 decimals below 1 (DOGE class)', () => {
    expect(pricePrecision(0.64)).toBe(4);
    expect(pRound(0.0848)).toBe(0.0848);
    expect(pRound(0.08484)).toBe(0.0848);
  });
  it('widens to 6/8 decimals for micro ticks (SHIB/PEPE class)', () => {
    expect(pricePrecision(0.0081)).toBe(6);
    expect(pRound(0.0008521)).toBe(0.000852);
    expect(pricePrecision(0.00000881)).toBe(8);
    expect(pRound(0.000008813)).toBe(0.00000881);
  });
  it('passes null/undefined through as null (never 0)', () => {
    expect(pRound(null)).toBeNull();
    expect(pRound(undefined)).toBeNull();
    expect(pRound(Number.NaN)).toBeNull();
  });
});

// ================= 2. plan precision (the DOGE/OP bug) ==========
describe('buildTradePlan — sub-1 instruments stay DISTINCT', () => {
  const cons = { side: 'SHORT', dir: -1, confidence: 70, agreement: 0.9, participation: 1, grade: 'ACTION', participating: 6, totalModels: 10 };

  it('DOGE-class SHORT: entry/SL/T1/T2 all distinct, geometry direction-consistent', () => {
    // ltp 0.0848, ATR 0.0019 → 1.6×ATR = 0.00304 stop distance (3.6%)
    const plan = buildTradePlan(cons, { ltp: 0.0848, ind: { atr: 0.0019 } }, 'FUTURES');
    expect(plan).not.toBeNull();
    expect(plan.entry).toBeCloseTo(0.0848, 6);
    expect(plan.stopLoss).toBeGreaterThan(plan.entry);      // SHORT: SL above
    expect(plan.target1).toBeLessThan(plan.entry);          // SHORT: T below
    expect(plan.target2).toBeLessThan(plan.target1);        // SHORT: T2 below T1
    // the old r2 collapse produced T1 === T2 === entry — banned now
    expect(plan.target1).not.toBe(plan.entry);
    expect(plan.target2).not.toBe(plan.target1);
    expect(plan.stopLoss).not.toBe(plan.entry);             // OP bug: SL === entry
    expect(plan.risk).toBeGreaterThan(0);
  });

  it('LONG mirror: SL < entry < T1 < T2, all distinct below 1', () => {
    const plan = buildTradePlan({ ...cons, side: 'LONG', dir: 1 }, { ltp: 0.6437, ind: { atr: 0.0145 } }, 'FUTURES');
    expect(plan.stopLoss).toBeLessThan(plan.entry);
    expect(plan.target1).toBeGreaterThan(plan.entry);
    expect(plan.target2).toBeGreaterThan(plan.target1);
    expect(plan.stopLoss).not.toBe(plan.entry);
  });

  it('absurd ATR (283% of price) is capped at 30% — no negative levels', () => {
    const plan = buildTradePlan(cons, { ltp: 0.00000881, ind: { atr: 0.000025 } }, 'CRYPTO');
    expect(plan).not.toBeNull();
    expect(plan.stopLoss).toBeLessThanOrEqual(0.00000881 * (1 + MAX_STOP_FRACTION + 1e-9));
    expect(plan.target2).toBeGreaterThan(0);
    expect(plan.riskPct).toBeLessThanOrEqual(30.01);
    expect(String(plan.planStyle)).toContain('stop-capped');
  });

  it('prices ≥ 1 round exactly as the old engine did (2dp)', () => {
    const plan = buildTradePlan({ ...cons, side: 'LONG', dir: 1 }, { ltp: 259.333, ind: { atr: 4.81 } }, 'INDIA');
    expect(plan.entry).toBe(259.33);
  });
});

describe('fitPlanToRiskCap — sub-1 fit keeps levels distinct', () => {
  it('SHORT DOGE-class: fitted SL/T stay on the correct side, distinct from entry', () => {
    const sig = {
      side: 'SHORT', ltp: 0.0848,
      plan: { entry: 0.0848, stopLoss: 0.0879, target1: 0.0817, target2: 0.0786, risk: 0.0031, riskPct: 6.5, rewardRisk: 2, planStyle: 'atr-based' },
    };
    const { signal } = fitPlanToRiskCap(sig, 5);
    const p = signal.plan;
    expect(p.riskPct).toBe(5);
    expect(p.stopLoss).toBeGreaterThan(signal.ltp);   // SHORT SL above entry
    expect(p.target1).toBeLessThan(signal.ltp);
    expect(p.target2).toBeLessThan(p.target1);
    expect(p.stopLoss).not.toBe(signal.ltp);
    expect(p.target1).not.toBe(p.target2);
  });
});

// ================= 3. leverage / trail precision ===============
describe('computeLeverageView + computeTrailSl — sub-1 precision', () => {
  it('liquidation stays distinct from entry on a 0.08 coin at 5x', () => {
    const view = computeLeverageView({ side: 'LONG', entry: 0.0848, stopLoss: 0.0750, target2: 0.1044, marginINR: 200, leverage: 5 });
    expect(view).not.toBeNull();
    // exact: 0.0848 × (1 − 0.95/5) = 0.068688 → pRound 4dp. The old r2
    // collapsed this to 0.07 — a liquidation 2% away from the true one.
    expect(view.liquidation).toBe(0.0687);
    expect(view.liquidation).not.toBe(0.07); // the old 2dp lie
    expect(view.liqBeforeSl).toBe(false);
  });

  it('trail stop on a sub-1 LONG stays strictly between SL and price', () => {
    const t = computeTrailSl({
      side: 'LONG', entryPrice: 0.0848, peakPrice: 0.1044, currentSl: 0.075,
      initialRisk: 0.0098, price: 0.0951, armR: 1, offsetR: 1,
    });
    expect(t).not.toBeNull();
    expect(t.sl).toBeGreaterThan(0.0848);        // breakeven+ floor
    expect(t.sl).toBeLessThan(0.0951);           // never crosses live price
    expect(t.sl).not.toBe(0.08);                 // the old 2dp collapse
  });
});

// ================= 4. direction pipeline (end-to-end) ============
describe('direction pipeline — votes → consensus → plan geometry', () => {
  it('a full bullish confluence context votes LONG across the committee', () => {
    const votes = runQuantModels(bullCtx);
    expect(voteDir(votes, 'trend')).toBe(1);
    expect(voteDir(votes, 'momentum')).toBe(1);
    expect(voteDir(votes, 'volume')).toBe(1);
    const bull = votes.filter(x => x.dir > 0).length;
    const bear = votes.filter(x => x.dir < 0).length;
    expect(bull).toBeGreaterThan(bear);
    const cons = aggregateVotes(votes.map(x => ({ ...x })));
    expect(['LONG', 'FLAT']).toContain(cons.side); // bullish context never yields SHORT
    if (cons.side === 'LONG') {
      const plan = buildTradePlan(cons, bullCtx, 'CRYPTO');
      expect(plan.stopLoss).toBeLessThan(plan.entry);
      expect(plan.target2).toBeGreaterThan(plan.entry);
    }
  });

  it('a full bearish confluence context votes SHORT across the committee', () => {
    const votes = runQuantModels(bearCtx);
    expect(voteDir(votes, 'trend')).toBe(-1);
    expect(voteDir(votes, 'momentum')).toBe(-1);
    expect(voteDir(votes, 'volume')).toBe(-1);
    const cons = aggregateVotes(votes.map(x => ({ ...x })));
    expect(['SHORT', 'FLAT']).toContain(cons.side);
    if (cons.side === 'SHORT') {
      const plan = buildTradePlan(cons, bearCtx, 'CRYPTO');
      expect(plan.stopLoss).toBeGreaterThan(plan.entry);
      expect(plan.target2).toBeLessThan(plan.entry);
    }
  });

  it('weighted vote-sum sign ALWAYS matches the final side (no inversion)', () => {
    for (const ctx of [bullCtx, bearCtx]) {
      const votes = runQuantModels(ctx);
      const cons = aggregateVotes(votes.map(x => ({ ...x })));
      const wsum = votes.reduce((a, x) => a + (x.dir || 0) * (x.weight || 0) * ((x.conf || 0) / 100), 0);
      if (wsum > 0) expect(cons.side).toBe('LONG');
      else if (wsum < 0) expect(cons.side).toBe('SHORT');
      else expect(cons.side).toBe('FLAT');
    }
  });

  it('buildSignal stamps the consensus side verbatim (LONG stays LONG)', () => {
    const votes = [v('trend', 1, 90, 1.4), v('momentum', 1, 80, 1.3), v('volume', 1, 70, 1.2)];
    const cons = aggregateVotes(votes);
    const plan = buildTradePlan(cons, bullCtx, 'CRYPTO');
    const sig = buildSignal({ symbol: 'TEST', market: 'CRYPTO', ctx: bullCtx, votes, consensus: cons, plan });
    expect(sig.side).toBe(cons.side);
    expect(sig.plan.stopLoss).toBeLessThan(sig.plan.entry);
  });

  it('trendMatrix flip-watch: bullish stack + price UNDER ema10 downgrades to neutral (isolated)', () => {
    const mk = (ltp) => ({
      market: 'CRYPTO', symbol: 'T', ltp, changePct: 0,
      ind: { ema10: 100.5, ema20: 100, ema50: 99.8 }, // bullish stack, nothing else
      candles: null, options: null, regime: {},
    });
    const flip = runQuantModels(mk(99.9)).find(x => x.id === 'trend');   // price < ema10
    const aligned = runQuantModels(mk(100.6)).find(x => x.id === 'trend'); // price > ema10
    expect(flip.reasons.join(' ')).toContain('flip watch');
    expect(aligned.reasons.join(' ')).toContain('bullish stack');
    expect(flip.dir).toBe(0);      // halved stack alone can't clear the ±1.2 threshold
    expect(aligned.dir).toBe(1);    // price-confirmed stack votes LONG
    expect(flip.conf).toBeLessThan(aligned.conf);
  });
});

// ================= 5. expert blueprint sanity ===================
describe('buildExpertBlueprint — micro-tick coins stay tradeable', () => {
  it('JUP-class (ATR 283% of price): stop capped, all targets positive', () => {
    const bp = buildExpertBlueprint({
      side: 'LONG', ltp: 0.00000881, atr: 0.000025, score: 60, market: 'CRYPTO',
      ema20: 0.0000089, atrPctLtp: 283,
    });
    expect(bp).not.toBeNull();
    expect(bp.stopLoss).toBeGreaterThan(0);
    expect(bp.stopLoss).toBeLessThan(bp.entry);           // LONG: SL below entry
    expect(bp.targets.t1).toBeGreaterThan(bp.entry);
    expect(bp.targets.t2).toBeGreaterThan(bp.targets.t1);
    expect(bp.targets.t3).toBeGreaterThan(bp.targets.t2);
    expect(bp.slDistPct).toBeLessThanOrEqual(30.01);
    expect(bp.entryZone[0]).toBeGreaterThan(0);          // zone low edge floored
  });

  it('JUP-class SHORT mirror: 3R runner (t3) stays POSITIVE under the 30% cap', () => {
    const bp = buildExpertBlueprint({
      side: 'SHORT', ltp: 0.00000881, atr: 0.000025, score: 60, market: 'CRYPTO',
      ema20: 0.0000089, atrPctLtp: 283,
    });
    // 1 − 3×0.30 = +10% of price — the old 45% cap produced a NEGATIVE t3
    expect(bp.targets.t3).toBeGreaterThan(0);
    expect(bp.targets.t2).toBeGreaterThan(bp.targets.t3);
    expect(bp.stopLoss).toBeGreaterThan(bp.entry);
  });

  it('SHORT blueprint: SL above entry, targets below, all positive', () => {
    const bp = buildExpertBlueprint({
      side: 'SHORT', ltp: 0.0848, atr: 0.0019, score: 82, market: 'FUTURES',
      ema20: 0.084, atrPctLtp: 2.2,
    });
    expect(bp.stopLoss).toBeGreaterThan(bp.entry);
    expect(bp.targets.t1).toBeLessThan(bp.entry);
    expect(bp.targets.t2).toBeLessThan(bp.targets.t1);
    expect(bp.targets.t3).toBeGreaterThan(0);
    expect(bp.entryZone[0]).toBeGreaterThan(0);
  });
});
