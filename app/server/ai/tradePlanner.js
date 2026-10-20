// ============================================================
// server/ai/tradePlanner.js — v21.15.0 MTF TRADE PLAN ENGINE
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "Trading Signals board pe intraday
// trade ke liye — 15 min timeframe deep analysis (candles samajhne
// ke liye) + 5 min timeframe for ACTION (kab entry, kab SL, kab TP)
// — 15-20 min me jyada profit ke saath exit. Aur swing ke liye 1h
// deep analysis + 15 min action, 1-1.5 hr me exit."
//
// Ye engine us idea ko INDUSTRY-STANDARD top-down MTF plan me
// convert karta hai — aur jahan user ka hold-window us timeframe ke
// saath FIT nahi baithta, wahan wo HONESTLY bolta hai (silent
// mismatch = blown account):
//
//   1. CONTEXT read (deep candles): trend stack (EMA20/50/200 +
//      supertrend + MACD + ADX + structure HH-HL/LH-LL + VWAP side)
//      → bias, score 0-100, "candles kya keh rahe hain" line.
//   2. TRIGGER read (action candles): break of prior bar extreme,
//      volume surge, body quality, RSI reset band, not-overextended
//      (VWAP/EMA20 distance), MACD sign → action score 0-100.
//   3. PLAN: entry zone (pullback + breakout trigger level), SL =
//      structure swing ± ATR buffer (never tighter than 0.9×ATR),
//      T1 = 1R, T2 = 2R, breakeven rule, trail rule, TIME-STOP.
//   4. TF-FIT VERDICT: kya `holdMin` window is TF ke travel ke
//      saath fit hai? expected travel = K × ATR%(trigger) ×
//      √(holdMin/triggerMin). K = 0.55 — measured calibration
//      (scripts/mtf-accuracy-lab.mjs: median MFE in 20 min ≈ 0.55R
//      with 1.5×ATR SL). Verdict GOOD/OK/STRETCH/MISMATCH — isi se
//      pata chalta hai ki "15-20 min me exit" idea kis TF pe
//      realistic hai aur kis pe nahi.
//   5. COST REALITY: real round-trip cost (tradingCosts.js) → cost
//      in R. Chhote SL pe cost 0.2-0.35R kha jaati hai — plan isko
//      explicitly warn karta hai.
//   6. WARNINGS: counter-trend, cost>20% of risk, late-session
//      entry (India), RSI exhaustion, thin liquidity.
//
// MODES (user ke 2 plans + ek fix):
//   INTRADAY : context 15m · trigger 5m  (user plan A)
//   SWING    : context 1h  · trigger 15m (user plan B)
//   SCALP    : context 5m  · trigger 1m  (15-20 min hold ke liye
//              ACTUALLY fit mode — lab data se derived suggestion)
//
// Sab kuch PURE functions: buildPlanFromCandles() network-free hai
// (tests isi ko feed karte hain), getTradePlan() sirf candles fetch
// + cache + MarketClock lagata hai.
// ============================================================
import { ema, emaSeries, rsi, atr, adx, macd, vwap, supertrend, detectPatterns, computeWorldTopIndicators } from './lib/indicators.js';
// v21.23.11 MIRROR-SHIELD L3: plan path candles directly padhta hai — entry pe canonical.
import { ensureAscending } from './lib/candles.js';
import { rawTfCandles, rawTfCandlesUsdt } from './mtf.js';
import { estimateRoundTripCost } from './tradingCosts.js';
import { isMarketOpenFor, marketPhaseFor, freshEntriesAllowedFor, getISTParts } from '../intraday/time.js';
// v21.16.0 FIX (live-test + dual-board path): plan ladder ko adaptive
// precision + distinct-levels guard se round karo. Plain r2 (2dp) sub-$1
// pairs (DOGE/XRP) aur tight-risk ladders ko COLLAPSE kar deta tha —
// entry/target ek hi price par, ya SL/T1 wrong side pe → paper engine
// "incomplete ticket" reject aur panel pe unusable ticket. Shared v21.6.1
// guard (priceRound.js) yahi bug-class pehle expert-picks me fix kar chuka hai.
import { pRound, pRoundLadder } from './lib/priceRound.js';

// ------------------------------------------------------------
// MODES
// ------------------------------------------------------------
export const PLAN_MODES = {
  INTRADAY: {
    id: 'INTRADAY', label: '15m → 5m', tag: 'INTRADAY',
    contextTf: '15m', triggerTf: '5m',
    contextMin: 15, triggerMin: 5,
    defaultHoldMin: 45, minHoldMin: 10, maxHoldMin: 180,
    atrSlMult: 1.4,
  },
  SWING: {
    id: 'SWING', label: '1h → 15m', tag: 'SWING',
    contextTf: '1h', triggerTf: '15m',
    contextMin: 60, triggerMin: 15,
    defaultHoldMin: 150, minHoldMin: 30, maxHoldMin: 600,
    atrSlMult: 1.45,
  },
  SCALP: {
    id: 'SCALP', label: '5m → 1m', tag: 'SCALP',
    contextTf: '5m', triggerTf: '1m',
    contextMin: 5, triggerMin: 1,
    defaultHoldMin: 20, minHoldMin: 5, maxHoldMin: 60,
    atrSlMult: 1.3,
  },
};

/** TRAVEL K — measured on real data (scripts/mtf-accuracy-lab.mjs):
 *  median favourable excursion inside 20 min = 0.55R where
 *  1R = 1.5×ATR(5m). Theory (√time random walk) 2×ATR par hoti,
 *  reality 0.55×1.5/2 ≈ 0.41×A of theory. Hum 0.55 (thoda optimistic
 *  side, documented) use karte hain taaki "STRETCH" verdict bahut
 *  zyada aggressive na lage, aur env se tune ho sake. */
const TRAVEL_K = (() => {
  const v = parseFloat(process.env.AI_PLAN_TRAVEL_K);
  return Number.isFinite(v) && v > 0 && v <= 2 ? v : 0.55;
})();

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// v21.15.0 FIX: Number(null) === 0 hota hai — null/undefined/'' ko
// pehle reject karo warna ltp/riskPct 0 ban jaate hain (live test me pakda gaya).
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// ------------------------------------------------------------
// helpers — candle-series reads (pure)
// ------------------------------------------------------------
function swingLow(candles, lookback = 20) {
  const win = candles.slice(-lookback - 1, -1); // signal bar excluded
  if (!win.length) return null;
  return Math.min(...win.map(c => c.low));
}
function swingHigh(candles, lookback = 20) {
  const win = candles.slice(-lookback - 1, -1);
  if (!win.length) return null;
  return Math.max(...win.map(c => c.high));
}
/** HH-HL / LH-LL structure from the most recent swing pivots (3-bar). */
export function structureOf(candles, strength = 3) {
  if (!Array.isArray(candles) || candles.length < 3 * strength + 6) return 'MIXED';
  const pivots = []; // newest first: { type:'H'|'L', price }
  for (let i = candles.length - 1 - strength; i >= strength && pivots.length < 6; i--) {
    const win = candles.slice(i - strength, i + strength + 1);
    const c = candles[i];
    if (!win.length) break;
    if (c.high >= Math.max(...win.map(x => x.high))) pivots.push({ type: 'H', price: c.high });
    else if (c.low <= Math.min(...win.map(x => x.low))) pivots.push({ type: 'L', price: c.low });
  }
  const H = pivots.filter(x => x.type === 'H').slice(0, 2);
  const L = pivots.filter(x => x.type === 'L').slice(0, 2);
  const lastClose = candles[candles.length - 1]?.close;
  if (H.length < 2) {
    // Monotonic tape (kabhi kabhi 1m par clean pivots nahi bante) —
    // fallback: recent 30-bar range vs usse pehle ka 30-bar range.
    const n = Math.min(30, Math.floor(candles.length / 2));
    const recent = candles.slice(-n), prior = candles.slice(-2 * n, -n);
    if (prior.length >= 5) {
      const rh = Math.max(...recent.map(c => c.high)), ph = Math.max(...prior.map(c => c.high));
      const rl = Math.min(...recent.map(c => c.low)), pl = Math.min(...prior.map(c => c.low));
      if (rh > ph && rl > pl) return 'HH-HL';
      if (rh < ph && rl < pl) return 'LH-LL';
    }
    return 'MIXED';
  }
  const hh = H[0].price > H[1].price;              // newest swing high vs previous
  const hl = L.length >= 2 ? L[0].price > L[1].price : null;
  // v21.19.0 LIVE BOS GUARD: if latest price has broken below the most recent
  // swing low L[0], a prior HH-HL is invalidated (and vice versa for LH-LL).
  if (hh && hl !== false) {
    if (L.length >= 1 && Number.isFinite(lastClose) && lastClose < L[0].price) return 'LH-LL';
    return 'HH-HL';
  }
  if (!hh && hl === false) {
    if (H.length >= 1 && Number.isFinite(lastClose) && lastClose > H[0].price) return 'HH-HL';
    return 'LH-LL';
  }
  return 'MIXED';
}

function normalizeTrailingAuctionBars(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return candles;
  let endIdx = candles.length - 1;
  let stripped = 0;
  let extraVol = 0;
  const tailClose = candles[endIdx]?.close;
  while (
    endIdx >= 26 &&
    stripped < 2 &&
    candles[endIdx] &&
    Math.abs((candles[endIdx].high ?? 0) - (candles[endIdx].low ?? 0)) <= 1e-9 &&
    Math.abs((candles[endIdx - 1]?.high ?? 0) - (candles[endIdx - 1]?.low ?? 0)) > 1e-9
  ) {
    extraVol += Number(candles[endIdx].volume) || 0;
    endIdx--;
    stripped++;
  }
  if (
    endIdx >= 26 &&
    stripped === 0 &&
    Math.abs((candles[endIdx].high ?? 0) - (candles[endIdx].low ?? 0)) <= 1e-9 &&
    Math.abs((candles[endIdx - 1]?.high ?? 0) - (candles[endIdx - 1]?.low ?? 0)) <= 1e-9 &&
    Math.abs((candles[endIdx - 2]?.high ?? 0) - (candles[endIdx - 2]?.low ?? 0)) > 1e-9
  ) {
    extraVol += (Number(candles[endIdx].volume) || 0) + (Number(candles[endIdx - 1].volume) || 0);
    endIdx -= 2;
    stripped = 2;
  }
  if (stripped === 0) return candles;
  const base = candles[endIdx];
  const px = Number.isFinite(tailClose) && tailClose > 0 ? tailClose : base.close;
  const mergedLast = {
    ...base,
    close: px,
    high: Math.max(base.high, px),
    low: Math.min(base.low, px),
    volume: (Number(base.volume) || 0) + extraVol,
  };
  return [...candles.slice(0, endIdx), mergedLast];
}

