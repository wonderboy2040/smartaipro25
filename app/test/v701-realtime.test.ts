// ============================================================
// test/v701-realtime.test.ts — v7.0.1 REALTIME POSITION PRICES
// ------------------------------------------------------------
// Covers the position-price resilience upgrade (the "realtime price
// fetch nahi ho raha" fix):
//   • CoinDCX ticker blocked → TV-Binance USD × live USD/₹ fallback
//     for CRYPTO spot positions (₹ domain, priceSource tagged)
//   • Futures RT feed dead → TV-Binance USD fallback in the USDT
//     domain (NEVER × USD/₹ — that would corrupt perp P&L math)
//   • India TV scanner down → Yahoo per-symbol fallback
//   • Every feed dead → honest entry-fallback (frozen) + STALE tag
//   • Healthy CoinDCX → native ticker, priceSource 'coindcx'
//   • uPnL math on every path stays (ltp − entry) × qty + booked
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- mocks (same boundary pattern as v70-pro-trader.test.ts) ----
const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
}));

let _tickers: Array<{ market: string; last_price: string }> = [];
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => _tickers),
}));

let _tvIndia: Record<string, { ltp: number }> = {};
let _tvCrypto: Record<string, { usdPrice: number }> = {};
vi.mock('../server/ai/data.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchTVIndiaBatch: vi.fn(async () => _tvIndia),
    fetchTVCryptoBatch: vi.fn(async () => _tvCrypto),
  };
});

let _futRows: Array<{ pair: string; last: number }> = [];
let _usdInr = 84;
vi.mock('../server/ai/futures.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    walletSnapshot: vi.fn(async () => null),
    executeFuturesSignal: vi.fn(async () => ({ ok: false, error: 'mocked' })),
    closeFuturesPosition: vi.fn(async () => ({ ok: true })),
    fetchFuturesPrices: vi.fn(async () => _futRows),
    fetchUsdInr: vi.fn(async () => _usdInr),
  };
});

vi.mock('../server/ai/signals.js', () => ({
  getSignals: vi.fn(async () => ({ ok: true, market: 'CRYPTO', signals: [] })),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
  getFreshSignalForExec: vi.fn(async () => null),
}));

import { getPositionsWithPnl, __resetForTests, __setJournalForTests } from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// ---------------- fixtures ----------------
function cryptoPosition(overrides = {}) {
  return {
    id: 'pos-rt-1', pair: 'BTCINR', symbol: 'BTC', side: 'LONG', mode: 'paper',
    market: 'CRYPTO', source: 'manual',
    qty: 0.01, entryPrice: 7_000_000, notionalINR: 70_000,
    sl: 6_800_000, tp: 7_200_000, tp2: 7_400_000,
    openedAt: Date.now() - 60_000, status: 'OPEN',
    ...overrides,
  };
}
function futuresPosition(overrides = {}) {
  return {
    id: 'pos-rt-2', pair: 'B-BTC_USDT', symbol: 'BTC', side: 'LONG', mode: 'paper',
    market: 'FUTURES', source: 'manual',
    qty: 0.5, entryPrice: 80_000, notionalUSDT: 40_000, marginUSDT: 13_333,
    sl: 77_000, tp: 83_000, tp2: 86_000,
    openedAt: Date.now() - 60_000, status: 'OPEN',
    ...overrides,
  };
}
function indiaPosition(overrides = {}) {
  return {
    id: 'pos-rt-3', pair: 'RELIANCE', symbol: 'RELIANCE', side: 'LONG', mode: 'paper',
    market: 'INDIA', source: 'manual',
    qty: 10, entryPrice: 1_200, notionalINR: 12_000,
    sl: 1_160, tp: 1_240, tp2: 1_280,
    openedAt: Date.now() - 60_000, status: 'OPEN',
    ...overrides,
  };
}

let _origCreds = null;
const _origFetch = globalThis.fetch;

beforeEach(() => {
  __resetForTests();
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  _tickers = [];
  _tvIndia = {};
  _tvCrypto = {};
  _futRows = [];
  _usdInr = 84;
  // default: global fetch throws (no unexpected network in tests)
  globalThis.fetch = vi.fn(async () => { throw new Error('network blocked in test'); }) as unknown as typeof fetch;
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
  globalThis.fetch = _origFetch;
});

