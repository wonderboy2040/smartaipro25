// ============================================================
// server/mcp/agents/coingecko.js — v11.0 PHASE 1
// ------------------------------------------------------------
// CoinGecko — official MCP (remote JSON-RPC). The public REST API
// covers the same surface with the demo key, so the adapter speaks
// REST (same contract; the remote MCP URL can be swapped in without
// touching mesh.js — "protocol flexible, interface strict").
// Capabilities:
//   crypto.price     /simple/price       (hot tier, 10/min budget)
//   crypto.market    /coins/markets      (trending by mcap)
//   crypto.trending  /search/trending    (warm tier)
//   crypto.onchain   /coins/{id}         (cold — dev/community data)
// ============================================================
import { registerAgent, fetchJSON } from './registry.js';

const BASE = 'https://api.coingecko.com/api/v3';
const key = () => String(process.env.COINGECKO_API_KEY || '').trim();

/** Demo key rides the documented header; absent key → public paths. */
function headers() {
  return key() ? { 'x-cg-demo-api-key': key() } : {};
}

const CG_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
  BNB: 'binancecoin', DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2',
  TRX: 'tron', LINK: 'chainlink', DOT: 'polkadot', MATIC: 'matic-network',
  LTC: 'litecoin', SHIB: 'shiba-inu', NEAR: 'near', ATOM: 'cosmos',
  UNI: 'uniswap', XLM: 'stellar', HBAR: 'hedera-hashgraph', FIL: 'filecoin',
  ARB: 'arbitrum', OP: 'optimism', APT: 'aptos', INJ: 'injective-protocol',
  TIA: 'celestia', SUI: 'sui', PEPE: 'pepe', WIF: 'dogwifcoin', TON: 'the-open-network',
};
const cgId = (s) => CG_IDS[q(s)] || null;
function q(s) { return String(s || '').toUpperCase().replace(/USDT$|INR$/g, ''); }

registerAgent({
  id: 'coingecko',
  name: 'CoinGecko MCP (official)',
  kind: 'rest',
  envKey: 'COINGECKO_API_KEY',
  authRequired: false, // public demo endpoints work keyless (rate-limited)
  priority: 20,
  budget: { perDay: 0, perMinute: 10 },
  note: 'Crypto prices, market caps, trending + on-chain context — 200+ chains, 8M+ tokens',
  caps: {
    'crypto.price': {
      tier: 'hot', cost: 1,
      fn: async ({ symbols }) => {
        const ids = [...new Set((symbols || []).map(cgId).filter(Boolean))].join(',');
        if (!ids) return null;
        const j = await fetchJSON(`${BASE}/simple/price?ids=${ids}&vs_currencies=usd,inr&include_24hr_change=true&include_24hr_vol=true`, { headers: headers() });
        if (!j || typeof j !== 'object' || Object.keys(j).length === 0) return null;
        const out = {};
        for (const [id, v] of Object.entries(j)) {
          if (!v || !Number.isFinite(v.usd)) continue;
          const sym = Object.keys(CG_IDS).find(k => CG_IDS[k] === id) || id.toUpperCase();
          out[sym] = {
            usd: v.usd,
            inr: Number.isFinite(v.inr) ? v.inr : null,
            changePct24h: Number.isFinite(v.usd_24h_change) ? Math.round(v.usd_24h_change * 100) / 100 : null,
            volumeUsd24h: Number.isFinite(v.usd_24h_vol) ? Math.round(v.usd_24h_vol) : null,
          };
        }
        return { prices: out, source: 'coingecko' };
      },
    },
    'crypto.market': {
      tier: 'warm', cost: 1,
      fn: async ({ limit }) => {
        const n = Math.min(50, Math.max(5, Number(limit) || 20));
        const j = await fetchJSON(`${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&sparkline=false&price_change_percentage=24h`, { headers: headers() });
        if (!Array.isArray(j) || j.length === 0) return null;
        return {
          top: j.map(c => ({
            symbol: q(c.symbol), name: c.name, usd: c.current_price,
            mcap: c.market_cap, rank: c.market_cap_rank,
            changePct24h: Number.isFinite(c.price_change_percentage_24h) ? Math.round(c.price_change_percentage_24h * 100) / 100 : null,
          })),
          source: 'coingecko',
        };
      },
    },
    'crypto.trending': {
      tier: 'warm', cost: 1,
      fn: async () => {
        const j = await fetchJSON(`${BASE}/search/trending`, { headers: headers() });
        const coins = j?.coins || [];
        if (!Array.isArray(coins) || coins.length === 0) return null;
        return {
          trending: coins.slice(0, 12).map(c => ({
            symbol: q(c.item?.symbol), name: c.item?.name, rank: c.item?.market_cap_rank || null,
          })),
          source: 'coingecko',
        };
      },
    },
    'crypto.onchain': {
      tier: 'cold', cost: 1,
      fn: async ({ symbols }) => {
        const id = cgId(Array.isArray(symbols) ? symbols[0] : symbols);
        if (!id) return null;
        const j = await fetchJSON(`${BASE}/coins/${id}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true&sparkline=false`, { headers: headers() });
        if (!j || !j.market_data) return null;
        return {
          symbol: q(Array.isArray(symbols) ? symbols[0] : symbols),
          athChangePct: Number(j.market_data?.ath_change_percentage?.usd) || null,
          atlChangePct: Number(j.market_data?.atl_change_percentage?.usd) || null,
          totalVolumeUsd: Number(j.market_data?.total_volume?.usd) || null,
          circulatingSupply: Number(j.market_data?.circulating_supply) || null,
          community: j.community_data ? {
            twitterFollowers: j.community_data.twitter_followers || null,
            redditSubs: j.community_data.reddit_subscribers || null,
          } : null,
          developer: j.developer_data ? {
            stars: j.developer_data.stars || null,
            forks: j.developer_data.forks || null,
            lastCommitDays: j.developer_data?.last_commit_days != null ? Math.round(Number(j.developer_data.last_commit_days)) : null,
          } : null,
          source: 'coingecko',
        };
      },
    },
  },
});

export default 'coingecko';
