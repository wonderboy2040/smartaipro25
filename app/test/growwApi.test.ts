// ============================================================
// test/growwApi.test.ts — v21.6 the OFFICIAL Groww Trading-API tier
// contract: token checksum flow, batched 1s LTP, breaker, enrichment.
//
// WHAT THIS LOCKS (docs-verified contract, groww.in/trade-api/docs):
//   • token = POST /v1/token/api/access {key_type:'approval', checksum,
//     timestamp} with Authorization: Bearer <API_KEY>; checksum =
//     SHA256(secret + epochSeconds) — token cached ~a day, refreshed at
//     ~05:00 IST before the 06:00 expiry
//   • LTP = GET /v1/live-data/ltp?segment=CASH&exchange_symbols=NSE_A,NSE_B
//     → payload {"NSE_A": 123.4, ...} — ≤50 symbols per call, rate class
//     10 req/s + 300/min
//   • 401 anywhere → token refresh ONCE + retry (expired-token self-heal)
//   • persistent failures → 5-min circuit breaker with INSTANT empty maps
//     (public tier in growwQuote carries India meanwhile)
//   • quote = GET /v1/live-data/quote?exchange=NSE&segment=CASH&trading_symbol=X
//     → last_price + the loose "{open:…,high:…}" ohlc STRING
//
// Hermetic: fetch injected; fake timers; env set BEFORE the dynamic
// import (the module reads keys once at import).
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const KEY = 'test_groww_key_123';
const SECRET = 'test_groww_secret_456';

function tokenOk(jwt = 'jwt.tok.en') {
  return { ok: true, json: async () => ({ token: jwt, tokenRefId: 'r1', isActive: true }) };
}
function ltpOk(map) {
  return { ok: true, json: async () => ({ status: 'SUCCESS', payload: map }) };
}

describe('growwApi — unarmed (no keys) = inert', () => {
  let mod;
  beforeEach(async () => {
    delete process.env.GROWW_API_KEY;
    delete process.env.GROWW_API_SECRET;
    delete process.env.GROWW_API;
    vi.resetModules();
    mod = await import('../server/ai/growwApi.js');
    mod._resetGrowwApiForTest();
  });
  afterEach(() => { mod?._resetGrowwApiForTest(); });

  it('growwApiArmed() is false and LTP resolves an EMPTY map with zero upstream', async () => {
    const fetchMock = vi.fn();
    mod._setGrowwApiFetchForTest(fetchMock);
    expect(mod.growwApiArmed()).toBe(false);
    const out = await mod.growwApiLtp(['RELIANCE', 'TCS']);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await mod.growwApiQuote('RELIANCE')).toBeNull();
  });

  it('status reports armed:false, hasKey:false — /api/health stays honest', () => {
    const st = mod.growwApiStatus();
    expect(st.armed).toBe(false);
    expect(st.hasKey).toBe(false);
    expect(st.token).toBe(false);
  });
});

