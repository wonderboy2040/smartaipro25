// ============================================================
// src/components/aitrading/DepthLadder.tsx — v10.6
// ------------------------------------------------------------
// Pro Upgrade #1 — the order-flow / Level-2 depth mini-widget that
// lives inside the signal card (both tabs): top-5 ladder + two-band
// imbalance bar + wall markers + spoof flag, so the trader sees WHY
// the VolumeFlow seat voted the way it did — not just the vote.
//
// Polls GET /api/ai/depth every 2s while mounted (the server's 2s
// cache dedupes N viewers of the same card into ONE upstream call).
// Honest degrade: L2 unavailable → a quiet one-liner, never a spin.
// ============================================================
import { memo, useEffect, useRef, useState } from 'react';
import { apiFetch, getProxyBase } from '../../utils/api';
import type { MarketKind } from './types';

interface DepthLevel { price: number; qty: number }
interface DepthWall { price: number; qty: number; x: number; distPct?: number | null }

export interface DepthView {
  ok: boolean;
  market?: string;
  symbol?: string;
  source?: string;
  proxy?: boolean;
  reason?: string;
  bestBid?: number; bestAsk?: number;
  spreadPct?: number | null;
  imbalanceTop5?: number | null;
  imbalanceTop20?: number | null;
  bidWalls?: DepthWall[];
  askWalls?: DepthWall[];
  nearBidWall?: DepthWall | null;
  nearAskWall?: DepthWall | null;
  spoofRisk?: boolean;
  ladder?: { bids: DepthLevel[]; asks: DepthLevel[] };
}

const qty = (q: number): string => {
  if (q >= 1e6) return `${(q / 1e6).toFixed(1)}M`;
  if (q >= 1e3) return `${(q / 1e3).toFixed(1)}K`;
  return String(Math.round(q * 100) / 100);
};

// v10.6.1: readable price for every venue scale — 65432.1 / 100.35 /
// 0.000704 (SHIB-class INR tokens) all stay exact and compact.
const px = (p: number): string => {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1000) return String(Math.round(p * 10) / 10);
  if (p >= 1) return String(Math.round(p * 100) / 100);
  return String(Number(p.toPrecision(4)));
};

interface Props {
  market: MarketKind;
  symbol: string;
  ltp?: number | null;
  /** compact = inside an expanded card row; false = standalone block */
  compact?: boolean;
}

