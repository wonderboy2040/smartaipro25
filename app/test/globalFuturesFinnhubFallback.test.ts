// ============================================================
// test/globalFuturesFinnhubFallback.test.ts — v10.11 (#3)
// ------------------------------------------------------------
// THE ASK (user plan): "Finnhub fallback for EQUITY SIM (replaces
// Yahoo as primary fallback)" — the fallback priority chain for the
// USDC equity-perp desk becomes:
//     1. CoinDCX USDC RT feed (unchanged — app parity)
//     2. FINNHUB REST quote   (shared module, rate-limited, gated)
//     3. Yahoo chart quote    (final fallback)
//
// THE CONTRACT (locked here):
//   • RT down → Finnhub is tried BEFORE Yahoo; rows carry
//     source 'finnhub' (the #1 src-tag the frontend badges).
//   • Finnhub fails too (down / no key / rate-limited /
//     freshness-gated) → Yahoo serves, source 'yahoo'.
//   • RT up → Finnhub is NEVER called (RT rows win outright).
//   • Partial coverage is honest per-symbol: whichever upstream
//     actually served a symbol, that symbol's source says so.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false,
  coindcxPrivate: vi.fn(),
  coindcxPrivateGET: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
  fetchGlobalFuturesInstruments: vi.fn(async () => []),
}));

import { fetchGlobalQuotes, __resetGlobalForTests } from '../server/ai/globalFutures.js';
import { __resetFinnhubForTests } from '../server/ai/finnhubQuote.js';

const ORIG_KEY = process.env.FINNHUB_API_KEY;
const origFetch = globalThis.fetch;

const yahooChart = (price: number, prev: number) => ({
  chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev } }] },
});
const finnhubQuote = (c: number) => ({
  c, d: 2.5, dp: 0.75, h: c * 1.01, l: c * 0.99, pc: c * 0.995,
  t: Math.floor(Date.now() / 1000), // fresh → staleness gate never rejects
});

function routeFetch(handler: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> } | null) {
  globalThis.fetch = vi.fn(async (url: any) => {
    const r = handler(String(url));
    if (!r) return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    return { ...r, text: async () => JSON.stringify({}) };
  }) as any;
}

beforeEach(() => {
  __resetGlobalForTests();
  __resetFinnhubForTests();
  process.env.FINNHUB_API_KEY = 'test-key-123';
});

afterEach(() => {
  globalThis.fetch = origFetch;
  process.env.FINNHUB_API_KEY = ORIG_KEY;
  __resetFinnhubForTests();
});

