// ============================================================
// server/ai/models.js — THE SUPERINTELLIGENCE ENSEMBLE (11 models + 3 gated V2)
// ------------------------------------------------------------
// Each model is an independent "AI analyst" with its own specialty,
// reading the SAME live context and casting a weighted vote:
//
//   { dir: +1 | 0 | -1, conf: 0-100, reasons: [...] }
//
// MODEL REGISTRY (weights tuned for signal reliability):
//   1. TrendMatrix      1.4  multi-EMA alignment + ADX/DMI + supertrend
//   2. MomentumQuant    1.3  RSI regime + MACD histogram + stochastic
//   3. VolatilityScope  0.9  Bollinger squeeze/expansion + ATR percentile
//   4. VolumeFlow       1.2  rel-volume + OBV slope + MFI + VWAP side
//   5. PatternNeural    1.0  candlestick patterns + 52-week position
//   6. SRMatrix         1.1  pivot / breakout proximity logic
//   7. OptionsFlow      1.0  PCR + max-pain + IV (India indices only)
//   8. MacroRegime      0.8  NIFTY/VIX gate (India) / BTC gate (crypto)
//   9. AICouncil        1.5  LLM verification (Gemini→Groq→Cerebras)
//                           — honest OFFLINE when no AI keys configured
//  10. SmartMoneyICT    1.1  v6.7 liquidity sweeps + order blocks + FVG
//                           (ICT/SMC candle geometry — glama-inspired)
//  11. IntradayTape     1.3  v9.3 THE 15m tape seat (India desk) —
//                           EMA10/20 stack, MACD, RSI zone, session
//                           VWAP side, 3-bar momentum. The trading
//                           timeframe finally VOTES, not just advises.
//                           v10.5: when AI_ENABLE_MTF_CONFLUENCE=true
//                           this seat is held by IntradayTapeMTF
//                           (weight 1.6) — the 5m/15m/1h confluence
//                           vote; the plain 15m tape stays registered
//                           for backward-compat (flag OFF boards).
//  12. SentimentPulse    0.7  V2 Phase 1 — news headlines (RSS lexicon,
//                           India) + Fear&Greed & perp funding (crypto)
//  13. InstFlow          0.8  V2 Phase 2 — FII/DII daily net (India) ·
//                           CoinDCX orderbook depth imbalance (crypto)
//  14. FundaCheck        0.5  V2 Phase 3 — P/E vs sector avg + earnings
//                           surprise proxy (India SWING path only; the
//                           intraday board never attaches its data)
//  15. InstFlowPro       0.8  v11.6 MESH seat — Quiver congressional /
//                           insider flow (GLOBALFUTURES desk; US tickers)
//  16. TechConsensus     0.7  v11.6 MESH seat — TradingCentral's
//                           INDEPENDENT read (different methodology than
//                           this whole stack — real diversification when
//                           it agrees, a flag when it doesn't)
//  17. FundaProPlus     0.55  v11.6 MESH seat — AlphaVantage OVERVIEW +
//                           Massive profile (India swing/deep + global)
//  18. CryptoOnChainPro  0.6  v11.6 MESH seat — CoinGecko on-chain /
//                           dev / community context + CoinAPI tick drift
//                           (crypto desks)
//
// The v11.6 mesh seats ride the MCP Data Agent Mesh (server/mcp/*) —
// the FIRST time mesh data actually VOTES on a trade decision. They
// ship shadow-mode (weight 0 until settled outcomes prove an edge —
// meshModels.js applyMeshModelGating) and abstain on stale mesh data
// (the Phase-1B honesty gate). Gated by AI_ENABLE_MESH_MODELS.
//
// The ensemble aggregator (ensemble.js) turns these votes into ONE
// consensus: side, confidence, agreement and the STRONG grade that
// gates live order execution. 12/14 models feed a trained meta-
// learner when AI_ENABLE_META_ENSEMBLE=true (LightGBM stacking —
// see ml-service/models/train_signal.py); the weighted average
// remains the always-on fallback.
// ============================================================

// helper: clamp + round
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function vote(dir, conf, reasons, na = false) {
  return { dir, conf: Math.round(clamp(conf)), reasons: reasons.filter(Boolean), ...(na ? { na: true } : {}) };
}

// ------------------------------------------------------------
// V2 SIGNAL-ACCURACY UPGRADE — 3 new models behind a feature flag
// ------------------------------------------------------------
// Phase 4 wiring per the upgrade plan: all 3 entries are gated by
// AI_ENABLE_V2_MODELS so the rollout can run a clean A/B (flag OFF =
// the exact 11-model ensemble that ships today; flag ON = 14 models)
// before going live for real users. Default OFF — enable with
// AI_ENABLE_V2_MODELS=true (also accepts 1/on/yes).
import { sentimentVote } from './sentiment.js';
import { instFlowVote } from './instFlow.js';
import { fundamentalsVote } from './fundamentals.js';
// v21.12.0 MASTER ACCURACY SWITCH — stale-.env 13-seat pin disease ka
// permanent ilaaj (see accuracySuite.js header). Legacy per-flag env
// values ab sirf AI_ACCURACY_SUITE=false (legacy A/B mode) par respected.
import { accuracySuiteEnabled, legacyFlagEnabled } from './accuracySuite.js';
// v11.6 MESH-BACKED SEATS — the MCP mesh finally votes (Phase 1A).
import {
  instFlowProVote, techConsensusVote, fundaProPlusVote, cryptoOnChainProVote,
  meshModelsEnabled, MESH_MODEL_IDS,
} from './meshModels.js';

export function v2ModelsEnabled() {
  // v21.12.0 (master switch): AI_ACCURACY_SUITE (default ON) ke ON hone
  // par ye seat-group UNCONDITIONALLY ON hai — purane .env ki explicit
  // `false` line (jo v21.11.0 tak override jeet-ti thi) ab IGNORED.
  // User ka "sirf 13 models dikh rahe hain" report exactly isi stale-
  // override se aaya tha. Legacy A/B: AI_ACCURACY_SUITE=false + per-flag.
  if (accuracySuiteEnabled()) return true;
  return legacyFlagEnabled('AI_ENABLE_V2_MODELS');
}

export const V2_MODEL_IDS = ['sentiment', 'instflow', 'fundamentals'];
export { meshModelsEnabled, MESH_MODEL_IDS };

