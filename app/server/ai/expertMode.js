// ============================================================
// server/ai/expertMode.js — EXPERT MODE orchestrator (v18.4)
// ------------------------------------------------------------
// "Advance Pro Trading AI Expert Mode" — assembles everything the
// LOCAL-AI expert engine needs and proxies it to the Python
// ml-service (/expert/analyze):
//
//   1. MULTI-TIMEFRAME CANDLES  15m + 1h + 4h + 1d
//        CRYPTO -> Binance/Bybit public klines (data.js)
//        IN/US  -> Yahoo chart API (server-side, CORS-free)
//   2. NEWS HEADLINES            Yahoo Finance RSS + Google News RSS
//                                (15-min cache) -> fed to FinBERT
//   3. RISK PARAMS               capital + risk_pct from the request
//
// The heavy AI (Chronos forecast + FinBERT sentiment + confluence
// ensemble) runs INSIDE the Python service — this module only
// gathers data and forwards it with the ML token.
//
// Honest failure: ML down / models missing -> 503 with a precise
// hint (never a fake expert answer).
// ============================================================

import { fetchBinanceKlines } from './data.js';

const ML_SERVICE_BASE = () =>
  // ml-service 8100 pe (v21.11 port fix; 8000 historical Laya port tha — v21.14 me removed)
  // v21.13.x recheck (M5): the .replace() was swallowed inside the comment
  // (a trailing slash in ML_SERVICE_URL produced //expert/analyze) —
  // ab genuinely applied.
  String(process.env.ML_SERVICE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');

const ML_HEADERS = () => ({
  'Content-Type': 'application/json',
  // ml-service enforces ML_API_TOKEN when set — forward it or every
  // call 401s (the v18.1 lesson).
  ...(process.env.ML_API_TOKEN ? { 'X-API-Key': process.env.ML_API_TOKEN } : {}),
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------- caches (bounded) ----------------
const _candleCache = new Map();   // key -> { at, data }
const _newsCache = new Map();     // key -> { at, items }
const CANDLE_TTL_MS = 5 * 60_000; // candles: 5 min
const NEWS_TTL_MS = 15 * 60_000;  // headlines: 15 min

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (map.size > 300) { // bound: oldest-entry sweep
    const first = map.keys().next().value;
    map.delete(first);
  }
  return null;
}
function cacheSet(map, key, data) { map.set(key, { at: Date.now(), data }); }

// ---------------- symbol resolution ----------------
// Returns { yahoo?: 'RELIANCE.NS', binance?: 'BTC' } per market.
const YF_INDEX_MAP = {
  NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
  SENSEX: '^BSESN', INDIAVIX: '^INDIAVIX',
  USVIX: '^VIX', DXY: 'DX-Y.NYB', GOLD: 'GC=F', CRUDE: 'CL=F',
  NDX: '^NDX', SPX: '^GSPC', BTC: 'BTC-USD', ETH: 'ETH-USD',
};

// Normalize the app's market labels (INDIA/IN, US/GLOBAL, CRYPTO,
// FUTURES, GLOBALFUTURES) to IN / US / CRYPTO for the expert engine.
function normExpertMarket(raw) {
  const m = String(raw || 'IN').toUpperCase();
  if (m === 'CRYPTO' || m === 'FUTURES' || m === 'GLOBALFUTURES') return 'CRYPTO';
  if (m === 'INDIA' || m === 'IN') return 'IN';
  return 'US';
}

function resolveSymbol(symbol, market) {
  const sym = String(symbol || '').trim().toUpperCase();
  const mkt = normExpertMarket(market);
  if (!sym) return {};
  if (mkt === 'CRYPTO') {
    const base = sym.replace(/USDT?$/, '').replace(/-USD$/, '');
    return { binance: base || sym };
  }
  if (YF_INDEX_MAP[sym]) return { yahoo: YF_INDEX_MAP[sym] };
  if (mkt === 'IN') {
    return { yahoo: /^[A-Z0-9&-]{1,10}\.(NS|BO)$/.test(sym) ? sym : `${sym}.NS` };
  }
  return { yahoo: sym }; // US / global
}

// ---------------- Yahoo chart candles (IN/US) ----------------
const YF_CHART_CFG = {
  '15m': { interval: '15m', range: '15d' },
  '1h': { interval: '60m', range: '3mo' },
  '4h': { interval: '60m', range: '1y' },   // sampled down to ~4h below
  '1d': { interval: '1d', range: '2y' },
};

async function fetchYahooChartCandles(yfSymbol, tf = '1h') {
  const cfg = YF_CHART_CFG[tf] || YF_CHART_CFG['1h'];
  const key = `yfc:${yfSymbol}:${tf}`;
  const cached = cacheGet(_candleCache, key, CANDLE_TTL_MS);
  if (cached) return cached;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?interval=${cfg.interval}&range=${cfg.range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp;
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q || !Array.isArray(q.close)) return null;
    let candles = [];
    for (let i = 0; i < ts.length; i++) {
      const c = Number(q.close[i]);
      const o = Number(q.open[i]);
      const h = Number(q.high[i]);
      const l = Number(q.low[i]);
      const v = Number(q.volume?.[i]) || 0;
      if (c > 0 && o > 0 && h >= l && h > 0 && l > 0) {
        candles.push({ time: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: v });
      }
    }
    // 4h: aggregate 1h bars (Yahoo has no 4h interval)
    if (tf === '4h' && candles.length) {
      // v21.1.1 [audit C10]: TIME-BUCKETED aggregation — pehle har 4th
      // INDEX pe chunk hota tha; Yahoo 1h bars me session gaps hote hain
      // (overnight/weekend) to index-chunk 20h+ span kar leta tha (ek "4h"
      // candle jo overnight gap ke aar-paar ban jati). Ab calendar-4h
      // buckets (UTC epoch floor) — gap-adjacent bars kabhi merge nahi hote.
      const BUCKET = 4 * 3600_000;
      const agg = [];
      let cur = null;
      for (const c of candles) {
        const b = Math.floor(c.time / BUCKET);
        if (!cur || cur.b !== b) {
          if (cur) agg.push(cur.bar);
          cur = { b, bar: { time: b * BUCKET, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } };
        } else {
          cur.bar.high = Math.max(cur.bar.high, c.high);
          cur.bar.low = Math.min(cur.bar.low, c.low);
          cur.bar.close = c.close;
          cur.bar.volume += c.volume;
        }
      }
      if (cur) agg.push(cur.bar);
      candles = agg;
    }
    if (candles.length >= 30) { cacheSet(_candleCache, key, candles); return candles; }
    return null;
  } catch { return null; }
}

// ---------------- multi-TF candle bundle ----------------
const EXPERT_TFS = ['15m', '1h', '4h', '1d'];

async function getExpertCandles(symbol, market) {
  const { yahoo, binance } = resolveSymbol(symbol, market);
  const out = {};
  const jobs = [];
  for (const tf of EXPERT_TFS) {
    if (binance) {
      jobs.push(fetchBinanceKlines(binance, tf).then(c => { if (c && c.length >= 30) out[tf] = c; }).catch(() => {}));
    }
    if (yahoo) {
      jobs.push(fetchYahooChartCandles(yahoo, tf).then(c => { if (c && c.length >= 30) out[tf] = c; }).catch(() => {}));
    }
  }
  await Promise.allSettled(jobs);
  return { candles: out, yahoo, binance };
}

// ---------------- news headlines (RSS, symbol-scoped) ----------------
function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchRss(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const xml = await r.text();
    // lightweight <item> extraction — no XML parser dependency
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < 30) {
      const block = m[1];
      const title = stripHtml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      if (title && title.length > 15) items.push(title);
    }
    return items;
  } catch { return []; }
}

