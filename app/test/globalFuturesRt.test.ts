// ============================================================
// test/globalFuturesRt.test.ts — v10.7 COINDCX GLOBAL FUTURES
// RT-FEED PRICING (app-parity) regression suite.
//
// THE BUG (user report): the Global Equity SIM desk priced every
// symbol from Yahoo stock spot — AAPL showed 332.27 (frozen outside
// US market hours) while the CoinDCX app showed 333.62 USDC (the
// live 24/7 USDC-margined perp LTP). Positions P&L/SL/TP were
// frozen the same way.
//
// THE CONTRACT (locked here):
//   • fetchGlobalFuturesRt() tries every plausible USDC param shape —
//     v10.11 order: ARRAY-STYLE FIRST (CoinDCX's documented multi-value
//     convention on the derivatives family), then scalar, then the
//     param-less combined feed — and accepts a variant ONLY with >= 3
//     live B-<BASE>_USDC rows; the working variant is STICKY (no
//     re-probe per poll).
//   • total failure → v10.11 jittered exponential backoff: first
//     failure blacks out ~10s (10s base + 0-2s jitter), repeated
//     failures double it to a 40s CAP, and ONE success resets the
//     streak (the v10.6.1 wick lesson, now with fast healing).
//   • fetchGlobalQuotes() prices from the RT feed FIRST (source
//     'coindcx-usdc', feed's own 24h changePct), FINNHUB fills next
//     (source 'finnhub' — see globalFuturesFinnhubFallback.test.ts),
//     Yahoo is the FINAL fallback, SPACEX stays sim.
//   • buildGlobalCtxSync carries the honest priceSource.
//   • markets view exposes the CoinDCX pair (B-AAPL_USDC).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// refreshGlobalUniverse is NOT under test here — keep the universe seed-only
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false,
  coindcxPrivate: vi.fn(),
  coindcxPrivateGET: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
  fetchGlobalFuturesInstruments: vi.fn(async () => []),
}));

import {
  fetchGlobalFuturesRt, fetchGlobalQuotes, buildGlobalCtxSync,
  globalFuturesMarketsView, syntheticCandles,
  __resetGlobalForTests, __globalRtStateForTests,
} from '../server/ai/globalFutures.js';

const origFetch = globalThis.fetch;

// ---------------- payloads ----------------
const rtRow = (ls, pc = 0.4) => ({ ls, mp: ls * 0.9999, pc, h: ls * 1.01, l: ls * 0.99, v: 1_234_567 });
const RT_USDC_PAYLOAD = {
  ts: Date.now(),
  prices: {
    'B-AAPL_USDC': rtRow(333.62),
    'B-TSLA_USDC': rtRow(412.05),
    'B-NVDA_USDC': rtRow(196.4),
    'B-MSFT_USDC': rtRow(498.11),
  },
};
const RT_USDT_ONLY_PAYLOAD = {
  ts: Date.now(),
  prices: {
    'B-BTC_USDT': rtRow(77000.1),
    'B-ETH_USDT': rtRow(3900.2),
    'B-XAU_USDT': rtRow(4277.4),
  },
};
const yahooChart = (price, prev) => ({
  chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev } }] },
});

// ---------------- fetch routing ----------------
function routeFetch(handler: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> } | null) {
  globalThis.fetch = vi.fn(async (url: any) => {
    const r = handler(String(url));
    if (!r) return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    return { ...r, text: async () => JSON.stringify({}) };
  }) as any;
}

