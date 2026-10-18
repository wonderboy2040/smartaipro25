// ============================================================
// test/sectors.test.ts — v11.1 GAP 1: SECTOR-MAP × FULL UNIVERSE
// ------------------------------------------------------------
// THE GAP being locked: sectors.js's static 45-symbol SECTOR_MAP never
// talked to indiaUniverse.js's dynamic ~220-name scan — a genuinely
// strong F&O name outside the original 45 could never surface through
// the sector lens. Locks:
//   1. buildSectorMap: original 45 keep their curated buckets; the
//      extended static classification covers the seed/F&O names; TV's
//      own `sector` taxonomy buckets discovered strangers; static
//      ALWAYS wins over TV; unknown TV sectors → honest OTHERS.
//   2. parseDiscoveryRows: the appended `sector` column (d[8]) rides
//      through with locked indices 0-7 unchanged.
//   3. sectorDesk full mode: an out-of-45 symbol (BEL) is bucketed
//      into DEFENCE and CONTRIBUTES to breadth/momentum/leaders; the
//      context chain + F-Score board see it too; sectorMode labelled.
//   4. sectorDesk flag OFF: the legacy static 45-name path,
//      byte-identical payload shape (sectorMode 'base-45').
// Hermetic — data.js + indiaUniverse discovery mocked.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- controllable mocks over the REAL modules ----
const ctrl = {
  fullUniverse: true,
  discovered: { at: Date.now(), rows: [] as any[], ok: true },
  chunkedRows: {} as any,
  plainRows: {} as any,
  yahoo: {} as any,
  chunkedCalls: 0,
  plainCalls: 0,
  chunkedArg: [] as string[],
};
vi.mock('../server/ai/data.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    INDIA_UNIVERSE: actual.INDIA_UNIVERSE,
    fetchTVIndiaBatch: vi.fn(async (symbols: string[]) => { ctrl.plainCalls++; return { ...ctrl.plainRows }; }),
    fetchTVIndiaBatchChunked: vi.fn(async (symbols: string[]) => {
      ctrl.chunkedCalls++;
      ctrl.chunkedArg = [...symbols];
      const out: any = {};
      for (const s of symbols) if (ctrl.chunkedRows[s]) out[s] = ctrl.chunkedRows[s];
      return out;
    }),
    fetchYahooQuotes: vi.fn(async () => ctrl.yahoo),
  };
});
vi.mock('../server/ai/indiaUniverse.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    fullIndiaUniverseEnabled: () => ctrl.fullUniverse,
    discoverNSEFullUniverse: vi.fn(async () => ctrl.discovered),
  };
});

import { sectorDesk, buildSectorMap, SECTOR_MAP, EXTENDED_SECTOR_CLASSIFICATION, TV_SECTOR_TO_DESK, __testables, __resetSectorDeskForTests } from '../server/ai/sectors.js';

// a TV-batch row shaped like fetchTVIndiaBatch serves (fscore-capable)
const row = (symbol: string, over = {}) => ({
  symbol, exchange: 'NSE', ltp: 100, open: 99, high: 101, low: 98,
  volume: 1e6, changePct: 1, ema10: 100, ema20: 99, ema50: 98,
  sma20: 99, sma50: 98, rsi: 55, macd: 1, macdSignal: 0.5,
  atr: 2, vwap: 100, adx: 22, adxPlus: 15, adxMinus: 10,
  relVolume: 1.3, pivot: { p: 100, s1: 98, r1: 102 },
  bbUpper: 104, bbLower: 96, stochK: 60, stochD: 55,
  high52w: 120, low52w: 80, recommend: 0,
  ...over,
});

beforeEach(() => {
  __resetSectorDeskForTests(); // the 5-min payload cache must not bleed between cases
  ctrl.fullUniverse = true;
  ctrl.discovered = { at: Date.now(), rows: [], ok: true };
  ctrl.chunkedRows = {};
  ctrl.plainRows = {};
  ctrl.yahoo = { NIFTY: { price: 23400, changePct: 0.5 }, INDIAVIX: { price: 12 } };
  ctrl.chunkedCalls = 0;
  ctrl.plainCalls = 0;
  ctrl.chunkedArg = [];
});

