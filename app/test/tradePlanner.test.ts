// ============================================================
// test/tradePlanner.test.ts — v21.15.0 MTF TRADE PLAN ENGINE
// ------------------------------------------------------------
// Pure-function suite (NO network): synthetic candle sets are fed
// straight into buildPlanFromCandles(), so the whole plan pipeline
// (context read → trigger read → entry/SL/T1/T2 → TF-fit → costs →
// checklist → warnings → time-plan) is verified deterministically.
//
// Ye suite specifically guards the USER SPEC:
//   • 15m context + 5m trigger (INTRADAY) aur 1h + 15m (SWING) dono
//     modes plan banate hain, side/levels consistent hote hain
//   • SL kabhi 0.9×ATR se tighter nahi (noise stop ban jata)
//   • T2 = 2×risk, T1 = risk (RR discipline)
//   • TF-FIT: 20 min hold 15m→5m par STRETCH/MISMATCH, aur lamba
//     window better verdict deta hai (jo measured lab se match karta
//     hai — scripts/mtf-accuracy-lab.mjs)
//   • cost-in-R > 0 aur netRR < gross RR (cost kabhi free nahi)
//   • thin candles → honest ok:false (crash nahi)
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  buildPlanFromCandles, readContext, readTrigger, tfFit, structureOf,
  PLAN_MODES, planModeList, __clearPlanCache,
} from '../server/ai/tradePlanner.js';

// ---------------- synthetic candle helper ----------------
interface C { time: number; open: number; high: number; low: number; close: number; volume: number }

/** Deterministic pseudo-random walk with a drift + a final-bar breakout. */
function candles({ n, start, driftPct, tfMin, vol = 1000, breakout = false, upCandles = 0.55 }: {
  n: number; start: number; driftPct: number; tfMin: number; vol?: number; breakout?: boolean; upCandles?: number;
}): C[] {
  const out: C[] = [];
  const t0 = 1_700_000_000_000;
  let p = start;
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    const drift = p * (driftPct / 100) / n;
    const noise = p * 0.0003 * (rnd() - 0.5) * 2;
    const o = p;
    const c = p + drift * 2 + noise;
    const h = Math.max(o, c) + p * 0.0007;
    const l = Math.min(o, c) - p * 0.0007;
    out.push({ time: t0 + i * tfMin * 60_000, open: o, high: h, low: l, close: c, volume: vol });
    p = c;
  }
  if (breakout) {
    const last = out[out.length - 1], prev = out[out.length - 2];
    last.close = prev.high * 1.002;
    last.high = last.close + (prev.high - prev.low) * 0.1;
    last.open = prev.high * 0.999;
    last.low = last.open - (prev.high - prev.low) * 0.05;
    last.volume = vol * 3;
  }
  void upCandles;
  return out;
}

const DAY = 1440;

describe('tradePlanner — modes', () => {
  it('exposes the 3 user modes with correct TF pairs', () => {
    const modes = planModeList();
    const byId = Object.fromEntries(modes.map(m => [m.id, m]));
    expect(byId.INTRADAY.contextTf).toBe('15m');
    expect(byId.INTRADAY.triggerTf).toBe('5m');
    expect(byId.SWING.contextTf).toBe('1h');
    expect(byId.SWING.triggerTf).toBe('15m');
    expect(byId.SCALP.contextTf).toBe('5m');
    expect(byId.SCALP.triggerTf).toBe('1m');
    expect(PLAN_MODES.INTRADAY.defaultHoldMin).toBeGreaterThan(20); // 20 min isna tight window — default 45
  });

  it('clamps holdMin into the mode bounds', () => {
    const ctx = candles({ n: 220, start: 1000, driftPct: 8, tfMin: 15 });
    const trig = candles({ n: 220, start: 1030, driftPct: 4, tfMin: 5, breakout: true });
    const tooShort = buildPlanFromCandles({ symbol: 'X', market: 'INDIA', mode: 'INTRADAY', holdMin: 1, ctxCandles: ctx, trigCandles: trig });
    expect(tooShort.holdMin).toBe(PLAN_MODES.INTRADAY.minHoldMin);
    const tooLong = buildPlanFromCandles({ symbol: 'X', market: 'INDIA', mode: 'INTRADAY', holdMin: 9999, ctxCandles: ctx, trigCandles: trig });
    expect(tooLong.holdMin).toBe(PLAN_MODES.INTRADAY.maxHoldMin);
  });
});

