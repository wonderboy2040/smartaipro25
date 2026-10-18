// ============================================================
// test/indiaUniverse.test.ts — v10.17 FULL UNIVERSE SCAN
// ------------------------------------------------------------
// Locks the tier engine: discovery parsing/validation, honest
// fallback, tier split, rotation slicing, hot promotion/pruning/cap,
// the shared tieredScanUniverse call, the exclude contract (user
// watchlist removals honoured against discovered names) and the
// flag-off legacy parity.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  parseDiscoveryRows, splitTiers, nextSlice, isHot, mergeHot, pruneHot,
  tieredScanUniverse, absorbScanRows, discoverNSEFullUniverse,
  fullIndiaUniverseEnabled, validNSESymbol, INDIA_FULL_FALLBACK_SEED,
  __resetIndiaUniverseForTests, __setDiscoveredForTests,
  __setHotForTests, __hotForTests, __ptrForTests, __setPtrForTests,
} from '../server/ai/indiaUniverse.js';

const BASE = ['RELIANCE', 'HDFCBANK', 'TCS', 'INFY'];

const discoveryRow = (symbol, over = {}) => ({
  symbol, ltp: 100, changePct: 0.5, volume: 1e6, valueTraded: 5e7,
  relVolume: 1.1, marketCap: 1e11, ...over,
});

// TV wire shape: [name, exchange, close, change, volume, value_traded, rel_vol, mcap]
const tvItem = (name, exchange, close, change, vol, val, rel) => ({
  s: `NSE:${name}`, d: [name, exchange, close, change, vol, val, rel, 1e11],
});

beforeEach(() => {
  __resetIndiaUniverseForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_INDIA_FULL_UNIVERSE;
});

// ---------------- parsing / validation ----------------
describe('parseDiscoveryRows — the TV filter-query contract', () => {
  it('maps the wire columns into liquidity rows, NSE-only, turnover-sorted', () => {
    const rows = parseDiscoveryRows([
      tvItem('RELIANCE', 'NSE', 2800, 1.2, 9e6, 2.5e10, 1.4),
      tvItem('DMART', 'NSE', 4200, -0.4, 3e5, 1.2e9, 0.9),
      tvItem('RELIANCE', 'BSE', 2801, 1.2, 9e4, 2.5e8, 1.1), // dup + BSE
    ]);
    expect(rows.map(r => r.symbol)).toEqual(['RELIANCE', 'DMART']);
    expect(rows[0]).toMatchObject({ symbol: 'RELIANCE', ltp: 2800, changePct: 1.2, valueTraded: 2.5e10, relVolume: 1.4 });
  });

  it('drops garbage: non-string names, zero closes, invalid grammar, non-finite numbers', () => {
    const rows = parseDiscoveryRows([
      tvItem('X', 'NSE', 10, 1, 1, 1, 1),           // too short (1 char)
      tvItem('BAD!SYMBOL', 'NSE', 10, 1, 1, 1, 1),  // grammar violation
      tvItem('ZERO', 'NSE', 0, 1, 1, 1, 1),         // dead price
      { s: 'NSE:NOPE', d: null },                    // malformed row
      tvItem('GOOD', 'NSE', 10, 1, 1, 1, 1),
    ]);
    expect(rows.map(r => r.symbol)).toEqual(['GOOD']);
  });

  it('never trusts the wire sort — re-sorts locally by turnover', () => {
    const rows = parseDiscoveryRows([
      tvItem('SMALL', 'NSE', 10, 1, 1, 100, 1),
      tvItem('BIG', 'NSE', 20, 1, 1, 999, 1),
    ]);
    expect(rows[0].symbol).toBe('BIG');
  });
});

describe('validNSESymbol — repo grammar', () => {
  it('accepts M&M / BAJAJ-AUTO style names, rejects junk', () => {
    expect(validNSESymbol('M&M')).toBe(true);
    expect(validNSESymbol('BAJAJ-AUTO')).toBe(true);
    expect(validNSESymbol('bad!name')).toBe(false);
    expect(validNSESymbol('')).toBe(false);
    expect(validNSESymbol(null)).toBe(false);
  });
});

