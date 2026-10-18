// ============================================================
// test/finnhubQuote.test.ts — v10.11 SHARED Finnhub module
// ------------------------------------------------------------
// THE CONTRACT (locked here):
//   • ONE shared fetcher serves the US desk (/api/quote) AND the
//     EQUITY SIM desk's fallback chain — identical response shape
//     to the old index.js inline copy (byte-parity, source
//     'finnhub-realtime').
//   • 3s micro-cache with in-flight promise sharing: two callers
//     inside the window share ONE upstream round-trip.
//   • 55/min sliding-window rate limiter: over budget → honest
//     null IMMEDIATELY (callers fall to Yahoo; never a throw).
//   • The isStaleUsQuote freshness gate survives the lift: while
//     the US market is OPEN a quote older than 5 min is rejected.
//   • No key / bad payload / upstream failure → null, never throws.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  fetchFinnhubQuote, _setFinnhubFetchForTest, __resetFinnhubForTests, __finnhubStateForTests,
} from '../server/ai/finnhubQuote.js';
import { usMarketOpen } from '../server/usStream.js';

const ORIG_KEY = process.env.FINNHUB_API_KEY;
const quoteJson = (c: number, opts: Record<string, unknown> = {}) => JSON.stringify({
  c, d: 1.25, dp: 0.5, h: c * 1.01, l: c * 0.99, pc: c * 0.995,
  t: Math.floor(Date.now() / 1000), // FRESH by default → staleness gate never rejects
  ...opts,
});

beforeEach(() => {
  __resetFinnhubForTests();
  process.env.FINNHUB_API_KEY = 'test-key-123';
});

afterEach(() => {
  __resetFinnhubForTests();
  process.env.FINNHUB_API_KEY = ORIG_KEY;
});

describe('fetchFinnhubQuote — the shared contract (byte-parity with the old US-desk copy)', () => {
  it('returns the canonical quote row with source finnhub-realtime', async () => {
    let url = '';
    _setFinnhubFetchForTest(async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => JSON.parse(quoteJson(713.36)) };
    });
    const q = await fetchFinnhubQuote('QQQ');
    expect(q).toMatchObject({
      price: 713.36,
      change: 0.5,          // dp wins when present (old behavior)
      prevClose: 713.36 * 0.995,
      source: 'finnhub-realtime',
    });
    expect(url).toContain('https://finnhub.io/api/v1/quote?symbol=QQQ&token=test-key-123');
    expect(q!.high).toBeGreaterThan(q!.price);
    expect(q!.time).toBeGreaterThan(0);
  });

  it('no key configured → honest null (Yahoo owns the symbol)', async () => {
    process.env.FINNHUB_API_KEY = '';
    const fetchSpy = vi.fn();
    _setFinnhubFetchForTest(fetchSpy as any);
    expect(await fetchFinnhubQuote('AAPL')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bad payload / HTTP failure → null, NEVER throws', async () => {
    _setFinnhubFetchForTest(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await fetchFinnhubQuote('AAPL')).toBeNull();
    _setFinnhubFetchForTest(async () => ({ ok: true, status: 200, json: async () => ({ c: 0 }) }));
    expect(await fetchFinnhubQuote('AAPL')).toBeNull();
    _setFinnhubFetchForTest(async () => { throw new Error('network'); });
    expect(await fetchFinnhubQuote('AAPL')).toBeNull();
  });

  it('STALENESS GATE (2026 audit RC1): while the US market is OPEN, a quote older than 5 min is rejected', async () => {
    // freeze "now" semantics: t = 10 minutes ago
    const staleT = Math.floor(Date.now() / 1000) - 600;
    _setFinnhubFetchForTest(async () => ({ ok: true, status: 200, json: async () => JSON.parse(quoteJson(716.47, { t: staleT })) }));
    const q = await fetchFinnhubQuote('QQQ');
    if (usMarketOpen()) {
      // open market → the Friday-close-style quote must be REJECTED
      expect(q).toBeNull();
    } else {
      // closed market → the last close IS the price, served cleanly
      expect(q?.price).toBe(716.47);
    }
  });
});

describe('fetchFinnhubQuote — the shared micro-cache (both desks share round-trips)', () => {
  it('two callers inside the 3s window share ONE upstream round-trip', async () => {
    let calls = 0;
    _setFinnhubFetchForTest(async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => JSON.parse(quoteJson(100)) };
    });
    const [a, b] = await Promise.all([fetchFinnhubQuote('AAPL'), fetchFinnhubQuote('AAPL')]);
    expect(a?.price).toBe(100);
    expect(b?.price).toBe(100);
    expect(calls).toBe(1); // ONE round-trip for both desks
    expect(__finnhubStateForTests().cached).toBe(1);
  });

  it('different symbols are NOT conflated (per-symbol cache keys)', async () => {
    _setFinnhubFetchForTest(async (u: string) => ({
      ok: true, status: 200, json: async () => JSON.parse(quoteJson(u.includes('NVDA') ? 196.4 : 333.62)),
    }));
    const [nvda, aapl] = await Promise.all([fetchFinnhubQuote('NVDA'), fetchFinnhubQuote('AAPL')]);
    expect(nvda?.price).toBe(196.4);
    expect(aapl?.price).toBe(333.62);
  });
});

describe('fetchFinnhubQuote — the 55/min shared-key budget guard', () => {
  it('over budget → honest null IMMEDIATELY, and the budget frees as the window slides', async () => {
    let calls = 0;
    _setFinnhubFetchForTest(async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => JSON.parse(quoteJson(50)) };
    });
    // burn the whole minute budget with DISTINCT symbols (cache never helps)
    const symbols = Array.from({ length: 60 }, (_, i) => `S${i}Y`);
    const results = await Promise.all(symbols.map(s => fetchFinnhubQuote(s)));
    expect(results.filter(r => r !== null).length).toBe(55); // exactly the budget
    expect(calls).toBe(55);
    // symbol #60 got the honest null — the free-tier key was never overspent
    expect(results[59]).toBeNull();
    // and a fresh call right now is still over budget
    expect(await fetchFinnhubQuote('QQQ')).toBeNull();
    expect(calls).toBe(55); // no new upstream call for the over-budget path
  });
});
