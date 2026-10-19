// ============================================================
// server/ai/mtf.js — v18.5 SUPER INTELLIGENCE MTF-6 ENGINE
// ------------------------------------------------------------
// Full 6-timeframe confluence analysis: 1m / 5m / 15m / 1h / 4h / 1d.
// Every timeframe gets its own candle fetch + indicator stack
// (EMA10/20/50, RSI, MACD, ADX, supertrend, ROC, volume) and a
// directional vote; the engine then computes:
//   • consensus (BULLISH / BEARISH / NEUTRAL)
//   • weighted alignment score  -100 … +100  (HTF heavier: 1d ×3.0)
//   • agreement ratio 0..1 (share of TF weight on the consensus side)
//   • phase: TREND-ALIGNED / MIXED / RANGE
//   • htfBias (1d+4h) and ltfTrigger (5m+1m) reads
//   • timing quality (LTF exhaustion gate for the entry)
//   • structureStop (15m swing beyond entry, ATR-buffered)
//
// Integration contract (used by signals.js board + deep paths):
//   buildMTFSnapshot(symbol, market, { side, ltp })
//     → snapshot | null (never throws; honest degrade when the
//       candle sources are unreachable or too thin)
//   mtfWire6Payload(snapshot)
//     → the compact badge payload (sig.mtf) for the frontend
//     MTFConfluenceBadge — carries all 6 TF chips + consensus.
//
// Cost discipline:
//   • crypto candles ride data.js's TTL cache (1m 90s / 5m 120s /
//     15m 3m / 1h+4h+1d 5m) with CoinDCX→Binance→Bybit fallback
//   • INDIA candles: Yahoo v8 chart with per-TF TTL (1m 90s / 5m 2m /
//     15m 2m / 1h 10m / 1d 30m; 4h resampled from 1h — zero extra call)
//   • snapshot-level cache 90s per (symbol, market, side)
//   • all 6 fetches fan out in parallel; a missing TF degrades to a
//     "N/A" chip and is excluded from the vote (never blocks the board)
// ============================================================
import { fetchCoinDcxCandles, fetchBinanceKlines } from './data.js';
import { fetchFuturesCandles, futuresPairFor } from './futures.js';
import { usdInrFallback } from './lib/usdinr.js';
import { computeIndicatorsFromCandles, atr as atrOf } from './lib/indicators.js';
// v21.23.5 CoinDCX Ultrafast WS candle overlay — the REST chain stays the
// series anchor (official OHLCV + volume); the live forming bar tracks
// the WS price books (~1s) instead of freezing for the REST TTL
// (15m=180s · 1h/4h/1d=300s · India Yahoo 15m=120s). See cxWsCandles.js
// for the live probe + domain-safety + zero-regression contract.
import { cxSpotOverlayCandles, indiaOverlayCandles, cxFutOverlayCandles } from './cxWsCandles.js';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TF_WEIGHT = { '1d': 3.0, '4h': 2.4, '1h': 1.8, '15m': 1.3, '5m': 1.0, '1m': 0.6 };

const SNAP_TTL_MS = 90_000;
const _snapCache = new Map(); // key → { at, snap }
const SNAP_CACHE_MAX = 96;
// v18.5 OFFLINE CIRCUIT BREAKER — when every candle source is down
// (user offline / firewalled), 6 failed fetches per symbol per cycle
// would add 8s+ of timeouts to EVERY board build. After 6 consecutive
// degraded snapshots the engine opens the circuit for 10 minutes and
// returns null instantly (the legacy 5m/15m/1h wire stays in charge).
// v18.6.4: breaker ab PER-(market,symbol) hai — pehle module-global
// streak tha, to 6 thin/delisted coins (ya ek Yahoo outage) SAARE
// markets ke liye 10-min blackout khol dete the. Global breaker sirf
// tab khulta hai jab 8+ DISTINCT symbols apne blackout me chale —
// wo asli user-offline outage hai.
const _mtfFailBySym = new Map(); // `${mkt}:${sym}` → { streak, at } (fresh degraded COMPUTES only)
const _mtfSkipBySym = new Map(); // `${mkt}:${sym}` → skip-until epoch
let _mtfSkipUntil = 0;
const MTF_FAIL_OPEN = 6;         // per-symbol: 6 fresh degraded computes → 10m blackout
const MTF_GLOBAL_DISTINCT = 8;   // distinct symbols failing ≥2x in 10m → global 10m (user-offline)
const MTF_FAIL_WIN_MS = 10 * 60_000;

