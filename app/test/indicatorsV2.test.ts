// ============================================================
//  v20.7.4 — USER-SPEC INDICATOR STACK tests
//  Price Action / Fibonacci / SMC v2 (BOS-CHoCH, EQH-EQL,
//  premium-discount, kill zones) / Volume Profile / Chart
//  Patterns / Supply-Demand / EMA100-200 / StructurePro seat.
//  All functions are PURE — synthetic candles pin the math.
// ============================================================
import { describe, it, expect } from 'vitest';

import {
  fibonacciRetracement, volumeProfile, detectChartPatterns,
  supplyDemandZones, priceActionStats, computeIndicatorsFromCandles,
} from '../server/ai/lib/indicators.js';
import {
  smcVote, swingStructure, equalLevels, premiumDiscount, ictKillZone,
} from '../server/ai/lib/smc.js';
import { structurePro, runQuantModels } from '../server/ai/models.js';

// ---- helpers: synthetic candle builders (oldest-first) ----
const bar = (i, o, h, l, c, v = 100) => ({ time: 1_700_000_000_000 + i * 3_600_000, open: o, high: h, low: l, close: c, volume: v });

/** Smooth monotone ramp with a sine wiggle (no clean pivots). */
function rampCandles(n = 120, start = 100, step = 1) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p += step + Math.sin(i / 6) * 0.3;
    out.push(bar(i, o, Math.max(o, p) + 0.8, Math.min(o, p) - 0.8, p));
  }
  return out;
}

/**
 * GOLDEN-POCKET SETUP (v21.0 StructurePro contract) — 55-bar gentle
 * rally + 15-bar sharp rally, phir 12-bar pullback jo up-leg ka ~63%
 * retrace karta hai (fib golden pocket 0.618-0.65 band me land).
 * StructurePro ab BOS/CHoCH NAHI dekhta (SMC ka kaam — dedup fix)
 * — uske UNIQUE legs (Fib/VP/S&D/EMA) fire hote hain is fixture me.
 */
function goldenPocketSetup(dir = 1, start = 100) {
  const out = [];
  let p = start;
  const sgn = dir >= 0 ? 1 : -1;
  const push = (i, o, c, w, v) => out.push(bar(i, o, Math.max(o, c) + w, Math.min(o, c) - w, c, v));
  // Phase 1: 55-bar gentle trend, Phase 2: 15-bar sharp trend
  for (let i = 0; i < 55; i++) { const o = p; p += 1.6 * sgn; push(i, o, p, 0.2, 100); }
  for (let i = 0; i < 15; i++) { const o = p; p += 3.0 * sgn; push(55 + i, o, p, 0.3, 200); }
  // Phase 3: 12-bar pullback jo leg ka ~63% retrace kare → golden pocket.
  // legExtreme = trend ka extreme end; legStart = window ka anchor.
  // Direction-AGNOSTIC: extreme se start ki taraf 63% wapas.
  const legExtreme = p;
  const legStart = start + 5 * sgn;
  const target = legExtreme + (legStart - legExtreme) * 0.68;  // GP band = 61.8-65% + wick offset
  for (let i = 0; i < 12; i++) { const o = p; p += (target - p) * 0.28; push(70 + i, o, p, 0.3, 150); }
  return out;
}

/**
 * TREND WITH PULLBACKS — clean alternating fractal pivots.
 * Trend leg: `legBars` bars moving ±`upSwing`; pullback: legBars/2
 * bars moving ∓`downSwing`. Turn bars carry a distinct 1.2-unit wick
 * on the leg's extreme side (direction-aware) so pivots are
 * unambiguous for strength-3 fractals.
 */
function trendWithPullbacks(n = 120, start = 100, dir = 1, legBars = 10, upSwing = 10, downSwing = 4) {
  const pullBars = Math.max(2, Math.floor(legBars / 2));
  const cycle = legBars + pullBars;
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const pos = i % cycle;
    const inPull = pos >= legBars;
    const isTrend = !inPull;
    const step = (inPull ? -downSwing : upSwing) / (inPull ? pullBars : legBars) * dir;
    const o = p;
    const c = p + step;
    const trendTurn = isTrend && pos === legBars - 1;   // trend-leg extreme
    const pullTurn = inPull && pos === cycle - 1;       // pullback extreme
    // wick on the extreme side: dir>0 → trend top / pullback bottom
    const hiWick = (trendTurn && dir > 0) || (pullTurn && dir < 0);
    const loWick = (trendTurn && dir < 0) || (pullTurn && dir > 0);
    out.push(bar(i, o,
      hiWick ? Math.max(o, c) + 1.2 : Math.max(o, c) + 0.15,
      loWick ? Math.min(o, c) - 1.2 : Math.min(o, c) - 0.15,
      c, 100));
    p = c;
  }
  return out;
}