beforeEach(() => {
  __resetGlobalForTests();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

// ============================================================
// the RT probe itself
// ============================================================
describe('fetchGlobalFuturesRt — variant probing + validation', () => {
  it('prices from the CoinDCX USDC RT feed — the ARRAY-STYLE variant (documented convention) is probed FIRST', async () => {
    let arrayProbedFirst = false;
    let probeOrder: string[] = [];
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt') && u.includes('%5B%5D=USDC')) {
        probeOrder.push('array');
        arrayProbedFirst = probeOrder.length === 1;
        return { ok: true, status: 200, json: async () => RT_USDC_PAYLOAD };
      }
      if (u.includes('current_prices/futures/rt')) probeOrder.push('other');
      return null;
    });
    const rt = await fetchGlobalFuturesRt();
    expect(rt).toBeTruthy();
    expect(arrayProbedFirst).toBe(true); // array-style leads the round (v10.11 reorder)
    expect(probeOrder).toEqual(['array']);
    expect(rt.get('AAPL')).toMatchObject({ price: 333.62, source: 'coindcx-usdc', pair: 'B-AAPL_USDC' });
    expect(rt.get('AAPL').mark).toBeGreaterThan(333);
    expect(rt.get('AAPL').changePct).toBe(0.4);
  });

  it('falls through to the SCALAR param when the array one 403s, and the working variant is STICKY', async () => {
    let arrayCalls = 0;
    routeFetch((u) => {
      if (u.includes('%5B%5D=USDC')) {
        arrayCalls += 1;
        return { ok: false, status: 403, json: async () => ({}) };
      }
      if (u.includes('margin_currency_short_name=USDC')) { // scalar shape
        return { ok: true, status: 200, json: async () => RT_USDC_PAYLOAD };
      }
      return null;
    });
    const rt = await fetchGlobalFuturesRt();
    expect(rt?.get('TSLA')?.price).toBe(412.05);
    expect(arrayCalls).toBe(1);
    // next fresh probe reuses the sticky SCALAR variant — array never re-tried
    await fetchGlobalFuturesRt({ maxAgeMs: 0 });
    expect(arrayCalls).toBe(1);
  });

  it('a payload with ZERO USDC rows is REJECTED (a USDT-only response is not the global domain)', async () => {
    routeFetch(() => ({ ok: true, status: 200, json: async () => RT_USDT_ONLY_PAYLOAD }));
    const rt = await fetchGlobalFuturesRt();
    expect(rt).toBeNull();
    expect(__globalRtStateForTests().down).toBe(true); // negative cache armed
  });

  it('total failure arms the BACKOFF negative cache — ONE probe round, not one per poll', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => { calls += 1; return { ok: false, status: 403, json: async () => ({}), text: async () => '' }; }) as any;
    expect(await fetchGlobalFuturesRt()).toBeNull();
    const callsAfterProbe = calls;
    expect(callsAfterProbe).toBe(3); // array + scalar + combined = one full round
    expect(await fetchGlobalFuturesRt()).toBeNull();
    expect(await fetchGlobalFuturesRt()).toBeNull();
    expect(calls).toBe(callsAfterProbe); // backoff negative cache served both
    const st = __globalRtStateForTests();
    expect(st.failStreak).toBe(1);      // first failure → base blackout
  });

  it('v10.11 backoff: first failure blacks out ~10s (base + 0-2s jitter) — a WAF blip heals FAST', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' })) as any;
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      expect(await fetchGlobalFuturesRt()).toBeNull();
      const st = __globalRtStateForTests();
      expect(st.failStreak).toBe(1);
      expect(st.downUntil - t0).toBeGreaterThanOrEqual(10_000);
      expect(st.downUntil - t0).toBeLessThanOrEqual(12_000); // 10s base + ≤2s jitter
    } finally { nowSpy.mockRestore(); }
  });

  it('v10.11 backoff: repeated failures DOUBLE the blackout (10s→20s→40s) and CAP at 40s', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' })) as any;
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    let fake = t0;
    nowSpy.mockImplementation(() => fake);
    try {
      await fetchGlobalFuturesRt({ maxAgeMs: 0 });            // fail 1 @ t0 → ~10s
      expect(__globalRtStateForTests().failStreak).toBe(1);
      fake = t0 + 13_000;                                      // past blackout #1
      await fetchGlobalFuturesRt({ maxAgeMs: 0 });            // fail 2 → ~20s
      let st = __globalRtStateForTests();
      expect(st.failStreak).toBe(2);
      expect(st.downUntil - fake).toBeGreaterThanOrEqual(20_000);
      expect(st.downUntil - fake).toBeLessThanOrEqual(22_000);
      fake = t0 + 35_000;                                      // past blackout #2
      await fetchGlobalFuturesRt({ maxAgeMs: 0 });            // fail 3 → 40s (the cap)
      st = __globalRtStateForTests();
      expect(st.failStreak).toBe(3);
      expect(st.downUntil - fake).toBeGreaterThanOrEqual(40_000);
      expect(st.downUntil - fake).toBeLessThanOrEqual(42_000);
      fake = t0 + 78_000;                                      // past blackout #3
      await fetchGlobalFuturesRt({ maxAgeMs: 0 });            // fail 4 → STILL 40s (capped)
      st = __globalRtStateForTests();
      expect(st.failStreak).toBe(4);
      expect(st.downUntil - fake).toBeGreaterThanOrEqual(40_000);
      expect(st.downUntil - fake).toBeLessThanOrEqual(42_000);
    } finally { nowSpy.mockRestore(); }
  });

  it('v10.11 backoff: ONE success fully heals the streak — the next failure is back at the 10s base', async () => {
    const fail = { ok: false, status: 403, json: async () => ({}), text: async () => '' };
    const succeed = { ok: true, status: 200, json: async () => RT_USDC_PAYLOAD };
    let mode: 'fail' | 'succeed' = 'fail';
    globalThis.fetch = vi.fn(async () => (mode === 'fail' ? fail : succeed)) as any;
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    let fake = t0;
    nowSpy.mockImplementation(() => fake);
    try {
      await fetchGlobalFuturesRt({ maxAgeMs: 0 });            // fail 1 → ~10s
      expect(__globalRtStateForTests().failStreak).toBe(1);
      fake = t0 + 13_000;
      mode = 'succeed';
      const rt = await fetchGlobalFuturesRt({ maxAgeMs: 0 }); // SUCCESS → streak reset
      expect(rt?.get('AAPL')?.price).toBe(333.62);
      expect(__globalRtStateForTests().failStreak).toBe(0);
      fake = t0 + 20_000;                                      // beyond the 5s positive cache
      mode = 'fail';
      await fetchGlobalFuturesRt({ maxAgeMs: 0 });            // fail again → BASE again
      const st = __globalRtStateForTests();
      expect(st.failStreak).toBe(1);                          // not 2 — the success healed it
      expect(st.downUntil - fake).toBeGreaterThanOrEqual(10_000);
      expect(st.downUntil - fake).toBeLessThanOrEqual(12_000);
    } finally { nowSpy.mockRestore(); }
  });

  it('dark rows (ls=0) are skipped — illiquid USDC perps never zero a price', async () => {
    const payload = { ts: Date.now(), prices: {
      'B-AAPL_USDC': rtRow(333.62),
      'B-TSLA_USDC': { ...rtRow(0), ls: 0 },
      'B-NVDA_USDC': rtRow(196.4),
      'B-MSFT_USDC': rtRow(498.11),
    } };
    routeFetch((u) => (u.includes('current_prices/futures/rt') ? { ok: true, status: 200, json: async () => payload } : null));
    const rt = await fetchGlobalFuturesRt();
    expect(rt?.has('TSLA')).toBe(false);
    expect(rt?.get('AAPL')?.price).toBe(333.62);
  });
});