// ------------------------------------------------------------
// 1. TrendMatrix — the trend engine
// ------------------------------------------------------------
function trendMatrix(ctx) {
  const i = ctx.ind || {};
  const pts = [];
  let score = 0, conf = 0;

  // EMA stack alignment (10 > 20 > 50 for uptrend).
  if (i.ema10 != null && i.ema20 != null && i.ema50 != null) {
    if (i.ema10 > i.ema20 && i.ema20 > i.ema50) {
      // v9.2 PRICE-CONFIRMATION GUARD (the "wrong direction" fix):
      // a lagging HTF stack stays bullish for hours after an intraday
      // reversal — the vote used to read "EMA 10>20>50 bullish" on a
      // coin already dumping. Price closing below the FAST average
      // (ema10) is the textbook flip-warning: the stack term is halved
      // and the reason says so, instead of voting full-size against
      // the tape the user is watching.
      const confirmed = ctx.ltp == null || ctx.ltp > i.ema10;
      score += confirmed ? 2 : 1;
      pts.push(confirmed ? 'EMA 10>20>50 bullish stack' : 'EMA stack bullish but price < EMA10 — flip watch');
    }
    else if (i.ema10 < i.ema20 && i.ema20 < i.ema50) {
      const confirmed = ctx.ltp == null || ctx.ltp < i.ema10;
      score -= confirmed ? 2 : 1;
      pts.push(confirmed ? 'EMA 10<20<50 bearish stack' : 'EMA stack bearish but price > EMA10 — flip watch');
    }
    else { score += i.ema10 > i.ema20 ? 0.5 : -0.5; pts.push('EMA stack mixed'); }
  }
  // Price vs 50-period average.
  if (i.ema50 != null && ctx.ltp) {
    const dist = ((ctx.ltp - i.ema50) / i.ema50) * 100;
    if (Math.abs(dist) < 0.3) pts.push(`at EMA50 (${r1(dist)}%)`);
    else score += dist > 0 ? 0.7 : -0.7;
  }
  // ADX / DMI — trend strength gate.
  const adx = i.adx?.adx;
  if (adx != null) {
    const plus = i.adx?.plusDI ?? 0, minus = i.adx?.minusDI ?? 0;
    const dirn = plus > minus ? 1 : -1;
    if (adx >= 25) { score += 1.2 * dirn; pts.push(`ADX ${r1(adx)} trending, ${dirn > 0 ? '+DI leads' : '-DI leads'}`); }
    else if (adx < 18) { conf -= 12; pts.push(`ADX ${r1(adx)} weak trend`); }
  }
  // Supertrend direction.
  const st = i.supertrend?.direction;
  if (st === 1) { score += 0.8; pts.push('Supertrend bullish'); }
  else if (st === -1) { score -= 0.8; pts.push('Supertrend bearish'); }

  const dir = score > 1.2 ? 1 : score < -1.2 ? -1 : 0;
  conf = clamp(38 + Math.abs(score) * 17 + conf);
  return vote(dir, dir === 0 ? 30 : conf, pts);
}

// ------------------------------------------------------------
// v21.7.0 MACrossTracker — the MA-CROSSOVER EVENT seat (dono tabs).
// ------------------------------------------------------------
// User ask: "site me dono tabs me MA Crossover hai kya trades signals
// ke liye" — pehle NAHI tha (mlEngine.js ka heuristic golden-cross
// sirf Ask-AI chat ke /api/ml path me tha, ensemble me kabhi vote
// nahi karta tha). TrendMatrix EMA-STACK STATE padhta hai (kaun upar
// hai — alignment), cross EVENT kabhi nahi. Ye seat SMTAHI event
// momentum detect karti hai:
//   • SMA20 × SMA50 golden/death cross — bars-ago + magnitude
//   • EMA10 × EMA20 fast cross — fresh confirm ya whipsaw warning
//   • fresh cross (≤3 bar) = 76+ conf; purana cross = decay;
//     steady aligned stack = 44 continuation; mixed = no vote
//   • chase guard: price 3.5%+ extended from EMA10 → late-entry haircut
// Data: ctx.candles (crypto 1h / India index daily / deep LTF) YA
// pass-2 + deep revival me 15m candles (India intraday). Pure fn —
// unit-testable, no fetches, no clock reads.
// ------------------------------------------------------------
function _smaTail(closes, period, tail = 26) {
  const n = closes.length;
  if (n < period + 1) return null;
  const want = Math.min(tail, n - period + 1);
  const out = [];
  for (let k = 0; k < want; k++) {
    const end = n - k; // window [end-period, end)
    let s = 0;
    for (let i = end - period; i < end; i++) s += closes[i];
    out.push(s / period);
  }
  return out.reverse(); // oldest → newest
}

function _emaTail(closes, period, tail = 26) {
  const n = closes.length;
  if (n < period + 6) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += closes[i];
  e /= period;
  const start = Math.max(period, n - tail);
  const out = [];
  for (let i = period; i < n; i++) {
    e = closes[i] * k + e * (1 - k);
    if (i >= start) out.push(e);
  }
  return out; // oldest → newest
}

/** Last sign-flip of fast-vs-slow in the window: { bars, sign }
 * (bars = bars since the flip; bars null = steady state). */
function _lastCross(fast, slow) {
  const n = Math.min(fast?.length || 0, slow?.length || 0);
  if (n < 2) return null;
  const rel = [];
  for (let i = 0; i < n; i++) {
    const d = fast[i] - slow[i];
    rel.push(d > 0 ? 1 : d < 0 ? -1 : 0);
  }
  const nowSign = rel[n - 1];
  if (!nowSign) return { bars: null, sign: 0 };
  for (let i = n - 2; i >= 0; i--) {
    if (rel[i] !== 0 && rel[i] !== nowSign) {
      return { bars: n - 1 - i, sign: nowSign };
    }
  }
  return { bars: null, sign: nowSign };
}

/** PURE cross read from candles — signals.js pass-2/deep revival bhi
 * isi se 15m payload banata hai (ctx.__maCross). */
export function maCrossFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const closes = candles.map(c => Number(c?.close)).filter(Number.isFinite);
  if (closes.length < 60) return null;
  const sma20 = _smaTail(closes, 20, 26);
  const sma50 = _smaTail(closes, 50, 26);
  if (!sma20 || !sma50 || sma20.length < 2 || sma50.length < 2) return null;
  const ema10 = _emaTail(closes, 10, 26);
  const ema20 = _emaTail(closes, 20, 26);
  const lastSma50 = sma50[sma50.length - 1];
  return {
    main: _lastCross(sma20, sma50),
    fast: (ema10 && ema20) ? _lastCross(ema10, ema20) : null,
    sepPct: lastSma50 > 0 ? ((sma20[sma20.length - 1] - lastSma50) / lastSma50) * 100 : null,
  };
}

function maCrossFlow(ctx) {
  const i = ctx.ind || {};
  const pts = [];
  let dir = 0, conf = 30;
  // 1) EVENT read: revival payload (pass-2/deep 15m) ya ctx.candles history
  const cross = ctx.__maCross ?? (Array.isArray(ctx.candles) ? maCrossFromCandles(ctx.candles) : null);
  if (cross?.main && cross.main.sign !== 0 && cross.main.bars != null && cross.main.bars <= 20) {
    dir = cross.main.sign;
    const mag = Number.isFinite(cross.sepPct) ? Math.abs(cross.sepPct) : null;
    conf = cross.main.bars <= 3 ? 76 : cross.main.bars <= 8 ? 66 : cross.main.bars <= 14 ? 58 : 48;
    pts.push(`SMA20${dir > 0 ? '>' : '<'}SMA50 cross ${cross.main.bars} bar pehle${mag != null ? ` (${r1(mag)}% sep)` : ''}`);
    if (mag != null) conf += Math.min(10, mag * 4); // separation bonus (capped)
    if (cross.fast && cross.fast.sign === dir && cross.fast.bars != null && cross.fast.bars <= 10) {
      conf += 6; pts.push(`EMA10/20 ${dir > 0 ? 'golden' : 'death'} cross confirm`);
    } else if (cross.fast && cross.fast.sign === -dir && cross.fast.bars != null && cross.fast.bars <= 3) {
      conf -= 14; pts.push('EMA10/20 ulta fresh cross — whipsaw warning');
    }
  } else if (cross?.main && cross.main.sign !== 0) {
    // steady state — no flip in window: continuation read (state-confirmed)
    const stack = i.ema10 != null && i.ema20 != null && i.ema50 != null
      ? (i.ema10 > i.ema20 && i.ema20 > i.ema50 ? 1 : i.ema10 < i.ema20 && i.ema20 < i.ema50 ? -1 : 0)
      : (Number.isFinite(cross.sepPct) ? Math.sign(cross.sepPct) : 0);
    if (stack === cross.main.sign) {
      dir = stack; conf = 44;
      pts.push(`MA steady ${dir > 0 ? 'bullish' : 'bearish'} — cross window me nahi, continuation`);
    } else pts.push('MA steady par EMA stack mixed — no edge');
  } else {
    // 2) STATE fallback (no candle history — India board pass-1)
    const smaSign = i.sma20 != null && i.sma50 != null ? Math.sign(i.sma20 - i.sma50) : null;
    const emaSign = i.ema10 != null && i.ema20 != null ? Math.sign(i.ema10 - i.ema20) : null;
    if (smaSign && smaSign === emaSign) {
      dir = smaSign; conf = 42;
      pts.push(`SMA20 ${smaSign > 0 ? '>' : '<'} SMA50 + EMA10 ${smaSign > 0 ? '>' : '<'} EMA20 aligned`);
    } else pts.push('MA state missing/mixed — cross edge nahi');
  }
  // chase guard — late-entry haircut (price already ran away from fast MA)
  if (dir !== 0 && i.ema10 > 0 && ctx.ltp != null) {
    const dist = ((ctx.ltp - i.ema10) / i.ema10) * 100 * dir; // signed WITH the vote
    if (dist > 3.5) { conf -= 12; pts.push(`price ${r1(dist)}% extended from EMA10 — late chase`); }
  }
  return vote(dir, Math.max(20, conf), pts);
}