async function getExpertHeadlines(symbol, market) {
  const sym = String(symbol || '').trim().toUpperCase();
  const key = `news:${market}:${sym}`;
  const cached = cacheGet(_newsCache, key, NEWS_TTL_MS);
  if (cached) return cached;
  const q = encodeURIComponent(sym);
  const feeds = [
    // Yahoo Finance RSS — works for US tickers, .NS and indices
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(resolveSymbol(symbol, market).yahoo || sym)}&region=US&lang=en-US`,
    // Google News RSS — catches India-market coverage Yahoo misses
    `https://news.google.com/rss/search?q=${q}+stock+OR+share+OR+earnings&hl=en-IN&gl=IN&ceid=IN:en`,
  ];
  const [a, b] = await Promise.allSettled(feeds.map(fetchRss));
  const items = [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : [])];
  const dedup = [...new Set(items.map(s => s.slice(0, 80)))].slice(0, 24);
  cacheSet(_newsCache, key, dedup);
  return dedup;
}

// ---------------- expert analyze (proxy to ml-service) ----------------
const _inFlight = new Map(); // cacheKey -> promise (coalesce concurrent)

export async function expertAnalyze(symbol, market, risk = {}) {
  const key = `${market}:${symbol}:${risk.capital || 0}:${risk.risk_pct || 1}`;
  const existing = _inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const { candles } = await getExpertCandles(symbol, market);
    if (!Object.keys(candles).length) {
      const err = new Error('no candle data available for this symbol (data sources unreachable)');
      err.status = 502;
      throw err;
    }
    const headlines = await getExpertHeadlines(symbol, market).catch(() => []);
    const payload = {
      symbol: String(symbol).toUpperCase(),
      market: normExpertMarket(market),
      candles,
      headlines,
      risk: {
        capital: Number(risk.capital) || 0,
        risk_pct: Number(risk.risk_pct) || 1,
      },
    };
    const r = await fetch(`${ML_SERVICE_BASE()}/expert/analyze`, {
      method: 'POST',
      headers: ML_HEADERS(),
      body: JSON.stringify(payload),
      // first call loads Chronos+FinBERT into RAM (can take 10-40s on
      // Windows) — generous timeout, still bounded
      signal: AbortSignal.timeout(90_000),
    });
    if (r.status === 401) throw new Error('ml-service rejected the token (ML_API_TOKEN mismatch)');
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.detail || `ml-service ${r.status}`);
    }
    const j = await r.json();
    j.data_sources = {
      timeframes: Object.keys(candles),
      headlines: headlines.length,
    };
    return j;
  })();

  _inFlight.set(key, p);
  p.finally(() => _inFlight.delete(key)).catch(() => {});
  return p;
}

// ---------------- passthrough helpers ----------------
export async function expertStatus() {
  const r = await fetch(`${ML_SERVICE_BASE()}/expert/status`, {
    headers: ML_HEADERS(),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw Object.assign(new Error(`ml-service ${r.status}`), { status: 503 });
  return r.json();
}

export async function expertDownloadModels(model = 'finbert') {
  const r = await fetch(`${ML_SERVICE_BASE()}/expert/models/download`, {
    method: 'POST',
    headers: ML_HEADERS(),
    body: JSON.stringify({ model: String(model || 'finbert') }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw Object.assign(new Error(`ml-service ${r.status}`), { status: 503 });
  return r.json();
}

export async function expertWarmModels() {
  const r = await fetch(`${ML_SERVICE_BASE()}/expert/models/warm`, {
    method: 'POST',
    headers: ML_HEADERS(),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw Object.assign(new Error(`ml-service ${r.status}`), { status: 503 });
  return r.json();
}