/** v18.6.4 test hook — current breaker state. */
export function _mtfBreakerState() {
  return {
    globalSkipUntil: _mtfSkipUntil,
    symSkip: Object.fromEntries(_mtfSkipBySym),
    failStreaks: Object.fromEntries(_mtfFailBySym),
  };
}

/** Widespread-outage count: distinct symbols whose RECENT (10m) fresh
 *  computes failed ≥2 times. Thin coins (1-2 failures) never count. */
function _widespreadFailCount(now = Date.now()) {
  let n = 0;
  for (const e of _mtfFailBySym.values()) {
    if ((e?.streak || 0) >= 2 && now - (e?.at || 0) < MTF_FAIL_WIN_MS) n++;
  }
  return n;
}

// per-TF Yahoo TTLs (INDIA path)
const YF_TTL = { '1m': 90_000, '5m': 120_000, '15m': 120_000, '1h': 600_000, '4h': 600_000, '1d': 1_800_000 };
const _yfCache = new Map();
const YF_CACHE_MAX = 160;

const YF_TICKER_MINI = {
  NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
  SENSEX: '^BSESN', INDIAVIX: '^INDIAVIX', TATAMOTORS: 'TMPV.NS',
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (Number.isFinite(v) ? v : null);

// ------------------------------------------------------------
// Candle sources
// ------------------------------------------------------------
async function _yahooCandles(yh, interval, range) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yh)}?interval=${interval}&range=${range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI mtf6)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp;
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) return null;
    const rows = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open?.[i] == null || q.close?.[i] == null) continue;
      rows.push({
        time: ts[i] * 1000,
        open: q.open[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i],
        close: q.close[i], volume: q.volume?.[i] || 0,
      });
    }
    return rows.length >= 40 ? rows : null;
  } catch { return null; }
}

async function _indiaCandles(symbol, tf, market = 'INDIA') {
  const yh = market === 'GLOBALFUTURES'
    ? String(symbol || '').toUpperCase()
    : (YF_TICKER_MINI[symbol] || `${symbol}.NS`);
  const key = `yf:${market}:${symbol}:${tf}`;
  const hit = _yfCache.get(key);
  const ttl = YF_TTL[tf] || 120_000;
  // v21.23.5: the CACHE holds the RAW Yahoo series; the live-bar overlay
  // (Groww liveFeed print) is applied per-READ so the forming bar never
  // bakes a stale live close into the shared cache.
  if (hit && Date.now() - hit.at < ttl) return indiaOverlayCandles(symbol, tf, hit.payload);
  let out = null;
  if (tf === '4h') {
    // 4h resampled from the cached 1h series — zero extra Yahoo call
    const base = await _indiaCandles(symbol, '1h', market);
    out = base ? _resample(base, 240) : null;
  } else {
    const interval = tf === '1h' ? '60m' : tf;
    const range = tf === '1m' ? '5d' : (tf === '5m' || tf === '15m') ? '1mo' : tf === '1h' ? '3mo' : '2y';
    out = await _yahooCandles(yh, interval, range);
  }
  _yfCache.set(key, { at: Date.now(), payload: out });
  while (_yfCache.size > YF_CACHE_MAX) {
    const k = _yfCache.keys().next().value;
    if (k === undefined) break;
    _yfCache.delete(k);
  }
  return indiaOverlayCandles(symbol, tf, out);
}

/** Bucket candles into `minutes`-wide bars (open/high/low/close/volume). */
function _resample(candles, minutes) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const out = [];
  let bucket = null;
  const widthMs = minutes * 60_000;
  for (const c of candles) {
    const bt = Math.floor(Number(c.time) / widthMs) * widthMs;
    if (!bucket || bucket.time !== bt) {
      if (bucket) out.push(bucket);
      bucket = { time: bt, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume || 0;
    }
  }
  if (bucket) out.push(bucket);
  return out.length >= 30 ? out : null;
}

