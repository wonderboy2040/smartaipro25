// ============================================================
// test/bseOptionChain.test.ts — v11.1 NSE + SENSEX ADDENDUM
// ------------------------------------------------------------
// Locks the SENSEX honesty contract end-to-end:
//   1. fetchBSEOptionChain (REAL module, stubbed fetch): parses a
//      BSE-shaped chain, normalizes expiries, nulls on 403-block and
//      arms the negative cache (the documented datacenter case).
//   2. getOptionsDesk('SENSEX') with a REAL BSE chain → source 'bse',
//      full analytics parity (PCR/max-pain computed from real OI).
//   3. getOptionsDesk('SENSEX') with BSE blocked → the PERMANENT
//      limitation: source 'bs-model-sensex-always' + the persistent
//      banner text + honest null analytics. NIFTY's fallback stays
//      the RECOVERABLE 'bs-model-nifty-fallback' framing. The two
//      model cases can never be visually confused again.
//   4. buildOptionSignalCards: SENSEX model cards carry the STRUCTURAL
//      confidence discount (beyond model-uncertainty handling) and
//      their own source tag; NIFTY model cards carry none.
//   5. optionsScan: 'bse' counts as a LIVE chain (bonus + synthetic
//      flag + live/model classification).
//   6. v21.0.5 — the NIFTY Groww mirror ladder: direct NSE first
//      (richest feed), mirror fallback when NSE blocks (datacenter),
//      10-min direct negative hold, NIFTY-only (BANKNIFTY never
//      touches groww), desk parity via 'nse'+via'groww'.
// Hermetic — no network. All fetches stubbed/mocked.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- data.js: partially mocked (fetchers controllable; the REAL
// module stays importable via importActual for the parse tests) ----
const ctrl = {
  bse: null as any,
  nse: null as any,
  yahoo: {} as any,
};
vi.mock('../server/ai/data.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    fetchBSEOptionChain: vi.fn(async () => ctrl.bse),
    fetchNSEOptionChain: vi.fn(async () => ctrl.nse),
    fetchYahooQuotes: vi.fn(async () => ctrl.yahoo),
  };
});

import { getOptionsDesk, buildOptionSignalCards, buildSyntheticChain, SENSEX_MODEL_BANNER, LOT_SIZES } from '../server/ai/optionsDesk.js';
import { optionScanRow, scanScoreOf } from '../server/ai/optionsScan.js';