describe('growwApi — armed tier (token + batched LTP)', () => {
  let mod;
  let fetchMock;
  let calls;
  beforeEach(async () => {
    vi.useFakeTimers();
    process.env.GROWW_API_KEY = KEY;
    process.env.GROWW_API_SECRET = SECRET;
    process.env.GROWW_API = '1';
    vi.resetModules();
    mod = await import('../server/ai/growwApi.js');
    mod._resetGrowwApiForTest();
    calls = [];
    fetchMock = vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('/v1/token/api/access')) return tokenOk();
      if (String(url).includes('/v1/live-data/ltp')) {
        return ltpOk({ NSE_RELIANCE: 2925.5, NSE_TCS: 3850.25 });
      }
      if (String(url).includes('/v1/live-data/quote')) {
        return {
          ok: true,
          json: async () => ({
            status: 'SUCCESS',
            payload: {
              last_price: 2925.5, day_change_perc: 0.43, volume: 12345,
              last_trade_time: 1760000000000, upper_circuit_limit: 3050, lower_circuit_limit: 2800,
              ohlc: '{open: 2915.00,high: 2940.10,low: 2905.00,close: 2913.10}',
            },
          }),
        };
      }
      return { ok: false, status: 404 };
    });
    mod._setGrowwApiFetchForTest(fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    mod?._resetGrowwApiForTest();
    delete process.env.GROWW_API_KEY;
    delete process.env.GROWW_API_SECRET;
    delete process.env.GROWW_API;
  });

  it('fetches ONE token then ONE batched LTP call; parses NSE_ prefixed payload', async () => {
    const out = await mod.growwApiLtp(['RELIANCE', 'TCS']);
    expect(out.get('RELIANCE')).toBe(2925.5);
    expect(out.get('TCS')).toBe(3850.25);
    const tokenCall = calls.find(c => c.url.includes('/v1/token/api/access'));
    const ltpCall = calls.find(c => c.url.includes('/v1/live-data/ltp'));
    expect(tokenCall).toBeTruthy();
    expect(ltpCall).toBeTruthy();
    // documented request shape
    expect(ltpCall.url).toContain('segment=CASH');
    expect(ltpCall.url).toContain('NSE_RELIANCE');
    expect(ltpCall.url).toContain('NSE_TCS');
    expect(tokenCall.opts.headers['Authorization']).toBe(`Bearer ${KEY}`); // token call auth = API key
    expect(tokenCall.opts.method).toBe('POST');
    const body = JSON.parse(tokenCall.opts.body);
    expect(body.key_type).toBe('approval');
    expect(body.timestamp).toMatch(/^\d{10}$/);
    // checksum = SHA256(secret + timestamp) hex
    const { createHash } = await import('node:crypto');
    const expectSum = createHash('sha256').update(SECRET + body.timestamp, 'utf8').digest('hex');
    expect(body.checksum).toBe(expectSum);
  });

  it('LTP call uses the SERVED jwt as Bearer (API key only on the token call)', async () => {
    await mod.growwApiLtp(['RELIANCE']);
    const tokenCall = calls.find(c => c.url.includes('/v1/token/api/access'));
    const ltpCall = calls.find(c => c.url.includes('/v1/live-data/ltp'));
    expect(ltpCall.opts.headers['Authorization']).toBe('Bearer jwt.tok.en');
    expect(ltpCall.opts.headers['X-API-VERSION']).toBe('1.0');
    expect(tokenCall.opts.headers['X-API-VERSION']).toBe('1.0');
  });

  it('token is CACHED — a second LTP round (post-cache-window) re-fetches LTP but NOT the token', async () => {
    await mod.growwApiLtp(['RELIANCE']);
    await vi.advanceTimersByTimeAsync(1200); // 1s LTP cache expires
    await mod.growwApiLtp(['RELIANCE']);
    const tokenCalls = calls.filter(c => c.url.includes('/v1/token/api/access'));
    const ltpCalls = calls.filter(c => c.url.includes('/v1/live-data/ltp'));
    expect(tokenCalls).toHaveLength(1);
    expect(ltpCalls).toHaveLength(2);
  });

  it('1s cache window: N concurrent consumers ride ONE LTP round (in-flight dedupe)', async () => {
    const [a, b, c] = await Promise.all([
      mod.growwApiLtp(['RELIANCE']), mod.growwApiLtp(['RELIANCE']), mod.growwApiLtp(['RELIANCE']),
    ]);
    expect(a.get('RELIANCE')).toBe(2925.5);
    expect(c.get('RELIANCE')).toBe(2925.5);
    const ltpCalls = calls.filter(x => x.url.includes('/v1/live-data/ltp'));
    expect(ltpCalls).toHaveLength(1);
  });

  it('>50 symbols chunk into TWO LTP calls (documented per-call cap)', async () => {
    const syms = Array.from({ length: 60 }, (_, i) => `SYM${i}`);
    await mod.growwApiLtp(syms);
    const ltpCalls = calls.filter(c => c.url.includes('/v1/live-data/ltp'));
    expect(ltpCalls).toHaveLength(2);
  });

  it('symbols are normalized (.NS stripped / case / dupes)', async () => {
    await mod.growwApiLtp(['reliance.ns', 'RELIANCE', ' TCS ']);
    const ltpCall = calls.find(c => c.url.includes('/v1/live-data/ltp'));
    expect(ltpCall.url.match(/NSE_RELIANCE/g)).toHaveLength(1);
    expect(ltpCall.url).toContain('NSE_TCS');
  });

  it('401 → token refresh ONCE → retry succeeds (self-heal)', async () => {
    let ltp401 = true;
    const fetch2 = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/v1/token/api/access')) return tokenOk('jwt.fresh');
      if (u.includes('/v1/live-data/ltp')) {
        if (ltp401) { ltp401 = false; return { ok: false, status: 401 }; }
        return ltpOk({ NSE_RELIANCE: 2999 });
      }
      return { ok: false, status: 404 };
    });
    mod._setGrowwApiFetchForTest(fetch2);
    const out = await mod.growwApiLtp(['RELIANCE']);
    expect(out.get('RELIANCE')).toBe(2999);
    const tokenCalls = fetch2.mock.calls.filter(([u]) => String(u).includes('/v1/token/api/access'));
    expect(tokenCalls).toHaveLength(2); // initial + ONE refresh
  });

  it('upstream failure → EMPTY map, never throws; breaker after 3 fails → INSTANT empty (zero upstream)', async () => {
    const dead = vi.fn(async (url) => {
      if (String(url).includes('/v1/token/api/access')) return tokenOk();
      return { ok: false, status: 503 };
    });
    mod._setGrowwApiFetchForTest(dead);
    // 3 consecutive failed cycles arm the breaker
    for (let i = 0; i < 3; i++) {
      const out = await mod.growwApiLtp(['RELIANCE']);
      expect(out.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1100); // let the 1s cache window pass
    }
    expect(mod.growwApiStatus().breakerActive).toBe(true);
    const n = dead.mock.calls.length;
    const t0 = Date.now();
    const out = await mod.growwApiLtp(['RELIANCE']);
    expect(out.size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(50);   // INSTANT
    expect(dead.mock.calls.length).toBe(n);      // ZERO new upstream
  });

  it('full quote parse: last_price + loose ohlc STRING + circuits', async () => {
    const q = await mod.growwApiQuote('RELIANCE');
    expect(q).toBeTruthy();
    expect(q.price).toBe(2925.5);
    expect(q.change).toBe(0.43);
    expect(q.high).toBeCloseTo(2940.10, 4);
    expect(q.low).toBeCloseTo(2905.00, 4);
    expect(q.prevClose).toBeCloseTo(2913.10, 4);
    expect(q.volume).toBe(12345);
    expect(q.upperCircuit).toBe(3050);
    expect(q.lowerCircuit).toBe(2800);
    expect(q.source).toBe('groww-api');
    // 30s enrichment cache: second call rides it
    await mod.growwApiQuote('RELIANCE');
    const qCalls = calls.filter(c => c.url.includes('/v1/live-data/quote'));
    expect(qCalls).toHaveLength(1);
  });

  it('status: armed + token + fresh ltp after a successful round', async () => {
    await mod.growwApiLtp(['RELIANCE']);
    const st = mod.growwApiStatus();
    expect(st.armed).toBe(true);
    expect(st.hasKey).toBe(true);
    expect(st.token).toBe(true);
    expect(st.ltpFresh).toBe(true);
    expect(st.breakerActive).toBe(false);
  });
});

