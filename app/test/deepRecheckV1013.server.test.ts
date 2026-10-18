// ============================================================
// test/deepRecheckV1013.server.test.ts — v10.13 full-site deep
// recheck: the server-side fix contracts.
//
// LOCKED HERE:
//   1. growwQuote grossly-stale row guard (deep-recheck M-2 stream):
//      while the NSE window is OPEN, a lastTradeTime from BEFORE
//      today's 09:15 IST session (the observed garbage shape:
//      Nov-2023 rows served live) or an absurd future clock → the
//      row is REJECTED (null → quick-retry → honest Yahoo fallback
//      downstream). Same-session old timestamps stay ACCEPTED
//      (illiquid symbols still have an honest last-traded price),
//      and outside market hours nothing is gated (last close IS the
//      price).
//   2. growwQuote failure-map sweep (M-2): _failStreaks/_backoffUntil
//      are bounded — an anonymous caller enumerating random symbols
//      through the public /api/quote can no longer grow them forever.
//   3. intraday setScanSymbols per-market maps (M-4): an INDIA scan
//      no longer evicts the CRYPTO scanner's signal symbols (and
//      vice versa) — _watchSet unions both markets.
//   4. Static guards on server/index.js (routeMount.test.ts pattern —
//      the module has heavy boot side effects): the GLOBAL CSRF
//      discriminator, public-endpoint rate limits, the VITE_API_TOKEN
//      boot refusal, the global PIN-failure lockout, the err.status
//      middleware, graceful-shutdown drain, and the compat-proxy
//      max_tokens clamp.
// Hermetic: no network — fetch is an injected double.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// nseWindow is forced OPEN for the freshness-gate suites (the real module
// computes it from the wall clock; the gate itself is unit-locked instead).
vi.mock('../server/inStream.js', () => ({
  nseWindow: () => true,
}));

// ---------------- payloads ----------------
const growwRow = (over: Record<string, unknown> = {}) => ({
  ltp: 2925.5, dayChange: 12.5, dayChangePerc: 0.43, high: 2935.5,
  low: 2915.5, volume: 12345,
  lastTradeTime: Math.floor(Date.now() / 1000),
  ...over,
});

// ============================================================
// 1. growwQuote — grossly-stale row guard (NSE window OPEN)
// ============================================================
describe('growwQuote — v10.13 grossly-stale row guard (nseWindow OPEN)', () => {
  let gq: any;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    // Deterministic mid-session Monday: 2026-06-15 12:00 IST (06:30 UTC).
    vi.setSystemTime(new Date('2026-06-15T06:30:00Z'));
    gq = await import('../server/ai/growwQuote.js');
    gq.__resetGrowwForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    gq?.__resetGrowwForTests();
  });

  const quoteWith = (lastTradeTime: number) => ({
    ok: true,
    json: async () => growwRow({ lastTradeTime }),
  });

  it('lastTradeTime from BEFORE today\'s 09:15 IST open (the observed garbage shape) → rejected (null)', async () => {
    // 08:00 IST today — pre-session while the window is open = stale row
    gq._setGrowwFetchForTest(vi.fn(async () => quoteWith(Math.floor(new Date('2026-06-15T02:30:00Z').getTime() / 1000))));
    const p = gq.fetchGrowwNseQuote('RELIANCE');
    await vi.advanceTimersByTimeAsync(600); // ride the in-cycle retry sleep
    expect(await p).toBeNull();
  });

  it('lastTradeTime from a PREVIOUS DAY → rejected (the v10.12.1 Nov-2023 shape)', async () => {
    gq._setGrowwFetchForTest(vi.fn(async () => quoteWith(Math.floor(new Date('2025-11-20T10:00:00Z').getTime() / 1000))));
    const p = gq.fetchGrowwNseQuote('RELIANCE');
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();
  });

  it('absurd FUTURE clock (>60s ahead) → rejected', async () => {
    gq._setGrowwFetchForTest(vi.fn(async () => quoteWith(Math.floor(Date.now() / 1000) + 300)));
    const p = gq.fetchGrowwNseQuote('RELIANCE');
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();
  });

  it('same-session old timestamp (11:30 IST, illiquid-but-honest) → ACCEPTED', async () => {
    gq._setGrowwFetchForTest(vi.fn(async () => quoteWith(Math.floor(new Date('2026-06-15T06:00:00Z').getTime() / 1000))));
    const p = gq.fetchGrowwNseQuote('RELIANCE');
    await vi.advanceTimersByTimeAsync(0);
    const q = await p;
    expect(q).toBeTruthy();
    expect(q.price).toBe(2925.5);
    expect(q.source).toBe('groww-nse-realtime');
  });

  it('missing lastTradeTime → trusted (unchanged legacy behavior)', async () => {
    gq._setGrowwFetchForTest(vi.fn(async () => ({ ok: true, json: async () => growwRow({ lastTradeTime: undefined }) })));
    const q = await gq.fetchGrowwNseQuote('RELIANCE');
    expect(q).toBeTruthy();
  });
});

