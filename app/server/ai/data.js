// ============================================================
// server/ai/data.js — market-data access layer for the AI engine
// ------------------------------------------------------------
// ONE place that knows how to reach every data source. Everything
// downstream (models, ensemble, options desk) consumes normalized
// structures and NEVER touches fetch() directly.
//
//   INDIA equities : TradingView India scanner (1 request, rich
//                    pre-computed indicators — proven in prod)
//   INDIA indices  : Yahoo Finance chart API (^NSEI, ^NSEBANK, …)
//   INDIA options  : NSE option-chain (cookie bootstrap) with a
//                    Black-Scholes synthetic fallback
//   CRYPTO         : CoinDCX public candles + tickers, TV crypto
//                    scanner as the USD-indicator source
//   FX             : Yahoo USDINR=X
//
// Every fetch is timeout-guarded and null-safe: an unreachable
// source degrades that market's signals — it never crashes the API.
// ============================================================
import { computeIndicatorsFromCandles as _computeIndicatorsFromCandles } from './lib/indicators.js';
import { fetchCoinDcxTickers } from '../cryptoStream.js';
import { TV_SCAN_HEADERS } from '../lib/tvHeaders.js';
// v20.7.8 [L5]: the SHARED disk-backed USDINR store — the leftover flat
// ×84 in fetchCryptoSnapshot priced exotic fallback symbols ~6-7% off at
// USDINR ≈ 89 (the exact class the v20.2 consolidation killed everywhere
// else). Last-known-good rate first; 84 only on a never-seen cold boot.
import { usdInrFallback as _usdInrFallback } from './lib/usdinr.js';
// v18.9: ONE market-clock definition — isNseOpen now shares the
// intraday/time.js NSE calendar (weekends + fixed + NSE_HOLIDAYS env),
// so the LIVE gauntlet and the scanner agree on "market band hai".
// time.js is import-free (pure) — no cycle is possible.
import { isNseMarketOpen as _isNseMarketOpenShared } from '../intraday/time.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ---------------- universes ----------------
// Liquid NSE large/mid caps — the AI scanner universe (kept tight
// for scanner latency: 44 symbols = 1 TV request + fast scan).
export const INDIA_UNIVERSE = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'BHARTIARTL', 'ITC',
  'LT', 'AXISBANK', 'KOTAKBANK', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI', 'ASIANPAINT',
  'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'TATAMOTORS', 'TATASTEEL', 'WIPRO', 'ONGC',
  'NTPC', 'POWERGRID', 'ADANIENT', 'ADANIPORTS', 'JSWSTEEL', 'HCLTECH', 'TECHM',
  'INDUSINDBK', 'CIPLA', 'DRREDDY', 'DIVISLAB', 'NESTLEIND', 'BAJAJFINSV', 'SHRIRAMFIN',
  'EICHERMOT', 'HEROMOTOCO', 'BAJAJ-AUTO', 'BPCL', 'COALINDIA', 'GRASIM', 'HINDALCO',
  'SBILIFE', 'HDFCLIFE',
];

export const CRYPTO_UNIVERSE = [
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'TRX', 'POL',
];

export const INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

// ---------------- TV scanner (INDIA) ----------------
// Two-tier column set: the extended set adds BB/Stoch/52w; if the
// scanner rejects any column, we retry once with the proven set.
const TV_FULL = [
  'close', 'open', 'high', 'low', 'volume', 'change',
  'EMA10', 'EMA20', 'EMA50', 'SMA20', 'SMA50',
  'RSI', 'MACD.macd', 'MACD.signal',
  'ATR', 'VWAP', 'ADX', 'ADX+DI', 'ADX-DI',
  'relative_volume_10d_calc',
  'Pivot.M.Classic.Middle', 'Pivot.M.Classic.S1', 'Pivot.M.Classic.R1',
  'BB.upper', 'BB.lower', 'Stoch.K', 'Stoch.D',
  'price_52_week_high', 'price_52_week_low',
  'Recommend.All',
];
const TV_SAFE = [...TV_FULL.slice(0, 23), 'Recommend.All']; // v20.7.8 [L4]: 24-col safe set — Recommend.All KEPT at d[23]; the old slice(0,23) read pf(d[23]) on a 23-col response → recommend was ALWAYS null on the safe-retry path