describe('v20.7.4 — Fibonacci Retracement', () => {
  it('up-leg me levels descending + golden pocket 0.618-0.65 band me', () => {
    const c = rampCandles(100, 100, 1);
    const fib = fibonacciRetracement(c);
    expect(fib).not.toBeNull();
    expect(fib.direction).toBe('up');
    expect(fib.levels['0.236']).toBeGreaterThan(fib.levels['0.382']);
    expect(fib.levels['0.382']).toBeGreaterThan(fib.levels['0.5']);
    expect(fib.levels['0.5']).toBeGreaterThan(fib.levels['0.618']);
    expect(fib.goldenPocket.low).toBeLessThanOrEqual(fib.goldenPocket.high);
    expect(fib.goldenPocket.low).toBeGreaterThan(fib.swingLow);
    expect(fib.goldenPocket.high).toBeLessThan(fib.swingHigh);
    expect(fib.positionPct).toBeGreaterThanOrEqual(0);
    expect(fib.positionPct).toBeLessThanOrEqual(100);
  });

  it('down-leg me levels ascending mirror + extensions niche', () => {
    const c = rampCandles(100, 300, -1);
    const fib = fibonacciRetracement(c);
    expect(fib.direction).toBe('down');
    expect(fib.levels['0.236']).toBeLessThan(fib.levels['0.382']);
    expect(fib.levels['0.382']).toBeLessThan(fib.levels['0.5']);
    expect(fib.levels['0.5']).toBeLessThan(fib.levels['0.618']);
    expect(fib.extensions['1.272']).toBeLessThan(fib.swingLow);
    expect(fib.extensions['1.618']).toBeLessThan(fib.extensions['1.272']);
  });

  it('golden pocket me price → bias continuation direction', () => {
    // up leg 100→180 then pull back exactly to ~0.62 of the range
    const out = rampCandles(80, 100, 1);
    const hi = Math.max(...out.map(x => x.high));
    const lo = Math.min(...out.map(x => x.low));
    const target = hi - 0.62 * (hi - lo);
    let q = out[out.length - 1].close;
    for (let i = 0; i < 8; i++) {
      const o = q;
      q = target + (7 - i) * 0.9;
      out.push(bar(80 + i, o, Math.max(o, q) + 0.2, Math.min(o, q) - 0.2, q));
    }
    const fib = fibonacciRetracement(out);
    expect(fib.inGoldenPocket).toBe(true);
    expect(fib.direction).toBe('up');
    expect(fib.bias).toBe(1);
  });

  it('insufficient candles → null', () => {
    expect(fibonacciRetracement(rampCandles(10))).toBeNull();
  });
});

describe('v20.7.4 — Volume Profile (POC / VAH / VAL)', () => {
  it('heavy-volume cluster ke paas POC lagta hai', () => {
    const out = [];
    for (let i = 0; i < 60; i++) {
      const nearHeavy = i % 3 !== 0;
      const base = nearHeavy ? 111 : 101;
      const v = nearHeavy ? 1000 : 10;
      out.push(bar(i, base, base + 1, base - 1, base, v));
    }
    const vp = volumeProfile(out);
    expect(vp).not.toBeNull();
    expect(vp.poc).toBeGreaterThan(105);
    expect(vp.poc).toBeLessThan(118);
    expect(vp.vah).toBeGreaterThanOrEqual(vp.poc);
    expect(vp.val).toBeLessThanOrEqual(vp.poc);
    expect(vp.inValueArea).toBe(true); // last close 111 (heavy zone)
  });

  it('value area ~70% volume cover karta hai', () => {
    const c = trendWithPullbacks(120, 100, 1);
    const vp = volumeProfile(c);
    expect(vp).not.toBeNull();
    expect(vp.val).toBeLessThanOrEqual(vp.vah);
    expect(vp.priceVsPoc).toMatch(/above|below/);
  });

  it('zero-volume candles → null (honest)', () => {
    const c = rampCandles(30).map(x => ({ ...x, volume: 0 }));
    expect(volumeProfile(c)).toBeNull();
  });
});

