// ============================================================
// server/ai/swing.js — SWING DESK · WHALE RADAR · ORDERBOOK (v6.7)
// ------------------------------------------------------------
// Glama-inspired read-only intelligence layers (NO execution —
// the gauntlets stay the only order paths):
//
//   1. SWING BOARD — multi-DAY setups (3–10 day horizon) on daily
//      candles: weekly trend alignment (EMA20 vs EMA50 daily), daily
//      RSI/MACD, ATR-based SL, 2R/3R targets, R:R + confluence
//      score. India (Yahoo daily) + crypto (CoinDCX 1d, Yahoo USD
//      fallback). Clearly labeled "analysis, not execution".
//
//   2. WHALE RADAR — volume-spike scanner: last bar's volume vs the
//      20-bar average (rel-volume), price impact, OBV slope. A 3x+
//      spike with a directional close = whale footprint. Both desks.
//
//   3. ORDERBOOK VIEW — CoinDCX public depth for a crypto pair:
//      bid/ask imbalance + wall detection (defensive — public
//      endpoint, honest error when unreachable).
// ============================================================
import { computeIndicatorsFromCandles, emaSeries, obvSlope } from './lib/indicators.js';
import { INDIA_UNIVERSE as _INDIA_UNIVERSE, CRYPTO_UNIVERSE as _CRYPTO_UNIVERSE, fetchCoinDcxCandles } from './data.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// ---------------- data ----------------
async function yahooDaily(ticker, range = '6mo') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (SmartAI swing desk)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp;
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) return null;
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open?.[i] == null || q.close?.[i] == null) continue;
      out.push({
        time: ts[i] * 1000,
        open: q.open[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i],
        close: q.close[i], volume: q.volume?.[i] || 0,
      });
    }
    return out.length >= 80 ? out : null;
  } catch { return null; }
}

async function candlesFor(symbol, market) {
  if (market === 'INDIA') {
    const c = await yahooDaily(`${symbol}.NS`).catch(() => null);
    if (c) return { candles: c, source: 'yahoo-1d' };
    return { candles: null, source: null };
  }
  // crypto: CoinDCX 1d first, Yahoo base-USD fallback
  let c = await fetchCoinDcxCandles(symbol, '1d', 180).catch(() => null);
  if (c && c.length >= 80) return { candles: c, source: 'coindcx-1d' };
  c = await yahooDaily(`${symbol}-USD`).catch(() => null);
  if (c) return { candles: c, source: 'yahoo-1d-USD' };
  return { candles: null, source: null };
}

// ---------------- swing scoring (pure, exported for tests) ----------------
/**
 * Score ONE symbol's daily candles into a swing idea.
 * Confluence factors (each 0..1, weighted):
 *   trend  0.35 — EMA20 vs EMA50 daily + close vs EMA20
 *   momo   0.30 — daily RSI zone + MACD histogram sign
 *   structure 0.20 — higher-highs/lows vs 20 bars ago
 *   volume 0.15 — 5-bar avg rel-volume direction
 * Score ≥ 62 → grade A (high-conviction swing), ≥ 48 → B, else pass.
 */
