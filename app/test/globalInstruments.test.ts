// ============================================================
// test/globalInstruments.test.ts — v10.5.3 CoinDCX equity-perp
// discovery filter (Issue #2, server/mcp/coindcx.js) + v10.7 USDC
// Global Futures scan and commodity/index exclusion.
//
// fetchGlobalFuturesInstruments() separates global-equity perps from
// crypto perps so the Global Equity SIM desk's full-universe scan
// only ever adds real stock tickers. Classification contract:
//   • v10.7 USDC scan FIRST — the app's Global Futures stock list
//     (B-<TICKER>_USDC, margin_currency_short_name[]=USDC); a scan
//     counts only with >= 3 USDC rows; merged with the USDT scan.
//   • a base with a CoinDCX SPOT market = crypto coin → excluded
//   • leveraged-token suffixes (3L/3S/BULL/BEAR/HALF) → excluded
//   • perp-only crypto staples (WIF/PEPE/…) → excluded
//   • non-ticker shapes (digits) → excluded
//   • v10.7 commodity/energy/index perps (XAU/XAG/NATGAS/INX/COPPER/
//     ROBO/SLX/RAYSOL…) → excluded — real markets, NOT stocks
//   • everything else (AAPL/MU/JPM/TSLA/NVDA…) → equity discovery
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchGlobalFuturesInstruments } from '../server/mcp/coindcx.js';

const origFetch = globalThis.fetch;

// a believable active-instruments response: crypto perps + equity perps
const INSTRUMENTS = [
  'B-BTC_USDT', 'B-ETH_USDT', 'B-AAPL_USDT', 'B-MU_USDT', 'B-DOGE_USDT',
  'B-ETH3L_USDT', 'B-JPM_USDT', 'B-WIF_USDT', 'B-TSLA_USDT', 'B-1000PEPE_USDT',
  'B-NVDA_USDT',
];
// v10.7: the USDT book ALSO lists commodity/energy/index perps —
// they must NEVER be discovered as "equity perps" (the desk bug that
// filled the Global Equity SIM tail with gold/silver/natgas).
const COMMODITY_INSTRUMENTS = [
  ...INSTRUMENTS, 'B-XAU_USDT', 'B-XAG_USDT', 'B-NATGAS_USDT', 'B-INX_USDT',
  'B-COPPER_USDT', 'B-ROBO_USDT', 'B-SLX_USDT', 'B-RAYSOL_USDT',
];
// v10.7: the USDC-margined Global Futures stock list (the app's list)
const USDC_INSTRUMENTS = [
  'B-AAPL_USDC', 'B-TSLA_USDC', 'B-NVDA_USDC', 'B-TSM_USDC', 'B-SKHX_USDC',
  'B-SMSN_USDC', 'B-CRWV_USDC', 'B-MSTR_USDC', 'B-HOOD_USDC',
];
// the SPOT book (crypto coins trade spot; tokenized equities do not)
const TICKERS = [
  { market: 'BTCINR' }, { market: 'ETHUSDT' }, { market: 'DOGEINR' },
  { market: 'SOLINR' },
];

function routeWith({ usdt = INSTRUMENTS, usdc = [] as string[] } = {}) {
  globalThis.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/derivatives/futures/data/active_instruments')) {
      // USDC-scoped calls return the USDC list; the USDT scan returns USDT
      const list = u.includes('USDC') ? usdc : usdt;
      return { ok: true, status: 200, json: async () => list, text: async () => JSON.stringify(list) };
    }
    if (u.includes('/exchange/ticker')) {
      return { ok: true, status: 200, json: async () => TICKERS, text: async () => JSON.stringify(TICKERS) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
  }) as any;
}

beforeEach(() => { routeWith(); });
afterEach(() => { globalThis.fetch = origFetch; });

