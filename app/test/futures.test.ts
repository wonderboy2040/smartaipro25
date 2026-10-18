// ============================================================
// test/futures.test.ts — v6.8 GLOBAL FUTURES (CoinDCX USDT perps)
// ------------------------------------------------------------
// Covers: RT price parsing, candlestick parsing, pair helpers,
// futures order body, wallet normalization + equity view, the
// execution gauntlet (venue gate, leverage clamp/sanity, wallet
// auto-transfer, native TP/SL arming, journal caps), the futures
// watcher (SL/TP close, exchange reconcile, trailing, liquidation),
// and manual close.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockPrivate = vi.fn();
const mockPrivateGET = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxPrivateGET: (...args) => mockPrivateGET(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => []),
}));

import {
  futuresPairFor, baseOfFuturesPair, fetchFuturesPrices, fetchFuturesCandles,
  futuresOrderBody, fetchFuturesWallets, walletSnapshot, executeFuturesSignal,
  watchFuturesPositions, closeFuturesPosition, __resetFuturesForTests,
  __setUsdInrForTests, inrOfUsdt, roundFuturesQty, __setWalletLegBudgetForTests,
  probeFuturesKeyScope, lastFuturesKeyScope, resetWalletTransportForReconnect,
  __walletTransportStateForTests, __clearFuturesCandleCacheForTest,
} from '../server/ai/futures.js';
import { __resetForTests, __setJournalForTests, loadJournal, __setConfigForTests, todayIST } from '../server/ai/coindcxOrders.js';
import { __ledgerRaw } from '../server/ai/ledger.js';
import { __resetUsdInrStoreForTests } from '../server/ai/lib/usdinr.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// ---------------- fixtures ----------------
const STRONG_FUT = {
  symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG',
  confidence: 84, agreement: 0.8, generatedAt: Date.now(),
  ltp: 50000, plan: {
    entry: 50000, stopLoss: 48400, target1: 51600, target2: 53200,
    risk: 1600, riskPct: 3.2, rewardRisk: 2, atrUsed: 1000, planStyle: 'atr-based',
  },
  votes: [], summary: 'x', executable: true,
};
const freshSignal = async () => ({ ...STRONG_FUT });

const RT_PAYLOAD = {
  ts: 1720429586580, vs: 54009972,
  prices: {
    'B-BTC_USDT': { ls: 50000, pc: 2.5, h: 50500, l: 49500, v: 12345.6, mp: 49999.5, mkt: 'BTCUSDT' },
    'B-ETH_USDT': { ls: 3000, pc: -1.2, h: 3050, l: 2950, v: 9876.5, mp: 3000.1, mkt: 'ETHUSDT' },
    'B-DEAD_USDT': { ls: 0, pc: 0, h: 0, l: 0, v: 0, mp: 0, mkt: 'DEADUSDT' }, // dark row — must be skipped
  },
};

const CANDLE_ROWS = Array.from({ length: 40 }, (_, i) => ({
  open: 1654 + i, high: 1660 + i, low: 1650 + i, volume: 1000 + i, close: 1655 + i, time: 1704153600000 + i * 86400000,
}));
const CANDLES_PAYLOAD = { s: 'ok', data: CANDLE_ROWS.slice(-2).concat() };
// note: the endpoint returns whatever the from/to window asked — we feed a
// full 40-row window and assert the parser's ordering/shape contract

