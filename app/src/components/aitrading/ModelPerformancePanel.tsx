// ============================================================
// src/components/aitrading/ModelPerformancePanel.tsx — v10.6
// ------------------------------------------------------------
// Pro Upgrade #5 — the WALK-FORWARD BACKTEST / CALIBRATION DASHBOARD.
// backtest.py, trust.js (calibration + Brier) and per-model governance
// already compute real accuracy numbers server-side; this is the one
// read-only surface where a trader finally SEES them together:
//
//   • per-model win-rate over rolling 30/90 days (which of the 14
//     models is actually pulling its weight THIS MONTH)
//   • calibration bucket chart — claimed confidence vs realized
//     win-rate (the trust.js output, charted)
//   • the REGIME down-weight indicator (feeds off Pro Upgrade #4):
//     which models the current TRENDING/CHOPPY/HIGH_VOL/LOW_VOL
//     state is tilting down, and whether the tilt is even armed
//
// Collapsible (collapsed by default — never intrudes on the board).
// Data: GET /api/ai/trust (extended v10.6) — already fetched by the
// desk hook's fetchTrust(); no new backend call from this panel.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { fetchTrust, fetchCouncilCalibration } from './useAITrading';
import type { CouncilCalibrationView, MeshCorrelationRow, MeshSeatAccountabilityRow, ModelPerfRow, RegimeReweightState, TrustView } from './types';