// ------------------------------------------------------------
// 2. MomentumQuant — RSI + MACD + stochastic
// ------------------------------------------------------------
function momentumQuant(ctx) {
  const i = ctx.ind || {};
  const pts = [];
  let score = 0, conf = 45;

  // v21.13 REGIME-AWARE CONTRARIAN TAILS: RSI>75 pe blanket −0.9
  // strong-trend days pe board ko vertical tops par SHORT kar deta tha
  // — the "momentum capture nahi hota" complaint (fade + price continues
  // = "opposite"). ADX >= 25 (strong trend) → continuation ±0.4 (NEVER
  // fade a trending extreme); ADX < 25 → the old contrarian fade ±0.9
  // (range/chop me exhaustion fade is the right trade).
  // ADX shape normalize: TV rows = NUMBER, candle paths = OBJECT
  // ({adx, plusDI, minusDI}) — same trap v21.4.1 [A1] fixed elsewhere.
  const _adxObj = i.adx && typeof i.adx === 'object' ? i.adx : null;
  const adxN = _adxObj ? (typeof _adxObj.adx === 'number' && isFinite(_adxObj.adx) ? _adxObj.adx : null) : (typeof i.adx === 'number' && isFinite(i.adx) ? i.adx : null);
  const strongTrend = adxN != null && adxN >= 25;
  const trendNote = adxN != null ? ` ADX ${Math.round(adxN)}` : '';

  const rsi = i.rsi;
  if (rsi != null) {
    if (rsi > 75) {
      if (strongTrend) { score += 0.4; pts.push(`RSI ${r1(rsi)} overbought but${trendNote} strong trend — continuation, no fade`); }
      else { score -= 0.9; pts.push(`RSI ${r1(rsi)} overbought — exhaustion risk`); }
    }
    else if (rsi < 25) {
      if (strongTrend) { score -= 0.4; pts.push(`RSI ${r1(rsi)} oversold but${trendNote} strong trend — continuation, no bounce-bet`); }
      else { score += 0.9; pts.push(`RSI ${r1(rsi)} oversold — bounce fuel`); }
    }
    else if (rsi > 55) { score += 1.0; pts.push(`RSI ${r1(rsi)} bullish zone`); }
    else if (rsi < 45) { score -= 1.0; pts.push(`RSI ${r1(rsi)} bearish zone`); }
    else pts.push(`RSI ${r1(rsi)} neutral`);
  }
  const m = i.macd;
  if (m && m.hist != null) {
    const h = m.hist / Math.max(1e-9, Math.abs(ctx.ltp || 1)) * 10000; // bps of price
    // v21.13 NULL-SLOPE HONESTY: histSlope null (TV snapshot — a snapshot
    // cannot know the previous bar). hist-sign still votes (reduced weight
    // 0.8/−0.8) — the old code fabricated histSlope=hist so "rising" was a
    // disguised hist-sign vote; now the label is honest and the true-slope
    // branches (candle paths) keep their full ±1.1.
    if (m.hist > 0 && (m.histSlope == null || m.histSlope > 0)) { score += m.histSlope == null ? 0.8 : 1.1; pts.push(m.histSlope == null ? 'MACD histogram positive (slope unknown)' : 'MACD histogram positive & rising'); }
    else if (m.hist < 0 && (m.histSlope == null || m.histSlope < 0)) { score -= m.histSlope == null ? 0.8 : 1.1; pts.push(m.histSlope == null ? 'MACD histogram negative (slope unknown)' : 'MACD histogram negative & falling'); }
    else if (m.histSlope > 0) { score += 0.4; pts.push('MACD turning up'); }
    else if (m.histSlope < 0) { score -= 0.4; pts.push('MACD turning down'); }
    if (Math.abs(h) > 120) conf -= 8; // extreme extension
  }
  if (i.stochK != null && i.stochD != null) {
    if (i.stochK > 80 && i.stochK < i.stochD) { score -= 0.5; pts.push('Stochastic rolling over from OB'); }
    else if (i.stochK < 20 && i.stochK > i.stochD) { score += 0.5; pts.push('Stochastic crossing up from OS'); }
    else if (i.stochK > i.stochD && i.stochK < 80) { score += 0.4; pts.push('Stoch K>D mid-zone'); }
    else if (i.stochK < i.stochD && i.stochK > 20) { score -= 0.4; pts.push('Stoch K<D mid-zone'); }
  }
  const roc = i.roc;
  if (roc != null) {
    if (roc > 4) { score += 0.4; pts.push(`10-bar ROC +${r1(roc)}%`); }
    else if (roc < -4) { score -= 0.4; pts.push(`10-bar ROC ${r1(roc)}%`); }
  }

  const dir = score > 1.0 ? 1 : score < -1.0 ? -1 : 0;
  // v6.3: base 40→45, slope ×15→×17 (a full RSI+MACD+Stoch confluence
  // now reads 75-85, not 55-65 — the ensemble needs expressive votes).
  return vote(dir, dir === 0 ? 28 : clamp(conf + Math.abs(score) * 17), pts);
}

// ------------------------------------------------------------
// 3. VolatilityScope — BB + ATR regime
// ------------------------------------------------------------
function volatilityScope(ctx) {
  const i = ctx.ind || {};
  const pts = [];
  let score = 0, conf = 42;

  const bb = i.bollinger || (i.bbUpper != null && i.bbLower != null && ctx.ltp ? {
    upper: i.bbUpper, lower: i.bbLower,
    mid: (i.bbUpper + i.bbLower) / 2,
    percentB: (ctx.ltp - i.bbLower) / Math.max(1e-9, i.bbUpper - i.bbLower),
    widthPct: ((i.bbUpper - i.bbLower) / ((i.bbUpper + i.bbLower) / 2)) * 100,
  } : null);

  if (bb && bb.percentB != null) {
    if (bb.percentB > 1) { score -= 0.8; pts.push('Price above upper Bollinger — overextended'); }
    else if (bb.percentB < 0) { score += 0.8; pts.push('Price below lower Bollinger — stretched down'); }
    else if (bb.percentB > 0.7) { score += 0.7; pts.push('%B 0.7+ — riding upper band'); }
    else if (bb.percentB < 0.3) { score -= 0.7; pts.push('%B 0.3- — riding lower band'); }
    else pts.push(`%B ${r1(bb.percentB * 100)}% mid-band`);
    // Squeeze: compressed bands often precede expansion moves — direction-neutral boost.
    if (bb.widthPct != null && bb.widthPct < 2) { conf += 10; pts.push(`BB squeeze (${r1(bb.widthPct)}% width) — breakout pending`); }
    else if (bb.widthPct != null && bb.widthPct > 8) { conf -= 8; pts.push(`BB wide (${r1(bb.widthPct)}%) — chop risk`); }
  }
  const ap = i.atrPct;
  if (ap != null) {
    if (ap > 85) { conf += 6; pts.push(`ATR percentile ${r1(ap)} — volatility expanding`); }
    else if (ap < 15) { conf -= 10; pts.push(`ATR percentile ${r1(ap)} — dead tape`); }
  }

  const dir = score > 0.8 ? 1 : score < -0.8 ? -1 : 0;
  // v6.3: base 35→42, slope ×18→×22 (band-ride votes were capped ~49).
  return vote(dir, dir === 0 ? 25 : clamp(conf + Math.abs(score) * 22), pts);
}

