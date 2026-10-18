// ============================================================
// test/v214StreamQuotes.test.ts — v21.4.1 [C1/C2/C4/C5] LOCKS
// ------------------------------------------------------------
//   [C1] stream watcher market-qualified quote map (byMarket) —
//        CRYPTO (INR) × FUTURES (USDT) same-base collision repair
//   [C2] globalFutures USDC candle cache stale-prune on serve
//   [C4] honest upstream ts on the futures/global watcher legs
//   [C5] MAX_WATCH_CRYPTO 14 → 40 (tracked-row starvation ban)
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// hermetic data dir (separate from v214DeepRecheck — trackRecord module state)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v214-stream');

// CoinDCX exchange legs mocked OFF (same as v213)
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false,
  coindcxPrivate: vi.fn(),
  coindcxPrivateGET: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
}));

// futures.js: ONLY fetchFuturesPrices replaced (USDT rows with honest ts)
vi.mock('../server/ai/futures.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    fetchFuturesPrices: vi.fn(async () => [
      { base: 'BTC', last: 102000, changePct: 1.1, ts: 1700000000000 },
      { base: 'ETH', last: 3500, changePct: 0.5, ts: 1700000000000 },
      { base: 'SOL', last: 241, changePct: 0.2, ts: 1700000000000 },
    ]),
  };
});

// globalFutures.js: ONLY fetchGlobalLtpMap replaced (candle functions stay REAL)
vi.mock('../server/ai/globalFutures.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    fetchGlobalLtpMap: vi.fn(async () => new Map([['AAPL', { price: 190.5, changePct: 0.4, ts: 1700000000000 }]])),
  };
});

import { initIntradayStream, watchSetForTests, __fetchQuotesForTests } from '../server/intraday/stream.js';
import {
  recordSignals, watcherSymbolsByMarket, evaluateTracked, getTrackRecord, flushTrackRecordState,
} from '../server/intraday/trackRecord.js';
import {
  fetchGlobalUsdcCandleQuotes, __resetGlobalForTests, __seedGcCacheForTests,
} from '../server/ai/globalFutures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const trackedSig = (over = {}) => ({
  symbol: 'BTC', market: 'CRYPTO', direction: 'LONG',
  entry: 8600000, stopLoss: 8550000, target1: 8700000, target2: 8800000,
  ltp: 8600000, confidence: 80, qtyPerLakh: 2,
  ...over,
});