describe('fetchGlobalFuturesInstruments — equity-perp discovery filter', () => {
  it('keeps equity perps, drops crypto coins / leveraged tokens / perp-only memes / junk shapes', async () => {
    const rows = await fetchGlobalFuturesInstruments({ maxAgeMs: 0 });
    const syms = rows.map(r => r.symbol);
    // the equities survive
    for (const want of ['AAPL', 'MU', 'JPM', 'TSLA', 'NVDA']) expect(syms).toContain(want);
    // crypto coins WITH spot markets are excluded
    for (const no of ['BTC', 'ETH', 'DOGE', 'SOL']) expect(syms).not.toContain(no);
    // leveraged tokens are crypto derivatives, never equities
    expect(syms).not.toContain('ETH3L');
    // perp-only crypto staples
    expect(syms).not.toContain('WIF');
    // digit-prefixed meme units are not ticker-shaped
    expect(syms.some(s => s.includes('1000PEPE'))).toBe(false);
    // rows carry the CoinDCX pair
    for (const r of rows) expect(r.pair).toBe(`B-${r.symbol}_USDT`);
  });

  it('serves repeat calls from the cache (one upstream round-trip per TTL)', async () => {
    await fetchGlobalFuturesInstruments({ maxAgeMs: 0 }); // fresh fetch
    const f = globalThis.fetch as any;
    const calls = f.mock.calls.length;
    await fetchGlobalFuturesInstruments({ maxAgeMs: 60_000 }); // cache window
    expect(f.mock.calls.length).toBe(calls); // nothing hit the upstream
  });

  it('an unreachable CoinDCX throws (caller degrades to seed-only honestly)', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' })) as any;
    await expect(fetchGlobalFuturesInstruments({ maxAgeMs: 0 })).rejects.toThrow();
  });
});

describe('v10.7 USDC Global Futures scan + commodity exclusion', () => {
  it('discovers the USDC-margined Global Futures stocks (the app\'s list) and merges with USDT', async () => {
    routeWith({ usdc: USDC_INSTRUMENTS });
    const rows = await fetchGlobalFuturesInstruments({ maxAgeMs: 0 });
    const bySymbol = new Map(rows.map(r => [r.symbol, r]));
    // USDC names land with their B-<TICKER>_USDC pair + margin tag
    for (const want of ['AAPL', 'TSLA', 'TSM', 'SKHX', 'HOOD']) {
      expect(bySymbol.get(want)).toBeTruthy();
      expect(bySymbol.get(want).pair).toBe(`B-${want}_USDC`);
      expect(bySymbol.get(want).margin).toBe('USDC');
    }
    // the USDT scan still merges its equity rows (deduped by symbol —
    // AAPL keeps its USDC pair, never duplicated)
    expect(bySymbol.get('MU').pair).toBe('B-MU_USDT');
    expect(rows.filter(r => r.symbol === 'AAPL')).toHaveLength(1);
  });

  it('a USDC response with < 3 rows is ignored (never mistaken for the global domain)', async () => {
    routeWith({ usdc: ['B-AAPL_USDC'] });
    const rows = await fetchGlobalFuturesInstruments({ maxAgeMs: 0 });
    // falls through to the honest USDT scan — no partial USDC junk
    expect(rows.some(r => r.pair.endsWith('_USDC'))).toBe(false);
    for (const r of rows) expect(r.pair).toBe(`B-${r.symbol}_USDT`);
  });

  it('commodity / energy / index perps are NEVER equities (the XAU/NATGAS/INX bug)', async () => {
    routeWith({ usdt: COMMODITY_INSTRUMENTS });
    const rows = await fetchGlobalFuturesInstruments({ maxAgeMs: 0 });
    const syms = rows.map(r => r.symbol);
    for (const no of ['XAU', 'XAG', 'NATGAS', 'INX', 'COPPER', 'ROBO', 'SLX', 'RAYSOL']) {
      expect(syms).not.toContain(no);
    }
    // real stocks from the same list still survive
    for (const want of ['AAPL', 'MU', 'JPM', 'TSLA', 'NVDA']) expect(syms).toContain(want);
  });

  it('USDC scan success alone is a valid result even if the USDT scan fails (honest partial)', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/derivatives/futures/data/active_instruments')) {
        if (u.includes('USDC')) return { ok: true, status: 200, json: async () => USDC_INSTRUMENTS, text: async () => '[]' };
        return { ok: false, status: 503, json: async () => ({}), text: async () => '' }; // USDT down
      }
      if (u.includes('/exchange/ticker')) {
        return { ok: true, status: 200, json: async () => TICKERS, text: async () => '[]' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }) as any;
    const rows = await fetchGlobalFuturesInstruments({ maxAgeMs: 0 });
    expect(rows.length).toBe(USDC_INSTRUMENTS.length);
    for (const r of rows) expect(r.margin).toBe('USDC');
  });
});
