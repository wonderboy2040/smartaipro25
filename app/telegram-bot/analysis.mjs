// ============================================
// ANALYSIS ENGINE — Signals, Reports, Allocation
// ============================================

import {
  ALPHA_ETFS_IN, ALPHA_ETFS_US, getAssetCagrProxy,
  formatCurrency, formatPrice, DEFAULT_INDIA_SIP, DEFAULT_US_SIP, DEFAULT_USD_INR, isCryptoSymbol
} from './config.mjs';
import { getISTTime, getMarketStatus, isIndiaMarketOpen, isUSMarketOpen } from './market.mjs';

// ========================================
// ASSET SIGNAL ANALYSIS
// ========================================
export function analyzeAsset(position, priceData) {
  // FIX H9: when both `priceData.price` and `position.avgPrice` are undefined,
  // `price` was undefined → NaN propagated through low/high/targetPrice.
  const price = priceData?.price ?? position.avgPrice ?? 0;
  if (!price || price <= 0) {
    return {
      symbol: position.symbol.replace('.NS', ''),
      market: position.market,
      signal: 'HOLD', action: 'HOLD', trend: 'flat',
      rsi: 50, change: 0, price: 0, targetPrice: 0,
      fibLow: 0, fibHigh: 0, confidence: 0,
      reason: 'No price data available'
    };
  }
  const rsi = priceData?.rsi || 50;
  const change = priceData?.change || 0;
  const volume = priceData?.volume || 0;
  const cagr = getAssetCagrProxy(position.symbol, position.market);
  const isCrypto = isCryptoSymbol(position.symbol);

  // Crypto uses wider RSI thresholds (more volatile)
  const oversoldThreshold = isCrypto ? 25 : 30;
  const overboughtThreshold = isCrypto ? 80 : 65;
  const strongOversold = isCrypto ? 20 : 30;
  const strongOverbought = isCrypto ? 85 : 75;

  const sma20 = priceData?.sma20;
  const sma50 = priceData?.sma50;
  const macd = priceData?.macd;

  // Institutional Volume Tracking
  // Volume spike > 2x average (approximate)
  const isVolumeSpike = volume > 1000000 && (priceData?.change !== undefined ? Math.abs(priceData.change) > 1.5 : false);
  const instAccumulation = isVolumeSpike && change > 0;
  const instDistribution = isVolumeSpike && change < 0;

  let isBullishTrend = change > 0.5;
  let isBearishTrend = change < -0.5;

  if (sma20 && sma50) {
    // Mutually exclusive — both can't be true at the same time
    const smaBullish = sma20 > sma50;
    const smaBearish = sma50 > sma20;
    isBullishTrend = smaBullish && (macd === undefined || macd >= 0);
    isBearishTrend = smaBearish && (macd === undefined || macd <= 0);
  }

  const low = priceData?.low || price * 0.98;
  const high = priceData?.high || price * 1.02;
  const dayRange = high - low;
  const supportLevel = low - dayRange * 0.382;
  const resistanceLevel = high + dayRange * 0.382;

  let signal = 'HOLD';
  let confidence = 60;
  let reason = 'Neutral range, maintain position';
  let targetPrice = price;

  if (rsi < strongOversold) {
    signal = 'STRONG_BUY'; confidence = 95; targetPrice = resistanceLevel;
    reason = `RSI ${rsi.toFixed(0)} oversold${isCrypto ? ' (crypto zone)' : ''} — institutional accumulation zone.`;
    if (instAccumulation) { confidence = 99; reason = `🔥 MAX CONVICTION: RSI ${rsi.toFixed(0)} + Volume Spike! Institutional buying detected.`; }
  } else if (rsi < oversoldThreshold + 10) {
    // FIX H8: BUY targetPrice was set to `low` (below current price) — should
    // be a resistance/upsider target above current price.
    signal = 'BUY'; confidence = 80; targetPrice = resistanceLevel;
    reason = `RSI ${rsi.toFixed(0)} approaching oversold — good entry.`;
    if (isBullishTrend) { reason += ' Bullish momentum building.'; confidence += 5; }
    if (instAccumulation) { confidence += 10; reason += ' Volume confirming accumulation.'; }
  } else if (rsi > strongOverbought) {
    signal = 'STRONG_SELL'; confidence = 90; targetPrice = supportLevel;
    reason = `RSI ${rsi.toFixed(0)} overbought${isCrypto ? ' (crypto zone)' : ''} — distribution zone.`;
    if (instDistribution) { confidence = 98; reason = `🔥 MAX RISK: RSI ${rsi.toFixed(0)} + Volume Spike! Institutional distribution detected.`; }
  } else if (rsi > overboughtThreshold) {
    // FIX H8: SELL targetPrice was set to `high` (above current price) — should
    // be a support/downside target below current price.
    signal = 'SELL'; confidence = 70; targetPrice = supportLevel;
    reason = `RSI ${rsi.toFixed(0)} elevated — consider partial booking.`;
    if (isBearishTrend) { reason += ' Bearish momentum detected.'; confidence += 5; }
    if (instDistribution) { confidence += 10; reason += ' Volume confirming distribution.'; }
  } else {
    if (isBullishTrend && rsi < 55) {
      signal = 'BUY'; confidence = 75; targetPrice = resistanceLevel || high || price * 1.02;
      reason = `Golden Cross / Bullish MACD detected. Accumulate on dips.`;
    } else if (isBearishTrend && rsi > 55) {
      signal = 'SELL'; confidence = 65; targetPrice = supportLevel || low || price * 0.98;
      reason = `Death Cross / Bearish MACD momentum. Book partials.`;
    } else if (change < -3) {
      signal = 'BUY'; confidence = 75; targetPrice = resistanceLevel || price * 1.03;
      reason = `Sharp dip ${change.toFixed(1)}% — potential reversal.`;
    } else if (change > 3) {
      signal = 'SELL'; confidence = 65; targetPrice = supportLevel || price * 0.97;
      reason = `Strong rally ${change.toFixed(1)}% — book partial profits.`;
    }
  }

  if (cagr > 20 && signal === 'BUY') confidence = Math.min(99, confidence + 10);

  confidence = Math.max(1, Math.min(99, confidence));

  const action = (signal === 'STRONG_BUY' || signal === 'BUY') ? 'BUY' : (signal === 'STRONG_SELL' || signal === 'SELL') ? 'SELL' : 'HOLD';
  const trend = isBullishTrend ? 'up' : isBearishTrend ? 'down' : 'flat';

  return {
    symbol: position.symbol.replace('.NS', ''),
    market: position.market,
    signal, action, trend, rsi, change, price,
    targetPrice, fibLow: supportLevel, fibHigh: resistanceLevel,
    confidence, reason
  };
}

// ========================================
// PORTFOLIO METRICS
// ========================================
export function calculateMetrics(portfolio, livePrices, usdInrRate) {
  let totalInvested = 0, totalValue = 0, todayPL = 0;
  let indPL = 0, usPL = 0, cryptoPL = 0;

  for (const p of portfolio) {
    // FIX H7: portfolio data may have market in lowercase ('in' instead of
    // 'IN'). livePrices is keyed with UPPERCASE market prefix (e.g. 'IN_RELIANCE').
    // Without normalization, the lookup silently misses → metrics fall back to
    // avgPrice and today's P&L is always 0.
    const mkt = String(p.market || '').toUpperCase();
    const key = `${mkt}_${p.symbol}`;
    const data = livePrices[key];
    const curPrice = data?.price || p.avgPrice;
    const change = data?.change || 0;
    const lev = p.leverage || 1;

    const posSize = p.avgPrice * p.qty;
    const inv = posSize / lev;
    const curVal = curPrice * p.qty;
    const eqVal = inv + (curVal - posSize);

    const invINR = p.market === 'IN' ? inv : inv * usdInrRate;
    const valINR = p.market === 'IN' ? eqVal : eqVal * usdInrRate;

    totalInvested += invINR;
    totalValue += valINR;

    // FIX M19: division-by-zero when change === -100 (1 + (-100/100) = 0).
    // Treat as invalid data → 0 day P&L.
    const denom = 1 + (change / 100);
    const prevPrice = denom > 0 ? curPrice / denom : curPrice;
    const dayPL = (curPrice - prevPrice) * p.qty;
    const dayPLINR = p.market === 'IN' ? dayPL : dayPL * usdInrRate;
    todayPL += dayPLINR;

    const cleanSym = p.symbol.replace('.NS', '').replace('.BO', '');
    if (isCryptoSymbol(cleanSym)) cryptoPL += dayPLINR;
    else if (p.market === 'IN') indPL += dayPLINR;
    else usPL += dayPLINR;
  }

  const totalPL = totalValue - totalInvested;
  const plPct = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;
  const prevDayValue = totalValue - todayPL;
  const todayPct = prevDayValue > 0 ? (todayPL / prevDayValue) * 100 : 0;

  return { totalInvested, totalValue, totalPL, plPct, todayPL, todayPct, indPL, usPL, cryptoPL };
}

// ========================================
// TELEGRAM REPORT GENERATORS
// ========================================