async function _candlesFor(symbol, market, tf) {
  try {
    if (market === 'CRYPTO' || market === 'FUTURES') {
      // strip only namespace markers (FUT_/GLOB_) — a leading "B" is part
      // of real tickers (BTC/BNB!) and must NEVER be eaten
      const base = String(symbol || '').toUpperCase().replace(/^(FUT_|GLOB_)/, '');
      // v18.5: the full chain the board uses — CoinDCX INR first, then
      // Binance/Bybit USDT klines (public, geo-robust). Per-TF VOTES are
      // scale-invariant (EMA/RSI/MACD/ADX are relative); the structure
      // stop converts itself via the close-ratio, so a USDT-sourced
      // candle set can still price an INR stop correctly.
      const c = await fetchCoinDcxCandles(base, tf, { noCache: false }).catch(() => null);
      // v21.23.5: CoinDCX leg ab ULTRAFAST — WS spot book ka live INR print
      // last bar pe overlay hota hai (candles official REST series hi rehte
      // hain). Binance USDT fallback pe overlay NAHI (cross-domain risk —
      // USDT candles ko INR tick kabhi nahi milega, v20.9.3 lesson).
      if (Array.isArray(c) && c.length >= 30) return cxSpotOverlayCandles(base, tf, c);
      return await fetchBinanceKlines(base, tf).catch(() => null);
    }
    if (market === 'GLOBALFUTURES') {
      // US equity perps (GLOB_ domain) — Yahoo equity series
      const sym = String(symbol || '').toUpperCase().replace(/^GLOB_/, '');
      return await _indiaCandles(sym, tf, 'GLOBALFUTURES');
    }
    return await _indiaCandles(symbol, tf, 'INDIA');
  } catch { return null; }
}

// ------------------------------------------------------------
// Per-TF vote
// ------------------------------------------------------------
function _tfVote(candles, tf) {
  const li = computeIndicatorsFromCandles(candles);
  if (!li) return null;
  const last = candles[candles.length - 1];
  const close = Number(last?.close) || li.ltp;
  let score = 0;
  const ema10 = num(li.ema10), ema20 = num(li.ema20), ema50 = num(li.ema50);
  // v21.19.0: when live close has crossed against EMA20, slow EMA20-vs-EMA50
  // stack lags the turn — reduce stack weight so broken structure does not
  // keep voting the stale direction.
  if (ema20 != null && ema50 != null) {
    const stackAlignedWithPrice = (ema20 > ema50 && close >= ema20) || (ema20 < ema50 && close <= ema20);
    const stackW = stackAlignedWithPrice ? 1.1 : 0.3;
    score += ema20 > ema50 ? stackW : ema20 < ema50 ? -stackW : 0;
  }
  if (ema10 != null) score += close > ema10 ? 0.7 : close < ema10 ? -0.7 : 0;
  if (ema20 != null) score += close > ema20 ? 0.8 : close < ema20 ? -0.8 : 0;
  if (ema50 != null) score += close > ema50 ? 0.5 : close < ema50 ? -0.5 : 0;
  const rsiV = num(li.rsi);
  if (rsiV != null) score += rsiV > 55 ? 0.8 : rsiV < 45 ? -0.8 : 0;
  const mac = li.macd && typeof li.macd === 'object' ? li.macd : null;
  const macSlope = mac && num(mac.histSlope) != null ? num(mac.histSlope) : 0;
  if (mac && num(mac.macd) != null && num(mac.signal) != null) {
    const macBull = mac.macd > mac.signal;
    const slopeAligned = (macBull && macSlope >= 0) || (!macBull && macSlope <= 0);
    const macW = slopeAligned ? 1.0 : 0.35;
    score += macBull ? macW : -macW;
  }
  const sup = li.supertrend && typeof li.supertrend === 'object' ? li.supertrend : null;
  if (sup && Number.isFinite(sup.direction)) score += sup.direction * 0.7;
  const rocV = num(li.roc);
  if (rocV != null) score += rocV > 0 ? 0.5 : rocV < 0 ? -0.5 : 0;
  const n = candles.length;
  const roc3 = n >= 4 && Number(candles[n - 4]?.close) > 0
    ? ((close - Number(candles[n - 4].close)) / Number(candles[n - 4].close)) * 100
    : 0;
  if (roc3 > 0.08) score += 0.7;
  else if (roc3 < -0.08) score -= 0.7;
  // v21.19.0 LIVE REVERSAL GUARD: if price has broken both EMA10 & EMA20 with
  // active 3-bar momentum and decelerating/opposing MACD, override lagging
  // Supertrend/EMA50 so an active dump never votes +1 (and an active pump never votes -1).
  const activeDump = ema10 != null && ema20 != null && close < ema10 && close < ema20 && roc3 < -0.08 && ((mac && num(mac.hist) < 0) || macSlope < 0);
  const activePump = ema10 != null && ema20 != null && close > ema10 && close > ema20 && roc3 > 0.08 && ((mac && num(mac.hist) > 0) || macSlope > 0);
  if (activeDump && score > -1.2) score = -1.6;
  if (activePump && score < 1.2) score = 1.6;
  const adxObj = li.adx && typeof li.adx === 'object' ? num(li.adx.adx) : null;
  const adxV = adxObj != null ? adxObj : num(li.adx);
  const trendAmp = adxV != null ? clamp(0.6 + adxV / 50, 0.6, 1.6) : 1.0; // strong trend scales the vote
  const scaled = clamp(score * trendAmp, -4.5, 4.5);
  const dir = scaled >= 0.9 ? 1 : scaled <= -0.9 ? -1 : 0;
  const strength = Math.round(clamp(Math.abs(scaled) / 4.5, 0, 1) * 100);
  const noteBits = [];
  if (ema20 != null && ema50 != null) noteBits.push(close >= ema20 && ema20 > ema50 ? 'EMA bull' : close <= ema20 && ema20 < ema50 ? 'EMA bear' : close >= ema20 ? 'EMA reclaim' : 'EMA break');
  if (rsiV != null) noteBits.push(`RSI ${Math.round(rsiV)}`);
  if (adxV != null) noteBits.push(`ADX ${Math.round(adxV)}`);
  if (mac && num(mac.hist) != null) noteBits.push(mac.hist > 0 ? 'MACD+' : 'MACD-');
  return {
    tf, dir, strength, conf: Math.max(20, strength),
    rsi: rsiV != null ? Math.round(rsiV * 10) / 10 : null,
    adx: adxV != null ? Math.round(adxV * 10) / 10 : null,
    ltp: close,
    note: noteBits.join(' · '),
  };
}

