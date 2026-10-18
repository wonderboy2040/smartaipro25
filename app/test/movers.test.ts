// ============================================================
// movers.test — Trending Gainers/Losers deep-analysis builder
// (server/intraday/movers.js — pure functions, no network)
// v4.5: + mostActive ordering, sector pulse, crypto index pulse
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildMoversRows, moversAnalysis, buildSectorPulse, buildCryptoIndices } from '../server/intraday/movers.js';

const tv = (over = {}) => ({
  close: 100, open: 99, high: 105, low: 97, volume: 1e6, change: 2.5,
  ema10: 100, ema20: 101, sma20: 99, sma50: 95,
  rsi: 62, macd: 1, macdSignal: 0.8, atr: 2, vwap: 99.5,
  adx: 28, adxPlus: 25, adxMinus: 10, relVolume: 2.8,
  pivotMiddle: 100, pivotS1: 95, pivotR1: 105, recommend: 0.5, last: 102,
  ...over,
});

const q = (over = {}) => ({ price: 102, change: 2.5, high: 105, low: 97, volume: 1e6, prevClose: 99.5, ...over });

describe('buildMoversRows — ordering & breadth', () => {
  it('sorts gainers desc and losers asc-reversed, caps at 8', () => {
    const universe = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const tvData = {}; const quoteData = {};
    universe.forEach((s, i) => {
      const chg = i - 10; // -10 .. +9
      tvData[s] = tv({ change: chg });
      quoteData[s] = q({ change: chg, price: 100 + chg });
    });
    const out = buildMoversRows(universe, tvData, quoteData, 'INDIA');
    expect(out.gainers.length).toBeLessThanOrEqual(8);
    expect(out.losers.length).toBeLessThanOrEqual(8);
    // strongest gainer first
    expect(out.gainers[0].symbol).toBe('S19');
    // weakest (most negative) loser first
    expect(out.losers[0].symbol).toBe('S0');
    // gainers all positive, losers all negative
    expect(out.gainers.every(g => g.changePct > 0)).toBe(true);
    expect(out.losers.every(l => l.changePct < 0)).toBe(true);
    // breadth
    expect(out.breadth.scanned).toBe(20);
    expect(out.breadth.advanced).toBe(9);
    expect(out.breadth.declined).toBe(10);
    expect(out.breadth.unchanged).toBe(1);
    // 9 adv vs 10 decl — neither side 1.5x dominant → MIXED
    expect(out.breadth.bias).toBe('MIXED');
  });

  it('flags a strongly bullish tape as BULLISH bias', () => {
    const universe = ['A', 'B', 'C', 'D', 'E', 'F'];
    const tvData = {}; const quoteData = {};
    universe.forEach((s) => { tvData[s] = tv({ change: 3 }); quoteData[s] = q({ change: 3 }); });
    const out = buildMoversRows(universe, tvData, quoteData, 'INDIA');
    expect(out.breadth.advanced).toBe(6);
    expect(out.breadth.bias).toBe('BULLISH');
  });

  it('skips symbols with no usable price', () => {
    const out = buildMoversRows(['A', 'B'], { A: tv() }, { A: q() }, 'INDIA');
    expect(out.breadth.scanned).toBe(1);
  });

  it('prefers the LIVE quote change over the TV batch value', () => {
    const out = buildMoversRows(['A'], { A: tv({ change: 1 }) }, { A: q({ change: 5 }) }, 'INDIA');
    expect(out.gainers[0].changePct).toBe(5);
  });

  it('falls back to TV change when the quote has none', () => {
    const out = buildMoversRows(['A'], { A: tv({ change: -2 }) }, { A: q({ change: 0, price: 0 }) }, 'INDIA');
    // quote price 0 → ltp falls back to TV last(102), change from TV
    expect(out.losers[0].changePct).toBe(-2);
  });
});