// ---------------- tier split + rotation ----------------
describe('splitTiers — T1 base∪hot every cycle, T2 the discovered rest', () => {
  it('base members never double-seat in T2; discovered names fill T2', () => {
    const { t1, t2, fullCount } = splitTiers(BASE, [discoveryRow('RELIANCE'), discoveryRow('IRFC'), discoveryRow('HUDCO')], []);
    expect(t1).toEqual(BASE);
    expect(t2).toEqual(['IRFC', 'HUDCO']);
    expect(fullCount).toBe(6);
  });

  it('HOT NAMES RIDE T1 — even when the rotation slice would miss them', () => {
    // 200 T2 names, IRFC seeded near the END of the list — no rotation
    // slice starting at ptr=0 reaches it, yet its heat must still be
    // scanned EVERY cycle via T1 (the smoke caught this exact bug:
    // hotSet used to be computed and then silently ignored).
    const bigT2 = Array.from({ length: 200 }, (_, i) => discoveryRow(`X${i}`));
    bigT2.push(discoveryRow('IRFC'));
    const { t1, t2 } = splitTiers(BASE, bigT2, ['IRFC']);
    expect(t1).toEqual([...BASE, 'IRFC']); // hot appended AFTER the base
    expect(t2).not.toContain('IRFC');      // and never double-seated
    // ptr=0 + slice 50 can never reach X200-region names on its own
    const { slice } = nextSlice(t2, 0, 50);
    expect(slice).not.toContain('IRFC');
    expect(t1).toContain('IRFC');          // but T1 carries it every cycle
  });
});

describe('nextSlice — deterministic rotating slices', () => {
  const t2 = Array.from({ length: 20 }, (_, i) => `T${i}`);

  it('takes a contiguous wrap-around slice and advances the pointer', () => {
    const { slice, nextPtr } = nextSlice(t2, 0, 8);
    expect(slice).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
    expect(nextPtr).toBe(8);
  });

  it('wraps around the end of the list', () => {
    const { slice } = nextSlice(t2, 16, 8);
    expect(slice).toEqual(['T16', 'T17', 'T18', 'T19', 'T0', 'T1', 'T2', 'T3']);
  });

  it('empty T2 → empty slice, pointer reset', () => {
    expect(nextSlice([], 5, 8)).toEqual({ slice: [], nextPtr: 0 });
  });

  it('adaptive take: a quarter of T2 per cycle (ceil), never below the floor', () => {
    const big = Array.from({ length: 240 }, (_, i) => `S${i}`);
    const { slice, nextPtr } = nextSlice(big, 0, 50);
    expect(slice.length).toBe(60);   // ceil(240/4) — whole market in ~4 cycles
    expect(nextPtr).toBe(60);
    const small = Array.from({ length: 12 }, (_, i) => `S${i}`);
    expect(nextSlice(small, 0, 50).slice.length).toBe(12); // whole T2 at once
  });
});

// ---------------- hot promotion ----------------
describe('isHot — the heat rule', () => {
  it('|chg| >= 2.5% is heat', () => {
    expect(isHot({ symbol: 'A', changePct: 2.5 })).toBe(true);
    expect(isHot({ symbol: 'A', changePct: -2.6 })).toBe(true);
    expect(isHot({ symbol: 'A', changePct: 2.4 })).toBe(false);
  });
  it('relVolume >= 2 is heat (engine rows use relVolume too)', () => {
    expect(isHot({ symbol: 'A', relVolume: 2 })).toBe(true);
    expect(isHot({ symbol: 'A', relVolume: 1.9 })).toBe(false);
  });
  it('RSI extremes are heat (72+ / 28-)', () => {
    expect(isHot({ symbol: 'A', rsi: 72 })).toBe(true);
    expect(isHot({ symbol: 'A', rsi: 28 })).toBe(true);
    expect(isHot({ symbol: 'A', rsi: 50 })).toBe(false);
  });
  it('engine TV rows (change, not changePct) also qualify', () => {
    expect(isHot({ symbol: 'A', change: 3.1 })).toBe(true);
  });
});

