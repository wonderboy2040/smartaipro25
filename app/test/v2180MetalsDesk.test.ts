// ============================================================
// test/v2180MetalsDesk.test.ts — v21.8.0 GOLD (XAU/USDT) +
// SILVER (XAG/USDT) SPECIAL DESK inside the CoinDCX tab
// ------------------------------------------------------------
// User spec: "crypto gold (XAU USDT) and silver (XAG USDT) inko
// special TAB add karo CoinDCX TAB ke andar".
//
// Locked contracts:
//   A. futures.js metals module — METALS_BASES, isMetalsBase,
//      fapiKlinesToCandles (pure mapper), fetchMetalsFapiCandles
//      (non-metals → null, no fetch), fetchMetalsPrices (fapi 24h
//      ticker → futures-price row shape).
//   B. METALS board (hermetic, network stubbed) —
//      getSignals('METALS') serves XAU/XAG cards; every signal
//      carries market 'FUTURES' (the domain stamp — USDT perps:
//      execute gauntlet + deep + SSE FUT_ ticks + card currency),
//      while the board's own label stays 'METALS'; universe fixed;
//      candle chain CoinDCX-blocked → Binance fapi fallback answers.
//   C. Deep dive — getDeepSignal('XAU','METALS') routes the FUTURES
//      branch and answers with the fapi fallback chain.
//   D. discoverFuturesUniverse metals carve-out — XAU/XAG NEVER leak
//      onto the crypto GLOBAL FUTURES board (dedicated desk owns them).
//   E. sessionPhase — METALS + GLOBALFUTURES are 24/7 venues (the
//      v21.8.0 latent-bug fix: GLOBALFUTURES used to get NSE phases).
//   F. Source contracts — signals.js/routes.js/CoinDcxTab.tsx/
//      useAITrading.ts wiring (mapper, branch, stamp, desk button,
//      METALS board job).
// Hermetic: data.js mocked, global fetch stubbed per-URL.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-metals-desk');

// ---------------- the incident-style network matrix ----------------
// TV crypto scanner: BLOCKED (mocked {} — also the LIVE truth for
// BINANCE:XAUUSDT/XAGUSDT, verified 2026-10-13). CoinDCX public
// candlesticks: BLOCKED. CoinDCX futures RT: ALIVE (XAU/XAG rows).
// Binance fapi (klines + tickers + price book): ALIVE.
const XAU = 4190.5, XAG = 60.55, BTC = 83_000, ETH = 2_400;
const RT_FUTURES_PAYLOAD = {
  ts: Date.now(), vs: 54009972,
  prices: {
    // XAU deliberately has the TOP volume — the discovery carve-out
    // (contract D) must exclude it anyway.
    'B-XAU_USDT': { ls: XAU, pc: 0.44, h: XAU * 1.01, l: XAU * 0.99, v: 9_900_000, mp: XAU, mkt: 'XAUUSDT' },
    'B-XAG_USDT': { ls: XAG, pc: -0.28, h: XAG * 1.01, l: XAG * 0.99, v: 4_400_000, mp: XAG, mkt: 'XAGUSDT' },
    'B-BTC_USDT': { ls: BTC, pc: 1.2, h: BTC * 1.01, l: BTC * 0.99, v: 8_800_000, mp: BTC, mkt: 'BTCUSDT' },
    'B-ETH_USDT': { ls: ETH, pc: -0.8, h: ETH * 1.01, l: ETH * 0.99, v: 3_300_000, mp: ETH, mkt: 'ETHUSDT' },
  },
};
// Realistic OHLC wave (trend + oscillation) so RSI/MACD/ATR/ADX live.
const fapiKlines = (anchor) => Array.from({ length: 300 }, (_, i) => {
  const drift = Math.sin(i / 17) * 0.012 + (i / 300) * 0.05 - 0.02;
  const close = anchor * (1 + drift);
  return [
    1_700_000_000_000 + i * 3_600_000, // openTime (sec → ms-ified by mapper)
    String(close * 0.998), String(close * 1.004), String(close * 0.996), String(close),
    String(100 + (i % 7) * 10), 1_700_000_003_600, 'q', 0, 0, '0',
  ];
});
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE'],
  CRYPTO_UNIVERSE: ['BTC', 'ETH'],
  FUTURES_UNIVERSE: ['BTC', 'ETH'],
  fetchTVIndiaBatch: async () => ({}),
  fetchTVIndiaBatchChunked: async () => ({}),
  fetchTVCryptoBatch: async () => ({}),            // TV scanner BLOCKED (and metals-missing IRL)
  fetchCoinDcxCandles: async () => null,           // public.coindcx.com spot candles BLOCKED
  fetchBinanceKlines: async (base) => {
    const anchor = base === 'BTC' ? BTC : base === 'ETH' ? ETH : 100;
    return fapiKlines(anchor).map(k => ({ time: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
  },
  fetchYahooQuotes: async () => ({}),
  isNseOpen: () => false,
}));

