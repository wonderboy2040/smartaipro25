// ============================================================
// test/intradayTvChunking.test.ts — v10.17 TV BATCH CHUNKING
// ------------------------------------------------------------
// The tiered full-universe scan hands the intraday engine 100+
// symbols (200+ NSE+BSE tickers). Locks: (a) big universes are
// chunked at ≤100 tickers per scanner request, (b) small universes
// still ride ONE request (legacy behavior unchanged), (c) results
// merge first-exchange-wins across chunks, (d) a dead chunk costs
// only its own slice (allSettled containment).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchIntradayDataBatch } from '../server/intraday/engine.js';

const tvOk = (tickers) => ({
  ok: true,
  json: async () => ({
    data: tickers.map(t => ({ s: t, d: Array(24).fill(10) })),
  }),
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchIntradayDataBatch — India TV chunking (v10.17)', () => {
  it('big universe (150 symbols → 300 tickers) → 3 chunked requests of ≤100 tickers, all rows merged', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const tickers = body.symbols.tickers;
      requests.push(tickers.length);
      return tvOk(tickers);
    }));
    const syms = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const [tv] = await fetchIntradayDataBatch(syms, null);
    expect(requests).toEqual([100, 100, 100]);
    expect(Object.keys(tv)).toHaveLength(150);      // every symbol resolved
    expect(tv.S0.exchange).toBe('NSE');              // first-exchange-wins
    expect(tv.S149).toBeDefined();
  });

  it('small universe (≤50 symbols) → ONE request with the full ticker list (legacy byte-parity)', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body.symbols.tickers.length);
      return tvOk(body.symbols.tickers);
    }));
    const syms = Array.from({ length: 50 }, (_, i) => `S${i}`);
    const [tv] = await fetchIntradayDataBatch(syms, null);
    expect(requests).toEqual([100]);                 // 50 symbols × NSE+BSE = 100 tickers, one shot
    expect(Object.keys(tv)).toHaveLength(50);
  });

  it('a dead chunk costs only its slice — the rest of the universe still lands', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const tickers = body.symbols.tickers;
      requests.push(tickers.length);
      // kill the SECOND chunk (returns nothing usable on all retries)
      if (requests.length === 2) return { ok: false, status: 500, json: async () => ({}) };
      return tvOk(tickers);
    }));
    const syms = Array.from({ length: 60 }, (_, i) => `S${i}`); // 120 tickers → 2 chunks
    const [tv] = await fetchIntradayDataBatch(syms, null);
    // chunk 1 covers S0..S49 (first 100 tickers = 50 symbols), chunk 2 dead
    expect(Object.keys(tv).length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(tv).length).toBeLessThanOrEqual(60);
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });
});
