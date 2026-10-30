// ============================================================
// server/ai/futures.js — CoinDCX GLOBAL FUTURES desk (v6.8)
// ------------------------------------------------------------
// CoinDCX's GLOBAL futures are USDT-margined perpetuals with
// instrument names like "B-BTC_USDT". This module owns EVERYTHING
// futures — data, wallets, execution gauntlet, position watching —
// so the spot path (coindcxOrders.js) stays untouched:
//
//  PUBLIC (no auth):
//   • fetchFuturesPrices()      RT prices (ls/mark/pc) — 20s cache
//   • fetchFuturesInstrumentMeta(pair) — max leverage / qty rules — 6h cache
//   • fetchFuturesCandles(pair)  candlesticks?…&pcode=f — TA source
//
//  PRIVATE (HMAC-signed, same coindcxPrivate transport):
//   • fetchFuturesWallets()     DF wallet balances (USDT margin)
//   • listFuturesPositions()    active_pos / avg_price / liquidation
//   • createFuturesOrder()      market/limit order (nested `order` body)
//   • exitFuturesPosition(id)   market exit by position id
//   • createFuturesTpsl()       NATIVE exchange TP/SL (survives server death)
//
//  EXECUTION:
//   • executeFuturesSignal()    the SAME gauntlet as spot: kill switch
//                               → auto policy → LIVE arming → fresh STRONG
//                               signal (venue FUTURES) → leverage sanity →
//                               wallet-margin sizing → journal caps
//   • watchFuturesPositions()   SL/TP/trailing/liquidation + exchange
//                               reconcile (native TP/SL closes detected)
//   • closeFuturesPosition()    manual close (market)
//
// Currency honesty: futures prices/margins are USDT; the shared journal
// and daily risk caps stay INR — every USDT amount carries its INR
// twin converted at the live USDINR rate (10-min cache, fallback 84).
// ============================================================
import crypto from 'node:crypto';
import { coindcxPrivate, coindcxConnected, coindcxEnvCreds } from '../mcp/coindcx.js';
import { loadJSON, saveJSON } from '../lib/store.js';
import { feeBreakevenFloor } from '../exec/sizing.js';
import { durablePut } from '../mcp/durable.js';
import { recordExecution, settlePositionOutcome, markPartialOutcome } from './ledger.js';
import { isAmbiguousTransportError } from './coindcxOrders.js'; // v20.3: ambiguous-retry guard (v18.9 spot fix, ported)
import { computeTrailSl, maxSaneLeverage, fitPlanToRiskCap, evaluateExecutionGate } from './ensemble.js';
import { pRound } from './lib/priceRound.js';
// v21.25.0 DIRECTION CERTIFICATE — strict side + explicit signal→order mapping.
import { normalizeSide, resolveActivePosSide, buildDirectionCertificate } from './directionCertificate.js';
import { withJournalLock, pushEntry, todayIST, dailyStats, ratchetSl, exitStageOf, loadProTraderConfig } from './coindcxOrders.js';
import { validateTick, wickJournalEntry } from './wickFilter.js';
import { futBookSnapshot } from './cxBookState.js';
import { actionKey, claimAction, finishAction, releaseAction, __resetTradeActionLogForTests } from './tradeActionLog.js';
// v21.23.11 MIRROR-SHIELD: candle wire-format drift → canonical ascending series.
import { canonicalizeCandles } from './lib/candles.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };
const ok = (r) => r && r.ok;

/** v21.22.0 USER SPEC: CoinDCX official site USDT/INR conversion rate (`1 USDT = Rs 102`). */
export const COINDCX_INR_PER_USDT = 102;

// ---------------- constants ----------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const PRICES_URL = 'https://public.coindcx.com/market_data/v3/current_prices/futures/rt';
const CANDLES_URL = 'https://public.coindcx.com/market_data/candlesticks';
const INSTRUMENT_URL = 'https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument';
const ORDERS_CREATE_PATH = '/exchange/v1/derivatives/futures/orders/create';
const POSITIONS_PATH = '/exchange/v1/derivatives/futures/positions';
const POSITIONS_EXIT_PATH = '/exchange/v1/derivatives/futures/positions/exit';
const POSITIONS_TPSL_PATH = '/exchange/v1/derivatives/futures/positions/create_tpsl';
const WALLETS_PATH = '/exchange/v1/derivatives/futures/wallets';

/** The futures universe we scan — liquid USDT perps matching the spot
 *  crypto universe (plus a couple of perp-only staples). */
export const FUTURES_UNIVERSE = [
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'TRX',
  // v20.3: MATIC hata diya (delisted → POL migration; the slot never
  // priced — a dead seed silently scanned every cycle).
  'POL',
];

export function futuresPairFor(base) {
  return `B-${String(base || '').toUpperCase()}_USDT`;
}
export function baseOfFuturesPair(pair) {
  const m = String(pair || '').match(/^B-([A-Z0-9]+)_USDT$/i);
  return m ? m[1].toUpperCase() : String(pair || '').toUpperCase();
}

// ---------------- v21.8.0: METALS DESK (GOLD XAU + SILVER XAG) ----------------
// CoinDCX futures book par B-XAU_USDT / B-XAG_USDT commodity perps listed
// hain (v11.3 note) — the RT book + pcode=f candlestick endpoint dono serve
// karte hain. YE module unke DEDICATED fallbacks deta hai:
//   • TV crypto scanner par BINANCE:XAUUSDT/XAGUSDT MISSING hai (verified
//     live — scanner returns {} for metals) → indicators candles se hi
//     bante hain (computeIndicatorsFromCandles), isliye candle chain ko
//     rock-solid hona chahiye.
//   • Binance SPOT par XAU/XAG listed NAHI (sirf PAXG/XAUT tokens) → the
//     generic fetchBinanceKlines fallback metals ke liye bekaar hai. FAPI
//     (Binance FUTURES) par XAUUSDT/XAGUSDT perps REAL hain (verified
//     live: fapi klines + 24h ticker dono kaam karte hain) → fapi is the
//     right fallback venue, USDT domain 1:1 (no rescale).
export const METALS_BASES = ['XAU', 'XAG'];
const METALS_SET = new Set(METALS_BASES);
export function isMetalsBase(base) {
  return METALS_SET.has(String(base || '').toUpperCase());
}
const METALS_FAPI_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const METALS_FAPI_TICKER = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
// v21.9.0 METALS RESCUE: Yahoo COMEX continuous fronts — gold GC=F /
// silver SI=F. Yahoo India-accessible hai (Binance fapi kuch Indian
// ISPs pe geo-blocked hai, CoinDCX Cloudflare WAF datacenter IPs pe
// 403 karta hai) → ye THIRD candle leg hai jo geo-chaloos hai.
// Domain: COMEX futures USD — spot XAU/XAG se ~0.3-0.8% contango pe;
// caller candles ko desk ke live anchor pe RESCALE karta hai
// (rescaleCandlesToLtp — ratios scale-invariant, levels domain-mein).
const METALS_YAHOO_SYMBOL = { XAU: 'GC=F', XAG: 'SI=F' };
// v21.9.0: free spot-price fallback (no key, no rate limit drama) —
// https://api.gold-api.com/price/XAU → { price, updatedAt } (~30s fresh).
const METALS_SPOT_API = 'https://api.gold-api.com/price/';

// v21.9.0 [THE XAU/XAG FIX]: TradingView-style resolutions ('60','15',
// '1D'…) Binance fapi me VALID INTERVALS NAHI hain — `interval=60`
// fapi se HTTP 400 `{"code":-1120,"msg":"Invalid interval."}` lauta
// deta tha (live-verified), isliye fetchMetalsFapiCandles kabhi bhi ek
// bhi candle nahi de pata tha aur METALS board har cycle "No metals
// data reachable" error se marti rahi. Ye PURE mapper TV resolution
// ko Binance interval me translate karta hai:
//   '1'→'1m' '5'→'5m' '15'→'15m' '30'→'30m' '60'→'1h' '120'→'2h'
//   '240'→'4h' '360'→'6h' '480'→'8h' '720'→'12h' '1D'/'D'→'1d'
//   '3D'→'3d' '1W'/'W'→'1w' '1M'→'1M'
// Already-Binance-style ('1h','15m'…) as-is pass through. Unknown → null.
const TV_TO_FAPI = {
  '1': '1m', '2': '2m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h', '360': '6h', '480': '8h', '720': '12h',
  'D': '1d', '1D': '1d', '2D': '2d', '3D': '3d', 'W': '1w', '1W': '1w',
  'M': '1M', '1M': '1M',
};
export function toFapiInterval(resolution) {
  const r = String(resolution ?? '').trim();
  if (!r) return null;
  if (/^[0-9]+[smhdwM]$/.test(r)) return r;      // already Binance-style
  return TV_TO_FAPI[r] || null;
}

/** PURE: Binance fapi kline rows → the house candle shape (same as
 * fetchFuturesCandles rows: {time,open,high,low,close,volume}, ascending).
 * Kline row: [openTime, open, high, low, close, volume, closeTime, …]. */
export function fapiKlinesToCandles(rows) {
  if (!Array.isArray(rows)) return null;
  const candles = rows.map(k => {
    const t = Number(Array.isArray(k) ? k[0] : k?.t);
    const o = num(Array.isArray(k) ? k[1] : k?.o);
    const h = num(Array.isArray(k) ? k[2] : k?.h);
    const l = num(Array.isArray(k) ? k[3] : k?.l);
    const c = num(Array.isArray(k) ? k[4] : k?.c);
    const v = num(Array.isArray(k) ? k[5] : k?.v) || 0;
    return { time: t < 1e12 ? t * 1000 : t, open: o, high: h, low: l, close: c, volume: v };
  }).filter(c => c.close > 0 && c.open > 0)
    .sort((a, b) => a.time - b.time);
  return candles.length >= 30 ? candles : null;
}

// v12.6-style TTL cache (fapi klines: 3 min for 15m, 5 min otherwise —
// same cadence as the futures candle cache; the metals board re-reads
// every cycle, 299/300 bars identical).
const _metalsKlineCache = new Map();
export async function fetchMetalsFapiCandles(base, resolution = '60', limit = 300) {
  const sym = String(base || '').toUpperCase();
  if (!isMetalsBase(sym)) return null;
  // v21.9.0 [THE FIX]: TV resolution → Binance interval translate.
  // Pehle raw '60'/'15' bhejte the → fapi 400 "Invalid interval" →
  // metals candles kabhi nahi aate the. Safe default '1h'.
  const interval = toFapiInterval(resolution) || '1h';
  const cacheKey = `met:${sym}:${interval}`;
  const ttl = interval === '15m' ? 180_000 : 300_000;
  const hit = _metalsKlineCache.get(cacheKey);
  if (hit && Date.now() - hit.at <= ttl) return hit.candles.slice();
  const url = `${METALS_FAPI_KLINES}?symbol=${sym}USDT&interval=${interval}&limit=${Math.max(60, Math.min(1000, limit))}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    // v21.9.0: HTTP 400 bhi ok(r) ho sakta tha? Nahi — 400 !ok hai; par
    // fapi error JSON ({"code":-1120}) 200 ke saath bhi nahi aata. Body
    // array-check hi kaafi hai (fapiKlinesToCandles null return karta hai).
    if (!ok(r)) return null;
    const j = await r.json().catch(() => null);
    const candles = fapiKlinesToCandles(Array.isArray(j) ? j : null);
    if (!candles) return null;
    if (_metalsKlineCache.size >= 8) _metalsKlineCache.clear(); // 2 syms × few TFs — trivial bound
    _metalsKlineCache.set(cacheKey, { at: Date.now(), candles });
    return candles.slice();
  } catch { return null; } // honest — caller's chain falls through
}

// ---------------- v21.26.0: GENERIC BINANCE FUTURES (fapi) KLINE LEG ----------------
// USER REPORT (2026-10-29): "live market candles ka data Websocket Futures
// se lelo, Spot se nahi". The MTF dual-board already rides CoinDCX futures
// REST + CoinDCX futures WS overlay (rawTfCandlesUsdt Leg-1); its fallback
// though was Binance SPOT klines (fetchBinanceKlines). Spot and perp series
// can diverge (wick depth, last-print venue basis) - exactly the "signal
// LONG, trade SHORT" class. This leg is the FUTURES-domain replacement:
//   Leg 1: Binance USDT-M futures klines (fapi)
//   Leg 2: Bybit USDT linear perp klines (same USDT domain)
// Never spot. Returns the house candle shape (ascending), >=30 bars or null.
const BINANCE_FUT_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const BYBIT_LINEAR_KLINES = 'https://api.bybit.com/v5/market/kline';
const TV_TO_BYBIT = {
  '1': '1', '3': '3', '5': '5', '15': '15', '30': '30',
  '60': '60', '120': '120', '240': '240', '360': '360', '480': '480', '720': '720',
  'D': 'D', '1D': 'D', 'W': 'W', '1W': 'W', 'M': 'M', '1M': 'M',
};
const _futKlineCache = new Map(); // key -> { at, candles }

export async function fetchBinanceFutKlines(base, resolution = '60', limit = 300) {
  const sym = String(base || '').toUpperCase().trim()
    .replace(/^(FUT_|GLOB_)/, '')
    .replace(/[-_](USDT|USDC|USD|INR)$/, '');
  if (!/^[A-Z0-9]{2,20}$/.test(sym)) return null;
  const interval = toFapiInterval(resolution) || '1h';
  const lim = Math.max(30, Math.min(1000, Math.floor(Number(limit) || 300)));
  const cacheKey = `bfk:${sym}:${interval}:${lim}`;
  const ttl = (interval === '1m' || interval === '5m' || interval === '15m') ? 12_000 : 60_000;
  const hit = _futKlineCache.get(cacheKey);
  if (hit && Date.now() - hit.at <= ttl) return hit.candles.slice();

  const remember = (candles) => {
    if (_futKlineCache.size >= 80) {
      const entries = [..._futKlineCache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < 16; i++) _futKlineCache.delete(entries[i][0]);
    }
    _futKlineCache.set(cacheKey, { at: Date.now(), candles });
    return candles.slice();
  };

  // Leg 1 - Binance USDT-M futures (fapi)
  try {
    const r = await fetch(
      `${BINANCE_FUT_KLINES}?symbol=${sym}USDT&interval=${interval}&limit=${lim}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) },
    );
    if (ok(r)) {
      const j = await r.json().catch(() => null);
      const candles = fapiKlinesToCandles(Array.isArray(j) ? j : null);
      if (candles) return remember(candles);
    }
  } catch { /* next leg */ }

  // Leg 2 - Bybit USDT linear perp (newest-first -> re-sort)
  try {
    const bi = TV_TO_BYBIT[String(resolution)] || TV_TO_BYBIT[interval] || '60';
    const r = await fetch(
      `${BYBIT_LINEAR_KLINES}?category=linear&symbol=${sym}USDT&interval=${bi}&limit=${Math.min(1000, lim)}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) },
    );
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length >= 30) {
        const candles = list.map(k => ({
          time: Number(k[0]),
          open: num(k[1]), high: num(k[2]), low: num(k[3]),
          close: num(k[4]), volume: num(k[5]) || 0,
        })).filter(c => c.close > 0 && c.open > 0)
          .sort((a, b) => a.time - b.time);
        if (candles.length >= 30) return remember(candles);
      }
    }
  } catch { /* honest null below */ }
  return null;
}

/** Test hook - hermetic suites clear the generic futures-kline cache. */
export function __clearBinanceFutKlineCacheForTest() { _futKlineCache.clear(); }

// ---------------- v21.9.0: METALS YAHOO COMEX CANDLE LEG ----------------
// Yahoo chart API se GC=F/SI=F candles — house shape, USD domain
// (caller rescales onto the desk anchor). TTL cache + negative cache,
// same discipline as the fapi leg. Hermetic tests fetchImpl inject
// kar sakte hain via __metalsYahooFetchForTest.
const _metalsYahooCache = new Map();   // key -> { at, candles }
let _metalsYahooNegUntil = 0;          // outage par 60s hold-off
let _metalsYahooFetchImpl = null;      // test hook
export function __metalsYahooForTest(impl) {
  _metalsYahooFetchImpl = impl;
  _metalsYahooCache.clear();
  _metalsYahooNegUntil = 0;
}
/** TV resolution → Yahoo chart interval (subset jo board use karta hai). */
export function toYahooInterval(resolution) {
  const f = toFapiInterval(resolution);
  if (!f) return null;
  const m = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '1h', '4h': '1h', '6h': '1h', '8h': '1h', '12h': '1h', '1d': '1d', '3d': '1d', '1w': '1wk', '1M': '1mo' };
  return m[f] || null;
}
const _yahooRangeFor = (interval, limit) => {
  // bars × interval → Yahoo range (15m max 60d, 1h max 730d, 1d max olavi)
  const n = Math.max(120, Math.min(1000, Number(limit) || 300));
  if (interval === '1m') return n <= 400 ? '1d' : '7d';
  if (interval === '5m' || interval === '15m' || interval === '30m') return n <= 300 ? '5d' : '1mo';
  if (interval === '1h') return n <= 300 ? '1mo' : '3mo';
  return '2y';
};
/**
 * Yahoo COMEX candles for XAU (GC=F) / XAG (SI=F).
 * Returns house-shape candles [{time,open,high,low,close,volume}] in
 * USD (COMEX domain) YA null. Caller MUST rescale onto its live anchor
 * (COMEX front ~0.3-0.8% spot se upar ho sakta hai).
 */
export async function fetchMetalsYahooCandles(base, resolution = '60', limit = 300) {
  const sym = String(base || '').toUpperCase();
  const yk = METALS_YAHOO_SYMBOL[sym];
  if (!yk) return null;
  if (Date.now() < _metalsYahooNegUntil) return null;
  const interval = toYahooInterval(resolution) || '1h';
  const cacheKey = `myh:${sym}:${interval}`;
  const ttl = interval === '15m' || interval === '30m' ? 180_000 : 300_000;
  const hit = _metalsYahooCache.get(cacheKey);
  if (hit && Date.now() - hit.at <= ttl) return hit.candles.slice();
  const f = _metalsYahooFetchImpl || ((u, o) => fetch(u, o));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yk)}?interval=${interval}&range=${_yahooRangeFor(interval, limit)}&includePrePost=false`;
  try {
    const r = await f(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
    if (!ok(r)) throw new Error(`yahoo ${r?.status}`);
    const j = await r.json().catch(() => null);
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp;
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) throw new Error('yahoo shape');
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = num(q.open?.[i]), h = num(q.high?.[i]), l = num(q.low?.[i]), c = num(q.close?.[i]);
      if (!(o > 0) || !(c > 0) || !(h > 0) || !(l > 0)) continue;
      candles.push({ time: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: num(q.volume?.[i]) || 0 });
    }
    if (candles.length < 30) throw new Error(`yahoo thin (${candles.length})`);
    // v21.23.12 [S2-PARITY — LOCAL SORT INVARIANT]: Binance/fapi legs apne
    // output ko KHUD sort karti hain (v21.23.4 S2); Yahoo legs wire-order
    // par bharosa karti thi. Ascending hote hain (observed), par invariant
    // ab LOCAL hai — wire drift pe bhi degrade-honest, mirror kabhi nahi.
    candles.sort((a, b) => a.time - b.time);
    if (_metalsYahooCache.size >= 8) _metalsYahooCache.clear();
    _metalsYahooCache.set(cacheKey, { at: Date.now(), candles });
    return candles.slice();
  } catch {
    _metalsYahooNegUntil = Date.now() + 60_000; // both syms share the hold-off
    return null;
  }
}

/** Metals price fallback — v21.9.0 ab THREE-leg chain hai (har leg
 * geo-bloated ho sakti hai, chain nahi):
 *   1. Binance fapi XAUUSDT/XAGUSDT 24h tickers (USDT 1:1 — best row)
 *   2. gold-api.com free spot (no key; price only — changePct pichhli
 *      successful fetch se, high/low/volume unknown → 0/null honest)
 *   3. Yahoo COMEX quotes GC=F/SI=F (price + previousClose → changePct)
 * Rows fetchFuturesPrices shape me ({pair, base, last, mark, changePct,
 * high, low, volume, ts, source}). 20s cache + 30s negative-cache. */
let _metalsPrices = { at: 0, rows: null, downUntil: 0 };
// gold-api leg ka last-price memory (changePct compute ke liye)
const _metalsSpotPrev = new Map(); // base -> { price, at }
async function _metalsPricesViaFapi() {
  const rows = await Promise.all(METALS_BASES.map(async (base) => {
    const r = await fetch(`${METALS_FAPI_TICKER}?symbol=${base}USDT`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!ok(r)) return null;
    const t = await r.json().catch(() => null);
    if (!t || !(Number(t.lastPrice) > 0)) return null;
    return {
      pair: futuresPairFor(base), base,
      last: num(t.lastPrice), mark: num(t.lastPrice),
      changePct: num(t.priceChangePercent), high: num(t.highPrice), low: num(t.lowPrice),
      volume: num(t.quoteVolume) || 0, ts: Date.now(), source: 'binance-fut-usdt',
    };
  }));
  return rows.filter(Boolean);
}
async function _metalsPricesViaSpotApi() {
  const f = globalThis.fetch?.bind(globalThis);
  if (!f) return null;
  const rows = await Promise.all(METALS_BASES.map(async (base) => {
    try {
      const r = await fetch(`${METALS_SPOT_API}${base}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
      if (!ok(r)) return null;
      const t = await r.json().catch(() => null);
      const p = num(t?.price);
      if (!(p > 0)) return null;
      const prev = _metalsSpotPrev.get(base);
      const changePct = prev && prev.price > 0 && Date.now() - prev.at < 30 * 60_000
        ? ((p - prev.price) / prev.price) * 100 : 0;
      _metalsSpotPrev.set(base, { price: p, at: Date.now() });
      return {
        pair: futuresPairFor(base), base,
        last: p, mark: p, changePct,
        high: null, low: null, volume: 0, ts: Date.now(), source: 'gold-api-spot',
      };
    } catch { return null; }
  }));
  const okRows = rows.filter(Boolean);
  return okRows.length > 0 ? okRows : null;
}
async function _metalsPricesViaYahoo() {
  try {
    const { fetchYahooQuotes } = await import('./data.js');
    // YF_MAP keys: GOLD (GC=F) + v21.9.0 SILVER (SI=F)
    const q = await fetchYahooQuotes(['GOLD', 'SILVER']);
    const rows = [];
    const m = { GOLD: 'XAU', SILVER: 'XAG' };
    for (const [k, base] of Object.entries(m)) {
      const p = num(q?.[k]?.price);
      if (!(p > 0)) continue;
      rows.push({
        pair: futuresPairFor(base), base,
        last: p, mark: p, changePct: num(q?.[k]?.changePct) || 0,
        high: null, low: null, volume: 0, ts: Date.now(), source: 'yahoo-comex',
      });
    }
    return rows.length > 0 ? rows : null;
  } catch { return null; }
}
export async function fetchMetalsPrices() {
  if (Date.now() < _metalsPrices.downUntil) return null;
  if (_metalsPrices.rows && Date.now() - _metalsPrices.at < 20_000) return _metalsPrices.rows;
  // Leg order: fapi (fullest rows) → gold-api spot → Yahoo COMEX quotes
  let rows = await _metalsPricesViaFapi().catch(() => null);
  if (!rows || rows.length === 0) rows = await _metalsPricesViaSpotApi().catch(() => null);
  if (!rows || rows.length === 0) rows = await _metalsPricesViaYahoo().catch(() => null);
  if (!rows || rows.length === 0) {
    _metalsPrices.downUntil = Date.now() + 30_000;
    return null;
  }
  _metalsPrices = { at: Date.now(), rows, downUntil: 0 };
  return rows;
}

// ---------------- USDINR (shared conversion, cached) ----------------
// v20.2: the last-known rate is recorded into ai/lib/usdinr (disk-backed)
// — a cold boot + Yahoo FX outage now re-hydrates yesterday's rate instead
// of falling to the flat 84 (~5% error at USDINR ~88).
import { usdInrRecord, usdInrFallback } from './lib/usdinr.js';
let _usdInr = null, _usdInrAt = 0;
export async function fetchUsdInr() {
  if (_usdInr && Date.now() - _usdInrAt < 10 * 60_000) return _usdInr;
  try {
    const { fetchYahooQuotes } = await import('./data.js');
    const q = await fetchYahooQuotes(['USDINR']);
    const v = num(q?.USDINR?.price);
    if (v > 40 && v < 150) {
      _usdInr = v; _usdInrAt = Date.now();
      usdInrRecord(v, 'yahoo-quotes');
      return v;
    }
  } catch { /* fall back to the last-known rate */ }
  return _usdInr || usdInrFallback();
}
const inrOfUsdt = (usdt, usdInr) => (Number.isFinite(usdt) ? Math.round(usdt * usdInr * 100) / 100 : null);

// ---------------- PUBLIC: RT prices ----------------
let _pricesCache = null, _pricesAt = 0;
// v21.1.1 [audit B10]: futures watcher per-pair error-telegram throttle (pair::reason → last ts)
const _futWatchErrAlerts = new Map();
let _pricesInflight = null; // v10.10: single-flight — the 2s RT stream + board compute share ONE round-trip
// v11.3: deep-stale window — the LAST resort before throwing. A
// 3-min-old official book keeps the futures board alive (and honest —
// rows keep their real ts) while REST heals.
const PRICES_DEEP_STALE_MS = 180_000;
// v11.3: negative cache for the Binance/Bybit synth leg — when the leg
// returns nothing (blocked / empty), hold off 30s instead of hammering
// fapi on every 2s stream beat while CoinDCX REST is dark. A SUCCESS
// never arms it (the synth becomes the serving source).
const SYNTH_NEG_MS = 30_000;
let _synthDownUntil = 0;
/**
 * Live futures prices. Returns [{ pair, base, last, mark, changePct,
 * high, low, volume }] — one row per active USDT perp. 20s default cache
 * (the SSE crypto stream pattern: one shared round-trip, nobody hits the
 * upstream per-request); the v10.10 ultra-fast stream passes maxAgeMs≈1.3s
 * and joins the in-flight fetch instead of stacking a second one.
 * v11.3 RESILIENCE CHAIN (the "futures board dead on Render" fix):
 *   REST RT (public.coindcx.com) → official WS book (cxBookState — the
 *   stream's currentPrices@futures@rt socket) → Binance fapi 24h tickers
 *   (same USDT-perp domain, honest 'binance-fut' source) → deep-stale
 *   cache serve → throw. Every fallback row carries `source`.
 */
export async function fetchFuturesPrices({ maxAgeMs = 20_000 } = {}) {
  if (_pricesCache && Date.now() - _pricesAt < maxAgeMs) return _pricesCache;
  if (_pricesInflight) return _pricesInflight;
  const probe = (async () => {
    try {
      const r = await fetch(PRICES_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!ok(r)) throw new Error(`futures prices HTTP ${r?.status}`);
      const j = await r.json();
      const map = j?.prices && typeof j.prices === 'object' ? j.prices : null;
      if (!map) throw new Error('futures prices: unexpected payload');
      const rows = _rowsFromRtPayload(j, map);
      if (rows.length === 0) throw new Error('futures prices: empty');
      _pricesCache = rows; _pricesAt = Date.now();
      return rows;
    } catch {
      // v11.3 leg 2 — the official futures WS book (fresh ≤5s rows from
      // the stream socket; happens to be FASTER than REST when healthy).
      const book = futBookSnapshot(5_000);
      if (book.size > 0) {
        const rows = [...book.values()];
        _pricesCache = rows; _pricesAt = Date.now();
        return rows;
      }
      // v11.3 leg 3 — Binance fapi / Bybit linear USDT-perp tickers (1:1
      // domain), rate-limited by the negative cache so a dead CoinDCX
      // never turns into a 2s fapi hammer.
      // v12.7 BANDWIDTH: the fapi leg now requests ONLY the board's
      // universe symbols (?symbols= JSON-array param) instead of the
      // full ~500-symbol 1-2MB book — the futures board scans
      // FUTURES_UNIVERSE, so the synth leg only ever needs those rows.
      if (Date.now() >= _synthDownUntil) {
        const synth = await _binanceFutRows(FUTURES_UNIVERSE).catch(() => null);
        if (synth && synth.length > 0) {
          _pricesCache = synth; _pricesAt = Date.now();
          return synth;
        }
        _synthDownUntil = Date.now() + SYNTH_NEG_MS;
      }
      // v11.3 leg 4 — deep-stale serve.
      if (_pricesCache && Date.now() - _pricesAt < PRICES_DEEP_STALE_MS) return _pricesCache;
      throw new Error('futures prices: all legs failed');
    }
  })();
  _pricesInflight = probe;
  try { return await probe; } finally { _pricesInflight = null; }
}

/** RT payload → rows (shared by the REST leg; extracted v11.3 so the
 *  fallback legs produce the identical shape). */
function _rowsFromRtPayload(j, map) {
  const rows = [];
  // v10.13 (deep-recheck M3): normalize the payload epoch to MILLISECONDS.
  // CoinDCX's top-level `ts` is seconds; consumers (cxRtStream's WS
  // out-of-order guard, liveFeed freshness) compare against ms values —
  // mixed units made correctness luck-dependent.
  const rawTs = num(j?.ts);
  const tsMs = rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now();
  for (const [pair, p] of Object.entries(map)) {
    if (!p || typeof p !== 'object') continue;
    const last = num(p.ls);
    if (!(last > 0)) continue; // dark/illiquid rows carry ls=0
    rows.push({
      pair: String(pair),
      base: baseOfFuturesPair(pair),
      last,
      mark: num(p.mp) || last,
      changePct: num(p.pc),
      high: num(p.h),
      low: num(p.l),
      volume: num(p.v),
      ts: tsMs,
    });
  }
  return rows;
}

/** v11.3 leg 3 — Binance fapi / Bybit linear 24h ticker book →
 *  CoinDCX-shaped rows. Same USDT-perp domain (zero projection risk);
 *  source: 'binance-fut' / 'bybit-fut'.
 *  v21.13.x BANDWIDTH (P2 recheck): `bases` (optional array) now issues
 *  PER-SYMBOL `?symbol=` requests (fapi ignores the ?symbols= JSON-array
 *  param — live-verified) so a dark-CoinDCX board fetch pulls ~20 tiny
 *  rows (~2KB total) instead of the full ~793-symbol ~1.1MB book.
 *  No bases = full book (legacy callers/discovery). */
async function _binanceFutRows(bases) {
  // v21.13.x recheck (P2): fapi /fapi/v1/ticker/24hr IGNORES the
  // ?symbols=["A","B"] JSON-array param (live-verified: a 12-symbol
  // request returns the FULL ~793-row ~1.1MB book — single symbol= works)
  // — the v12.7 bandwidth optimization was silently defeated and a
  // CoinDCX-dark episode re-pulled the whale every 2s poll. Per-symbol
  // `symbol=` requests instead: ~20 tiny rows (~2KB total) + LOWER total
  // request weight (N×1 vs 40 for the full book). No bases → full book
  // (legacy callers/discovery).
  if (Array.isArray(bases) && bases.length > 0) {
    const symbols = [...new Set(bases.map(b => String(b || '').toUpperCase()).filter(Boolean))]
      .map(b => `${b}USDT`).slice(0, 100);
    if (symbols.length > 0) {
      const settled = await Promise.allSettled(symbols.map(async (sym) => {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(sym)}`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(8000),
        });
        if (!ok(r)) throw new Error(`fapi ${sym} HTTP ${r?.status}`);
        return r.json();
      }));
      const raw = settled.filter(s => s.status === 'fulfilled').map(s => s.value).filter(Boolean);
      const rows = _rowsFromBinanceFut(raw, 'binance-fut');
      if (rows.length > 0) return rows;
      // v21.13.x recheck (P2b): 0 rows → FALL THROUGH to the full-book +
      // Bybit legs, NEVER an early null — a geo-blocked fapi (451 India)
      // per-symbol fan-out must not kill the Bybit rescue leg (the exact
      // leg-3′ scenario: CoinDCX dark + Binance dark → Bybit serves).
      // Per-symbol weight (N×1) is cheap; the negative cache upstream
      // still caps the retry cadence.
    }
  }
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (ok(r)) {
      const raw = await r.json();
      if (Array.isArray(raw) && raw.length > 0) {
        const rows = _rowsFromBinanceFut(raw, 'binance-fut');
        if (rows.length > 0) return rows;
      }
    }
  } catch { /* next leg */ }
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (ok(r)) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const rows = [];
        const now = Date.now();
        for (const x of list) {
          if (!x || typeof x.symbol !== 'string' || !x.symbol.endsWith('USDT')) continue;
          const base = x.symbol.slice(0, -4);
          const last = parseFloat(x.lastPrice);
          if (!base || !(last > 0)) continue;
          rows.push({
            pair: `B-${base}_USDT`,
            base,
            last,
            mark: parseFloat(x.markPrice) || last,
            changePct: (parseFloat(x.price24hPcnt) || 0) * 100,
            high: parseFloat(x.highPrice24h) || 0,
            low: parseFloat(x.lowPrice24h) || 0,
            volume: parseFloat(x.volume24h) || 0,
            ts: now,
            source: 'bybit-fut',
          });
        }
        if (rows.length > 0) return rows;
      }
    }
  } catch { /* give up honestly */ }
  return null;
}