// ============================================================
// the quotes merge — RT first, Yahoo fills gaps, sim stays sim
// ============================================================
describe('fetchGlobalQuotes — CoinDCX RT wins, Yahoo fills ONLY the gaps', () => {
  it('RT-covered symbols price from the feed; uncovered ones from Yahoo; SPACEX stays sim', async () => {
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt') && u.includes('USDC')) {
        // feed covers AAPL + NVDA only
        return { ok: true, status: 200, json: async () => ({ ts: Date.now(), prices: {
          'B-AAPL_USDC': rtRow(333.62), 'B-NVDA_USDC': rtRow(196.4), 'B-TSLA_USDC': rtRow(412.05),
        } }) };
      }
      if (u.includes('query1.finance.yahoo.com')) {
        const m = u.match(/chart\/([A-Z0-9.-]+)\?/);
        const sym = m ? m[1] : null;
        // Yahoo's AAPL is STALE (332.27 — the bug's number): must NOT win
        if (sym === 'AAPL') return { ok: true, status: 200, json: async () => yahooChart(332.27, 330) };
        return { ok: true, status: 200, json: async () => yahooChart(100, 99) };
      }
      return null;
    });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    // the headline case: AAPL = the CoinDCX app's LTP, not Yahoo's stale spot
    expect(q.get('AAPL')).toMatchObject({ price: 333.62, source: 'coindcx-usdc', sim: false });
    expect(q.get('AAPL').dcxPair).toBe('B-AAPL_USDC');
    // uncovered symbol → honest Yahoo fallback
    expect(q.get('MU')).toMatchObject({ source: 'yahoo', sim: false });
    expect(q.get('MU').price).toBe(100);
    // SPACEX stays the labeled sim
    expect(q.get('SPACEX')).toMatchObject({ source: 'sim', sim: true });
  });

  it('feed DOWN → full Yahoo fallback (the desk never goes dark)', async () => {
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt')) return { ok: false, status: 403, json: async () => ({}) };
      if (u.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(227.5, 225) };
      }
      return null;
    });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    expect(q.get('AAPL')).toMatchObject({ price: 227.5, source: 'yahoo', sim: false });
    expect(q.size).toBeGreaterThan(10);
  });

  it('buildGlobalCtxSync carries the honest per-source priceSource', () => {
    const candles = syntheticCandles('SPACEX');
    const rtx = buildGlobalCtxSync('NVDA', { price: 196.4, changePct: 0.4, source: 'coindcx-usdc', sim: false }, candles, {});
    expect(rtx.priceSource).toBe('coindcx-usdc');
    expect(rtx.ltp).toBe(196.4);
    const yh = buildGlobalCtxSync('NVDA', { price: 196.1, changePct: 0.3, sim: false }, candles, {});
    expect(yh.priceSource).toBe('yahoo-1h');
    const sim = buildGlobalCtxSync('SPACEX', { price: 185, sim: true }, candles, {});
    expect(sim.priceSource).toBe('synthetic-sim');
  });

  it('markets view exposes the CoinDCX pair on RT-priced rows', async () => {
    routeFetch((u) => {
      if (u.includes('current_prices/futures/rt') && u.includes('USDC')) {
        return { ok: true, status: 200, json: async () => RT_USDC_PAYLOAD };
      }
      if (u.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => yahooChart(100, 99) };
      }
      return null;
    });
    const view = await globalFuturesMarketsView();
    const aapl = view.markets.find((m: any) => m.symbol === 'AAPL');
    expect(aapl.last).toBe(333.62);
    expect(aapl.dcxPair).toBe('B-AAPL_USDC');
    expect(aapl.source).toBe('coindcx-usdc');
    // Yahoo-priced row keeps dcxPair null (never invented)
    const mu = view.markets.find((m: any) => m.symbol === 'MU');
    expect(mu.source).toBe('yahoo');
    expect(mu.dcxPair).toBeNull();
  });
});