const WALLETS_PAYLOAD = [
  { id: 'w1', currency_short_name: 'USDT', balance: '6.1693226', locked_balance: '0.5', cross_order_margin: '0.2', cross_user_margin: '0.1' },
  { id: 'w2', currency_short_name: 'INR', balance: '1000', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
];

// ---------------- fetch routing ----------------
const origFetch = globalThis.fetch;
function routeFetch(handlers = {}) {
  globalThis.fetch = vi.fn(async (url, opts) => {
    const u = String(url);
    for (const [needle, responder] of Object.entries(handlers)) {
      if (u.includes(needle)) {
        const body = typeof responder === 'function' ? responder(u, opts) : responder;
        return {
          ok: true, status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  });
}

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  __resetFuturesForTests();
  __setUsdInrForTests(84);
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockPrivateGET.mockReset();
  // default private transport: GET wallets (2025 API), positions list with
  // our pair, create + tpsl succeed. GET is the primary transport (the
  // route is GET-only — POST dies [404] not_found); POST stays as the
  // legacy fallback for older gateway deployments.
  mockPrivateGET.mockImplementation(async (path, _key, _secret, _params, opts) => {
    if (path === '/exchange/v1/derivatives/futures/wallets') return WALLETS_PAYLOAD;
    throw new Error(`unexpected GET path: ${path} (${opts?.unit})`);
  });
  mockPrivate.mockImplementation(async (path) => {
    if (path === '/exchange/v1/derivatives/futures/wallets') return WALLETS_PAYLOAD;
    if (path === '/exchange/v1/derivatives/futures/positions') return [
      { id: 'pos-1', pair: 'B-BTC_USDT', active_pos: 0.01, avg_price: 50000, liquidation_price: 45000, leverage: 3, margin_type: 'isolated', mark_price: 50000, take_profit_trigger: null, stop_loss_trigger: null },
    ];
    if (path === '/exchange/v1/derivatives/futures/orders/create') return { order: { id: 'fut-order-1' } };
    if (path === '/exchange/v1/derivatives/futures/positions/create_tpsl') return { ok: true };
    if (path === '/exchange/v1/derivatives/futures/positions/exit') return { ok: true };
    if (path === '/exchange/v1/users/balances') return [];
    throw new Error(`unexpected private path: ${path}`);
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.unstubAllGlobals();
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ============================================================
// pair helpers + RT prices + candles
// ============================================================
describe('futures pair helpers', () => {
  it('derives the B-<BASE>_USDT instrument name and back', () => {
    expect(futuresPairFor('BTC')).toBe('B-BTC_USDT');
    expect(baseOfFuturesPair('B-BTC_USDT')).toBe('BTC');
    expect(baseOfFuturesPair('garbage')).toBe('GARBAGE');
  });
  it('rounds qty to the instrument precision', () => {
    expect(roundFuturesQty('B-BTC_USDT', 0.000876)).toBeCloseTo(0.0008, 6);
    expect(roundFuturesQty('B-DOGE_USDT', 1234.9)).toBe(1234);
  });
});

describe('fetchFuturesPrices (RT payload)', () => {
  it('parses ls/pc/mp/h/l/v and SKIPS dark (ls=0) rows', async () => {
    routeFetch({ 'current_prices/futures/rt': RT_PAYLOAD });
    const rows = await fetchFuturesPrices({ maxAgeMs: 0 });
    const dead = rows.find(r => r.pair === 'B-DEAD_USDT');
    expect(dead).toBeUndefined();
    const btc = rows.find(r => r.pair === 'B-BTC_USDT');
    expect(btc).toMatchObject({ base: 'BTC', last: 50000, mark: 49999.5, changePct: 2.5 });
  });
  it('rejects garbage payloads (empty / wrong shape)', async () => {
    routeFetch({ 'current_prices/futures/rt': { prices: {} } });
    // v11.3: the chain's final honest error once every fallback leg is dead
    await expect(fetchFuturesPrices({ maxAgeMs: 0 })).rejects.toThrow(/empty|unexpected|all legs failed/i);
  });
});

describe('fetchFuturesCandles (pcode=f)', () => {
  beforeEach(() => { __clearFuturesCandleCacheForTest(); });
  it('parses { s, data } oldest-first (≥30 rows → usable TA input)', async () => {
    routeFetch({ 'market_data/candlesticks': { s: 'ok', data: CANDLE_ROWS } });
    const out = await fetchFuturesCandles('B-MKR_USDT', '60', 40);
    expect(out).toHaveLength(40);
    expect(out[0].time).toBeLessThan(out[1].time);
    expect(out[39].close).toBe(1655 + 39);
  });
  it('returns null for short (<30) responses and bare-array tolerance', async () => {
    routeFetch({ 'market_data/candlesticks': CANDLE_ROWS.slice(0, 2) });
    expect(await fetchFuturesCandles('B-MKR_USDT', '60', 2)).toBeNull();
  });
});

// ============================================================
// order body + wallets
// ============================================================
describe('futuresOrderBody', () => {
  it('builds the documented NESTED order body (LONG→buy, market)', () => {
    const body = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.01, leverage: 3 });
    expect(body.order).toMatchObject({
      side: 'buy', pair: 'B-BTC_USDT', order_type: 'market_order',
      total_quantity: 0.01, leverage: 3, hidden: false, post_only: false,
    });
    expect(typeof body.timestamp).toBe('number');
  });
  it('SHORT→sell and limit orders carry the price', () => {
    const body = futuresOrderBody({ pair: 'B-ETH_USDT', side: 'SHORT', qty: 2, leverage: 5, price: 3000 });
    expect(body.order.side).toBe('sell');
    expect(body.order.order_type).toBe('limit_order');
    expect(body.order.price).toBe('3000');
  });
});

describe('futures wallets + snapshot', () => {
  it('v12.3 TRANSPORT: the DOCUMENTED GET-with-body call is the primary wallets transport — POST never fires when it answers', async () => {
    const rows = await fetchFuturesWallets();
    // v20.8.5: cold-start PARALLEL probe — teeno documented body rungs
    // ek saath udte hain (rung 1 jo answer karta hai wahi STICKY); POST
    // kabhi nahi chala. Calls: 3 (parallel) — rung order ladder-order me.
    expect(mockPrivateGET).toHaveBeenCalledTimes(3);
    expect(mockPrivateGET.mock.calls[0][0]).toBe('/exchange/v1/derivatives/futures/wallets');
    // v12.3 auth ladder: rung 1 = GET body-mode + ms + INT timestamp
    expect(mockPrivateGET.mock.calls[0][4]).toEqual({ unit: 'ms', tsType: 'num', mode: 'body' });
    expect(mockPrivateGET.mock.calls[1][4]).toEqual({ unit: 's', tsType: 'num', mode: 'body' });
    expect(mockPrivateGET.mock.calls[2][4]).toEqual({ unit: 'ms', tsType: 'str', mode: 'body' });
    expect(mockPrivate).not.toHaveBeenCalledWith('/exchange/v1/derivatives/futures/wallets', expect.anything(), expect.anything(), expect.anything());
    expect(rows.find(r => r.currency === 'USDT')).toBeTruthy();
  });
  it('v12.3 AUTH LADDER: GET rungs fall through in order before the legacy POST (the live [401]/[404] case)', async () => {
    mockPrivateGET.mockImplementation(async () => {
      const e = new Error('[401] Invalid credentials'); e.status = 401; throw e;
    });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '6.169', locked_balance: '0.5', cross_order_margin: '0.2', cross_user_margin: '0.1' },
      ];
      throw new Error(`unexpected ${path}`);
    });
    const rows = await fetchFuturesWallets();
    // all six GET rungs tried before the POST fallback (the 3 documented
    // body-mode rungs + the 3 legacy query-mode rungs)
    expect(mockPrivateGET).toHaveBeenCalledTimes(6);
    expect(mockPrivateGET.mock.calls.map(c => c[4])).toEqual([
      { unit: 'ms', tsType: 'num', mode: 'body' },   // the doc sample
      { unit: 's', tsType: 'num', mode: 'body' },    // table "epoch seconds"
      { unit: 'ms', tsType: 'str', mode: 'body' },   // string-ts insurance
      { unit: 's', tsType: 'str' },                   // legacy query rungs
      { unit: 'ms', tsType: 'num' },
      { unit: 's', tsType: 'str' },                   // pgsz rung (params differ below)
    ]);
    // the page/size rung signs page+size into the payload
    expect(mockPrivateGET.mock.calls[5][3]).toEqual({ page: '1', size: '100' });
    expect(mockPrivate).toHaveBeenCalledWith('/exchange/v1/derivatives/futures/wallets', expect.anything(), expect.anything(), expect.anything());
    expect(rows.find(r => r.currency === 'USDT')?.free).toBeCloseTo(6.17, 1);
  });
  it('v12.1/v12.3 AUTH LADDER: a failing variant goes STICKY — later polls retry just that rung first', async () => {
    let calls = 0;
    mockPrivateGET.mockImplementation(async (_path, _k, _s, _params, opts) => {
      calls++;
      // rung 1 (GET-body/ms/num) 401s; rung 2 (GET-body/s/num) answers
      if (opts && opts.mode === 'body' && opts.unit === 's') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '2.5', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      const e = new Error('[401] Invalid credentials'); e.status = 401; throw e;
    });
    const rows = await fetchFuturesWallets();
    expect(rows.find(r => r.currency === 'USDT')?.free).toBeCloseTo(2.5, 2);
    // v20.8.5: cold parallel probe — teeno body rung ek saath ude (rung 1
    // 401, rung 2 answer) → 3 calls, sticky = rung 2.
    expect(calls).toBe(3);
    // next poll: sticky rung 2 answers immediately, one call only
    await fetchFuturesWallets();
    expect(calls).toBe(4);
    expect(mockPrivateGET.mock.calls[3][4]).toEqual({ unit: 's', tsType: 'num', mode: 'body' });
  });
  it('v12.1/v12.3 AUTH LADDER: every rung failing throws the FULL variant trace + key guidance', async () => {
    mockPrivateGET.mockImplementation(async () => {
      const e = new Error('[401] Invalid credentials'); e.status = 401; throw e;
    });
    mockPrivate.mockImplementation(async () => {
      const e = new Error('[404] not_found'); e.status = 404; throw e;
    });
    const err = await fetchFuturesWallets().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    const msg = String(err?.message || err);
    // the exact live-observed failure shape: 401 on every GET rung
    // (body AND query mode), 404 on POST
    expect(msg).toContain('[auth-ladder GET-body/ms/num:401 · GET-body/s/num:401 · GET-body/ms/str:401 · GET-s/str:401 · GET-ms/num:401 · GET-s/pgsz:401 · POST:404]');
    // all-GET-401 with a spot-working key → the Global-Futures-permission guidance
    expect(msg).toContain('GLOBAL FUTURES permission');
    // the sweep armed the probe cooldown — the next poll fails FAST on one rung
    const t0 = Date.now();
    const err2 = await fetchFuturesWallets().catch(e => e);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(String(err2?.message || err2)).toContain('[auth-ladder GET-body/ms/num:401]');
    expect(mockPrivateGET).toHaveBeenCalledTimes(7); // 6 full sweep + 1 cooldown probe
  });
  it('v10.3.2 TRANSPORT: the working transport sticks — no per-poll re-probing', async () => {
    await fetchFuturesWallets(); // GET-s wins
    const callsAfterFirst = mockPrivateGET.mock.calls.length;
    await fetchFuturesWallets();
    await fetchFuturesWallets();
    expect(mockPrivateGET.mock.calls.length).toBe(callsAfterFirst + 2); // still GET-s, one call each
    expect(mockPrivate).not.toHaveBeenCalledWith('/exchange/v1/derivatives/futures/wallets', expect.anything(), expect.anything(), expect.anything());
  });
  it('2025 API: balance IS free — total = balance + locked + cross margins', async () => {
    const rows = await fetchFuturesWallets();
    const usdt = rows.find(r => r.currency === 'USDT');
    // balance 6.169 = USABLE (free); locked_balance 0.5 (isolated) +
    // cross_order 0.2 = locked 0.7; cross_user 0.1 rides separately;
    // total = 6.169 + 0.5 + 0.2 + 0.1 = 6.969…
    expect(usdt.free).toBeCloseTo(6.17, 1);
    expect(usdt.locked).toBeCloseTo(0.7, 1);
    expect(usdt.crossUserMargin).toBeCloseTo(0.1, 2);
    expect(usdt.total).toBeCloseTo(6.97, 1);
  });
  it('USER BUG CASE: "3.01 USDT available" shows 3.01 free (not a 0-clip)', async () => {
    // The exact live report: futures margin 3.01 USDT available while the
    // site showed nothing. Old (pre-2025) reading treated balance as TOTAL
    // and subtracted locked margins from it — free went negative and
    // clipped to 0. Under the documented semantics free IS balance.
    mockPrivateGET.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '3.01', locked_balance: '2.5', cross_order_margin: '0.0', cross_user_margin: '0.0' },
      ];
      throw new Error(`unexpected ${path}`);
    });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '3.01', locked_balance: '2.5', cross_order_margin: '0.0', cross_user_margin: '0.0' },
      ];
      if (path === '/exchange/v1/users/balances') return [];
      throw new Error(`unexpected ${path}`);
    });
    const rows = await fetchFuturesWallets();
    expect(rows.find(r => r.currency === 'USDT')?.free).toBeCloseTo(3.01, 2);
  });
  it('wrapper tolerance: {data:[…]} and {wallets:[…]} both parse', async () => {
    mockPrivateGET.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return {
        data: [{ id: 'w1', currency_short_name: 'USDT', balance: '4.5', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' }],
      };
      throw new Error(`unexpected ${path}`);
    });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return {
        data: [{ id: 'w1', currency_short_name: 'USDT', balance: '4.5', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' }],
      };
      if (path === '/exchange/v1/users/balances') return [];
      throw new Error(`unexpected ${path}`);
    });
    const rows = await fetchFuturesWallets();
    expect(rows.find(r => r.currency === 'USDT')?.free).toBeCloseTo(4.5, 2);
  });
  it('walletSnapshot carries spot + futures + INR-equivalent equity', async () => {
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return WALLETS_PAYLOAD;
      if (path === '/exchange/v1/users/balances') return [
        { currency_short_name: 'INR', available_balance: 8400, locked_balance: 0 },
        { currency_short_name: 'USDT', available_balance: 10, locked_balance: 0 },
      ];
      throw new Error(`unexpected ${path}`);
    });
    const snap = await walletSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.usdInr).toBe(84);
    // v20.7.2: equity now includes INR futures margin (1000) + spot INR
    // (8400) + spot USDT (10×84=840) + fut USDT (6.869×84=577) = 10817
    expect(snap.equityINR).toBeGreaterThan(10500);
    expect(snap.equityINR).toBeLessThan(11000);
    expect(snap.deployableFuturesUSDT).toBeCloseTo(6.17, 1);
    expect(snap.futures.inr).toBeTruthy();
    expect(snap.futures.inr.total).toBe(1000);
    expect(snap.deployableFuturesINR).toBe(1000);
    expect(snap.deployableSpotINR).toBe(8400);
  });
  it('walletSnapshot NEVER throws — a dead leg degrades with the reason', async () => {
    mockPrivateGET.mockRejectedValue(new Error('[401] bad key'));
    mockPrivate.mockRejectedValue(new Error('[401] bad key'));
    const snap = await walletSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.futures.error).toMatch(/401/);
  });
  it('v12.1/v12.2: walletSnapshot carries the FULL auth-ladder trace (420-char budget) + the scope verdict', async () => {
    // the exact live incident shape: every GET rung 401s, POST 404s — the
    // variant trace + key-permission guidance must reach the UI intact
    // (the old 140-char slice amputated it to "[401] Invalid credentials")
    mockPrivateGET.mockImplementation(async () => {
      const e = new Error('[401] Invalid credentials'); e.status = 401; throw e;
    });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/users/balances') return [];
      const e = new Error('[404] not_found'); e.status = 404; throw e;
    });
    const snap = await walletSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.futures.error).toContain('[auth-ladder GET-body/ms/num:401');
    expect(snap.futures.error).toContain('GET-body/ms/str:401'); // v12.3 body rung in the trace
    expect(snap.futures.error).toContain('POST:404]');
    expect(snap.futures.error).toContain('GLOBAL FUTURES permission');
    expect(String(snap.futures.error).length).toBeGreaterThan(140); // not amputated
    // the scope probe ran (positions POST also 404 → honestly UNKNOWN);
    // verdict surfaced alongside the error for UI badging
    expect(['unknown', 'no_scope', 'ok']).toContain(snap.futures.scope);
    expect(lastFuturesKeyScope()?.verdict).toBe(snap.futures.scope);
  });

  // ============================================================
  // v10.14 (deep-recheck S1) — the "wallet API unreachable" budget fixes
  // ============================================================
  it('FX failure degrades to the static rate — snapshot stays ok with the wallets intact', async () => {
    // cold FX cache + a DEAD Yahoo upstream (the exact "ek ek baar" blip)
    __resetFuturesForTests(); // _usdInr = null, _usdInrAt = 0
    // v20.2: the SHARED last-known-good usdinr store must also be cold —
    // an earlier test's recorded rate would otherwise serve as fallback.
    __resetUsdInrStoreForTests();
    globalThis.fetch = vi.fn(async () => { throw new Error('yahoo down'); });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/users/balances') return [
        { currency_short_name: 'INR', available_balance: 8400, locked_balance: 0 },
        { currency_short_name: 'USDT', available_balance: 10, locked_balance: 0 },
      ];
      throw new Error(`unexpected private path: ${path}`);
    });
    const snap = await walletSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.usdInr).toBe(84);           // static fallback, never a throw
    expect(snap.fxStale).toBe(true);        // honest: equityINR is an estimate
    expect(snap.futures.usdt.free).toBeCloseTo(6.17, 1); // wallets still served
    expect(snap.deployableSpotINR).toBe(8400);
  });
  it('v20.2: FX failure serves the LAST-KNOWN rate once one live read ever succeeded (better than the flat 84)', async () => {
    __resetFuturesForTests();
    __resetUsdInrStoreForTests();
    // first a successful live read (88.4)…
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      chart: { result: [{ meta: { regularMarketPrice: 88.4 } }] },
    }), { status: 200 }));
    const warm = await walletSnapshot();
    expect(warm.usdInr).toBeCloseTo(88.4, 1);
    // …then the upstream dies: the snapshot keeps serving 88.4, NOT 84
    globalThis.fetch = vi.fn(async () => { throw new Error('yahoo down'); });
    __resetFuturesForTests(); // futures' own cache cold again
    const snap = await walletSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.usdInr).toBeCloseTo(88.4, 1);
    expect(snap.fxStale).toBe(true);
    __resetUsdInrStoreForTests();
  });
  it('a HANGING wallet leg is deadline-bounded — the route answers inside the client budget', async () => {
    __setWalletLegBudgetForTests(25);
    // neither transport ever answers (a slow CoinDCX gateway, not an error)
    mockPrivateGET.mockImplementation(() => new Promise(() => {}));
    mockPrivate.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    const snap = await walletSnapshot();
    expect(Date.now() - t0).toBeLessThan(2_000); // budget-bounded, not 30s
    expect(snap.ok).toBe(true);
    expect(snap.futures.error).toMatch(/budget exceeded/);
    expect(snap.spot.error).toMatch(/budget exceeded/);
  });
  it('full transport-sweep failure arms the probe cooldown — the next poll tries ONE mode only', async () => {
    mockPrivateGET.mockRejectedValue(new Error('[502] gateway'));
    mockPrivate.mockRejectedValue(new Error('[502] gateway'));
    await fetchFuturesWallets().catch(() => {});
    const firstSweep = mockPrivateGET.mock.calls.length + mockPrivate.mock.calls.length;
    // v12.3: the 7-rung auth ladder — 6 GET variants (3 documented body
    // rungs + 3 legacy query rungs) + the legacy POST.
    // No scope probe here: 'T' (timeout/unknown-status) traces are NOT
    // strict 401s — a network stall is not an auth rejection.
    expect(firstSweep).toBe(7);
    mockPrivateGET.mockClear(); mockPrivate.mockClear();
    // inside the 5-min cooldown: only the first mode is retried (fail fast)
    await fetchFuturesWallets().catch(() => {});
    expect(mockPrivateGET.mock.calls.length + mockPrivate.mock.calls.length).toBe(1);
    // and a RECOVERY clears the cooldown — full probing resumes immediately
    mockPrivateGET.mockResolvedValueOnce(WALLETS_PAYLOAD);
    const rows = await fetchFuturesWallets().catch(e => { throw e; });
    expect(Array.isArray(rows)).toBe(true);
  });

  // ============================================================
  // v12.2 — the futures KEY-SCOPE PROBE (the live 401 discriminator)
  // ============================================================
  describe('v12.2 futures key-scope probe', () => {
    const allGet401 = () => {
      mockPrivateGET.mockImplementation(async () => {
        const e = new Error('[401] Invalid credentials'); e.status = 401; throw e;
      });
    };
    const statusErr = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

    it('verdict classification: 2xx → ok · 400/422 → ok (auth PASSED, shape rejected) · 401/403 → no_scope · 404/other → unknown', async () => {
      const cases = [
        { status: 200, want: 'ok' },
        { status: 400, want: 'ok' },
        { status: 422, want: 'ok' },
        { status: 401, want: 'no_scope' },
        { status: 403, want: 'no_scope' },
        { status: 404, want: 'unknown' },
        { status: 500, want: 'unknown' },
      ];
      for (const c of cases) {
        __resetFuturesForTests();
        mockPrivate.mockImplementation(async (path) => {
          if (path === '/exchange/v1/derivatives/futures/positions') {
            if (c.status === 200) return [];
            throw statusErr(c.status, `[${c.status}] x`);
          }
          throw new Error(`unexpected ${path}`);
        });
        const v = await probeFuturesKeyScope({ force: true });
        expect(v.verdict).toBe(c.want);
        expect(v.status).toBe(c.status);
      }
      // no-status network error → unknown, status null
      __resetFuturesForTests();
      mockPrivate.mockRejectedValue(new Error('fetch failed'));
      const v = await probeFuturesKeyScope({ force: true });
      expect(v.verdict).toBe('unknown');
      expect(v.status).toBeNull();
    });
    it('no_scope (positions 401) → the error LEADS with the verdict + the exact user fix', async () => {
      allGet401();
      mockPrivate.mockImplementation(async (path) => {
        if (path === '/exchange/v1/derivatives/futures/positions') throw statusErr(401, '[401] Invalid credentials');
        const e = new Error('[404] not_found'); e.status = 404; throw e;
      });
      const err = await fetchFuturesWallets().catch(e => e);
      const msg = String(err?.message || err);
      expect(msg).toContain('futures-key-scope: MISSING');
      expect(msg.indexOf('futures-key-scope: MISSING')).toBeLessThan(120); // leads — survives the blocker's 200-char slice
      expect(msg).toContain('Global Futures permission nahi hai');
      expect(msg).toContain('NAYI key banao');
      expect(msg).toContain('same key spot par chalti hai');
      expect(msg).toContain('[auth-ladder GET-body/ms/num:401');
      expect(lastFuturesKeyScope()).toMatchObject({ verdict: 'no_scope', status: 401 });
      // walletSnapshot surfaces the verdict for UI badging
      const snap = await walletSnapshot();
      expect(snap.futures.scope).toBe('no_scope');
    });
    it('scope ok (positions 422 — auth passed) → the verdict says GET-with-body fix, NOT permission', async () => {
      allGet401();
      mockPrivate.mockImplementation(async (path) => {
        if (path === '/exchange/v1/derivatives/futures/positions') throw statusErr(422, '[422] market is required');
        const e = new Error('[404] not_found'); e.status = 404; throw e;
      });
      const err = await fetchFuturesWallets().catch(e => e);
      const msg = String(err?.message || err);
      expect(msg).toContain('futures-key-scope: OK');
      expect(msg).toContain('GET-with-body rungs');
      // NOT the permission guidance — the key is fine
      expect(msg).not.toContain('NAYI key banao');
      expect(lastFuturesKeyScope()).toMatchObject({ verdict: 'ok', status: 422 });
    });
    it('the probe is CACHED — a second failing sweep does not re-POST positions', async () => {
      allGet401();
      mockPrivate.mockImplementation(async (path) => {
        if (path === '/exchange/v1/derivatives/futures/positions') throw statusErr(401, '[401] Invalid credentials');
        const e = new Error('[404] not_found'); e.status = 404; throw e;
      });
      await fetchFuturesWallets().catch(() => {});
      const postsAfterFirst = mockPrivate.mock.calls.length;
      await fetchFuturesWallets().catch(() => {}); // cooldown single-rung retry
      expect(mockPrivate.mock.calls.length).toBe(postsAfterFirst); // zero extra POSTs
    });
    it('resetWalletTransportForReconnect clears the cooldown + verdict — a fresh key re-probes the FULL ladder', async () => {
      allGet401();
      mockPrivate.mockImplementation(async () => { throw statusErr(404, '[404] not_found'); });
      await fetchFuturesWallets().catch(() => {});
      expect(__walletTransportStateForTests().cooling).toBe(true);
      expect(__walletTransportStateForTests().scopeVerdict).toBe('unknown');
      // reconnect with the new key → clean slate
      resetWalletTransportForReconnect();
      expect(__walletTransportStateForTests().cooling).toBe(false);
      expect(__walletTransportStateForTests().scopeVerdict).toBeNull();
      // full sweep again even inside the old cooldown window
      mockPrivateGET.mockClear();
      await fetchFuturesWallets().catch(() => {});
      expect(mockPrivateGET.mock.calls.length).toBe(6);
    });
    it('non-401 failures (gateway 502) never fire the probe — no misleading verdict', async () => {
      mockPrivateGET.mockRejectedValue(statusErr(502, '[502] gateway'));
      mockPrivate.mockRejectedValue(statusErr(502, '[502] gateway'));
      const err = await fetchFuturesWallets().catch(e => e);
      expect(String(err?.message || err)).not.toContain('futures-key-scope');
      expect(lastFuturesKeyScope()).toBeNull();
    });
  });
});