// ------------------------------------------------------------
// Structure stop (15m swings, ATR-buffered)
// ------------------------------------------------------------
function _structureStop(candles15m, side, ltp) {
  if (!Array.isArray(candles15m) || candles15m.length < 45) return null;
  const a = atrOf(candles15m, 14);
  if (a == null || !(a > 0)) return null;
  const lastClose = Number(candles15m[candles15m.length - 1].close);
  if (!(lastClose > 0)) return null;
  const lookback = candles15m.slice(-40);
  // v18.5 SCALE-SAFETY: all swing/ATR math runs in the candle's OWN
  // currency scale (CoinDCX INR or Binance USDT — the fetch chain picks
  // whichever answered). The stop is emitted in the LTP's scale: direct
  // when ltp matches the candle scale (within 5%), else converted via
  // the close-ratio so a USDT-sourced stop still prices an INR entry.
  const toLtp = (slLocal) => {
    if (ltp > 0) {
      if (Math.abs(ltp - lastClose) / lastClose < 0.05) {
        return { sl: Math.round(slLocal * 10000) / 10000, style: 'mtf-15m-swing', refTf: '15m', atr: a };
      }
      const ratio = slLocal / lastClose;
      return { sl: Math.round(ltp * ratio * 10000) / 10000, ratio: Math.round(ratio * 10000) / 10000, style: 'mtf-15m-swing', refTf: '15m', atr: a };
    }
    return { sl: Math.round(slLocal * 10000) / 10000, style: 'mtf-15m-swing', refTf: '15m', atr: a };
  };
  if (side === 'LONG') {
    let swing = null;
    for (let i = lookback.length - 2; i >= 1; i--) {
      const c = lookback[i], p = lookback[i - 1], n = lookback[i + 1];
      if (c.low < p.low && c.low < n.low) { swing = c.low; break; }
    }
    if (swing == null || swing >= lastClose) return null;
    const sl = Math.min(lastClose - 1.2 * a, swing - 0.25 * a);
    if (!(sl > 0) || sl >= lastClose) return null;
    return toLtp(sl);
  }
  let swing = null;
  for (let i = lookback.length - 2; i >= 1; i--) {
    const c = lookback[i], p = lookback[i - 1], n = lookback[i + 1];
    if (c.high > p.high && c.high > n.high) { swing = c.high; break; }
  }
  if (swing == null || swing <= lastClose) return null;
  const sl = Math.max(lastClose + 1.2 * a, swing + 0.25 * a);
  return toLtp(sl);
}

