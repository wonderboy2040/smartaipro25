// ============================================================
// src/components/aitrading/DeepQualityBlock.tsx — v6.12
// ------------------------------------------------------------
// The PRO TRADER BRAIN blocks for the deep-analysis modal:
//   1. MTF SNAPSHOT — the LTF (15m India / 1h crypto) indicator
//      state next to the daily HTF, so the user SEES the alignment
//      (or the conflict) the quality layer graded.
//   2. EDGE STATS — the walk-forward replay of the SAME ensemble
//      on this symbol's recent bars: win-rate, avg R, profit
//      factor, sample size. Honest colors: a negative-expectancy
//      setup shows RED — "is setup ne recent history me paisa
//      khoya hai" is the single most pro sentence on the desk.
// ============================================================
import type { EdgeStats, LtfSnapshot, SignalQuality } from './types';

const n2 = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(dp);

export function MtfBlock({ ltf, quality }: { ltf?: LtfSnapshot | null; quality?: SignalQuality | null }) {
  const mtf = quality?.mtf;
  const phase = mtf?.phase || 'UNAVAILABLE';
  // v18.5: the mtf6 engine writes its own title (per-TF range) into
  // quality.mtf.engine/consensus — the header no longer hard-codes
  // "DAILY vs {label}" (crypto deep used to show a false DAILY label
  // while the server compared 1h-vs-1h).
  const mtfTitle = (mtf as { engine?: string; consensus?: string; agreementPct?: number } | undefined)?.engine === 'mtf6'
    ? `🧭 MTF-6 — 1m/5m/15m/1h/4h/1d · ${(mtf as { consensus?: string }).consensus ?? 'NEUTRAL'}${(mtf as { agreementPct?: number }).agreementPct != null ? ` · ${(mtf as { agreementPct?: number }).agreementPct}% agreement` : ''}`
    : `🧭 MTF — DAILY vs ${ltf?.label?.toUpperCase() ?? 'LTF'}`;
  const phaseCls = phase === 'ALIGNED'
    ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
    : phase === 'COUNTER_HTF' || phase === 'MISALIGNED'
      ? 'text-red-300 bg-red-500/10 border-red-500/30'
      : 'text-amber-300 bg-amber-500/10 border-amber-500/30';
  // v6.12.1: null EMAs → neutral (n/a) chip, not a misleading red stack
  const emasKnown = ltf?.ema20 != null && ltf?.ema50 != null;
  const bull = emasKnown ? (ltf?.ema20 ?? 0) > (ltf?.ema50 ?? 0) : null;
  return (
    <div className="mt-3 bg-violet-500/[0.05] border border-violet-500/15 rounded-xl p-3" aria-label="multi timeframe snapshot">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-black text-violet-300 tracking-wider">{mtfTitle}</div>
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${phaseCls}`}>{phase}</span>
      </div>
      {ltf ? (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 text-[10px] font-mono">
          <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">RSI</span><span className="text-slate-200">{n2(ltf.rsi, 1)}</span></div>
          <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">MACD-h</span><span className={ltf.macdHist == null ? 'text-slate-200' : ltf.macdHist > 0 ? 'text-emerald-300' : 'text-red-300'}>{n2(ltf.macdHist)}</span></div>
          <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">EMA20</span><span className="text-slate-200">{n2(ltf.ema20, 1)}</span></div>
          <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">EMA50</span><span className="text-slate-200">{n2(ltf.ema50, 1)}</span></div>
          <div className="flex justify-between bg-black/30 rounded px-2 py-1">
            <span className="text-slate-500">STACK</span>
            <span className={bull == null ? 'text-slate-500' : bull ? 'text-emerald-300' : 'text-red-300'}>{bull == null ? 'n/a' : bull ? '20>50 ▲' : '20<50 ▼'}</span>
          </div>
        </div>
      ) : (
        <div className="text-[10px] text-slate-500">LTF candles unavailable — MTF check skip (honest degrade, koi penalty nahi)</div>
      )}
    </div>
  );
}

export function EdgeBlock({ edge }: { edge?: EdgeStats | null }) {
  if (!edge) return null;
  const wr = edge.winRate ?? 0;
  const avgR = edge.avgR ?? 0;
  const good = avgR > 0.05 && wr >= 45;
  const bad = avgR < -0.05 || wr < 35;
  const cls = good ? 'text-emerald-300' : bad ? 'text-red-300' : 'text-amber-300';
  const verdict = good
    ? 'Recent bars pe ye ensemble setup positive expectancy dikha raha hai'
    : bad
      ? '⚠ Recent history me ye setup paisa KHOTA raha hai — trade sirf tab jab quality chips green hon'
      : 'Breakeven-ish recent record — edge marginal hai, size chhota rakho';
  return (
    <div className="mt-3 bg-amber-500/[0.04] border border-amber-500/20 rounded-xl p-3" aria-label="walk-forward edge stats">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-black text-amber-300 tracking-wider">📉 EDGE — WALK-FORWARD REPLAY ({edge.timeframe} bars × {edge.bars})</div>
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${good ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : bad ? 'bg-red-500/10 text-red-300 border-red-500/30' : 'bg-amber-500/10 text-amber-300 border-amber-500/30'}`}>{edge.trades} trades</span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-[10px] font-mono">
        <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">WIN%</span><span className={cls}>{wr.toFixed(1)}</span></div>
        <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">AVG R</span><span className={cls}>{avgR.toFixed(2)}</span></div>
        <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">TOT R</span><span className={cls}>{(edge.totalR ?? 0).toFixed(1)}</span></div>
        <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">PF</span><span className={cls}>{edge.profitFactor == null ? '—' : edge.profitFactor.toFixed(2)}</span></div>
        <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">MAX DD</span><span className="text-slate-200">{(edge.maxDDR ?? 0).toFixed(1)}R</span></div>
        <div className="flex justify-between bg-black/30 rounded px-2 py-1"><span className="text-slate-500">HOLD</span><span className="text-slate-200">{edge.avgHoldBars == null ? '—' : `${Math.round(edge.avgHoldBars)}b`}</span></div>
      </div>
      <div className="text-[10px] mt-1.5 font-bold text-slate-400">{verdict}</div>
      <div className="text-[9px] mt-1 text-slate-600 leading-relaxed">{edge.disclaimer}</div>
    </div>
  );
}