const fetchMock = vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('public.coindcx.com/market_data/v3/current_prices/futures/rt')) return json(RT_FUTURES_PAYLOAD);
  if (u.includes('public.coindcx.com/market_data/candlesticks')) throw new Error('blocked (metals sim)');
  if (u.includes('fapi.binance.com/fapi/v1/klines')) {
    // v21.9.0 [THE REGRESSION LOCK]: real Binance fapi Sirf VALID intervals
    // accept karta hai (1m,3m,5m,15m,30m,1h,2h,4h,6h,8h,12h,1d,3d,1w,1M).
    // Purana mock interval param IGNORE karta tha — isliye v21.8.0 ka
    // `interval=60` bug (HTTP 400 Invalid interval) kabhi pakda nahi gaya.
    // Ab mock real API jaisa reject karta hai.
    const sym = /symbol=([A-Z0-9]+)/.exec(u)?.[1] || '';
    const interval = /interval=([a-zA-Z0-9]+)/.exec(u)?.[1] || '';
    const VALID = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);
    if (!VALID.has(interval)) {
      return new Response(JSON.stringify({ code: -1120, msg: 'Invalid interval.' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const anchor = sym === 'XAUUSDT' ? XAU : sym === 'XAGUSDT' ? XAG : sym === 'BTCUSDT' ? BTC : 100;
    return json(fapiKlines(anchor));
  }
  if (u.includes('fapi.binance.com/fapi/v1/ticker/24hr')) {
    const sym = /symbol=([A-Z0-9]+)/.exec(u)?.[1] || '';
    const anchor = sym === 'XAUUSDT' ? XAU : sym === 'XAGUSDT' ? XAG : 100;
    return json({ symbol: sym, lastPrice: String(anchor), priceChangePercent: '0.44', highPrice: String(anchor * 1.01), lowPrice: String(anchor * 0.99), quoteVolume: '9900000' });
  }
  if (u.includes('fapi.binance.com/fapi/v1/ticker/price')) {
    return json([{ symbol: 'XAUUSDT', price: String(XAU) }, { symbol: 'XAGUSDT', price: String(XAG) }, { symbol: 'BTCUSDT', price: String(BTC) }, { symbol: 'ETHUSDT', price: String(ETH) }]);
  }
  if (u.includes('api.binance.com/api/v3/ticker/price')) {
    return json([{ symbol: 'BTCUSDT', price: String(BTC) }, { symbol: 'ETHUSDT', price: String(ETH) }]);
  }
  throw new Error('offline (metals sim)');
});
vi.stubGlobal('fetch', fetchMock);

const {
  METALS_BASES, isMetalsBase, fapiKlinesToCandles, fetchMetalsFapiCandles, fetchMetalsPrices,
  futuresPairFor, __clearFuturesCandleCacheForTest, toFapiInterval, toYahooInterval,
  fetchMetalsYahooCandles, __metalsYahooForTest, __clearMetalsCachesForTest,
} = await import('../server/ai/futures.js');
const { getSignals, getDeepSignal, __clearSignalCaches } = await import('../server/ai/signals.js');
const { discoverFuturesUniverse } = await import('../server/ai/expertPicks.js');
const { sessionPhase } = await import('../server/ai/probrain.js');

beforeEach(() => {
  __clearSignalCaches();
  __clearFuturesCandleCacheForTest();
  __clearMetalsCachesForTest();
  fetchMock.mockClear();
});

// ============================================================
// A. futures.js metals module
// ============================================================
describe('v21.8.0 [A] futures.js metals module', () => {
  it('METALS_BASES = GOLD XAU + SILVER XAG; isMetalsBase guards', () => {
    expect(METALS_BASES).toEqual(['XAU', 'XAG']);
    expect(isMetalsBase('XAU')).toBe(true);
    expect(isMetalsBase('xag')).toBe(true);
    expect(isMetalsBase('BTC')).toBe(false);
    expect(isMetalsBase('')).toBe(false);
    expect(isMetalsBase(null)).toBe(false);
  });

  it('metals ride the standard futures pair namespace (B-XAU_USDT / B-XAG_USDT)', () => {
    expect(futuresPairFor('XAU')).toBe('B-XAU_USDT');
    expect(futuresPairFor('XAG')).toBe('B-XAG_USDT');
  });

  it('fapiKlinesToCandles: kline rows → house candle shape (ms time, ascending, filtered, min-30)', () => {
    const rows = fapiKlines(4190);
    const candles = fapiKlinesToCandles(rows);
    expect(Array.isArray(candles)).toBe(true);
    expect(candles.length).toBe(300);
    expect(candles[0].time).toBeGreaterThan(1e12);            // ms
    expect(candles[1].time).toBeGreaterThan(candles[0].time); // ascending
    for (const c of candles) {
      expect(c.open).toBeGreaterThan(0);
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.close).toBeGreaterThan(0);
      expect(typeof c.volume).toBe('number');
    }
    // < 30 usable rows → null (the fetchFuturesCandles contract)
    expect(fapiKlinesToCandles(fapiKlines(4190).slice(0, 12))).toBeNull();
    expect(fapiKlinesToCandles(null)).toBeNull();
    expect(fapiKlinesToCandles('nope')).toBeNull();
    // zero-close rows are dropped, not served
    const poisoned = [...fapiKlines(4190)];
    poisoned[5][4] = '0';
    const cleaned = fapiKlinesToCandles(poisoned);
    expect(cleaned.length).toBe(299);
  });

  it('fetchMetalsFapiCandles: XAU answers via fapi; non-metals base → null WITHOUT any fetch', async () => {
    const c = await fetchMetalsFapiCandles('XAU', '60');
    expect(Array.isArray(c)).toBe(true);
    expect(c.length).toBeGreaterThanOrEqual(30);
    expect(c.some(x => x.close > 3000)).toBe(true); // gold-scale, not 100-default
    const before = fetchMock.mock.calls.length;
    expect(await fetchMetalsFapiCandles('BTC', '60')).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(before);  // no wasted network for non-metals
  });

  it('fetchMetalsPrices: fapi 24h tickers → futures-price row shape (USDT 1:1, B-XAU_USDT pair)', async () => {
    const rows = await fetchMetalsPrices();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);
    const xau = rows.find(r => r.base === 'XAU');
    expect(xau).toBeTruthy();
    expect(xau.pair).toBe('B-XAU_USDT');
    expect(xau.last).toBeCloseTo(XAU, 0);
    expect(xau.volume).toBeGreaterThan(0);
    expect(xau.source).toBe('binance-fut-usdt');
    const xag = rows.find(r => r.base === 'XAG');
    expect(xag.last).toBeCloseTo(XAG, 0);
  });
});

