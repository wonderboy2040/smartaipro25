// ============================================================
// intraday/PaperTradePanel — virtual-trade simulator UI
// ------------------------------------------------------------
// Lists open virtual positions with LIVE P&L (SSE prices), today's
// closed trades, and day/total P&L stats. Auto-managed by the
// server watcher (T1 books 50%, trail to entry, SL/T2/EOD close).
//
// v2 — DURABLE HISTORY:
//   • "History" section: day-wise closed trades + win-rate accuracy
//     stats (signal testing actually accurate hai ya nahi).
//   • Device mirror (IndexedDB) + auto-restore: Render free tier
//     wipes server/data/ on restart — the browser silently POSTs
//     its mirror back and rebuilds the server's trade history.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { syncMirrorWithServer, ensureMirrorSyncLoop, PAPER_MIRROR_RESTORED_EVENT } from '../../utils/paperMirror';
import type { PaperHistory, PaperSummary, PaperTrade, LiveQuote, IntradaySignal, PaperDayStats } from './types';

// v21.23.13 [DESK-SCOPED PAPER PANEL]: `desk` prop panel ko us desk ke
// rows tak scope karta hai — ?market= query server-side filter chalati hai
// (detail paperTrading.js `_deskMatches` pe). undefined desk = legacy
// unscoped behavior (sab desks — back-compat).
async function fetchSummary(desk?: 'INDIA' | 'CRYPTO'): Promise<PaperSummary | null> {
  try {
    const q = desk ? `?market=${encodeURIComponent(desk)}` : '';
    const res = await apiFetch(`/api/intraday-paper${q}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return await res.json();
  } catch { /* offline */ }
  return null;
}

async function fetchHistory(desk?: 'INDIA' | 'CRYPTO'): Promise<PaperHistory | null> {
  try {
    const res = await apiFetch(`/api/intraday-paper/history?days=90${desk ? `&market=${encodeURIComponent(desk)}` : ''}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return await res.json();
  } catch { /* offline */ }
  return null;
}

async function closeTrade(id: number): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/intraday-paper/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch { return false; }
}

export async function openPaperTrade(s: IntradaySignal, qty: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/intraday-paper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: s.symbol, direction: s.direction, entry: s.entry, qty,
        stopLoss: s.stopLoss, target1: s.target1, target2: s.target2,
        market: s.market || (['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','DOT','LINK','UNI','MATIC'].includes(s.symbol) ? 'CRYPTO' : 'INDIA'),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) return { ok: true };
    return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