// ------------------------------------------------------------
// Snapshot
// ------------------------------------------------------------
export async function buildMTFSnapshot(symbol, market, opts = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const mkt = String(market || 'INDIA').toUpperCase();
  if (!sym) return null;
  const side = opts.side === 'SHORT' ? 'SHORT' : opts.side === 'LONG' ? 'LONG' : null;

  const key = `mtf6:${mkt}:${sym}:${side || '-'}`;
  const hit = _snapCache.get(key);
  if (hit && Date.now() - hit.at < SNAP_TTL_MS) return hit.payload;
  // v18.6.4: circuit — per-symbol blackout first, then the GLOBAL
  // breaker (only when many distinct symbols are dark = user offline).
  const symKey = `${mkt}:${sym}`;
  const now0 = Date.now();
  const symSkip = _mtfSkipBySym.get(symKey) || 0;
  if (now0 < symSkip || now0 < _mtfSkipUntil) return null;

  const jobs = TFS.map(async (tf) => {
    const candles = await _candlesFor(sym, mkt, tf);
    if (!candles) return { tf, dir: null, strength: 0, conf: 0, rsi: null, adx: null, note: 'no data' };
    return _tfVote(candles, tf);
  });
  const settled = await Promise.allSettled(jobs);
  // v18.6.4: a REJECTED job keeps its OWN timeframe — the old hardcoded
  // `tf:'1m'` placeholder used to OVERWRITE the real 1m vote when a
  // later TF (e.g. 1d) threw, silently killing the 1m timing leg.
  const votes = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { tf: TFS[i], dir: null, strength: 0, conf: 0, rsi: null, adx: null, note: 'error' })).filter(Boolean);
  const byTf = new Map(votes.map(v => [v.tf, v]));

  const voting = votes.filter(v => v.dir === 1 || v.dir === -1);
  const totalW = voting.reduce((acc, v) => acc + (TF_WEIGHT[v.tf] || 1), 0);
  if (voting.length < 2 || totalW <= 0) {
    const snapDegraded = {
      ok: false, symbol: sym, market: mkt, ts: Date.now(),
      timeframes: TFS.map(tf => byTf.get(tf) || { tf, dir: null, strength: 0, note: 'no data' }),
      consensus: 'NEUTRAL', alignment: 0, agreement: null, agreementPct: null,
      phase: 'UNAVAILABLE', htfBias: null, ltfTrigger: null,
      timing: { quality: 'N/A', note: 'insufficient timeframe data' },
      structureStop: null, alignedWithSide: null, side,
    };
    // cache the degraded read (a 90s negative cache stops per-cycle
    // re-fetch storms) + drive the PER-SYMBOL circuit breaker
    _snapCache.set(key, { at: Date.now(), payload: snapDegraded });
    while (_snapCache.size > SNAP_CACHE_MAX) {
      const k = _snapCache.keys().next().value;
      if (k === undefined) break;
      _snapCache.delete(k);
    }
    const prevFail = _mtfFailBySym.get(symKey);
    const streak = (prevFail?.streak || 0) + 1;
    _mtfFailBySym.set(symKey, { streak, at: Date.now() });
    if (streak >= MTF_FAIL_OPEN) {
      _mtfSkipBySym.set(symKey, Date.now() + 10 * 60_000);
      _mtfFailBySym.delete(symKey);
    }
    // GLOBAL breaker: only a WIDESPREAD outage (8+ distinct symbols,
    // each failed ≥2 times within 10m — cached reads don't count) —
    // a couple of thin coins must never blackout the whole board.
    if (_mtfSkipUntil < Date.now() && _widespreadFailCount() >= MTF_GLOBAL_DISTINCT) {
      _mtfSkipUntil = Date.now() + 10 * 60_000;
      _mtfSkipBySym.clear();
      _mtfFailBySym.clear();
    }
    return snapDegraded;
  }

  // weighted net score −1 … +1
  const net = clamp(voting.reduce((acc, v) => acc + v.dir * (TF_WEIGHT[v.tf] || 1) * (0.4 + 0.6 * (v.strength / 100)), 0) / totalW, -1, 1);
  const consensus = net >= 0.18 ? 'BULLISH' : net <= -0.18 ? 'BEARISH' : 'NEUTRAL';

  // agreement: the DOMINANT side's share of the voting weight — a 50/50
  // split reads ~0.5 (honest conflict), 3-of-4 aligned reads 0.75, all
  // aligned reads 1.0. (The earlier 1−spread formula read a balanced
  // conflict as ~0.9 "agreement" — exactly backwards.)
  const upW = voting.filter(v => v.dir === 1).reduce((acc, v) => acc + (TF_WEIGHT[v.tf] || 1), 0);
  const agreement = clamp(Math.max(upW, totalW - upW) / totalW, 0.5, 1);

  // phase bands (agreement floor is 0.5 by construction — dominant side):
  // ≥0.72 the weight sits on ONE side (trend), ≥0.55 lean, else split.
  const phase = agreement >= 0.72 ? 'TREND-ALIGNED' : agreement >= 0.55 ? 'MIXED' : 'SPLIT';

  const biasOf = (tfs) => {
    const vs = tfs.map(tf => byTf.get(tf)).filter(v => v && (v.dir === 1 || v.dir === -1));
    if (!vs.length) return null;
    const w = vs.reduce((acc, v) => acc + (TF_WEIGHT[v.tf] || 1), 0);
    const n = vs.reduce((acc, v) => acc + v.dir * (TF_WEIGHT[v.tf] || 1), 0) / w;
    return n >= 0.2 ? 'BULLISH' : n <= -0.2 ? 'BEARISH' : 'NEUTRAL';
  };
  const htfBias = biasOf(['1d', '4h']);
  const ltfTrigger = biasOf(['1m', '5m']);

  // timing gate: LTF exhaustion against the intended side
  let timing = { quality: 'GOOD', note: 'LTF healthy' };
  const r1m = byTf.get('1m')?.rsi ?? null;
  const r5m = byTf.get('5m')?.rsi ?? null;
  if (side === 'LONG') {
    if ((r1m != null && r1m > 78) || (r5m != null && r5m > 74)) timing = { quality: 'POOR', note: 'LTF overbought — pullback entry ka wait karo' };
    else if ((r1m != null && r1m > 68) || (r5m != null && r5m > 66)) timing = { quality: 'CAUTION', note: 'LTF warm — chhota pullback expect karo' };
  } else if (side === 'SHORT') {
    if ((r1m != null && r1m < 22) || (r5m != null && r5m < 26)) timing = { quality: 'POOR', note: 'LTF oversold — bounce risk, short mat pakdo' };
    else if ((r1m != null && r1m < 32) || (r5m != null && r5m < 34)) timing = { quality: 'CAUTION', note: 'LTF cool — bounce possible' };
  }

  let structureStop = null;
  if (side) {
    const ltp = Number(opts.ltp) > 0 ? Number(opts.ltp)
      : (() => { for (const tf of ['15m', '5m', '1h']) { const v = byTf.get(tf); if (v?.ltp > 0) return v.ltp; } return null; })();
    if (ltp) {
      const candles15m = await _candlesFor(sym, mkt, '15m');
      structureStop = _structureStop(candles15m, side, ltp);
    }
  }

  const alignedWithSide = side
    ? (side === 'LONG' ? consensus === 'BULLISH' : consensus === 'BEARISH')
    : null;
  const counterHtf = side && htfBias
    ? (side === 'LONG' ? htfBias === 'BEARISH' : htfBias === 'BULLISH')
    : null;

  const snap = {
    ok: true, symbol: sym, market: mkt, ts: Date.now(), side,
    timeframes: TFS.map(tf => {
      const v = byTf.get(tf);
      if (v) { const { tf: _t, note, ...rest } = v; return { tf, ...rest, note }; }
      return { tf, dir: null, strength: 0, conf: 0, rsi: null, adx: null, note: 'no data' };
    }),
    consensus, alignment: Math.round(net * 100), agreement,
    agreementPct: Math.round(agreement * 100), phase,
    htfBias, ltfTrigger, timing, structureStop,
    alignedWithSide, counterHtf,
  };

  _snapCache.set(key, { at: Date.now(), payload: snap });
  while (_snapCache.size > SNAP_CACHE_MAX) {
    const k = _snapCache.keys().next().value;
    if (k === undefined) break;
    _snapCache.delete(k);
  }
  _mtfFailBySym.delete(symKey); // v18.6.4: a real read closes THIS symbol's streak
  return snap;
}