const nextThursday = () => {
  const d = new Date();
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((4 - day + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
};

// Phase-0 fix (2026-09-23): the fixtures below used a HARDCODED '2026-09-17'
// expiry — once the IST calendar rolled past it, chain.expiryDates had no
// d >= today row left, getOptionsDesk correctly honest-fell-back to
// 'bs-model-sensex-always', and the parity test failed as a STALE FIXTURE
// (production logic was right). Both fixtures are now SELF-HEALING: the
// expiry is always the next (future) Thursday, computed at run time.
const THU_ISO = nextThursday();
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const THU_DMY = (() => { const [y, m, d] = THU_ISO.split('-'); return `${Number(d)} ${MONS[Number(m) - 1]} ${y}`; })();

// A deep-signal payload like getDeepSignal returns for a LONG consensus.
const mkDeep = (side: string) => ({
  ok: true,
  signal: { symbol: 'SENSEX', side, confidence: 74, grade: 'ACTION', agreement: 0.7 },
});

beforeEach(() => { ctrl.bse = null; ctrl.nse = null; ctrl.yahoo = {}; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ============================================================
// 1. fetchBSEOptionChain — the REAL module with stubbed global fetch
// ============================================================
describe('fetchBSEOptionChain (real module, stubbed fetch)', () => {
  it('parses a BSE-shaped chain (records.data, "DD Mon YYYY" expiries) into the NSE-normalized row shape', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        records: {
          underlyingValue: 82350.5,
          data: [
            { strikePrice: 82000, expiryDate: THU_DMY, CE: { openInterest: 1200, changeinOpenInterest: 80, impliedVolatility: 12.4, lastPrice: 410.2, totalTradedVolume: 9000 }, PE: { openInterest: 3000, changeinOpenInterest: 200, impliedVolatility: 13.1, lastPrice: 85.4, totalTradedVolume: 21000 } },
            { strikePrice: 82100, expiryDate: THU_DMY, CE: { openInterest: 1500, changeinOpenInterest: 90, impliedVolatility: 12.1, lastPrice: 355.1, totalTradedVolume: 8000 }, PE: { openInterest: 2600, changeinOpenInterest: 120, impliedVolatility: 12.8, lastPrice: 120.6, totalTradedVolume: 15000 } },
            { strikePrice: 82200, expiryDate: THU_DMY, CE: { openInterest: 2100, changeinOpenInterest: 110, impliedVolatility: 11.9, lastPrice: 305.0, totalTradedVolume: 12000 }, PE: { openInterest: 1900, changeinOpenInterest: 60, impliedVolatility: 12.5, lastPrice: 170.3, totalTradedVolume: 11000 } },
            { strikePrice: 82300, expiryDate: THU_DMY, CE: { openInterest: 2600, changeinOpenInterest: 130, impliedVolatility: 11.7, lastPrice: 255.4, totalTradedVolume: 14000 }, PE: { openInterest: 1500, changeinOpenInterest: 40, impliedVolatility: 12.2, lastPrice: 230.1, totalTradedVolume: 9000 } },
            { strikePrice: 82400, expiryDate: THU_DMY, CE: { openInterest: 2900, changeinOpenInterest: 150, impliedVolatility: 11.6, lastPrice: 210.9, totalTradedVolume: 16000 }, PE: { openInterest: 1100, changeinOpenInterest: 30, impliedVolatility: 12.0, lastPrice: 295.2, totalTradedVolume: 7000 } },
            { strikePrice: 82500, expiryDate: THU_DMY, CE: { openInterest: 3200, changeinOpenInterest: 170, impliedVolatility: 11.5, lastPrice: 170.2, totalTradedVolume: 18000 }, PE: { openInterest: 900, changeinOpenInterest: 20, impliedVolatility: 11.9, lastPrice: 360.8, totalTradedVolume: 6000 } },
          ],
        },
      }),
    })) as any);
    const out = await real.fetchBSEOptionChain('SENSEX');
    expect(out).toBeTruthy();
    expect(out.source).toBe('bse');
    expect(out.spot).toBeCloseTo(82350.5, 1);
    expect(out.expiryDates).toEqual([THU_ISO]);
    expect(out.rows.length).toBe(6);
    expect(out.rows[0]).toMatchObject({
      strike: 82000, expiry: THU_ISO,
      callOI: 1200, callOIChange: 80, callIV: 12.4, callLTP: 410.2, callVolume: 9000,
      putOI: 3000, putOIChange: 200, putIV: 13.1, putLTP: 85.4, putVolume: 21000,
    });
    void calls;
  });

  it('returns null on the 403 Akamai block and arms the negative cache (no re-probe inside the window)', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    let fetches = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetches++;
      return { ok: false, status: 403, text: async () => 'Access Denied' };
    }) as any);
    expect(await real.fetchBSEOptionChain('SENSEX')).toBeNull();
    expect(fetches).toBeGreaterThanOrEqual(2); // bootstrap + both candidate endpoints attempted
    const { negUntil } = real.__bseNegForTests();
    expect(negUntil).toBeGreaterThan(Date.now());
    // Inside the 10-min hold: NO further upstream traffic.
    const before = fetches;
    expect(await real.fetchBSEOptionChain('SENSEX')).toBeNull();
    expect(fetches).toBe(before);
    real.__resetBseForTests();
  });

  it('only serves the SENSEX index (the single wired BSE underlying)', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    let fetches = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { fetches++; throw new Error('no'); }) as any);
    expect(await real.fetchBSEOptionChain('NIFTY')).toBeNull();
    expect(await real.fetchBSEOptionChain('BANKNIFTY')).toBeNull();
    expect(fetches).toBe(0);
    real.__resetBseForTests();
  });
});

// ============================================================
// 1c. v21.0.4 — GROWW PUBLIC MIRROR (the real SENSEX chain source)
// groww.in server-renders the REAL BSE SENSEX chain into
// <script id="__NEXT_DATA__">. These tests lock the parser + the
// fetch ladder (mirror first, direct BSE second) + the 90s cache.
// ============================================================
const mkGrowwNext = () => ({
  props: { pageProps: { data: {
    company: {
      symbol: 'SENSEX', exchange: 'BSE', searchId: 'sp-bse-sensex',
      liveData: { ltp: 72559.89, close: 71593.24, dayChange: 966.65, dayChangePerc: 1.35 },
    },
    optionChain: {
      optionContracts: [
        { strikePrice: 7240000, ce: { greeks: { iv: 14.2 }, liveData: { ltp: 901.4, oi: 1200, prevOI: 900 } }, pe: { greeks: { iv: 13.9 }, liveData: { ltp: 71.2, oi: 5200, prevOI: 5000 } } },
        { strikePrice: 7250000, ce: { greeks: { iv: 13.5153 }, liveData: { ltp: 585, oi: 35314, prevOI: 16176 } }, pe: { greeks: { iv: 13.8 }, liveData: { ltp: 122.5, oi: 28000, prevOI: 24000 } } },
        { strikePrice: 7260000, ce: { greeks: { iv: 13.1 }, liveData: { ltp: 350.2, oi: 41000, prevOI: 39000 } }, pe: { greeks: { iv: 14.1 }, liveData: { ltp: 190.8, oi: 15000, prevOI: 16000 } } },
        { strikePrice: 7270000, ce: { greeks: { iv: null }, liveData: { ltp: 180.5, oi: 900, prevOI: 950 } }, pe: { greeks: { iv: 14.6 }, liveData: { ltp: 265.3, oi: 700, prevOI: 650 } } },
        { strikePrice: 7280000, ce: { greeks: { iv: 12.9 }, liveData: { ltp: 101.7, oi: 0, prevOI: 0 } }, pe: { greeks: { iv: null }, liveData: { ltp: 401.9, oi: 0, prevOI: 0 } } },
      ],
      aggregatedDetails: {
        currentExpiry: '2026-10-15',
        expiryDates: ['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-26', '2026-12-31'],
        lotSize: 20, freezeQty: 1001, maxOI: 56495,
      },
    },
  } } },
});