// ============================================================
// [C1/C4/C5] — watcher qualified quote map
// ============================================================
describe('v21.4.1 [C1] — watcher market-qualified quote map (byMarket)', () => {
  beforeEach(() => {
    initIntradayStream({
      fetchGrowwNseQuote: async (s) => ({ price: s === 'RELIANCE' ? 2500 : 100, change: 1 }),
      fetchCoinDcxTickers: async () => ([
        { market: 'BTCINR', last_price: '8600000', change_24_hour: '1.2' },
        { market: 'ETHINR', last_price: '300000', change_24_hour: '0.8' },
        { market: 'SOLINR', last_price: '20000', change_24_hour: '0.4' },
      ]),
      // fetchIndexSpot jaan-boojh kar nahi — India index leg skip hota hai
    });
  });

  it('BTC dono desks pe tracked → CRYPTO bucket (INR plain) par FUTURES|BTC qualified key pe USDT truth', async () => {
    // same base, dono desks (same UTC dayKey) — the collision premise
    recordSignals([trackedSig({ symbol: 'BTC', market: 'CRYPTO' })]);
    recordSignals([trackedSig({ symbol: 'BTC', market: 'FUTURES', entry: 102000, stopLoss: 100000, target1: 104000, target2: 106000, ltp: 102000 })]);
    recordSignals([trackedSig({ symbol: 'ETH', market: 'FUTURES', entry: 3500, stopLoss: 3400, target1: 3600, target2: 3700, ltp: 3500 })]);

    const ws = watchSetForTests();
    expect(ws.get('BTC')).toBe('CRYPTO'); // first-write-wins paper/tracked-crypto — the UI/paper view

    const { quotes, byMarket } = await __fetchQuotesForTests(ws);
    // plain key: INR domain (paper/UI unchanged)
    expect(quotes.BTC?.price).toBe(8600000);
    expect(quotes.BTC?.src).toBe('coindcx-inr');
    // qualified keys: har desk ki apni truth
    expect(byMarket['CRYPTO|BTC']?.price).toBe(8600000);
    expect(byMarket['FUTURES|BTC']?.price).toBe(102000); // COLLISION REPAIR — BTC futures-bucket me nahi tha
    // ETH futures-bucket me tha (no crypto row) — dono keys pe USDT
    expect(quotes.ETH?.price).toBe(3500);
    expect(byMarket['FUTURES|ETH']?.price).toBe(3500);
  });

  it('[C4] futures/global legs ab upstream ka HONEST ts lete hain (Date.now() stamp nahi)', async () => {
    recordSignals([trackedSig({ symbol: 'BTC', market: 'FUTURES', entry: 102000, stopLoss: 100000, target1: 104000, target2: 106000, ltp: 102000 })]);
    recordSignals([trackedSig({ symbol: 'ETH', market: 'FUTURES', entry: 3500, stopLoss: 3400, target1: 3600, target2: 3700, ltp: 3500 })]);
    recordSignals([trackedSig({ symbol: 'AAPL', market: 'GLOBALFUTURES', entry: 190, stopLoss: 185, target1: 195, target2: 200, ltp: 190 })]);
    const ws = watchSetForTests();
    const { quotes, byMarket } = await __fetchQuotesForTests(ws);
    expect(quotes.ETH?.ts).toBe(1700000000000);                 // row ka apna ts, Date.now() nahi
    expect(byMarket['FUTURES|BTC']?.ts).toBe(1700000000000);
    expect(quotes.AAPL?.ts).toBe(1700000000000);                // global row ka apna ts
    expect(quotes.AAPL?.src).toBe('global-usdc');
  });

  it('end-to-end: evaluateTracked qualified map se futures row USDT domain pe hi settle hota hai', async () => {
    // FRESH symbols (SOL) — purane BTC rows level-freeze ho chuke the.
    // SOL CRYPTO (INR 20000/SL 19500) + SOL FUTURES (USDT 240/SL 243>entry).
    recordSignals([trackedSig({ symbol: 'SOL', market: 'CRYPTO', entry: 20000, stopLoss: 19500, target1: 20500, target2: 21000, ltp: 20000 })]);
    recordSignals([trackedSig({ symbol: 'SOL', market: 'FUTURES', entry: 240, stopLoss: 243, target1: 246, target2: 252, ltp: 240 })]);
    const ws = watchSetForTests();
    expect(ws.get('SOL')).toBe('CRYPTO'); // INR bucket — collision premise
    const { quotes, byMarket } = await __fetchQuotesForTests(ws);
    expect(byMarket['FUTURES|SOL']?.price).toBe(241); // collision repair worked
    evaluateTracked(quotes, [], byMarket);
    const rec = getTrackRecord(1);
    const futRow = [...rec.open, ...rec.history].find(r => r.symbol === 'SOL' && r.market === 'FUTURES');
    const cxRow = [...rec.open, ...rec.history].find(r => r.symbol === 'SOL' && r.market === 'CRYPTO');
    expect(futRow.status).toBe('SL_HIT');   // 241 ≤ 243 USDT — right domain
    expect(futRow.exitPrice).toBe(241);     // v21.13 gap-through parity: TRADED price (241), not the 243 level
    expect(cxRow.status).toBe('OPEN');       // 20000 > 19500 INR — untouched
    flushTrackRecordState();
  });
});

// ============================================================
// [C2] — globalFutures candle cache stale-prune
// ============================================================
describe('v21.4.1 [C2] — USDC candle cache prunes stale entries on serve', () => {
  beforeEach(() => { __resetGlobalForTests(); });

  it('a >90s-old candle entry is pruned on the serve path (fresher fallbacks get the slot)', async () => {
    const now = Date.now();
    __seedGcCacheForTests({
      BTC: { at: now, price: 102000, changePct: 0.1, ts: now },
      AAPL: { at: now - 120_000, price: 190, changePct: 0, ts: now - 120_000 }, // STALE (>90s)
    });
    // BTC fresh-cached → fresh=[] → serve path (NO network) → prune fires
    const m = await fetchGlobalUsdcCandleQuotes({ bases: ['BTC'] });
    expect(m.has('BTC')).toBe(true);         // fresh entry survives
    expect(m.has('AAPL')).toBe(false);        // stale entry PRUNED — Finnhub/Yahoo ko chance
  });

  it('a fresh entry inside the window survives untouched', async () => {
    const now = Date.now();
    __seedGcCacheForTests({ BTC: { at: now - 5_000, price: 102000, changePct: 0.1, ts: now - 5_000 } });
    const m = await fetchGlobalUsdcCandleQuotes({ bases: ['BTC'] });
    expect(m.has('BTC')).toBe(true);
    expect(m.get('BTC').price).toBe(102000);
  });
});

// ============================================================
// [C5] — crypto watch cap raised (source contract)
// ============================================================
describe('v21.4.1 [C5] — MAX_WATCH_CRYPTO 14 → 40', () => {
  it('the cap is 40 (tracked rows beyond 14 ab quotes leti hain)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server/intraday/stream.js'), 'utf8');
    expect(src).toContain('const MAX_WATCH_CRYPTO = 40;');
  });
});