describe('mergeHot — TTL, refresh, cap, fittest-survive', () => {
  it('adds hot rows with a TTL and refreshes existing rides', () => {
    const now = Date.now();
    const hot = mergeHot(new Map(), [{ symbol: 'AAA', changePct: 3 }], now, 20 * 60_000, 15);
    expect(hot.get('AAA')).toBe(now + 20 * 60_000);
    const hot2 = mergeHot(hot, [{ symbol: 'AAA', changePct: 4 }], now + 60_000, 20 * 60_000, 15);
    expect(hot2.get('AAA')).toBe(now + 60_000 + 20 * 60_000); // ride REFRESHED from the new now
  });

  it('cap eviction: over the cap, the earliest-expiring entry is replaced', () => {
    const now = Date.now();
    let hot = new Map([['OLD', now + 1000]]);
    const rows = Array.from({ length: 15 }, (_, i) => ({ symbol: `H${i}`, changePct: 5 }));
    hot = mergeHot(hot, rows, now, 20 * 60_000, 15);
    expect(hot.size).toBe(15);
    expect(hot.has('OLD')).toBe(false);   // earliest TTL evicted
    expect(hot.has('H14')).toBe(true);
  });

  it('pruneHot drops expired entries (Map in — the production state shape)', () => {
    const now = Date.now();
    const pruned = pruneHot(new Map([['AAA', now + 5000], ['BBB', now - 1]]), now);
    expect([...pruned.keys()]).toEqual(['AAA']);
  });
});

// ---------------- discovery (network mocked) ----------------
describe('discoverNSEFullUniverse — single-flight, cache, honest fallback', () => {
  it('parses the TV filter query and caches the result', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [
        tvItem('RELIANCE', 'NSE', 2800, 1, 9e6, 5e10, 1.2),
        tvItem('IRFC', 'NSE', 90, 3.2, 8e6, 4e10, 2.2),
        ...Array.from({ length: 43 }, (_, i) => tvItem(`S${i}`, 'NSE', 10 + i, 1, 1e5, 1e9 - i, 1)),
      ] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await discoverNSEFullUniverse();
    expect(first.ok).toBe(true);
    expect(first.rows.slice(0, 5).map(r => r.symbol)).toEqual(['RELIANCE', 'IRFC', 'S0', 'S1', 'S2']);
    expect(first.rows).toHaveLength(45);
    await discoverNSEFullUniverse(); // cached — no second call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects thin responses (< 40 rows) and falls back to the static seed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [tvItem('ONLYONE', 'NSE', 10, 1, 1, 1, 1)] }),
    })));
    const out = await discoverNSEFullUniverse();
    expect(out.ok).toBe(false);
    expect(out.rows.length).toBe(INDIA_FULL_FALLBACK_SEED.length);
    expect(out.rows[0]).toMatchObject({ ltp: 0, valueTraded: 0 });
  });

  it('network failure → static seed, negative cache holds it (no hammering)', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('scanner down'); });
    vi.stubGlobal('fetch', fetchMock);
    const out = await discoverNSEFullUniverse();
    expect(out.ok).toBe(false);
    expect(out.rows.length).toBe(INDIA_FULL_FALLBACK_SEED.length);
    await discoverNSEFullUniverse();
    expect(fetchMock).toHaveBeenCalledTimes(1); // negative cache checked
  });

  it('the wire filter carries type=stock + exchange NSE + turnover sort', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: Array.from({ length: 50 }, (_, i) => tvItem(`S${i}`, 'NSE', 10, 1, 1, 100 - i, 1)) }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await discoverNSEFullUniverse();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.filter).toEqual([
      { left: 'type', operation: 'equal', right: 'stock' },
      { left: 'exchange', operation: 'in_range', right: ['NSE'] },
    ]);
    expect(body.sort).toEqual({ sortBy: 'value_traded', sortOrder: 'desc' });
    expect(body.range[1]).toBeGreaterThanOrEqual(60);
  });
});

