// ============================================================
// src/components/aitrading/NearMissPanel.tsx — v11.0 PHASE 3
// ------------------------------------------------------------
// The PRECISION GATE's transparency surface: SUPPRESSED verdicts +
// unke gate reasons. Education + system trust dono — the user sees
// WHAT the council almost published and WHY the gate said no
// (quorum thin? confidence 71 vs 78? counter-regime? event
// blackout?). The weekly review analyzes the same records.
// Collapsible, 60s poll, document.hidden gated.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { fetchCouncilNearMiss } from './useAITrading';
import type { NearMissEntry } from './types';

const ageTxt = (ts: number) => {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (min < 60) return `${min}m pehle`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h pehle` : `${Math.round(h / 24)}d pehle`;
};
const dirCls = (s: string) => (s === 'LONG' ? 'text-emerald-300' : s === 'SHORT' ? 'text-red-300' : 'text-slate-500');

interface Props {
  /** limit the poll when the desk wants a tighter window */
  limit?: number;
}

export const NearMissPanel = memo(function NearMissPanel({ limit = 20 }: Props) {
  const [entries, setEntries] = useState<NearMissEntry[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (document.hidden) return;
    setEntries(await fetchCouncilNearMiss(false, limit));
  }, [limit]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="quantum-panel rounded-2xl">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        aria-label="Council near-miss journal"
      >
        <span className="text-xs font-black text-slate-200">
          ⊘ NEAR-MISS JOURNAL — gate ne kya roka {entries.length > 0 && <span className="text-slate-500 font-mono text-[10px]">({entries.length})</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-violet-500/10 text-violet-300 border border-violet-500/20">v11.0</span>
          <span className="text-slate-500 text-[10px] font-black">{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          {entries.length === 0 && (
            <div className="text-[10px] text-slate-600 py-1">
              Koi suppressed verdict nahi — ya to council OFF hai, ya gate ko sab kuch pass hua (dono acche signs hain). Records durably persist hote hain (cap 200).
            </div>
          )}
          {entries.slice(0, 12).map(e => (
            <div key={e.id} className="bg-black/20 rounded-xl p-2.5 border border-white/5">
              <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
                <span className="text-[11px] font-black text-white">{e.symbol}</span>
                <span className={`font-black ${dirCls(e.side)}`}>{e.side === 'LONG' ? '▲' : e.side === 'SHORT' ? '▼' : '—'} {e.side}</span>
                <span className="text-slate-600">{e.market}</span>
                <span className="text-slate-500">conf {Math.round(e.confidence)} · agree {Math.round(e.agreement * 100)}% · q {e.quorum}/6</span>
                <span className="text-slate-600 ml-auto">{ageTxt(e.ts)}</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {(e.gateReasons || []).slice(0, 4).map((r, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-300 border border-amber-500/20">{r}</span>
                ))}
              </div>
              {e.voters && e.voters.length > 0 && (
                <div className="text-[9px] text-slate-600 mt-1 font-mono truncate" title={e.voters.map(v => `${v.role}:${v.direction}${Math.round(v.confidence)}`).join(' ')}>
                  seats: {e.voters.map(v => `${v.role} ${v.direction === 'LONG' ? '▲' : v.direction === 'SHORT' ? '▼' : '—'}${Math.round(v.confidence)}`).join(' · ')}
                </div>
              )}
            </div>
          ))}
          <p className="text-[9px] text-slate-600 leading-relaxed">
            Ye wo verdicts hain jo precision gate ne publish nahi kiye (reason stamped). Weekly review inhe analyze karta hai — "gate sahi tha ya over-strict?" Learning loop, not noise.
          </p>
        </div>
      )}
    </div>
  );
});
