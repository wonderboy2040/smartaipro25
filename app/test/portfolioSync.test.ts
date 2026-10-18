// ============================================================
// test/portfolioSync.test.ts — INDMoney → asset table pipeline
// Covers: symbols resolution (Groww/US/crypto), holdings→assets
// mapping (INR/USD conversion, noLive NAV assets), the 2×-daily
// scheduler math (IST slots, catch-up window), and the mocked
// end-to-end syncNow (OAuth → MCP → resolve → snapshot file).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// v20.3: hermetic — the settings/durable/portfolioSync suites used to
// read/write the DEV's live server/data directly (the exact pollution
// that shipped inside the v20.2 zip). Ride the shared temp dir the test
// setup assigns (SMARTAI_DATA_DIR) so the module and the test agree.
const DATA = process.env.SMARTAI_DATA_DIR || path.join(__dirname, '..', 'server', 'data');
const SNAP_PATH = path.join(DATA, 'mcp-portfolio.json');
const SYM_CACHE_PATH = path.join(DATA, 'mcp-symbol-cache.json');
const STORE_PATH = path.join(DATA, 'mcp-indmoney.json');

const symbolsMod = await import('../server/mcp/symbols.js');
const syncMod = await import('../server/mcp/portfolioSync.js');
const indm = await import('../server/mcp/indmoney.js');

const {
  pickGrowwMatch, classifyHolding, resolveCryptoSymbol, resolveUsSymbol,
  resolveIndSymbol, __setFetchForTests, __resetSymbolCacheForTests,
} = symbolsMod;
const {
  mapHoldingsToAssets, parseSlots, slotTsToday, computeDueSlots, nextSlotTs,
  syncNow, getAssetsSnapshot, syncInfo, clearSnapshot, maybeBackgroundSync,
  netWorthSnapshot,
  __resetSyncForTests, __stopSchedulerForTests, istParts,
} = syncMod;

const RATE_URL = 'https://open.er-api.com/v6/latest/USD';

// ---------------- helpers ----------------
function jsonRes(json, init = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: new Map(Object.entries(init.headers || {})),
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
    json: async () => (typeof json === 'string' ? JSON.parse(json) : json),
  };
}
function groww(items) { return jsonRes({ content: items }); }

function growwItem(title, symbol, entity_type = 'ETF') {
  return { title, entity_type, nse_scrip_code: symbol, company_short_name: symbol, isin: null };
}