// ------------------------------------------------------------
// 4. VolumeFlow — volume confirms the move
// ------------------------------------------------------------
function volumeFlow(ctx) {
  const i = ctx.ind || {};
  const pts = [];
  let score = 0, conf = 40;

  const rv = i.relVolume;
  if (rv != null) {
    if (rv > 1.5) { conf += 12; pts.push(`Relative volume ${r1(rv)}x — participation`); }
    else if (rv > 1.1) { conf += 5; pts.push(`Relative volume ${r1(rv)}x`); }
    else if (rv < 0.7) { conf -= 12; pts.push(`Relative volume ${r1(rv)}x — thin`); }
  }
  const chg = ctx.changePct || 0;
  if (rv != null && rv > 1.2 && chg > 0.4) { score += 1.2; pts.push('Volume-backed upmove'); }
  else if (rv != null && rv > 1.2 && chg < -0.4) { score -= 1.2; pts.push('Volume-backed downmove'); }
  else if (rv != null && rv < 0.8 && Math.abs(chg) > 1) { score -= Math.sign(chg) * 0.6; pts.push('Move on thin volume — suspect'); }

  const obv = i.obvSlope;
  if (obv != null) {
    if (obv > 0.15) { score += 0.8; pts.push('OBV rising (accumulation)'); }
    else if (obv < -0.15) { score -= 0.8; pts.push('OBV falling (distribution)'); }
  }
  const m = i.mfi;
  if (m != null) {
    if (m > 80) { score -= 0.3; pts.push(`MFI ${r1(m)} overheated`); }
    else if (m < 20) { score += 0.3; pts.push(`MFI ${r1(m)} capitulated`); }
    else if (m > 55) { score += 0.4; pts.push(`MFI ${r1(m)} money inflow`); }
    else if (m < 45) { score -= 0.4; pts.push(`MFI ${r1(m)} money outflow`); }
  }
  // v21.0 FALSE-DIVERSITY FIX (deep-check D4): VWAP side YAHAN SE removed
  // — tape seat (IntradayTape/MTF, w 1.3/1.6) pehle se SESSION VWAP
  // ka authority hai (same TV row.vwap dono padhte the = ek hi number
  // 2.5 combined weight pe). VolumeFlow ab apne unique volume family
  // (relVol/OBV/MFI/L2 depth) pe pure hai.

  // v10.6 ORDER-FLOW DEPTH (Pro Upgrade #1 — the VolumeFlow fold-in):
  // the L2 ladder read joins the volume seat (zero change to the model
  // registry / weights / quorum caps). ctx.depth is warmed by the board
  // for the top-turnover slice; absent → the exact legacy vote.
  const d = ctx.depth;
  if (d && d.ok === true) {
    const i5 = d.imbalanceTop5, i20 = d.imbalanceTop20;
    if (i5 != null) {
      if (i5 >= 0.62) { score += 0.7; pts.push(`L2 top-5 bids hold ${Math.round(i5 * 100)}% — buyers stacked`); }
      else if (i5 <= 0.38) { score -= 0.7; pts.push(`L2 top-5 asks hold ${Math.round((1 - i5) * 100)}% — sellers stacked`); }
    }
    if (i5 != null && i20 != null) {
      if (i5 >= 0.58 && i20 >= 0.55) { score += 0.3; pts.push(`depth-confirmed (${Math.round(i20 * 100)}% bid-side at top-20)`); }
      else if (i5 <= 0.42 && i20 <= 0.45) { score -= 0.3; pts.push(`depth-confirmed sell side (${Math.round((1 - i20) * 100)}% ask-side at top-20)`); }
      else if (Math.abs(i5 - 0.5) > 0.12 && Math.abs(i20 - 0.5) < 0.06) { conf -= 5; pts.push('shallow-only imbalance — spoof risk, down-weighted'); }
    }
    if (d.nearBidWall && d.nearBidWall.distPct != null && d.nearBidWall.distPct >= 0 && d.nearBidWall.distPct <= 0.5) {
      score += 0.4; pts.push(`bid wall ${d.nearBidWall.x}x at ${d.nearBidWall.price} (${d.nearBidWall.distPct}% below)`);
    }
    if (d.nearAskWall && d.nearAskWall.distPct != null && d.nearAskWall.distPct >= 0 && d.nearAskWall.distPct <= 0.5) {
      score -= 0.4; pts.push(`ask wall ${d.nearAskWall.x}x at ${d.nearAskWall.price} (${d.nearAskWall.distPct}% above)`);
    }
    if (d.spoofRisk) { conf -= 6; pts.push('book walls vanished between snapshots — spoof pattern, conviction cut'); }
  }

  const dir = score > 0.9 ? 1 : score < -0.9 ? -1 : 0;
  // v6.3: base 35→40, slope ×16→×18 (vol-backed moves read 70+, thin
  // tape still penalised via the conf adjustments above).
  return vote(dir, dir === 0 ? 25 : clamp(conf + Math.abs(score) * 18), pts);
}

// ------------------------------------------------------------
// 5. PatternNeural — candlestick + 52-week context
// ------------------------------------------------------------
function patternNeural(ctx) {
  const i = ctx.ind || {};
  const pts = [];
  let score = 0, conf = 38;

  const patterns = Array.isArray(i.patterns) ? i.patterns : [];
  for (const p of patterns) {
    if (p.bias === 1) { score += 0.9; pts.push(`${p.name} (bullish)`); }
    else if (p.bias === -1) { score -= 0.9; pts.push(`${p.name} (bearish)`); }
    else pts.push(`${p.name} (indecision)`);
  }
  if (i.high52w != null && i.low52w != null && ctx.ltp) {
    const range = i.high52w - i.low52w;
    const pos = range > 0 ? (ctx.ltp - i.low52w) / range : 0.5;
    if (pos > 0.95) { score += 0.6; conf += 6; pts.push('At 52-week high — breakout zone'); }
    else if (pos > 0.8) { score += 0.3; pts.push(`Near 52w high (${Math.round(pos * 100)}%)`); }
    else if (pos < 0.05) { score -= 0.6; conf += 6; pts.push('At 52-week low — breakdown zone'); }
    else if (pos < 0.2) { score -= 0.3; pts.push(`Near 52w low (${Math.round(pos * 100)}%)`); }
    else pts.push(`52w range position ${Math.round(pos * 100)}%`);
  }
  const rec = i.recommend;
  if (rec != null) {
    // TV's own aggregate recommendation: -1..1 scale.
    if (rec > 0.3) { score += 0.5; pts.push('TV composite rating bullish'); }
    else if (rec < -0.3) { score -= 0.5; pts.push('TV composite rating bearish'); }
  }

  const dir = score > 0.7 ? 1 : score < -0.7 ? -1 : 0;
  // v6.3: base 32→38 (pattern votes were the weakest link in the board).
  return vote(dir, dir === 0 ? 22 : clamp(conf + patterns.length * 8 + Math.abs(score) * 14), pts);
}

