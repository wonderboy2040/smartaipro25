// ============================================================
// test/indiaBoardTiered.test.ts — v10.17 BOARD × TIERED WIRING
// ------------------------------------------------------------
// Locks the signals.js INDIA branch contract:
//   • discovery LIVE  → the board scans the TIERED set (T1+slice)
//     via the CHUNKED batch and labels superMeta honestly
//   • discovery DOWN  → legacy static universe + plain batch
//     (byte-identical v9.3 behavior — the same-upstream honesty)
//   • hot absorb runs only on the live path
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- the tier engine (mocked — its own math is locked in
// indiaUniverse.test.ts; here we lock the BOARD wiring) ----
const tieredState = {
  mode: 'tiered-full',
  scan: ['RELIANCE', 'TCS', 'IRFC', 'HUDCO'],
  t1Count: 2, t2Count: 8, sliceCount: 2, fullCount: 10,
  hot: ['IRFC'],
};
const absorbCalls = [];
const tieredBaseArgs: string[][] = [];
let overrideState: { removedBase: Set<string>, custom: string[] } = { removedBase: new Set(), custom: [] };
vi.mock('../server/ai/indiaUniverse.js', () => ({
  // v20.3: capture the BASE array — the board must PRE-FILTER it (the
  // exclude opt only touches discovered rows + the hot map).
  tieredScanUniverse: async (base) => { tieredBaseArgs.push([...(base || [])]); return { ...tieredState }; },
  absorbScanRows: (rows) => { absorbCalls.push(rows); return tieredState.hot; },
  fullIndiaUniverseEnabled: () => true,
  // v20.2: the board reads the user's universe-editor overrides through
  // this seam — mocked (no disk reads in tests). v20.3: mutable so the
  // removedBase path is exercisable.
  boardUniverseOverrides: () => overrideState,
}));

// ---- data.js (mocked — count which batch fn the board used) ----
let plainCalls = 0, chunkedCalls = 0, chunkedArg = null;
const tvRowsFor = (symbols) => {
  const out = {};
  for (const s of symbols || []) {
    out[s] = {
      symbol: s, exchange: 'NSE', ltp: 100, open: 99, high: 101, low: 98,
      volume: 1e6, changePct: 1, ema10: 100, ema20: 99, ema50: 98,
      sma20: 99, sma50: 98, rsi: 55, macd: 1, macdSignal: 0.5,
      atr: 2, vwap: 100, adx: 20, adxPlus: 15, adxMinus: 10,
      relVolume: 1.2, pivot: { p: 100, s1: 98, r1: 102 },
      bbUpper: 104, bbLower: 96, stochK: 60, stochD: 55,
      high52w: 120, low52w: 80, recommend: 0,
    };
  }
  return out;
};
vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE', 'TCS'],
  CRYPTO_UNIVERSE: ['BTC'],
  FUTURES_UNIVERSE: ['B-BTC_USDT'],
  fetchTVIndiaBatch: async (symbols) => { plainCalls++; return tvRowsFor(symbols); },
  fetchTVIndiaBatchChunked: async (symbols) => {
    chunkedCalls++;
    chunkedArg = [...(symbols || [])];
    return tvRowsFor(symbols);
  },
  fetchTVCryptoBatch: async () => ({}),
  fetchCoinDcxCandles: async () => null,
  fetchYahooQuotes: async () => ({}),
  isNseOpen: () => true,
}));

// every raw network call in signals.js itself → OFFLINE
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test)'); }));

const { getSignals, __clearSignalCaches } = await import('../server/ai/signals.js');

beforeEach(() => {
  __clearSignalCaches();
  plainCalls = 0; chunkedCalls = 0; chunkedArg = null;
  absorbCalls.length = 0;
  tieredBaseArgs.length = 0;
  overrideState = { removedBase: new Set(), custom: [] };
  tieredState.mode = 'tiered-full';
  tieredState.scan = ['RELIANCE', 'TCS', 'IRFC', 'HUDCO'];
});