function _rowsFromBinanceFut(raw, source) {
  const rows = [];
  const now = Date.now();
  for (const x of raw) {
    if (!x || typeof x.symbol !== 'string' || !x.symbol.endsWith('USDT')) continue;
    const base = x.symbol.slice(0, -4);
    const last = parseFloat(x.lastPrice);
    if (!base || !(last > 0)) continue;
    rows.push({
      pair: `B-${base}_USDT`,
      base,
      last,
      mark: parseFloat(x.markPrice) || last,
      changePct: parseFloat(x.priceChangePercent) || 0,
      high: parseFloat(x.highPrice) || 0,
      low: parseFloat(x.lowPrice) || 0,
      volume: parseFloat(x.volume) || 0,
      ts: now,
      source,
    });
  }
  return rows;
}
let _instrumentMetaCache = new Map();
/** Instrument rules for one pair (max leverage, qty precision, minimums).
 *  The endpoint shape is documented with max_leverage_long/short; qty
 *  precision/min-quantity keys vary by API revision — every plausible
 *  key is tried (the CoinDCX field-name lesson, learned twice). */
export async function fetchFuturesInstrumentMeta(pair, { bust = false } = {}) {
  const key = String(pair).toUpperCase();
  const hit = _instrumentMetaCache.get(key);
  // v21.23.10 [META-TTL]: 'unknown' (fallback/guessed) meta sirf 60s cache —
  // pehle 6h! Ek network hiccup ka guessed qtyPrecision/minQty:0 us window
  // ke saare live orders ko galat precision/laddar rejects me dhakelta tha.
  if (!bust && hit && Date.now() - hit._at < (hit._fallback ? 60_000 : 6 * 3600_000)) return hit;
  if (bust) _instrumentMetaCache.delete(key);
  try {
    // v21.26.6 [PAIR-CASE]: CoinDCX's instrument endpoint is CASE-SENSITIVE.
    // Lowercase `pair=b-bnb_usdt` silently returns the DEFAULT instrument
    // (live-verified 2026-10-29: B-LAB_USDT, minQty 1 / increment 1) — every
    // perp then inherited LAB's precision (0 dp!) and min-qty, so BNB/ETH/
    // SOL/BTC qty rounded to 0 and the BNB auto trade died at "Quantity 0
    // below exchange min (2)". Uppercase returns the REAL row (BNB min 0.01
    // / inc 0.01). Same uppercase lesson as the candlesticks pcode=f leg.
    const url = `${INSTRUMENT_URL}?pair=${encodeURIComponent(key.toUpperCase())}&margin_currency_short_name=USDT`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (ok(r)) {
      const j = await r.json();
      const i = j?.instrument && typeof j.instrument === 'object' ? j.instrument : (j && typeof j === 'object' && !Array.isArray(j) ? j : null);
      if (i) {
        const qtyInc = num(i.quantity_increment) ?? num(i.min_trade_size) ?? null;
        const incPrecision = qtyInc != null && qtyInc > 0
          ? (qtyInc >= 1 ? 0 : Math.min(8, Math.max(0, Math.round(-Math.log10(qtyInc)))))
          : null;
        const dynLevKeys = i.dynamic_position_leverage_details && typeof i.dynamic_position_leverage_details === 'object'
          ? Object.keys(i.dynamic_position_leverage_details).map(Number).filter(n => Number.isFinite(n) && n >= 1)
          : [];
        const dynMaxLev = dynLevKeys.length > 0 ? Math.max(...dynLevKeys) : null;
        const meta = {
          pair: String(i.pair || key),
          maxLeverage: Math.max(1, Math.floor(Math.min(
            num(i.max_leverage) ?? num(i.max_leverage_long) ?? 10,
            num(i.max_leverage_short) ?? num(i.max_leverage_long) ?? 10,
          ))),
          dynamicMaxLeverage: dynMaxLev,
          qtyPrecision: Math.max(0, Math.min(8, Math.round(
            num(i.quantity_precision) ?? num(i.qty_precision) ?? num(i.precision) ?? incPrecision ?? guessPrecision(key)
          ))),
          minQty: num(i.min_qty) ?? num(i.min_quantity) ?? num(i.minimum_qty) ?? 0,
          minNotional: num(i.min_notional) ?? 0,
          safetyPct: num(i.safety_percentage) ?? 2,
          status: String(i.status || 'active'),
          _at: Date.now(),
        };
        _instrumentMetaCache.set(key, meta);
        return meta;
      }
    }
  } catch { /* fall back to the conservative default */ }
  const meta = { pair: key, maxLeverage: 10, qtyPrecision: guessPrecision(key), minQty: 0, status: 'unknown', _fallback: true, _at: Date.now() };
  _instrumentMetaCache.set(key, meta);
  return meta;
}
function guessPrecision(pair) {
  const base = baseOfFuturesPair(pair);
  const p = { BTC: 4, ETH: 3, BNB: 2, SOL: 1, XRP: 0, DOGE: 0, ADA: 0, AVAX: 1, LINK: 1, DOT: 1, TRX: 0, POL: 0 }[base];
  return p != null ? p : 3;
}
export function roundFuturesQty(pair, qty, precision = null) {
  // v21.3.0 (Issue-4): the fetched instrument meta's qtyPrecision is now
  // HONOURED (pehle sirf the hardcoded guess table — unusual instruments
  // (jinke base guess me nahi) galat precision pe round hote the aur
  // exchange minQty/stepSize reject kar deta tha).
  const p = Number.isFinite(precision) && precision >= 0 && precision <= 8 ? Math.floor(precision) : guessPrecision(pair);
  return Math.floor(Number(qty) * 10 ** p) / 10 ** p;
}

// ============================================================
// v21.3.0 (Issue-4) ONE-CLICK LIVE EXECUTE PRE-FLIGHT — READ-ONLY.
// ------------------------------------------------------------
// The old ⚡ EXECUTE LIVE button ONE CLICK = REAL ORDER — no preview,
// no gate checklist, silent 1x-leverage/₹1000-margin defaults, aur har
// rejection POST-Click toast me milti thi. Ye function wahi gauntlet
// + sizing DRY-RUN karta hai: koi order nahi, koi journal entry nahi,
// sirf the would-be ticket + pass/fail gate list (modal me dikhta hai).
// ============================================================
export async function futuresExecutePrecheck(opts) {
  const { symbol, side, marginUSDT, leverage, getFreshSignal } = opts || {};
  const out = { ok: true, symbol: String(symbol || '').toUpperCase(), side: side || null, gates: [], ticket: null, warnings: [] };
  const gate = (name, pass, detail = null, blocking = true) => {
    out.gates.push({ name, pass: !!pass, detail, blocking: blocking !== false });
    if (!pass && blocking !== false) out.ok = false;
  };
  try {
    const cfg = await import('./coindcxOrders.js').then(m => m.loadConfig());
    const pair = futuresPairFor(symbol);
    const base = baseOfFuturesPair(pair);
    out.pair = pair;

    // ---- gates (the same ladder executeFuturesSignal runs, READ-ONLY) ----
    gate('Kill switch', !cfg.killSwitch, cfg.killSwitch ? 'ON — execution disabled' : 'off');
    try {
      const { isKilled, killLevel, killReason } = await import('../exec/reconciler.js');
      if (typeof isKilled === 'function') {
        const k = isKilled();
        gate('Exec kill', !k, k ? `L${killLevel()} ACTIVE (${killReason() || 'no reason'})` : 'clear');
      }
    } catch { /* single-node local */ }
    try {
      const { goLiveGateBlocked } = await import('./strategyGuard.js');
      const g = goLiveGateBlocked();
      gate('GO-LIVE gate (paper track-record)', !g.blocked, g.blocked ? g.reason : (g.readiness?.stats ? `settled ${g.readiness.stats.settled}/${g.readiness.stats.minTrades} trades` : 'pass'));
    } catch { /* guard unavailable */ }
    try {
      const { strategyGuardBlocked } = await import('./strategyGuard.js');
      const g = strategyGuardBlocked('manual', 'FUTURES');
      gate('Strategy health', !g.blocked, g.blocked ? g.reason : 'no paused strategy');
    } catch { /* guard unavailable */ }
    gate('LIVE arming', cfg.mode === 'live', cfg.mode === 'live' ? 'armed' : 'type LIVE in Risk settings to arm');
    gate('CoinDCX connection', coindcxConnected(), coindcxConnected() ? 'connected' : 'connect an API key');

    // ---- fresh signal read (no mutation) ----
    // v21.4.1 [C3]: mode 'paper' → 'live' — parity with the REAL execute
    // gauntlet. Paper mode 10-min board fallback tak allow karta tha:
    // modal "Fresh signal ✓ · 480s old" dikha sakta tha jabki actual execute
    // (mode live) strict fresh deep-run hi leta hai (90s, no fallback).
    // Precheck ab wahi source padhta hai jo order fire hone par chalega.
    const signal = typeof getFreshSignal === 'function' ? await getFreshSignal(pair, { mode: 'live' }).catch(() => null) : null;
    const sigAgeMs = signal?.generatedAt ? Date.now() - Number(signal.generatedAt) : null;
    gate('Fresh signal', !!signal, signal ? `${signal.grade ?? '—'} · conf ${signal.confidence ?? '—'}% · ${sigAgeMs != null ? `${Math.round(sigAgeMs / 1000)}s old` : 'age n/a'}` : 'no fresh signal (deep/board feed down)');
    if (signal) {
      const sideMatch = !side || !signal.side || signal.side === side;
      gate('Side match', sideMatch, sideMatch ? `consensus ${signal.side}` : `board flipped: ${signal.side} vs requested ${side}`);
      if (signal.ucRejected) out.warnings.push('Ultrafast chart verification REJECTED this direction');
      // v21.11: CONFLICT warning me kaun ULTA side pe hai + uski conviction
      // — direction ka pata chalta hai (user ka exact complaint).
      // v21.14: sirf jev provider.
      if (signal.aiConfirm?.verdict === 'CONFLICT') {
        const flips = ['jev']
          .filter((n) => signal.aiConfirm?.detail?.[n]?.v === 'DISAGREE')
          .map((n) => {
            const d = signal.aiConfirm.detail[n];
            const p = d.picked === 'enter_short' ? d.pShort : d.picked === 'enter_long' ? d.pLong : null;
            return `Jev ${d.picked === 'enter_short' ? 'SHORT' : 'LONG'}${p != null ? ` ${Math.round(p * 100)}%` : ''}`;
          });
        out.warnings.push(`AI CONFLICT on this signal${flips.length ? ` — ${flips.join(' + ')} ke side me (ULTA)` : ''}`);
      }
    }

    // ---- sizing preview (the would-be ticket — no order) ----
    const price = Number(signal?.ltp) || null;
    if (price > 0) {
      const usdInr = await fetchUsdInr();
      const meta = await fetchFuturesInstrumentMeta(pair).catch(() => null);
      const levCapInstrument = meta?.maxLeverage || 10;
      const levCapConfig = Number(cfg.cryptoLeverage) >= 1 ? Math.floor(Number(cfg.cryptoLeverage)) : 1;
      let lev = Math.max(1, Math.floor(Number(leverage) || 1));
      lev = Math.min(lev, levCapConfig, levCapInstrument);
      let margin = Number(marginUSDT) > 0 ? Number(marginUSDT) : Math.min(cfg.maxOrderINR, 1000) / usdInr;
      margin = Math.round(margin * 1000) / 1000;
      const plan = signal?.plan || null;
      const slDistPct = plan?.stopLoss != null ? Math.abs(price - plan.stopLoss) / price * 100 : null;
      const saneLev = slDistPct != null ? maxSaneLeverage(slDistPct, Math.min(levCapConfig, levCapInstrument)) : null;
      const effLev = saneLev != null ? Math.min(lev, saneLev) : lev;
      const rawQty = (margin * effLev) / price;
      const qty = roundFuturesQty(pair, rawQty, meta?.qtyPrecision ?? null) || roundFuturesQty(pair, rawQty, null);
      const notionalUSDT = r2(qty * price);
      const marginUsed = r2(notionalUSDT / effLev);
      const liquidation = effLev > 1 && plan?.stopLoss != null
        // v21.23.10 [SIDE-VOCAB]: precheck bhi BUY/SELL vocabulary samjhe —
        // pehle sirf 'SHORT' check hota tha ('SELL' ulta LONG estimate deta).
        ? pRound(!['SHORT', 'SELL'].includes(String(signal.side || '').toUpperCase()) ? price * (1 - 0.95 / effLev) : price * (1 + 0.95 / effLev)) : null;
      if (saneLev != null && lev > saneLev) {
        out.warnings.push(`leverage auto-reduced ${lev}x → ${saneLev}x (liquidation would fire before the ${r2(slDistPct)}% SL)`);
        // v21.4.1 [C3]: LIVE execute is requested leverage pe HARD-REJECT
        // karta hai (futures.js gauntlet) — par precheck sirf auto-reduce
        // dikhata tha. Blocking gate FAIL = modal hi honestly bolta hai
        // ki order nahi jaayega jab tak leverage kam nahi kiya jaata.
        gate('Leverage sanity', false, `${lev}x par liquidation SL se PEHLE fire karegi — max ${saneLev}x (Risk settings me kam karo)`);
      } else if (saneLev != null) {
        gate('Leverage sanity', true, `${lev}x OK — SL ${r2(slDistPct)}% se pehle liquidation nahi`);
      }
      if (meta?.minQty > 0 && qty < meta.minQty) out.warnings.push(`qty ${qty} below exchange minimum ${meta.minQty} — increase margin`);
      out.ticket = {
        pair, symbol: base, side: side || signal.side || null, price: pRound(price),
        stopLoss: plan?.stopLoss != null ? pRound(plan.stopLoss) : null,
        target1: plan?.target1 != null ? pRound(plan.target1) : null,
        target2: plan?.target2 != null ? pRound(plan.target2) : null,
        riskPct: plan?.riskPct ?? null, rewardRisk: plan?.rewardRisk ?? null,
        leverage: effLev, leverageRequested: lev, maxSaneLeverage: saneLev,
        marginUSDT: margin, marginUsedUSDT: marginUsed, marginINR: inrOfUsdt(marginUsed, usdInr),
        qty, notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr),
        liquidation, grade: signal.grade ?? null, confidence: signal.confidence ?? null,
        aiScore: signal.superIntel?.aiScore ?? null, aiConfirm: signal.aiConfirm?.verdict ?? null,
        // exchange-armed protection pair (what createFuturesTpsl sets):
        nativeProtection: plan?.stopLoss != null && plan?.target2 != null ? { stopLoss: pRound(plan.stopLoss), takeProfit: pRound(plan.target2) } : null,
        minQty: meta?.minQty ?? null, qtyPrecision: meta?.qtyPrecision ?? null,
      };
    }
    return out;
  } catch (e) {
    return { ...out, ok: false, error: String(e?.message || e) };
  }
}

// ---------------- PUBLIC: candlesticks (pcode=f) ----------------
/**
 * Futures candles — TA source for the futures board. Docs shape:
 *   GET /market_data/candlesticks?pair=B-MKR_USDT&from=…&to=…&resolution=60&pcode=f
 *   → { s: "ok", data: [{ open, high, low, volume, close, time (ms) }] }
 * (also tolerates the legacy bare-array shape).
 */
export async function fetchFuturesCandles(pair, resolution = '60', limit = 300) {
  // v12.6 candle TTL cache — same rationale as data.js (the futures
  // board re-fetches the full history every cycle; 299/300 bars are
  // identical). 3 min for 15m bars, 5 min otherwise.
  // v21.23.12 [DEPTH-POISON FIX]: key me `limit` MISSING tha — ek 120-bar
  // ultrafast write 240/300-bar chahe wale reader ko 12-30s ke liye serve
  // hoti thi (ema200/ema100 silently null, indicator depth thin). data.js
  // (spot) ne v20.8.2 me isi class ka yahi fix lagaya tha — ab futures
  // cache me bhi limit key ka hissa hai.
  const cacheKey = `fut:${pair}:${resolution}:${Math.max(30, Math.min(1000, Math.floor(Number(limit) || 300)))}`;
  // v21.20.0 ULTRA-FAST TREND CAPTURE: keep 1m/5m/15m candle cache at 12s (not 3-5 minutes!)
  // so fresh breakouts/breakdowns and reversal wicks appear on the MTF Dual Board immediately.
  const ttl = (resolution === '1' || resolution === '5' || resolution === '15') ? 12_000 : 30_000;
  const hit = _futCandleCache.get(cacheKey);
  if (hit && Date.now() - hit.at <= ttl) return hit.candles.slice();
  // v21.23.11 [TWO-LEG CHAIN]: Leg-1 legacy candlesticks (pcode=f, the
  // true perp series) → Leg-2 official /market_data/candles (docs' CURRENT
  // endpoint, same USDT domain). Legacy leg WAF/retire/shape-drift ho to
  // desk is leg pe zinda rahegi — dono legs MIRROR-SHIELD canonicalize
  // se guzarti hain (wire shape/order chahe kuch bhi ho — output hamesha
  // canonical ascending).
  let candles = await _fetchFuturesLegacyCandles(pair, resolution, limit).catch(() => null);
  if (!candles || candles.length < 30) {
    candles = await _fetchFuturesOfficialCandles(pair, resolution, limit).catch(() => null);
  }
  if (!candles || candles.length < 30) return null;
  if (_futCandleCache.size >= 48) {
    const entries = [..._futCandleCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < 12; i++) _futCandleCache.delete(entries[i][0]);
  }
  _futCandleCache.set(cacheKey, { at: Date.now(), candles });
  return candles.slice();
}

/** Leg-1: legacy public candlesticks endpoint (perp series, pcode=f). */
async function _fetchFuturesLegacyCandles(pair, resolution, limit) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - Math.max(1, Math.ceil(limit * resolutionSeconds(resolution) * 1.2 / 60)) * 60;
  // v21.19.0 FIX: CoinDCX /market_data/candlesticks?pcode=f requires UPPERCASE
  // pair (e.g. B-BTC_USDT, B-ZRO_USDT, B-XAU_USDT). Lowercase b-btc_usdt
  // returns {"s":"no_data","data":[]}, which previously starved the entire
  // FUTURES desk of 15m/1h USDT candles!
  const url = `${CANDLES_URL}?pair=${encodeURIComponent(String(pair).toUpperCase())}&from=${from}&to=${to}&resolution=${resolution}&pcode=f`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!ok(r)) return null;
  const j = await r.json().catch(() => null);
  const raw = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
  if (!raw || raw.length === 0) return null;
  // v21.23.11 [MIRROR-SHIELD]: legacy parse `{…, time}` + self-sort me
  // timestamp-key drift (time→open_time, docs-vs-BFF mismatch) NaN time
  // banati thi → sort comparator NaN → sort NO-OP → CoinDCX NEWEST-FIRST
  // order PRESERVED → MIRRORED SERIES → dual-board/MTF/futures ke SAB
  // signals systematically OPPOSITE (live-probe 2026-10-20: Binance leg
  // pe 17/20 AGREE — direction engine sahi tha; CoinDCX wire hi suspect
  // #1). Ab canonicalizeCandles: alias-tolerant parse + NaN-row drop +
  // orientation-detect + ascending sort. Wire chahe KOI bhi shape/order
  // de, series hamesha canonical ascending niklegi.
  const candles = canonicalizeCandles(raw, { label: `cdc-fut:${pair}:${resolution}` });
  if (!candles || candles.length < 30) return null;
  return candles;
}