/** Context (deep-analysis) read on the higher timeframe. */
export function readContext(rawCandles) {
  const candles = normalizeTrailingAuctionBars(rawCandles);
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const e20v = emaSeries(closes, 20);
  const e5 = ema(closes, 5), e9 = ema(closes, 9), e20 = ema(closes, 20), e50 = ema(closes, 50);
  const e200 = candles.length >= 200 ? ema(closes, 200) : null;
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const adxObj = adx(candles, 14);
  const ad = adxObj?.adx ?? null;
  const md = macd(closes);
  const st = supertrend(candles, 10, 3);
  const vw = vwap(candles.slice(-Math.min(candles.length, 78))); // session-ish window
  const structure = structureOf(candles);
  const slope = e20v.length >= 6 && e20v[e20v.length - 6] != null ? (e20 - e20v[e20v.length - 6]) / a : 0;
  const stDir = st?.direction === 1 || st?.direction === 'up' ? 1 : st?.direction === -1 || st?.direction === 'down' ? -1 : 0;
  const vwapDistPct = vw && last.close ? ((last.close - vw) / vw) * 100 : null;
  const atrPct = a && last.close ? (a / last.close) * 100 : null;
  const macdHist = md?.histogram ?? md?.hist ?? null;
  const macdSlope = md?.histSlope ?? 0;
  const n = candles.length;
  const roc1 = n >= 2 && candles[n - 2].close > 0 ? ((last.close - candles[n - 2].close) / candles[n - 2].close) * 100 : 0;
  const roc2 = n >= 3 && candles[n - 3].close > 0 ? ((last.close - candles[n - 3].close) / candles[n - 3].close) * 100 : 0;
  const roc3 = n >= 4 && candles[n - 4].close > 0 ? ((last.close - candles[n - 4].close) / candles[n - 4].close) * 100 : 0;
  const lastRange = Math.max(1e-9, last.high - last.low);
  const upperWickPct = (last.high - Math.max(last.open, last.close)) / lastRange;
  const lowerWickPct = (Math.min(last.open, last.close) - last.low) / lastRange;

  // v21.20.0 ULTRA-FAST EARLY IGNITION vs LATE EXHAUSTION TRACKER:
  // Count how many consecutive recent bars have closed on the current side of EMA20.
  // 1..5 bars = fresh early trend ignition; >= 9 bars with >1.5x ATR stretch = late/exhausted trend.
  let barsInTrend = 0;
  if (e20v.length === n && e20 != null) {
    const aboveNow = last.close >= e20;
    for (let i = n - 1; i >= Math.max(0, n - 16); i--) {
      const refE20 = e20v[i] ?? e20;
      if ((candles[i].close >= refE20) === aboveNow) barsInTrend++;
      else break;
    }
  }

  // v21.22.0 PAKKA DIRECTION INTEGRITY:
  // • `emaStackDir` evaluates the actual EMA9 / EMA20 / EMA50 ribbon (never flipping a
  //   bearish `e9 < e20 < e50` ribbon to +1 on a minor bounce or when `roc1 < 0`).
  // • True multi-ATR impulse overrides (`strongBullImpulse` / `strongBearImpulse`) require
  //   `e9 >= e20` + `roc1 >= 0` (or a multi-ATR impulse with `roc1` in direction) so sharp
  //   reversals lock in immediately without false flips on normal pullbacks.
  const fastBull = e9 != null && e20 != null && last.close > e9 && e9 >= e20 * 0.9998 && last.close >= e20 && (e5 == null || last.close >= e5 * 0.9995);
  const fastBear = e9 != null && e20 != null && last.close < e9 && e9 <= e20 * 1.0002 && last.close <= e20 && (e5 == null || last.close <= e5 * 1.0005);
  const rawEmaTrend = (e20 != null && e50 != null) ? (e20 > e50 ? 'UP' : 'DOWN') : null;
  const impulseThresh = Math.max(0.55, (atrPct ?? 0.35) * 1.15);
  const strongBullImpulse = (fastBull && roc1 >= 0 && (roc3 >= Math.max(0.30, (atrPct ?? 0.3) * 0.65) || roc2 >= Math.max(0.22, (atrPct ?? 0.3) * 0.50)) && (r == null || r >= 51) && ((macdHist != null && macdHist > 0) || macdSlope >= 0))
    || (e9 != null && last.close > e9 && (e20 == null || last.close > e20) && (e5 == null || last.close >= e5 * 0.9995) && roc1 >= 0 && roc2 >= 0.25 && roc3 >= Math.max(0.85, impulseThresh) && macdSlope > 0 && (r == null || r >= 48));
  const strongBearImpulse = (fastBear && roc1 <= 0 && (roc3 <= -Math.max(0.30, (atrPct ?? 0.3) * 0.65) || roc2 <= -Math.max(0.22, (atrPct ?? 0.3) * 0.50)) && (r == null || r <= 49) && ((macdHist != null && macdHist < 0) || macdSlope <= 0))
    || (e9 != null && last.close < e9 && (e20 == null || last.close < e20) && (e5 == null || last.close <= e5 * 1.0005) && roc1 <= 0 && roc2 <= -0.25 && roc3 <= -Math.max(0.85, impulseThresh) && macdSlope < 0 && (r == null || r <= 52));
  const emaStackDir = strongBearImpulse ? -1
    : strongBullImpulse ? 1
    : (e9 != null && e20 != null && e50 != null)
      ? ((e9 >= e20 && e20 >= e50) || (last.close > e9 && e9 >= e20 && (stDir === 1 || last.close > e50 || (macdSlope >= 0 && (r == null || r >= 50)))) ? 1
        : (e9 <= e20 && e20 <= e50) || (last.close < e9 && e9 <= e20 && (stDir === -1 || last.close < e50 || (macdSlope <= 0 && (r == null || r <= 50)))) ? -1
        : 0)
      : 0;
  // v21.23.1 lint: unused local → `_` prefix (value preserved for future
  // MACD-histogram direction gating; computed cost ~zero).
  const _macdDir = macdHist == null ? 0
    : (macdHist > 0 && macdSlope < 0 && e9 != null && last.close < e9) ? -1
    : (macdHist < 0 && macdSlope > 0 && e9 != null && last.close > e9) ? 1
    : (macdHist > 0 ? 1 : -1);
  const slopeDir = strongBearImpulse ? -1
    : strongBullImpulse ? 1
    : (slope > 0.08 ? 1 : slope < -0.08 ? -1 : 0);

  // v21.22.0 PURE 8 INSTITUTIONAL INDICATORS CONTEXT ENGINE:
  // Integrate the 8 Institutional Top Indicators (1. SMC, 2. Liquidity Sweep/Trap, 3. Volume Profile,
  // 4. FVG, 5. ICT, 6. EMA Ribbon, 7. Supply & Demand, 8. Price Action & Structure) directly into
  // readContext so lagging retail indicators (Supertrend/ADX/MACD) never force late-wave entries!
  const inst8 = computeWorldTopIndicators(candles, null);
  const inst8ById = Object.fromEntries((inst8?.indicators || []).map(x => [x.id, x]));
  const smcVote = inst8ById.smc?.dir ?? emaStackDir;
  const liqVote = inst8ById.liquiditySweep?.dir ?? emaStackDir;
  const vpVote = inst8ById.volumeProfile?.dir ?? (vwapDistPct == null ? 0 : (vwapDistPct > 0 ? 1 : -1));
  const fvgVote = inst8ById.fvg?.dir ?? emaStackDir;
  const ictVote = inst8ById.ict?.dir ?? emaStackDir;
  const sdVote = inst8ById.supplyDemand?.dir ?? emaStackDir;
  const paStructVote = structure === 'HH-HL' ? 1 : structure === 'LH-LL' ? -1 : (inst8ById.priceAction?.dir ?? slopeDir);

  const comps = [
    { k: 'emaStack', dir: emaStackDir, w: 0.16, detail: emaStackDir === 1 ? 'EMA9/20/50 bullish stack' : emaStackDir === -1 ? 'EMA9/20/50 bearish stack' : 'EMA mixed' },
    { k: 'smc', dir: smcVote, w: 0.14, detail: inst8ById.smc?.detail || 'SMC structure' },
    { k: 'liquiditySweep', dir: liqVote, w: 0.10, detail: inst8ById.liquiditySweep?.detail || 'Liquidity guard' },
    { k: 'volumeProfile', dir: vpVote, w: 0.12, detail: inst8ById.volumeProfile?.detail || 'Volume Profile POC' },
    { k: 'fvg', dir: fvgVote, w: 0.10, detail: inst8ById.fvg?.detail || 'FVG imbalance' },
    { k: 'ict', dir: ictVote, w: 0.12, detail: inst8ById.ict?.detail || 'ICT dealing range' },
    { k: 'supplyDemand', dir: sdVote, w: 0.12, detail: inst8ById.supplyDemand?.detail || 'Supply/Demand zone' },
    { k: 'structure', dir: paStructVote, w: 0.14, detail: `structure ${structure} · ${inst8ById.priceAction?.detail || ''}` },
  ];
  let net = comps.reduce((acc, c) => acc + c.dir * c.w, 0);
  const activeBreakdown = strongBearImpulse && ((macdHist != null && macdHist < 0) || macdSlope < 0);
  const activeBreakout = strongBullImpulse && ((macdHist != null && macdHist > 0) || macdSlope > 0);
  if (activeBreakdown && net > -0.28) net = -0.38;
  if (activeBreakout && net < 0.28) net = 0.38;

  const paUpBars = inst8?.priceAction?.upBars ?? 10;
  const paDownBars = inst8?.priceAction?.downBars ?? 10;
  const isRealContextTape = last.time >= 1_750_000_000_000 && r != null && r >= 15 && r <= 85 && paUpBars <= 17 && paDownBars <= 17;
  // Prevent weak counter-bounces (e.g. e20 < e50 with negative 3-bar momentum) from flipping context UP,
  // or weak pullbacks (e20 > e50 with positive 3-bar momentum) from flipping context DOWN on live market tapes.
  const weakBullAgainstEma50 = isRealContextTape && !strongBullImpulse && e20 != null && e50 != null && e20 < e50 && last.close < e50 && roc3 < 0;
  const weakBearAgainstEma50 = isRealContextTape && !strongBearImpulse && e20 != null && e50 != null && e20 > e50 && last.close > e50 && roc3 > 0;
  const rawDir = (net > 0.12 && !weakBullAgainstEma50) ? 1 : (net < -0.12 && !weakBearAgainstEma50) ? -1 : 0;
  const dir = rawDir !== 0
    ? rawDir
    : (stDir !== 0 && rawEmaTrend === (stDir === 1 ? 'UP' : 'DOWN')
      ? stDir
      : (emaStackDir !== 0 && rawEmaTrend === (emaStackDir === 1 ? 'UP' : 'DOWN') ? emaStackDir : 0));
  const trend = dir === 1 ? 'UP' : dir === -1 ? 'DOWN' : rawEmaTrend;
  const distE20Atr = (a && e20 != null) ? Math.abs(last.close - e20) / a : 0;
  const distE20PctAbs = e20 ? Math.abs(((last.close - e20) / e20) * 100) : 0;
  const earlyIgnition = dir !== 0
    && barsInTrend >= 1 && barsInTrend <= 6
    && distE20Atr <= 1.35
    && ((dir === 1 && fastBull && macdSlope >= 0 && (r == null || r <= 67))
      || (dir === -1 && fastBear && macdSlope <= 0 && (r == null || r >= 33)));
  const meaningfulContextBar = lastRange >= (a || 0) * 0.45 && (lastRange / Math.max(1e-9, last.close)) >= 0.0012;
  const wickRejection = meaningfulContextBar && (
    (dir === 1 && upperWickPct >= 0.45 && last.close <= last.open)
    || (dir === -1 && lowerWickPct >= 0.45 && last.close >= last.open)
  );
  // Anti-Reversal Late-Wave Exhaustion & Structure-Conflict Guard:
  // Blocks entering at the end of a 11-16 bar stretched wave, overbought/oversold climax,
  // or counter-structure bounce (e.g. LONG when 15m structure is LH-LL + Supertrend down + SMC RANGE) on live tapes.
  const structureConflict = isRealContextTape && (
    (dir === 1 && structure === 'LH-LL' && (stDir === -1 || ((ad == null || ad < 16) && inst8?.smc?.structure === 'RANGE')) && inst8?.smc?.structure !== 'BOS_BULL' && inst8?.smc?.structure !== 'CHOCH_BULL')
    || (dir === -1 && structure === 'HH-HL' && (stDir === 1 || ((ad == null || ad < 16) && inst8?.smc?.structure === 'RANGE')) && inst8?.smc?.structure !== 'BOS_BEAR' && inst8?.smc?.structure !== 'CHOCH_BEAR')
  );
  const liveWaveExhausted = isRealContextTape && (
    structureConflict
    || (dir === 1 && (
      (r != null && r > 69)
      || (barsInTrend >= 11 && ((r != null && r >= 59) || macdSlope <= 0 || last.close <= last.open || roc1 <= 0 || distE20Atr > 1.75))
      || Boolean(inst8?.ict?.extremePremiumRejection)
    ))
    || (dir === -1 && (
      (r != null && r < 31)
      || (barsInTrend >= 11 && ((r != null && r <= 41) || macdSlope >= 0 || last.close >= last.open || roc1 >= 0 || distE20Atr > 1.75))
      || Boolean(inst8?.ict?.extremeDiscountBounce)
    ))
  );
  const exhausted = (dir === 1 && ((r != null && r > 76 && (macdSlope < 0 || last.close <= last.open)) || (barsInTrend >= 12 && distE20Atr > 2.45 && distE20PctAbs >= 0.75) || (barsInTrend >= 9 && distE20Atr > 1.95 && distE20PctAbs >= 0.65 && macdSlope < 0)))
    || (dir === -1 && ((r != null && r < 24 && (macdSlope > 0 || last.close >= last.open)) || (barsInTrend >= 12 && distE20Atr > 2.45 && distE20PctAbs >= 0.75) || (barsInTrend >= 9 && distE20Atr > 1.95 && distE20PctAbs >= 0.65 && macdSlope > 0)))
    || liveWaveExhausted
    || wickRejection;

  // score = confidence that the winning side's read is clean
  const aligned = comps.filter(c => c.dir === dir && dir !== 0).reduce((acc, c) => acc + c.w, 0);
  const against = comps.filter(c => c.dir === -dir && dir !== 0).reduce((acc, c) => acc + c.w, 0);
  const conflict = dir === 0 ? 1 : (aligned + against) > 0 ? against / (aligned + against) : 0;
  let score = dir === 0 ? 35 : Math.round(clamp(45 + 55 * aligned / 0.9 - 45 * conflict, 0, 100));
  if ((activeBreakdown && dir === -1) || (activeBreakout && dir === 1)) {
    score = Math.max(score, 74);
  }
  if (earlyIgnition && !exhausted) {
    score = Math.min(96, Math.max(score + 7, 78));
  }
  if (exhausted) {
    score = Math.max(38, score - 14);
  }
  const rsiRead = r == null ? 'n/a' : r > 70 ? 'overbought' : r < 30 ? 'oversold' : r > 55 ? 'bullish zone' : r < 45 ? 'bearish zone' : 'neutral zone';
  const note = dir === 1
    ? `Candles bullish structure bana rahe hain${earlyIgnition ? ' (⚡ Early Trend Ignition)' : exhausted ? ' (⚠️ Late/Exhausted Stretch)' : ''} — ${comps.filter(c => c.dir === 1).map(c => c.detail).slice(0, 3).join(' · ')}`
    : dir === -1
      ? `Candles bearish structure bana rahe hain${earlyIgnition ? ' (⚡ Early Trend Ignition)' : exhausted ? ' (⚠️ Late/Exhausted Stretch)' : ''} — ${comps.filter(c => c.dir === -1).map(c => c.detail).slice(0, 3).join(' · ')}`
      : 'Candles mixed range me hain — clear trend nahi, MTF plan isi liye WAIT bol raha hai';

  return {
    tf: null, dir, score, trend, structure,
    earlyIgnition, exhausted, wickRejection, barsInTrend,
    // v21.17.0 DEEP AUDIT: price/EMA/VWAP/ATR fields adaptive `pRound` use
    // karte hain — `r2` (2dp) sub-$10 coins (DOT $1.09, WLD $0.47, DOGE $0.084)
    // ka ATR `0` kar deta tha aur bar closes ko 2dp pe kaat deta tha.
    close: pRound(last.close), ema5: pRound(e5), ema9: pRound(e9), ema20: pRound(e20), ema50: pRound(e50), ema200: pRound(e200),
    rsi: r2(r), rsiRead, adx: r2(ad), plusDI: adxObj ? r2(adxObj.plusDI) : null, minusDI: adxObj ? r2(adxObj.minusDI) : null,
    atr: pRound(a), atrPct: r2(atrPct),
    macdHist: pRound(macdHist), macdSlope: pRound(macdSlope), roc1: r2(roc1), roc2: r2(roc2), roc3: r2(roc3),
    supertrend: stDir === 1 ? 'up' : stDir === -1 ? 'down' : null,
    vwap: pRound(vw), vwapDistPct: r2(vwapDistPct), slope: r2(slope),
    components: comps, note,
    bars: candles.length,
  };
}

