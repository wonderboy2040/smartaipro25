// ============================================================
// test/superIntel.test.ts — v9 SUPERINTELLIGENCE PRO TRADER ENGINE
// ------------------------------------------------------------
// Pure-function coverage for the Signal Board's superintelligence
// layer (both desks — the 10-model committee board AND the dual-AI
// intraday scanner):
//   1. computeSuperScore — the AI SCORE blend + tier ladder
//      (85+ ELITE / 80+ STRONG / 65+ ACTION / 50+ WATCH), the
//      redistribution when AI/expert inputs are absent, the honest
//      quality adjustments (extension veto cap, MTF ±4, session −6,
//      quorum −4, counter-regime −6, agreement +3) and the hard cap
//      (the intraday B-grade is watch-only → 64).
//   2. superTier — boundary exactness.
//   3. buildSuperBlueprint — the complete pro-trader ticket math:
//      entry timing window (EMA distance), the liquidation-aware
//      leverage ladder (spot 1× / futures tier-capped), LONG/SHORT
//      liquidation side, staged 40/40/20 exit with T3 = 3R.
//   4. exitClock — India hard square-off vs crypto horizon clock.
//   5. intradayExpertFactors — the 7-factor expert score from the
//      intraday scanner's signal shape (side-aware, 0-100).
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  computeSuperScore, superTier, buildSuperBlueprint, exitClock,
  intradayExpertFactors, SUPER_TIERS,
} from '../server/ai/superIntel.js';

describe('v9 computeSuperScore — AI SCORE blend + tier ladder', () => {
  it('tier boundaries are exact: 85 ELITE · 80 STRONG · 65 ACTION · 50 WATCH', () => {
    expect(superTier(85)).toBe('ELITE');
    expect(superTier(84)).toBe('STRONG');
    expect(superTier(80)).toBe('STRONG');
    expect(superTier(79)).toBe('ACTION');
    expect(superTier(65)).toBe('ACTION');
    expect(superTier(64)).toBe('WATCH');
    expect(superTier(50)).toBe('WATCH');
    expect(superTier(49)).toBe('NEUTRAL');
    expect(SUPER_TIERS.STRONG).toBe(80);
  });

  it('three-source blend: 45% engine + 35% expert + 20% AI', () => {
    // 90×0.45 + 80×0.35 + 100×0.20 = 40.5 + 28 + 20 = 88.5 → 89 ELITE
    const r = computeSuperScore({ engineConf: 90, expertScore: 80, aiConf: 100 });
    expect(r.aiScore).toBe(89);
    expect(r.tier).toBe('ELITE');
  });

  it('without AI: weights redistribute to 55/45 engine/expert', () => {
    // 80×0.55 + 80×0.45 = 80 → STRONG boundary
    const r = computeSuperScore({ engineConf: 80, expertScore: 80 });
    expect(r.aiScore).toBe(80);
    expect(r.tier).toBe('STRONG');
  });

  it('without expert: engine × AI only (65/35)', () => {
    // 80×0.65 + 90×0.35 = 52 + 31.5 = 83.5 → 84 STRONG
    const r = computeSuperScore({ engineConf: 80, aiConf: 90 });
    expect(r.aiScore).toBe(84);
    expect(r.tier).toBe('STRONG');
  });

  it('engine-only: the score IS the engine conviction', () => {
    const r = computeSuperScore({ engineConf: 72 });
    expect(r.aiScore).toBe(72);
    expect(r.tier).toBe('ACTION');
  });

  it('extension veto hard-caps the score at 65 — never STRONG while extended', () => {
    const r = computeSuperScore({
      engineConf: 95, expertScore: 90, aiConf: 95,
      quality: { extension: { veto: true } },
    });
    expect(r.aiScore).toBe(65);
    expect(r.tier).toBe('ACTION');
  });

  it('hard cap (intraday B-grade watch-only) beats every blend', () => {
    const r = computeSuperScore({ engineConf: 100, expertScore: 95, aiConf: 100, cap: 64 });
    expect(r.aiScore).toBe(64);
    expect(r.tier).toBe('WATCH');
  });

  it('quality adjustments move the score by their documented amounts', () => {
    const base = computeSuperScore({ engineConf: 70, expertScore: 70 }); // 70
    // MTF aligned +4, session closed −6, counter-regime −6 → 62
    const adj = computeSuperScore({
      engineConf: 70, expertScore: 70,
      quality: { mtf: { available: true, aligned: true }, session: { tradeable: false } },
      counterTrend: true,
    });
    expect(adj.aiScore).toBe(62);
    // agreement ≥ 0.8 → +3
    const agree = computeSuperScore({ engineConf: 70, expertScore: 70, agreement: 0.85 });
    expect(agree.aiScore).toBe(73);
    expect(base.aiScore).toBe(70);
  });

  it('drivers name their sources (expert + AI + engine)', () => {
    const r = computeSuperScore({ engineConf: 80, expertScore: 82, aiConf: 88 });
    expect(r.drivers.join(' ')).toContain('7-factor expert score');
    expect(r.drivers.join(' ')).toContain('AI verdict');
    expect(r.drivers.join(' ')).toContain('engine conviction');
    expect(r.drivers.length).toBeLessThanOrEqual(4);
  });

  it('score is clamped to 1..99 — no 0 or 100 lies', () => {
    expect(computeSuperScore({ engineConf: 100, expertScore: 100, aiConf: 100 }).aiScore).toBeLessThanOrEqual(99);
    expect(computeSuperScore({ engineConf: 0, expertScore: 0, aiConf: 0 }).aiScore).toBeGreaterThanOrEqual(1);
  });
});