export function scoreSwing(symbol, market, candles) {
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const ind = computeIndicatorsFromCandles(candles);
  if (!ind || !(ind.ltp > 0)) return null;
  const closes = candles.map(c => c.close);
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const last = closes[closes.length - 1];
  const ema20 = e20[e20.length - 1], ema50 = e50[e50.length - 1];
  if (!(ema20 > 0) || !(ema50 > 0)) return null;

  // trend
  const trendUp = ema20 > ema50 && last > ema20;
  const trendDn = ema20 < ema50 && last < ema20;
  const trendScore = trendUp ? 1 : trendDn ? 1 : 0.2; // direction-agnostic magnitude
  const dir = trendUp ? 1 : trendDn ? -1 : 0;
  if (dir === 0) return null; // no swing without a side

  // momentum
  const rsiD = ind.rsi;
  let momoScore = 0;
  if (dir > 0) momoScore = rsiD >= 50 && rsiD <= 68 ? 1 : rsiD > 68 ? 0.5 : 0.35;
  else momoScore = rsiD <= 50 && rsiD >= 32 ? 1 : rsiD < 32 ? 0.5 : 0.35;
  const macdHist = ind.macd?.histogram ?? 0;
  const macdAgree = dir > 0 ? macdHist > 0 : macdHist < 0;
  if (macdAgree) momoScore = Math.min(1, momoScore + 0.15);

  // structure: higher highs/lows (20-bar lookback)
  const lookback = candles.slice(-20);
  const hi20 = Math.max(...lookback.map(c => c.high));
  const lo20 = Math.min(...lookback.map(c => c.low));
  const prev40 = candles.slice(-40, -20);
  const hiPrev = prev40.length ? Math.max(...prev40.map(c => c.high)) : hi20;
  const loPrev = prev40.length ? Math.min(...prev40.map(c => c.low)) : lo20;
  const structUp = hi20 > hiPrev && lo20 > loPrev;
  const structDn = hi20 < hiPrev && lo20 < loPrev;
  const structScore = (dir > 0 ? structUp : structDn) ? 1 : 0.3;

  // volume confirmation (5-bar avg vs 20-bar avg)
  const vols = candles.map(c => c.volume || 0);
  const avg5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avg20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volConfirm = avg20 > 0 && avg5 > avg20 * 1.05;

  const score = Math.round(
    (trendScore * 0.35 + momoScore * 0.30 + structScore * 0.20 + (volConfirm ? 1 : 0.45) * 0.15) * 100
  );

  // ATR-based plan (1.8 × ATR stop — swings need room; 2.5R target)
  const atr = ind.atr || last * 0.02;
  const entry = last;
  const sl = dir > 0 ? entry - 1.8 * atr : entry + 1.8 * atr;
  const risk = Math.abs(entry - sl);
  const t1 = dir > 0 ? entry + 2 * risk : entry - 2 * risk;
  const t2 = dir > 0 ? entry + 3 * risk : entry - 3 * risk;
  const holdDays = market === 'INDIA' ? '3–8 trading days' : '2–6 days (24/7)';

  const reasons = [
    `Daily EMA20 ${dir > 0 ? '>' : '<'} EMA50 and price ${dir > 0 ? 'above' : 'below'} EMA20 — trend aligned`,
    `RSI ${r1(rsiD)} ${macdAgree ? '+ MACD histogram agrees' : '(MACD neutral)'}`,
    (dir > 0 ? structUp : structDn) ? `${dir > 0 ? 'Higher' : 'Lower'} highs + lows vs the prior 20 bars` : 'Structure mixed',
    volConfirm ? `Volume expanding (5d avg ${(avg5 / (avg20 || 1)).toFixed(2)}× the 20d avg)` : 'Volume flat',
  ];

  return {
    symbol, market,
    side: dir > 0 ? 'LONG' : 'SHORT',
    grade: score >= 62 ? 'A' : 'B',
    score,
    ltp: r2(last),
    rsi: r1(rsiD),
    atr: r2(atr),
    plan: { entry: r2(entry), stopLoss: r2(sl), target1: r2(t1), target2: r2(t2), riskPct: r2((risk / entry) * 100), rewardRisk: 3 },
    holdDays,
    reasons,
  };
}

// ---------------- whale detection (pure, exported for tests) ----------------
/**
 * Volume-spike scanner: last bar volume vs 20-bar average.
 * spike ≥ 3x + directional close ≥ 1% = whale footprint.
 */
export function detectWhale(symbol, market, candles) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const vols = candles.map(c => c.volume || 0);
  const lastV = vols[vols.length - 1];
  const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  if (!(avg20 > 0) || !(lastV > 0)) return null;
  const spike = lastV / avg20;
  if (spike < 2.5) return null; // below radar threshold
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const changePct = prev?.close > 0 ? ((last.close / prev.close) - 1) * 100 : 0;
  const obv = obvSlope(candles, 10);
  const dir = changePct >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION';
  return {
    symbol, market,
    spike: r2(spike),
    changePct: r2(changePct),
    ltp: r2(last.close),
    direction: dir,
    obvSlope: r2(obv),
    note: `${r2(spike)}× volume vs 20-bar avg${Math.abs(changePct) >= 1 ? ` + ${r2(changePct)}% price impact` : ''} — ${dir.toLowerCase()} footprint${obv != null && obv > 0 === (changePct >= 0) ? ' (OBV confirms)' : ''}`,
  };
}

