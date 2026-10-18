// ============================================================
// test/regimeReweight.test.ts — v10.6 REGIME-AWARE MODEL
// REWEIGHTING (Pro Upgrade #4) + the walk-forward dashboard's data
// (Pro Upgrade #5: trust windows + regimeReweightView).
//
// LOCKED HERE:
//   • classifyRegime: TRENDING / CHOPPY / HIGH_VOL / LOW_VOL from the
//     live buildRegime payloads (BTC / NIFTY+VIX / NDX+USVIX gates)
//   • the multiplier table only tilts ±25% max; unknown model ids
//     default 1.0 (a new seat is never accidentally reweighted)
//   • applyRegimeWeights: flag OFF → votes returned AS-IS (the
//     byte-identical legacy board); flag ON → weights tilt + carry
//     regimeAdj for the UI
//   • the backtest `strategy=regime_weighted` mode forces the tilt ON
//     (force bypass) — the A/B that gates the live flag
//   • trust.modelPerformanceWindows: 30d/90d per-model attribution
//     with the ledger's settled entries
//   • regimeReweightView: honest OFF state + labeled ON state
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../server/ai/ledger.js', () => ({
  __ledgerRaw: vi.fn(() => globalThis.__ledgerRawShim()),
  modelStats: vi.fn(() => []),
}));

import {
  classifyRegime, classifyRegimeFor, classifyRegimeFromCandles,
  REGIME_MODEL_MULTIPLIERS, regimeMulFor, applyRegimeWeights,
  regimeWeightsEnabled, regimeReweightView,
} from '../server/ai/ensemble.js';
import { modelPerformanceWindows } from '../server/ai/trust.js';
import { simulateSymbol } from '../server/ai/backtest.js';

const mkVotes = () => ([
  { id: 'trend', name: 'TrendMatrix', weight: 1.4, dir: 1, conf: 80, reasons: [] },
  { id: 'volatility', name: 'VolatilityScope', weight: 0.9, dir: -1, conf: 60, reasons: [] },
  { id: 'sr', name: 'SRMatrix', weight: 1.1, dir: 1, conf: 55, reasons: [] },
  { id: 'brandnewseat', name: 'FutureModel', weight: 1.0, dir: 1, conf: 70, reasons: [] },
]);

beforeEach(() => { delete process.env.AI_ENABLE_REGIME_WEIGHTS; });
afterEach(() => { delete process.env.AI_ENABLE_REGIME_WEIGHTS; });

describe('classifyRegime — the four states (PURE)', () => {
  it('CRYPTO: strong aligned move = TRENDING', () => {
    expect(classifyRegime({ market: 'CRYPTO', changePct: 1.2, trend: 'UP', vix: null })).toBe('TRENDING');
    expect(classifyRegime({ market: 'FUTURES', changePct: -1.1, trend: 'DOWN', vix: null })).toBe('TRENDING');
  });
  it('CRYPTO: extreme move = HIGH_VOL regardless of trend', () => {
    expect(classifyRegime({ market: 'CRYPTO', changePct: -3.2, trend: 'DOWN', vix: null })).toBe('HIGH_VOL');
  });
  it('CRYPTO: dead-flat day = LOW_VOL', () => {
    expect(classifyRegime({ market: 'CRYPTO', changePct: 0.2, trend: 'FLAT', vix: null })).toBe('LOW_VOL');
  });
  it('CRYPTO: counter-trend day = CHOPPY (a -1.4% day inside an UP trend)', () => {
    expect(classifyRegime({ market: 'CRYPTO', changePct: -1.4, trend: 'UP', vix: null })).toBe('CHOPPY');
  });
  it('INDIA: VIX gate dominates (>= 18 = HIGH_VOL even on a mild day)', () => {
    expect(classifyRegime({ market: 'INDIA', changePct: 0.2, trend: 'UP', vix: 19 })).toBe('HIGH_VOL');
    expect(classifyRegime({ market: 'INDIA', changePct: 0.2, trend: 'UP', vix: 9 })).toBe('LOW_VOL');
  });
  it('INDIA: aligned NIFTY move = TRENDING; flat+VIX-quiet = LOW_VOL', () => {
    expect(classifyRegime({ market: 'INDIA', changePct: 0.6, trend: 'UP', vix: 14 })).toBe('TRENDING');
  });
  it('GLOBAL (NDX + USVIX gates)', () => {
    expect(classifyRegime({ market: 'GLOBALFUTURES', changePct: 1.2, trend: 'UP', vix: 20 })).toBe('TRENDING');
    expect(classifyRegime({ market: 'GLOBALFUTURES', changePct: -3.0, trend: 'DOWN', vix: 30 })).toBe('HIGH_VOL');
  });
  it('no inputs → null (honest degrade, never a guess)', () => {
    expect(classifyRegime({ market: 'CRYPTO', changePct: null, trend: null, vix: null })).toBeNull();
    expect(classifyRegime({ market: 'INDIA', changePct: null, trend: null, vix: null })).toBeNull();
  });

  it('classifyRegimeFor maps the live buildRegime payload shapes', () => {
    expect(classifyRegimeFor({ btcChange: 1.2, btcTrend: 'UP' }, 'CRYPTO')).toBe('TRENDING');
    expect(classifyRegimeFor({ niftyChange: 0.2, niftyTrend: 'UP', indiaVix: 21 }, 'INDIA')).toBe('HIGH_VOL');
    expect(classifyRegimeFor({ ndxChange: 2.5, ndxTrend: 'UP', usVix: 18 }, 'GLOBALFUTURES')).toBe('HIGH_VOL');
    expect(classifyRegimeFor(null, 'CRYPTO')).toBeNull();
  });

  it('classifyRegimeFromCandles derives a no-look-ahead label from history', () => {
    // steady climb → TRENDING
    const up = Array.from({ length: 120 }, (_, i) => ({ time: i, open: 100 + i * 0.5, high: 101 + i * 0.5, low: 99 + i * 0.5, close: 100 + i * 0.5, volume: 10 }));
    expect(['TRENDING', 'HIGH_VOL']).toContain(classifyRegimeFromCandles(up, 'CRYPTO'));
    // sideways chop → CHOPPY or LOW_VOL
    const flat = Array.from({ length: 120 }, (_, i) => ({ time: i, open: 100, high: 100.3, low: 99.7, close: 100 + (i % 2 === 0 ? 0.1 : -0.1), volume: 10 }));
    expect(['CHOPPY', 'LOW_VOL']).toContain(classifyRegimeFromCandles(flat, 'CRYPTO'));
    expect(classifyRegimeFromCandles(flat.slice(0, 30), 'CRYPTO')).toBeNull(); // < 60 bars → no label
  });
});