// ------------------------------------------------------------
// 6. SRMatrix — support/resistance + pivots
// ------------------------------------------------------------
function srMatrix(ctx) {
  const i = ctx.ind || {};
  const pts = [];
  let score = 0, conf = 36;

  const piv = i.pivot;
  if (piv && piv.p != null && ctx.ltp) {
    const d = ((ctx.ltp - piv.p) / piv.p) * 100;
    if (d > 0.2) { score += 0.7; pts.push(`Above pivot (${r1(d)}%)`); }
    else if (d < -0.2) { score -= 0.7; pts.push(`Below pivot (${r1(d)}%)`); }
    else pts.push('At daily pivot');
    // Breakout above R1 / breakdown below S1.
    if (piv.r1 != null && ctx.ltp > piv.r1 * 1.001) { score += 0.6; conf += 8; pts.push('Trading above R1 — breakout'); }
    if (piv.s1 != null && ctx.ltp < piv.s1 * 0.999) { score -= 0.6; conf += 8; pts.push('Trading below S1 — breakdown'); }
    // Mean-reversion pull when far from pivot.
    if (Math.abs(d) > 1.8) { score -= Math.sign(d) * 0.4; pts.push('Extended far from pivot'); }
  }
  // Prior-day candle high/low levels (from candles when available).
  const candles = ctx.candles;
  if (Array.isArray(candles) && candles.length >= 2) {
    const prev = candles[candles.length - 2];
    if (ctx.ltp > prev.high) { score += 0.4; pts.push('Above prev-day high'); }
    else if (ctx.ltp < prev.low) { score -= 0.4; pts.push('Below prev-day low'); }
  }

  const dir = score > 0.7 ? 1 : score < -0.7 ? -1 : 0;
  // v6.3: base 30→36, slope ×20→×24 (pivot-break votes were capped ~64).
  return vote(dir, dir === 0 ? 22 : clamp(conf + Math.abs(score) * 24), pts);
}

// ------------------------------------------------------------
// 7. OptionsFlow — India index options intelligence
// (PCR extremes are CONTRARIAN; OI walls act as magnets/support)
// ------------------------------------------------------------
function optionsFlow(ctx) {
  const o = ctx.options;
  // v11.8: `na: true` = STRUCTURAL abstain — spot crypto and single
  // stocks have no option chain to read; the seat cannot serve this
  // market, so it must not sit in the quorum denominator either
  // (the applicable-committee fix in ensemble.js).
  if (!o) return vote(0, 0, ['No option-chain data (stock / crypto) — model abstains'], true);
  const pts = [];
  let score = 0, conf = 40;

  const pcr = o.pcr;
  if (pcr != null) {
    if (pcr > 1.4) { score += 1.0; conf += 8; pts.push(`PCR ${r1(pcr)} extreme put-heavy — contrarian bullish`); }
    else if (pcr < 0.6) { score -= 1.0; conf += 8; pts.push(`PCR ${r1(pcr)} extreme call-heavy — contrarian bearish`); }
    else pts.push(`PCR ${r1(pcr)} balanced`);
  }
  if (o.maxPain != null && ctx.ltp) {
    const dist = ((o.maxPain - ctx.ltp) / ctx.ltp) * 100;
    if (Math.abs(dist) > 0.4) {
      score += Math.sign(dist) * 0.7; // price tends to gravitate toward max pain
      pts.push(`Max pain ₹${o.maxPain} is ${r1(Math.abs(dist))}% ${dist > 0 ? 'above' : 'below'} spot — gravity ${dist > 0 ? 'up' : 'down'}`);
    } else pts.push('Spot at max pain');
  }
  if (o.ivPercentile != null) {
    if (o.ivPercentile > 80) { conf -= 6; pts.push(`IV percentile ${r1(o.ivPercentile)} — premium-rich, prefer spreads`); }
    else if (o.ivPercentile < 20) { conf += 4; pts.push(`IV percentile ${r1(o.ivPercentile)} — cheap options, longs favoured`); }
  }
  if (o.oiSkew != null) {
    if (o.oiSkew > 0.15) { score += 0.5; pts.push('Call OI building over puts — writers confident upside'); }
    else if (o.oiSkew < -0.15) { score -= 0.5; pts.push('Put OI building over calls — writers defending downside'); }
  }

  const dir = score > 0.7 ? 1 : score < -0.7 ? -1 : 0;
  // v6.3: base 34→40, slope ×16→×18 (PCR-extreme votes read 75+).
  return vote(dir, dir === 0 ? 25 : clamp(conf + Math.abs(score) * 18), pts);
}

// ------------------------------------------------------------
// 8. MacroRegime — the market gate
// ------------------------------------------------------------
// v6.12 PRO RECALIBRATION: the old bands (BTC ±1.5%, NIFTY ±0.5%)
// read "BTC -1.4%" as NEUTRAL while alts correlate ~0.8 with BTC —
// the whole board went LONG into a red BTC day. Tightened:
//   CRYPTO  BTC ±0.75% directional, ±2.5% strong
//   INDIA   NIFTY ±0.35% directional, ±1.0% strong
// Daily EMA trend tie-break lives in probrain.regimeGate.
function macroRegime(ctx) {
  const reg = ctx.regime || {};
  const pts = [];
  let score = 0, conf = 40;

  // v6.12.1 FIX (recheck H-2): FUTURES contexts carry the CRYPTO
  // regime (buildRegime('FUTURES') → btcChange/btcTrend) — the old
  // CRYPTO-only check pushed them into the NIFTY branch where the
  // model silently abstained on the whole FUTURES desk.
  const isCryptoish = ctx.market === 'CRYPTO' || ctx.market === 'FUTURES';
  if (isCryptoish) {
    const btc = reg.btcChange;
    if (btc != null) {
      if (btc > 2.5) { score += 1.2; pts.push(`BTC +${r1(btc)}% STRONG risk-on — alts ke liye tailwind`); }
      else if (btc > 0.75) { score += 1.0; pts.push(`BTC +${r1(btc)}% — risk-on regime`); }
      else if (btc < -2.5) { score -= 1.2; pts.push(`BTC ${r1(btc)}% STRONG risk-off — alts bleed`); }
      else if (btc < -0.75) { score -= 1.0; pts.push(`BTC ${r1(btc)}% — risk-off, alts flat/weak`); }
      else pts.push(`BTC ${r1(btc)}% flat — regime neutral`);
    }
  } else {
    const nifty = reg.niftyChange, vix = reg.indiaVix;
    if (nifty != null) {
      if (nifty > 1.0) { score += 1.0; pts.push(`NIFTY +${r1(nifty)}% strong risk-on`); }
      else if (nifty > 0.35) { score += 0.8; pts.push(`NIFTY +${r1(nifty)}% — broad risk-on`); }
      else if (nifty < -1.0) { score -= 1.0; pts.push(`NIFTY ${r1(nifty)}% strong risk-off`); }
      else if (nifty < -0.35) { score -= 0.8; pts.push(`NIFTY ${r1(nifty)}% — broad risk-off`); }
    }
    if (vix != null) {
      if (vix > 18) { conf -= 10; pts.push(`India VIX ${r1(vix)} elevated — size down`); }
      else if (vix < 11) { conf += 5; pts.push(`India VIX ${r1(vix)} calm`); }
    }
  }
  const dir = score > 0.6 ? 1 : score < -0.6 ? -1 : 0;
  // v6.3: base 30→40, slope ×18→×22 (macro gate votes were capped ~48).
  return vote(dir, dir === 0 ? 25 : clamp(conf + Math.abs(score) * 22), pts);
}