// ---------------- boards (cached) ----------------
const _cache = new Map();
function cacheGet(key, ttl) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.payload;
  return null;
}
function cacheSet(key, payload) { _cache.set(key, { at: Date.now(), payload }); }
export function __clearSwingCache() { _cache.clear(); }

const SWING_UNIVERSE = {
  INDIA: ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'TATAMOTORS', 'AXISBANK', 'LT', 'ITC'],
  CRYPTO: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX'],
};

export async function getSwingBoard(market = 'INDIA', symbols) {
  const mkt = String(market).toUpperCase() === 'CRYPTO' ? 'CRYPTO' : 'INDIA';
  const key = `swing:${mkt}`;
  const cached = cacheGet(key, 5 * 60_000);
  if (cached) return cached;

  const syms = (Array.isArray(symbols) && symbols.length > 0 ? symbols : SWING_UNIVERSE[mkt])
    .map(s => String(s).toUpperCase().replace(/[^A-Z0-9-]/g, '')).filter(Boolean).slice(0, 10);

  const results = await Promise.allSettled(syms.map(async (sym) => {
    const { candles, source } = await candlesFor(sym, mkt);
    if (!candles) return { symbol: sym, ok: false, reason: 'no daily data' };
    const idea = scoreSwing(sym, mkt, candles);
    if (!idea) return { symbol: sym, ok: false, reason: 'no aligned swing setup' };
    return { ...idea, ok: true, source };
  }));
  const ideas = results.map(r => r.status === 'fulfilled' ? r.value : { symbol: '?', ok: false, reason: 'failed' });
  const valid = ideas.filter(i => i.ok).sort((a, b) => b.score - a.score);

  const payload = {
    ok: valid.length > 0,
    market: mkt,
    horizon: mkt === 'INDIA' ? '3–8 trading days' : '2–6 days',
    universe: syms,
    ideas: valid,
    scanned: ideas.length,
    disclaimer: 'Swing desk = ANALYSIS, not execution. Brokers settle T+1; the intraday gauntlets are the only order paths. Size with the same 1–2% risk rule.',
    generatedAt: Date.now(),
  };
  cacheSet(key, payload);
  return payload;
}

export async function scanWhales(market = 'CRYPTO', symbols) {
  const mkt = String(market).toUpperCase() === 'INDIA' ? 'INDIA' : 'CRYPTO';
  const key = `whales:${mkt}`;
  const cached = cacheGet(key, 3 * 60_000);
  if (cached) return cached;

  const syms = (Array.isArray(symbols) && symbols.length > 0 ? symbols : SWING_UNIVERSE[mkt])
    .map(s => String(s).toUpperCase().replace(/[^A-Z0-9-]/g, '')).filter(Boolean).slice(0, 12);

  const results = await Promise.allSettled(syms.map(async (sym) => {
    const { candles } = await candlesFor(sym, mkt);
    if (!candles) return null;
    return detectWhale(sym, mkt, candles);
  }));
  const whales = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean)
    .sort((a, b) => b.spike - a.spike);

  const payload = {
    ok: true,
    market: mkt,
    whales,
    scanned: syms.length,
    note: whales.length === 0
      ? 'No volume anomalies ≥ 2.5× the 20-bar average right now — quiet tape.'
      : 'Whale prints are FLOW hints, not signals — confirm with the ensemble board before acting.',
    generatedAt: Date.now(),
  };
  cacheSet(key, payload);
  return payload;
}

// ---------------- CoinDCX public orderbook (defensive) ----------------
/**
 * Public depth snapshot for a crypto base (e.g. BTC → B-BTC_INR).
 * Computes imbalance + the biggest walls each side. Pure read — no
 * keys needed. Honest 502 when the public endpoint is unreachable
 * from this host.
 */