describe('v20.7.4 — Chart Patterns (multi-bar)', () => {
  it('double top detect hota hai (bearish, confirmed)', () => {
    const out = [];
    let p = 100;
    for (let i = 0; i < 25; i++) { const o = p; p += 0.8; out.push(bar(i, o, p + 0.15, o - 0.15, p)); }        // →120
    out.push(bar(25, p, p + 1.5, p - 0.5, p - 0.2));                                                            // top A (high 121.5)
    for (let i = 26; i < 36; i++) { const o = p; p -= 1.2; out.push(bar(i, o, o + 0.15, p - 0.15, p)); }       // →108
    for (let i = 36; i < 46; i++) { const o = p; p += 1.2; out.push(bar(i, o, p + 0.15, o - 0.15, p)); }       // →120
    out.push(bar(46, p, p + 1.5, p - 0.5, p - 0.2));                                                            // top B (high 121.5)
    for (let i = 47; i < 60; i++) { const o = p; p -= 1.4; out.push(bar(i, o, o + 0.15, p - 0.15, p)); }       // breakdown
    const pats = detectChartPatterns(out);
    expect(pats.length).toBeGreaterThan(0);
    const dt = pats.find(x => /Double Top/.test(x.name));
    expect(dt).toBeDefined();
    expect(dt.dir).toBe(-1);
    expect(dt.confidence).toBeGreaterThanOrEqual(70); // neckline broken → confirmed
  });

  it('double bottom detect hota hai (bullish, confirmed)', () => {
    const out = [];
    let p = 200;
    for (let i = 0; i < 25; i++) { const o = p; p -= 0.8; out.push(bar(i, o, o + 0.15, p + 0.15, p)); }        // →180
    out.push(bar(25, p, p + 0.5, p - 1.5, p + 0.2));                                                            // bottom A (low 178.5)
    for (let i = 26; i < 36; i++) { const o = p; p += 1.2; out.push(bar(i, o, p + 0.15, o - 0.15, p)); }       // →192
    for (let i = 36; i < 46; i++) { const o = p; p -= 1.2; out.push(bar(i, o, o + 0.15, p - 0.15, p)); }       // →180
    out.push(bar(46, p, p + 0.5, p - 1.5, p + 0.2));                                                            // bottom B (low 178.5)
    for (let i = 47; i < 60; i++) { const o = p; p += 1.4; out.push(bar(i, o, p + 0.15, o - 0.15, p)); }       // breakout
    const pats = detectChartPatterns(out);
    const db = pats.find(x => /Double Bottom/.test(x.name));
    expect(db).toBeDefined();
    expect(db.dir).toBe(1);
    expect(db.confidence).toBeGreaterThanOrEqual(70);
  });

  it('bull flag detect hota hai', () => {
    const out = rampCandles(40, 100, 1);
    out.push(bar(40, 140, 152, 139.5, 151)); // big impulse
    for (let i = 41; i < 46; i++) out.push(bar(i, 151 - (i - 41) * 0.4, 151.5 - (i - 41) * 0.4, 150 - (i - 41) * 0.4, 150.6 - (i - 41) * 0.4));
    const pats = detectChartPatterns(out);
    const flag = pats.find(x => x.name === 'Bull Flag');
    expect(flag).toBeDefined();
    expect(flag.dir).toBe(1);
  });

  it('pattern-less tape → empty list', () => {
    const out = [];
    for (let i = 0; i < 60; i++) {
      const p = 100 + i * 0.5 + Math.sin(i / 2) * 2;
      out.push(bar(i, p - 0.25, p + 0.25, p - 0.25, p));
    }
    expect(detectChartPatterns(out)).toEqual([]);
  });
});

