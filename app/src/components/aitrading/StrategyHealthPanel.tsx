// ============================================================
// StrategyHealthPanel — v21.1.0 (Phase-4)
// ------------------------------------------------------------
// GET /api/ai/strategy-health ka dashboard:
//   • GO-LIVE GATE: paper track-record readiness (trades/100,
//     expectancy, maxDD) — LIVE kab unlock hoga, saaf counters ke saath
//   • PER-STRATEGY TABLE: har source×market ka rolling 30-trade
//     expectancy + win-rate + AUTO-PAUSED state (kill rule)
//   • WALK-FORWARD HINT: backtest panel me ?walkForward=1 ka note
// Poll: 30s visibility-gated. Fail: panel chhup jaata hai (auxiliary).
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, PauseCircle } from 'lucide-react';
import { apiFetch } from '../../utils/api';

interface StrategyRow {
  strategy: string;
  n: number;
  winRate: number | null;
  expectancyR: number | null;
  rolling: { window: number; n: number; winRate: number | null; expectancyR: number | null };
  paused: boolean;
}
interface GoLive {
  ready: boolean;
  reasons: string[];
  stats: { settledPaperTrades: number; winRate: number | null; expectancyR: number | null; maxDrawdownR: number; netR: number };
  thresholds: { minTrades: number; minExpectancyR: number; maxDrawdownR: number };
  enforced: boolean;
}
interface HealthView {
  strategies: StrategyRow[];
  killRule: { window: number; minTrades: number };
  goLive: GoLive;
  enforced: boolean;
}

export const StrategyHealthPanel = memo(function StrategyHealthPanel() {
  const [view, setView] = useState<HealthView | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai/strategy-health', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { setView(null); return; }
      const d = (await res.json().catch(() => null)) as HealthView | null;
      setView(d && Array.isArray(d.strategies) ? d : null);
    } catch { setView(null); /* silent — auxiliary */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!view) return null;
  const gl = view.goLive;
  const tradePct = gl ? Math.min(100, Math.round((gl.stats.settledPaperTrades / Math.max(1, gl.thresholds.minTrades)) * 100)) : 0;
  const pausedCount = view.strategies.filter(s => s.paused).length;

  return (
    <div className="quantum-panel rounded-2xl p-4 space-y-3" aria-label="Strategy health and go-live gate">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1 text-[11px] font-black text-slate-200">
          {gl?.ready ? <ShieldCheck size={13} className="text-emerald-400" /> : <ShieldAlert size={13} className="text-amber-400" />}
          STRATEGY HEALTH · GO-LIVE GATE
        </span>
        <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black border ${gl?.ready
          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
          {gl?.ready ? 'LIVE UNLOCKED' : 'LIVE LOCKED'}
        </span>
        {view.enforced ? (
          <span className="text-[9px] font-mono text-slate-500" title="executeSignal / executeFuturesSignal / executeIndiaSignal — teeno desks ke LIVE entries inhi criteria se reject hote hain (v21.1.1 me India bhi wired)">
            enforced on all desks
          </span>
        ) : (
          <span className="text-[9px] font-mono text-slate-600" title="VITEST/test mode ya GO_LIVE_ENFORCE=0 — production me default ON">
            not enforced (test mode)
          </span>
        )}
      </div>

      {/* GO-LIVE progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[9px] font-mono text-slate-400">
          <span>PAPER TRACK-RECORD</span>
          <span>{gl?.stats.settledPaperTrades ?? 0}/{gl?.thresholds.minTrades ?? 100} trades · exp {gl?.stats.expectancyR ?? 'n/a'}R · maxDD {gl?.stats.maxDrawdownR ?? 0}R/{gl?.thresholds.maxDrawdownR ?? 8}R · net {gl?.stats.netR ?? 0}R</span>
        </div>
        <div className="h-1.5 rounded-full bg-slate-700/50 overflow-hidden" title={`Settled paper trades ${gl?.stats.settledPaperTrades ?? 0} / ${gl?.thresholds.minTrades ?? 100} (fees+slippage ke BAAD ka R)}`}>
          <div
            className={`h-full rounded-full transition-all ${tradePct >= 100 ? 'bg-emerald-500' : 'bg-amber-500'}`}
            style={{ width: `${Math.min(100, tradePct)}%` }}
          />
        </div>
        {!gl?.ready && gl?.reasons?.length ? (
          <ul className="text-[9px] font-mono text-amber-300/90 space-y-0.5">
            {gl.reasons.slice(0, 4).map((r, i) => <li key={i}>· {r}</li>)}
          </ul>
        ) : (
          <div className="text-[9px] font-mono text-emerald-300/90">
            Paper track-record qualify — LIVE entries allowed (per-trade gauntlet gates phir bhi lagte hain: kill-switch, margin, one-per-pair).
          </div>
        )}
      </div>

      {/* Per-strategy table */}
      {view.strategies.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr className="text-slate-500 border-b border-slate-700/50">
                <th className="text-left py-1 pr-2">STRATEGY (source:market)</th>
                <th className="text-right py-1 px-1">N</th>
                <th className="text-right py-1 px-1">WIN%</th>
                <th className="text-right py-1 px-1">EXP (R)</th>
                <th className="text-right py-1 px-1">ROLL{view.killRule?.window ?? 30}</th>
                <th className="text-right py-1 pl-1">STATE</th>
              </tr>
            </thead>
            <tbody>
              {view.strategies.slice(0, 8).map((s) => (
                <tr key={s.strategy} className={`border-b border-slate-800/40 ${s.paused ? 'text-red-300' : 'text-slate-300'}`}>
                  <td className="py-1 pr-2 truncate max-w-[220px]" title={s.strategy}>{s.strategy}</td>
                  <td className="text-right px-1">{s.n}</td>
                  <td className="text-right px-1">{s.winRate ?? '—'}</td>
                  <td className={`text-right px-1 ${(s.expectancyR ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{s.expectancyR != null ? `${s.expectancyR}R` : '—'}</td>
                  <td className={`text-right px-1 ${(s.rolling.expectancyR ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {s.rolling.expectancyR != null ? `${s.rolling.expectancyR}R · ${s.rolling.n}` : `— · ${s.rolling.n}`}
                  </td>
                  <td className="text-right pl-1">
                    {s.paused
                      ? <span className="inline-flex items-center gap-1 text-red-300"><PauseCircle size={9} /> PAUSED</span>
                      : <span className={s.rolling.n >= (view.killRule?.minTrades ?? 30) ? 'text-emerald-400' : 'text-slate-600'}>{s.rolling.n >= (view.killRule?.minTrades ?? 30) ? 'ACTIVE' : 'WARMING'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[8px] font-mono text-slate-600 mt-1">
            Rolling {view.killRule?.window ?? 30}-trade expectancy negative → strategy AUTO-PAUSE (naye entries reject; expectancy recover hone par auto-resume).{pausedCount > 0 ? ` ${pausedCount} paused.` : ''}
          </div>
        </div>
      ) : (
        <div className="text-[9px] font-mono text-slate-600">
          Koi settled strategy trades nahi — paper entries settle hone par stats yahan dikhen ge.
        </div>
      )}

      <div className="text-[8px] font-mono text-slate-600 border-t border-slate-800/50 pt-1">
        Backtest panel me <span className="text-slate-400">walk-forward</span> mode on karke train/test overfit verdict bhi dekho (v21.1.0 Phase-4).
      </div>
    </div>
  );
});
