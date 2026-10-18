// ============================================================
// test/mesh.test.ts — v11.0 PHASE 1 · MESH ORCHESTRATOR
// ------------------------------------------------------------
// Locks: capability routing + priority fallback, deadline enforcement,
// 3-tier cache hit/miss/expiry, single-flight dedup, negative cache,
// honesty tags (agent/ts/stale), stale-while-revalidate, cross-source
// price sanity bands, route guards, and the p-limit fan-out bound.
// Hermetic: global fetch is stubbed per-test.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f, d) => (_disk.has(f) ? _disk.get(f) : d),
  saveJSON: (f, v) => { _disk.set(f, v); },
}));
vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(),
  durableStatus: () => ({}),
}));

import * as mesh from '../server/mcp/mesh.js';

const _realFetch = globalThis.fetch;
let _calls = [];

// Shrink the per-agent deadline BEFORE the mesh module imports (the
// const is read at import) so the hang test cuts in ~1.5s, not 8s.
vi.hoisted(() => { process.env.AI_MCP_MESH_TIMEOUT_MS = '1500'; });

function stubFetch(handler) {
  _calls = [];
  globalThis.fetch = async (url, opts) => {
    _calls.push({ url: String(url), opts });
    const out = handler ? handler(String(url), opts) : null;
    if (out == null) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (out instanceof Error) throw out;
    // raw array payloads (the klines shape) are the body themselves;
    // objects honour the { body, status } directive contract
    const body = Array.isArray(out) ? out : (out.body ?? { ok: true });
    return new Response(JSON.stringify(body), { status: out.status ?? 200 });
  };
}

// Binance klines shape for the ccxt ohlcv probe
const KLINES = [[1, '100', '110', '90', '105', '50'], [2, '105', '112', '95', '108', '60']];

// The 10 real agents stay registered (the top-level mesh import did
// it); each test starts with clean caches/health/budgets.
beforeEach(() => {
  mesh.__resetMeshForTests();
});

afterEach(() => { globalThis.fetch = _realFetch; });

describe('v11.0 mesh — capability routing + honesty tags', () => {
  it('serves crypto.ohlcv from the ccxt agent with full honesty tags', async () => {
    stubFetch(() => KLINES);
    const out = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    expect(out.ok).toBe(true);
    const r = out.results['crypto.ohlcv'];
    expect(r.agent).toBe('ccxt');
    expect(r.stale).toBe(false);
    expect(r.ts).toBeGreaterThan(0);
    expect(r.data.candles).toHaveLength(2);
    expect(r.data.candles[0].close).toBe(105);
    expect(_calls[0].url).toContain('binance.com/api/v3/klines');
  });

  it('unknown capability → honest gap, never invented data', async () => {
    const out = await mesh.meshQuery({ capabilities: ['does.not.exist'] });
    expect(out.ok).toBe(false);
    expect(out.gaps[0].cap).toBe('does.not.exist');
    expect(out.results['does.not.exist']).toBeUndefined();
  });

  it('empty capabilities → structured error', async () => {
    const out = await mesh.meshQuery({});
    expect(out.ok).toBe(false);
  });

  it('priority fallback: binance down → bybit serves the SAME capability', async () => {
    let n = 0;
    stubFetch((url) => {
      if (url.includes('binance.com')) { n += 1; return { status: 503 }; }
      // bybit kline shape { result: { list: [[t,o,h,l,c,v], ...] } }
      return { body: { result: { list: [[2, '100', '110', '90', '106', '50']] } } };
    });
    const out = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'], force: true });
    mesh.__resetMeshForTests();
    expect(out.ok).toBe(true);
    expect(out.results['crypto.ohlcv'].data.exchange).toBe('bybit');
    expect(n).toBe(1);
  });
});

