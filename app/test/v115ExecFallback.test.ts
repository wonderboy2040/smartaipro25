// ============================================================
// test/v115ExecFallback.test.ts — v11.5 EXEC BOARD FALLBACK
// ------------------------------------------------------------
// THE INCIDENT (CoinDCX tab): getDeepSignal() fails whenever an
// upstream leg is down (CoinDCX futures API, TradingView) →
// {ok:false} (30s-cached) → the execution gauntlet's gate 5 got a
// null signal → "⛔ No fresh ensemble signal available for this
// futures pair" — even for PAPER trades, where the signal is only
// needed for plan generation, not live order safety.
//
// THE FIX locked here: the three getFresh*ForExec sources fall back
// to the 60s-refreshed BOARD cache (10-minute staleness cap, the
// row's own generatedAt honored) — PAPER/NOTIFY only. LIVE keeps the
// strict fresh-deep-run contract, and an unrecognized/missing mode
// fails safe (no fallback).
//
// Hermetic: data.js + cryptoStream mocked OFFLINE (same scaffolding
// as boardResilience.test.ts) → the deep path deterministically
// answers {ok:false} for every market.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v115ef');

vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE', 'TCS', 'INFY'],
  CRYPTO_UNIVERSE: ['BTC', 'ETH'],
  fetchTVIndiaBatch: async () => ({}),
  fetchTVIndiaBatchChunked: async () => ({}),
  fetchTVCryptoBatch: async () => ({}),
  fetchCoinDcxCandles: async () => null,
  fetchBinanceKlines: async () => null,
  fetchYahooQuotes: async () => ({}),
  isNseOpen: () => false,
}));

// tickers → [] : the CRYPTO deep path can never build an INR anchor →
// ctx null → {ok:false} (the exact incident shape, deterministic).
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => []),
}));

// every raw network call → OFFLINE
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test)'); }));

const {
  getFreshSignalForExec, getFreshFuturesSignalForExec, getFreshGlobalSignalForExec,
  __clearSignalCaches, __setBoardCacheForTests,
} = await import('../server/ai/signals.js');

/** A board-shaped signal row (buildSignal output, minimal honest fields). */
const boardRow = (symbol, market, ageMs = 0) => ({
  symbol, market, side: 'LONG', grade: 'STRONG',
  confidence: 82, agreement: 0.78, participation: 9,
  ltp: 100, changePct: 0.5,
  plan: {
    entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4,
    riskPct: 3.2, rewardRisk: 2, planStyle: 'atr-based',
  },
  votes: [], abstentions: [], summary: 'board row',
  generatedAt: Date.now() - Math.max(0, ageMs),
});

const seedBoard = (mkt, signals) =>
  __setBoardCacheForTests(mkt, { ok: true, market: mkt, signals, topFive: [], generatedAt: Date.now() });

beforeEach(() => {
  __clearSignalCaches();
});

describe('v11.5 board fallback — deep path down, paper/notify served from the board', () => {
  it('CRYPTO paper: "BTCINR" → the board\'s BTC row, provenance-stamped', async () => {
    seedBoard('CRYPTO', [boardRow('BTC', 'CRYPTO')]);
    const sig = await getFreshSignalForExec('BTCINR', {}, { mode: 'paper' });
    expect(sig).toBeTruthy();
    expect(sig.symbol).toBe('BTC');
    expect(sig.market).toBe('CRYPTO');
    expect(sig.__execSource).toBe('board');          // provenance visible
    expect(sig.__signalAgeMs).toBeGreaterThanOrEqual(0); // age visible
    expect(sig.generatedAt).toBeGreaterThan(0);      // the gate reads this for freshness
    expect(sig.plan).toBeTruthy();                   // plan generation can proceed
  }, 20_000);

  it('FUTURES paper: "B-BTC_USDT" normalizes to the board\'s BTC row', async () => {
    seedBoard('FUTURES', [boardRow('BTC', 'FUTURES')]);
    const sig = await getFreshFuturesSignalForExec('B-BTC_USDT', {}, { mode: 'paper' });
    expect(sig).toBeTruthy();
    expect(sig.symbol).toBe('BTC');
    expect(sig.market).toBe('FUTURES');
    expect(sig.__execSource).toBe('board');
  }, 20_000);

  it('GLOBALFUTURES notify: "NVDA-USD" → the board\'s NVDA row', async () => {
    seedBoard('GLOBALFUTURES', [boardRow('NVDA', 'GLOBALFUTURES')]);
    const sig = await getFreshGlobalSignalForExec('NVDA-USD', {}, { mode: 'notify' });
    expect(sig).toBeTruthy();
    expect(sig.symbol).toBe('NVDA');
    expect(sig.__execSource).toBe('board');
  }, 20_000);

  it('plain base symbols ("BTC", "NVDA") also match board rows', async () => {
    seedBoard('CRYPTO', [boardRow('BTC', 'CRYPTO')]);
    const sig = await getFreshSignalForExec('BTC', {}, { mode: 'paper' });
    expect(sig?.symbol).toBe('BTC');
  }, 20_000);
});