describe('v21.0.4 Groww public mirror — parser + ladder', () => {
  it('_growwParseNextData: paise→strike, oi−prevOI→OI-change, null greeks→null IV, ISO expiry list, via=groww', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    const out = real._growwParseNextData(mkGrowwNext());
    expect(out).toBeTruthy();
    expect(out.source).toBe('bse');
    expect(out.via).toBe('groww');
    expect(out.spot).toBeCloseTo(72559.89, 1);
    expect(out.spotChangePct).toBeCloseTo(1.35, 2);
    expect(out.lotSize).toBe(20);
    expect(out.expiryDates).toEqual(['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-26', '2026-12-31']);
    expect(out.rows.length).toBe(5);
    const atm = out.rows.find((r: any) => r.strike === 72500);
    expect(atm).toMatchObject({
      strike: 72500, expiry: '2026-10-15',
      callOI: 35314, callOIChange: 35314 - 16176, callIV: 13.5153, callLTP: 585, callVolume: 0,
      putOI: 28000, putOIChange: 28000 - 24000, putIV: 13.8, putLTP: 122.5, putVolume: 0,
    });
    // null IVs stay null (illiquid greeks) — never coerced to 0
    expect(out.rows.find((r: any) => r.strike === 72700).callIV).toBeNull();
    expect(out.rows.find((r: any) => r.strike === 72800).putIV).toBeNull();
    // v21.0.6 [audit]: REAL OI-unwinding passes through — negative
    // OI-change ab preserve hota hai (direct NSE changeinOpenInterest
    // parity); missing oi/prevOI fields → 0 (fabricated negative nahi).
    expect(out.rows.find((r: any) => r.strike === 72600).putOIChange).toBe(15000 - 16000); // −1000 unwind
    expect(out.rows.find((r: any) => r.strike === 72700).callOIChange).toBe(900 - 950); // −50 unwind
    expect(out.rows.find((r: any) => r.strike === 72800).callOIChange).toBe(0); // oi:0/prevOI:0 → 0, no fabrication
  });

  it('_growwParseNextData: sanity failures return null (no contracts / no expiry / <5 rows)', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    expect(real._growwParseNextData({})).toBeNull();
    expect(real._growwParseNextData({ props: { pageProps: { data: { optionChain: { optionContracts: [], aggregatedDetails: { currentExpiry: '2026-10-15' } } } } } })).toBeNull();
    expect(real._growwParseNextData({ props: { pageProps: { data: { optionChain: { optionContracts: [{ strikePrice: 7250000 }], aggregatedDetails: {} } } } } })).toBeNull();
  });

  it('fetchBSEOptionChain serves the groww mirror FIRST — one fetch, no direct-BSE traffic, source bse + via groww', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    const next = mkGrowwNext();
    const html = '<html><head></head><body><div>app</div><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(next) + '</script></body></html>';
    const fetches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetches.push(String(url));
      return { ok: true, text: async () => html, json: async () => { throw new Error('json should not be called on the mirror path'); } };
    }) as any);
    const out = await real.fetchBSEOptionChain('SENSEX');
    expect(out).toBeTruthy();
    expect(out.source).toBe('bse');
    expect(out.via).toBe('groww');
    expect(fetches.length).toBe(1); // mirror hit ONLY — direct BSE candidates untouched
    expect(fetches[0]).toContain('groww.in/options/sp-bse-sensex');
    // within the 90s TTL: no re-fetch
    const before = fetches.length;
    const again = await real.fetchBSEOptionChain('SENSEX');
    expect(again).toBeTruthy();
    expect(fetches.length).toBe(before);
    real.__resetBseForTests();
  });

  it('mirror down → direct BSE candidates still get their turn (ladder order)', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    const fetches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      fetches.push(u);
      if (u.includes('groww.in')) return { ok: false, status: 503, text: async () => 'unavailable' };
      // direct BSE candidate returns a parseable chain
      return {
        ok: true,
        headers: { getSetCookie: () => [] },
        text: async () => '',
        json: async () => ({ records: { underlyingValue: 82350.5, data: [
          { strikePrice: 82000, expiryDate: '17 Oct 2026', CE: { openInterest: 1200, changeinOpenInterest: 80, impliedVolatility: 12.4, lastPrice: 410.2, totalTradedVolume: 9000 }, PE: { openInterest: 3000, changeinOpenInterest: 200, impliedVolatility: 13.1, lastPrice: 85.4, totalTradedVolume: 21000 } },
          { strikePrice: 82100, expiryDate: '17 Oct 2026', CE: { openInterest: 1500, impliedVolatility: 12.1, lastPrice: 355.1, totalTradedVolume: 8000 }, PE: { openInterest: 2600, impliedVolatility: 12.8, lastPrice: 120.6, totalTradedVolume: 15000 } },
          { strikePrice: 82200, expiryDate: '17 Oct 2026', CE: { openInterest: 2100, impliedVolatility: 11.9, lastPrice: 305.0, totalTradedVolume: 12000 }, PE: { openInterest: 1900, impliedVolatility: 12.5, lastPrice: 170.3, totalTradedVolume: 11000 } },
          { strikePrice: 82300, expiryDate: '17 Oct 2026', CE: { openInterest: 2600, impliedVolatility: 11.7, lastPrice: 255.4, totalTradedVolume: 14000 }, PE: { openInterest: 1500, impliedVolatility: 12.2, lastPrice: 230.1, totalTradedVolume: 9000 } },
          { strikePrice: 82400, expiryDate: '17 Oct 2026', CE: { openInterest: 2900, impliedVolatility: 11.6, lastPrice: 210.9, totalTradedVolume: 16000 }, PE: { openInterest: 1100, impliedVolatility: 12.0, lastPrice: 295.2, totalTradedVolume: 7000 } },
          { strikePrice: 82500, expiryDate: '17 Oct 2026', CE: { openInterest: 3200, impliedVolatility: 11.5, lastPrice: 170.2, totalTradedVolume: 18000 }, PE: { openInterest: 900, impliedVolatility: 11.9, lastPrice: 360.8, totalTradedVolume: 6000 } },
        ] } }),
      };
    }) as any);
    const out = await real.fetchBSEOptionChain('SENSEX');
    expect(out).toBeTruthy();
    expect(out.source).toBe('bse');
    expect(out.via).toBeUndefined(); // direct path — no mirror marker
    expect(fetches.some((u: string) => u.includes('groww.in'))).toBe(true);   // mirror tried first
    expect(fetches.some((u: string) => u.includes('bseindia.com'))).toBe(true); // then direct
    real.__resetBseForTests();
  });
});