describe('v20.7.4 — Supply & Demand Zones', () => {
  it('base + up-impulse → DEMAND zone; retest me inZone true', () => {
    const out = [];
    // 30-bar tight base around 100 (bodies 0.2)
    for (let i = 0; i < 30; i++) out.push(bar(i, i % 2 ? 99.9 : 100.1, 100.4, 99.6, i % 2 ? 100.1 : 99.9, 50));
    out.push(bar(30, 100, 104.5, 99.8, 104, 500));                                 // impulse up (body 4)
    for (let i = 31; i < 45; i++) out.push(bar(i, 104 + (i - 31) * 0.2, 104.6, 103.6, 104 + (i - 31) * 0.2, 60));
    // pullback INTO the base zone (close 100.0 ∈ [99.9, 100.1])
    let q = 104;
    for (let i = 45; i < 52; i++) { const o = q; q = 100 + (51 - i) * 0.5; out.push(bar(i, o, o + 0.2, q - 0.2, q, 40)); }
    const sd = supplyDemandZones(out);
    expect(sd).not.toBeNull();
    expect(sd.demand).not.toBeNull();
    expect(sd.demand.type).toBe('demand');
    expect(sd.demand.dir).toBe(1);
    expect(sd.demand.inZone).toBe(true);
  });

  it('base + down-impulse → SUPPLY zone', () => {
    const out = [];
    for (let i = 0; i < 30; i++) out.push(bar(i, i % 2 ? 199.9 : 200.1, 200.4, 199.6, i % 2 ? 200.1 : 199.9, 50));
    out.push(bar(30, 200, 200.2, 195.5, 196, 500));                                 // impulse down
    for (let i = 31; i < 45; i++) out.push(bar(i, 196 - (i - 31) * 0.2, 196.4, 195.4, 196 - (i - 31) * 0.2, 60));
    const sd = supplyDemandZones(out);
    expect(sd?.supply).not.toBeNull();
    expect(sd.supply.type).toBe('supply');
    expect(sd.supply.dir).toBe(-1);
  });

  it('bina impulse ke kuch nahi (honest null)', () => {
    const out = rampCandles(40).map(x => ({ ...x, open: x.close - 0.01, high: x.close + 0.05, low: x.close - 0.05 }));
    expect(supplyDemandZones(out)).toBeNull();
  });
});

describe('v20.7.4 — Price Action stats', () => {
  it('CLV + bar-count + trend bias', () => {
    const c = rampCandles(30, 100, 1);
    const pa = priceActionStats(c);
    expect(pa).not.toBeNull();
    expect(pa.bars).toBe(20);                       // default lookback
    expect(pa.upBars + pa.downBars).toBe(19);
    expect(pa.trendBias).toBe(1);                   // up-trend
    expect(pa.clv).toBeGreaterThanOrEqual(-1);
    expect(pa.clv).toBeLessThanOrEqual(1);
    expect(pa.bodyRatio).toBeGreaterThan(0);
    expect(pa.rangePositionPct).toBeGreaterThanOrEqual(0);
  });
});

describe('v20.7.4 — computeIndicatorsFromCandles (full aggregate)', () => {
  function baseImpulseDrift() {
    // 140 gentle bars @100 → 30-bar tight base → impulse up → drift @104.8
    const out = [];
    let q = 100;
    for (let i = 0; i < 140; i++) { const o = q; q += Math.sin(i / 5) * 0.1; out.push(bar(i, o, Math.max(o, q) + 0.1, Math.min(o, q) - 0.1, q, 60)); }
    for (let i = 140; i < 170; i++) out.push(bar(i, i % 2 ? 99.95 : 100.05, 100.4, 99.6, i % 2 ? 100.05 : 99.95, 50));
    out.push(bar(170, 100, 105, 99.8, 104.8, 800));
    for (let i = 171; i < 220; i++) { const o = q = 104.8 + Math.sin(i / 5) * 0.1; q = 104.8 + Math.sin((i + 1) / 5) * 0.1; out.push(bar(i, o, Math.max(o, q) + 0.1, Math.min(o, q) - 0.1, q, 60)); }
    return out;
  }
  it('naye fields sab present (chartPatterns/fib/volumeProfile/supplyDemand/priceAction/ema100/ema200)', () => {
    const c = baseImpulseDrift();
    const ind = computeIndicatorsFromCandles(c);
    expect(ind).not.toBeNull();
    expect(ind.ema100).not.toBeNull();
    expect(ind.ema200).not.toBeNull();
    expect(ind.fib).not.toBeNull();
    expect(ind.volumeProfile).not.toBeNull();
    expect(Array.isArray(ind.chartPatterns)).toBe(true);
    expect(ind.supplyDemand).not.toBeNull();
    expect(ind.priceAction).not.toBeNull();
    expect(ind.ema100).toBeGreaterThan(0);
    expect(typeof ind.fib.positionPct).toBe('number');
  });

  it('short data me ema100/200 null, legacy fields intact', () => {
    const ind = computeIndicatorsFromCandles(rampCandles(60, 100, 1));
    expect(ind).not.toBeNull();
    expect(ind.ema100).toBeNull();
    expect(ind.ema200).toBeNull();
    expect(ind.ema10).not.toBeNull();
    expect(ind.rsi).not.toBeNull();
    expect(ind.patterns).toBeDefined();
  });
});

