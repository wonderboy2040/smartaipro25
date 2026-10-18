// ============================================================
// src/components/aitrading/MarketClockStrip.tsx — v6.9
// ------------------------------------------------------------
// India desk ka NSE session clock: live IST time + session phase
// (PRE-OPEN / LIVE / NO-FRESH-ENTRY / SQUARE-OFF / CLOSED) +
// countdown to the next session event. All client-side, ticks
// every second, honest on weekends/holidays (phase from clock,
// open/closed confirmation from the board's marketOpen flag).
// ============================================================
import { memo, useEffect, useState } from 'react';

/** IST parts from any local clock (timezone-proof). */
function istNow(): { h: number; m: number; s: number; dow: number; label: string } {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    h: ist.getHours(), m: ist.getMinutes(), s: ist.getSeconds(),
    dow: ist.getDay(), // 0 Sun … 6 Sat
    label: `${pad(ist.getHours())}:${pad(ist.getMinutes())}:${pad(ist.getSeconds())} IST`,
  };
}

type Phase = 'WEEKEND' | 'PRE_OPEN' | 'LIVE' | 'NO_FRESH' | 'SQUARE_OFF' | 'CLOSED';

function phaseFor(h: number, m: number, dow: number): { phase: Phase; note: string; tone: string } {
  const mins = h * 60 + m;
  if (dow === 0 || dow === 6) return { phase: 'WEEKEND', note: 'Weekend — market Monday 09:15 khulega', tone: 'text-slate-400 bg-slate-600/20 border-slate-600/30' };
  if (mins < 9 * 60) return { phase: 'CLOSED', note: 'Market band — 09:00 pre-open', tone: 'text-slate-400 bg-slate-600/20 border-slate-600/30' };
  if (mins < 9 * 60 + 15) return { phase: 'PRE_OPEN', note: 'Pre-open auction — orders queue ho rahe hain', tone: 'text-amber-300 bg-amber-500/10 border-amber-500/30' };
  if (mins < 15 * 60) return { phase: 'LIVE', note: 'NSE LIVE — fresh entries open hain', tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' };
  if (mins < 15 * 60 + 15) return { phase: 'NO_FRESH', note: '15:00 se NAYA entry avoid — sirf exit manage karo', tone: 'text-orange-300 bg-orange-500/10 border-orange-500/30' };
  if (mins < 15 * 60 + 30) return { phase: 'SQUARE_OFF', note: 'SQUARE-OFF window — watcher + broker dono force-close karenge', tone: 'text-red-300 bg-red-500/10 border-red-500/30' };
  return { phase: 'CLOSED', note: 'Market band — kal 09:15', tone: 'text-slate-400 bg-slate-600/20 border-slate-600/30' };
}

/** Countdown string to the next event boundary (client-side, IST). */
function nextEventCountdown(h: number, m: number, dow: number): string {
  const mins = h * 60 + m;
  const boundaries: Array<[number, string]> = dow === 0 || dow === 6
    ? [] // weekend — no countdown today
    : [
        [9 * 60, 'pre-open'],
        [9 * 60 + 15, 'market OPEN'],
        [15 * 60, 'no-fresh-entry'],
        [15 * 60 + 15, 'square-off'],
        [15 * 60 + 30, 'market CLOSE'],
      ];
  for (const [t, label] of boundaries) {
    if (mins < t) {
      const left = t - mins;
      return `${Math.floor(left / 60)}h ${left % 60}m → ${label}`;
    }
  }
  return 'kal 09:00 pre-open';
}

export const MarketClockStrip = memo(function MarketClockStrip({ marketOpen }: { marketOpen?: boolean }) {
  const [t, setT] = useState(istNow);
  useEffect(() => {
    // v20.8.4 FIX (L — hidden-tab gate parity): every sibling clock (App
    // IstClock, deskShared, deepAnalysisExtras) parks its 1s ticker while
    // the tab is hidden; this one kept ticking. Browser-throttled to ~1/min
    // anyway, but consistency + zero wasted renders.
    const tick = () => { if (!document.hidden) setT(istNow()); };
    const id = setInterval(tick, 1000);
    const onVis = () => tick();
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  const { phase, note, tone } = phaseFor(t.h, t.m, t.dow);
  const label = phase === 'WEEKEND' ? 'WEEKEND' : phase === 'PRE_OPEN' ? 'PRE-OPEN'
    : phase === 'LIVE' ? 'LIVE' : phase === 'NO_FRESH' ? 'NO FRESH ENTRY'
    : phase === 'SQUARE_OFF' ? 'SQUARE-OFF' : 'CLOSED';
  const dot = phase === 'LIVE' ? 'bg-emerald-400 animate-pulse' : phase === 'NO_FRESH' || phase === 'SQUARE_OFF' ? 'bg-red-400 animate-pulse' : 'bg-slate-500';

  return (
    <div className="quantum-panel rounded-2xl px-4 py-2.5 flex items-center gap-3 flex-wrap" aria-label="NSE market clock">
      <span className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dot}`} aria-hidden="true" />
        <span className="text-[10px] font-black tracking-wider text-slate-500">NSE</span>
      </span>
      <span className="font-mono text-sm font-black text-slate-100 tabular-nums">{t.label}</span>
      <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black border tracking-wider ${tone}`}>{label}</span>
      <span className="text-[11px] text-slate-400">{note}</span>
      <span className="ml-auto text-[10px] font-mono font-bold text-cyan-300">{nextEventCountdown(t.h, t.m, t.dow)}</span>
      {marketOpen === false && phase === 'LIVE' && (
        <span className="text-[9px] font-bold text-amber-400" title="Board data nahi mila (holiday ho sakti hai)">⚠ data offline</span>
      )}
    </div>
  );
});
