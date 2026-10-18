// ============================================================
// intraday/engine — NSE intraday dual-source quant engine (v4)
// ------------------------------------------------------------
// Scoring stack (per side, clamped 0..100):
//   EMA10/20 stack 20 | VWAP bias 19 | RSI zone 14 | Rel.Volume 12
//   MACD 12 | Pivot/CPR 10 | ADX 10 | ORB-15 8 | Gap 7 | Day-range 7
//   Supertrend-align 8 | Volume-POC 7 | SMA50 MTF confluence 10
//   minus: RSI exhaustion (x2), extreme-gap, wrong-side-of-ORB,
//   counter-regime (-10), VIX-HIGH (-6), dead-zone (-15) penalties
//
// 2026 v3 upgrades (pro-desk):
//   • ORB-15 factor — LIVE opening range while 09:15–09:45 is
//     forming, ATR-proxy band afterwards (honest label: PROXY).
//   • Slippage model — ±7bps per side on INR prices; quantity and
//     effective RR are computed on slip-adjusted risk.
//   • Market-regime penalty — counter-trend setups (vs NIFTY/VIX
//     regime) lose conviction instead of firing blind.
//
// 2026 v4 MEGA upgrades (dual-AI expert desk):
//   • Supertrend(7) alignment — ATR-trail proxy (no candle history
//     on daily OHLC — honest approximation, labelled proxy).
//   • Volume Profile POC premium — price near VWAP = value-area
//     acceptance (+7).
//   • Multi-timeframe EMA confluence — SMA50 with EMA10/20 stack
//     (+10) — higher-conviction trend alignment.
//   • Tighter RSI sweet zones: LONG 52-68, SHORT 32-48; exhaustion
//     penalty doubled (-12).
//   • Hard volume floor: known SESSION-PACE relVolume < 1.2x
//     disqualifies (2026-09 audit fix: TV's raw relVol is cumulative
//     vs FULL-DAY average — a flat floor nuked the whole market every
//     morning; pace = raw ÷ expected session share, post-close == raw).
//   • RR floor 1.5 for high-conviction (grade-A requirement).
//   • Dead zone 14:30–15:00 IST — statistically weak window,
//     hard-gated in routes + -15 in scoring.
//   • Signal GRADES: A+ / A / B (watch-only) via gradeSignal().
// ============================================================
import { istMinutes, marketPhaseFor, paceRelVolume } from './time.js';
// v11.1 GAP 2 — circuit-limit guard (pure helpers, no fetch)
import { entryCircuitRisk } from '../ai/circuitGuard.js';
// v21.13.0 — the pure chase/entry-timing guard (entryTiming.js has ZERO
// imports of its own — no cycle risk; same module the board's signalMemory
// chase guard runs, so both desks time entries by the SAME rules).
import {
  entryTimingRead,
  CHASE_HARD_CONF_CAP, CHASE_SOFT_CONF_PENALTY,
  QUALITY_EXTENDED_CONF_PENALTY,
} from '../ai/entryTiming.js';
import { TV_SCAN_HEADERS } from '../lib/tvHeaders.js';

export const INTRADAY_MIN_CONFIDENCE = 75;
export const INTRADAY_TOP_N = 5;
// Slippage assumption for liquid NSE F&O names: 7 basis points per side
// (entry fills worse + exit fills worse). Conservative but realistic for
// market-order fills on liquid large-caps.
export const SLIPPAGE_BPS = 7;
// Crypto spot INR pairs: spread + taker fee + impact — wider than the
// tight NSE F&O fills, so the R:R math stays honest on BTC/ETH signals.
export const CRYPTO_SLIPPAGE_BPS = 12;
// v4 quality gates
export const MIN_REL_VOLUME = 1.2;   // hard floor (only when relVolume is KNOWN)
export const HIGH_CONV_RR_FLOOR = 1.5; // grade-A minimum R:R
export const DEAD_ZONE_START = 14 * 60 + 30; // 14:30 IST
export const DEAD_ZONE_END = 15 * 60;        // 15:00 IST

export function inDeadZone(m = istMinutes()) {
  return m >= DEAD_ZONE_START && m < DEAD_ZONE_END;
}

export const BASE_UNIVERSE = [
  // NSE + BSE liquid F&O / high-volume names — deep liquidity + tight spreads.
  // Candles resolve via .NS first, .BO fallback (some names list on one exchange only).
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'BHARTIARTL',
  'ITC', 'LT', 'KOTAKBANK', 'AXISBANK', 'HINDUNILVR', 'BAJFINANCE', 'ASIANPAINT',
  'MARUTI', 'TITAN', 'SUNPHARMA', 'ULTRACEMCO', 'WIPRO', 'ONGC', 'NTPC',
  'POWERGRID', 'TATAMOTORS', 'TATASTEEL', 'JSWSTEEL', 'HCLTECH', 'TECHM',
  'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'GRASIM', 'HINDALCO', 'NESTLEIND',
  'CIPLA', 'DRREDDY', 'BRITANNIA', 'EICHERMOT', 'HEROMOTOCO', 'M&M',
  'INDUSINDBK', 'BPCL', 'IOC', 'DLF', 'VEDL', 'CANBK', 'PNB', 'BEL', 'HAL',
  // Extended NSE + BSE coverage (banks, PSUs, auto, pharma, infra, new-age)
  'BANKBARODA', 'UNIONBANK', 'FEDERALBNK', 'IDFCFIRSTB', 'AUBANK',
  'SBILIFE', 'HDFCLIFE', 'ICICIPRULI', 'SHRIRAMFIN', 'CHOLAFIN', 'BAJAJFINSV',
  'TATAPOWER', 'ADANIGREEN', 'ADANIPOWER', 'JIOFIN', 'LICI', 'IRFC',
  'TRENT', 'ZOMATO', 'NYKAA', 'POLICYBZR', 'PAYTM',
  'TATAELXSI', 'PERSISTENT', 'COFORGE', 'LTIM', 'MPHASIS',
  'PIDILITIND', 'HAVELLS', 'DIVISLAB', 'APOLLOHOSP', 'LUPIN', 'AUROPHARMA',
  'GAIL', 'PETRONET', 'IDEA', 'YESBANK', 'SUZLON', 'IREDA',
];

// 2026-09 multi-market pass — CRYPTO universe (CoinDCX INR pairs, TV crypto
// scanner indicators off BINANCE:SYM USDT). Liquid majors only: intraday
// signals need tight spreads + deep books; thin alts generate noise.
export const CRYPTO_UNIVERSE = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK', 'UNI', 'POL',
];

/** Is this bare symbol a crypto base (used to route quotes per market)?
 * v9 SUPERINTELLIGENCE: the crypto scan universe is DYNAMIC now (every
 * liquid CoinDCX INR pair by 24h turnover) — every scanned base is
 * registered here so paper trades / track records / the SSE stream keep
 * routing new coins to the CRYPTO side correctly (not INDIA).
 * v18.5: MATIC kept as a LEGACY base (the token migrated to POL, but
 * old persisted rows/paper trades still say MATIC — they must keep
 * routing to the crypto side, never to Groww). */
const _knownCryptoBases = new Set([...CRYPTO_UNIVERSE, 'MATIC']);
export function registerCryptoBases(list) {
  for (const b of (Array.isArray(list) ? list : [])) {
    const s = String(b || '').trim().toUpperCase();
    if (s) _knownCryptoBases.add(s);
  }
}
export function isCryptoSymbolBase(sym) {
  return _knownCryptoBases.has(String(sym || '').trim().toUpperCase());
}