describe('v20.7.4 — SMC v2: market structure (BOS / CHoCH)', () => {
  it('up-trend → HH/HL labels + bullish BOS event', () => {
    const c = trendWithPullbacks(120, 100, 1);
    const st = swingStructure(c);
    expect(st).not.toBeNull();
    expect(st.trend).toBe(1);
    expect(st.event).not.toBeNull();
    expect(['BOS', 'CHoCH']).toContain(st.event.type);
    expect(st.event.dir).toBe(1);
    expect(st.swingHigh).toBeGreaterThan(st.swingLow);
    expect(st.labels.some(l => ['HH', 'HL'].includes(l.type))).toBe(true);
  });

  it('down-trend → bearish structure', () => {
    const st = swingStructure(trendWithPullbacks(120, 300, -1));
    expect(st.trend).toBe(-1);
    expect(st.event).not.toBeNull();
    expect(st.event.dir).toBe(-1);
  });

  it('reversal: up-trend ke baad short breakdown → CHoCH bearish (fresh event)', () => {
    const out = trendWithPullbacks(100, 100, 1);    // ~146 par
    // 5-bar HARD breakdown (short — koi naya pivot confirm nahi hota,
    // isliye last event wahi pehla CHoCH rehta hai)
    let p = out[out.length - 1].close;
    for (let i = 0; i < 5; i++) { const o = p; p -= 4; out.push(bar(100 + i, o, o + 0.15, p - 0.15, p)); }
    const st = swingStructure(out);
    expect(st.event).not.toBeNull();
    expect(st.event.type).toBe('CHoCH');
    expect(st.event.dir).toBe(-1);
    expect(st.trend).toBe(-1);
  });
});

describe('v20.7.4 — SMC v2: EQH/EQL liquidity pools', () => {
  it('do near-equal tops → EQH pool', () => {
    const out = [];
    let p = 100;
    for (let i = 0; i < 20; i++) { const o = p; p += 1.25; out.push(bar(i, o, p + 0.15, o - 0.15, p)); }      // →125
    out.push(bar(20, p, p + 1.2, p - 0.5, p - 0.3));                                                          // top A (high 126.2)
    for (let i = 21; i < 29; i++) { const o = p; p -= 1; out.push(bar(i, o, o + 0.15, p - 0.15, p)); }      // →117
    for (let i = 29; i < 37; i++) { const o = p; p += 1; out.push(bar(i, o, p + 0.15, o - 0.15, p)); }      // →125
    out.push(bar(37, p, p + 1.2, p - 0.5, p - 0.3));                                                          // top B (high 126.2)
    for (let i = 38; i < 46; i++) { const o = p; p -= 0.8; out.push(bar(i, o, o + 0.15, p - 0.15, p)); }
    const pools = equalLevels(out);
    expect(pools).not.toBeNull();
    expect(pools.eqh).not.toBeNull();
    expect(Math.abs(pools.eqh - 126.2)).toBeLessThan(0.5);
  });
});

describe('v20.7.4 — SMC v2: premium / discount', () => {
  it('range ke top pe PREMIUM (short bias), bottom pe DISCOUNT (long bias)', () => {
    const c = rampCandles(120, 100, 1);
    const pd = premiumDiscount(c);
    expect(pd).not.toBeNull();
    expect(pd.positionPct).toBeGreaterThan(60);    // uptrend → upper part
    expect(['premium', 'equilibrium']).toContain(pd.zone);
    expect(pd.equilibrium).toBeLessThan(pd.rangeHigh);
    expect(pd.equilibrium).toBeGreaterThan(pd.rangeLow);

    const pdDown = premiumDiscount(rampCandles(120, 300, -1));
    expect(pdDown.positionPct).toBeLessThan(40);
    expect(pdDown.zone).toBe('discount');
    expect(pdDown.bias).toBe(1);
  });
});