describe('growwApi — _parseOhlcString robustness (exported behaviour via quote)', () => {
  // The ohlc field is a loose "{open: 1,high: 2}" string on the wire —
  // malformed rows must degrade to undefined, never NaN/garbage.
  let mod;
  beforeEach(async () => {
    process.env.GROWW_API_KEY = KEY;
    process.env.GROWW_API_SECRET = SECRET;
    process.env.GROWW_API = '1';
    vi.resetModules();
    mod = await import('../server/ai/growwApi.js');
    mod._resetGrowwApiForTest();
  });
  afterEach(() => {
    mod?._resetGrowwApiForTest();
    delete process.env.GROWW_API_KEY;
    delete process.env.GROWW_API_SECRET;
    delete process.env.GROWW_API;
  });

  it('garbage ohlc string → undefined high/low/prevClose, price still served', async () => {
    mod._setGrowwApiFetchForTest(vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/v1/token/api/access')) return tokenOk();
      if (u.includes('/v1/live-data/quote')) {
        return { ok: true, json: async () => ({ status: 'SUCCESS', payload: { last_price: 100, ohlc: 'nonsense', volume: 1 } }) };
      }
      return { ok: false, status: 404 };
    }));
    const q = await mod.growwApiQuote('XYZ');
    expect(q.price).toBe(100);
    expect(q.high).toBe(100);   // degrades to price
    expect(q.prevClose).toBeUndefined();
  });
});
