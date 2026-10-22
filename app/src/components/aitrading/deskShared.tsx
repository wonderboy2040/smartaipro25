// ============================================================
// src/components/aitrading/deskShared.tsx — v6.9 + v6.10
// ------------------------------------------------------------
// Shared building blocks for the two SPLIT desks (IndiaIntradayTab
// + CoinDcxTab): section labels, regime chips, breadth meter,
// board filters, refresh countdown, summary chips, the India
// how-to guide and the v6.10 DESK STATS quick-glance strip.
// Extracted from the old single AI Trading tab so each desk
// stays visually consistent while fully separate.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import type { MarketKind, SignalBoard } from './types';

// v18.9 HONESTY FIX: the countdown ring counts down to REFRESH_MS but the
// board hook polls at 60s (useAITrading) — the ring used to reset TWICE
// with zero refresh ("desk frozen?" feeling). 60s now matches reality.
const REFRESH_MS = 60_000;

export function SectionLabel({ num, title, sub }: { num: string; title: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-2.5 pt-2">
      <span className="text-[10px] font-black font-mono text-cyan-500/70">{num}</span>
      <span className="text-sm font-black text-slate-100 tracking-wide uppercase">{title}</span>
      {sub && <span className="text-[10px] text-slate-500 hidden sm:inline">— {sub}</span>}
    </div>
  );
}

/** Live regime chips (NIFTY/VIX for India, BTC for crypto desks). */
export function RegimeChips({ board, market }: { board: SignalBoard | null; market: MarketKind }) {
  const regime = board?.regime;
  const chips = market === 'INDIA'
    ? [
        regime?.niftyChange != null ? { label: 'NIFTY', v: `${regime.niftyChange >= 0 ? '+' : ''}${regime.niftyChange.toFixed(2)}%`, bull: regime.niftyChange >= 0 } : null,
        regime?.indiaVix != null ? { label: 'VIX', v: regime.indiaVix.toFixed(1), bull: regime.indiaVix < 15 } : null,
      ].filter(Boolean) as { label: string; v: string; bull: boolean }[]
    : (regime?.btcChange != null ? [{ label: 'BTC 24h', v: `${regime.btcChange >= 0 ? '+' : ''}${regime.btcChange.toFixed(2)}%`, bull: regime.btcChange >= 0 }] : []);
  return (
    <>
      {chips.map(c => (
        <span key={c.label} className="px-2 py-1 rounded-lg bg-black/30 text-[10px] font-mono font-bold">
          <span className="text-slate-500">{c.label} </span>
          <span className={c.bull ? 'text-emerald-400' : 'text-red-400'}>{c.v}</span>
        </span>
      ))}
    </>
  );
}

/** Live bull/bear/flat breadth meter across the scanned universe. */
export const BreadthStrip = memo(function BreadthStrip({ board }: { board: SignalBoard | null }) {
  const b = board?.breadth;
  if (!b) return null;
  const total = Math.max(1, b.bull + b.bear + b.flat);
  const bullPct = (b.bull / total) * 100;
  const bearPct = (b.bear / total) * 100;
  const flatPct = 100 - bullPct - bearPct;
  const mood = bullPct - bearPct;
  const label = mood > 25 ? 'RISK-ON' : mood < -25 ? 'RISK-OFF' : 'MIXED';
  const moodCls = mood > 25 ? 'text-emerald-400' : mood < -25 ? 'text-red-400' : 'text-amber-400';
  return (
    <div className="quantum-panel rounded-2xl px-4 py-3" aria-label="Market breadth">
      <div className="flex items-center gap-3 flex-wrap text-[10px] font-black">
        <span className="text-slate-500 tracking-wider">MARKET BREADTH</span>
        <span className="text-emerald-400 font-mono">▲ {b.bull} BULL</span>
        <span className="text-red-400 font-mono">▼ {b.bear} BEAR</span>
        <span className="text-slate-500 font-mono">· {b.flat} FLAT</span>
        <span className={`ml-auto font-mono ${moodCls}`}>{label} {mood >= 0 ? '+' : ''}{Math.round(mood)}</span>
        <span className="text-slate-600 font-mono">avg conf {b.avgConf}%</span>
      </div>
      <div className="flex h-2 mt-2 rounded-full overflow-hidden bg-black/40" role="img" aria-label={`breadth ${Math.round(bullPct)}% bull`}>
        <div className="bg-emerald-500/80" style={{ width: `${bullPct}%` }} />
        <div className="bg-slate-600/60" style={{ width: `${flatPct}%` }} />
        <div className="bg-red-500/80" style={{ width: `${bearPct}%` }} />
      </div>
      {/* v21.23.4 WRONG-SIGNAL-REMOVAL banner: data-degraded symbols ka
          signal REMOVE hua (15m/1h series missing — daily-fallback
          "90% opposite" disease). Ye banner hi honest answer hai: "kyun
          itne kam signals?" / "kyun kuch symbols gayab?" — fabricated
          ulta-direction nahi, honest suppress. */}
      {(board?.degraded?.count ?? 0) > 0 && (
        <div className="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-amber-200 text-[10px] font-bold leading-relaxed" title={(board?.degraded?.symbols || []).map(s => `${s.symbol}: ${s.reason}`).join('\n')}>
          ⚠ {board!.degraded!.count} SYMBOL{(board!.degraded!.count ?? 0) === 1 ? '' : 'S'} SUPPRESSED — {board!.degraded!.note || 'intraday data unavailable (daily-fallback opposite-trend signals removed by design)'}
        </div>
      )}
    </div>
  );
});

