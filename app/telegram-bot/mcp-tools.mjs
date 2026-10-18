// ============================================
// MCP / AI SUPERINTELLIGENCE REAL-TIME DATA AGENT
// Comprehensive Portfolio Deep Dive & Long-Term Wealth Blueprints
// ============================================

import {
  fetchSingleSymbol,
  fetchForexRate,
  fetchMarketIntelligence,
  fetchCryptoPricesINR,
  fetchCryptoPrices,
  fetchBondYields,
  fetchFIIDIIData
} from './market.mjs';
import { calculateMetrics, analyzeAsset } from './analysis.mjs';
import { TAVILY_API_KEY, isTavilyAvailable, guessMarket } from './config.mjs';

// ============================================
// 1. SUPERSCORE v6.0 PURE CALCULATION ENGINE
// Weights: RSI zone 35% | SMA20/50 divergence 25% | MACD 15% |
// day-range position 15% | anti-chasing momentum 10%
// ============================================
export function computeSuperScore(o) {
  const rsi = o.rsi || 50;
  const price = o.price || 1;
  const change = o.change || 0;
  let score = 50;

  // 35% RSI zone
  score += rsi < 30 ? 20 : rsi < 40 ? 10 : rsi > 75 ? -20 : rsi > 65 ? -10 : 0;

  // 25% trend divergence (SMA20 vs SMA50)
  if (o.sma20 && o.sma50 && o.sma50 > 0) {
    const divPct = ((o.sma20 - o.sma50) / o.sma50) * 100;
    score += Math.max(-15, Math.min(15, divPct * 3));
  }

  // 15% MACD direction
  if (o.macd !== undefined) score += o.macd > 0 ? 8 : -8;

  // 15% day-range seat (closer to day low = better entry)
  const hi = o.high ?? price;
  const lo = o.low ?? price;
  const dayRangePos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  score += (0.5 - dayRangePos) * 12;

  // 10% anti-chasing momentum (sharp green day lowers buy score; sharp dip raises)
  score += change > 4 ? -6 : change > 0 ? 2 : change < -4 ? 6 : 4;

  return Math.max(1, Math.min(99, Math.round(score)));
}

// ============================================
// 2. TOOL DEFINITIONS (OpenAI & Gemini Formats)
// ============================================

export const MCP_TOOLS_OPENAI = [
  {
    type: 'function',
    function: {
      name: 'analyze_portfolio_superintelligence',
      description: 'Run deep real-time quantitative audit on EVERY holding in user portfolio. Returns SuperScore (1-99), exact Buy Dip entry prices, Hold zones, Profit Booking targets, Trailing Stop Losses, and 3-5 Year Long-Term Wealth Compound targets.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_superscore_analysis',
      description: 'Calculate composite SuperScore v6.0 (1-99), RSI/SMA/MACD breakdown, day-range positioning, and inside story for any single stock or crypto.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol to analyze (e.g. RELIANCE, TCS, NVDA, BTC).' },
          market: { type: 'string', enum: ['IN', 'US'], description: 'Market (IN or US).' }
        },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_live_quote',
      description: 'Fetch real-time price, day change percentage, high, low, and volume for any Indian stock/ETF, US stock, or crypto ticker.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker symbol (e.g. RELIANCE, TCS, NVDA, AAPL, BTC).' },
          market: { type: 'string', enum: ['IN', 'US'], description: 'Market: IN or US.' }
        },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_whale_block_deals',
      description: 'Scan user portfolio & Indian markets for unusually large institutional moves (>3%), bulk deals, block deals, and whale activity.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_fii_dii_positioning',
      description: 'Fetch latest FII & DII net cash flow, institutional sentiment, and smart money direction in Indian markets.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_sector_rotation_radar',
      description: 'Get real-time performance and capital rotation across major NSE sectors (IT, Bank, Auto, Pharma, FMCG, Metal, Realty).',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_market_news',
      description: 'Search real-time financial news, quarterly earnings, or breaking events via Tavily web search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g. "TCS Q3 results", "Reliance retail expansion").' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_market_regime',
      description: 'Get real-time global market regime, India VIX, US VIX, DXY, Gold, Crude Oil, bond yields, and Fear & Greed narrative.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate_trade_setup',
      description: 'Calculate quantitative Entry, Stop Loss, Target 1, Target 2, Target 3, and Risk-to-Reward ratio.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Asset symbol.' },
          currentPrice: { type: 'number', description: 'Current market price.' },
          bias: { type: 'string', enum: ['BULLISH', 'BEARISH'], description: 'Trading bias.' },
          atrPercent: { type: 'number', description: 'Expected ATR % (default: 2.5).' }
        },
        required: ['symbol', 'currentPrice', 'bias']
      }
    }
  }
];