describe('v11.5 board fallback — the safety rails (LIVE + staleness + honesty)', () => {
  it('LIVE mode: NO fallback even with a fresh board row (fresh-deep-run contract intact)', async () => {
    seedBoard('CRYPTO', [boardRow('BTC', 'CRYPTO')]);
    const sig = await getFreshSignalForExec('BTCINR', {}, { mode: 'live' });
    expect(sig).toBeNull();
  }, 20_000);

  it('missing/unrecognized mode: NO fallback (fail-safe — callers must opt in with paper/notify)', async () => {
    seedBoard('CRYPTO', [boardRow('BTC', 'CRYPTO')]);
    expect(await getFreshSignalForExec('BTCINR', {})).toBeNull();
    expect(await getFreshSignalForExec('BTCINR', {}, {})).toBeNull();
    expect(await getFreshFuturesSignalForExec('B-BTC_USDT', {}, { mode: 'LIVE' })).toBeNull();
    expect(await getFreshGlobalSignalForExec('NVDA-USD', {}, { mode: 'auto' })).toBeNull();
  }, 20_000);

  it('board row older than 10 minutes → null (the staleness cap)', async () => {
    seedBoard('CRYPTO', [boardRow('BTC', 'CRYPTO', 10 * 60_000 + 5_000)]);
    const sig = await getFreshSignalForExec('BTCINR', {}, { mode: 'paper' });
    expect(sig).toBeNull();
  }, 20_000);

  it('a 9-minute-old row still serves (inside the 10-minute window)', async () => {
    seedBoard('CRYPTO', [boardRow('BTC', 'CRYPTO', 9 * 60_000)]);
    const sig = await getFreshSignalForExec('BTCINR', {}, { mode: 'paper' });
    expect(sig).toBeTruthy();
    expect(sig.__signalAgeMs).toBeGreaterThanOrEqual(9 * 60_000 - 1000);
  }, 20_000);

  it('a degraded board payload (ok:false) is never a fallback source', async () => {
    __setBoardCacheForTests('CRYPTO', { ok: false, market: 'CRYPTO', reason: 'chain down', signals: [boardRow('BTC', 'CRYPTO')], topFive: [] });
    const sig = await getFreshSignalForExec('BTCINR', {}, { mode: 'paper' });
    expect(sig).toBeNull();
  }, 20_000);

  it('symbol absent from the board → null (no cross-symbol invention)', async () => {
    seedBoard('CRYPTO', [boardRow('ETH', 'CRYPTO')]);
    const sig = await getFreshSignalForExec('BTCINR', {}, { mode: 'paper' });
    expect(sig).toBeNull();
  }, 20_000);

  it('empty board (no signals) → null', async () => {
    seedBoard('CRYPTO', []);
    const sig = await getFreshSignalForExec('BTCINR', {}, { mode: 'paper' });
    expect(sig).toBeNull();
  }, 20_000);
});