describe('buildMoversRows — v4.5 mostActive / sectors / crypto indices', () => {
  it('mostActive ranks by session volume desc and skips volume-less rows', () => {
    const universe = ['A', 'B', 'C', 'D'];
    const tvData = {}; const quoteData = {};
    universe.forEach((s, i) => {
      tvData[s] = tv({ change: i, volume: (4 - i) * 1e6 });
      quoteData[s] = q({ change: i, volume: (4 - i) * 1e6 });
    });
    // D has no volume at all (quote 0 + tv null)
    delete quoteData.D; tvData.D = null;
    const out = buildMoversRows(universe, tvData, quoteData, 'INDIA');
    expect(out.mostActive.map(r => r.symbol)).toEqual(['A', 'B', 'C']);
    expect(out.mostActive[0].volume).toBe(4e6);
  });

  it('mostActive is capped at 8', () => {
    const universe = Array.from({ length: 12 }, (_, i) => `V${i}`);
    const tvData = {}; const quoteData = {};
    universe.forEach((s, i) => {
      tvData[s] = tv({ change: 1, volume: (12 - i) * 1e5 });
      quoteData[s] = q({ change: 1, volume: (12 - i) * 1e5 });
    });
    const out = buildMoversRows(universe, tvData, quoteData, 'INDIA');
    expect(out.mostActive.length).toBe(8);
    expect(out.mostActive[0].volume).toBeGreaterThan(out.mostActive[7].volume);
  });

  it('sectors aggregate per-sector avg move, adv/dec counts, strongest first', () => {
    const out = buildMoversRows(
      ['HDFCBANK', 'ICICIBANK', 'INFY', 'TCS'],
      {
        HDFCBANK: tv({ change: 2 }), ICICIBANK: tv({ change: 1 }),
        INFY: tv({ change: -1 }), TCS: tv({ change: -3 }),
      },
      {
        HDFCBANK: q({ change: 2, volume: 1e6 }), ICICIBANK: q({ change: 1, volume: 1e6 }),
        INFY: q({ change: -1, volume: 1e6 }), TCS: q({ change: -3, volume: 1e6 }),
      },
      'INDIA',
    );
    const banks = out.sectors.find(s => s.name === 'Banks');
    const itSec = out.sectors.find(s => s.name === 'IT');
    expect(banks).toBeDefined();
    expect(banks!.count).toBe(2);
    expect(banks!.advancing).toBe(2);
    expect(banks!.declining).toBe(0);
    expect(banks!.avgPct).toBe(1.5);
    expect(itSec!.declining).toBe(2);
    expect(itSec!.avgPct).toBe(-2);
    // strongest sector first
    expect(out.sectors[0].name).toBe('Banks');
  });

  it('unmapped symbols fall into the Other sector bucket', () => {
    const out = buildMoversRows(['ZZZ'], { ZZZ: tv({ change: 1 }) }, { ZZZ: q({ change: 1, volume: 5 }) }, 'INDIA');
    expect(out.sectors.find(s => s.name === 'Other')!.count).toBe(1);
  });

  it('CRYPTO payload carries BTC/ETH index pulse off the same batch rows', () => {
    const out = buildMoversRows(
      ['BTC', 'ETH', 'SOL'],
      {
        BTC: tv({ change: 1.5, last: 9000000, vwap: 8900000, rsi: 60 }),
        ETH: tv({ change: -2, last: 300000, vwap: 305000, rsi: 40 }),
        SOL: tv({ change: 0.5, last: 14000 }),
      },
      {
        BTC: q({ price: 9100000, change: 1.6, high: 9200000, low: 9000000, volume: 420 }),
        ETH: q({ price: 298000, change: -2.2, high: 305000, low: 297000, volume: 180 }),
        SOL: q({ price: 14100, change: 0.4, high: 14200, low: 13900, volume: 90 }),
      },
      'CRYPTO',
    );
    expect(out.indices.map(i => i.symbol)).toEqual(['BTC', 'ETH']);
    expect(out.indices[0].name).toBe('Bitcoin');
    expect(out.indices[0].changePct).toBe(1.6);
    expect(out.indices[0].vwapDist).toBeGreaterThan(0);
    // sector pulse keys off crypto sub-sectors too
    expect(out.sectors.find(s => s.name === 'Layer 1')!.count).toBe(3);
  });

  it('INDIA payload omits crypto-style indices (server merges TV index pulse instead)', () => {
    const out = buildMoversRows(['A'], { A: tv() }, { A: q() }, 'INDIA');
    expect(out.indices).toEqual([]);
  });

  it('buildCryptoIndices tolerates missing majors and empty input', () => {
    expect(buildCryptoIndices([])).toEqual([]);
    const rows = [{ symbol: 'SOL', ltp: 14000, changePct: 0.4, vwapDist: null, rsi: null }];
    expect(buildCryptoIndices(rows)).toEqual([]);
  });

  it('buildSectorPulse handles null-ish input gracefully', () => {
    expect(buildSectorPulse(null)).toEqual([]);
    expect(buildSectorPulse(undefined)).toEqual([]);
  });
});