describe('v9 buildSuperBlueprint — the complete pro-trader ticket', () => {
  const base = {
    side: 'LONG' as const, ltp: 100, atr: 2, market: 'FUTURES' as const,
    stopLoss: 96.8, target1: 103.2, target2: 106.4, ema20: 99, // risk 3.2 → T1 1R · T2 2R
    atrPctLtp: 2.0, now: Date.parse('2026-09-10T10:30:00+05:30'),
  };

  it('FUTURES leverage ladder is tier-capped: ELITE 6x · STRONG 5x · else 3x', () => {
    const elite = buildSuperBlueprint({ ...base, aiScore: 90 });
    const strong = buildSuperBlueprint({ ...base, aiScore: 82 });
    const action = buildSuperBlueprint({ ...base, aiScore: 70 });
    expect(elite?.leverage).toBe(6);
    expect(strong?.leverage).toBe(5);
    expect(action?.leverage).toBe(3);
  });

  it('leverage is also capped by the SL-distance sane-max (never liquidates first)', () => {
    // SL 30% away → sane = floor(95/30) = 3 → tier cap 6 vs sane 3 → 3
    const wide = buildSuperBlueprint({ ...base, ltp: 100, stopLoss: 70, target1: 130, target2: 160, aiScore: 90 });
    expect(wide?.leverage).toBe(3);
    expect(wide?.maxSaneLeverage).toBe(3);
  });

  it('LONG liquidation sits BELOW entry; SHORT above; spot reads 1× with none', () => {
    const long = buildSuperBlueprint({ ...base, aiScore: 82 });
    expect(long?.liquidation).not.toBeNull();
    expect(long!.liquidation!).toBeLessThan(100);
    const short = buildSuperBlueprint({ ...base, side: 'SHORT', stopLoss: 103.2, target1: 96.8, target2: 93.6, aiScore: 82 });
    expect(short!.liquidation!).toBeGreaterThan(100);
    const spot = buildSuperBlueprint({ ...base, market: 'CRYPTO', aiScore: 95 });
    expect(spot?.leverage).toBe(1);
    expect(spot?.liquidation).toBeNull();
  });

  it('staged exit plan is 40/40/20 with T3 at 3R', () => {
    const bp = buildSuperBlueprint({ ...base, aiScore: 80 });
    const books = bp?.exitPlan.map(e => e.bookPct);
    expect(books).toEqual([40, 40, 20]);
    expect(books!.reduce((a, b) => a + b, 0)).toBe(100);
    expect(bp?.targets.t3).toBeGreaterThan(bp!.targets.t2!);
  });

  it('entry timing: near EMA20 → IMMEDIATE, far → PULLBACK with a limit zone', () => {
    const now = buildSuperBlueprint({ ...base, ema20: 99.5, aiScore: 80 }); // 0.25 ATR away
    expect(now?.entryTiming?.mode).toBe('IMMEDIATE');
    const pull = buildSuperBlueprint({ ...base, ema20: 90, aiScore: 80 }); // 5 ATR away
    expect(pull?.entryTiming?.mode).toBe('PULLBACK');
    expect(pull?.entryZone?.[0]).toBeLessThan(pull!.entryZone![1]!);
  });

  it('India reads the honest MIS note and a 1× plan', () => {
    const ind = buildSuperBlueprint({ ...base, market: 'INDIA', aiScore: 90 });
    expect(ind?.leverage).toBe(1);
    expect(ind?.leverageNote).toContain('MIS');
  });

  it('rejects degenerate inputs (no ltp / no levels)', () => {
    expect(buildSuperBlueprint({ ...base, ltp: 0 })).toBeNull();
    expect(buildSuperBlueprint({ ...base, stopLoss: NaN as unknown as number })).toBeNull();
  });
});