// ============================================================
// THE EXECUTION GAUNTLET (futures)
// ============================================================
describe('executeFuturesSignal', () => {
  beforeEach(() => {
    // LIVE-armed config (the gauntlet's gate 3) + generous caps so each
    // test can isolate ONE gate
    __setConfigForTests({ mode: 'live', cryptoLeverage: 10, maxRiskPct: 5, dailyMaxTrades: 50, dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    routeFetch({
      'current_prices/futures/rt': RT_PAYLOAD,
      'derivatives/futures/data/instrument': { instrument: { pair: 'B-BTC_USDT', max_leverage_long: 10, max_leverage_short: 10, quantity_precision: 4, min_qty: 0.001, status: 'active' } },
    });
  });

  it('PAPER: fresh STRONG futures signal → journal position in the USDT domain', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: freshSignal, source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('paper');
    // qty = 100×3 / 50000 = 0.006 → floored at 4dp
    expect(out.filled.qty).toBeCloseTo(0.006, 6);
    expect(out.filled.marginUSDT).toBeCloseTo(100, 0);
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.market).toBe('FUTURES');
    expect(p.pair).toBe('B-BTC_USDT');
    expect(p.notionalUSDT).toBeCloseTo(0.006 * 50000, 0);
    expect(p.notionalINR).toBeCloseTo(0.006 * 50000 * 84, 0); // INR twin at 84
    expect(j.entries[0].kind).toBe('ORDER');
    expect(j.entries[0].status).toBe('FILLED');
    expect(j.entries[0].market).toBe('FUTURES');
  });

  it('v20.3: PAPER practice fill against a FLIPPED consensus is stamped relaxed (calibration corpus stays clean)', async () => {
    // request SHORT while the fresh consensus says LONG → practice synth plan
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...STRONG_FUT, side: 'LONG' }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('paper');
    // the tamper-evident ledger row carries the relaxed stamp — trust.js
    // settledEntries excludes it from the calibration corpus (v20.2 gave
    // this hygiene to the SPOT desk only; futures/global/india leaked).
    const raw = __ledgerRaw();
    const e = raw.entries.at(-1);
    expect(e?.market).toBe('FUTURES');
    expect(e?.mode).toBe('paper');
    expect(e?.relaxed).toBe(true);
  });

  it('VENUE gate: a CRYPTO (spot) signal can never pass the futures gauntlet', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', marginUSDT: 100, leverage: 1,
      getFreshSignal: async () => ({ ...STRONG_FUT, market: 'CRYPTO' }),
      source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/signal is for the CRYPTO market/i);
    const j = loadJournal();
    expect(j.entries[0].status).toBe('REJECTED');
  });

  it('FRESHNESS gate: a stale signal is rejected for LIVE', async () => {
    const stale = { ...STRONG_FUT, generatedAt: Date.now() - 10 * 60_000 };
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', marginUSDT: 100, leverage: 1,
      getFreshSignal: async () => stale, source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/stale/i);
  });

  it('LEVERAGE sanity: LIVE rejects when liquidation would fire before the SL', async () => {
    // WIDE stop (12%) → maxSane = floor(95/12) = 7 → 10x must REJECT live
    __setConfigForTests({ mode: 'live', cryptoLeverage: 10, maxRiskPct: 15, dailyMaxTrades: 50, dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    const wide = { ...STRONG_FUT, plan: { ...STRONG_FUT.plan, stopLoss: 44000, risk: 6000, riskPct: 12, target1: 56000, target2: 62000, rewardRisk: 2 } };
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', marginUSDT: 100, leverage: 10,
      getFreshSignal: async () => wide, source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/liquidat/i);
  });

  it('LIVE: creates the order, resolves the position id, arms NATIVE TP/SL', async () => {
    const tpslCalls = [];
    mockPrivateGET.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      throw new Error(`unexpected GET ${path}`);
    });
    mockPrivate.mockImplementation(async (path, _key, _sec, body) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      if (path === '/exchange/v1/derivatives/futures/positions') return [
        { id: 'pos-live-1', pair: 'B-BTC_USDT', active_pos: 0.006, avg_price: 50000, liquidation_price: 46000, leverage: 3, margin_type: 'isolated', mark_price: 50000, take_profit_trigger: null, stop_loss_trigger: null },
      ];
      if (path === '/exchange/v1/derivatives/futures/orders/create') return { order: { id: 'fut-order-9' } };
      if (path === '/exchange/v1/derivatives/futures/positions/create_tpsl') { tpslCalls.push(body); return { ok: true }; }
      throw new Error(`unexpected ${path}`);
    });
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', marginUSDT: 100, leverage: 3,
      getFreshSignal: freshSignal, source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.orderId).toBe('fut-order-9');
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.mode).toBe('live');
    expect(p.exchangePositionId).toBe('pos-live-1');
    expect(p.liquidation).toBe(46000); // exchange-reported
    expect(p.liquidationSource).toBe('exchange');
    // native TP/SL armed with the plan levels (SL 48400 / TP2 53200)
    expect(tpslCalls.length).toBeGreaterThanOrEqual(1);
    expect(Number(tpslCalls[0].stop_loss.stop_price)).toBe(48400);
    expect(Number(tpslCalls[0].take_profit.stop_price)).toBe(53200);
  });

  it('WALLET gate: live rejects honestly when the DF wallet + spot are short', async () => {
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '1', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      if (path === '/exchange/v1/users/balances') return [
        { currency_short_name: 'INR', available_balance: 100, locked_balance: 0 },
      ];
      throw new Error(`unexpected ${path}`);
    });
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', marginUSDT: 500, leverage: 3,
      getFreshSignal: freshSignal, source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/margin needed|wallet/i);
  });

  it('DAILY caps: the 3rd trade of the day is the LAST — a 4th is rejected', async () => {
    // user spec: dailyMaxTrades = 3 (override the gauntlet beforeEach's 50)
    __setConfigForTests({ mode: 'live', cryptoLeverage: 10, maxRiskPct: 5, dailyMaxTrades: 3, dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    // simulate 3 trades already done today (non-rejected ORDER entries)
    const j = loadJournal();
    const today = todayIST();
    for (let i = 0; i < 3; i++) {
      j.entries.push({ id: `e${i}`, ts: Date.now(), kind: 'ORDER', day: today, pair: `X${i}`, status: 'FILLED' });
    }
    __setJournalForTests(j);
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: freshSignal, source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/daily trade cap/i);
  });
});

