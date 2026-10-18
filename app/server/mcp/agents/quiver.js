// ============================================================
// server/mcp/agents/quiver.js — v11.0 PHASE 1
// ------------------------------------------------------------
// Quiver Quantitative — US alt-data (Congress trades, insider
// activity, government contracts, retail sentiment). REST adapter
// with the same agent-card contract. Free tier ~limited → daily
// budget 50.
// Capabilities:
//   altdata.congress   live congressional trades
//   altdata.insider    recent insider transactions
// ============================================================
import { registerAgent, fetchJSON } from './registry.js';

const BASE = 'https://api.quiverquant.com/beta';
const key = () => String(process.env.QUIVER_API_KEY || '').trim();

function authHeaders() { return { Authorization: `Bearer ${key()}` }; }
const normSym = (s) => String(s || '').toUpperCase();

registerAgent({
  id: 'quiver',
  name: 'Quiver Quantitative Alt-Data',
  kind: 'rest',
  envKey: 'QUIVER_API_KEY',
  authRequired: true,
  priority: 45,
  budget: { perDay: 50, perMinute: 5 },
  note: 'US alt-data: Congress trades, insider transactions, gov contracts — smart-money footprints',
  caps: {
    'altdata.congress': {
      tier: 'cold', cost: 1,
      fn: async ({ symbols }) => {
        const syms = (symbols || []).map(normSym).filter(Boolean);
        // v11.0.1: encode the ticker — raw '&' used to inject query params
        const path = syms.length > 0 ? `/live/congresstrading?ticker=${encodeURIComponent(syms[0])}` : '/live/congresstrading';
        const j = await fetchJSON(`${BASE}${path}`, { headers: authHeaders() });
        if (!Array.isArray(j)) return null;
        return {
          trades: j.slice(0, 10).map(t => ({
            ticker: normSym(t.ticker),
            senator: t.senator || t.representative || null,
            transaction: t.transaction || null,   // Buy/Sell
            amountRange: t.amount || null,
            daysAgo: t.daysAgo != null ? Math.round(Number(t.daysAgo)) : null,
          })),
          source: 'quiver',
        };
      },
    },
    'altdata.insider': {
      tier: 'cold', cost: 1,
      fn: async ({ symbols }) => {
        const syms = (symbols || []).map(normSym).filter(Boolean);
        if (syms.length === 0) return null;
        const j = await fetchJSON(`${BASE}/live/insidertrading?ticker=${encodeURIComponent(syms[0])}`, { headers: authHeaders() });
        if (!Array.isArray(j)) return null;
        return {
          transactions: j.slice(0, 10).map(t => ({
            ticker: normSym(t.ticker),
            name: t.name || null,
            transaction: t.transaction || null,
            shares: Number(t.shares) || null,
            valueUsd: Number(t.value) || null,
            daysAgo: t.daysAgo != null ? Math.round(Number(t.daysAgo)) : null,
          })),
          source: 'quiver',
        };
      },
    },
  },
});

export default 'quiver';