// ============================================================
// B+C. the METALS board + deep dive (hermetic)
// ============================================================
describe('v21.8.0 [B] METALS board — GOLD & SILVER special desk (CoinDCX tab ke andar)', () => {
  it('getSignals("METALS") serves XAU/XAG cards; board label METALS, signals market FUTURES (domain stamp)', async () => {
    const board = await getSignals('METALS', {}, { noCache: true });
    expect(board.ok).toBe(true);
    expect(board.market).toBe('METALS');
    expect(board.marketOpen).toBe(true);
    expect(board.sessionPhase.phase).toBe('OPEN');           // 24/7 venue
    expect(board.sessionPhase.tradeable).toBe(true);
    const syms = board.signals.map(s => s.symbol);
    expect(syms).toContain('XAU');
    expect(syms).toContain('XAG');
    // THE DOMAIN STAMP: metals are normal B-XAU_USDT/B-XAG_USDT USDT
    // perps — every card carries market 'FUTURES' so execute gauntlet,
    // deep branch, SSE FUT_XAU ticks and SignalCard USDT currency all
    // work with ZERO new branches.
    for (const s of board.signals) {
      expect(s.market).toBe('FUTURES');
    }
    // plans are priced in the USDT (≈USD) domain — gold ~4k, silver ~60
    const xau = board.signals.find(s => s.symbol === 'XAU');
    expect(xau.ltp).toBeGreaterThan(1000);
    expect(xau.ltp).toBeLessThan(10_000);
    expect(xau.plan.entry).toBeGreaterThan(0);
    expect(xau.plan.stopLoss).toBeGreaterThan(0);
    expect(xau.plan.stopLoss).not.toBe(xau.plan.entry);      // distinct levels (pRoundLadder)
    // meta honesty
    expect(board.superIntelMeta.universeSize).toBe(2);
    expect(board.superIntelMeta.universeMode).toContain('metals-fixed');
    expect(String(board.superIntelMeta.priceSource)).toContain('coindcx-fut');
  }, 60_000);

  it('metals board survives a full CoinDCX REST outage: fapi price + fapi candles carry the board', async () => {
    // CoinDCX RT down + candlesticks down → fetchMetalsPrices + fapi klines legs
    const saved = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('public.coindcx.com')) throw new Error('CoinDCX outage (sim)');
      return saved(url);
    });
    try {
      const board = await getSignals('METALS', {}, { noCache: true });
      expect(board.ok).toBe(true);
      expect(board.signals.map(s => s.symbol).sort()).toEqual(['XAG', 'XAU']);
      // price chain: deep-stale CoinDCX rows YA fapi synth — dono honest
      // legs pass; the SURVIVAL is the contract.
      expect(String(board.superIntelMeta.priceSource)).toMatch(/coindcx-fut|binance-fut/);
      for (const s of board.signals) expect(s.market).toBe('FUTURES');
    } finally {
      fetchMock.mockImplementation(saved);
    }
  }, 60_000);

  it('deep dive: getDeepSignal("XAU", "METALS") routes the FUTURES branch and answers with a USDT plan', async () => {
    const deep = await getDeepSignal('XAU', 'METALS', {}, { fresh: true });
    expect(deep.ok).toBe(true);
    expect(deep.signal.symbol).toBe('XAU');
    expect(deep.signal.market).toBe('FUTURES');             // mapper + domain stamp
    expect(deep.signal.ltp).toBeGreaterThan(1000);          // gold-scale USDT
    expect(deep.signal.plan.entry).toBeGreaterThan(0);
    expect(deep.signal.plan.stopLoss).toBeGreaterThan(0);
  }, 60_000);
});