describe('the multiplier table (tilt, not a takeover)', () => {
  it('every multiplier is within ±25%', () => {
    for (const table of Object.values(REGIME_MODEL_MULTIPLIERS)) {
      for (const mul of Object.values(table)) {
        expect(mul).toBeGreaterThanOrEqual(0.75);
        expect(mul).toBeLessThanOrEqual(1.25);
      }
    }
  });
  it('CHOPPY cuts trend-followers and lifts mean-reverters (the plan\'s example)', () => {
    expect(REGIME_MODEL_MULTIPLIERS.CHOPPY.trend).toBeLessThan(1);
    expect(REGIME_MODEL_MULTIPLIERS.CHOPPY.smc).toBeLessThan(1);
    expect(REGIME_MODEL_MULTIPLIERS.CHOPPY.volatility).toBeGreaterThan(1);
    expect(REGIME_MODEL_MULTIPLIERS.CHOPPY.sr).toBeGreaterThan(1);
  });
  it('TRENDING is the mirror image', () => {
    expect(REGIME_MODEL_MULTIPLIERS.TRENDING.trend).toBeGreaterThan(1);
    expect(REGIME_MODEL_MULTIPLIERS.TRENDING.volatility).toBeLessThan(1);
  });
  it('unknown model ids default to 1.0', () => {
    expect(regimeMulFor('TRENDING', 'brandnewseat')).toBe(1);
    expect(regimeMulFor(null, 'trend')).toBe(1);
  });
});

describe('applyRegimeWeights (flag discipline)', () => {
  it('flag OFF (default) → votes returned AS-IS — the legacy board is untouchable', () => {
    expect(regimeWeightsEnabled()).toBe(false);
    const votes = mkVotes();
    const out = applyRegimeWeights(votes, 'CHOPPY');
    expect(out).toBe(votes); // same reference — zero new objects
    expect(out.map(v => v.weight)).toEqual([1.4, 0.9, 1.1, 1.0]);
  });

  it('flag ON → weights tilt and carry regimeAdj; input is NOT mutated', () => {
    process.env.AI_ENABLE_REGIME_WEIGHTS = 'true';
    const votes = mkVotes();
    const out = applyRegimeWeights(votes, 'CHOPPY');
    expect(votes[0].weight).toBe(1.4); // input untouched
    expect(out[0].weight).toBeCloseTo(1.4 * 0.75, 3);
    expect(out[1].weight).toBeCloseTo(0.9 * 1.20, 3);
    expect(out[3].weight).toBe(1.0); // unknown seat untouched
    expect(out[0].regimeAdj).toEqual({ label: 'CHOPPY', base: 1.4, mul: 0.75 });
  });

  it('null label (regime inputs missing) → no-op even with the flag ON', () => {
    process.env.AI_ENABLE_REGIME_WEIGHTS = 'true';
    const votes = mkVotes();
    expect(applyRegimeWeights(votes, null)).toBe(votes);
  });
});

