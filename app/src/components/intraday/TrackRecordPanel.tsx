// ============================================================
// intraday/TrackRecordPanel — scanner accountability dashboard
// ------------------------------------------------------------
// Shows the win-rate / avg-R / disciplined P&L of every signal the
// scanner has published (tracked server-side to T1/T2/SL/EOD) plus
// the recent history table. Trust builder: the engine's own
// scorecard, not marketing claims.
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api';
import type { TrackRecordData } from './types';

const STATUS_STYLES: Record<string, string> = {
  T2_HIT: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  BE_TRAIL_EXIT: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  SL_HIT: 'bg-red-500/15 text-red-300 border-red-500/30',
  EOD_EXIT: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  T1_HIT: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};
const STATUS_LABEL: Record<string, string> = {
  T2_HIT: 'T2 WIN', BE_TRAIL_EXIT: 'BE TRAIL', SL_HIT: 'SL', EOD_EXIT: 'EOD', T1_HIT: 'T1',
};

// v10.17 perf: memo'd — the panel's ONLY prop is a number (refreshKey),
// so the tab's live-price/positions flushes (every 800ms–5s) skip this
// subtree entirely; it re-renders only when a paper trade bumps the key.
export const TrackRecordPanel = memo(function TrackRecordPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<TrackRecordData | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/intraday-track-record?days=30`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) setData(await res.json());
    } catch { /* offline */ }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!data) return null;

  const hasHistory = data.history.length > 0 || data.open.length > 0;
  const pnlColor = data.disciplinedPnlPerLakh > 0 ? 'text-emerald-400'
    : data.disciplinedPnlPerLakh < 0 ? 'text-red-400' : 'text-slate-400';

  return (
    <div className="quantum-panel rounded-2xl border border-white/5 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-200">🎯 Signal Track Record</span>
          {data.winRate != null && (
            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black font-mono border ${data.winRate >= 55 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : data.winRate >= 45 ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-red-500/15 text-red-300 border-red-500/30'}`}>
              {data.winRate}% WIN • 30D
            </span>
          )}
          <span className="text-[10px] font-mono text-slate-500">
            {data.resolved} resolved • {data.openCount} tracking now
            {data.avgR != null && <> • avg <b className={data.avgR >= 0 ? 'text-emerald-400' : 'text-red-400'}>{data.avgR >= 0 ? '+' : ''}{data.avgR}R</b></>}
            {data.resolved > 0 && <> • P&L/₹1L <b className={pnlColor}>{data.disciplinedPnlPerLakh >= 0 ? '+' : '−'}₹{Math.abs(data.disciplinedPnlPerLakh).toFixed(0)}</b></>}
          </span>
        </div>
        <span className="text-slate-500 text-xs">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Status distribution */}
          <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono px-1">
            {Object.entries(data.byStatus).map(([k, v]) =>
              v > 0 && (
                <span key={k} className={`px-2 py-0.5 rounded-md border ${STATUS_STYLES[k] || 'bg-white/5 text-slate-400 border-white/10'}`}>
                  {STATUS_LABEL[k] || k}: {v}
                </span>
              )
            )}
          </div>

          {/* Live-tracked signals */}
          {data.open.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider px-1 pb-1">Currently Tracking</div>
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-white/10 text-[9px] uppercase text-slate-500">
                    <th className="px-2 py-1 text-left">Symbol</th>
                    <th className="px-2 py-1">Dir</th>
                    <th className="px-2 py-1">Entry</th>
                    <th className="px-2 py-1">Last</th>
                    <th className="px-2 py-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.open.slice(0, 10).map((o, i) => (
                    <tr key={i} className="border-b border-white/5">
                      <td className="px-2 py-1.5 text-left font-black text-slate-200">{o.symbol}</td>
                      <td className={`px-2 py-1.5 text-center font-black ${o.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{o.direction === 'LONG' ? 'L' : 'S'}</td>
                      <td className="px-2 py-1.5 text-center text-cyan-200">₹{o.entry.toFixed(1)}</td>
                      <td className="px-2 py-1.5 text-center text-slate-300">₹{(o.lastPrice ?? o.entry).toFixed(1)}</td>
                      <td className="px-2 py-1.5 text-center">
                        {o.t1Hit
                          ? <span className="text-amber-300 font-bold text-[9px]">T1 ✓ trailing</span>
                          : <span className="text-slate-500 text-[9px]">open</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Resolved history */}
          {data.history.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider px-1 pb-1">Recent Outcomes (30d)</div>
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-white/10 text-[9px] uppercase text-slate-500">
                    <th className="px-2 py-1 text-left">Date</th>
                    <th className="px-2 py-1 text-left">Symbol</th>
                    <th className="px-2 py-1">Dir</th>
                    <th className="px-2 py-1">Entry</th>
                    <th className="px-2 py-1">Exit</th>
                    <th className="px-2 py-1">Outcome</th>
                    <th className="px-2 py-1">R</th>
                    <th className="px-2 py-1">P&L/₹1L</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.slice(0, 15).map((h, i) => (
                    <tr key={i} className="border-b border-white/5 hover:bg-white/[0.03]">
                      <td className="px-2 py-1.5 text-left text-slate-500">{h.dayKey.slice(5)}</td>
                      <td className="px-2 py-1.5 text-left font-black text-slate-200">{h.symbol}</td>
                      <td className={`px-2 py-1.5 text-center font-black ${h.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{h.direction === 'LONG' ? 'L' : 'S'}</td>
                      <td className="px-2 py-1.5 text-center text-cyan-200">₹{h.entry.toFixed(1)}</td>
                      <td className="px-2 py-1.5 text-center text-slate-300">{h.exitPrice != null ? `₹${h.exitPrice.toFixed(1)}` : '—'}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${STATUS_STYLES[h.status] || 'bg-white/5 text-slate-400 border-white/10'}`}>
                          {STATUS_LABEL[h.status] || h.status}
                        </span>
                      </td>
                      <td className={`px-2 py-1.5 text-center font-bold ${(h.rMultiple ?? 0) > 0 ? 'text-emerald-400' : (h.rMultiple ?? 0) < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                        {h.rMultiple != null ? `${h.rMultiple >= 0 ? '+' : ''}${h.rMultiple.toFixed(1)}R` : '—'}
                      </td>
                      <td className={`px-2 py-1.5 text-center font-bold ${(h.pnl ?? 0) > 0 ? 'text-emerald-400' : (h.pnl ?? 0) < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                        {h.pnl != null ? `${h.pnl >= 0 ? '+' : '−'}₹${Math.abs(h.pnl).toFixed(0)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!hasHistory && (
            <p className="text-[11px] text-slate-500 px-1">
              Abhi koi tracked history nahi hai — agle market session ke signals automatically track hone lagenge
              aur yahan win-rate + outcomes dikha denge.
            </p>
          )}
          <p className="text-[9px] text-slate-600 font-mono text-center pt-1 border-t border-white/5">
            Har published signal server-side track hota hai: T1 → 50% book + breakeven trail • SL/T2/EOD → final exit. Disciplined P&L model.
          </p>
        </div>
      )}
    </div>
  );
});