describe('v20.7.4 — SMC v2: ICT kill zones (IST)', () => {
  it('fixed UTC timestamps → correct IST zone', () => {
    // 2024-01-15 03:00 UTC = 08:30 IST → Asia zone
    expect(ictKillZone(Date.UTC(2024, 0, 15, 3, 0)).name).toBe('Asia (Tokyo)');
    // 2024-01-15 09:00 UTC = 14:30 IST → London open
    expect(ictKillZone(Date.UTC(2024, 0, 15, 9, 0)).name).toBe('London open');
    // 2024-01-15 14:00 UTC = 19:30 IST → New York AM
    expect(ictKillZone(Date.UTC(2024, 0, 15, 14, 0)).name).toBe('New York AM');
    // 2024-01-15 16:30 UTC = 22:00 IST → off-session
    expect(ictKillZone(Date.UTC(2024, 0, 15, 16, 30)).inZone).toBe(false);
    // seconds input bhi chalega
    expect(ictKillZone(Date.UTC(2024, 0, 15, 9, 0) / 1000).name).toBe('London open');
    // garbage → unknown
    expect(ictKillZone(0).inZone).toBe(false);
    expect(ictKillZone(NaN).name).toBe('unknown');
  });
});

describe('v20.7.4 — SMC v2 vote (upgraded smcVote)', () => {
  it('bullish confluence → dir +1, conf bounded ≤ 88, reasons non-empty', () => {
    // n=110 → data MID-UPLEG khatam hota hai (fresh BOS + bullish FVG,
    // pullback ka bearish FVG abhi bana nahi)
    const v = smcVote(trendWithPullbacks(110, 100, 1));
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThan(40);
    expect(v.conf).toBeLessThanOrEqual(88);
    expect(Array.isArray(v.reasons)).toBe(true);
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it('bearish confluence → dir -1', () => {
    const v = smcVote(trendWithPullbacks(110, 300, -1));
    expect(v.dir).toBe(-1);
    expect(v.conf).toBeGreaterThan(40);
  });

  it('kam candles → honest abstain', () => {
    const v = smcVote(rampCandles(10));
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
  });

  it('ctx object shape (signals.js path) bhi chalega', () => {
    const v = smcVote({ candles: trendWithPullbacks(120, 100, 1) });
    expect([1, -1, 0]).toContain(v.dir);
  });
});

describe('v20.7.4 — StructurePro ensemble seat', () => {
  it('candles ke bina honest abstain', () => {
    const v = structurePro({ ind: {} });
    expect(v.dir).toBe(0);
    expect(v.conf).toBe(0);
    expect(v.reasons[0]).toMatch(/abstain/i);
  });

  it('bullish scenario → LONG vote + reasons me Fib/VP/S&D/EMA mentions (v21.0 — BOS/CHoCH ab SMC ka kaam hai)', () => {
    const c = goldenPocketSetup(1);   // up-leg ka ~63% pullback → golden pocket
    const ind = computeIndicatorsFromCandles(c);
    const v = structurePro({ candles: c, ind });
    expect(v.dir).toBe(1);
    expect(v.conf).toBeGreaterThan(45);
    const txt = v.reasons.join(' ');
    expect(/Fib|golden|VP-POC|zone|EMA/i.test(txt)).toBe(true);
    // DEDUP CONTRACT: StructurePro me ab BOS/CHoCH/structure reasons NAHI
    // (wahi legs SmartMoneyICT seat dekhta hai — double-count fix)
    expect(/BOS|CHoCH/i.test(txt)).toBe(false);
  });

  it('bearish scenario → SHORT vote', () => {
    const c = goldenPocketSetup(-1, 500);  // down-leg ka ~63% pullback → golden pocket
    const ind = computeIndicatorsFromCandles(c);
    const v = structurePro({ candles: c, ind });
    expect(v.dir).toBe(-1);
  });

  it('runQuantModels registry me structure seat vote karta hai', () => {
    const c = goldenPocketSetup(1);
    const votes = runQuantModels({ ltp: c[c.length - 1].close, ind: computeIndicatorsFromCandles(c), candles: c });
    const seat = votes.find(v => v.id === 'structure');
    expect(seat).toBeDefined();
    expect(seat.name).toBe('StructurePro');
    // v21.0 DEDUP: weight 1.15 → 1.0 (BOS/CHoCH legs SMC ko de diye —
    // committee me structure-family ka double-count khatam)
    expect(seat.weight).toBe(1);
    expect(seat.dir).toBe(1);
    // smc seat ab BOS/CHoCH ka SOLE authority hai
    const smc = votes.find(v => v.id === 'smc');
    expect(smc).toBeDefined();
    expect(/BOS\/CHoCH/.test(smc.role)).toBe(true);
  });
});