export async function fetchTVIndiaBatch(symbols) {
  const tickers = [], map = {};
  for (const s of symbols) {
    for (const ex of ['NSE', 'BSE']) {
      const t = `${ex}:${s}`;
      tickers.push(t);
      map[t] = s;
    }
  }
  for (const columns of [TV_FULL, TV_SAFE]) {
    try {
      const res = await fetch(`https://scanner.tradingview.com/india/scan?t=${Date.now()}`, {
        method: 'POST',
        headers: TV_SCAN_HEADERS,
        body: JSON.stringify({ symbols: { tickers: [...new Set(tickers)] }, columns }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.data) continue;
      const out = {};
      for (const item of data.data) {
        if (!item?.d) continue;
        const sym = map[item.s];
        if (!sym || out[sym]) continue;
        const d = item.d;
        const pf = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        out[sym] = {
          symbol: sym,
          exchange: item.s.split(':')[0],
          ltp: pf(d[0]), open: pf(d[1]), high: pf(d[2]), low: pf(d[3]),
          volume: pf(d[4]), changePct: pf(d[5]),
          ema10: pf(d[6]), ema20: pf(d[7]), ema50: pf(d[8]),
          sma20: pf(d[9]), sma50: pf(d[10]),
          rsi: pf(d[11]), macd: pf(d[12]), macdSignal: pf(d[13]),
          atr: pf(d[14]), vwap: pf(d[15]),
          adx: pf(d[16]), adxPlus: pf(d[17]), adxMinus: pf(d[18]),
          relVolume: pf(d[19]),
          pivot: { p: pf(d[20]), s1: pf(d[21]), r1: pf(d[22]) },
          bbUpper: columns === TV_FULL ? pf(d[23]) : null,
          bbLower: columns === TV_FULL ? pf(d[24]) : null,
          stochK: columns === TV_FULL ? pf(d[25]) : null,
          stochD: columns === TV_FULL ? pf(d[26]) : null,
          high52w: columns === TV_FULL ? pf(d[27]) : null,
          low52w: columns === TV_FULL ? pf(d[28]) : null,
          recommend: columns === TV_FULL ? pf(d[29]) : pf(d[23]),
        };
      }
      if (Object.keys(out).length > 0) return out;
    } catch { /* try the safe set */ }
  }
  return {};
}

// ---------------- v10.17 chunked India batch (full universe) ----------------
// The tiered full-universe scan can hand over 100+ symbols (200+
// NSE+BSE tickers) — the single-request path was never sized for
// that. Chunked at 60 symbols (120 tickers) per request, max 3
// concurrent, results merged first-match-wins (identical row shape
// to fetchTVIndiaBatch — a drop-in expansion, zero downstream edits).
const TV_INDIA_CHUNK_SYMS = 60;
const TV_INDIA_CHUNK_CONCURRENCY = 3;
export async function fetchTVIndiaBatchChunked(symbols) {
  const list = [...new Set((Array.isArray(symbols) ? symbols : []).map(s => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (list.length <= TV_INDIA_CHUNK_SYMS) return fetchTVIndiaBatch(list);
  const out = {};
  const chunks = [];
  for (let i = 0; i < list.length; i += TV_INDIA_CHUNK_SYMS) chunks.push(list.slice(i, i + TV_INDIA_CHUNK_SYMS));
  for (let i = 0; i < chunks.length; i += TV_INDIA_CHUNK_CONCURRENCY) {
    const group = chunks.slice(i, i + TV_INDIA_CHUNK_CONCURRENCY);
    const results = await Promise.allSettled(group.map(c => fetchTVIndiaBatch(c)));
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) Object.assign(out, r.value);
    });
  }
  return out;
}

// ---------------- TV scanner (CRYPTO, USD indicators) ----------------
export async function fetchTVCryptoBatch(symbols) {
  const tickers = symbols.map(s => `BINANCE:${s}USDT`);
  const columns = [
    'close', 'change', 'RSI', 'MACD.macd', 'MACD.signal',
    'EMA10', 'EMA20', 'EMA50', 'SMA20', 'SMA50',
    'ATR', 'ADX', 'ADX+DI', 'ADX-DI',
    'BB.upper', 'BB.lower', 'Stoch.K', 'Stoch.D',
    'relative_volume_10d_calc', 'Recommend.All',
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://scanner.tradingview.com/crypto/scan?t=${Date.now()}`, {
        method: 'POST',
        headers: TV_SCAN_HEADERS,
        body: JSON.stringify({ symbols: { tickers }, columns }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.data) continue;
      const out = {};
      for (const item of data.data) {
        if (!item?.d) continue;
        const base = String(item.s || '').replace('BINANCE:', '').replace('USDT', '');
        if (!base) continue;
        const d = item.d;
        const pf = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        out[base] = {
          symbol: base,
          usdPrice: pf(d[0]), changePct: pf(d[1]),
          rsi: pf(d[2]), macd: pf(d[3]), macdSignal: pf(d[4]),
          ema10: pf(d[5]), ema20: pf(d[6]), ema50: pf(d[7]),
          sma20: pf(d[8]), sma50: pf(d[9]),
          atr: pf(d[10]), adx: pf(d[11]), adxPlus: pf(d[12]), adxMinus: pf(d[13]),
          bbUpper: pf(d[14]), bbLower: pf(d[15]),
          stochK: pf(d[16]), stochD: pf(d[17]),
          relVolume: pf(d[18]), recommend: pf(d[19]),
        };
      }
      if (Object.keys(out).length > 0) return out;
    } catch { /* retry once */ }
  }
  return {};
}

// ---------------- CoinDCX public candles (crypto TA) ----------------
// https://public.coindcx.com/market_data/candles?pair=BTCINR&duration=1h&limit=300
const CANDLE_SOURCES = {
  '1m': { duration: '1m', limit: 300 },   // v18.5 MTF engine (LTF timing leg)
  '5m': { duration: '5m', limit: 300 },   // v18.5 MTF engine (LTF trigger leg)
  '1d': { duration: '1d', limit: 180 },   // v6.7 swing desk (daily bars)
  '1h': { duration: '1h', limit: 300 },   // swing/position TA
  '4h': { duration: '4h', limit: 300 },
  '15m': { duration: '15m', limit: 400 }, // aggressive TA
};

// ---------------- v12.6 CANDLE TTL CACHE (the bandwidth + speed fix) ----
// Every board cycle (60s, per market, 24+ symbols) used to re-download
// the FULL candle history from CoinDCX/Binance/Bybit — 299 of 300 bars
// are byte-identical between cycles (only the live bar moves). On
// Render that is ~0.5-1GB/day of pure outbound waste, and on the free
// tier it is a large slice of the 5GB quota. Cache per (source, base,
// tf): 1h/4h/1d bars live 5 minutes, 15m bars 3 minutes (the tape read
// wants fresher bars). Returns a COPY of the array (callers must never
// see a later cycle's mutation). Bounded (≤64 entries, LRU-ish prune).
const _candleCache = new Map(); // key -> { at, candles }
const CANDLE_CACHE_TF_TTL_MS = { '1m': 90_000, '5m': 120_000, '15m': 180_000, '1h': 300_000, '4h': 300_000, '1d': 300_000 };
const CANDLE_CACHE_MAX = 64;
function _candleCacheGet(key, tf) {
  const hit = _candleCache.get(key);
  if (!hit) return null;
  const ttl = CANDLE_CACHE_TF_TTL_MS[tf] ?? 300_000;
  if (Date.now() - hit.at > ttl) { _candleCache.delete(key); return null; }
  return hit.candles.slice(); // copy — callers never share the cache
}
function _candleCacheSet(key, candles) {
  if (!Array.isArray(candles)) return;
  if (_candleCache.size >= CANDLE_CACHE_MAX) {
    // prune the oldest quarter — bounded, no unbounded growth
    const entries = [..._candleCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < Math.ceil(CANDLE_CACHE_MAX / 4); i++) _candleCache.delete(entries[i][0]);
  }
  _candleCache.set(key, { at: Date.now(), candles });
}
/** Test hook — hermetic suites clear the candle cache between cases. */
export function __clearCandleCache() { _candleCache.clear(); }

export async function fetchCoinDcxCandles(base, tf = '1h', opts = {}) {
  const cfg = CANDLE_SOURCES[tf] || CANDLE_SOURCES['1h'];
  // v20.8.2 FIX (H1 — bot-lab warmup): callers (the bot-lab candle
  // chain) can request a DEEPER window than the board default; the
  // limit joins the cache key so a 1000-bar bot fetch can never be
  // served from the 300-bar board cache (or vice versa).
  const limit = Math.min(1000, Math.max(30, Math.floor(Number(opts.limit) || cfg.limit)));
  const cacheKey = `cdc:${base}:${tf}:${limit}`;
  const cached = opts.noCache ? null : _candleCacheGet(cacheKey, tf);
  if (cached) return cached;
  const pair = `${base}INR`;
  // v18.5 FIX: dropped the malformed dead "legacy" URL (it glued
  // `B${pair}_${Date.now()}` — wrong pair prefix AND a timestamp glued
  // with `_` instead of `&` — and the loop's slice(0,1) made it
  // unreachable anyway).
  const urls = [
    `https://public.coindcx.com/market_data/candles?pair=${pair}&duration=${cfg.duration}&limit=${limit}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const raw = await r.json();
      if (!Array.isArray(raw) || raw.length === 0) continue;
      // CoinDCX returns newest-first: [{ o, h, l, c, v, t }] with t in seconds (or ms on some pairs).
      const candles = raw.map(x => ({
        time: Number(x.t) < 1e12 ? Number(x.t) * 1000 : Number(x.t),
        open: Number(x.o), high: Number(x.h), low: Number(x.l),
        close: Number(x.c), volume: Number(x.v) || 0,
      })).filter(c => Number.isFinite(c.close) && c.close > 0)
        .sort((a, b) => a.time - b.time); // oldest-first for the TA lib
      if (candles.length >= 30) { _candleCacheSet(cacheKey, candles); return candles.slice(); }
    } catch { /* next source */ }
  }
  // v21.19.0 FIX: CoinDCX public /market_data/candles only accepts duration in
  // {1m, 15m, 1h, 1d} (returns HTTP 422 on 5m / 4h). Resample 1m→5m (5m bucket)
  // or 1h→4h (240m bucket) so 5m/4h callers get genuine resampled candles.
  if (tf === '5m' || tf === '4h') {
    const srcTf = tf === '5m' ? '1m' : '1h';
    const bucketMs = (tf === '5m' ? 5 : 240) * 60_000;
    const srcBars = await fetchCoinDcxCandles(base, srcTf, { ...opts, limit: Math.min(1000, limit * (tf === '5m' ? 5 : 4)) }).catch(() => null);
    if (Array.isArray(srcBars) && srcBars.length >= 60) {
      const resampled = [];
      let cur = null;
      for (const c of srcBars) {
        const bt = Math.floor(Number(c.time) / bucketMs) * bucketMs;
        if (!cur || cur.time !== bt) {
          if (cur) resampled.push(cur);
          cur = { time: bt, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
        } else {
          cur.high = Math.max(cur.high, c.high);
          cur.low = Math.min(cur.low, c.low);
          cur.close = c.close;
          cur.volume += c.volume || 0;
        }
      }
      if (cur) resampled.push(cur);
      if (resampled.length >= 30) {
        _candleCacheSet(cacheKey, resampled);
        return resampled.slice();
      }
    }
  }
  return null;
}

// ---------------- v11.2 Binance/Bybit public USDT klines (crypto candle fallback) ----------------
// Render/datacenter reality (verified 2026-09-17 live): public.coindcx.com candles
// AND the TV crypto scanner can both be IP-blocked while api.binance.com,
// data-api.binance.vision and api.bybit.com stay reachable. The crypto board's
// old candle chain (CoinDCX → Yahoo) died with them; this native crypto-OHLC
// source keeps the board alive. Output shape matches fetchCoinDcxCandles
// exactly (oldest-first {time ms, open, high, low, close, volume}, >=30 rows).
const BINANCE_KL_INTERVAL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
const BYBIT_KL_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
export async function fetchBinanceKlines(base, tf = '1h', opts = {}) {
  const sym = `${String(base || '').toUpperCase()}USDT`;
  if (!/^[A-Z0-9]{2,15}USDT$/.test(sym)) return null;
  const interval = BINANCE_KL_INTERVAL[tf] || '1h';
  // v20.8.2 FIX (H1 — bot-lab warmup + staleness): opts.limit deepens the
  // window (the bot lab needs >2017 bars for its 7-day ATR), opts.startTime
  // pages BACKWARDS for contiguous history, and opts.noCache bypasses the
  // shared TTL cache (a bot tick must never trade on a 120s-old snapshot).
  const limit = Math.min(1000, Math.max(30, Math.floor(Number(opts.limit) || (tf === '15m' ? 400 : 300))));
  const parts = [];
  if (opts.startTime != null) parts.push(`startTime=${Number(opts.startTime)}`);
  if (opts.endTime != null) parts.push(`endTime=${Number(opts.endTime)}`);
  const rangeQ = parts.length ? `&${parts.join('&')}` : '';
  const cacheKey = `bnk:${base}:${tf}:${limit}${rangeQ}`;
  const cached = opts.noCache ? null : _candleCacheGet(cacheKey, tf);
  if (cached) return cached;
  // Leg 1 + 2: Binance spot klines + the public market-data mirror
  // (data-api.binance.vision is Binance's keyless mirror — no geo-block).
  for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
    try {
      const r = await fetch(`${host}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}${rangeQ}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const raw = await r.json();
      if (!Array.isArray(raw) || raw.length < 30) continue;
      const candles = raw.map(k => ({
        time: Number(k[0]),
        open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
        close: Number(k[4]), volume: Number(k[5]) || 0,
      })).filter(c => Number.isFinite(c.close) && c.close > 0);
      if (candles.length >= 30) { _candleCacheSet(cacheKey, candles); return candles.slice(); } // already oldest-first
    } catch { /* next leg */ }
  }
  // Leg 3: Bybit public spot klines (newest-first → re-sort).
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${BYBIT_KL_INTERVAL[tf] || '60'}&limit=200`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length >= 30) {
        const candles = list.map(k => ({
          time: Number(k[0]),
          open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
          close: Number(k[4]), volume: Number(k[5]) || 0,
        })).filter(c => Number.isFinite(c.close) && c.close > 0)
          .sort((a, b) => a.time - b.time);
        // v20.9.1 [M]: Bybit leg HARDCODED limit=200 serve karti hai —
        // cacheKey requested limit (e.g. 1000 deep-history) ke naam pe
        // 200-bar shallow window CACHE ho jata tha aur agli deep request
        // cache se shallow hi milti thi. Sirf tab cache jab bars >=
        // requested, warna uncached return.
        if (candles.length >= 30) {
          if (candles.length >= limit) _candleCacheSet(cacheKey, candles);
          return candles.slice();
        }
      }
    }
  } catch { /* give up honestly */ }
  return null;
}

/** Crypto indicator snapshot: TV USD indicators re-scaled to INR via the live CoinDCX ticker. */
export async function fetchCryptoSnapshot(base) {
  const [tv, tickers] = await Promise.all([
    fetchTVCryptoBatch([base]),
    fetchCoinDcxTickers().catch(() => []),
  ]);
  const tvRow = tv[base];
  const ticker = (Array.isArray(tickers) ? tickers : []).find(t => t?.market === `${base}INR`);
  const inrPrice = ticker ? parseFloat(ticker.last_price) : null;
  if (!tvRow && inrPrice == null) return null;
  // v20.9.1 [M]: usdPrice missing + INR ticker present = scale UNKNOWN —
  // pehle scale=1 silently apply hota tha (USD-dimensioned ATR/EMA/BB ~89x
  // chhote INR numbers ki tarah emit, koi label nahi). Ab scaled fields
  // null + honest flags.
  const scaleKnown = Boolean(tvRow?.usdPrice && inrPrice);
  const scale = scaleKnown ? inrPrice / tvRow.usdPrice : null;
  const S = (v) => (scale != null && v != null ? v * scale : null);
  return {
    symbol: base,
    pair: `${base}INR`,
    ltp: inrPrice ?? (tvRow?.usdPrice ? tvRow.usdPrice * _usdInrFallback() : null),
    changePct: tvRow?.changePct ?? (ticker ? parseFloat(ticker.change_24_hour) || null : null),
    priceSource: inrPrice != null ? 'coindcx' : (tvRow ? 'tv-usd-approx' : null),
    // v20.9.1: scale unknown hone pe indicators ke scaled fields null hain
    // (raw USD values emit karna INR consumer ke liye ~89x corrupt hai).
    ...(scaleKnown ? {} : { indicatorsDegraded: 'usdPrice missing — INR re-scale impossible, scaled indicator fields nulled' }),
    indicators: tvRow ? {
      ...tvRow,
      // Re-scale USD-dimensioned fields into INR so entry/SL/targets
      // are in the currency the user actually trades.
      usdPrice: tvRow.usdPrice,
      atr: S(tvRow.atr),
      ema10: S(tvRow.ema10),
      ema20: S(tvRow.ema20),
      ema50: S(tvRow.ema50),
      sma20: S(tvRow.sma20),
      sma50: S(tvRow.sma50),
      bbUpper: S(tvRow.bbUpper),
      bbLower: S(tvRow.bbLower),
      macd: S(tvRow.macd),
      macdSignal: S(tvRow.macdSignal),
    } : null,
    candles: await fetchCoinDcxCandles(base, '1h').catch(() => null),
  };
}

// ---------------- Yahoo index quotes (spot + regime) ----------------
const YF_MAP = {
  NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
  SENSEX: '^BSESN', INDIAVIX: '^INDIAVIX', USDINR: 'USDINR=X', BTC: 'BTC-USD',
  // NSE sector indices + global risk proxies (MCP market tools). Each key
  // is fetched independently — a dead ticker is simply skipped.
  IT: '^CNXIT', AUTO: '^CNXAUTO', PHARMA: '^CNXPHARMA', FMCG: '^CNXFMCG',
  METAL: '^CNXMETAL', REALTY: '^CNXREALTY',
  USVIX: '^VIX', DXY: 'DX-Y.NYB', GOLD: 'GC=F', CRUDE: 'CL=F',
  // v21.9.0 METALS RESCUE: silver COMEX front — fetchMetalsPrices ki
  // Yahoo leg (gold ke saath pair) XAG price/changePct nikalti hai.
  SILVER: 'SI=F',
  // v10.4 GLOBAL EQUITY FUTURES desk regime: NASDAQ-100 (the tech-
  // complex risk barometer) + S&P 500 fallback.
  NDX: '^NDX', SPX: '^GSPC',
};

export async function fetchYahooQuotes(keys) {
  const out = {};
  await Promise.allSettled(keys.map(async (k) => {
    const yk = YF_MAP[k];
    if (!yk) return;
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yk)}?interval=1d&range=5d`;
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const meta = res?.meta;
      if (!meta) return;
      // v11.4 recheck: with range=5d, `chartPreviousClose` is the close
      // BEFORE the 5-session window — a ~5-day change masquerading as the
      // daily move every consumer (regime classifier, btcChangePct24h,
      // top-5 regime alignment, macro bias) assumes. `previousClose` is
      // Yahoo's true prior-session close — prefer it, keep the 5d window
      // (meta is always populated there) as a last-resort fallback.
      const prev = meta.previousClose ?? meta.chartPreviousClose;
      const price = meta.regularMarketPrice;
      if (!(price > 0)) return;
      out[k] = {
        price,
        changePct: prev > 0 ? ((price - prev) / prev) * 100 : 0,
      };
    } catch { /* skip this key */ }
  }));
  return out;
}