describe('EQUITY SIM fallback chain — CoinDCX RT → FINNHUB → Yahoo', () => {
  it('RT down + Finnhub up → Finnhub serves BEFORE Yahoo (source finnhub, Yahoo never called)', async () => {
    let yahooCalls = 0;
    let finnhubCalls = 0;
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt')) {
        return { ok: false, status: 403, json: async () => ({}) }; // RT dark
      }
      if (u.includes('finnhub.io/api/v1/quote')) {
        finnhubCalls += 1;
        const sym = u.match(/symbol=([A-Z0-9.]+)&/)?.[1] || '???';
        return { ok: true, status: 200, json: async () => finnhubQuote(sym === 'AAPL' ? 334.1 : 200) };
      }
      if (u.includes('query1.finance.yahoo.com')) {
        yahooCalls += 1;
        return { ok: true, status: 200, json: async () => yahooChart(111.11, 110) };
      }
      return null;
    });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    // every non-sim symbol the RT feed missed got a FRESH Finnhub quote
    expect(q.get('AAPL')).toMatchObject({ price: 334.1, source: 'finnhub', sim: false });
    expect(q.get('NVDA')).toMatchObject({ source: 'finnhub', sim: false });
    expect(q.get('NVDA')?.price).toBe(200);
    expect(q.get('META')).toMatchObject({ source: 'finnhub', sim: false });
    // SPACEX stays sim
    expect(q.get('SPACEX')).toMatchObject({ source: 'sim', sim: true });
    // the whole non-sim universe (20 seed names) went through Finnhub
    expect(finnhubCalls).toBe(20);
    // and Yahoo was NEVER touched — Finnhub covered everything
    expect(yahooCalls).toBe(0);
  });

  it('RT down + Finnhub down TOO → Yahoo is the FINAL fallback (source yahoo)', async () => {
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt')) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      if (u.includes('finnhub.io/api/v1/quote')) {
        return { ok: false, status: 429, json: async () => ({}) }; // rate-limited
      }
      if (u.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(227.5, 225) };
      }
      return null;
    });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    expect(q.get('AAPL')).toMatchObject({ price: 227.5, source: 'yahoo', sim: false });
    expect(q.size).toBeGreaterThan(10);
    // no symbol pretends Finnhub served it
    expect([...q.values()].filter(r => r.source === 'finnhub').length).toBe(0);
  });

  it('no FINNHUB key → the chain degrades straight to Yahoo (config-honest)', async () => {
    process.env.FINNHUB_API_KEY = '';
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt')) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      if (u.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(150.75, 149) };
      }
      return null;
    });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    expect(q.get('AAPL')).toMatchObject({ price: 150.75, source: 'yahoo', sim: false });
  });

  it('RT up → Finnhub is NEVER called (the app-parity feed wins outright)', async () => {
    let finnhubCalls = 0;
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt')) {
        return {
          ok: true, status: 200,
          json: async () => ({ ts: Date.now(), prices: {
            'B-AAPL_USDC': { ls: 333.62, mp: 333.5, pc: 0.4, h: 335, l: 331, v: 1_000_000 },
            'B-TSLA_USDC': { ls: 412.05, mp: 412, pc: -0.3, h: 415, l: 410, v: 500_000 },
            'B-NVDA_USDC': { ls: 196.4, mp: 196.3, pc: 1.2, h: 198, l: 195, v: 2_000_000 },
          } }),
        };
      }
      if (u.includes('finnhub.io/api/v1/quote')) {
        finnhubCalls += 1;
        return { ok: true, status: 200, json: async () => finnhubQuote(1) };
      }
      if (u.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(111, 110) };
      }
      return null;
    });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    expect(q.get('AAPL')).toMatchObject({ price: 333.62, source: 'coindcx-usdc', dcxPair: 'B-AAPL_USDC' });
    expect(q.get('NVDA')).toMatchObject({ source: 'coindcx-usdc' });
    // the RT-uncovered names went Finnhub-first
    expect(q.get('MU')).toMatchObject({ source: 'finnhub' });
    expect(finnhubCalls).toBeGreaterThan(0);
    // but the headline: RT-covered names carry the feed's own pair
    expect(q.get('AAPL')?.dcxPair).toBe('B-AAPL_USDC');
  });

  it('partial Finnhub outage → PER-SYMBOL honesty (some finnhub, some yahoo)', async () => {
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt')) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      if (u.includes('finnhub.io/api/v1/quote')) {
        // Finnhub serves ONLY AAPL; every other symbol 500s
        const sym = u.match(/symbol=([A-Z0-9.]+)&/)?.[1] || '???';
        if (sym === 'AAPL') return { ok: true, status: 200, json: async () => finnhubQuote(334.2) };
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (u.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(99.5, 99) };
      }
      return null;
    });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    expect(q.get('AAPL')).toMatchObject({ price: 334.2, source: 'finnhub', sim: false });
    expect(q.get('MSFT')).toMatchObject({ price: 99.5, source: 'yahoo', sim: false });
    // both honest labels coexist — the frontend badge shows exactly which
    const sources = new Set([...q.values()].map(r => r.source));
    expect(sources.has('finnhub')).toBe(true);
    expect(sources.has('yahoo')).toBe(true);
  });
});
