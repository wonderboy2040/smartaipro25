// ============================================================
// src/components/aitrading/CouncilVerdictPanel.tsx — v11.0 PHASE 3
// ------------------------------------------------------------
// The GLOBAL MARKET COUNCIL's live surface on every desk: the 6
// specialist seats' direction+confidence grid, the calibrated
// consensus bar, the precision-gate chip (PASSED green /
// SUPPRESSED amber + reasons), the bull/bear debate trail, and the
// 10-agent MCP mesh health strip.
//
// Transparency FIRST (the plan's Phase-3 principle): the user sees
// the whole expert-panel discussion, not just "AI bol raha hai buy".
//
// Data: the council STAMPS ride the signal board (zero extra cost);
// the status/mesh-health lines poll /api/ai/council/status +
// /api/mcp/mesh/status on a 60s cadence (document.hidden gated —
// the v10.18 audit's hidden-tab-zero-burn rule).
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { fetchCouncilStatus } from './useAITrading';
import type { AISignal, CouncilStamp, SignalBoard } from './types';

const dirChip = (d: string) => {
  if (d === 'LONG') return 'text-emerald-300';
  if (d === 'SHORT') return 'text-red-300';
  return 'text-slate-500';
};
const dirArrow = (d: string) => (d === 'LONG' ? '▲' : d === 'SHORT' ? '▼' : '—');

function SeatRow({ vote, reasons }: { vote: { role: string; name: string; direction: string; confidence: number }; reasons?: string[] }) {
  const cls = dirChip(vote.direction);
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono" title={reasons?.join(' · ') || vote.name}>
      <span className="text-slate-400 w-[92px] truncate">{vote.name}</span>
      <span className={`w-16 font-black ${cls}`}>{dirArrow(vote.direction)} {vote.direction}</span>
      <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative">
        <div
          className={`h-full ${vote.direction === 'LONG' ? 'bg-emerald-500/50' : vote.direction === 'SHORT' ? 'bg-red-500/50' : 'bg-slate-600/50'}`}
          style={{ width: `${Math.min(100, vote.confidence)}%` }}
        />
      </div>
      <span className="w-8 text-right text-slate-300 font-black">{Math.round(vote.confidence)}</span>
    </div>
  );
}

function GateChip({ stamp }: { stamp: CouncilStamp }) {
  if (stamp.gate === 'PASSED') {
    return <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">✓ GATE PASSED</span>;
  }
  return (
    <span
      className="px-2 py-0.5 rounded-md text-[10px] font-black bg-amber-500/15 text-amber-300 border border-amber-500/30"
      title={(stamp.gateReasons || []).join(' · ')}
    >
      ⊘ SUPPRESSED — {(stamp.gateReasons || [])[0] || 'gate'}
    </span>
  );
}