/**
 * v6.11 (glama cross-asset correlations): daily CLOSES for any
 * Yahoo symbol (^NSEI, BTC-USD, RELIANCE.NS …). Oldest-first,
 * nulls dropped, empty array on failure (caller degrades honestly).
 */
export async function fetchYahooDailyCloses(yahooSymbol, range = '3mo') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=${range}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return [];
    const j = await r.json();
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) return [];
    return closes.map(Number).filter(v => Number.isFinite(v) && v > 0);
  } catch { return []; }
}

/** v6.11: asset-key → Yahoo symbol (for correlation + sector desks). */
export const YF_SYMBOL = (k) => YF_MAP[k] || null;

// ---------------- NSE option chain (real, with cookie bootstrap) ----------------
const NSE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/option-chain',
};
let _nseCookie = null, _nseCookieAt = 0;
const NSE_COOKIE_TTL = 8 * 60 * 1000;
// v21.0.5: when DIRECT NSE refuses this host (datacenter IP / bot
// detection — spike-verified: the sandbox gets 403 from both
// nseindia.com endpoints), skip the dead probe for 10 minutes so the
// desk stays fast while the Groww mirror serves the REAL chain. A
// residential host (the user's laptop) never arms this — direct NSE
// keeps serving the richest feed (per-contract volume + ALL expiries
// in one payload).
const NSE_DIRECT_NEG_MS = 10 * 60 * 1000;
let _nseDirectNegUntil = 0;