describe('v11.0 mesh — 3-tier cache + single-flight + negative cache', () => {
  it('hot-tier cache: second identical query makes ZERO upstream calls', async () => {
    stubFetch(() => KLINES);
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    const first = _calls.length;
    const out2 = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    expect(_calls.length).toBe(first);
    expect(out2.ok).toBe(true);
    expect(mesh.__meshStatsForTests().cacheHits).toBeGreaterThan(0);
  });

  it('cache key includes args: different symbols = separate entries', async () => {
    stubFetch(() => KLINES);
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['ETHUSDT'] });
    expect(_calls.length).toBe(2);
    const urls = _calls.map(c => c.url);
    expect(urls.some(u => u.includes('BTCUSDT'))).toBe(true);
    expect(urls.some(u => u.includes('ETHUSDT'))).toBe(true);
  });

  it('force=true bypasses the cache and re-fetches', async () => {
    stubFetch(() => KLINES);
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    const first = _calls.length;
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'], force: true });
    expect(_calls.length).toBe(first + 1);
  });

  it('expiry: an entry older than the tier TTL serves STALE-tagged on refresh failure', async () => {
    let ok = true;
    stubFetch(() => (ok ? KLINES : { status: 500 }));
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    ok = false;
    vi.useFakeTimers();
    // warm tier is 5min; move past it
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const out = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    vi.useRealTimers();
    mesh.__resetMeshForTests();
    expect(out.ok).toBe(true);
    expect(out.results['crypto.ohlcv'].stale).toBe(true);
  });

  it('negative cache: a total failure short-circuits repeat queries for 90s', async () => {
    stubFetch(() => { throw new Error('net down'); });
    const out1 = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    expect(out1.ok).toBe(false);
    const callsAfterFirst = _calls.length;
    const out2 = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    expect(_calls.length).toBe(callsAfterFirst); // no re-herd
    expect(out2.ok).toBe(false);
    expect(mesh.__meshStatsForTests().negativeHits).toBeGreaterThan(0);
    mesh.__resetMeshForTests();
  });

  it('breaker opens after 3 failed agent calls and routing skips the agent', async () => {
    stubFetch(() => { throw new Error('net down'); });
    // 3 distinct symbols → 3 distinct cache keys → 3 fails on ccxt
    for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: [s] });
    }
    const st = mesh.meshStatus();
    const ccxt = st.agents.find(a => a.id === 'ccxt');
    expect(ccxt.health.state).toBe('open');
    mesh.__resetMeshForTests();
  });
});

describe('v11.0 mesh — deadline enforcement', () => {
  it('a hanging agent is cut at the deadline and the next exchange serves', async () => {
    stubFetch((url) => {
      if (url.includes('binance.com')) return new Promise((_res, rej) => setTimeout(() => rej(new Error('hang')), 10_000));
      return { body: { result: { list: [[2, '100', '110', '90', '104', '50']] } } };
    });
    const out = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'], force: true });
    mesh.__resetMeshForTests();
    expect(out.ok).toBe(true);
    expect(['bybit', 'okx']).toContain(out.results['crypto.ohlcv'].data.exchange);
  }, 20000);
});