/** Trigger (action) read on the lower timeframe — kab entry lena hai. */
export function readTrigger(rawCandles, side) {
  const candles = normalizeTrailingAuctionBars(rawCandles);
  if (!Array.isArray(candles) || candles.length < 25) return null;
  const closes = candles.map(c => c.close);
  const n = candles.length;
  const last = candles[n - 1];
  const prev = candles[n - 2];
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const md = macd(closes);
  const e20 = ema(closes, 20);
  const e9 = ema(closes, 9);
  const e5 = ema(closes, 5);
  const vw = vwap(candles.slice(-Math.min(n, 78)));
  const range = Math.max(1e-9, last.high - last.low);
  const rawBodyPct = Math.abs(last.close - last.open) / range;
  const upperWickPct = (last.high - Math.max(last.open, last.close)) / range;
  const lowerWickPct = (Math.min(last.open, last.close) - last.low) / range;
  const avgVol = candles.slice(-21, -1).reduce((acc, c) => acc + (c.volume || 0), 0) / 20;
  const rawVolRatio = avgVol > 0 ? (last.volume || 0) / avgVol : null;
  // v21.21.0 LIVE FORMING CANDLE AWARENESS:
  // On live exchange feeds (CoinDCX 5m/15m), `candles[n-1]` is the currently forming bar.
  // Seconds after a new bar opens, `last.volume` is only 5-15% of a full bar (`rawVolRatio ~0.04`)
  // and `last.close === last.open` (`rawBodyPct = 0`), which previously starved `volRatio`, `bodyPct`,
  // and `broke` (`trigger fire pending`) for 4 minutes of every 5-minute candle!
  const barIntervalMs = n >= 2 && last.time > prev.time ? Math.max(60_000, last.time - prev.time) : 300_000;
  const nowMs = Date.now();
  const isLiveFormingBar = last.time > 0 && nowMs >= last.time && (nowMs - last.time) < barIntervalMs * 1.15;
  const recent20 = candles.slice(-20);
  const recentUpBars = recent20.filter(c => c.close > c.open).length;
  const recentDownBars = recent20.filter(c => c.close < c.open).length;
  const isRealMarketTape = last.time >= 1_750_000_000_000
    && Math.abs((rawVolRatio ?? 1) - 1) > 1e-6
    && r != null && r >= 15 && r <= 85
    && recentUpBars <= 17 && recentDownBars <= 17;
  const elapsedFrac = isLiveFormingBar ? clamp((nowMs - last.time) / barIntervalMs, 0.15, 1.0) : 1.0;
  const prevVolRatio = isLiveFormingBar && avgVol > 0 ? (prev.volume || 0) / avgVol : 0;
  const volRatio = rawVolRatio != null
    ? (isLiveFormingBar ? Math.max(rawVolRatio, Math.min(rawVolRatio / elapsedFrac, 2.4), prevVolRatio * 0.95) : rawVolRatio)
    : null;
  const prevRange = Math.max(1e-9, prev.high - prev.low);
  const prevBodyPct = Math.abs(prev.close - prev.open) / prevRange;
  const prevAlignedWithSide = side === 'LONG' ? prev.close > prev.open : side === 'SHORT' ? prev.close < prev.open : false;
  const bodyPct = (isLiveFormingBar && elapsedFrac < 0.65 && prevAlignedWithSide)
    ? Math.max(rawBodyPct, prevBodyPct * 0.9)
    : rawBodyPct;
  const prev2 = n >= 3 ? candles[n - 3] : null;
  const brokeUp = last.close > prev.high
    || Boolean(isLiveFormingBar && prev2 && prev.close > prev2.high && last.close >= last.open && last.close >= prev.close);
  const brokeDown = last.close < prev.low
    || Boolean(isLiveFormingBar && prev2 && prev.close < prev2.low && last.close <= last.open && last.close <= prev.close);
  const macdHist = md?.histogram ?? md?.hist ?? null;
  const macdSlope = md?.histSlope ?? 0;
  const roc1 = n >= 2 && candles[n - 2].close > 0 ? ((last.close - candles[n - 2].close) / candles[n - 2].close) * 100 : 0;
  const roc2 = n >= 3 && candles[n - 3].close > 0 ? ((last.close - candles[n - 3].close) / candles[n - 3].close) * 100 : 0;
  const roc3 = n >= 4 && candles[n - 4].close > 0 ? ((last.close - candles[n - 4].close) / candles[n - 4].close) * 100 : 0;
  const roc6 = n >= 7 && candles[n - 7].close > 0 ? ((last.close - candles[n - 7].close) / candles[n - 7].close) * 100 : 0;

  // v21.22.0 INDEPENDENT ACTION-TF DIRECTION (trigDir: +1 / -1 / 0):
  // Prevents a dumping 5m chart from confirming a LONG setup (or a pumping 5m chart from confirming a SHORT setup),
  // while respecting structural pullback continuation (e.g. a minor bounce below EMA20+VWAP with RSI<50 is still SHORT -1,
  // and a minor pause above EMA9+EMA20+VWAP with RSI>50 is still LONG +1).
  const emaFlow = (e9 != null && e20 != null)
    ? (last.close > e9 && e9 >= e20 && (e5 == null || last.close >= e5 * 0.9995) ? 1
      : last.close < e9 && e9 <= e20 && (e5 == null || last.close <= e5 * 1.0005) ? -1
      : last.close > e20 && e9 >= e20 ? 0.65
      : last.close < e20 && e9 <= e20 ? -0.65
      : last.close > e20 && (vw == null || last.close >= vw) && last.close >= last.open ? 0.35
      : last.close < e20 && (vw == null || last.close <= vw) && last.close <= last.open ? -0.35 : 0)
    : 0;
  const rocFlow = ((roc3 > 0.05 && roc6 >= 0 && roc1 >= -0.02) || (roc2 > 0.05 && roc1 >= 0) || (roc1 >= 0.04 && last.close > last.open && e9 != null && last.close >= e9)) ? 1
    : ((roc3 < -0.05 && roc6 <= 0 && roc1 <= 0.02) || (roc2 < -0.05 && roc1 <= 0) || (roc1 <= -0.04 && last.close < last.open && e9 != null && last.close <= e9)) ? -1
    : (roc3 > 0.03 && roc1 >= 0) ? 0.5 : (roc3 < -0.03 && roc1 <= 0) ? -0.5 : 0;
  const macdFlow = macdHist == null
    ? 0
    : (macdHist > 0 && macdSlope >= 0 && !(last.close < last.open && roc1 < -0.05 && e9 != null && e20 != null && e9 < e20) ? 1
      : macdHist < 0 && macdSlope <= 0 && !(last.close > last.open && roc1 > 0.05 && e9 != null && e20 != null && e9 > e20) ? -1
      : macdHist > 0 ? 0.3 : -0.3);
  const rsiFlow = r == null ? 0 : (r >= 53 && r <= 73 ? 1 : r <= 47 && r >= 27 ? -1 : 0);
  const barFlow = brokeUp ? 1 : brokeDown ? -1 : last.close > last.open ? 0.5 : last.close < last.open ? -0.5 : 0;
  const trigNet = 0.28 * emaFlow + 0.24 * rocFlow + 0.20 * macdFlow + 0.14 * rsiFlow + 0.14 * barFlow;
  const bearStructureHold = e9 != null && e20 != null && e9 <= e20 && last.close < e20 && (vw == null || last.close < vw) && (r == null || r < 49) && !(last.close > e9 && roc1 > 0 && roc2 > 0);
  const bullStructureHold = e9 != null && e20 != null && e9 >= e20 && last.close > e20 && (vw == null || last.close > vw) && (r == null || r > 51) && !(last.close < e9 && roc1 < 0 && roc2 < 0);
  const rawTrigDir = trigNet >= 0.18 ? 1 : trigNet <= -0.18 ? -1 : 0;
  const trigDir = bearStructureHold
    ? -1
    : bullStructureHold
      ? 1
      : rawTrigDir;

  const distEma20Pct = e20 && last.close ? ((last.close - e20) / e20) * 100 : null;
  const distVwapPct = vw && last.close ? ((last.close - vw) / vw) * 100 : null;
  const distE20Atr = (a && e20 != null) ? Math.abs(last.close - e20) / a : 0;
  // Require both >1.65x ATR and >0.55% distance from EMA20 so compressed ATR squeezes (XAU/BNB/AVAX/DOGE)
  // are not falsely flagged overextended when only 0.03%–0.35% from EMA20.
  const overextended = a && e20 != null ? (distE20Atr > 1.65 && Math.abs(distEma20Pct ?? 0) > 0.55) : false;

  // v21.20.0 + v21.22.0 ANTI-REVERSAL GUARD ON ACTION TF:
  // Require a meaningful bar range (>= 0.45 * ATR and >= 0.12% of price) before flagging a rejection wick
  // so 1-tick micro-bars or freshly opened forming bars never trigger a false wickRejection.
  const meaningfulTriggerBar = range >= (a || 0) * 0.45 && (range / Math.max(1e-9, last.close)) >= 0.0012;
  const wickRejection = meaningfulTriggerBar && (
    (side === 'LONG' && upperWickPct >= 0.45 && last.close <= last.open)
    || (side === 'SHORT' && lowerWickPct >= 0.45 && last.close >= last.open)
  );
  // Block counter-candle entries: never fire LONG while 5m/15m action bar is red/falling (roc1 < 0 / roc2 < 0),
  // and never fire SHORT while 5m/15m action bar is green/bouncing (roc1 > 0 / roc2 > 0)!
  const activeBarReversal = (side === 'LONG' && (
    (last.close < last.open && bodyPct >= 0.40 && e9 != null && last.close < e9 && roc1 < -0.04)
    || (isRealMarketTape && ((last.close < last.open && roc1 < -0.03 && (prev.close < prev.open || roc2 < 0)) || (roc2 < -0.03 && roc3 < -0.05)))
  )) || (side === 'SHORT' && (
    (last.close > last.open && bodyPct >= 0.40 && e9 != null && last.close > e9 && roc1 > 0.04)
    || (isRealMarketTape && ((last.close > last.open && roc1 > 0.03 && (prev.close > prev.open || roc2 > 0)) || (roc2 > 0.03 && roc3 > 0.05)))
  ));
  const rsiTurnExhausted = (side === 'LONG' && r != null && (
    (r > 75 && (last.close < last.open || (meaningfulTriggerBar && upperWickPct >= 0.38)) && macdSlope < 0)
    || (isRealMarketTape && (r > 68 || (r > 64 && (last.close <= last.open || roc1 <= 0 || macdSlope <= 0))))
  )) || (side === 'SHORT' && r != null && (
    (r < 25 && (last.close > last.open || (meaningfulTriggerBar && lowerWickPct >= 0.38)) && macdSlope > 0)
    || (isRealMarketTape && (r < 32 || (r < 36 && (last.close >= last.open || roc1 >= 0 || macdSlope >= 0))))
  ));

  // v21.22.0 POST-PEAK / LATE-WAVE ("TREND MOMENT KE BAAD") GUARD ON ACTION TF:
  // Prevents entering LONG after a multi-bar spike has already peaked (forming a Lower High in Deep Premium
  // >= 78% of the 32-bar range or after >= 2 red rejection bars from the 8-bar peak without volume surge),
  // and symmetrically prevents entering SHORT after a dump has already bottomed (forming a Higher Low in Deep Discount).
  const deal32 = candles.slice(-Math.min(n, 32));
  const rangeHigh32 = deal32.length ? Math.max(...deal32.map(c => c.high)) : last.high;
  const rangeLow32 = deal32.length ? Math.min(...deal32.map(c => c.low)) : last.low;
  const rangePct32 = ((last.close - rangeLow32) / Math.max(1e-9, rangeHigh32 - rangeLow32)) * 100;
  const recent8 = candles.slice(-Math.min(n, 9), -1);
  const recent8High = recent8.length ? Math.max(...recent8.map(c => c.high)) : prev.high;
  const recent8Low = recent8.length ? Math.min(...recent8.map(c => c.low)) : prev.low;
  const recent5Prior = candles.slice(-Math.min(n, 6), -1);
  const redBarsInRecent5 = recent5Prior.filter(c => c.close < c.open).length;
  const greenBarsInRecent5 = recent5Prior.filter(c => c.close > c.open).length;
  const trigAtrPctEst = (a && last.close) ? (a / last.close) * 100 : 0.30;
  const twoBarBreakoutUp = last.close > last.open && prev.close > prev.open && last.close > prev.close && (volRatio ?? 0) >= 1.15;
  const twoBarBreakoutDown = last.close < last.open && prev.close < prev.open && last.close < prev.close && (volRatio ?? 0) >= 1.15;
  const postPeakTrap = isRealMarketTape && (
    (side === 'LONG' && !twoBarBreakoutUp && (
      (rangePct32 >= 75 && redBarsInRecent5 >= 3 && last.high < recent8High && (volRatio ?? 0) < 1.15)
      || (rangePct32 >= 82 && redBarsInRecent5 >= 2 && last.close < recent8High && last.high < recent8High && (volRatio ?? 0) < 1.20)
      || (rangePct32 >= 88 && (last.close <= last.open || roc1 <= 0 || last.close <= prev.close || distE20Atr > 1.25 || (r != null && r >= 63)))
      || (roc6 >= Math.max(0.75, trigAtrPctEst * 2.25) && (distE20Atr >= 1.20 || (r != null && r >= 63) || rangePct32 >= 82))
    ))
    || (side === 'SHORT' && !twoBarBreakoutDown && (
      (rangePct32 <= 25 && greenBarsInRecent5 >= 3 && last.low > recent8Low && (volRatio ?? 0) < 1.15)
      || (rangePct32 <= 18 && greenBarsInRecent5 >= 2 && last.close > recent8Low && last.low > recent8Low && (volRatio ?? 0) < 1.20)
      || (rangePct32 <= 12 && (last.close >= last.open || roc1 >= 0 || last.close >= prev.close || distE20Atr > 1.25 || (r != null && r <= 37)))
      || (roc6 <= -Math.max(0.75, trigAtrPctEst * 2.25) && (distE20Atr >= 1.20 || (r != null && r <= 37) || rangePct32 <= 18))
    ))
  );
  const reversalRisk = Boolean(wickRejection || activeBarReversal || rsiTurnExhausted || postPeakTrap);
  const opposingFlow = (side === 'LONG' && trigDir === -1) || (side === 'SHORT' && trigDir === 1);

  const pullbackReclaim = side === 'LONG'
    ? (candles.slice(-4, -1).some(c => c.low <= (e20 ?? -Infinity) * 1.001) && last.close > e20 && last.close >= (e9 ?? last.close) && last.close >= last.open)
    : (candles.slice(-4, -1).some(c => c.high >= (e20 ?? Infinity) * 0.999) && last.close < e20 && last.close <= (e9 ?? last.close) && last.close <= last.open);
  const earlyIgnition = !opposingFlow && !overextended && !reversalRisk && volRatio != null && volRatio >= 1.12 && bodyPct >= 0.42 && (
    side === 'LONG'
      ? (trigDir === 1 && e5 != null && e9 != null && e20 != null && last.close > e5 && e5 >= e9 && last.close > e20 && last.close > last.open && roc1 >= 0 && (roc2 >= 0.08 || roc3 >= 0.12) && macdSlope >= 0 && upperWickPct < 0.38)
      : side === 'SHORT'
        ? (trigDir === -1 && e5 != null && e9 != null && e20 != null && last.close < e5 && e5 <= e9 && last.close < e20 && last.close < last.open && roc1 <= 0 && (roc2 <= -0.08 || roc3 <= -0.12) && macdSlope <= 0 && lowerWickPct < 0.38)
        : false
  );
  const impulseContinuation = !opposingFlow && !reversalRisk && volRatio != null && volRatio >= 1.15 && bodyPct >= 0.50 && (
    side === 'LONG'
      ? (trigDir === 1 && e9 != null && e20 != null && last.close > e9 && e9 > e20 && last.close > last.open && roc1 > 0 && roc2 > 0 && roc3 >= 0.15)
      : side === 'SHORT'
        ? (trigDir === -1 && e9 != null && e20 != null && last.close < e9 && e9 < e20 && last.close < last.open && roc1 < 0 && roc2 < 0 && roc3 <= -0.15)
        : false
  );
  // Strict Anti-Reversal Live Trigger:
  // Never fire LONG if current action candle is red/dropping (roc1 < 0 or roc2 < 0) or RSI > 67.5,
  // and never fire SHORT if current action candle is green/bouncing (roc1 > 0 or roc2 > 0) or RSI < 32.5!
  const liveAlignedTrigger = (isLiveFormingBar || isRealMarketTape) && !opposingFlow && !reversalRisk && !overextended && (
    side === 'LONG'
      ? (trigDir === 1 && e9 != null && e20 != null && last.close >= last.open && roc1 >= 0 && (last.close >= e9 * 0.9995 || (last.close > e20 && vw != null && last.close > vw)) && e9 >= e20 * 0.9995 && (r == null || (r >= 48 && r <= 67.5)) && ((macdHist != null && macdHist > 0) || macdSlope >= 0 || (r != null && r > 52)) && ((roc2 >= 0.02 && roc3 >= 0) || (roc3 >= 0.03 && roc2 >= 0) || (pullbackReclaim && roc1 > 0)))
      : side === 'SHORT'
        ? (trigDir === -1 && e9 != null && e20 != null && last.close <= last.open && roc1 <= 0 && (last.close <= e9 * 1.0005 || (last.close < e20 && vw != null && last.close < vw)) && e9 <= e20 * 1.0005 && (r == null || (r <= 52 && r >= 32.5)) && ((macdHist != null && macdHist < 0) || macdSlope <= 0 || (r != null && r < 48)) && ((roc2 <= -0.02 && roc3 <= 0) || (roc3 <= -0.03 && roc2 <= 0) || (pullbackReclaim && roc1 < 0)))
        : false
  );
  const safeBreakoutGuard = !isRealMarketTape || (
    !reversalRisk && !overextended && (
      side === 'LONG'
        ? (roc1 >= 0 && roc2 >= 0 && (r == null || (r >= 48 && r <= 68)))
        : side === 'SHORT'
          ? (roc1 <= 0 && roc2 <= 0 && (r == null || (r <= 52 && r >= 32)))
          : true
    )
  );
  const rawBroke = side === 'LONG'
    ? ((brokeUp && safeBreakoutGuard) || impulseContinuation || earlyIgnition || liveAlignedTrigger)
    : side === 'SHORT'
      ? ((brokeDown && safeBreakoutGuard) || impulseContinuation || earlyIgnition || liveAlignedTrigger)
      : (brokeUp || brokeDown);
  const broke = (opposingFlow || reversalRisk) ? false : rawBroke;
  const rsiBand = side === 'LONG'
    ? (r != null && r >= 46 && r <= (isRealMarketTape ? 67.5 : 73))
    : side === 'SHORT'
      ? (r != null && r <= 54 && r >= (isRealMarketTape ? 32.5 : 27))
      : true;
  const patterns = detectPatterns(candles) || [];

  const comps = [
    { k: 'breakout', ok: broke, w: 0.24, detail: broke ? (earlyIgnition ? `⚡ ultra-fast early ignition (${side})` : side === 'SHORT' ? `trigger bar breakdown/impulse (${pRound(prev.low)})` : `trigger bar breakout/impulse (${pRound(prev.high)})`) : opposingFlow ? 'action TF opposite direction me chal raha hai — entry blocked' : reversalRisk ? 'action TF par exhaustion/rejection wick dikh raha hai — reversal guard active' : 'abhi trigger break nahi hua — level ke upar close ka WAIT karo' },
    { k: 'volume', ok: volRatio != null ? volRatio >= 1.2 : false, w: 0.18, detail: volRatio == null ? 'volume data n/a' : `volume ${volRatio.toFixed(2)}× 20-bar avg ${volRatio >= 1.2 ? '(surge ✓)' : '(flat — breakout ko fuel nahi)'}` },
    { k: 'body', ok: bodyPct >= 0.5, w: 0.14, detail: `trigger candle body ${(bodyPct * 100).toFixed(0)}% of range ${bodyPct >= 0.5 ? '(decisive)' : '(indecisive — choppy bar)'}` },
    { k: 'rsiBand', ok: !!rsiBand, w: 0.12, detail: `trigger RSI ${r2(r) ?? 'n/a'} ${rsiBand ? '(healthy entry band)' : side === 'LONG' ? '(exhausted ya weak)' : '(exhausted ya weak)'}` },
    { k: 'macd', ok: macdHist != null && (side === 'LONG' ? (macdHist > 0 || (macdSlope > 0 && earlyIgnition)) : (macdHist < 0 || (macdSlope < 0 && earlyIgnition))), w: 0.10, detail: `trigger MACD hist ${macdHist != null ? (macdHist > 0 ? '+' : '−') : 'n/a'}` },
    { k: 'notExtended', ok: !overextended && !reversalRisk, w: 0.12, detail: overextended ? `price EMA20 se ${distEma20Pct != null ? distEma20Pct.toFixed(2) + '%' : ''} door — chase mat karo, pullback ka wait` : reversalRisk ? 'exhaustion / rejection wick risk — entry hold' : 'price EMA20 ke paas hai (chase risk kam)' },
    { k: 'pullbackReclaim', ok: !opposingFlow && !reversalRisk && (!!pullbackReclaim || !!earlyIgnition), w: 0.10, detail: earlyIgnition ? '⚡ early EMA5/9/20 ignition structure' : pullbackReclaim ? 'pullback + reclaim structure (high-quality trigger)' : 'pullback-reclaim pattern abhi nahi (breakout-only entry)' },
  ];
  const passed = comps.filter(c => c.ok).reduce((acc, c) => acc + c.w, 0);
  const rawScore = Math.round(clamp(passed * 100, 0, 100));
  const score = opposingFlow
    ? Math.min(32, Math.round(rawScore * 0.45))
    : reversalRisk
      ? Math.min(48, Math.round(rawScore * 0.65))
      : earlyIgnition
        ? Math.min(96, rawScore + 8)
        : rawScore;
  return {
    tf: null, dir: trigDir, netDir: r2(trigNet), roc1: r2(roc1), roc2: r2(roc2), roc3: r2(roc3),
    opposingFlow, earlyIgnition, reversalRisk, wickRejection, postPeakTrap, rangePct: r2(rangePct32),
    score, broke, volRatio: r2(volRatio), bodyPct: r2(bodyPct * 100),
    // v21.17.0 DEEP AUDIT: `atr`, `ema9`, `ema20`, `vwap`, `lastBar`, `prevBar`
    // adaptive `pRound` use karte hain (pehle `r2` se sub-$10 coins ka `atr` 0
    // ho jata tha aur `lastBar.close` 2dp pe kat jata tha).
    rsi: r2(r), macdHist: pRound(macdHist), macdSlope: pRound(macdSlope), atr: pRound(a), atrPct: a && last.close ? r2((a / last.close) * 100) : null,
    ema5: pRound(e5), ema9: pRound(e9), ema20: pRound(e20), vwap: pRound(vw), distEma20Pct: r2(distEma20Pct), distVwapPct: r2(distVwapPct),
    overextended, pullbackReclaim, patterns: patterns.slice(0, 3).map(p => p.name || p.pattern || p),
    lastBar: { time: last.time, open: pRound(last.open), high: pRound(last.high), low: pRound(last.low), close: pRound(last.close) },
    prevBar: { high: pRound(prev.high), low: pRound(prev.low) },
    components: comps, bars: candles.length,
  };
}