// ============================================================
// D. discovery carve-out — metals NEVER on the crypto futures board
// ============================================================
describe('v21.8.0 [D] discoverFuturesUniverse metals carve-out', () => {
  it('XAU/XAG with TOP-24h-volume still NEVER leak onto the GLOBAL FUTURES (crypto) board', async () => {
    // RT payload ranks XAU #1 by volume — the carve-out must still drop it.
    const bases = await discoverFuturesUniverse(40);
    expect(Array.isArray(bases)).toBe(true);
    expect(bases).not.toContain('XAU');
    expect(bases).not.toContain('XAG');
    // the crypto majors still flow through
    expect(bases).toContain('BTC');
    expect(bases).toContain('ETH');
  }, 30_000);
});

// ============================================================
// E. sessionPhase — 24/7 venues (latent-bug fix)
// ============================================================
describe('v21.8.0 [E] sessionPhase 24/7 venues', () => {
  it('METALS + GLOBALFUTURES + FUTURES + CRYPTO → always OPEN tradeable (never NSE phases)', () => {
    for (const m of ['METALS', 'GLOBALFUTURES', 'FUTURES', 'CRYPTO']) {
      const ph = sessionPhase(m, new Date('2026-10-11T04:00:00Z').getTime()); // a Sunday
      expect(ph.phase).toBe('OPEN');
      expect(ph.tradeable).toBe(true);
      expect(ph.note).toMatch(/Weekend|24\/7/);
    }
    // India keeps its real session phases
    const sunday = sessionPhase('INDIA', new Date('2026-10-11T04:00:00Z').getTime());
    expect(sunday.tradeable).toBe(false);
  });
});

