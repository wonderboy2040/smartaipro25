// ============================================================
// src/components/aitrading/PerpIntelPanel.tsx — v12.0 PERP
// POSITIONING INTELLIGENCE (CoinDCX GLOBAL FUTURES desk)
// ------------------------------------------------------------
// The derivatives-positioning read the pro perp desk runs BEFORE
// entries: per symbol —
//   • FUNDING       (crowded longs pay / shorts pay = squeeze fuel)
//   • OI 24h CHANGE (new longs vs new shorts vs squeeze vs unwind)
//   • TOP-TRADER L/S RATIO (bade accounts kahan lean kar rahe hain)
//   • TAKER FLOW    (buy/sell aggression, 24h average)
//   • the derived POSITIONING READ (BULLISH/BEARISH/NEUTRAL + crowd
//     warnings) from the server's perpIntel engine
// Plus a desk-level summary: funding regime + bull/bear breadth.
//
// Data: GET /api/ai/perp-intel (Binance fapi public reference —
// CoinDCX publishes no positioning endpoints). 90s auto-refresh,
// honest degrade (partial fields, thin-confidence reads labeled).
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api';
import type { PerpIntelWire } from './types';

interface PerpIntelRow {
  base: string;
  pair: string;
  last: number | null;
  changePct: number | null;
  volume24hUSDT: number | null;
  intel: PerpIntelWire | { ok: false; base: string; reason?: string };
}

interface PerpIntelView {
  ok: boolean;
  at?: number;
  reason?: string;
  summary?: {
    scanned: number;
    bullish: number;
    bearish: number;
    neutral: number;
    avgFundingBps8h: number | null;
    fundingRegime: string;
    note: string;
  };
  symbols?: PerpIntelRow[];
}

const BIAS_STYLE: Record<string, string> = {
  BULLISH: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  BEARISH: 'bg-red-500/15 text-red-300 border-red-500/40',
  NEUTRAL: 'bg-slate-600/20 text-slate-400 border-slate-600/30',
};

const MATRIX_LABEL: Record<string, string> = {
  LONGS_BUILDING: 'OI↑P↑ NEW LONGS — trend fuel',
  SHORTS_BUILDING: 'OI↑P↓ NEW SHORTS — fresh pressure',
  SHORT_SQUEEZE: 'OI↓P↑ SQUEEZE — covering rally, fuel jaldi khatam',
  LONG_UNWIND: 'OI↓P↓ UNWIND — longs nikal rahe, pressure thak raha',
  FLAT: 'FLAT — clear positioning nahi',
};