// ============================================================
// single-flight — concurrent callers share ONE probe
// ============================================================
describe('fetchGlobalFuturesRt — single-flight', () => {
  it('concurrent callers share one probe round (no fetch stampede)', async () => {
    let inflight = 0, peak = 0;
    globalThis.fetch = vi.fn(async (url: any) => {
      inflight += 1; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      const u = String(url);
      if (u.includes('margin_currency_short_name=USDC') && !u.includes('%5B')) {
        return { ok: true, status: 200, json: async () => RT_USDC_PAYLOAD };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as any;
    const [a, b, c] = await Promise.all([
      fetchGlobalFuturesRt({ maxAgeMs: 0 }),
      fetchGlobalFuturesRt({ maxAgeMs: 0 }),
      fetchGlobalFuturesRt({ maxAgeMs: 0 }),
    ]);
    expect(a?.get('AAPL')?.price).toBe(333.62);
    expect(b?.get('AAPL')?.price).toBe(333.62);
    expect(c?.get('AAPL')?.price).toBe(333.62);
    expect(peak).toBe(1); // ONE request in flight at a time — shared probe
  });
});

// ============================================================
// the probe deadline — a HUNG upstream must never stall the caller
// ============================================================
describe('fetchGlobalFuturesRt — probe deadline (positions realtime guarantee)', () => {
  it('a hanging feed resolves null within the deadline budget, then negative-caches', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => { /* never resolves — worst case */ })) as any;
    const t0 = Date.now();
    const rt = await fetchGlobalFuturesRt({ maxAgeMs: 0 });
    const took = Date.now() - t0;
    expect(rt).toBeNull();
    expect(took).toBeLessThan(10_000);   // ≤6s deadline (+ CI slack)
    expect(took).toBeGreaterThanOrEqual(4_000); // the deadline did the cutting, not luck
    // the negative cache is armed — the next call is INSTANT null
    const t1 = Date.now();
    expect(await fetchGlobalFuturesRt()).toBeNull();
    expect(Date.now() - t1).toBeLessThan(500);
  }, 20_000);
});