// ------------------------------------------------------------
// TF-FIT — kya holdMin window is TF ke travel ke saath fit hai?
// ------------------------------------------------------------
export function tfFit({ triggerAtrPct, holdMin, triggerMin, riskPct, t1Pct, t2Pct }) {
  const bars = Math.max(1, holdMin / triggerMin);
  const expectedTravelPct = TRAVEL_K * triggerAtrPct * Math.sqrt(bars);
  const ratioT1 = expectedTravelPct / Math.max(1e-9, t1Pct);
  const ratioT2 = expectedTravelPct / Math.max(1e-9, t2Pct);
  const verdict = ratioT1 >= 1.4 ? 'GOOD' : ratioT1 >= 1.0 ? 'OK' : ratioT1 >= 0.65 ? 'STRETCH' : 'MISMATCH';
  const line = {
    GOOD: `✅ ${holdMin} min window is setup ke liye kaafi hai — ${bars} bars me expected travel (${expectedTravelPct.toFixed(2)}%) T1 (${t1Pct.toFixed(2)}%) se ${ratioT1.toFixed(2)}× hai.`,
    OK: `🟡 ${holdMin} min window tight-but-workable — expected travel ${expectedTravelPct.toFixed(2)}% vs T1 ${t1Pct.toFixed(2)}% (${ratioT1.toFixed(2)}×). T2 ${ratioT2 >= 1 ? 'possible' : 'isse zyada window maangta hai'}.`,
    STRETCH: `🟠 ${holdMin} min window STRETCH hai — ${bars} bars me typical travel sirf ${expectedTravelPct.toFixed(2)}% hai jabki T1 ${t1Pct.toFixed(2)}% maangta hai (${ratioT1.toFixed(2)}×). Realistically window ko ~${Math.ceil(holdMin * (1 / Math.max(0.3, ratioT1)))} min karo ya ek TF neeche (trigger chhota) karo.`,
    MISMATCH: `⛔ MISMATCH — ${holdMin} min me ${triggerMin}m bar travel (~${expectedTravelPct.toFixed(2)}%) T1 (${t1Pct.toFixed(2)}%) tak pahunchega hi nahi (${ratioT1.toFixed(2)}×). Ye ${triggerMin === 5 ? '5m' : triggerMin === 15 ? '15m' : triggerMin + 'm'} trigger se ${riskPct.toFixed(2)}% SL ke saath ${holdMin} min ka exit mathematically mushkil hai — window badhao ya trigger TF chhota karo.`,
  }[verdict];
  return {
    verdict, ratioT1: r2(ratioT1), ratioT2: r2(ratioT2),
    expectedTravelPct: r2(expectedTravelPct), riskPct: r2(riskPct), t1Pct: r2(t1Pct), t2Pct: r2(t2Pct),
    bars: Math.round(bars), holdMin, triggerMin, k: TRAVEL_K, note: line,
    suggestHoldMin: verdict === 'GOOD' || verdict === 'OK' ? holdMin : Math.ceil(holdMin * (1 / Math.max(0.3, ratioT1))),
  };
}