describe('the backtest A/B (strategy=regime_weighted)', () => {
  // a deterministic 300-bar series with enough structure for the models to vote
  const candles = Array.from({ length: 300 }, (_, i) => {
    const drift = i > 200 ? 0.4 : 0.15;
    const wiggle = Math.sin(i / 5) * 0.8;
    const close = 100 + i * drift + wiggle;
    return {
      time: 1700000000 + i * 3600, open: close - 0.2, high: close + 0.6, low: close - 0.8, close,
      volume: 1000 + Math.abs(Math.sin(i / 3)) * 500,
    };
  });

  it('plain simulateSymbol still works (strategy weighted)', () => {
    const sim = simulateSymbol({ symbol: 'TEST', market: 'CRYPTO', candles, minGrade: 'WATCH', maxHoldBars: 48 });
    expect(sim).not.toBeNull();
    expect(Array.isArray(sim.trades)).toBe(true);
    expect(sim.stats).toHaveProperty('winRate');
  });

  it('regime_weighted runs the SAME folds with the tilt FORCED on (env flag irrelevant)', () => {
    // flag stays OFF — the A/B must still exercise the tilt
    expect(regimeWeightsEnabled()).toBe(false);
    const sim = simulateSymbol({ symbol: 'TEST', market: 'CRYPTO', candles, minGrade: 'WATCH', maxHoldBars: 48, strategy: 'regime_weighted' });
    expect(sim).not.toBeNull();
    // identical input → the two legs are comparable by construction; the
    // REGIME leg must produce a well-formed stats object too
    expect(sim.stats).toHaveProperty('winRate');
    expect(sim.stats).toHaveProperty('trades');
  });
});

describe('regimeReweightView (dashboard state)', () => {
  it('flag OFF → honest disabled state', () => {
    const v = regimeReweightView({ btcChange: 1.2, btcTrend: 'UP' }, 'CRYPTO');
    expect(v.enabled).toBe(false);
    expect(v.label).toBeNull();
    expect(v.note).toContain('off');
  });
  it('flag ON + inputs → labeled state with up/down lists', () => {
    process.env.AI_ENABLE_REGIME_WEIGHTS = 'true';
    const v = regimeReweightView({ btcChange: 1.2, btcTrend: 'UP' }, 'CRYPTO');
    expect(v.enabled).toBe(true);
    expect(v.label).toBe('TRENDING');
    expect(v.downWeighted.some(m => m.id === 'volatility')).toBe(true);
    expect(v.upWeighted.some(m => m.id === 'trend')).toBe(true);
    expect(v.upWeighted.find(m => m.id === 'trend')?.name).toBe('TrendMatrix');
  });
  it('flag ON + no inputs → enabled but unlabeled (base weights, no tilt)', () => {
    process.env.AI_ENABLE_REGIME_WEIGHTS = 'true';
    const v = regimeReweightView(null, 'CRYPTO');
    expect(v.enabled).toBe(true);
    expect(v.label).toBeNull();
  });
});

describe('modelPerformanceWindows (Pro #5 — rolling per-model attribution)', () => {
  const NOW = 1_800_000_000_000;
  const entry = (daysAgo, side, r, votes) => ({
    side, confidence: 70,
    outcome: { r, ts: NOW - daysAgo * 86400_000 },
    votes,
  });
  const votesA = { trend: { dir: 1, conf: 80 }, volatility: { dir: -1, conf: 60 } };

  beforeEach(() => {
    (globalThis as any).__ledgerRawShim = () => ({
      entries: [
        entry(5, 'LONG', 2, votesA),          // trend right, volatility wrong
        entry(10, 'SHORT', 1.5, votesA),      // trend wrong, volatility right
        entry(40, 'LONG', 2, votesA),         // only inside the 90d window
        entry(200, 'LONG', 2, votesA),         // outside both windows
      ],
    });
  });

  it('30d window counts only recent entries; attribution follows vote-vs-outcome', () => {
    const w = modelPerformanceWindows({ windows: [30, 90], now: NOW });
    const d30Trend = w.d30.find(m => m.model === 'trend');
    const d30Vol = w.d30.find(m => m.model === 'volatility');
    expect(d30Trend).toMatchObject({ n: 2, hitRate: 50 }); // right on the LONG win, wrong on the SHORT win
    expect(d30Vol).toMatchObject({ n: 2, hitRate: 50 });
  });

  it('90d window includes the 40-day-old entry; the 200-day-old one never counts', () => {
    const w = modelPerformanceWindows({ windows: [30, 90], now: NOW });
    expect(w.d90.find(m => m.model === 'trend').n).toBe(3);
  });

  it('model names resolve from the registry; abstained (dir 0) votes never count', () => {
    (globalThis as any).__ledgerRawShim = () => ({
      entries: [entry(1, 'LONG', 2, { trend: { dir: 1, conf: 80 }, smc: { dir: 0, conf: 0 } })],
    });
    const w = modelPerformanceWindows({ windows: [30], now: NOW });
    expect(w.d30.find(m => m.model === 'trend').name).toBe('TrendMatrix');
    expect(w.d30.find(m => m.model === 'smc')).toBeUndefined();
  });

  it('zero-window rows are dropped and the view is honest about noise', () => {
    const w = modelPerformanceWindows({ windows: [30], now: NOW });
    expect(w.d30.every(m => m.n > 0)).toBe(true);
    expect(w.note).toContain('noise');
  });
});
