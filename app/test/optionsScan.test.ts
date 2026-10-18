// ============================================================
// test/optionsScan.test.ts — v10.17 OPTIONS SCANNER
// ------------------------------------------------------------
// Locks the pure core (direction tally, scan score, row mapping,
// verdict honesty) + the scan execution contract (underlying pick,
// bounded-group NSE politeness, 90s cache, single-flight, honest
// per-row degradation + ranking).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the optionsDesk (network) + the universe discovery BEFORE imports.
const mockGetOptionsDesk = vi.fn();
vi.mock('../server/ai/optionsDesk.js', () => ({
  getOptionsDesk: (...args) => mockGetOptionsDesk(...args),
  expiryLabel: (e) => String(e || '').slice(5),
}));
vi.mock('../server/ai/indiaUniverse.js', () => ({
  discoverNSEFullUniverse: async () => ({
    ok: true,
    rows: [
      { symbol: 'RELIANCE', valueTraded: 9e10 }, { symbol: 'HUDCO', valueTraded: 8e10 },
      { symbol: 'TRENT', valueTraded: 7e10 }, { symbol: 'DIXON', valueTraded: 6e10 },
      { symbol: 'ETERNAL', valueTraded: 5e10 }, { symbol: 'IREDA', valueTraded: 4e10 },
      { symbol: 'BEL', valueTraded: 3e10 }, { symbol: 'HAL', valueTraded: 2e10 },
      { symbol: 'ZOMATO', valueTraded: 1e10 }, { symbol: 'VOLTAS', valueTraded: 9e9 },
      { symbol: 'IRFC', valueTraded: 8e9 }, // not in the F&O seed — never picked
    ],
  }),
}));

import {
  pickStockUnderlyings, directionRead, scanScoreOf, optionScanRow, buildVerdict,
  scanOptionsUniverse, __resetOptionsScanForTests,
} from '../server/ai/optionsScan.js';

// A live-NSE desk with a clearly BULLISH chain: puts being written,
// put-heavy PCR, spot above max-pain, spot above gamma flip.
const bullDesk = (over = {}) => ({
  ok: true, symbol: 'NIFTY', spot: 25000, spotChangePct: 0.8, dte: 2,
  expiry: '2026-09-17', lotSize: 75, source: 'nse',
  analytics: {
    pcr: 1.35, maxPain: 24800, atmIV: 12.5, ivPercentile: 40, oiSkew: -0.4,
    callOI: 100, putOI: 135,
    flow: {
      oiLean: -0.3, callPutVolRatio: 0.8,
      read: 'put volume dominates', oiLeanRead: 'puts OI add kar rahe — positioning defensive',
    },
    skew: { value: 1.2, read: 'mild put skew', putIV: 13.1, callIV: 11.9 },
    gex: {
      gammaFlip: 24700, callWall: 25100, putWall: 24500, totalNetGex: 5e9,
      expectedMove: { abs: 210, pct: 0.84, low: 24790, high: 25210, method: 'atm-straddle×0.85' },
      regimeNote: 'Positive net GEX — dealers dampen moves',
    },
  },
  ...over,
});

const bearDesk = () => ({
  ok: true, symbol: 'RELIANCE', spot: 2800, spotChangePct: -1.2, dte: 3,
  expiry: '2026-09-24', lotSize: 250, source: 'nse',
  analytics: {
    pcr: 0.55, maxPain: 2840, atmIV: 22, oiSkew: 0.5,
    callOI: 200, putOI: 110,
    flow: { oiLean: 0.35, callPutVolRatio: 2.1, read: 'call volume dominates', oiLeanRead: 'calls OI add' },
    skew: { value: -0.8, read: 'CALL skew', putIV: 20.5, callIV: 21.3 },
    gex: {
      gammaFlip: 2820, callWall: 2860, putWall: 2740, totalNetGex: -3e9,
      expectedMove: { abs: 60, pct: 2.1, low: 2740, high: 2860, method: 'atm-straddle×0.85' },
      regimeNote: 'Negative net GEX — trend acceleration zone',
    },
  },
});

beforeEach(() => {
  __resetOptionsScanForTests();
  mockGetOptionsDesk.mockReset();
});

// ---------------- pure core ----------------
describe('directionRead — the deterministic tally', () => {
  it('4 bull signals → BULLISH with all four reasons', () => {
    const d = directionRead(bullDesk());
    expect(d.pts).toBe(4);
    expect(d.direction).toBe('BULLISH');
    expect(d.why).toHaveLength(4);
    expect(d.why[0]).toContain('PE writing');
  });

  it('4 bear signals → BEARISH', () => {
    const d = directionRead(bearDesk());
    expect(d.pts).toBe(-4);
    expect(d.direction).toBe('BEARISH');
  });

  it('mixed/absent analytics → NEUTRAL', () => {
    const d = directionRead({ spot: 100, analytics: {} });
    expect(d.pts).toBe(0);
    expect(d.direction).toBe('NEUTRAL');
    expect(d.why).toEqual([]);
  });

  it('synthetic desks (no OI analytics) degrade to max-pain side only', () => {
    const d = directionRead({ spot: 100, analytics: { maxPain: 99 } });
    expect(d.pts).toBe(1); // spot above max-pain is still readable
    expect(d.direction).toBe('NEUTRAL'); // one point is not conviction
  });
});