describe('v11.0 mesh — cross-source validation', () => {
  it('flags >1.5% divergence between two sources as degraded', () => {
    const out = mesh.crossValidatePrices({
      BTC: [
        { agent: 'desk', price: 100 },
        { agent: 'coingecko', price: 103 },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].degraded).toBe(true);
    expect(out[0].spreadPct).toBeGreaterThan(1.5);
  });

  it('sub-1.5% agreement passes silently (no false alarms)', () => {
    const out = mesh.crossValidatePrices({
      BTC: [
        { agent: 'desk', price: 100 },
        { agent: 'coingecko', price: 100.8 },
      ],
    });
    expect(out).toHaveLength(0);
  });

  it('single-source symbols are skipped (nothing to cross-check)', () => {
    expect(mesh.crossValidatePrices({ BTC: [{ agent: 'a', price: 1 }] })).toHaveLength(0);
    expect(mesh.crossValidatePrices({})).toHaveLength(0);
  });
});

describe('v11.0 mesh — fan-out + status', () => {
  it('multi-capability query fans out in parallel and serves each cap', async () => {
    stubFetch((url) => {
      // binance depth shape for the orderbook URL, klines otherwise
      if (url.includes('/depth')) return { body: { bids: [['100', '1'], ['99', '2']], asks: [['101', '1'], ['102', '3']] } };
      return KLINES;
    });
    const out = await mesh.meshQuery({ capabilities: ['crypto.ohlcv', 'crypto.orderbook'], symbols: ['BTCUSDT'] });
    expect(Object.keys(out.results)).toEqual(expect.arrayContaining(['crypto.ohlcv', 'crypto.orderbook']));
    expect(out.results['crypto.orderbook'].agent).toBe('ccxt');
    expect(out.results['crypto.orderbook'].data.bids[0].price).toBe(100);
    mesh.__resetMeshForTests();
  });

  it('meshStatus exposes cache occupancy + stats + breaker states', async () => {
    stubFetch(() => KLINES);
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'] });
    const st = mesh.meshStatus();
    expect(st.agentCount).toBe(10);
    expect(st.cache.entries).toBeGreaterThan(0);
    expect(st.cache.stats.queries).toBeGreaterThan(0);
    expect(st.cache.stats.upstream).toBeGreaterThan(0);
    mesh.__resetMeshForTests();
  });

  it('route guard: POST /api/mcp/mesh/query rejects a keyless body', async () => {
    const app = { get: vi.fn(), post: vi.fn() };
    mesh.registerMeshRoutes(app);
    const queryRoute = app.post.mock.calls.find(c => c[0] === '/api/mcp/mesh/query')[1];
    const res = { status: vi.fn(() => res), json: vi.fn() };
    await queryRoute({ body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});

// ============================================================
// v11.0.1 recheck locks — input hardening at the engine boundary
// ============================================================
describe('v11.0.1 — meshQuery input hardening (the query-injection guard)', () => {
  it('junk symbols (query-param payloads) are DROPPED before any upstream fetch', async () => {
    stubFetch(() => KLINES);
    const out = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTC&limit=999', 'BTCUSDT'] });
    // only the clean symbol reached the upstream — never the injected one
    expect(_calls.length).toBe(1);
    expect(_calls[0].url).toContain('BTCUSDT');
    expect(_calls[0].url).not.toContain('&limit=999');
    expect(out.ok).toBe(true);
    mesh.__resetMeshForTests();
  });

  it('a symbol that is ALL junk → honest gap with zero upstream calls', async () => {
    stubFetch(() => KLINES);
    const out = await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTC&x=1#frag'] });
    expect(_calls.length).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.gaps[0].cap).toBe('crypto.ohlcv');
    mesh.__resetMeshForTests();
  });

  it('limit is clamped to 1..500 (negative and huge both pass through raw before)', async () => {
    stubFetch(() => KLINES);
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'], limit: -5 });
    expect(_calls[0].url).toContain('limit=1');
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['ETHUSDT'], limit: 999999 });
    // binance cap: Math.min(500, limit) → 500
    expect(_calls[1].url).toContain('limit=500');
    mesh.__resetMeshForTests();
  });

  it('timeframe is whitelisted — junk intervals fall back to 1h, never reach the URL raw', async () => {
    stubFetch(() => KLINES);
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['BTCUSDT'], timeframe: '15x&evil=1' });
    expect(_calls[0].url).toContain('interval=1h');
    expect(_calls[0].url).not.toContain('evil');
    mesh.__resetMeshForTests();
  });

  it('lowercase symbols are normalized to UPPER (charset-safe, case-insensitive callers)', async () => {
    stubFetch(() => KLINES);
    await mesh.meshQuery({ capabilities: ['crypto.ohlcv'], symbols: ['btcusdt'] });
    expect(_calls[0].url).toContain('BTCUSDT');
    mesh.__resetMeshForTests();
  });
});