function ModelWinRateBars({ rows, label }: { rows: ModelPerfRow[]; label: string }) {
  if (!rows || rows.length === 0) {
    return <div className="text-[10px] text-slate-600 py-1">No settled trades with model votes in the {label} window yet.</div>;
  }
  return (
    <div className="space-y-1">
      {rows.slice(0, 12).map(r => (
        <div key={r.model} className="flex items-center gap-2 text-[10px] font-mono" title={`${r.name}: ${r.n} attributed settled trades in ${label}`}>
          <span className="text-slate-400 w-28 truncate">{r.name}</span>
          <span className="text-slate-600 w-8 text-right">n={r.n}</span>
          <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative">
            <div
              className={`h-full ${(r.hitRate ?? 0) >= 55 ? 'bg-emerald-500/50' : (r.hitRate ?? 0) >= 45 ? 'bg-amber-500/50' : 'bg-red-500/50'}`}
              style={{ width: `${Math.min(100, r.hitRate ?? 0)}%` }}
            />
            <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: '50%' }} title="50% line" />
          </div>
          <span className={`w-12 text-right font-black ${(r.hitRate ?? 0) >= 55 ? 'text-emerald-300' : (r.hitRate ?? 0) >= 45 ? 'text-amber-300' : 'text-red-300'}`}>
            {r.hitRate != null ? `${r.hitRate}%` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function RegimeTilt({ state, desk }: { state: RegimeReweightState | undefined; desk: string }) {
  if (!state) return null;
  const labelCls = state.label === 'TRENDING' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : state.label === 'HIGH_VOL' ? 'bg-red-500/15 text-red-300 border-red-500/30'
    : state.label === 'CHOPPY' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
  return (
    <div className="bg-black/20 rounded-xl p-2.5 border border-white/5">
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        <span className="text-[9px] font-black text-slate-500 tracking-wider">{desk} REGIME</span>
        {state.enabled && state.label ? (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${labelCls}`}>{state.label}</span>
        ) : (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-slate-600/20 text-slate-400 border border-slate-600/30">tilt OFF</span>
        )}
        <span className="text-[8px] text-slate-600 ml-auto">±25% max · weighted-avg path only</span>
      </div>
      {state.enabled && state.label ? (
        <div className="flex flex-wrap gap-1">
          {state.downWeighted.map(m => (
            <span key={m.id} className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-red-500/10 text-red-300 border border-red-500/20" title={`weight ×${m.mul} under ${state.label}`}>
              {m.name} ↓{m.mul}
            </span>
          ))}
          {state.upWeighted.map(m => (
            <span key={m.id} className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/20" title={`weight ×${m.mul} under ${state.label}`}>
              {m.name} ↑{m.mul}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[9px] text-slate-500 leading-relaxed">{state.note}</div>
      )}
    </div>
  );
}

function CalibrationChart({ view }: { view: TrustView }) {
  const cal = view.calibration;
  if (!cal?.sufficient || !cal.calibration?.length) {
    return <div className="text-[10px] text-slate-600 py-1">{cal?.note || 'Insufficient settled outcomes for calibration — track record gather hone do.'}</div>;
  }
  return (
    <div className="space-y-1">
      {(cal.calibration || []).map(b => (
        <div key={b.bucket} className="flex items-center gap-2 text-[10px] font-mono">
          <span className="text-slate-500 w-14">{b.bucket}</span>
          <span className="text-slate-600 w-8">n={b.n}</span>
          <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative">
            <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: `${Math.min(98, b.claimed)}%` }} title={`claimed ${b.claimed}%`} />
            <div className={`h-full ${b.winRate != null && b.winRate >= b.claimed ? 'bg-emerald-500/50' : 'bg-amber-500/50'}`} style={{ width: `${Math.min(100, b.winRate ?? 0)}%` }} />
          </div>
          <span className={`w-20 text-right font-black ${b.gap == null ? 'text-slate-600' : b.gap >= 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
            {b.winRate ?? '—'}%{b.gap != null ? ` (${b.gap > 0 ? '+' : ''}${b.gap})` : ''}
          </span>
        </div>
      ))}
      <div className="text-[9px] text-slate-600 pt-0.5">
        claimed (the line) vs realized (the bar) · Brier {cal.brier ?? '—'} — {cal.brierVerdict || ''}
      </div>
    </div>
  );
}

/** v10.15 (deep-recheck #2 S3): the direction-accuracy split — the
 *  standing answer to "kya sab trades ka direction sahi de raha hai?"
 *  LONG vs SHORT settled win-rates side-by-side; a systematically wrong
 *  side becomes visible instead of hiding in the blended average. */
function DirectionSplit({ view }: { view: TrustView }) {
  const dir = (view.calibration as unknown as { direction?: { LONG: { n: number; winRate: number | null; avgR: number | null }; SHORT: { n: number; winRate: number | null; avgR: number | null } } })?.direction;
  if (!dir || ((dir.LONG?.n || 0) + (dir.SHORT?.n || 0)) === 0) {
    return <div className="text-[10px] text-slate-600 py-1">Direction split ka data abhi nahi — settled trades hone do.</div>;
  }
  const row = (label: string, d: { n: number; winRate: number | null; avgR: number | null }, cls: string) => (
    <div className="flex items-center gap-2 text-[10px] font-mono">
      <span className={`${cls} w-14 font-black`}>{label}</span>
      <span className="text-slate-600 w-8">n={d.n}</span>
      <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative">
        <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: '50%' }} title="50% line" />
        <div
          className={`h-full ${(d.winRate ?? 0) >= 55 ? 'bg-emerald-500/50' : (d.winRate ?? 0) >= 45 ? 'bg-amber-500/50' : 'bg-red-500/50'}`}
          style={{ width: `${Math.min(100, d.winRate ?? 0)}%` }}
        />
      </div>
      <span className={`w-16 text-right font-black ${(d.winRate ?? 0) >= 55 ? 'text-emerald-300' : (d.winRate ?? 0) >= 45 ? 'text-amber-300' : 'text-red-300'}`}>
        {d.winRate != null ? `${d.winRate}%` : '—'}
      </span>
      <span className="w-14 text-right text-slate-500" title="average R multiple">{d.avgR != null ? `${d.avgR > 0 ? '+' : ''}${d.avgR}R` : '—'}</span>
    </div>
  );
  const gap = dir.LONG?.n > 0 && dir.SHORT?.n > 0 && dir.LONG.winRate != null && dir.SHORT.winRate != null
    ? Math.round((dir.LONG.winRate - dir.SHORT.winRate) * 10) / 10 : null;
  return (
    <div className="space-y-1">
      {row('LONG ▲', dir.LONG, 'text-emerald-300')}
      {row('SHORT ▼', dir.SHORT, 'text-red-300')}
      {gap != null && (
        <div className={`text-[9px] ${Math.abs(gap) >= 15 ? 'text-amber-300' : 'text-slate-600'}`}>
          side gap {gap > 0 ? '+' : ''}{gap} pts{Math.abs(gap) >= 15 ? ' — ek side systematically weak hai, review karo' : ''} · settled ledger, direction-only (R&gt;0)
        </div>
      )}
    </div>
  );
}

/** v11.0: per-COUNCIL-AGENT track records — the 6 specialist seats'
 *  claimed confidence vs realized outcomes (hit-rate, direction split,
 *  calibrated weight). n small = honest 'insufficient data'. */
function CouncilAgentsBlock({ cal }: { cal: CouncilCalibrationView | null }) {
  if (!cal || (cal.settled ?? 0) === 0) {
    return <div className="text-[10px] text-slate-600 py-1">Council-stamped settled trades abhi nahi — agents apna track record EXECUTED trades se banate hain (calibrated weights n≥8 pe engage).</div>;
  }
  return (
    <div className="space-y-1">
      {(cal.agents || []).map(a => {
        const w = cal.weights?.[a.role];
        return (
          <div key={a.role} className="flex items-center gap-2 text-[10px] font-mono" title={`${a.role}: ${a.wins}W/${a.losses}L · LONG ${a.directionSplit?.LONG?.winRate ?? '—'}% (n=${a.directionSplit?.LONG?.n ?? 0}) · SHORT ${a.directionSplit?.SHORT?.winRate ?? '—'}% (n=${a.directionSplit?.SHORT?.n ?? 0})`}>
            <span className="text-slate-400 w-[92px] truncate">{a.role}</span>
            <span className="text-slate-600 w-8 text-right">n={a.n}</span>
            <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative">
              <div
                className={`h-full ${(a.hitRate ?? 0) >= 55 ? 'bg-emerald-500/50' : (a.hitRate ?? 0) >= 45 ? 'bg-amber-500/50' : 'bg-red-500/50'}`}
                style={{ width: `${Math.min(100, a.hitRate ?? 0)}%` }}
              />
              <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: '50%' }} title="50% line" />
            </div>
            <span className={`w-12 text-right font-black ${(a.hitRate ?? 0) >= 55 ? 'text-emerald-300' : (a.hitRate ?? 0) >= 45 ? 'text-amber-300' : 'text-red-300'}`}>
              {a.hitRate != null ? `${a.hitRate}%` : '—'}
            </span>
            <span className={`w-14 text-right font-black ${w && w.mul > 1.02 ? 'text-emerald-300' : w && w.mul < 0.98 ? 'text-red-300' : 'text-slate-500'}`} title="calibrated weight multiplier (Bayesian, ±30% bound, n≥8)">
              ×{w ? w.mul.toFixed(2) : '1.00'}
            </span>
          </div>
        );
      })}
      <div className="text-[9px] text-slate-600 pt-0.5">
        published precision {(cal as { precision?: number | null }).precision ?? '—'}% · 90d {(cal as { precision90d?: number | null }).precision90d ?? '—'}% (n={(cal as { n90d?: number | null }).n90d ?? 0}) · Brier {cal.brier ?? '—'} — {cal.brierVerdict || ''}
      </div>
    </div>
  );
}