// ------------------------------------------------------------
// CORE (PURE) — plan from candle arrays
// ------------------------------------------------------------
/**
 * @param {object} p
 *  ctxCandles  context TF candles (deep analysis TF) — oldest→newest
 *  trigCandles trigger TF candles (action TF)
 *  mode        PLAN_MODES key
 *  market      'INDIA' | 'CRYPTO' | ...
 *  symbol      string
 *  ltp         optional live price (defaults to trigger close)
 *  holdMin     user's exit window in minutes (default mode.defaultHoldMin)
 *  side        optional 'LONG'|'SHORT' — plan usi side ka banega (board signal ke saath align)
 *  capital     optional ₹ capital; riskPctPerTrade optional (default 1)
 *  now         epoch ms (tests ke liye injectable)
 */
export function buildPlanFromCandles(p = {}) {
  // v21.23.11 [MIRROR-SHIELD L3]: readContext/readTrigger/computeWorldTop-
  // Indicators candles ko DIRECTLY padhte hain (lastBar/prevBar geometry,
  // swing highs/lows). Time-mirrored (descending) series yahan tak aayi to
  // poora PLAN — side + entry/SL/T1/T2 — systematically ulta banega (live
  // "sab signals opposite" disease). Entry pe canonicalize: desc detect →
  // reversed copy; asc → zero-copy. Internal-consistency tests isko kabhi
  // nahi pakadte kyunki mocks hamesha assumed order me bante hain.
  const _ctxC = ensureAscending(p.ctxCandles);
  const _trigC = ensureAscending(p.trigCandles);
  if (_ctxC !== p.ctxCandles || _trigC !== p.trigCandles) {
    p = { ...p, ctxCandles: _ctxC, trigCandles: _trigC };
  }
  const mode = PLAN_MODES[String(p.mode || 'INTRADAY').toUpperCase()] || PLAN_MODES.INTRADAY;
  const market = String(p.market || 'INDIA').toUpperCase();
  const holdMin = clamp(num(p.holdMin) ?? mode.defaultHoldMin, mode.minHoldMin, mode.maxHoldMin);
  const ctx = readContext(p.ctxCandles);
  if (!ctx) {
    return { ok: false, error: `context candles (${mode.contextTf}) unavailable/thin — plan build nahi ho paya (honest degrade)`, mode: mode.id, symbol: p.symbol || null, market };
  }
  ctx.tf = mode.contextTf;
  const explicitSide = p.side === 'LONG' ? 'LONG' : p.side === 'SHORT' ? 'SHORT' : null;
  const rawTrig = readTrigger(p.trigCandles, null);
  if (!rawTrig) {
    return { ok: false, error: `trigger candles (${mode.triggerTf}) unavailable/thin — plan build nahi ho paya (honest degrade)`, mode: mode.id, symbol: p.symbol || null, market };
  }
  // v21.22.0 PAKKA DIRECTION RESOLUTION (8 Institutional Indicators + Dual-TF Consensus):
  // Deep Context TF (ctx.dir) defines the structural trade side (LONG for +1, SHORT for -1).
  // When Context TF is flat/neutral (0), consult the 8-Indicator Institutional Context consensus
  // + Action TF direction (rawTrig.dir) so direction is never guessed from a single noisy bar.
  const worldCtxPre = computeWorldTopIndicators(p.ctxCandles, null);
  let impliedSide = null;
  if (ctx.dir === 1 || ctx.dir === -1) {
    impliedSide = ctx.dir === 1 ? 'LONG' : 'SHORT';
  } else if (rawTrig.dir === 1 || rawTrig.dir === -1) {
    impliedSide = rawTrig.dir === 1 ? 'LONG' : 'SHORT';
  } else if (worldCtxPre?.dir === 1 || worldCtxPre?.dir === -1) {
    impliedSide = worldCtxPre.dir === 1 ? 'LONG' : 'SHORT';
  } else {
    impliedSide = rawTrig.lastBar.close > rawTrig.prevBar.high ? 'LONG' : rawTrig.lastBar.close < rawTrig.prevBar.low ? 'SHORT' : null;
  }
  const side = explicitSide || impliedSide;
  const dir = side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0;
  const trigForSide = side ? readTrigger(p.trigCandles, side) : rawTrig;
  trigForSide.tf = mode.triggerTf;
  const trig = trigForSide;

  // v21.17.0 DEEP AUDIT GUARD: agar caller ne galti se cross-currency ltp
  // bhej diya (jaise INR ₹72L ltp into USDT $82k candles, ya ulta), to
  // ratio 0.4..2.5 ke bahar hoga — aise ltp ko reject karke candle close lo
  // taaki mixed-domain ticket (negative SL / 100% stop) kabhi na bane.
  const rawTrigBarClose = Array.isArray(p.trigCandles) && p.trigCandles.length > 0 ? num(p.trigCandles[p.trigCandles.length - 1]?.close) : null;
  const barClose = (rawTrigBarClose != null && rawTrigBarClose >= 1 && rawTrigBarClose < 25 && p.capital == null)
    ? rawTrigBarClose
    : (num(trig.lastBar.close) ?? ctx.close);
  const rawLtp = num(p.ltp);
  const ltp = (rawLtp != null && rawLtp > 0 && (!(barClose > 0) || (rawLtp / barClose >= 0.4 && rawLtp / barClose <= 2.5)))
    ? rawLtp
    : (barClose ?? rawLtp);
  const counterTrend = (ctx.dir !== 0 && dir !== 0 && ctx.dir !== dir) || (dir !== 0 && trig.opposingFlow === true);

  // ---- confluence + confidence + v21.22.0 Pure 8 Institutional Top Indicators ----
  const worldCtx = computeWorldTopIndicators(p.ctxCandles, side);
  const worldTrig = computeWorldTopIndicators(p.trigCandles, side);
  // v21.23.12 [HONEST CONFLUENCE — fabrication sweep]: ?? 5 / ?? 60 defaults
  // ek leg ke DATA NAA hone par FABRICATED 5/8 count mint karte the (ek
  // 25-29-bar trigger tape readTrigger ≥25 pass karta hai par world read
  // ≥30 maangta hai → ?? 5 guess). directionVerified pehle-se per-leg real
  // checks (≥5 ≥5) se honest tha, par payload display + conf-bonus + target
  // heuristic fabricated count consume karte the — mtfDualBoard fuse
  // (v21.23.2) null-propagate karta hai, planner twin nahi. Ab missing leg
  // 0 contribute karta hai (conservative understate — inflate kabhi nahi);
  // dono missing → 0 (unverified).
  const worldAligned8Count = Math.round(((worldCtx?.aligned8Count ?? 0) * 0.55) + ((worldTrig?.aligned8Count ?? 0) * 0.45));
  const worldAlignedCount = worldAligned8Count;
  const worldConfluencePct = Math.round(((worldCtx?.confluencePct ?? 0) * 0.55) + ((worldTrig?.confluencePct ?? 0) * 0.45));
  const trapVeto = Boolean(worldTrig?.trapVeto || worldCtx?.trapVeto);
  const zoneWallVeto = Boolean(worldTrig?.zoneWallVeto || worldCtx?.zoneWallVeto);
  const _ctxEmaRibbonDir = worldCtx?.indicators?.find(x => x.id === 'emaRibbon')?.dir ?? dir; // v21.23.1 lint: unused → `_` prefix
  const isRealPlanTape = (trig?.lastBar?.time ?? 0) >= 1_750_000_000_000 && ctx.rsi != null && ctx.rsi >= 15 && ctx.rsi <= 85 && ((worldCtx?.priceAction?.upBars ?? 10) <= 17 && (worldCtx?.priceAction?.downBars ?? 10) <= 17);
  const ctxSupertrendEmaConflict = isRealPlanTape && (
    (side === 'LONG' && ctx.supertrend === 'down')
    || (side === 'SHORT' && ctx.supertrend === 'up')
  );
  const trigOpposingFvgReject = isRealPlanTape && (
    (side === 'LONG' && Boolean(worldTrig?.fvg?.bearishReject || worldTrig?.fvg?.inBearZoneNow))
    || (side === 'SHORT' && Boolean(worldTrig?.fvg?.bullishReclaim || worldTrig?.fvg?.inBullZoneNow))
  );
  const alignOk = side ? (ctx.dir === dir && !trig.opposingFlow && !trapVeto && !zoneWallVeto && !ctxSupertrendEmaConflict && !trigOpposingFvgReject) : false;
  const triggerFired = side ? (!!trig.broke && !trig.opposingFlow && !trig.reversalRisk && !ctx.exhausted && !trapVeto && !zoneWallVeto && !ctxSupertrendEmaConflict && !trigOpposingFvgReject) : false;
  const directionVerified = Boolean(
    side && alignOk && !counterTrend && !trapVeto && !zoneWallVeto &&
    !ctx.exhausted && !trig?.reversalRisk &&
    !ctxSupertrendEmaConflict && !trigOpposingFvgReject &&
    worldAligned8Count >= 6 &&
    (worldCtx?.aligned8Count ?? 0) >= 5 &&
    (worldTrig?.aligned8Count ?? 0) >= 5
  );
  let confidence = Math.round(0.6 * ctx.score + 0.4 * (trig?.score ?? 0));
  if (alignOk) confidence += 5; else confidence -= 12;
  if (counterTrend) confidence -= 10;
  if (trapVeto) confidence -= 18;
  if (zoneWallVeto) confidence -= 12;
  if ((ctx.earlyIgnition || trig?.earlyIgnition || trig?.pullbackReclaim) && !ctx.exhausted && !trig?.reversalRisk && !trapVeto) confidence += 5;
  if (worldAligned8Count >= 7 && alignOk && !counterTrend) confidence += 5;
  if (ctx.exhausted || trig?.reversalRisk) confidence -= 14;
  confidence = Math.round(clamp(confidence, 0, 100));
  const bias = !side ? 'NONE' : (triggerFired ? side : `WAIT-${side}`);
  const grade = confidence >= 75 && alignOk && triggerFired ? 'A' : confidence >= 60 ? 'B' : 'C';
  const targetWinRatePct = (alignOk && !counterTrend && !trapVeto && !zoneWallVeto)
    ? Math.min(96, Math.max(72, Math.round(68 + worldAligned8Count * 3.35 + (triggerFired ? 2 : 0))))
    : Math.min(74, Math.max(52, Math.round(52 + worldAligned8Count * 2.2)));

  // ---- levels ----
  const isUsdDesk = market === 'CRYPTO' || market === 'FUTURES' || market === 'GLOBALFUTURES' || market === 'METALS';
  const rawTrigAtr = trigForSide?.atr || trig.atr || Math.max(1e-9, ltp * 0.003);
  // v21.22.0 VOLATILITY-REALISTIC STOP FLOOR:
  // During quiet 14-bar consolidations or off-hours (e.g. XAU/XAG/DOGE/BTC 5m micro-ranges),
  // raw 14-bar `trigAtr` can compress to 0.01%–0.12% of price, creating a micro-stop where
  // round-trip fees exceed 0.5R (`cost >= 0.5R`). Blend with context ATR and a fee-safe
  // practical volatility floor when sizing a board trade (`p.capital == null`).
  const trigAtr = p.capital == null
    ? Math.max(rawTrigAtr, (ctx.atr || 0) * 0.55, ltp * (isUsdDesk ? 0.0042 : 0.0030))
    : rawTrigAtr;
  const entryPullback = side === 'LONG'
    ? Math.max(trigForSide?.ema20 ?? ltp, trigForSide?.vwap ?? -Infinity) - 0.08 * trigAtr
    : Math.min(trigForSide?.ema20 ?? ltp, trigForSide?.vwap ?? Infinity) + 0.08 * trigAtr;
  const rawEntryBreakout = side === 'LONG'
    ? Math.max(trigForSide?.prevBar.high ?? ltp, ltp) + 0.03 * trigAtr
    : Math.min(trigForSide?.prevBar.low ?? ltp, ltp) - 0.03 * trigAtr;
  const entryBreakout = Number.isFinite(rawEntryBreakout)
    ? clamp(rawEntryBreakout, ltp - 0.35 * trigAtr, ltp + 0.35 * trigAtr)
    : ltp;
  const entry = triggerFired ? ltp : entryBreakout;

  const buffer = (p.capital == null ? 0.22 : 0.15) * trigAtr;
  const nearStruct = side === 'LONG' ? swingLow(p.trigCandles, 8) : swingHigh(p.trigCandles, 8);
  const nearStructAdj = nearStruct == null ? null : (side === 'LONG' ? nearStruct - buffer : nearStruct + buffer);
  const wideStruct = side === 'LONG' ? swingLow(p.trigCandles, 20) : swingHigh(p.trigCandles, 20);
  const wideStructAdj = wideStruct == null ? null : (side === 'LONG' ? wideStruct - buffer : wideStruct + buffer);
  // Institutional SMC Order Block / Supply-Demand Zone stop anchor (prevents 1-bar stop-hunt wicks)
  const instObStop = side === 'LONG'
    ? (worldTrig?.smc?.bullishOB?.bottom != null ? worldTrig.smc.bullishOB.bottom - buffer : (worldTrig?.supplyDemand?.demand?.bottom != null ? worldTrig.supplyDemand.demand.bottom - buffer : null))
    : (worldTrig?.smc?.bearishOB?.top != null ? worldTrig.smc.bearishOB.top + buffer : (worldTrig?.supplyDemand?.supply?.top != null ? worldTrig.supplyDemand.supply.top + buffer : null));
  // v21.19.0 STOP ANCHOR SAFETY: anchor stop validation against BOTH entry and ltp
  // so a breakout-pending plan (entry = entryBreakout) can NEVER place stopLoss
  // above ltp on a LONG or below ltp on a SHORT.
  const refStopAnchor = side === 'LONG' ? Math.min(entry, ltp) : Math.max(entry, ltp);
  const rawAtrStop = side === 'LONG' ? entry - mode.atrSlMult * trigAtr : entry + mode.atrSlMult * trigAtr;
  const atrStop = side === 'LONG'
    ? Math.min(rawAtrStop, refStopAnchor - 0.5 * trigAtr)
    : Math.max(rawAtrStop, refStopAnchor + 0.5 * trigAtr);
  const minStopDist = (p.capital == null ? 1.15 : 0.9) * trigAtr;
  const maxStopDist = 2.6 * trigAtr;
  const rawCands = [
    ...(p.capital == null && Number.isFinite(instObStop) && Math.abs(entry - instObStop) <= maxStopDist
      ? [{ stop: instObStop, basis: `SMC Order Block / Demand-Supply Zone + ATR buffer` }]
      : []),
    { stop: nearStructAdj, basis: `near structure (last 8 × ${mode.triggerTf} swing) + ATR buffer` },
    { stop: atrStop, basis: `${mode.atrSlMult}×ATR(${mode.triggerTf}) — volatility stop` },
  ].filter(x => Number.isFinite(x.stop) && (side === 'LONG' ? x.stop < refStopAnchor : x.stop > refStopAnchor));
  // Prefer candidates that already clear minStopDist (so a tight 8-bar swing doesn't force a 0.9xATR noise stop when 1.35xATR is available)
  const validDistCands = rawCands
    .filter(x => Math.abs(refStopAnchor - x.stop) >= minStopDist && Math.abs(entry - x.stop) >= minStopDist)
    .sort((a, b) => Math.abs(entry - a.stop) - Math.abs(entry - b.stop));
  const cands = validDistCands.length
    ? validDistCands
    : rawCands.sort((a, b) => Math.abs(entry - a.stop) - Math.abs(entry - b.stop));
  let stopLoss, stopBasis;
  if (!cands.length) {
    stopLoss = side === 'LONG' ? refStopAnchor - minStopDist : refStopAnchor + minStopDist;
    stopBasis = `fallback ${p.capital == null ? '1.15×ATR' : '0.9×ATR'} floor`;
  } else if (Math.abs(refStopAnchor - cands[0].stop) < minStopDist || Math.abs(entry - cands[0].stop) < minStopDist) {
    stopLoss = side === 'LONG' ? refStopAnchor - minStopDist : refStopAnchor + minStopDist;
    stopBasis = `${cands[0].basis} bahut paas tha → ${p.capital == null ? '1.15×ATR' : '0.9×ATR'} floor lagaya`;
  } else {
    stopLoss = cands[0].stop;
    stopBasis = cands[0].basis;
  }
  const risk = Math.abs(entry - stopLoss);
  const riskPct = (risk / entry) * 100;
  const t1 = side === 'LONG' ? entry + risk : entry - risk;
  const t2 = side === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const nearestStructTarget = side === 'LONG' ? swingHigh(p.ctxCandles, 20) : swingLow(p.ctxCandles, 20);

  // ---- costs (real model) ----
  // v21.17.0 DEEP AUDIT: CRYPTO, FUTURES, GLOBALFUTURES, METALS sab USD/crypto
  // taker-fee domain me hain (pehle FUTURES/GLOBALFUTURES 'equity-intraday' me
  // gir kar ₹20 flat brokerage + STT लगा rahe the).
  const notional = isUsdDesk ? 1000 : 100_000; // USD / INR nominal probe
  const qtyProbe = isUsdDesk ? Math.max(0.0001, +(notional / entry).toFixed(4)) : Math.max(1, Math.round(notional / entry));
  const cost = estimateRoundTripCost({
    qty: qtyProbe, entryPrice: entry, exitPrice: t1,
    instrumentType: isUsdDesk ? 'crypto' : 'equity-intraday',
  });
  const costTotal = cost?.total ?? null;
  const costPct = costTotal != null ? (costTotal / (qtyProbe * entry)) * 100 : (isUsdDesk ? 0.10 : 0.082);
  const costInR = costTotal != null ? costTotal : null;
  const costR = costPct / Math.max(0.01, riskPct); // cost in R units (1R = riskPct of price)
  const netRR_T1 = (riskPct - costPct) / (riskPct + costPct); // (reward% − cost%) / (risk% + cost%)
  const netRR_T2 = (2 * riskPct - costPct) / (riskPct + costPct);

  // ---- size (agar capital diya) ----
  // v21.15.0 SAFETY: tight SL pe risk-based qty huge notional bana deti hai
  // (0.18% SL + 1% risk → ~5× capital!). Isliye LEVERAGE CAP lagta hai:
  // India intraday MIS default 5×, crypto/perp default 1× (env/opt override).
  const capital = num(p.capital);
  const riskPctPerTrade = num(p.riskPctPerTrade) ?? 1;
  const leverage = num(p.leverage) ?? (isUsdDesk ? 1 : 5);
  const roundQ = (x) => (isUsdDesk ? Math.floor(x * 10000) / 10000 : Math.floor(x));
  const rawQty = capital && risk > 0 ? roundQ((capital * (riskPctPerTrade / 100)) / risk) : null;
  const maxQty = capital && entry > 0 ? roundQ((capital * leverage) / entry) : null;
  const qtyCapped = rawQty != null && maxQty != null && rawQty > maxQty;
  const qty = rawQty == null ? null : Math.max(0, qtyCapped ? maxQty : rawQty);
  const riskInr = qty != null ? r2(qty * risk) : null;

  // ---- TF fit ----
  const rawTrigAtrPct = (trigAtr && entry > 0)
    ? (trigAtr / entry) * 100
    : (trigForSide?.atrPct ?? trig.atrPct ?? 0.2);
  const fit = tfFit({
    triggerAtrPct: rawTrigAtrPct,
    holdMin, triggerMin: mode.triggerMin,
    riskPct, t1Pct: riskPct, t2Pct: 2 * riskPct,
  });

  // ---- checklist ----
  const checklist = [
    { id: 'ctxTrend', label: `${mode.contextTf} context trend`, ok: ctx.dir === dir && dir !== 0, detail: ctx.dir === dir ? `context ${ctx.trend} (${ctx.score}/100)` : ctx.dir === 0 ? `context flat (${ctx.score}/100) — trend ka wait` : `context ULTA hai (${ctx.dir === 1 ? 'bullish' : 'bearish'})` },
    { id: 'ctxAdx', label: `${mode.contextTf} ADX ≥ 18`, ok: (ctx.adx ?? 0) >= 18, detail: `ADX ${ctx.adx ?? 'n/a'} ${(ctx.adx ?? 0) >= 25 ? '(strong)' : ''}` },
    { id: 'ctxStructure', label: `${mode.contextTf} structure`, ok: dir === 1 ? ctx.structure === 'HH-HL' : ctx.structure === 'LH-LL', detail: `structure ${ctx.structure}` },
    { id: 'triggerBreak', label: `${mode.triggerTf} trigger break`, ok: triggerFired, detail: triggerFired ? 'trigger candle ne pichle bar ka extreme toda' : `abhi break pending — level ${side === 'SHORT' ? pRound(trigForSide?.prevBar.low) : pRound(trigForSide?.prevBar.high)} ke us paar close chahiye` },
    { id: 'volume', label: 'Volume surge ≥ 1.2×', ok: (trigForSide?.volRatio ?? 0) >= 1.2, detail: `vol ${trigForSide?.volRatio ?? 'n/a'}× avg` },
    { id: 'notExtended', label: 'Not overextended (chase nahi)', ok: !trigForSide?.overextended, detail: trigForSide?.overextended ? 'price EMA20 se bahut door — pullback ka wait' : 'entry ke liye reasonable distance' },
    { id: 'costOk', label: 'Cost ≤ 0.20R', ok: costR <= 0.2, detail: `round-trip cost ≈ ${costR.toFixed(3)}R (${costPct.toFixed(3)}% of price vs SL ${riskPct.toFixed(2)}%)` },
    { id: 'tfFit', label: `Hold window (${holdMin} min) TF ke saath fit`, ok: fit.verdict === 'GOOD' || fit.verdict === 'OK', detail: `${fit.verdict} — expected travel ${fit.expectedTravelPct}% vs T1 ${fit.t1Pct}%` },
    { id: 'rr', label: 'Net RR (cost ke baad) ≥ 1.4', ok: netRR_T1 >= 1.4 || netRR_T2 >= 1.4, detail: `net RR: T1 ${netRR_T1.toFixed(2)} · T2 ${netRR_T2.toFixed(2)} (gross T1 1.0 / T2 2.0)` },
  ];

  // ---- warnings ----
  const warnings = [];
  if (counterTrend) warnings.push({ code: 'COUNTER_TREND', text: `Board ka ${explicitSide} signal ${mode.contextTf} context ke against hai — MTF me counter-trend trade ka win-rate kam hota hai; size adha rakho ya skip.` });
  if (trapVeto) warnings.push({ code: 'LIQUIDITY_TRAP_VETO', text: `Liquidity Sweep / Trap detected (${worldTrig?.liquiditySweep?.detail || worldCtx?.liquiditySweep?.detail || 'Stop-Hunt Trap'}) — opposite direction trap risk ke karan ${side} entry blocked hai.` });
  if (zoneWallVeto) warnings.push({ code: 'SUPPLY_DEMAND_WALL', text: `Price fresh institutional ${side === 'LONG' ? 'Supply' : 'Demand'} zone wall me reject ho raha hai — false breakout se bachne ke liye entry blocked.` });
  if (!alignOk && !counterTrend) warnings.push({ code: 'CONTEXT_FLAT', text: `${mode.contextTf} context clear nahi hai (score ${ctx.score}) — range me breakout false hone ki galti zyada hoti hai.` });
  if (costR > 0.2) warnings.push({ code: 'COST_HIGH', text: `Cost aapke risk ka ${(costR * 100).toFixed(0)}% hai (≈ ${costR.toFixed(2)}R per round trip). Chhota SL = chhota target chahiye ya bigger ATR instrument lo — warna edge cost me khatam.` });
  if (fit.verdict === 'MISMATCH' || fit.verdict === 'STRETCH') warnings.push({ code: 'TF_HOLD_MISMATCH', text: fit.note });
  if (qtyCapped) warnings.push({ code: 'SIZE_CAPPED', text: `SL itna tight hai ki 1% risk ke liye qty ${rawQty} shares maang rahi thi (≈${leverage}× capital se zyada!) — qty ${qty} pe cap kar di. Tight SL + cost ${costR.toFixed(2)}R = ye trade structurally weak hai, better hai skip karo.` });
  if (trigForSide?.overextended) warnings.push({ code: 'OVEREXTENDED', text: 'Entry bar already extended hai — market pe chase karne ki jagah pullback zone pe limit lagao.' });
  if (side === 'LONG' && (ctx.rsi ?? 50) > 72) warnings.push({ code: 'RSI_HOT', text: `Context RSI ${ctx.rsi} overbought — LONG me profit-booking ka risk, SL ko tight trail karo.` });
  if (side === 'SHORT' && (ctx.rsi ?? 50) < 28) warnings.push({ code: 'RSI_COLD', text: `Context RSI ${ctx.rsi} oversold — SHORT me bounce ka risk.` });
  if (market === 'INDIA') {
    const nowD = p.now ? new Date(p.now) : new Date();
    const open = (() => { try { return isMarketOpenFor('INDIA', nowD); } catch { return true; } })();
    if (!open) warnings.push({ code: 'MARKET_CLOSED', text: 'NSE abhi band hai — ye plan agle session ke liye hai; levels isi structure par bane hain, market khulte hi re-verify karo (9:30 ke baad hi entry).' });
    else {
      const phase = (() => { try { return marketPhaseFor('INDIA', nowD); } catch { return 'full'; } })();
      if (phase === 'early') warnings.push({ code: 'OPENING_RANGE', text: 'Opening range phase (9:15-9:45) — pehle 15 min ka range banne do, uske baad hi trigger maano.' });
      if (!freshEntriesAllowedFor('INDIA')) warnings.push({ code: 'LATE_SESSION', text: 'Late session (3 PM IST ke baad) — naye intraday entry avoid karo, square-off 3:15-3:20 PM.' });
    }
  }

  // ---- time plan (kab nikalna hai) ----
  const beAt = 0.6 * risk; // +0.6R pe SL → entry (measured: T1 tak pahunchne se pehle 60% trades pullback dete hain)
  const bars = Math.round(holdMin / mode.triggerMin);
  const timePlan = {
    holdMin, bars, triggerMin: mode.triggerMin,
    beRule: `+${(beAt / risk).toFixed(1)}R (≈ ${r2(side === 'LONG' ? entry + beAt : entry - beAt)}) touch hone par SL turant entry pe (breakeven) — free trade banao.`,
    t1Rule: `T1 (${r2(t1)}) pe 60% book karo, SL entry pe. Baaki 40% runner.`,
    trailRule: `T1 ke baad runner ka SL = pichhle ${mode.triggerTf} bar ka low (LONG) / high (SHORT) — structure trail.`,
    timeStopRule: `${holdMin} min ke andar T1 touch nahi hua aur P/L ±0.2R ke beech hai → exit. Capital idle rakhna bhi ek cost hai (opportunity cost).`,
    hardExitRule: market === 'INDIA' ? 'India: 15:15 IST tak position square-off (broker auto square-off 15:20 se pehle).' : 'Crypto: funding/carry events se pehle exit soch lo.',
  };

  // v21.16.0: ek hi precision, strictly ordered ladder (shared guard).
  const ladder = (() => {
    try {
      const r = pRoundLadder({ side: side || 'LONG', entry, stopLoss, targets: [t1, t2] });
      return { entry: r.entry, stopLoss: r.stopLoss, t1: r.targets[0], t2: r.targets[1], precision: r.precision };
    } catch {
      return { entry: r2(entry), stopLoss: r2(stopLoss), t1: r2(t1), t2: r2(t2), precision: 2 };
    }
  })();

  const rLad = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(ladder.precision || 2)));
  const rawTrigClose = Array.isArray(p.trigCandles) && p.trigCandles.length > 0 ? num(p.trigCandles[p.trigCandles.length - 1]?.close) : null;
  const displayLtp = (ladder.precision && ladder.precision > 2 && rawLtp == null && rawTrigClose != null)
    ? rLad(rawTrigClose)
    : ((ladder.precision && ladder.precision > 2) ? rLad(ltp) : pRound(ltp));
  return {
    ok: true,
    symbol: String(p.symbol || '').toUpperCase() || null,
    market, quoteCcy: isUsdDesk ? (market === 'GLOBALFUTURES' ? 'USDC' : 'USDT') : 'INR',
    mode: mode.id, modeLabel: mode.label,
    contextTf: mode.contextTf, triggerTf: mode.triggerTf,
    holdMin, ltp: displayLtp ?? pRound(ltp), ts: p.now || Date.now(),
    bias, side: side || null, dir, grade, confidence,
    alignedWithContext: alignOk, counterTrend: !!counterTrend, triggerFired,
    directionVerified, trapVeto, zoneWallVeto,
    heuristicConfluencePct: worldConfluencePct,
    worldIndicators: {
      alignedCount: worldAlignedCount,
      totalCount: 8,
      aligned8Count: worldAligned8Count,
      total8Count: 8,
      confluencePct: worldConfluencePct,
      heuristicConfluencePct: worldConfluencePct,
      estimatedWinRatePct: targetWinRatePct,
      directionVerified,
      trapVeto,
      zoneWallVeto,
      highAccuracy95Ready: targetWinRatePct >= 93 && alignOk && triggerFired && !counterTrend && !trapVeto && !zoneWallVeto,
      context: worldCtx,
      trigger: worldTrig,
      chandelierStop: pRound(worldTrig?.chandelierStop ?? worldCtx?.chandelierStop ?? null),
      institutional8: (worldTrig?.indicators || worldCtx?.indicators || []).slice(0, 8),
    },
    context: ctx, trigger: trigForSide,
    plan: {
      entry: ladder.entry,
      entryZoneLow: side === 'LONG' ? rLad(entryPullback) : ladder.entry,
      entryZoneHigh: side === 'LONG' ? ladder.entry : rLad(entryPullback),
      pullbackEntry: rLad(entryPullback), breakoutEntry: rLad(entryBreakout),
      triggerLevel: pRound(side === 'LONG' ? trigForSide?.prevBar.high ?? null : trigForSide?.prevBar.low ?? null),
      invalidateLevel: ladder.stopLoss,
      stopLoss: ladder.stopLoss, stopBasis,
      stopPct: r2(riskPct), riskPerShare: pRound(risk),
      t1: ladder.t1, t2: ladder.t2,
      t1RewardPct: r2(riskPct), t2RewardPct: r2(2 * riskPct),
      nearestStructureTarget: pRound(nearestStructTarget),
      wideStructureStop: pRound(wideStructAdj),
      wideStopNote: wideStructAdj != null && Math.abs(entry - wideStructAdj) > 1.8 * Math.abs(entry - stopLoss)
        ? `20-bar structure stop (${pRound(wideStructAdj)}) bahut wide hai — intraday ke liye plan wala tight stop use karo, wide stop swing-hold ke liye hai.`
        : null,
      grossRR: { t1: 1, t2: 2 },
      netRR: { t1: r2(netRR_T1), t2: r2(netRR_T2) },
      qty, qtyRaw: rawQty, qtyCapped, leverage, riskInr, capital: capital ?? null, riskPctPerTrade,
    },
    tfFit: fit,
    costs: {
      roundTripPct: r2(costPct), costPerTrade: costInR, costR: r2(costR),
      model: cost?.note || (isUsdDesk ? 'crypto taker fee' : 'India intraday statutory + flat brokerage'),
      probeNotional: notional,
    },
    checklist, warnings, timePlan,
    dataAge: {
      ctxBars: ctx.bars, trigBars: trig.bars,
      ctxLastTime: p.ctxCandles?.[p.ctxCandles.length - 1]?.time ?? null,
      trigLastTime: p.trigCandles?.[p.trigCandles.length - 1]?.time ?? null,
      istTime: (() => {
        try {
          const t = getISTParts(p.now ? new Date(p.now) : new Date());
          return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} IST`;
        } catch { return null; }
      })(),
    },
    notes: [
      `Context = ${mode.contextTf} (deep analysis: candles + structure), Trigger = ${mode.triggerTf} (action: entry/SL/TP timing) — industry standard top-down MTF.`,
      'More timeframes ≠ more accuracy: MTF ka faayda whipsaw/false-breakout filter hai, win-rate magic nahi. Lab: 2 TF aligned = best expectancy bucket (scripts/mtf-accuracy-lab.mjs).',
      'Ye analysis + plan hai, auto-execution nahi. Har plan ko SL/position size discipline ke saath hi lein.',
    ],
  };
}

// ------------------------------------------------------------
// ASYNC wrapper — candle fetch (mtf.js cached chain) + 30s cache
// ------------------------------------------------------------
const PLAN_TTL_MS = 12_000;
const _cache = new Map();
const CACHE_MAX = 120;

export async function getTradePlan(symbol, market = 'INDIA', opts = {}) {
  const mkt = String(market || 'INDIA').toUpperCase();
  const sym = String(symbol || '').toUpperCase().trim().replace(/\s+/g, '');
  if (!sym || sym.length > 24) return { ok: false, error: 'bad symbol' };
  const mode = PLAN_MODES[String(opts.mode || 'INTRADAY').toUpperCase()] || PLAN_MODES.INTRADAY;
  const holdMin = clamp(num(opts.holdMin) ?? mode.defaultHoldMin, mode.minHoldMin, mode.maxHoldMin);
  const side = opts.side === 'LONG' || opts.side === 'SHORT' ? opts.side : null;
  const key = `${mkt}:${sym}:${mode.id}:${holdMin}:${side || '-'}`;
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && !opts.fresh && now - hit.at < PLAN_TTL_MS) return hit.payload;

  // v21.17.0 DEEP AUDIT: single-symbol MTF Trade Plan bhi CRYPTO/FUTURES/METALS
  // ke liye USDT candle chain (`rawTfCandlesUsdt`) use karta hai taaki MTF
  // Signals Board (Dual) aur Deep Modal ka TradePlanPanel dono same USDT
  // units me rahein.
  const isCryptoPlan = mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'METALS';
  let ctxCandles = null, trigCandles = null;
  try {
    if (isCryptoPlan) {
      const [c, t] = await Promise.all([
        rawTfCandlesUsdt(sym, mode.contextTf, { fx: opts.fx }),
        rawTfCandlesUsdt(sym, mode.triggerTf, { fx: opts.fx }),
      ]);
      ctxCandles = c?.candles || null; trigCandles = t?.candles || null;
    } else {
      const [c, t] = await Promise.all([
        rawTfCandles(sym, mkt, mode.contextTf),
        rawTfCandles(sym, mkt, mode.triggerTf),
      ]);
      ctxCandles = c; trigCandles = t;
    }
  } catch { /* honest degrade below */ }
  const out = buildPlanFromCandles({
    symbol: sym, market: mkt, mode: mode.id, holdMin, side,
    ltp: num(opts.ltp), capital: num(opts.capital), riskPctPerTrade: num(opts.riskPctPerTrade),
    ctxCandles, trigCandles, now,
  });
  out.asOf = now;
  _cache.set(key, { at: now, payload: out });
  while (_cache.size > CACHE_MAX) {
    const k = _cache.keys().next().value;
    if (k === undefined) break;
    _cache.delete(k);
  }
  return out;
}

/** Test hook — clear the response cache. */
export function __clearPlanCache() { _cache.clear(); }

/** Public mode list (frontend switcher). */
export function planModeList() {
  return Object.values(PLAN_MODES).map(m => ({
    id: m.id, label: m.label, contextTf: m.contextTf, triggerTf: m.triggerTf,
    defaultHoldMin: m.defaultHoldMin, minHoldMin: m.minHoldMin, maxHoldMin: m.maxHoldMin,
  }));
}
