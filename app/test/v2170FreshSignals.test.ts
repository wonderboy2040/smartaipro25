// ============================================================
// test/v2170FreshSignals.test.ts — v21.7.0 regression suite
// ------------------------------------------------------------
// Issue-1 (F&O fresh + realtime): buildOptionsPlanCtx — options-card
//   index plans ab LIVE desk spot + 15m ATR geometry par bante hain
//   (pehle: Yahoo daily close + DAILY ATR → systematically wrong
//   entry/exit on NIFTY/SENSEX cards).
// Issue-2 (MA Crossover dono tabs): MACrossTracker seat — SMA20/50
//   + EMA10/20 cross EVENTS vote in the ensemble (India 15m revival
//   + crypto 1h candles, ek hi seat — no double count).
// Issue-3 (Superintelligence accuracy): applyStrictAgreementCap —
//   split committee (agreement < 0.62) ka ACTION ab WATCH cap hota
//   hai; STRONG/FLAT/above-threshold untouched.
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { MODELS, maCrossFromCandles } from '../server/ai/models.js';
import { applyStrictAgreementCap, buildOptionsPlanCtx, buildTradePlan } from '../server/ai/ensemble.js';

const maSeat = MODELS.find(m => m.id === 'macross');
const maFn = maSeat?.fn as (ctx: unknown) => { dir: number; conf: number; reasons: string[] };

// ---- candle fixtures ------------------------------------------
function mkCandles(closes: number[]) {
  return closes.map(c => ({ open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1000 }));
}
/** 100 bars down (bearish MA state) then `rallyN` sharp up bars — the
 * golden cross lands INSIDE the last ~20 bars (event, not steady). */
function goldenCrossCandles(rallyN = 22) {
  const closes: number[] = [];
  let px = 120;
  for (let i = 0; i < 100; i++) { px -= 0.4; closes.push(Number(px.toFixed(4))); }
  for (let i = 0; i < rallyN; i++) { px += 2.4; closes.push(Number(px.toFixed(4))); }
  return mkCandles(closes);
}
function deathCrossCandles(rallyN = 22) {
  const closes: number[] = [];
  let px = 80;
  for (let i = 0; i < 100; i++) { px += 0.4; closes.push(Number(px.toFixed(4))); }
  for (let i = 0; i < rallyN; i++) { px -= 2.4; closes.push(Number(px.toFixed(4))); }
  return mkCandles(closes);
}
function steadyBullCandles(n = 140) {
  const closes: number[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) { px += 0.5; closes.push(Number(px.toFixed(4))); }
  return mkCandles(closes);
}

// ================================================================
// Issue-2 — MACrossTracker
// ================================================================
describe('v21.7.0 Issue-2 — MACrossTracker seat (dono tabs)', () => {
  it('seat is registered with weight 1.15 and votes cross EVENTS', () => {
    expect(maSeat).toBeTruthy();
    expect(maSeat.weight).toBe(1.15);
    expect(typeof maFn).toBe('function');
  });

  it('maCrossFromCandles: golden cross inside the window is detected with sign +1', () => {
    const cross = maCrossFromCandles(goldenCrossCandles());
    expect(cross).toBeTruthy();
    expect(cross.main.sign).toBe(1);
    expect(cross.main.bars).not.toBeNull();
    expect(cross.main.bars as number).toBeLessThanOrEqual(20);
  });

  it('golden-cross candles → bullish vote with cross reason', () => {
    const v = maFn({ market: 'INDIA', ltp: 132, ind: {}, candles: goldenCrossCandles() });
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThanOrEqual(55);
    expect(v.reasons.join(' ')).toMatch(/cross/i);
  });

  it('death-cross candles → bearish vote with cross reason', () => {
    const v = maFn({ market: 'FUTURES', ltp: 68, ind: {}, candles: deathCrossCandles() });
    expect(v.dir).toBe(-1);
    expect(v.conf).toBeGreaterThanOrEqual(55);
    expect(v.reasons.join(' ')).toMatch(/cross/i);
  });

  it('steady bull series (no fresh cross) still votes continuation', () => {
    const v = maFn({ market: 'CRYPTO', ltp: 170, ind: {}, candles: steadyBullCandles() });
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThan(30);
  });

  it('state fallback (no candles): aligned SMA20/50 + EMA10/20 votes, mixed abstains', () => {
    const bull = maFn({ market: 'INDIA', ltp: 100, ind: { sma20: 102, sma50: 99, ema10: 103, ema20: 100 } });
    expect(bull.dir).toBe(1);
    const mixed = maFn({ market: 'INDIA', ltp: 100, ind: { sma20: 102, sma50: 99, ema10: 98, ema20: 100 } });
    expect(mixed.dir).toBe(0);
  });

  it('chase guard: extended price off EMA10 cuts the confidence', () => {
    const candles = goldenCrossCandles();
    const cross = maCrossFromCandles(candles);
    const last = (candles as Array<{ close: number }>)[candles.length - 1].close;
    const ema10ish = last * 0.90; // ltp ~11% above the fast MA
    const v = maFn({ market: 'INDIA', ltp: last, ind: { ema10: ema10ish }, candles });
    expect(v.reasons.join(' ')).toMatch(/late chase/);
    expect(v.conf).toBeLessThan(90);
  });

  it('short/invalid candle arrays return null (honest abstain)', () => {
    expect(maCrossFromCandles(null)).toBeNull();
    expect(maCrossFromCandles(mkCandles([1, 2, 3, 4, 5]))).toBeNull();
  });

  it('seatCorrelation static pair registered (trend > macross dedup guard)', async () => {
    const mod = await import('../server/ai/seatCorrelation.js');
    expect(mod.CORE_DEDUP_PAIRS.some((p: string[]) => p[0] === 'trend' && p[1] === 'macross')).toBe(true);
  });
});

