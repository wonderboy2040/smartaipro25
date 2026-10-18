// ============================================================
// src/components/intraday/GateReplayPanel.tsx — v20.2
// ------------------------------------------------------------
// The INTRADAY GATE REPLAY harness UI: run the quant gate stack
// (MTF ladder · chase · OB/OS · confidence ladder · ATR plan ·
// T1-50%/BE-trail discipline) over historical 5m bars of any NSE
// symbol and SEE win-rate / avg R / PF / maxDD + which gate
// rejected how many bars. The tuning instrument the intraday
// engine never had — numbers, not vibes.
// Honest degrade + LOW SAMPLE warning; one request at a time.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api';

interface ReplayView {
  ok: boolean;
  symbol?: string;
  bars?: number;
  sessionBars?: number;
  window?: { from: string; to: string };
  trades?: number;
  wins?: number;
  losses?: number;
  winRate?: number | null;
  avgR?: number | null;
  profitFactor?: number | null;
  maxDD_R?: number;
  totalR?: number;
  byReason?: Record<string, number>;
  gates?: Record<string, number>;
  sampleNote?: string;
  honest?: string;
  error?: string;
}

const num = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(dp);

export const GateReplayPanel = memo(function GateReplayPanel({ symbols }: { symbols?: string[] }) {
  const [sym, setSym] = useState('');
  const [run, setRun] = useState<ReplayView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);
  // v20.3: unmount guard + abort — desk/tab switch mid-run left the 90s
  // replay request running and its setState firing on a dead component.
  const aliveRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { aliveRef.current = false; try { abortRef.current?.abort(); } catch { /* noop */ } }, []);

  const suggestions = (symbols || []).slice(0, 12);

  const execute = useCallback(async (symbol: string) => {
    const s = symbol.trim().toUpperCase();
    if (!s || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setRun(null);
    try {
      // v20.3: AbortController (abortable on unmount) + 90s hard timeout.
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const kill = setTimeout(() => { try { ctrl.abort(); } catch { /* noop */ } }, 90_000);
      let j: ReplayView;
      try {
        const r = await apiFetch(`/api/ai/replay?market=INDIA&symbol=${encodeURIComponent(s)}`, { signal: ctrl.signal });
        j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      } finally {
        clearTimeout(kill);
      }
      if (!aliveRef.current) return;
      if (j?.ok) setRun(j);
      else setErr(j?.error || 'replay failed');
    } catch {
      if (aliveRef.current) setErr('replay engine unreachable');
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!sym && suggestions.length) setSym(suggestions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols?.join(',')]);

  const g = run?.gates || {};
  const stats: Array<[string, string, string]> = run ? [
    ['TRADES', String(run.trades ?? 0), 'total replayed entries (T1-50% + BE-trail discipline)'],
    ['WIN RATE', `${run.winRate ?? '—'}%`, `${run.wins ?? 0}W / ${run.losses ?? 0}L`],
    ['AVG R', num(run.avgR, 3), 'per-trade R multiple (net)'],
    ['TOTAL R', num(run.totalR, 2), 'cumulative R over the window'],
    ['PROFIT FACTOR', run.profitFactor != null ? num(run.profitFactor) : '∞', 'gross win R ÷ gross loss R'],
    ['MAX DD', `${num(run.maxDD_R)}R`, 'peak-to-trough drawdown in R'],
  ] : [];

  return (
    <div className="quantum-panel rounded-2xl p-4" aria-label="gate replay harness">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-black text-cyan-300 tracking-wider">🧪 GATE REPLAY — 5m HARNESS</span>
        <span className="text-[9px] text-slate-500">MTF ladder · chase · OB/OS · conf ladder · ATR plan — historical bars pe</span>
        {busy && <span className="text-[9px] text-cyan-300 animate-pulse">replaying…</span>}
        {run?.window && <span className="ml-auto text-[9px] text-slate-600 font-mono">{run.window.from} → {run.window.to} · {run.sessionBars ?? 0} session bars</span>}
      </div>

      <div className="flex items-center gap-2 mt-2.5 flex-wrap">
        <input
          value={sym}
          onChange={e => setSym(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') void execute(sym); }}
          placeholder="SYMBOL (e.g. RELIANCE)"
          className="quantum-input px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-bold w-40"
          aria-label="replay symbol"
        />
        <button
          onClick={() => void execute(sym)}
          disabled={busy || !sym.trim()}
          className="quantum-btn px-3 py-1.5 rounded-lg text-[10px] font-black disabled:opacity-40"
        >
          ▶ RUN REPLAY
        </button>
        {suggestions.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {suggestions.slice(0, 6).map(s => (
              <button key={s} onClick={() => { setSym(s); void execute(s); }}
                className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-slate-800/40 text-slate-400 border-slate-700/40 hover:text-slate-200">
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <div className="mt-2 text-[10px] text-amber-500/90 font-bold">⚠ {err}</div>}

      {run && (
        <>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5">
            {stats.map(([l, v, t]) => (
              <div key={l} className="bg-black/30 rounded-lg px-2 py-1.5 text-center" title={t}>
                <div className="text-[8px] text-slate-500 font-black tracking-wider">{l}</div>
                <div className={`text-xs font-mono font-black ${l === 'AVG R' || l === 'TOTAL R' ? (Number(run.avgR) > 0 ? 'text-emerald-300' : 'text-red-300') : 'text-slate-200'}`}>{v}</div>
              </div>
            ))}
          </div>

          {/* gate funnel — which gate rejected what */}
          <div className="mt-2.5 flex items-center gap-1.5 flex-wrap text-[9px] font-mono font-bold">
            <span className="text-slate-500">GATE FUNNEL:</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-800/40 border border-slate-700/40 text-slate-300" title="bars in NSE session">bars {g.bars ?? 0}</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300" title="OB/OS suppression (RSI 70/30)">OB/OS {g.obos ?? 0}</span>
            <span className="px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-red-300" title="chase guard (≥2.5×ATR from EMA20 → conf cap 48)">chase-H {g.chaseHard ?? 0}</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300/90" title="soft chase (≥1.8×ATR)">chase-S {g.chaseSoft ?? 0}</span>
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300" title="MTF fully aligned (+3 conf)">aligned {g.mtfAligned ?? 0}</span>
            <span className="px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-red-300" title="MTF counter (−7 conf, STRONG demotion)">counter {g.mtfCounter ?? 0}</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-800/40 border border-slate-700/40 text-slate-400" title="below ACTION floor / neutral">below-floor {g.belowAction ?? 0}</span>
            <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300" title="entries that cleared every gate">entries {g.entries ?? 0}</span>
          </div>

          {/* exits breakdown */}
          {run.byReason && Object.keys(run.byReason).length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[9px] font-mono font-bold">
              <span className="text-slate-500">EXITS:</span>
              {Object.entries(run.byReason).map(([k, v]) => (
                <span key={k} className={`px-1.5 py-0.5 rounded border ${k === 'T2' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : k === 'SL' ? 'bg-red-500/10 border-red-500/30 text-red-300' : 'bg-slate-800/40 border-slate-700/40 text-slate-400'}`}>
                  {k} {v}
                </span>
              ))}
            </div>
          )}

          {(run.sampleNote || '').startsWith('LOW') && (
            <div className="mt-2 text-[10px] text-amber-400/90 font-bold">⚠ {run.sampleNote}</div>
          )}
          <div className="mt-2 text-[9px] text-slate-600 leading-relaxed">{run.honest}</div>
        </>
      )}
    </div>
  );
});