export function __nseNegForTests() { return { directNegUntil: _nseDirectNegUntil }; }

async function nseBootstrapCookies() {
  if (_nseCookie && Date.now() - _nseCookieAt < NSE_COOKIE_TTL) return _nseCookie;
  try {
    const r = await fetch('https://www.nseindia.com/option-chain', {
      headers: NSE_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const raw = r.headers.getSetCookie?.() || [];
    if (raw.length) {
      _nseCookie = raw.map(c => c.split(';')[0]).join('; ');
      _nseCookieAt = Date.now();
    }
    return _nseCookie;
  } catch { return _nseCookie; }
}

/**
 * Normalize an expiry string to ISO YYYY-MM-DD (all-ISO contract).
 * Handles every format the live exchanges return:
 *   • 'YYYY-MM-DD'  — already ISO (synthetic/BSE-normalized) → passthrough
 *   • 'DD-Mmm-YYYY' — NSE live format ('13-Oct-2026')
 *   • 'DD Mmm YYYY' — BSE-ish ('17 Sep 2026')
 * Returns null when unparseable.
 *
 * v21.0.3 ROOT-CAUSE FIX: NSE's raw DD-Mmm-YYYY expiries were passed
 * through unnormalized, while EVERY downstream consumer (expiry pick,
 * daysToExpiry, BS yearsToExpiry, GEX, paper-trade ISO validation)
 * assumes ISO. Lexicographic compare of '13-Oct-2026' vs '2026-10-09'
 * picked a far monthly chain (or silently fell back to the model
 * chain), Greeks/GEX/DTE went null/zero, and option paper trades were
 * server-REJECTED on the ISO regex — the "options accurate nahi /
 * paper trade show nahi hua" bug.
 */
export function _expiryNormISO(s) {
  const t = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-\s]+([A-Za-z]{3})[-\s]+(\d{4})$/);
  if (m) {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mi = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(parseInt(m[1], 10)).padStart(2, '0')}`;
  }
  return null;
}

/**
 * REAL NSE option chain for an index. v21.0.5 LADDER:
 *   1. DIRECT NSE (richest: per-contract volume + every expiry in one
 *      payload — the residential-host path, cookie-bootstrapped)
 *   2. Groww public NIFTY mirror (the same verified relay that fixed
 *      SENSEX in v21.0.4 — datacenter-friendly, live LTP/OI/IV/spot;
 *      NIFTY alone: bank-nifty/fin-nifty pages are client-side
 *      rendered, their HTML carries no chain data)
 * Returns null when BOTH paths fail — the options desk then falls
 * back to the clearly-labeled Black-Scholes synthetic chain.
 * v21.0.3: ALL expiries are normalized to ISO by _expiryNormISO at
 * this boundary — the desk, Greeks, GEX and paper trades can keep
 * their all-ISO contract.
 */
export async function fetchNSEOptionChain(symbol) {
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const path = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'].includes(sym)
    ? `/api/option-chain-indices?symbol=${encodeURIComponent(sym)}`
    : `/api/option-chain-equities?symbol=${encodeURIComponent(sym)}`;
  // Step 1 — DIRECT NSE (skipped inside the 10-min negative hold after
  // a failed probe cycle; one cheap re-probe per window heals it).
  if (Date.now() >= _nseDirectNegUntil) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cookie = await nseBootstrapCookies();
        if (!cookie && attempt === 0) continue;
        const r = await fetch(`https://www.nseindia.com${path}`, {
          headers: { ...NSE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const j = await r.json();
        const rows = j?.records?.data;
        if (!Array.isArray(rows) || rows.length === 0) continue;
        // v21.0.3: normalize EVERY expiry to ISO at the source (see
        // _expiryNormISO header). Unparseable dates are dropped from the
        // list / fall back to the raw string so the desk's own fallback
        // (nextWeeklyExpiryFor) still has a path.
        _nseDirectNegUntil = 0; // live direct feed confirmed — never hold
        return {
          symbol: sym,
          spot: Number(j?.records?.underlyingValue) || null,
          expiryDates: (j?.records?.expiryDates || []).map(_expiryNormISO).filter(Boolean),
          rows: rows.map(x => ({
            strike: Number(x.strikePrice),
            expiry: _expiryNormISO(x.expiryDate) || String(x.expiryDate || ''),
            callOI: Number(x.CE?.openInterest) || 0,
            callOIChange: Number(x.CE?.changeinOpenInterest) || 0,
            callIV: Number(x.CE?.impliedVolatility) || null,
            callLTP: Number(x.CE?.lastPrice) || 0,
            callVolume: Number(x.CE?.totalTradedVolume) || 0,
            putOI: Number(x.PE?.openInterest) || 0,
            putOIChange: Number(x.PE?.changeinOpenInterest) || 0,
            putIV: Number(x.PE?.impliedVolatility) || null,
            putLTP: Number(x.PE?.lastPrice) || 0,
            putVolume: Number(x.PE?.totalTradedVolume) || 0,
          })),
          source: 'nse',
          // v21.1.1 [audit C4]: NSE option-chain-indices payload me lot-size
          // field NAHI hai (Groww mirror ke aggregatedDetails me hota hai).
          // Pehle undefined rehta tha → desk seedha hardcoded table use karta
          // tha aur "chain lotSize FIRST" claim galat read hota tha. Ab seedha
          // static fallback stamp hota hai + lotSizeSource marker — exchange
          // lot revision ho to desk UI me dikh jayega ki ye static hai.
          lotSize: NSE_STATIC_LOT_SIZES[sym] || null,
          lotSizeSource: NSE_STATIC_LOT_SIZES[sym] ? 'static-table (NSE payload lot-size field nahi rakhta)' : null,
          fetchedAt: Date.now(),
        };
      } catch { /* retry once more */ }
    }
    // Direct NSE refused this host — hold the dead probe for 10 min
    // (mirror serves the desk meanwhile; the hold self-clears on the
    // next successful direct cycle after it expires).
    _nseDirectNegUntil = Date.now() + NSE_DIRECT_NEG_MS;
  }
  // Step 2 — Groww public NIFTY mirror (verified REAL NSE chain relay,
  // datacenter-friendly). NIFTY only — the other index pages on groww
  // are client-side rendered and carry no chain data in the HTML.
  if (sym === 'NIFTY') {
    const mirror = await fetchGrowwIndexChain('NIFTY').catch(() => null);
    if (mirror) return mirror;
  }
  return null;
}