/** Compact wire payload for the signal card's MTF badge (sig.mtf). */
export function mtfWire6Payload(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const chip = (tf) => {
    const v = (snap.timeframes || []).find(x => x.tf === tf);
    if (!v) return null;
    return { dir: v.dir == null ? 0 : v.dir, conf: v.conf ?? v.strength ?? 0 };
  };
  const legacy = {
    m5: chip('5m'), m15: chip('15m'), h1: chip('1h'),
    agreement: snap.agreement ?? null,
  };
  if (!snap.ok) return { ...legacy, engine: 'mtf6', available: false };
  return {
    ...legacy,
    engine: 'mtf6',
    available: true,
    tfs: (snap.timeframes || []).map(v => ({ tf: v.tf, dir: v.dir, conf: v.conf ?? v.strength ?? 0 })),
    consensus: snap.consensus,
    alignment: snap.alignment,
    agreementPct: snap.agreementPct,
    phase: snap.phase,
    htfBias: snap.htfBias,
    ltfTrigger: snap.ltfTrigger,
    timing: snap.timing ? { quality: snap.timing.quality, note: snap.timing.note } : null,
  };
}

/** Test hook — clear caches between hermetic suite cases. */
export function __clearMtfCaches() { _snapCache.clear(); _yfCache.clear(); _mtfFailBySym.clear(); _mtfSkipBySym.clear(); _mtfSkipUntil = 0; }
/** Test hook — run the per-TF vote on a candle set directly. */
export function __tfVote(candles, tf) { return _tfVote(candles, tf); }

