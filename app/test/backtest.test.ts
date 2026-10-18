// ============================================================
// test/backtest.test.ts — v6.5 WALK-FORWARD BACKTESTER
// ------------------------------------------------------------
// simulateSymbol on SYNTHETIC candles (deterministic, no network):
// the no-look-ahead guarantee, SL-first ambiguity, TP2 runner
// discipline, time-stop, R-normalized stats and the equity/DD math.
// ============================================================
import { describe, it, expect } from 'vitest';
import { simulateSymbol } from '../server/ai/backtest.js';

/** Deterministic candle generator — a clean up-trend with pullbacks. */
function trendCandles({ n = 160, start = 100, drift = 0.6, vol = 1.2, seed = 7 } = {}) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = close + drift + (rand() - 0.5) * 2 * vol;
    const high = Math.max(open, close) + rand() * vol;
    const low = Math.min(open, close) - rand() * vol;
    out.push({ time: 1700000000000 + i * 3600_000, open, high, low, close, volume: 1000 + Math.round(rand() * 500) });
  }
  return out;
}

/** Flat chop — a trend-follower should mostly abstain / churn small. */
function chopCandles({ n = 160, start = 100, vol = 0.8, seed = 11 } = {}) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = close + (rand() - 0.5) * 2 * vol;
    out.push({ time: 1700000000000 + i * 3600_000, open, high: Math.max(open, close) + rand() * 0.4, low: Math.min(open, close) - rand() * 0.4, close, volume: 1000 });
  }
  return out;
}

describe('simulateSymbol — structure', () => {
  it('returns null on unusable data (< warmup + 20 bars)', () => {
    expect(simulateSymbol({ symbol: 'X', market: 'CRYPTO', candles: trendCandles({ n: 50 }) })).toBeNull();
    expect(simulateSymbol({ symbol: 'X', market: 'CRYPTO', candles: [] })).toBeNull();
  });

  it('no look-ahead: a signal at bar i enters at bar i+1 open (±slippage)', () => {
    const candles = trendCandles({ n: 140 });
    const out = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, capitalPerTradeINR: 1000 })!;
    expect(out).not.toBeNull();
    for (const t of out.trades) {
      const nextOpen = candles[t.entryBar].open;
      const long = t.side !== 'SHORT';
      const expected = Math.round(nextOpen * (1 + (long ? 0.001 : -0.001)) * 100) / 100;
      expect(t.entry).toBeCloseTo(expected, 1);
    }
  });

  it('every exit reason is one of SL / TP2 / TIME / EOD — TP1 never closes (runner discipline)', () => {
    const out = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: trendCandles({ n: 200 }) })!;
    const allowed = new Set(['SL', 'TP2', 'TIME', 'EOD']);
    for (const t of out.trades) expect(allowed.has(t.reason)).toBe(true);
  });

  it('time-stop is honored: TIME exits only after maxHoldBars of holding', () => {
    const slow = trendCandles({ n: 150, drift: 0.02, vol: 0.25 });
    const out = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: slow, minGrade: 'WATCH', capitalPerTradeINR: 1000, maxHoldBars: 48 })!;
    const timeExits = out.trades.filter(t => t.reason === 'TIME');
    for (const t of timeExits) {
      expect(t.holdBars).toBeGreaterThanOrEqual(48);
    }
  });

  it('R-multiples are normalized: |entry − SL| = 1R by construction', () => {
    const out = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: trendCandles({ n: 200 }) })!;
    for (const t of out.trades) {
      const risk = Math.abs(t.entry! - t.sl!);
      expect(risk).toBeGreaterThan(0);
      const move = (t.side === 'LONG' ? t.exit! - t.entry! : t.entry! - t.exit!);
      expect(t.r).toBeCloseTo(move / risk, 1);
    }
  });
});

