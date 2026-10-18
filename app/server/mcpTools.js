// ============================================================
// Wealth AI Pro — Server-Side Superintelligence MCP Tool Engine
// Bridges Free AI Models (Gemini, Groq, OpenRouter) with
// Live Real-Time Market APIs, SuperScore v6, News & Portfolio Data
// ============================================================

import { getMLPrediction as _getMLPrediction, getRegime } from './mlEngine.js';
import { TV_SCAN_HEADERS } from './lib/tvHeaders.js';

// ============================================
// 1. SUPERSCORE v6.0 PURE CALCULATION ENGINE
// ============================================
function computeServerSuperScore(o) {
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

  // 10% anti-chasing momentum
  score += change > 4 ? -6 : change > 0 ? 2 : change < -4 ? 6 : 4;

  return Math.max(1, Math.min(99, Math.round(score)));
}

// ============================================
// 2. SERVER TOOL DEFINITIONS
// ============================================

export const SERVER_MCP_TOOLS_OPENAI = [
  {
    type: 'function',
    function: {
      name: 'analyze_portfolio_superintelligence',
      description: 'Run deep quantitative audit on ALL user holdings. Returns SuperScore (1-99), exact Dip Buy zones, Hold zones, Profit Booking targets, Trailing Stop Losses, and 3-5 Year Long-Term Wealth projections.',
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
      description: 'Calculate composite SuperScore v6.0 (1-99), RSI/SMA/MACD breakdown, and actionable timing advice for any single stock or crypto.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Stock or Crypto symbol (e.g. RELIANCE, TCS, NVDA, AAPL, BTC).' },
          market: { type: 'string', enum: ['IN', 'US'], description: 'Market: IN or US.' }
        },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_live_quote',
      description: 'Fetch real-time stock/ETF/crypto price, daily change, high, low, volume from NSE, BSE, NYSE, NASDAQ, or CoinDCX.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Stock or Crypto symbol (e.g. RELIANCE, TCS, NVDA, AAPL, BTC, ETH).' },
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
      description: 'Search real-time financial news, quarterly earnings, or breaking events via Tavily.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'News search query (e.g. "Tata Motors quarterly results", "NIFTY all-time high news").' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_market_regime',
      description: 'Get real-time global market regime, India VIX, US VIX, DXY, Gold, Crude Oil, and Fear & Greed narrative.',
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
      description: 'Calculate quantitative Entry, Stop Loss, Target 1, Target 2, and Risk-to-Reward ratio.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Asset symbol.' },
          currentPrice: { type: 'number', description: 'Current market price.' },
          bias: { type: 'string', enum: ['BULLISH', 'BEARISH'], description: 'BULLISH for Buy, BEARISH for Sell.' },
          atrPercent: { type: 'number', description: 'Expected ATR % (default: 2.5).' }
        },
        required: ['symbol', 'currentPrice', 'bias']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_intraday_expert_analysis',
      description: 'Indian Market Intraday Realtime Market Expert MCP tool. Provides pro-trader level intraday analysis: Top 5 high-conviction algo setups or single stock deep scan with exact Entry Zones, Structural Stop Loss, Target 1 (1.6R), Target 2 (2.6R), Trailing SL, 1% Capital Risk Position Sizing (qty per ₹1 Lakh), VWAP & ADX confluence, and 15:10 IST square-off rules.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'NSE/BSE symbol (e.g. RELIANCE, HDFCBANK, TATASTEEL, NIFTY) or "TOP5" for top intraday setups.' },
          market: { type: 'string', enum: ['IN'], description: 'Market exchange (default: IN).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_planner_ai_allocation',
      description: 'Wealth Planner MCP AI Agent tool. Calculates optimal investment distribution for any investment amount across curated Indian Alpha ETFs (MOMENTUM50, SMALLCAP, MID150BEES, JUNIORBEES, SETFNIF50), USA Alpha ETFs (SMH, VOOG, MU, QQQ, VGT), and Crypto (BTC, ETH) based on real-time market prices, SuperScore v6.0, RSI momentum, and 4 AI Agent models (Quantum Alpha, Balanced Parity, Aggressive Momentum, Deep Dip Hunter).',
      parameters: {
        type: 'object',
        properties: {
          investmentAmount: { type: 'number', description: 'Total investment amount in INR (e.g. 25000, 50000, 100000).' },
          agentModel: { type: 'string', enum: ['QUANTUM_ALPHA', 'BALANCED_PARITY', 'AGGRESSIVE_MOMENTUM', 'DEEP_DIP_HUNTER'], description: 'AI Agent model strategy (default: QUANTUM_ALPHA).' },
          investmentType: { type: 'string', enum: ['SIP', 'LUMPSUM'], description: 'Investment mode: SIP or LUMPSUM.' },
          marketFocus: { type: 'string', enum: ['ALL', 'IN', 'US', 'CRYPTO'], description: 'Market selection (default: ALL).' }
        },
        required: ['investmentAmount']
      }
    }
  }
];

export const SERVER_MCP_TOOLS_GEMINI = [
  {
    functionDeclarations: SERVER_MCP_TOOLS_OPENAI.map(t => t.function)
  }
];

