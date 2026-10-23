// ============================================================
// test/mtfVoteV2.test.ts — v21.23.15 MTF VOTE V2
// Hermetic, network-free: exercises __tfVote directly with synthetic
// candle series. MTF_VOTE_V2 is default ON; legacy path is checked by
// flipping the env flag and restored afterwards.
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { __tfVote, __decideVoteDirection, mtfVoteV2Enabled } from '../server/ai/mtf.js';

const OPEN = 1_700_000_000_000;

/** Linear candles; `wick` inflates high/low (ATR) without changing closes. */
const linear = (n: number, start: number, step: number, wick = Math.abs(step) * 0.4 + 0.05) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = start + step * i;
    out.push({
      time: OPEN + i * 300_000,
      open: c - step / 2, high: c + wick, low: c - wick, close: c,
      volume: 100 + i,
    });
  }
  return out;
};

describe('v21.23.15 MTF vote v2', () => {
  afterEach(() => { delete process.env.MTF_VOTE_V2; });

  it('is ON by default and can be disabled by env', () => {
    delete process.env.MTF_VOTE_V2;
    expect(mtfVoteV2Enabled()).toBe(true);
    process.env.MTF_VOTE_V2 = '0';
    expect(mtfVoteV2Enabled()).toBe(false);
  });

  it('legacy flag keeps the old vote shape (no v2 telemetry)', () => {
    process.env.MTF_VOTE_V2 = '0';
    const v = __tfVote(linear(120, 100, 0.8), '5m')!;
    expect(v.dir).toBe(1);
    expect(v.voteEngine).toBe('legacy');
    expect(v.mom3Atr).toBeNull();
    expect(v.context2).toBeNull();
    expect(v.structureConflict).toBe(false);
  });

  it('ATR-normalizes 3-bar momentum — same % move on a wilder series is smaller', () => {
    const calm = __tfVote(linear(120, 100, 0.5, 0.2), '5m')!;
    const wild = __tfVote(linear(120, 100, 0.5, 5), '5m')!;
    expect(calm.voteEngine).toBe('v2');
    expect(wild.voteEngine).toBe('v2');
    expect(calm.mom3Atr).toBeGreaterThan(0);
    expect(wild.mom3Atr).toBeGreaterThan(0);
    expect(wild.mom3Atr!).toBeLessThan(calm.mom3Atr!);
  });

  it('2-bar context is neutral on a single-bar spike (no whipsaw momentum vote)', () => {
    const candles = linear(120, 100, 0.5);
    // last three closes: up, down → the two bars disagree (context 0)
    for (const [i, c] of [[117, 100.5], [118, 101.5], [119, 101.0]] as const) {
      const o = candles[i];
      o.open = c; o.close = c; o.high = c + 0.4; o.low = c - 0.4;
    }
    const v = __tfVote(candles, '5m')!;
    expect(v.context2).toBe(0);
  });

  it('caps a counter-structure vote at strength 60', () => {
    // 90 bars down, then a 20-bar V-bounce: price reclaims the EMAs but the
    // EMA20/50 stack is still bearish → the +1 vote must not read 100.
    const candles = [...linear(90, 200, -1), ...linear(20, 110, 2)];
    const v = __tfVote(candles, '15m')!;
    expect(v.dir).toBe(1);
    expect(v.structureDir).toBe(-1);
    expect(v.structureConflict).toBe(true);
    expect(v.rawStrength).toBeGreaterThan(60);
    expect(v.strength).toBe(60);
    expect(v.conf).toBe(60);
    expect(v.note).toContain('counter-structure');
  });

  it('does not publish a directional vote on a mid-band score', () => {
    // The higher 1.4 threshold is the contract; a genuinely flat tape must
    // not be forced LONG/SHORT just because the old 0.9 bar was crossed.
    const flat = linear(120, 100, 0).map((c, i) => ({
      ...c, open: 100, close: 100, high: 100.2 + (i % 2) * 0.05, low: 99.8,
    }));
    const v = __tfVote(flat, '15m')!;
    expect(v.dir).toBe(0);
  });

  it('keeps the legacy flat-MACD bear vote only when MTF_VOTE_V2=0', () => {
    const flat = linear(120, 100, 0).map((c, i) => ({
      ...c, open: 100, close: 100, high: 100.2 + (i % 2) * 0.05, low: 99.8,
    }));
    delete process.env.MTF_VOTE_V2;
    const v2 = __tfVote(flat, '15m')!;
    process.env.MTF_VOTE_V2 = '0';
    const legacy = __tfVote(flat, '15m')!;
    expect(v2.dir).toBe(0);
    expect(legacy.dir).toBe(-1);
    // The only intentional difference is the flat MACD tie (−0.35 legacy).
    expect(legacy.score).toBeLessThan(v2.score);
    expect(legacy.score).toBeCloseTo(v2.score - 0.35, 2);
  });

  it('forces a confirmed reversal direction even when low ADX dilutes amplitude', () => {
    // 1.8 × (0.6 + 0/50) = 1.08 < 1.4 → without the force path this is a
    // no-vote. The structure guard already proved the dump/pump side.
    const dump = __decideVoteDirection({ score: -1.8, adx: 0, v2: true, activeDump: true });
    expect(dump.scaled).toBeCloseTo(-1.08, 6);
    expect(dump.dir).toBe(-1);
    const noDump = __decideVoteDirection({ score: -1.8, adx: 0, v2: true, activeDump: false });
    expect(noDump.dir).toBe(0);
    const pump = __decideVoteDirection({ score: 1.8, adx: 0, v2: true, activePump: true });
    expect(pump.dir).toBe(1);
  });

  it('tags a real confirmed dump as reversal=dump with a bearish direction', () => {
    // Flat chop, then the last three bars break the 12-bar low.
    const candles = linear(120, 100, 0.02, 0.12);
    const drops = [100.0, 99.9, 99.8];
    for (let k = 0; k < drops.length; k++) {
      const i = 120 - 3 + k;
      const v = drops[k];
      candles[i] = { ...candles[i], open: v + 0.05, close: v, high: v + 0.08, low: v - 0.1 };
    }
    const v = __tfVote(candles, '15m')!;
    expect(v.reversal).toBe('dump');
    expect(v.dir).toBe(-1);
  });
});
