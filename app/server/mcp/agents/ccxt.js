// ============================================================
// server/mcp/agents/ccxt.js — v11.0 PHASE 1
// ------------------------------------------------------------
// CCXT-style unified exchange adapter. The plan's "npm ccxt
// in-process" is honoured in SPIRIT with a deliberate deviation
// (recorded in docs/CHANGES.md): the npm package is ~50MB and would
// triple the deploy size for 3 public endpoints this mesh needs.
// Instead: ONE thin unified surface over Binance + Bybit + OKX
// PUBLIC REST (the same upstreams the repo already proved in
// binanceFutWs/cryptoStream). Same agent card, same mesh contract —
// "protocol flexible, interface strict".
//
// Capabilities (exchange-agnostic, round-robins on failure):
//   crypto.ohlcv      unified klines/candles
//   crypto.orderbook  unified L2 top-of-book
//   crypto.funding    perp funding rates (Binance fapi)
// ============================================================
import { registerAgent, fetchJSON } from './registry.js';

// ---------------- symbol normalization ----------------
function normSymbol(s) {
  return String(s || '').toUpperCase().replace(/INR$/, 'USDT');
}

// ---------------- exchange adapters (public, keyless) ----------------
const EXCHANGES = {
  binance: {
    ohlcv: async (sym, tf, limit) => {
      const map = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
      const j = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${map[tf] || '1h'}&limit=${Math.min(500, limit)}`);
      if (!Array.isArray(j)) return null;
      return j.map(k => ({ time: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
    },
    orderbook: async (sym, limit) => {
      const j = await fetchJSON(`https://api.binance.com/api/v3/depth?symbol=${sym}&limit=${Math.min(100, limit || 20)}`);
      if (!j?.bids || !j?.asks) return null;
      return {
        bids: j.bids.slice(0, 10).map(b => ({ price: Number(b[0]), qty: Number(b[1]) })),
        asks: j.asks.slice(0, 10).map(a => ({ price: Number(a[0]), qty: Number(a[1]) })),
      };
    },
    funding: async (sym) => {
      const j = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`);
      const rate = Number(j?.lastFundingRate);
      if (!Number.isFinite(rate)) return null;
      return { rate, nextFundingTs: j.nextFundingTime || null, markPrice: Number(j.markPrice) || null };
    },
  },
  bybit: {
    ohlcv: async (sym, tf, limit) => {
      const map = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
      const j = await fetchJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${map[tf] || '60'}&limit=${Math.min(200, limit)}`);
      const list = j?.result?.list;
      if (!Array.isArray(list)) return null;
      // bybit returns newest-first
      return list.reverse().map(k => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
    },
    orderbook: async (sym, limit) => {
      const j = await fetchJSON(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${sym}&limit=${Math.min(50, limit || 20)}`);
      const r = j?.result;
      if (!r?.b || !r?.a) return null;
      return {
        bids: r.b.slice(0, 10).map(b => ({ price: Number(b[0]), qty: Number(b[1]) })),
        asks: r.a.slice(0, 10).map(a => ({ price: Number(a[0]), qty: Number(a[1]) })),
      };
    },
    funding: async (sym) => {
      const j = await fetchJSON(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`);
      const t = j?.result?.list?.[0];
      const rate = Number(t?.fundingRate);
      if (!Number.isFinite(rate)) return null;
      return { rate, nextFundingTs: t.nextFundingTime ? Number(t.nextFundingTime) : null, markPrice: Number(t.markPrice) || null };
    },
  },
  okx: {
    ohlcv: async (sym, tf, limit) => {
      const map = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
      // OKX wants BTC-USDT split form
      const inst = sym.includes('-') ? sym : sym.replace(/USDT$/, '-USDT');
      const j = await fetchJSON(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${map[tf] || '1H'}&limit=${Math.min(100, limit)}`);
      const list = j?.data;
      if (!Array.isArray(list)) return null;
      return list.reverse().map(k => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
    },
    orderbook: async (sym, _limit) => {
      const inst = sym.includes('-') ? sym : sym.replace(/USDT$/, '-USDT');
      const j = await fetchJSON(`https://www.okx.com/api/v5/market/books?instId=${inst}&sz=10`);
      const list = j?.data?.[0];
      if (!list?.bids || !list?.asks) return null;
      return {
        bids: list.bids.slice(0, 10).map(b => ({ price: Number(b[0]), qty: Number(b[1]) })),
        asks: list.asks.slice(0, 10).map(a => ({ price: Number(a[0]), qty: Number(a[1]) })),
      };
    },
    funding: null, // OKX funding needs instId on swap market — binance/bybit cover it
  },
};

const ORDER = ['binance', 'bybit', 'okx'];

/** Try exchanges in order (geo-block resilience — the repo's 451
 *  breaker lesson); first non-null wins. */
async function acrossExchanges(fnName, sym, ...args) {
  for (const ex of ORDER) {
    const fn = EXCHANGES[ex]?.[fnName];
    if (typeof fn !== 'function') continue;
    try {
      const out = await fn(sym, ...args);
      if (out) return { data: out, exchange: ex };
    } catch { /* next exchange */ }
  }
  return null;
}

registerAgent({
  id: 'ccxt',
  name: 'CCXT Unified Exchange Mesh',
  kind: 'inprocess',
  envKey: '',
  authRequired: false, // public market data only — no key, no trading
  priority: 10,
  budget: { perDay: 0, perMinute: 40 },
  note: 'Unified OHLCV / orderbooks / funding across Binance+Bybit+OKX (CCXT-style public surface, geo-failover)',
  caps: {
    'crypto.ohlcv': {
      tier: 'warm', cost: 1,
      fn: async ({ symbols, timeframe = '1h', limit = 120 }) => {
        const sym = normSymbol(Array.isArray(symbols) ? symbols[0] : symbols);
        if (!sym) return null;
        const r = await acrossExchanges('ohlcv', sym, timeframe, Number(limit) || 120);
        if (!r) return null;
        return { symbol: sym, timeframe, candles: r.data, exchange: r.exchange, source: 'ccxt' };
      },
    },
    'crypto.orderbook': {
      tier: 'hot', cost: 1,
      fn: async ({ symbols, limit = 20 }) => {
        const sym = normSymbol(Array.isArray(symbols) ? symbols[0] : symbols);
        if (!sym) return null;
        const r = await acrossExchanges('orderbook', sym, Number(limit) || 20);
        if (!r) return null;
        return { symbol: sym, ...r.data, exchange: r.exchange, source: 'ccxt' };
      },
    },
    'crypto.funding': {
      tier: 'warm', cost: 1,
      fn: async ({ symbols }) => {
        const sym = normSymbol(Array.isArray(symbols) ? symbols[0] : symbols);
        if (!sym) return null;
        const r = await acrossExchanges('funding', sym);
        if (!r) return null;
        return { symbol: sym, fundingRate: r.data.rate, nextFundingTs: r.data.nextFundingTs, markPrice: r.data.markPrice, exchange: r.exchange, source: 'ccxt' };
      },
    },
  },
});

export default 'ccxt';
