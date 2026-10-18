// ============================================================
// server/mcp/agents/tradingcentral.js — v11.0 PHASE 1
// ------------------------------------------------------------
// TradingCentral — real-time news sentiment / buzzing scores /
// industry sentiment (paid MCP; flag OFF by having NO key). The
// adapter speaks their documented REST surface; without a key the
// agent is simply ABSENT from routing (honest, never fake data).
// Capabilities:
//   news.sentiment   aggregated market/symbol news sentiment
//   news.buzzing     buzzing scores + industry sentiment timeseries
// ============================================================
import { registerAgent, fetchJSON } from './registry.js';

const BASE = 'https://api.tradingcentral.com';
const key = () => String(process.env.TRADINGCENTRAL_API_KEY || '').trim();

registerAgent({
  id: 'tradingcentral',
  name: 'TradingCentral News-Sentiment MCP',
  kind: 'rest',
  envKey: 'TRADINGCENTRAL_API_KEY',
  authRequired: true,
  priority: 40,
  budget: { perDay: 0, perMinute: 5 },
  note: 'Real-time news sentiment + buzzing scores (paid vendor — absent without key, never faked)',
  caps: {
    'news.sentiment': {
      tier: 'warm', cost: 1,
      fn: async ({ symbols }) => {
        const syms = (symbols || []).map(s => String(s || '').toUpperCase()).filter(Boolean);
        if (syms.length === 0) return null;
        // v11.0.1: encode each symbol — raw join used to inject query params
        const j = await fetchJSON(`${BASE}/v1/news/sentiment?symbols=${syms.slice(0, 5).map(encodeURIComponent).join(',')}`, {
          headers: { Authorization: `Bearer ${key()}` },
        });
        if (!j || !Array.isArray(j.items)) return null;
        return {
          items: j.items.slice(0, 12).map(i => ({
            symbol: i.symbol || null,
            sentiment: i.sentiment || null,   // bull/bear/neutral read
            score: Number(i.score) || null,
            headline: i.headline || null,
          })),
          source: 'tradingcentral',
        };
      },
    },
    'news.buzzing': {
      tier: 'warm', cost: 1,
      fn: async ({ symbols }) => {
        const syms = (symbols || []).map(s => String(s || '').toUpperCase()).filter(Boolean);
        const j = await fetchJSON(`${BASE}/v1/news/buzzing${syms.length ? `?symbols=${syms.slice(0, 5).map(encodeURIComponent).join(',')}` : ''}`, {
          headers: { Authorization: `Bearer ${key()}` },
        });
        if (!j || !Array.isArray(j.items)) return null;
        return {
          items: j.items.slice(0, 12).map(i => ({
            symbol: i.symbol || null,
            buzz: Number(i.buzz) || null,
            changePct: Number(i.change) || null,
          })),
          source: 'tradingcentral',
        };
      },
    },
  },
});

export default 'tradingcentral';