// ============================================================
// CRYPTO spot — CoinDCX ticker dead → TV-USD × USD/₹ fallback
// ============================================================
describe('v7.0.1 crypto position price fallback', () => {
  it('CoinDCX blocked → TV-Binance USD × live USD/₹ + tv-usd-fallback tag + honest uPnL', async () => {
    _tvCrypto = { BTC: { usdPrice: 84_000 } }; // TV feed alive
    _usdInr = 84;
    __setJournalForTests({ entries: [], positions: [cryptoPosition()] });
    const out = await getPositionsWithPnl();
    const p = out.positions[0];
    expect(p.priceSource).toBe('tv-usd-fallback');
    expect(p.ltp).toBe(84_000 * 84);            // ₹ domain: 7,056,000
    expect(p.unrealizedPnlINR).toBeCloseTo((84_000 * 84 - 7_000_000) * 0.01, 1); // +₹560
  });

  it('healthy CoinDCX ticker → native price + coindcx tag (no fallback)', async () => {
    _tickers = [{ market: 'BTCINR', last_price: '7100000' }];
    __setJournalForTests({ entries: [], positions: [cryptoPosition()] });
    const out = await getPositionsWithPnl();
    const p = out.positions[0];
    expect(p.priceSource).toBe('coindcx');
    expect(p.ltp).toBe(7_100_000);
    expect(p.unrealizedPnlINR).toBeCloseTo((7_100_000 - 7_000_000) * 0.01, 1); // +₹100
  });

  it('ALL feeds dead → entry-fallback (honest frozen price, uPnL 0)', async () => {
    __setJournalForTests({ entries: [], positions: [cryptoPosition()] });
    const out = await getPositionsWithPnl();
    const p = out.positions[0];
    expect(p.priceSource).toBe('entry-fallback');
    expect(p.ltp).toBe(7_000_000);
    expect(p.unrealizedPnlINR).toBe(0);
  });
});

// ============================================================
// FUTURES — RT feed dead → TV USD in the USDT domain (never × USD/₹)
// ============================================================
describe('v7.0.1 futures position price fallback', () => {
  it('futures RT dead → TV USD price, USDT domain intact (no ×84 corruption)', async () => {
    _tvCrypto = { BTC: { usdPrice: 82_000 } };
    __setJournalForTests({ entries: [], positions: [futuresPosition()] });
    const out = await getPositionsWithPnl();
    const p = out.positions[0];
    expect(p.priceSource).toBe('tv-usd-fallback');
    expect(p.ltp).toBe(82_000);                 // USDT domain — NOT 82_000×84
    expect(p.unrealizedPnlUSDT).toBeCloseTo((82_000 - 80_000) * 0.5, 1); // +1000 USDT
    expect(p.unrealizedPnlINR).toBeCloseTo((82_000 - 80_000) * 0.5 * 84, 1); // ₹-converted for the hero
  });

  it('futures RT healthy → native feed + futures-rt tag', async () => {
    _futRows = [{ pair: 'B-BTC_USDT', last: 81_250 }];
    __setJournalForTests({ entries: [], positions: [futuresPosition()] });
    const out = await getPositionsWithPnl();
    const p = out.positions[0];
    expect(p.priceSource).toBe('futures-rt');
    expect(p.ltp).toBe(81_250);
  });
});

// ============================================================
// INDIA — TV scanner down → Yahoo per-symbol fallback
// ============================================================
describe('v7.0.1 india position price fallback', () => {
  it('TV India scanner down → Yahoo quote + yahoo tag + honest uPnL', async () => {
    _tvIndia = {}; // scanner missed everything
    // Yahoo chart endpoint mock — regularMarketPrice 1240
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('query1.finance.yahoo.com')) {
        return {
          ok: true,
          json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 1240 } }] } }),
        } as unknown as Response;
      }
      throw new Error('unexpected url');
    }) as unknown as typeof fetch;
    __setJournalForTests({ entries: [], positions: [indiaPosition()] });
    const out = await getPositionsWithPnl();
    const p = out.positions[0];
    expect(p.priceSource).toBe('yahoo');
    expect(p.ltp).toBe(1240);
    expect(p.unrealizedPnlINR).toBeCloseTo((1240 - 1200) * 10, 1); // +₹400
  });

  it('TV India scanner healthy → tv-india tag', async () => {
    _tvIndia = { RELIANCE: { ltp: 1235 } };
    __setJournalForTests({ entries: [], positions: [indiaPosition()] });
    const out = await getPositionsWithPnl();
    const p = out.positions[0];
    expect(p.priceSource).toBe('tv-india');
    expect(p.ltp).toBe(1235);
  });
});