// v21.13.0 MOMENTUM CAPTURE ENGINE v2: the columns are INTRADAY-RESOLUTION
//   now (live-verified on scanner.tradingview.com/india + /crypto):
//   `EMA10|15` = 15-minute EMA10, `SMA50|60` = 1-HOUR SMA50 (genuine HTF
//   confluence, not daily-vs-daily), `ATR|15` = 15m ATR (risk geometry —
//   stops/targets finally intraday-scaled for the 15:10 sq-off),
//   `ADX|15` = 15m trend strength (chop filter reads the REAL intraday
//   regime). Daily stays: OHLC/change (day-range/gap factors), VWAP
//   (session anchor), relVolume (session pace), monthly pivots
//   (Pivot.B.Classic.* returns null on TV — live-probed; .M. stays).
//   THE 90%-OPPOSITE DISEASE, LIVE-PROVEN 2026-10-14: RELIANCE daily RSI
//   41.8 (SHORT zone) while the 15m RSI was 83 (strong rally) — the old
//   engine voted YESTERDAY'S trend against TODAY's tape. Same for SMA50:
//   daily 1263 (bearish) vs SMA50|60 1181 (bullish). Order of this array
//   is POSITIONAL (d[0..23] parse below) — suffixes only, never reorder.
export const TV_INTRADAY_COLUMNS = [
  'close', 'open', 'high', 'low', 'volume', 'change',
  'EMA10|15', 'EMA20|15', 'SMA20|15', 'SMA50|60',
  'RSI|15', 'MACD.macd|15', 'MACD.signal|15',
  'ATR|15', 'VWAP',
  'ADX|15', 'ADX+DI|15', 'ADX-DI|15',
  'relative_volume_10d_calc',
  'Pivot.M.Classic.Middle', 'Pivot.M.Classic.S1', 'Pivot.M.Classic.R1',
  'Recommend.All|15', 'last',
];