// ---------------- BSE option chain (SENSEX — best-effort, honest) ----------------
// v11.1 NSE+SENSEX addendum. RESEARCH-SPIKE VERDICT (17 Sep 2026 live
// probe from this host): bseindia.com AND api.bseindia.com both serve
// HTTP 403 Access Denied (Akamai CDN) to datacenter IPs — this sandbox
// CAN reach NSE's chain but NOT BSE's, so a Render deployment has no
// path either. The block is STRUCTURAL, not a transient outage.
//
// v21.0.4 UPDATE (9 Oct 2026 live re-probe): a WORKING public relay
// was found — groww.in's option-chain page (/options/sp-bse-sensex)
// server-renders the REAL BSE SENSEX chain (real LTPs, OI/prevOI,
// exchange Greeks + IV, weekly expiry list, lot size, live spot)
// inside <script id="__NEXT_DATA__">, and it is datacenter-IP
// friendly (the very sandbox that gets Akamai-403 from BSE fetches
// groww.in 200 OK). The mirror is tried FIRST; the direct BSE
// candidates below stay wired so a future CDN posture change (or a
// residential host, e.g. the user's own laptop) gets the pure-BSE
// feed with full parity. A negative cache (10 min after each failed
// probe cycle) keeps the dead probe nearly free; optionsDesk labels
// the SENSEX fallback 'bs-model-sensex-always' only when BOTH paths
// are unreachable — honesty by design.
const BSE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.bseindia.com/option-chain',
};
let _bseCookie = null, _bseCookieAt = 0;
const BSE_COOKIE_TTL = 8 * 60 * 1000;
const BSE_NEG_CACHE_MS = 10 * 60 * 1000;
let _bseNegUntil = 0;