// ============================================================
// THE FUTURES WATCHER
// ============================================================
describe('watchFuturesPositions', () => {
  const mkPos = (over = {}) => ({
    id: 'p1', pair: 'B-BTC_USDT', symbol: 'BTC', market: 'FUTURES', side: 'LONG', mode: 'paper',
    source: 'agent', qty: 0.01, entryPrice: 50000, notionalUSDT: 500, notionalINR: 42000,
    marginUSDT: 100, marginINR: 8400, leverage: 3, liquidation: 34166.67,
    sl: 48400, tp: 51600, tp2: 53200, initialRisk: 1600, peakPrice: 50000,
    signal: { grade: 'STRONG', confidence: 84, agreement: 0.8 },
    openedAt: Date.now(), status: 'OPEN', ...over,
  });

  beforeEach(() => {
    routeFetch({ 'current_prices/futures/rt': RT_PAYLOAD });
  });

  it('closes a PAPER position when the RT price crosses the SL', async () => {
    __setJournalForTests({ entries: [], positions: [mkPos()] });
    // price 48000 ≤ SL 48400
    routeFetch({ 'current_prices/futures/rt': { ...RT_PAYLOAD, prices: { ...RT_PAYLOAD.prices, 'B-BTC_USDT': { ...RT_PAYLOAD.prices['B-BTC_USDT'], ls: 48000 } } } });
    const closures = await watchFuturesPositions({});
    expect(closures).toHaveLength(1);
    expect(closures[0].reason).toMatch(/STOP-LOSS/i);
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toMatch(/STOP-LOSS/i);
    // USDT P&L = (48000 − 50000) × 0.01 = −20 USDT → ×84 = −1680 INR
    expect(p.pnlUSDT).toBeCloseTo(-20, 0);
    expect(p.pnlINR).toBeCloseTo(-20 * 84, 0);
  });

  it('closes at TARGET-2 with the runner profit (manual desk — classic full exit)', async () => {
    // v7.0: PARTIAL TP applies to AGENT positions only — a manual
    // position keeps the classic full-close-at-T2 behavior.
    __setJournalForTests({ entries: [], positions: [mkPos({ source: 'manual' })] });
    routeFetch({ 'current_prices/futures/rt': { ...RT_PAYLOAD, prices: { ...RT_PAYLOAD.prices, 'B-BTC_USDT': { ...RT_PAYLOAD.prices['B-BTC_USDT'], ls: 53300 } } } });
    const closures = await watchFuturesPositions({});
    expect(closures[0].reason).toMatch(/TARGET-2/i);
    const p = loadJournal().positions[0];
    expect(p.pnlUSDT).toBeCloseTo(33, 0); // (53300 − 50000) × 0.01
  });

  it('v7.0 PRO: agent position at T2 books 40%+40% partials, 20% runner rides (no full close)', async () => {
    __setJournalForTests({ entries: [], positions: [mkPos()] }); // source: 'agent'
    routeFetch({ 'current_prices/futures/rt': { ...RT_PAYLOAD, prices: { ...RT_PAYLOAD.prices, 'B-BTC_USDT': { ...RT_PAYLOAD.prices['B-BTC_USDT'], ls: 53300 } } } });
    const closures = await watchFuturesPositions({});
    // both partial legs booked in one pass (price gapped past T1+T2)
    const partial = closures.filter(c => c.partial);
    expect(partial).toHaveLength(1);
    expect(partial[0].reason).toMatch(/PARTIAL TP/i);
    const j = loadJournal();
    const p = j.positions[0];
    const legs = j.entries.filter(e => e.kind === 'PARTIAL_TP');
    expect(legs.map(l => l.stage)).toEqual(['T1', 'T2']);
    expect(p.status).toBe('OPEN');               // RUNNER alive at 20%
    expect(p.tp1Hit).toBe(true);
    expect(p.tp2Hit).toBe(true);
    expect(p.exitStage).toBe('RUNNER');
    expect(p.originalQty).toBe(0.01);
    expect(p.qty).toBeCloseTo(0.002, 4);         // 0.01 − 40% − 40%
    // booked legs: 0.004 × 3300 × 2 = 26.4 USDT (+ INR twin @84)
    expect(p.bookedPnlUSDT).toBeCloseTo(26.4, 2);
    expect(p.bookedPnlINR).toBeCloseTo(26.4 * 84, 1);
    // no CLOSE — the runner continues
    expect(j.entries.filter(e => e.kind === 'CLOSE')).toHaveLength(0);
    // SL locked at/above T1 (profit lock; trail ratchet keeps it ≥)
    expect(p.sl).toBeGreaterThanOrEqual(51600);
  });

  it('v7.0 PRO: T1 partial on an agent position → 40% booked + breakeven lock', async () => {
    __setJournalForTests({ entries: [], positions: [mkPos()] }); // source: 'agent'
    // price 52000: T1 51600 hit, T2 53200 not yet
    routeFetch({ 'current_prices/futures/rt': { ...RT_PAYLOAD, prices: { ...RT_PAYLOAD.prices, 'B-BTC_USDT': { ...RT_PAYLOAD.prices['B-BTC_USDT'], ls: 52000 } } } });
    await watchFuturesPositions({});
    const j = loadJournal();
    const p = j.positions[0];
    expect(j.entries.filter(e => e.kind === 'PARTIAL_TP')).toHaveLength(1);
    expect(p.tp1Hit).toBe(true);
    expect(p.qty).toBeCloseTo(0.006, 4);         // 0.01 − 40%
    // booked leg: 0.004 × (52000 − 50000) = 8 USDT
    expect(p.bookedPnlUSDT).toBeCloseTo(8, 2);
    // breakeven lock: SL ≥ entry 50000 (was 48400)
    expect(p.sl).toBeGreaterThanOrEqual(50000);
    expect(p.status).toBe('OPEN');
    expect(j.entries.filter(e => e.kind === 'CLOSE')).toHaveLength(0);
  });

  it('reconciles a LIVE position the exchange already closed (native TP/SL)', async () => {
    __setJournalForTests({ entries: [], positions: [mkPos({ mode: 'live', exchangePositionId: 'pos-1' })] });
    // exchange says active_pos = 0 with an SL trigger 48400 → reconciled close
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/positions') return [
        { id: 'pos-1', pair: 'B-BTC_USDT', active_pos: 0, avg_price: 50000, liquidation_price: 0, leverage: 3, margin_type: 'isolated', mark_price: 48000, take_profit_trigger: null, stop_loss_trigger: 48400 },
      ];
      throw new Error(`unexpected ${path}`);
    });
    const closures = await watchFuturesPositions({});
    expect(closures).toHaveLength(1);
    const p = loadJournal().positions[0];
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toMatch(/native/i);
    expect(p.closePrice).toBe(48400);
  });

  it('updates the entry price + liquidation from the exchange while open', async () => {
    __setJournalForTests({ entries: [], positions: [mkPos({ mode: 'live', exchangePositionId: 'pos-1' })] });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/positions') return [
        { id: 'pos-1', pair: 'B-BTC_USDT', active_pos: 0.01, avg_price: 50100, liquidation_price: 45500, leverage: 3, margin_type: 'isolated', mark_price: 50000, take_profit_trigger: null, stop_loss_trigger: null },
      ];
      throw new Error(`unexpected ${path}`);
    });
    await watchFuturesPositions({});
    const p = loadJournal().positions[0];
    expect(p.status).toBe('OPEN');
    expect(p.entryPrice).toBe(50100);
    expect(p.liquidation).toBe(45500);
    expect(p.liquidationSource).toBe('exchange');
  });

  it('paper liquidation closes the whole margin when the estimate is crossed', async () => {
    __setJournalForTests({ entries: [], positions: [mkPos()] });
    routeFetch({ 'current_prices/futures/rt': { ...RT_PAYLOAD, prices: { ...RT_PAYLOAD.prices, 'B-BTC_USDT': { ...RT_PAYLOAD.prices['B-BTC_USDT'], ls: 34000 } } } });
    const closures = await watchFuturesPositions({});
    expect(closures[0].reason).toMatch(/LIQUIDATED/i);
    const p = loadJournal().positions[0];
    expect(p.closeReason).toMatch(/LIQUIDATED/i);
    expect(p.closePrice).toBe(34166.67);
  });

  it('manual close (paper) settles at the RT price', async () => {
    __setJournalForTests({ entries: [], positions: [mkPos()] });
    const out = await closeFuturesPosition('p1');
    expect(out.ok).toBe(true);
    expect(loadJournal().positions[0].closeReason).toBe('Manual close');
  });
});

// ============================================================
// conversion twin
// ============================================================
describe('USDT→INR twin', () => {
  it('rounds to 2dp at the given FX rate', () => {
    expect(inrOfUsdt(6.1693226, 84)).toBeCloseTo(518.22, 1);
    expect(inrOfUsdt(NaN, 84)).toBeNull();
  });
});