describe('growwQuote — v10.13 stale-row guard is INERT outside the NSE window', () => {
  let gq: any;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T06:30:00Z'));
    // Re-mock inStream with the window CLOSED for this suite (vi.mock above
    // is file-wide; override the implementation per-suite via doMock+import).
    vi.doMock('../server/inStream.js', () => ({ nseWindow: () => false }));
    gq = await import('../server/ai/growwQuote.js');
    gq.__resetGrowwForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    gq?.__resetGrowwForTests();
    vi.doUnmock('../server/inStream.js');
  });

  it('yesterday\'s lastTradeTime outside market hours → SERVED (last close IS the price)', async () => {
    gq._setGrowwFetchForTest(vi.fn(async () => ({
      ok: true,
      json: async () => growwRow({ lastTradeTime: Math.floor(new Date('2026-06-14T10:00:00Z').getTime() / 1000) }),
    })));
    const q = await gq.fetchGrowwNseQuote('RELIANCE');
    expect(q).toBeTruthy();
    expect(q.price).toBe(2925.5);
  });
});

// ============================================================
// 2. growwQuote — failure-map sweep (bounded memory)
// ============================================================
describe('growwQuote — v10.13 failure-map sweep (public /api/quote enumeration)', () => {
  let gq: any;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    gq = await import('../server/ai/growwQuote.js');
    gq.__resetGrowwForTests();
    // every upstream call fails instantly → each symbol's cycle = fail + retry
    gq._setGrowwFetchForTest(vi.fn(async () => { throw new Error('dark'); }));
  });
  afterEach(() => { vi.useRealTimers(); gq?.__resetGrowwForTests(); });

  it('>500 distinct failing symbols → the streak map is swept (bounded memory)', async () => {
    for (let i = 0; i < 505; i++) {
      const p = gq.fetchGrowwNseQuote(`SYM${i}`);
      await vi.advanceTimersByTimeAsync(600); // ride the retry sleep
      await p;
    }
    // the LAST symbols retain their fresh streak state…
    expect(gq.__growwStateForTests('SYM504').failStreak).toBe(1);
    // …but the early entries were swept once the map crossed the cap
    expect(gq.__growwStateForTests('SYM0').failStreak).toBe(0);
  });
});

// ============================================================
// 3. intraday — per-market scan sets (cross-market scans stop
//    evicting each other's quotes)
// ============================================================
vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));
vi.mock('../server/intraday/trackRecord.js', () => ({
  watcherSymbolsByMarket: vi.fn(() => ({ india: [], crypto: [] })),
}));

import { watchSetForTests as _wsft, setScanSymbols as _sss } from '../server/intraday/stream.js';

describe('intraday setScanSymbols — v10.13 per-market scan sets', () => {
  beforeEach(() => { _sss([]); });

  it('an INDIA scan no longer evicts the CRYPTO scan\'s symbols (the M-4 clobber)', () => {
    _sss(['BTC', 'ETH'], 'CRYPTO');
    _sss(['RELIANCE', 'SBIN'], 'INDIA'); // the clobber that used to wipe BTC/ETH
    const ws = _wsft();
    expect(ws.get('RELIANCE')).toBe('INDIA');
    expect(ws.get('SBIN')).toBe('INDIA');
    expect(ws.get('BTC')).toBe('CRYPTO'); // survived the India scan
    expect(ws.get('ETH')).toBe('CRYPTO');
  });

  it('a CRYPTO scan no longer evicts the INDIA scan\'s symbols', () => {
    _sss(['RELIANCE', 'TCS'], 'INDIA');
    _sss(['SOL'], 'CRYPTO'); // the reverse clobber
    const ws = _wsft();
    expect(ws.get('SOL')).toBe('CRYPTO');
    expect(ws.get('RELIANCE')).toBe('INDIA'); // survived the crypto scan
    expect(ws.get('TCS')).toBe('INDIA');
  });

  it('crypto-base stray inside an INDIA scan still routes to CRYPTO (legacy heuristic kept)', () => {
    _sss(['RELIANCE', 'BTC'], 'INDIA');
    const ws = _wsft();
    expect(ws.get('RELIANCE')).toBe('INDIA');
    expect(ws.get('BTC')).toBe('CRYPTO');
  });
});