beforeEach(() => {
  indm.__resetForTests();
  __resetSyncForTests();
  __resetSymbolCacheForTests();
  __stopSchedulerForTests();
  try { fs.rmSync(SNAP_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(SYM_CACHE_PATH, { force: true }); } catch { /* ignore */ }
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setFetchForTests(null);
  try { fs.rmSync(SNAP_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(SYM_CACHE_PATH, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(STORE_PATH, { force: true }); } catch { /* ignore */ }
});

// ============================================================
// symbols.js — Groww (India) resolution
// ============================================================
describe('pickGrowwMatch (India NSE symbol from Groww search)', () => {
  it('exact title match wins', () => {
    const m = pickGrowwMatch('Motilal Oswal Nifty 500 Momentum 50 ETF', [
      growwItem('Motilal Oswal Nifty 500 Momentum 50 ETF', 'MOMENTUM50'),
      growwItem('Some Other ETF', 'OTHER'),
    ]);
    expect(m).toEqual({ symbol: 'MOMENTUM50', exact: true });
  });

  it('fuzzy: ≥3 shared significant words resolves (case-insensitive)', () => {
    const m = pickGrowwMatch('Nippon India ETF Nifty Midcap 150', [
      growwItem('Nippon India ETF Nifty Midcap 150', 'MID150BEES'),
    ]);
    expect(m.symbol).toBe('MID150BEES');
    expect(m.exact).toBe(true);
  });

  it('mutual-fund Schemes never resolve to an NSE symbol (NAV-priced)', () => {
    const m = pickGrowwMatch('HDFC Flexi Cap Fund', [
      growwItem('HDFC Flexi Cap Fund', 'HDFCFLEXI', 'Scheme'),
    ]);
    expect(m).toBeNull();
  });

  it('Futures / Options / Option chains are excluded', () => {
    const m = pickGrowwMatch('RELIANCE', [
      { title: 'RELIANCE 29 Sep Fut', entity_type: 'Future', nse_scrip_code: 'RELIANCE' },
      { title: 'RELIANCE option chain', entity_type: 'OPTION_CHAIN', symbol: 'RELIANCE' },
    ]);
    expect(m).toBeNull();
  });

  it('rights entitlements (…-RE) are excluded', () => {
    const m = pickGrowwMatch('Reliance Industries', [
      growwItem('Reliance Industries Ltd. - (Rights Entitlements (REs))', 'RIL-RE', 'Stocks'),
      growwItem('Reliance Industries Ltd.', 'RELIANCE', 'Stocks'),
    ]);
    expect(m.symbol).toBe('RELIANCE');
  });
});

describe('resolveIndSymbol (network + cache)', () => {
  it('resolves via Groww and caches the result (second call makes no request)', async () => {
    let hits = 0;
    __setFetchForTests(async () => { hits++; return groww([growwItem('Motilal Oswal Nifty 500 Momentum 50 ETF', 'MOMENTUM50')]); });
    expect(await resolveIndSymbol('Motilal Oswal Nifty 500 Momentum 50 ETF')).toBe('MOMENTUM50');
    expect(hits).toBe(1);
    expect(await resolveIndSymbol('Motilal Oswal Nifty 500 Momentum 50 ETF')).toBe('MOMENTUM50');
    expect(hits).toBe(1); // served from cache
  });

  it('unresolvable names are negative-cached (no retry storm)', async () => {
    let hits = 0;
    __setFetchForTests(async () => { hits++; return groww([]); });
    expect(await resolveIndSymbol('Totally Unknown Fund Xyz')).toBeNull();
    expect(await resolveIndSymbol('Totally Unknown Fund Xyz')).toBeNull();
    expect(hits).toBe(1);
  });
});

// ============================================================
// symbols.js — crypto + US + classification
// ============================================================
describe('resolveCryptoSymbol', () => {
  it('resolves by name, by symbol, and with parenthesised ticker', () => {
    expect(resolveCryptoSymbol('Bitcoin', null)).toBe('BTC');
    expect(resolveCryptoSymbol('Ethereum', 'ETH')).toBe('ETH');
    expect(resolveCryptoSymbol('Solana (SOL)', null)).toBe('SOL');
    expect(resolveCryptoSymbol('Some Token', null)).toBeNull();
  });
});

describe('resolveUsSymbol (v2 verified engine)', () => {
  // The v2 engine verifies every candidate with a real Yahoo chart quote
  // before accepting it, so the mocks must serve that endpoint.
  const yahooOk = (sym) => jsonRes({ chart: { result: [{ meta: { regularMarketPrice: 100 + sym.length } }] } });

  it('uses a payload ticker when it verifies on Yahoo', async () => {
    const tried = [];
    __setFetchForTests(async (url) => {
      tried.push(String(url));
      if (String(url).includes('query1.finance.yahoo.com/v8/finance/chart/AAPL')) return yahooOk('AAPL');
      throw new Error('unexpected url');
    });
    expect(await resolveUsSymbol('Apple Inc.', 'AAPL')).toBe('AAPL');
    expect(tried.some(u => u.includes('/chart/AAPL'))).toBe(true); // verification happened
  });

  it('keeps a high-confidence candidate when Yahoo itself is unreachable', async () => {
    __setFetchForTests(async () => { throw new Error('network down'); });
    // Yahoo blip → tentative keep (old behaviour preserved, never a silent NAV row)
    expect(await resolveUsSymbol('Apple Inc.', 'AAPL')).toBe('AAPL');
    expect(await resolveUsSymbol('Apple Inc.', null)).toBe('AAPL'); // static map, tentative
  });

  it('rejects a company short-name masquerading as a ticker (the SPCX bug)', async () => {
    // INDMoney sent the company short-name "SPACEX" in the symbol field.
    // Old engine: accepted it → LIVE row that never quotes. v2: 404 from
    // Yahoo → fall to the Yahoo search tier → real ticker SPCX.
    __setFetchForTests(async (url) => {
      const u = String(url);
      if (u.includes('/v8/finance/chart/SPACEX')) return jsonRes({ chart: { result: [] } }, { status: 404 });
      if (u.includes('/v1/finance/search')) {
        return jsonRes({ quotes: [{ symbol: 'SPCX', shortname: 'Space Exploration Technologies', quoteType: 'EQUITY', exchange: 'NMS' }] });
      }
      if (u.includes('/v8/finance/chart/SPCX')) return jsonRes({ chart: { result: [{ meta: { regularMarketPrice: 140.5 } }] } });
      throw new Error(`unexpected url ${u}`);
    });
    expect(await resolveUsSymbol('SpaceX', 'SPACEX')).toBe('SPCX');
  });

  it('resolves comma-drifted names via Yahoo search (the MU bug)', async () => {
    // TV's description is "Micron Technology, Inc." — the description-EQUAL
    // filter never matched "Micron Technology Inc.". Yahoo search does.
    __setFetchForTests(async (url) => {
      const u = String(url);
      if (u.includes('/v1/finance/search')) {
        return jsonRes({ quotes: [
          { symbol: 'MU', shortname: 'Micron Technology, Inc.', quoteType: 'EQUITY', exchange: 'NMS' },
        ] });
      }
      if (u.includes('/v8/finance/chart/MU')) return jsonRes({ chart: { result: [{ meta: { regularMarketPrice: 942 } }] } });
      if (u.includes('scanner.tradingview.com')) return jsonRes({ data: [] }); // old tier: no match
      throw new Error(`unexpected url ${u}`);
    });
    expect(await resolveUsSymbol('Micron Technology Inc.', null)).toBe('MU');
  });

  it('paren-ticker in the name wins after verification', async () => {
    __setFetchForTests(async (url) => {
      if (String(url).includes('/v8/finance/chart/SPCX')) return jsonRes({ chart: { result: [{ meta: { regularMarketPrice: 140.5 } }] } });
      throw new Error('unexpected url');
    });
    expect(await resolveUsSymbol('SpaceX (SPCX)', null)).toBe('SPCX');
  });

  it('static map → TV scanner fallback still works (last tier)', async () => {
    // 'Zyllo Energy Corp' is deliberately NOT in the static map and Yahoo
    // search returns nothing → the TV description-equal tier must rescue it.
    const tried = [];
    __setFetchForTests(async (url) => {
      tried.push(String(url));
      const u = String(url);
      if (u.includes('scanner.tradingview.com')) {
        return jsonRes({ data: [{ s: 'NYSE:ZYL', d: ['ZYL', 'Zyllo Energy Corp'] }] });
      }
      if (u.includes('/v8/finance/chart/')) return jsonRes({ chart: { result: [{ meta: { regularMarketPrice: 200 } }] } });
      if (u.includes('/v1/finance/search')) return jsonRes({ quotes: [] });
      return groww([]);
    });
    expect(await resolveUsSymbol('Apple Inc.', null)).toBe('AAPL');        // static map (verified)
    expect(await resolveUsSymbol('Zyllo Energy Corp', 'ZYLLO9')).toBe('ZYL'); // TV fallback
    expect(tried.some(u => u.includes('scanner.tradingview.com'))).toBe(true);
  });
});

describe('US resolution pure helpers (v2 engine)', () => {
  it('extractTickerToken handles plain, composite and exchange forms', () => {
    const { extractTickerToken } = symbolsMod;
    expect(extractTickerToken('MU')).toBe('MU');
    expect(extractTickerToken('mu')).toBe('MU');
    expect(extractTickerToken('NASDAQ:MU')).toBe('MU');   // exchange-prefixed
    expect(extractTickerToken('MU:NSDQ')).toBe('MU');     // exchange-suffixed
    expect(extractTickerToken('US45208C2827')).toBeNull(); // ISIN — not a ticker
    expect(extractTickerToken('ZSCALER-X')).toBeNull();   // 9 chars — not US-shaped
    expect(extractTickerToken('')).toBeNull();
    expect(extractTickerToken(null)).toBeNull();
  });

  it('extractParenTicker pulls the ticker out of "(SPCX)" style names', () => {
    const { extractParenTicker } = symbolsMod;
    expect(extractParenTicker('SpaceX (SPCX)')).toBe('SPCX');
    expect(extractParenTicker('Micron Technology Inc. (MU)')).toBe('MU');
    expect(extractParenTicker('Some Fund (LONGNAME)')).toBeNull(); // not ticker-shaped
    expect(extractParenTicker('No parens here')).toBeNull();
    expect(extractParenTicker(null)).toBeNull();
  });

  it('pickYahooSearchMatch scores exact/overlap matches and filters non-US', () => {
    const { pickYahooSearchMatch } = symbolsMod;
    // Exact shortname match wins
    expect(pickYahooSearchMatch(
      [{ symbol: 'MU', shortname: 'Micron Technology, Inc.', quoteType: 'EQUITY', exchange: 'NMS' }],
      'Micron Technology Inc.'
    )).toBe('MU');
    // Token overlap path
    expect(pickYahooSearchMatch(
      [{ symbol: 'AMD', shortname: 'Advanced Micro Devices', quoteType: 'EQUITY', exchange: 'NMS' }],
      'Advanced Micro Devices Inc'
    )).toBe('AMD');
    // FUTURES / non-US exchanges are filtered out
    expect(pickYahooSearchMatch(
      [{ symbol: 'SSPCX=F', shortname: 'Space X Futures', quoteType: 'FUTURE', exchange: 'CME' }],
      'SpaceX'
    )).toBeNull();
    // Distinctive single-word query → first US equity accepted (the SpaceX case)
    expect(pickYahooSearchMatch(
      [
        { symbol: 'SSPCX=F', shortname: 'Space X Futures', quoteType: 'FUTURE', exchange: 'CME' },
        { symbol: 'SPCX', shortname: 'Space Exploration Technologies', quoteType: 'EQUITY', exchange: 'NMS' },
      ],
      'SpaceX'
    )).toBe('SPCX');
    // Empty / garbage input
    expect(pickYahooSearchMatch(null, 'X')).toBeNull();
    expect(pickYahooSearchMatch([], 'X')).toBeNull();
    expect(pickYahooSearchMatch([{ symbol: 'MU' }], '')).toBeNull();
  });
  it('static US map has the micron / spacex entries (the reported rows)', async () => {
    // Verified live: Yahoo chart serves SPCX (SpaceX, Nasdaq) and MU.
    __setFetchForTests(async (url) => {
      const u = String(url);
      if (u.includes('/v8/finance/chart/')) {
        return jsonRes({ chart: { result: [{ meta: { regularMarketPrice: 100 } }] } });
      }
      throw new Error(`unexpected url ${u}`);
    });
    expect(await resolveUsSymbol('Micron Technology Inc.', null)).toBe('MU');
    expect(await resolveUsSymbol('SpaceX', null)).toBe('SPCX');
  });});

describe('classifyHolding (enum → market/kind/live decision)', () => {
  it('routes every INDMoney enum correctly', () => {
    expect(classifyHolding({ assetEnum: 'IND_STOCK', name: 'Reliance', assetType: 'Stock' }))
      .toMatchObject({ market: 'IN', kind: 'stock', tryResolve: 'ind' });
    expect(classifyHolding({ assetEnum: 'IND_STOCK', name: 'Some ETF', assetType: 'ETF' }))
      .toMatchObject({ kind: 'etf', tryResolve: 'ind' });
    expect(classifyHolding({ assetEnum: 'US_STOCK', name: 'Apple', assetType: 'Stock' }))
      .toMatchObject({ market: 'US', tryResolve: 'us' });
    expect(classifyHolding({ assetEnum: 'CRYPTO', name: 'Bitcoin' }))
      .toMatchObject({ market: 'IN', kind: 'crypto', tryResolve: 'crypto' });
    expect(classifyHolding({ assetEnum: 'MF', name: 'HDFC Flexi Cap', assetType: 'Mutual Fund' }))
      .toMatchObject({ market: 'IN', kind: 'mf', tryResolve: null });
    expect(classifyHolding({ assetEnum: 'FD', name: 'SBI FD', assetType: 'Fixed Income' }))
      .toMatchObject({ market: 'IN', kind: 'fixed', tryResolve: null });
    expect(classifyHolding({ assetEnum: 'EPF', name: 'EPF' })).toMatchObject({ kind: 'retirement' });
    expect(classifyHolding({ assetEnum: 'SA', name: 'Savings' })).toMatchObject({ kind: 'other' });
  });
  it('label-based fallback when the enum is absent (legacy path)', () => {
    expect(classifyHolding({ name: 'Nifty ETF', assetType: 'ETF' })).toMatchObject({ market: 'IN', tryResolve: 'ind' });
    expect(classifyHolding({ name: 'Bitcoin', assetType: 'Crypto' })).toMatchObject({ kind: 'crypto' });
    expect(classifyHolding({ name: 'Gold Bond', assetType: 'Gold' })).toMatchObject({ kind: 'gold' });
  });
});

// ============================================================
// portfolioSync.js — holdings → assets mapper (PURE)
// ============================================================
describe('mapHoldingsToAssets', () => {
  const h = (over = {}) => ({
    name: 'Reliance', symbol: null, qty: 10, avgPrice: 100, currentPrice: 120,
    value: 1200, invested: 1000, pnl: 200, pnlPct: 20, oneDayChangePct: 1.5,
    assetType: 'Stock', assetEnum: 'IND_STOCK', ...over,
  });

  it('maps an India stock/ETF with a resolved symbol (live)', () => {
    const assets = mapHoldingsToAssets([h()], [{ market: 'IN', kind: 'stock', symbol: 'RELIANCE', noLive: false }]);
    expect(assets).toHaveLength(1);
    const a = assets[0];
    expect(a.symbol).toBe('RELIANCE');
    expect(a.market).toBe('IN');
    expect(a.qty).toBe(10);
    expect(a.avgPrice).toBe(100);       // INR per unit
    expect(a.lastPrice).toBe(120);
    expect(a.value).toBe(1200);
    expect(a.invested).toBe(1000);
    expect(a.pnl).toBe(200);
    expect(a.oneDayChangePct).toBe(1.5);
    expect(a.noLive).toBe(false);
  });

  it('converts US assets to USD per-unit prices while keeping INR totals', () => {
    const assets = mapHoldingsToAssets(
      [h({ name: 'Apple Inc.', assetEnum: 'US_STOCK' })],
      [{ market: 'US', kind: 'stock', symbol: 'AAPL', noLive: false }],
      80, // USD/INR
    );
    const a = assets[0];
    expect(a.market).toBe('US');
    expect(a.avgPrice).toBe(1.25);    // (1000 INR / 10 qty) / 80 rate
    expect(a.lastPrice).toBe(1.5);    // (1200 / 10) / 80
    expect(a.value).toBe(1200);       // INR totals preserved
    expect(a.invested).toBe(1000);
    expect(a.noLive).toBe(false);
  });

  it('NAV assets (MF/FD) are noLive with a seeded price; qty=null collapses to qty 1', () => {
    const assets = mapHoldingsToAssets(
      [h({ name: 'HDFC Flexi Cap Fund', qty: null, avgPrice: null, assetEnum: 'MF', assetType: 'Mutual Fund' })],
      [{ market: 'IN', kind: 'mf', symbol: null, noLive: true }],
    );
    const a = assets[0];
    expect(a.noLive).toBe(true);
    expect(a.symbol).toBeNull();
    expect(a.qty).toBe(1);
    expect(a.avgPrice).toBe(1000);   // invested / qty(1)
    expect(a.lastPrice).toBe(1200);
  });

  it('crypto assets resolve to exchange-agnostic symbols in the IN market', () => {
    const assets = mapHoldingsToAssets(
      [h({ name: 'Bitcoin', assetEnum: 'CRYPTO', assetType: 'Crypto' })],
      [{ market: 'IN', kind: 'crypto', symbol: 'BTC', noLive: false }],
    );
    expect(assets[0].symbol).toBe('BTC');
    expect(assets[0].market).toBe('IN');
    expect(assets[0].noLive).toBe(false);
  });

  it('computes pnl/pnlPct when the payload omits them', () => {
    const assets = mapHoldingsToAssets(
      [h({ pnl: null, pnlPct: null })],
      [{ market: 'IN', kind: 'stock', symbol: 'RELIANCE', noLive: false }],
    );
    expect(assets[0].pnl).toBe(200);
    expect(assets[0].pnlPct).toBe(20);
  });

  it('garbage USD/INR falls back to the safe default; holdings with no data are skipped', () => {
    const assets = mapHoldingsToAssets(
      [h({ assetEnum: 'US_STOCK' }), h({ name: 'Empty', qty: null, value: null, invested: null, avgPrice: null, currentPrice: null })],
      [{ market: 'US', kind: 'stock', symbol: 'AAPL', noLive: false }, { market: 'IN', kind: 'other', symbol: null, noLive: true }],
      5, // out of range → default 84
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].avgPrice).toBe(1.19); // round2(1000 / 10 / 84)
  });
});

// ============================================================
// portfolioSync.js — 2×-daily scheduler math (IST)
// ============================================================
describe('scheduler (IST slots)', () => {
  it('parseSlots: valid list, invalid entries dropped, empty → defaults', () => {
    expect(parseSlots('08:00, 20:15')).toEqual(['08:00', '20:15']);
    expect(parseSlots('25:00, 09:99, abc')).toEqual(['09:30', '21:30']);
    expect(parseSlots('')).toEqual(['09:30', '21:30']);
  });

  it('slotTsToday: IST 09:30 = 04:00 UTC same day', () => {
    const now = Date.parse('2026-09-02T05:00:00Z'); // 10:30 IST
    expect(slotTsToday('09:30', now)).toBe(Date.parse('2026-09-02T04:00:00Z'));
    expect(slotTsToday('21:30', now)).toBe(Date.parse('2026-09-02T16:00:00Z'));
  });

  it('computeDueSlots: due when the slot passed today and has not run', () => {
    const now = Date.parse('2026-09-02T05:00:00Z'); // 10:30 IST — 09:30 passed, 21:30 not yet
    expect(computeDueSlots(now, {}, ['09:30', '21:30'])).toEqual(['09:30']);
  });

  it('computeDueSlots: already ran today → not due again', () => {
    const now = Date.parse('2026-09-02T05:00:00Z');
    expect(computeDueSlots(now, { '09:30': now - 3600_000 }, ['09:30', '21:30'])).toEqual([]);
  });

  it('computeDueSlots: yesterday’s run does NOT block today’s slot', () => {
    const now = Date.parse('2026-09-02T05:00:00Z');
    const yesterday = now - 24 * 3600_000;
    expect(computeDueSlots(now, { '09:30': yesterday }, ['09:30', '21:30'])).toEqual(['09:30']);
  });

  it('computeDueSlots: a slot missed by > the catch-up window is skipped', () => {
    const now = Date.parse('2026-09-02T09:00:00Z'); // 14:30 IST — 09:30 slot was 5h ago (>4h)
    expect(computeDueSlots(now, {}, ['09:30'], 4 * 3600_000)).toEqual([]);
    expect(computeDueSlots(now, {}, ['09:30'], 6 * 3600_000)).toEqual(['09:30']);
  });

  it('nextSlotTs: next upcoming slot strictly after now', () => {
    const now = Date.parse('2026-09-02T05:00:00Z'); // 10:30 IST
    expect(nextSlotTs(now, ['09:30', '21:30'])).toBe(Date.parse('2026-09-02T16:00:00Z'));
    const late = Date.parse('2026-09-02T17:00:00Z'); // 22:30 IST — both slots done today
    expect(nextSlotTs(late, ['09:30', '21:30'])).toBe(Date.parse('2026-09-03T04:00:00Z'));
  });

  it('istParts is pure UTC+5:30 with no DST', () => {
    const p = istParts(new Date(Date.parse('2026-09-02T18:29:59Z')));
    expect(p).toEqual({ y: 2026, m: 9, d: 2, hh: 23, mm: 59 });
  });
});

// ============================================================
// portfolioSync.js — end-to-end (mocked network)
// ============================================================
describe('syncNow e2e (mocked OAuth + MCP + Groww + forex)', () => {
  const ORIGIN = 'https://smartai.example.com';

  function stubMcpFlow({ responses, forexRate = 80, growwItems = [] }) {
    __setFetchForTests(async (url) => {
      if (String(url).includes('groww.in')) return groww(growwItems);
      if (String(url).includes('scanner.tradingview.com')) return jsonRes({ data: [] });
      throw new Error(`unexpected symbol lookup ${url}`);
    });
    vi.stubGlobal('fetch', async (url) => {
      if (String(url) === RATE_URL) return jsonRes({ rates: { INR: forexRate } });
      if (String(url) === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'client-sync' });
      if (String(url) === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-S', refresh_token: 'RT-S', expires_in: 3600 });
      if (String(url) === indm.INDM.MCP_URL) {
        const body = JSON.parse((arguments.length > 1) ? '{}' : '{}');
        return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
      }
      throw new Error(`unexpected url ${url}`);
    });
  }

  it('full pipeline: holdings → resolved assets → snapshot on disk (+ slot marking)', async () => {
    const ENUM = ['IND_STOCK', 'MF'];
    const RESPONSES = {
      IND_STOCK: {
        holdings: [
          { investment: 'Motilal Oswal Nifty 500 Momentum 50 ETF', invested_amount: 103380.5, market_value: 107619.2, total_pnl: 4238.7, pnl_per: 4.1, total_units: 1990, unit_price: 54.08, one_day_change_percentage: -0.39 },
          { investment: 'Nippon India ETF Nifty Midcap 150', invested_amount: 73056.7, market_value: 78893.1, total_pnl: 5836.4, pnl_per: 7.99, total_units: 330, unit_price: 239.07, one_day_change_percentage: -0.6 },
        ],
        asset_summary: { total_value: 180512.3, invested: 176437.2, one_day_change: -417.9, one_day_change_percentage: -0.23 },
        mtf_positions: [{ ind_stock_id: 'INDS18666', quantity: 45, avg_price: 260.57, buy_val: 11725.65, t1_qty: 10, position_id: '1' }],
      },
      MF: {
        holdings: [
          { investment: 'HDFC Flexi Cap Fund', invested_amount: 50000, market_value: 55000, total_pnl: 5000, pnl_per: 10, total_units: 100, unit_price: 550 },
        ],
        asset_summary: null,
      },
    };

    let mcpBody = null;
    __setFetchForTests(async (url) => {
      if (String(url).includes('groww.in')) {
        return groww([
          growwItem('Motilal Oswal Nifty 500 Momentum 50 ETF', 'MOMENTUM50'),
          growwItem('Nippon India ETF Nifty Midcap 150', 'MID150BEES'),
          growwItem('HDFC Flexi Cap Fund', 'HDFCFLEXI', 'Scheme'), // scheme → not resolvable
        ]);
      }
      throw new Error(`unexpected symbols url ${url}`);
    });
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80.5 } });
      if (u === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'client-sync-1' });
      if (u === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-SYNC', refresh_token: 'RT-SYNC', expires_in: 3600 });
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse(String(init.body || '{}'));
        mcpBody = body;
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'indmoney' } } }, { headers: { 'mcp-session-id': 'sync-1' } });
        if (body.method === 'notifications/initialized') return jsonRes('', { status: 202 });
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{
            name: 'networth_holdings',
            description: 'Get user net worth holdings by asset type',
            inputSchema: { type: 'object', properties: { asset_type: { type: 'string', enum: ENUM } }, required: ['asset_type'] },
          }] } });
        }
        if (body.method === 'tools/call') {
          const at = body.params.arguments.asset_type;
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(RESPONSES[at]) }] } });
        }
        throw new Error(`unexpected MCP method ${body.method}`);
      }
      throw new Error(`unexpected url ${u}`);
    });

    const { state } = await indm.startConnect(ORIGIN);
    await indm.completeConnect({ code: 'sync-code', state });

    const out = await syncNow({ force: true, reason: '09:30' });
    expect(out.ok).toBe(true);

    const snap = getAssetsSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.source).toBe('indmoney+coindcx');
    expect(snap.assets).toHaveLength(3);
    expect(snap.counts).toEqual({ assets: 3, live: 2, noLive: 1, resolved: 2, coindcx: 0 });
    expect(snap.slots['09:30']).toBeTruthy(); // slot marked as run

    // ETF 1: resolved symbol, live-priced, correct numbers
    const etf1 = snap.assets.find(a => a.symbol === 'MOMENTUM50');
    expect(etf1).toBeTruthy();
    expect(etf1.market).toBe('IN');
    expect(etf1.kind).toBe('etf');
    expect(etf1.qty).toBe(1990);
    expect(etf1.avgPrice).toBeCloseTo(103380.5 / 1990, 4);
    expect(etf1.lastPrice).toBeCloseTo(107619.2 / 1990, 4);
    expect(etf1.value).toBe(107619.2);
    expect(etf1.noLive).toBe(false);
    expect(etf1.oneDayChangePct).toBe(-0.39);

    // ETF 2: MID150BEES
    expect(snap.assets.find(a => a.symbol === 'MID150BEES')).toBeTruthy();

    // MF: scheme → not exchange-listed → noLive with seeded NAV price
    const mf = snap.assets.find(a => a.name === 'HDFC Flexi Cap Fund');
    expect(mf).toBeTruthy();
    expect(mf.symbol).toBeNull();
    expect(mf.noLive).toBe(true);
    expect(mf.lastPrice).toBe(550);

    // official summary (consistent across both calls) preserved
    expect(snap.summary.totalValue).toBe(180512.3);
    // MTF positions carried through
    expect(snap.positions).toHaveLength(1);

    // syncInfo reports the scheduler context
    const info = syncInfo();
    expect(info.connected).toBe(true);
    expect(info.assetCount).toBe(3);
    expect(info.liveCount).toBe(2);
    expect(info.nextSyncAt).toBeGreaterThan(Date.now());
    expect(mcpBody).toBeTruthy();
  });

  it('a hard fetch failure keeps the previous snapshot (stale data, never wiped)', async () => {
    const ORIGIN2 = 'https://smartai.example.com';
    // First: a good sync (empty holdings but ok) to establish a snapshot.
    __setFetchForTests(async () => groww([]));
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      if (u === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'client-s2' });
      if (u === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 });
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse('{}');
        return jsonRes({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: [] }) }] } });
      }
      throw new Error(`unexpected ${u}`);
    });
    // Build connected state via the real (stubbed) flow:
    // tools/list with NO required args → satisfiable; tools/call returns one holding.
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      if (u === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'client-s2' });
      if (u === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 });
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's2' } });
        if (body.method === 'tools/list') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'get_portfolio', description: 'portfolio', inputSchema: { type: 'object', properties: {} } }] } });
        if (body.method === 'tools/call') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: [{ investment: 'SBI FD', invested_amount: 1000, market_value: 1100 }] }) }] } });
        return jsonRes('', { status: 202 });
      }
      throw new Error(`unexpected ${u}`);
    });
    const { state } = await indm.startConnect(ORIGIN2);
    await indm.completeConnect({ code: 'c2', state });
    const good = await syncNow({ force: true });
    expect(good.ok).toBe(true);
    expect(getAssetsSnapshot().assets).toHaveLength(1);

    // Now break the network — the snapshot must survive.
    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    __setFetchForTests(async () => { throw new Error('network down'); });
    const bad = await syncNow({ force: true });
    expect(bad.ok).toBe(false);
    const snap = getAssetsSnapshot();
    expect(snap.assets).toHaveLength(1);           // previous assets kept
    expect(snap.lastError).toContain('network down');
    expect(snap.failedAt).toBeGreaterThan(0);
  });

  it('syncNow without a connection reports not-connected (no MCP traffic)', async () => {
    let hit = 0;
    vi.stubGlobal('fetch', async () => { hit++; throw new Error('must not be called'); });
    const out = await syncNow({ force: true });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not-connected');
    expect(hit).toBe(0);
  });

  it('v10.18: a MID-SYNC disconnect is not reverted by the still-running sync (no resurrect)', async () => {
    // THE RACE: `indmConnected` is captured at sync start; the sync then
    // sits in 30-60s of awaits. If the user disconnects INDMoney during
    // that window, clearSourceAssets() writes a snapshot WITHOUT the
    // indmoney rows — and the still-running sync used to write them
    // right back (resurrect + durable-put, surviving restarts).
    const HOLDINGS = {
      holdings: [{ investment: 'HDFC Flexi Cap Fund', invested_amount: 50000, market_value: 55000, total_pnl: 5000, pnl_per: 10, total_units: 100, unit_price: 550 }],
      asset_summary: null,
    };
    const mcpTools = () => [{ name: 'networth_holdings', description: 'x', inputSchema: { type: 'object', properties: { asset_type: { type: 'string' } }, required: ['asset_type'] } }];
    const mcpRes = (body, payload) => jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });

    // 1) connect + first sync primes ONE indmoney asset
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      if (u === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'c-race' });
      if (u === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-RACE', refresh_token: 'RT-RACE', expires_in: 3600 });
      if (u === indm.INDM.REVOKE_URL) return jsonRes({});
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 'race-1' } });
        if (body.method === 'tools/list') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: mcpTools() } });
        if (body.method === 'tools/call') return mcpRes(body, HOLDINGS);
        return jsonRes('', { status: 202 });
      }
      throw new Error(`unexpected ${u}`);
    });
    __setFetchForTests(async () => groww([]));
    const { state } = await indm.startConnect('https://race.example.com');
    await indm.completeConnect({ code: 'race', state });
    const first = await syncNow({ force: true });
    expect(first.ok).toBe(true);
    expect(getAssetsSnapshot().assets).toHaveLength(1);

    // 2) second sync whose tools/call HANGS on a gate — the disconnect
    //    lands while it is in flight
    let callHit = false;
    let release;
    const gate = new Promise(r => { release = r; });
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      if (u === RATE_URL) return jsonRes({ rates: { INR: 80 } });
      if (u === indm.INDM.REVOKE_URL) return jsonRes({});
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.method === 'tools/call') { callHit = true; await gate; return mcpRes(body, HOLDINGS); }
        if (body.method === 'tools/list') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: mcpTools() } });
        return jsonRes('', { status: 202 });
      }
      throw new Error(`unexpected ${u}`);
    });
    const p = syncNow({ force: true });
    for (let i = 0; i < 200 && !callHit; i++) await new Promise(r => setTimeout(r, 10));
    expect(callHit).toBe(true); // the sync is now parked inside its awaits

    // 3) the user disconnects mid-sync (exactly what the route does)
    await indm.disconnect();
    syncMod.clearSourceAssets('indmoney');
    expect(getAssetsSnapshot().assets).toHaveLength(0); // cleared by the disconnect

    // 4) release the hanging call — the sync finishes AFTER the disconnect
    release();
    const out = await p;
    expect(out.ok).toBe(false); // honest: nothing usable remains
    const snap = getAssetsSnapshot();
    expect(snap.assets || []).toHaveLength(0);       // THE FIX: no resurrect
    expect(snap.summary ?? null).toBeNull();          // residue dropped (clearSourceAssets parity)
  });

  it('maybeBackgroundSync fires only when connected + stale', async () => {
    expect(maybeBackgroundSync()).toBe(false); // not connected
    // connect…
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = String(url);
      if (u === indm.INDM.REGISTER_URL) return jsonRes({ client_id: 'c-bg' });
      if (u === indm.INDM.TOKEN_URL) return jsonRes({ access_token: 'AT-BG', refresh_token: 'RT-BG', expires_in: 3600 });
      if (u === indm.INDM.MCP_URL) {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 'bg' } });
        if (body.method === 'tools/list') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'get_portfolio', inputSchema: { type: 'object', properties: {} } }] } });
        if (body.method === 'tools/call') return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ holdings: [] }) }] } });
        return jsonRes('', { status: 202 });
      }
      throw new Error(`unexpected ${u}`);
    });
    __setFetchForTests(async () => groww([]));
    const { state } = await indm.startConnect('https://x.example.com');
    await indm.completeConnect({ code: 'bg', state });
    expect(maybeBackgroundSync()).toBe(true);  // no snapshot → stale → fires
    // gap guard: immediate second call is suppressed
    expect(maybeBackgroundSync()).toBe(false);
  });

  it('clearSnapshot empties the asset table', async () => {
    clearSnapshot();
    const snap = getAssetsSnapshot();
    expect(snap.ok).toBe(false);
    expect(snap.assets).toEqual([]);
    expect(syncInfo().assetCount).toBe(0);
  });
});

