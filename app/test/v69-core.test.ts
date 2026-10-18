// ============================================================
// test/v69-core.test.ts — v6.9 SPLIT DESKS
// ------------------------------------------------------------
// Pure coverage for the TOP-5 composite ranking:
//   1. Eligibility (STRONG/ACTION + side + plan only)
//   2. Composite ordering (conf 40% · agree 20% · R:R 15% ·
//      participation 10% · regime 10% · momentum 5%)
//   3. Regime alignment scoring (NIFTY for India, BTC for crypto,
//      unknown-regime neutrality)
//   4. Honest short lists (fewer than 5 → never padded)
//   5. rank / score / rankReason payload fields
//   6. getSignals board carries topFive (INDIA + CRYPTO + FUTURES)
// ============================================================
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same trick as the other suites)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v69');

const { computeTopFive } = await import('../server/ai/signals.js');

const SIG = (over = {}) => ({
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 80, agreement: 0.75, participation: 0.9, participating: 9, totalModels: 10,
  ltp: 2400, changePct: 1.2,
  plan: { entry: 2400, stopLoss: 2320, target1: 2480, target2: 2560, riskPct: 3.33, rewardRisk: 2 },
  votes: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, dir: i < 7 ? 1 : -1, conf: 70 })),
  summary: 'test', aiNote: null, executable: true, generatedAt: Date.now(),
  ...over,
});