describe('tradePlanner — context / trigger reads', () => {
  it('reads an uptrend context as dir +1 with a trend name', () => {
    const ctx = readContext(candles({ n: 240, start: 1000, driftPct: 12, tfMin: 15 }));
    expect(ctx).not.toBeNull();
    expect(ctx!.dir).toBe(1);
    expect(ctx!.trend).toBe('UP');
    expect(ctx!.score).toBeGreaterThan(50);
    expect(ctx!.structure).toBe('HH-HL');
  });

  it('reads a downtrend context as dir −1', () => {
    const ctx = readContext(candles({ n: 240, start: 1000, driftPct: -12, tfMin: 15 }));
    expect(ctx!.dir).toBe(-1);
    expect(ctx!.trend).toBe('DOWN');
    expect(ctx!.structure).toBe('LH-LL');
  });

  it('structureOf detects HH-HL / LH-LL and returns MIXED for flat noise', () => {
    expect(structureOf(candles({ n: 120, start: 1000, driftPct: 10, tfMin: 5 }))).toBe('HH-HL');
    expect(structureOf(candles({ n: 120, start: 1000, driftPct: -10, tfMin: 5 }))).toBe('LH-LL');
    expect(structureOf(candles({ n: 6, start: 1000, driftPct: 0, tfMin: 5 }))).toBe('MIXED');
  });

  it('trigger flags a breakout bar + volume surge', () => {
    const trig = readTrigger(candles({ n: 120, start: 1000, driftPct: 3, tfMin: 5, breakout: true }), 'LONG');
    expect(trig).not.toBeNull();
    expect(trig!.broke).toBe(true);
    expect(trig!.volRatio).toBeGreaterThan(1.5);
    expect(trig!.score).toBeGreaterThan(50);
  });

  it('trigger does NOT flag a non-breakout bar', () => {
    const trig = readTrigger(candles({ n: 120, start: 1000, driftPct: 3, tfMin: 5 }), 'LONG');
    expect(trig!.broke).toBe(false);
    expect(trig!.components.find(c => c.k === 'breakout')!.ok).toBe(false);
  });
});

describe('tradePlanner — plan discipline (levels, RR, SL floor)', () => {
  const ctx = candles({ n: 260, start: 1000, driftPct: 10, tfMin: 15 });
  const trig = candles({ n: 260, start: 1040, driftPct: 5, tfMin: 5, breakout: true });
  const plan = buildPlanFromCandles({ symbol: 'TESTCO', market: 'INDIA', mode: 'INTRADAY', holdMin: 45, ctxCandles: ctx, trigCandles: trig, capital: 200000, riskPctPerTrade: 1 });

  it('builds an ok plan with a LONG side on an up-trend + breakout', () => {
    expect(plan.ok).toBe(true);
    expect(plan.side).toBe('LONG');
    expect(plan.triggerFired).toBe(true);
    expect(plan.bias).toBe('LONG');
  });

  it('SL/T1/T2 obey the 1R / 2R geometry (long)', () => {
    const { entry, stopLoss, t1, t2 } = plan.plan;
    const risk = entry - stopLoss;
    expect(risk).toBeGreaterThan(0);
    expect(t1).toBeCloseTo(entry + risk, 6);
    expect(t2).toBeCloseTo(entry + 2 * risk, 6);
    expect(plan.plan.grossRR).toEqual({ t1: 1, t2: 2 });
  });

  it('SL is never tighter than 0.9×ATR(trigger) — noise-proof floor', () => {
    const trigAtr = plan.trigger!.atr!;
    const riskDist = Math.abs(plan.plan.entry! - plan.plan.stopLoss!);
    expect(riskDist).toBeGreaterThanOrEqual(0.9 * trigAtr - 1e-9);
  });

  it('costs are real: costR > 0 and net RR < gross RR', () => {
    expect(plan.costs.costR!).toBeGreaterThan(0);
    expect(plan.costs.roundTripPct!).toBeGreaterThan(0);
    expect(plan.plan.netRR!.t1!).toBeLessThan(1);
    expect(plan.plan.netRR!.t2!).toBeLessThan(2);
  });

  it('risk-based qty respects the risk budget', () => {
    expect(plan.plan.qty!).toBeGreaterThan(0);
    expect(plan.plan.riskInr!).toBeLessThanOrEqual(2000 + 1); // 1% of ₹2,00,000
  });

  it('time plan carries BE / T1 / trail / time-stop / hard-exit rules', () => {
    const tp = plan.timePlan!;
    expect(tp.holdMin).toBe(45);
    expect(tp.bars).toBe(9); // 45 / 5
    expect(tp.beRule).toMatch(/breakeven/i);
    expect(tp.t1Rule).toMatch(/60%/);
    expect(tp.timeStopRule).toMatch(/exit/i);
  });

  it('SHORT side flips the geometry (explicit side wins)', () => {
    const short = buildPlanFromCandles({ symbol: 'TESTCO', market: 'INDIA', mode: 'INTRADAY', holdMin: 45, side: 'SHORT', ctxCandles: ctx, trigCandles: trig });
    expect(short.side).toBe('SHORT');
    const { entry, stopLoss, t1, t2 } = short.plan;
    expect(stopLoss!).toBeGreaterThan(entry!);
    expect(t1!).toBeLessThan(entry!);
    expect(t2!).toBeLessThan(t1!);
    expect(short.counterTrend).toBe(true); // up-context + SHORT
    expect(short.warnings.some(w => w.code === 'COUNTER_TREND')).toBe(true);
  });
});