describe('scanScoreOf — transparent ranking math', () => {
  it('conviction + flow + movement + live-chain bonus', () => {
    const row = optionScanRow(bullDesk(), 'index');
    // 4pts×8=32 + |oiSkew|0.4×25=10 + em 0.84×5=4.2 + nse 5 − dte 0 = 51
    expect(row.scanScore).toBe(51);
  });

  it('model chains carry the honesty penalty (no +5, no OI flow)', () => {
    const row = optionScanRow({ ...bullDesk(), source: 'bs-model' }, 'stock');
    expect(row.source).toBe('bs-model');
    expect(row.synthetic).toBe(true);
    expect(scanScoreOf(row)).toBeLessThan(51);
  });

  it('far expiries drag the score (dte > 8 −5)', () => {
    const near = optionScanRow(bullDesk({ dte: 2 }), 'index');
    const far = optionScanRow(bullDesk({ dte: 15 }), 'index');
    expect(far.scanScore).toBe(near.scanScore - 5);
  });
});

describe('optionScanRow — the row contract', () => {
  it('maps analytics to the scan surface with null-safety', () => {
    const r = optionScanRow(bullDesk(), 'index');
    expect(r).toMatchObject({
      symbol: 'NIFTY', kind: 'index', ok: true, spot: 25000, changePct: 0.8,
      dte: 2, source: 'nse', synthetic: false, lotSize: 75,
      atmIV: 12.5, pcr: 1.35, maxPain: 24800, oiSkew: -0.4,
      gammaFlip: 24700, putWall: 24500, callWall: 25100,
      expectedMovePct: 0.84, expectedMoveBand: { low: 24790, high: 25210 },
      direction: 'BULLISH', directionPts: 4,
    });
    expect(r.verdict).toContain('🟢');
    expect(r.expiryLabel).toBe('09-17');
  });

  it('degrades honestly when the desk failed', () => {
    const r = optionScanRow({ ok: false, symbol: 'X', reason: 'no chain' }, 'stock');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no chain');
    expect(buildVerdict(r)).toBe('no chain');
  });
});

describe('pickStockUnderlyings — turnover-ranked F&O seed intersection', () => {
  it('picks seed members in discovery (turnover) order, capped at n', () => {
    const picked = pickStockUnderlyings(
      [
        { symbol: 'IRFC' }, { symbol: 'RELIANCE' }, { symbol: 'TRENT' },
        { symbol: 'IREDA' }, { symbol: 'DIXON' }, { symbol: 'ETERNAL' },
      ],
      4,
    );
    expect(picked).toEqual(['IRFC', 'RELIANCE', 'TRENT', 'IREDA']);
  });

  it('never picks a non-seed name however liquid', () => {
    expect(pickStockUnderlyings([{ symbol: 'UNITECH' }], 4)).toEqual([]);
  });

  it('dedupes discovery repeats', () => {
    expect(pickStockUnderlyings([{ symbol: 'BEL' }, { symbol: 'BEL' }], 4)).toEqual(['BEL']);
  });
});

// ---------------- scan execution ----------------
describe('scanOptionsUniverse — execution contract', () => {
  it('scans 3 indices + top stock underlyings, ranked by scan score', async () => {
    mockGetOptionsDesk.mockImplementation(async (sym) => {
      if (sym === 'NIFTY') return bullDesk();
      if (sym === 'RELIANCE') return bearDesk();
      return { ok: false, symbol: sym, reason: 'chain unavailable' };
    });
    const view = await scanOptionsUniverse({ force: true });
    expect(view.ok).toBe(true);
    // 3 indices (NIFTY/SENSEX/BANKNIFTY) + 6 stocks (AI_OPTIONS_SCAN_STOCKS default)
    expect(view.scanned).toBe(9);
    // ranked by scan score: the BEAR row (60 = 32 conv + 12.5 flow +
    // 10.5 big-expected-move + 5 live) edges the BULL row (51) —
    // movement potential is part of the ranking by design
    expect(view.rows.map(r => r.symbol)).toEqual(['RELIANCE', 'NIFTY']);
    expect(view.rows[0].direction).toBe('BEARISH');
    expect(view.rows[1].direction).toBe('BULLISH');
    expect(view.failedCount).toBe(7);
    expect(view.failed[0]).toMatchObject({ symbol: 'SENSEX', reason: 'chain unavailable' });
    expect(view.note).toBeNull(); // live rows exist → no model-chain warning
  });

  it('90s cache — a second call serves the cached view without fetching', async () => {
    mockGetOptionsDesk.mockResolvedValue(bullDesk());
    await scanOptionsUniverse({ force: true });
    const calls = mockGetOptionsDesk.mock.calls.length;
    await scanOptionsUniverse(); // cached
    expect(mockGetOptionsDesk.mock.calls.length).toBe(calls);
  });

  it('single-flight — concurrent calls share ONE scan', async () => {
    mockGetOptionsDesk.mockResolvedValue(bullDesk());
    const [a, b] = await Promise.all([
      scanOptionsUniverse({ force: true }),
      scanOptionsUniverse({ force: true }),
    ]);
    expect(a).toBe(b); // same object — one execution
    expect(mockGetOptionsDesk.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it('all-model view (NSE blocked) is honestly labeled', async () => {
    mockGetOptionsDesk.mockResolvedValue({ ...bullDesk(), source: 'bs-model' });
    const view = await scanOptionsUniverse({ force: true });
    expect(view.modelCount).toBe(9);
    expect(view.liveCount).toBe(0);
    expect(view.note).toContain('model-chain');
  });

  it('NSE politeness — underlyings fetched in bounded groups of 4, never a stampede', async () => {
    let inFlight = 0, maxInFlight = 0;
    mockGetOptionsDesk.mockImplementation(async (sym) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return bullDesk({ symbol: sym });
    });
    await scanOptionsUniverse({ force: true });
    expect(maxInFlight).toBeLessThanOrEqual(4); // group size cap
    expect(mockGetOptionsDesk.mock.calls.length).toBe(9);
  });
});