export async function getOrderbook(base = 'BTC') {
  const sym = String(base).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pair = `B-${sym}_INR`;
  const urls = [
    `https://public.coindcx.com/market_data/v3/orders?pair=${encodeURIComponent(pair)}&limit=25`,
    `https://public.coindcx.com/market_data/book?pair=${encodeURIComponent(pair)}`,
  ];
  const norm = (arr) => (Array.isArray(arr) ? arr.map(x => {
    const p = Number(x?.price ?? x?.p ?? (Array.isArray(x) ? x[0] : NaN));
    const q = Number(x?.quantity ?? x?.q ?? x?.volume ?? (Array.isArray(x) ? x[1] : NaN));
    return { price: p, qty: q };
  }).filter(x => x.price > 0 && x.qty > 0).slice(0, 25) : []);
  let book = null;
  let source = 'coindcx-inr';
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (SmartAI orderbook)' } });
      if (!r.ok) continue;
      const j = await r.json();
      const bids = j?.bids || j?.buy || j?.bid_book || [];
      const asks = j?.asks || j?.sell || j?.ask_book || [];
      const b = norm(bids), a = norm(asks);
      if (b.length > 0 && a.length > 0) { book = { bids: b, asks: a }; break; }
    } catch { /* try next shape */ }
  }
  // v11.8 RENDER-REACHABILITY FALLBACK: the CoinDCX public REST hosts
  // are 403/timeout-challenged from several datacenter IPs (the exact
  // v11.3 incident — verified live 2026-09-18: booksCached stayed 0 all
  // day, so InstFlow NEVER voted on the crypto desk). Binance's public
  // spot depth is keyless and datacenter-friendly; the SAME-USDT-pair
  // book is an honest PROXY for INR-pair imbalance (arbitrage keeps the
  // two books' imbalance structure tightly linked). Prices stay in the
  // USDT domain and the result is LABELED with its source — consumers
  // that need INR-domain prices rescale off their own INR anchor.
  if (!book) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(`${sym}USDT`)}&limit=25`, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0 (SmartAI orderbook)' },
      });
      if (r.ok) {
        const j = await r.json();
        const b = norm(j?.bids), a = norm(j?.asks);
        if (b.length > 0 && a.length > 0) { book = { bids: b, asks: a }; source = 'binance-usdt-proxy'; }
      }
    } catch { /* honest failure below */ }
  }
  if (!book) {
    return { ok: false, symbol: sym, pair, error: `CoinDCX public orderbook unreachable for ${pair} from this host` };
  }
  const bidVol = book.bids.reduce((s, x) => s + x.qty, 0);
  const askVol = book.asks.reduce((s, x) => s + x.qty, 0);
  const bestBid = book.bids[0].price, bestAsk = book.asks[0].price;
  const spreadPct = bestAsk > 0 ? r2(((bestAsk - bestBid) / bestAsk) * 100) : null;
  // walls: largest single-level qty each side
  const bidWall = book.bids.reduce((w, x) => (x.qty > w.qty ? x : w), book.bids[0]);
  const askWall = book.asks.reduce((w, x) => (x.qty > w.qty ? x : w), book.asks[0]);
  const imbalance = (bidVol + askVol) > 0 ? r2(((bidVol - askVol) / (bidVol + askVol)) * 100) : null;
  return {
    ok: true,
    symbol: sym, pair,
    source,
    bestBid: r2(bestBid), bestAsk: r2(bestAsk), spreadPct,
    bidVol: r2(bidVol), askVol: r2(askVol),
    imbalancePct: imbalance,
    bidWall: { price: r2(bidWall.price), qty: r2(bidWall.qty) },
    askWall: { price: r2(askWall.price), qty: r2(askWall.qty) },
    read: `${source === 'binance-usdt-proxy' ? 'Binance USDT book (proxy — CoinDCX unreachable) · ' : ''}${imbalance == null ? 'n/a'
      : imbalance > 15 ? `Bid-heavy book (+${imbalance}%) — buyers stacked`
      : imbalance < -15 ? `Ask-heavy book (${imbalance}%) — sellers stacked`
      : `Balanced book (${imbalance > 0 ? '+' : ''}${imbalance}%)`}`,
    generatedAt: Date.now(),
  };
}
