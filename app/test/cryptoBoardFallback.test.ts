// ============================================================
// test/cryptoBoardFallback.test.ts — v11.2 CRYPTO BOARD SURVIVOR
// ------------------------------------------------------------
// 2026-09-17 LIVE INCIDENT (Render, smartai1.onrender.com):
// the crypto spot board answered
//   "No crypto data reachable right now (TV + CoinDCX both unavailable)"
// with ZERO signal cards while CoinDCX INR tickers were perfectly
// reachable (expert-picks served coindcx-inr prices the same minute).
//
// Mechanical root cause (proven by local network simulation):
//   1. TV crypto scanner IP-blocked from the Render egress      → tv = {}
//   2. public.coindcx.com candles IP-blocked                    → null
//   3. Yahoo USD 1h fallback DID answer — but rescaleCandlesToLtp
//      got expectedScale=null (TV row missing) and its no-reference
//      sanity bound (0.2–5) rejected EVERY USD→INR rescale (≈85×)
//      → candleMap empty → ind null → ZERO contexts → board dead.
//
// v11.2 fix locked here:
//   A. Live USDINR fx anchors the rescale guard when the TV row is
//      missing (one fetch per board, shared by every coin).
//   B. Binance/Bybit USDT klines join the candle chain BEFORE Yahoo
//      (crypto-native OHLC, same linear INR rescale).
//   C. The deep dive gets the same fallback chain (it previously had
//      NO candle fallback at all: TV-blocked + coindcx-candles-blocked
//      → "No data for BTC on CRYPTO").
// Hermetic: data.js mocked, global fetch stubbed per-URL.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-crypto-board-fb');

// ----- the incident's network matrix, per data.js export -----
// TV crypto BLOCKED ({}), CoinDCX public candles BLOCKED (null),
// Binance/Bybit klines REACHABLE (300 USD-domain rows).
const FAKE_FX = 85.9;
// Realistic OHLC: wave + trend so RSI/MACD/ATX/ADX are live (flat candles
// degenerate every indicator and the models abstain).
const fakeKlines = (lastClose) => Array.from({ length: 300 }, (_, i) => {
  const drift = Math.sin(i / 17) * 0.012 + (i / 300) * 0.06 - 0.03;
  const close = lastClose * (1 + drift);
  return {
    time: 1_700_000_000_000 + i * 3_600_000,
    open: close * 0.998, high: close * 1.004, low: close * 0.996,
    close, volume: 100 + (i % 7) * 10,
  };
});
vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE'],
  CRYPTO_UNIVERSE: ['BTC', 'ETH'],
  FUTURES_UNIVERSE: ['B-BTC_USDT'],
  fetchTVIndiaBatch: async () => ({}),
  fetchTVIndiaBatchChunked: async () => ({}),
  fetchTVCryptoBatch: async () => ({}),            // ← TV crypto scanner BLOCKED
  fetchCoinDcxCandles: async () => null,           // ← public.coindcx.com BLOCKED
  fetchBinanceKlines: async (base) => fakeKlines(base === 'BTC' ? 76_300 : 2_430),
  fetchYahooQuotes: async () => ({}),
  isNseOpen: () => false,
}));

// ----- raw network: CoinDCX tickers + USDINR answer; everything else throws -----
vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('api.coindcx.com/exchange/ticker')) {
    return new Response(JSON.stringify([
      { market: 'BTCINR', last_price: '6540000', volume_24_hour: '42' },
      { market: 'ETHINR', last_price: '208500', volume_24_hour: '18' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('USDINR=X')) {
    return new Response(JSON.stringify({
      chart: { result: [{ meta: { regularMarketPrice: FAKE_FX } }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.binance.com/api/v3/ticker/price')) { // wick-guard cross-venue ref
    return new Response(JSON.stringify([
      { symbol: 'BTCUSDT', price: '76300.5' },
      { symbol: 'ETHUSDT', price: '2430.1' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('offline (incident sim)');
}));

const { getSignals, getDeepSignal, __clearSignalCaches } = await import('../server/ai/signals.js');

beforeEach(() => { __clearSignalCaches(); });

describe('v11.2 crypto board survives TV-scanner + CoinDCX-candle IP blocks (2026-09-17 Render incident)', () => {
  it('board: TV blocked + public candles blocked + tickers alive → signals still served (fx-anchored rescale)', async () => {
    const board = await getSignals('CRYPTO', {}, { noCache: true });
    expect(board.ok).toBe(true);
    expect(Array.isArray(board.signals)).toBe(true);
    expect(board.signals.length).toBeGreaterThan(0);
    // honesty meta: the new candle chain is advertised
    expect(board.superIntelMeta.candleChain).toContain('binance-bybit-usdt-rescaled');
    // INR domain: BTC-class plans must be priced in lakhs, not USD
    const btc = board.signals.find((s) => s.symbol === 'BTC');
    if (btc) {
      expect(btc.ltp).toBeGreaterThan(1_000_000);      // 6,540,000-class
      expect(btc.plan.entry).toBeGreaterThan(1_000_000);
      expect(btc.plan.stopLoss).toBeGreaterThan(0);
    }
  }, 30_000);

  it('deep: BTC deep dive answers with a full INR plan instead of "No data for BTC on CRYPTO"', async () => {
    const deep = await getDeepSignal('BTC', 'CRYPTO', {});
    expect(deep.ok).toBe(true);
    expect(deep.signal.ltp).toBe(6_540_000);
    expect(deep.signal.plan.entry).toBeGreaterThan(1_000_000);
    expect(deep.signal.plan.stopLoss).toBeGreaterThan(1_000_000);
  }, 30_000);

  it('rescale guard: fx anchor accepts the honest USD→INR ratio (≈86) that the old null-anchor bound (0.2–5) rejected', async () => {
    // observed scale 6,540,000 / 76,300 ≈ 85.7 — inside ±50% of the 85.9 anchor.
    // The OLD code path (expectedScale=null) would have returned null here and
    // killed the board; the fx-anchored path returns rescaled INR candles.
    const board = await getSignals('CRYPTO', {}, { noCache: true });
    expect(board.ok).toBe(true);
    const btc = board.signals.find((s) => s.symbol === 'BTC') || board.signals[0];
    expect(btc).toBeTruthy();
  }, 30_000);
});
