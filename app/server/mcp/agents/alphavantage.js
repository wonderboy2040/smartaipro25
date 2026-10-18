// ============================================================
// server/mcp/agents/alphavantage.js — v11.0 PHASE 1
// ------------------------------------------------------------
// Alpha Vantage — official MCP server exists; this adapter speaks
// the REST API (the MCP remote endpoint is gated behind the same
// key, and REST keeps the mesh hermetic + testable). Capabilities:
//   stocks.quote      GLOBAL_QUOTE        (world tickers)
//   stocks.fundamentals  OVERVIEW         (cold tier)
//   forex.rate        CURRENCY_EXCHANGE_RATE
//   crypto.rate       CURRENCY_EXCHANGE_RATE (digital)
// Free tier: 25 req/day → our budget 20/day (token bucket).
// ============================================================
import { registerAgent, fetchJSON } from './registry.js';

const BASE = 'https://www.alphavantage.co/query';
const key = () => String(process.env.ALPHAVANTAGE_API_KEY || '').trim();

function q(symbol) {
  return String(symbol || '').toUpperCase();
}

registerAgent({
  id: 'alphavantage',
  name: 'Alpha Vantage MCP',
  kind: 'rest',
  envKey: 'ALPHAVANTAGE_API_KEY',
  authRequired: true,
  priority: 30,
  budget: { perDay: 20, perMinute: 5 },
  note: 'World stocks/forex/crypto quotes + fundamentals (official MCP vendor, REST transport)',
  caps: {
    'stocks.quote': {
      tier: 'warm', cost: 1,
      fn: async ({ symbols }) => {
        const sym = q(Array.isArray(symbols) ? symbols[0] : symbols);
        if (!sym) return null;
        const j = await fetchJSON(`${BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${key()}`);
        const g = j?.['Global Quote'] || {};
        const price = Number(g['05. price']);
        if (!Number.isFinite(price) || price <= 0) return null;
        return {
          symbol: sym,
          price,
          changePct: Number(String(g['10. change percent'] || '').replace('%', '')) || null,
          volume: Number(g['06. volume']) || null,
          source: 'alphavantage',
        };
      },
    },
    'stocks.fundamentals': {
      tier: 'cold', cost: 1,
      fn: async ({ symbols }) => {
        const sym = q(Array.isArray(symbols) ? symbols[0] : symbols);
        if (!sym) return null;
        const j = await fetchJSON(`${BASE}?function=OVERVIEW&symbol=${encodeURIComponent(sym)}&apikey=${key()}`);
        if (!j || !j.Symbol || !j.MarketCapitalization) return null;
        return {
          symbol: j.Symbol,
          name: j.Name || null,
          sector: j.Sector || null,
          industry: j.Industry || null,
          marketCap: Number(j.MarketCapitalization) || null,
          peRatio: Number(j.PERatio) || null,
          forwardPE: Number(j.ForwardPE) || null,
          dividendYield: Number(j.DividendYield) || null,
          beta: Number(j.Beta) || null,
          profitMargin: Number(j.ProfitMargin) || null,
          source: 'alphavantage',
        };
      },
    },
    'forex.rate': {
      tier: 'warm', cost: 1,
      fn: async ({ pairs }) => {
        const p = String(Array.isArray(pairs) ? pairs[0] : pairs || '').toUpperCase();
        const from = p.slice(0, 3), to = p.slice(3, 6);
        if (!/^[A-Z]{6}$/.test(p)) return null;
        const j = await fetchJSON(`${BASE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${key()}`);
        const rate = Number(j?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']);
        if (!Number.isFinite(rate) || rate <= 0) return null;
        return { pair: p, rate, source: 'alphavantage' };
      },
    },
    'crypto.rate': {
      tier: 'warm', cost: 1,
      fn: async ({ symbols }) => {
        const s = String(Array.isArray(symbols) ? symbols[0] : symbols || '').toUpperCase();
        if (!s) return null;
        // v11.0.1: encode — a raw '&' in the symbol used to inject query params
        const j = await fetchJSON(`${BASE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${encodeURIComponent(s)}&to_currency=USD&apikey=${key()}`);
        const rate = Number(j?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']);
        if (!Number.isFinite(rate) || rate <= 0) return null;
        return { symbol: s, usdRate: rate, source: 'alphavantage' };
      },
    },
  },
});

export default 'alphavantage';
