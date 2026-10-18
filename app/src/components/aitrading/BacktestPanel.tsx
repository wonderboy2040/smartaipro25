// ============================================================
// src/components/aitrading/BacktestPanel.tsx — v6.5
// ------------------------------------------------------------
// Walk-forward replay of the SAME full-committee ensemble on historical
// candles. Shows the honest question users actually ask: "would
// these signals have made money?" — win rate, avg R, profit
// factor, max drawdown, equity curve, per-symbol table.
// v6.7: backtest-LEARNED gate recommendation (read-only — user applies).
// ============================================================
import { memo, useCallback, useEffect, useState } from 'react';
import type { BacktestResult, StrategyLabResult } from './types';

const fmtINR = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '−';
  const a = Math.abs(n);
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  return `${s}₹${a.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

function EquityCurve({ equity }: { equity: NonNullable<BacktestResult['equity']> }) {
  const pts = equity.filter(e => e.cumR != null);
  if (pts.length < 2) return null;
  const w = 600, h = 90, pad = 4;
  const vals = pts.map(p => p.cumR as number);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / range) * (h - 2 * pad);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cumR as number).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  const final = vals[vals.length - 1];
  const up = final >= 0;
  return (
    <div className="bg-black/30 rounded-xl p-2.5" aria-label="equity curve">
      <div className="flex items-center justify-between text-[10px] font-black mb-1">
        <span className="text-slate-500 tracking-wider">EQUITY CURVE (cumulative R)</span>
        <span className={`font-mono ${up ? 'text-emerald-400' : 'text-red-400'}`}>{final >= 0 ? '+' : ''}{final.toFixed(1)}R</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[90px]" preserveAspectRatio="none" role="img" aria-label={`cumulative R over ${pts.length} trades`}>
        <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="rgba(148,163,184,0.25)" strokeDasharray="3 3" strokeWidth="1" />
        <path d={line} fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

interface Props {
  market: 'INDIA' | 'CRYPTO';
  runBacktest: (market: 'INDIA' | 'CRYPTO', minGrade?: string, opts?: { walkForward?: boolean }) => Promise<BacktestResult | null>;
  /** v10.8: NL Custom Strategy Lab runner (optional — panel degrades without it) */
  runStrategyLab?: (description: string, market: 'INDIA' | 'CRYPTO') => Promise<StrategyLabResult | null>;
}

export const BacktestPanel = memo(function BacktestPanel({ market, runBacktest, runStrategyLab }: Props) {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [grade, setGrade] = useState<'ACTION' | 'STRONG' | 'WATCH'>('ACTION');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // v21.1.1 [audit A5]: walk-forward toggle — 70/30 train/test split,
  // overfit verdict per symbol (Phase-4 feature pehle API-only tha).
  const [walkForward, setWalkForward] = useState(false);

  const run = useCallback(async () => {
    setRunning(true); setErr(null);
    const r = await runBacktest(market, grade, { walkForward });
    setRunning(false);
    if (!r || !r.ok) { setErr(r?.disclaimer ? null : 'backtest data unavailable — try again'); setResult(r); return; }
    setResult(r);
  }, [market, grade, runBacktest, walkForward]);

  // auto-run once per market switch (cheap: 10-min server cache)
  useEffect(() => { setResult(null); setErr(null); }, [market]);

  const s = result?.stats;
  const wfVerdictColor = (v?: string) => v === 'CALIBRATED' ? 'text-emerald-300'
    : v === 'OVERFIT_HIGH' || v === 'HIGH' ? 'text-red-300'
    : v === 'MODERATE' ? 'text-amber-300' : 'text-slate-300';

  return (
    <div className="quantum-panel rounded-2xl p-4 space-y-3" aria-label="Backtest panel">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-black text-slate-200">📉 BACKTEST — {market === 'INDIA' ? 'NSE daily candles' : 'crypto 1h candles'}</span>
        <div className="flex gap-1 ml-1" role="group" aria-label="Minimum grade">
          {(['ACTION', 'STRONG', 'WATCH'] as const).map(g => (
            <button key={g} onClick={() => setGrade(g)} aria-pressed={grade === g}
              className={`px-2 py-0.5 rounded-lg text-[9px] font-black border ${grade === g ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' : 'bg-black/20 text-slate-500 border-slate-700/40'}`}>
              {g}
            </button>
          ))}
        </div>
        {/* v21.1.1 [audit A5]: walk-forward mode toggle */}
        <button onClick={() => setWalkForward(w => !w)} aria-pressed={walkForward} title="70/30 train/test split — out-of-sample overfit verdict per symbol (Phase-4)"
          className={`px-2 py-0.5 rounded-lg text-[9px] font-black border ${walkForward ? 'bg-violet-500/15 text-violet-300 border-violet-500/40' : 'bg-black/20 text-slate-500 border-slate-700/40'}`}>
          🔬 WALK-FORWARD {walkForward ? 'ON' : 'OFF'}
        </button>
        <button onClick={run} disabled={running}
          className="ml-auto px-3 py-1.5 rounded-lg text-[10px] font-black bg-gradient-to-r from-violet-600 to-indigo-600 text-white disabled:opacity-50">
          {running ? '⏳ REPLAYING HISTORY…' : '▶ RUN BACKTEST'}
        </button>
      </div>

      {result?.ok && s && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            {[
              { l: 'TRADES', v: String(s.trades), c: 'text-slate-200' },
              { l: 'WIN RATE', v: s.winRate != null ? `${s.winRate}%` : '—', c: (s.winRate ?? 0) >= 50 ? 'text-emerald-300' : 'text-amber-300' },
              { l: 'AVG R', v: s.avgR != null ? `${s.avgR >= 0 ? '+' : ''}${s.avgR}` : '—', c: (s.avgR ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300' },
              { l: 'PROFIT FACTOR', v: s.profitFactor != null && Number.isFinite(s.profitFactor) ? String(s.profitFactor) : '∞', c: (s.profitFactor ?? 0) >= 1.2 ? 'text-emerald-300' : 'text-amber-300' },
              { l: 'MAX DD', v: `−${s.maxDDR ?? 0}R`, c: 'text-red-300' },
              { l: `P&L @₹${(result.params?.capitalPerTradeINR ?? 1000).toLocaleString('en-IN')}`, v: fmtINR(s.pnlINR), c: (s.pnlINR ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300' },
            ].map(x => (
              <div key={x.l} className="bg-black/30 rounded-lg px-2 py-1.5 text-center">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">{x.l}</div>
                <div className={`text-xs font-mono font-bold ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>

          {result.equity && result.equity.length > 1 && <EquityCurve equity={result.equity} />}

          {/* v21.1.1 [audit A5]: walk-forward verdicts — train vs test expectancy + overfit call */}
          {result.walkForward && (result.walkForward.summary || (result.walkForward.perSymbol || []).length > 0) && (
            <div className="rounded-xl p-2.5 border bg-violet-500/5 border-violet-500/25">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[10px] font-black text-violet-300 tracking-wider">🔬 WALK-FORWARD — out-of-sample check</span>
                {result.walkForward.summary ? (
                  <>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-black bg-black/30 text-emerald-300">CALIBRATED × {result.walkForward.summary.calibrated}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-black bg-black/30 text-amber-300">MODERATE × {result.walkForward.summary.moderate}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-black bg-black/30 text-red-300">HIGH × {result.walkForward.summary.high}</span>
                  </>
                ) : null}
              </div>
              <div className="space-y-0.5 max-h-28 overflow-y-auto">
                {(result.walkForward.perSymbol || []).map(w => (
                  <div key={w.symbol} className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="text-slate-300 w-20 truncate">{w.symbol}</span>
                    <span className="text-slate-500">train {(w.train?.atLearnedBar?.avgR ?? 0) >= 0 ? '+' : ''}{w.train?.atLearnedBar?.avgR ?? '—'}R</span>
                    <span className="text-slate-500">test {(w.test?.learnedBar?.avgR ?? 0) >= 0 ? '+' : ''}{w.test?.learnedBar?.avgR ?? '—'}R</span>
                    <span className="text-slate-600 hidden sm:inline">{w.verdict?.comparisonBasis === 'learned-bar' ? '' : '· base-split'}</span>
                    <span className={`ml-auto font-black ${wfVerdictColor(w.verdict?.overfit)}`}>{w.verdict?.overfit ?? '—'}{w.verdict?.degradationPct != null ? ` (−${w.verdict.degradationPct}%)` : ''}</span>
                  </div>
                ))}
              </div>
              <div className="text-[9px] text-slate-600 mt-1">Train (pehle 70%) pe seekhe gaye gates ko test (aakhri 30%) pe validate karta hai — HIGH verdict = gates sirf history pe kaam karte hain (overfit).</div>
            </div>
          )}

          {/* v6.7: learned gate recommendation */}
          {result.learned && (
            <div className={`rounded-xl p-2.5 border ${result.learned.changed ? 'bg-violet-500/5 border-violet-500/25' : 'bg-black/20 border-white/5'}`}>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-[10px] font-black text-violet-300 tracking-wider">🧓 LEARNED GATES — backtest se seekha gaya</span>
                {result.learned.changed ? (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-violet-500/15 text-violet-300 border border-violet-500/25">
                    SUGGEST: {result.learned.currentMinConfidence}% → {result.learned.suggestedMinConfidence}%
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-slate-600/20 text-slate-400">no change recommended</span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5 mb-1.5">
                {Object.entries(result.learned.perGrade || {}).map(([g, p]) => (
                  <div key={g} className="bg-black/30 rounded-lg px-2 py-1 text-center">
                    <div className="text-[8px] text-slate-500 font-black tracking-wider">{g}</div>
                    <div className="text-[11px] font-mono font-black text-slate-200">{p.winRate != null ? `${p.winRate}%` : '—'} <span className="text-slate-600 text-[9px]">({p.n} trades)</span></div>
                    <div className="text-[9px] font-mono text-slate-500">avg {(p.avgR ?? 0) >= 0 ? '+' : ''}{p.avgR ?? '—'}R</div>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-slate-400 leading-relaxed">{result.learned.recommendation}</div>
              <div className="text-[9px] text-slate-600 mt-1">{result.learned.disclaimer} Apply karne ke liye: Execution Console → Risk settings → Min confidence {result.learned.suggestedMinConfidence ?? result.learned.currentMinConfidence}% set karo.</div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="bg-black/20 rounded-xl p-2.5">
              <div className="text-[10px] font-black text-slate-500 tracking-wider mb-1.5">PER SYMBOL</div>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {(result.perSymbol || []).filter(p => p.ok).map(p => (
                  <div key={p.symbol} className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="text-slate-300 w-20 truncate">{p.symbol}</span>
                    <span className="text-slate-500 w-14">{p.stats?.trades ?? 0} trades</span>
                    <span className={(p.stats?.winRate ?? 0) >= 50 ? 'text-emerald-400' : 'text-amber-400'}>{p.stats?.winRate ?? '—'}% win</span>
                    <span className={`ml-auto ${(p.stats?.avgR ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{(p.stats?.avgR ?? 0) >= 0 ? '+' : ''}{p.stats?.avgR ?? '—'}R</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-black/20 rounded-xl p-2.5">
              <div className="text-[10px] font-black text-slate-500 tracking-wider mb-1.5">EXIT REASONS</div>
              <div className="flex gap-1.5 flex-wrap">
                {Object.entries(result.exitDist || {}).map(([k, v]) => (
                  <span key={k} className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${k === 'TP2' ? 'bg-emerald-500/10 text-emerald-300' : k === 'SL' ? 'bg-red-500/10 text-red-300' : 'bg-slate-600/20 text-slate-400'}`}>
                    {k} × {v}
                  </span>
                ))}
              </div>
              <div className="mt-2 text-[9px] text-slate-500 leading-relaxed">
                Discipline mirrors the live watcher: TP1 does NOT close (winners run to TP2), SL-first on ambiguous bars, 0.1% slippage both sides.
              </div>
            </div>
          </div>

          <p className="text-[9px] text-slate-600 leading-relaxed">{result.disclaimer}</p>
        </>
      )}

      {result && !result.ok && (
        <div className="text-[11px] text-amber-400/90 font-bold bg-amber-500/5 border border-amber-500/20 rounded-xl px-3 py-2.5">
          {market === 'INDIA'
            ? 'Historical daily candles unavailable for the default India set (Yahoo may be rate-limiting) — retry in a minute, symbols neeche board se chun ke bhi try kar sakte ho.'
            : 'CoinDCX candle history unavailable right now — retry in a minute.'}
        </div>
      )}
      {err && <div className="text-[11px] text-red-400 font-bold">⚠️ {err}</div>}
      {!result && !running && !err && (
        <div className="text-[11px] text-slate-500">
          Run karo — SAME live ensemble (indicators → full-committee votes → consensus → risk-capped plan) historical candles par replay hota hai.
          {market === 'INDIA' ? ' India: 2 saal daily candles, max 5-day hold.' : ' Crypto: 300 × 1h candles, max 48h hold.'}
        </div>
      )}

      {/* v10.8 PRO #2: NL CUSTOM STRATEGY LAB — describe an idea in plain
          English → LLM compiles BOUNDED whitelist rules → validated →
          walk-forward replay on the SAME candle history. */}
      {runStrategyLab && <StrategyLab market={market} run={runStrategyLab} />}
    </div>
  );
});

/** v10.8: the Custom Strategy Lab block. */
function StrategyLab({ market, run }: { market: 'INDIA' | 'CRYPTO'; run: (description: string, market: 'INDIA' | 'CRYPTO') => Promise<StrategyLabResult | null> }) {
  const [desc, setDesc] = useState('');
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<StrategyLabResult | null>(null);

  const runLab = useCallback(async () => {
    if (desc.trim().length < 8) return;
    setRunning(true); setOut(null);
    const r = await run(desc.trim(), market);
    setRunning(false);
    setOut(r);
  }, [desc, market, run]);

  // reset on market switch
  useEffect(() => { setOut(null); }, [market]);

  const s = out?.stats;
  const cond = (c: { indicator: string; operator?: string; value: number | string }) =>
    c.indicator === 'emaStack' ? `EMA stack ${String(c.value)}` : `${c.indicator} ${c.operator} ${c.value}`;

  return (
    <div className="mt-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3 space-y-2.5" data-testid="strategy-lab" aria-label="custom strategy lab">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-black text-violet-300 tracking-wider">🧪 CUSTOM STRATEGY LAB — apna idea bolo, history par test karo</span>
        <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-black/30 border border-violet-500/25 text-violet-300" title="an LLM compiles your idea into a bounded whitelist rule set — validated before anything runs, never free-form code">
          LLM → SAFE RULES → REPLAY
        </span>
      </div>
      <div className="flex gap-2 flex-col sm:flex-row">
        <textarea
          value={desc}
          onChange={e => setDesc(e.target.value)}
          placeholder={market === 'INDIA'
            ? 'e.g. "RELIANCE jab RSI 30 ke upar cross kare aur volume 2x average ho tab LONG — exit 2R ya 20 din, stop 2×ATR"'
            : 'e.g. "buy BTC when RSI crosses above 30 and volume is 2x average — exit at 2R or 48 bars, stop 2×ATR"'}
          rows={2}
          maxLength={800}
          className="flex-1 bg-black/30 border border-violet-500/20 rounded-xl px-3 py-2 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/50 resize-none"
          aria-label="strategy description"
        />
        <button onClick={runLab} disabled={running || desc.trim().length < 8}
          className="sm:w-36 px-3 py-2 rounded-xl text-[10px] font-black bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white disabled:opacity-40 shrink-0"
          title="compile + validate + walk-forward replay">
          {running ? '⏳ TESTING…' : '▶ TEST STRATEGY'}
        </button>
      </div>
      {out?.error && (
        <div className="text-[10px] text-amber-400/90 font-mono bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-2">⚠ {out.error}</div>
      )}
      {out?.ok && s && (
        <div className="space-y-2">
          {/* the EXACT rules that ran — full transparency */}
          <div className="bg-black/30 rounded-lg px-2.5 py-2 text-[10px] font-mono text-slate-300">
            <span className="text-violet-300 font-black">RULES THAT RAN:</span>{' '}
            {out.rules?.direction} · {out.rules?.entry.map(cond).join(' AND ')}
            {out.rules?.exit?.length ? ` · EXIT: ${out.rules.exit.map(cond).join(' OR ')}` : ''}
            {' '}· SL {out.rules?.stopLossAtr}×ATR · TP {out.rules?.takeProfitR}R · max hold {out.rules?.maxHoldBars} bars
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            {[
              { l: 'TRADES', v: String(s.trades), c: 'text-slate-200' },
              { l: 'WIN RATE', v: s.winRate != null ? `${s.winRate}%` : '—', c: (s.winRate ?? 0) >= 50 ? 'text-emerald-300' : 'text-amber-300' },
              { l: 'AVG R', v: s.avgR != null ? `${s.avgR >= 0 ? '+' : ''}${s.avgR}` : '—', c: (s.avgR ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300' },
              { l: 'PROFIT FACTOR', v: s.profitFactor != null && Number.isFinite(s.profitFactor) ? String(s.profitFactor) : '∞', c: (s.profitFactor ?? 0) >= 1.2 ? 'text-emerald-300' : 'text-amber-300' },
              { l: 'MAX DD', v: `−${s.maxDDR ?? 0}R`, c: 'text-red-300' },
              { l: `P&L @₹${(out.params?.capitalPerTradeINR ?? 1000).toLocaleString('en-IN')}`, v: fmtINR(s.pnlINR), c: (s.pnlINR ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300' },
            ].map(x => (
              <div key={x.l} className="bg-black/30 rounded-lg px-2 py-1.5 text-center">
                <div className="text-[8px] text-slate-500 font-black tracking-wider">{x.l}</div>
                <div className={`text-xs font-mono font-bold ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="text-[9px] font-black text-slate-500 tracking-wider">EXITS:</span>
            {Object.entries(out.exitDist || {}).map(([k, v]) => (
              <span key={k} className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${k === 'TP' ? 'bg-emerald-500/10 text-emerald-300' : k === 'SL' ? 'bg-red-500/10 text-red-300' : 'bg-slate-600/20 text-slate-400'}`}>
                {k} × {v}
              </span>
            ))}
            <span className="text-[9px] text-slate-600 ml-auto">{out.scannedSymbols} symbols · {out.disclaimer ? 'walk-forward, no look-ahead' : ''}</span>
          </div>
          <p className="text-[9px] text-slate-600 leading-relaxed">{out.disclaimer}</p>
        </div>
      )}
    </div>
  );
}
