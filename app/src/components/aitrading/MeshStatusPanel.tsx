// ============================================================
// src/components/aitrading/MeshStatusPanel.tsx — v11.6
// ------------------------------------------------------------
// PHASE 3 #3 — the mesh OPS VIEW. The 10-agent MCP Data Agent Mesh
// (Quiver/AlphaVantage/TradingCentral/Massive/CoinGecko/CoinAPI/…)
// now feeds real ensemble seats — and free-tier reality means agents
// WILL go budget-exhausted or breaker-tripped during the day. This
// panel surfaces exactly that, in real time:
//
//   • per-agent: authed? breaker state (closed/open/half-open),
//     token-bucket burn (usedToday / perDay)
//   • the v11.6 mesh seats: shadow/voting mode + T3 warm state
//     (caps served vs gapped — the "Quiver down half the day"
//     situation becomes VISIBLE, never a mystery accuracy dip)
//
// Data: GET /api/mcp/mesh/status (already exists, mesh.js) +
// GET /api/ai/status → meshModels block. Collapsible, off by default.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch, getProxyBase } from '../../utils/api';
import type { MeshSeatsStatusView, MeshStatusView } from './types';

async function fetchMeshStatus(): Promise<MeshStatusView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/mcp/mesh/status?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchMeshSeats(): Promise<MeshSeatsStatusView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/status`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.meshModels || null;
  } catch { return null; }
}

const healthCls = (state: string) => state === 'closed'
  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  : state === 'half-open'
    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    : 'bg-red-500/15 text-red-300 border-red-500/30';

function AgentRow({ a }: { a: NonNullable<MeshStatusView['agents']>[number] }) {
  const dayBurn = a.budget.perDay > 0 ? Math.min(100, Math.round((a.budgetUsed.usedToday / a.budget.perDay) * 100)) : 0;
  const exhausted = a.budget.perDay > 0 && a.budgetUsed.usedToday >= a.budget.perDay;
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono" title={`${a.note}${a.health.lastError ? `\nlast error: ${a.health.lastError}` : ''}`}>
      <span className="text-slate-400 w-[86px] truncate">{a.id}</span>
      {!a.authed ? (
        <span className="px-1.5 py-0.5 rounded text-[8px] font-black border bg-slate-600/20 text-slate-500 border-slate-600/30" title={`missing ${a.envKey || 'auth'} — honestly absent, never faked`}>NO KEY</span>
      ) : (
        <span className={`px-1.5 py-0.5 rounded text-[8px] font-black border ${healthCls(a.health.state)}`}>{a.health.state.toUpperCase()}</span>
      )}
      <span className="text-slate-600 w-16 text-right" title={`caps: ${a.capabilities.map(c => c.cap).join(', ')}`}>
        {a.capabilities.length} cap{a.capabilities.length === 1 ? '' : 's'}
      </span>
      <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative" title={a.budget.perDay > 0 ? `token bucket: ${a.budgetUsed.usedToday}/${a.budget.perDay} today · ${a.budgetUsed.usedMinute}/${a.budget.perMinute} this minute` : 'no daily cap (per-minute only)'}>
        {a.budget.perDay > 0 ? (
          <>
            <div className={`h-full ${exhausted ? 'bg-red-500/60' : dayBurn > 70 ? 'bg-amber-500/50' : 'bg-cyan-500/40'}`} style={{ width: `${dayBurn}%` }} />
            <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: '80%' }} title="80% — careful zone" />
          </>
        ) : (
          <div className="h-full bg-cyan-500/15" style={{ width: '100%' }} />
        )}
      </div>
      <span className={`w-20 text-right font-black ${exhausted ? 'text-red-300' : dayBurn > 70 ? 'text-amber-300' : 'text-slate-500'}`}>
        {a.budget.perDay > 0 ? `${a.budgetUsed.usedToday}/${a.budget.perDay}` : 'unlimited'}
      </span>
    </div>
  );
}

function SeatRow({ s }: { s: NonNullable<MeshSeatsStatusView['seats']>[number] }) {
  const modeCls = s.mode === 'voting'
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : s.mode === 'retired'
      ? 'bg-red-500/15 text-red-300 border-red-500/30'
      : 'bg-slate-500/15 text-slate-400 border-slate-500/30';
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono" title={`${s.meshCaps.join(' + ')} → ${s.markets.join('/')} desk${s.edge != null ? ` · edge ${s.edge > 0 ? '+' : ''}${s.edge}pts` : ''}`}>
      <span className="text-slate-400 w-[92px] truncate">{s.name}</span>
      <span className={`px-1.5 py-0.5 rounded text-[8px] font-black border ${modeCls}`}>{s.mode.toUpperCase()}</span>
      <span className="text-slate-600 flex-1 truncate">{s.meshCaps.join(' + ')}</span>
      <span className="w-12 text-right text-slate-500" title={`base weight ${s.baseWeight} · effective ${s.effectiveWeight}`}>w {s.effectiveWeight}</span>
    </div>
  );
}

export const MeshStatusPanel = memo(function MeshStatusPanel() {
  const [mesh, setMesh] = useState<MeshStatusView | null>(null);
  const [seats, setSeats] = useState<MeshSeatsStatusView | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [m, s] = await Promise.all([fetchMeshStatus(), fetchMeshSeats()]);
    setMesh(m);
    setSeats(s);
    setLoading(false);
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const warm = seats?.warm;
  const stats = warm?.stats;

  return (
    <div className="quantum-panel rounded-2xl">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        aria-label="MCP mesh agent status"
      >
        <span className="text-xs font-black text-slate-200">🕸️ MCP DATA MESH — agent health, budgets &amp; mesh seats</span>
        <span className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">v11.6</span>
          <span className="text-slate-500 text-[10px] font-black">{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="quantum-btn-ghost px-2 py-1 rounded-lg text-[10px] font-bold" aria-label="Refresh mesh status">
              <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span> refresh
            </button>
            {mesh && (
              <span className="text-[9px] text-slate-600">
                {mesh.agentCount} agents ({mesh.authedAgents} authed) · cache {mesh.cache.entries}/{mesh.cache.cap} · {mesh.cache.stats.upstream} upstream calls · {mesh.cache.stats.gaps} gaps
              </span>
            )}
          </div>

          {/* the mesh seats: shadow/voting + caps */}
          {seats && (
            <div className="bg-black/20 rounded-xl p-2.5">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-[9px] font-black text-slate-500 tracking-wider">MESH SEATS — the ensemble's data-backed votes</span>
                {seats.enabled ? (
                  <span className="px-1.5 py-0.5 rounded text-[8px] font-black border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">{seats.flag} ON</span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[8px] font-black border bg-slate-600/20 text-slate-400 border-slate-600/30">{seats.flag} OFF — A/B safe</span>
                )}
              </div>
              {seats.seats.map(s => <SeatRow key={s.id} s={s} />)}
              {stats && (
                <div className="text-[9px] text-slate-600 pt-1 leading-relaxed">
                  T3 warm: top {warm?.topN} symbols · batch {warm?.batchPerTick}/tick · re-query gaps hot {warm?.requeryGaps.hot} / warm {warm?.requeryGaps.warm} / cold {warm?.requeryGaps.cold} · {stats.queriesIssued} mesh queries issued → {stats.capsServed} served, {stats.gaps} gapped (budget/breaker = honest abstain)
                  {warm?.byMarket && Object.entries(warm.byMarket).length > 0 && (
                    <> · per desk: {Object.entries(warm.byMarket).map(([mkt, w]) => `${mkt} ${w.capsServed}✓/${w.capsGapped}✗${w.staleCapped ? ` (${w.staleCapped} stale)` : ''}`).join(' · ')}</>
                  )}
                </div>
              )}
            </div>
          )}

          {/* per-agent health + budgets */}
          <div className="bg-black/20 rounded-xl p-2.5">
            <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">AGENTS — breaker state + free-tier token buckets</div>
            {(mesh?.agents || []).map(a => <AgentRow key={a.id} a={a} />)}
            {!mesh && <div className="text-[10px] text-slate-600 py-1">/api/mcp/mesh/status unreachable — mesh panel needs the server up.</div>}
          </div>

          <p className="text-[9px] text-slate-600 leading-relaxed">
            A budget-exhausted or breaker-open agent = its mesh seat <b>honestly abstains</b> (the Phase-1B rule — stale/missing data never votes). Isliye yeh panel hai: agar InstFlowPro aaj subah se abstain kar raha hai, check karo Quiver ka bucket — 50/day free tier 11:30 tak khatam ho sakta hai, aur wahi accuracy-dip lagta tha jab actually data ka intezaar hona chahiye tha.
          </p>
        </div>
      )}
    </div>
  );
});
