// ============================================================
// server/mcp/agents/massive.js — v11.0 PHASE 1 · fixed v11.8.1
// ------------------------------------------------------------
// Massive — formerly Polygon.io. The v11.6 plan's api.massive.dev
// domain does NOT resolve (live-checked 2026-09-18: DNS failure);
// the real REST surface still serves at api.polygon.io with Bearer
// auth. MASSIVE_API_BASE overrides without a redeploy if Massive
// migrates domains again. Free "Basic" tier: 5 req/min, 2y history,
// EOD + reference data.
// Capabilities:
//   fundamentals.profile    /v3/reference/tickers/{sym} — company
//                           metadata (name/sector/SIC). The free tier
//                           serves no P/E/margin, so those stay
//                           honestly null (the mesh seat FundaProPlus
//                           cross-reads AlphaVantage for the numbers).
// ============================================================
import { registerAgent, fetchJSON } from './registry.js';

const BASE = String(process.env.MASSIVE_API_BASE || 'https://api.polygon.io').replace(/\/+$/, '');
const key = () => String(process.env.MASSIVE_API_KEY || '').trim();

const normSym = (s) => String(s || '').toUpperCase();

registerAgent({
  id: 'massive',
  name: 'Massive Market Data MCP',
  kind: 'rest',
  envKey: 'MASSIVE_API_KEY',
  authRequired: true,
  priority: 46,
  budget: { perDay: 30, perMinute: 5 },
  note: 'Polygon.io/ Massive reference data — fundamentals cross-check (free Basic tier, Bearer auth)',
  caps: {
    'fundamentals.profile': {
      tier: 'cold', cost: 1,
      fn: async ({ symbols }) => {
        const sym = normSym(Array.isArray(symbols) ? symbols[0] : symbols);
        if (!sym) return null;
        // v11.0.1 guard kept: encode the PATH segment — raw '/'-bearing
        // tickers (BRK/A style) used to traverse to other endpoints
        const j = await fetchJSON(`${BASE}/v3/reference/tickers/${encodeURIComponent(sym)}`, { headers: { Authorization: `Bearer ${key()}` } });
        const r = j?.results;
        if (!r || (!r.ticker && !r.symbol)) return null;
        return {
          symbol: r.ticker || r.symbol || sym,
          name: r.name || null,
          sector: r.sic_description || r.sector || null,
          // v11.8.1: the free Basic tier serves reference metadata only —
          // valuation ratios stay honestly null instead of guessed:
          marketCap: null,
          peRatio: null,
          dividendYield: null,
          beta: null,
          source: 'massive',
        };
      },
    },
  },
});

export default 'massive';