describe('v9 exitClock — the EXIT TIME', () => {
  it('INDIA: hard NSE square-off clock', () => {
    const c = exitClock({ market: 'INDIA', now: Date.parse('2026-09-10T11:00:00+05:30') });
    expect(c.exitBy).toBe('15:10 IST');
    expect(c.horizon.label).toBe('INTRADAY');
    expect(c.horizon.hours).toBeLessThan(8);
  });

  it('CRYPTO: high volatility → 8h intraday clock; sane → 72h swing clock', () => {
    const t0 = Date.parse('2026-09-10T21:00:00+05:30');
    const hot = exitClock({ market: 'CRYPTO', atrPctLtp: 3.4, now: t0 });
    const calm = exitClock({ market: 'CRYPTO', atrPctLtp: 1.2, now: t0 });
    expect(hot.horizon.hours).toBe(8);
    expect(hot.horizon.label).toBe('INTRADAY');
    expect(calm.horizon.hours).toBe(72);
    expect(calm.horizon.label).toBe('SWING');
    expect(calm.exitBy).toContain('IST');
  });
});

describe('v9 intradayExpertFactors — the intraday 7-factor expert score', () => {
  const bullSig = {
    symbol: 'RELIANCE', ltp: 2500, direction: 'LONG' as const,
    confidence: 88, quantConfidence: 88, aiConfidence: null, aiModel: '', aiNote: '',
    entry: 2500, stopLoss: 2460, target1: 2564, target2: 2604,
    trendStrength: 'STRONG', adx: 30, rsi: 60, volumeRatio: 1.8,
    atr: 30, rr: 1.9, effRR: 1.75, changePct: 1.4, gapPct: 0.4, vwapDist: 0.3,
  };

  it('scores a clean bullish setup 0-100 with all 7 factors', () => {
    const r = intradayExpertFactors(bullSig, { regime: 'BULLISH' });
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(0);
    expect(r!.score).toBeLessThanOrEqual(100);
    expect(r!.factors).toHaveLength(7);
    expect(r!.factors.map(f => f.key)).toEqual(
      expect.arrayContaining(['trend', 'momentum', 'volume', 'smc', 'volatility', 'regime', 'rr']));
    expect(r!.atrPct).toBeCloseTo(1.2, 5);
  });

  it('bearish regime flips the regime factor against a LONG setup', () => {
    const bull = intradayExpertFactors(bullSig, { regime: 'BULLISH' })!;
    const bear = intradayExpertFactors(bullSig, { regime: 'BEARISH' })!;
    const rb = bull.factors.find(f => f.key === 'regime')!;
    const rr2 = bear.factors.find(f => f.key === 'regime')!;
    expect(rb.value).toBeGreaterThan(rr2.value);
    expect(bull.score).toBeGreaterThan(bear.score);
  });

  it('SMC honestly abstains at neutral 50 (no candles on this path)', () => {
    const r = intradayExpertFactors(bullSig, null)!;
    expect(r.factors.find(f => f.key === 'smc')!.value).toBe(50);
  });

  it('degenerate signal (no ltp) → null', () => {
    expect(intradayExpertFactors({ ...bullSig, ltp: 0 }, null)).toBeNull();
    expect(intradayExpertFactors(null, null)).toBeNull();
  });
});