export const MCP_TOOLS_GEMINI = [
  {
    functionDeclarations: MCP_TOOLS_OPENAI.map(t => t.function)
  }
];

// ============================================
// 3. TOOL EXECUTION ENGINE
// ============================================

export async function executeMCPTool(name, args = {}, context = {}) {
  const { portfolio = [], livePrices = {}, usdInrRate = 85.5 } = context;

  try {
    switch (name) {
      // 🌟 1. Dedicated Portfolio Superintelligence Deep Audit
      case 'analyze_portfolio_superintelligence': {
        if (!portfolio || portfolio.length === 0) {
          return { message: 'Portfolio is currently empty. Please add holdings via Web App.' };
        }

        const metrics = calculateMetrics(portfolio, livePrices, usdInrRate);
        const holdingsAudit = [];
        let totalScore = 0;

        for (const p of portfolio) {
          const mkt = String(p.market || 'IN').toUpperCase();
          const cacheKey = `${mkt}_${p.symbol}`;
          let pd = livePrices[cacheKey];
          if (!pd || !pd.price) {
            pd = (await fetchSingleSymbol(p.symbol, mkt)) || {};
          }

          const price = pd.price || p.avgPrice || 1;
          const change = pd.change || 0;
          const rsi = pd.rsi || 50;
          const sma20 = pd.sma20 || (price * 0.98);
          const sma50 = pd.sma50 || (price * 0.95);
          const macd = pd.macd;

          const pnlINR = (price - p.avgPrice) * p.qty * (mkt === 'US' ? usdInrRate : 1);
          const pnlPct = p.avgPrice > 0 ? ((price - p.avgPrice) / p.avgPrice) * 100 : 0;
          const currentValueINR = price * p.qty * (mkt === 'US' ? usdInrRate : 1);

          // Calculate SuperScore v6.0
          const superScore = computeSuperScore({
            rsi, price, change, sma20, sma50, macd, high: pd.high, low: pd.low
          });
          totalScore += superScore;

          // Determine Action Verdict & Exact Timing Strategy
          let actionVerdict = 'HOLD_AND_COMPOUND';
          let actionBadge = '🛡️ HOLD & COMPOUND';
          let timingAdvice = 'Current levels healthy hain. Position hold karo, compounding chalne do.';
          let dipBuyZone = `${Math.round(price * 0.94)} - ${Math.round(price * 0.96)}`;
          let profitBookingZone = `${Math.round(price * 1.15)} - ${Math.round(price * 1.25)}`;

          if (superScore >= 68 || rsi < 35) {
            actionVerdict = 'ACCUMULATE_MORE_ON_DIPS';
            actionBadge = '💎 STRONG BUY / ACCUMULATE ON DIPS';
            timingAdvice = `Value & accumulation zone active hai. ${dipBuyZone} pe fresh quantity add karna highest return dega.`;
          } else if (superScore <= 35 || rsi > 72) {
            actionVerdict = 'BOOK_PARTIAL_PROFIT';
            actionBadge = '💰 BOOK PARTIAL PROFIT (TRIM 15-25%)';
            timingAdvice = `Asset overextended/overbought hai (RSI ${Math.round(rsi)}). 15-25% profit book karke dip buying ke liye cash safe rakho.`;
          } else if (pnlPct < -18 && superScore < 45) {
            actionVerdict = 'REVIEW_UNDERPERFORMER';
            actionBadge = '⚠️ REVIEW THESIS / STOP LOSS ALERT';
            timingAdvice = `Heavy drawdown (${pnlPct.toFixed(1)}%). Re-evaluate thesis ya trailing stop-loss trigger consider karo.`;
          }

          // Long-term 3-5 Year Target projection (conservative 14-18% CAGR)
          const target1 = Math.round(price * 1.10);
          const target2 = Math.round(price * 1.25);
          const targetLongTerm3Yr = Math.round(price * 1.65);
          const trailingStopLoss = Math.round(Math.max(p.avgPrice * 0.92, price * 0.90));

          holdingsAudit.push({
            symbol: p.symbol,
            market: mkt,
            qty: p.qty,
            avgPrice: p.avgPrice,
            currentPrice: price,
            currentValueINR: Math.round(currentValueINR),
            pnlINR: Math.round(pnlINR),
            pnlPct: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`,
            superScore: `${superScore}/99`,
            superScoreCategory: superScore >= 65 ? 'BUY-LEAN 🟢' : superScore <= 35 ? 'SELL-LEAN 🔴' : 'NEUTRAL 🟡',
            rsi: Math.round(rsi),
            actionBadge,
            actionVerdict,
            timingAdvice,
            dipBuyZone,
            trailingStopLoss,
            target1,
            target2,
            targetLongTerm3Yr
          });
        }

        const avgPortfolioSuperScore = Math.round(totalScore / portfolio.length);

        return {
          totalHoldings: portfolio.length,
          totalPortfolioValueINR: Math.round(metrics.totalValue),
          totalInvestedINR: Math.round(metrics.totalInvested),
          totalPnLINR: Math.round(metrics.totalPL),
          totalPnLPct: `${metrics.plPct >= 0 ? '+' : ''}${metrics.plPct.toFixed(2)}%`,
          todayPnLINR: Math.round(metrics.todayPL),
          todayPnLPct: `${metrics.todayPct >= 0 ? '+' : ''}${metrics.todayPct.toFixed(2)}%`,
          overallPortfolioSuperScore: `${avgPortfolioSuperScore}/99`,
          portfolioHealthVerdict: avgPortfolioSuperScore >= 65 ? 'EXCELLENT ACCUMULATION 🚀' : avgPortfolioSuperScore >= 48 ? 'HEALTHY COMPOUNDING 🟢' : 'CAUTION / REBALANCE NEEDED ⚠️',
          holdingsAudit
        };
      }

      // 2. Single Stock SuperScore Analysis
      case 'get_superscore_analysis': {
        const rawSym = String(args.symbol || '').trim().toUpperCase();
        if (!rawSym) return { error: 'Symbol is required' };
        const market = args.market || guessMarket(rawSym);
        const cacheKey = `${market}_${rawSym}`;
        const pd = livePrices[cacheKey] || (await fetchSingleSymbol(rawSym, market)) || {};

        const price = pd.price || 1;
        const change = pd.change || 0;
        const rsi = pd.rsi || 50;
        const sma20 = pd.sma20 || (price * 0.98);
        const sma50 = pd.sma50 || (price * 0.95);
        const macd = pd.macd;

        const superScore = computeSuperScore({
          rsi, price, change, sma20, sma50, macd, high: pd.high, low: pd.low
        });

        return {
          symbol: rawSym,
          market,
          currentPrice: price,
          change: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
          superScore: `${superScore}/99`,
          stance: superScore >= 65 ? 'BUY-LEAN / ACCUMULATE' : superScore <= 35 ? 'SELL-LEAN / TRIM' : 'NEUTRAL / HOLD',
          components: {
            rsi: Math.round(rsi),
            rsiZone: rsi < 30 ? 'Oversold (Value Zone)' : rsi > 70 ? 'Overbought (Risk Zone)' : 'Neutral',
            trend: sma20 > sma50 ? 'Golden Cross / Bullish Uptrend' : 'Death Cross / Bearish Downtrend',
            macd: macd !== undefined ? (macd > 0 ? 'Bullish Expansion' : 'Bearish Divergence') : 'Neutral'
          },
          dipBuyZone: `${Math.round(price * 0.94)} - ${Math.round(price * 0.96)}`,
          trailingSL: Math.round(price * 0.91),
          target1: Math.round(price * 1.08),
          targetLongTerm3Yr: Math.round(price * 1.60)
        };
      }

      // 3. Whale & Block Deals Tracker
      case 'get_whale_block_deals': {
        let portfolioWhales = [];
        if (portfolio.length > 0) {
          portfolioWhales = portfolio
            .map(p => {
              const pd = livePrices[`${p.market}_${p.symbol}`];
              if (!pd || Math.abs(pd.change || 0) < 2.5) return null;
              return {
                symbol: p.symbol,
                market: p.market,
                change: `${pd.change >= 0 ? '+' : ''}${pd.change.toFixed(2)}%`,
                currentPrice: pd.price,
                institutionalMove: Math.abs(pd.change) >= 4 ? 'HIGH INSTUTIONAL FLOW' : 'MODERATE FLOW'
              };
            })
            .filter(Boolean);
        }

        let tavilyDeals = null;
        if (isTavilyAvailable()) {
          try {
            const res = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: TAVILY_API_KEY,
                query: 'India NSE BSE block deal bulk deal institutional large trades today',
                search_depth: 'basic',
                include_answer: true,
                max_results: 4,
                topic: 'finance'
              }),
              signal: AbortSignal.timeout(8000)
            });
            if (res.ok) {
              const d = await res.json();
              tavilyDeals = d.answer || null;
            }
          } catch {}
        }

        return {
          portfolioLargeMovers: portfolioWhales,
          marketBlockDealSummary: tavilyDeals || 'No major block deals flagged in current session.'
        };
      }

      // 4. FII / DII Institutional Flow
      case 'get_fii_dii_positioning': {
        if (!isTavilyAvailable()) return { error: 'Tavily key required for FII/DII live data' };
        const fii = await fetchFIIDIIData(TAVILY_API_KEY);
        return {
          summary: fii?.summary || 'FII/DII data unavailable',
          institutionalBias: (fii?.summary || '').toLowerCase().includes('net buy') ? 'NET BUYERS (Institutional Inflows 🟢)' : 'NET SELLERS / CAUTIOUS 🔴'
        };
      }

      // 5. Sector Rotation Radar
      case 'get_sector_rotation_radar': {
        const intel = await fetchMarketIntelligence();
        const sectors = intel?.sectors || [];
        return {
          topLeadingSectors: sectors.filter(s => s.change > 0).sort((a, b) => b.change - a.change),
          laggingSectors: sectors.filter(s => s.change <= 0).sort((a, b) => a.change - b.change),
          marketBreadthNarrative: intel?.marketNarrative || 'Sector rotation steady'
        };
      }

      // 6. Live Quote
      case 'get_live_quote': {
        const rawSym = String(args.symbol || '').trim().toUpperCase();
        if (!rawSym) return { error: 'Symbol is required' };
        const market = args.market || guessMarket(rawSym);
        const cacheKey = `${market}_${rawSym}`;

        if (livePrices[cacheKey]?.price) {
          const p = livePrices[cacheKey];
          return { symbol: rawSym, market, price: p.price, change: p.change || 0, high: p.high || p.price, low: p.low || p.price, volume: p.volume || 0, currency: market === 'US' ? 'USD' : 'INR' };
        }

        const quote = await fetchSingleSymbol(rawSym, market);
        if (quote && quote.price > 0) {
          return { symbol: rawSym, market, price: quote.price, change: quote.change || 0, high: quote.high || quote.price, low: quote.low || quote.price, volume: quote.volume || 0, currency: market === 'US' ? 'USD' : 'INR' };
        }
        return { error: `Could not fetch live price for ${rawSym}` };
      }

      // 7. Search Market News
      case 'search_market_news': {
        const query = String(args.query || '').trim();
        if (!query) return { error: 'Search query is required' };
        if (!isTavilyAvailable()) return { error: 'Tavily API key not configured' };

        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query: `${query} latest stock financial news`,
            search_depth: 'basic',
            include_answer: true,
            max_results: 4,
            topic: 'finance'
          }),
          signal: AbortSignal.timeout(8000)
        });

        if (!res.ok) return { error: `Tavily HTTP ${res.status}` };
        const data = await res.json();
        return {
          query,
          aiSummary: data.answer || 'No direct summary found',
          articles: (data.results || []).slice(0, 3).map(r => ({ title: r.title, content: (r.content || '').substring(0, 180), url: r.url }))
        };
      }

      // 8. Market Regime
      case 'get_market_regime': {
        const intel = await fetchMarketIntelligence();
        const fx = await fetchForexRate().catch(() => usdInrRate);
        const bonds = await fetchBondYields().catch(() => []);
        return {
          narrative: intel?.marketNarrative || 'Market conditions steady',
          fearGreedScore: intel?.fearGreedScore || 50,
          usdInr: fx,
          globalIndices: (intel?.globalIndices || []).map(i => ({ name: i.name, price: i.price, change: `${i.change >= 0 ? '+' : ''}${i.change.toFixed(2)}%` })),
          sectors: (intel?.sectors || []).map(s => ({ name: s.name, change: `${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%` })),
          bondYields: bonds.map(b => ({ name: b.name, yield: `${b.yield.toFixed(3)}%` }))
        };
      }

      // 9. Calculate Trade Setup
      case 'calculate_trade_setup': {
        const symbol = String(args.symbol || '').toUpperCase();
        const price = parseFloat(args.currentPrice);
        const bias = String(args.bias || 'BULLISH').toUpperCase();
        const atrPct = parseFloat(args.atrPercent) || 2.5;

        if (!price || price <= 0) return { error: 'Valid currentPrice is required' };
        const atr = price * (atrPct / 100);

        let entry = price;
        let sl = bias === 'BULLISH' ? price - (atr * 1.2) : price + (atr * 1.2);
        let tp1 = bias === 'BULLISH' ? price + (atr * 1.5) : price - (atr * 1.5);
        let tp2 = bias === 'BULLISH' ? price + (atr * 2.5) : price - (atr * 2.5);
        let tp3 = bias === 'BULLISH' ? price + (atr * 4.0) : price - (atr * 4.0);

        const risk = Math.abs(entry - sl);
        const reward1 = Math.abs(tp1 - entry);
        const reward2 = Math.abs(tp2 - entry);

        return {
          symbol,
          bias,
          entryPrice: Math.round(entry * 100) / 100,
          stopLoss: Math.round(sl * 100) / 100,
          target1: Math.round(tp1 * 100) / 100,
          target2: Math.round(tp2 * 100) / 100,
          target3: Math.round(tp3 * 100) / 100,
          riskRewardT1: `1:${(reward1 / (risk || 1)).toFixed(2)}`,
          riskRewardT2: `1:${(reward2 / (risk || 1)).toFixed(2)}`,
          positionSizingAdvice: `Risk max 1-2% of total portfolio on this setup. SL is ${atrPct * 1.2}% away.`
        };
      }

      default:
        return { error: `Unknown tool name: ${name}` };
    }
  } catch (err) {
    return { error: `Tool execution failed: ${err.message}` };
  }
}