// ------------------------------------------------------------
// v20.2 CHART CANDLES — the price chart endpoint's data source.
// The board/deep path already fetches these exact series for MTF-6;
// this wrapper trims to the last `bars` candles, and (like the
// structure-stop converter) rescales a fallback-sourced series onto
// the caller's LTP scale so entry/SL/target overlay lines land on
// the chart in the desk's native currency (INR spot / USDT futures).
// 60s response cache — the SAME chain MTF-6 uses, zero new upstreams.
// ------------------------------------------------------------
const CHART_TFS = new Set(['5m', '15m', '1h', '1d']);
const _chartCache = new Map();
const CHART_TTL_MS = 60_000;
const CHART_CACHE_MAX = 64;

export async function chartCandles(symbol, market, tf, opts = {}) {
  const mkt = String(market || 'INDIA').toUpperCase();
  const t = String(tf || '15m').toLowerCase();
  if (!CHART_TFS.has(t)) return { ok: false, error: 'tf must be one of 5m/15m/1h/1d' };
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym || sym.length > 16) return { ok: false, error: 'bad symbol' };
  const ltp = Number(opts.ltp);
  const bars = Math.min(180, Math.max(40, Number(opts.bars) || 96));

  const key = `${mkt}:${sym}:${t}:${bars}`;
  const hit = _chartCache.get(key);
  const now = Date.now();
  let base = hit && now - hit.at < CHART_TTL_MS ? hit.payload : null;
  let scale = null;
  if (!base) {
    base = await _candlesFor(sym, mkt, t);
    if (!Array.isArray(base) || base.length < 30) return { ok: false, error: 'candles unavailable (source down or thin symbol)' };
    base = base.slice(-bars);
    _chartCache.set(key, { at: now, payload: base });
    while (_chartCache.size > CHART_CACHE_MAX) {
      const k = _chartCache.keys().next().value;
      if (k === undefined) break;
      _chartCache.delete(k);
    }
  }

  // Scale conversion — same contract as _structureStop.toLtp(): when the
  // candle series' own currency differs from the desk's LTP (Binance USDT
  // fallback serving an INR desk, or vice versa), ratios convert prices.
  const lastClose = Number(base[base.length - 1].close) || 0;
  let candles = base;
  if (Number.isFinite(ltp) && ltp > 0 && lastClose > 0 && Math.abs(ltp - lastClose) / lastClose >= 0.05) {
    const ratio = ltp / lastClose;
    candles = base.map(c => ({
      time: c.time,
      open: +(c.open * ratio).toFixed(6),
      high: +(c.high * ratio).toFixed(6),
      low: +(c.low * ratio).toFixed(6),
      close: +(c.close * ratio).toFixed(6),
      volume: c.volume || 0,
    }));
    scale = { ratio: +ratio.toFixed(6), note: 'converted to desk LTP scale (fallback candle source)' };
  }

  return {
    ok: true, symbol: sym, market: mkt, tf: t, bars: candles.length,
    candles, scaled: scale, fetchedAt: now,
    tfMs: t === '5m' ? 300_000 : t === '15m' ? 900_000 : t === '1h' ? 3_600_000 : 86_400_000,
  };
}

/** v20.2 RAW candle access for the replay harness — the SAME cached
 *  chain (Yahoo INDIA / CoinDCX→Binance crypto), NO bar-count trim. */
export async function rawTfCandles(symbol, market, tf) {
  return await _candlesFor(String(symbol || '').toUpperCase(), String(market || 'INDIA').toUpperCase(), tf);
}