// v21.23.11 [OFFICIAL-ENDPOINT LEG]: docs.coindcx.com ka CURRENT candles
// endpoint — `interval` param + B-pairs + NEWEST-FIRST response (same
// BFF /market_data/candles). Legacy candlesticks endpoint retirement/
// shape-drift/WAF hone pe futures desk is leg pe USDT candles (same
// domain as perp USDT — votes + USDT-priced plans dono safe) continue
// karega. Sirf {1m,15m,1h,1d} official intervals map hote hain; '240' pe
// ye leg skip (existing resample/fallback chain handles 4h).
const OFFICIAL_RES_INTERVAL = { '1': '1m', '5': '5m', '15': '15m', '60': '1h', '1D': '1d' };
async function _fetchFuturesOfficialCandles(pair, resolution, limit) {
  const interval = OFFICIAL_RES_INTERVAL[String(resolution)];
  if (!interval) return null;
  try {
    const r = await fetch(
      `https://api.coindcx.com/market_data/candles?pair=${encodeURIComponent(String(pair).toUpperCase())}&interval=${interval}&limit=${Math.min(1000, Math.max(30, limit))}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) },
    );
    if (!ok(r)) return null;
    const raw = await r.json().catch(() => null);
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const candles = canonicalizeCandles(raw, { label: `cdc-fut-official:${pair}:${resolution}` });
    if (!candles || candles.length < 30) return null;
    return candles;
  } catch { return null; }
}
const _futCandleCache = new Map(); // key -> { at, candles } (v12.6 TTL cache)
/** Test hook — hermetic suites clear the candle cache between cases. */
export function __clearFuturesCandleCacheForTest() { _futCandleCache.clear(); }
/** v21.9.0 test hook — metals candle/price/spot caches saaf (hermetic suites). */
export function __clearMetalsCachesForTest() {
  _metalsKlineCache.clear();
  _metalsYahooCache.clear();
  _metalsYahooNegUntil = 0;
  _metalsYahooFetchImpl = null;
  _metalsPrices = { at: 0, rows: null, downUntil: 0 };
  _metalsSpotPrev.clear();
}
function resolutionSeconds(res) {
  const r = String(res);
  if (r === '1D') return 86400;
  return parseInt(r, 10) * 60 || 3600;
}

// ---------------- PRIVATE: wallets ----------------
export function loadCredsForOrder() {
  const c = loadJSON('mcp-coindcx.json', {});
  if (c?.apiKey && c?.secret) return { apiKey: c.apiKey, secret: c.secret, source: c.source || 'file' };
  const envC = coindcxEnvCreds();
  if (envC?.apiKey && envC?.secret) {
    return { apiKey: envC.apiKey, secret: envC.secret, source: 'env' };
  }
  return null;
}
function credGuard() {
  const creds = loadCredsForOrder();
  if (!coindcxConnected() && !creds) { const e = new Error('CoinDCX not connected — connect an API key first'); e.status = 400; throw e; }
  if (!creds) { const e = new Error('CoinDCX credentials unreadable'); e.status = 400; throw e; }
  return creds;
}

/** DF (derivatives-futures) wallet rows: [{ currency, total, free, locked, crossMargin }]
 *
 * 2025 FUTURES API SEMANTICS (docs.coindcx.com — verified against the
 * official field reference + the "Total wallet balance" formula):
 *   • balance            = USABLE (free) balance — NOT the total. The
 *                          old pre-migration reading (`balance` = total,
 *                          free = total − locked) now computes free
 *                          NEGATIVE and clips to 0 — the exact
 *                          "3.01 USDT available par site kuch nahi
 *                          dikha raha" bug. `free` IS `balance`.
 *   • locked_balance     = total initial margin locked in ISOLATED
 *                          margined orders/positions
 *   • cross_order_margin = total initial margin locked in CROSS orders
 *   • cross_user_margin  = total initial margin locked in CROSS positions
 *   • Total wallet balance = balance + locked_balance
 *                          + cross_order_margin + cross_user_margin
 *
 * v10.3.2 TRANSPORT FIX: the wallets route is GET-only — the POST call
 * died with `[404] not_found` (Express routes by METHOD, so the path
 * "doesn't exist" for POST), which is why the futures USDT tile showed
 * 0 while the user's CoinDCX app showed 3.01 USDT available. Transport
 * chain: GET(seconds) → GET(ms) → legacy POST. The first transport that
 * answers sticks for the process lifetime (no per-poll probing).
 * Wrapper tolerance: bare array (documented), `{wallets:[]}`,
 * `{data:[]}` and `{balances:[]}` are all accepted.
 *
 * v10.14 (deep-recheck S1) PROBE-COOLDOWN: a full 3-mode sweep on every
 * 60s wallet poll could stack 3 × 10s timeouts = 30s — beyond the
 * client's 20s fetch budget → "wallet API unreachable" even though a
 * single transport blip was the only fault. After one full-sweep
 * failure the transport probe goes into a 5-min cooldown: only the
 * sticky mode is retried (one round-trip, fail fast) until it answers
 * again or the cooldown lapses.
 *
 * v12.1 AUTH LADDER (live incident 2026-09-19, smartai1.onrender.com):
 * the user's Global-Futures wallet HAS funds, but every wallet poll
 * returns `[401] Invalid credentials` while the SAME key signs spot
 * POSTs fine — and POST on this route still answers `[404] not_found`
 * (route stays GET-only). The 2025-era string-timestamp GET stopped
 * authenticating: CoinDCX evidently drifted the canonical signed
 * payload (the official doc samples type the timestamp as an INT, not
 * a string). The sweep is now a 6-rung AUTH LADDER covering every
 * plausible canonicalization — string/number × seconds/ms × bare
 * params/page+size — plus the legacy POST. The FIRST rung the server
 * accepts goes STICKY (zero per-poll cost after that). When every rung
 * fails, the thrown error carries the FULL variant trace
 * (`GET-s/str:401 · GET-ms/num:401 · …`) so the next probe pinpoints
 * exactly which auth the server speaks — and, if all GETs answer 401
 * with a key that works on spot, the guidance says what to check (a
 * Global-Futures-permission API key).
 *
 * v12.2 SCOPE PROBE + SPACED RUNGS (same incident, round 2): the 6
 * compact-GET permutations ALL 401'd live while an independent public
 * CoinDCX SDK signs the wallets GET exactly like rung 1 — so either
 * the key lacks derivatives permission, or the server rebuilds the
 * canonical string with PYTHON json.dumps spacing. Two additions:
 *   • rungs GET-s/str-sp / GET-ms/num-sp — signature over the spaced
 *     canonical form (see coindcxPrivateGET v12.2).
 *   • probeFuturesKeyScope() — THE discriminator: POST
 *     /derivatives/futures/positions (a documented POST route) with
 *     the SAME key. 2xx/4xx-shape → auth PASSED on the derivatives
 *     family (scope OK, wallets-GET auth is the fault). 401/403 → the
 *     key itself is rejected on derivatives (Global-Futures permission
 *     missing) — the error then LEADS with that verdict so the blocker
 *     panel tells the user the exact one-step fix. Cached 10 min,
 *     single-flight, only fired when every GET rung 401s.
 *
 * v12.3 THE VERDICT-BACKED FIX (same incident, round 3 — the live
 *   scope probe ANSWERED): the key's scope is OK (the positions POST
 *   auth PASSES with the same key that 401s on the wallets GET). The
 *   official docs.coindcx.com Slate capture (1.1MB, "Wallet Details"
 *   + "Wallet Transactions" samples) settles it: the derivatives
 *   wallets GET carries the SIGNED {"timestamp":<int ms>} JSON AS THE
 *   REQUEST BODY (requests.get(url, data=json_body)) — params like
 *   page/size ride the query string UNSIGNED. Our GETs were sending
 *   the signed payload as QUERY PARAMS with an EMPTY BODY, so the
 *   server's body-based verification could never pass → 401 on every
 *   permutation, forever. coindcxPrivateGET now defaults to the
 *   documented body mode; the ladder leads with the body rungs. */
const WALLET_PROBE_COOLDOWN_MS = 5 * 60_000;
// v20.5.1: force a FULL ladder re-probe every 10 minutes even when the
// cooldown is armed and sticky mode is set. Without this escape hatch,
// a server that hit the cooldown with a stale UA / transient 401 keeps
// retrying ONLY rung 1 every poll and re-arming the cooldown forever —
// a deploy that fixes the underlying transport (UA / signature / WAF
// rule change) never gets a chance to actually take effect until the
// user manually reconnects. With this counter, the 11th attempt post-
// cooldown-arming (i.e. ~10 polls at 60s cadence = ~10min) silently
// does a full 7-rung sweep and re-establishes sticky on whichever rung
// wins. Never throws; never blocks the cooldown's fail-fast intent on
// the first 10 polls.
const _walletsTransport = { mode: null, coolUntil: 0, probesSinceSweep: 0 };
function _walletList(resp) {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.wallets)) return resp.wallets;
  if (Array.isArray(resp?.data)) return resp.data;
  if (Array.isArray(resp?.balances)) return resp.balances;
  return null; // error-shaped / unknown wrapper → try the next transport
}
// The v12.3 ladder — order matters: rungs 1-3 are THE DOCUMENTED
// GET-with-body contract (docs.coindcx.com Wallet Details sample —
// requests.get(url, data=json_body)): the compact {"timestamp":<int>}
// JSON is BOTH signed AND sent as the GET request body. This is the
// transport the live scope-OK verdict demands (key CAN auth derivatives
// — POSTs pass, every query-param GET 401'd because the server verifies
// the signature against the REQUEST BODY, which was empty). Rung 1 is
// the exact doc sample (ms + int); rung 2 covers the Request-Definitions
// table's "epoch seconds" wording; rung 3 the string-ts variant. Then
// the legacy query-transport rungs (2025-verified family) as fallbacks,
// and POST last (the [404] legacy canary).
const WALLET_AUTH_LADDER = [
  { id: 'GET-body/ms/num', method: 'GET', mode: 'body', unit: 'ms', tsType: 'num', params: {} },
  { id: 'GET-body/s/num', method: 'GET', mode: 'body', unit: 's', tsType: 'num', params: {} },
  { id: 'GET-body/ms/str', method: 'GET', mode: 'body', unit: 'ms', tsType: 'str', params: {} },
  { id: 'GET-s/str', method: 'GET', unit: 's', tsType: 'str', params: {} },
  { id: 'GET-ms/num', method: 'GET', unit: 'ms', tsType: 'num', params: {} },
  { id: 'GET-s/pgsz', method: 'GET', unit: 's', tsType: 'str', params: { page: '1', size: '100' } },
  { id: 'POST', method: 'POST' },
];
async function _walletTransportAttempt(variant, apiKey, secret) {
  if (variant.method === 'POST') return coindcxPrivate(WALLETS_PATH, apiKey, secret, {});
  const { coindcxPrivateGET } = await import('../mcp/coindcx.js');
  return coindcxPrivateGET(WALLETS_PATH, apiKey, secret, variant.params, {
    unit: variant.unit, tsType: variant.tsType,
    ...(variant.mode ? { mode: variant.mode } : {}),
    ...(variant.sep ? { sep: variant.sep } : {}),
  });
}
/** v20.8.5: wallets payload → normalized rows (shared by the parallel
 * cold-probe and the sequential ladder — ek hi mapping, do paths). */
function _mapWalletRows(list) {
  return list.map(w => {
    const free = num(w.balance) || 0;
    const lockedIso = num(w.locked_balance) || 0;
    const crossOrder = num(w.cross_order_margin) || 0;
    const crossUser = num(w.cross_user_margin) || 0;
    return {
      currency: String(w.currency_short_name || w.currency || '').toUpperCase(),
      total: r2(free + lockedIso + crossOrder + crossUser),
      locked: r2(lockedIso + crossOrder),
      free: r2(Math.max(0, free)),
      crossUserMargin: r2(crossUser),
    };
  }).filter(w => w.currency && w.total > 0);
}
// ---------------- v12.2: futures key-scope probe ----------------
// THE discriminator for the live 401 incident: POST
// /derivatives/futures/positions is a documented POST route on the
// SAME derivatives family — one harmless read with the SAME key tells
// us whether the key can authenticate derivatives AT ALL:
//   • 2xx            → scope OK (and the route works)
//   • 400/422        → scope OK — auth PASSED, the request merely failed
//                      validation (a validation error is past the auth
//                      middleware by definition)
//   • 401/403        → scope MISSING — the key is rejected on the whole
//                      derivatives family (spot works, futures doesn't:
//                      a SPOT-scoped API key)
//   • 404/5xx/net    → UNKNOWN — route moved or gateway trouble; the
//                      verdict stays honest rather than guessing.
// Cached 10 min (verdicts don't flap per-minute), single-flight.
let _scopeProbe = null; // { verdict: 'ok'|'no_scope'|'unknown', status, at }
let _scopeProbeInflight = null;
const SCOPE_PROBE_TTL_MS = 10 * 60_000;
export async function probeFuturesKeyScope({ force = false } = {}) {
  if (_scopeProbe && !force && Date.now() - _scopeProbe.at < SCOPE_PROBE_TTL_MS) return _scopeProbe;
  if (_scopeProbeInflight) return _scopeProbeInflight;
  _scopeProbeInflight = (async () => {
    let out;
    try {
      const { apiKey, secret } = credGuard();
      await coindcxPrivate(POSITIONS_PATH, apiKey, secret, {
        page: '1', size: '10', margin_currency_short_name: ['USDT'],
      });
      out = { verdict: 'ok', status: 200, at: Date.now() }; // 2xx — full pass
    } catch (e) {
      const s = Number(e?.status);
      if (s === 401 || s === 403) out = { verdict: 'no_scope', status: s, at: Date.now() };
      else if (s === 400 || s === 422) out = { verdict: 'ok', status: s, at: Date.now() }; // auth passed, shape rejected
      else out = { verdict: 'unknown', status: Number.isFinite(s) ? s : null, at: Date.now() };
    }
    _scopeProbe = out;
    return out;
  })();
  try { return await _scopeProbeInflight; } finally { _scopeProbeInflight = null; }
}
/** Last scope verdict (null before the first probe) — walletSnapshot
 *  exposes it as futures.scope so the UI can badge the exact cause. */
export function lastFuturesKeyScope() { return _scopeProbe ? { ..._scopeProbe } : null; }
/** v12.2: a fresh CoinDCX connect (new key) resets the wallet transport
 *  ladder + cooldown AND this probe's cached verdict — the old key's
 *  state must never mask the new key's behavior (called from
 *  coindcxConnect via dynamic import). */
export function resetWalletTransportForReconnect() {
  _walletsTransport.mode = null;
  _walletsTransport.coolUntil = 0;
  _walletsTransport.probesSinceSweep = 0;
  _scopeProbe = null;
  _scopeProbeInflight = null;
  _resetWalletSnapshotCache(); // v20.8.5: purane key ka cached snapshot naya verify na mask kare
}
export async function fetchFuturesWallets() {
  const { apiKey, secret } = credGuard();
  // v20.5.1: count every probe so a stuck cooldown doesn't lock the
  // ladder to rung 1 forever. Every 10 probes (= ~10 polls × 60s = 10
  // min), force a FULL ladder sweep even while cooling — the deploy
  // may have fixed the underlying transport and the only way to find
  // out is to actually try every rung again.
  _walletsTransport.probesSinceSweep = (_walletsTransport.probesSinceSweep || 0) + 1;
  const forceSweep = _walletsTransport.probesSinceSweep >= 10;
  if (forceSweep) _walletsTransport.probesSinceSweep = 0;
  const probeCooling = Date.now() < _walletsTransport.coolUntil && !forceSweep;
  // sticky rung first; a legacy pre-v12.1 sticky value maps onto the
  // ladder ('GET-s' → 'GET-s/str', 'GET-ms' → 'GET-ms/str'). v12.3: the
  // resolved rung is what gets filtered out of the tail (a stale id that
  // no longer exists resolves to ladder rung 1 — never duplicated).
  const stickyId = _walletsTransport.mode === 'GET-s' ? 'GET-s/str'
    : _walletsTransport.mode === 'GET-ms' ? 'GET-ms/str' : _walletsTransport.mode;
  const stickyRung = stickyId
    ? (WALLET_AUTH_LADDER.find(v => v.id === stickyId) || WALLET_AUTH_LADDER[0])
    : null;
  let order = stickyRung
    ? [stickyRung, ...WALLET_AUTH_LADDER.filter(v => v.id !== stickyRung.id)]
    : [...WALLET_AUTH_LADDER];
  // v10.14: during the post-sweep-failure cooldown the alternates are
  // NOT re-probed — one sticky-mode round-trip bounds the failure path.
  if (probeCooling && stickyId) order = [order[0]];
  else if (probeCooling) order = order.slice(0, 1);
  const trace = [];
  let lastErr = null;
  // v20.8.5: COLD-START PARALLEL PROBE — 3 documented GET-body rungs ka
  // sequential sweep worst-case 3 × 10s lagta tha (aur 9s wallet-leg
  // budget use CUT kar deti thi) → boot / cooldown ke baad ka PEHLA
  // futures-wallet read consistently fail-ya-late hota tha ("wallet
  // bahut late read"). Ab teeno documented rung EK SAATH udte hain
  // (harmless signed GET reads); ladder-order preference me jo bhi
  // pehla array-shaped jawab de wahi STICKY ban jata hai — cold read
  // ≈ ek round-trip. Teeno fail → legacy rungs sequential (old path).
  if (!probeCooling && !stickyId) {
    const bodyRungs = WALLET_AUTH_LADDER.filter(v => v.mode === 'body');
    // v20.8.5a: dynamic import ko RACE se pehle EK baar resolve karo —
    // 3 concurrent import() calls (vi.mock registry race) test-env me
    // REAL module tak leak ho sakte the (real network 403!). Ek resolved
    // reference se saare rung udte hain — production me bhi zero repeat
    // import overhead.
    const { coindcxPrivateGET } = await import('../mcp/coindcx.js');
    const raced = await Promise.all(bodyRungs.map((v) =>
      Promise.resolve(coindcxPrivateGET(WALLETS_PATH, apiKey, secret, v.params, {
        unit: v.unit, tsType: v.tsType,
        ...(v.mode ? { mode: v.mode } : {}),
        ...(v.sep ? { sep: v.sep } : {}),
      })).then((resp) => ({ v, resp })).catch((e) => ({ v, e }))
    ));
    for (const { v, resp, e } of raced) {
      if (e) { trace.push(`${v.id}:${Number.isFinite(e?.status) ? e.status : 'T'}`); lastErr = e; continue; }
      const list = _walletList(resp);
      if (!list) { trace.push(`${v.id}:200?`); lastErr = new Error(`wallets payload not array-shaped (${v.id})`); continue; }
      _walletsTransport.mode = v.id;
      _walletsTransport.coolUntil = 0; // health restored — full probing again
      return _mapWalletRows(list);
    }
    // teeno body rung fail — sequential fallback me unhe REPEAT mat karo
    // (unka trace upar already hai; worst-case total attempts 7 hi rehte
    // hain — cold 3 parallel + 4 legacy sequential).
    order = order.filter(v => v.mode !== 'body');
  }
  for (const variant of order) {
    try {
      const resp = await _walletTransportAttempt(variant, apiKey, secret);
      const list = _walletList(resp);
      if (!list) { trace.push(`${variant.id}:200?`); throw new Error(`wallets payload not array-shaped (${variant.id})`); }
      _walletsTransport.mode = variant.id;
      _walletsTransport.coolUntil = 0; // health restored — full probing again
      return _mapWalletRows(list);
    } catch (e) {
      const status = e?.status;
      trace.push(`${variant.id}:${Number.isFinite(status) ? status : 'T'}`);
      lastErr = e;
    }
  }
  // every rung failed → arm the probe cooldown (fail-fast on the next
  // poll instead of another full-ladder sweep)…
  if (!probeCooling) _walletsTransport.coolUntil = Date.now() + WALLET_PROBE_COOLDOWN_MS;
  // …and throw the HONEST trace: which rungs answered what. All GET-401
  // with a spot-working key = the key itself can't read the derivatives
  // wallet family (Global Futures permission) — say exactly that. (POST's
  // 404 is EXPECTED on this route family — it never counts against the
  // GET verdict.)
  const getTraces = trace.filter(t => !t.startsWith('POST:'));
  const allGet401 = getTraces.length > 0 && getTraces.every(t => t.endsWith(':401') || t.endsWith(':T'));
  // v12.2: STRICT 401s only (no 'T' timeouts — a network stall is not an
  // auth rejection) → run the key-scope probe and let its verdict LEAD
  // the error text, so the agent blocker's 200-char slice carries the
  // definitive cause + fix, not just the ladder trace.
  let verdictTag = '';
  let guidance = '';
  const strict401 = getTraces.length > 0 && getTraces.every(t => t.endsWith(':401'));
  if (strict401) {
    const probe = await probeFuturesKeyScope().catch(() => null);
    if (probe?.verdict === 'no_scope') {
      verdictTag = ' · futures-key-scope: MISSING';
      guidance = ' — API key me Global Futures permission nahi hai (derivatives positions auth bhi 401 — same key spot par chalti hai). CoinDCX app → API Dashboard → Futures permission ON karke NAYI key banao → site me CoinDCX reconnect karo';
    } else if (probe?.verdict === 'ok') {
      verdictTag = ' · futures-key-scope: OK';
      guidance = ' — key derivatives-auth pass karti hai (positions readable) — sirf wallets-GET reject ho raha. v12.3 GET-with-body rungs ab ladder me HEAD par hain (documented contract); agar phir bhi 401 rahe to CoinDCX API changelog dekho';
    }
  }
  if (!guidance && allGet401) {
    guidance = ' — key spot par kaam karta hai par derivatives wallet reject kar raha hai: CoinDCX app → API Dashboard me GLOBAL FUTURES permission wali key bana ke reconnect karo';
  }
  // Order: verdict → guidance → trace LAST. The user-facing surfaces
  // (agent blocker 260 · log 300 · Telegram 200 · snapshot 420) slice
  // from the FRONT — the verdict + the one-step fix must land inside
  // every budget; the ladder trace is tail diagnostic for the logs.
  const err = new Error(`${String(lastErr?.message || lastErr).slice(0, 90)}${verdictTag}${guidance} [auth-ladder ${trace.join(' · ')}]`);
  err.status = lastErr?.status;
  throw err;
}

/** Spot wallet rows via the SAME /users/balances transport (free/locked). */
export async function fetchSpotWallets() {
  const { apiKey, secret } = credGuard();
  const resp = await coindcxPrivate('/exchange/v1/users/balances', apiKey, secret, { page: '1', size: '100' });
  const list = Array.isArray(resp) ? resp : [];
  const out = [];
  for (const w of list) {
    const base = String(w.currency_short_name ?? w.currency ?? '').toUpperCase();
    if (!base) continue;
    const free = num(w.available_balance ?? w.balance) || 0;
    const locked = num(w.locked_balance) || 0;
    if (free + locked <= 0) continue;
    out.push({ currency: base, free: r2(free), locked: r2(locked), total: r2(free + locked) });
  }
  return out;
}

/**
 * ONE wallet view for the UI + agent sizing:
 *   spot INR/USDT free+locked, futures USDT margin free+locked,
 *   USDINR, and INR-equivalent equity / deployable margin.
 * Never throws — a failed leg degrades to null with the reason kept.
 *
 * v10.14 (deep-recheck S1) RESPONSE-BUDGET FIX: the old body ran
 * `await fetchUsdInr()` SEQUENTIALLY before the two wallet legs — a cold
 * FX cache added up to 8s of Yahoo latency ON TOP of the legs (a full
 * 3-mode transport sweep could add 30s) → 38s worst case vs the client's
 * 20s AbortSignal → "⚡ wallet API unreachable" on a mere FX blip ("ek
 * ek baar"). Now: FX + both legs run in PARALLEL, each leg individually
 * deadline-bounded, so the route ALWAYS answers well inside the client
 * budget with whatever data it has (honest `error` per lagging leg).
 */
const WALLET_LEG_BUDGET_MS = 9_000;
let _walletLegBudgetMs = WALLET_LEG_BUDGET_MS;
function _withDeadline(p, ms, label) {
  let timer = null;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ error: `${label} — ${ms}ms budget exceeded (degraded)` }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([p, budget]).finally(() => { if (timer) clearTimeout(timer); });
}
// v20.8.5: SERVER-SIDE SNAPSHOT MINI-CACHE (10s) + single-flight. Ek hi
// browser ke kai surfaces (WalletCard/WalletStrip/PortfolioHeat ka shared
// useWalletPoll, agent ka 55s throttle, status views) ek hi window me
// walletSnapshot maang sakte hain — pehle HAR call 2 signed CoinDCX
// round-trips lagti thi. Ab 10s window me sab EK hi snapshot share
// karte hain (fetchedAt honest rehta hai — data ki umar kabhi chhupi
// nahi). force:true (reconnect route) cache bypass karta hai.
const WALLET_SNAPSHOT_CACHE_MS = 10_000;
let _walletSnapCache = null;   // { at, value }
let _walletSnapInflight = null;
export async function walletSnapshot({ force = false } = {}) {
  if (!force && _walletSnapCache && Date.now() - _walletSnapCache.at < WALLET_SNAPSHOT_CACHE_MS) {
    return _walletSnapCache.value;
  }
  if (_walletSnapInflight) return _walletSnapInflight;
  const build = (async () => {
    const [usdInr, fut, spot] = await Promise.all([
      fetchUsdInr().catch(() => _usdInr || 84), // belt & braces — never let FX break the snapshot
      _withDeadline(
        // v12.2: 420 chars (was 300) — the scope verdict LEADS, then the
        // 8-rung ladder trace, then the guidance; the whole diagnostic
        // sentence must survive to the UI so the user sees WHICH fault it
        // is (key permission vs auth drift) and the one-step fix.
        fetchFuturesWallets().catch(e => ({ error: String(e?.message || e).slice(0, 420) })),
        _walletLegBudgetMs, 'futures wallets slow'),
      _withDeadline(
        fetchSpotWallets().catch(e => ({ error: String(e?.message || e).slice(0, 140) })),
        _walletLegBudgetMs, 'spot wallets slow'),
    ]);
    // FX honesty: 84-static / >10min-cached rate flagged, never silently trusted
    const fxStale = !(Date.now() - _usdInrAt < 11 * 60_000);
    const futRows = Array.isArray(fut) ? fut : [];
    const spotRows = Array.isArray(spot) ? spot : [];
    const spotINR = spotRows.find(w => w.currency === 'INR') || { free: 0, locked: 0, total: 0 };
    const spotUSDT = spotRows.find(w => w.currency === 'USDT') || { free: 0, locked: 0, total: 0 };
    // v20.7.2: CoinDCX futures wallets can be USDT-margined OR INR-margined.
    // The user's diagnostic confirmed their wallet returns INR — the old code
    // only looked for USDT → showed 0 in the UI. Now surface BOTH.
    const futUSDT = futRows.find(w => w.currency === 'USDT') || { free: 0, locked: 0, total: 0, crossUserMargin: 0 };
    const futINR = futRows.find(w => w.currency === 'INR') || { free: 0, locked: 0, total: 0, crossUserMargin: 0 };
    const equityINR = r2(
      (spotINR.total || 0)
      + (spotUSDT.total || 0) * usdInr
      + (futUSDT.total || 0) * usdInr
      + (futINR.total || 0),
    );
    return {
      ok: true,
      connected: coindcxConnected(),
      usdInr: r2(usdInr),
      coindcxInrPerUsdt: COINDCX_INR_PER_USDT,
      fxStale,
      spot: {
        inr: spotINR,
        usdt: spotUSDT,
        error: Array.isArray(spot) ? null : spot?.error || 'unavailable',
        rows: spotRows.filter(w => w.currency !== 'INR' && w.currency !== 'USDT' && w.total > 5).slice(0, 12),
      },
      futures: {
        usdt: futUSDT,
        inr: futINR,
        error: Array.isArray(fut) ? null : fut?.error || 'unavailable',
        scope: lastFuturesKeyScope()?.verdict || null,
        rows: futRows.filter(w => w.currency !== 'USDT' && w.currency !== 'INR' && w.total > 0).slice(0, 12),
      },
      equityINR,
      deployableFuturesUSDT: r2(Math.max(0, (futUSDT.free || 0))),
      deployableFuturesINR: r2(Math.max(0, (futINR.free || 0))),
      deployableFuturesCombinedUSDT: r2(Math.max(0, (futUSDT.free || 0) + ((futINR.free || 0) / (usdInr || 84)))),
      futuresMarginCurrency: ((futINR.free || 0) / (usdInr || 84)) > (futUSDT.free || 0) && (futINR.free || 0) > 0 ? 'INR' : 'USDT',
      deployableSpotINR: r2(Math.max(0, (spotINR.free || 0))),
      fetchedAt: Date.now(),
    };
  })();
  _walletSnapInflight = build;
  try {
    const snap = await build;
    _walletSnapCache = { at: Date.now(), value: snap };
    return snap;
  } finally { _walletSnapInflight = null; }
}

/**
 * v21.21.0 COINDCX FUTURES INR + USDT MARGIN RESOLVER:
 * Reads both USDT and INR futures wallet rows, computes combined deployable
 * margin in USDT and INR, and selects the active `margin_currency_short_name`
 * ('INR' when INR margin exceeds USDT margin, else 'USDT').
 */
export function resolveFuturesWalletMargin(wallets, usdInr = 84) {
  const rows = Array.isArray(wallets) ? wallets : [];
  const fx = Number(usdInr) > 0 ? Number(usdInr) : 85;
  const futUSDT = rows.find(w => String(w?.currency || w?.currency_short_name || '').toUpperCase() === 'USDT') || null;
  const futINR = rows.find(w => String(w?.currency || w?.currency_short_name || '').toUpperCase() === 'INR') || null;
  const freeUSDT = Math.max(0, Number(futUSDT?.free ?? futUSDT?.balance) || 0);
  const freeINR = Math.max(0, Number(futINR?.free ?? futINR?.balance) || 0);
  const freeINRAsUSDT = freeINR / fx;
  const combinedFreeUSDT = r2(freeUSDT + freeINRAsUSDT) || 0;
  const combinedFreeINR = Math.round(freeUSDT * fx + freeINR);
  const preferINR = freeINR > 0 && freeINRAsUSDT > freeUSDT;
  const marginCurrency = preferINR ? 'INR' : 'USDT';
  const primaryFreeUSDT = r2(preferINR ? freeINRAsUSDT : freeUSDT) || 0;
  const altMarginCurrency = preferINR
    ? (freeUSDT > 0 ? 'USDT' : null)
    : (freeINR > 0 ? 'INR' : null);
  return {
    freeUSDT: r2(freeUSDT) || 0,
    freeINR: r2(freeINR) || 0,
    freeINRAsUSDT: r2(freeINRAsUSDT) || 0,
    combinedFreeUSDT,
    combinedFreeINR,
    marginCurrency,
    primaryFreeUSDT,
    altMarginCurrency,
  };
}
/** v20.8.5: transport reset (reconnect / key-swap) snapshot cache bhi
 * invalidate karta hai — purane key ka cached error naya verify-mask
 * nahi karega. resetWalletTransportForReconnect inhi ko call karta hai. */
function _resetWalletSnapshotCache() { _walletSnapCache = null; }
/** test hook — v20.8.5 mini-cache ko reset karo (test isolation). */
export function __resetWalletSnapshotCacheForTests() { _walletSnapCache = null; _walletSnapInflight = null; }

// ---------------- PRIVATE: positions ----------------
/**
 * Exchange futures positions (USDT margin). [{ id, pair, activePos,
 * avgPrice, liquidationPrice, leverage, marginType, markPrice, tp, sl }]
 * side is derived: activePos > 0 → LONG, < 0 → SHORT, 0 → flat.
 */
export async function listFuturesPositions() {
  const { apiKey, secret } = credGuard();
  let resp;
  try {
    resp = await coindcxPrivate(POSITIONS_PATH, apiKey, secret, {
      page: '1', size: '100', margin_currency_short_name: ['USDT', 'INR'],
    });
  } catch {
    resp = await coindcxPrivate(POSITIONS_PATH, apiKey, secret, {
      page: '1', size: '100', margin_currency_short_name: ['USDT'],
    });
  }
  const list = Array.isArray(resp) ? resp : (Array.isArray(resp?.positions) ? resp.positions : []);
  return list.map(p => ({
    id: String(p.id || ''),
    pair: String(p.pair || ''),
    activePos: num(p.active_pos) || 0,
    avgPrice: num(p.avg_price) || 0,
    liquidationPrice: num(p.liquidation_price) || 0,
    leverage: num(p.leverage) || 1,
    marginType: String(p.margin_type || ''),
    marginCurrency: String(p.margin_currency_short_name || 'USDT'),
    markPrice: num(p.mark_price) || 0,
    tp: num(p.take_profit_trigger),
    sl: num(p.stop_loss_trigger),
    updatedAt: num(p.updated_at) || 0,
  })).filter(p => p.pair);
}

// ---------------- PRIVATE: orders ----------------
/** v20.7.12 [H2-1] — CoinDCX kabhi-kabhi HTTP 200 ke andar hi error body
 * bhejta hai ({code,message} / {status:'error',message} / {error}). The
 * non-2xx path coindcxPrivate me throw karta hai, par ye wrapped rejections
 * parse ko null nahi karte the — createFuturesTpsl HAMESHA {ok:true} return
 * karta tha (naked leveraged position "protected" maana jata tha jabki
 * exchange pe SL set hi nahi hua tha). Ye pure detector us jhooth band
 * karta hai. FALSE-POSITIVE-SAFE: sirf tab error jab body me EXPLICIT
 * numeric code >= 400 ho, ya string status 'error' ho, ya top-level
 * `error` string ho — success bodies (order:{id}, positions[], {message:'...'}
 * success shapes) kabhi flag nahi hote. */
export function coindcxRespError(resp) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return null;
  if (typeof resp.code === 'number' && resp.code >= 400) {
    return String(resp.message || resp.error || resp.error_description || `CoinDCX code ${resp.code}`).slice(0, 180);
  }
  if (typeof resp.code === 'string' && /^\d{3,}$/.test(resp.code) && Number(resp.code) >= 400) {
    return String(resp.message || resp.error || `CoinDCX code ${resp.code}`).slice(0, 180);
  }
  if (typeof resp.status === 'string' && /error|fail|reject/i.test(resp.status)) {
    return String(resp.message || resp.error || `CoinDCX status ${resp.status}`).slice(0, 180);
  }
  if (typeof resp.error === 'string' && resp.error.trim()) {
    return resp.error.slice(0, 180);
  }
  return null;
}

/** Build the nested create-order body (documented shape + INR/USDT margin_currency_short_name support). */
export function futuresOrderBody({ pair, side, qty, leverage, price, marginCurrency }) {
  // v21.23.9 [CRITICAL FIX — the SHORT-inversion]: pehle `long = side !==
  // 'SHORT'` SILENT-LONG-default tha. exec-port adapter `side: 'buy'/'sell'`
  // pass karta tha → 'SELL' !== 'SHORT' → long=true → SHORT entry exchange
  // par BUY order ban jati thi (5-10x leverage par ulta position!). Ab DONO
  // vocabularies honestly map hoti hain — 'LONG'/'SHORT' (mtfDual/reversal/
  // partial paths) aur 'BUY'/'SELL' (exec-port) — aur unknown side LOUD
  // reject hota hai (v21.23.4 doctrine: unknown side ≠ LONG-default).
  const s = String(side ?? '').toUpperCase().trim();
  const long = s === 'LONG' || s === 'BUY';
  const short = s === 'SHORT' || s === 'SELL';
  if (!long && !short) {
    throw new Error(`futuresOrderBody: invalid side "${String(side)}" — LONG/SHORT ya BUY/SELL chahiye`);
  }
  const limit = Number(price) > 0;
  const mc = marginCurrency ? String(marginCurrency).toUpperCase().trim() : null;
  return {
    timestamp: Date.now(),
    order: {
      side: long ? 'buy' : 'sell',
      pair: String(pair),
      order_type: limit ? 'limit_order' : 'market_order',
      ...(limit ? { price: String(price) } : {}),
      total_quantity: Number(qty),
      leverage: Math.max(1, Math.floor(Number(leverage) || 1)),
      ...(mc === 'INR' || mc === 'USDT' ? { margin_currency_short_name: mc } : {}),
      notification: 'no_notification',
      time_in_force: 'good_till_cancel',
      hidden: false,
      post_only: false,
    },
  };
}
export async function createFuturesOrder({ pair, side, qty, leverage, price, marginCurrency }) {
  const { apiKey, secret } = credGuard();
  let body;
  try {
    body = futuresOrderBody({ pair, side, qty, leverage, price, marginCurrency });
  } catch (e) {
    // v21.23.9: invalid side/params honest reject — pehle unknown side
    // silently LONG-default hota tha (the SHORT-inversion root). Network
    // call KABHI nahi jaati, callers ko documented {orderId:null, error}
    // shape milti hai.
    return { orderId: null, error: String(e?.message || e).slice(0, 160) };
  }
  let resp;
  try {
    resp = await coindcxPrivate(ORDERS_CREATE_PATH, apiKey, secret, body);
  } catch (e) {
    // v21.21.0: If CoinDCX rejects with [400] Insufficient funds on default/USDT margin,
    // automatically retry once with the alternate margin_currency_short_name ('INR' <-> 'USDT').
    const errMsg = String(e?.message || e);
    if (/insufficient\s*(funds|margin|balance)/i.test(errMsg)) {
      const altMc = String(marginCurrency || 'USDT').toUpperCase() === 'INR' ? 'USDT' : 'INR';
      const altBody = futuresOrderBody({ pair, side, qty, leverage, price, marginCurrency: altMc });
      resp = await coindcxPrivate(ORDERS_CREATE_PATH, apiKey, secret, altBody);
    } else {
      throw e;
    }
  }
  // v20.7.12 [H2-1/H2-4]: 200-wrapped error body ya orderId-less 200 —
  // pehle {orderId: null} + truthy object return hota tha aur port.open()
  // ok:true bol deta tha (order kabhi gaya hi nahi, "placed" journal).
  // Ab honest error. orderId ab SIRF exchange-issued id se aata hai —
  // clientId fallback hata diya (journal dedupe ke liye raw.clientId
  // return hota hai, ok ke lie id hi truth hai).
  const errOf = coindcxRespError(resp);
  const firstArrItem = Array.isArray(resp)
    ? resp[0]
    : (Array.isArray(resp?.orders) ? resp.orders[0] : (Array.isArray(resp?.data) ? resp.data[0] : null));
  const orderId = resp?.order?.id ?? resp?.id ?? firstArrItem?.id ?? firstArrItem?.order?.id ?? null;
  if (errOf) return { orderId: null, error: errOf, raw: resp };
  if (orderId == null || String(orderId).trim() === '') {
    return { orderId: null, error: 'exchange ne order id nahi diya (200 body me id missing)', raw: resp };
  }
  return { orderId: String(orderId), raw: resp };
}
export async function exitFuturesPosition(positionId) {
  const { apiKey, secret } = credGuard();
  const resp = await coindcxPrivate(POSITIONS_EXIT_PATH, apiKey, secret, { timestamp: Date.now(), id: String(positionId) });
  // v20.7.12 [H2-1]: wrapped-rejection detection — port.close() pehle
  // `ok: r != null` se hamesha true bolta tha.
  const errOf = coindcxRespError(resp);
  return errOf ? { ok: false, error: errOf, raw: resp } : { ok: true, raw: resp };
}

/** v21.28.0 [F3 SAFE-REDUCE PLAN — PURE]: exchange reduce se PEHLE side/qty
 *  truth decide karta hai. Pehle partial path p.side ko trust karke opposite
 *  order bhejta tha — adopted/manual row ka side stale ho to reduce position
 *  ko ULTA badha sakta tha. Rules:
 *    • position flat → no order
 *    • expected side ≠ exchange position side → refuse
 *    • requested qty > position → cap (never flip/overshoot)
 *    • precision floor → hamesha neeche round (over-reduce impossible)
 *  Pure function — network/journal kuch nahi. */
export function planFuturesReduce({
  activePos, expectedSide, requestedQty, pair = null, qtyPrecision = null,
} = {}) {
  const side = normalizeSide(expectedSide);
  if (!side) return { ok: false, reason: 'invalid_side', error: `invalid side "${String(expectedSide ?? '')}" — LONG/SHORT required` };
  const rawPos = Number(activePos);
  const posQty = Math.abs(rawPos);
  const EPS = 1e-9;
  if (!(posQty > EPS)) return { ok: false, reason: 'already_flat', side, posQty: 0, error: 'position already flat — reduce skipped' };
  const actualSide = rawPos > 0 ? 'LONG' : 'SHORT';
  if (actualSide !== side) {
    return {
      ok: false, reason: 'side_mismatch', side, actualSide, posQty,
      error: `side mismatch: expected ${side} but exchange position is ${actualSide} (${rawPos})`,
    };
  }
  const rawQty = Number(requestedQty);
  if (!(rawQty > 0)) return { ok: false, reason: 'invalid_qty', side, actualSide, posQty, error: 'requested qty must be > 0' };
  const rounded = pair
    ? roundFuturesQty(pair, rawQty, qtyPrecision)
    : Math.floor(rawQty * 1e8) / 1e8;
  if (!(rounded > 0)) {
    return { ok: false, reason: 'qty_rounds_to_zero', side, actualSide, posQty, requestedQty: rawQty, error: 'qty rounds to 0 at instrument precision' };
  }
  const qty = Math.min(rounded, posQty);
  const remaining = +(posQty - qty).toFixed(8);
  return {
    ok: true,
    side,
    actualSide,
    posQty: +posQty.toFixed(8),
    requestedQty: +rawQty.toFixed(8),
    qty: +qty.toFixed(8),
    remaining: Math.max(0, remaining),
    capped: rounded > posQty + EPS,
    closeAll: remaining <= EPS,
  };
}

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * v21.28.0 [F3 SAFE REDUCE — EXCHANGE VERIFIED]:
 * CoinDCX futures partial reduce ka single guarded entry point.
 *   1. pre-read position (id > pair+side), flat/side/qty guard
 *   2. opposite-side market order for the capped fraction
 *   3. post-trade re-read (2 attempts) — qty genuinely kam hui ya flat?
 * Agar order submit ho gaya par re-read confirm na kare to `verified:false`
 * (caller book kar sakta hai; ambiguity alag flag se surface hoti hai) —
 * position ko blind dobara reduce karna caller ke retry guard ki zimmedari.
 * Read-only failure order se PEHLE → koi order nahi jaata (safe retry).
 */
export async function safeReduceFuturesPosition({
  positionId = null, symbol = null, pair = null, qty, side, leverage,
  settleMs = [250, 750],
  // Test seam (pure injection): production callers kabhi pass nahi karte.
  deps = null,
} = {}) {
  const readPositions = deps?.listFuturesPositions || listFuturesPositions;
  const reduceExit = deps?.partialFuturesExit || partialFuturesExit;
  const isConnected = deps?.coindcxConnected || coindcxConnected;
  const expectedSide = normalizeSide(side);
  if (!expectedSide) return { ok: false, error: `invalid side "${String(side ?? '')}" — LONG/SHORT required` };
  const normPair = pair
    ? String(pair).toUpperCase()
    : (symbol ? futuresPairFor(symbol) : null);
  if (!normPair) return { ok: false, error: 'pair/symbol required for safe reduce' };
  if (!isConnected()) return { ok: false, error: 'CoinDCX not connected — safe reduce refused' };

  let pre;
  try {
    pre = await readPositions();
  } catch (e) {
    return { ok: false, phase: 'pre', error: `position pre-read failed — blind reduce refused: ${String(e?.message || e).slice(0, 140)}` };
  }
  const live = pre.filter((p) => Math.abs(Number(p.activePos) || 0) > 1e-9);
  let pos = positionId
    ? live.find((p) => String(p.id) === String(positionId))
    : null;
  if (!pos) {
    pos = live.find((p) => p.pair === normPair
      && (Number(p.activePos) > 0 ? 'LONG' : 'SHORT') === expectedSide);
  }
  if (!pos) {
    const samePair = live.find((p) => p.pair === normPair);
    if (samePair) {
      return {
        ok: false, phase: 'pre', reason: 'side_mismatch', expectedSide,
        actualSide: Number(samePair.activePos) > 0 ? 'LONG' : 'SHORT',
        error: `side mismatch: expected ${expectedSide} but exchange position ${samePair.pair} is ${Number(samePair.activePos) > 0 ? 'LONG' : 'SHORT'}`,
      };
    }
    return { ok: false, phase: 'pre', reason: 'already_flat', error: 'no open exchange position — reduce skipped' };
  }
  const plan = planFuturesReduce({
    activePos: pos.activePos,
    expectedSide,
    requestedQty: qty,
    pair: pos.pair || normPair,
  });
  if (!plan.ok) return { ...plan, phase: 'pre' };

  const xr = await reduceExit({
    pair: pos.pair || normPair,
    qty: plan.qty,
    side: expectedSide,
    leverage: leverage || pos.leverage,
  }).catch((e) => ({ orderId: null, error: String(e?.message || e), transport: true }));
  if (!xr?.orderId || xr?.error) {
    return {
      ok: false,
      phase: 'order',
      ambiguous: xr?.transport === true,
      orderId: xr?.orderId || null,
      error: `exchange rejected reduce: ${String(xr?.error || 'no order id').slice(0, 160)}`,
    };
  }

  // ---- P0-style post-trade truth: exchange qty re-read ----
  let post = null;
  let readError = null;
  for (const wait of (Array.isArray(settleMs) ? settleMs : [250])) {
    if (Number(wait) > 0) await _sleep(Number(wait));
    try {
      post = await readPositions();
      readError = null;
    } catch (e) {
      post = null;
      readError = String(e?.message || e).slice(0, 140);
    }
    const afterPos = (post || []).find((p) => String(p.id) === String(pos.id))
      || (post || []).find((p) => p.pair === pos.pair
        && (Number(p.activePos) > 0 ? 'LONG' : 'SHORT') === expectedSide);
    const afterQty = afterPos ? Math.abs(Number(afterPos.activePos) || 0) : 0;
    const tolerance = Math.max(1e-9, plan.posQty * 1e-4);
    if (afterQty <= plan.remaining + tolerance) {
      return {
        ok: true,
        verified: true,
        orderId: xr.orderId,
        positionId: pos.id,
        pair: pos.pair,
        side: expectedSide,
        preQty: plan.posQty,
        requestedQty: plan.qty,
        capped: plan.capped,
        postQty: +afterQty.toFixed(8),
        closeAll: afterQty <= 1e-9,
      };
    }
  }
  return {
    ok: true,
    verified: false,
    ambiguous: Boolean(readError),
    orderId: xr.orderId,
    positionId: pos.id,
    pair: pos.pair,
    side: expectedSide,
    preQty: plan.posQty,
    requestedQty: plan.qty,
    capped: plan.capped,
    postQty: null,
    closeAll: false,
    warning: readError
      ? `reduce order accepted but post-read failed (${readError}) — exchange qty unverified`
      : 'reduce order accepted but exchange qty re-read did not reflect the reduction yet — verify/reconcile before any retry',
  };
}

/** v7.0 PRO TRADER: PARTIAL futures exit. CoinDCX futures
 *  /positions/exit is FULL-exit only — a partial close goes through an
 *  OPPOSITE-side market order for the fraction (the exchange nets it
 *  against the open position, shrinking it to the runner qty). */
export async function partialFuturesExit({ pair, qty, side, leverage }) {
  // v21.25.0 [NO SILENT SHORT]: unknown side pe opposite derive karna
  // impossible hai — exit order bhejna hi galat hoga.
  const posSide = normalizeSide(side);
  if (!posSide) return { orderId: null, error: `partialFuturesExit: invalid side "${String(side ?? '')}" — LONG/SHORT ya BUY/SELL required` };
  const opposite = posSide === 'LONG' ? 'SHORT' : 'LONG';
  return createFuturesOrder({
    pair, side: opposite, qty,
    leverage: Math.max(1, Math.floor(Number(leverage) || 1)),
  });
}
// ============================================================
// v21.29.0 [R1 ORDER HYGIENE] — futures open-order list/cancel.
// [VERIFY-DOCS] The two paths below follow the documented CoinDCX
// derivatives orders family (`GET …/orders/open`, `POST …/orders/cancel`)
// but the EXACT open-order query shape and cancel body were not exercised
// against a live account in this release. Every caller therefore gets an
// honest verdict: `unsupported:true` when the response shape is unknown,
// per-order `failed[]` entries when a cancel is rejected — never a blanket
// `ok:true`. Production wiring additionally requires the deps seam to be
// validated on a small live size before any emergency path relies on it.
// ============================================================
const ORDERS_OPEN_PATH = '/exchange/v1/derivatives/futures/orders/open'; // [VERIFY-DOCS]
const ORDERS_CANCEL_PATH = '/exchange/v1/derivatives/futures/orders/cancel'; // [VERIFY-DOCS]

function _mapOpenOrderRow(o = {}) {
  return {
    orderId: String(o.id ?? o.order_id ?? o.orderId ?? ''),
    pair: String(o.pair ?? o.symbol ?? '').toUpperCase() || null,
    side: String(o.side ?? '').toUpperCase() || null,
    type: String(o.order_type ?? o.type ?? '').toUpperCase() || null,
    qty: num(o.total_quantity ?? o.quantity ?? o.qty),
    remainingQty: num(o.remaining_quantity ?? o.unfilled_quantity ?? o.remaining_qty),
    price: num(o.price ?? o.limit_price),
    status: String(o.status ?? '').toUpperCase() || null,
    raw: o,
  };
}

/** List resting futures orders for one pair (or the whole account). */
export async function listFuturesOpenOrders({ pair = null, deps = null } = {}) {
  const injected = deps?.listOpenOrders;
  if (typeof injected === 'function') {
    const r = await injected({ pair });
    if (!r || r.ok !== true) return { ok: false, orders: [], error: String(r?.error || 'open-order read failed') };
    return { ok: true, orders: (Array.isArray(r.orders) ? r.orders : []).map(_mapOpenOrderRow) };
  }
  let apiKey; let secret;
  try { ({ apiKey, secret } = credGuard()); } catch (e) {
    return { ok: false, orders: [], error: `open-order read blocked: ${String(e?.message || e).slice(0, 140)}` };
  }
  try {
    const { coindcxPrivateGET } = await import('../mcp/coindcx.js');
    const params = { timestamp: Date.now(), ...(pair ? { pair: String(pair).toUpperCase() } : {}) };
    const resp = await coindcxPrivateGET(ORDERS_OPEN_PATH, apiKey, secret, params, {
      mode: 'body', unit: 'ms', tsType: 'num',
    });
    const rows = Array.isArray(resp)
      ? resp
      : (Array.isArray(resp?.orders) ? resp.orders : (Array.isArray(resp?.data) ? resp.data : null));
    if (!rows) {
      return {
        ok: false, unsupported: true, orders: [], raw: resp,
        error: 'open-orders response shape unrecognized [VERIFY-DOCS] — cancel not attempted',
      };
    }
    return { ok: true, orders: rows.map(_mapOpenOrderRow).filter(o => o.orderId), raw: resp };
  } catch (e) {
    return { ok: false, orders: [], error: String(e?.message || e).slice(0, 180) };
  }
}

/** Cancel one resting futures order. Never invents success. */
export async function cancelFuturesOpenOrder({ orderId, pair = null, deps = null } = {}) {
  const id = String(orderId ?? '').trim();
  if (!id) return { ok: false, error: 'cancelFuturesOpenOrder: orderId required' };
  const injected = deps?.cancelOpenOrder;
  if (typeof injected === 'function') {
    const r = await injected({ orderId: id, pair });
    return r?.ok === true
      ? { ok: true, orderId: id, raw: r }
      : { ok: false, orderId: id, error: String(r?.error || 'cancel rejected'), raw: r };
  }
  let apiKey; let secret;
  try { ({ apiKey, secret } = credGuard()); } catch (e) {
    return { ok: false, orderId: id, error: `cancel blocked: ${String(e?.message || e).slice(0, 140)}` };
  }
  try {
    const resp = await coindcxPrivate(ORDERS_CANCEL_PATH, apiKey, secret, {
      timestamp: Date.now(), id,
      ...(pair ? { pair: String(pair).toUpperCase() } : {}),
    });
    const errOf = coindcxRespError(resp);
    if (errOf) return { ok: false, orderId: id, error: errOf, raw: resp };
    return { ok: true, orderId: id, raw: resp };
  } catch (e) {
    const msg = String(e?.message || e);
    return {
      ok: false, orderId: id, ambiguous: isAmbiguousTransportError(e),
      error: msg.slice(0, 180),
    };
  }
}

/**
 * Cancel ALL resting orders for a pair — the close/flatten hygiene step.
 * Returns `ok:true` only when the list succeeded AND every cancel was
 * accepted. `unsupported:true` means the exchange list shape is unknown:
 * the caller must surface the manual-verification note instead of
 * pretending the book is clean.
 */
export async function cancelFuturesOpenOrdersForPair({ pair, deps = null } = {}) {
  const p = String(pair || '').toUpperCase();
  if (!p) return { ok: false, error: 'cancelFuturesOpenOrdersForPair: pair required' };
  const listed = await listFuturesOpenOrders({ pair: p, deps });
  if (!listed.ok) {
    return {
      ok: false, unsupported: listed.unsupported === true, pair: p,
      error: listed.error || 'open-order list failed',
    };
  }
  const mine = listed.orders.filter(o => !o.pair || o.pair === p);
  if (mine.length === 0) return { ok: true, pair: p, cancelled: [], failed: [], listed: 0 };
  const cancelled = [];
  const failed = [];
  for (const o of mine) {
    const r = await cancelFuturesOpenOrder({ orderId: o.orderId, pair: p, deps });
    if (r.ok) cancelled.push(o.orderId);
    else failed.push({ orderId: o.orderId, error: r.error, ambiguous: r.ambiguous === true });
  }
  return {
    ok: failed.length === 0, pair: p, cancelled, failed,
    listed: mine.length,
    error: failed.length ? `${failed.length}/${mine.length} cancel(s) rejected` : undefined,
  };
}

/**
 * R1 hygiene mode: `on` (default) cancels resting orders on close, `shadow`
 * only lists what WOULD be cancelled, `off` skips the exchange call entirely.
 */
export function orderHygieneMode() {
  const raw = String(process.env.FUTURES_ORDER_HYGIENE ?? 'on').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled') return 'off';
  if (raw === 'shadow' || raw === 'dry' || raw === 'dry-run') return 'shadow';
  return 'on';
}

/**
 * Close-path order hygiene: remove resting orders for the pair BEFORE the
 * position exit so a stale limit cannot re-open/flip the book after close.
 * Best-effort by design: a hygiene failure is reported in the close verdict
 * but must never block the exit itself.
 */
export async function runOrderHygieneForPair({ pair, deps = null } = {}) {
  const p = String(pair || '').toUpperCase();
  const mode = orderHygieneMode();
  if (!p || mode === 'off') return { ok: true, skipped: true, mode, pair: p || null };
  if (mode === 'shadow') {
    const listed = await listFuturesOpenOrders({ pair: p, deps }).catch(e => ({ ok: false, error: String(e?.message || e) }));
    return {
      ok: true, shadow: true, mode, pair: p,
      listed: listed?.ok === true ? listed.orders.length : null,
      wouldCancel: listed?.ok === true ? listed.orders.map(o => o.orderId) : [],
      unsupported: listed?.unsupported === true,
      error: listed?.ok === true ? undefined : String(listed?.error || 'list failed'),
    };
  }
  const res = await cancelFuturesOpenOrdersForPair({ pair: p, deps }).catch(e => ({ ok: false, error: String(e?.message || e) }));
  return { ...res, mode, pair: p };
}

/** NATIVE exchange TP/SL — the safety net that keeps working even when
 *  this server is down (Render free-tier sleeps between ticks). */
export async function createFuturesTpsl({ positionId, stopLoss, takeProfit }) {
  const { apiKey, secret } = credGuard();
  const body = {
    timestamp: Date.now(),
    id: String(positionId),
    ...(stopLoss != null && Number(stopLoss) > 0 ? {
      stop_loss: { stop_price: String(stopLoss), order_type: 'stop_market' },
    } : {}),
    ...(takeProfit != null && Number(takeProfit) > 0 ? {
      take_profit: { stop_price: String(takeProfit), order_type: 'take_profit_market' },
    } : {}),
  };
  if (!body.stop_loss && !body.take_profit) return { ok: false, error: 'no levels given' };
  const resp = await coindcxPrivate(POSITIONS_TPSL_PATH, apiKey, secret, body);
  // v20.7.12 [H2-1] CRITICAL: pehle ye HAMESHA {ok:true} return karta tha.
  // CoinDCX 200-wrapped rejection bhejta hai ({code,message}) — executeFuturesSignal
  // journal me "native TP/SL armed on the exchange" likh deta tha jabki SL SET
  // HI NAHI THA (naked leveraged position believed protected — v20.7.10 ne arg
  // names fix kiye the, verdict ka jhootha ok nahi). Ab body inspect hoti hai.
  const errOf = coindcxRespError(resp);
  if (errOf) return { ok: false, error: errOf, raw: resp };
  return { ok: true, raw: resp };
}

// ---------------- THE FUTURES EXECUTION GAUNTLET ----------------
/**
 * executeFuturesSignal({ symbol, side, mode, marginUSDT | qtyINR,
 * leverage, getFreshSignal, wantAuto, source })
 *
 * Same gate ladder as the spot gauntlet (coindcxOrders.executeSignal),
 * venue-switched to the GLOBAL FUTURES desk:
 *   1. kill switch    2. auto policy (allowAuto + LIVE)
 *   3. LIVE arming    4. connection
 *   5. fresh STRONG signal (venue FUTURES, ≤90s for LIVE)
 *   6. leverage sanity (liquidation OUTSIDE the SL)
 *   7. margin sizing vs the DF wallet (live) — never over-commit
 *   8. journal caps under the lock (daily trades / loss / one-per-pair
 *      / concentration) — same journal, same lock, same INR caps
 *
 * LIVE orders additionally arm the NATIVE exchange TP/SL so the stop
 * exists even if this server never wakes up again.
 */
export async function executeFuturesSignal(opts) {
  const {
    symbol, side, mode, qtyINR, marginUSDT, leverage,
    getFreshSignal, wantAuto = false, source = 'manual', sendTelegram,
  } = opts || {};
  const cfg = await import('./coindcxOrders.js').then(m => m.loadConfig());
  const pair = futuresPairFor(symbol);
  const base = baseOfFuturesPair(pair);
  // v6.11: NOTIFY mode — full gauntlet, Telegram alert, no order/position.
  const wantMode = mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper';
  const day = todayIST();
  const entry = { kind: 'ORDER', day, symbol: pair, side, mode: wantMode, market: 'FUTURES', source };

  const reject = (reason, error, extra = {}) => withJournalLock(() => {
    const j = loadJournalFresh();
    // v21.23.12 [REJECT-DEDUP — futures side]: indiaOrders (v21.23.10 fix-20)
    // me dedup sirf India ko mila tha; crypto/futures rejects har tick nayi
    // row mint karte the (persistent reject-condition = 500-entry window
    // ~4h me displacement — genuine trade/audit history destroyed). Scan-20
    // dedup + __repeatCount + fresh ts, 5-min window.
    const _entries = Array.isArray(j.entries) ? j.entries : [];
    for (let k = _entries.length - 1, n = 0; k >= 0 && n < 20; k--, n++) {
      const e = _entries[k];
      if (!e || e.status !== 'REJECTED') continue;
      if (String(e.symbol) !== String(pair) || String(e.reason) !== String(reason)) continue;
      if (Date.now() - Number(e.ts || 0) >= 5 * 60_000) break;
      e.__repeatCount = (Number(e.__repeatCount) || 1) + 1;
      e.ts = Date.now();
      return saveJournalFresh(j);
    }
    pushEntry(j, { ...entry, status: 'REJECTED', reason, ...extra });
    saveJournalFresh(j);
  }).then(() => ({ ok: false, error: error || reason }));

  // --- gate 1: kill switch ---
  if (cfg.killSwitch) return reject('Kill switch ON — execution disabled');

  // v21.1.0 (Phase-2 #4 + Phase-4): reconciler kill + GO-LIVE gate + per-strategy
  // kill rule — spot desk ke saath parity (coindcxOrders.js gate 1 block dekho).
  if (wantMode === 'live') {
    try {
      const { isKilled, killLevel, killReason } = await import('../exec/reconciler.js');
      if (typeof isKilled === 'function' && isKilled()) {
        return reject(`Exec kill L${killLevel()} ACTIVE (${killReason() || 'no reason'}) — live entries blocked`);
      }
    } catch { /* reconciler unavailable — single-node local */ }
  }
  if (wantMode === 'live') {
    try {
      const { goLiveGateBlocked } = await import('./strategyGuard.js');
      const g = goLiveGateBlocked();
      if (g.blocked) return reject(g.reason, g.reason, { goLiveGate: g.readiness?.stats });
    } catch { /* guard unavailable — never break the flow */ }
  }
  // v21.1.1 [audit A1]: per-strategy kill rule ab LIVE-only block karta hai —
  // paper continue (window refresh → recovery possible). Pehle all-modes
  // block ek one-way latch tha (deadlock): settled trades pass-only aate hain.
  if (wantMode === 'live') {
    try {
      const { strategyGuardBlocked } = await import('./strategyGuard.js');
      const g = strategyGuardBlocked(source, 'FUTURES');
      if (g.blocked) return reject(g.reason, g.reason, { strategyPaused: true });
    } catch { /* guard unavailable — never break the flow */ }
  }

  // --- gate 2: auto policy ---
  if (wantAuto && !cfg.allowAuto) return { ok: false, error: 'Auto-execution is OFF (enable it in Risk settings)' };
  if (wantAuto && cfg.mode !== 'live') return { ok: false, error: 'Auto-execution only runs in LIVE mode' };

  // --- gate 3: LIVE arming (typed "LIVE" in Risk settings) ---
  if (wantMode === 'live' && cfg.mode !== 'live') {
    return reject('LIVE mode is not enabled — type LIVE in Risk settings first');
  }
  // --- gate 4: connection ---
  if (wantMode === 'live' && !coindcxConnected()) return reject('CoinDCX not connected');

  // --- gate 5: fresh STRONG futures signal ---
  // v11.5: mode flows into the fresh-signal source — paper/notify may use
  // the board-cached fallback when the deep path is down; LIVE never does.
  const signal = await getFreshSignal(pair, { mode: wantMode });
  if (!signal) return reject('No fresh ensemble signal available for this futures pair');

  const gates = { minConfidence: cfg.minConfidence, minAgreement: cfg.minAgreement };
  const riskCap = Number(cfg.maxRiskPct) > 0 ? Number(cfg.maxRiskPct) : 5;

  // PAPER practice fallback (same honesty model as the spot path) — v9.0.2
  // adds side-flip + below-floor coverage so a PAPER click never dead-ends
  // (the "paper trading start hi nhi ho raha" fix).
  let effectiveSignal = signal;
  let synthNote = null;
  // v12.7 (recheck R1-#9): an ABSENT side no longer silently defaults
  // LONG — an unspecified request inherits the fresh signal's side (the
  // client always sends side; a missing side is a malformed call, and
  // minting a LONG from nothing was a free directional bias).
  // v21.25.0: agar requested side bhi invalid aur signal side bhi invalid/FLAT
  // ho to LOUD reject — koi silent LONG nahi.
  const reqSide = normalizeSide(side) ?? normalizeSide(signal.side);
  if (!reqSide) {
    return reject(`Direction unresolved: requested side "${String(side ?? '')}" invalid aur fresh signal side "${String(signal.side ?? '')}" bhi LONG/SHORT nahi — order blocked (no silent LONG)`);
  }
  const sideConflict = signal.side !== 'FLAT' && signal.side !== reqSide;
  const belowFloor = signal.grade !== 'STRONG' && signal.grade !== 'ACTION';
  if (wantMode !== 'live' && (sideConflict || signal.side === 'FLAT' || !signal.plan)) {
    const { buildTradePlan } = await import('./ensemble.js');
    const synthPlan = buildTradePlan(
      { side: reqSide, dir: reqSide === 'LONG' ? 1 : -1 },
      { ltp: signal.ltp, ind: {} }, 'FUTURES',
    );
    if (synthPlan && signal.ltp > 0) {
      effectiveSignal = { ...signal, side: reqSide, plan: synthPlan };
      synthNote = sideConflict
        ? `practice plan @ live futures price (fresh consensus FLIPPED: ${signal.side} ${signal.confidence}%)`
        : `practice plan @ live futures price (fresh consensus: ${signal.side} ${signal.confidence}%)`;
    }
  }
  const floorNote = (wantMode !== 'live' && !synthNote && (belowFloor || (Number(signal.confidence) || 0) < 55))
    ? `practice floor relaxed (fresh ${signal.grade ?? '—'} · ${signal.confidence ?? 0}% — journaled)` : null;

  // risk auto-fit (paper always; live mild overshoot ≤ 1.5×)
  let fitNote = null;
  const planRiskPct = Number(effectiveSignal?.plan?.riskPct);
  if (Number.isFinite(planRiskPct) && planRiskPct > riskCap) {
    if (wantMode !== 'live' || planRiskPct <= riskCap * 1.5) {
      const fitted = fitPlanToRiskCap(effectiveSignal, riskCap);
      if (fitted.note) { effectiveSignal = fitted.signal; fitNote = fitted.note; }
    }
  }
  const verdict = evaluateExecutionGate(effectiveSignal, {
    side: side || effectiveSignal.side, gates,
    requireStrong: wantMode === 'live',
    maxAgeMs: wantMode === 'live' ? 90_000 : 600_000,
    maxRiskPct: riskCap, venue: 'FUTURES',
    // v21.23.15 FIX (STRK fresh-degrade): desk clicks keep the relaxed
    // practice floor, but AUTO-AGENT entries must not execute a signal
    // that degraded after selection (board ACTION 73 -> fresh WATCH 55).
    // Agent source now enforces the ACTION+/55 floor on the FRESH signal.
    practice: wantMode !== 'live' && source !== 'agent',
  });
  if (!verdict.ok) {
    return reject(verdict.reason, `Signal gate: ${verdict.reason}`, {
      signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
    });
  }

  // v6.11 NOTIFY: gauntlet pass — Telegram alert + journal audit, NO order.
  // Position-creation caps deliberately don't block a notification.
  if (wantMode === 'notify') {
    const alertPrice = Number(effectiveSignal.ltp) > 0 ? Number(effectiveSignal.ltp) : null;
    return withJournalLock(async () => {
      const j = loadJournalFresh();
      const stats = dailyStats(j);
      const plan = effectiveSignal.plan;
      const capsNote = `trades ${stats.tradesCount}/${cfg.dailyMaxTrades} · realized ₹${r2(stats.realizedPnlINR)}`;
      const lines = [
        `🔔 <b>SmartAI NOTIFY (Futures)</b> — ${base} PERP ${effectiveSignal.side}`,
        `<b>${signal.grade || '—'}</b> · conf ${signal.confidence ?? '—'}% · agreement ${Math.round((signal.agreement ?? 0) * 100)}%`,
        plan ? `Entry ${pRound(plan.entry)} · SL ${pRound(plan.stopLoss)} · T1 ${pRound(plan.target1)} · T2 ${pRound(plan.target2)} · risk ${r2(plan.riskPct)}%` : 'plan nahi bana',
        `Book: ${capsNote}`,
        [synthNote, fitNote, floorNote].filter(Boolean).join(' · ') || undefined,
        '— notify-only: koi order place NAHI hua.',
      ].filter(Boolean);
      let telegramSent = false;
      if (typeof sendTelegram === 'function') {
        try { telegramSent = !!(await sendTelegram(lines.join('\n'))).ok; } catch { /* best-effort */ }
      }
      pushEntry(j, {
        ...entry, status: 'NOTIFIED', ...(alertPrice ? { price: pRound(alertPrice) } : {}),
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [synthNote, fitNote, floorNote, verdict.reason].filter(Boolean).join(' · ') || 'gauntlet pass',
        telegramSent,
      });
      saveJournalFresh(j);
      return {
        ok: true, mode: 'notify', notified: true, telegramSent,
        alert: { pair: base, side: effectiveSignal.side, grade: signal.grade, confidence: signal.confidence,
          plan: plan ? { entry: pRound(plan.entry), stopLoss: pRound(plan.stopLoss), target2: pRound(plan.target2) } : null,
          caps: capsNote },
        note: telegramSent ? 'Telegram alert bhej diya (journal AUDIT: NOTIFIED). Koi futures order nahi laga.'
          : 'Gauntlet pass + journal AUDIT likha, par Telegram configured nahi — Alerts & AI Keys me token daalo.',
      };
    });
  }

  // --- sizing (USDT margin domain) ---
  const price = effectiveSignal.ltp;
  if (!(price > 0)) return { ok: false, error: 'No live futures price for sizing' };
  const usdInr = await fetchUsdInr();
  const meta = await fetchFuturesInstrumentMeta(pair).catch(() => null);
  const levCapInstrument = meta?.maxLeverage || 10;
  const levCapConfig = Number(cfg.cryptoLeverage) >= 1 ? Math.floor(Number(cfg.cryptoLeverage)) : 1;
  let lev = Math.max(1, Math.floor(Number(leverage) || 1));
  if (lev > levCapConfig) lev = levCapConfig;
  if (lev > levCapInstrument) lev = levCapInstrument;

  // margin budget: direct USDT wins; else the INR budget converted; else the INR cap
  let margin = Number(marginUSDT) > 0 ? Number(marginUSDT)
    : (Number(qtyINR) > 0 ? Number(qtyINR) / usdInr : Math.min(cfg.maxOrderINR, 1000) / usdInr);
  margin = Math.round(margin * 1000) / 1000;

  // leverage sanity — liquidation must sit OUTSIDE the SL
  const slDistPct = Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price)) / price * 100;
  const saneLev = maxSaneLeverage(slDistPct, Math.min(levCapConfig, levCapInstrument));
  let levNote = null;
  if (lev > 1 && lev > saneLev) {
    if (wantMode === 'paper') {
      levNote = `leverage auto-reduced ${lev}x → ${saneLev}x (liquidation est. would fire before the ${r2(slDistPct)}% SL)`;
      lev = saneLev;
    } else {
      return reject(`leverage ${lev}x puts liquidation (~${r2(95 / lev)}% away) inside the ${r2(slDistPct)}% stop — reduce leverage to ≤${saneLev}x`,
        `Leverage gate: ${lev}x liquidates before the SL — use ≤ ${saneLev}x`);
    }
  }

  // live margin must exist in the DF wallet (USDT or INR margin; auto-deposit
  // from spot USDT, else from spot INR at the live FX rate)
  let walletNote = null;
  let activeMarginCurrency = undefined;
  if (wantMode === 'live') {
    try {
      const wallets = await fetchFuturesWallets();
      const wInfo = resolveFuturesWalletMargin(wallets, usdInr);
      const free = wInfo.combinedFreeUSDT;
      if (wInfo.marginCurrency === 'INR') activeMarginCurrency = 'INR';
      if (margin > free) {
        // try auto-transfer from the spot wallet (documented transfer API)
        const spotWallets = await fetchSpotWallets();
        const spotUSDT = spotWallets.find(w => w.currency === 'USDT')?.free || 0;
        const spotINR = spotWallets.find(w => w.currency === 'INR')?.free || 0;
        const need = margin - free;
        if (spotUSDT >= need) {
          await transferSpotToFutures({ amount: r2(need + 0.5), currency: 'USDT' });
          walletNote = `auto-moved ${r2(need + 0.5)} USDT spot → futures margin`;
        } else if (spotINR / usdInr >= need) {
          const usdtNeed = r2((need + 0.5));
          await transferSpotToFutures({ amount: r2(usdtNeed * usdInr), currency: 'INR' });
          walletNote = `auto-moved ₹${r2(usdtNeed * usdInr)} spot → futures (≈ ${usdtNeed} USDT margin)`;
        } else if (wInfo.primaryFreeUSDT >= 2.2 && margin <= wInfo.primaryFreeUSDT * 1.6) {
          margin = Math.max(2.05, Math.floor(wInfo.primaryFreeUSDT * 0.78 * 1000) / 1000);
          walletNote = `margin auto-fitted to ${r2(margin)} USDT (${wInfo.marginCurrency} futures wallet)`;
        } else {
          return reject(`futures wallet short: need ${r2(margin)} USDT margin, ${r2(free)} free + spot ₹${r2(spotINR)} insufficient`,
            `Wallet gate: ${r2(margin)} USDT margin needed — futures free ${r2(free)} USDT, spot ₹${r2(spotINR)} — transfer margin in the CoinDCX app`);
        }
      } else if (wInfo.marginCurrency === 'INR' && wInfo.primaryFreeUSDT >= 2.5 && margin > wInfo.primaryFreeUSDT * 0.78) {
        // Leave 22% headroom on INR-margined futures wallet for CoinDCX safety_percentage + taker fees + INR/USDT FX conversion spread
        margin = Math.max(2.05, Math.floor(wInfo.primaryFreeUSDT * 0.78 * 1000) / 1000);
        walletNote = `INR futures wallet safety buffer applied (${r2(margin)} USDT equiv from ₹${r2(wInfo.freeINR)})`;
      }
    } catch (e) {
      return reject(`futures wallet check failed: ${String(e?.message || e).slice(0, 140)}`,
        `Wallet gate: ${String(e?.message || e).slice(0, 140)}`);
    }
  }

  const rawQty = (margin * lev) / price;
  const qty = roundFuturesQty(pair, rawQty, meta?.qtyPrecision ?? null); // v21.3.0: instrument precision honoured
  if (!(qty > 0)) return { ok: false, error: `Quantity rounds to 0 for ${pair} — increase the margin` };
  // v9.5: the exchange minimum stays a HARD gate for LIVE (CoinDCX would
  // reject the real order), but PAPER is practice money — a small-margin
  // rehearsal now runs with an honest note instead of dead-ending on
  // "Quantity below the futures minimum" (BTC's min is 1 whole contract).
  let minQtyNote = null;
  if (meta?.minQty > 0 && qty < meta.minQty) {
    if (wantMode === 'live') {
      return { ok: false, error: `Quantity ${qty} below the futures minimum (${meta.minQty}) for ${pair}` };
    }
    minQtyNote = `paper qty ${qty} below the exchange minimum (${meta.minQty}) — real order would need more margin; simulating anyway`;
  }
  const notionalUSDT = r2(qty * price);
  const marginUsed = r2(notionalUSDT / lev);
  if (marginUsed < 2) return { ok: false, error: `Margin ₹${inrOfUsdt(marginUsed, usdInr)} too small for ${pair} — increase the order size` };
  const liquidation = lev > 1 && effectiveSignal.plan?.stopLoss != null
    ? pRound(reqSide !== 'SHORT' ? price * (1 - 0.95 / lev) : price * (1 + 0.95 / lev))
    : null;

  // --- FINAL MUTATION under the journal lock (fresh copy) ---
  return withJournalLock(async () => {
    const j = loadJournalFresh();
    const stats = dailyStats(j);
    if (stats.tradesCount >= cfg.dailyMaxTrades) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Daily trade cap (${cfg.dailyMaxTrades}) hit` });
      saveJournalFresh(j);
      return { ok: false, error: `Daily trade cap (${cfg.dailyMaxTrades}) reached — resets at IST midnight` };
    }
    if (stats.realizedPnlINR <= -cfg.dailyMaxLossINR) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Daily loss cap (₹${cfg.dailyMaxLossINR}) hit` });
      saveJournalFresh(j);
      return { ok: false, error: `Daily loss cap (₹${cfg.dailyMaxLossINR}) breached — trading paused for today` };
    }
    if (j.positions.some(p => p.pair === pair && (p.status === 'OPEN' || p.status === 'UNKNOWN'))) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: 'Position already open for this futures pair' });
      saveJournalFresh(j);
      return { ok: false, error: `An open position already exists for ${pair} (one-per-pair rule)` };
    }
    const openCount = j.positions.filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length;
    if (openCount >= (cfg.maxOpenPositions || 5)) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Max open positions (${cfg.maxOpenPositions || 5}) hit` });
      saveJournalFresh(j);
      return { ok: false, error: `Concentration guard: ${openCount} positions already open (max ${cfg.maxOpenPositions || 5})` };
    }

    const mkPosition = (extra) => ({
      id: crypto.randomUUID(), pair, symbol: base, market: 'FUTURES', side: effectiveSignal.side, mode: wantMode, source,
      qty, entryPrice: price, notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr),
      marginUSDT: marginUsed, marginINR: inrOfUsdt(marginUsed, usdInr),
      leverage: lev, ...(lev > 1 ? { liquidation } : {}),
      sl: effectiveSignal.plan?.stopLoss ?? null, tp: effectiveSignal.plan?.target1 ?? null, tp2: effectiveSignal.plan?.target2 ?? null,
      initialRisk: pRound(Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price))),
      peakPrice: pRound(price),
      signal: { grade: signal.grade, confidence: signal.confidence, agreement: signal.agreement, summary: synthNote || signal.summary },
      openedAt: Date.now(), status: 'OPEN', ...extra,
    });

    // --- PAPER execution ---
    if (wantMode === 'paper') {
      let ledgerEntryId = null;
      // v20.3: relaxed stamp (the spot desk already had it) — practice
      // entries built against a flipped/sub-floor consensus must stay OUT
      // of the calibration corpus on EVERY desk, not just CRYPTO.
      try {
        ledgerEntryId = recordExecution(signal, {
          mode: 'paper', market: 'FUTURES', source,
          ...(synthNote || floorNote ? { relaxed: true } : {}),
        })?.id || null;
      } catch { /* best-effort */ }
      const position = mkPosition(ledgerEntryId ? { ledgerEntryId } : {});
      j.positions.push(position);
      pushEntry(j, {
        ...entry, status: 'FILLED', qty, price: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr),
        leverage: lev, marginUSDT: marginUsed,
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [verdict.reason, synthNote, fitNote, levNote, floorNote, minQtyNote].filter(Boolean).join(' · '),
      });
      saveJournalFresh(j);
      return {
        ok: true, mode: 'paper', position,
        filled: { qty, price: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr), leverage: lev, marginUSDT: marginUsed },
        ...(walletNote || synthNote || fitNote || levNote || floorNote || minQtyNote ? { fitted: [walletNote, synthNote, fitNote, levNote, floorNote, minQtyNote].filter(Boolean).join(' · ') } : {}),
      };
    }

    // --- LIVE execution ---
    try {
      const orderRes = await createFuturesOrder({ pair, side: effectiveSignal.side, qty, leverage: lev, marginCurrency: activeMarginCurrency });
      const orderId = orderRes?.orderId ?? null;
      // v20.7.12 [H2-1]: createFuturesOrder ab 200-wrapped rejections ko
      // {orderId:null, error} me return karta hai — pehle ye path journal me
      // 'SUBMITTED' + ok:true likh deta tha jabki order REJECT ho chuka tha.
      // Explicit rejection → honest FAILED + no phantom position.
      if (orderRes?.error) {
        pushEntry(j, { ...entry, status: 'FAILED', reason: `exchange rejected: ${String(orderRes.error).slice(0, 160)}` });
        saveJournalFresh(j);
        return { ok: false, error: `CoinDCX futures order rejected: ${orderRes.error}` };
      }
      // Resolve the exchange position id (needed for exit + native TP/SL).
      let exchangePositionId = null, exchangeLiq = null;
      for (let i = 0; i < 3 && !exchangePositionId; i++) {
        await new Promise(r => setTimeout(r, 1200));
        const positions = await listFuturesPositions().catch(() => []);
        const row = positions.find(p => p.pair === pair && p.activePos !== 0);
        if (row) { exchangePositionId = row.id; exchangeLiq = row.liquidationPrice > 0 ? row.liquidationPrice : null; }
      }
      // Native TP/SL — belt + suspenders (works while this server sleeps).
      // v21.1.0 PROTECTION-FIRST (Phase-2 audit fix #3): tpsl fail → 2s baad
      // EK retry; phir bhi fail → FLATTEN (positionManager.js ka core rule
      // port: "no protection = no position"). Pehle ye position OPEN book
      // karta tha sirf ek note ke saath — leveraged position exchange-resident
      // stop ke bina 30s server-watcher ke bharose reh jati thi.
      let tpslNote = null;
      let tpslFailed = false;
      if (exchangePositionId) {
        const tp = effectiveSignal.plan?.target2 ?? null;
        const sl = effectiveSignal.plan?.stopLoss ?? null;
        let tpsl = await createFuturesTpsl({ positionId: exchangePositionId, stopLoss: sl, takeProfit: tp }).catch(e => ({ ok: false, error: String(e?.message || e) }));
        if (!tpsl?.ok) {
          await new Promise(r => setTimeout(r, 2000)); // ek bounded retry — transient API hiccup
          tpsl = await createFuturesTpsl({ positionId: exchangePositionId, stopLoss: sl, takeProfit: tp }).catch(e => ({ ok: false, error: String(e?.message || e) }));
        }
        if (tpsl?.ok) {
          tpslNote = `native TP/SL armed on the exchange (SL ${sl} · TP ${tp})`;
        } else {
          tpslFailed = true;
          tpslNote = `native TP/SL FAILED twice (${String(tpsl?.error || '').slice(0, 80)}) — PROTECTION-FIRST flatten triggered`;
        }
      } else if (wantMode === 'live') {
        // v21.1.1 [audit B5]: id-resolution miss (3×1.2s poll, fill latency)
        // pehle TP/SL attempt hi nahi hota tha — position phir kabhi arm nahi
        // hoti thi. Ab protectionMissing stamp hota hai → watcher har pass
        // re-arm koshish karta hai jab tak native SL lag na jaaye.
        tpslNote = 'native TP/SL not armed YET — exchange position id resolve nahi hui (fill latency); watcher har pass re-arm karega (protectionMissing)';
      }
      // v21.1.0: tpsl fail → flatten the just-opened position. Flatten bhi
      // fail ho (API down) → honest booking + watcher-guard note (purana
      // behavior) — kabhi bhi "armed" ka jhootha claim nahi.
      if (tpslFailed) {
        let flattenErr = null;
        try {
          const fx = await exitFuturesPosition(exchangePositionId).catch(e => ({ ok: false, error: String(e?.message || e) }));
          if (!fx?.ok) flattenErr = fx?.error || 'wrapped rejection';
        } catch (e) { flattenErr = String(e?.message || e); }
        if (!flattenErr) {
          const usdInrFx = await fetchUsdInr().catch(() => 84);
          pushEntry(j, {
            ...entry, status: 'CLOSED', qty, price: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInrFx),
            leverage: lev, marginUSDT: marginUsed, exchangeOrderId: orderId ?? null, exchangePositionId,
            reason: `PROTECTION-FIRST FLATTEN: native TP/SL do attempt me arm nahi hua — entry turant close kar di gayi (scratch exit, fee-only). Original tpsl error: ${tpslNote}`,
          });
          saveJournalFresh(j);
          return { ok: false, error: `Futures entry flattened (protection-first): native TP/SL arm nahi hua — ${tpslNote}. Position close ho gayi, scratch exit (fee-only).` };
        }
        // flatten fail — honest booking + watcher guard (existing path)
        tpslNote = `native TP/SL NOT armed + FLATTEN BHI FAIL (${String(flattenErr).slice(0, 60)}) — server watcher hi exit guard hai; manual verify karo`;
      }
      // v21.1.1 [audit B5]: position pe protectionMissing stamp — watcher
      // har pass native TP/SL re-arm karega jab tak arm na ho (ya flatten).
      // Covers: id-resolution miss (tpsl attempted hi nahi) + flatten-fail.
      const protectionMissing = tpslFailed || !exchangePositionId;
      let ledgerEntryId = null;
      try { ledgerEntryId = recordExecution(signal, { mode: 'live', market: 'FUTURES', source })?.id || null; } catch { /* best-effort */ }
      const position = mkPosition({
        exchangeOrderId: orderId ?? null,
        ...(exchangePositionId ? { exchangePositionId } : {}),
        ...(exchangeLiq ? { liquidation: exchangeLiq, liquidationSource: 'exchange' } : {}),
        ...(ledgerEntryId ? { ledgerEntryId } : {}),
        ...(protectionMissing ? { protectionMissing: true } : {}),
        status: 'OPEN',
      });
      j.positions.push(position);
      pushEntry(j, {
        ...entry, status: orderId || exchangePositionId ? 'SUBMITTED' : 'SUBMITTED_UNKNOWN',
        qty, price: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr),
        leverage: lev, marginUSDT: marginUsed, exchangeOrderId: orderId ?? null,
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [verdict.reason, fitNote, levNote, walletNote, tpslNote].filter(Boolean).join(' · '),
      });
      saveJournalFresh(j);
      return {
        ok: true, mode: 'live', orderId, position,
        filled: { qty, price: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr), leverage: lev, marginUSDT: marginUsed },
        ...(walletNote || fitNote || levNote || tpslNote ? { fitted: [walletNote, fitNote, levNote, tpslNote].filter(Boolean).join(' · ') } : {}),
      };
    } catch (e) {
      // v21.1.1 [audit B6]: AMBIGUOUS TRANSPORT ERRORS (timeout/network) —
      // order exchange pe FILL ho bhi sakti thi. Spot desk (v21.1.0 fix) ki
      // tarah ab UNKNOWN position row book hoti hai warna one-per-pair block
      // disarm ho jaata tha aur 30s agent loop usi pair pe DUSRA live order
      // daal deta tha (double-fill + pehli position bina SL ke).
      const ambiguous = isAmbiguousTransportError(e);
      if (ambiguous) {
        const position = mkPosition({ status: 'UNKNOWN', ambiguousEntry: true, protectionMissing: true });
        j.positions.push(position);
        pushEntry(j, {
          ...entry, status: 'SUBMITTED_UNKNOWN',
          reason: `AMBIGUOUS ENTRY (timeout/network) — order MAY have filled on the exchange; pair re-entry blocked till reconciled. ${String(e?.message || e).slice(0, 140)}`,
        });
        saveJournalFresh(j);
        return { ok: false, error: `CoinDCX futures order AMBIGUOUS: ${e?.message || e} — duplicate-entry guard armed (UNKNOWN row)`, ambiguous: true, position };
      }
      pushEntry(j, { ...entry, status: 'FAILED', reason: String(e?.message || e).slice(0, 200) });
      saveJournalFresh(j);
      return { ok: false, error: `CoinDCX futures order failed: ${e?.message || e}` };
    }
  });
}

// ============================================================
// v21.20.0 DIRECT MTF DUAL-BOARD LIVE EXECUTION ENGINE
// ------------------------------------------------------------
// Executes the exact MTF Dual-Timeframe Signal Board trade plan
// (15m+5m or 1h+15m) on CoinDCX USDT Perpetual Futures using the
// connected .env (COINDCX_API_KEY + COINDCX_SECRET) or saved keys,
// with wallet-tier leverage (< ₹10,000 → 10x, ≥ ₹10,000 → 5x),
// native exchange TP/SL, and fee-protected zero-loss watcher tracking.
// ============================================================
let _mtfLiveOrderInFlight = false;

export function __resetMtfLiveOrderLockForTests() {
  try { __resetTradeActionLogForTests(); } catch { /* test-only */ }
  _mtfLiveOrderInFlight = false;
}

export async function executeMtfDualLiveOrder(opts = {}) {
  // v21.29.0 [R1 ORDER IDEMPOTENCY]: one logical plan → one exchange
  // mutation. Double-click / overlapping loops / a retry after restart all
  // land on the same key. Success and AMBIGUOUS outcomes stay held for the
  // TTL (never blind-retry); deterministic refusals release immediately.
  const idemParts = opts?.idempotencyKey
    ? ['mtf-live-explicit', opts.idempotencyKey]
    : ['mtf-live', opts?.symbol, opts?.side, opts?.mode, opts?.source,
      opts?.entry, opts?.stopLoss, opts?.t1, opts?.t2];
  const idemKey = actionKey(idemParts);
  const claim = claimAction(idemKey, {
    ttlMs: 5 * 60_000,
    meta: { symbol: opts?.symbol || null, side: opts?.side || null, source: opts?.source || null },
  });
  if (!claim.ok) {
    const msg = `duplicate live order blocked (${claim.status || 'held'}) — idempotency key ${idemKey.slice(0, 8)} until ${new Date(Number(claim.until) || Date.now()).toISOString()}`;
    return {
      ok: false, blocked: true, duplicate: true, idempotencyKey: idemKey,
      reason: msg, error: msg, retryAt: claim.until || null,
    };
  }
  let res;
  try {
    res = await _executeMtfDualLiveOrderInner(opts);
  } catch (e) {
    // Unexpected throw — outcome may be ambiguous at the exchange. KEEP the
    // key held; a reconcile must decide before another entry is allowed.
    finishAction(idemKey, { status: 'ambiguous', result: { error: String(e?.message || e) } });
    throw e;
  }
  const ambiguous = res?.ambiguous === true || res?.position?.status === 'UNKNOWN' || res?.inFlight === true;
  if (res?.ok === true || ambiguous) {
    finishAction(idemKey, { status: res?.ok === true ? 'done' : 'ambiguous', result: { ok: res?.ok === true, ambiguous } });
  } else {
    releaseAction(idemKey, { reason: String(res?.reason || res?.error || 'rejected') });
  }
  return { ...res, idempotencyKey: idemKey };
}

async function _executeMtfDualLiveOrderInner(opts = {}) {
  if (_mtfLiveOrderInFlight) {
    return {
      ok: false,
      blocked: true,
      inFlight: true,
      reason: '1 session = 1 trade lock: a live order is already in-flight — duplicate concurrent trade blocked',
      error: '1 session = 1 trade lock: a live order is already in-flight — duplicate concurrent trade blocked',
    };
  }
  _mtfLiveOrderInFlight = true;
  try {
  const {
    symbol, side, leverage, entry: planEntry, stopLoss: planSl, t1: planT1, t2: planT2,
    superScore = null, tier = null, mode = 'INTRADAY', source = 'mtf-dual-board',
    marginUSDT = null, qtyINR = null,
  } = opts || {};

  const ordersMod = await import('./coindcxOrders.js');
  const cfg = ordersMod.loadConfig();
  if (cfg.killSwitch) {
    return { ok: false, blocked: true, reason: 'Kill switch ON — execution disabled', error: 'Kill switch ON — execution disabled' };
  }

  // 1) Credential resolution: mcp-coindcx.json OR .env COINDCX_API_KEY + COINDCX_SECRET
  const creds = loadCredsForOrder();
  if (!creds?.apiKey || !creds?.secret) {
    return {
      ok: false, blocked: true,
      reason: 'CoinDCX API key & secret not connected — add COINDCX_API_KEY + COINDCX_SECRET in .env or connect in Portfolio tab',
      error: 'CoinDCX API key & secret not connected — add COINDCX_API_KEY + COINDCX_SECRET in .env or connect in Portfolio tab',
    };
  }
  // If .env credentials exist and mcp-coindcx.json was not yet persisted, persist now so all gates see connected=true
  if (!coindcxConnected()) {
    try {
      saveJSON('mcp-coindcx.json', {
        apiKey: creds.apiKey,
        secret: creds.secret,
        connectedAt: Date.now(),
        lastSyncAt: Date.now(),
        source: 'env',
      });
    } catch { /* best-effort */ }
  }
  // Auto-sync live mode config when user triggers Live execution from MTF Dual Board
  // (keep legacy spot allowAuto=false so legacy 90s spot loop never places a 2nd competing trade)
  // v21.23.10 [AUTO-SYNC SCOPE]: ye auto-sync ab sirf MANUAL board clicks
  // (source 'mtf-dual-board') ke liye — AUTO engine ticks (source
  // 'mtf-auto-live') pehle CHUPKE se global site config ko mode:'live'
  // likh dete the (typed-LIVE validation bypass) — engine ka apna live
  // mode cfg.executionMode se aata hai, global flip ki zaroorat nahi.
  if ((cfg.mode !== 'live' || cfg.allowAuto) && source !== 'mtf-auto-live') {
    try {
      ordersMod.saveConfig({ ...cfg, mode: 'live', allowAuto: false, liveConfirmedAt: Date.now() });
    } catch { /* best-effort */ }
  }

  const reqSide = String(side || '').toUpperCase();
  if (reqSide !== 'LONG' && reqSide !== 'SHORT') {
    return { ok: false, blocked: true, reason: `Invalid trade side "${side}" (LONG or SHORT required)`, error: `Invalid trade side "${side}"` };
  }

  const pair = futuresPairFor(symbol);
  const base = baseOfFuturesPair(pair);
  const day = todayIST();
  const journalEntryBase = { kind: 'ORDER', day, symbol: pair, side: reqSide, mode: 'live', market: 'FUTURES', source };

  // 2) Resolve live USDT price + validate SL/T1/T2 geometry
  let livePx = null;
  try {
    const fpx = await fetchFuturesPrices({ maxAgeMs: 4000 });
    const rows = Array.isArray(fpx) ? fpx : (fpx?.rows || []);
    const row = rows.find(r => r.pair === pair || r.base === base || r.symbol === base);
    if (row && Number(row.last ?? row.ltp ?? row.mark) > 0) {
      livePx = Number(row.last ?? row.ltp ?? row.mark);
    }
    // v21.23.10 [FRESH-PRICE GATE]: live MARKET order ke liye sirf FRESH +
    // OFFICIAL (CoinDCX) row — fetchFuturesPrices ki failure-ladder 180s
    // deep-stale cache tak aur Binance/Bybit cross-venue synth rows tak gir
    // sakti thi. 3-minute-old ya cross-venue price par qty sizing + SL/T1/T2
    // re-anchor = instant premature stop / galta notional. Stale/synth row
    // → planEntry (board price, seconds-old) fallback — wo bhi missing to
    // neeche honest reject.
    if (livePx != null) {
      const rowTs = Number(row?.ts || 0);
      const rowSrc = String(row?.source || row?.src || '');
      const freshOfficial = rowTs > 0 && Date.now() - rowTs <= 30_000 && !/binance|bybit/i.test(rowSrc);
      if (!freshOfficial) livePx = null;
    }
  } catch { /* fallback to planEntry */ }

  const price = (livePx != null && livePx > 0) ? livePx : (Number(planEntry) > 0 ? Number(planEntry) : null);
  if (!(price > 0)) {
    return { ok: false, error: `No live futures price available for ${pair}` };
  }

  const rawRiskPct = (Number(planEntry) > 0 && Number(planSl) > 0)
    ? Math.max(0.008, Math.min(0.04, Math.abs(Number(planEntry) - Number(planSl)) / Number(planEntry)))
    : 0.01;
  let sl = Number(planSl) > 0 ? Number(planSl) : null;
  let tp1 = Number(planT1) > 0 ? Number(planT1) : null;
  let tp2 = Number(planT2) > 0 ? Number(planT2) : null;

  // v21.22.0 CONCRETE PREMATURE-CLOSE FIX:
  // If `planEntry` was a Pullback or Breakout level away from actual market `price` (> 0.25% drift),
  // OR if `sl` / `tp1` / `tp2` is dangerously close to `price` (< 0.55% stop distance),
  // re-anchor `sl`, `tp1`, `tp2` directly around the actual fill `price` so CoinDCX native TP/SL
  // or Deep Monitor NEVER closes the position 2 seconds after entry!
  const entryDriftPct = Number(planEntry) > 0 ? Math.abs(price - Number(planEntry)) / price : 0;
  const slDistPct = sl != null && sl > 0 ? Math.abs(price - sl) / price : 0;
  const slValid = sl != null && (reqSide === 'LONG' ? sl < price : sl > price) && slDistPct >= 0.0055 && entryDriftPct <= 0.0025;
  if (!slValid) {
    const dist = price * rawRiskPct;
    const origRisk = (Number(planEntry) > 0 && Number(planSl) > 0) ? Math.abs(Number(planEntry) - Number(planSl)) : 0;
    const r1Mult = (origRisk > 0 && Number(planT1) > 0)
      ? Math.max(1.2, Math.min(3.0, Math.abs(Number(planT1) - Number(planEntry)) / origRisk))
      : 1.3;
    const r2Mult = (origRisk > 0 && Number(planT2) > 0)
      ? Math.max(r1Mult + 0.8, Math.min(5.0, Math.abs(Number(planT2) - Number(planEntry)) / origRisk))
      : 2.4;
    sl = pRound(reqSide === 'LONG' ? price - dist : price + dist);
    tp1 = pRound(reqSide === 'LONG' ? price + dist * r1Mult : price - dist * r1Mult);
    tp2 = pRound(reqSide === 'LONG' ? price + dist * r2Mult : price - dist * r2Mult);
  } else {
    const minT1Dist = Math.max(Math.abs(price - sl), price * 0.0075);
    if (!(tp1 > 0) || (reqSide === 'LONG' ? tp1 <= price + price * 0.005 : tp1 >= price - price * 0.005)) {
      tp1 = pRound(reqSide === 'LONG' ? price + minT1Dist : price - minT1Dist);
    }
    if (!(tp2 > 0) || (reqSide === 'LONG' ? tp2 <= tp1 + price * 0.005 : tp2 >= tp1 - price * 0.005)) {
      tp2 = pRound(reqSide === 'LONG' ? price + 2.2 * minT1Dist : price - 2.2 * minT1Dist);
    }
  }

  // 3) Wallet-tier leverage (< ₹10,000 → 10x, ≥ ₹10,000 → 5x) + INR/USDT Futures Wallet margin check
  const usdInr = await fetchUsdInr().catch(() => COINDCX_INR_PER_USDT);
  // v21.23.10 [META-RESCUE]: fallback/guessed meta (status 'unknown') par EK
  // cache-busting fresh re-fetch — pehle ek network hiccup 6 GHANTE tak
  // guessed qtyPrecision/minQty:0 cache karta tha → us window ka HAR live
  // order galat precision/laddar par reject ("live orders not executing"
  // class). fetchFuturesInstrumentMeta ab 'unknown' ko sirf 60s cache karta hai.
  let meta = await fetchFuturesInstrumentMeta(pair).catch(() => null);
  if (meta && String(meta.status) !== 'active') {
    meta = await fetchFuturesInstrumentMeta(pair, { bust: true }).catch(() => meta);
  }
  const proCfg = loadProTraderConfig();
  let freeUsdt = 0;
  let walletINR = Number(proCfg?.walletAmountINR) > 0 ? Number(proCfg.walletAmountINR) : 8000;
  let marginCurrency = 'USDT';
  let altMarginCurrency = 'INR';
  let walletNote = null;
  try {
    const wallets = await fetchFuturesWallets();
    const wInfo = resolveFuturesWalletMargin(wallets, COINDCX_INR_PER_USDT);
    freeUsdt = wInfo.primaryFreeUSDT || wInfo.combinedFreeUSDT || 0;
    marginCurrency = wInfo.marginCurrency || 'USDT';
    altMarginCurrency = marginCurrency === 'INR' ? 'USDT' : 'INR';
    if (wInfo.combinedFreeINR > 0) {
      walletINR = wInfo.combinedFreeINR;
    }
  } catch (e) {
    // v21.23.10 [WALLET-FAIL BLOCK]: wallet read FAILURE (network/auth —
    // empty wallet NAHI, wo legit [] hota hai) par live order block karo.
    // Pehle ₹8000 proTrader default guess se sizing hoti thi → 7-rung ladder
    // × 2 margin-retries = 14 real exchanges POSTs har attempt "insufficient
    // funds" par barbaad (backoff ke bina har ~10s repeat).
    return {
      ok: false, blocked: true,
      reason: `CoinDCX futures wallet read failed — order blocked (sizing unreliable): ${String(e?.message || e).slice(0, 140)}`,
      error: 'futures wallet read failed',
    };
  }

  const tierLev = walletINR > 0 && walletINR < 10000 ? 10 : 5;
  const maxInstLev = Number(meta?.maxLeverage) >= 1 ? Math.floor(Number(meta.maxLeverage)) : 20;
  let lev = Math.max(1, Math.min(maxInstLev, Math.floor(Number(leverage) || tierLev)));

  // v21.22.0: 100% CoinDCX Wallet Deployment as per Wallet amount & Leverage (< ₹10,000 → 10x, ≥ ₹10,000 → 5x)
  // Using CoinDCX official USDT/INR rate (`1 USDT = Rs 102`)
  const coinDcxFx = marginCurrency === 'INR' ? Math.max(usdInr, COINDCX_INR_PER_USDT) : usdInr;
  const walletDeployPct = Math.min(100, Math.max(10, Number(opts?.walletDeployPct) || 100));
  const deployedWalletINR = Math.round(walletINR * (walletDeployPct / 100) * 100) / 100;
  const deployedWalletUSDT = Math.round(((marginCurrency === 'INR' && walletINR > 0 ? walletINR / coinDcxFx : (freeUsdt > 0 ? freeUsdt : walletINR / coinDcxFx)) * (walletDeployPct / 100)) * 10000) / 10000;

  // Determine USDT margin for the order (defaults to 100% of fetched CoinDCX wallet)
  let margin = Number(marginUSDT) > 0
    ? Number(marginUSDT)
    : Number(qtyINR) > 0
      ? Number(qtyINR) / coinDcxFx
      : Math.max(2.0, deployedWalletINR / coinDcxFx);

  if (freeUsdt > 0 && margin > freeUsdt) {
    try {
      const spotWallets = await fetchSpotWallets();
      const spotUSDT = spotWallets.find(w => w.currency === 'USDT')?.free || 0;
      const spotINR = spotWallets.find(w => w.currency === 'INR')?.free || 0;
      const need = margin - freeUsdt;
      if (spotUSDT >= need) {
        await transferSpotToFutures({ amount: r2(need + 0.5), currency: 'USDT' });
        freeUsdt += need;
        marginCurrency = 'USDT';
        walletNote = `auto-moved ${r2(need + 0.5)} USDT spot → futures`;
      } else if (spotINR / coinDcxFx >= need) {
        const usdtNeed = r2(need + 0.5);
        await transferSpotToFutures({ amount: r2(usdtNeed * coinDcxFx), currency: 'INR' });
        freeUsdt += need;
        walletNote = `auto-moved ₹${r2(usdtNeed * coinDcxFx)} spot → futures`;
      }
    } catch { /* proceed with available freeUsdt */ }
  }

  // v21.22.0 FULL 100% WALLET SIZING (`1 USDT = Rs 102` on CoinDCX):
  // Previously, dividing Rung 1 by `(1/lev + safetyPct/100 + 0.003)` shrank a ₹3,000 wallet at 10x
  // down to ₹2,435 (81.2%). Now Rung 1 sizes directly at 98.5% of the full CoinDCX Wallet
  // (~₹2,955 on ₹3,000 at 10x, leaving only 1.5% for CoinDCX's entry taker fee), and the 7-rung
  // ladder steps down only if CoinDCX requests a safety reserve on that specific instrument.
  const safetyPct = Number(meta?.safetyPct) > 0 ? Number(meta.safetyPct) : 2.0;
  const effectiveFreeUsdt = marginCurrency === 'INR' && walletINR > 0
    ? (walletINR / coinDcxFx)
    : freeUsdt;
  if (effectiveFreeUsdt >= 1.2) {
    const utilFactor = lev >= 8 ? 0.985 : 0.965;
    const maxSafeNominalMargin = Math.floor((effectiveFreeUsdt * (walletDeployPct / 100) * utilFactor) * 1000) / 1000;
    const forceFullWalletDeploy = opts?.walletDeployPct != null || !(Number(marginUSDT) > 0);
    if ((forceFullWalletDeploy || margin > maxSafeNominalMargin) && maxSafeNominalMargin >= 1.0) {
      margin = maxSafeNominalMargin;
      walletNote = walletNote || `${walletDeployPct}% wallet deployed (${r2(margin)} USDT @ 1 USDT = ₹${coinDcxFx} · ₹${Math.round(margin * coinDcxFx)} of ₹${walletINR} ${marginCurrency} wallet @ ${lev}x)`;
    }
  }
  margin = Math.max(1.0, Math.round(margin * 1000) / 1000);

  // 4) Quantity calculation + exchange minQty / minNotional auto-fit
  const precision = meta?.qtyPrecision ?? guessPrecision(pair);
  const stepUnit = 10 ** (-Math.max(0, Math.min(8, Math.floor(precision))));
  const minExchangeNotional = Math.max(
    Number(meta?.minNotional) > 0 ? Number(meta.minNotional) : 6,
    (Number(meta?.minQty) > 0 ? Number(meta.minQty) : stepUnit) * price,
  );
  const minQtyForExchange = Math.max(
    Number(meta?.minQty) > 0 ? Number(meta.minQty) : stepUnit,
    Math.ceil(((minExchangeNotional * 1.03) / price) / stepUnit - 1e-9) * stepUnit,
  );
  const minQtyRounded = Number(minQtyForExchange.toFixed(Math.max(0, Math.min(8, Math.floor(precision)))));

  const rawQty = (margin * lev) / price;
  let qty = roundFuturesQty(pair, rawQty, precision);
  if (qty < minQtyRounded) {
    // Check if bumping leverage within instrument maxLeverage makes minQtyRounded affordable
    if (freeUsdt > 0 && maxInstLev > lev) {
      const minNotionalVal = minQtyRounded * price;
      const neededLev = Math.ceil(minNotionalVal / Math.max(1, (freeUsdt * 0.80) - minNotionalVal * ((safetyPct / 100) + 0.003)));
      if (neededLev > lev && neededLev <= maxInstLev) {
        lev = neededLev;
      }
    }
    const minMarginNeeded = (minQtyRounded * price) / lev;
    if (freeUsdt <= 0 || minMarginNeeded <= Math.max(freeUsdt * 0.92, margin * 3)) {
      qty = minQtyRounded;
      margin = r2(minMarginNeeded) || margin;
    } else {
      return {
        ok: false,
        reason: `Quantity ${qty} below exchange min (${minQtyRounded}) for ${pair} — requires ~${r2(minMarginNeeded)} USDT margin at ${lev}x`,
        error: `Quantity ${qty} below exchange min (${minQtyRounded}) for ${pair} — requires ~${r2(minMarginNeeded)} USDT margin at ${lev}x`,
      };
    }
  }
  if (!(qty > 0)) {
    return { ok: false, reason: `Calculated quantity is 0 for ${pair}`, error: `Calculated quantity is 0 for ${pair}` };
  }

  let notionalUSDT = r2(qty * price);
  let marginUsed = r2(notionalUSDT / lev);
  const liquidation = lev > 1
    ? pRound(reqSide !== 'SHORT' ? price * (1 - 0.95 / lev) : price * (1 + 0.95 / lev))
    : null;

  return await withJournalLock(async () => {
    const j = loadJournalFresh();
    // v21.22.0 STRICT 1-TRADE-PER-SESSION + LIVE EXCHANGE RECONCILIATION:
    // 1. Check live CoinDCX `/positions` and all open live journal rows across ALL pairs.
    // 2. If ANY position is currently active on CoinDCX (or opened within the last 120s in this session),
    //    NEVER open a 2nd concurrent trade!
    // 3. Only reconcile a journal row as flat if it is >= 120s old AND flat on CoinDCX.
    const openLivePositions = j.positions.filter(
      p => p && p.market === 'FUTURES' && p.mode === 'live' && (p.status === 'OPEN' || p.status === 'UNKNOWN'),
    );
    let liveExch = null;
    try {
      liveExch = await listFuturesPositions();
    } catch {
      liveExch = null;
    }

    if (Array.isArray(liveExch)) {
      const activeExchList = liveExch.filter(p => p && Math.abs(Number(p.activePos) || 0) > 0);
      const sameActiveExch = activeExchList.find(p => p.pair === pair);
      if (sameActiveExch) {
        const existingSame = openLivePositions.find(p => p.pair === pair) || null;
        // v21.23.14 [SIDE-HONESTY]: same pair is NOT the same trade. A user's
        // manual/journaled LONG on the pair must never make a requested SHORT
        // return ok:true (callers then book a phantom opposite-side LIVE row).
        // v21.25.0 [EXCHANGE SIGN AUTHORITATIVE]: activePos sign = truth.
        // Zero/unreadable sign pe koi guess nahi — entry honestly blocked.
        const activePosN = Number(sameActiveExch.activePos);
        const exchSide = normalizeSide(activePosN);
        if (!exchSide) {
          const msg = `Exchange activePos for ${pair} unreadable (${String(sameActiveExch.activePos)}) — ${reqSide} entry blocked (no direction guess)`;
          return { ok: false, blocked: true, reason: msg, error: msg, requestedSide: reqSide };
        }
        if (exchSide !== reqSide) {
          const msg = `Opposite ${exchSide} position already active on ${pair} - ${reqSide} entry blocked (1 session = 1 direction)`;
          return { ok: false, blocked: true, reason: msg, error: msg, existingSide: exchSide, requestedSide: reqSide };
        }
        return {
          ok: true,
          mode: 'live',
          alreadyOpen: true,
          orderId: existingSame?.exchangeOrderId || existingSame?.id || sameActiveExch.id,
          position: existingSame,
          filled: {
            orderId: existingSame?.exchangeOrderId || existingSame?.id || sameActiveExch.id,
            marginCurrency,
            walletDeployPct,
            deployedWalletINR,
            deployedWalletUSDT,
            // v21.23.10 [FILLED-CONTRACT ALIASES] — alreadyOpen path par bhi.
            walletDeployINR: deployedWalletINR,
            buyingPowerINR: Math.round(Number(deployedWalletINR) * Number(lev || leverage || 1)),
            walletTotalINR: Math.round(walletINR * 100) / 100,
            qty: Math.abs(Number(sameActiveExch.activePos) || existingSame?.qty || qty),
            price: pRound(Number(sameActiveExch.avgPrice) || existingSame?.entryPrice || price),
            notionalUSDT,
            notionalINR: inrOfUsdt(notionalUSDT, coinDcxFx),
            leverage: Number(sameActiveExch.leverage) || existingSame?.leverage || lev,
            marginUSDT: marginUsed,
            stopLoss: existingSame?.sl || sl,
            t1: existingSame?.tp || tp1,
            t2: existingSame?.tp2 || tp2,
          },
        };
      }
      if (activeExchList.length > 0) {
        const otherActive = activeExchList[0];
        const msg = `1 session = 1 trade lock: ${otherActive.pair} is already active on CoinDCX — next trade will open only after ${otherActive.pair} finishes`;
        return { ok: false, blocked: true, alreadyActivePair: otherActive.pair, reason: msg, error: msg };
      }
    }

    if (openLivePositions.length > 0) {
      let journalDirty = false;
      for (const pos of openLivePositions) {
        const posAgeMs = Date.now() - (Number(pos.openedAt) || 0);
        const exchRow = Array.isArray(liveExch) ? liveExch.find(p => p.pair === pos.pair) : null;
        const stillActiveOnCoinDcx = exchRow && Math.abs(Number(exchRow.activePos) || 0) > 0;
        // Never mark a recently opened position (<120s) closed while CoinDCX may still be indexing `/positions`
        if (stillActiveOnCoinDcx || posAgeMs < 120_000 || !Array.isArray(liveExch)) {
          if (pos.pair === pair) {
            return {
              ok: true,
              mode: 'live',
              alreadyOpen: true,
              orderId: pos.exchangeOrderId || pos.id,
              position: pos,
              filled: {
                orderId: pos.exchangeOrderId || pos.id,
                marginCurrency,
                walletDeployPct,
                deployedWalletINR,
                deployedWalletUSDT,
                // v21.23.10 [FILLED-CONTRACT ALIASES] — alreadyOpen path par bhi.
                walletDeployINR: deployedWalletINR,
                buyingPowerINR: Math.round(Number(deployedWalletINR) * Number(lev || leverage || 1)),
                walletTotalINR: Math.round(walletINR * 100) / 100,
                qty: Math.abs(Number(exchRow?.activePos) || pos.qty || qty),
                price: pRound(Number(exchRow?.avgPrice) || pos.entryPrice || price),
                notionalUSDT,
                notionalINR: inrOfUsdt(notionalUSDT, coinDcxFx),
                leverage: Number(exchRow?.leverage) || pos.leverage || lev,
                marginUSDT: marginUsed,
                stopLoss: pos.sl || sl,
                t1: pos.tp || tp1,
                t2: pos.tp2 || tp2,
              },
            };
          }
          const msg = `1 session = 1 trade lock: ${pos.symbol || pos.pair} (${pos.side}) is already active in this session — next trade will open only after it finishes`;
          return { ok: false, blocked: true, alreadyActivePair: pos.pair, reason: msg, error: msg };
        }
        // Position is >= 120s old and flat on CoinDCX -> mark stale journal row CLOSED
        pos.status = 'CLOSED';
        pos.closedAt = Date.now();
        pos.closeReason = 'Reconciled flat on CoinDCX before new live order';
        journalDirty = true;
      }
      if (journalDirty) saveJournalFresh(j);
    }

    const mkPosition = (extra = {}) => ({
      id: crypto.randomUUID(),
      pair, symbol: base, market: 'FUTURES', side: reqSide, mode: 'live', source,
      qty, entryPrice: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, coinDcxFx),
      marginUSDT: marginUsed, marginINR: inrOfUsdt(marginUsed, coinDcxFx),
      marginCurrency,
      leverage: lev, ...(lev > 1 ? { liquidation } : {}),
      sl, tp: tp1, tp2,
      initialRisk: pRound(Math.abs(price - sl)),
      peakPrice: pRound(price),
      feeBreakevenFloor: feeBreakevenFloor({ entry: price, side: reqSide, market: 'FUTURES' }),
      signal: {
        grade: tier || 'STRONG',
        confidence: superScore || 80,
        agreement: 0.85,
        summary: `MTF Dual Board (${mode}) ${reqSide} · score ${superScore ?? '—'} (${tier || 'STRONG'}) · ${lev}x (${marginCurrency})`,
      },
      openedAt: Date.now(),
      status: 'OPEN',
      ...extra,
    });

    try {
      // v21.22.0 100% WALLET 7-RUNG HIGH-UTILIZATION ORDER LADDER:
      // 1) 98.5% full wallet deployment in primary wallet currency ('INR' @ 1 USDT = ₹102, else 'USDT')
      // 2) Fine-grained step-down rungs (0.97x -> 0.93x -> 0.88x -> 0.82x) so max wallet is always deployed
      // 3) Minimum valid exchange lot (minQtyRounded) fallback
      const attemptCandidates = [
        { q: qty, l: lev, mc: marginCurrency },
        { q: Math.max(minQtyRounded, roundFuturesQty(pair, qty * 0.97, precision)), l: Math.min(lev, maxInstLev), mc: marginCurrency },
        { q: Math.max(minQtyRounded, roundFuturesQty(pair, qty * 0.93, precision)), l: Math.min(lev, maxInstLev), mc: marginCurrency },
        { q: Math.max(minQtyRounded, roundFuturesQty(pair, qty * 0.88, precision)), l: Math.min(lev, maxInstLev), mc: marginCurrency },
        { q: Math.max(minQtyRounded, roundFuturesQty(pair, qty * 0.82, precision)), l: Math.min(lev, maxInstLev), mc: marginCurrency },
        { q: minQtyRounded, l: Math.min(lev, maxInstLev), mc: marginCurrency },
        { q: minQtyRounded, l: Math.min(lev, maxInstLev), mc: altMarginCurrency },
      ];
      let orderRes = null;
      let lastErr = null;
      for (const att of attemptCandidates) {
        if (!(att.q > 0)) continue;
        try {
          const res = await createFuturesOrder({ pair, side: reqSide, qty: att.q, leverage: att.l, marginCurrency: att.mc });
          if (res?.orderId && !res?.error) {
            orderRes = res;
            qty = att.q;
            lev = att.l;
            marginCurrency = att.mc;
            notionalUSDT = r2(qty * price);
            marginUsed = r2(notionalUSDT / lev);
            break;
          }
          lastErr = res?.error || 'order rejected';
          if (!/insufficient|margin|balance|leverage|quantity/i.test(String(lastErr))) {
            orderRes = res;
            break;
          }
        } catch (err) {
          lastErr = String(err?.message || err);
          if (!/insufficient|margin|balance|leverage|quantity/i.test(lastErr)) {
            throw err;
          }
        }
      }
      if (!orderRes && lastErr) {
        throw new Error(lastErr);
      }
      const orderId = orderRes?.orderId ?? null;
      if (orderRes?.error) {
        pushEntry(j, { ...journalEntryBase, status: 'FAILED', reason: `exchange rejected: ${String(orderRes.error).slice(0, 160)}` });
        saveJournalFresh(j);
        return {
          ok: false,
          reason: `CoinDCX futures order rejected: ${orderRes.error}`,
          error: `CoinDCX futures order rejected: ${orderRes.error}`,
        };
      }

      // Resolve position id & arm native TP/SL on CoinDCX (best-effort; watcher re-arms if indexing takes >3s)
      let exchangePositionId = null, exchangeLiq = null;
      for (let i = 0; i < 3 && !exchangePositionId; i++) {
        await new Promise(r => setTimeout(r, 900));
        const positions = await listFuturesPositions().catch(() => []);
        const row = positions.find(p => p.pair === pair && p.activePos !== 0);
        if (row) {
          exchangePositionId = row.id;
          exchangeLiq = row.liquidationPrice > 0 ? row.liquidationPrice : null;
        }
      }

      let tpslArmed = false;
      let tpslNote = null;
      if (exchangePositionId) {
        const tpsl = await createFuturesTpsl({ positionId: exchangePositionId, stopLoss: sl, takeProfit: tp2 }).catch(e => ({ ok: false, error: String(e?.message || e) }));
        if (tpsl?.ok) {
          tpslArmed = true;
          tpslNote = `native TP/SL armed (SL ${sl} · TP ${tp2})`;
        } else {
          tpslNote = `native TP/SL pending (${String(tpsl?.error || 'watcher will re-arm').slice(0, 60)})`;
        }
      } else {
        tpslNote = 'position indexing — watcher will arm native TP/SL on next pass';
      }

      const position = mkPosition({
        exchangeOrderId: orderId ?? null,
        ...(exchangePositionId ? { exchangePositionId } : {}),
        ...(exchangeLiq ? { liquidation: exchangeLiq, liquidationSource: 'exchange' } : {}),
        ...(!tpslArmed ? { protectionMissing: true } : {}),
      });
      j.positions.push(position);
      pushEntry(j, {
        ...journalEntryBase,
        status: orderId || exchangePositionId ? 'SUBMITTED' : 'SUBMITTED_UNKNOWN',
        qty, price: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr),
        leverage: lev, marginUSDT: marginUsed, exchangeOrderId: orderId ?? null,
        signal: { grade: tier || 'STRONG', conf: superScore || 80, agreement: 0.85 },
        reason: [`MTF Dual Board ${mode} ${reqSide} (${lev}x)`, walletNote, tpslNote].filter(Boolean).join(' · '),
      });
      saveJournalFresh(j);

      return {
        ok: true,
        mode: 'live',
        orderId: orderId || position.id,
        position,
        orderSide: reqSide === 'LONG' ? 'buy' : 'sell',
        directionCertificate: buildDirectionCertificate({
          symbol: base,
          market: 'FUTURES',
          side: reqSide,
          entry: price,
          stopLoss: sl,
          t1: tp1,
          t2: tp2,
          requireTargets: true,
          directionVerified: true,
          source,
        }),
        filled: {
          orderId: orderId || position.id,
          marginCurrency,
          walletDeployPct,
          deployedWalletINR,
          deployedWalletUSDT,
          // v21.23.10 [FILLED-CONTRACT ALIASES]: caller (mtfAutoLink:1952+ /
          // recordLiveMtfBoardTrade) `filled.walletDeployINR` +
          // `filled.buyingPowerINR` padhte the — producer ye naam KABHI nahi
          // bhejta tha (mock-drift: tests khud walletDeployINR waale mocks
          // dete the). Honest aliases ab producer-side guaranteed.
          walletDeployINR: deployedWalletINR,
          buyingPowerINR: Math.round(Number(deployedWalletINR) * Number(lev || leverage || 1)),
          walletTotalINR: Math.round(walletINR * 100) / 100,
          qty, price: pRound(price), notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr),
          leverage: lev, marginUSDT: marginUsed, stopLoss: sl, t1: tp1, t2: tp2,
        },
        ...(walletNote || tpslNote ? { fitted: [walletNote, tpslNote].filter(Boolean).join(' · ') } : {}),
      };
    } catch (e) {
      const msg = String(e?.message || e);
      pushEntry(j, { ...journalEntryBase, status: 'FAILED', reason: msg.slice(0, 200) });
      saveJournalFresh(j);
      return { ok: false, reason: `CoinDCX futures order failed: ${msg}`, error: `CoinDCX futures order failed: ${msg}` };
    }
  });
  } finally {
    _mtfLiveOrderInFlight = false;
  }
}

/** Spot ↔ futures margin transfer ("deposit" moves spot → futures). */
export async function transferSpotToFutures({ amount, currency = 'USDT' }) {
  const { apiKey, secret } = credGuard();
  const body = { timestamp: Date.now(), transfer_type: 'deposit', amount: Number(amount), currency_short_name: String(currency).toUpperCase() };
  return coindcxPrivate('/exchange/v1/derivatives/futures/wallets/transfer', apiKey, secret, body);
}

// ---------------- v21.22.0 FULL CONTROL OF COINDCX ACTIVE POSITIONS ----------------
let _activePosCtrlCache = null;

/**
 * Fetches and reconciles all genuinely ACTIVE CoinDCX Futures positions
 * (from CoinDCX `/positions` API + open live journal positions), arms native TP/SL
 * if missing on the exchange, and returns normalized active position records
 * so `mtfAutoLink.syncCoinDcxActivePositionsToDeepMonitor` can take 100% control.
 */
export async function syncCoinDcxActivePositionsForControl({ force = false } = {}) {
  const now = Date.now();
  if (!force && _activePosCtrlCache && (now - _activePosCtrlCache.at) < 4000) {
    return _activePosCtrlCache.value;
  }
  const hasCreds = Boolean(loadCredsForOrder());
  let exchPositions = null;
  let allExchRows = null;
  if (hasCreds) {
    try {
      const allExch = await listFuturesPositions();
      if (Array.isArray(allExch)) {
        allExchRows = allExch;
        exchPositions = allExch.filter(
          p => p && Math.abs(Number(p.activePos) || 0) > 0 && (Number(p.avgPrice) > 0 || Number(p.markPrice) > 0),
        );
      }
    } catch {
      exchPositions = null;
    }
  }

  const j = loadJournalFresh();
  const openLiveJournal = Array.isArray(j?.positions)
    ? j.positions.filter(p => p && p.market === 'FUTURES' && p.mode === 'live' && (p.status === 'OPEN' || p.status === 'UNKNOWN'))
    : [];

  const byPairJournal = new Map(openLiveJournal.map(p => [String(p.pair || '').toUpperCase(), p]));
  const activeOut = [];
  const activePairs = new Set();

  if (Array.isArray(exchPositions)) {
    for (const ex of exchPositions) {
      const pair = String(ex.pair || '').toUpperCase();
      const sym = pair.replace(/^B-/, '').replace(/_USDT$/i, '');
      const jPos = byPairJournal.get(pair) || null;
      // v21.25.0 [ACTIVEPOS AUTHORITY]: sign wins over journal side; conflict
      // is surfaced (never silently ignored). Zero/NaN sign + missing journal
      // side = direction blocked, not LONG.
      const posSide = resolveActivePosSide({ activePos: ex.activePos, side: jPos?.side });
      const side = posSide.side;
      const directionBlocked = !side;
      const entry = Number(ex.avgPrice) || Number(ex.markPrice) || Number(jPos?.entryPrice) || 0;
      const qty = Math.abs(Number(ex.activePos) || 0);
      const isLong = side === 'LONG';
      const sl = Number(ex.sl) > 0
        ? Number(ex.sl)
        : (Number(jPos?.sl) > 0 ? Number(jPos.sl) : (directionBlocked ? 0 : pRound(isLong ? entry * 0.988 : entry * 1.012)));
      const risk = Math.max(entry * 0.004, Math.abs(entry - sl));
      const tp1 = Number(jPos?.tp) > 0 ? Number(jPos.tp) : (directionBlocked ? 0 : pRound(isLong ? entry + 1.25 * risk : entry - 1.25 * risk));
      const tp2 = Number(ex.tp) > 0
        ? Number(ex.tp)
        : (Number(jPos?.tp2) > 0 ? Number(jPos.tp2) : (directionBlocked ? 0 : pRound(isLong ? entry + 2.4 * risk : entry - 2.4 * risk)));
      // v21.28.0 [F9]: exchange-provided SL is the ONLY protection truth.
      // `sl` above may be journal/synthesized when CoinDCX did not report one —
      // adoption must mark that row sync-pending, never "protected".
      const exSl = Number(ex.sl) > 0 ? Number(ex.sl) : null;

      // Arm exchange-native TP/SL if missing on CoinDCX so the active position is 100% protected
      if (!directionBlocked && ex.id && !(Number(ex.sl) > 0) && sl > 0) {
        createFuturesTpsl({ positionId: ex.id, stopLoss: sl, takeProfit: tp2 }).catch(() => {});
      }

      activePairs.add(pair);
      activeOut.push({
        id: ex.id || jPos?.id || null,
        positionId: ex.id || jPos?.exchangePositionId || jPos?.id || null,
        orderId: jPos?.exchangeOrderId || ex.id || null,
        pair,
        symbol: sym,
        side,
        directionBlocked,
        directionReason: posSide.reason,
        directionConflict: posSide.conflict,
        activePos: posSide.rawActivePos,
        qty,
        entry,
        ltp: Number(ex.markPrice) > 0 ? Number(ex.markPrice) : entry,
        leverage: Number(ex.leverage) || Number(jPos?.leverage) || 10,
        stopLoss: sl,
        exchangeSl: exSl,
        slSource: exSl != null ? 'exchange' : (Number(jPos?.sl) > 0 ? 'journal' : 'synthesized'),
        t1: tp1,
        t2: tp2,
        openedAt: jPos?.openedAt || ex.updatedAt || now,
      });
    }
    // Preserve recently opened (<120s) live journal positions while CoinDCX indexes `/positions`
    for (const jPos of openLiveJournal) {
      const pair = String(jPos.pair || '').toUpperCase();
      if (activePairs.has(pair)) continue;
      const ageMs = now - (Number(jPos.openedAt) || 0);
      const exchRow = Array.isArray(allExchRows) ? allExchRows.find(p => String(p.pair || '').toUpperCase() === pair) : null;
      if (ageMs < 120_000 || !exchRow) {
        const sym = jPos.symbol || pair.replace(/^B-/, '').replace(/_USDT$/i, '');
        const posSide = resolveActivePosSide({ activePos: jPos.activePos ?? exchRow?.activePos, side: jPos.side });
        activePairs.add(pair);
        activeOut.push({
          id: jPos.id,
          positionId: jPos.exchangePositionId || jPos.id,
          orderId: jPos.exchangeOrderId || jPos.id,
          pair,
          symbol: sym,
          side: posSide.side,
          directionBlocked: !posSide.side,
          directionReason: posSide.reason,
          directionConflict: posSide.conflict,
          activePos: posSide.rawActivePos,
          qty: Math.abs(Number(jPos.qty) || 0),
          entry: Number(jPos.entryPrice) || 0,
          ltp: Number(jPos.entryPrice) || 0,
          leverage: Number(jPos.leverage) || 10,
          stopLoss: Number(jPos.sl) || 0,
          exchangeSl: Number(exchRow?.sl) > 0 ? Number(exchRow.sl) : null,
          slSource: Number(exchRow?.sl) > 0 ? 'exchange' : (Number(jPos.sl) > 0 ? 'journal' : 'synthesized'),
          t1: Number(jPos.tp) || 0,
          t2: Number(jPos.tp2) || 0,
          openedAt: jPos.openedAt || now,
        });
      }
    }
  } else {
    for (const jPos of openLiveJournal) {
      const pair = String(jPos.pair || '').toUpperCase();
      const sym = jPos.symbol || pair.replace(/^B-/, '').replace(/_USDT$/i, '');
      const posSide = resolveActivePosSide({ activePos: jPos.activePos, side: jPos.side });
      activeOut.push({
        id: jPos.id,
        positionId: jPos.exchangePositionId || jPos.id,
        orderId: jPos.exchangeOrderId || jPos.id,
        pair,
        symbol: sym,
        side: posSide.side,
        directionBlocked: !posSide.side,
        directionReason: posSide.reason,
        directionConflict: posSide.conflict,
        activePos: posSide.rawActivePos,
        qty: Math.abs(Number(jPos.qty) || 0),
        entry: Number(jPos.entryPrice) || 0,
        ltp: Number(jPos.entryPrice) || 0,
        leverage: Number(jPos.leverage) || 10,
        stopLoss: Number(jPos.sl) || 0,
        exchangeSl: null,
        slSource: Number(jPos.sl) > 0 ? 'journal' : 'synthesized',
        t1: Number(jPos.tp) || 0,
        t2: Number(jPos.tp2) || 0,
        openedAt: jPos.openedAt || now,
      });
    }
  }

  const value = {
    ok: true,
    authoritativeExchangeList: Array.isArray(exchPositions),
    positions: activeOut,
  };
  _activePosCtrlCache = { at: now, value };
  return value;
}

/** v21.28.0 [F5 SL READ-BACK MATCH — PURE]: exchange SL trigger ko
 *  requested SL se compare karta hai. Tolerance 0.05% default (tick-size
 *  rounding); invalid/0 actual = match nahi. */
export function slReadBackMatches({ actualSl, expectedSl, tolerancePct = 0.0005 } = {}) {
  const actual = Number(actualSl);
  const expected = Number(expectedSl);
  const tolPct = Number(tolerancePct);
  if (!(actual > 0) || !(expected > 0)) return false;
  const tol = Math.max(Math.abs(expected) * (Number.isFinite(tolPct) && tolPct >= 0 ? tolPct : 0.0005), 1e-12);
  return Math.abs(actual - expected) <= tol;
}

/** Best-effort exchange read-back. Create accepted hone ke baad 2-3 reads
 *  (exchange propagation lag). Koi order DOBARA nahi bhejta — sirf truth
 *  padhta hai, isliye retry se TP/SL stack nahi hota. */
async function _readBackCoinDcxSl({ positionId, pair, expectedSl, attempts = [0, 350, 900] } = {}) {
  let lastActual = null;
  let lastError = null;
  for (const wait of attempts) {
    if (Number(wait) > 0) await _sleep(Number(wait));
    let list;
    try {
      list = await listFuturesPositions();
    } catch (e) {
      lastError = `read-back list failed: ${String(e?.message || e).slice(0, 120)}`;
      continue;
    }
    const row = (positionId && list.find((p) => String(p.id) === String(positionId)))
      || (pair && list.find((p) => p.pair === pair && Number(p.activePos) !== 0));
    if (!row) {
      lastError = 'exchange position not found during SL read-back';
      continue;
    }
    const actual = Number(row.sl) || 0;
    lastActual = actual > 0 ? actual : null;
    if (!(actual > 0)) {
      lastError = 'exchange reports no SL trigger on the position';
      continue;
    }
    if (slReadBackMatches({ actualSl: actual, expectedSl })) {
      return { verified: true, actualSl: actual, error: null };
    }
    lastError = `exchange SL ${actual} != requested ${expectedSl}`;
  }
  return { verified: false, actualSl: lastActual, error: lastError || 'SL read-back unavailable' };
}

/**
 * Updates/trails the Stop-Loss (and TP) of an active CoinDCX Futures position
 * on the exchange (`createFuturesTpsl`) and syncs `trade-journal.json`.
 *
 * v21.28.0 [F5 — JOURNAL-FIRST FIX + READ-BACK]:
 *   Pehle journal naya SL likh deta tha aur exchange push ka sirf HTTP verdict
 *   dekha jata tha. Ab:
 *     1. exchange push (create_tpsl) pehle
 *     2. accepted hone par position list se actual SL read-back (2-3 attempts)
 *     3. journal SIRF accepted push ke baad update — SL ko "armed" claim
 *        tabhi karta hai jab read-back match kare; warna verified:false +
 *        protectionState UNVERIFIED/PROTECTION_MISSING.
 *   `create_tpsl` replace-vs-stack behaviour CoinDCX par [VERIFY-LIVE] hai
 *   (small size test). Isliye read-back retry kabhi naya order nahi bhejta.
 */
export async function updateCoinDcxPositionSl({ positionId, symbol, pair, stopLoss, takeProfit } = {}) {
  const sl = pRound(Number(stopLoss));
  const tp = Number(takeProfit) > 0 ? pRound(Number(takeProfit)) : null;
  if (!(sl > 0)) return { ok: false, error: 'invalid stopLoss' };

  const normPair = pair
    ? String(pair).toUpperCase()
    : symbol
      ? `B-${String(symbol).toUpperCase().replace(/USDT$/i, '')}_USDT`
      : null;

  const j = loadJournalFresh();
  const findJournalPos = (jj) => (Array.isArray(jj?.positions)
    ? jj.positions.find(p =>
      (p.status === 'OPEN' || p.status === 'UNKNOWN') && (
        (positionId && (p.id === positionId || p.exchangePositionId === positionId))
        || (normPair && p.pair === normPair)
      ))
    : null);
  const jPos = findJournalPos(j);

  let exchPosId = positionId || jPos?.exchangePositionId || null;
  if (!exchPosId && normPair && loadCredsForOrder()) {
    const exchList = await listFuturesPositions().catch(() => []);
    const row = exchList.find(p => p.pair === normPair && p.activePos !== 0);
    if (row?.id) exchPosId = row.id;
  }

  const writeJournal = async ({ verified, actualSl, protectionState, error }) => {
    if (!jPos) return;
    try {
      await withJournalLock(async () => {
        const jj = loadJournalFresh();
        const jp = findJournalPos(jj);
        if (!jp) return;
        jp.sl = sl;
        if (exchPosId && !jp.exchangePositionId) jp.exchangePositionId = String(exchPosId);
        jp.exchangeSlVerified = verified === true;
        jp.exchangeSlReadBack = Number(actualSl) || null;
        jp.exchangeSlReadBackAt = Date.now();
        jp.slProtectionState = protectionState || (verified ? 'PROTECTED' : 'UNVERIFIED');
        if (error) jp.slProtectionError = String(error).slice(0, 180);
        else delete jp.slProtectionError;
        saveJournalFresh(jj);
      });
    } catch { /* best-effort journal update */ }
  };

  // No exchange id / creds → journal-only. Honest ok:false (pehle ok:true
  // 15s tick ko lastExchangeSl stamp karne deta tha — silent dead SL).
  if (!exchPosId || !loadCredsForOrder()) {
    await writeJournal({ verified: false, protectionState: 'UNVERIFIED', error: 'exchange position id not resolvable' });
    return { ok: false, synced: false, journalOnly: true, verified: false, protectionState: 'UNVERIFIED', positionId: exchPosId, stopLoss: sl, error: 'exchange position id not resolvable — journal updated only' };
  }

  let usedId = exchPosId;
  let res = await createFuturesTpsl({ positionId: usedId, stopLoss: sl, takeProfit: tp })
    .catch(e => ({ ok: false, error: String(e?.message || e) }));

  // v21.23.10 [UUID-RESCUE]: entry-time position-id poll miss ho jaye to
  // caller internal journal UUID pass karta hai — pair-based re-resolve +
  // retry (warna LIVE SL sync us position ke liye hamesha dead).
  if (!res?.ok && normPair && String(exchPosId) !== String(jPos?.exchangePositionId || '')) {
    const exchList = await listFuturesPositions().catch(() => []);
    const row = exchList.find(p => p.pair === normPair && p.activePos !== 0);
    if (row?.id && String(row.id) !== String(exchPosId)) {
      usedId = String(row.id);
      res = await createFuturesTpsl({ positionId: usedId, stopLoss: sl, takeProfit: tp })
        .catch(e => ({ ok: false, error: String(e?.message || e) }));
      exchPosId = usedId;
    }
  }

  if (!res?.ok) {
    // Exchange rejection = protection NOT re-armed. Journal ka purana SL
    // hi sach hai — naya SL journal me mat likho.
    return {
      ok: false,
      accepted: false,
      verified: false,
      protectionState: 'PROTECTION_PUSH_FAILED',
      positionId: usedId,
      stopLoss: sl,
      error: res?.error || 'exchange TP/SL update rejected',
    };
  }

  const readBack = await _readBackCoinDcxSl({ positionId: usedId, pair: normPair, expectedSl: sl });
  const protectionState = readBack.verified ? 'PROTECTED' : 'UNVERIFIED';
  await writeJournal({
    verified: readBack.verified,
    actualSl: readBack.actualSl,
    protectionState,
    error: readBack.verified ? null : readBack.error,
  });

  return {
    ok: readBack.verified,
    accepted: true,
    verified: readBack.verified,
    protectionState,
    positionId: usedId,
    stopLoss: sl,
    exchangeSl: readBack.actualSl,
    readBackError: readBack.error || null,
    retryAfterMs: readBack.verified ? 0 : 60_000,
    error: readBack.verified ? null : `SL push accepted but read-back unverified: ${readBack.error}`,
  };
}

/**
 * Closes an active CoinDCX Futures position under Full Control (when TP2,
 * Trailed SL, or Bullish/Bearish Reversal Profit-Book triggers).
 */
export async function closeCoinDcxActivePosition({ positionId, symbol, pair } = {}) {
  _activePosCtrlCache = null;
  const normPair = pair
    ? String(pair).toUpperCase()
    : symbol
      ? `B-${String(symbol).toUpperCase().replace(/USDT$/i, '')}_USDT`
      : null;

  // v21.29.0 [R1]: resting-order hygiene BEFORE the exit — a stale limit
  // order on the same pair must not survive/re-fill after a close.
  const orderHygiene = normPair
    ? await runOrderHygieneForPair({ pair: normPair }).catch(e => ({ ok: false, error: String(e?.message || e) }))
    : { ok: true, skipped: true };

  const j = loadJournalFresh();
  const jPos = Array.isArray(j?.positions)
    ? j.positions.find(p =>
      (p.status === 'OPEN' || p.status === 'UNKNOWN') && (
        (positionId && (p.id === positionId || p.exchangePositionId === positionId))
        || (normPair && p.pair === normPair)
      ))
    : null;

  if (jPos) {
    const res = await closeFuturesPosition(jPos.id).catch(() => null);
    if (res?.ok) return { ...res, orderHygiene };
  }

  // Direct CoinDCX position exit fallback (for positions opened directly on CoinDCX or adopted by exchange id)
  let exchPosId = positionId || jPos?.exchangePositionId || null;
  if (!exchPosId && normPair && loadCredsForOrder()) {
    const exchList = await listFuturesPositions().catch(() => []);
    const row = exchList.find(p => p.pair === normPair && p.activePos !== 0);
    if (row?.id) exchPosId = row.id;
  }
  if (exchPosId && loadCredsForOrder()) {
    const out1 = await exitFuturesPosition(exchPosId).catch(e => ({ ok: false, error: String(e?.message || e) }));
    // v21.23.10 [UUID-RESCUE]: internal-UUID id fail ho to pair-based
    // re-resolve + EK retry (SL-sync twin fix — warna ye position kabhi
    // engine se close nahi hoti, sirf native SL bachata).
    if (!out1?.ok && normPair && String(exchPosId) !== String(jPos?.exchangePositionId || '')) {
      const exchList = await listFuturesPositions().catch(() => []);
      const row = exchList.find(p => p.pair === normPair && p.activePos !== 0);
      if (row?.id && String(row.id) !== String(exchPosId)) {
        return exitFuturesPosition(row.id)
          .then(r => ({ ...r, orderHygiene }))
          .catch(e => ({ ok: false, error: String(e?.message || e), orderHygiene }));
      }
    }
    return { ...out1, orderHygiene };
  }
  return { ok: false, error: 'Active CoinDCX position not found', orderHygiene };
}

// ============================================================
// v21.29.0 [R2 FLATTEN-ALL]
// ------------------------------------------------------------
// Emergency "close every open futures position". Design rules:
//   • Typed confirmation is mandatory — no accidental one-click flatten.
//   • Every close is an independent verdict; one failure never hides behind
//     a blanket ok:true.
//   • Resting-order hygiene runs BEFORE each close (via closeCoinDcxActive-
//     Position). Position-attached native TP/SL cleanup is [VERIFY-LIVE]:
//     not assumed, reported as unverified.
//   • A post-close re-read decides `flat`; if the list cannot be re-read,
//     `flat` is null (unknown), never a fabricated true.
// ============================================================
export const FLATTEN_ALL_PHRASE = 'FLATTEN ALL';

export async function flattenAllFuturesPositions({ confirm = '', deps = null } = {}) {
  const typed = String(confirm ?? '').trim().toUpperCase();
  if (typed !== FLATTEN_ALL_PHRASE) {
    return {
      ok: false, blocked: true, reason: 'confirm-required', requested: 0,
      closed: [], failed: [], flat: null,
      error: `typed "${FLATTEN_ALL_PHRASE}" confirmation required — got "${String(confirm ?? '').slice(0, 40)}"`,
    };
  }
  const list = deps?.listPositions || listFuturesPositions;
  const closeOne = deps?.closePosition || closeCoinDcxActivePosition;
  let rows;
  try {
    rows = await list();
  } catch (e) {
    return {
      ok: false, phase: 'list', requested: 0, closed: [], failed: [], flat: null,
      error: `futures position list failed: ${String(e?.message || e).slice(0, 160)}`,
    };
  }
  const open = (Array.isArray(rows) ? rows : [])
    .filter(p => p && p.id && Number(p.activePos) !== 0);
  if (open.length === 0) {
    return {
      ok: true, requested: 0, closed: [], failed: [], flat: true,
      note: 'no open futures positions — nothing to flatten',
    };
  }
  const closed = [];
  const failed = [];
  for (const p of open) {
    const qty = Math.abs(Number(p.activePos) || 0);
    const row = {
      positionId: String(p.id), pair: p.pair || null,
      side: Number(p.activePos) > 0 ? 'LONG' : 'SHORT', qty,
    };
    const r = await Promise.resolve(closeOne({ positionId: row.positionId, pair: p.pair || null }))
      .catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (r?.ok) {
      closed.push({ ...row, orderHygiene: r.orderHygiene || null });
    } else {
      failed.push({
        ...row, error: String(r?.error || 'close rejected'),
        orderHygiene: r?.orderHygiene || null,
      });
    }
  }
  // Re-read truth. A failed re-read leaves `flat` unknown.
  let remaining = null;
  try {
    const after = await list();
    remaining = (Array.isArray(after) ? after : []).filter(p => p && p.id && Number(p.activePos) !== 0).length;
  } catch { /* remaining stays null */ }
  const flat = remaining === null ? null : remaining === 0;
  return {
    // Verified-flat only. A failed post-read is NOT success.
    ok: failed.length === 0 && flat === true,
    requested: open.length,
    closed,
    failed,
    remaining,
    flat,
    tpSlCleanup: 'unverified [VERIFY-LIVE] — position-attached native TP/SL auto-cancel is not assumed',
    note: flat === false
      ? `${remaining} position(s) still open after flatten — manual exchange check required`
      : (flat === null
        ? 'closes attempted; post-close position re-read failed — verify flat manually'
        : 'all futures positions flat'),
  };
}

// ---------------- journal helpers (same files as coindcxOrders) ----------------
const JOURNAL_FILE = 'ai-trading-journal.json';
const MAX_JOURNAL = 500;
const CLOSED_POSITION_TTL = 90 * 24 * 3600_000; // v7.0.2: closed positions pruned after 90d
function loadJournalFresh() {
  return loadJSON(JOURNAL_FILE, { entries: [], positions: [] });
}
// v7.0.2: futures writes now prune like the spot desk — saveJournalFresh
// previously capped NOTHING, so TRAIL/WATCH_ERROR entries and every closed
// position grew the file forever (multi-MB reloads on every route hit).
function saveJournalFresh(j) {
  if (Array.isArray(j.entries) && j.entries.length > MAX_JOURNAL) {
    j.entries = j.entries.slice(-MAX_JOURNAL);
  }
  if (Array.isArray(j.positions)) {
    const cutoff = Date.now() - CLOSED_POSITION_TTL;
    const keep = j.positions.filter(p => p.status !== 'CLOSED' || (p.closedAt || p.openedAt || 0) >= cutoff);
    if (keep.length !== j.positions.length) j.positions = keep;
  }
  try { durablePut(JOURNAL_FILE, j); } catch { /* best-effort */ }
  saveJSON(JOURNAL_FILE, j);
  return j;
}

// ---------------- FUTURES POSITION WATCHER ----------------
/**
 * Runs under the journal lock every 60s (routes.js interval):
 *   • LIVE reconcile: the exchange position list is truth — if the
 *     exchange closed the position (native TP/SL, app close, liq),
 *     ours closes with an honest reason. avg/trigger prices approximate
 *     the exit (CoinDCX doesn't expose the fill price here).
 *   • SL / TP2 / trailing / liquidation on the RT futures price
 *     (paper closes simulated, live exits via /positions/exit).
 *   • watch errors persist — a dead stop never looks healthy.
 */
export async function watchFuturesPositions({ sendTelegram, getDeepSignal } = {}) {
  return withJournalLock(async () => {
    const j = loadJournalFresh();
    const closures = [];
    const watchErrors = [];
    let dirty = false;
    const cfg = await import('./coindcxOrders.js').then(m => m.loadConfig());
    const pro = loadProTraderConfig(); // v7.0 partial-TP settings

    // v12.8 SUPERINTELLIGENCE REVERSAL RECOVERY — ₹ loss-cap cut →
    // stop-and-reverse → ₹ target booking (opt-in; guards inside
    // reversalEngine.js). Deps injected → zero import cycles.
    const rev = await import('./reversalEngine.js');
    const revCfg = rev.loadReversalConfig();
    // v20.9.4 [H1]: listFuturesPositions bhi inject — openReversalLeg ab
    // real POSITION id (row.id) resolve karta hai, order id nahi.
    const revDeps = { exitFuturesPosition, createFuturesOrder, createFuturesTpsl, roundFuturesQty, coindcxConnected, listFuturesPositions };
    const revCtxBase = { cfg: revCfg, getDeepSignal, deps: revDeps, sendTelegram };

    let openFut = j.positions.filter(p => p.market === 'FUTURES' && (p.status === 'OPEN' || p.status === 'UNKNOWN')
      // v20.9.3 FIX (M): PM-owned exec positions (protectionFirstEntry) —
      // the PositionManager 15m ladder manages these (boot-hydrated from
      // these same rows). Skip while the exec stack is armed so T1/T2/trail
      // don't double-fire (PM reduce + watcher close = double exit); if the
      // stack failed to arm, the watcher adopts them (protection never drops).
      && !(p.execManaged && globalThis.__positionManager));
    if (openFut.length === 0) {
      // v12.8: waiting windows STILL need their pass when flat (the last
      // leg closed — re-entry window is exactly the interesting part).
      // Prices are 20s-cached → this flat-pass is free.
      if (revCfg.enabled) {
        try {
          const prices0 = await fetchFuturesPrices().catch(() => null);
          const byPair0 = new Map((prices0 || []).map(p => [p.pair, p.last]));
          const rr = await rev.processReversalWaiting(j, byPair0, revCtxBase);
          if (rr?.dirty) saveJournalFresh(j);
        } catch { /* non-fatal */ }
      }
      return closures;
    }

    const prices = await fetchFuturesPrices({
      // v20.8.5: TP1/TP2 partial-booking + SL decisions ≤5s-old prices pe
      // chalte hain (default 20s cache ek hit ko 20-80s late detect kar
      // sakta tha — "profit book late ho raha hai" ka latency hissa).
      // Public REST + single-flight — har watcher pass max 1 fresh fetch.
      maxAgeMs: 5_000,
    }).catch(() => null);
    const byPair = new Map((prices || []).map(p => [p.pair, p.last]));
    // v12.8: the reversal pass needs INR twins — resolve once per pass
    // (10-min cached) so loss-cap ₹ math is consistent within the sweep.
    const revCtx = revCfg.enabled ? { ...revCtxBase, usdInr: await fetchUsdInr().catch(() => 84) } : null;

    // --- LIVE reconcile against the exchange's own position list ---
    if (coindcxConnected() && openFut.some(p => p.mode === 'live')) {
      const exch = await listFuturesPositions().catch(() => null);
      if (exch) {
        const byExchPair = new Map(exch.map(p => [p.pair, p]));
        for (const p of openFut.filter(x => x.mode === 'live')) {
          if (cfg.killSwitch) break;
          const row = byExchPair.get(p.pair);
          if (!row) continue; // pair absent this page — retry next pass
          if (row.activePos !== 0) {
            // v7.0.2 CRITICAL FIX: adopt the exchange position id when the
            // entry-time polls missed it (fill latency). Without the id NO
            // exit path can reach the exchange — the position would be
            // "closed" on paper only while real margin bleeds with no stop.
            if (!p.exchangePositionId && row.id) {
              p.exchangePositionId = row.id;
              dirty = true;
              pushEntry(j, {
                kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
                reason: `exchange position id adopted late (${row.id}) — exit paths now armed`,
              });
            }
            // v21.1.1 [audit B5]: protection-missing position (entry-time id
            // miss / tpsl+flatten dono fail / ambiguous UNKNOWN row jo
            // reconcile ne adopt ki) — ab id hai, har pass native TP/SL
            // arm karne ki koshish. Arm ho jaaye → flag clear + journal;
            // fail → agle pass phir (30s server watcher hi backstop hai,
            // native SL lagne ke baad server so bhi jaaye to chalega).
            if (p.protectionMissing && p.exchangePositionId) {
              const slArm = Number(p.sl) > 0 ? Number(p.sl) : null;
              const tpArm = Number(p.tp2) > 0 ? Number(p.tp2) : (Number(p.tp) > 0 ? Number(p.tp) : null);
              const arm = await createFuturesTpsl({ positionId: p.exchangePositionId, stopLoss: slArm, takeProfit: tpArm })
                .catch(e => ({ ok: false, error: String(e?.message || e) }));
              if (arm?.ok) {
                delete p.protectionMissing;
                dirty = true;
                pushEntry(j, {
                  kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
                  reason: `RECOVERY: native TP/SL armed late by watcher (SL ${slArm} · TP ${tpArm}) — protectionMissing cleared`,
                });
                try { await sendTelegram(`🤖 ✅ <b>FUTURES RECOVERY</b> — ${p.pair}: native TP/SL watcher ne late-arm kar diya (SL ${slArm} · TP ${tpArm}). Server-resident stop ab active.`); } catch { /* best-effort */ }
              }
            }
            // still open — refresh the exchange's own numbers.
            // v7.0: partial legs shrink activePos — sync our qty to the
            // exchange's truth (a native/app partial close shows up here)
            if (row.avgPrice > 0 && row.avgPrice !== p.entryPrice) { p.entryPrice = row.avgPrice; dirty = true; }
            if (row.liquidationPrice > 0 && row.liquidation !== row.liquidationPrice) { p.liquidation = row.liquidationPrice; p.liquidationSource = 'exchange'; dirty = true; }
            if (Math.abs(row.activePos) > 0 && Math.abs(row.activePos) !== Number(p.qty)) {
              // v7.0 comment claimed app/native partial closes sync here,
              // but the old `(p.tp1Hit || p.tp2Hit)` guard required OUR OWN
              // stamps — an external partial close never synced, leaving
              // book qty stale for every P&L/daily-cap computation until
              // full close. v20.3: sync on ANY divergence.
              pushEntry(j, {
                kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
                reason: `partial-sync: exchange qty ${Math.abs(row.activePos)} vs book ${p.qty} — syncing (native/app partial close)`,
              });
              p.qty = Math.abs(row.activePos);
              dirty = true;
            }
            continue;
          }
          // exchange says flat → it closed out from under us (native TP/SL
          // or app close). Exit price ≈ the trigger level we armed.
          const long = p.side === 'LONG';
          let exitPrice = null, reason = 'Exchange closed (reconciled)';
          const ltp = byPair.get(p.pair);
          // v21.29.0 [R1]: the exchange closed the position (native SL/TP or
          // app) — sweep any resting orders for the pair so they cannot
          // re-open a position the engine believes is flat.
          const orderHygiene = await runOrderHygieneForPair({ pair: p.pair }).catch(e => ({ ok: false, error: String(e?.message || e) }));
          if (orderHygiene && orderHygiene.ok !== true && orderHygiene.unsupported !== true) {
            pushEntry(j, {
              kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
              reason: `order hygiene after exchange close: ${String(orderHygiene.error || 'cancel failed').slice(0, 160)}`,
            });
          }
          if (row.sl != null && row.sl > 0) { exitPrice = row.sl; reason = 'Exchange SL (native)'; }
          else if (row.tp != null && row.tp > 0) { exitPrice = row.tp; reason = 'Exchange TP (native)'; }
          else if (ltp > 0) { exitPrice = ltp; reason = 'Exchange closed (app/manual)'; }
          const usdInr = await fetchUsdInr();
          const pnlUSDT = exitPrice != null ? (long ? exitPrice - p.entryPrice : p.entryPrice - exitPrice) * p.qty : 0;
          p.status = 'CLOSED'; p.closedAt = Date.now();
          if (exitPrice != null) p.closePrice = exitPrice;
          p.pnlUSDT = r2(pnlUSDT);
          p.pnlINR = inrOfUsdt(pnlUSDT, usdInr);
          p.closeReason = reason;
          try { settlePositionOutcome(p, reason); } catch { /* best-effort */ }
          dirty = true;
          pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'FUTURES', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: exitPrice, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR, reason });
          closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason });
        }
      }
    }

    openFut = j.positions.filter(p => p.market === 'FUTURES' && p.status === 'OPEN');

    // v10.6 CROSS-EXCHANGE VALIDATION (Pro Upgrade #3): perp prices are
    // natively USDT → compared 1:1 against Binance perps (no conversion).
    // A fresh cross-venue gap skips all liq/trailing/SL/TP checks for
    // that base this pass; a reverted wick lands in the journal; a
    // sustained gap is accepted (real move).
    const _futWick = new Map(); // base → verdict|null
    for (const p of openFut) {
      const base = String(p.pair || '').replace(/^B-/, '').replace(/_USDT$/, '');
      if (!base || _futWick.has(base)) continue;
      _futWick.set(base, await validateTick({ market: 'FUTURES', base, price: byPair.get(p.pair) }).catch(() => null));
    }
    for (const [base, wv] of _futWick.entries()) {
      if (wv?.episode === 'wick') {
        const entry = wickJournalEntry({ market: 'FUTURES', base, pair: `B-${base}_USDT`, verdict: wv });
        entry.day = todayIST();
        pushEntry(j, entry);
        dirty = true;
      }
    }

    for (const p of openFut) {
      // v21.22.0: MTF Dual Board live positions are controlled exclusively by the 15s MTF Auto-Trade
      // Deep Monitor (`mtfAutoLink.js`), preventing competing legacy watchers / reversalEngine from
      // prematurely closing live MTF positions.
      if (p.mode === 'live' && String(p.source || '').startsWith('mtf-')) continue;
      const price = byPair.get(p.pair);
      if (!(price > 0)) continue;
      const _wv = _futWick.get(String(p.pair || '').replace(/^B-/, '').replace(/_USDT$/, ''));
      if (_wv?.action === 'SUPPRESS') continue; // fresh bad print — no action this pass
      const long = p.side === 'LONG';

      // liquidation estimate first (paper sim + live backstop)
      if (p.leverage > 1 && p.liquidation != null && p.liquidation > 0) {
        if (long ? price <= p.liquidation : price >= p.liquidation) {
          let closed = false;
          if (p.mode === 'live' && p.exchangePositionId && coindcxConnected()) {
            try {
              const xr = await exitFuturesPosition(p.exchangePositionId);
              // v20.9.1 [H1]: 200-wrapped rejection throw NAHI karta — {ok:false}
              // verdict check kiye bina closed=true fake LIQUIDATION close book
              // hota tha jabki exchange position khuli reh jati thi.
              if (!xr?.ok) throw new Error(xr?.error || 'wrapped rejection (200 body me error)');
              closed = true;
            }
            catch (e) {
              pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `futures liq exit failed: ${String(e?.message || e).slice(0, 160)}` });
              dirty = true; watchErrors.push({ pair: p.pair, reason: String(e?.message || e).slice(0, 120) });
            }
          } else if (p.mode !== 'live') {
            closed = true; // paper liquidation always executes
          } else {
            // v7.0.2 CRITICAL FIX: LIVE without id/creds used to be
            // paper-simulated closed — orphaning the real exchange
            // position. Persist + retry instead; the reconcile pass will
            // adopt the id or close it honestly when the exchange reports flat.
            pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `LIVE liq-exit BLOCKED (no exchange position id / CoinDCX disconnected) — NOT paper-closing, will retry` });
            dirty = true; watchErrors.push({ pair: p.pair, reason: 'live liq-exit blocked (no id/creds) — retrying' });
          }
          if (closed) {
            const usdInr = await fetchUsdInr();
            const liq = p.liquidation;
            const pnlUSDT = (long ? liq - p.entryPrice : p.entryPrice - liq) * p.qty;
            p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = liq;
            p.pnlUSDT = r2(pnlUSDT); p.pnlINR = inrOfUsdt(pnlUSDT, usdInr);
            p.closeReason = 'LIQUIDATED (est.)';
            try { settlePositionOutcome(p, 'LIQUIDATED (est.)'); } catch { /* best-effort */ }
            dirty = true;
            pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'FUTURES', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: liq, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR, reason: 'LIQUIDATED (est. — price crossed the liquidation level)' });
            closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: 'LIQUIDATED (est.)' });
          }
          continue;
        }
      }

      // v12.8 SUPERINTELLIGENCE REVERSAL RECOVERY — ₹-denominated loss-cap
      // cut + stop-and-reverse + ₹ profit booking. Runs BEFORE trail/SL/TP
      // (the ₹ thresholds ARE the position's discipline when enabled; the
      // stamped price SL/TP below stays as redundant second guard). The
      // engine sends its own Telegram — closures array untouched (no
      // double push), LIVE honesty per v7.0.2 inside closeLeg().
      if (revCtx && (p.status === 'OPEN' || p.status === 'UNKNOWN')) {
        try {
          const rres = await rev.evaluateReversalForPosition(j, p, price, revCtx);
          if (rres?.dirty) dirty = true;
          if (rres?.closed) {
            console.log(`[ai] reversal: ${rres.closed.pair} leg cut — ${rres.closed.reason} → ₹${rres.closed.pnlINR}${rres.opened ? ` · FLIP leg-${rres.opened.reversal?.leg} ${rres.opened.side}` : ''}`);
          }
        } catch (e) {
          pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `reversal pass error: ${String(e?.message || e).slice(0, 160)}` });
          dirty = true;
        }
        if (p.status !== 'OPEN' && p.status !== 'UNKNOWN') continue;
      }

      // trailing SL (USDT domain, same ratchet math)
      if (cfg.trailEnabled && p.sl != null && p.sl > 0) {
        const prevPeak = Number(p.peakPrice);
        const peak = long
          ? Math.max(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price)
          : Math.min(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price);
        p.peakPrice = pRound(peak);
        const risk = Number(p.initialRisk) > 0 ? Number(p.initialRisk) : Math.abs(p.entryPrice - p.sl);
        if (risk > 0) {
          const trail = computeTrailSl({ side: p.side, entryPrice: p.entryPrice, peakPrice: peak, currentSl: p.sl, initialRisk: risk, price, armR: cfg.trailArmR, offsetR: cfg.trailOffsetR });
          if (trail) {
            pushEntry(j, { kind: 'TRAIL', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `SL ${trail.stage}: ${p.sl} → ${trail.sl} (peak ${pRound(peak)})`, from: p.sl, to: trail.sl });
            p.sl = trail.sl; p.trailing = trail.stage;
            // LIVE: nudge the native stop too (ratchet-only on the exchange)
            if (p.mode === 'live' && p.exchangePositionId && coindcxConnected()) {
              try { await createFuturesTpsl({ positionId: p.exchangePositionId, stopLoss: trail.sl }); } catch { /* watcher remains the guard */ }
            }
          }
        }
        dirty = true;
      }

      // v7.0 PRO TRADER — 3-tier partial take-profit (agent-sourced
      // positions): T1 → close pct% + SL → breakeven; T2 → close pct% +
      // SL → T1; runner trails until time-exit/SL. LIVE legs go through
      // partialFuturesExit (opposite-side market order — /positions/exit
      // is full-exit only) and nudge the native stop to the locked level.
      if (pro.partialTpEnabled && p.source === 'agent' && !p.partialTpOff) {
        const t1 = Number(p.tp) > 0 ? Number(p.tp) : null;
        const t2 = Number(p.tp2) > 0 ? Number(p.tp2) : null;
        const hit = (lvl) => lvl != null && (long ? price >= lvl : price <= lvl);
        const partialNotes = [];

        // T1 leg
        // v20.3: a PARTIAL-RETRY hold (ambiguous transport error on the
        // previous attempt — the market order MAY have filled) blocks the
        // gate, else the 60s watcher would re-send the SAME market order
        // and shrink the book again (the spot desk's v18.9 double-sell
        // fix, ported to futures).
        if (!p.tp1Hit && hit(t1) && !(p.partialRetryAfter && Date.now() < p.partialRetryAfter)) {
          const leg = await partialCloseFuturesLeg(j, p, price, { stage: 'T1', pct: pro.tp1ClosePct });
          if (leg.ok) {
            if (pro.breakEvenAfterTp1 && p.status !== 'CLOSED') {
              const prevSl = p.sl;
              p.sl = ratchetSl(p.side, p.sl, feeBreakevenFloor({ entry: p.entryPrice, side: p.side, market: 'FUTURES' }) || p.entryPrice);
              if (prevSl !== p.sl) {
                pushEntry(j, { kind: 'TRAIL', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `BREAKEVEN LOCK (T1 hit): SL ${pRound(prevSl)} → ${pRound(p.sl)} — runner risk-free`, from: prevSl, to: p.sl });
                if (p.mode === 'live' && p.exchangePositionId && coindcxConnected()) {
                  try { await createFuturesTpsl({ positionId: p.exchangePositionId, stopLoss: p.sl }); } catch { /* watcher remains the guard */ }
                }
              }
            }
            partialNotes.push(`T1 ${leg.closedQty} @ ${pRound(price)} → +₹${r2(leg.legPnlINR)}`);
          } else {
            pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `T1 futures partial failed: ${String(leg.error || '').slice(0, 160)}` });
            watchErrors.push({ pair: p.pair, reason: `T1 partial failed: ${String(leg.error || '').slice(0, 120)}` });
          }
          dirty = true;
        }

        // T2 leg (same pass when price gapped past both)
        if (p.tp1Hit && !p.tp2Hit && hit(t2) && p.status === 'OPEN' && !(p.partialRetryAfter && Date.now() < p.partialRetryAfter)) {
          const leg = await partialCloseFuturesLeg(j, p, price, { stage: 'T2', pct: pro.tp2ClosePct });
          if (leg.ok) {
            if (t1 != null && p.status !== 'CLOSED') {
              const prevSl = p.sl;
              p.sl = ratchetSl(p.side, p.sl, t1);
              if (prevSl !== p.sl) {
                pushEntry(j, { kind: 'TRAIL', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `PROFIT LOCK (T2 hit): SL ${pRound(prevSl)} → T1 ${pRound(p.sl)}`, from: prevSl, to: p.sl });
                if (p.mode === 'live' && p.exchangePositionId && coindcxConnected()) {
                  try { await createFuturesTpsl({ positionId: p.exchangePositionId, stopLoss: p.sl }); } catch { /* watcher remains the guard */ }
                }
              }
            }
            partialNotes.push(`T2 ${leg.closedQty} @ ${pRound(price)} → +₹${r2(leg.legPnlINR)}`);
          } else {
            pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `T2 futures partial failed: ${String(leg.error || '').slice(0, 160)}` });
            watchErrors.push({ pair: p.pair, reason: `T2 partial failed: ${String(leg.error || '').slice(0, 120)}` });
          }
          dirty = true;
        }

        if (partialNotes.length > 0) {
          closures.push({ pair: p.pair, mode: p.mode, pnlINR: null, partial: true, reason: `PARTIAL TP — ${partialNotes.join(' · ')}` });
        }
        if (p.status !== 'OPEN') continue; // partials closed the whole book
      }

      let close = null;
      if (p.sl != null && (long ? price <= p.sl : price >= p.sl)) close = { reason: 'STOP-LOSS hit', price, kind: 'SL' };
      else if (p.tp2 != null && !p.tp2Hit && (long ? price >= p.tp2 : price <= p.tp2)) close = { reason: 'TARGET-2 hit', price, kind: 'TP2' };
      if (!close) continue;

      let closed = false;
      if (p.mode === 'live' && p.exchangePositionId && coindcxConnected()) {
        try {
          const xr = await exitFuturesPosition(p.exchangePositionId);
          // v20.9.1 [H1]: wrapped rejection (HTTP 200 + {code,message} body)
          // resolve hota hai, throw nahi — verdict ignore karke closed=true
          // banana = fake CLOSE + fabricated PnL + real position unmonitored.
          if (!xr?.ok) throw new Error(xr?.error || 'wrapped rejection (200 body me error)');
          closed = true;
        }
        catch (e) {
          pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `futures exit failed: ${String(e?.message || e).slice(0, 160)}` });
          dirty = true; watchErrors.push({ pair: p.pair, reason: String(e?.message || e).slice(0, 120) });
          continue;
        }
      } else if (p.mode !== 'live') {
        closed = true; // paper close is always executable
      } else {
        // v7.0.2 CRITICAL FIX: never paper-simulate a LIVE close. The real
        // leveraged position stays open on the exchange — persist + retry.
        pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `LIVE ${close.kind} exit BLOCKED (no exchange position id / CoinDCX disconnected) — NOT paper-closing, will retry` });
        dirty = true; watchErrors.push({ pair: p.pair, reason: `live ${close.kind} exit blocked (no id/creds) — retrying` });
        continue;
      }
      if (!closed) continue;

      const usdInr = await fetchUsdInr();
      const pnlUSDT = (long ? price - p.entryPrice : p.entryPrice - price) * p.qty;
      p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = price;
      p.pnlUSDT = r2(pnlUSDT); p.pnlINR = inrOfUsdt(pnlUSDT, usdInr);
      p.closeReason = close.reason;
      try { settlePositionOutcome(p, close.reason); } catch { /* best-effort */ }
      dirty = true;
      pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'FUTURES', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: price, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR, reason: close.reason });
      closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: close.reason });
    }

    // v12.8 REVERSAL: waiting windows — confirmed re-entry legs open
    // here, expired windows END the cycle (both journal-persisted).
    if (revCfg.enabled) {
      try {
        const rr = await rev.processReversalWaiting(j, byPair, revCtx);
        if (rr?.dirty) dirty = true;
      } catch (e) {
        pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), market: 'FUTURES', reason: `reversal waiting pass error: ${String(e?.message || e).slice(0, 160)}` });
        dirty = true;
      }
    }

    if (dirty) saveJournalFresh(j);
    if (typeof sendTelegram === 'function' && (closures.length > 0 || watchErrors.length > 0)) {
      try {
        // v21.1.1 [audit B10]: watch-error lines 30-min per-pair throttle —
        // persistent failures (dust, bad keys, no-id) pehle HAR 30s pass pe
        // repeat hote the → channel mute. Closures (real events) always send.
        const nowMs = Date.now();
        const freshErrs = watchErrors.filter(w => {
          const key = `${w.pair}::${String(w.reason).split('(')[0].slice(0, 60)}`;
          const last = _futWatchErrAlerts.get(key) || 0;
          if (nowMs - last < 30 * 60_000) return false;
          _futWatchErrAlerts.set(key, nowMs);
          return true;
        });
        if (_futWatchErrAlerts.size > 200) {
          for (const k of _futWatchErrAlerts.keys()) { _futWatchErrAlerts.delete(k); if (_futWatchErrAlerts.size <= 100) break; }
        }
        const fullClosures = closures.filter(c => !c.partial);
        const partialClosures = closures.filter(c => c.partial);
        const lines = [
          ...fullClosures.map(c => `• ${c.pair} (${c.mode}) — ${c.reason}: ₹${c.pnlINR > 0 ? '+' : ''}${c.pnlINR}`),
          ...partialClosures.map(c => `💰 ${c.reason}`),
          ...freshErrs.map(c => `⚠️ ${c.pair} — ${c.reason}`),
        ];
        if (lines.length > 0) {
          await sendTelegram(`🤖 <b>AI Trading · Futures</b>\n${lines.join('\n')}`);
        }
      } catch { /* best-effort */ }
    }
    return closures;
  });
}

// ---------------- v7.0 PRO TRADER: partial close leg (futures desk) ----------------
/**
 * Books ONE partial take-profit leg on an agent FUTURES position (USDT
 * domain, INR twin at the live USDINR):
 *   • qty = pct% of the ORIGINAL entry qty (frozen at the first leg)
 *   • LIVE: partialFuturesExit → OPPOSITE-side market order for the
 *     fraction (positions/exit is full-exit only; the exchange nets
 *     the opposite order against the open position)
 *   • PAPER: simulated (always executable)
 *   • journals a PARTIAL_TP entry + stamps the tamper-evident ledger leg
 *   • edge cases identical to the spot desk: qty rounds to 0 → partials
 *     disabled for the position; remaining rounds to 0 → full book
 *     closes as the final leg.
 * Returns { ok, closedQty, legPnlINR, legPnlUSDT?, error?, disabled? }.
 */
async function partialCloseFuturesLeg(j, p, price, { stage, pct }) {
  try {
    const long = p.side === 'LONG';
    const originalQty = Number(p.originalQty) > 0 ? Number(p.originalQty) : Number(p.qty);
    // v20.9.1 [H3]: reconcile/manual-partial ne p.qty shrink ki ho to ORIGINAL
    // ka pct dobara bhejna over-close karta — opposite-side residual position
    // khul jati. Cap: pct% of original, par CURRENT qty se zyada kabhi nahi.
    let partialQty = roundFuturesQty(p.pair, Math.min((originalQty * pct) / 100, Number(p.qty)));

    // too small to slice at instrument precision → tiered exits off
    if (!(partialQty > 0)) {
      p.partialTpOff = true;
      pushEntry(j, {
        kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
        reason: `partial TP disabled for this position — ${pct}% of ${originalQty} rounds to 0 at ${p.pair} precision (classic full TP2 exit applies)`,
      });
      return { ok: false, disabled: true, error: 'qty rounds to 0' };
    }
    // v21.1.1 [audit B12]: exchange-minimum guard (spot desk ka v18.9 fix
    // port — wahan hai, yahan nahi tha). Below-minQty opposite-side order
    // exchange reject karta hai → leg fail → WATCH_ERROR + telegram HAR
    // 30s pass pe, tier exits kabhi execute nahi hote. Ab: below-min →
    // partialTpOff + ek baar honest note (full TP2 exit bacha hai).
    if (p.mode === 'live') {
      try {
        const meta = await fetchFuturesInstrumentMeta(p.pair);
        if (meta?.minQty > 0 && partialQty < meta.minQty) {
          p.partialTpOff = true;
          pushEntry(j, {
            kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
            reason: `partial TP disabled — ${stage} leg qty ${partialQty} below the futures minimum ${meta.minQty} for ${p.pair} (full TP2 exit applies)`,
          });
          return { ok: false, disabled: true, error: `qty ${partialQty} below futures minimum ${meta.minQty}` };
        }
      } catch { /* meta unavailable — precision guard upar already covers */ }
    }

    // LIVE: move the fraction on the exchange BEFORE booking anything
    let execQty = partialQty;
    if (p.mode === 'live') {
      if (!coindcxConnected()) {
        // v20.9.1 [H2]: LIVE + disconnected pe paper-book KABHI NAHI — leg
        // book hua to journal/PnL/daily-cap jhooth bolte jabki exchange
        // position untouched hai (file ka apna "never paper-simulate a LIVE
        // close" discipline hi partial path pe toota tha).
        pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `LIVE ${stage} partial BLOCKED (CoinDCX disconnected) — NOT paper-booking the leg, will retry` });
        return { ok: false, error: 'LIVE partial blocked (no CoinDCX connection) — retrying next pass' };
      }
      // v21.28.0 [F3 SAFE-REDUCE]: pre-read side/flat/qty guard + exchange
      // post-read. Raw opposite-order path side mismatch par position ko
      // ULTA badha sakta tha; ab capped qty hi book hoti hai.
      const xr = await safeReduceFuturesPosition({
        positionId: p.exchangePositionId,
        pair: p.pair,
        qty: partialQty,
        side: p.side,
        leverage: p.leverage,
      });
      if (xr?.ambiguous) {
        p.partialRetryAfter = Date.now() + 5 * 60_000;
        pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `${stage} safe-reduce AMBIGUOUS (${String(xr?.error || xr?.warning || 'post-read failed').slice(0, 120)}) — 5 min retry hold (double-reduce guard)` });
        return { ok: false, error: String(xr?.error || xr?.warning || 'ambiguous reduce') };
      }
      // v20.9.1 [H1-class]: 200-wrapped rejection ({orderId:null,error})
      // resolve hota hai, throw nahi — verdict ignore karke leg book karna
      // = phantom T1 latch + BE-lock + bookedPnl jabki exchange unchanged.
      if (!xr?.ok || !xr?.orderId) {
        return { ok: false, error: `safe-reduce ${stage} partial failed: ${String(xr?.error || 'no order id').slice(0, 160)}` };
      }
      execQty = Number(xr.requestedQty) > 0 ? Number(xr.requestedQty) : partialQty;
      if (xr.verified === false) {
        pushEntry(j, {
          kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
          reason: `${stage} reduce order ${xr.orderId} accepted but exchange qty UNVERIFIED (${String(xr.warning || '').slice(0, 150)}) — leg booked on order id, reconcile required before retry`,
        });
      }
    }
    partialQty = execQty;

    // ---- book the leg (USDT domain + INR twin) ----
    const usdInr = await fetchUsdInr();
    const legPnlUSDT = (long ? price - p.entryPrice : p.entryPrice - price) * partialQty;
    const legPnlINR = inrOfUsdt(legPnlUSDT, usdInr);
    p.originalQty = originalQty;
    // remaining qty rounds at the INSTRUMENT precision (r2 would eat
    // sub-0.01 runners alive: 0.006 → 0.01)
    p.qty = roundFuturesQty(p.pair, Number(p.qty) - partialQty);
    p.bookedPnlUSDT = r2((Number(p.bookedPnlUSDT) || 0) + legPnlUSDT);
    p.bookedPnlINR = r2((Number(p.bookedPnlINR) || 0) + legPnlINR);
    if (stage === 'T1') p.tp1Hit = true;
    if (stage === 'T2') p.tp2Hit = true;
    p.exitStage = exitStageOf(p);

    // remaining book too small to keep? → this leg closes the position
    if (!(Number(p.qty) > 0)) {
      p.status = 'CLOSED';
      p.closedAt = Date.now();
      p.closePrice = price;
      p.pnlUSDT = 0; // fully realized via partial legs (bookedPnlUSDT carries it)
      p.pnlINR = 0;
      p.closeReason = `PARTIAL TP (${stage}) closed the full book`;
      try { settlePositionOutcome(p, p.closeReason); } catch { /* best-effort */ }
      pushEntry(j, {
        kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'FUTURES', mode: p.mode, source: p.source,
        qty: 0, entryPrice: p.entryPrice, closePrice: price, pnlUSDT: 0, pnlINR: 0,
        reason: `${stage} leg closed the full remaining book (qty too small to split)`,
      });
    }

    pushEntry(j, {
      kind: 'PARTIAL_TP', day: todayIST(), pair: p.pair, mode: p.mode, market: 'FUTURES',
      source: p.source, stage,
      qty: partialQty, price: r2(price), pnlUSDT: r2(legPnlUSDT), pnlINR: r2(legPnlINR),
      remainingQty: p.qty, bookedPnlINR: p.bookedPnlINR, exitStage: p.exitStage,
      reason: `${stage} partial: closed ${pct}% (${partialQty} of ${originalQty}) @ ${r2(price)} — booked ${r2(legPnlUSDT)} USDT / ₹${r2(legPnlINR)} · remaining ${p.qty}`,
    });
    try { markPartialOutcome(p.ledgerEntryId, { stage, qty: partialQty, price, pnlINR: legPnlINR }); } catch { /* best-effort */ }

    return { ok: true, closedQty: partialQty, legPnlINR: r2(legPnlINR), legPnlUSDT: r2(legPnlUSDT), remainingQty: p.qty };
  } catch (e) {
    // v20.3 AMBIGUOUS-RETRY GUARD: a timeout/abort/network failure on the
    // LIVE market order means the partial MAY have filled — re-sending it
    // every 60s would slice the book again (40% + 40% + …). Park the
    // partial gates for 5 minutes and let the 60s reconcile pass settle
    // the exchange's qty truth first (the exchange IS reachable between
    // hiccups; a definitive HTTP 4xx/5xx rejection is safe to retry).
    if (p.mode === 'live' && isAmbiguousTransportError(e)) {
      p.partialRetryAfter = Date.now() + 5 * 60_000;
      try {
        pushEntry(j, {
          kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES',
          reason: `partial ${stage} order AMBIGUOUS (${String(e?.message || e).slice(0, 120)}) — 5 min retry hold (double-sell guard; reconcile pass will sync exchange qty)`,
        });
      } catch { /* best-effort journal */ }
    }
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------- manual close ----------------
export async function closeFuturesPosition(positionId, reason = 'Manual close') {
  return withJournalLock(async () => {
    const j = loadJournalFresh();
    const p = j.positions.find(x => x.id === positionId || x.exchangePositionId === positionId);
    if (!p || (p.status !== 'OPEN' && p.status !== 'UNKNOWN')) return { ok: false, error: 'Position not found / already closed' };
    const prices = await fetchFuturesPrices().catch(() => null);
    const ltp = (prices || []).find(x => x.pair === p.pair)?.last;
    // v7.0.2: no live price → HONEST reject. The old `|| p.entryPrice`
    // booked a fake ₹0-P&L close for a trade that really moved money
    // (and silently understated the daily-loss cap).
    if (!(ltp > 0)) {
      return { ok: false, error: `No live futures price for ${p.pair} — thodi der baad try karo (honest close, no fake P&L)` };
    }
    // v7.0.2: LIVE without id/connection → reject honestly (reconciler
    // adopts the id on its next pass). Never book a paper close for it.
    if (p.mode === 'live' && (!p.exchangePositionId || !coindcxConnected())) {
      return { ok: false, error: 'LIVE position without exchange connection/id — reconcile ho raha hai, kuch second baad retry karo' };
    }
    let orderHygiene = null;
    if (p.mode === 'live' && p.exchangePositionId && coindcxConnected()) {
      // v21.29.0 [R1]: cancel resting orders before the exit (best-effort,
      // never blocks the close). Verdict is returned for the journal/UI.
      orderHygiene = await runOrderHygieneForPair({ pair: p.pair }).catch(e => ({ ok: false, error: String(e?.message || e) }));
      try {
        const xr = await exitFuturesPosition(p.exchangePositionId);
        // v20.9.1 [H1]: wrapped rejection pehle silently pass hota tha —
        // user ko {ok:true} milta tha jabki close hua hi nahi.
        if (!xr?.ok) return { ok: false, error: `Exchange close failed: ${xr?.error || 'wrapped rejection (200 body)'}` };
      }
      catch (e) { return { ok: false, error: `Exchange close failed: ${e?.message || e}` }; }
    }
    const long = p.side === 'LONG';
    const usdInr = await fetchUsdInr();
    const pnlUSDT = (long ? ltp - p.entryPrice : p.entryPrice - ltp) * p.qty;
    p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = ltp;
    p.pnlUSDT = r2(pnlUSDT); p.pnlINR = inrOfUsdt(pnlUSDT, usdInr);
    p.closeReason = reason;
    try { settlePositionOutcome(p, reason); } catch { /* best-effort */ }
    pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'FUTURES', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: ltp, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR, reason });
    saveJournalFresh(j);
    return { ok: true, position: p, ...(orderHygiene ? { orderHygiene } : {}) };
  });
}

// ---------------- futures markets view (UI) ----------------
/** Top futures markets by 24h volume + our universe rows first. */
export async function futuresMarketsView(limit = 24) {
  const rows = await fetchFuturesPrices().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: 'Futures market data unreachable right now', markets: [] };
  }
  const universeSet = new Set(FUTURES_UNIVERSE);
  const sorted = rows.slice().sort((a, b) => {
    const au = universeSet.has(a.base) ? 1 : 0, bu = universeSet.has(b.base) ? 1 : 0;
    if (au !== bu) return bu - au;
    return (b.volume || 0) - (a.volume || 0);
  }).slice(0, limit);
  return {
    ok: true, count: rows.length,
    markets: sorted.map(m => ({
      pair: m.pair, base: m.base, last: m.last, mark: m.mark, changePct: m.changePct,
      high: m.high, low: m.low, volumeUSDT: m.volume,
    })),
    fetchedAt: Date.now(),
  };
}

// ---------------- test hooks ----------------
export function __resetFuturesForTests() {
  _pricesCache = null; _pricesAt = 0; _pricesInflight = null;
  _synthDownUntil = 0; // v11.3: the Binance/Bybit synth negative cache
  _instrumentMetaCache = new Map();
  _walletsTransport.mode = null;
  _walletsTransport.coolUntil = 0;
  _walletsTransport.probesSinceSweep = 0; // v20.8.5: gap fix — counter file-wide accumulate hota tha, 10 pe forceSweep cooldown-bypass karke call-count locks todta tha
  _scopeProbe = null; // v12.2: the cached key-scope verdict
  _scopeProbeInflight = null;
  _walletLegBudgetMs = WALLET_LEG_BUDGET_MS;
  _usdInr = null; _usdInrAt = 0;
  _walletSnapCache = null; _walletSnapInflight = null; // v20.8.5: snapshot mini-cache
  _futWatchErrAlerts.clear(); // v21.1.1 [audit B10]
}
export function __setUsdInrForTests(v) { _usdInr = v; _usdInrAt = Date.now(); }
/** v10.14 test hook: shrink the wallet-leg deadline so budget tests run in ms. */
export function __setWalletLegBudgetForTests(ms) { _walletLegBudgetMs = Math.max(1, Number(ms) || WALLET_LEG_BUDGET_MS); }
/** v12.2 test hook: the wallet-transport probe state (sticky rung,
 *  cooldown armed?, last key-scope verdict) for reconnect-reset locks. */
export function __walletTransportStateForTests() {
  return {
    mode: _walletsTransport.mode,
    cooling: Date.now() < _walletsTransport.coolUntil,
    scopeVerdict: _scopeProbe?.verdict || null,
  };
}
export { inrOfUsdt };