// ============================================================
// 1. buildSectorMap — the merged lookup
// ============================================================
describe('buildSectorMap — curated static + TV taxonomy merge', () => {
  it('the original 45 keep their curated buckets (SECTOR_MAP intact)', () => {
    const map = buildSectorMap([]);
    expect(SECTOR_MAP.BANKING).toHaveLength(6);
    expect(SECTOR_MAP.IT).toHaveLength(5);
    for (const [sec, syms] of Object.entries(SECTOR_MAP)) {
      for (const s of syms) expect(map.get(s)).toBe(sec);
    }
    expect(map.size).toBeGreaterThanOrEqual(45);
  });

  it('extended static classification covers the out-of-45 seed/F&O names', () => {
    const map = buildSectorMap([]);
    expect(map.get('BEL')).toBe('DEFENCE');
    expect(map.get('HAL')).toBe('DEFENCE');
    expect(map.get('DLF')).toBe('REALTY');
    expect(map.get('IRCTC')).toBe('TRANSPORT');
    expect(map.get('IDEA')).toBe('TELECOM');
    expect(map.get('PIDILITIND')).toBe('CHEMICALS');
    expect(map.get('APOLLOHOSP')).toBe('HEALTHCARE');
    expect(map.get('TATAPOWER')).toBe('ENERGY');
    expect(Object.keys(EXTENDED_SECTOR_CLASSIFICATION).length).toBeGreaterThan(100);
  });

  it('TV sector strings bucket discovered strangers (live taxonomy, appended column)', () => {
    const map = buildSectorMap([
      { symbol: 'MODINATUR', sector: 'Process Industries' },
      { symbol: 'MINDTECK', sector: 'Technology Services' },
      { symbol: 'INDBANK', sector: 'Finance' },
      { symbol: 'METROBRAND', sector: 'Retail Trade' },
      { symbol: 'WEIRD1', sector: 'Alien Industries' }, // unknown taxonomy → OTHERS
      { symbol: 'NOSECTOR', sector: null },
    ]);
    expect(map.get('MODINATUR')).toBe('CHEMICALS');
    expect(map.get('MINDTECK')).toBe('IT');
    expect(map.get('INDBANK')).toBe('FINANCIALS');
    expect(map.get('METROBRAND')).toBe('CONSUMER');
    expect(map.get('WEIRD1')).toBe('OTHERS');
    expect(map.has('NOSECTOR')).toBe(false); // no string + no static → not seated (OTHERS at use time)
    expect(TV_SECTOR_TO_DESK['Technology Services']).toBe('IT');
  });

  it('curated static ALWAYS wins over TV taxonomy (no silent re-bucketing of the base)', () => {
    const map = buildSectorMap([{ symbol: 'HDFCBANK', sector: 'Finance' }, { symbol: 'BHARTIARTL', sector: 'Communications' }]);
    expect(map.get('HDFCBANK')).toBe('BANKING');            // static, not TV's 'Finance'
    expect(map.get('BHARTIARTL')).toBe('CONSUMER');         // the original map's (odd but curated) bucket
  });
});

// ============================================================
// 2. parseDiscoveryRows — the appended sector column
// ============================================================
describe('parseDiscoveryRows — sector column (d[8], indices 0-7 locked)', () => {
  it('captures the TV sector string without disturbing the locked column contract', async () => {
    const actual: any = await vi.importActual('../server/ai/indiaUniverse.js');
    const rows = actual.parseDiscoveryRows([
      { d: ['MODINATUR', 'NSE', 330.9, 1.5, 2117, 12345678, 1.2, 5e9, 'Process Industries'] },
      { d: ['MINDTECK', 'NSE', 156.49, 1.3, 4012, 8765432, 0.9, 1e9, 'Technology Services'] },
      { d: ['NOSECTOR', 'NSE', 100, 0.5, 10, 1000, 1.0, 1e8] }, // 8 columns — sector absent
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ symbol: 'MODINATUR', ltp: 330.9, sector: 'Process Industries', valueTraded: 12345678 });
    expect(rows[1].sector).toBe('Technology Services');
    expect(rows[2].sector).toBeNull(); // absent column → honest null, row still valid
    // locked indices 0-7 unchanged
    expect(rows[0].changePct).toBe(1.5);
    expect(rows[0].volume).toBe(2117);
    expect(rows[0].relVolume).toBe(1.2);
    expect(rows[0].marketCap).toBe(5e9);
  });
});