/** v11.6: the MESH-BACKED SEATS block — shadow/voting mode, the
 *  when-voted vs when-abstained edge, and the false-diversity
 *  correlation guard. The answer to "did more MCP data actually
 *  help?" — in the same calibration display as the original 14. */
function MeshModelsBlock({ view }: { view: TrustView }) {
  const mm = view.meshModels;
  if (!mm?.accountability?.models?.length) {
    return <div className="text-[10px] text-slate-600 py-1">Mesh-backed seats (v11.6) ka accountability data nahi — AI_ENABLE_MESH_MODELS on karke settled trades hone do.</div>;
  }
  const modeBadge = (mode: string) => mode === 'voting'
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : mode === 'retired'
      ? 'bg-red-500/15 text-red-300 border-red-500/30'
      : 'bg-slate-500/15 text-slate-400 border-slate-500/30';
  const corrOf = (id: string): MeshCorrelationRow | undefined => mm.correlation?.seats?.[id];
  return (
    <div className="space-y-1">
      {mm.accountability.models.map((m: MeshSeatAccountabilityRow) => {
        const c = corrOf(m.id);
        return (
          <div key={m.id} className="flex items-center gap-2 text-[10px] font-mono" title={`${m.note}${c ? `\n${c.note}` : ''}`}>
            <span className="text-slate-400 w-[92px] truncate">{m.name}</span>
            <span className={`px-1.5 py-0.5 rounded text-[8px] font-black border ${modeBadge(m.mode)}`}>{m.mode.toUpperCase()}</span>
            <span className="text-slate-600 w-8 text-right">n={m.n}</span>
            <div className="flex-1 h-2 bg-black/40 rounded overflow-hidden relative">
              <div
                className={`h-full ${(m.hitRate ?? 0) >= 55 ? 'bg-emerald-500/50' : (m.hitRate ?? 0) >= 45 ? 'bg-amber-500/50' : 'bg-red-500/50'}`}
                style={{ width: `${Math.min(100, m.hitRate ?? 0)}%` }}
              />
              <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: '50%' }} title="50% line" />
            </div>
            <span className={`w-12 text-right font-black ${(m.hitRate ?? 0) >= 55 ? 'text-emerald-300' : (m.hitRate ?? 0) >= 45 ? 'text-amber-300' : 'text-red-300'}`}>
              {m.hitRate != null ? `${m.hitRate}%` : '—'}
            </span>
            <span
              className={`w-16 text-right font-black ${m.edge == null ? 'text-slate-600' : m.edge > 0 ? 'text-emerald-300' : 'text-red-300'}`}
              title={`trades with this seat voting won ${m.whenVotedWR ?? '—'}% vs ${m.whenAbstainedWR ?? '—'}% when it abstained`}
            >
              {m.edge != null ? `${m.edge > 0 ? '+' : ''}${m.edge}pts` : 'no data'}
            </span>
            <span
              className={`w-14 text-right font-black ${c && c.discount < 1 ? 'text-amber-300' : 'text-slate-600'}`}
              title={c?.note || 'cross-correlation vs TrendMatrix/MomentumQuant'}
            >
              {c && c.discount < 1 ? `×${c.discount}` : 'indep'}
            </span>
          </div>
        );
      })}
      <div className="text-[9px] text-slate-600 pt-0.5 leading-relaxed">
        edge = trades where the seat VOTED (win-rate) minus trades where it ABSTAINED — promotion needs n≥{mm.accountability.minSettled} settled outcomes with a positive edge (Phase-2 proving rule). ×0.5/×0.75 = false-diversity discount (votes correlate with TrendMatrix/MomentumQuant, corr guard &gt;{' '}0.70/0.85). Shadow = journaled, weight 0.
      </div>
    </div>
  );
}

