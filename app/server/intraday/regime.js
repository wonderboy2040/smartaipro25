// ============================================================
// intraday/regime — NIFTY + INDIA VIX market-regime filter
// ------------------------------------------------------------
// Gates the scanner against the broad market: counter-trend setups
// (LONG while NIFTY is bearish / SHORT while NIFTY is bullish)
// lose conviction instead of firing blind. VIX level flags
// volatile regimes. Data source: TradingView India Scanner —
// ONE extra request, cached 60s, fully degradable (no data ⇒
// no penalty, never blocks the scan).
// ============================================================
import { istMinutes } from './time.js';
import { TV_SCAN_HEADERS } from '../lib/tvHeaders.js';

let _regimeCache = { data: null, ts: 0 };
const REGIME_CACHE_MS = 60 * 1000;

const REGIME_TV_COLUMNS = ['close', 'change', 'VWAP', 'EMA20', 'RSI'];

async function fetchRegimeFromTV() {
  const res = await fetch(`https://scanner.tradingview.com/india/scan?t=${Date.now()}`, {
    method: 'POST',
    headers: TV_SCAN_HEADERS,
    body: JSON.stringify({
      symbols: { tickers: ['NSE:NIFTY', 'NSE:INDIAVIX'] },
      columns: REGIME_TV_COLUMNS,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const out = {};
  for (const item of data?.data || []) {
    if (!item.d) continue;
    const pf = (v) => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : null;
    out[item.s] = { close: pf(item.d[0]), change: pf(item.d[1]), vwap: pf(item.d[2]), ema20: pf(item.d[3]), rsi: pf(item.d[4]) };
  }
  return out;
}

/**
 * Returns { regime, vix, vixLevel, niftyChange, niftyVwapDist, asOf } | null.
 *  regime:   'BULLISH' | 'BEARISH' | 'NEUTRAL'
 *  vixLevel: 'LOW' (<13) | 'ELEVATED' (13–16) | 'HIGH' (>16)
 */
export async function getMarketRegime(debug = false) {
  if (!debug && _regimeCache.data && Date.now() - _regimeCache.ts < REGIME_CACHE_MS) {
    return _regimeCache.data;
  }
  try {
    const raw = await fetchRegimeFromTV();
    const nifty = raw?.['NSE:NIFTY'];
    const vixRow = raw?.['NSE:INDIAVIX'];
    if (!nifty || !(nifty.close > 0)) return _regimeCache.data || null;

    const niftyChange = nifty.change ?? 0;
    const niftyVwapDist = nifty.vwap > 0 ? ((nifty.close - nifty.vwap) / nifty.vwap) * 100 : 0;
    const aboveEma = nifty.ema20 != null ? nifty.close > nifty.ema20 : null;

    let regime = 'NEUTRAL';
    if (niftyVwapDist > 0.15 && niftyChange > 0.1 && aboveEma !== false) regime = 'BULLISH';
    else if (niftyVwapDist < -0.15 && niftyChange < -0.1 && aboveEma !== true) regime = 'BEARISH';
    else if (Math.abs(niftyChange) > 0.35 && niftyVwapDist > 0.2) regime = 'BULLISH';
    else if (Math.abs(niftyChange) > 0.35 && niftyVwapDist < -0.2) regime = 'BEARISH';

    const vix = vixRow?.close ?? null;
    const vixLevel = vix == null ? null : vix > 16 ? 'HIGH' : vix >= 13 ? 'ELEVATED' : 'LOW';

    const data = {
      regime, vix, vixLevel,
      niftyChange: +niftyChange.toFixed(2),
      niftyVwapDist: +niftyVwapDist.toFixed(2),
      niftyRsi: nifty.rsi != null ? Math.round(nifty.rsi) : null,
      asOf: new Date().toISOString(),
    };
    _regimeCache = { data, ts: Date.now() };
    return data;
  } catch {
    return _regimeCache.data || null;
  }
}

// True when fresh entries should be blocked globally (15:00 IST onward).
export function freshEntriesAllowedNow() {
  return istMinutes() < 15 * 60;
}

// ------------------------------------------------------------
// 2026-09 multi-market pass — CRYPTO regime (BTC-based).
// Same shape as the NIFTY regime so the engine + frontend render
// one unified banner: regime / change / vwapDist / rsi. The "VIX"
// slot maps to BTC 24h volatility (labelled 'HIGH' when |24h| > 4%).
// Source: TV crypto scanner BINANCE:BTCUSDT (60s cache, degradable).
// ------------------------------------------------------------
let _cryptoRegimeCache = { data: null, ts: 0 };

async function fetchCryptoRegimeFromTV() {
  const res = await fetch(`https://scanner.tradingview.com/crypto/scan?t=${Date.now()}`, {
    method: 'POST',
    headers: TV_SCAN_HEADERS,
    body: JSON.stringify({
      symbols: { tickers: ['BINANCE:BTCUSDT'] },
      columns: ['close', 'change', 'VWAP', 'EMA20', 'RSI'],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const row = (data?.data || []).find(r => r.s === 'BINANCE:BTCUSDT');
  if (!row || !row.d) return null;
  const pf = (v) => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : null;
  return { close: pf(row.d[0]), change: pf(row.d[1]), vwap: pf(row.d[2]), ema20: pf(row.d[3]), rsi: pf(row.d[4]) };
}

/**
 * CRYPTO regime: { market:'CRYPTO', regime, vix, vixLevel, btcChange,
 * btcVwapDist, btcRsi, asOf } | null — same keys the NIFTY payload
 * exposes under nifty* names, mirrored as btc* for the crypto banner.
 */
export async function getCryptoRegime(debug = false) {
  if (!debug && _cryptoRegimeCache.data && Date.now() - _cryptoRegimeCache.ts < REGIME_CACHE_MS) {
    return _cryptoRegimeCache.data;
  }
  try {
    const btc = await fetchCryptoRegimeFromTV();
    if (!btc || !(btc.close > 0)) return _cryptoRegimeCache.data || null;

    const btcChange = btc.change ?? 0;
    const btcVwapDist = btc.vwap > 0 ? ((btc.close - btc.vwap) / btc.vwap) * 100 : 0;
    const aboveEma = btc.ema20 != null ? btc.close > btc.ema20 : null;

    let regime = 'NEUTRAL';
    if (btcVwapDist > 0.2 && btcChange > 0.3 && aboveEma !== false) regime = 'BULLISH';
    else if (btcVwapDist < -0.2 && btcChange < -0.3 && aboveEma !== true) regime = 'BEARISH';
    else if (Math.abs(btcChange) > 1.2 && btcVwapDist > 0.35) regime = 'BULLISH';
    else if (Math.abs(btcChange) > 1.2 && btcVwapDist < -0.35) regime = 'BEARISH';

    // 24h move magnitude as the crypto "volatility" gauge (no VIX for BTC).
    const vol = Math.abs(btcChange);
    const vixLevel = vol > 4 ? 'HIGH' : vol >= 2 ? 'ELEVATED' : 'LOW';

    const data = {
      market: 'CRYPTO',
      regime,
      vix: +vol.toFixed(2),       // |24h %| — displayed as BTC 24h volatility
      vixLevel,
      btcChange: +btcChange.toFixed(2),
      btcVwapDist: +btcVwapDist.toFixed(2),
      btcRsi: btc.rsi != null ? Math.round(btc.rsi) : null,
      asOf: new Date().toISOString(),
    };
    _cryptoRegimeCache = { data, ts: Date.now() };
    return data;
  } catch {
    return _cryptoRegimeCache.data || null;
  }
}