describe('tradePlanner — TF-fit verdict (user ka core sawaal)', () => {
  it('rewards a longer window and punishes a too-short one (same setup)', () => {
    const triggerAtrPct = 0.17, riskPct = 0.26;
    const short = tfFit({ triggerAtrPct, holdMin: 20, triggerMin: 5, riskPct, t1Pct: riskPct, t2Pct: 2 * riskPct });
    const long = tfFit({ triggerAtrPct, holdMin: 120, triggerMin: 5, riskPct, t1Pct: riskPct, t2Pct: 2 * riskPct });
    const rank = { MISMATCH: 0, STRETCH: 1, OK: 2, GOOD: 3 } as Record<string, number>;
    expect(rank[long.verdict]).toBeGreaterThan(rank[short.verdict]);
    expect(long.ratioT1!).toBeGreaterThan(short.ratioT1!);
    expect(short.suggestHoldMin!).toBeGreaterThan(short.holdMin); // honest suggestion
    expect(short.note).toMatch(/MISMATCH|STRETCH/);
  });

  it('a shorter trigger TF fits the same window better (why 15-20 min needs 1m)', () => {
    const args = { triggerAtrPct: 0.17, holdMin: 20, riskPct: 0.26, t1Pct: 0.26, t2Pct: 0.52 };
    const m5 = tfFit({ ...args, triggerMin: 5 });
    const m1 = tfFit({ ...args, triggerMin: 1 });
    expect(m1.ratioT1!).toBeGreaterThan(m5.ratioT1!);
    expect(m1.bars).toBe(20);
    expect(m5.bars).toBe(4);
  });

  it('verdict bands are exhaustive and monotonic', () => {
    const band = (ratio: number) => tfFit({ triggerAtrPct: 1, holdMin: ratio * 20, triggerMin: 5, riskPct: 1, t1Pct: 1, t2Pct: 2 }).verdict;
    expect(band(0.2)).toBe('MISMATCH');
    expect(band(1.1)).toBe('OK');
    expect(band(5)).toBe('GOOD');
  });
});

describe('tradePlanner — honest degrade + SWING mode', () => {
  it('returns ok:false (no crash) on thin candle sets', () => {
    const ctx = candles({ n: 200, start: 1000, driftPct: 5, tfMin: 60 });
    const out = buildPlanFromCandles({ symbol: 'THIN', market: 'INDIA', mode: 'SWING', holdMin: 90, ctxCandles: ctx, trigCandles: candles({ n: 8, start: 1000, driftPct: 1, tfMin: 15 }) });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/trigger|unavailable/i);
  });

  it('SWING mode (1h → 15m) plans on 15m trigger bars with a 90 min window', () => {
    const ctx = candles({ n: 220, start: 1000, driftPct: 9, tfMin: 60 });
    const trig = candles({ n: 220, start: 1035, driftPct: 5, tfMin: 15, breakout: true });
    const plan = buildPlanFromCandles({ symbol: 'SWINGCO', market: 'INDIA', mode: 'SWING', holdMin: 90, ctxCandles: ctx, trigCandles: trig });
    expect(plan.ok).toBe(true);
    expect(plan.contextTf).toBe('1h');
    expect(plan.triggerTf).toBe('15m');
    expect(plan.timePlan!.bars).toBe(6); // 90 / 15
    expect(plan.dataAge.ctxBars).toBe(220);
  });

  it('crypto plans use the crypto cost model (taker fee, no STT)', () => {
    const ctx = candles({ n: 220, start: 100, driftPct: 8, tfMin: 15 });
    const trig = candles({ n: 220, start: 104, driftPct: 4, tfMin: 5, breakout: true });
    const plan = buildPlanFromCandles({ symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, ctxCandles: ctx, trigCandles: trig });
    expect(plan.costs.model).toMatch(/taker/i);
  });

  it('__clearPlanCache is safe to call (test hook)', () => {
    expect(() => __clearPlanCache()).not.toThrow();
  });

  it('cross-symbol dataAge + istTime are populated for the UI freshness chip', () => {
    const ctx = candles({ n: 220, start: 1000, driftPct: 8, tfMin: 15 });
    const trig = candles({ n: 220, start: 1030, driftPct: 4, tfMin: 5, breakout: true });
    const plan = buildPlanFromCandles({ symbol: 'X', market: 'INDIA', mode: 'INTRADAY', holdMin: 45, ctxCandles: ctx, trigCandles: trig, now: Date.UTC(2026, 0, 5, 5, 0, 0) });
    expect(plan.dataAge.istTime).toMatch(/\d\d:\d\d IST/);
    void DAY;
  });
});