async function bseBootstrapCookies() {
  if (_bseCookie && Date.now() - _bseCookieAt < BSE_COOKIE_TTL) return _bseCookie;
  try {
    const r = await fetch('https://www.bseindia.com/option-chain', {
      headers: BSE_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const raw = r.headers.getSetCookie?.() || [];
    if (raw.length) {
      _bseCookie = raw.map(c => c.split(';')[0]).join('; ');
      _bseCookieAt = Date.now();
    }
    return _bseCookie;
  } catch { return _bseCookie; }
}

/** Normalize a BSE-ish expiry string ('17 Sep 2026' | '2026-09-17') to YYYY-MM-DD. */
function _bseExpiryNorm(s) {
  const t = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (m) {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mi = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(parseInt(m[1], 10)).padStart(2, '0')}`;
  }
  return null;
}

/**
 * REAL BSE option chain for SENSEX — v21.0.4 LADDER:
 *   1. Groww public mirror (verified real BSE relay, datacenter-friendly)
 *   2. Direct BSE candidates (the future residential/CDN-change path)
 * Returns null when BOTH paths fail (the documented datacenter case) —
 * callers MUST label the fallback honestly (bs-model-sensex-always).
 */
export async function fetchBSEOptionChain(symbol = 'SENSEX') {
  const sym = String(symbol || 'SENSEX').toUpperCase();
  if (sym !== 'SENSEX') return null; // only the BSE flagship index is wired
  // Step 1 — Groww public mirror FIRST (verified-reachable REAL chain).
  // v21.0.6 [audit]: mirror ka APNA 5-min negative backoff usse govern
  // karta hai — whole-ladder 10-min hold ab SIRF direct-BSE probes ko
  // block karta hai. Pehle hold mirror ko bhi 10 min ke liye block karta
  // tha jabki mirror apne 5-min backoff ke baad recover ho sakta tha
  // (har outage pe 5 min extra model-chain SENSEX). Mirror success
  // kisi bhi stale hold ko clear kar deta hai.
  const mirror = await fetchGrowwIndexChain('SENSEX').catch(() => null);
  if (mirror) { _bseNegUntil = 0; return mirror; }
  if (Date.now() < _bseNegUntil) return null; // hold governs DIRECT probes only
  // Step 2 — direct BSE (two candidate endpoints, community-known
  // shapes). Neither is verifiable from a datacenter IP today — both
  // are attempted once (cheap: same fetch count as the old code).
  const paths = [
    `https://www.bseindia.com/OptionChain/GetOptionChain?symbol=${encodeURIComponent(sym)}`,
    `https://api.bseindia.com/BseIndiaAPI/api/OptionChain?symbol=${encodeURIComponent(sym)}`,
  ];
  for (const url of paths) {
    try {
      const cookie = await bseBootstrapCookies();
      const r = await fetch(url, {
        headers: { ...BSE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      // Tolerant parsing: accept NSE-like {records:{data:[…]}} OR a
      // top-level {data:[…]} / array of CE/PE rows.
      const records = j?.records || j;
      const rowsRaw = Array.isArray(records?.data) ? records.data
        : Array.isArray(j?.data) ? j.data
        : Array.isArray(j) ? j : null;
      if (!rowsRaw || rowsRaw.length === 0) continue;
      const rows = [];
      for (const x of rowsRaw) {
        const ce = x?.CE || x?.call || null;
        const pe = x?.PE || x?.put || null;
        if (!ce && !pe) continue;
        const expiry = _bseExpiryNorm(x?.expiryDate || x?.expiry || '');
        rows.push({
          strike: Number(x?.strikePrice ?? x?.strike),
          expiry: expiry || String(x?.expiryDate || x?.expiry || ''),
          callOI: Number(ce?.openInterest ?? ce?.oi) || 0,
          callOIChange: Number(ce?.changeinOpenInterest ?? ce?.chgOi) || 0,
          callIV: Number(ce?.impliedVolatility ?? ce?.iv) || null,
          callLTP: Number(ce?.lastPrice ?? ce?.ltp) || 0,
          callVolume: Number(ce?.totalTradedVolume ?? ce?.volume) || 0,
          putOI: Number(pe?.openInterest ?? pe?.oi) || 0,
          putOIChange: Number(pe?.changeinOpenInterest ?? pe?.chgOi) || 0,
          putIV: Number(pe?.impliedVolatility ?? pe?.iv) || null,
          putLTP: Number(pe?.lastPrice ?? pe?.ltp) || 0,
          putVolume: Number(pe?.totalTradedVolume ?? pe?.volume) || 0,
        });
      }
      const clean = rows.filter(r => Number.isFinite(r.strike) && r.strike > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.expiry));
      if (clean.length < 5) continue;
      const expiries = [...new Set(clean.map(r => r.expiry))].sort();
      _bseNegUntil = 0; // reached & parsed — clear any stale hold
      return {
        symbol: sym,
        spot: Number(records?.underlyingValue ?? j?.underlyingValue) || null,
        expiryDates: expiries,
        rows: clean,
        source: 'bse',
        fetchedAt: Date.now(),
      };
    } catch { /* next candidate */ }
  }
  // Both paths failed (the documented datacenter case) — hold off
  // for 10 minutes so SENSEX desks stay fast while the probe heals
  // itself the day BSE becomes reachable.
  _bseNegUntil = Date.now() + BSE_NEG_CACHE_MS;
  return null;
}

export function __bseNegForTests() { return { negUntil: _bseNegUntil, cookie: _bseCookie }; }
export function __resetBseForTests() { _bseNegUntil = 0; _bseCookie = null; _bseCookieAt = 0; _growwChainState.clear(); _nseDirectNegUntil = 0; }

// ---------------- Groww public index-chain mirrors (v21.0.4/v21.0.5) ----------------
// See the BSE research-spike note above. groww.in server-renders the
// REAL option chain (live LTP/OI/prevOI, exchange Greeks + IV, expiry
// list, lot size, live spot) into __NEXT_DATA__ for BOTH flagship
// indices:
//   • /options/sp-bse-sensex → the BSE SENSEX chain (v21.0.4)
//   • /options/nifty         → the NSE NIFTY chain (v21.0.5)
// Live re-probe (9 Oct 2026): bank-nifty / fin-nifty / midcp-nifty
// pages exist par ssrError=true — client-side render only, chain data
// never reaches the HTML — so the mirror ladder stays wired for the
// two flagship indices alone. Both pages are datacenter-IP friendly
// (the very sandbox that gets Akamai-403 from BSE / Cloudflare-403
// from NSE fetches groww.in 200 OK). One HTML GET per cache window,
// browser headers — exactly the posture of the NSE chain fetch (a
// public browser page, not a protected API). Payload ~1MB → parsed
// once, cached 90s PER INDEX.
const GROWW_INDEX_PAGES = {
  SENSEX: 'https://groww.in/options/sp-bse-sensex',
  NIFTY: 'https://groww.in/options/nifty',
};
// v21.1.1 [audit C4]: NSE-direct chains ke liye static lot table (NSE payload
// lot-size field nahi deta; Groww mirror real lot deta hai). optionsDesk.js ke
// LOT_SIZES ke saath sync me rakhna hai.
const NSE_STATIC_LOT_SIZES = { NIFTY: 75, BANKNIFTY: 35, FINNIFTY: 65, MIDCPNIFTY: 140, NIFTYNXT50: 25 };
const GROWW_CHAIN_TTL = 90 * 1000;      // re-fetch at most every 90s
// v21.7.0 (Issue-1): 5 min → 90s — NSE-direct 403 hone par Groww mirror
// hi live premiums ka source hai; ek transient blip (timeout/CDN hiccup)
// poore 5 min tak NIFTY/SENSEX cards ko BS-model premiums par dhakel
// deta tha (user ko "entry/exit galat" dikhta tha). 90s negative hold
// recovery 3x fast hai, abuse-guard bana rehta hai.
const GROWW_NEG_MS = 90 * 1000;     // back off 90s after a failure
const GROWW_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://groww.in/options',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1',
};
// per-index mirror state: { chain, at, negUntil }
const _growwChainState = new Map();

function _growwSt(index) {
  let s = _growwChainState.get(index);
  if (!s) { s = { chain: null, at: 0, negUntil: 0 }; _growwChainState.set(index, s); }
  return s;
}

export function __growwStateForTests(index = 'SENSEX') {
  const s = _growwChainState.get(index) || {};
  return { negUntil: s.negUntil || 0, cachedAt: s.at || 0, hasChain: !!s.chain };
}

/**
 * Parse groww's __NEXT_DATA__ payload into the NSE-normalized chain
 * shape (all-ISO expiries, rupee strikes, oi/prevOI → OI-change).
 * Exported for unit tests. Returns null on any sanity failure.
 * v21.0.5: meta { symbol, source, defaultLot } parameterizes the SAME
 * parser for both mirrors (SENSEX→bse, NIFTY→nse) — the page shape is
 * identical (optionContracts with paise strikes + liveData + greeks,
 * aggregatedDetails expiry list, company.liveData spot).
 */
export function _growwParseNextData(next, meta = {}) {
  const symbol = meta.symbol || 'SENSEX';
  const source = meta.source || 'bse';
  const defaultLot = meta.defaultLot || (symbol === 'NIFTY' ? 75 : 20);
  const pageData = next?.props?.pageProps?.data;
  const oc = pageData?.optionChain;
  const company = pageData?.company;
  const contracts = Array.isArray(oc?.optionContracts) ? oc.optionContracts : null;
  const agg = oc?.aggregatedDetails || {};
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(String(agg.currentExpiry || '')) ? agg.currentExpiry : null;
  if (!contracts || contracts.length < 5 || !expiry) return null;
  const spot = Number(company?.liveData?.ltp);
  const rows = [];
  for (const c of contracts) {
    const strike = Number(c?.strikePrice) / 100; // groww sends PAISE
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const ceL = c?.ce?.liveData || {}, peL = c?.pe?.liveData || {};
    const ceG = c?.ce?.greeks || {}, peG = c?.pe?.greeks || {};
    // v21.0.6 [audit]: OI-change ab REAL diff hai (unwinding NEGATIVE
    // allowed — direct NSE ka changeinOpenInterest bhi negative hota hai
    // aur downstream oiSkew/oiLean usi ko expect karta hai). Pehle
    // Math.max(0, oi−prevOI) clamp OI-unwinding signal ko erase kar deta
    // tha. Missing oi/prevOI fields → 0 (fabricated negative nahi).
    const _oiChg = (l) => {
      const oi = Number(l?.oi), prev = Number(l?.prevOI);
      return Number.isFinite(oi) && Number.isFinite(prev) ? (oi - prev) : 0;
    };
    rows.push({
      strike, expiry,
      callOI: Number(ceL.oi) || 0,
      callOIChange: _oiChg(ceL),
      callIV: Number(ceG.iv) || null,
      callLTP: Number(ceL.ltp) || 0,
      callVolume: 0, // public payload carries no per-contract volume
      putOI: Number(peL.oi) || 0,
      putOIChange: _oiChg(peL),
      putIV: Number(peG.iv) || null,
      putLTP: Number(peL.ltp) || 0,
      putVolume: 0,
    });
  }
  const clean = rows.filter(r => r.strike > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.expiry));
  if (clean.length < 5) return null;
  const expiryDates = [...new Set((Array.isArray(agg.expiryDates) ? agg.expiryDates : [])
    .map(d => _expiryNormISO(d)).filter(d => d && d >= expiry))].sort();
  return {
    symbol,
    spot: Number.isFinite(spot) && spot > 0 ? spot : null,
    spotChangePct: Number(company?.liveData?.dayChangePerc) || null,
    expiryDates: expiryDates.length ? expiryDates : [expiry],
    rows: clean,
    source,
    via: 'groww',
    lotSize: Number(agg.lotSize) || defaultLot,
    fetchedAt: Date.now(),
  };
}

/** Fetch the REAL index chain via groww's public page (SENSEX→bse,
 *  NIFTY→nse). 90s cache + 5-min negative backoff, per index. */
async function fetchGrowwIndexChain(index) {
  const url = GROWW_INDEX_PAGES[index];
  if (!url) return null;
  const st = _growwSt(index);
  if (Date.now() < st.negUntil) return null;
  if (st.chain && Date.now() - st.at < GROWW_CHAIN_TTL) return st.chain;
  try {
    const r = await fetch(url, { headers: GROWW_HEADERS, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('groww HTTP ' + r.status);
    const html = await r.text();
    const i = html.indexOf('<script id="__NEXT_DATA__"');
    if (i < 0) throw new Error('groww page has no __NEXT_DATA__');
    const s = html.indexOf('>', i) + 1;
    const e = html.indexOf('</script>', s);
    if (e < 0) throw new Error('groww __NEXT_DATA__ truncated');
    const chain = _growwParseNextData(JSON.parse(html.slice(s, e)), {
      symbol: index,
      source: index === 'SENSEX' ? 'bse' : 'nse',
    });
    if (!chain) throw new Error('groww chain failed sanity checks');
    st.chain = chain; st.at = Date.now(); st.negUntil = 0;
    return chain;
  } catch {
    st.negUntil = Date.now() + GROWW_NEG_MS; // short hold — mirror usually recovers
    return null;
  }
}

// ---------------- time / market-hours (IST) ----------------
export function istNow(now = new Date()) {
  return new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
}
export function isNseOpen(now = new Date()) {
  // v18.9 HOLIDAY-AWARE — the LIVE gauntlet / watchers / agent loops rode
  // this holiday-blind twin while intraday/time.js (the "single source of
  // truth") had the calendar: on Republic Day etc. LIVE entries passed the
  // gate into a closed market and 15:15 square-offs submitted orders the
  // exchange rejects. Both twins now share ONE definition.
  try {
    return _isNseMarketOpenShared(now);
  } catch {
    // graceful fallback to the old window check (never crash boot)
    const d = istNow(now);
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins >= 555 && mins <= 930; // 09:15–15:30
  }
}

// ---------------- test hooks ----------------
export const __testables = { TV_FULL, TV_SAFE, CANDLE_SOURCES };