// ------------------------------------------------------------
// v9.5 F&O OPTION PAPER TRADE — the "Nifty50 15Sep 23400 CE" signal
// card opens a premium-BUY (LONG) position in the SAME Paper Desk:
//   qty   = 1 LOT (P&L auto-multiplied by lotSize server-side)
//   T2    = entry + 1.5× the reward leg (extends the card's target)
//   price = watcher re-prices the premium via Black-Scholes on the
//           live index spot (NIFTY→^NSEI / SENSEX→^BSESN), so SL/T1/
//           T2/trailing/15:10 square-off + live P&L all work
// ------------------------------------------------------------
export async function openOptionPaperTrade(c: {
  symbol: string; strike: number; type: 'CE' | 'PE'; expiry: string;
  entry: number; target: number; stopLoss: number; iv: number | null;
  lotSize: number; name: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    // Option BUY = premium LONG: SL < entry < T1 < T2 in premium terms.
    if (!(c.stopLoss > 0 && c.stopLoss < c.entry && c.target > c.entry)) {
      return { ok: false, error: 'Card levels incomplete (entry/target/SL) — option paper trade nahi khul sakta.' };
    }
    // v21.0.2 EXIT-PLAN MATCH FIX: card ka displayed plan tha —
    // T1 = entry + 0.5×reward (book 50% · SL → breakeven), T2 = entry +
    // 1.0×reward (runner). Pehle target1 = FULL target bheja jata tha,
    // matlab engine 50% booking pura target pe karta tha (card ke half-
    // reward claim se aadha reward late) aur T2 1.5R pe — dono card se
    // mismatch. Ab engine wahi karta hai jo card dikhata hai.
    const reward = c.target - c.entry;
    const t1 = +(c.entry + reward * 0.5).toFixed(2);
    const t2 = +(c.entry + reward * 1.0).toFixed(2);
    const res = await apiFetch(`/api/intraday-paper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // compact contract id: NIFTY23400CE (validated server-side)
        symbol: `${c.symbol}${Math.round(c.strike)}${c.type}`,
        direction: 'LONG',                    // premium BUY
        entry: c.entry, qty: 1,               // 1 lot
        stopLoss: c.stopLoss, target1: t1, target2: t2,
        market: 'INDIA',
        assetKind: 'OPTION', underlying: c.symbol,
        strike: c.strike, optType: c.type, expiry: c.expiry,
        iv: c.iv && c.iv > 0 ? c.iv : 13,    // BS fallback IV (13%) — same as the card builder
        lotSize: c.lotSize, label: c.name,    // "Nifty50 15Sep 23400 CE"
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) return { ok: true };
    return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

const pnlColor = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400');
const isUsdTrade = (t?: { market?: string; ccy?: string } | null) =>
  t?.ccy === 'USDT' || t?.ccy === 'USDC' || t?.market === 'FUTURES' || t?.market === 'GLOBALFUTURES';
const ccySym = (t?: { market?: string; ccy?: string } | null) => (isUsdTrade(t) ? '$' : '₹');
const fmtPnl = (v: number, t?: { market?: string; ccy?: string } | null) => `${v >= 0 ? '+' : '−'}${ccySym(t)}${Math.abs(v).toFixed(2)}`;

/** v9.2 adaptive price format — DOGE/SHIB-class crypto paper trades
 *  must not render as ₹0.0 (0.0848 → ₹0.0848, 4-8 decimals below ₹1).
 *  v21.17.0: USDT/USDC paper trades render with `$` instead of `₹`. */
const px = (v: number | null | undefined, t?: { market?: string; ccy?: string } | null): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const clean = Number(v.toFixed(8));
  const s = String(clean);
  const dot = s.indexOf('.');
  const actualDp = dot >= 0 ? s.length - dot - 1 : 0;
  const a = Math.abs(clean);
  const minDp = a === 0 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  const dp = Math.min(8, Math.max(minDp, actualDp));
  return `${ccySym(t)}${clean.toFixed(dp)}`;
};

function dayLabel(dayKey: string): string {
  try {
    const d = new Date(`${dayKey}T12:00:00`);
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return dayKey; }
}

function TradeRow({ t, live, onClose, closing }: {
  t: PaperTrade; live?: LiveQuote; onClose: (id: number) => void; closing: boolean;
}) {
  const sign = t.direction === 'LONG' ? 1 : -1;
  const lotMult = t.assetKind === 'OPTION' ? (t.lotSize || 1) : 1; // v9.5 F&O lots
  // v21.17.0 QUOTE DOMAIN GUARD (browser): USDT/USDC paper trades ignore
  // INR-denominated live quotes (`coindcx-inr`) so cross-desk base symbols
  // (BTC) never render a mixed-currency P&L in the table.
  const safeLive = (isUsdTrade(t) && live?.src && /inr/i.test(String(live.src))) ? undefined : live;
  const livePnl = safeLive?.price != null
    ? t.remainingQty * (safeLive.price - t.entry) * sign * lotMult + t.realizedPnl
    : t.realizedPnl + t.unrealizedPnl;
  const livePrice = safeLive?.price ?? t.lastPrice;
  const isClosed = t.status === 'CLOSED';
  const isOption = t.assetKind === 'OPTION';
  // v11.1 GAP 3: entry-side costs already locked in (brokerage buy order +
  // stamp/txn/SEBI/GST) ride as an honest small chip under the gross number.
  const openCosts = !isClosed && t.costs != null && t.costs > 0 ? t.costs : null;
  return (
    <tr className="border-b border-white/5 hover:bg-white/[0.03]">
      <td className="px-2 py-1.5">
        <span className="font-black text-white" title={isOption ? `${t.label || t.symbol} · ${t.expiry} · lot ${t.lotSize}` : t.symbol}>
          {isOption ? (t.label || t.symbol) : t.symbol}
        </span>
        {isOption && (
          <span className="ml-1 px-1 py-0.5 rounded text-[8px] font-black font-mono bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/25" title={`F&O option · 1 lot = ${t.lotSize} qty · premium re-priced live`}>F&amp;O</span>
        )}
        {t.market === 'CRYPTO' && (
          <span className="ml-1 px-1 py-0.5 rounded text-[8px] font-black font-mono bg-amber-500/15 text-amber-300 border border-amber-500/25" title="Crypto market · CoinDCX INR · 24/7">₿</span>
        )}
        {(t.market === 'FUTURES' || t.market === 'GLOBALFUTURES' || t.ccy === 'USDT' || t.ccy === 'USDC') && (
          <span className="ml-1 px-1 py-0.5 rounded text-[8px] font-black font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/25" title="Perp paper · USDT/USDC domain · 24/7">{t.ccy || 'USDT'}</span>
        )}
        {t.source && t.source !== 'ui' && (
          <span className={`ml-1 px-1 rounded text-[8px] font-black ${t.source === 'mtf-auto' ? 'bg-emerald-500/15 text-emerald-300' : t.source === 'mtf-board-ui' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-slate-500/15 text-slate-400'}`}
            title={t.sourceMeta ? `source: ${t.source} · score ${t.sourceMeta.score ?? '—'} ${t.sourceMeta.tier ?? ''} · ${t.sourceMeta.mode ?? ''} ${t.sourceMeta.holdMin ?? ''}m` : `source: ${t.source}`}>
            {t.source === 'mtf-auto' ? '🔗' : t.source === 'mtf-board-ui' ? '🧪' : t.source}
          </span>
        )}
        <span className={`ml-1 text-[9px] font-black ${t.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
          {t.direction === 'LONG' ? 'L' : 'S'}
        </span>
      </td>
      <td className="px-2 py-1.5 text-center text-cyan-200">{px(t.entry, t)}</td>
      <td className="px-2 py-1.5 text-center text-slate-300">
        {px(livePrice, t)}{safeLive && <span className="ml-0.5 text-[7px] text-cyan-500 animate-pulse">●</span>}
      </td>
      <td className="px-2 py-1.5 text-center text-slate-400">{t.remainingQty}/{t.qty}</td>
      <td className={`px-2 py-1.5 text-center font-bold ${pnlColor(livePnl)}`} title={openCosts != null ? `gross ${fmtPnl(livePnl, t)} — entry-side costs ${fmtPnl(openCosts, t)} abhi tak lage hain` : undefined}>
        {fmtPnl(livePnl, t)}
        {openCosts != null && <span className="ml-1 text-[8px] font-black text-amber-500/80" title="costs so far (entry side)">−{fmtPnl(openCosts, t)}c</span>}
      </td>
      <td className="px-2 py-1.5 text-center">
        {isClosed ? (
          <span className="text-[9px] font-bold text-slate-500">{t.closeReason}</span>
        ) : (
          <span className="inline-flex items-center gap-1">
            {t.status === 'PARTIAL' && (
              <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-amber-500/15 text-amber-300 border border-amber-500/30" title="T1 par 50% book ho chuka, runner BE-trail par hai">T1✓</span>
            )}
            <button
              onClick={() => onClose(t.id)}
              disabled={closing}
              className="px-2 py-0.5 rounded text-[9px] font-black bg-white/5 border border-white/15 text-slate-300 hover:bg-white/10 disabled:opacity-40"
            >
              {closing ? '…' : 'CLOSE'}
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

// ---- HISTORY sub-section: day-wise closed trades + accuracy stats ----
function HistorySection({ history }: { history: PaperHistory }) {
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const { overall, groups, trades } = history;
  if (overall.totalTrades === 0) return null;

  return (
    <div className="rounded-lg bg-black/20 border border-white/5 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap px-1">
        <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">History — Accuracy Audit</div>
        <div className="text-[10px] font-mono text-slate-400 flex items-center gap-2 flex-wrap">
          <span>{overall.totalTrades} trades</span>
          <span className={`font-black ${overall.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
            {overall.winRate.toFixed(1)}% win
          </span>
          {overall.profitFactor != null && <span className="text-slate-500">PF {overall.profitFactor.toFixed(2)}</span>}
          <b className={pnlColor(overall.totalNetPnl ?? overall.totalPnl)} title={`gross ${fmtPnl(overall.totalPnl)} − costs ${fmtPnl(overall.totalCosts ?? 0)}`}>
            {fmtPnl(overall.totalNetPnl ?? overall.totalPnl)} net
          </b>
          {overall.totalPnl !== (overall.totalNetPnl ?? overall.totalPnl) && (
            <span className="text-slate-600">gross {fmtPnl(overall.totalPnl)}</span>
          )}
        </div>
      </div>
      <div className="text-[9px] font-mono text-slate-500 px-1 flex gap-3 flex-wrap">
        <span>Avg W <b className="text-emerald-400/80">{fmtPnl(overall.avgWin)}</b></span>
        <span>Avg L <b className="text-red-400/80">{fmtPnl(overall.avgLoss)}</b></span>
        {overall.bestDay && <span>Best <b className="text-emerald-400/80">{overall.bestDay.dayKey} {fmtPnl(overall.bestDay.pnl)}</b></span>}
        {(overall.totalCosts ?? 0) > 0 && (
          <span className="text-amber-500/80" title="brokerage + STT + exchange txn + SEBI + GST + stamp (env-tunable to your broker)">
            Costs ate {fmtPnl(overall.totalCosts ?? 0)}{overall.costsPctOfGrossProfit != null ? ` · ${overall.costsPctOfGrossProfit}% of gross profit` : ''}
          </span>
        )}
      </div>
      <div className="max-h-56 overflow-y-auto">
        {groups.map((g: PaperDayStats) => {
          const open = expandedDay === g.dayKey;
          const dayTrades = trades.filter(t => (t.dayKey || '') === g.dayKey);
          return (
            <div key={g.dayKey} className="border-b border-white/5 last:border-0">
              <button
                onClick={() => setExpandedDay(open ? null : g.dayKey)}
                className="w-full flex items-center justify-between gap-2 px-1.5 py-1 hover:bg-white/[0.03] text-left"
              >
                <span className="text-[10px] font-mono font-bold text-slate-300">{dayLabel(g.dayKey)}</span>
                <span className="text-[9px] font-mono text-slate-500 flex items-center gap-2">
                  <span>{g.trades}T</span>
                  <span className="text-emerald-400/70">{g.wins}W</span>
                  <span className="text-red-400/70">{g.losses}L</span>
                  <span className={`px-1 rounded font-black ${g.winRate >= 50 ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300'}`}>
                    {g.winRate.toFixed(0)}%
                  </span>
                  <b className={pnlColor(g.netPnl ?? g.realizedPnl)} title={`gross ${fmtPnl(g.realizedPnl)} − costs ${fmtPnl(g.costs ?? 0)}`}>{fmtPnl(g.netPnl ?? g.realizedPnl)}</b>
                </span>
              </button>
              {open && dayTrades.length > 0 && (
                <table className="w-full text-[10px] font-mono pb-1">
                  <tbody>
                    {dayTrades.map(t => {
                      const exit = t.parts.length ? t.parts[t.parts.length - 1].exitPrice : t.entry;
                      return (
                        <tr key={t.id} className="border-b border-white/5">
                          <td className="px-2 py-1 text-left">
                            <span className="font-black text-slate-200" title={t.assetKind === 'OPTION' ? `${t.label || t.symbol} · lot ${t.lotSize}` : undefined}>
                              {t.assetKind === 'OPTION' ? (t.label || t.symbol) : t.symbol}
                            </span>
                            <span className={`ml-1 text-[8px] font-black ${t.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {t.direction === 'LONG' ? 'L' : 'S'}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-center text-cyan-200/80">{px(t.entry)}</td>
                          <td className="px-2 py-1 text-center text-slate-400">{px(exit)}</td>
                          <td className="px-2 py-1 text-center text-slate-500">{t.qty}</td>
                          <td className={`px-2 py-1 text-center font-bold ${pnlColor(t.netPnl ?? t.realizedPnl)}`} title={`gross ${fmtPnl(t.realizedPnl)} − costs ${fmtPnl(t.costs ?? 0)} (brokerage/STT/txn/GST/SEBI/stamp)`}>
                            {fmtPnl(t.netPnl ?? t.realizedPnl)}
                            {(t.costs ?? 0) > 0 && <span className="ml-0.5 text-[8px] font-black text-amber-500/70">net</span>}
                          </td>
                          <td className="px-2 py-1 text-center text-[8px] text-slate-600">{t.closeReason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PaperTradePanel({ desk = null, livePrices, refreshKey, onOpenSymbolsChange }: {
  /** v21.23.13: 'INDIA' → sirf NSE paper rows (Intraday tab); 'CRYPTO' →
   *  crypto family rows — CoinDCX tab ka Paper Desk (MTF board PAPER
   *  clicks ab wahin dikhenge, Intraday tab me nahi). null = all desks. */
  desk?: 'INDIA' | 'CRYPTO' | null;
  livePrices: Record<string, LiveQuote>; refreshKey: number;
  /** v9.1: lift the open-trade symbol set to the parent tab so the Signal
   *  Board cards can badge "PAPER OPEN" (the old IntradayTab kept this
   *  in a never-populated ref — the badge never lit up; fixed by design). */
  onOpenSymbolsChange?: (symbols: Set<string>) => void;
}) {
  const [summary, setSummary] = useState<PaperSummary | null>(null);
  const [history, setHistory] = useState<PaperHistory | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [restoredNote, setRestoredNote] = useState<string | null>(null);
  const syncingRef = useRef(false);
  // v21.1.1 [audit D7]: restored-note timer ref — unmount pe clear (codebase
  // ka toast discipline; React 18+ me warning nahi hoti par cleanup sahi hai).
  const restoredNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v9.1: report the open-symbol set upward (dedup'd via a ref so the
  // 15s/60s pollers don't spam the parent with fresh-but-equal Sets).
  const lastSymbolsRef = useRef<Set<string> | null>(null);
  const reportSymbols = useCallback((s: PaperSummary | null) => {
    if (!onOpenSymbolsChange) return;
    const next = new Set((s?.open || []).map(t => String(t.symbol).toUpperCase()));
    const prev = lastSymbolsRef.current;
    if (prev && prev.size === next.size && [...next].every(x => prev.has(x))) return;
    lastSymbolsRef.current = next;
    onOpenSymbolsChange(next);
  }, [onOpenSymbolsChange]);

  const load = useCallback(async () => {
    const s = await fetchSummary(desk ?? undefined);
    if (s) { setSummary(s); reportSymbols(s); }
  }, [reportSymbols, desk]);

  const loadHistory = useCallback(async () => {
    // v21.23.13 [MIRROR DUTY SPLIT]: desk-scoped panel ka compare/restore
    // UNSCOPED singleton loop (paperMirror.ensureMirrorSyncLoop) karta hai
    // — scoped rows se wipe-detection galat RESTORE trigger karta. Scoped
    // mode me yahan sirf display fetch hota hai.
    if (desk) {
      const [s, h] = await Promise.all([fetchSummary(desk), fetchHistory(desk)]);
      if (s) { setSummary(s); reportSymbols(s); }
      if (h) setHistory(h);
      ensureMirrorSyncLoop();
      return;
    }
    // History fetch + device-mirror sync (guard: no overlapping runs —
    // a restore inside triggers a refresh, which re-enters here).
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      const [s, h] = await Promise.all([fetchSummary(), fetchHistory()]);
      if (!s) return;
      setSummary(s);
      setHistory(h);
      reportSymbols(s);
      if (h) {
        const restored = await syncMirrorWithServer(s.open || [], h.trades || []);
        if (restored) {
          // Server was wiped (Render restart) and the device mirror just
          // rebuilt it — refresh both views to show the recovered history.
          const [s2, h2] = await Promise.all([fetchSummary(), fetchHistory()]);
          if (s2) setSummary(s2);
          if (h2) setHistory(h2);
          if (s2) reportSymbols(s2);
          setRestoredNote('history device-backup se recover hui');
          if (restoredNoteTimerRef.current) clearTimeout(restoredNoteTimerRef.current);
          restoredNoteTimerRef.current = setTimeout(() => setRestoredNote(null), 8000);
        }
      }
    } finally {
      syncingRef.current = false;
    }
    // v21.1.0 FIX (Phase-1.3): reportSymbols dep missing tha — stale closure
    // forever first-render ka onOpenSymbolsChange callback capture karta tha.
    // reportSymbols apne aap useCallback hai ([onOpenSymbolsChange]) — identity
    // sirf parent callback badalne pe change hoti hai, to yahan koi infinite
    // re-render loop nahi banega (sirf fresh closure re-subscribe hota hai).
    // v21.23.13: desk dep — scoped fetches desk badalne pe re-run karein.
  }, [reportSymbols, desk]);

  useEffect(() => { loadHistory(); }, [loadHistory, refreshKey]);
  // v21.1.1 [audit D7]: unmount pe pending restored-note timer clear
  useEffect(() => () => { if (restoredNoteTimerRef.current) clearTimeout(restoredNoteTimerRef.current); }, []);
  // v21.23.13 [SCOPED-RESTORE NOTE]: desk-scoped mode me singleton mirror
  // loop restore karta hai — yahan note dikhane ke liye event sunte hain.
  useEffect(() => {
    const onRestored = () => {
      setRestoredNote('history device-backup se recover hui');
      if (restoredNoteTimerRef.current) clearTimeout(restoredNoteTimerRef.current);
      restoredNoteTimerRef.current = setTimeout(() => setRestoredNote(null), 8000);
      void load();
      void loadHistory();
    };
    window.addEventListener(PAPER_MIRROR_RESTORED_EVENT, onRestored);
    return () => window.removeEventListener(PAPER_MIRROR_RESTORED_EVENT, onRestored);
  }, [load, loadHistory]);

  // Periodic refresh (open trades' server-side auto-management).
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 15000);
    return () => clearInterval(t);
  }, [load]);

  // History + mirror re-sync every 60s (cheap: server renders from RAM).
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadHistory();
    }, 60000);
    return () => clearInterval(t);
  }, [loadHistory]);

  const onClose = async (id: number) => {
    setClosingId(id);
    const ok = await closeTrade(id);
    if (ok) { await load(); await loadHistory(); }
    setClosingId(null);
  };

  if (!summary) return null;
  const { stats } = summary;
  if (summary.open.length === 0 && summary.closedToday.length === 0 && stats.totalRealizedPnl === 0
    && (history?.overall.totalTrades || 0) === 0) {
    return (
      <div className="quantum-panel rounded-2xl p-4 border border-purple-500/15">
        <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5 mb-1">
          <span>📈</span> Paper Trading Simulator
        </div>
        <p className="text-[11px] text-slate-500">
          Koi virtual trade nahi khula. Kisi bhi signal card par <b className="text-purple-300">📈 DESK PAPER</b> dabain
          aur engine ki levels bina real paisa lagaye test karein — T1 par 50% book, breakeven trail, SL/T2/EOD auto-manage.
        </p>
      </div>
    );
  }

  return (
    <div className="quantum-panel rounded-2xl border border-purple-500/20 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-200">📈 Paper Trading Simulator{desk === 'CRYPTO' ? ' — CRYPTO DESK (CoinDCX USDT/USDC perps + spot)' : desk === 'INDIA' ? ' — INDIA DESK (NSE)' : ''}</span>
          <span className="px-2 py-0.5 rounded-md text-[9px] font-mono font-black bg-purple-500/15 text-purple-300 border border-purple-500/30">
            {desk === 'CRYPTO' ? 'CRYPTO PAPER' : desk === 'INDIA' ? 'INDIA PAPER' : 'VIRTUAL'}
          </span>
          <span className="text-[10px] font-mono text-slate-400">
            Open {stats.openCount} • Day P&L <b className={pnlColor((stats.dayNetPnl ?? stats.dayRealizedPnl) + stats.dayUnrealizedPnl)}>
              {fmtPnl((stats.dayNetPnl ?? stats.dayRealizedPnl) + stats.dayUnrealizedPnl)}
            </b> • Total <b className={pnlColor(stats.totalNetPnl ?? stats.totalRealizedPnl)}>{fmtPnl(stats.totalNetPnl ?? stats.totalRealizedPnl)}</b>
            {(stats.totalCosts ?? 0) > 0 && (
              <span className="text-amber-500/70" title="brokerage + STT + exchange txn + SEBI + GST + stamp — env-tunable (AI_TC_*) to match your broker"> · costs {fmtPnl(stats.totalCosts ?? 0)}</span>
            )}
            {(stats.closedTotal ?? 0) > 0 && (
              <span className="text-slate-500"> · {stats.closedTotal} closed · WR <b className={((stats.winRatePct ?? 0) >= 50) ? 'text-emerald-400' : 'text-amber-400'}>{stats.winRatePct ?? '—'}%</b> · avgR <b className={(stats.avgR ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{stats.avgR ?? '—'}</b></span>
            )}
            {(stats.openRisk ?? 0) > 0 && (
              <span className="text-slate-500" title="Open positions ka total SL-risk (₹) — poora book ek saath kitna max kho sakta hai"> · open risk {fmtPnl(stats.openRisk ?? 0)}</span>
            )}
          </span>
        </div>
        <span className="text-slate-500 text-xs">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* v21.17.0 PAPER ANALYTICS — exit-quality numbers: MFE/MAE capture,
              R-distribution, exit-reason mix, source split (manual vs MTF board
              vs auto-link). Wo discipline jo manual-trade tracker dikhata hai. */}
          {((stats.closedTotal ?? 0) > 0) && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              <div className="bg-black/30 rounded-lg px-2 py-1.5" title="Closed trades: average outcome in R (1R = SL distance). +R = edge.">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">📊 AVG R · BEST / WORST</div>
                <div className={`text-[11px] font-mono font-black ${(stats.avgR ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {stats.avgR ?? '—'} <span className="text-[9px] text-slate-500">({stats.bestR ?? '—'} / {stats.worstR ?? '—'})</span>
                </div>
              </div>
              <div className="bg-black/30 rounded-lg px-2 py-1.5" title="MFE = peak favourable move (trade kitna de sakta tha) · MAE = max adverse (kitna ulta gaya) — R me.">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">📈 MFE / MAE (avg R)</div>
                <div className="text-[11px] font-mono font-black text-cyan-300">
                  {stats.avgMfeR ?? '—'} <span className="text-slate-500">/</span> <span className="text-amber-300">{stats.avgMaeR ?? '—'}</span>
                </div>
              </div>
              <div className="bg-black/30 rounded-lg px-2 py-1.5" title="Actual R ÷ MFE R — potential ka kitna % actually capture hua (exit quality).">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">🎯 CAPTURE</div>
                <div className={`text-[11px] font-mono font-black ${(stats.capturePct ?? 0) >= 50 ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {stats.capturePct != null ? `${stats.capturePct}%` : '—'}
                </div>
              </div>
              <div className="bg-black/30 rounded-lg px-2 py-1.5" title="Exit-reason mix (T1/SL/T2/BE-trail/SL_TRAIL/EOD) — engine kis raaste se band karta hai.">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">🚪 EXIT MIX</div>
                <div className="text-[10px] font-mono text-slate-300 truncate">
                  {Object.entries(stats.exitMix || {}).map(([k, v]) => `${k}×${v}`).join(' · ') || '—'}
                </div>
              </div>
              {Object.keys(stats.bySource || {}).length > 0 && (
                <div className="bg-black/30 rounded-lg px-2 py-1.5 col-span-2 sm:col-span-4" title="Manual (📈) vs MTF board (🧪) vs auto-link (🔗) — kis raaste ki entries kaise perform kar rahi hain.">
                  <div className="text-[8px] text-slate-500 font-black tracking-wider">🧬 SOURCE SPLIT (closed)</div>
                  <div className="text-[10px] font-mono text-slate-300">
                    {Object.entries(stats.bySource || {}).filter(([, v]) => v.n > 0).map(([k, v]) => (
                      <span key={k} className="mr-2">
                        <span className={k === 'mtf-auto' ? 'text-emerald-300' : k === 'mtf-board-ui' ? 'text-cyan-300' : 'text-slate-300'}>{k}</span>
                        {' '}{v.n}t · {v.n ? `${Math.round((v.wins / v.n) * 100)}%W` : '—'} · <span className={v.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtPnl(v.pnl)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {summary.open.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider px-1 pb-1">Open Virtual Trades</div>
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-white/10 text-[9px] uppercase text-slate-500">
                    <th className="px-2 py-1 text-left">Symbol</th>
                    <th className="px-2 py-1">Entry</th>
                    <th className="px-2 py-1">LTP</th>
                    <th className="px-2 py-1">Qty</th>
                    <th className="px-2 py-1">P&L</th>
                    <th className="px-2 py-1">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.open.map(t => (
                    <TradeRow key={t.id} t={t} live={livePrices[`${t.market || 'INDIA'}|${t.symbol}`] || livePrices[t.symbol]} onClose={onClose} closing={closingId === t.id} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {summary.closedToday.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider px-1 pb-1">Closed Today</div>
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-white/10 text-[9px] uppercase text-slate-500">
                    <th className="px-2 py-1 text-left">Symbol</th>
                    <th className="px-2 py-1">Entry</th>
                    <th className="px-2 py-1">Exit</th>
                    <th className="px-2 py-1">Qty</th>
                    <th className="px-2 py-1">P&L</th>
                    <th className="px-2 py-1" title="Peak favourable excursion (R) — trade kitna de sakta tha">MFE</th>
                    <th className="px-2 py-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.closedToday.map(t => {
                    const exit = t.parts.length ? t.parts[t.parts.length - 1].exitPrice : t.entry;
                    return (
                      <tr key={t.id} className="border-b border-white/5">
                        <td className="px-2 py-1.5">
                          <span className="font-black text-slate-200" title={t.assetKind === 'OPTION' ? `${t.label || t.symbol} · lot ${t.lotSize}` : undefined}>
                            {t.assetKind === 'OPTION' ? (t.label || t.symbol) : t.symbol}
                          </span>
                          <span className={`ml-1 text-[9px] font-black ${t.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
                            {t.direction === 'LONG' ? 'L' : 'S'}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-center text-cyan-200">{px(t.entry, t)}</td>
                        <td className="px-2 py-1.5 text-center text-slate-300">{px(exit, t)}</td>
                        <td className="px-2 py-1.5 text-center text-slate-400">{t.qty}</td>
                        <td className={`px-2 py-1.5 text-center font-bold ${pnlColor(t.netPnl ?? t.realizedPnl)}`} title={`gross ${fmtPnl(t.realizedPnl, t)} − costs ${fmtPnl(t.costs ?? 0, t)}`}>
                          {fmtPnl(t.netPnl ?? t.realizedPnl, t)}
                          {(t.costs ?? 0) > 0 && <span className="ml-0.5 text-[8px] font-black text-amber-500/70">net</span>}
                        </td>
                        <td className="px-2 py-1.5 text-center text-cyan-300/80" title={`MFE ${t.mfeR ?? '—'}R · MAE ${t.maeR ?? '—'}R`}>{t.mfeR != null ? `${t.mfeR}R` : '—'}</td>
                        <td className="px-2 py-1.5 text-center text-[9px] text-slate-500">
                          {t.closeReason}
                          {t.source && t.source !== 'ui' && (
                            <span className={`ml-1 px-1 rounded text-[8px] font-black ${t.source === 'mtf-auto' ? 'bg-emerald-500/15 text-emerald-300' : t.source === 'mtf-board-ui' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-slate-500/15 text-slate-400'}`}
                              title={t.sourceMeta ? `source: ${t.source} · score ${t.sourceMeta.score ?? '—'} ${t.sourceMeta.tier ?? ''} · ${t.sourceMeta.mode ?? ''} ${t.sourceMeta.holdMin ?? ''}m` : `source: ${t.source}`}>
                              {t.source === 'mtf-auto' ? '🔗 auto' : t.source === 'mtf-board-ui' ? '🧪 board' : t.source}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {history && <HistorySection history={history} />}
          {restoredNote && (
            <p className="text-[9px] text-emerald-400 font-mono text-center">✓ {restoredNote}</p>
          )}
          <p className="text-[9px] text-slate-600 font-mono text-center pt-1 border-t border-white/5">
            Virtual trades only — no real money. Auto-managed: T1 → 50% book + breakeven trail • SL/T2 hit → close • 15:10 IST square-off.
            History server + device mirror me durable hai.
            P&L numbers NET hain — brokerage + STT + exchange txn + SEBI + GST + stamp deduct ho chuke hain (AI_TC_* env se apne broker ke rates pin karo); gross tooltip me.
          </p>
        </div>
      )}
    </div>
  );
}