// ============================================================
// F. source contracts — wiring the desk end-to-end
// ============================================================
const read = (p) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), p), 'utf8');

describe('v21.8.0 [F] source wiring contracts', () => {
  it('signals.js: METALS mapper + FUTURES||METALS board branch + domain stamp + deep routing + 15m tape', () => {
    const s = read('../server/ai/signals.js');
    expect(s).toMatch(/raw === 'METALS' \? 'METALS'/);                              // getSignals mapper
    expect(s).toMatch(/mkt === 'FUTURES' \|\| mkt === 'METALS'/);                   // board branch
    expect(s).toMatch(/if \(mkt === 'METALS'\) \{\s*\n\s*for \(const s of signals\) s\.market = 'FUTURES';/); // domain stamp
    expect(s).toMatch(/raw === 'FUTURES' \|\| raw === 'METALS' \? 'FUTURES'/);      // deep mapper
    expect(s).toMatch(/mkt === 'GLOBALFUTURES' \|\| mkt === 'METALS'/);             // 15m tape branch
    expect(s).toMatch(/isMetalsBase\(b\)/);                                        // fapi candle fallback
    expect(s).toMatch(/fetchMetalsPrices\(\)/);                                    // metals price fallback
    expect(s).toMatch(/metals-fixed/);                                              // universeMode honesty
  });

  it('routes.js: normMarket accepts METALS', () => {
    const s = read('../server/ai/routes.js');
    expect(s).toMatch(/m === 'METALS' \? 'METALS' : 'INDIA'/);
  });

  it('CoinDcxTab.tsx: 3-desk switcher with the GOLD & SILVER special tab + full wiring', () => {
    const s = read('../src/components/tabs/CoinDcxTab.tsx');
    expect(s).toMatch(/useState<'FUTURES' \| 'GLOBAL' \| 'METALS'>/);
    expect(s).toMatch(/switchDesk\('METALS'\)/);
    expect(s).toMatch(/GOLD & SILVER/);
    expect(s).toMatch(/XAU · XAG · 24\/7/);
    expect(s).toMatch(/desk === 'METALS' \? metals : globalFut/);                   // board selection
    expect(s).toMatch(/\['FUTURES', 'GLOBALFUTURES', 'METALS'\]/);                  // hook markets
    expect(s).toMatch(/\.\.\.futSyms, \.\.\.metalsSyms/);                           // SSE watch merge (FUT_ ticks)
    expect(s).toMatch(/desk !== 'GLOBAL' \? onExecuteFutures : undefined/);          // metals execute = futures gauntlet
    expect(s).not.toMatch(/ExpertPicksPanel/);                                      // permanently removed per v21.22.0 user spec
    expect(s).toMatch(/GOLD & SILVER DESK SNAPSHOT/);                               // stats strip label
  });

  it('useAITrading.ts: METALS board job + state', () => {
    const s = read('../src/components/aitrading/useAITrading.ts');
    expect(s).toMatch(/'GLOBALFUTURES' \| 'METALS'/);                     // type widened
    expect(s).toMatch(/boardJob\('METALS', setMetals/);                   // the fetch job
    expect(s).toMatch(/futures, globalFut, metals,/);                      // hook return
  });

  it('types.ts: MarketKind includes METALS (board label only — signals carry FUTURES)', () => {
    const s = read('../src/components/aitrading/types.ts');
    expect(s).toMatch(/'GLOBALFUTURES' \| 'METALS'/);
  });
});

// ============================================================
// G. v21.9.0 THE XAU/XAG RESCUE — interval fix + multi-source chain
// ============================================================
describe('v21.9.0 [G] metals rescue — interval mapping + Yahoo COMEX + gold-api chain', () => {
  it('toFapiInterval: TV resolutions → Binance intervals (THE bug — interval=60 tha, 1h chahiye)', () => {
    expect(toFapiInterval('60')).toBe('1h');
    expect(toFapiInterval('15')).toBe('15m');
    expect(toFapiInterval('5')).toBe('5m');
    expect(toFapiInterval('30')).toBe('30m');
    expect(toFapiInterval('240')).toBe('4h');
    expect(toFapiInterval('1D')).toBe('1d');
    expect(toFapiInterval('D')).toBe('1d');
    expect(toFapiInterval('1W')).toBe('1w');
    expect(toFapiInterval('1M')).toBe('1M');
    // already-Binance-style passthrough
    expect(toFapiInterval('1h')).toBe('1h');
    expect(toFapiInterval('15m')).toBe('15m');
    // garbage → null (caller '1h' default pe gira dega)
    expect(toFapiInterval('45')).toBeNull();
    expect(toFapiInterval('abc')).toBeNull();
    expect(toFapiInterval('')).toBeNull();
    expect(toFapiInterval(null)).toBeNull();
  });

  it('toYahooInterval: fapi interval → Yahoo chart interval', () => {
    expect(toYahooInterval('60')).toBe('1h');
    expect(toYahooInterval('15')).toBe('15m');
    expect(toYahooInterval('1D')).toBe('1d');
    expect(toYahooInterval('240')).toBe('1h'); // Yahoo 4h nahi deta — 1h
  });

  it('fetchMetalsFapiCandles: ab VALID interval bhejta hai (interval=1h URL me) — THE v21.8.0 regression lock', async () => {
    const c = await fetchMetalsFapiCandles('XAU', '60');
    expect(Array.isArray(c)).toBe(true);
    expect(c.length).toBeGreaterThanOrEqual(30);
    // THE assertion: request URL me interval=1h tha, 60 NAHI
    const klineCall = fetchMock.mock.calls.map((x) => String(x[0])).find((u) => u.includes('fapi.binance.com/fapi/v1/klines'));
    expect(klineCall).toBeTruthy();
    expect(klineCall).toMatch(/interval=1h/);
    expect(klineCall).not.toMatch(/interval=60\b/);
    // 15m bhi
    __clearMetalsCachesForTest();
    const c15 = await fetchMetalsFapiCandles('XAG', '15', 240);
    expect(Array.isArray(c15)).toBe(true);
    const kline15 = fetchMock.mock.calls.map((x) => String(x[0])).filter((u) => u.includes('fapi.binance.com/fapi/v1/klines')).pop();
    expect(kline15).toMatch(/interval=15m/);
  });

  it('fetchMetalsYahooCandles: GC=F/SI=F chart shape → house candles (USD domain)', async () => {
    const anchor = 4180; // COMEX gold USD
    const ts = Array.from({ length: 300 }, (_, i) => 1_700_000_000 + i * 3600);
    const closes = ts.map((_, i) => anchor * (1 + Math.sin(i / 17) * 0.012 + (i / 300) * 0.04 - 0.02));
    // Yahoo mock (encodeURIComponent('GC=F') === 'GC%3DF')
    __metalsYahooForTest(async (url) => {
      const u = String(url);
      if (!u.includes('query1.finance.yahoo.com')) throw new Error('wrong host');
      if (!u.includes('GC%3DF') && !u.includes('GC=F')) throw new Error(`wrong symbol: ${u}`);
      if (!u.includes('interval=1h')) throw new Error('yahoo interval wrong');
      return json({
        chart: { result: [{ meta: { symbol: 'GC=F' }, timestamp: ts, indicators: { quote: [{ open: closes.map((v) => v * 0.998), high: closes.map((v) => v * 1.004), low: closes.map((v) => v * 0.996), close: closes, volume: closes.map(() => 900) }] } }] },
      });
    });
    const candles = await fetchMetalsYahooCandles('XAU', '60');
    expect(Array.isArray(candles)).toBe(true);
    expect(candles.length).toBe(300);
    expect(candles[0].time).toBeGreaterThan(1e12);
    expect(candles.some((x) => x.close > 3000)).toBe(true); // gold-scale USD
    // non-metals → null
    expect(await fetchMetalsYahooCandles('BTC', '60')).toBeNull();
    __metalsYahooForTest(null);
  });

  it('fetchMetalsPrices: fapi down → gold-api.com spot fallback (source honest)', async () => {
    // fapi ticker down, gold-api zinda
    const saved = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('fapi.binance.com/fapi/v1/ticker/24hr')) throw new Error('fapi geo-blocked (sim)');
      if (u.includes('api.gold-api.com/price/XAU')) return json({ currency: 'USD', name: 'Gold', price: XAU, symbol: 'XAU', updatedAt: '2026-10-13T18:07:14Z' });
      if (u.includes('api.gold-api.com/price/XAG')) return json({ currency: 'USD', name: 'Silver', price: XAG, symbol: 'XAG', updatedAt: '2026-10-13T18:07:14Z' });
      return saved(url);
    });
    try {
      const rows = await fetchMetalsPrices();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(2);
      const xau = rows.find((r) => r.base === 'XAU');
      expect(xau.last).toBeCloseTo(XAU, 0);
      expect(xau.source).toBe('gold-api-spot');
      expect(xau.pair).toBe('B-XAU_USDT');
    } finally {
      fetchMock.mockImplementation(saved);
    }
  });

  it('METALS board survives a FULL Binance geo-block: gold-api prices + Yahoo COMEX candles carry the desk', async () => {
    // THE user-scenario test: CoinDCX candles dark + Binance poora
    // geo-blocked → Yahoo COMEX + gold-api hi board chalate hain.
    const saved = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('fapi.binance.com')) throw new Error('binance geo-blocked (sim)');
      if (u.includes('public.coindcx.com/market_data/candlesticks')) throw new Error('WAF blocked (sim)');
      if (u.includes('public.coindcx.com/market_data/v3/current_prices/futures/rt')) return saved(url); // RT zinda (prices)
      if (u.includes('api.gold-api.com/price/XAU')) return json({ price: XAU, symbol: 'XAU' });
      if (u.includes('api.gold-api.com/price/XAG')) return json({ price: XAG, symbol: 'XAG' });
      if (u.includes('query1.finance.yahoo.com/v8/finance/chart/GC')) {
        const ts = Array.from({ length: 300 }, (_, i) => 1_700_000_000 + i * 3600);
        const closes = ts.map((_, i) => 4150 * (1 + Math.sin(i / 17) * 0.012 + (i / 300) * 0.04 - 0.02));
        return json({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: closes.map((v) => v * 0.998), high: closes.map((v) => v * 1.004), low: closes.map((v) => v * 0.996), close: closes, volume: closes.map(() => 800) }] } }] } });
      }
      if (u.includes('query1.finance.yahoo.com/v8/finance/chart/SI')) {
        const ts = Array.from({ length: 300 }, (_, i) => 1_700_000_000 + i * 3600);
        const closes = ts.map((_, i) => 59.5 * (1 + Math.sin(i / 19) * 0.015 + (i / 300) * 0.03 - 0.015));
        return json({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: closes.map((v) => v * 0.998), high: closes.map((v) => v * 1.004), low: closes.map((v) => v * 0.996), close: closes, volume: closes.map(() => 700) }] } }] } });
      }
      return saved(url);
    });
    try {
      const board = await getSignals('METALS', {}, { noCache: true });
      expect(board.ok).toBe(true);
      expect(board.signals.map((s) => s.symbol).sort()).toEqual(['XAG', 'XAU']);
      for (const s of board.signals) {
        expect(s.market).toBe('FUTURES');
        expect(s.plan.entry).toBeGreaterThan(0);
      }
      const xau = board.signals.find((s) => s.symbol === 'XAU');
      expect(xau.ltp).toBeGreaterThan(1000); // gold-scale
      expect(xau.ltp).toBeLessThan(10_000);
    } finally {
      fetchMock.mockImplementation(saved);
    }
  }, 60_000);
});
