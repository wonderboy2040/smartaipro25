// ============================================================
// test/indicatorsV21280.test.ts — v21.28.0 F6/F7 INDICATOR CORRECTNESS
// ------------------------------------------------------------
// Audit findings:
//   F6 — ADX final value last-14 DX ka SMA tha (Wilder smoothing nahi).
//   F7 — VWAP supplied slice ka cumulative tha (planner 78 bars = multi-day),
//        isliye "session VWAP" ka matlab hi gaya.
// Ye suite textbook reference implementation se golden comparison karti hai
// (koi network/venue dependency nahi).
// ============================================================
import { describe, it, expect } from 'vitest';
import { adx, vwap, vwapSessionStart } from '../server/ai/lib/indicators.js';

function candle(time, close, { high = close + 1, low = close - 1, volume = 100 } = {}) {
  return { time, open: close, high, low, close, volume };
}

/** Independent textbook Wilder ADX (14) — test-only reference. */
function wilderAdxReference(candles, period = 14) {
  const pDM = [], mDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    pDM.push(up > down && up > 0 ? up : 0);
    mDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) {
      s = s - (s / period) + arr[i];
      out.push(s);
    }
    return out;
  };
  const trS = smooth(tr), pS = smooth(pDM), mS = smooth(mDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (!(trS[i] > 0)) continue;
    const pdi = (pS[i] / trS[i]) * 100;
    const mdi = (mS[i] / trS[i]) * 100;
    const sum = pdi + mdi;
    if (sum > 0) dx.push((Math.abs(pdi - mdi) / sum) * 100);
  }
  let val = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) val = ((val * (period - 1)) + dx[i]) / period;
  return val;
}

describe('v21.28.0 F6 — ADX uses Wilder smoothing (not last-14 DX SMA)', () => {
  const candles = Array.from({ length: 80 }, (_, i) => {
    const close = 100 + i * 0.7 + Math.sin(i / 3) * 0.4;
    return candle(1_790_000_000_000 + i * 300_000, close, {
      high: close + 0.9 + (i % 5) * 0.05,
      low: close - 0.8 - (i % 3) * 0.04,
      volume: 1000 + i * 3,
    });
  });

  it('matches the independent Wilder reference', () => {
    const got = adx(candles, 14);
    expect(got).not.toBeNull();
    expect(got.adx).toBeCloseTo(wilderAdxReference(candles, 14), 6);
  });

  it('is NOT the simple SMA of the last 14 DX values when DX is variable', () => {
    // Zig-zag tape → DX genuinely varies, so SMA vs Wilder must diverge.
    const mixed = Array.from({ length: 90 }, (_, i) => {
      const close = 100 + i * 0.2 + Math.sin(i / 1.7) * 5 + (i % 11 === 0 ? 3 : 0);
      return candle(1_790_000_000_000 + i * 300_000, close, {
        high: close + 1.2 + (i % 4) * 0.3,
        low: close - 1.1 - (i % 3) * 0.2,
        volume: 1000 + i * 3,
      });
    });
    const period = 14;
    const pDM = [], mDM = [], tr = [];
    for (let i = 1; i < mixed.length; i++) {
      const c = mixed[i], p = mixed[i - 1];
      const up = c.high - p.high, down = p.low - c.low;
      pDM.push(up > down && up > 0 ? up : 0);
      mDM.push(down > up && down > 0 ? down : 0);
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    const smooth = (arr) => {
      let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
      const out = [s];
      for (let i = period; i < arr.length; i++) { s = s - (s / period) + arr[i]; out.push(s); }
      return out;
    };
    const trS = smooth(tr), pS = smooth(pDM), mS = smooth(mDM);
    const dx = [];
    for (let i = 0; i < trS.length; i++) {
      if (!(trS[i] > 0)) continue;
      const pdi = (pS[i] / trS[i]) * 100, mdi = (mS[i] / trS[i]) * 100;
      const sum = pdi + mdi;
      if (sum > 0) dx.push((Math.abs(pdi - mdi) / sum) * 100);
    }
    const buggySma = dx.slice(-period).reduce((a, b) => a + b, 0) / period;
    expect(Math.abs(adx(mixed, 14).adx - buggySma)).toBeGreaterThan(0.01);
  });

  it('still honest-refuses a too-short series', () => {
    expect(adx(candles.slice(0, 20), 14)).toBeNull();
  });
});

describe('v21.28.0 F7 — VWAP anchored to the current session', () => {
  const DAY = 86_400_000;
  const todayStart = Date.UTC(2026, 9, 30); // 2026-10-30 UTC
  const yesterday = [
    candle(todayStart - DAY + 3_600_000, 100, { volume: 5_000 }),
    candle(todayStart - DAY + 7_200_000, 105, { volume: 5_000 }),
  ];
  const today = [
    candle(todayStart + 3_600_000, 200, { volume: 100 }),
    candle(todayStart + 7_200_000, 220, { volume: 300 }),
  ];
  const slice = [...yesterday, ...today];
  const expectedToday = ((200 * 100) + (220 * 300)) / 400;

  it('uses only candles from the last candle\'s UTC session', () => {
    expect(vwap(slice)).toBeCloseTo(expectedToday, 6);
  });

  it('legacy full-slice average would be materially different (regression pin)', () => {
    const all = ((100 * 5_000) + (105 * 5_000) + (200 * 100) + (220 * 300)) / 10_400;
    expect(Math.abs(vwap(slice) - all)).toBeGreaterThan(20);
  });

  it('explicit sessionStartTs overrides the inferred anchor', () => {
    const start = todayStart + 7_200_000; // only the last candle
    expect(vwap(slice, { sessionStartTs: start })).toBeCloseTo(220, 6);
  });

  it('seconds-based timestamps are normalized to ms', () => {
    const secs = today.map((c) => ({ ...c, time: Math.floor(c.time / 1000) }));
    expect(vwap([...yesterday, ...secs])).toBeCloseTo(expectedToday, 6);
  });

  it('daily series keeps the full supplied slice (no fake intraday session)', () => {
    const daily = Array.from({ length: 10 }, (_, i) => candle(todayStart - (9 - i) * DAY, 100 + i, { volume: 10 }));
    const expectedAll = daily.reduce((a, c) => a + ((c.high + c.low + c.close) / 3) * c.volume, 0)
      / daily.reduce((a, c) => a + c.volume, 0);
    expect(vwapSessionStart(daily)).toBeNull();
    expect(vwap(daily)).toBeCloseTo(expectedAll, 6);
  });

  it('no timestamps → legacy full-slice fallback (honest, no fabricated anchor)', () => {
    const bare = [
      { high: 100, low: 100, close: 100, volume: 1 },
      { high: 200, low: 200, close: 200, volume: 3 },
    ];
    expect(vwap(bare)).toBeCloseTo(175, 6);
  });
});