// ------------------------------------------------------------
// 9. AICouncil — LLM verification (chain: Gemini → Groq → Cerebras)
//    Vote shape set by routes layer after the LLM responds.
// ------------------------------------------------------------
export function aiCouncilVoteFromVerdict(verdict) {
  if (!verdict) return null;
  const v = String(verdict.verdict || '').toUpperCase();
  const conf = clamp(Number(verdict.confidence) || 0);
  if (v === 'LONG') return vote(1, Math.max(55, conf), [verdict.note, verdict.analysis].filter(Boolean).slice(0, 2));
  if (v === 'SHORT') return vote(-1, Math.max(55, conf), [verdict.note, verdict.analysis].filter(Boolean).slice(0, 2));
  if (v === 'AVOID') return vote(0, Math.max(50, conf), [verdict.note || 'AI Council says avoid'].filter(Boolean));
  return null;
}

import { smcVote } from './lib/smc.js';
import { fibonacciRetracement, volumeProfile, supplyDemandZones } from './lib/indicators.js';

// ------------------------------------------------------------
// 19. StructurePro — v21.0 THE KEY-LEVEL CONFLUENCE SEAT
// ------------------------------------------------------------
// v21.0 FALSE-DIVERSITY FIX (deep-check D1): ye seat pehle BOS/CHoCH
// + premium/discount bhi calculate karta tha — EXACTLY wahi functions
// (swingStructure/premiumDiscount) jo SmartMoneyICT (w 1.1) already
// run karta tha same candles pe. Committee ka ~16.4% weight ek hi
// structure opinion ka double-count tha. Ab StructurePro apne UNIQUE
// legs pe pure hai: Fib golden pocket + Volume-Profile POC/VA +
// Supply/Demand zones + EMA100/200 macro. Structure authority = SMC.
// (Statistical safety-net: seatCorrelation.js guard bhi live hai.)
export function structurePro(ctx) {
  const candles = Array.isArray(ctx?.candles) ? ctx.candles : null;
  const ind = ctx?.ind || {};
  if (!candles || candles.length < 60) {
    return vote(0, 0, ['StructurePro: candles nahi — Fib/VP/S&D sab candle-geometry hai (abstain)']);
  }
  const pts = [];
  let score = 0, conf = 40;

  // 1) Fibonacci golden pocket (0.618-0.65 of the active leg)
  const fib = fibonacciRetracement(candles);
  if (fib?.inGoldenPocket) {
    score += fib.direction === 'up' ? 1.2 : -1.2;
    conf += 8;
    pts.push(`Fib golden pocket ${Math.round(fib.goldenPocket.low)}–${Math.round(fib.goldenPocket.high)} of ${fib.direction}-leg — continuation zone`);
  } else if (fib) {
    pts.push(`Fib position ${fib.positionPct}% of ${fib.direction}-leg`);
  }

  // 2) volume profile — POC side + value area
  const vp = volumeProfile(candles);
  if (vp) {
    if (vp.priceVsPoc === 'above') { score += 0.6; pts.push(`price above VP-POC ${Math.round(vp.poc)} — value support niche`); }
    else if (vp.priceVsPoc === 'below') { score -= 0.6; pts.push(`price below VP-POC ${Math.round(vp.poc)} — value resistance upar`); }
    if (vp.inValueArea) conf += 5;
  }

  // 3) supply/demand zone retest
  const sd = supplyDemandZones(candles);
  if (sd?.demand?.inZone) { score += 1.0; conf += 6; pts.push(`DEMAND zone ${Math.round(sd.demand.bottom)}–${Math.round(sd.demand.top)} me price — institutional support`); }
  if (sd?.supply?.inZone) { score -= 1.0; conf += 6; pts.push(`SUPPLY zone ${Math.round(sd.supply.bottom)}–${Math.round(sd.supply.top)} me price — distribution`); }

  // 4) EMA100/200 macro alignment
  const ltp = candles[candles.length - 1].close;
  const e100 = Number(ind.ema100), e200 = Number(ind.ema200);
  if (e100 > 0 && e200 > 0) {
    if (e100 > e200 && ltp > e100) { score += 0.7; pts.push('EMA100>200 macro-up + price above EMA100'); }
    else if (e100 < e200 && ltp < e100) { score -= 0.7; pts.push('EMA100<200 macro-down + price below EMA100'); }
  }

  const dir = score > 0.9 ? 1 : score < -0.9 ? -1 : 0;
  return vote(dir, dir === 0 ? 30 : clamp(conf + Math.abs(score) * 15), pts);
}

// ------------------------------------------------------------
// 11. IntradayTape — v9.3 THE 15-MINUTE TAPE SEAT
// ------------------------------------------------------------
// THE "wrong trend" fix. The India desk's other models read the TV
// scanner snapshot, which serves DAILY-timeframe indicators (verified
// live: scanner EMA10/EMA50 == Yahoo DAILY EMAs to the cent). A stock
// can sit in a multi-day downtrend (daily RSI 37, price below every
// daily EMA) while its 15-minute tape is RIPPING UP — the committee
// voted "STRONG SHORT" off the daily stack while the user watched the
// price climb against their fresh short (the exact screenshot bug).
//
// This model gives the timeframe the user actually TRADES (15:15
// square-off, entry cutoff 15:00) a full committee seat:
//   • 15m EMA10/20 stack + price position
//   • 15m MACD histogram + slope
//   • 15m RSI momentum zone (with exhaustion guards)
//   • session-VWAP side (from the TV row — true session anchor)
//   • last-3-bar momentum (the tape direction RIGHT NOW)
//
// CRYPTO/FUTURES desks: abstains with an honest reason — their ctx.ind
// already merges live 1h candle indicators at build time, so a second
// tape vote would double-count the same timeframe.
//
// v10.5: the scoring core lives in tapeVote(tape, label) so the MTF
// seat can run the IDENTICAL read on the 5m/15m/1h tapes (label is
// just the reason prefix — output for '15m' is byte-identical to the
// v9.3 single-TF model, the tape-alignment tests lock that).
export function tapeVote(t, label = '15m') {
  if (!t || typeof t !== 'object') {
    return vote(0, 0, [`${label} tape unavailable — model abstains (honest degrade)`]);
  }
  const pts = [];
  let score = 0; const conf = 42; // v21.1.0: conf const — tapeVote me kabhi reassign nahi hota (prefer-const)
  const ltp = t.ltp, e10 = t.ema10, e20 = t.ema20;

  // EMA stack + price position — the tape's own trend.
  if (e10 != null && e20 != null && ltp > 0) {
    if (e10 > e20 && ltp > e10) { score += 1.2; pts.push(`${label} EMA10>20 stack, price above EMA10 — tape rising`); }
    else if (e10 < e20 && ltp < e10) { score -= 1.2; pts.push(`${label} EMA10<20 stack, price below EMA10 — tape falling`); }
    else if (e10 > e20 && ltp < e20) { score -= 0.7; pts.push(`${label} EMA10>20 stack broken — price below EMA10 & EMA20`); }
    else if (e10 < e20 && ltp > e20) { score += 0.7; pts.push(`${label} EMA10<20 stack reclaimed — price above EMA10 & EMA20`); }
    else if (e10 > e20) { score += 0.5; pts.push(`${label} stack up, price pulling back under EMA10`); }
    else if (e10 < e20) { score -= 0.5; pts.push(`${label} stack down, price bouncing over EMA10`); }
    else pts.push(`${label} EMA10 = EMA20 (coil)`);
  }
  // MACD momentum.
  if (t.macdHist != null) {
    if (t.macdHist > 0 && (t.macdSlope ?? 0) > 0) { score += 0.9; pts.push(`${label} MACD histogram positive & rising`); }
    else if (t.macdHist < 0 && (t.macdSlope ?? 0) < 0) { score -= 0.9; pts.push(`${label} MACD histogram negative & falling`); }
    else if ((t.macdSlope ?? 0) > 0) { score += 0.3; pts.push(`${label} MACD turning up`); }
    else if ((t.macdSlope ?? 0) < 0) { score -= 0.3; pts.push(`${label} MACD turning down`); }
  }
  // RSI momentum zone — with exhaustion guards (never chase blow-offs).
  if (t.rsi != null) {
    if (t.rsi > 60 && t.rsi <= 75) { score += 0.6; pts.push(`${label} RSI ${r1(t.rsi)} momentum zone`); }
    else if (t.rsi < 40 && t.rsi >= 25) { score -= 0.6; pts.push(`${label} RSI ${r1(t.rsi)} weakness zone`); }
    if (t.rsi > 78) { score -= 0.4; pts.push(`${label} RSI ${r1(t.rsi)} overbought — exhaustion`); }
    if (t.rsi < 22) { score += 0.4; pts.push(`${label} RSI ${r1(t.rsi)} oversold — bounce fuel`); }
  }
  // Session-VWAP side (TV row's true session anchor).
  if (t.vwap != null && ltp > 0) {
    const vd = ((ltp - t.vwap) / t.vwap) * 100;
    if (vd > 0.08) { score += 0.5; pts.push(`Above session VWAP +${r1(vd)}%`); }
    else if (vd < -0.08) { score -= 0.5; pts.push(`Below session VWAP ${r1(vd)}%`); }
    else pts.push('Hugging session VWAP');
  }
  // Last-3-bar momentum — the tape direction RIGHT NOW.
  if (t.last3Pct != null) {
    if (t.last3Pct > 0.25) { score += 0.6; pts.push(`3-bar tape +${r1(t.last3Pct)}%`); }
    else if (t.last3Pct < -0.25) { score -= 0.6; pts.push(`3-bar tape ${r1(t.last3Pct)}%`); }
  }

  const dir = score > 0.9 ? 1 : score < -0.9 ? -1 : 0;
  return vote(dir, dir === 0 ? 26 : clamp(conf + Math.abs(score) * 18), pts);
}