// ============================================================
// 1d. v21.0.5 — NIFTY GROWW MIRROR LADDER (fetchNSEOptionChain)
// Direct NSE serves the richest feed when reachable; when NSE blocks
// the host (datacenter / bot-detection), the ladder falls to groww.in's
// public NIFTY page (the same verified relay that fixed SENSEX in
// v21.0.4). A 10-min negative hold keeps the dead direct probe nearly
// free. NIFTY alone — BANKNIFTY-family groww pages are client-side
// rendered (ssrError=true, no chain in HTML).
// ============================================================
const mkGrowwNiftyNext = () => ({
  props: { pageProps: { data: {
    company: {
      symbol: 'NIFTY', exchange: 'NSE', searchId: 'nifty',
      liveData: { ltp: 22520.45, close: 22231.8, dayChange: 288.65, dayChangePerc: 1.2983654045106625 },
    },
    optionChain: {
      optionContracts: [
        { strikePrice: 2240000, ce: { greeks: { iv: 13.9 }, liveData: { ltp: 341.7, oi: 21000, prevOI: 19000 } }, pe: { greeks: { iv: 14.3 }, liveData: { ltp: 122.5, oi: 17500, prevOI: 16000 } } },
        { strikePrice: 2245000, ce: { greeks: { iv: 13.2 }, liveData: { ltp: 285.4, oi: 33500, prevOI: 29000 } }, pe: { greeks: { iv: 14.0 }, liveData: { ltp: 165.9, oi: 22000, prevOI: 21000 } } },
        { strikePrice: 2250000, ce: { greeks: { iv: 12.8 }, liveData: { ltp: 236.9, oi: 48000, prevOI: 41000 } }, pe: { greeks: { iv: 13.7 }, liveData: { ltp: 217.3, oi: 29500, prevOI: 28500 } } },
        { strikePrice: 2255000, ce: { greeks: { iv: 12.4 }, liveData: { ltp: 192.1, oi: 52000, prevOI: 47500 } }, pe: { greeks: { iv: 13.4 }, liveData: { ltp: 272.4, oi: 36800, prevOI: 33200 } } },
        { strikePrice: 2260000, ce: { greeks: { iv: 12.1 }, liveData: { ltp: 152.8, oi: 44900, prevOI: 39800 } }, pe: { greeks: { iv: 13.1 }, liveData: { ltp: 333.0, oi: 25100, prevOI: 22800 } } },
        { strikePrice: 2265000, ce: { greeks: { iv: 11.9 }, liveData: { ltp: 118.6, oi: 30200, prevOI: 27600 } }, pe: { greeks: { iv: 12.9 }, liveData: { ltp: 398.7, oi: 18900, prevOI: 17400 } } },
      ],
      aggregatedDetails: {
        currentExpiry: '2026-10-13',
        expiryDates: ['2026-10-13', '2026-10-19', '2026-10-27', '2026-11-03'],
        lotSize: 65, freezeQty: 3511, maxOI: 223649,
      },
    },
  } } },
});