describe('moversAnalysis — deep-analysis chips', () => {
  it('tags overbought RSI, VWAP+, volume surge, strong trend, at-high', () => {
    const row = {
      symbol: 'X', market: 'INDIA', ltp: 104.8, changePct: 4.5,
      high: 105, low: 97, volume: 5e6,
      relVolume: 3.1, rsi: 74, adx: 31, vwap: 99, sma50: 95, ema20: 101,
      pivotR1: 108, pivotS1: 95,
      vwapDist: null, dayRangePos: null, pivotRoomUp: null, pivotRoomDown: null,
      tags: [], analysis: '',
    };
    const out = moversAnalysis(row, 'INDIA');
    expect(out.tags).toContain('RSI-OB');
    expect(out.tags).toContain('VWAP+');
    expect(out.tags).toContain('VOL-SURGE');
    expect(out.tags).toContain('STRONG-TREND');
    expect(out.tags).toContain('AT-HIGH');
    expect(out.tags).toContain('ABOVE-SMA50');
    expect(out.vwapDist).toBeCloseTo(5.86, 1);
    expect(out.dayRangePos).toBeGreaterThanOrEqual(85);
    expect(out.analysis).toContain('overbought');
  });

  it('tags oversold RSI + VWAP− + at-low for a dump', () => {
    const row = {
      symbol: 'Y', market: 'CRYPTO', ltp: 95, changePct: -4,
      high: 105, low: 94.5, volume: 1e6,
      relVolume: 1.8, rsi: 26, adx: 12, vwap: 100, sma50: 95, ema20: 101,
      pivotR1: 105, pivotS1: 92,
      vwapDist: null, dayRangePos: null, pivotRoomUp: null, pivotRoomDown: null,
      tags: [], analysis: '',
    };
    const out = moversAnalysis(row, 'CRYPTO');
    expect(out.tags).toContain('RSI-OS');
    expect(out.tags).toContain('VWAP−');
    expect(out.tags).toContain('AT-LOW');
    expect(out.analysis).toContain('oversold');
  });

  it('crypto rows carry market=COUNTRY label and quote-only rows degrade gracefully', () => {
    const row = {
      symbol: 'BTC', market: 'CRYPTO', ltp: 5000000, changePct: 1.2,
      high: null, low: null, volume: null,
      relVolume: null, rsi: null, adx: null, vwap: null, sma50: null, ema20: null,
      pivotR1: null, pivotS1: null,
      vwapDist: null, dayRangePos: null, pivotRoomUp: null, pivotRoomDown: null,
      tags: [], analysis: '',
    };
    const out = moversAnalysis(row, 'CRYPTO');
    expect(out.tags).toEqual([]);
    expect(out.analysis).toBe('indicators mixed — quote-only row');
  });
});