// ============================================================
// v21.17.0 — USDT-DOMAIN CANDLES (MTF Dual Board ka crypto pricing)
// ------------------------------------------------------------
// USER REPORT (verbatim): "MTF Signals Board me jo trading signals hai
// vo INR price me aa rahe hai, muje USDT me symbols ko price show hona
// hai."
//
// ROOT CAUSE: `_candlesFor` ka CRYPTO branch CoinDCX **INR** candles
// ko pehle try karta hai (MTF votes ke liye theek — EMA/RSI/MACD
// scale-invariant hote hain). Par MTF Dual Board usi candle set se
// PRICES (entry/SL/T1/T2) banata hai → India me CoinDCX reachable hai,
// to har crypto row ₹ me render hoti thi (BTC ₹95,00,000-class),
// jabki Superintelligence board aur USDT futures desk $ domain me.
//
// FIX: dual board ke liye ek alag USDT-first resolver —
//   Leg 1: Binance USDT klines (api.binance.com + data-api.binance.vision
//          keyless mirror — geo-robust, jaisa data.js ka chain use karta hai)
//   Leg 2: CoinDCX INR candles × (1/USDINR) — Binance down ho to bhi
//          prices USDT me hi dikhte hain (fx honest, usdInr.js se)
// Votes wahi rehte hain (scale-invariant), sirf PRICE DOMAIN badalta hai.
// ============================================================
const FUT_TF_RES = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': '1D' };

export async function rawTfCandlesUsdt(symbol, tf, opts = {}) {
  const base = String(symbol || '').toUpperCase().trim()
    .replace(/^(FUT_|GLOB_)/, '')
    .replace(/[-_](USDT|USDC|USD|INR)$/, '');
  if (!/^[A-Z0-9]{2,20}$/.test(base)) return null;
  // Leg 1 — v21.19.0 Native CoinDCX USDT Perpetual Futures candlesticks (B-<BASE>_USDT, pcode=f)
  try {
    const res = FUT_TF_RES[String(tf || '15m').toLowerCase()];
    if (res) {
      const fc = await fetchFuturesCandles(futuresPairFor(base), res, 240).catch(() => null);
      if (Array.isArray(fc) && fc.length >= 30) {
        // v21.23.5: futures WS book ka ~1s mark/last print live bar pe —
        // dual-board crypto rows ki 15m — D1 ladder tick-fresh.
        return { candles: cxFutOverlayCandles(base, tf, fc), ccy: 'USDT', src: 'coindcx-fut-usdt', fx: null, base };
      }
    }
  } catch { /* fall through */ }
  // Leg 2 — Binance/Bybit USDT (data.js chain: spot + keyless mirror + Bybit 200-bar cached)
  try {
    const bk = await fetchBinanceKlines(base, tf, { limit: 200, ...opts }).catch(() => null);
    if (Array.isArray(bk) && bk.length >= 30) {
      return { candles: bk, ccy: 'USDT', src: 'binance-usdt', fx: null, base };
    }
  } catch { /* fall through */ }
  // Leg 3 — CoinDCX INR scaled to USDT (usdInr.js last-known-good)
  try {
    const cdc = await fetchCoinDcxCandles(base, tf).catch(() => null);
    if (Array.isArray(cdc) && cdc.length >= 30) {
      const fx = Number(opts.fx) > 40 && Number(opts.fx) < 150 ? Number(opts.fx) : usdInrFallback();
      // v21.23.5: overlay INR domain me PEHLE (spot WS ka INR print), phir
      // ÷fx USDT scaling — tick/candle domain hamesha matched.
      const scaled = cxSpotOverlayCandles(base, tf, cdc).map(c => ({
        ...c,
        open: c.open / fx, high: c.high / fx, low: c.low / fx, close: c.close / fx,
        // volume ratio-invariant hai (indicators sirf relative use karte hain)
      }));
      return { candles: scaled, ccy: 'USDT', src: 'coindcx-inr-scaled', fx, base };
    }
  } catch { /* none */ }
  return null;
}

/** Pure helper (testable): scale an INR candle array into the USDT domain. */
export function scaleCandlesInrToUsdt(candles, fx) {
  const rate = Number(fx);
  if (!Array.isArray(candles) || !(rate > 40 && rate < 150)) return null;
  return candles.map(c => ({
    ...c,
    open: c.open / rate, high: c.high / rate, low: c.low / rate, close: c.close / rate,
  }));
}