const growwNiftyHtml = () => '<html><body><div>app</div><script id="__NEXT_DATA__" type="application/json" nonce="x" crossorigin="anonymous">' + JSON.stringify(mkGrowwNiftyNext()) + '</script></body></html>';

describe('v21.0.5 NIFTY Groww mirror ladder — fetchNSEOptionChain', () => {
  afterEach(async () => {
    // the direct-NSE negative hold is module-global — never leak it
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
  });

  it('_growwParseNextData meta: NIFTY → source nse, via groww, spot from company.liveData, lotSize from payload', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    const out = real._growwParseNextData(mkGrowwNiftyNext(), { symbol: 'NIFTY', source: 'nse' });
    expect(out).toBeTruthy();
    expect(out.symbol).toBe('NIFTY');
    expect(out.source).toBe('nse');
    expect(out.via).toBe('groww');
    expect(out.spot).toBeCloseTo(22520.45, 1);
    expect(out.spotChangePct).toBeCloseTo(1.3, 1);
    expect(out.lotSize).toBe(65);
    expect(out.expiryDates).toEqual(['2026-10-13', '2026-10-19', '2026-10-27', '2026-11-03']);
    const atm = out.rows.find((r: any) => r.strike === 22500);
    expect(atm).toMatchObject({
      strike: 22500, expiry: '2026-10-13',
      callOI: 48000, callOIChange: 48000 - 41000, callIV: 12.8, callLTP: 236.9, callVolume: 0,
      putOI: 29500, putOIChange: 29500 - 28500, putIV: 13.7, putLTP: 217.3, putVolume: 0,
    });
  });

  it('direct NSE 403-block → the groww NIFTY mirror serves the REAL chain (source nse + via groww) and the direct leg arms its 10-min hold', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    const fetches: string[] = [];
    const html = growwNiftyHtml();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      fetches.push(u);
      if (u.includes('groww.in')) return { ok: true, text: async () => html };
      return { ok: false, status: 403, text: async () => 'Access Denied' }; // NSE blocks
    }) as any);
    const out = await real.fetchNSEOptionChain('NIFTY');
    expect(out).toBeTruthy();
    expect(out.source).toBe('nse');
    expect(out.via).toBe('groww');
    expect(out.spot).toBeCloseTo(22520.45, 1);
    expect(fetches.some((u: string) => u.includes('nseindia.com'))).toBe(true);   // direct tried first
    expect(fetches.some((u: string) => u.includes('groww.in/options/nifty'))).toBe(true); // mirror fallback
    // the direct negative hold is armed — inside it, NO further NSE traffic
    expect(real.__nseNegForTests().directNegUntil).toBeGreaterThan(Date.now());
    const nseBefore = fetches.filter((u: string) => u.includes('nseindia.com')).length;
    const allBefore = fetches.length;
    const again = await real.fetchNSEOptionChain('NIFTY');
    expect(again).toBeTruthy();
    expect(again.via).toBe('groww');
    expect(fetches.filter((u: string) => u.includes('nseindia.com')).length).toBe(nseBefore); // hold = skip
    expect(fetches.length).toBe(allBefore); // 90s mirror cache = zero re-fetch
    real.__resetBseForTests();
  });

  it('direct NSE SUCCESS serves the richest feed — groww is never touched', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    const TUE = (() => { const d = new Date(); const day = d.getUTCDay(); d.setUTCDate(d.getUTCDate() + ((2 - day + 7) % 7 || 7)); return d.toISOString().slice(0, 10); })();
    const fetches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetches.push(String(url));
      return {
        ok: true,
        json: async () => ({ records: { underlyingValue: 22520.45, expiryDates: [TUE], data: [
          { strikePrice: 22500, expiryDate: TUE, CE: { openInterest: 48000, changeinOpenInterest: 7000, impliedVolatility: 12.8, lastPrice: 236.9, totalTradedVolume: 510000 }, PE: { openInterest: 29500, changeinOpenInterest: 1000, impliedVolatility: 13.7, lastPrice: 217.3, totalTradedVolume: 320000 } },
          { strikePrice: 22550, expiryDate: TUE, CE: { openInterest: 52000, changeinOpenInterest: 4500, impliedVolatility: 12.4, lastPrice: 192.1, totalTradedVolume: 480000 }, PE: { openInterest: 36800, changeinOpenInterest: 3600, impliedVolatility: 13.4, lastPrice: 272.4, totalTradedVolume: 290000 } },
        ] } }),
      };
    }) as any);
    const out = await real.fetchNSEOptionChain('NIFTY');
    expect(out).toBeTruthy();
    expect(out.source).toBe('nse');
    expect(out.via).toBeUndefined(); // direct — no mirror marker
    expect(out.rows[0].callVolume).toBe(510000); // volume rides the direct feed
    expect(fetches.some((u: string) => u.includes('groww.in'))).toBe(false);
    expect(real.__nseNegForTests().directNegUntil).toBe(0); // success never arms the hold
    real.__resetBseForTests();
  });

  it('BANKNIFTY (and the rest of the family) never touch the groww mirror — honest null when direct NSE blocks', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    real.__resetBseForTests();
    const fetches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetches.push(String(url));
      return { ok: false, status: 403, text: async () => 'Access Denied' };
    }) as any);
    expect(await real.fetchNSEOptionChain('BANKNIFTY')).toBeNull();
    expect(fetches.some((u: string) => u.includes('groww.in'))).toBe(false);
    real.__resetBseForTests();
  });

  it('getOptionsDesk NIFTY with the mirror chain → full parity: source nse + sourceVia groww + real-OI analytics', async () => {
    const TUE = (() => { const d = new Date(); const day = d.getUTCDay(); d.setUTCDate(d.getUTCDate() + ((2 - day + 7) % 7 || 7)); return d.toISOString().slice(0, 10); })();
    ctrl.nse = {
      symbol: 'NIFTY', spot: 22520, expiryDates: [TUE], source: 'nse', via: 'groww', lotSize: 65, fetchedAt: Date.now(),
      rows: Array.from({ length: 13 }, (_, i) => ({
        strike: 22500 + (i - 6) * 50, expiry: TUE,
        callOI: 40000 - i * 500, callOIChange: 600, callIV: 12.5, callLTP: Math.max(5, 240 - Math.abs(i - 6) * 38), callVolume: 0,
        putOI: 30000 + i * 500, putOIChange: 400, putIV: 13.2, putLTP: Math.max(5, 210 - Math.abs(i - 6) * 34), putVolume: 0,
      })),
    };
    ctrl.yahoo = { NIFTY: { price: 22525, changePct: 1.2 }, INDIAVIX: { price: 13.1 } };
    const d = await getOptionsDesk('NIFTY');
    expect(d.ok).toBe(true);
    expect(d.source).toBe('nse');
    expect((d as any).sourceVia).toBe('groww'); // the chip can say “LIVE NSE CHAIN · GROWW”
    expect(d.analytics).toBeTruthy();
    expect(d.analytics!.pcr).toBeGreaterThan(0);
    expect(d.syntheticNote).toBeNull();
    expect(d.lotSize).toBe(65); // relay payload wins
  });
});