function intradayTape(ctx) {
  // v12.6: DATA-DRIVEN GATE — the seat votes whenever a TAPE payload is
  // present on the ctx, regardless of desk. The crypto/futures boards'
  // new 15m enrichment (signals.js pass-2) supplies ctx.tape for the top
  // candidates; the plain 1h candle path never sets it, so the abstain
  // stays data-driven instead of market-driven. Different timeframe =
  // different information: the 1h committee reads the SWING, the 15m
  // tape reads ENTRY TIMING — the old "no double count" note only ever
  // applied to reading the SAME series twice, which this never was.
  // (Live 2026-09-20 ground truth: with the tape seat parked, the
  // crypto/futures committee degenerated into 4 lagging 1h trend seats
  // voting LONG together AFTER the move — the replay engine measured
  // 29% win-rate / avgR −0.35. This seat is the counterweight.)
  const t = ctx.tape;
  if (!t || typeof t !== 'object') {
    return vote(0, 0, ['15m tape unavailable — model abstains (honest degrade)']);
  }
  return tapeVote(t, '15m');
}

// ------------------------------------------------------------
// 11b. IntradayTapeMTF — v10.5 THE 5m/15m/1h CONFLUENCE SEAT
// ------------------------------------------------------------
// The multi-timeframe upgrade of the 15m tape seat: 5m (entry
// timing), 15m (the TRADING timeframe — anchor), and 1h (the
// intraday trend) each get the same tape read; the vote is the
// 15m direction scaled by the 3-TF confluence:
//   agreement = matching dirs / 3   (vs the 15m anchor)
//   agreement === 1        → conf +15  (all three aligned)
//   agreement < 0.67       → conf -20 (2+ TFs disagree)
// The ensemble layer additionally caps a <0.67 board at ACTION
// (never STRONG). Gated by AI_ENABLE_MTF_CONFLUENCE — flag OFF
// keeps the exact 11-model v9.3 board (plain IntradayTape 1.3).
export function mtfConfluenceEnabled() {
  // v21.11.0 (Superintelligence accuracy upgrade): DEFAULT ON — the
  // tape seat upgrade (w 1.3 → 1.6 MTF confluence) is the repo's own
  // documented accuracy lever (models.js intradayTape comment: tape
  // seat parked hone par crypto/futures committee 29% win-rate disease).
  // Crypto/futures desks gracefully degrade to the plain 15m read (same
  // seat, honest label) — India gets the full 5m/15m/1h confluence.
  // v21.12.0 (master switch): AI_ACCURACY_SUITE (default ON) ke ON hone
  // par MTF tape UNCONDITIONALLY ON — stale AI_ENABLE_MTF_CONFLUENCE=false
  // ab ignored. Legacy A/B: AI_ACCURACY_SUITE=false + per-flag.
  if (accuracySuiteEnabled()) return true;
  return legacyFlagEnabled('AI_ENABLE_MTF_CONFLUENCE');
}

function intradayTapeMTF(ctx) {
  // v12.6: same data-driven gate as the plain tape seat — the crypto/
  // futures 15m enrichment supplies ctx.tape; the 5m/15m/1h tapeMTF
  // payload stays India-only (its 5m base is a Yahoo India source).
  // Without tapeMTF the fn degrades to the plain 15m read below.
  // graceful degrade: no MTF payload → the plain 15m tape logic
  const m = ctx.tapeMTF;
  if (!m || typeof m !== 'object' || !m.m15) {
    if (ctx.tape) return intradayTape(ctx);
    return vote(0, 0, ['MTF tape unavailable — model abstains (honest degrade)']);
  }

  const perTf = {};
  for (const [tf, tape] of [['m5', m.m5], ['m15', m.m15], ['h1', m.h1]]) {
    if (!tape || typeof tape !== 'object') { perTf[tf] = null; continue; }
    const v = tapeVote(tape, tf === 'h1' ? '1h' : tf === 'm5' ? '5m' : '15m');
    perTf[tf] = v.dir !== 0 ? v : null;
  }
  const anchor = perTf.m15; // the trading timeframe carries the vote
  if (!anchor) {
    return vote(0, 0, ['15m tape read is neutral/coil — MTF model abstains']);
  }

  // agreement = countMatchingDir(dir5m, dir15m, dir1h) / 3 — measured
  // against the 15m anchor (the TF the user actually trades).
  const dirs = [perTf.m5?.dir ?? 0, perTf.m15.dir, perTf.h1?.dir ?? 0];
  const matching = dirs.filter(d => d === perTf.m15.dir).length;
  // v10.5.1: integer-exact threshold — the plan's "agreement < 0.67"
  // means FEWER than 2 of 3 timeframes aligned (0.67 ≈ 2/3, but the
  // float 2/3 = 0.666… would wrongly trip its own 2-of-3 case). Only
  // 1-of-3 (or 0) disagreements pay the penalty.
  const alignedCount = matching;
  const agreement = matching / 3;

  let conf = anchor.conf;
  const pts = [];
  const label = (tf, v) => `${tf} ${v != null ? (v.dir > 0 ? '↑ bull' : '↓ bear') : '· neutral'}`;
  pts.push(`MTF read — ${label('5m', perTf.m5)} · ${label('15m', perTf.m15)} · ${label('1h', perTf.h1)} · ${Math.round(agreement * 100)}% aligned`);
  if (perTf.m5) pts.push(...(perTf.m5.reasons || []).slice(0, 1).map(r => `5m: ${r}`));
  if (perTf.h1) pts.push(...(perTf.h1.reasons || []).slice(0, 1).map(r => `1h: ${r}`));

  if (alignedCount === 3) {
    conf += 15;
    pts.push('ALL 3 timeframes aligned (5m/15m/1h) — full confluence boost');
  } else if (alignedCount < 2) {
    conf -= 20;
    pts.push('Timeframe conflict (2+ of 3 disagree) — conviction penalized, STRONG banned');
  } else {
    pts.push('2 of 3 timeframes aligned — partial confluence');
  }

  const out = vote(anchor.dir, clamp(conf), pts.filter(Boolean));
  // ACCURACY-PLAN PHASE 2.1 — the A/B SHADOW arm: the byte-identical
  // plain 15m read (the v9.3 seat, NO agreement boost/penalty) rides
  // the vote so the ledger journals BOTH arms on every executed signal.
  // Settled outcomes then measure the MTF upgrade's calibration delta
  // (Brier + conf separation) vs the plain 15m seat — the "is w1.6
  // genuinely better than w1.3" question answered by data, not guesses.
  // Only stamped when the MTF payload actually ran (degraded fallbacks
  // are the plain seat already — no arm to compare).
  try {
    const abPlain = tapeVote(m.m15, '15m');
    if (abPlain && abPlain.dir !== 0) {
      out.__abShadow = { id: 'ab_tape15m', dir: abPlain.dir, conf: abPlain.conf, weight: 1.3 };
    }
  } catch { /* shadow is best-effort — the MTF vote itself is the product */ }
  return out;
}