export type BoardFilter = 'ALL' | 'ACTION' | 'STRONG' | 'SUPER' | 'LONG' | 'SHORT';

/** v6.10 DESK STATS — the one-glance "desk kaisa hai" strip:
 *  scanned universe · actionable · STRONG · avg confidence · breadth mood.
 *  Five compact stat tiles directly under the command bar so the user
 *  never has to scroll into the board to answer "aaj kuch hai kya?"
 *  Degrades to a slim placeholder while the first board loads. */
export const DeskStatsStrip = memo(function DeskStatsStrip({ board, deskLabel }: { board: SignalBoard | null; deskLabel: string }) {
  const sigs = board?.signals || [];
  const strong = sigs.filter(s => s.grade === 'STRONG').length;
  const actionable = sigs.filter(s => s.grade === 'ACTION' || s.grade === 'STRONG').length;
  // v13.1 SVA — the verifier's verdict tally on the board: how many
  // signals did the pro-trader layer CONFIRM vs CAUTION vs reject
  // (FLIP/STAND_ASIDE)? The desk's honest "kitne pakke setups hain"
  // number — one glance, no scroll.
  const vConfirmed = sigs.filter(s => s.verify?.action === 'CONFIRM').length;
  const vCaution = sigs.filter(s => s.verify?.action === 'CAUTION').length;
  const vRejected = sigs.filter(s => s.verify && (s.verify.action === 'FLIP' || s.verify.action === 'STAND_ASIDE')).length;
  const b = board?.breadth;
  // v18.9: SAME MATH as BreadthStrip — percentage points, not raw symbol
  // counts. A 400-symbol universe (220 bull / 180 bear) used to read
  // MIXED on one strip and RISK-ON on the other (raw +40 vs +10pp).
  const moodPP = b && (b.bull + b.bear + (b.flat || 0)) > 0
    ? Math.round(((b.bull - b.bear) / Math.max(1, b.bull + b.bear + (b.flat || 0))) * 100)
    : null;
  const mood = moodPP;
  const moodTxt = mood == null ? '—' : mood > 25 ? 'RISK-ON' : mood < -25 ? 'RISK-OFF' : 'MIXED';
  const moodCls = mood == null ? 'text-slate-400' : mood > 25 ? 'text-emerald-400' : mood < -25 ? 'text-red-400' : mood < 0 ? 'text-amber-400' : 'text-amber-400';
  const stats: { label: string; value: string; cls?: string; title: string }[] = [
    { label: 'SCANNED', value: board ? `${board.scanned ?? 0}` : '…', title: 'Universe symbols the ensemble scanned' },
    { label: 'SIGNALS', value: `${sigs.length}`, title: 'Rows on the board (any grade)' },
    { label: 'ACTION+', value: `${actionable}`, cls: actionable > 0 ? 'text-cyan-300' : 'text-slate-400', title: 'STRONG + ACTION. Sirf STRONG live-executable hai (75%+ conf + 70%+ agreement); ACTION paper-practice grade hai.' },
    { label: 'STRONG', value: `${strong}`, cls: strong > 0 ? 'text-emerald-300' : 'text-slate-400', title: 'LIVE-executable: full-committee agreement (75%+ conf + 70%+ agreement)' },
    { label: 'VERIFIED', value: sigs.some(s => s.verify) ? `${vConfirmed}` : '—', cls: vConfirmed > 0 ? 'text-emerald-300' : 'text-slate-400', title: `SVA pro-trader CONFIRM verdicts — full-risk setups${sigs.some(s => s.verify) ? ` (caution ${vCaution} · rejected ${vRejected})` : ''}` },
    { label: 'AVG CONF', value: b ? `${Math.round(b.avgConf ?? 0)}%` : '—', title: 'Average confidence across the board' },
    { label: 'MOOD', value: moodTxt, cls: moodCls, title: 'Breadth mood (bull − bear)' },
  ];
  return (
    <div className="quantum-panel rounded-2xl px-3.5 py-2.5" aria-label={`${deskLabel} desk stats`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] font-black text-slate-400 tracking-widest">{deskLabel}</span>
        {b && (
          <span className="ml-auto text-[9px] font-mono text-slate-500">
            ▲{b.bull} ▼{b.bear} ·{b.flat}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-7 gap-2">
        {stats.map(s => (
          <div key={s.label} className="bg-black/25 rounded-xl px-2 py-1.5 text-center" title={s.title}>
            <div className="text-[8px] font-black text-slate-500 tracking-wider">{s.label}</div>
            <div className={`text-sm font-black font-mono ${s.cls ?? 'text-slate-100'}`}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
});

const FILTERS: { id: BoardFilter; label: string }[] = [
  { id: 'ALL', label: 'ALL' },
  { id: 'SUPER', label: '🔥 80+' },
  { id: 'ACTION', label: '⚡ ACTION+ (paper)' },
  { id: 'STRONG', label: '★ STRONG' },
  { id: 'LONG', label: '▲ LONG' },
  { id: 'SHORT', label: '▼ SHORT' },
];

export function FilterChips({ filter, onChange, counts }: { filter: BoardFilter; onChange: (f: BoardFilter) => void; counts: Record<BoardFilter, number> }) {
  return (
    <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Signal filters">
      {FILTERS.map(f => (
        <button key={f.id} onClick={() => onChange(f.id)} aria-pressed={filter === f.id}
          className={`px-2.5 py-1 rounded-lg text-[10px] font-black tracking-wide transition-colors border ${filter === f.id
            ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
            : 'bg-black/20 text-slate-500 border-slate-700/40 hover:text-slate-300'}`}>
          {f.label} <span className="font-mono opacity-70">{counts[f.id] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

/** Countdown ring to the next auto-refresh.
 *  v20.7.12 [H3-6/L-6]: countdown ab board.generatedAt se DERIVE hota hai
 *  (pehle apna independent 60s counter chalata tha jo generatedAt ke
 *  60s cycle se desync ho jata tha — ring aadhe cycle me galat dikhti
 *  thi + tooltip "every 60s" jhootha lagta tha jab poll 30s ka tha).
 *  Ab ring HAMESHA exactly generatedAt+60s pe count karta hai, aur 1s
 *  ticker hidden tab me band rehta hai (bg renders zero). */
export function RefreshCountdown({ board, loading }: { board: SignalBoard | null; loading: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(t);
  }, []);
  const genAt = board?.generatedAt ?? 0;
  const left = genAt ? Math.max(0, Math.ceil((genAt + REFRESH_MS - now) / 1000)) : REFRESH_MS / 1000;
  const pct = Math.max(0, Math.min(100, (left / (REFRESH_MS / 1000)) * 100));
  const age = board ? Math.max(0, Math.round((now - board.generatedAt) / 1000)) : 0;
  return (
    <span className="px-2 py-1 rounded-lg bg-black/30 text-[9px] font-mono font-bold text-slate-500 flex items-center gap-1.5" title={`Board server pe har ~60s recompute hota hai (generatedAt ${new Date(genAt).toLocaleTimeString('en-IN', { hour12: false })}) — ring usi cycle pe synced hai`}>
      {loading ? <span className="inline-block animate-spin">🔄</span> : <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-60 animate-ping" /><span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" /></span>}
      <span className="relative w-8 h-1 rounded-full bg-black/40 overflow-hidden" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 bg-cyan-500/70 rounded-full" style={{ width: `${100 - pct}%` }} />
      </span>
      {left}s · age {age}s
    </span>
  );
}

// ---------------- v10.9 #8: SIGNAL FRESHNESS DECAY ----------------
// The Intraday tab's 5-min stale concept applied to the ensemble boards.
// The 30s auto-refresh keeps boards fresh; when it breaks (network drop,
// throttled background tab, server restart) the user must SEE the
// decay instead of trusting an old signal. Prices on cards may still be
// SSE-live — this badge grades the SIGNAL COMPUTE, not the price feed.
export function boardAgeInfo(board: SignalBoard | null, now = Date.now()): { ageMin: number | null; level: 'none' | 'live' | 'aging' | 'stale' } {
  if (!board?.generatedAt) return { ageMin: null, level: 'none' };
  const ageMin = Math.max(0, (now - board.generatedAt) / 60_000);
  const level = ageMin < 2 ? 'live' : ageMin < 5 ? 'aging' : 'stale';
  return { ageMin, level };
}

/** Opacity ramp for the signal grid — the visual decay. */
export function boardStaleClass(board: SignalBoard | null, now = Date.now()): string {
  const { level } = boardAgeInfo(board, now);
  if (level === 'aging') return 'opacity-80 transition-opacity';
  if (level === 'stale') return 'opacity-50 transition-opacity';
  return '';
}

/** LIVE (green pulse) → aging (amber "Xm old") → STALE (red pulsing). */
export function FreshnessBadge({ board }: { board: SignalBoard | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(v => v + 1), 15_000); // re-grade every 15s
    return () => clearInterval(t);
  }, []);
  const { ageMin, level } = boardAgeInfo(board);
  if (ageMin == null || level === 'none') return null;
  if (level === 'live') {
    return (
      <span className="px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[9px] font-mono font-bold flex items-center gap-1.5" title="Signal compute fresh — board generated < 2 min ago. Prices stream live via SSE separately.">
        <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" /><span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" /></span>
        LIVE
      </span>
    );
  }
  const m = Math.floor(ageMin);
  if (level === 'aging') {
    return (
      <span className="px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[9px] font-mono font-bold" title="Board generated 2-5 min ago — signals aging, auto-refresh should catch up soon.">
        ⏳ {m}m old
      </span>
    );
  }
  return (
    <span className="px-2 py-1 rounded-lg bg-red-500/15 border border-red-500/40 text-red-300 text-[9px] font-mono font-bold animate-pulse" title="STALE — board older than 5 min. Card prices may be SSE-live, but this signal compute is OLD. Verify with a manual refresh before acting.">
      ⚠ STALE {m}m
    </span>
  );
}

export function BoardSummary({ board }: { board: SignalBoard | null }) {
  if (!board) return null;
  const strong = (board.signals || []).filter(s => s.grade === 'STRONG').length;
  const actionable = (board.signals || []).filter(s => s.grade === 'ACTION' || s.grade === 'STRONG').length;
  return (
    <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold">
      <span className="px-2 py-1 rounded-lg bg-black/30 text-slate-400 font-mono">{board.scanned || 0} scanned</span>
      <span className="px-2 py-1 rounded-lg bg-black/30 text-slate-400 font-mono">{(board.signals || []).length} signals</span>
      <span className={`px-2 py-1 rounded-lg border ${strong > 0 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40 animate-pulse' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}>★ {strong} STRONG</span>
      <span className={`px-2 py-1 rounded-lg border ${actionable > 0 ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}>⚡ {actionable} ACTION+ <span className="text-slate-500 font-normal">(paper)</span></span>
    </div>
  );
}

/** Board filter computation shared by both desks. */
export function filterSignals(board: SignalBoard | null, filter: BoardFilter) {
  const sigs = board?.signals || [];
  switch (filter) {
    case 'SUPER': return sigs.filter(s => (s.superIntel?.aiScore ?? 0) >= 80);
    case 'ACTION': return sigs.filter(s => s.grade === 'ACTION' || s.grade === 'STRONG');
    case 'STRONG': return sigs.filter(s => s.grade === 'STRONG');
    case 'LONG': return sigs.filter(s => s.side === 'LONG' && s.grade !== 'NEUTRAL');
    case 'SHORT': return sigs.filter(s => s.side === 'SHORT' && s.grade !== 'NEUTRAL');
    default: return sigs;
  }
}

export function countSignals(board: SignalBoard | null): Record<BoardFilter, number> {
  const sigs = board?.signals || [];
  return {
    ALL: sigs.length,
    SUPER: sigs.filter(s => (s.superIntel?.aiScore ?? 0) >= 80).length,
    ACTION: sigs.filter(s => s.grade === 'ACTION' || s.grade === 'STRONG').length,
    STRONG: sigs.filter(s => s.grade === 'STRONG').length,
    LONG: sigs.filter(s => s.side === 'LONG' && s.grade !== 'NEUTRAL').length,
    SHORT: sigs.filter(s => s.side === 'SHORT' && s.grade !== 'NEUTRAL').length,
  };
}

/** The "India me trade kaisa lein" answer, on the board itself —
 *  3-step manual broker flow. Collapsible, dismissal remembered. */
const HOWTO_KEY = 'ai-india-howto-dismissed';
export function IndiaHowToTrade() {
  const [open, setOpen] = useState(() => {
    try { return !localStorage.getItem(HOWTO_KEY); } catch { return true; }
  });
  const dismiss = () => {
    setOpen(false);
    try { localStorage.setItem(HOWTO_KEY, '1'); } catch { /* private mode */ }
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="quantum-btn-ghost px-3 py-1.5 rounded-xl text-[10px] font-black text-orange-300">
        🇮🇳 India trade kaise lein? — 3-step guide
      </button>
    );
  }
  return (
    <div className="quantum-panel rounded-2xl p-4 border border-orange-500/20 bg-gradient-to-r from-orange-500/[0.05] to-transparent">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-black text-orange-300 tracking-wide">🇮🇳 INDIA DESK — SIGNAL SE TRADE TAK (3 steps)</span>
        <button onClick={dismiss} className="quantum-btn-ghost px-2 py-1 rounded-lg text-[10px] font-black" aria-label="Dismiss guide">✕ Got it</button>
      </div>
      <div className="grid gap-2 md:grid-cols-3 mt-2.5 text-[11px] leading-relaxed">
        <div className="bg-black/25 rounded-xl p-2.5">
          <div className="text-[10px] font-black text-cyan-300 mb-1">① TOP 6 DEEP-TREND SIGNAL CHUNO (grade dekho)</div>
          <p className="text-slate-400">
            <b className="text-cyan-300">📡 TOP 6 DEEP-TREND SIGNALS</b> = 8 Institutional + 10 World Top Indicators + 3-Model Local Ollama AI se confluence-verified LONG/SHORT setups.
            <b className="text-cyan-300"> ★ ELITE / STRONG</b> = full committee agree (75%+ conf) — yehi LIVE-executable grade hai (guaranteed accuracy claim nahi — ledger-calibrated win-rate hi dekho).
            <b className="text-cyan-300"> ⚡ ACTION</b> (55%+) sirf PAPER practice grade hai — LIVE order sirf ★ STRONG par jaata hai. Grade decision-gate pe lock hota hai, isliye quality/MTF boosts ke baad conf 75%+ dikh sakta hai bina badge upgrade ke.
            <span className="text-slate-500"> 9:30–14:30 ke beech entry best hai.</span>
          </p>
        </div>
        <div className="bg-black/25 rounded-xl p-2.5">
          <div className="text-[10px] font-black text-orange-300 mb-1">② 🚀 TRADE TICKET — one-click, sab pre-computed</div>
          <p className="text-slate-400">
            Pick ya card par <b className="text-cyan-300">🚀 TRADE</b> button dabao — <b>budget ₹ daalo, qty + ₹ risk @ SL + ₹ profit @ T2 + R:R sab instant</b>
            calculate ho jaata hai (same math server use karta hai). <b className="text-cyan-300">PAPER EXECUTE</b> one-click practice (watcher SL/TP + trailing + 15:15 square-off manage karega).
            Manual broker chahiye? <b className="text-orange-300">📋 Slip</b> button me risk-sized order slip + COPY for Zerodha/Upstox.
          </p>
        </div>
        <div className="bg-black/25 rounded-xl p-2.5">
          <div className="text-[10px] font-black text-violet-300 mb-1">③ DHAN LIVE ya OPTIONS DESK (small capital)</div>
          <p className="text-slate-400">
            <span className="text-emerald-300"><b>Dhan broker connect</b> karke (Execution Console me) STRONG India signals par direct <b>LIVE execution</b> — entry market order + broker SL-M + 15:15 square-off, sab automated.</span>
            Capital kam hai ya index pe trade karna hai? Neeche <b className="text-violet-300">Options Desk</b>
            me NIFTY/BANKNIFTY ki ready strategies (spread/condor) — legs, max profit/loss, breakeven sab priced.
          </p>
        </div>
      </div>
      <p className="text-[10px] text-slate-500 mt-2">
        Crypto/CoinDCX ab apna alag tab hai (₿ CoinDCX) — wahan wallet + GLOBAL FUTURES (USDT) + EQUITY SIM + Auto-Agent sab ek jagah (v21.0.5: SPOT desk remove ho chuka hai). Intraday rules: square-off 15:15 IST (LIVE par watcher + broker dono enforce karte hain), opening 15 min avoid karo — LIVE entries 09:30–15:00 tak hi open hoti hain.
      </p>
    </div>
  );
}

// ------------------------------------------------------------
// v6.13 — SIMPLE / PRO desk view.
// User feedback: "UI bahut mixup ho gaya" — 12 sections ek saath
// dikhna overwhelming tha. SIMPLE (default) = sirf trade-flow
// (TOP5 → SIGNALS → OPTIONS/AGENT → EXECUTE); PRO = poora desk.
// Choice localStorage me persist hoti hai (dono desks share).
// ------------------------------------------------------------
export type DeskViewMode = 'simple' | 'pro';

const DESK_VIEW_KEY = 'smartai-desk-view';

export function useDeskViewMode(): [DeskViewMode, (m: DeskViewMode) => void] {
  const [mode, setMode] = useState<DeskViewMode>(() => {
    try { return localStorage.getItem(DESK_VIEW_KEY) === 'pro' ? 'pro' : 'simple'; } catch { return 'simple'; }
  });
  const set = useCallback((m: DeskViewMode) => {
    try { localStorage.setItem(DESK_VIEW_KEY, m); } catch { /* private mode — state-only */ }
    setMode(m);
  }, []);
  return [mode, set];
}

export const ViewModeToggle = memo(function ViewModeToggle({ mode, onSet }: { mode: DeskViewMode; onSet: (m: DeskViewMode) => void }) {
  return (
    <div className="flex gap-0.5 quantum-panel p-0.5 rounded-xl" role="group" aria-label="desk view mode">
      <button data-desk-view="simple" onClick={() => onSet('simple')} aria-pressed={mode === 'simple'}
        title="SIMPLE — sirf trade-flow: TOP 5 · SIGNALS · OPTIONS/AGENT · EXECUTE"
        className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition-colors ${mode === 'simple' ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
        SIMPLE
      </button>
      <button data-desk-view="pro" onClick={() => onSet('pro')} aria-pressed={mode === 'pro'}
        title="PRO — poora desk: Brief · Sectors · Swing · Backtest · Alerts · Models · Ledger · Trust · Correlations"
        className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition-colors ${mode === 'pro' ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
        PRO
      </button>
    </div>
  );
});

/** v6.13: SIMPLE mode ke neeche chhota footer — kya chhupa hai, kaise kholega. */
export const ProSectionsNote = memo(function ProSectionsNote({ names }: { names: string }) {
  return (
    <div className="quantum-panel rounded-xl px-3 py-2 flex items-center gap-2 flex-wrap" role="note">
      <span className="text-[10px] font-black text-violet-300 tracking-wider">🔬 PRO VIEW</span>
      <span className="text-[10px] text-slate-400 leading-relaxed">
        baaki sections abhi chhupe hain — <b className="text-slate-300">{names}</b>. Sab dikhana ho to upar <b className="text-violet-300">PRO</b> chip dabao (yaad rakha jaata hai).
      </span>
    </div>
  );
});