describe('INDIA board × tiered full universe (v10.17)', () => {
  it('discovery LIVE → chunked batch over the TIERED scan set + honest superMeta', async () => {
    const board = await getSignals('INDIA', {}, { limit: 5, noCache: true });
    expect(board.ok).toBe(true);
    expect(chunkedCalls).toBe(1);
    expect(plainCalls).toBe(0);                     // never the single-shot path
    expect(chunkedArg).toEqual(['RELIANCE', 'TCS', 'IRFC', 'HUDCO']); // T1 + T2 slice
    expect(board.superIntelMeta.universeMode).toContain('tiered-full');
    expect(board.superIntelMeta.tiered).toMatchObject({ t1: 2, t2: 8, slice: 2, full: 10 });
    expect(board.superIntelMeta.tiered.hot).toEqual(['IRFC']);
    // the freshly scanned rows were fed back into the hot engine
    expect(absorbCalls.length).toBe(1);
    expect(absorbCalls[0].map(r => r.symbol)).toEqual(['RELIANCE', 'TCS', 'IRFC', 'HUDCO']);
  });

  it('discovery DOWN (seed fallback) → legacy static universe + plain batch, hot absorb skipped', async () => {
    tieredState.mode = 'tiered-seed-fallback';
    tieredState.scan = ['RELIANCE', 'TCS'];
    const board = await getSignals('INDIA', {}, { limit: 5, noCache: true });
    expect(board.ok).toBe(true);
    expect(plainCalls).toBe(1);                     // the locked v9.3 path
    expect(chunkedCalls).toBe(0);
    expect(board.superIntelMeta.universeMode).toBe('tv-nse-batch');
    expect(board.superIntelMeta.tiered).toBeUndefined();
    expect(absorbCalls.length).toBe(0);             // no hot promotion on a guessed universe
  });

  it('tiered symbols that the TV batch resolves still generate signal contexts', async () => {
    const board = await getSignals('INDIA', {}, { limit: 5, noCache: true });
    // all four scanned symbols built contexts and voted (consensus
    // may be FLAT on this neutral fixture — the CONTRACT is that the
    // tiered names were part of the scan, visible via superMeta size)
    expect(board.superIntelMeta.universeSize).toBe(tieredState.fullCount + 2);
  });
});


// ============================================================
// v20.3 — UNIVERSE EDITOR × BOARD BASE ARRAY (the T1 leak)
// ------------------------------------------------------------
// tieredScanUniverse's `exclude` only filters DISCOVERED rows and the
// hot map — the caller's BASE array must arrive pre-filtered. The
// board used to pass raw INDIA_UNIVERSE, so a removed T1 name (44/45
// of the editor's names are T1) kept scanning on EVERY board cycle.
// ============================================================
describe('v20.3 — removedBase is filtered out of the board BASE array', () => {
  it('a removed T1 name never reaches tieredScanUniverse (belt-and-suspenders exclude stays)', async () => {
    overrideState = { removedBase: new Set(['TCS']), custom: [] };
    const board = await getSignals('INDIA', {}, { limit: 5, noCache: true });
    expect(board.ok).toBe(true);
    expect(tieredBaseArgs).toHaveLength(1);
    expect(tieredBaseArgs[0]).toEqual(['RELIANCE']);  // TCS (removed) gone from the BASE
  });

  it('custom adds still ride Tier-1 on top of the filtered base', async () => {
    overrideState = { removedBase: new Set(['TCS']), custom: ['IRCTC'] };
    const board = await getSignals('INDIA', {}, { limit: 5, noCache: true });
    expect(board.ok).toBe(true);
    // base filtered + the custom add merged into the scan set
    expect(tieredBaseArgs[0]).toEqual(['RELIANCE']);
    expect(chunkedArg).toContain('IRCTC');
  });
});