// ============================================================
// 3. sectorDesk — FULL mode (default): the out-of-45 name surfaces
// ============================================================
describe('sectorDesk — full-universe mode', () => {
  it('buckets a symbol from OUTSIDE the original 45 and lets it CONTRIBUTE to its sector', async () => {
    // BEL (defence) + IRFC (financials) discovered — both outside the 45
    ctrl.discovered.rows = [
      { symbol: 'BEL', ltp: 300, changePct: 2, valueTraded: 9e9, sector: 'Electronic Technology' },
      { symbol: 'IRFC', ltp: 130, changePct: 1, valueTraded: 8e9, sector: 'Finance' },
    ];
    // static classification wins anyway (BEL → DEFENCE, IRFC → FINANCIALS)
    ctrl.chunkedRows = {
      HDFCBANK: row('HDFCBANK', { changePct: 0.2 }),
      ICICIBANK: row('ICICIBANK', { changePct: 0.1 }),
      SBIN: row('SBIN', { changePct: 0.3 }),
      AXISBANK: row('AXISBANK', { changePct: -0.1 }),
      KOTAKBANK: row('KOTAKBANK', { changePct: 0.05 }),
      INDUSINDBK: row('INDUSINDBK', { changePct: -0.2 }),
      INFY: row('INFY', { changePct: 0.4 }),
      TCS: row('TCS', { changePct: 0.3 }),
      WIPRO: row('WIPRO', { changePct: 0.1 }),
      BEL: row('BEL', { changePct: 4.5, ltp: 300, rsi: 63, relVolume: 2.1 }),
      IRFC: row('IRFC', { changePct: 1.5, ltp: 130 }),
    };
    const out = await sectorDesk();
    expect(out.ok).toBe(true);
    expect(out.sectorMode).toBe('full-dynamic');
    expect(ctrl.chunkedCalls).toBe(1);
    expect(ctrl.chunkedArg).toContain('BEL');
    expect(ctrl.chunkedArg).toContain('HDFCBANK');
    expect(out.universe).toBe(11);
    // THE GAP CLOSED: BEL is a DEFENCE sector member with breadth/momentum
    const defence = out.sectors.find((s: any) => s.sector === 'DEFENCE');
    expect(defence).toBeTruthy();
    expect(defence.symbols).toBe(1);
    expect(defence.breadth).toBe(100);            // ltp > ema20 → above
    expect(defence.avgChangePct).toBe(4.5);
    expect(defence.leader.symbol).toBe('BEL');    // the out-of-45 name SURFACES
    // banking still computed over its 6 members
    const banking = out.sectors.find((s: any) => s.sector === 'BANKING');
    expect(banking.symbols).toBe(6);
    // F-Score board sees the full universe
    expect(out.fscore.top.length).toBeGreaterThan(0);
    expect(out.fscore.distribution.A + out.fscore.distribution.B + out.fscore.distribution.C).toBe(11);
    // context chain present + honest note about the full universe
    expect(out.chain.strongest.length).toBeGreaterThan(0);
    expect(out.note).toContain('FULL discovered universe');
  });

  it('discovery-down (seed fallback) still buckets via static classification and labels the mode honestly', async () => {
    // the REAL seed-fallback shape: rows populated from the static seed
    // (~120 names, zeroed except symbol) with ok:false — the curated
    // classification carries the bucketing, TV taxonomy unavailable.
    ctrl.discovered = { at: Date.now(), ok: false, rows: [
      { symbol: 'BEL', ltp: 0, changePct: 0, volume: 0, valueTraded: 0, relVolume: null, marketCap: 0, sector: null },
      { symbol: 'IRFC', ltp: 0, changePct: 0, volume: 0, valueTraded: 0, relVolume: null, marketCap: 0, sector: null },
    ] };
    ctrl.chunkedRows = {
      HDFCBANK: row('HDFCBANK'), BEL: row('BEL', { changePct: 3 }),
      ICICIBANK: row('ICICIBANK'), SBIN: row('SBIN'), AXISBANK: row('AXISBANK'),
      KOTAKBANK: row('KOTAKBANK'), INDUSINDBK: row('INDUSINDBK'), INFY: row('INFY'),
      TCS: row('TCS'), WIPRO: row('WIPRO'),
    };
    const out = await sectorDesk();
    expect(out.sectorMode).toBe('full-seed-fallback');
    expect(out.sectors.find((s: any) => s.sector === 'DEFENCE')?.symbols).toBe(1);
  });
});