// ------------------------------------------------------------
// Dual-source batch fetch: TradingView India Scanner (ONE request
// for all symbols with rich pre-computed indicators) + Groww NSE
// live quotes (genuine LTP). No Yahoo 5m candle dependency.
// Returns [tvData, growwData] — same shape the old monolith used.
//
// 2026-09 multi-market pass: opts.market='CRYPTO' switches the batch to
// TV *crypto* scanner (BINANCE:SYMUSDT indicators, USD) + CoinDCX INR
// LTP (injected fetchCoinDcxTickers — shared 2s cache with the live
// price stream). TV USD indicators are re-scaled into INR with the
// per-symbol anchor (coindcxINR / binanceUSDT) so the whole engine
// runs in ONE currency — INR — exactly like the NSE path.
// ------------------------------------------------------------
export async function fetchIntradayDataBatch(symbols, fetchGrowwNseQuote, opts = {}) {
  const market = String(opts.market || 'INDIA').toUpperCase();
  if (market === 'CRYPTO') {
    return fetchCryptoIntradayDataBatch(symbols, opts.fetchCoinDcxTickers, opts.fallbackCryptoPrices);
  }
  const tvTickers = [];
  const tvToClean = {};
  symbols.forEach(sym => {
    [`NSE:${sym}`, `BSE:${sym}`].forEach(t => {
      tvTickers.push(t);
      tvToClean[t] = sym;
    });
  });

  // v10.17: the tiered full-universe scan can hand this batch 100+
  // symbols (200+ tickers) — chunked at 100 tickers per request with
  // 2 sequential rounds max overlap, merged first-match-wins. Small
  // universes (legacy watchlist) still ride ONE request exactly like
  // before.
  const tvPromise = (async () => {
    const out = {};
    const unique = [...new Set(tvTickers)];
    if (unique.length === 0) return out;
    const CHUNK = 100;
    if (unique.length <= CHUNK) {
      Object.assign(out, await _tvScanRound(unique));
      return out;
    }
    const chunks = [];
    for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
    for (let i = 0; i < chunks.length; i += 2) {
      const group = chunks.slice(i, i + 2);
      const results = await Promise.allSettled(group.map(c => _tvScanRound(c)));
      results.forEach(r => { if (r.status === 'fulfilled') Object.assign(out, r.value); });
    }
    return out;
  })();

  async function _tvScanRound(tickers) {
    const out = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://scanner.tradingview.com/india/scan?t=${Date.now()}`, {
          method: 'POST',
          headers: TV_SCAN_HEADERS,
          body: JSON.stringify({
            symbols: { tickers: [...new Set(tickers)] },
            columns: TV_INTRADAY_COLUMNS,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          if (attempt < 2) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
          return out;
        }
        const data = await res.json();
        if (!data?.data) return out;
        for (const item of data.data) {
          if (!item.d) continue;
          const clean = tvToClean[item.s];
          if (!clean || out[clean]) continue; // first exchange that resolves wins
          const d = item.d;
          const pf = (v) => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : null;
          out[clean] = {
            close: pf(d[0]) || 0, open: pf(d[1]) || 0,
            high: pf(d[2]) || 0, low: pf(d[3]) || 0,
            volume: pf(d[4]) || 0, change: pf(d[5]) || 0,
            ema10: pf(d[6]), ema20: pf(d[7]),
            sma20: pf(d[8]), sma50: pf(d[9]),
            rsi: pf(d[10]), macd: pf(d[11]), macdSignal: pf(d[12]),
            atr: pf(d[13]), vwap: pf(d[14]),
            adx: pf(d[15]), adxPlus: pf(d[16]), adxMinus: pf(d[17]),
            relVolume: pf(d[18]),
            pivotMiddle: pf(d[19]), pivotS1: pf(d[20]), pivotR1: pf(d[21]),
            recommend: pf(d[22]), last: pf(d[23]),
            exchange: item.s.split(':')[0],
          };
        }
        break; // success — stop retrying
      } catch (e) {
        console.warn(`[intraday-scanner] TV scanner attempt ${attempt + 1}/3 failed:`, e?.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    return out;
  }

  // Groww NSE Live — batch 20 at a time (same source as portfolio prices).
  // PERF (2026 lag audit): 12 → 20 = fewer sequential rounds for the 87-symbol
  // universe (8 rounds → 5), shaving seconds off every scan. Upstream calls
  // are de-duplicated by the server-side Groww micro-cache anyway.
  const growwPromise = (async () => {
    const out = {};
    if (typeof fetchGrowwNseQuote !== 'function') return out;
    for (let i = 0; i < symbols.length; i += 20) {
      const batch = symbols.slice(i, i + 20);
      await Promise.allSettled(batch.map(async (sym) => {
        try {
          const gw = await fetchGrowwNseQuote(sym);
          if (gw) out[sym] = gw;
        } catch { /* skip */ }
      }));
    }
    return out;
  })();

  return Promise.all([tvPromise, growwPromise]);
}

// ------------------------------------------------------------
// CRYPTO batch — TV crypto scanner (BINANCE:SYMUSDT) + CoinDCX INR
// LTP + USD→INR re-scaling via the per-symbol anchor ratio.
// v9: when the CoinDCX ticker feed is unreachable (WAF/geo/outage),
// opts.fallbackCryptoPrices() supplies INR anchors from Binance spot
// USDT × live USDINR — the scan stays ALIVE instead of dropping every
// symbol. Honest degrade, INR domain preserved.
// ------------------------------------------------------------
async function fetchCryptoIntradayDataBatch(symbols, fetchCoinDcxTickers, fallbackCryptoPrices = null) {
  const tvToSym = {};
  const tvTickers = symbols.map(sym => {
    const t = `BINANCE:${sym}USDT`;
    tvToSym[t] = sym;
    return t;
  });

  const tvPromise = (async () => {
    const out = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`https://scanner.tradingview.com/crypto/scan?t=${Date.now()}`, {
          method: 'POST',
          headers: TV_SCAN_HEADERS,
          body: JSON.stringify({
            symbols: { tickers: [...new Set(tvTickers)] },
            columns: TV_INTRADAY_COLUMNS,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          if (attempt < 1) { await new Promise(r => setTimeout(r, 1500)); continue; }
          return out;
        }
        const data = await res.json();
        if (!data?.data) return out;
        for (const item of data.data) {
          if (!item.d) continue;
          const sym = tvToSym[item.s];
          if (!sym || out[sym]) continue; // first listing that resolves wins
          const d = item.d;
          const pf = (v) => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : null;
          out[sym] = {
            close: pf(d[0]) || 0, open: pf(d[1]) || 0,
            high: pf(d[2]) || 0, low: pf(d[3]) || 0,
            volume: pf(d[4]) || 0, change: pf(d[5]) || 0,
            ema10: pf(d[6]), ema20: pf(d[7]),
            sma20: pf(d[8]), sma50: pf(d[9]),
            rsi: pf(d[10]), macd: pf(d[11]), macdSignal: pf(d[12]),
            atr: pf(d[13]), vwap: pf(d[14]),
            adx: pf(d[15]), adxPlus: pf(d[16]), adxMinus: pf(d[17]),
            relVolume: pf(d[18]),
            pivotMiddle: pf(d[19]), pivotS1: pf(d[20]), pivotR1: pf(d[21]),
            recommend: pf(d[22]), last: pf(d[23]),
            exchange: item.s.split(':')[0],
            _currency: 'USD',
          };
        }
        break; // success — stop retrying
      } catch (e) {
        console.warn(`[intraday-crypto] TV crypto scanner attempt ${attempt + 1}/2 failed:`, e?.message);
        if (attempt < 1) await new Promise(r => setTimeout(r, 1500));
      }
    }
    return out;
  })();

  // CoinDCX INR live LTP — one shared (2s-cached) ticker round-trip.
  const cdcxPromise = (async () => {
    const out = {};
    if (typeof fetchCoinDcxTickers !== 'function') return out;
    try {
      const tickers = await fetchCoinDcxTickers();
      const byMarket = new Map();
      for (const t of tickers) byMarket.set(t.market, t);
      for (const sym of symbols) {
        const t = byMarket.get(`${sym}INR`);
        if (!t) continue;
        const price = parseFloat(t.last_price);
        if (!(price > 0)) continue;
        const change = parseFloat(t.change_24_hour) || 0;
        out[sym] = {
          price,
          change,
          high: parseFloat(t.high) || price,
          low: parseFloat(t.low) || price,
          volume: parseFloat(t.volume) || 0,
          prevClose: (change > -99 && change < 99) ? price / (1 + change / 100) : price,
        };
      }
    } catch { /* CoinDCX transient — TV-only analysis still proceeds */ }
    return out;
  })();

  const [tvData, cdcxDataRaw] = await Promise.all([tvPromise, cdcxPromise]);

  // v9: CoinDCX unreachable → Binance spot × live USDINR anchors (the
  // same honest fallback chain the Superintelligence boards use).
  const cdcxData = cdcxDataRaw;
  if (Object.keys(cdcxData).length === 0 && typeof fallbackCryptoPrices === 'function') {
    try {
      const fb = await fallbackCryptoPrices();
      if (fb && typeof fb === 'object') {
        for (const sym of symbols) {
          const f = fb[sym];
          const price = Number(f?.price);
          if (!(price > 0)) continue;
          const chg = Number(f?.change);
          const change = Number.isFinite(chg) ? chg : (Number(tvData[sym]?.change) || 0);
          cdcxData[sym] = {
            price, change,
            high: Number(f?.high) > 0 ? Number(f.high) : price,
            low: Number(f?.low) > 0 ? Number(f.low) : price,
            volume: Number(f?.volume) || 0,
            prevClose: (change > -99 && change < 99) ? price / (1 + change / 100) : price,
          };
        }
      }
    } catch { /* honest degrade — TV-only symbols get dropped below */ }
  }

  // Re-scale every TV USD price field into INR via the per-symbol anchor
  // (coindcxINR / binanceUSDT — captures USD/INR + India premium exactly).
  // RSI / MACD relations / relVolume / ADX are scale-invariant; all absolute
  // price fields (EMA/SMA/ATR/VWAP/pivots/OHLC) are linear → ×scale.
  // A symbol WITHOUT a CoinDCX INR anchor is DROPPED — emitting its raw USD
  // TV price would mislabel dollars as ₹ (wrong entry/SL/targets for users).
  for (const sym of symbols) {
    const tv = tvData[sym];
    const cd = cdcxData[sym];
    if (!tv || !cd || !(cd.price > 0)) {
      if (tv && (!cd || !(cd.price > 0))) delete tvData[sym];
      continue;
    }
    const usdRef = (tv.last > 0) ? tv.last : tv.close;
    if (!(usdRef > 0)) continue;
    const scale = cd.price / usdRef;
    const px = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? +(v * scale) : null;
    tvData[sym] = {
      ...tv,
      close: px(tv.close) || cd.price,
      open: px(tv.open) || cd.price,
      high: px(tv.high) || cd.high,
      low: px(tv.low) || cd.low,
      ema10: px(tv.ema10), ema20: px(tv.ema20),
      sma20: px(tv.sma20), sma50: px(tv.sma50),
      atr: px(tv.atr), vwap: px(tv.vwap),
      pivotMiddle: px(tv.pivotMiddle), pivotS1: px(tv.pivotS1), pivotR1: px(tv.pivotR1),
      _currency: 'INR',
    };
  }
  return [tvData, cdcxData];
}

// ------------------------------------------------------------
// Analyze ONE symbol from merged TV+Groww snapshot.
// opts: { regime?: { regime, vixLevel } | null, market?: 'INDIA' | 'CRYPTO' }
// CRYPTO: 24/7 session (no IST ORB window / dead zone / fresh-entry
// ban / EOD sq-off), fractional position sizing (BTC ≠ whole shares),
// and a wider slippage model (spot taker fees on INR pairs).
// ------------------------------------------------------------
export function analyzeIntradayFromScanner(symbol, tv, groww, opts = {}) {
  const isCrypto = String(opts.market || 'INDIA').toUpperCase() === 'CRYPTO';
  // Injectable clock (tests pass fixed timestamps; live calls default to
  // now) — the session-pace volume math below depends on the scan time.
  const now = opts.now instanceof Date ? opts.now
    : (typeof opts.now === 'number' ? new Date(opts.now) : new Date());
  const SLIP_BPS = isCrypto ? CRYPTO_SLIPPAGE_BPS : SLIPPAGE_BPS;
  // Merge Groww/CoinDCX real-time LTP with TradingView pre-computed indicators
  const ltp = groww?.price || (tv?.last > 0 ? tv.last : tv?.close) || 0;
  if (!(ltp > 0)) return null;

  const prevClose = groww?.prevClose || (tv?.change != null && tv.change !== 0
    ? ltp / (1 + tv.change / 100) : ltp);
  const changePct = groww?.change ?? tv?.change ?? 0; // v21.13: nullish — a legitimate 0.00% no longer falls through to the TV value
  const open = tv?.open || ltp;
  const high = Math.max(groww?.high || 0, tv?.high || 0) || ltp;
  const low = Math.min(
    (groww?.low > 0 ? groww.low : Infinity),
    (tv?.low > 0 ? tv.low : Infinity)
  );
  const effectiveLow = isFinite(low) ? low : ltp;
  const _volume = groww?.volume || tv?.volume || 0;

  // Pre-computed indicators from TradingView (instant — no candle counts needed)
  const ema10 = tv?.ema10 ?? ltp;
  const ema20 = tv?.ema20 ?? ltp;
  const rsi = tv?.rsi ?? 50;
  const macdVal = tv?.macd;
  const macdSig = tv?.macdSignal;
  const atr = (tv?.atr > 0) ? tv.atr : ltp * 0.02;
  const vwap = (tv?.vwap > 0) ? tv.vwap : ltp;
  const adx = tv?.adx ?? 20;
  const adxPlus = tv?.adxPlus ?? 15;
  const adxMinus = tv?.adxMinus ?? 15;
  // SESSION-PACE relative volume (2026-09 audit fix): TV's
  // relative_volume_10d_calc = today's CUMULATIVE volume ÷ 10-day
  // FULL-DAY average — verified live NOT time-of-day adjusted (13%
  // into the session, normal large-caps read 0.13–0.41). Divide by the
  // expected cumulative share of the session so the floor, the scoring
  // tiers and the displayed VOL× all mean "vs average daily pace at this
  // time" — morning signals stop being blanket-rejected. Post-close /
  // pre-open / weekend → share = 1 → pace == raw (shipped behavior
  // preserved). CRYPTO: 24/7 rolling window → raw stands unchanged.
  const rawRelVolume = (typeof tv?.relVolume === 'number' && Number.isFinite(tv.relVolume) && tv.relVolume > 0)
    ? tv.relVolume : null;
  const relVolumeKnown = rawRelVolume !== null;
  const relVolume = relVolumeKnown
    ? (paceRelVolume(rawRelVolume, isCrypto ? 'CRYPTO' : 'INDIA', now) ?? rawRelVolume)
    : 1;
  const pivot = tv?.pivotMiddle ?? ltp;
  const pivotS1 = tv?.pivotS1 ?? (ltp * 0.98);
  const pivotR1 = tv?.pivotR1 ?? (ltp * 1.02);
  const sma50 = tv?.sma50 ?? null; // multi-timeframe confluence anchor

  // ---- v4 HARD VOLUME FLOOR ----
  // Only reject on KNOWN low relative volume — an absent feed value
  // (null/0 from TV) must not disqualify a symbol on missing data.
  // Crypto trades 24/7 across global sessions — floor is 0.7x (NSE is 1.2x).
  const volFloor = isCrypto ? 0.7 : MIN_REL_VOLUME;
  if (relVolumeKnown && relVolume < volFloor) return null;

  // Derived metrics
  const gapPct = prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : 0;
  const dayRange = high > effectiveLow ? (ltp - effectiveLow) / (high - effectiveLow) : 0.5;
  const vwapDist = vwap > 0 ? ((ltp - vwap) / vwap) * 100 : 0;

  // ---- ORB-15 (Opening Range Breakout, 15-min) ----
  // While 09:15–09:45 IST is FORMING, the day's running high/low IS the
  // opening range. After that window we cannot reconstruct the exact range
  // from daily OHLC alone, so we use an honest ATR-proxy band around the
  // open (labelled PROXY in the payload — never presented as exact).
  // CRYPTO 24/7: there IS no session open — the ATR-proxy band is the only
  // honest form (never a LIVE session range). v4.9 audit fix: _istMins honors
  // the injectable clock (opts.now) so ORB/dead-zone/fresh-entry/phase logic
  // stays deterministic under test — same wall clock live.
  const _istMins = istMinutes(now);
  const inOrbWindow = !isCrypto && _istMins >= 9 * 60 + 15 && _istMins < 9 * 60 + 45;
  const orbHigh = inOrbWindow ? high : open + 0.55 * atr;
  const orbLow = inOrbWindow ? effectiveLow : open - 0.55 * atr;
  const orbMode = inOrbWindow ? 'LIVE' : 'PROXY';

  function scoreSide(dir) {
    let s = 0; const reasons = [];
    // EMA Stack — 20pts
    if (dir === 'LONG' ? (ltp > ema10 && ema10 > ema20) : (ltp < ema10 && ema10 < ema20)) {
      s += 20; reasons.push(`EMA10/20 ${dir === 'LONG' ? 'bullish' : 'bearish'} stack`);
    } else if (dir === 'LONG' ? (ltp > ema10 || ema10 > ema20) : (ltp < ema10 || ema10 < ema20)) { s += 12; }
    // VWAP Bias — 19pts
    if (dir === 'LONG' ? vwapDist > 0.05 : vwapDist < -0.05) {
      s += 19; reasons.push(dir === 'LONG' ? `Above VWAP +${vwapDist.toFixed(1)}%` : `Below VWAP ${vwapDist.toFixed(1)}%`);
    } else if (Math.abs(vwapDist) <= 0.25) { s += 10; reasons.push('At VWAP control zone'); }
    // ---- v4: Volume Profile POC premium — 7pts ----
    // VWAP approximates the session's volume point-of-control; price
    // hugging it = value-area acceptance (premium entries, both sides).
    if (Math.abs(vwapDist) <= 0.25) {
      s += 7; reasons.push('Volume-POC value-area acceptance');
    }
    // RSI Sweet Zone — 14pts (v4 TIGHTER: LONG 52-68, SHORT 32-48)
    if (dir === 'LONG' ? (rsi >= 52 && rsi <= 68) : (rsi >= 32 && rsi <= 48)) {
      s += 14; reasons.push(`RSI ${Math.round(rsi)} momentum`);
    } else if (dir === 'LONG' ? (rsi >= 46 && rsi < 52) : (rsi > 48 && rsi <= 54)) { s += 8; }
    // v4: exhaustion penalty DOUBLED — never chase blow-off moves
    if (dir === 'LONG' && rsi > 78) s -= 12;
    if (dir === 'SHORT' && rsi < 22) s -= 12;
    // Relative Volume — 12pts (v4: 1.2x floor already hard-gated above)
    if (relVolume >= 1.5) { s += 12; reasons.push(`Volume ${relVolume.toFixed(1)}x surge`); }
    else if (relVolume >= 1.2) { s += 8; reasons.push(`Volume ${relVolume.toFixed(1)}x`); }
    else if (relVolume >= 0.8) { s += 4; }
    // MACD — 12pts
    if (macdVal != null && macdSig != null) {
      if (dir === 'LONG' ? macdVal > macdSig : macdVal < macdSig) {
        s += 12; reasons.push(`MACD ${dir === 'LONG' ? 'bullish' : 'bearish'} cross`);
      } else if (dir === 'LONG' ? macdVal > 0 : macdVal < 0) { s += 6; }
    }
    // Pivot/CPR — 10pts
    if (dir === 'LONG' ? ltp > pivotR1 : ltp < pivotS1) {
      s += 10; reasons.push(dir === 'LONG' ? 'Above R1 breakout' : 'Below S1 breakdown');
    } else if (dir === 'LONG' ? ltp > pivot : ltp < pivot) {
      s += 6; reasons.push(dir === 'LONG' ? 'Above pivot' : 'Below pivot');
    }
    // ADX Trend Strength — 10pts
    if (adx > 22) { s += 8; reasons.push(`ADX ${Math.round(adx)} strong trend`); }
    else if (adx > 16) { s += 4; }
    if (dir === 'LONG' ? adxPlus > adxMinus : adxMinus > adxPlus) s += 2;
    // ---- v4: Supertrend(7) alignment — 8pts ----
    // No intraday candle history on the daily TV snapshot, so the 7-period
    // Supertrend is approximated as an ATR-trail off EMA20 (honest proxy):
    // LONG needs price above ema20 - 0.5*ATR (trail line below price);
    // SHORT needs price below ema20 + 0.5*ATR.
    const stTrail = dir === 'LONG' ? ema20 - 0.5 * atr : ema20 + 0.5 * atr;
    if (dir === 'LONG' ? ltp > stTrail : ltp < stTrail) {
      s += 8; reasons.push('Supertrend(7) aligned (ATR-trail proxy)');
    }
    // ---- v4: Multi-timeframe EMA confluence — 10pts ----
    // SMA50 (higher timeframe) agreeing with the EMA10/20 intraday stack.
    if (sma50 != null) {
      if (dir === 'LONG' ? (ltp > sma50 && ema20 > sma50) : (ltp < sma50 && ema20 < sma50)) {
        s += 10; reasons.push('SMA50 multi-timeframe confluence');
      }
    }
    // ORB-15 — 8pts (breakout side bonus / wrong-side penalty)
    if (dir === 'LONG' ? ltp > orbHigh + 0.05 * atr : ltp < orbLow - 0.05 * atr) {
      s += 8; reasons.push(`ORB-15 ${dir === 'LONG' ? 'breakout' : 'breakdown'}${orbMode === 'PROXY' ? ' (proxy)' : ''}`);
    } else if (dir === 'LONG' ? ltp < orbLow : ltp > orbHigh) { s -= 3; }
    // Gap Analysis — 7pts (v4: exhaustion threshold 2.5%, was 3.5%)
    if (dir === 'LONG' ? (gapPct > 0.2 && gapPct < 2.5) : (gapPct < -0.2 && gapPct > -2.5)) {
      s += 7; reasons.push(`Gap ${gapPct > 0 ? '+' : ''}${gapPct.toFixed(1)}%`);
    }
    // v4: gap-exhaustion penalty HEAVY at ±2.5%+ (was -4 at ±3.5%)
    if (dir === 'LONG' && gapPct > 2.5) s -= 8;
    if (dir === 'SHORT' && gapPct < -2.5) s -= 8;
    // Day Range Position — 7pts
    if (dir === 'LONG' ? dayRange < 0.45 : dayRange > 0.55) {
      s += 7; reasons.push(dir === 'LONG' ? 'Near day low entry' : 'Near day high short');
    } else if (dir === 'LONG' ? dayRange < 0.6 : dayRange > 0.4) { s += 4; }
    return { score: Math.round(Math.max(0, Math.min(100, s))), reasons };
  }

  const longR = scoreSide('LONG'), shortR = scoreSide('SHORT');
  // v21.13.x recheck (B5): exact-score ties no longer break LONG (the
  // ensemble's v12.7 tie→FLAT fix ka engine mirror — a free LONG bias on
  // a coin-flip setup). A tie is a NO-EDGE read: keep the deterministic
  // LONG/SHORT shape downstream contracts expect, but demote below the
  // routes pool floor (70) so the tie can never become an entry.
  const _tieScore = longR.score === shortR.score;
  const direction = longR.score >= shortR.score ? 'LONG' : 'SHORT';
  let quantConfidence = Math.max(longR.score, shortR.score);
  const reasons = direction === 'LONG' ? longR.reasons : shortR.reasons;
  if (_tieScore) {
    quantConfidence = Math.min(quantConfidence, 69);
    reasons.push('⚖️ TIE — dono sides barabar score, koi directional edge nahi');
  }

  // ---------- MARKET REGIME PENALTY (NIFTY/VIX gating) ----------
  // v4: counter-regime -10 (was -6), VIX-HIGH -6 (was -3)
  let counterTrend = false;
  const regime = opts?.regime;
  if (regime && typeof regime === 'object') {
    if (regime.regime === 'BEARISH' && direction === 'LONG') { quantConfidence -= 10; counterTrend = true; }
    if (regime.regime === 'BULLISH' && direction === 'SHORT') { quantConfidence -= 10; counterTrend = true; }
    if (regime.vixLevel === 'HIGH') { quantConfidence -= 6; reasons.push('High-VIX regime caution'); }
    if (counterTrend) reasons.push('Counter-regime (NIFTY filter)');
  }

  // ---------- v4: DEAD-ZONE (14:30–15:00 IST) ----------
  // Statistically weak window — heavy penalty here, hard gate in routes.
  // CRYPTO 24/7: N/A.
  const deadZone = !isCrypto && inDeadZone(_istMins);
  if (deadZone) { quantConfidence -= 15; reasons.push('Dead-zone timing (14:30-15:00)'); }

  // ---------- v11.1 GAP 2: CIRCUIT-LIMIT GUARD (NSE price bands) ----------
  // Same-direction entry near the adverse band (LONG→upper / SHORT→lower
  // circuit) gets a HEAVY penalty + a distinct reason flag — chasing into
  // a freeze is the classic retail trap, and at a frozen band the entry
  // literally cannot fill in that direction. Bands come from the Groww
  // quote already riding this scan (highPriceRange/lowPriceRange).
  // CRYPTO / no-band quotes → guard inert (honest, never invented).
  const circuitRisk = !isCrypto
    ? entryCircuitRisk(direction, ltp, groww?.upperCircuit, groww?.lowerCircuit)
    : { risk: false, penalty: 0, reason: null, prox: null, clampLong: null, clampShort: null };
  if (circuitRisk.risk) {
    quantConfidence -= circuitRisk.penalty;
    reasons.push(circuitRisk.reason);
  }
  quantConfidence = Math.max(0, Math.min(100, quantConfidence));

  // ---------- v21.13 MOMENTUM-CAPTURE GATE (chase guard, board parity) ----------
  // The engine scored the setup; this gate times the ENTRY. Same contract
  // as the board's signalMemory chase guard (entryTiming.js — PURE module):
  // never flips the side, only SUPPRESSES the entry. INDIA anchors to the
  // session VWAP, crypto to EMA20 — both in 15m ATR units.
  //   HARD  (>=2.5×ATR, or RSI 64/36 + >=1.9×ATR): conf cap 48 → the
  //         routes pool floor (70) drops the chase setup entirely.
  //   SOFT  (>=1.8×ATR): −7.  EXTENDED (1.5-1.8×ATR): −4.
  //   PULLBACK band: NO boost here (intentional) — the +4 belongs to the
  //   BOARD's signalMemory (ranking). Engine pe sirf suppression hai, so
  //   confidence diffs (regime/circuit penalties) saturation me kabhi
  //   distort nahi hote — deterministic penalties, deterministic tests.
  const chase = entryTimingRead({
    side: direction, ltp, ema20, vwap, atr, rsi,
    market: isCrypto ? 'CRYPTO' : 'INDIA',
  });
  let chaseGuard = null;
  if (chase && (chase.severity || chase.extAtr != null)) {
    chaseGuard = chase;
    if (chase.severity === 'HARD') {
      quantConfidence = Math.min(quantConfidence, CHASE_HARD_CONF_CAP);
      reasons.push(`🚀 CHASING — ${chase.reason} — ${direction} entry suppressed (pullback ka wait karo)`);
    } else if (chase.severity === 'SOFT') {
      quantConfidence = Math.max(5, quantConfidence - CHASE_SOFT_CONF_PENALTY);
      reasons.push(`🚀 extended — ${chase.reason}`);
    }
    if (chase.quality === 'EXTENDED') {
      quantConfidence = Math.max(5, quantConfidence - QUALITY_EXTENDED_CONF_PENALTY);
      reasons.push(`📐 stretched — ${chase.qualityNote}`);
    } else if (chase.quality === 'PULLBACK') {
      // payload-only (no conf boost on the engine — see note above)
      reasons.push(`🌊 PULLBACK — ${chase.qualityNote}`);
    }
    quantConfidence = Math.max(0, Math.min(100, quantConfidence));
  }

  // ---------- PRO-DESK RISK ARCHITECTURE ----------
  const entry = ltp;
  const entryZoneLow = +(entry - 0.25 * atr).toFixed(2);
  const entryZoneHigh = +(entry + 0.10 * atr).toFixed(2);
  const isLong = direction === 'LONG';

  // Structural stop: tighter of (1.1×ATR, day-swing ± 0.15×ATR buffer),
  // clamped 0.7×ATR (noise floor) ↔ 1.8×ATR (max risk cap) — pro standard.
  const atrStop = isLong ? entry - 1.1 * atr : entry + 1.1 * atr;
  const swingStop = isLong
    ? (effectiveLow > 0 ? effectiveLow - 0.15 * atr : atrStop)
    : (high > 0 ? high + 0.15 * atr : atrStop);
  let stopLoss = isLong ? Math.max(atrStop, swingStop) : Math.min(atrStop, swingStop);
  if (isLong) {
    stopLoss = Math.min(stopLoss, entry - 0.7 * atr); // never tighter than 0.7 ATR
    stopLoss = Math.max(stopLoss, entry - 1.8 * atr); // never wider than 1.8 ATR
  } else {
    stopLoss = Math.max(stopLoss, entry + 0.7 * atr);
    stopLoss = Math.min(stopLoss, entry + 1.8 * atr);
  }
  stopLoss = +stopLoss.toFixed(2);

  // R-multiple targets off ACTUAL risk (targets scale with the real stop).
  const risk = Math.abs(entry - stopLoss);
  let target1 = +(isLong ? entry + 1.6 * risk : entry - 1.6 * risk).toFixed(2);
  let target2 = +(isLong ? entry + 2.6 * risk : entry - 2.6 * risk).toFixed(2);
  // v11.1 GAP 2: circuit-band clamp — a LONG target printed ABOVE the
  // upper circuit can never fill (price cannot exceed the band), and a
  // SHORT target below the lower circuit likewise. Clamp to the band
  // BEFORE R:R math so the published RR stays physically achievable.
  if (circuitRisk.prox) {
    if (isLong && circuitRisk.prox.upper > 0) {
      if (target1 > circuitRisk.prox.upper) target1 = +circuitRisk.prox.upper.toFixed(2);
      if (target2 > circuitRisk.prox.upper) target2 = +circuitRisk.prox.upper.toFixed(2);
    } else if (!isLong && circuitRisk.prox.lower > 0) {
      if (target1 < circuitRisk.prox.lower) target1 = +circuitRisk.prox.lower.toFixed(2);
      if (target2 < circuitRisk.prox.lower) target2 = +circuitRisk.prox.lower.toFixed(2);
    }
  }
  const trailingSL = +(isLong ? entry - 0.8 * atr : entry + 0.8 * atr).toFixed(2);
  const trailAfterT1 = +entry.toFixed(2); // breakeven lock once T1 books — discipline rule
  const rr = risk > 0 ? Math.abs(target1 - entry) / risk : 0;

  // ---------- SLIPPAGE MODEL (±7bps NSE / ±12bps crypto per side) ----------
  const slippage = +(entry * SLIP_BPS / 10000).toFixed(2);
  const effRisk = risk + 2 * slippage;                 // slip hurts entry AND exit
  const effReward1 = Math.abs(target1 - entry) - 2 * slippage;
  const effRR = effRisk > 0 ? +(effReward1 / effRisk).toFixed(2) : 0;

  // Position sizing — 1% RISK RULE per ₹1,00,000 capital, capped at 25%
  // capital deployed. Quantity uses slip-adjusted risk (conservative).
  // CRYPTO: fractional units (you can buy 0.0027 BTC) — round to 4 dp;
  // NSE equities stay whole-share (integer floor).
  // v11.4 recheck: the old code Math.floor'ed qtyRisk/qtyCap BEFORE the
  // crypto branch — for BTC (entry ≈ ₹43.5L) both floors hit 0, so every
  // major-coin signal published the 0.0001 dust minimum (~50–90× undersize).
  // Floor ONLY for NSE; crypto keeps the fraction.
  const qtyRisk = effRisk > 0 ? 1000 / effRisk : 0;
  const qtyCap = 25000 / entry;
  const qtyRaw = Math.max(0, Math.min(qtyRisk, qtyCap));
  const qtyPerLakh = isCrypto
    ? Math.max(0.0001, +qtyRaw.toFixed(4))
    : Math.floor(qtyRaw);

  // ADX regime label
  const trendStrength = adx >= 28 ? 'STRONG' : adx >= 20 ? 'BUILDING' : 'WEAK-RANGE';

  // v4.9 audit fix: phase honors the injectable clock too (wall clock live).
  const phase = marketPhaseFor(isCrypto ? 'CRYPTO' : 'INDIA', now);
  const freshEntriesAllowed = isCrypto ? true : (_istMins < 15 * 60); // crypto: 24/7, no entry cutoff

  return {
    symbol, ltp: +ltp.toFixed(2), changePct: +changePct.toFixed(2),
    direction, quantConfidence: phase === 'early' ? Math.min(quantConfidence, 88) : quantConfidence,
    market: isCrypto ? 'CRYPTO' : 'INDIA',
    exchange: isCrypto ? (tv?.exchange || 'BINANCE') : (tv?.exchange || 'NSE'),
    entry: +entry.toFixed(2), stopLoss,
    entryZoneLow, entryZoneHigh,
    target1, target2,
    trailingSL, trailAfterT1,
    qtyPerLakh, trendStrength,
    freshEntriesAllowed, sqOffBy: isCrypto ? '24/7 (no EOD sq-off)' : '15:10 IST',
    rr: +rr.toFixed(2), atr: +atr.toFixed(2),
    vwap: +vwap.toFixed(2), rsi: +rsi.toFixed(1), volumeRatio: +relVolume.toFixed(2),
    adx: +(adx).toFixed(1), gapPct: +gapPct.toFixed(2), vwapDist: +vwapDist.toFixed(2),
    marketPhase: phase, orbMode, counterTrend,
    slippage, effRR,
    reasons,
    // v11.1 GAP 2: circuit-band proximity (null = bands unknown — guard
    // inert). nearCircuit flags the same-direction entry-risk case.
    circuitRisk: circuitRisk.risk ? {
      band: circuitRisk.prox.upper != null && isLong ? 'UPPER' : 'LOWER',
      distPct: isLong ? circuitRisk.prox.distUpperPct : circuitRisk.prox.distLowerPct,
      upper: circuitRisk.prox.upper,
      lower: circuitRisk.prox.lower,
    } : (circuitRisk.prox ? {
      band: null, distPct: null,
      upper: circuitRisk.prox.upper,
      lower: circuitRisk.prox.lower,
    } : null),
    nearCircuit: !!circuitRisk.risk,
    _rrOk: rr >= HIGH_CONV_RR_FLOOR, // v4: 1.5 floor (was 1.25)
    _momentumPct: changePct,
    _deadZone: deadZone,
    // v21.13: the chase/timing read (entryTimingRead payload — severity,
    // extAtr vs VWAP/EMA20, quality band). null = nothing computable.
    chaseGuard,
  };
}

// ------------------------------------------------------------
// v4 SIGNAL QUALITY GRADE — A+ / A / B
//   A+: confidence ≥88, RR(eff) ≥1.8, volume ≥1.5x, ADX ≥25,
//       VWAP-aligned, not counter-regime
//   A : confidence ≥80, RR(eff) ≥1.5, volume ≥1.2x
//   B : everything else that clears the confidence threshold
//       (frontend shows B as "WATCH ONLY")
// ------------------------------------------------------------
export function gradeSignal(s) {
  if (!s) return 'B';
  const rrEff = (s.effRR ?? s.rr) || 0;
  const vol = s.volumeRatio ?? 0;
  const adx = s.adx ?? 0;
  const vd = s.vwapDist ?? 0;
  const vwapAligned = s.direction === 'LONG' ? vd > 0 : vd < 0;
  if (s.confidence >= 88 && rrEff >= 1.8 && vol >= 1.5 && adx >= 25 && vwapAligned && !s.counterTrend) {
    return 'A+';
  }
  if (s.confidence >= 80 && rrEff >= 1.5 && vol >= 1.2) {
    return 'A';
  }
  return 'B';
}

// ------------------------------------------------------------
// MCP AI verification — v4 STRUCTURED DUAL-EXPERT CONSENSUS.
// Gemini + Groq (parallel, independent) each return a full expert
// analysis per setup: reasoning chain, risk factors, entry-quality
// score, trade-type classification and optional ADJUSTED levels.
// Consensus rules (v4, quality-over-quantity):
//   • ANY "AVOID" vote → setup rejected (was: confidence halved)
//   • Direction conflict between experts → rejected
//   • Unanimous direction → confidence = weighted avg + 5 agreement
//     bonus; tightest valid AI stop merged into the signal (routes)
// deps: { KEYS, OPENAI_COMPAT } (injected from server/index.js)
// ------------------------------------------------------------
export async function aiVerifySignals(candidates, deps) {
  if (!candidates.length) return null;
  const { KEYS, OPENAI_COMPAT } = deps || {};
  const isCryptoMkt = String(deps?.market || 'INDIA').toUpperCase() === 'CRYPTO';
  const compact = candidates.map(c => ({
    sym: c.symbol, exch: c.exchange || 'NSE', dir: c.direction, q: c.quantConfidence,
    ltp: c.ltp, chg: c.changePct, rsi: c.rsi, vr: c.volumeRatio, rr: c.rr,
    adx: c.adx ?? 20, gap: c.gapPct ?? 0, phase: c.marketPhase || 'full',
    vwapDist: c.vwapDist ?? +((((c.ltp - c.vwap) / c.vwap) * 100)).toFixed(2),
    plan: { entry: c.entry, sl: c.stopLoss, t1: c.target1, t2: c.target2 },
    atr: c.atr,
    mom: c._momentumPct != null ? +c._momentumPct.toFixed(2) : undefined,
  }));
  const systemPrompt = isCryptoMkt
    ? `You are an elite CRYPTO intraday EXPERT analyst (15+ yrs prop-desk, Binance/CoinDCX spot & perp scalping) running as an MCP verification tool. All prices are INR (CoinDCX) with 24/7 continuous sessions. You receive pre-scored setups from a v4 quantitative engine (EMA/VWAP/Supertrend/ORB-proxy/CPR/ADX/SMA50-confluence/pivot/volume/momentum factors). Analyze each setup IN DEPTH and verify strictly.

PENALIZE: RSI exhaustion (>75/<25), poor RR (<1.5), counter-VWAP direction, low relative volume (<1.2x), overextension far from VWAP (>2%), weak ADX (<18), extreme 24h move (>6%), counter-regime setups when BTC is strongly bearish (LONG) or bullish (SHORT), weekend liquidity thinning. Boost only high-conviction confluence: ADX >25, volume >1.5x, VWAP-aligned, BTC-regime-aligned.

For EVERY symbol respond with a STRUCTURED expert analysis (STRICT JSON only, no markdown):
{"verdicts":{"SYMBOL":{
  "verdict":"LONG"|"SHORT"|"AVOID",
  "confidence":0-100,
  "note":"max 15 words",
  "analysis":"2-3 sentences: indicator state, entry timing quality, momentum/catalyst read — your reasoning chain",
  "riskFactors":["risk 1","risk 2"],
  "entryQuality":1-10,
  "tradeType":"SCALP"|"MOMENTUM"|"SWING",
  "slAdjust":null-or-tighter-stop-price,
  "entryAdjust":null-or-better-entry-price
}}}
slAdjust/entryAdjust: only suggest when clearly better than the engine plan (tighter risk / superior entry). Use null otherwise.`
    : `You are an elite NSE/BSE intraday EXPERT analyst (15+ yrs prop-desk) running as an MCP verification tool. You receive pre-scored setups from a v4 quantitative engine (EMA/VWAP/Supertrend/ORB/CPR/ADX/SMA50-confluence/pivot/volume/momentum/gap factors). Analyze each setup IN DEPTH and verify strictly.

PENALIZE: RSI exhaustion (>75/<25), poor RR (<1.5), counter-VWAP direction, low relative volume (<1.2x), overextension far from VWAP (>1.5%), weak ADX (<18), extreme gap (>2.5%), counter-regime setups when NIFTY is strongly bearish (LONG) or bullish (SHORT). In early phase (9:15-9:45 IST) reduce confidence by 5-10 pts. Boost only high-conviction confluence: ADX >25, volume >1.5x, VWAP-aligned.

For EVERY symbol respond with a STRUCTURED expert analysis (STRICT JSON only, no markdown):
{"verdicts":{"SYMBOL":{
  "verdict":"LONG"|"SHORT"|"AVOID",
  "confidence":0-100,
  "note":"max 15 words",
  "analysis":"2-3 sentences: indicator state, entry timing quality, momentum/catalyst read — your reasoning chain",
  "riskFactors":["risk 1","risk 2"],
  "entryQuality":1-10,
  "tradeType":"SCALP"|"MOMENTUM"|"SWING",
  "slAdjust":null-or-tighter-stop-price,
  "entryAdjust":null-or-better-entry-price
}}}
slAdjust/entryAdjust: only suggest when clearly better than the engine plan (tighter risk / superior entry). Use null otherwise.`;
  const userPrompt = `Setups (q = engine confidence, vwapDist % = price vs VWAP, plan = engine entry/SL/T1/T2 levels):\n${JSON.stringify(compact)}`;

  const parseVerdicts = (text) => {
    try {
      // Strip <think>...</think> blocks BEFORE extracting JSON.
      const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      // Progressive extraction: the old greedy /\{[\s\S]*\}/ spanned from the
      // FIRST '{' to the LAST '}' — trailing prose with a stray '}' (or a
      // second JSON blob) poisoned the parse and silently dropped the whole
      // multi-model consensus layer. Try progressively shorter spans instead.
      const start = cleanText.indexOf('{');
      if (start === -1) return null;
      let end = cleanText.lastIndexOf('}');
      while (end > start) {
        try {
          const parsed = JSON.parse(cleanText.slice(start, end + 1));
          if (parsed?.verdicts) return parsed.verdicts;
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) return parsed.verdicts || parsed;
        } catch { /* shrink window and retry */ }
        end = cleanText.lastIndexOf('}', end - 1);
      }
      return null;
    } catch { return null; }
  };

  async function askGemini(model) {
    if (!KEYS?.gemini) return null;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEYS.gemini}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 3000 },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`gemini ${r.status}`);
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
    return parseVerdicts(text);
  }

  async function askOpenAICompat(provider) {
    if (!KEYS?.[provider]) return null;
    const p = OPENAI_COMPAT[provider];
    const r = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS[provider]}` },
      body: JSON.stringify({
        model: p.defModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2, max_completion_tokens: 3000,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`${provider} ${r.status}`);
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content || '';
    return parseVerdicts(text);
  }

  // Parallel consensus across all available engines (Gemini + Groq are the
  // v4 dual experts; Cerebras joins when configured).
  const settled = await Promise.allSettled([
    askGemini('gemini-3.5-flash').catch(() => askGemini('gemini-2.5-flash')),
    askOpenAICompat('groq'),
    askOpenAICompat('cerebras'),
  ]);
  const responses = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled' && s.value && typeof s.value === 'object') {
      responses.push({ model: ['gemini', 'groq', 'cerebras'][i], verdicts: s.value });
    }
  }
  if (responses.length === 0) return null;

  // ---- v4 structured-field sanitizers ----
  const _n = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const _tt = (v) => (['SCALP', 'MOMENTUM', 'SWING'].includes(v) ? v : null);
  const _rf = (v) => Array.isArray(v)
    ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 60)).slice(0, 6)
    : [];

  const merged = {};
  const VALID_VERDICTS = new Set(['LONG', 'SHORT', 'AVOID']);
  for (const c of candidates) {
    const votes = [];
    for (const resp of responses) {
      const v = resp.verdicts[c.symbol];
      if (v && v.verdict && typeof v.confidence === 'number') {
        const verdict = String(v.verdict).toUpperCase().trim();
        // v4.1 robustness: a model that drifts off the whitelist ("WAIT",
        // "NEUTRAL", "HOLD", …) must never poison the consensus loop —
        // unknown verdicts are discarded here (not counted as votes).
        // Previously: all-drift votes left tradeVotes empty and
        // `tradeVotes[0].verdict` threw, killing the WHOLE scan.
        if (!VALID_VERDICTS.has(verdict)) continue;
        votes.push({
          verdict,
          confidence: Math.max(0, Math.min(100, v.confidence)),
          note: String(v.note || '').slice(0, 120),
          analysis: String(v.analysis || '').slice(0, 700).trim(),
          riskFactors: _rf(v.riskFactors),
          entryQuality: (() => { const q = _n(v.entryQuality); return q == null ? null : Math.max(1, Math.min(10, Math.round(q))); })(),
          tradeType: _tt(v.tradeType),
          slAdjust: _n(v.slAdjust),
          entryAdjust: _n(v.entryAdjust),
          model: resp.model,
        });
      }
    }
    if (votes.length === 0) continue;

    const tradeVotes = votes.filter(v => v.verdict === 'LONG' || v.verdict === 'SHORT');
    const avoidVotes = votes.filter(v => v.verdict === 'AVOID');

    // v4 STRICT: any AVOID vote rejects the setup outright.
    if (avoidVotes.length > 0) {
      merged[c.symbol] = {
        verdict: 'AVOID',
        confidence: Math.max(...avoidVotes.map(v => v.confidence)),
        note: avoidVotes[0].note || 'AI avoid',
        analysis: avoidVotes.map(v => v.analysis).filter(Boolean).join(' ').slice(0, 900),
        riskFactors: [...new Set(avoidVotes.flatMap(v => v.riskFactors))].slice(0, 6),
        models: votes.map(v => v.model),
        dissent: 0,
      };
      continue;
    }
    // v4 STRICT: experts must agree on direction — conflict = reject.
    const dirs = new Set(tradeVotes.map(v => v.verdict));
    if (dirs.size > 1) {
      merged[c.symbol] = {
        verdict: 'AVOID',
        confidence: 55,
        note: 'AI direction conflict — experts disagree',
        analysis: votes.map(v => `${v.model}: ${v.analysis}`).filter(Boolean).join(' ').slice(0, 900),
        riskFactors: ['Expert direction disagreement', ...[...new Set(votes.flatMap(v => v.riskFactors))]].slice(0, 6),
        models: votes.map(v => v.model),
        dissent: 1,
      };
      continue;
    }

    // Unanimous trade direction — build the consensus verdict.
    const dir = tradeVotes[0].verdict;
    const avgConf = tradeVotes.reduce((s, v) => s + v.confidence, 0) / tradeVotes.length;
    const agreementBonus = tradeVotes.length >= 2 ? 5 : 0;

    // Reasoning chain: every expert's analysis, labelled.
    const analysis = votes
      .map(v => v.analysis ? `[${v.model.toUpperCase()}] ${v.analysis}` : '')
      .filter(Boolean).join('\n').slice(0, 1200);

    // Risk factors: union across experts (deduped, capped).
    const riskFactors = [...new Set(votes.flatMap(v => v.riskFactors))].slice(0, 6);

    // Entry quality: average of the experts that scored it.
    const eqs = votes.map(v => v.entryQuality).filter(q => q != null);
    const entryQuality = eqs.length ? Math.round(eqs.reduce((s, q) => s + q, 0) / eqs.length) : null;

    // Trade type: majority (tie → first expert's classification).
    const ttCounts = {};
    for (const v of tradeVotes) if (v.tradeType) ttCounts[v.tradeType] = (ttCounts[v.tradeType] || 0) + 1;
    const ttEntries = Object.entries(ttCounts).sort((a, b) => b[1] - a[1]);
    const tradeType = ttEntries.length ? ttEntries[0][0] : null;

    // Adjusted levels: tightest valid SL + averaged entry suggestions.
    // (raw values here — routes.js bounds them against engine geometry)
    const slCandidates = tradeVotes.map(v => v.slAdjust).filter(x => x != null);
    const entryCandidates = tradeVotes.map(v => v.entryAdjust).filter(x => x != null);

    merged[c.symbol] = {
      verdict: dir,
      confidence: Math.max(0, Math.min(100, Math.round(avgConf + agreementBonus))),
      note: tradeVotes[0].note,
      analysis,
      riskFactors,
      entryQuality,
      tradeType,
      slAdjust: slCandidates.length
        ? (dir === 'LONG' ? Math.max(...slCandidates) : Math.min(...slCandidates)) // tightest = closest to entry
        : null,
      entryAdjust: entryCandidates.length
        ? +(entryCandidates.reduce((s, x) => s + x, 0) / entryCandidates.length).toFixed(2)
        : null,
      models: [...new Set(votes.map(v => v.model))],
      dissent: 0, // conflicts already rejected above
      perModel: Object.fromEntries(votes.map(v => [v.model, {
        verdict: v.verdict, confidence: v.confidence, note: v.note, analysis: v.analysis,
        entryQuality: v.entryQuality, tradeType: v.tradeType, riskFactors: v.riskFactors,
      }])),
    };
  }
  return { verdicts: merged, models: responses.map(r => r.model) };
}