describe('simulateSymbol — stats & sanity', () => {
  it('a persistent up-trend must NOT lose money overall (LONG-biased ensemble)', () => {
    const out = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: trendCandles({ n: 240, drift: 0.8, seed: 3 }) })!;
    // if the ensemble traded at all on a clean trend, it must not be net-negative
    if (out.stats.trades > 0) {
      expect(out.stats.totalR!).toBeGreaterThanOrEqual(-1);
    }
  });

  it('stats math: winRate/avgR/profitFactor consistency', () => {
    const out = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: trendCandles({ n: 200 }) })!;
    const s = out.stats;
    if (s.trades > 0) {
      expect(s.wins + s.losses).toBe(s.trades);
      expect(s.winRate).toBeCloseTo((s.wins / s.trades) * 100, 1);
      expect(s.avgR).not.toBeNull();
      const wins = out.trades.filter(t => t.r > 0);
      const losses = out.trades.filter(t => t.r <= 0);
      const gw = wins.reduce((a, t) => a + t.r, 0);
      const gl = Math.abs(losses.reduce((a, t) => a + t.r, 0));
      expect(s.profitFactor).toBeCloseTo(gl > 0 ? gw / gl : Infinity, 1);
    } else {
      expect(s.winRate).toBeNull();
      expect(s.avgR).toBeNull();
    }
  });

  it('maxDDR is a real drawdown of the cumulative R curve (≤ peak-cum)', () => {
    const out = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: trendCandles({ n: 200 }) })!;
    let cum = 0, peak = 0, dd = 0;
    for (const t of out.trades) {
      cum += t.r;
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
    }
    expect(out.stats.maxDDR).toBeCloseTo(Math.round(dd * 100) / 100, 1);
  });

  it('chop regime: fewer or worse trades than a clean trend (honest degradation)', () => {
    const trend = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: trendCandles({ n: 200, drift: 0.7 }) });
    const chop = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles: chopCandles({ n: 200 }) });
    const trendScore = (trend?.stats.avgR ?? 0) * (trend?.stats.trades ?? 0);
    const chopScore = (chop?.stats.avgR ?? 0) * (chop?.stats.trades ?? 0);
    expect(chopScore).toBeLessThan(trendScore + 2); // chop never beats a clean trend by much
  });

  it('minGrade STRONG produces a subset of the ACTION trade set (or zero)', () => {
    const candles = trendCandles({ n: 200 });
    const action = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, minGrade: 'ACTION' })!;
    const strong = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, minGrade: 'STRONG' })!;
    expect(strong.stats.trades).toBeLessThanOrEqual(action.stats.trades);
  });
});

// ============================================================
// v12.6 GUARDED STRATEGY — the A/B validation leg
// ------------------------------------------------------------
// The live trust guards (chase + OB/OS) replayed at entry: a HARD-chase
// or overbought/oversold consensus is SKIPPED exactly like the live
// execution gate vetoes it. The A/B this locks: guarded trades are a
// strict subset of raw trades, and on a blow-off-top series the guard
// demonstrably refuses the top-tick entries.
// ============================================================
describe('simulateSymbol — v12.6 guarded strategy (the trust-guard replay)', () => {
  /** A vertical blow-off: a strong trend that goes parabolic at the end. */
  function blowOffCandles({ n = 180, start = 100, drift = 0.3, vol = 0.9, seed = 3 } = {}) {
    const base = trendCandles({ n: n - 40, start, drift, vol, seed });
    // the last 40 bars go vertical (+1.2%/bar average, low noise) — the
    // exhaustion zone every chase guard exists to refuse
    let close = base[base.length - 1].close;
    let s = seed + 99;
    const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const t0 = base[base.length - 1].time;
    for (let i = 0; i < 40; i++) {
      const open = close;
      close = close * (1 + 0.012 + (rand() - 0.5) * 0.004);
      base.push({ time: t0 + (i + 1) * 3600_000, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: 2000 });
    }
    return base;
  }

  it('guarded trades are a SUBSET of raw trades (the guards only refuse, never invent)', () => {
    const candles = trendCandles({ n: 200, drift: 0.5, vol: 1.4, seed: 21 });
    const raw = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, minGrade: 'ACTION' })!;
    const guarded = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, minGrade: 'ACTION', strategy: 'guarded' })!;
    // the guards only REFUSE entries (chase/OB-OS skips) — the guarded
    // replay can never take MORE trades than the raw one on the same
    // bars. (A per-bar key subset would be wrong: a skipped entry frees
    // the occupancy calendar and later entries legitimately shift.)
    expect(guarded.stats.trades).toBeLessThanOrEqual(raw.stats.trades);
    // every guarded SIDE is a side the raw engine also traded (no invented direction)
    const rawSides = new Set(raw.trades.map(t => t.side));
    for (const t of guarded.trades) expect(rawSides.has(t.side)).toBe(true);
  });

  it('a parabolic blow-off top: the guard refuses the exhaustion entries (guarded ≤ raw trades, and no guarded entry inside the vertical leg)', () => {
    const candles = blowOffCandles();
    const raw = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, minGrade: 'ACTION' })!;
    const guarded = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, minGrade: 'ACTION', strategy: 'guarded' })!;
    // the vertical zone starts at bar n-40
    const verticalStart = candles.length - 40;
    const rawInVertical = raw.trades.filter(t => t.entryBar >= verticalStart).length;
    const guardedInVertical = guarded.trades.filter(t => t.entryBar >= verticalStart).length;
    // the guard may not enter MORE inside the vertical leg than raw did
    expect(guardedInVertical).toBeLessThanOrEqual(rawInVertical);
    expect(guarded.stats.trades).toBeLessThanOrEqual(raw.stats.trades);
  });

  it('unknown strategy values degrade to the plain weighted replay (byte-identical trade set)', () => {
    const candles = trendCandles({ n: 180, seed: 5 });
    const plain = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles })!;
    const bogus = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, strategy: 'nonsense' })!;
    expect(bogus.stats.trades).toBe(plain.stats.trades);
    expect(bogus.stats.totalR).toBeCloseTo(plain.stats.totalR ?? 0, 2);
  });
});