// ---------------- the ONE tiered-universe call ----------------
describe('tieredScanUniverse — the shared scan contract', () => {
  it('returns T1 + one rotating T2 slice and advances the shared pointer', async () => {
    __setDiscoveredForTests([discoveryRow('IRFC'), discoveryRow('HUDCO'), discoveryRow('RVNL'), discoveryRow('NBCC')]);
    __setPtrForTests(0);
    const t = await tieredScanUniverse(BASE);
    expect(t.mode).toBe('tiered-full');
    expect(t.scan.slice(0, 4)).toEqual(BASE);      // T1 first, in base order
    expect(t.t2Count).toBe(4);
    expect(t.sliceCount).toBe(4);                   // whole (small) T2
    expect(__ptrForTests()).toBe(0);                // wrapped
    expect(t.fullCount).toBe(8);
  });

  it('hot symbols ride T1 on the NEXT cycle after absorbScanRows', async () => {
    __setDiscoveredForTests([discoveryRow('IRFC', { changePct: 5 }), discoveryRow('HUDCO')]);
    await tieredScanUniverse(BASE); // IRFC scanned in the T2 slice
    const hot = absorbScanRows([discoveryRow('IRFC', { changePct: 5, relVolume: 2.4 })]);
    expect(hot).toContain('IRFC');
    const t2 = await tieredScanUniverse(BASE);
    expect(t2.hot).toContain('IRFC');
    expect(t2.scan).toContain('IRFC'); // hot name rides T1 cadence now
  });

  it('exclude (user watchlist removals) is honoured against T2 AND hot', async () => {
    // production wiring passes effectiveUniverse() (removals already
    // applied to the base) + exclude=removedBase (belt-and-suspenders
    // against discovered T2 seats + hot rides)
    __setDiscoveredForTests([discoveryRow('IRFC', { changePct: 5 }), discoveryRow('HUDCO')]);
    absorbScanRows([{ symbol: 'IRFC', changePct: 6 }]);
    const t = await tieredScanUniverse(BASE, { exclude: ['IRFC'] });
    expect(t.scan).not.toContain('IRFC');
    expect(t.hot).not.toContain('IRFC');
    expect(t.scan).toContain('HUDCO');
  });

  it('flag OFF → legacy static universe, byte-identical contract', async () => {
    process.env.AI_INDIA_FULL_UNIVERSE = 'off';
    expect(fullIndiaUniverseEnabled()).toBe(false);
    const t = await tieredScanUniverse(BASE);
    expect(t.mode).toBe('legacy-static');
    expect(t.scan).toEqual(BASE);
    expect(t2stats(t)).toEqual({ t1Count: 4, t2Count: 0, sliceCount: 0 });
  });

  it('fallback discovery is honestly labeled (tiered-seed-fallback)', async () => {
    __setDiscoveredForTests(INDIA_FULL_FALLBACK_SEED.slice(0, 100).map(s => discoveryRow(s)), false);
    const t = await tieredScanUniverse(BASE);
    expect(t.mode).toBe('tiered-seed-fallback');
    expect(t.fullCount).toBeGreaterThan(BASE.length);
  });
});

function t2stats(t) {
  return { t1Count: t.t1Count, t2Count: t.t2Count, sliceCount: t.sliceCount };
}

// ---------------- absorbScanRows no-ops when flag off ----------------
describe('absorbScanRows — flag discipline', () => {
  it('does nothing when the feature is OFF', () => {
    process.env.AI_INDIA_FULL_UNIVERSE = 'off';
    const out = absorbScanRows([{ symbol: 'IRFC', changePct: 9 }]);
    expect(out).toEqual([]);
    expect(__hotForTests().size).toBe(0);
  });
});