interface Props {
  /** which desk's regime tilt to highlight (kept for the panel contract —
   *  both desks' tilts always render side-by-side in the grid) */
  desk?: 'INDIA' | 'CRYPTO';
}

export const ModelPerformancePanel = memo(function ModelPerformancePanel(_props: Props) {
  const [view, setView] = useState<TrustView | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // v11.0: council per-agent calibration rides the same refresh.
  const [council, setCouncil] = useState<CouncilCalibrationView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setView(await fetchTrust());
    setCouncil(await fetchCouncilCalibration());
    setLoading(false);
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const win = view?.windows;

  return (
    <div className="quantum-panel rounded-2xl">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        aria-label="Model performance dashboard"
      >
        <span className="text-xs font-black text-slate-200">🧪 MODEL PERFORMANCE — kaun kitna sahi bol raha hai?</span>
        <span className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-violet-500/10 text-violet-300 border border-violet-500/20">v10.6</span>
          <span className="text-slate-500 text-[10px] font-black">{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {/* refresh row */}
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="quantum-btn-ghost px-2 py-1 rounded-lg text-[10px] font-bold" aria-label="Refresh model performance">
              <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span> refresh
            </button>
            {win && <span className="text-[9px] text-slate-600">{win.settledTotal} settled outcomes on record</span>}
          </div>

          {/* regime tilt (Upgrade #4 indicator) */}
          <div className="grid gap-2 sm:grid-cols-2">
            <RegimeTilt state={view?.regimeReweight?.INDIA} desk="INDIA" />
            <RegimeTilt state={view?.regimeReweight?.CRYPTO} desk="CRYPTO" />
          </div>

          {/* per-model rolling win-rates */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="bg-black/20 rounded-xl p-2.5">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">PER-MODEL WIN-RATE · 30 DAYS</div>
              <ModelWinRateBars rows={win?.d30 || []} label="30-day" />
            </div>
            <div className="bg-black/20 rounded-xl p-2.5">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">PER-MODEL WIN-RATE · 90 DAYS</div>
              <ModelWinRateBars rows={win?.d90 || []} label="90-day" />
            </div>
          </div>

          {/* calibration chart */}
          <div className="bg-black/20 rounded-xl p-2.5">
            <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">CALIBRATION — bola vs hua (claimed vs realized)</div>
            <CalibrationChart view={view || ({} as TrustView)} />
          </div>

          {/* v10.15 S3: direction split — "kya direction sahi de raha hai?" ka standing answer */}
          <div className="bg-black/20 rounded-xl p-2.5">
            <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">DIRECTION SPLIT — LONG vs SHORT (kis side pe dimaag hai)</div>
            <DirectionSplit view={view || ({} as TrustView)} />
          </div>

          {/* v11.0: per-COUNCIL-agent accountability — the 6 seats' own track records */}
          <div className="bg-black/20 rounded-xl p-2.5">
            <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">COUNCIL AGENTS — 6 seats ka apna track record (v11.0)</div>
            <CouncilAgentsBlock cal={council} />
          </div>

          {/* v11.6: mesh-backed seats — the MCP data agents finally VOTE;
              shadow/voting + edge + correlation guard, same display */}
          <div className="bg-black/20 rounded-xl p-2.5">
            <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">MESH-BACKED SEATS — Quiver/TradingCentral/AlphaVantage/CoinGecko data ka apna track record (v11.6)</div>
            <MeshModelsBlock view={view || ({} as TrustView)} />
          </div>

          <p className="text-[9px] text-slate-600 leading-relaxed">
            Attribution = a model wins when its recorded vote direction matched the settled outcome. Small n = noise, not edge — 30/90d windows ke liye kam-se-kam 20+ attributed trades chahiye before judging a model. Run the A/B yourself: Backtest panel → <b>strategy=regime_weighted</b> (or <code>python -m models.backtest --strategy regime_weighted</code> in ml-service) — regime tilt tabhi ON karo jab walk-forward bhi bole.
          </p>
        </div>
      )}
    </div>
  );
});