// ================================================================
// Issue-3 — strict agreement cap
// ================================================================
describe('v21.7.0 Issue-3 — applyStrictAgreementCap (Superintelligence accuracy)', () => {
  const mk = (grade: string, agreement: number, dir = 1) => ({
    side: dir > 0 ? 'LONG' : 'SHORT', dir, confidence: 62, agreement, grade,
    summary: 'test consensus', participation: 0.9, voters: 8,
  });

  it('split committee ACTION (agreement 0.55) is capped to WATCH + stamped', () => {
    const out = applyStrictAgreementCap(mk('ACTION', 0.55), true);
    expect(out.grade).toBe('WATCH');
    expect((out as { strictAgreementCap?: boolean }).strictAgreementCap).toBe(true);
    expect(out.summary).toMatch(/SPLIT CAP/);
  });

  it('high-agreement ACTION (0.75) untouched', () => {
    const out = applyStrictAgreementCap(mk('ACTION', 0.75), true);
    expect(out.grade).toBe('ACTION');
  });

  it('STRONG and FLAT and NEUTRAL untouched (only ACTION is capped)', () => {
    expect(applyStrictAgreementCap(mk('STRONG', 0.55), true).grade).toBe('STRONG');
    expect(applyStrictAgreementCap(mk('NEUTRAL', 0.55), true).grade).toBe('NEUTRAL');
    expect(applyStrictAgreementCap({ ...mk('ACTION', 0.55), dir: 0 }, true).grade).toBe('ACTION');
  });

  it('disabled flag is a full rollback (no cap)', () => {
    expect(applyStrictAgreementCap(mk('ACTION', 0.55), false).grade).toBe('ACTION');
  });

  it('env AI_STRICT_AGREEMENT=0 disables (rollback switch)', () => {
    const prev = process.env.AI_STRICT_AGREEMENT;
    process.env.AI_STRICT_AGREEMENT = '0';
    try {
      expect(applyStrictAgreementCap(mk('ACTION', 0.55)).grade).toBe('ACTION');
    } finally {
      if (prev === undefined) delete process.env.AI_STRICT_AGREEMENT; else process.env.AI_STRICT_AGREEMENT = prev;
    }
  });

  afterEach(() => { delete process.env.AI_STRICT_AGREEMENT; });
});

// ================================================================
// Issue-1 — F&O options-card plan context (live spot + 15m ATR)
// ================================================================
describe('v21.7.0 Issue-1 — buildOptionsPlanCtx (F&O entry/exit fix)', () => {
  const dailyCtx = { market: 'INDIA', symbol: 'NIFTY', ltp: 24700, ind: { atr: 118, rsi: 56 }, isIndex: true };

  it('overrides ltp with LIVE desk spot and atr with 15m ATR, preserves the rest', () => {
    const out = buildOptionsPlanCtx(dailyCtx, { liveSpot: 24850.15 }, { atr: 38.5 }) as typeof dailyCtx & { ind: { atr: number } };
    expect(out.ltp).toBe(24850.15);
    expect(out.ind.atr).toBe(38.5);
    expect(out.ind.rsi).toBe(56);
    expect(out.symbol).toBe('NIFTY');
    expect(out.isIndex).toBe(true);
  });

  it('is PURE — the input ctx is never mutated', () => {
    const snapshot = JSON.stringify(dailyCtx);
    buildOptionsPlanCtx(dailyCtx, { liveSpot: 24999 }, { atr: 20 });
    expect(JSON.stringify(dailyCtx)).toBe(snapshot);
  });

  it('no-ops honestly when neither live spot nor ltf ATR is present', () => {
    expect(buildOptionsPlanCtx(dailyCtx, {}, null)).toBe(dailyCtx);
    expect(buildOptionsPlanCtx(dailyCtx, { liveSpot: 'nan' }, { atr: 0 })).toBe(dailyCtx);
  });

  it('a LONG plan built on the options ctx anchors entry at LIVE spot with INTRADAY risk', () => {
    const consensus = { dir: 1, side: 'LONG', confidence: 80, agreement: 0.8 };
    const planCtx = buildOptionsPlanCtx(dailyCtx, { liveSpot: 24850.15 }, { atr: 38.5 });
    const plan = buildTradePlan(consensus, planCtx, 'INDIA', {});
    expect(plan).toBeTruthy();
    // entry = LIVE spot (not the stale 24700 daily close)
    expect(Math.abs(plan.entry - 24850.15)).toBeLessThan(0.6);
    // SL distance = 1.4 × 15m ATR ≈ 54 points (NOT 1.4 × daily 118 ≈ 165)
    const slDist = Math.abs(plan.entry - plan.stopLoss);
    expect(slDist).toBeGreaterThan(40);
    expect(slDist).toBeLessThan(75);
    // T1 = 1R beyond entry (intraday geometry — reachable in a session)
    expect(Math.abs(Math.abs(plan.target1 - plan.entry) - slDist)).toBeLessThan(0.6);
  });

  it('without the fix (daily ctx) the SL distance would be ~165 — proving the geometry change', () => {
    const consensus = { dir: 1, side: 'LONG', confidence: 80, agreement: 0.8 };
    const planOld = buildTradePlan(consensus, dailyCtx, 'INDIA', {});
    const slOld = Math.abs(planOld.entry - planOld.stopLoss);
    expect(slOld).toBeGreaterThan(140); // daily-ATR geometry — the old wrong-world
  });
});