// ============================================
// 3. SERVER TOOL EXECUTION HANDLER
// ============================================
export async function executeServerMCPTool(name, args = {}, context = {}) {
  const { tavilyKey = '', portfolio = [], livePrices = {}, usdInrRate = 85.5 } = context;

  try {
    switch (name) {
      // 🌟 1. Deep Portfolio Superintelligence Audit
      case 'analyze_portfolio_superintelligence': {
        if (!portfolio || portfolio.length === 0) {
          return { message: 'Portfolio is currently empty. Add positions to unlock deep holding-by-holding audit.' };
        }

        const holdingsAudit = [];
        let totalScore = 0;

        for (const p of portfolio) {
          const mkt = String(p.market || 'IN').toUpperCase();
          const cacheKey = `${mkt}_${p.symbol}`;
          const pd = livePrices[cacheKey] || {};
          const price = pd.price || p.avgPrice || 1;
          const change = pd.change || 0;
          const rsi = pd.rsi || 50;
          const sma20 = pd.sma20 || (price * 0.98);
          const sma50 = pd.sma50 || (price * 0.95);
          const macd = pd.macd;

          const pnlINR = (price - p.avgPrice) * p.qty * (mkt === 'US' ? usdInrRate : 1);
          const pnlPct = p.avgPrice > 0 ? ((price - p.avgPrice) / p.avgPrice) * 100 : 0;
          const currentValueINR = price * p.qty * (mkt === 'US' ? usdInrRate : 1);

          const superScore = computeServerSuperScore({
            rsi, price, change, sma20, sma50, macd, high: pd.high, low: pd.low
          });
          totalScore += superScore;

          let actionBadge = '🛡️ HOLD & COMPOUND';
          let timingAdvice = 'Current levels healthy hain. Position hold karo, compounding chalne do.';
          const dipBuyZone = `${Math.round(price * 0.94)} - ${Math.round(price * 0.96)}`;

          if (superScore >= 68 || rsi < 35) {
            actionBadge = '💎 STRONG BUY / ACCUMULATE ON DIPS';
            timingAdvice = `Value & accumulation zone active hai. ${dipBuyZone} pe fresh quantity add karna highest return dega.`;
          } else if (superScore <= 35 || rsi > 72) {
            actionBadge = '💰 BOOK PARTIAL PROFIT (TRIM 15-25%)';
            timingAdvice = `Asset overbought hai (RSI ${Math.round(rsi)}). 15-25% profit book karke cash ready rakho.`;
          } else if (pnlPct < -18 && superScore < 45) {
            actionBadge = '⚠️ REVIEW THESIS / STOP LOSS ALERT';
            timingAdvice = `Heavy drawdown (${pnlPct.toFixed(1)}%). Re-evaluate thesis ya trailing stop-loss trigger consider karo.`;
          }

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
            timingAdvice,
            dipBuyZone,
            trailingStopLoss: Math.round(Math.max(p.avgPrice * 0.92, price * 0.90)),
            target1: Math.round(price * 1.10),
            targetLongTerm3Yr: Math.round(price * 1.65)
          });
        }

        const avgScore = Math.round(totalScore / portfolio.length);

        return {
          totalHoldings: portfolio.length,
          overallPortfolioSuperScore: `${avgScore}/99`,
          portfolioHealthVerdict: avgScore >= 65 ? 'EXCELLENT ACCUMULATION 🚀' : avgScore >= 48 ? 'HEALTHY COMPOUNDING 🟢' : 'CAUTION / REBALANCE NEEDED ⚠️',
          holdingsAudit
        };
      }

      // 2. Single Stock SuperScore Analysis
      case 'get_superscore_analysis': {
        const rawSym = String(args.symbol || '').trim().toUpperCase();
        if (!rawSym) return { error: 'symbol is required' };
        const market = (args.market || 'IN').toUpperCase();
        const cacheKey = `${market}_${rawSym}`;
        const pd = livePrices[cacheKey] || {};
        const price = pd.price || 1;
        const change = pd.change || 0;
        const rsi = pd.rsi || 50;
        const sma20 = pd.sma20 || (price * 0.98);
        const sma50 = pd.sma50 || (price * 0.95);
        const macd = pd.macd;

        const superScore = computeServerSuperScore({
          rsi, price, change, sma20, sma50, macd, high: pd.high, low: pd.low
        });

        return {
          symbol: rawSym,
          market,
          currentPrice: price,
          change: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
          superScore: `${superScore}/99`,
          stance: superScore >= 65 ? 'BUY-LEAN / ACCUMULATE' : superScore <= 35 ? 'SELL-LEAN / TRIM' : 'NEUTRAL / HOLD',
          rsi: Math.round(rsi),
          dipBuyZone: `${Math.round(price * 0.94)} - ${Math.round(price * 0.96)}`,
          trailingSL: Math.round(price * 0.91),
          target1: Math.round(price * 1.08),
          targetLongTerm3Yr: Math.round(price * 1.60)
        };
      }

      // 3. Live Quote
      case 'get_live_quote': {
        const rawSym = String(args.symbol || '').trim().toUpperCase();
        if (!rawSym) return { error: 'symbol is required' };
        const market = (args.market || (rawSym.endsWith('.NS') || rawSym === 'RELIANCE' || rawSym === 'NIFTY' ? 'IN' : 'US')).toUpperCase();
        
        if (market === 'IN') {
          // 2026 perf audit (M3): use the injected 3s-micro-cached Groww fetcher
          // (shared with the scanner + SSE watcher + /api/quote) before
          // falling back to a direct upstream call.
          if (typeof context?.fetchGrowwNseQuote === 'function') {
            try {
              const clean = rawSym.replace('.NS', '').replace('.BO', '');
              const q = await context.fetchGrowwNseQuote(clean);
              if (q && q.price > 0) {
                return {
                  symbol: clean,
                  market: 'IN',
                  price: q.price,
                  change: q.change || 0,
                  high: q.high || q.price,
                  low: q.low || q.price,
                  volume: q.volume || 0,
                  currency: 'INR',
                  source: q.source || 'groww-cached',
                };
              }
            } catch { /* probe best-effort */ }
          }
          try {
            const clean = rawSym.replace('.NS', '').replace('.BO', '');
            const growwRes = await fetch(`https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/NSE/segment/CASH/${encodeURIComponent(clean)}/latest`, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(5000)
            });
            if (growwRes.ok) {
              const j = await growwRes.json();
              if (j && j.ltp > 0) {
                return {
                  symbol: clean,
                  market: 'IN',
                  price: j.ltp,
                  change: j.dayChangePerc || 0,
                  high: j.high || j.ltp,
                  low: j.low || j.ltp,
                  volume: j.volume || 0,
                  currency: 'INR',
                  source: 'groww-nse-realtime'
                };
              }
            }
          } catch { /* probe best-effort */ }
        }

        try {
          const ysym = market === 'IN' && !rawSym.includes('.') && !rawSym.startsWith('^') ? `${rawSym}.NS` : rawSym;
          // 2026 perf audit (M3): injected cached fetcher first (shares the
          // 3s micro-cache with everything else on the server).
          if (typeof context?.fetchYahooQuote === 'function') {
            try {
              const q = await context.fetchYahooQuote(ysym);
              if (q && q.price > 0) {
                return {
                  symbol: rawSym,
                  market,
                  price: q.price,
                  change: q.change || 0,
                  high: q.high || q.price,
                  low: q.low || q.price,
                  volume: q.volume || 0,
                  currency: q.currency || (market === 'US' ? 'USD' : 'INR'),
                  source: q.source || 'yahoo-cached',
                };
              }
            } catch { /* probe best-effort */ }
          }
          const yRes = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ysym)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000)
          });
          if (yRes.ok) {
            const j = await yRes.json();
            const q = j?.quoteResponse?.result?.[0];
            if (q && q.regularMarketPrice > 0) {
              return {
                symbol: rawSym,
                market,
                price: q.regularMarketPrice,
                change: q.regularMarketChangePercent || 0,
                high: q.regularMarketDayHigh || q.regularMarketPrice,
                low: q.regularMarketDayLow || q.regularMarketPrice,
                volume: q.regularMarketVolume || 0,
                currency: q.currency || (market === 'US' ? 'USD' : 'INR'),
                source: 'yahoo-realtime'
              };
            }
          }
        } catch { /* probe best-effort */ }

        return { error: `Could not fetch quote for ${rawSym}` };
      }

      // 4. Whale & Block Deals
      case 'get_whale_block_deals': {
        let tavilyDeals = null;
        if (tavilyKey) {
          try {
            const res = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: tavilyKey,
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
          } catch { /* probe best-effort */ }
        }
        return {
          marketBlockDealSummary: tavilyDeals || 'No major block deals flagged in current session.'
        };
      }

      // 5. FII / DII Flow
      case 'get_fii_dii_positioning': {
        if (!tavilyKey) return { error: 'Tavily key required for FII/DII live data' };
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: 'FII DII data today India stock market net buy sell crore latest',
            search_depth: 'basic',
            include_answer: true,
            max_results: 3,
            topic: 'finance'
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return { error: `Tavily returned status ${res.status}` };
        const d = await res.json();
        return {
          summary: d.answer || 'FII/DII data unavailable',
          institutionalBias: (d.answer || '').toLowerCase().includes('net buy') ? 'NET BUYERS (Institutional Inflows 🟢)' : 'NET SELLERS / CAUTIOUS 🔴'
        };
      }

      // 6. Sector Radar — REAL NSE sector index moves via Yahoo, ranked
      // (leaders/laggards), plus the ML regime fed with live index data.
      // Previously returned fabricated constants (getRegime() with no
      // args); now every number comes from a live quote or is omitted.
      case 'get_sector_rotation_radar': {
        const { fetchYahooQuotes } = await import('./ai/data.js');
        const q = await fetchYahooQuotes(['NIFTY', 'BANKNIFTY', 'INDIAVIX', 'IT', 'AUTO', 'PHARMA', 'FMCG', 'METAL', 'REALTY']).catch(() => ({}));
        const sectors = [
          ['IT', q.IT], ['Bank', q.BANKNIFTY], ['Auto', q.AUTO], ['Pharma', q.PHARMA],
          ['FMCG', q.FMCG], ['Metal', q.METAL], ['Realty', q.REALTY],
        ].filter(([, v]) => v && Number.isFinite(v.changePct))
          .map(([name, v]) => ({ sector: name, changePct: Math.round(v.changePct * 100) / 100 }))
          .sort((a, b) => b.changePct - a.changePct);
        if (sectors.length === 0) {
          return { error: 'NSE sector index data unreachable right now — no live sector quotes could be fetched' };
        }
        const asIdx = (v) => v && Number.isFinite(v.changePct) ? { change: v.changePct, price: v.price } : null;
        const mlRegime = getRegime(asIdx(q.NIFTY), asIdx(q.BANKNIFTY), asIdx(q.INDIAVIX), null, null, null);
        return {
          regime: mlRegime?.regime || 'NEUTRAL',
          leaders: sectors.slice(0, 3),
          laggards: sectors.slice(-3).reverse(),
          sectors,
          unavailable: ['IT', 'AUTO', 'PHARMA', 'FMCG', 'METAL', 'REALTY'].filter(s => !sectors.some(x => x.sector === s) && s !== 'Bank'),
          fetchedAt: new Date().toISOString(),
        };
      }

      // 7. Search News
      case 'search_market_news': {
        const query = String(args.query || '').trim();
        if (!query) return { error: 'query is required' };
        if (!tavilyKey) return { error: 'Tavily search API key is not configured' };

        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: `${query} latest financial news`,
            search_depth: 'basic',
            include_answer: true,
            max_results: 4,
            topic: 'finance'
          }),
          signal: AbortSignal.timeout(8000)
        });

        if (!res.ok) return { error: `Tavily returned ${res.status}` };
        const data = await res.json();
        return {
          query,
          aiSummary: data.answer || 'No direct summary found',
          results: (data.results || []).slice(0, 3).map(r => ({
            title: r.title,
            content: (r.content || '').substring(0, 180),
            url: r.url
          }))
        };
      }

      // 8. Market Regime — the ML regime engine fed with LIVE quotes
      // (NIFTY/BANKNIFTY/India VIX/US VIX/DXY/Gold/Crude/BTC). Never
      // fabricated constants: anything unreachable is reported as null.
      case 'get_market_regime': {
        const { fetchYahooQuotes } = await import('./ai/data.js');
        const q = await fetchYahooQuotes(['NIFTY', 'BANKNIFTY', 'INDIAVIX', 'USVIX', 'DXY', 'GOLD', 'CRUDE', 'BTC']).catch(() => ({}));
        if (Object.keys(q).length === 0) {
          return { error: 'Market data unreachable right now — regime inputs unavailable' };
        }
        const asIdx = (v) => v && Number.isFinite(v.changePct) ? { change: v.changePct, price: v.price } : null;
        const mlRegime = getRegime(asIdx(q.NIFTY), asIdx(q.BANKNIFTY), asIdx(q.INDIAVIX), q.USVIX?.price ?? null, q.DXY?.price ?? null, asIdx(q.GOLD));
        const vix = q.INDIAVIX?.price ?? null;
        const usVix = q.USVIX?.price ?? null;
        const r2n = (v) => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
        const parts = [];
        if (q.NIFTY?.changePct != null) parts.push(`NIFTY ${q.NIFTY.changePct >= 0 ? '+' : ''}${r2n(q.NIFTY.changePct)}%`);
        if (vix != null) parts.push(`India VIX ${r2n(vix)}`);
        if (usVix != null) parts.push(`US VIX ${r2n(usVix)}`);
        if (q.DXY?.changePct != null) parts.push(`DXY ${q.DXY.changePct >= 0 ? '+' : ''}${r2n(q.DXY.changePct)}%`);
        if (q.GOLD?.changePct != null) parts.push(`Gold ${q.GOLD.changePct >= 0 ? '+' : ''}${r2n(q.GOLD.changePct)}%`);
        if (q.CRUDE?.changePct != null) parts.push(`Crude ${q.CRUDE.changePct >= 0 ? '+' : ''}${r2n(q.CRUDE.changePct)}%`);
        return {
          regime: mlRegime?.regime || 'NEUTRAL',
          // v20.9.0 (B1/M5): honest labeling — LLM is probability ko real
          // confidence ki tarah quote kar sakta tha. source: heuristic
          // + disclaimer field (deterministic ab — same input same output).
          probability: mlRegime?.probability ?? null,
          probabilitySource: 'heuristic',
          note: 'regime probability is a deterministic heuristic score, NOT a calibrated model estimate',
          sipMultiplier: mlRegime?.sip_multiplier ?? null,
          indiaVix: vix != null ? r2n(vix) : null,
          usVix: usVix != null ? r2n(usVix) : null,
          volatilityLevel: vix != null ? (vix > 20 ? 'HIGH' : vix > 14 ? 'NORMAL' : 'LOW')
            : usVix != null ? (usVix > 22 ? 'HIGH' : usVix > 15 ? 'NORMAL' : 'LOW') : null,
          niftyChangePct: r2n(q.NIFTY?.changePct),
          bankNiftyChangePct: r2n(q.BANKNIFTY?.changePct),
          dxy: r2n(q.DXY?.price),
          gold: r2n(q.GOLD?.price),
          crude: r2n(q.CRUDE?.price),
          btc: r2n(q.BTC?.price),
          narrative: `${mlRegime?.regime || 'NEUTRAL'} regime — ${parts.join(' · ')}`,
          fetchedAt: new Date().toISOString(),
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

        const entry = price;
        const sl = bias === 'BULLISH' ? price - (atr * 1.2) : price + (atr * 1.2);
        const tp1 = bias === 'BULLISH' ? price + (atr * 1.5) : price - (atr * 1.5);
        const tp2 = bias === 'BULLISH' ? price + (atr * 2.5) : price - (atr * 2.5);

        const risk = Math.abs(entry - sl);
        const reward1 = Math.abs(tp1 - entry);

        return {
          symbol,
          bias,
          entryPrice: Math.round(entry * 100) / 100,
          stopLoss: Math.round(sl * 100) / 100,
          target1: Math.round(tp1 * 100) / 100,
          target2: Math.round(tp2 * 100) / 100,
          riskReward: `1:${(reward1 / (risk || 1)).toFixed(2)}`,
          positionSizingRule: 'Risk no more than 1-2% of total trading capital on this setup.'
        };
      }

      // 10. Indian Market Intraday Realtime Market Expert MCP Tool (Pro Desk Level)
      case 'get_intraday_expert_analysis': {
        const rawSym = String(args.symbol || 'TOP5').trim().toUpperCase().replace('.NS', '').replace('.BO', '');
        const isTop5 = !rawSym || rawSym === 'TOP5' || rawSym === 'ALL' || rawSym === 'SCAN';

        const TV_INTRADAY_COLS = [
          'close', 'open', 'high', 'low', 'volume', 'change',
          'EMA10', 'EMA20', 'SMA20', 'SMA50',
          'RSI', 'MACD.macd', 'MACD.signal',
          'ATR', 'VWAP',
          'ADX', 'ADX+DI', 'ADX-DI',
          'relative_volume_10d_calc',
          'Pivot.M.Classic.Middle', 'Pivot.M.Classic.S1', 'Pivot.M.Classic.R1',
          'Recommend.All', 'last',
        ];

        const pf = (v) => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : null;

        if (isTop5) {
          // Top Liquid Scan Universe
          const universe = [
            'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'ITC', 'SBIN', 'BHARTIARTL',
            'KOTAKBANK', 'LT', 'AXISBANK', 'TATAMOTORS', 'SUNPHARMA', 'MARUTI', 'TITAN',
            'BAJFINANCE', 'TATASTEEL', 'ASIANPAINT', 'M&M', 'NTPC', 'POWERGRID', 'HCLTECH',
            'ONGC', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'JIOFIN', 'VEDL', 'ZOMATO', 'TRENT'
          ];
          const tickers = universe.map(s => `NSE:${s}`);
          let tvItems = [];
          try {
            const res = await fetch(`https://scanner.tradingview.com/india/scan?t=${Date.now()}`, {
              method: 'POST',
              headers: TV_SCAN_HEADERS,
              body: JSON.stringify({
                symbols: { tickers },
                columns: TV_INTRADAY_COLS,
              }),
              signal: AbortSignal.timeout(8000),
            });
            if (res.ok) {
              const data = await res.json();
              tvItems = data?.data || [];
            }
          } catch { /* parse skip */ }

          const setups = [];
          for (const item of tvItems) {
            if (!item.d) continue;
            const sym = item.s.replace('NSE:', '').replace('BSE:', '');
            const d = item.d;
            const ltp = pf(d[23]) || pf(d[0]) || 0;
            if (!ltp || ltp <= 0) continue;
            const _open = pf(d[1]) || ltp;
            const high = pf(d[2]) || ltp;
            const low = pf(d[3]) || ltp;
            const change = pf(d[5]) || 0;
            const ema10 = pf(d[6]) ?? ltp;
            const ema20 = pf(d[7]) ?? ltp;
            const rsi = pf(d[10]) ?? 50;
            const _macd = pf(d[11]);
            const _macdSig = pf(d[12]);
            const atr = pf(d[13]) || (ltp * 0.02);
            const vwap = pf(d[14]) || ltp;
            const adx = pf(d[15]) ?? 20;
            const relVol = pf(d[18]) ?? 1;

            const isLong = (ltp > ema10 && ema10 > ema20 && ltp > vwap) || (change > 0 && rsi >= 50);
            const dir = isLong ? 'LONG' : 'SHORT';

            const entry = ltp;
            const entryZoneLow = +(entry - 0.25 * atr).toFixed(2);
            const entryZoneHigh = +(entry + 0.10 * atr).toFixed(2);
            const atrStop = isLong ? entry - 1.1 * atr : entry + 1.1 * atr;
            const swingStop = isLong ? (low > 0 ? low - 0.15 * atr : atrStop) : (high > 0 ? high + 0.15 * atr : atrStop);
            let stopLoss = isLong ? Math.max(atrStop, swingStop) : Math.min(atrStop, swingStop);
            if (isLong) {
              stopLoss = Math.min(stopLoss, entry - 0.7 * atr);
              stopLoss = Math.max(stopLoss, entry - 1.8 * atr);
            } else {
              stopLoss = Math.max(stopLoss, entry + 0.7 * atr);
              stopLoss = Math.min(stopLoss, entry + 1.8 * atr);
            }
            stopLoss = +stopLoss.toFixed(2);
            const risk = Math.abs(entry - stopLoss);
            const target1 = +(isLong ? entry + 1.6 * risk : entry - 1.6 * risk).toFixed(2);
            const target2 = +(isLong ? entry + 2.6 * risk : entry - 2.6 * risk).toFixed(2);
            const trailingSL = +(isLong ? entry - 0.8 * atr : entry + 0.8 * atr).toFixed(2);
            const qtyRisk = risk > 0 ? Math.floor(1000 / risk) : 0;
            const qtyCap = Math.floor(25000 / entry);
            const qtyPerLakh = Math.max(0, Math.min(qtyRisk, qtyCap));

            let score = 50;
            if (dir === 'LONG' ? ltp > vwap : ltp < vwap) score += 15;
            if (dir === 'LONG' ? ema10 > ema20 : ema10 < ema20) score += 15;
            if (adx >= 25) score += 10;
            if (relVol >= 1.3) score += 10;
            if (dir === 'LONG' ? (rsi >= 52 && rsi <= 68) : (rsi >= 32 && rsi <= 48)) score += 10;

            setups.push({
              symbol: sym,
              direction: dir,
              confidenceScore: `${Math.min(98, score)}/100`,
              ltp: +ltp.toFixed(2),
              change: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
              entryTrigger: +entry.toFixed(2),
              entryZone: `${entryZoneLow} - ${entryZoneHigh}`,
              stopLoss,
              target1,
              target2,
              trailingSL,
              trailRuleAfterT1: `Move SL to Breakeven (${entry}) once Target 1 is hit`,
              rrRatio: `1:${risk > 0 ? (Math.abs(target1 - entry) / risk).toFixed(2) : '1.60'}`,
              qtyPer1LakhCapital: `${qtyPerLakh} shares (Strict 1% max capital risk)`,
              trendStrength: adx >= 28 ? 'STRONG TREND' : adx >= 20 ? 'BUILDING' : 'RANGE',
              vwap: +vwap.toFixed(2),
              rsi: Math.round(rsi),
              adx: Math.round(adx),
              volumeRatio: `${relVol.toFixed(1)}x`,
              squareOffRule: 'Strict 15:10 IST intraday square-off. No fresh trades after 15:00 IST.'
            });
          }

          setups.sort((a, b) => parseInt(b.confidenceScore) - parseInt(a.confidenceScore));

          return {
            expertEngine: 'NSE/BSE Intraday Realtime Market Expert MCP Engine v2.0',
            scanType: 'Top High-Conviction Setups',
            marketContext: 'Real-time TradingView + Groww Live Data Pipeline',
            riskDiscipline: '1% Capital Risk Model per ₹1,00,000 portfolio • Structural ATR & Swing stops',
            topSetups: setups.slice(0, 5)
          };
        }

        // Single Symbol Deep Scan
        let tvData = null;
        try {
          const res = await fetch(`https://scanner.tradingview.com/india/scan?t=${Date.now()}`, {
            method: 'POST',
            headers: TV_SCAN_HEADERS,
            body: JSON.stringify({
              symbols: { tickers: [`NSE:${rawSym}`, `BSE:${rawSym}`] },
              columns: TV_INTRADAY_COLS,
            }),
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = await res.json();
            if (data?.data?.[0]?.d) tvData = data.data[0].d;
          }
        } catch { /* parse skip */ }

        let growwQuote = null;
        try {
          const gres = await fetch(`https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/NSE/segment/CASH/${encodeURIComponent(rawSym)}/latest`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000)
          });
          if (gres.ok) {
            const gj = await gres.json();
            if (gj?.ltp > 0) growwQuote = gj;
          }
        } catch { /* parse skip */ }

        const ltp = growwQuote?.ltp || pf(tvData?.[23]) || pf(tvData?.[0]) || 0;
        if (!ltp || ltp <= 0) return { error: `Real-time intraday data unavailable for ${rawSym}. Verify symbol.` };

        const _open = pf(tvData?.[1]) || (growwQuote?.ltp && growwQuote?.dayChange != null ? (growwQuote.ltp - growwQuote.dayChange) : ltp);
        const high = Math.max(growwQuote?.high || 0, pf(tvData?.[2]) || 0) || ltp;
        const low = Math.min(growwQuote?.low || Infinity, pf(tvData?.[3]) || Infinity);
        const effectiveLow = isFinite(low) ? low : ltp;
        const change = growwQuote?.dayChangePerc ?? pf(tvData?.[5]) ?? 0;
        const ema10 = pf(tvData?.[6]) ?? ltp;
        const ema20 = pf(tvData?.[7]) ?? ltp;
        const rsi = pf(tvData?.[10]) ?? 50;
        const _macd = pf(tvData?.[11]);
        const _macdSig = pf(tvData?.[12]);
        const atr = pf(tvData?.[13]) || (ltp * 0.02);
        const vwap = pf(tvData?.[14]) || ltp;
        const adx = pf(tvData?.[15]) ?? 20;
        const relVol = pf(tvData?.[18]) ?? 1;

        const isLong = (ltp > ema10 && ema10 > ema20 && ltp > vwap) || (change > 0 && rsi >= 50);
        const dir = isLong ? 'LONG' : 'SHORT';
        const entry = ltp;
        const entryZoneLow = +(entry - 0.25 * atr).toFixed(2);
        const entryZoneHigh = +(entry + 0.10 * atr).toFixed(2);
        const atrStop = isLong ? entry - 1.1 * atr : entry + 1.1 * atr;
        const swingStop = isLong ? (effectiveLow > 0 ? effectiveLow - 0.15 * atr : atrStop) : (high > 0 ? high + 0.15 * atr : atrStop);
        let stopLoss = isLong ? Math.max(atrStop, swingStop) : Math.min(atrStop, swingStop);
        if (isLong) {
          stopLoss = Math.min(stopLoss, entry - 0.7 * atr);
          stopLoss = Math.max(stopLoss, entry - 1.8 * atr);
        } else {
          stopLoss = Math.max(stopLoss, entry + 0.7 * atr);
          stopLoss = Math.min(stopLoss, entry + 1.8 * atr);
        }
        stopLoss = +stopLoss.toFixed(2);
        const risk = Math.abs(entry - stopLoss);
        const target1 = +(isLong ? entry + 1.6 * risk : entry - 1.6 * risk).toFixed(2);
        const target2 = +(isLong ? entry + 2.6 * risk : entry - 2.6 * risk).toFixed(2);
        const trailingSL = +(isLong ? entry - 0.8 * atr : entry + 0.8 * atr).toFixed(2);
        const qtyRisk = risk > 0 ? Math.floor(1000 / risk) : 0;
        const qtyCap = Math.floor(25000 / entry);
        const qtyPerLakh = Math.max(0, Math.min(qtyRisk, qtyCap));

        return {
          symbol: rawSym,
          market: 'NSE/BSE (India)',
          expertVerdict: `${dir} PRO-DESK SETUP`,
          livePrice: +ltp.toFixed(2),
          dayChange: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
          tradePlan: {
            direction: dir,
            entryTriggerPrice: +entry.toFixed(2),
            entryZoneRange: `${entryZoneLow} - ${entryZoneHigh}`,
            structuralStopLoss: stopLoss,
            target1_1_6R: target1,
            target2_2_6R: target2,
            trailingStopLoss: trailingSL,
            breakevenDisciplineRule: `Once price reaches Target 1 (${target1}), book 50% quantity and shift SL to Entry (${entry}).`
          },
          positionSizingRule: {
            capitalBasis: '₹1,00,000 trading portfolio',
            recommendedQuantity: `${qtyPerLakh} shares`,
            maxRiskPerTrade: '₹1,000 (Strict 1% maximum capital risk rule)',
            capitalAllocated: `₹${(qtyPerLakh * entry).toLocaleString('en-IN')}`
          },
          confluenceIndicators: {
            vwapLevel: +vwap.toFixed(2),
            priceVsVwap: `${((ltp - vwap) / vwap * 100) >= 0 ? '+' : ''}${((ltp - vwap) / vwap * 100).toFixed(2)}%`,
            rsi14: Math.round(rsi),
            adxTrendStrength: `${Math.round(adx)} (${adx >= 28 ? 'STRONG TREND ⚡' : adx >= 20 ? 'MODERATE TREND 🟢' : 'CHOPPY / WEAK ⚠️'})`,
            relativeVolume: `${relVol.toFixed(1)}x 10-day average`,
            ema10: +ema10.toFixed(2),
            ema20: +ema20.toFixed(2)
          },
          executionRules: {
            squareOffDeadline: '15:10 IST strictly — do not carry intraday positions overnight.',
            entryCutoff: '15:00 IST — no fresh entries permitted after 3:00 PM.',
            slippageBuffer: 'Limit orders preferred inside the entry zone.'
          }
        };
      }

      // 11. Wealth Planner MCP AI Agent Allocation Tool
      case 'get_planner_ai_allocation': {
        const invAmount = parseFloat(args.investmentAmount) || 25000;
        const agentModel = String(args.agentModel || 'QUANTUM_ALPHA').toUpperCase();
        const invType = String(args.investmentType || 'SIP').toUpperCase();
        const marketFocus = String(args.marketFocus || 'ALL').toUpperCase();

        const assetList = [
          // India
          { sym: 'MOMENTUM50', name: 'Motilal Oswal Nifty 500 Momentum 50', mkt: 'IN', baseWeight: 0.28, cagr: 22.5 },
          { sym: 'SMALLCAP', name: 'Nippon India Nifty Smallcap 250', mkt: 'IN', baseWeight: 0.22, cagr: 24.5 },
          { sym: 'MID150BEES', name: 'Nippon India Nifty Midcap 150', mkt: 'IN', baseWeight: 0.20, cagr: 21.0 },
          { sym: 'JUNIORBEES', name: 'Nippon India ETF Junior BeES', mkt: 'IN', baseWeight: 0.18, cagr: 18.5 },
          { sym: 'SETFNIF50', name: 'SBI ETF Nifty 50', mkt: 'IN', baseWeight: 0.12, cagr: 14.0 },
          // USA
          { sym: 'SMH', name: 'VanEck Semiconductor ETF', mkt: 'US', baseWeight: 0.30, cagr: 28.5 },
          { sym: 'VOOG', name: 'Vanguard S&P 500 Growth ETF', mkt: 'US', baseWeight: 0.25, cagr: 18.5 },
          { sym: 'MU', name: 'Micron Technology Inc', mkt: 'US', baseWeight: 0.15, cagr: 24.0 },
          { sym: 'QQQ', name: 'Invesco Nasdaq-100 ETF', mkt: 'US', baseWeight: 0.10, cagr: 18.0 },
          { sym: 'VGT', name: 'Vanguard Information Technology ETF', mkt: 'US', baseWeight: 0.20, cagr: 21.5 },
          // Crypto
          { sym: 'BTC', name: 'Bitcoin (Digital Gold)', mkt: 'IN', baseWeight: 0.65, cagr: 50.0 },
          { sym: 'ETH', name: 'Ethereum (Web3 Ecosystem)', mkt: 'IN', baseWeight: 0.35, cagr: 42.0 }
        ];

        let filtered = assetList;
        if (marketFocus === 'IN') filtered = assetList.filter(a => a.mkt === 'IN' && !['BTC', 'ETH'].includes(a.sym));
        else if (marketFocus === 'US') filtered = assetList.filter(a => a.mkt === 'US');
        else if (marketFocus === 'CRYPTO') filtered = assetList.filter(a => ['BTC', 'ETH'].includes(a.sym));

        const computed = [];
        for (const spec of filtered) {
          const key = `${spec.mkt}_${spec.sym}`;
          const altKey = `${spec.mkt}_${spec.sym}.NS`;
          const pd = livePrices[key] || livePrices[altKey] || {};
          let price = pd.price || 0;
          // v20.9.1 [M]: stale hardcoded fallback prices ab LABELED hain —
          // pehle months-purane constants se stopLoss/target/units compute
          // hote the aur LLM unhe LIVE prices ki tarah quote karta tha
          // (repo ka apna "never invent a price" discipline — PaperPort
          // v20.8.4 / ml predict v11.4 fixes — is tool pe lacuna tha).
          let priceFallbackUsed = false;
          if (!price || price <= 0) {
            priceFallbackUsed = true;
            if (spec.sym === 'MOMENTUM50') price = 68.5;
            else if (spec.sym === 'SMALLCAP') price = 185.0;
            else if (spec.sym === 'MID150BEES') price = 22.4;
            else if (spec.sym === 'JUNIORBEES') price = 685.0;
            else if (spec.sym === 'SETFNIF50') price = 265.0;
            else if (spec.sym === 'SMH') price = 280.0;
            else if (spec.sym === 'VOOG') price = 365.0;
            else if (spec.sym === 'MU') price = 125.0;
            else if (spec.sym === 'QQQ') price = 485.0;
            else if (spec.sym === 'VGT') price = 590.0;
            else if (spec.sym === 'BTC') price = 7800000;
            else if (spec.sym === 'ETH') price = 280000;
          }
          const rsi = pd.rsi || 50;
          const superScore = computeServerSuperScore({ rsi, price, change: pd.change || 0, sma20: pd.sma20, sma50: pd.sma50, macd: pd.macd });

          let multiplier = 1.0;
          if (agentModel === 'QUANTUM_ALPHA') {
            multiplier = superScore >= 68 ? 1.4 : superScore <= 35 ? 0.6 : 1.0;
          } else if (agentModel === 'AGGRESSIVE_MOMENTUM') {
            multiplier = ['MOMENTUM50', 'SMH', 'MU', 'VGT'].includes(spec.sym) ? 1.5 : 0.8;
          } else if (agentModel === 'DEEP_DIP_HUNTER') {
            multiplier = rsi < 38 ? 1.7 : rsi > 65 ? 0.5 : 0.9;
          }

          const dynamicWeight = spec.baseWeight * multiplier;
          computed.push({
            symbol: spec.sym,
            name: spec.name,
            market: spec.mkt,
            currentPrice: price,
            // v20.9.1 [M]: fallback-priced rows EXPLICITLY tagged —
            // consumer (LLM/user) ko pata ho ki ye stale-approx hai.
            ...(priceFallbackUsed ? { priceSource: 'stale-fallback (live price unavailable — verify current price before acting)' } : {}),
            currency: spec.mkt === 'IN' ? 'INR' : 'USD',
            superScore: `${superScore}/99`,
            rsi: Math.round(rsi),
            dynamicWeight,
            signal: superScore >= 68 ? '💎 STRONG BUY' : superScore >= 52 ? '🟢 ACCUMULATE' : '🟡 WAIT / DIP',
            stopLoss: Math.round(price * 0.91),
            target1: Math.round(price * 1.10),
            target3Yr: Math.round(price * Math.pow(1 + spec.cagr / 100, 3))
          });
        }

        const totalWeight = computed.reduce((s, a) => s + a.dynamicWeight, 0) || 1;
        const allocations = computed.map(a => {
          const allocPct = a.dynamicWeight / totalWeight;
          const allocAmountINR = Math.round(invAmount * allocPct);
          const allocNative = a.market === 'US' ? Math.round(allocAmountINR / usdInrRate) : allocAmountINR;
          const targetUnits = a.market === 'US'
            ? +(allocNative / a.currentPrice).toFixed(2)
            : ['BTC', 'ETH'].includes(a.symbol)
            ? +(allocAmountINR / a.currentPrice).toFixed(6)
            : Math.floor(allocAmountINR / a.currentPrice);

          return {
            symbol: a.symbol,
            name: a.name,
            market: a.market,
            currentPrice: a.currentPrice,
            currency: a.currency,
            superScore: a.superScore,
            rsi: a.rsi,
            signal: a.signal,
            allocationPercentage: `${(allocPct * 100).toFixed(1)}%`,
            allocatedAmountINR: `₹${allocAmountINR.toLocaleString('en-IN')}`,
            allocatedNative: a.market === 'US' ? `$${allocNative.toLocaleString('en-US')}` : `₹${allocAmountINR.toLocaleString('en-IN')}`,
            recommendedUnits: `${targetUnits} ${a.market === 'US' ? 'shares' : 'units'}`,
            stopLoss: a.stopLoss,
            target1: a.target1,
            target3Yr: a.target3Yr
          };
        });

        allocations.sort((a, b) => parseInt(b.allocatedAmountINR.replace(/[^0-9]/g, '')) - parseInt(a.allocatedAmountINR.replace(/[^0-9]/g, '')));

        return {
          agentEngine: `SmartAI MCP Planner Engine (${agentModel})`,
          investmentAmount: `₹${invAmount.toLocaleString('en-IN')}`,
          investmentType: invType,
          marketFocus,
          // v20.9.1 [M]: koi bhi row fallback-priced thi to top-level warning.
          ...(computed.some((a) => a.priceSource) ? { priceWarning: 'Kuch symbols ke live prices unavailable the — un rows me priceSource:stale-fallback tagged hai (levels approximate, verify karo).' } : {}),
          totalAllocatedAssets: allocations.length,
          executionAdvice: 'Deploy into designated entry zones with structural stop losses.',
          allocations
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: `Tool execution failed: ${err.message}` };
  }
}