// ============================================================
// 1b. fetchNSEOptionChain — v21.0.3 EXPIRY NORMALIZATION
// (the "options desk accurate nahi dikh raha" root cause)
// Live NSE returns expiryDates/rows in DD-Mmm-YYYY ("13-Oct-2026").
// Before v21.0.3 those raw strings flowed into an all-ISO pipeline:
// lexicographic '13-Oct-2026' >= '2026-10-09' picked a far monthly
// expiry (or silently fell back to the BS-model chain), Greeks/GEX/DTE
// went zero/null, and paper trades carrying the raw expiry were
// server-rejected on the ISO regex. This locks the source normalization.
// ============================================================
describe('fetchNSEOptionChain (real module, stubbed fetch) — v21.0.3 expiry ISO normalization', () => {
  const mkDmy = (iso: string) => {
    const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const [y, m, d] = iso.split('-');
    return `${Number(d)}-${MONS[Number(m) - 1]}-${y}`;
  };

  const nextTue = () => {
    const d = new Date();
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + ((2 - day + 7) % 7 || 7));
    return d.toISOString().slice(0, 10);
  };
  const TUE_ISO = nextTue();

  it('normalizes DD-Mmm-YYYY expiryDates AND per-row expiries to ISO YYYY-MM-DD', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        records: {
          underlyingValue: 25980.4,
          expiryDates: [mkDmy(TUE_ISO), mkDmy('2027-01-26')],
          data: [
            { strikePrice: 25950, expiryDate: mkDmy(TUE_ISO), CE: { openInterest: 1100, changeinOpenInterest: 60, impliedVolatility: 12.2, lastPrice: 181.4, totalTradedVolume: 8000 }, PE: { openInterest: 1400, changeinOpenInterest: 90, impliedVolatility: 12.9, lastPrice: 122.7, totalTradedVolume: 9000 } },
            { strikePrice: 26000, expiryDate: mkDmy(TUE_ISO), CE: { openInterest: 2600, changeinOpenInterest: 140, impliedVolatility: 11.8, lastPrice: 141.9, totalTradedVolume: 15000 }, PE: { openInterest: 2100, changeinOpenInterest: 110, impliedVolatility: 12.4, lastPrice: 173.2, totalTradedVolume: 12000 } },
          ],
        },
      }),
    })) as any);
    const out = await real.fetchNSEOptionChain('NIFTY');
    expect(out).toBeTruthy();
    expect(out.source).toBe('nse');
    // the WHOLE contract is ISO now — this is what the desk filter, the
    // BS Greeks, daysToExpiry/GEX and openPaperTrade's ISO validation
    // all assume.
    expect(out.expiryDates).toEqual([TUE_ISO, '2027-01-26']);
    expect(out.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.expiry))).toBe(true);
    expect(out.rows[0].expiry).toBe(TUE_ISO);
  });

  it('drops unparseable expiryDates from the list (rows keep raw fallback)', async () => {
    const real: any = await vi.importActual('../server/ai/data.js');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        records: {
          underlyingValue: 25980.4,
          expiryDates: ['garbage-date', mkDmy(TUE_ISO)],
          data: [
            { strikePrice: 26000, expiryDate: mkDmy(TUE_ISO), CE: { openInterest: 100, impliedVolatility: 12, lastPrice: 140, totalTradedVolume: 100 }, PE: { openInterest: 120, impliedVolatility: 12.4, lastPrice: 170, totalTradedVolume: 200 } },
          ],
        },
      }),
    })) as any);
    const out = await real.fetchNSEOptionChain('NIFTY');
    expect(out.expiryDates).toEqual([TUE_ISO]); // garbage dropped
  });
});