// ============================================================
// v10.5 netWorthSnapshot — the unified by-class net-worth view
// ============================================================
describe('netWorthSnapshot (Upgrade 3 — by-class aggregation)', () => {
  function writeSnap(assets, hidden = []) {
    fs.writeFileSync(SNAP_PATH, JSON.stringify({
      ok: true, syncedAt: Date.now(), assets, hidden,
    }));
  }

  it('buckets every class correctly (Equity/MF/EPF/Gold/Fixed/Crypto) with pct math', () => {
    writeSnap([
      { key: 'a', name: 'RELIANCE', kind: 'stock', source: 'indmoney', value: 300000 },
      { key: 'b', name: 'HDFC Flexi Cap Fund', kind: 'mf', source: 'indmoney', value: 200000 },
      { key: 'c', name: 'EPF Account', kind: 'retirement', source: 'indmoney', value: 250000 },
      { key: 'd', name: 'Sovereign Gold Bond', kind: 'gold', source: 'indmoney', value: 100000 },
      { key: 'e', name: 'SBI FD', kind: 'fixed', source: 'indmoney', value: 150000 },
      { key: 'f', name: 'BTC', kind: 'crypto', source: 'coindcx', value: 200000 },
    ]);
    const nw = netWorthSnapshot();
    expect(nw.ok).toBe(true);
    expect(nw.totalValueINR).toBe(1200000);
    expect(nw.holdingCount).toBe(6);
    const byCat = Object.fromEntries(nw.categories.map(c => [c.category, c]));
    expect(byCat.Equity.valueINR).toBe(300000);
    expect(byCat['Mutual Funds'].valueINR).toBe(200000);
    expect(byCat.EPF.valueINR).toBe(250000);
    expect(byCat.Gold.valueINR).toBe(100000);
    expect(byCat['Fixed Income'].valueINR).toBe(150000);
    expect(byCat.Crypto.valueINR).toBe(200000);
    // pct sums to 100 and the largest class is sorted first
    expect(nw.categories[0].category).toBe('Equity');
    expect(nw.categories.reduce((a, c) => a + (c.pct || 0), 0)).toBeCloseTo(100, 1);
    expect(byCat.Equity.pct).toBeCloseTo(25, 1);
  });

  it('hidden rows NEVER count (removed, not zero-valued)', () => {
    writeSnap([
      { key: 'a', name: 'RELIANCE', kind: 'stock', source: 'indmoney', value: 100 },
      { key: 'b', name: 'BTC', kind: 'crypto', source: 'coindcx', value: 300 },
    ], ['b']);
    const nw = netWorthSnapshot();
    expect(nw.totalValueINR).toBe(100);
    expect(nw.holdingCount).toBe(1);
    expect(nw.categories.find(c => c.category === 'Crypto')).toBeUndefined();
  });

  it('missing-field rows count toward holdings but add 0 value (graceful)', () => {
    writeSnap([
      { key: 'a', name: 'RELIANCE', kind: 'stock', source: 'indmoney', value: 500 },
      { key: 'b', name: 'Mystery Asset' }, // no kind, no value
    ]);
    const nw = netWorthSnapshot();
    expect(nw.holdingCount).toBe(2);
    expect(nw.valuedCount).toBe(1);
    expect(nw.totalValueINR).toBe(500);
    const other = nw.categories.find(c => c.category === 'Other');
    expect(other.count).toBe(1);
    expect(other.valueINR).toBe(0);
  });

  it('empty snapshot → ok:false, zero total (no fake zeros on the card)', () => {
    writeSnap([]);
    const nw = netWorthSnapshot();
    expect(nw.ok).toBe(false);
    expect(nw.totalValueINR).toBe(0);
    expect(nw.categories).toEqual([]);
  });
});