describe('v6.9 computeTopFive — pure ranking', () => {
  it('returns empty on empty/garbage input (honest, never padded)', () => {
    expect(computeTopFive([], { niftyChange: 1 }, 'INDIA')).toEqual([]);
    expect(computeTopFive(null as unknown as [], {}, 'INDIA')).toEqual([]);
    expect(computeTopFive(undefined as unknown as [], {}, 'INDIA')).toEqual([]);
  });

  it('only ACTIONABLE signals qualify (STRONG/ACTION, side, plan)', () => {
    const out = computeTopFive([
      SIG({ symbol: 'OK1', grade: 'STRONG' }),
      SIG({ symbol: 'OK2', grade: 'ACTION' }),
      SIG({ symbol: 'NO1', grade: 'WATCH' }),          // too weak
      SIG({ symbol: 'NO2', grade: 'NEUTRAL' }),        // neutral grade
      SIG({ symbol: 'NO3', side: 'FLAT' }),            // no side
      SIG({ symbol: 'NO4', plan: null }),              // no plan
      SIG({ symbol: 'NO5', plan: { entry: NaN } }),    // broken plan
    ], { niftyChange: 1 }, 'INDIA');
    expect(out.map(p => p.symbol)).toEqual(['OK1', 'OK2']);
    expect(out.every(p => p.rank >= 1 && p.rank <= 2)).toBe(true);
  });

  it('confidence dominates: 80% conf outranks 60% conf (all else equal)', () => {
    const out = computeTopFive([
      SIG({ symbol: 'LOW', confidence: 60 }),
      SIG({ symbol: 'HIGH', confidence: 80 }),
    ], { niftyChange: 0 }, 'INDIA');
    expect(out[0].symbol).toBe('HIGH');
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('regime alignment: with-trend LONG beats counter-trend LONG under NIFTY +1%', () => {
    const out = computeTopFive([
      SIG({ symbol: 'COUNTER', confidence: 80, agreement: 0.75, side: 'SHORT' }), // short vs +1% → counter
      SIG({ symbol: 'ALIGNED', confidence: 80, agreement: 0.75, side: 'LONG' }),  // long with +1% → aligned
    ], { niftyChange: 1 }, 'INDIA');
    expect(out[0].symbol).toBe('ALIGNED');
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('crypto regime uses btcChange (FUTURES desk same), not NIFTY', () => {
    const withBtc = computeTopFive([
      SIG({ symbol: 'A', side: 'LONG', market: 'CRYPTO' }),
      SIG({ symbol: 'B', side: 'SHORT', market: 'CRYPTO' }),
    ], { niftyChange: 2, btcChange: -2 }, 'CRYPTO');
    // BTC -2% → SHORT aligned, LONG counter → SHORT ranks first
    expect(withBtc[0].symbol).toBe('B');
    expect(withBtc[0].rankReason).toContain('BTC');
    expect(withBtc[0].rankReason).toContain('ALIGNED');
  });

  it('unknown regime → neutral 50 (neither reward nor penalty), reason says so', () => {
    const [p] = computeTopFive([SIG()], { niftyChange: null }, 'INDIA');
    expect(p.rankReason).toContain('regime nahi mila');
    const [p2] = computeTopFive([SIG()], {}, 'INDIA');
    expect(p2.rankReason).toContain('regime nahi mila');
  });

  it('caps at 5 and assigns sequential medals/ranks', () => {
    const sigs = Array.from({ length: 8 }, (_, i) => SIG({ symbol: `S${i}`, confidence: 80 - i }));
    const out = computeTopFive(sigs, {}, 'INDIA');
    expect(out).toHaveLength(5);
    expect(out.map(p => p.rank)).toEqual([1, 2, 3, 4, 5]);
    // sorted by confidence descending → S0 first
    expect(out[0].symbol).toBe('S0');
  });

  it('score fields: rounded to 0.1, bounded 0-100 inputs, reason mentions conf + votes', () => {
    const [p] = computeTopFive([SIG({ confidence: 100, agreement: 1, participation: 1 })], { niftyChange: 5 }, 'INDIA');
    // perfect signal with trend: 0.4*100 + 0.2*100 + 0.15*100 + 0.1*100 + 0.1*100 + momentum
    expect(p.score).toBeGreaterThan(90);
    expect(p.score).toBeLessThanOrEqual(100.5);
    expect(p.rankReason).toContain('conf 100%');
    expect(p.rankReason).toContain('models');
  });

  it('clamp inputs: over-range confidence/agreement/RR cannot inflate the score', () => {
    const wild = SIG({ confidence: 1000, agreement: 5, changePct: 99, plan: { entry: 100, stopLoss: 50, target1: 150, target2: 200, rewardRisk: 50 } });
    const [p] = computeTopFive([wild], { niftyChange: 10 }, 'INDIA');
    expect(p.score).toBeLessThanOrEqual(100.5);
  });

  it('does NOT mutate the input signals (pure spread)', () => {
    const input = [SIG()];
    const snapshot = JSON.stringify(input);
    computeTopFive(input, { niftyChange: 1 }, 'INDIA');
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input[0].rank).toBeUndefined();
  });

  it('limit parameter honored', () => {
    const sigs = Array.from({ length: 6 }, (_, i) => SIG({ symbol: `S${i}`, confidence: 60 + i }));
    expect(computeTopFive(sigs, {}, 'INDIA', 3)).toHaveLength(3);
    expect(computeTopFive(sigs, {}, 'INDIA', 1)).toHaveLength(1);
  });
});

// ---------------- board payload integration ----------------
describe('v6.9 board payload carries topFive', () => {
  it('getSignals payload shape includes topFive on all three desks (cached honest fallback)', async () => {
    const { getSignals } = await import('../server/ai/signals.js');
    // Live network from this box is unreliable (CF-blocks) — the board
    // either resolves (ok:true + topFive array of ≤5) or degrades
    // honestly (ok:false + topFive:[]). Both are contract-compliant.
    for (const market of ['INDIA', 'CRYPTO', 'FUTURES'] as const) {
      const payload = await getSignals(market, {}, { noCache: true, limit: 10 });
      expect(Array.isArray(payload.topFive)).toBe(true);
      expect(payload.topFive.length).toBeLessThanOrEqual(5);
      if (payload.ok) {
        expect(payload.topFive.every(p => p.rank >= 1 && p.rank <= 5)).toBe(true);
        expect(payload.topFive.every(p => typeof p.score === 'number' && typeof p.rankReason === 'string')).toBe(true);
      } else {
        expect(payload.topFive).toEqual([]);
      }
    }
  }, 120_000);
});