// ============================================================
// 2/3. getOptionsDesk — SENSEX full-parity vs the honest fallback
// ============================================================
describe('getOptionsDesk — SENSEX source honesty', () => {
  const bseChain = () => ({
    symbol: 'SENSEX', spot: 82350, expiryDates: [THU_ISO],
    source: 'bse', fetchedAt: Date.now(),
    rows: Array.from({ length: 13 }, (_, i) => {
      const strike = 82300 + (i - 6) * 100;
      return {
        strike, expiry: THU_ISO,
        callOI: 2000 - i * 50, callOIChange: 60, callIV: 12, callLTP: Math.max(5, 300 - Math.abs(i - 6) * 45), callVolume: 9000,
        putOI: 1500 + i * 50, putOIChange: 40, putIV: 12.5, putLTP: Math.max(5, 180 - Math.abs(i - 6) * 30), putVolume: 7000,
      };
    }),
  });

  it('a REAL BSE chain gets full parity: source "bse" + real-OI analytics (PCR computed)', async () => {
    ctrl.bse = { ...bseChain(), via: 'groww' };
    ctrl.yahoo = { SENSEX: { price: 82355, changePct: 0.4 }, INDIAVIX: { price: 12.9 } };
    const d = await getOptionsDesk('SENSEX');
    expect(d.ok).toBe(true);
    expect(d.source).toBe('bse');
    expect((d as any).sourceVia).toBe('groww'); // v21.0.4: relay identified
    expect(d.analytics).toBeTruthy();
    expect(d.analytics!.pcr).toBeGreaterThan(0);
    expect(d.analytics!.maxPain).toBeGreaterThan(0);
    expect(d.syntheticNote).toBeNull();
  });

  it('BSE blocked → the honest model fallback: "bs-model-sensex-always" + the exact banner text + honest null analytics', async () => {
    ctrl.bse = null; // both live paths unreachable (the rare v21.0.4 case)
    ctrl.yahoo = { SENSEX: { price: 82355, changePct: 0.4 }, INDIAVIX: { price: 12.9 } };
    const d = await getOptionsDesk('SENSEX');
    expect(d.ok).toBe(true);
    expect(d.source).toBe('bs-model-sensex-always');
    expect(d.syntheticNote).toBeTruthy();
    // v21.0.4 banner: BOTH live paths (direct BSE + Groww mirror) named,
    // auto-retry promised, broker cross-check advised.
    expect(d.syntheticNote).toContain('SENSEX premiums are model-estimated — live BSE quotes (direct + Groww public mirror) are unreachable from this server right now; auto-retry chalu rehta hai.');
    expect(d.syntheticNote).toContain('cross-check your broker');
    expect(d.analytics).toBeNull(); // honest: no real OI → no PCR/max-pain
    expect((d as any).rows.length).toBeGreaterThan(0);
  });

  it('NIFTY with NSE blocked stays the RECOVERABLE framing: "bs-model-nifty-fallback" + "temporarily unreachable" (v21.0.5: dono live paths named)', async () => {
    ctrl.nse = null;
    ctrl.yahoo = { NIFTY: { price: 23400, changePct: -0.2 }, INDIAVIX: { price: 13.4 } };
    const d = await getOptionsDesk('NIFTY');
    expect(d.ok).toBe(true);
    expect(d.source).toBe('bs-model-nifty-fallback');
    expect(d.syntheticNote).toContain('temporarily unreachable');
    expect(d.syntheticNote!.startsWith('NSE chain')).toBe(true);
    // v21.0.5 banner names BOTH live paths (direct + Groww mirror) + the auto-retry promise
    expect(d.syntheticNote).toContain('direct NSE + Groww public mirror');
    expect(d.syntheticNote).toContain('auto-retry');
  });

  it('buildSyntheticChain default keeps the legacy "bs-model" tag (back-compat), and honours an explicit source tag', () => {
    const exp = nextThursday();
    const legacy = buildSyntheticChain('SENSEX', 82000, 0.13, exp, 5);
    expect(legacy!.source).toBe('bs-model');
    const tagged = buildSyntheticChain('SENSEX', 82000, 0.13, exp, 5, 'bs-model-sensex-always');
    expect(tagged!.source).toBe('bs-model-sensex-always');
  });
});

