// ============================================================
// server/mcp/agents/tradingview.js — v11.0 PHASE 1
// ------------------------------------------------------------
// TradingView — MCP-style wrap of the repo's OWN battle-proven TV
// scanner paths (data.js). ZERO duplicate fetch logic: the wrap
// calls the same functions the desks already call, so the mesh adds
// capability routing + health + budget semantics on top without a
// second upstream stream.
// Capabilities:
//   stocks.tvscan   fetchTVIndiaBatch (India scanner batch)
//   crypto.tvscan   fetchTVCryptoBatch
//   quotes.yahoo    fetchYahooQuotes (fallback quotes)
// ============================================================
import { registerAgent } from './registry.js';
import { fetchTVIndiaBatch, fetchTVCryptoBatch, fetchYahooQuotes } from '../../ai/data.js';

registerAgent({
  id: 'tradingview',
  name: 'TradingView Scanner Mesh',
  kind: 'wrap',
  envKey: '',
  authRequired: false,
  priority: 5, // the repo's own live-verified paths win first
  budget: { perDay: 0, perMinute: 15 },
  note: 'TV India + crypto scanner batches (the existing live-verified desk feed, MCP-ified)',
  caps: {
    'stocks.tvscan': {
      tier: 'hot', cost: 1,
      fn: async ({ symbols }) => {
        const syms = (symbols || []).map(s => String(s || '').toUpperCase()).filter(Boolean);
        if (syms.length === 0) return null;
        const rows = await fetchTVIndiaBatch(syms);
        if (!rows || typeof rows !== 'object' || Object.keys(rows).length === 0) return null;
        return { rows, count: Object.keys(rows).length, source: 'tradingview-india' };
      },
    },
    'crypto.tvscan': {
      tier: 'hot', cost: 1,
      fn: async ({ symbols }) => {
        const syms = (symbols || []).map(s => String(s || '').toUpperCase()).filter(Boolean);
        if (syms.length === 0) return null;
        const rows = await fetchTVCryptoBatch(syms);
        if (!rows || typeof rows !== 'object' || Object.keys(rows).length === 0) return null;
        return { rows, count: Object.keys(rows).length, source: 'tradingview-crypto' };
      },
    },
    'quotes.yahoo': {
      tier: 'hot', cost: 1,
      fn: async ({ keys }) => {
        const ks = (keys || []).map(k => String(k || '')).filter(Boolean);
        if (ks.length === 0) return null;
        const rows = await fetchYahooQuotes(ks);
        if (!rows || typeof rows !== 'object' || Object.keys(rows).length === 0) return null;
        return { rows, count: Object.keys(rows).length, source: 'yahoo' };
      },
    },
  },
});

export default 'tradingview';