// ============================================================
// 4. sectorDesk — flag OFF: the legacy path, byte-identical shape
// ============================================================
describe('sectorDesk — legacy static mode (AI_INDIA_FULL_UNIVERSE=off)', () => {
  it('scans only the static 45 via the PLAIN batch and serves the base-45 payload', async () => {
    ctrl.fullUniverse = false;
    ctrl.plainRows = {
      HDFCBANK: row('HDFCBANK'), ICICIBANK: row('ICICIBANK'), SBIN: row('SBIN'),
      AXISBANK: row('AXISBANK'), KOTAKBANK: row('KOTAKBANK'), INDUSINDBK: row('INDUSINDBK'),
      INFY: row('INFY'), TCS: row('TCS'), WIPRO: row('WIPRO'), HCLTECH: row('HCLTECH'), TECHM: row('TECHM'),
      RELIANCE: row('RELIANCE'), ONGC: row('ONGC'), BPCL: row('BPCL'), NTPC: row('NTPC'),
      POWERGRID: row('POWERGRID'), COALINDIA: row('COALINDIA'),
      MARUTI: row('MARUTI'), TATAMOTORS: row('TATAMOTORS'), EICHERMOT: row('EICHERMOT'),
      HEROMOTOCO: row('HEROMOTOCO'), 'BAJAJ-AUTO': row('BAJAJ-AUTO'),
      SUNPHARMA: row('SUNPHARMA'), CIPLA: row('CIPLA'), DRREDDY: row('DRREDDY'), DIVISLAB: row('DIVISLAB'),
      HINDUNILVR: row('HINDUNILVR'), ITC: row('ITC'), NESTLEIND: row('NESTLEIND'),
      BAJFINANCE: row('BAJFINANCE'), BAJAJFINSV: row('BAJAJFINSV'), SBILIFE: row('SBILIFE'),
      HDFCLIFE: row('HDFCLIFE'), SHRIRAMFIN: row('SHRIRAMFIN'),
      TATASTEEL: row('TATASTEEL'), JSWSTEEL: row('JSWSTEEL'), HINDALCO: row('HINDALCO'),
      LT: row('LT'), ULTRACEMCO: row('ULTRACEMCO'), GRASIM: row('GRASIM'),
      ADANIENT: row('ADANIENT'), ADANIPORTS: row('ADANIPORTS'),
      BHARTIARTL: row('BHARTIARTL'), ASIANPAINT: row('ASIANPAINT'), TITAN: row('TITAN'),
    };
    const out = await sectorDesk();
    expect(ctrl.plainCalls).toBe(1);
    expect(ctrl.chunkedCalls).toBe(0);
    expect(out.sectorMode).toBe('base-45');
    expect(out.universe).toBe(45);
    // exactly the ORIGINAL ten sectors, no new buckets
    expect(out.sectors.map((s: any) => s.sector).sort()).toEqual(Object.keys(SECTOR_MAP).sort());
    // no out-of-45 bucket can appear (BEL absent from the scan by design)
    expect(out.sectors.find((s: any) => s.sector === 'DEFENCE')).toBeUndefined();
    // the legacy note text, unchanged
    expect(out.note).toBe('Sector map = TV live snapshot (5-min cache). Context chain = top-down lens. F-Score = trend-quality proxy (disclaimer ke saath). Read-only — koi order nahi.');
    expect(__testables.SECTOR_INDEX.BANKING).toBe('BANKNIFTY');
  });
});