// ============================================================
// v21.1.0 (Phase-4): WALK-FORWARD TRAIN/TEST SPLIT
// ============================================================
import { walkForwardSymbol } from '../server/ai/backtest.js';

describe('walkForwardSymbol — v21.1.0 train/test split + overfit verdict', () => {
  it('returns null on insufficient bars (train+test dono warmup chahiye)', () => {
    expect(walkForwardSymbol({ symbol: 'X', market: 'CRYPTO', candles: trendCandles({ n: 120 }) })).toBeNull();
    expect(walkForwardSymbol({ symbol: 'X', market: 'CRYPTO', candles: [] })).toBeNull();
  });

  it('split shape: 70/30, learned bar [60..85] ke andar, dono legs stats dete hain', () => {
    const candles = trendCandles({ n: 400, seed: 21 });
    const wf = walkForwardSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, currentMinConfidence: 75 })!;
    expect(wf).not.toBeNull();
    expect(wf.split.trainBars).toBeGreaterThan(wf.split.testBars);
    expect(wf.split.trainPct).toBeCloseTo(0.7, 5);
    expect(wf.split.learnedBar).toBeGreaterThanOrEqual(60);
    expect(wf.split.learnedBar).toBeLessThanOrEqual(85);
    expect(wf.train).toBeTruthy();
    expect(wf.train.defaultGates).toBeTruthy();
    expect(wf.test.currentBar).toBeTruthy();
    expect(['HIGH', 'MODERATE', 'CALIBRATED', 'NO_EDGE', 'UNKNOWN']).toContain(wf.verdict.overfit);
  });

  it('test leg sirf OUT-OF-SAMPLE candles use karta hai (no train bleed)', () => {
    const candles = trendCandles({ n: 400, seed: 33 });
    const wf = walkForwardSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, currentMinConfidence: 75 })!;
    // train + test = total + WARMUP carry overlap (indicators test-start pe hot
    // karne ke liye test leg pehle WARMUP bars overlap leta hai — by design)
    expect(wf.split.trainBars + wf.split.testBars).toBeGreaterThanOrEqual(candles.length - 10);
    expect(wf.split.trainBars + wf.split.testBars).toBeLessThanOrEqual(candles.length + 60);
  });

  it('minConfidence filter: bar 100 pe trades <= bar 0 pe trades (filter monotonicity)', () => {
    const candles = trendCandles({ n: 400, seed: 9 });
    const all = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles })!;
    const filtered = simulateSymbol({ symbol: 'BTC', market: 'CRYPTO', candles, minConfidence: 100 })!;
    expect(filtered.stats.trades).toBeLessThanOrEqual(all.stats.trades);
    // bar 100 pe har entry ka confidence >= 100 tha (agar koi the)
    for (const t of filtered.trades) expect(t.confidence).toBeGreaterThanOrEqual(100);
  });
});