// /portfolio — Full Portfolio Report
export function generatePortfolioReport(portfolio, livePrices, usdInrRate) {
  const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
  const timeStr = getISTTime();

  let msg = `💼 <b>WEALTH AI — Portfolio Commander</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i> | ${getMarketStatus()}\n\n`;

  // Summary
  msg += `📊 <b>Portfolio Summary</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `Total Equity:  <b>₹${Math.round(metrics.totalValue).toLocaleString('en-IN')}</b>\n`;
  msg += `Invested:      <b>₹${Math.round(metrics.totalInvested).toLocaleString('en-IN')}</b>\n`;
  msg += `Total P&L:     <b>${metrics.totalPL >= 0 ? '📈 +' : '📉 '}₹${Math.round(Math.abs(metrics.totalPL)).toLocaleString('en-IN')}</b> <i>(${metrics.plPct >= 0 ? '+' : ''}${metrics.plPct.toFixed(2)}%)</i>\n`;
  msg += `Today:         <b>${metrics.todayPL >= 0 ? '🟢 +' : '🔴 '}₹${Math.round(Math.abs(metrics.todayPL)).toLocaleString('en-IN')}</b> <i>(${metrics.todayPct >= 0 ? '+' : ''}${metrics.todayPct.toFixed(2)}%)</i>\n`;
  msg += `USD/INR:       <b>₹${usdInrRate.toFixed(2)}</b>\n\n`;

  // Individual positions
  const inPositions = portfolio.filter(p => p.market === 'IN');
  const usPositions = portfolio.filter(p => p.market === 'US');

  if (inPositions.length > 0) {
    msg += `🇮🇳 <b>India Holdings</b>\n`;
    msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    for (const p of inPositions) {
      const key = `IN_${p.symbol}`;
      const data = livePrices[key];
      const curPrice = data?.price || p.avgPrice;
      const change = data?.change || 0;
      const rsi = data?.rsi || 50;
      const pl = (curPrice - p.avgPrice) * p.qty;
      const plPct = p.avgPrice > 0 ? ((curPrice - p.avgPrice) / p.avgPrice) * 100 : 0;
      const cleanSym = p.symbol.replace('.NS', '');

      msg += `\n• <b>${cleanSym}</b> × ${p.qty}\n`;
      msg += `  CMP: ₹${curPrice.toFixed(2)} <i>(${change >= 0 ? '+' : ''}${change.toFixed(2)}%)</i>\n`;
      msg += `  Avg: ₹${p.avgPrice.toFixed(2)} | P&L: <b>${pl >= 0 ? '+' : ''}₹${Math.round(pl).toLocaleString('en-IN')}</b> (${plPct >= 0 ? '+' : ''}${plPct.toFixed(1)}%)\n`;
      msg += `  RSI: <b>${rsi.toFixed(0)}</b> ${rsi < 35 ? '🟢 Oversold' : rsi > 65 ? '🔴 Overbought' : '🟡 Neutral'}\n`;
    }
    msg += '\n';
  }

  if (usPositions.length > 0) {
    msg += `🇺🇸 <b>US Holdings</b>\n`;
    msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    for (const p of usPositions) {
      const key = `US_${p.symbol}`;
      const data = livePrices[key];
      const curPrice = data?.price || p.avgPrice;
      const change = data?.change || 0;
      const rsi = data?.rsi || 50;
      const pl = (curPrice - p.avgPrice) * p.qty;
      const plINR = pl * usdInrRate;
      const plPct = p.avgPrice > 0 ? ((curPrice - p.avgPrice) / p.avgPrice) * 100 : 0;

      msg += `\n• <b>${p.symbol}</b> × ${p.qty}\n`;
      msg += `  CMP: $${curPrice.toFixed(2)} <i>(${change >= 0 ? '+' : ''}${change.toFixed(2)}%)</i>\n`;
      msg += `  Avg: $${p.avgPrice.toFixed(2)} | P&L: <b>${pl >= 0 ? '+' : ''}$${Math.abs(pl).toFixed(2)}</b> (₹${Math.round(Math.abs(plINR)).toLocaleString('en-IN')})\n`;
      msg += `  RSI: <b>${rsi.toFixed(0)}</b> ${rsi < 35 ? '🟢 Oversold' : rsi > 65 ? '🔴 Overbought' : '🟡 Neutral'}\n`;
    }
    msg += '\n';
  }

  msg += `\n💎 <i>Deep Mind AI Pro Trading Terminal</i>`;
  return msg;
}

// /market — Global Market Report
export function generateMarketReport(livePrices, intelligence) {
  const timeStr = getISTTime();
  const usVix = livePrices['US_VIX']?.price || 15;
  const inVix = livePrices['IN_INDIAVIX']?.price || 15;
  const avgVix = (usVix + inVix) / 2;

  let regime = '🟢 BULLISH';
  if (avgVix > 25) regime = '🔴 BEARISH';
  else if (avgVix > 18) regime = '🟡 VOLATILE';

  let msg = `🌍 <b>WEALTH AI — Global Market Radar</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i> | ${getMarketStatus()}\n\n`;

  // Regime
  msg += `🧭 <b>Market Regime:</b> ${regime}\n`;
  msg += `<code>US VIX: ${usVix.toFixed(1)} | India VIX: ${inVix.toFixed(1)}</code>\n\n`;

  // Global Indices
  if (intelligence?.globalIndices?.length > 0) {
    msg += `📊 <b>Global Indices</b>\n`;
    msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    for (const idx of intelligence.globalIndices) {
      const emoji = idx.change > 0.5 ? '🟢' : idx.change < -0.5 ? '🔴' : '⚪';
      msg += `${emoji} <b>${idx.name}:</b> ${idx.price.toFixed(2)} <i>(${idx.change >= 0 ? '+' : ''}${idx.change.toFixed(2)}%)</i>\n`;
    }
    msg += '\n';
  }

  // Sectors
  if (intelligence?.sectors?.length > 0) {
    msg += `🏭 <b>Sector Heat Map</b>\n`;
    msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    for (const s of intelligence.sectors) {
      const emoji = s.change > 1 ? '🟢' : s.change < -1 ? '🔴' : '⚪';
      msg += `${emoji} ${s.name}: <b>${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%</b>\n`;
    }
    msg += '\n';
  }

  // Fear & Greed
  if (intelligence) {
    const fg = intelligence.fearGreedScore;
    const fgBar = '█'.repeat(Math.round(fg / 10)) + '░'.repeat(10 - Math.round(fg / 10));
    msg += `🧠 <b>Fear & Greed Index</b>\n`;
    msg += `<code>[${fgBar}] ${fg}/100</code>\n`;
    msg += `${fg > 60 ? '🟢 GREED' : fg < 40 ? '🔴 FEAR' : '🟡 NEUTRAL'}\n\n`;
  }

  // Narrative
  if (intelligence?.marketNarrative) {
    msg += `📋 <b>AI Narrative:</b>\n<i>${intelligence.marketNarrative}</i>\n`;
  }

  msg += `\n💎 <i>Deep Mind AI Pro Trading Terminal</i>`;
  return msg;
}


// /allocation — Smart SIP Allocation
export function generateAllocationReport(livePrices, usdInrRate) {
  const timeStr = getISTTime();
  const usVix = livePrices['US_VIX']?.price || 15;
  const inVix = livePrices['IN_INDIAVIX']?.price || 15;
  const avgVix = (usVix + inVix) / 2;

  let msg = `📈 <b>WEALTH AI — Smart SIP Allocation</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n\n`;

  const processETF = (etf, market) => {
    const key = `${market}_${etf.sym}`;
    const altKey = `${market}_${etf.sym}.NS`;
    const data = livePrices[key] || livePrices[altKey];
    const price = data?.price || 0;
    const rsi = data?.rsi || 50;
    const sma20 = data?.sma20;
    const sma50 = data?.sma50;
    const macd = data?.macd;
    const isBull = sma20 && sma50 ? sma20 > sma50 : false;
    const hasMACDMomentum = macd !== undefined ? macd > 0 : false;

    let signal = '🟡 WAIT';
    if (rsi < 30 && hasMACDMomentum) signal = '🟢🟢 STRONG BUY';
    else if (rsi < 35 || (isBull && hasMACDMomentum)) signal = '🟢 BUY NOW';
    else if (rsi < 45 || isBull) signal = '🟢 ACCUMULATE';
    else if (rsi > 75) signal = '🔴 DISTRIBUTE';
    else if (rsi > 70 && !hasMACDMomentum) signal = '🔴 AVOID';

    return { sym: etf.sym, name: etf.name, market, price, rsi, signal, alloc: etf.fixedAlloc };
  };

  const inRecs = ALPHA_ETFS_IN.map(e => processETF(e, 'IN'));
  const usRecs = ALPHA_ETFS_US.map(e => processETF(e, 'US'));

  // Normalize allocations
  const inTotal = inRecs.reduce((s, r) => s + r.alloc, 0) || 1;
  const usTotal = usRecs.reduce((s, r) => s + r.alloc, 0) || 1;
  inRecs.forEach(r => { r.allocPct = r.alloc / inTotal; r.allocAmount = Math.round(DEFAULT_INDIA_SIP * r.allocPct); });
  usRecs.forEach(r => { r.allocPct = r.alloc / usTotal; r.allocAmount = Math.round(DEFAULT_US_SIP * r.allocPct); });

  msg += `🇮🇳 <b>India SIP Matrix (₹${DEFAULT_INDIA_SIP.toLocaleString()}/mo)</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  for (const r of inRecs) {
    msg += `\n${r.signal}\n`;
    msg += `<b>${r.sym}</b> — ${r.name}\n`;
    msg += `CMP: ₹${r.price.toFixed(2)} | RSI: <b>${r.rsi.toFixed(0)}</b>\n`;
    msg += `Allocation: <b>₹${r.allocAmount.toLocaleString()} (${(r.allocPct * 100).toFixed(0)}%)</b>\n`;
  }

  msg += `\n\n🇺🇸 <b>US SIP Matrix ($${DEFAULT_US_SIP}/mo)</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  for (const r of usRecs) {
    msg += `\n${r.signal}\n`;
    msg += `<b>${r.sym}</b> — ${r.name}\n`;
    msg += `CMP: $${r.price.toFixed(2)} | RSI: <b>${r.rsi.toFixed(0)}</b>\n`;
    msg += `Allocation: <b>$${r.allocAmount} (${(r.allocPct * 100).toFixed(0)}%)</b>\n`;
  }

  msg += `\n\n🧠 <b>VIX Risk Context:</b> ${avgVix > 22 ? '🔴 High Fear — conservative allocation' : avgVix < 15 ? '🟢 Low Risk — full deployment' : '🟡 Normal — standard allocation'}\n`;
  msg += `\n💎 <i>Deep Mind AI Pro Trading Terminal</i>`;
  return msg;
}

// /risk — Risk Assessment
export function generateRiskReport(livePrices, portfolio, usdInrRate) {
  const timeStr = getISTTime();
  const usVix = livePrices['US_VIX']?.price || 15;
  const inVix = livePrices['IN_INDIAVIX']?.price || 15;
  const avgVix = (usVix + inVix) / 2;
  const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);

  let riskLevel = '🟢 LOW';
  let riskScore = 25;
  let advice = 'Market stable. Full SIP deployment recommended.';

  if (avgVix > 30) { riskLevel = '🔴 EXTREME'; riskScore = 95; advice = 'DANGER ZONE — Paisa hath me rakho. Cash is king.'; }
  else if (avgVix > 25) { riskLevel = '🔴 HIGH'; riskScore = 80; advice = 'Major hedging required. Only essentials me invest karo.'; }
  else if (avgVix > 20) { riskLevel = '🟠 ELEVATED'; riskScore = 60; advice = 'Caution mode. SIP chalne do but extra deployment rokh ke rakho.'; }
  else if (avgVix > 16) { riskLevel = '🟡 MODERATE'; riskScore = 40; advice = 'Normal conditions. Standard SIP optimal hai.'; }
  else if (avgVix > 12) { riskLevel = '🟢 LOW'; riskScore = 25; advice = 'Bull territory. Aggressively accumulate quality assets.'; }
  else { riskLevel = '⚠️ ULTRA LOW'; riskScore = 15; advice = 'Extreme complacency! VIX bahut neeche. Profits protect karo.'; }

  const riskBar = '🟥'.repeat(Math.round(riskScore / 10)) + '🟩'.repeat(10 - Math.round(riskScore / 10));

  let msg = `🛡️ <b>WEALTH AI — Risk Command Center</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n\n`;

  msg += `🎚️ <b>Global Risk Level:</b> ${riskLevel}\n`;
  msg += `<code>[${riskBar}] ${riskScore}/100</code>\n\n`;

  msg += `📊 <b>Volatility Matrix</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `US VIX (CBOE):    <b>${usVix.toFixed(1)}</b> ${usVix > 20 ? '🔴' : '🟢'}\n`;
  msg += `India VIX:        <b>${inVix.toFixed(1)}</b> ${inVix > 20 ? '🔴' : '🟢'}\n`;
  msg += `Average VIX:      <b>${avgVix.toFixed(1)}</b>\n\n`;

  msg += `💼 <b>Portfolio Risk</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `Total Exposure:   ₹${Math.round(metrics.totalValue).toLocaleString('en-IN')}\n`;
  msg += `Today's Move:     ${metrics.todayPL >= 0 ? '📈 +' : '📉 '}₹${Math.round(Math.abs(metrics.todayPL)).toLocaleString('en-IN')} (${metrics.todayPct.toFixed(2)}%)\n`;

  // Max drawdown estimate
  const maxDrawdown = metrics.totalValue * (avgVix > 25 ? 0.15 : avgVix > 18 ? 0.10 : 0.05);
  msg += `Max Drawdown Est: <b>₹${Math.round(maxDrawdown).toLocaleString('en-IN')}</b> <i>(${avgVix > 25 ? '15%' : avgVix > 18 ? '10%' : '5%'} worst case)</i>\n\n`;

  msg += `🧠 <b>AI Recommendation:</b>\n<i>${advice}</i>\n`;
  msg += `\n💎 <i>Deep Mind AI Pro Trading Terminal</i>`;
  return msg;
}

// Scheduled Auto Report (market hours)
export function generateAutoReport(portfolio, livePrices, usdInrRate) {
  const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
  const timeStr = getISTTime();
  const usVix = livePrices['US_VIX']?.price || 15;
  const inVix = livePrices['IN_INDIAVIX']?.price || 15;
  const avgVix = (usVix + inVix) / 2;

  let regime = '🟢 BULLISH';
  if (avgVix > 25) regime = '🔴 BEARISH';
  else if (avgVix > 18) regime = '🟡 VOLATILE';

  // Check for urgent signals
  const signals = portfolio.map(p => {
    const key = `${String(p.market||"").toUpperCase()}_${p.symbol}`;
    return analyzeAsset(p, livePrices[key]);
  });
  const urgentBuys = signals.filter(s => s.signal === 'STRONG_BUY');
  const urgentSells = signals.filter(s => s.signal === 'STRONG_SELL');

  let msg = `📊 <b>WEALTH AI — Auto Scan Report</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i> | ${getMarketStatus()}\n\n`;

  msg += `💼 <b>Portfolio Status</b>\n`;
  msg += `Equity: <b>₹${Math.round(metrics.totalValue).toLocaleString('en-IN')}</b>\n`;
  msg += `P&L: <b>${metrics.totalPL >= 0 ? '+' : ''}₹${Math.round(metrics.totalPL).toLocaleString('en-IN')}</b> (${metrics.plPct.toFixed(2)}%)\n`;
  msg += `Today: <b>${metrics.todayPL >= 0 ? '📈 +' : '📉 '}₹${Math.round(Math.abs(metrics.todayPL)).toLocaleString('en-IN')}</b>\n\n`;

  msg += `🌍 Regime: <b>${regime}</b> | VIX: ${avgVix.toFixed(1)}\n\n`;

  if (urgentBuys.length > 0) {
    msg += `🟢 <b>STRONG BUY ALERT!</b>\n`;
    for (const s of urgentBuys) {
      msg += `• <b>${s.symbol}</b> RSI ${s.rsi.toFixed(0)} — ${s.reason}\n`;
    }
    msg += '\n';
  }

  if (urgentSells.length > 0) {
    msg += `🔴 <b>DISTRIBUTION ALERT!</b>\n`;
    for (const s of urgentSells) {
      msg += `• <b>${s.symbol}</b> RSI ${s.rsi.toFixed(0)} — ${s.reason}\n`;
    }
    msg += '\n';
  }

  if (urgentBuys.length === 0 && urgentSells.length === 0) {
    msg += `✅ <i>All assets stable — no urgent action needed.</i>\n`;
  }

  msg += `\n💎 <i>Automated by Deep Mind AI</i>`;
  return msg;
}

// /forex — Enhanced Forex Report
export function generateForexReport(usdInrRate) {
  const timeStr = getISTTime();
  const rate = usdInrRate;

  // Estimate if rupee is strong or weak based on rate
  const isStrong = rate < 84;
  const isWeak = rate > 87;
  const trend = isWeak ? '📉 Rupee Weakening' : isStrong ? '📈 Rupee Strengthening' : '↔️ Stable Range';

  let msg = `💱 <b>FOREX COMMAND CENTER — USD/INR</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i> | <b>LIVE</b>\n\n`;

  msg += `🇺🇸 1 USD = 🇮🇳 <b>₹${rate.toFixed(4)}</b>\n`;
  msg += `🇮🇳 1 INR = 🇺🇸 <b>$${(1 / rate).toFixed(6)}</b>\n\n`;

  msg += `📊 <b>Trend:</b> ${trend}\n\n`;

  msg += `<b>💵 USD → INR Conversion:</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `<code>$1     = ₹${rate.toFixed(2)}</code>\n`;
  msg += `<code>$5     = ₹${(5 * rate).toFixed(0)}</code>\n`;
  msg += `<code>$10    = ₹${(10 * rate).toFixed(0)}</code>\n`;
  msg += `<code>$25    = ₹${(25 * rate).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</code>\n`;
  msg += `<code>$50    = ₹${(50 * rate).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</code>\n`;
  msg += `<code>$100   = ₹${(100 * rate).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</code>\n`;
  msg += `<code>$500   = ₹${(500 * rate).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</code>\n`;
  msg += `<code>$1000  = ₹${(1000 * rate).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</code>\n`;
  msg += `<code>$5000  = ₹${(5000 * rate).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</code>\n`;
  msg += `<code>$10000 = ₹${(10000 * rate).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</code>\n\n`;

  msg += `<b>₹ INR → USD Conversion:</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `<code>₹1000   = $${(1000 / rate).toFixed(2)}</code>\n`;
  msg += `<code>₹5000   = $${(5000 / rate).toFixed(2)}</code>\n`;
  msg += `<code>₹10000  = $${(10000 / rate).toFixed(2)}</code>\n`;
  msg += `<code>₹50000  = $${(50000 / rate).toFixed(2)}</code>\n`;
  msg += `<code>₹100000 = $${(100000 / rate).toFixed(2)}</code>\n\n`;

  msg += `🧠 <b>AI Forex Insight:</b>\n`;
  if (isWeak) msg += `<i>Rupee weak zone me hai. US stocks ka INR value badh raha hai — aapke US portfolio ka fayda! But new US investments costly ho gaye.</i>\n`;
  else if (isStrong) msg += `<i>Rupee strong ho raha hai. US me invest karne ka achha time — dollar sasta pad raha hai. US portfolio ka INR value thoda kam dikhega.</i>\n`;
  else msg += `<i>Rupee stable range me hai — normal zone. SIP continue karo dono markets me.</i>\n`;

  msg += `\n💎 <i>Deep Mind AI Quantum Pro Terminal</i>`;
  return msg;
}

// ========================================
// /scan <SYMBOL> — Single Symbol Deep Scan
// ========================================
export function generateScanReport(symbolData) {
  const timeStr = getISTTime();
  const d = symbolData;
  const cur = d.market === 'IN' ? '₹' : '$';
  const rsi = d.rsi || 50;
  const change = d.change || 0;
  const sma20 = d.sma20;
  const sma50 = d.sma50;
  const macd = d.macd;

  // Signal logic
  const isBull = sma20 && sma50 ? sma20 > sma50 : false;
  const hasMACDMom = macd !== undefined ? macd > 0 : false;
  let signal = '🟡 NEUTRAL';
  let verdict = 'No strong signal. Wait for confirmation.';
  if (rsi < 30 && hasMACDMom) { signal = '🟢🟢 STRONG BUY'; verdict = 'Oversold + MACD bullish. Institutional accumulation zone!'; }
  else if (rsi < 35) { signal = '🟢 BUY'; verdict = 'RSI approaching oversold. Good entry opportunity.'; }
  else if (rsi < 45 && isBull) { signal = '🟢 ACCUMULATE'; verdict = 'Bullish trend intact. SMA Golden Cross active.'; }
  else if (rsi > 75) { signal = '🔴 STRONG SELL'; verdict = 'Extreme overbought. Distribution phase. Book profits!'; }
  else if (rsi > 65 && !hasMACDMom) { signal = '🔴 SELL'; verdict = 'Overbought + MACD losing momentum.'; }
  else if (isBull && hasMACDMom) { signal = '🟢 BULLISH'; verdict = 'Uptrend momentum. Hold/Accumulate.'; }

  // Fib levels
  const dayRange = (d.high || d.price) - (d.low || d.price);
  const support = (d.low || d.price) - dayRange * 0.382;
  const resistance = (d.high || d.price) + dayRange * 0.382;

  // Volume analysis
  let volText = '💤 Low';
  if (d.volume > 10000000) volText = '🔥 Very High';
  else if (d.volume > 1000000) volText = '📊 High';
  else if (d.volume > 100000) volText = '⚡ Active';

  let msg = `🔍 <b>DEEP SCAN — ${d.symbol}</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i> | ${d.market === 'IN' ? '🇮🇳' : '🇺🇸'} ${d.name || d.symbol}\n\n`;

  msg += `📊 <b>Price Action</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `CMP:        <b>${cur}${d.price.toFixed(2)}</b> (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)\n`;
  msg += `Day Range:  ${cur}${(d.low || d.price).toFixed(2)} — ${cur}${(d.high || d.price).toFixed(2)}\n`;
  msg += `Open:       ${cur}${(d.open || d.price).toFixed(2)}\n`;
  msg += `Volume:     ${volText} (${(d.volume / 1000000).toFixed(2)}M)\n\n`;

  msg += `🧠 <b>Technical Analysis</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `RSI (14):   <b>${rsi.toFixed(1)}</b> ${rsi < 35 ? '🟢 Oversold' : rsi > 65 ? '🔴 Overbought' : '🟡 Neutral'}\n`;
  if (sma20) msg += `SMA 20:     ${cur}${sma20.toFixed(2)} ${d.price > sma20 ? '📈 Above' : '📉 Below'}\n`;
  if (sma50) msg += `SMA 50:     ${cur}${sma50.toFixed(2)} ${d.price > sma50 ? '📈 Above' : '📉 Below'}\n`;
  if (sma20 && sma50) msg += `SMA Cross:  ${isBull ? '🟢 Golden Cross' : '🔴 Death Cross'}\n`;
  if (macd !== undefined) msg += `MACD:       ${macd.toFixed(2)} ${hasMACDMom ? '📈 Bullish' : '📉 Bearish'}\n`;
  msg += `\n`;

  msg += `📈 <b>Performance</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `Weekly:     ${d.weekChange >= 0 ? '📈 +' : '📉 '}${d.weekChange.toFixed(2)}%\n`;
  msg += `Monthly:    ${d.monthChange >= 0 ? '📈 +' : '📉 '}${d.monthChange.toFixed(2)}%\n`;
  msg += `3-Month:    ${d.threeMonthChange >= 0 ? '📈 +' : '📉 '}${d.threeMonthChange.toFixed(2)}%\n\n`;

  msg += `🎯 <b>Key Levels</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `Support:    <b>${cur}${support.toFixed(2)}</b> (Fib 38.2%)\n`;
  msg += `Resistance: <b>${cur}${resistance.toFixed(2)}</b> (Fib 38.2%)\n\n`;

  msg += `⚡ <b>AI VERDICT:</b> ${signal}\n`;
  msg += `<i>${verdict}</i>\n`;
  msg += `\n💎 <i>Deep Mind AI Pro Trading Terminal</i>`;
  return msg;
}


// ========================================
// /compare — Side-by-Side Symbol Comparison
// ========================================
export function generateCompareReport(data1, data2) {
  const timeStr = getISTTime();

  let msg = `⚖️ <b>HEAD TO HEAD</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<b>${data1.symbol}</b> vs <b>${data2.symbol}</b>\n\n`;

  const cur1 = data1.market === 'IN' ? '₹' : '$';
  const cur2 = data2.market === 'IN' ? '₹' : '$';

  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `<code>Metric      ${data1.symbol.padEnd(10)} ${data2.symbol.padEnd(10)}</code>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `<code>Price       ${(cur1 + data1.price.toFixed(2)).padEnd(10)} ${(cur2 + data2.price.toFixed(2)).padEnd(10)}</code>\n`;
  msg += `<code>Change      ${((data1.change >= 0 ? '+' : '') + data1.change.toFixed(2) + '%').padEnd(10)} ${((data2.change >= 0 ? '+' : '') + data2.change.toFixed(2) + '%').padEnd(10)}</code>\n`;
  msg += `<code>RSI         ${(data1.rsi || 50).toFixed(0).padEnd(10)} ${(data2.rsi || 50).toFixed(0).padEnd(10)}</code>\n`;

  // v20.7.3 FIX: the Yahoo fallback object carries no week/month/3M change
  // fields — when TV answered for symbol A but only Yahoo for symbol B,
  // data2.weekChange.toFixed() threw TypeError and killed the whole
  // /compare command. Guard on BOTH symbols having the field.
  if (data1.weekChange !== undefined && data2.weekChange !== undefined) {
    msg += `<code>Week        ${((data1.weekChange >= 0 ? '+' : '') + data1.weekChange.toFixed(1) + '%').padEnd(10)} ${((data2.weekChange >= 0 ? '+' : '') + data2.weekChange.toFixed(1) + '%').padEnd(10)}</code>\n`;
  }
  if (data1.monthChange !== undefined && data2.monthChange !== undefined) {
    msg += `<code>Month       ${((data1.monthChange >= 0 ? '+' : '') + data1.monthChange.toFixed(1) + '%').padEnd(10)} ${((data2.monthChange >= 0 ? '+' : '') + data2.monthChange.toFixed(1) + '%').padEnd(10)}</code>\n`;
  }
  if (data1.threeMonthChange !== undefined && data2.threeMonthChange !== undefined) {
    msg += `<code>3-Month     ${((data1.threeMonthChange >= 0 ? '+' : '') + data1.threeMonthChange.toFixed(1) + '%').padEnd(10)} ${((data2.threeMonthChange >= 0 ? '+' : '') + data2.threeMonthChange.toFixed(1) + '%').padEnd(10)}</code>\n`;
  }

  msg += `<code>Vol(M)      ${((data1.volume / 1000000).toFixed(1)).padEnd(10)} ${((data2.volume / 1000000).toFixed(1)).padEnd(10)}</code>\n`;

  // Winner verdict
  msg += `\n⚡ <b>AI Verdict:</b> `;
  const score1 = (data1.rsi < 40 ? 20 : 0) + (data1.change > 0 ? 10 : 0) + ((data1.monthChange || 0) > 0 ? 15 : 0);
  const score2 = (data2.rsi < 40 ? 20 : 0) + (data2.change > 0 ? 10 : 0) + ((data2.monthChange || 0) > 0 ? 15 : 0);

  if (score1 > score2) msg += `<b>${data1.symbol}</b> looks stronger for entry right now`;
  else if (score2 > score1) msg += `<b>${data2.symbol}</b> looks stronger for entry right now`;
  else msg += `Both symbols are equally positioned`;

  msg += `\n\n💎 <i>Deep Mind AI Pro Trading Terminal</i>`;
  return msg;
}

// ========================================
// /live — Real-Time Market Sensor Data
// source: 'COINDCX' = INR prices direct, 'TRADINGVIEW' = USD prices
// ========================================
export function generateLiveReport(intel, cryptos, bonds, usdInr, source = 'TRADINGVIEW') {
  const timeStr = getISTTime();
  let msg = `📡 <b>LIVE MARKET SENSOR</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i> | ${getMarketStatus()}\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // Global Indices
  if (intel?.globalIndices?.length > 0) {
    msg += `🌍 <b>GLOBAL INDICES</b>\n`;
    for (const idx of intel.globalIndices) {
      const em = idx.change >= 0 ? '🟢' : '🔴';
      msg += `${em} <b>${idx.name}</b>: ${idx.price?.toFixed(2)} (${idx.change >= 0 ? '+' : ''}${idx.change?.toFixed(2)}%)\n`;
    }
    msg += `\n`;
  }

  // Crypto
  if (cryptos?.length > 0) {
    const isInr = source === 'COINDCX';
    msg += `🪙 <b>CRYPTO${isInr ? ' (CoinDCX INR)' : ''}</b>\n`;
    for (const c of cryptos.slice(0, 6)) {
      const em = c.change >= 0 ? '🟢' : '🔴';
      if (isInr) {
        const inrStr = c.price >= 1000
          ? `₹${c.price.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
          : `₹${c.price.toFixed(2)}`;
        msg += `${em} <b>${c.symbol}</b>: ${inrStr} (${c.change >= 0 ? '+' : ''}${c.change.toFixed(2)}%)\n`;
      } else {
        const priceStr = c.price >= 1000 ? `$${c.price.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : `$${c.price.toFixed(4)}`;
        msg += `${em} <b>${c.symbol}</b>: ${priceStr} (${c.change >= 0 ? '+' : ''}${c.change.toFixed(2)}%)\n`;
      }
    }
    msg += `\n`;
  }

  // Bond Yields
  if (bonds?.length > 0) {
    msg += `📊 <b>BOND YIELDS</b>\n`;
    for (const b of bonds) {
      const em = b.change >= 0 ? '⬆️' : '⬇️';
      msg += `${em} <b>${b.name}</b>: ${b.yield.toFixed(3)}% (${b.change >= 0 ? '+' : ''}${b.change.toFixed(3)})\n`;
    }
    // Yield curve analysis
    const us10 = bonds.find(b => b.name === 'US 10Y');
    const us2 = bonds.find(b => b.name === 'US 2Y');
    if (us10 && us2) {
      const spread = us10.yield - us2.yield;
      msg += `📐 <b>US Yield Curve:</b> ${spread > 0 ? 'NORMAL' : '⚠️ INVERTED'} (${spread >= 0 ? '+' : ''}${spread.toFixed(3)})\n`;
    }
    msg += `\n`;
  }

  // Forex
  msg += `💱 <b>FOREX</b>\n`;
  msg += `🇺🇸🇮🇳 USD/INR: <b>₹${usdInr.toFixed(4)}</b>\n\n`;

  // Sectors
  if (intel?.sectors?.length > 0) {
    msg += `🏭 <b>SECTORS</b>\n`;
    const sorted = [...intel.sectors].sort((a, b) => b.change - a.change);
    for (const s of sorted.slice(0, 5)) {
      msg += `${s.change >= 0 ? '📈' : '📉'} ${s.name}: ${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%\n`;
    }
    msg += `\n`;
  }

  // Fear/Greed
  if (intel?.fearGreedScore !== undefined) {
    let fg = '😰 EXTREME FEAR';
    if (intel.fearGreedScore > 75) fg = '🤑 EXTREME GREED';
    else if (intel.fearGreedScore > 55) fg = '😀 GREED';
    else if (intel.fearGreedScore > 40) fg = '😐 NEUTRAL';
    else if (intel.fearGreedScore > 20) fg = '😟 FEAR';
    msg += `🎭 <b>Fear/Greed:</b> ${intel.fearGreedScore}/100 — ${fg}\n`;
  }

  if (intel?.marketNarrative) {
    msg += `\n💬 <i>${intel.marketNarrative}</i>\n`;
  }

  msg += `\n💎 <i>Deep Mind AI Quantum Pro • Live Sensor</i>`;
  return msg;
}

// ========================================
// /crypto — Crypto Market Report
// source: 'COINDCX' = INR prices direct, 'TRADINGVIEW' = USD prices
// ========================================
export function generateCryptoReport(cryptos, usdInr, source = 'TRADINGVIEW') {
  const timeStr = getISTTime();
  let msg = `🪙 <b>CRYPTO MARKET LIVE</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  if (!cryptos || cryptos.length === 0) {
    msg += `⚠️ Crypto data unavailable. Try again later.\n`;
    return msg;
  }

  const totalMcap = cryptos.reduce((s, c) => s + (c.marketCap || 0), 0);
  const bullish = cryptos.filter(c => c.change > 0).length;
  const bearish = cryptos.filter(c => c.change < 0).length;
  const isInr = source === 'COINDCX';

  msg += `📊 <b>Market Overview</b>\n`;
  if (totalMcap > 0) msg += `Total MCap: <b>$${(totalMcap / 1e12).toFixed(2)}T</b>\n`;
  msg += `Bullish/Bearish: <b>${bullish}/${bearish}</b>\n`;
  msg += `Source: <b>${isInr ? 'CoinDCX (INR)' : 'TradingView (USD)'}</b>\n\n`;

  for (const c of cryptos) {
    const em = c.change >= 0 ? '🟢' : '🔴';
    if (isInr) {
      const inrPrice = c.price;
      const inrStr = inrPrice >= 1000
        ? `₹${inrPrice.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
        : `₹${inrPrice.toFixed(2)}`;
      msg += `${em} <b>${c.symbol}</b>\n`;
      msg += `   💲 ${inrStr}\n`;
      msg += `   📈 ${c.change >= 0 ? '+' : ''}${c.change.toFixed(2)}%`;
      if (c.high && c.low) {
        msg += ` | 🔼 ₹${c.high >= 1000 ? c.high.toFixed(0) : c.high.toFixed(2)}`;
        msg += ` | 🔽 ₹${c.low >= 1000 ? c.low.toFixed(0) : c.low.toFixed(2)}`;
      }
      msg += `\n\n`;
    } else {
      const priceStr = c.price >= 1000
        ? `$${c.price.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
        : c.price >= 1 ? `$${c.price.toFixed(2)}` : `$${c.price.toFixed(4)}`;
      const inrPrice = c.price * usdInr;
      const inrStr = inrPrice >= 1000
        ? `₹${inrPrice.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
        : `₹${inrPrice.toFixed(2)}`;
      const mcapStr = c.marketCap > 0 ? `$${(c.marketCap / 1e9).toFixed(1)}B` : '-';

      msg += `${em} <b>${c.symbol}</b> (${c.name})\n`;
      msg += `   💲 ${priceStr} | 🇮🇳 ${inrStr}\n`;
      msg += `   📈 ${c.change >= 0 ? '+' : ''}${c.change.toFixed(2)}% | MCap: ${mcapStr}\n`;
      if (c.high && c.low) {
        msg += `   🔼 High: $${c.high >= 1000 ? c.high.toFixed(0) : c.high.toFixed(2)} | 🔽 Low: $${c.low >= 1000 ? c.low.toFixed(0) : c.low.toFixed(2)}\n`;
      }
      msg += `\n`;
    }
  }

  const btc = cryptos.find(c => c.symbol === 'BTC');
  if (btc && totalMcap > 0) {
    const dom = ((btc.marketCap / totalMcap) * 100).toFixed(1);
    msg += `👑 <b>BTC Dominance:</b> ~${dom}%\n`;
  }

  msg += `\n💎 <i>Deep Mind AI Quantum Pro • Crypto Terminal</i>`;
  return msg;
}

// ========================================
// /sip — SIP Calculator
// ========================================
export function generateSIPReport(monthlyAmount, years = 10) {
  const timeStr = getISTTime();
  let msg = `💰 <b>SIP INVESTMENT CALCULATOR</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  msg += `📌 Monthly SIP: <b>₹${monthlyAmount.toLocaleString('en-IN')}</b>\n\n`;

  const scenarios = [
    { name: 'Conservative (Debt/FD)', rate: 7, emoji: '🟡' },
    { name: 'Balanced (Hybrid Fund)', rate: 10, emoji: '🟢' },
    { name: 'Aggressive (Equity ETF)', rate: 13, emoji: '🔵' },
    { name: 'High Growth (Small Cap)', rate: 16, emoji: '🟣' },
    { name: 'Nifty 50 Historical', rate: 12, emoji: '🇮🇳' },
    { name: 'S&P 500 Historical', rate: 11, emoji: '🇺🇸' }
  ];

  const durations = [3, 5, 10, 15, 20, 25];

  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  for (const s of scenarios) {
    msg += `\n${s.emoji} <b>${s.name}</b> (${s.rate}% CAGR)\n`;
    for (const y of durations) {
      const r = s.rate / 100 / 12;
      const n = y * 12;
      const fv = monthlyAmount * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
      const invested = monthlyAmount * n;
      const returns = fv - invested;
      msg += `  ${y}Y → <b>₹${Math.round(fv).toLocaleString('en-IN')}</b> (Invested: ₹${invested.toLocaleString('en-IN')} | Gain: ₹${Math.round(returns).toLocaleString('en-IN')})\n`;
    }
  }

  msg += `\n⚠️ <i>Past returns don't guarantee future results. This is for educational purposes only.</i>`;
  msg += `\n\n💎 <i>Deep Mind AI Quantum Pro • SIP Planner</i>`;
  return msg;
}

// ========================================
// /etf — ETF Portfolio Analysis
// ========================================
export function generateETFReport(portfolio, livePrices, usdInr) {
  const timeStr = getISTTime();
  let msg = `📊 <b>ETF PORTFOLIO ANALYSIS</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // All known ETFs with categories
  const etfDb = {
    // Indian ETFs
    'NIFTYBEES': { cat: 'Large Cap', bench: 'NIFTY 50', expense: 0.04 },
    'MID150BEES': { cat: 'Mid Cap', bench: 'NIFTY MIDCAP 150', expense: 0.15 },
    'JUNIORBEES': { cat: 'Large Cap', bench: 'NIFTY NEXT 50', expense: 0.15 },
    'SMALLCAP': { cat: 'Small Cap', bench: 'NIFTY SMALLCAP 250', expense: 0.40 },
    'MOMENTUM50': { cat: 'Factor', bench: 'NIFTY 500 MOMENTUM 50', expense: 0.20 },
    'GOLDBEES': { cat: 'Commodity', bench: 'GOLD', expense: 0.60 },
    'SILVERBEES': { cat: 'Commodity', bench: 'SILVER', expense: 0.55 },
    'BANKBEES': { cat: 'Sectoral', bench: 'BANK NIFTY', expense: 0.15 },
    'ITBEES': { cat: 'Sectoral', bench: 'NIFTY IT', expense: 0.15 },
    'N100': { cat: 'International', bench: 'NASDAQ 100', expense: 0.45 },
    'MON100': { cat: 'International', bench: 'NASDAQ 100', expense: 0.50 },
    // US ETFs
    'SPY': { cat: 'Large Cap', bench: 'S&P 500', expense: 0.09 },
    'QQQ': { cat: 'Tech', bench: 'NASDAQ 100', expense: 0.20 },
    'VOO': { cat: 'Large Cap', bench: 'S&P 500', expense: 0.03 },
    'VTI': { cat: 'Total Market', bench: 'US Total', expense: 0.03 },
    'IWM': { cat: 'Small Cap', bench: 'Russell 2000', expense: 0.19 },
  };

  const etfPositions = portfolio.filter(p => {
    const sym = p.symbol.replace('.NS', '').replace('.BO', '').toUpperCase();
    return etfDb[sym] || sym.includes('BEES') || sym.includes('ETF');
  });

  if (etfPositions.length === 0) {
    msg += `⚠️ No ETFs found in your portfolio.\n\n`;
    msg += `📌 <b>Recommended ETF Portfolio (Aggressive):</b>\n`;
    msg += `  🇮🇳 NIFTYBEES (30%) — Large Cap core\n`;
    msg += `  🇮🇳 MID150BEES (20%) — Mid Cap growth\n`;
    msg += `  🇮🇳 MOMENTUM50 (15%) — Factor alpha\n`;
    msg += `  🇮🇳 GOLDBEES (10%) — Hedge\n`;
    msg += `  🇺🇸 MON100/N100 (25%) — International\n`;
    msg += `\n💎 <i>Deep Mind AI • ETF Terminal</i>`;
    return msg;
  }

  let totalVal = 0, totalInvested = 0;
  const catAlloc = {};

  for (const pos of etfPositions) {
    const key = `${pos.market}_${pos.symbol}`;
    const price = livePrices[key]?.price || pos.avgPrice;
    const change = livePrices[key]?.change || 0;
    const sym = pos.symbol.replace('.NS', '').replace('.BO', '').toUpperCase();
    const info = etfDb[sym] || { cat: 'Other', bench: '-', expense: 0 };
    const isUS = pos.market === 'US';
    const curr = isUS ? '$' : '₹';
    const val = price * pos.qty * (isUS ? usdInr : 1);
    const invested = pos.avgPrice * pos.qty * (isUS ? usdInr : 1);
    const pl = val - invested;

    totalVal += val;
    totalInvested += invested;
    catAlloc[info.cat] = (catAlloc[info.cat] || 0) + val;

    const em = change >= 0 ? '🟢' : '🔴';
    msg += `${em} <b>${pos.symbol}</b> [${info.cat}]\n`;
    msg += `   ${curr}${price.toFixed(2)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)\n`;
    msg += `   Qty: ${pos.qty} | P&L: ${pl >= 0 ? '+' : ''}₹${Math.round(pl).toLocaleString('en-IN')}\n`;
    msg += `   Benchmark: ${info.bench} | Expense: ${info.expense}%\n\n`;
  }

  const totalPL = totalVal - totalInvested;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `💼 <b>ETF Portfolio: ₹${Math.round(totalVal).toLocaleString('en-IN')}</b>\n`;
  msg += `📈 P&L: ${totalPL >= 0 ? '+' : ''}₹${Math.round(totalPL).toLocaleString('en-IN')} (${(totalInvested > 0 ? ((totalPL / totalInvested) * 100) : 0).toFixed(1)}%)\n\n`;

  msg += `🥧 <b>Category Allocation:</b>\n`;
  for (const [cat, val] of Object.entries(catAlloc).sort((a, b) => b[1] - a[1])) {
    const pct = (totalVal > 0 ? ((val / totalVal) * 100) : 0).toFixed(1);
    msg += `  ${cat}: ${pct}% (₹${Math.round(val).toLocaleString('en-IN')})\n`;
  }

  msg += `\n💎 <i>Deep Mind AI Quantum Pro • ETF Terminal</i>`;
  return msg;
}

// ========================================
// /digest — AI Daily Market Digest
// source: 'COINDCX' = INR prices direct, 'TRADINGVIEW' = USD prices
// ========================================
export function generateDigestReport(intel, cryptos, bonds, usdInr, portfolio, livePrices, source = 'TRADINGVIEW') {
  const timeStr = getISTTime();
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

  let msg = `🌅 <b>DAILY MARKET DIGEST</b>\n`;
  msg += `📅 ${today}\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // Key Indices
  if (intel?.globalIndices?.length > 0) {
    msg += `🌍 <b>GLOBAL PULSE</b>\n`;
    const key = ['NIFTY 50', 'SENSEX', 'BANK NIFTY', 'S&P 500', 'NASDAQ 100', 'VIX'];
    for (const name of key) {
      const idx = intel.globalIndices.find(i => i.name === name);
      if (idx) {
        msg += `${idx.change >= 0 ? '🟢' : '🔴'} ${idx.name}: ${idx.price.toFixed(0)} (${idx.change >= 0 ? '+' : ''}${idx.change.toFixed(2)}%)\n`;
      }
    }
    msg += `\n`;
  }

  // Crypto Snapshot
  if (cryptos?.length > 0) {
    const btc = cryptos.find(c => c.symbol === 'BTC');
    const eth = cryptos.find(c => c.symbol === 'ETH');
    const isInr = source === 'COINDCX';
    if (isInr) {
      if (btc) msg += `🪙 BTC: ₹${btc.price >= 1000 ? btc.price.toFixed(0) : btc.price.toFixed(2)} (${btc.change >= 0 ? '+' : ''}${btc.change.toFixed(1)}%) | `;
      if (eth) msg += `ETH: ₹${eth.price >= 1000 ? eth.price.toFixed(0) : eth.price.toFixed(2)} (${eth.change >= 0 ? '+' : ''}${eth.change.toFixed(1)}%)\n`;
    } else {
      if (btc) msg += `🪙 BTC: $${btc.price.toFixed(0)} (${btc.change >= 0 ? '+' : ''}${btc.change.toFixed(1)}%) | `;
      if (eth) msg += `ETH: $${eth.price.toFixed(0)} (${eth.change >= 0 ? '+' : ''}${eth.change.toFixed(1)}%)\n`;
    }
    msg += `\n`;
  }

  // Bond Yields
  if (bonds?.length > 0) {
    const us10 = bonds.find(b => b.name === 'US 10Y');
    const in10 = bonds.find(b => b.name === 'India 10Y');
    if (us10) msg += `📊 US 10Y: ${us10.yield.toFixed(3)}% | `;
    if (in10) msg += `India 10Y: ${in10.yield.toFixed(3)}%\n`;
    msg += `\n`;
  }

  // Forex
  msg += `💱 USD/INR: ₹${usdInr.toFixed(4)}\n\n`;

  // Portfolio Quick Summary
  if (portfolio?.length > 0) {
    const metrics = calculateMetrics(portfolio, livePrices, usdInr);
    msg += `💼 <b>YOUR PORTFOLIO</b>\n`;
    msg += `Total: <b>₹${Math.round(metrics.totalValue).toLocaleString('en-IN')}</b>\n`;
    msg += `Today: ${metrics.todayPL >= 0 ? '🟢 +' : '🔴 '}₹${Math.round(Math.abs(metrics.todayPL)).toLocaleString('en-IN')} (${metrics.todayPct >= 0 ? '+' : ''}${metrics.todayPct.toFixed(2)}%)\n`;
    msg += `Overall: ${metrics.totalPL >= 0 ? '🟢 +' : '🔴 '}₹${Math.round(Math.abs(metrics.totalPL)).toLocaleString('en-IN')} (${metrics.plPct >= 0 ? '+' : ''}${metrics.plPct.toFixed(2)}%)\n\n`;

    // Top Movers
    const movers = portfolio.map(p => {
      const key = `${String(p.market||"").toUpperCase()}_${p.symbol}`;
      return { symbol: p.symbol, change: livePrices[key]?.change || 0 };
    }).sort((a, b) => b.change - a.change);

    if (movers.length > 0) {
      msg += `📈 Top: <b>${movers[0].symbol}</b> (${movers[0].change >= 0 ? '+' : ''}${movers[0].change.toFixed(2)}%)\n`;
      msg += `📉 Bottom: <b>${movers[movers.length - 1].symbol}</b> (${movers[movers.length - 1].change >= 0 ? '+' : ''}${movers[movers.length - 1].change.toFixed(2)}%)\n\n`;
    }
  }

  // Fear/Greed
  if (intel?.fearGreedScore !== undefined) {
    let fg = '😰 EXTREME FEAR';
    if (intel.fearGreedScore > 75) fg = '🤑 EXTREME GREED';
    else if (intel.fearGreedScore > 55) fg = '😀 GREED';
    else if (intel.fearGreedScore > 40) fg = '😐 NEUTRAL';
    else if (intel.fearGreedScore > 20) fg = '😟 FEAR';
    msg += `🎭 Fear/Greed: <b>${intel.fearGreedScore}/100 — ${fg}</b>\n`;
  }

  // Market Narrative
  if (intel?.marketNarrative) {
    msg += `\n💬 <i>${intel.marketNarrative}</i>\n`;
  }

  // Sector Leaders
  if (intel?.sectors?.length > 0) {
    const top3 = [...intel.sectors].sort((a, b) => b.change - a.change).slice(0, 3);
    const bot3 = [...intel.sectors].sort((a, b) => a.change - b.change).slice(0, 3);
    msg += `\n📈 <b>Leading:</b> ${top3.map(s => `${s.name} +${s.change.toFixed(1)}%`).join(', ')}\n`;
    msg += `📉 <b>Lagging:</b> ${bot3.map(s => `${s.name} ${s.change.toFixed(1)}%`).join(', ')}\n`;
  }

  msg += `\n<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `🧠 <i>Deep Mind AI Quantum Pro v12.0 • Daily Digest</i>`;
  return msg;
}

// ========================================
// FII/DII Report
// ========================================
// v20.7.3: escape untrusted web content for parse_mode:HTML messages.
// (bot.mjs has its own copy; this module is imported standalone.)
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function generateFIIDIIReport(fiiData) {
  const timeStr = getISTTime();
  let msg = `🏛️ <b>FII / DII FLOW TRACKER</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  if (!fiiData || !fiiData.summary) {
    msg += `⚠️ FII/DII data unavailable. Try again during market hours.\n`;
  } else {
    // v20.7.3 FIX: Tavily-sourced summaries/titles/URLs are EXTERNAL web
    // content — a raw < / & breaks parse_mode:HTML rendering. Escape.
    msg += `📊 <b>Latest Data:</b>\n${escapeHtml(fiiData.summary)}\n\n`;
    if (fiiData.sources?.length > 0) {
      msg += `🔗 <b>Sources:</b>\n`;
      for (const src of fiiData.sources) {
        msg += `• <a href="${escapeHtml(String(src.url || ''))}">${escapeHtml(String(src.title || 'source'))}</a>\n`;
      }
    }
  }

  msg += `\n💎 <i>Deep Mind AI • Institutional Flow Tracker</i>`;
  return msg;
}

// ========================================
// IPO Report
// ========================================
export function generateIPOReport(ipoData) {
  const timeStr = getISTTime();
  let msg = `🚀 <b>IPO TRACKER</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  if (!ipoData || !ipoData.summary) {
    msg += `⚠️ IPO data unavailable. Try again later.\n`;
  } else {
    // v20.7.3 FIX: escape external web content (see generateFIIDIIReport).
    msg += `📋 <b>Latest IPO Updates:</b>\n${escapeHtml(ipoData.summary)}\n\n`;
    if (ipoData.sources?.length > 0) {
      msg += `🔗 <b>Sources:</b>\n`;
      for (const src of ipoData.sources) {
        msg += `• <a href="${escapeHtml(String(src.url || ''))}">${escapeHtml(String(src.title || 'source'))}</a>\n`;
      }
    }
  }

  msg += `\n💎 <i>Deep Mind AI • IPO Intelligence</i>`;
  return msg;
}

// ========================================
// /longterm - 15-20yr Wealth Strategy
// ========================================
export function generateLongTermReport() {
  const timeStr = getISTTime();
  let msg = `📈 <b>LONG-TERM WEALTH CREATION (15-20Y)</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  msg += `🚀 <b>The Power of 10% SIP Step-Up</b>\n`;
  msg += `<i>Increasing your SIP by just 10% every year drastically boosts final wealth due to compound interest magic.</i>\n\n`;

  const baseSIP = 25000;
  msg += `📌 <b>Example: ₹${baseSIP.toLocaleString('en-IN')}/mo base SIP</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `<b>No Step-Up (15% CAGR, 15 Years)</b>\n`;
  msg += `Invested: ₹45,00,000\n`;
  msg += `Final Wealth: ₹1.69 Cr\n\n`;

  msg += `<b>10% Annual Step-Up (15% CAGR, 15 Years)</b>\n`;
  msg += `Invested: ₹95,30,000\n`;
  msg += `Final Wealth: <b>₹3.02 Cr (Almost double!)</b>\n\n`;

  msg += `🧠 <b>Actionable Advice:</b>\n`;
  msg += `1. Never stop SIPs during bear markets.\n`;
  msg += `2. Top up investments by 20% when VIX > 25.\n`;
  msg += `3. Always opt for 10% annual step-ups linked to your salary increment.\n`;
  msg += `\n💎 <i>Deep Mind AI Quantum Pro v12.0</i>`;
  return msg;
}

// ========================================
// /strategy - Institutional Asset Strategy
// ========================================
export function generateStrategyReport(portfolio, livePrices, usdInr) {
  const timeStr = getISTTime();
  let msg = `🎯 <b>INSTITUTIONAL ASSET ALLOCATION</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  msg += `💼 <b>Core-Satellite Strategy (Rule of 100)</b>\n`;
  msg += `<i>Aimed to generate maximum Alpha with protected downside.</i>\n\n`;

  msg += `<b>1. Core Holdings (50-60%)</b>\n`;
  msg += `Index/Large Cap: NIFTYBEES, SPY, VOO\n`;
  msg += `Purpose: Foundation and stability.\n\n`;

  msg += `<b>2. Satellite Growth (30-40%)</b>\n`;
  msg += `Mid/Small Cap & Momentum: MID150BEES, MOMENTUM50, ALPHA ETF\n`;
  msg += `Purpose: Beat the index returns (Alpha generation).\n\n`;

  msg += `<b>3. Moonshot (5-10%)</b>\n`;
  msg += `Crypto: BTC, ETH\n`;
  msg += `Purpose: Massive asymmetric upside.\n\n`;

  msg += `<b>4. Hedge (5-10%)</b>\n`;
  msg += `Commodities: GOLDBEES, SILVERBEES\n`;
  msg += `Purpose: Bear market protection.\n\n`;

  msg += `🧠 <b>Deep Mind Logic:</b> Maintain heavy allocation in momentum and alpha ETFs when VIX < 18. Shift 10% to Hedge when VIX > 25.\n`;
  msg += `\n💎 <i>Deep Mind AI Quantum Pro v12.0</i>`;
  return msg;
}
// ========================================
// /siptilt — Smart SIP Auto-Tilt (VIX + RSI based multiplier)
// ========================================
export function generateSipTiltReport(portfolio, livePrices, usdInr) {
  const timeStr = getISTTime();
  const usVix = livePrices['US_VIX']?.price || 15;
  const inVix = livePrices['IN_INDIAVIX']?.price || 15;
  const avgVix = (usVix + inVix) / 2;

  // Portfolio average RSI (oversold = cheap = tilt up)
  let rsiSum = 0, rsiCount = 0;
  for (const p of portfolio) {
    const d = livePrices[`${String(p.market||"").toUpperCase()}_${p.symbol}`];
    if (d?.rsi) { rsiSum += d.rsi; rsiCount++; }
  }
  const avgRsi = rsiCount > 0 ? rsiSum / rsiCount : 50;

  // Nifty drawdown from recent high (proxy via change-based regime)
  const niftyChange = livePrices['IN_NIFTY']?.change || 0;

  // --- Multiplier logic ---
  // VIX high (fear) + RSI low (oversold) = market sasta = SIP zyada
  let multiplier = 1.0;
  let reason = '';

  if (avgVix > 28 || avgRsi < 32) {
    multiplier = 2.0;
    reason = 'Market me bada fear/oversold. Maximum deployment — generational buying zone.';
  } else if (avgVix > 22 || avgRsi < 40) {
    multiplier = 1.5;
    reason = 'Elevated fear / dip chal raha hai. SIP 1.5x karo — discount pe accumulate.';
  } else if (avgVix < 13 && avgRsi > 65) {
    multiplier = 0.75;
    reason = 'Extreme greed + overbought (ATH zone). SIP thoda kam karo, cash bachao.';
  } else if (avgVix < 15 || avgRsi > 60) {
    multiplier = 0.9;
    reason = 'Market mehnga lag raha hai. Normal se thoda kam, par SIP rokho mat.';
  } else {
    multiplier = 1.0;
    reason = 'Neutral zone. Standard SIP optimal hai. Emotion-free chalu rakho.';
  }

  const baseIN = DEFAULT_INDIA_SIP;
  const baseUS = DEFAULT_US_SIP;
  const tiltIN = Math.round(baseIN * multiplier);
  const tiltUS = Math.round(baseUS * multiplier);

  const mEmoji = multiplier >= 1.5 ? '🟢🟢' : multiplier > 1 ? '🟢' : multiplier === 1 ? '🟡' : '🔴';

  let msg = `📊 <b>SMART SIP AUTO-TILT</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i> | ${getMarketStatus()}\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  msg += `🌡️ <b>Market Conditions</b>\n`;
  msg += `Avg VIX: <b>${avgVix.toFixed(1)}</b> ${avgVix > 22 ? '🔴 Fear' : avgVix < 14 ? '🟢 Calm/Greed' : '🟡 Normal'}\n`;
  msg += `Portfolio Avg RSI: <b>${avgRsi.toFixed(0)}</b> ${avgRsi < 40 ? '🟢 Cheap' : avgRsi > 60 ? '🔴 Expensive' : '🟡 Fair'}\n`;
  msg += `NIFTY Today: ${niftyChange >= 0 ? '+' : ''}${niftyChange.toFixed(2)}%\n\n`;

  msg += `${mEmoji} <b>Recommended SIP Multiplier: ${multiplier}x</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `🇮🇳 India SIP: ₹${baseIN.toLocaleString('en-IN')} → <b>₹${tiltIN.toLocaleString('en-IN')}</b>\n`;
  msg += `🇺🇸 US SIP: $${baseUS} → <b>$${tiltUS}</b>\n\n`;

  msg += `🧠 <b>AI Reasoning:</b>\n<i>${reason}</i>\n\n`;
  msg += `💡 <i>Rule: Market sasta = zyada lagao, mehnga = kam. Emotion-free, mechanical.</i>`;
  msg += `\n\n💎 <i>Deep Mind AI Quantum Pro • SIP Tilt Engine</i>`;
  return msg;
}

// ========================================
// /taxplan — India Tax Optimizer (LTCG + Crypto + Harvesting)
// ========================================
export function generateTaxPlanReport(portfolio, livePrices, usdInr) {
  const timeStr = getISTTime();
  const LTCG_EXEMPTION = 125000; // ₹1.25L LTCG exemption per FY (equity)

  let msg = `💸 <b>TAX OPTIMIZER (India FY)</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // Estimate unrealized gains split: equity vs crypto
  let equityGain = 0, cryptoGain = 0, equityLoss = 0;
  const harvestable = [];

  for (const p of portfolio) {
    const d = livePrices[`${String(p.market||"").toUpperCase()}_${p.symbol}`];
    const price = d?.price || p.avgPrice;
    const plAbs = (price - p.avgPrice) * p.qty;
    const plINR = p.market === 'US' ? plAbs * usdInr : plAbs;
    const cleanSym = p.symbol.replace('.NS', '').replace('.BO', '');

    if (isCryptoSymbol(cleanSym)) {
      if (plINR > 0) cryptoGain += plINR;
    } else {
      if (plINR > 0) equityGain += plINR;
      else { equityLoss += Math.abs(plINR); harvestable.push({ sym: cleanSym, loss: Math.abs(plINR), market: p.market }); }
    }
  }

  // 1. LTCG harvesting opportunity
  msg += `🎯 <b>1. LTCG ₹1.25L Harvesting</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `Unrealized equity gains: <b>₹${Math.round(equityGain).toLocaleString('en-IN')}</b>\n`;
  if (equityGain > 0) {
    const bookable = Math.min(equityGain, LTCG_EXEMPTION);
    msg += `✅ Tax-free book karne layak: <b>₹${Math.round(bookable).toLocaleString('en-IN')}</b>\n`;
    msg += `<i>Itna gain sell karke turant re-buy karo — cost basis reset, ₹0 tax (LTCG exemption use).</i>\n`;
    if (equityGain > LTCG_EXEMPTION) {
      const taxable = (equityGain - LTCG_EXEMPTION) * 0.125;
      msg += `⚠️ ₹1.25L se upar wale gain pe 12.5% LTCG ≈ <b>₹${Math.round(taxable).toLocaleString('en-IN')}</b> tax lagega.\n`;
    }
  } else {
    msg += `<i>Abhi koi equity gain nahi — harvesting ki zarurat nahi.</i>\n`;
  }
  msg += `\n`;

  // 2. Tax-loss harvesting
  msg += `🔄 <b>2. Tax-Loss Harvesting</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  if (harvestable.length > 0) {
    harvestable.sort((a, b) => b.loss - a.loss);
    for (const h of harvestable) {
      const flag = h.market === 'IN' ? '🇮🇳' : '🇺🇸';
      msg += `${flag} <b>${h.sym}</b>: ₹${Math.round(h.loss).toLocaleString('en-IN')} loss bookable\n`;
    }
    msg += `<i>Total ₹${Math.round(equityLoss).toLocaleString('en-IN')} loss book karke gains se offset karo. /taxloss me swap pairs dekho.</i>\n`;
  } else {
    msg += `<i>Koi losing equity position nahi — sab profit me. 👍</i>\n`;
  }
  msg += `\n`;

  // 3. Crypto 30% impact
  msg += `🪙 <b>3. Crypto 30% Tax Impact</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `Unrealized crypto gains: <b>₹${Math.round(cryptoGain).toLocaleString('en-IN')}</b>\n`;
  if (cryptoGain > 0) {
    const cryptoTax = cryptoGain * 0.30;
    msg += `⚠️ Sell karoge to flat 30% tax ≈ <b>₹${Math.round(cryptoTax).toLocaleString('en-IN')}</b> (+ 1% TDS).\n`;
    msg += `<i>Crypto me loss offset NAHI hota, har gain pe 30%. Isliye HODL/DCA best — sell tabhi jab zaroori ho.</i>\n`;
  } else {
    msg += `<i>Abhi koi crypto gain nahi. Long-term HODL continue.</i>\n`;
  }
  msg += `\n`;

  // 4. ELSS reminder
  msg += `📋 <b>4. ELSS / 80C Reminder</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `<i>Old regime me ho to ELSS ₹1.5L (80C) invest karke ₹46,800 tak tax bachao. 3yr lock-in + equity returns.</i>\n`;

  msg += `\n⚠️ <i>Educational hai, CA se confirm karo. FY-end (Mar 31) se pehle plan karo.</i>`;
  msg += `\n💎 <i>Deep Mind AI Quantum Pro • Tax Optimizer</i>`;
  return msg;
}

// ========================================
// /drawdown — Drawdown Recovery Tracker
// ========================================
export function generateDrawdownReport(portfolio, livePrices, usdInr) {
  const timeStr = getISTTime();

  let msg = `📉 <b>DRAWDOWN RECOVERY TRACKER</b>\n`;
  msg += `⏰ <i>${timeStr} IST</i>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  if (portfolio.length === 0) {
    msg += `⚠️ Portfolio khali hai.\n`;
    return msg;
  }

  const positions = [];
  for (const p of portfolio) {
    const d = livePrices[`${String(p.market||"").toUpperCase()}_${p.symbol}`];
    const price = d?.price || p.avgPrice;
    const high = d?.high || price;
    const cleanSym = p.symbol.replace('.NS', '').replace('.BO', '');
    const cur = p.market === 'IN' ? '₹' : '$';

    // Drawdown from avg cost (underwater) AND from day high
    const ddFromAvg = p.avgPrice > 0 ? ((price - p.avgPrice) / p.avgPrice) * 100 : 0;
    const cagr = getAssetCagrProxy(p.symbol, p.market);

    // Recovery estimate: if underwater, time to regain avg cost at asset CAGR.
    // FIX H10: when price > 2× avgPrice, gainNeeded < -1 → Math.log(negative)
    // = NaN → recoveryMonths = NaN → "NaN mo" rendered to user. Guard with
    // `gainNeeded > -1` so deeply-profitable positions show "0 mo (profitable)".
    let recoveryMonths = 0;
    if (ddFromAvg < 0) {
      const gainNeeded = (p.avgPrice / price) - 1; // fractional gain to break even
      const monthlyRate = Math.pow(1 + cagr / 100, 1 / 12) - 1;
      if (gainNeeded > -1 && monthlyRate > 0) {
        recoveryMonths = Math.log(1 + gainNeeded) / Math.log(1 + monthlyRate);
      }
    }

    positions.push({ sym: cleanSym, cur, price, avg: p.avgPrice, ddFromAvg, recoveryMonths, cagr, underwater: ddFromAvg < 0 });
  }

  const underwater = positions.filter(p => p.underwater).sort((a, b) => a.ddFromAvg - b.ddFromAvg);
  const profitable = positions.filter(p => !p.underwater);

  // Portfolio-level
  const metrics = calculateMetrics(portfolio, livePrices, usdInr);
  msg += `💼 <b>Portfolio P&L:</b> ${metrics.plPct >= 0 ? '🟢 +' : '🔴 '}${metrics.plPct.toFixed(2)}%\n`;
  msg += `Underwater positions: <b>${underwater.length}/${positions.length}</b>\n\n`;

  if (underwater.length > 0) {
    msg += `🌊 <b>UNDERWATER POSITIONS</b>\n`;
    msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
    for (const p of underwater) {
      const bars = Math.min(10, Math.round(Math.abs(p.ddFromAvg) / 3));
      const ddBar = '🟥'.repeat(bars) + '⬜'.repeat(10 - bars);
      let recStr;
      if (p.recoveryMonths <= 0) recStr = 'N/A';
      else if (p.recoveryMonths < 12) recStr = `~${Math.round(p.recoveryMonths)} mo`;
      else recStr = `~${(p.recoveryMonths / 12).toFixed(1)} yr`;

      msg += `\n🔴 <b>${p.sym}</b>: ${p.ddFromAvg.toFixed(1)}% underwater\n`;
      msg += `   ${p.cur}${p.price.toFixed(2)} vs Avg ${p.cur}${p.avg.toFixed(2)}\n`;
      msg += `   <code>[${ddBar}]</code>\n`;
      msg += `   ⏳ Recovery est: <b>${recStr}</b> (@${p.cagr}% CAGR)\n`;
    }
    msg += `\n💪 <i>Bhai, drawdown temporary hai. Quality assets recover karte hain. Yahi accumulation ka time hai — ghabrao mat, SIP chalu rakho.</i>\n`;
  } else {
    msg += `✅ <b>Koi position underwater nahi!</b> Sab assets profit me hain. 🚀\n`;
  }

  if (profitable.length > 0) {
    msg += `\n🟢 <b>In profit:</b> ${profitable.map(p => p.sym).join(', ')}\n`;
  }

  msg += `\n💎 <i>Deep Mind AI Quantum Pro • Drawdown Tracker</i>`;
  return msg;
}