export const DepthLadder = memo(function DepthLadder({ market, symbol, ltp, compact = true }: Props) {
  const [view, setView] = useState<DepthView | null>(null);
  const [misses, setMisses] = useState(0);
  // v10.6.1 FIX: ltp lives in a ref (read at poll time) instead of the
  // effect deps — a live ltp change no longer re-fires the fetch loop.
  const ltpRef = useRef(ltp);
  ltpRef.current = ltp;

  useEffect(() => {
    // v10.6.1 FIX: aliveness is now PER-EFFECT (local flag, not a shared
    // ref). The old shared `alive` ref was flipped back to true by the
    // NEXT effect run, so an in-flight fetch from the previous run still
    // scheduled its timer after cleanup — a ZOMBIE 2s poll loop per ltp
    // change mid-flight. `stopped` is scoped to this closure only.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        // v20.1 FIX (deep audit): background tab → skip the wire entirely
        // (N mounted cards × 2s poll was a constant dead-load source).
        if (typeof document !== 'undefined' && document.hidden) return;
        const q = new URLSearchParams({ market, symbol });
        const l = ltpRef.current;
        if (l != null && Number.isFinite(l) && l > 0) q.set('ltp', String(l));
        // v20.1 FIX (CRITICAL, deep audit #1): apiFetch returns the RAW
        // Response — the old `setView(r)` stored the Response object itself
        // (Response structurally satisfies DepthView's `ok: boolean`), so
        // the L2 widget rendered "unavailable" FOREVER while polling
        // every 2s per card. Parse the JSON payload; a malformed body
        // counts as a miss (honest degrade).
        const r = await apiFetch(`${getProxyBase()}/api/ai/depth?${q.toString()}`, { signal: AbortSignal.timeout(5000) });
        if (!stopped) {
          if (r.ok) {
            const d = await r.json().catch(() => null) as DepthView | null;
            if (d && d.ok) { setView(d); setMisses(0); }
            else setMisses(m => m + 1);
          } else {
            setMisses(m => m + 1);
          }
        }
      } catch {
        if (!stopped) setMisses(m => m + 1);
      } finally {
        if (!stopped) timer = setTimeout(tick, 2000); // positionsStream fast tier
      }
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [market, symbol]);

  const d = view;
  if (!d || !d.ok || !d.ladder) {
    // honest quiet degrade — after several misses stop implying freshness
    return (
      <div className={`text-[9px] text-slate-600 ${compact ? '' : 'py-1'}`} aria-label="depth unavailable">
        L2 depth unavailable{misses > 2 ? ' — feed down' : ''}
      </div>
    );
  }

  const i5 = d.imbalanceTop5 ?? null;
  const i20 = d.imbalanceTop20 ?? null;
  const bidPct = i5 != null ? Math.round(i5 * 100) : null;
  const walls = [...(d.bidWalls || []), ...(d.askWalls || [])];
  const wallPrices = new Set(walls.map(w => w.price));

  return (
    <div className={`rounded-xl bg-black/30 border border-white/5 ${compact ? 'p-2' : 'p-3'} space-y-1.5`} aria-label="order-flow depth">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[8px] font-black text-slate-500 tracking-wider">ORDER FLOW · L2</span>
        <span className="text-[8px] text-slate-600">{d.source}{d.proxy ? ' (proxy)' : ''}</span>
        {d.spoofRisk && (
          <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-amber-500/10 text-amber-300 border border-amber-500/25" title="Walls vanished between snapshots — stacked-book spoof pattern, signal down-weighted">
            SPOOF ⚠
          </span>
        )}
      </div>

      {/* two-band imbalance bar */}
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-black text-emerald-400 w-8">BID {bidPct != null ? `${bidPct}%` : '—'}</span>
          <div className="flex-1 h-2.5 bg-red-500/20 rounded overflow-hidden relative" title={`top-5 book split — bid ${bidPct ?? '?'}% / ask ${bidPct != null ? 100 - bidPct : '?'}%`}>
            {bidPct != null && (
              <div className="h-full bg-gradient-to-r from-emerald-500/70 to-emerald-400/70" style={{ width: `${Math.min(100, bidPct)}%` }} />
            )}
            <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-600/60" />
          </div>
          <span className="text-[8px] font-black text-red-400 w-8 text-right">{bidPct != null ? `${100 - bidPct}%` : '—'}</span>
        </div>
        {i20 != null && (
          <div className="text-[8px] text-slate-500 font-mono">
            top-20: {Math.round(i20 * 100)}% bid-side{i5 != null && Math.abs(i5 - 0.5) > 0.12 && Math.abs(i20 - 0.5) < 0.06 ? ' · shallow-only (spoof-prone)' : ''}
          </div>
        )}
      </div>

      {/* the ladder — asks (reversed, best at bottom) then bids */}
      <div className="font-mono text-[9px] leading-tight">
        {[...(d.ladder.asks || [])].slice(0, 5).reverse().map((a, i) => (
          <div key={`a${i}`} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-10 text-right">{qty(a.qty)}</span>
            <span className={`w-16 text-right ${wallPrices.has(a.price) ? 'text-amber-300 font-black' : 'text-red-400'}`}
              title={wallPrices.has(a.price) ? 'wall — large resting order' : undefined}>
              {px(a.price)}{wallPrices.has(a.price) ? ' ▮' : ''}
            </span>
          </div>
        ))}
        <div className="h-px bg-slate-700/60 my-0.5" />
        {(d.ladder.bids || []).slice(0, 5).map((b, i) => (
          <div key={`b${i}`} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-10 text-right">{qty(b.qty)}</span>
            <span className={`w-16 text-right ${wallPrices.has(b.price) ? 'text-amber-300 font-black' : 'text-emerald-400'}`}
              title={wallPrices.has(b.price) ? 'wall — large resting order' : undefined}>
              {px(b.price)}{wallPrices.has(b.price) ? ' ▮' : ''}
            </span>
          </div>
        ))}
      </div>

      {/* wall read-out */}
      {(d.nearBidWall || d.nearAskWall) && (
        <div className="flex gap-2 flex-wrap text-[8px] font-mono">
          {d.nearBidWall && d.nearBidWall.distPct != null && d.nearBidWall.distPct >= 0 && (
            <span className="text-emerald-300" title="large bid within 0.5% — support">
              bid wall {d.nearBidWall.x}× @ {px(d.nearBidWall.price)}
            </span>
          )}
          {d.nearAskWall && d.nearAskWall.distPct != null && d.nearAskWall.distPct >= 0 && (
            <span className="text-red-300" title="large ask within 0.5% — resistance">
              ask wall {d.nearAskWall.x}× @ {px(d.nearAskWall.price)}
            </span>
          )}
          {d.spreadPct != null && <span className="text-slate-600 ml-auto">spread {d.spreadPct}%</span>}
        </div>
      )}
    </div>
  );
});
