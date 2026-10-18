// ============================================================
// server/mcp/agents/alpaca.js — v11.0 PHASE 1
// ------------------------------------------------------------
// Alpaca — US market data + news (free paper-tier key). The plan's
// "Alpaca-style" 10th mesh seat: IEX real-time quotes + market news,
// same agent-card contract. Absent without key (honest, never fake).
// Capabilities:
//   stocks.usquote   /v2/stocks/{sym}/quotes/latest (IEX feed)
//   news.usnews      /v1beta1/news (market + symbol news)
// ============================================================
import { registerAgent, fetchJSON } from './registry.js';

const DATA_BASE = 'https://data.alpaca.markets';
const key = () => String(process.env.ALPACA_API_KEY || '').trim();
const secret = () => String(process.env.ALPACA_API_SECRET || '').trim();
const authed = () => key() && secret();

function headers() {
  return { 'APCA-API-KEY-ID': key(), 'APCA-API-SECRET-KEY': secret() };
}
const normSym = (s) => String(s || '').toUpperCase();

registerAgent({
  id: 'alpaca',
  name: 'Alpaca US Market Data',
  kind: 'rest',
  envKey: 'ALPACA_API_KEY',
  authRequired: true,
  priority: 33,
  budget: { perDay: 0, perMinute: 30 },
  note: 'US quotes + market news (free paper tier) — the global equity desk breadth seat',
  caps: {
    'stocks.usquote': {
      tier: 'hot', cost: 1,
      fn: async ({ symbols }) => {
        if (!authed()) return null;
        const syms = (symbols || []).map(normSym).filter(Boolean).slice(0, 5);
        if (syms.length === 0) return null;
        const out = {};
        // v11.0.1: parallel (Promise.allSettled) — the sequential loop
        // used to burn up to 5×5s against the mesh's single 8s deadline
        // and discard ALL partial results on timeout
        await Promise.allSettled(syms.map(async (sym) => {
          const j = await fetchJSON(`${DATA_BASE}/v2/stocks/${encodeURIComponent(sym)}/quotes/latest?feed=iex`, { headers: headers() });
          const q = j?.quote;
          if (!q || !Number.isFinite(Number(q.ap))) return;
          const bid = Number(q.bp) || null, ask = Number(q.ap) || null;
          out[sym] = {
            price: ask,
            bid, ask,
            spread: bid && ask ? Math.round((ask - bid) * 100) / 100 : null,
            ts: q.t || null,
            source: 'alpaca-iex',
          };
        }));
        if (Object.keys(out).length === 0) return null;
        return { quotes: out, source: 'alpaca' };
      },
    },
    'news.usnews': {
      tier: 'warm', cost: 1,
      fn: async ({ symbols }) => {
        if (!authed()) return null;
        const syms = (symbols || []).map(normSym).filter(Boolean).slice(0, 3);
        // v11.0.1 FIX (dead feature): with NO symbols the URL used to
        // build ".../v1beta1/news&limit=10" — the "&" without a "?" put
        // limit=10 in the PATH, so market-wide news mode ALWAYS 404'd.
        // Also: symbols are encoded now (raw join was injectable).
        const url = syms.length
          ? `${DATA_BASE}/v1beta1/news?symbols=${syms.map(encodeURIComponent).join(',')}&limit=10`
          : `${DATA_BASE}/v1beta1/news?limit=10`;
        const j = await fetchJSON(url, { headers: headers() });
        if (!Array.isArray(j?.news)) return null;
        return {
          items: j.news.slice(0, 10).map(n => ({
            headline: n.headline || null,
            symbols: Array.isArray(n.symbols) ? n.symbols.slice(0, 3) : [],
            source: n.source || null,
            ts: n.created_at || null,
            summary: n.summary ? String(n.summary).slice(0, 220) : null,
          })),
          source: 'alpaca-news',
        };
      },
    },
  },
});

export default 'alpaca';