export const PerpIntelPanel = memo(function PerpIntelPanel() {
  const [view, setView] = useState<PerpIntelView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/ai/perp-intel?limit=12', { signal: AbortSignal.timeout(30_000) });
      if (r.ok) {
        const data = (await r.json()) as PerpIntelView;
        setView(data);
        setErr(null);
      } else {
        setErr(`HTTP ${r.status}`);
      }
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 90_000);
    return () => clearInterval(t);
  }, [load]);

  const s = view?.summary;
  const rows = (view?.symbols || []).slice(0, 12);

  return (
    <div className="quantum-panel rounded-2xl p-4 bg-gradient-to-br from-violet-500/[0.06] via-transparent to-cyan-500/[0.05] border border-violet-500/20">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="flex items-center gap-2 text-xs font-black tracking-wider text-violet-300 hover:text-violet-200 transition-colors">
          <span className={open ? 'rotate-90 transition-transform' : 'transition-transform'}>▶</span>
          🛰️ PERP POSITIONING INTELLIGENCE
        </button>
        <span className="px-2 py-0.5 rounded-lg text-[9px] font-black bg-black/30 border border-slate-700 text-slate-400">USDT PERPS · BINANCE FAPI REF</span>
        {view?.ok && (
          <span className="text-[10px] font-mono text-slate-500">
            {view.at ? `${Math.max(0, Math.round((Date.now() - view.at) / 1000))}s ago` : ''}
          </span>
        )}
        {!view?.ok && !err && <span className="text-[10px] text-slate-500">loading…</span>}
        {err && <span className="text-[10px] text-amber-500/80" title={err}>⚠ unreachable — retrying every 90s</span>}
        <button onClick={load} className="ml-auto quantum-btn-ghost px-2 py-1 rounded-lg text-[10px] font-black" title="Refresh now">🔄</button>
      </div>

      {/* desk summary — the one-glance positioning read */}
      {s && view?.ok && (
        <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          <div className="bg-black/30 rounded-xl px-2.5 py-2 border border-slate-800">
            <div className="text-[8px] font-black tracking-widest text-slate-600">💰 FUNDING REGIME</div>
            <div className={`text-[11px] font-black font-mono ${s.avgFundingBps8h != null && s.avgFundingBps8h > 10 ? 'text-red-300' : s.avgFundingBps8h != null && s.avgFundingBps8h < -3 ? 'text-emerald-300' : 'text-slate-300'}`}>
              {s.avgFundingBps8h != null ? `${s.avgFundingBps8h > 0 ? '+' : ''}${s.avgFundingBps8h}bps/8h · ${s.fundingRegime}` : s.fundingRegime}
            </div>
          </div>
          <div className="bg-black/30 rounded-xl px-2.5 py-2 border border-slate-800">
            <div className="text-[8px] font-black tracking-widest text-slate-600">📈 POSITIONING BREADTH</div>
            <div className="text-[11px] font-black font-mono">
              <span className="text-emerald-300">{s.bullish} bull</span>
              <span className="text-slate-500"> / </span>
              <span className="text-red-300">{s.bearish} bear</span>
              <span className="text-slate-500"> / {s.neutral} flat</span>
            </div>
          </div>
          <div className="bg-black/30 rounded-xl px-2.5 py-2 border border-slate-800 col-span-2" title={s.note}>
            <div className="text-[8px] font-black tracking-widest text-slate-600">🧠 HOW TO READ</div>
            <div className="text-[10px] text-slate-400 leading-snug font-medium">Entry se PEHLE positioning check: signal ke AGAINST positioning = fuel missing → size down ya skip. Crowded side + funding = squeeze risk.</div>
          </div>
        </div>
      )}

      {open && (
        <div className="mt-2.5 space-y-1.5">
          {rows.length === 0 && (
            <div className="text-[11px] text-slate-500 text-center py-3">
              {view?.ok ? 'Positioning data abhi warm ho raha hai — 60s me dobara dekho.' : 'Data unavailable — Binance fapi unreachable ya disabled.'}
            </div>
          )}
          {rows.map(r => {
            const i = r.intel as PerpIntelWire;
            if (!i || (i as { ok?: boolean }).ok === false) {
              return (
                <div key={r.base} className="flex items-center gap-2 text-[10px] font-mono text-slate-600 bg-black/20 rounded-lg px-2.5 py-1.5">
                  <span className="font-black text-slate-400 w-14">{r.base}</span>
                  <span>⚠ intel unreachable</span>
                </div>
              );
            }
            const read = i.read;
            return (
              <div key={r.base} className="flex items-center gap-2 flex-wrap bg-black/25 rounded-lg px-2.5 py-1.5 border border-slate-800/60">
                <span className="text-[11px] font-black font-mono text-white w-14 shrink-0">{r.base}</span>
                {read && (
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-black tracking-wide border ${BIAS_STYLE[read.bias] || BIAS_STYLE.NEUTRAL}`}
                    title={(read.reasons || []).join('\n')}>
                    {read.label}{read.confidence !== 'full' ? ` · ${read.confidence === 'partial' ? 'PARTIAL DATA' : 'THIN'}` : ''}
                  </span>
                )}
                {read?.matrix && <span className="text-[9px] font-mono font-bold text-slate-400" title={MATRIX_LABEL[read.matrix] || read.matrix}>{MATRIX_LABEL[read.matrix] || read.matrix}</span>}
                {i.fundingBps8h != null && (
                  <span className={`text-[9px] font-mono font-bold ${i.fundingBps8h > 10 ? 'text-red-300' : i.fundingBps8h < -3 ? 'text-emerald-300' : 'text-slate-500'}`}
                    title="8h funding — positive = longs pay shorts">
                    fund {i.fundingBps8h > 0 ? '+' : ''}{i.fundingBps8h}bps
                  </span>
                )}
                {i.oiChangePct24h != null && (
                  <span className={`text-[9px] font-mono font-bold ${i.oiChangePct24h > 1.5 ? 'text-cyan-300' : i.oiChangePct24h < -1.5 ? 'text-amber-300' : 'text-slate-500'}`}
                    title="Open interest 24h change">
                    OI {i.oiChangePct24h > 0 ? '+' : ''}{i.oiChangePct24h}%
                  </span>
                )}
                {i.topLongShortRatio != null && (
                  <span className="text-[9px] font-mono font-bold text-slate-500" title="Top-trader long/short account ratio">L/S {i.topLongShortRatio}</span>
                )}
                {i.takerRatio24h != null && (
                  <span className={`text-[9px] font-mono font-bold ${i.takerRatio24h >= 1.03 ? 'text-emerald-300' : i.takerRatio24h <= 0.97 ? 'text-red-300' : 'text-slate-500'}`}
                    title="Taker buy/sell ratio (24h average) — aggressive flow">
                    taker {i.takerRatio24h}×
                  </span>
                )}
                {(read?.crowdedLongs || read?.crowdedShorts) && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500/15 text-amber-300 border border-amber-500/40"
                    title="Crowded side — squeeze risk on any opposite print">
                    🚩 {read.crowdedLongs ? 'LONGS CROWDED' : 'SHORTS CROWDED'}
                  </span>
                )}
                {r.changePct != null && (
                  <span className={`ml-auto text-[10px] font-mono font-bold ${r.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(1)}%
                  </span>
                )}
              </div>
            );
          })}
          {view?.ok && s && (
            <div className="text-[9px] text-slate-600 leading-relaxed pt-1">{s.note}</div>
          )}
        </div>
      )}
    </div>
  );
});
