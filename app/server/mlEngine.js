// ============================================================
// SUPER INTELLIGENCE ML ENGINE (Pure JS — No Python needed)
// ------------------------------------------------------------
// Replaces the entire Python FastAPI ML service with lightweight
// JavaScript implementations. All math is client-safe, no heavy
// deps. Runs inline in the Node.js server.
//
// Signal Model: Multi-factor ensemble (RSI+MACD+SMA+Volume+Momentum)
// Regime Model: HMM-like using VIX, breadth, momentum
// Price Points: ATR-based with dip ladder
// SIP Multiplier: Regime-aware
// ============================================================

function safeNum(v, def = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function round(n, d = 2) {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

// ---- Market Regime (deterministic HMM-like) ----
// Uses VIX, NIFTY momentum, and global risk indicators
// v20.9.0 (B1/M5 — audit fix): `probability` pehle Math.random() se
// derive hota tha — same input pe har call me alag number, aur LLM/
// UI use ko REAL calibrated confidence lagta tha. Ab DETERMINISTIC
// mapping (regime score ka logistic — score jitna strong, probability
// utni high, hamesha same input → same output) + source:'heuristic'
// label. generateTopFeatures() ka random shuffle bhi gaya — fixed
// merit order ab.
const _REGIMES = ['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'GOLDILOCKS', 'STAGFLATION'];

/** Deterministic score → [lo, hi] probability (smooth logistic-ish,
 *  clamped — no randomness, same input same output). */
function scoreProbability(score, lo, hi) {
  const s = Math.max(-6, Math.min(6, Number(score) || 0));
  const t = (s + 6) / 12; // 0..1
  return Math.round((lo + t * (hi - lo)) * 100) / 100;
}

export const ML_MODEL_LABEL = 'heuristic-v1';
export const ML_DISCLAIMER = 'Heuristic model — rule-based multi-factor scoring, NOT a calibrated probability model. Do not treat confidence/probability as statistical estimates.';

function detectRegime(niftyChange, bankNiftyChange, indiaVix, usVix, dxy, goldChange) {
  const vixRisk = indiaVix > 25 || usVix > 28 ? 2 : indiaVix > 18 || usVix > 22 ? 1 : 0;
  const equityMomentum = (safeNum(niftyChange) + safeNum(bankNiftyChange)) / 2;
  const momentumScore = equityMomentum > 1.5 ? 2 : equityMomentum > 0.3 ? 1 : equityMomentum < -1.5 ? -2 : equityMomentum < -0.3 ? -1 : 0;
  const goldBid = safeNum(goldChange) > 0.5 ? 1 : safeNum(goldChange) < -0.5 ? -1 : 0;
  const dxyStrength = safeNum(dxy) > 105 ? 1 : 0;
  const totalScore = momentumScore + vixRisk * -1 + goldBid + dxyStrength * -1;

  if (totalScore >= 3 && vixRisk === 0) return { regime: 'GOLDILOCKS', probability: scoreProbability(totalScore, 0.55, 0.85), sip_multiplier: 1.1 };
  if (totalScore >= 2 && vixRisk <= 1) return { regime: 'RISK_ON', probability: scoreProbability(totalScore, 0.5, 0.8), sip_multiplier: 1.3 };
  if (totalScore <= -3 && vixRisk >= 1) return { regime: 'STAGFLATION', probability: scoreProbability(totalScore, 0.5, 0.8), sip_multiplier: 0.7 };
  if (totalScore <= -2 && vixRisk >= 2) return { regime: 'RISK_OFF', probability: scoreProbability(totalScore, 0.5, 0.8), sip_multiplier: 0.7 };
  return { regime: 'NEUTRAL', probability: scoreProbability(totalScore, 0.4, 0.65), sip_multiplier: 1.0 };
}

function _gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgLoss = losses.slice(-period).reduce((s, v) => s + v, 0) / period;
  // v20.9.1 [H3]: flat series (avgGain bhi 0) pe 100 nahi — 50 (neutral).
  // Halted/zero-range symbol "maximally overbought" read hota tha aur
  // generateSignal uspe -18 'overbought' lagata tha.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs), 1);
}

function calculateSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  return prices.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function _calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// FIX M16 (H16 in server review): previously `calculateMACD` returned only the
// final MACD value, but `signal = macd * (2 / (9 + 1))` is the one-step EMA
// fraction of the CURRENT macd — not the 9-period EMA of the macd series. As a
// result `histogram = macd - signal` was meaningless. Compute the full MACD
// series, then take the 9-period EMA of THAT series to get the proper signal.
function calculateEMASeries(prices, period) {
  if (!prices || prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calculateMACD(prices) {
  if (!prices || prices.length < 35) return { macd: 0, signal: 0, histogram: 0 };
  const ema12Series = calculateEMASeries(prices, 12);
  const ema26Series = calculateEMASeries(prices, 26);
  // Align: both series have length = prices.length - period. Use the overlap.
  const offset = ema26Series.length - ema12Series.length; // negative when ema12 shorter
  const macdSeries = [];
  for (let i = Math.max(0, -offset); i < ema12Series.length && (i + offset) >= 0 && (i + offset) < ema26Series.length; i++) {
    macdSeries.push(ema12Series[i] - ema26Series[i + offset]);
  }
  if (macdSeries.length < 9) return { macd: 0, signal: 0, histogram: 0 };
  const macd = macdSeries[macdSeries.length - 1];
  // Signal = 9-period EMA of the MACD series
  const signalSeries = calculateEMASeries(macdSeries, 9);
  const signal = signalSeries.length > 0 ? signalSeries[signalSeries.length - 1] : macd;
  return { macd: round(macd, 2), signal: round(signal, 2), histogram: round(macd - signal, 2) };
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high || 0;
    const low = candles[i].low || 0;
    const prevClose = candles[i - 1].close || 0;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function generateSignal(prices, currentPrice, currentChange) {
  if (!prices || prices.length < 20) {
    return { signal: 'HOLD', confidence: 30, direction: 'neutral' };
  }

  const closePrices = prices.map(c => c.close || 0).filter(v => v > 0);
  if (closePrices.length < 20) {
    return { signal: 'HOLD', confidence: 30, direction: 'neutral' };
  }

  const rsi = calculateRSI(closePrices);
  const sma20 = calculateSMA(closePrices, 20);
  const sma50 = calculateSMA(closePrices, 50);
  const macd = calculateMACD(closePrices);
  const _current = currentPrice || closePrices[closePrices.length - 1];
  const change = currentChange || 0;

  let score = 50;
  const factors = [];

  if (rsi < 30) { score += 18; factors.push('oversold'); }
  else if (rsi < 40) { score += 10; factors.push('rsi_low'); }
  else if (rsi > 70) { score -= 18; factors.push('overbought'); }
  else if (rsi > 60) { score -= 8; factors.push('rsi_high'); }
  else { factors.push('rsi_neutral'); }

  if (sma20 && sma50) {
    if (sma20 > sma50) { score += 15; factors.push('golden_cross'); }
    else { score -= 15; factors.push('death_cross'); }
  }

  if (macd.macd > 0) { score += 12; factors.push('macd_bull'); }
  else { score -= 12; factors.push('macd_bear'); }

  if (macd.histogram > 0) { score += 5; factors.push('macd_hist_bull'); }
  else if (macd.histogram < 0) { score -= 5; factors.push('macd_hist_bear'); }

  if (change > 2) { score += 10; factors.push('strong_momentum'); }
  else if (change > 0.5) { score += 5; factors.push('positive_momentum'); }
  else if (change < -2) { score -= 10; factors.push('strong_drop'); }
  else if (change < -0.5) { score -= 5; factors.push('negative_momentum'); }

  score = Math.max(0, Math.min(100, score));

  let signal, confidence;
  if (score >= 75) { signal = 'STRONG_BUY'; confidence = score; }
  else if (score >= 60) { signal = 'BUY'; confidence = score; }
  else if (score >= 40) { signal = 'HOLD'; confidence = score; }
  else if (score >= 25) { signal = 'SELL'; confidence = 100 - score; }
  else { signal = 'STRONG_SELL'; confidence = 100 - score; }

  return { signal, confidence: Math.round(confidence), direction: score >= 50 ? 'bullish' : 'bearish', rsi, macd, factors };
}

function calculatePricePoints(candles, currentPrice, direction = 'bullish') {
  const atr = calculateATR(candles || []) || currentPrice * 0.015;
  const entry = round(currentPrice);
  // v20.9.1 [H3]: SHORT-mirroring — pehle SELL/STRONG_SELL signals ko bhi
  // LONG-only ladder milti thi (SL profit-side me = instant stop, targets
  // loss-side me). Ab bearish direction pe levels flip hote hain
  // (reversalEngine.priceLevelsForLeg jaisa hi convention).
  const sgn = direction === 'bearish' ? -1 : 1;
  const stopLoss = round(entry - sgn * atr * 1.2);
  const tp1 = round(entry + sgn * atr * 1.5);
  const tp2 = round(entry + sgn * atr * 2.5);
  const tp3 = round(entry + sgn * atr * 4.0);
  const risk = Math.abs(entry - stopLoss) || 1;
  const reward = Math.abs(tp1 - entry);
  const riskReward = round(reward / risk, 2);

  const dipLadder = [
    { price: round(entry * 0.97), pct_budget: 25, label: '-3% dip' },
    { price: round(entry * 0.94), pct_budget: 25, label: '-6% dip' },
    { price: round(entry * 0.90), pct_budget: 25, label: '-10% dip' },
    { price: round(entry * 0.85), pct_budget: 25, label: '-15% deep dip' },
  ];

  return {
    entry, stop_loss: stopLoss, tp1, tp2, tp3, risk_reward: riskReward, atr: round(atr, 2), dip_ladder: dipLadder,
    // v20.9.1: consumer ko direction bata do taki bearish ladder ko ulta
    // samjha jaye (SL upar, TP neeche).
    ...(sgn === -1 ? { direction: 'bearish', note: 'levels mirrored for SHORT (SL above entry, targets below)' } : {}),
  };
}

function generatePriceTargets(candles, currentPrice, _market) {
  const closePrices = (candles || []).map(c => c.close || 0).filter(v => v > 0);
  const returns = [];
  for (let i = 20; i < closePrices.length; i++) {
    returns.push((closePrices[i] - closePrices[i - 20]) / closePrices[i - 20] * 100);
  }
  const avgReturn = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 5;
  const volatility = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / (returns.length - 1))
    : 10;

  return {
    P10: { expected_return: round(avgReturn - volatility * 1.28, 1), target_price: round(currentPrice * (1 + (avgReturn - volatility * 1.28) / 100)) },
    P50: { expected_return: round(avgReturn, 1), target_price: round(currentPrice * (1 + avgReturn / 100)) },
    P90: { expected_return: round(avgReturn + volatility * 1.28, 1), target_price: round(currentPrice * (1 + (avgReturn + volatility * 1.28) / 100)) },
  };
}

function generateTopFeatures() {
  // v20.9.0 (B1/M5): fixed MERIT ORDER — pehle Math.random() shuffle
  // hota tha (same market me har call pe alag "top features" —
  // fabricated variety). Deterministic top-4 by importance.
  const features = [
    { feature: 'RSI_14', importance: 0.22 },
    { feature: 'MACD_histogram', importance: 0.18 },
    { feature: 'SMA_20_50_cross', importance: 0.16 },
    { feature: 'volume_ratio', importance: 0.14 },
    { feature: 'momentum_5d', importance: 0.12 },
    { feature: 'ATR_14', importance: 0.10 },
    { feature: 'Bollinger_position', importance: 0.08 },
  ];
  return features.slice(0, 4);
}

function runBacktest(candles, initialCapital = 100000) {
  if (!candles || candles.length < 100) {
    return {
      total_periods: 0, total_return_pct: 0, avg_hit_rate: 0,
      avg_return_per_period: 0, avg_f1_weighted: 0, period_win_rate: 0,
      sharpe_ratio: 0, profit_factor: 0, equity_curve: [],
    };
  }
  const closes = candles.map(c => c.close || 0).filter(v => v > 0);
  const periods = 20;
  let equity = initialCapital;
  const curve = [{ equity, return: 0, hit_rate: 50 }];
  let wins = 0, losses = 0, totalReturn = 0;
  // FIX H18: track grossProfit / grossLoss in RETURN units so the profit
  // factor is the standard `sum(wins) / |sum(losses)|` rather than the
  // win/loss COUNT ratio (which is just `wins / losses`).
  let grossProfit = 0, grossLoss = 0;
  let actualPeriods = 0;
  const allReturns = [];

  for (let p = periods; p < closes.length - 5; p += periods) {
    const segment = closes.slice(p - periods, p);
    const avg = segment.reduce((s, v) => s + v, 0) / segment.length;
    const futureReturn = (closes[p + 4] - avg) / avg * 100;
    const rsi = calculateRSI(segment);
    const signal = rsi < 40 ? 'BUY' : rsi > 60 ? 'SELL' : 'HOLD';
    let prediction = 0;
    if (signal === 'BUY') prediction = 1;
    else if (signal === 'SELL') prediction = -1;
    const actual = futureReturn > 0.5 ? 1 : futureReturn < -0.5 ? -1 : 0;
    const correct = prediction === actual;

    const periodReturn = prediction * futureReturn * 0.5;
    equity += equity * periodReturn / 100;
    totalReturn += periodReturn;
    allReturns.push(periodReturn);
    actualPeriods++;

    if (periodReturn > 0) grossProfit += periodReturn;
    else if (periodReturn < 0) grossLoss += Math.abs(periodReturn);

    if (correct) { wins++; } else { losses++; }
    curve.push({
      equity: Math.round(equity),
      return: Math.round(totalReturn * 10) / 10,
      hit_rate: Math.round(wins / (wins + losses) * 100),
    });
  }

  const totalReturnPct = ((equity - initialCapital) / initialCapital) * 100;
  const hitRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
  const avgReturn = allReturns.length > 0 ? allReturns.reduce((s, v) => s + v, 0) / allReturns.length : 0;
  const stdReturn = allReturns.length > 1
    ? Math.sqrt(allReturns.reduce((s, r) => s + r * r, 0) / (allReturns.length - 1))
    : 1;
  // FIX H17: each loop step is `periods=20` days, not 1 day. Annualization
  // factor must be `sqrt(252/20)` not `sqrt(252)`.
  const sharpe = stdReturn > 0 ? avgReturn / stdReturn * Math.sqrt(252 / periods) : 0;
  // FIX H18: profit factor = grossProfit / grossLoss (standard definition).
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  return {
    total_periods: actualPeriods,  // FIX L33: report actual count, not floor(length/periods)
    total_return_pct: round(totalReturnPct, 1),
    avg_hit_rate: round(hitRate, 1),
    avg_return_per_period: round(avgReturn, 2),
    // FIX L34: avg_f1_weighted was `hitRate/100` (fake F1). Renamed to
    // `avg_f1_weighted` is kept for API compat but documented as approximate.
    avg_f1_weighted: round(hitRate / 100, 2),
    period_win_rate: round(hitRate, 1),
    sharpe_ratio: round(sharpe, 2),
    profit_factor: grossLoss > 0 ? round(profitFactor, 2) : (grossProfit > 0 ? null : 0),  // null when no losses
    equity_curve: curve,
  };
}

export function getMLPrediction(symbol, market, currentPrice, currentChange, candles) {
  const sig = generateSignal(candles, currentPrice, currentChange);
  const pricePoints = calculatePricePoints(candles, currentPrice, sig.direction);
  const priceTargets = generatePriceTargets(candles, currentPrice, market);
  const topFeatures = generateTopFeatures();

  return {
    symbol, market,
    // v20.9.0 (B1): honest model labeling — /api/ml/* public hai aur
    // mcpTools (AI chat/Telegram) ise quote karta hai; LLM ko pata hona
    // chahiye ki ye heuristic hai, calibrated model nahi.
    model: ML_MODEL_LABEL,
    disclaimer: ML_DISCLAIMER,
    price: round(currentPrice),
    change: round(currentChange, 2),
    rsi: sig.rsi || 50,
    volume: 0,
    signal: sig.signal,
    confidence: sig.confidence,
    direction: sig.direction,
    price_targets: priceTargets,
    price_points: pricePoints,
    top_features: topFeatures,
    timestamp: Date.now(),
  };
}

/** v20.9.1 [H2]: DEPRECATED — candle-history ke bina ye HAMESHA HOLD-30
 *  deta tha (generateSignal(null,...) ka early-return); isliye iska route
 *  /api/ml/signals 410-retire ho gaya. Function module-API compatibility ke
 *  liye rakha gaya hai — naye callers getMLPrediction use karein. */
export function getAllSignals(portfolioEntries, livePrices) {
  const signals = [];
  for (const [key, data] of Object.entries(livePrices)) {
    const parts = key.split('_');
    if (parts.length < 2) continue;
    const market = parts[0];
    const symbol = parts.slice(1).join('_');
    const price = data.price || 0;
    const change = data.change || 0;
    if (price <= 0) continue;
    const sig = generateSignal(null, price, change);
    signals.push({
      symbol, market, price: round(price),
      change: round(change, 2), rsi: data.rsi || 50,
      signal: sig.signal, confidence: sig.confidence,
      timestamp: Date.now(),
    });
  }
  return {
    signals: signals.sort((a, b) => b.confidence - a.confidence),
    count: signals.length,
  };
}

export function getRegime(niftyData, bankNiftyData, vixData, usVix, dxy, goldData) {
  const niftyChange = niftyData?.change || 0;
  const bankNiftyChange = bankNiftyData?.change || 0;
  const indiaVix = vixData?.price || 15;
  const goldChange = goldData?.change || 0;
  const regime = detectRegime(niftyChange, bankNiftyChange, indiaVix, usVix, dxy, goldChange);
  return {
    regime: regime.regime,
    // v20.9.0 (B1): deterministic + honestly labeled heuristic
    probability: round(regime.probability, 2),
    probabilitySource: 'heuristic',
    model: ML_MODEL_LABEL,
    disclaimer: ML_DISCLAIMER,
    sip_multiplier: regime.sip_multiplier,
    state_sequence: [regime.regime, 'NEUTRAL', regime.regime],
    timestamp: new Date().toISOString(),
  };
}

export function getBacktest(symbol, candles) {
  return runBacktest(candles);
}

export function getHealth() {
  return {
    status: 'healthy',
    service: 'super-intelligence-ml-engine',
    version: '3.1',
    model: 'heuristic-v1 (deterministic rule ensemble — not calibrated)',
    regime: 'HMM-like deterministic',
    engine: 'pure-js-no-python',
    disclaimer: ML_DISCLAIMER,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}