// ------------------------------------------------------------
// REGISTRY (the "Superintelligence MCP model bus")
// ------------------------------------------------------------
export const MODELS = [
  { id: 'trend', name: 'TrendMatrix', role: 'Multi-EMA stack + ADX/DMI + Supertrend', weight: 1.4, fn: trendMatrix },
  { id: 'momentum', name: 'MomentumQuant', role: 'RSI regime + MACD histogram + Stochastic', weight: 1.3, fn: momentumQuant },
  { id: 'volatility', name: 'VolatilityScope', role: 'Bollinger squeeze/expansion + ATR percentile', weight: 0.9, fn: volatilityScope },
  { id: 'volume', name: 'VolumeFlow', role: 'Rel-volume + OBV + MFI + L2 depth (VWAP side v21.0 me Tape seat ko diya — duplicate count fix)', weight: 1.2, fn: volumeFlow },
  { id: 'pattern', name: 'PatternNeural', role: 'Candlestick patterns + 52-week position', weight: 1.0, fn: patternNeural },
  { id: 'sr', name: 'SRMatrix', role: 'Pivot levels + breakout / breakdown', weight: 1.1, fn: srMatrix },
  { id: 'options', name: 'OptionsFlow', role: 'PCR + max pain + IV percentile (contrarian)', weight: 1.0, fn: optionsFlow },
  { id: 'regime', name: 'MacroRegime', role: 'NIFTY/VIX gate (India) · BTC gate (crypto)', weight: 0.8, fn: macroRegime },
  { id: 'smc', name: 'SmartMoneyICT', role: 'Liquidity sweeps + order blocks + FVG + BOS/CHoCH + EQH/EQL + premium/discount (SMC v2)', weight: 1.1, fn: smartMoneyICT },
  { id: 'structure', name: 'StructurePro', role: 'Fib golden pocket + Volume-Profile POC + Supply/Demand zones + EMA100/200 (BOS/CHoCH v21.0 me SMC ko diya — duplicate fix)', weight: 1.0, fn: structurePro },
  // v21.7.0 (Issue-2): the MA-CROSSOVER EVENT seat — dono tabs (India
  // 15m revival / crypto 1h candles). TrendMatrix reads STACK STATE;
  // ye seat SMTAHI 20/50 + 10/20 cross events vote karti hai. core
  // weight — seatCorrelation me trend>macross static pair hai (ledger
  // evidence jaam hone par auto-discount, pehle 1.0 weight).
  { id: 'macross', name: 'MACrossTracker', role: 'SMA20/50 + EMA10/20 golden/death CROSS EVENTS (fresh cross momentum — dono tabs)', weight: 1.15, fn: maCrossFlow },
  // v10.5 MTF CONFLUENCE (Upgrade 1): flag ON → the tape seat is held
  // by IntradayTapeMTF (w 1.6, 5m/15m/1h confluence); flag OFF → the
  // exact v9.3 11-model board (plain IntradayTape w 1.3). Same seat —
  // no double-count, either flavour.
  ...(mtfConfluenceEnabled()
    ? [{ id: 'tape-mtf', name: 'IntradayTapeMTF', role: '5m/15m/1h confluence vote (MTF tape — replaces 15m-only seat)', weight: 1.6, fn: intradayTapeMTF }]
    : [{ id: 'tape', name: 'IntradayTape', role: '15m EMA/MACD/RSI + session VWAP + 3-bar momentum (India tape)', weight: 1.3, fn: intradayTape }]),
  { id: 'aicouncil', name: 'AI Council (LLM)', role: 'Gemini → Groq → Cerebras verification chain', weight: 1.5, fn: null },
  // ---- V2 (Phase 1-3 of the signal-accuracy upgrade). Deliberately
  // LOW weights until adaptive.js earns multipliers from settled
  // outcomes (MIN_SAMPLE 8). Gated by AI_ENABLE_V2_MODELS.
  ...(v2ModelsEnabled() ? [
    { id: 'sentiment', name: 'SentimentPulse', role: 'News headlines + Fear&Greed/funding sentiment', weight: 0.7, fn: sentimentVote },
    { id: 'instflow', name: 'InstFlow', role: 'FII/DII net (India) · orderbook imbalance (crypto)', weight: 0.8, fn: instFlowVote },
    { id: 'fundamentals', name: 'FundaCheck', role: 'P/E vs sector avg + earnings surprise (India swing only)', weight: 0.5, fn: fundamentalsVote },
  ] : []),
  // ---- v11.6 MESH SEATS (Superintelligence MCP upgrade, Phase 1A).
  // Real mesh data finally VOTES. Shadow-mode until settled outcomes
  // prove an edge (applyMeshModelGating in signals.js sets weight 0
  // until meshModelAccountability promotes the seat); honesty-gated
  // abstention on stale data is inside each vote fn. Weights stay
  // deliberately modest — they must be EARNED, not assumed.
  ...(meshModelsEnabled() ? [
    { id: 'instflowpro', name: 'InstFlowPro', role: 'Quiver congressional + insider flow (US/global desk, mesh alt-data)', weight: 0.8, fn: instFlowProVote },
    { id: 'techconsensus', name: 'TechConsensus', role: 'TradingCentral independent vendor consensus (mesh)', weight: 0.7, fn: techConsensusVote },
    { id: 'fundaproplus', name: 'FundaProPlus', role: 'AlphaVantage + Massive deep fundamentals (mesh, swing/global)', weight: 0.55, fn: fundaProPlusVote },
    { id: 'cryptoonchain', name: 'CryptoOnChainPro', role: 'CoinGecko on-chain/dev context + CoinAPI tick drift (mesh)', weight: 0.6, fn: cryptoOnChainProVote },
  ] : []),
];

export function runQuantModels(ctx) {
  return MODELS.filter(m => m.fn)
    .map(m => {
      try {
        const v = m.fn(ctx);
        return { id: m.id, name: m.name, weight: m.weight, role: m.role, ...v };
      } catch (e) {
        return { id: m.id, name: m.name, weight: m.weight, role: m.role, dir: 0, conf: 0, reasons: [`model error: ${e?.message || 'unknown'}`] };
      }
    });
}

// v6.7 — 10th model: ICT / smart-money geometry (thin wrapper so the
// registry stays uniform; smcVote accepts the ctx directly).
function smartMoneyICT(ctx) {
  return smcVote(ctx);
}
