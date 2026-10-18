// ============================================================
// src/components/aitrading/manualLiveMerge.ts — v12.9
// ------------------------------------------------------------
// USER SPEC: "manual trade record ko Realtime Prices Fetch hona hai."
// The tracker's REST poll is 5s; the SSE tick stream is ~1s. This PURE
// helper merges the live SSE ticks into the server's trade views —
// LTP + P&L (native currency: USDT for perps, ₹ for India) recompute
// INSTANTLY between polls. The 5s REST poll stays as reconciliation
// (banner/conviction/distances stay server-computed).
//
// P&L math mirrors manualPnlOf (server): (px-entry)×mult×dir, ×fx for
// the ₹ twin of USDT-domain trades — the SAME usdInr the server sent
// in the response (never a hardcoded guess).
// ============================================================

export interface LivePnl {
  pnlUSDT: number | null;
  pnlINR: number;
  pnlPct: number;
  currency: 'INR' | 'USDT';
}

export interface LiveTickLike {
  price: number;
  time: number;
}

/** The SSE tick-key namespace for a manual trade's market — mirrors the
 *  server's _tickKeyFor + useCxLivePrices.forSignal. PURE. */
export function liveKeyFor(market: string, symbol: string): string | null {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const m = String(market || '').toUpperCase();
  if (m === 'FUTURES') return `FUT_${sym}`;
  if (m === 'GLOBALFUTURES') return `GLOB_${sym}`;
  if (m === 'CRYPTO') return `IN_${sym}`; // CoinDCX spot INR (crypto= param)
  if (m === 'INDIA') return `IN_${sym}`;   // NSE equity (in= param)
  return null;
}

/** Native-currency P&L at a live price — the exact manualPnlOf math. PURE. */
export function livePnlOf(trade: {
  market?: string; side?: string; entryPrice?: number; qty?: number; lotSize?: number;
}, px: number, usdInr: number): LivePnl | null {
  const entry = Number(trade?.entryPrice);
  const q = Number(trade?.qty);
  if (!(entry > 0) || !(q > 0) || !(px > 0)) return null;
  const isUsd = String(trade?.market || '').toUpperCase() === 'FUTURES'
    || String(trade?.market || '').toUpperCase() === 'GLOBALFUTURES';
  const dir = String(trade?.side || '').toUpperCase() === 'SELL' ? -1 : 1;
  const mult = q * (Number(trade?.lotSize) || 1);
  const pnlPct = ((px - entry) / entry) * 100 * dir;
  const pnlNative = (px - entry) * mult * dir;
  const fx = isUsd ? (Number(usdInr) > 0 ? Number(usdInr) : 84) : 1;
  return {
    pnlUSDT: isUsd ? Math.round(pnlNative * 1000) / 1000 : null,
    pnlINR: Math.round(pnlNative * fx * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    currency: isUsd ? 'USDT' : 'INR',
  };
}

/** Merge live SSE ticks into the tracker's trade views. A tick older
 *  than 30s is NOT live (the stale-tick rule) — the server LTP stays.
 *  Returns the SAME array shape with __view.ltp/pnl overridden. PURE. */
export function mergeLiveTicks<T extends {
  status?: string; market?: string; symbol?: string; assetKind?: string | null;
  __view?: { ltp?: number | null; pnl?: { pnlINR: number; pnlPct: number; pnlUSDT: number | null; currency: string } } | null;
}>(trades: T[], ticks: Record<string, LiveTickLike>, usdInr: number, now = Date.now()): T[] {
  if (!Array.isArray(trades) || trades.length === 0) return trades;
  let changed = false;
  const out = trades.map(t => {
    if (t?.status !== 'OPEN' || !t.__view) return t;
    // v18.6.4: OPTION trades NEVER take the underlying spot tick — the
    // server re-prices their premium via Black-Scholes; a NIFTY 24,600
    // tick on a ₹150-premium trade rendered -₹36L P&L between polls.
    if (t?.assetKind === 'OPTION') return t;
    const key = liveKeyFor(String(t.market || ''), String(t.symbol || ''));
    const tick = key ? ticks[key] : null;
    // the 30s freshness rule — a stale tick must not masquerade as live
    if (!tick || !(tick.price > 0) || now - tick.time > 30_000) return t;
    const pnl = livePnlOf(t as unknown as { market?: string; side?: string; entryPrice?: number; qty?: number; lotSize?: number }, tick.price, usdInr);
    if (!pnl) return t;
    changed = true;
    return {
      ...t,
      __view: {
        ...t.__view,
        ltp: tick.price,
        pnl: { pnlINR: pnl.pnlINR, pnlPct: pnl.pnlPct, pnlUSDT: pnl.pnlUSDT, currency: pnl.currency },
      },
    };
  });
  return changed ? out : trades;
}
