// ============================================================
// ADVANCE PRO ALGO TRADING — SUPER INTELLIGENCE (bot port)
// ------------------------------------------------------------
// JS mirror of src/utils/algoEngine.ts for the 24x7 Telegram bot.
// Generates intraday LONG/SHORT signals with elite AI Score (90-99),
// exact entry/SL/2 targets, R:R, position sizing and strategy class.
// ============================================================

function round(n, d = 2) {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

function scoreFactors(p) {
  const price = p.price;
  const rsi = p.rsi ?? 50;
  const change = p.change ?? 0;
  const sma20 = p.sma20;
  const sma50 = p.sma50;
  const macd = p.macd;
  const high = p.high || price * 1.01;
  const low = p.low || price * 0.99;
  const volume = p.volume || 0;

  const vwap = (high + low + price) / 3;
  const range = Math.max(high - low, price * 0.002);

  const factors = [];
  let bias = 0;

  if (rsi < 30) { bias += 26; factors.push({ label: 'RSI', state: 'bull', detail: `Oversold ${rsi.toFixed(0)} — bounce setup` }); }
  else if (rsi < 45) { bias += 14; factors.push({ label: 'RSI', state: 'bull', detail: `${rsi.toFixed(0)} — building strength` }); }
  else if (rsi > 70) { bias -= 26; factors.push({ label: 'RSI', state: 'bear', detail: `Overbought ${rsi.toFixed(0)} — fade risk` }); }
  else if (rsi > 58) { bias -= 8; factors.push({ label: 'RSI', state: 'bear', detail: `${rsi.toFixed(0)} — extended` }); }
  else { factors.push({ label: 'RSI', state: 'neutral', detail: `${rsi.toFixed(0)} — neutral` }); }

  if (macd !== undefined) {
    if (macd > 0) { bias += 18; factors.push({ label: 'MACD', state: 'bull', detail: 'Bullish momentum' }); }
    else { bias -= 18; factors.push({ label: 'MACD', state: 'bear', detail: 'Bearish momentum' }); }
  }

  if (sma20 && sma50) {
    if (sma20 > sma50) { bias += 18; factors.push({ label: 'Trend', state: 'bull', detail: 'Golden Cross (SMA20>50)' }); }
    else { bias -= 18; factors.push({ label: 'Trend', state: 'bear', detail: 'Death Cross (SMA20<50)' }); }
  }

  if (price > vwap) { bias += 12; factors.push({ label: 'VWAP', state: 'bull', detail: 'Above VWAP' }); }
  else if (price < vwap) { bias -= 12; factors.push({ label: 'VWAP', state: 'bear', detail: 'Below VWAP' }); }

  if (change > 1.2) { bias += 12; factors.push({ label: 'Momentum', state: 'bull', detail: `+${change.toFixed(2)}% surge` }); }
  else if (change > 0.2) { bias += 6; factors.push({ label: 'Momentum', state: 'bull', detail: `+${change.toFixed(2)}%` }); }
  else if (change < -1.2) { bias -= 12; factors.push({ label: 'Momentum', state: 'bear', detail: `${change.toFixed(2)}% drop` }); }
  else if (change < -0.2) { bias -= 6; factors.push({ label: 'Momentum', state: 'bear', detail: `${change.toFixed(2)}%` }); }

  if (volume > 1_000_000) {
    bias += bias >= 0 ? 8 : -8;
    factors.push({ label: 'Volume', state: bias >= 0 ? 'bull' : 'bear', detail: 'Above-average volume confirms' });
  }

  bias = Math.max(-100, Math.min(100, bias));
  const conviction = Math.min(100, Math.round(Math.abs(bias)));
  return { bias, conviction, factors, vwap: round(vwap), range };
}

function classifyStrategy(p, direction) {
  const rsi = p.rsi ?? 50;
  const change = p.change ?? 0;
  const macd = p.macd ?? 0;
  const trendUp = p.sma20 && p.sma50 ? p.sma20 > p.sma50 : change > 0;
  if (direction === 'LONG') {
    if (rsi < 32) return 'Oversold Bounce';
    if (Math.abs(change) > 1.2 && macd > 0) return 'Momentum Breakout';
    if (trendUp) return 'Trend Continuation';
    return 'VWAP Reversion';
  }
  if (direction === 'SHORT') {
    if (rsi > 70) return 'Overbought Fade';
    if (!trendUp) return 'Trend Continuation';
    if (Math.abs(change) > 1.2 && macd < 0) return 'Momentum Breakout';
    return 'Mean Reversion';
  }
  return 'Range Scalp';
}

export function generateAlgoSignal(symbol, market, p) {
  const price = p?.price;
  // FIX: guard against price=0 / undefined when called directly (not via
  // scanAlgoSignals which already filters, but this fn is exported).
  if (!price || price <= 0) {
    return {
      symbol, market: market || 'IN', price: 0, direction: 'WAIT',
      strategy: 'No Data', conviction: 0, aiScore: 0, riskReward: 0,
      entry: 0, stopLoss: 0, target1: 0, target2: 0, factors: [],
      reasoning: 'No price data', timestamp: Date.now(),
    };
  }
  const { bias, conviction, factors, vwap, range } = scoreFactors(p);

  let direction;
  if (bias >= 22) direction = 'LONG';
  else if (bias <= -22) direction = 'SHORT';
  else direction = 'WAIT';

  const strategy = classifyStrategy(p, direction);
  const atr = range;
  let entry = price, stopLoss = price, target1 = price, target2 = price, trailSL = price;

  if (direction === 'LONG') {
    entry = round(Math.min(price, vwap + atr * 0.05));
    stopLoss = round(entry - atr * 0.9);
    target1 = round(entry + atr * 1.5);
    target2 = round(entry + atr * 2.8);
    trailSL = round(entry - atr * 0.45);
  } else if (direction === 'SHORT') {
    entry = round(Math.max(price, vwap - atr * 0.05));
    stopLoss = round(entry + atr * 0.9);
    target1 = round(entry - atr * 1.5);
    target2 = round(entry - atr * 2.8);
    trailSL = round(entry + atr * 0.45);
  } else {
    entry = round(vwap);
    stopLoss = round(vwap - atr * 0.9);
    target1 = round(vwap + atr * 1.5);
    target2 = round(vwap + atr * 2.8);
    trailSL = round(vwap - atr * 0.45);
  }

  const risk = Math.abs(entry - stopLoss) || price * 0.01;
  const reward = Math.abs(target1 - entry);
  const riskReward = round(reward / risk, 2);
  const positionSizePct = direction === 'WAIT' ? 0 : Math.min(25, Math.round(8 + conviction * 0.17));
  const rrBoost = Math.min(4, Math.max(0, (riskReward - 1) * 1.5));
  const aiScore = Math.max(90, Math.min(99, Math.round(90 + conviction * 0.07 + rrBoost)));

  const dirWord = direction === 'LONG' ? 'LONG' : direction === 'SHORT' ? 'SHORT' : 'WAIT for trigger';
  const reasoning = `${strategy} — ${dirWord}. ${factors.filter(f => f.state !== 'neutral').slice(0, 3).map(f => f.detail).join('; ')}.`;

  return {
    symbol: String(symbol).replace('.NS', '').replace('.BO', ''),
    market, price: round(price), change: round(p.change ?? 0, 2), rsi: round(p.rsi ?? 50, 1),
    direction, strategy, aiScore, conviction, bias: Math.round(bias), vwap,
    entry, stopLoss, target1, target2, trailSL, riskReward, positionSizePct,
    factors, reasoning, timestamp: Date.now(),
  };
}

export function scanAlgoSignals(keys, livePrices) {
  const out = [];
  for (const key of keys) {
    // FIX CRIT: split('_') only works for symbols without underscore. For
    // multi-word symbols like "IN_GIFT_NIFTY" or "IN_NIFTY_50", split('_')
    // returns ['IN','GIFT','NIFTY'] → symbol='GIFT' (silent corruption).
    // Use indexOf to split on the FIRST underscore only.
    const idx = key.indexOf('_');
    if (idx < 0) continue;
    const market = key.slice(0, idx);
    const symbol = key.slice(idx + 1);
    const data = livePrices[key];
    if (!data || !data.price || data.price <= 0) continue;
    out.push(generateAlgoSignal(symbol, market, data));
  }
  return out.sort((a, b) => {
    const aAct = a.direction === 'WAIT' ? 0 : 1;
    const bAct = b.direction === 'WAIT' ? 0 : 1;
    if (aAct !== bAct) return bAct - aAct;
    if (b.conviction !== a.conviction) return b.conviction - a.conviction;
    return b.riskReward - a.riskReward;
  });
}

export function formatAlgoAlert(sig) {
  const cur = sig.market === 'IN' ? '₹' : '$';
  const dirEmoji = sig.direction === 'LONG' ? '🟢📈' : sig.direction === 'SHORT' ? '🔴📉' : '🟡⏳';
  let msg = `${dirEmoji} <b>INTRADAY ALGO — ${sig.symbol}</b> (${sig.market})\n`;
  msg += `<b>${sig.direction}</b> · ${sig.strategy}\n`;
  msg += `🤖 AI Score: <b>${sig.aiScore}/100</b> | Conviction ${sig.conviction}%\n\n`;
  msg += `💰 Price: ${cur}${sig.price} (${sig.change >= 0 ? '+' : ''}${sig.change}%)\n`;
  msg += `🎯 Entry: ${cur}${sig.entry}\n`;
  msg += `🛑 Stop-Loss: ${cur}${sig.stopLoss} (trail ${cur}${sig.trailSL})\n`;
  msg += `🎯 T1: ${cur}${sig.target1} | T2: ${cur}${sig.target2}\n`;
  msg += `⚖️ R:R 1:${sig.riskReward} | Size ${sig.positionSizePct}%\n\n`;
  msg += `<i>${sig.reasoning}</i>\n`;
  msg += `<i>Advance Pro Algo · Super Intelligence v1.0</i>`;
  return msg;
}

// Build an intraday watchlist from the bot's live prices (exclude VIX indices).
export function algoWatchKeys(livePrices) {
  return Object.keys(livePrices || {}).filter(k => !/_(INDIAVIX|VIX)$/i.test(k));
}