function FreshnessBadge({ stamp }: { stamp: CouncilStamp }) {
  const map: Record<string, { label: string; cls: string }> = {
    live: { label: '⚡ LIVE', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
    cached: { label: 'CACHED', cls: 'bg-slate-600/20 text-slate-400 border-slate-600/30' },
    model: { label: 'MODEL', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  };
  const b = map[stamp.freshness] || map.cached;
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${b.cls}`} title={`verdict engine: ${stamp.model || '—'}`}>{b.label}</span>;
}

interface Props {
  board: SignalBoard | null;
}

export const CouncilVerdictPanel = memo(function CouncilVerdictPanel({ board }: Props) {
  const [status, setStatus] = useState<{ enabled?: boolean; verdictCache?: { entries: number } } | null>(null);
  const [mesh, setMesh] = useState<{ agentCount?: number; authedAgents?: number; agents?: { id: string; name: string; authed: boolean; health?: { state: string } }[] } | null>(null);

  const loadStatus = useCallback(async () => {
    if (document.hidden) return;
    setStatus(await fetchCouncilStatus());
    try {
      const { apiFetch, getProxyBase } = await import('../../utils/api');
      const r = await apiFetch(`${getProxyBase()}/api/mcp/mesh/status?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) setMesh(await r.json());
    } catch { /* honest degrade */ }
  }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 60_000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const meta = board?.council || null;
  const stamped: AISignal[] = (board?.signals || []).filter(s => s.council);
  const enabled = meta?.enabled || false;
  if (!enabled) {
    return (
      <div className="quantum-panel rounded-2xl p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-black text-slate-200">🏛️ GLOBAL MARKET COUNCIL</span>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-slate-600/20 text-slate-400 border border-slate-600/30">OFF</span>
          <span className="text-[9px] text-slate-600">v11.0</span>
        </div>
        <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
          6 specialist seats + precision gate <span className="font-mono">({meta?.flag || 'AI_ENABLE_GLOBAL_COUNCIL'}=on)</span> karne par har STRONG signal ke peeche poora expert-panel
          discussion dikhega — Technical · Macro · Sentiment · Options-Flow · On-Chain · Risk Guardian. Mehngai: ~6 LLM calls / 90s (top-5 symbols, cached). A/B ke liye default OFF.
        </p>
      </div>
    );
  }


  return (
    <div className="quantum-panel rounded-2xl p-4 space-y-3">
      {/* header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-black text-slate-200">🏛️ GLOBAL MARKET COUNCIL</span>
        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">ON</span>
        {meta?.model && <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 font-mono">{meta.model}</span>}
        {meta?.stamped != null && (
          <span className="text-[9px] text-slate-600 ml-auto font-mono">
            {meta.stamped} stamped · {meta.passed ?? 0} passed · {meta.suppressed ?? 0} suppressed
            {status?.verdictCache ? ` · cache ${status.verdictCache.entries}` : ''}
          </span>
        )}
      </div>

      {/* per-symbol verdict cards */}
      {stamped.length === 0 && (
        <div className="text-[10px] text-slate-500">
          {meta?.note || 'Council verdicts warming — next board cycle pe stamps lagenge (90s per-symbol cache).'}
        </div>
      )}
      {stamped.slice(0, 3).map(s => {
        const c = s.council!;
        const reasonByRole = new Map((c.agentReasons || []).map(r => [r.role, r]));
        const bull = c.agents.filter(a => a.direction === 'LONG').length;
        const bear = c.agents.filter(a => a.direction === 'SHORT').length;
        return (
          <div key={`${s.market}-${s.symbol}`} className="bg-black/20 rounded-xl p-2.5 border border-white/5 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-black text-white font-mono">{s.symbol}</span>
              <span className={`text-[10px] font-black ${dirChip(c.direction)}`}>{dirArrow(c.direction)} {c.direction}</span>
              <span className="text-[9px] text-slate-600 font-mono">conf {Math.round(c.confidence)} · agree {Math.round(c.agreement * 100)}% · quorum {c.quorum}/6 · {bull}▲ {bear}▼</span>
              <span className="ml-auto flex items-center gap-1.5">
                <FreshnessBadge stamp={c} />
                <GateChip stamp={c} />
              </span>
            </div>
            {/* consensus bar */}
            <div className="h-2 bg-black/40 rounded overflow-hidden relative">
              <div
                className={`h-full ${c.direction === 'LONG' ? 'bg-emerald-500/50' : c.direction === 'SHORT' ? 'bg-red-500/50' : 'bg-slate-600/50'}`}
                style={{ width: `${Math.min(100, c.confidence)}%` }}
              />
              {/* v11.0.1: the marker rides the stamp's REAL gate bar
                  (env-tuned / auto-tighten aware) — was hardcoded 78 */}
              <div
                className="absolute top-0 bottom-0 w-px bg-amber-400/70"
                style={{ left: `${Math.min(97, Math.max(50, c.gateBar || 78))}%` }}
                title={`precision-gate bar (${c.gateBar ?? 78}${c.gateBar == null ? ' default' : ''})`}
              />
            </div>
            {/* seats grid */}
            <div className="grid gap-x-3 gap-y-1 sm:grid-cols-2">
              {(c.agents || []).map(a => (
                <SeatRow key={a.role} vote={a} reasons={reasonByRole.get(a.role)?.reasons} />
              ))}
            </div>
            {/* debate trail (deep mode) */}
            {c.debate && (c.debate.bull || c.debate.bear) && (
              <div className="grid gap-1.5 sm:grid-cols-2 text-[9px] leading-relaxed">
                {c.debate.bull && (
                  <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-lg p-1.5 text-emerald-200/80">
                    <b className="text-emerald-300">BULL:</b> {c.debate.bull}
                  </div>
                )}
                {c.debate.bear && (
                  <div className="bg-red-500/5 border border-red-500/15 rounded-lg p-1.5 text-red-200/80">
                    <b className="text-red-300">BEAR:</b> {c.debate.bear}
                  </div>
                )}
                {c.debate.judge && (
                  <div className="sm:col-span-2 bg-cyan-500/5 border border-cyan-500/15 rounded-lg p-1.5 text-cyan-200/80">
                    <b className="text-cyan-300">JUDGE:</b> {c.debate.judge}
                  </div>
                )}
              </div>
            )}
            {/* honesty extras */}
            <div className="flex items-center gap-2 flex-wrap text-[9px] text-slate-600">
              {c.divergence && (
                <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 font-mono" title={`cross-source divergence: ${c.divergence.agents?.join(' vs ')}`}>
                  ⚠ price divergence {c.divergence.spreadPct}%
                </span>
              )}
              {c.levels?.entry != null && (
                <span className="font-mono">council levels: E {c.levels.entry} · SL {c.levels.stop ?? '—'} · T1 {c.levels.t1 ?? '—'}</span>
              )}
              {c.gate === 'SUPPRESSED' && <span className="text-amber-400/70">near-miss journal me record hua (weekly review learning)</span>}
            </div>
          </div>
        );
      })}

      {/* mesh health strip */}
      {mesh?.agents && (
        <div className="bg-black/20 rounded-xl p-2.5 border border-white/5">
          <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">
            MCP DATA AGENT MESH — {mesh.agentCount} agents · {mesh.authedAgents} authed
          </div>
          <div className="flex flex-wrap gap-1">
            {mesh.agents.map(a => {
              const state = a.health?.state || 'closed';
              const cls = !a.authed
                ? 'bg-slate-600/15 text-slate-600 border-slate-600/20'
                : state === 'closed' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                  : state === 'half-open' ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                    : 'bg-red-500/10 text-red-300 border-red-500/20';
              const dot = !a.authed ? '·' : state === 'closed' ? '●' : state === 'half-open' ? '◐' : '○';
              return (
                <span key={a.id} className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${cls}`} title={`${a.name} — ${a.authed ? state : 'no API key (honestly absent)'}`}>
                  {dot} {a.id}
                </span>
              );
            })}
          </div>
          <div className="text-[8px] text-slate-600 mt-1.5 leading-relaxed">
            ● healthy · ◐ half-open probe · ○ breaker open · · no key (absent, never faked). Capability-routed fan-out · 3-tier cache · 8s deadlines.
          </div>
        </div>
      )}

      <p className="text-[9px] text-slate-600 leading-relaxed">
        Council = ANALYSIS layer (6 seats, calibrated weights, precision gate: conf 78+ · agreement 70%+ · quorum 5/6). Execution authority hamesha hardened gauntlets ke paas rehti hai.
        95% is a precision TARGET — publish kam, quality zyada; realized number Track Record me dikhega.
      </p>
    </div>
  );
});