// ============================================================
// 4. buildOptionSignalCards — the STRUCTURAL confidence discount
// ============================================================
describe('buildOptionSignalCards — SENSEX structural discount', () => {
  const mkDesk = (symbol: string, source: string) => {
    const exp = nextThursday();
    return {
      ok: true, symbol, spot: symbol === 'SENSEX' ? 82000 : 23400, expiry: exp, dte: 4,
      lotSize: LOT_SIZES[symbol] || 1, source, syntheticNote: 'model chain',
      rows: buildSyntheticChain(symbol, symbol === 'SENSEX' ? 82000 : 23400, 0.13, exp, 8)!.rows,
    } as any;
  };

  it('SENSEX model cards lose the structural discount points vs an identical NIFTY model card', () => {
    const niftyCards = buildOptionSignalCards(mkDesk('NIFTY', 'bs-model-nifty-fallback'), mkDeep('LONG'));
    const sensexCards = buildOptionSignalCards(mkDesk('SENSEX', 'bs-model-sensex-always'), mkDeep('LONG'));
    expect(niftyCards.length).toBeGreaterThan(0);
    expect(sensexCards.length).toBeGreaterThan(0);
    const n = niftyCards.find((c: any) => c.strikeBias === 'ATM');
    const s = sensexCards.find((c: any) => c.strikeBias === 'ATM');
    expect(s!.source).toBe('bs-model-sensex-always');
    expect(s!.structuralDiscount).toBe(8);            // default AI_SENSEX_MODEL_DISCOUNT
    expect(s!.aiScoreRaw).toBe(n!.aiScore);           // same raw blend (IV/lot differ only in scale)
    expect(s!.aiScore).toBe(Math.max(0, n!.aiScore - 8));
    expect(String(s!.machineNote)).toContain('SENSEX model-only');
    expect(n!.structuralDiscount).toBeUndefined();    // NIFTY's model mode is recoverable — no haircut
    expect(n!.aiScoreRaw).toBeUndefined();
  });

  it('a LIVE BSE desk produces cards with NO structural discount (parity restored)', () => {
    const cards = buildOptionSignalCards(mkDesk('SENSEX', 'bse'), mkDeep('LONG'));
    const atm = cards.find((c: any) => c.strikeBias === 'ATM');
    expect(atm!.source).toBe('bse');
    expect(atm!.structuralDiscount).toBeUndefined();
  });
});

// ============================================================
// 5. optionsScan — 'bse' is a LIVE chain
// ============================================================
describe('optionsScan — BSE live parity', () => {
  it('counts the bse chain as live: +5 score bonus, synthetic=false, live classification', () => {
    expect(scanScoreOf({ source: 'bse', directionPts: 0 } as any)).toBe(5);
    expect(scanScoreOf({ source: 'nse', directionPts: 0 } as any)).toBe(5);
    expect(scanScoreOf({ source: 'bs-model-sensex-always', directionPts: 0 } as any)).toBe(0);
    const desk: any = { ok: true, symbol: 'SENSEX', spot: 82000, source: 'bse', analytics: {}, dte: 2, expiry: nextThursday() };
    const row = optionScanRow(desk, 'index');
    expect(row.source).toBe('bse');
    expect(row.synthetic).toBe(false);
    const modelDesk: any = { ok: true, symbol: 'SENSEX', spot: 82000, source: 'bs-model-sensex-always', analytics: {}, dte: 2, expiry: nextThursday() };
    expect(optionScanRow(modelDesk, 'index').synthetic).toBe(true);
  });
});