// ============================================================
// 4. Static guards on server/index.js (routeMount.test.ts pattern)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const INDEX_PATH = path.resolve(__dirname, '..', 'server', 'index.js');
const indexSource = fs.readFileSync(INDEX_PATH, 'utf-8');
// v21.1.0 (Phase-3 split): auth system ab server/security/pinAuth.js me hai —
// static security assertions usi file se padhi jati hain.
const PINAUTH_PATH = path.resolve(__dirname, '..', 'server', 'security', 'pinAuth.js');
const pinAuthSource = fs.readFileSync(PINAUTH_PATH, 'utf-8');

describe('server/index.js — v10.13 static security guards', () => {
  it('the GLOBAL CSRF discriminator is mounted (cross-site + cookie + no Bearer → 403)', () => {
    expect(indexSource).toMatch(/sec-fetch-site.*cross-site/i);
    // the discriminator must check the session cookie before blocking
    expect(indexSource).toMatch(/parseCookie\(req\.headers\.cookie/);
    // and exempt login (no session exists yet — nothing to hijack)
    expect(indexSource).toMatch(/req\.path === '\/api\/auth\/login'/);
  });

  it('the CSRF middleware runs AFTER requireAuth and BEFORE the first route', () => {
    const authAt = indexSource.indexOf('app.use(requireAuth)');
    const csrfAt = indexSource.indexOf('app.use((req, res, next) => {', authAt);
    // v21.1.0: login route ab registerAuthRoutes(app, ...) se register hota hai —
    // isliye "first route" ab pehla direct app.<verb> registration hai CSRF ke baad.
    const registerAuthAt = indexSource.indexOf('registerAuthRoutes(app,');
    expect(authAt).toBeGreaterThan(-1);
    expect(csrfAt).toBeGreaterThan(authAt);
    expect(registerAuthAt).toBeGreaterThan(csrfAt);
  });

  it('public market-data endpoints carry per-IP rate limits (quote/chart/fundamentals)', () => {
    expect(indexSource).toMatch(/pubGuard\(req, res, QUOTE_RATE_10MIN\)/);
    expect(indexSource).toMatch(/pubGuard\(req, res, CHART_RATE_10MIN\)/);
    expect(indexSource).toMatch(/pubGuard\(req, res, FUND_RATE_10MIN\)/);
  });

  it('validateEnv REFUSES to boot when VITE_API_TOKEN === API_TOKEN (bundle-leak footgun)', () => {
    expect(indexSource).toMatch(/VITE_API_TOKEN === API_TOKEN/);
    expect(indexSource).toMatch(/Refusing to start due to configuration errors/);
  });

  it('the global PIN-failure lockout is wired (recordPinFail on bad PIN + pre-check)', () => {
    // v21.1.0: ye guards ab server/security/pinAuth.js me rehte hain (split).
    expect(pinAuthSource).toMatch(/function recordPinFail/);
    expect(pinAuthSource).toMatch(/function pinLockActive/);
    expect(pinAuthSource).toMatch(/recordPinFail\(\); \/\/ v10\.13/);
    expect(pinAuthSource).toMatch(/if \(pinLockActive\(\)\)/);
    // ...aur index.js unhe pinAuth module se import karta hai.
    expect(indexSource).toMatch(/from '\.\/security\/pinAuth\.js'/);
  });

  it('the terminal error middleware honors body-parser err.status (400 ≠ 500)', () => {
    expect(indexSource).toMatch(/Number\.isInteger\(err\?\.status\)/);
  });

  it('graceful shutdown drains the HTTP server before exit', () => {
    expect(indexSource).toMatch(/_httpServer\.close\(/);
    expect(indexSource).toMatch(/_httpServer = app\.listen/);
  });

  it('compat proxies clamp max_tokens / temperature and strip stream', () => {
    expect(indexSource).toMatch(/body\.max_tokens = Math\.min\(8192/);
    expect(indexSource).toMatch(/delete body\.stream/);
  });

  it('an India/crypto-only SSE session no longer opens an empty Finnhub socket', () => {
    expect(indexSource).toMatch(/if \(usSyms\.length\) usClientUp\(\)/);
  });
});