// ============================================================
// v21.16.0 REGRESSION — ADAPTIVE LADDER (sub-$1 + tight-risk)
// ------------------------------------------------------------
// Live-test ne pakda: plain r2 (2dp) rounding sub-$1 pairs (DOGE ~0.084)
// aur tight-risk ≥$1 pairs (XRP ~1.36) par ladder COLLAPSE kar deti thi —
// entry/SL ek hi price, ya T1 entry ke galat side. Paper engine aise
// ticket ko "incomplete" bolke reject karta. Fix: shared pRoundLadder
// (adaptive precision + distinct-levels bump). Ye test us regression ko
// permanently band karta hai.
// ============================================================
describe('v21.16.0 adaptive ladder — no level collapse (live-test regression)', () => {
  it('sub-$1 instrument: levels distinct + strictly ordered (DOGE-class)', () => {
    const ctx = candles({ n: 120, start: 0.0845, driftPct: 1.2, tfMin: 15 });
    const trig = candles({ n: 120, start: 0.0851, driftPct: 1.2, tfMin: 5, breakout: true });
    const r = buildPlanFromCandles({ symbol: 'DOGEUSDT', market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, ctxCandles: ctx, trigCandles: trig });
    expect(r.ok).toBe(true);
    const p = r.plan;
    expect(p.entry).toBeGreaterThan(0);
    expect(p.stopLoss).toBeGreaterThan(0);
    expect(p.t1).toBeGreaterThan(0);
    expect(p.t2).toBeGreaterThan(0);
    const L = r.side === 'LONG';
    if (L) {
      expect(p.stopLoss).toBeLessThan(p.entry);
      expect(p.t1).toBeGreaterThan(p.entry);
      expect(p.t2).toBeGreaterThan(p.t1);
    } else {
      expect(p.stopLoss).toBeGreaterThan(p.entry);
      expect(p.t1).toBeLessThan(p.entry);
      expect(p.t2).toBeLessThan(p.t1);
    }
    // sub-$1 → at least 4 decimals in play (2dp collapse would equalise them)
    const d = (v: number) => String(v).split('.')[1]?.length ?? 0;
    expect(Math.max(d(p.entry), d(p.stopLoss), d(p.t1), d(p.t2))).toBeGreaterThanOrEqual(3);
  });

  it('tight-risk >= $1 instrument: ladder stays distinct (XRP-class)', () => {
    const ctx = candles({ n: 120, start: 1.362, driftPct: 0.25, tfMin: 15 });
    const trig = candles({ n: 120, start: 1.3631, driftPct: 0.25, tfMin: 5, breakout: true });
    const r = buildPlanFromCandles({ symbol: 'XRPUSDT', market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, ctxCandles: ctx, trigCandles: trig });
    expect(r.ok).toBe(true);
    const p = r.plan;
    const L = r.side === 'LONG';
    // distinct + ordered: agar collapse hota to ye teen equal nikalte
    const set = new Set([p.entry, p.stopLoss, p.t1, p.t2]);
    expect(set.size).toBe(4);
    if (L) { expect(p.stopLoss).toBeLessThan(p.entry); expect(p.t1).toBeGreaterThan(p.entry); expect(p.t2).toBeGreaterThan(p.t1); }
    else { expect(p.stopLoss).toBeGreaterThan(p.entry); expect(p.t1).toBeLessThan(p.entry); expect(p.t2).toBeLessThan(p.t1); }
  });
});
