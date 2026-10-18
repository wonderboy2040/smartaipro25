// ============================================================
// src/components/aitrading/SignalRecheckPanel.tsx — v20.7.5
// ------------------------------------------------------------
// THE 15-SECOND SIGNAL RECHECK PANEL — the user's explicit ask:
// "AI ko sabhi trading 80+ signals (Strong + Action) har 15 sec
// recheck karta rahe."
//
// Mirrors server/ai/signalRecheck.js's loop at the SAME 15s
// cadence: every STRONG/ACTION signal across all four desks with
// its LIVE recheck state —
//   🚨 INVALIDATED (SL through — entry mat karo)
//   ⚠️ WEAKENING   (>0.75 ATR against the signal)
//   🎯 TARGET_1/2  (plan levels touched)
//   ✅ OK          (thesis holds at the live price)
// plus the committee's own re-vote transitions (FLIPPED / grade
// drift) and the loop's event feed. Problems sort FIRST.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getProxyBase } from '../../utils/api';

interface AutoTradeMonitorRow {
  symbol: string | null;
  market: string;
  ccy: string;
  side: string;
  entry: number;
  ltp: number;
  initialStopLoss: number;
  trailedStopLoss: number;
  slTrailed: boolean;
  t1: number;
  t2: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  peakPrice: number;
  currentR: number;
  peakR: number;
  peakGivebackPct: number;
  feeBreakevenPrice: number;
  feeCovered: boolean;
  grossPnl: number;
  distToTp1Pct: number | null;
  distToTp2Pct: number | null;
  stageCode: string;
  stageLabel: string;
  trendStatus: string;
  reversalDetected: boolean;
  shouldBookProfitNow: boolean;
  traded?: boolean;
  fullControl?: boolean;
  livePositionId?: string | null;
  executionMode?: string;
  leverage?: number;
  walletDeployPct?: number;
  deployedWalletINR?: number;
}

interface RecheckRow {
  market: string; symbol: string; side: string; grade: string;
  confidence: number | null; aiScore: number | null;
  entry: number | null; stopLoss: number | null; target1: number | null; target2: number | null;
  ltp: number | null; ltpAgeS: number | null; ltpSrc: string | null; movePct: number | null;
  state: string; reason: string; checks: number;
  // v20.9.3 FIX (L): UC verdict fields the server already ships — pehle
  // type me hi omit the, isliye render bhi nahi hote the (dead payload).
  ultrafast?: string | null; ultrafastAnswer?: string | null;
  lastCheckAgeS: number | null; events: { at: number; type: string; note: string }[];
  isAutoTrade?: boolean;
  autoTradeMonitor?: AutoTradeMonitorRow | null;
}
interface RecheckView {
  ok: boolean; enabled: boolean; started: boolean; tickMs: number;
  lastTickAt: number | null; nextTickIn: number | null;
  ticks: number; checks: number; events: number; watched: number;
  lastError: string | null;
  eventsFeed: { at: number; type: string; market: string; symbol: string; reason: string }[];
  autoTradeDeepMonitor?: {
    activeCount: number;
    trailingActiveCount: number;
    tp1LockedCount: number;
    reversalAlertCount: number;
    trades: AutoTradeMonitorRow[];
    checkedAt: number;
  };
  rows: RecheckRow[];
  note?: string;
}

const POLL_MS = 15_000;

const STATE_STYLE: Record<string, { chip: string; label: string }> = {
  INVALIDATED: { chip: 'bg-red-500/20 text-red-300 border-red-500/50', label: '🚨 INVALIDATED' },
  FLIPPED: { chip: 'bg-red-500/20 text-red-300 border-red-500/50', label: '🔄 FLIPPED' },
  WEAKENING: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/40', label: '⚠️ WEAKENING' },
  TARGET_2: { chip: 'bg-sky-500/15 text-sky-300 border-sky-500/40', label: '🏆 T2 TOUCHED' },
  TARGET_1: { chip: 'bg-sky-500/15 text-sky-300 border-sky-500/40', label: '🎯 T1 TOUCHED' },
  PENDING: { chip: 'bg-slate-600/20 text-slate-400 border-slate-600/30', label: '⏳ PENDING' },
  OK: { chip: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', label: '✅ OK' },
  EXPIRED: { chip: 'bg-slate-600/20 text-slate-500 border-slate-600/30', label: 'EXPIRED' },
};

const DESK_TAG: Record<string, string> = {
  CRYPTO: '₿', FUTURES: '🛡', INDIA: '🇮🇳', GLOBALFUTURES: '🌍',
};

const fmtPx = (v: number | null): string => (v == null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: v < 1 ? 6 : 2 }));

export const SignalRecheckPanel = memo(function SignalRecheckPanel({ market }: { market?: 'CRYPTO' | 'FUTURES' | 'INDIA' | 'GLOBALFUTURES' }) {
  const [view, setView] = useState<RecheckView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/signal-recheck?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => null);
      if (!alive.current) return;
      if (j?.ok) { setView(j as RecheckView); setErr(null); }
      else setErr(String(j?.error || 'unavailable'));
    } catch (e) {
      if (alive.current) setErr(String((e as Error)?.message || e));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    // 15s poll — the loop's own cadence (paused via the chip)
    const t = setInterval(() => { if (!paused) load(); }, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, paused]);

  const rows = (view?.rows || []).filter(r => !market || r.market === market || r.isAutoTrade);
  const activeAutoTrades = (view?.autoTradeDeepMonitor?.trades || []).filter(t => t.traded !== false);
  const problems = rows.filter(r => r.state === 'INVALIDATED' || r.state === 'WEAKENING').length;
  const strongN = rows.filter(r => r.grade === 'STRONG').length;
  const nextIn = view?.nextTickIn != null ? Math.max(0, Math.round(view.nextTickIn / 1000)) : null;

  return (
    <div className="quantum-panel rounded-2xl p-3.5">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-xs font-black text-violet-300 tracking-wide">🛡 SIGNAL RECHECK — 15s LIVE WATCH</h3>
            <span className="px-2 py-0.5 rounded-lg text-[9px] font-black border bg-violet-500/10 text-violet-300 border-violet-500/30">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse align-middle mr-1" />
              {view?.enabled === false ? 'OFF (AI_SIGNAL_RECHECK=off)' : nextIn != null ? `next ${nextIn}s` : 'starting…'}
            </span>
            {view && (
              <>
                <span className="px-2 py-0.5 rounded-lg text-[9px] font-black border bg-black/30 text-slate-400 border-slate-600/30" title="Strong + Action signals under watch">
                  👁 {view.watched} watched · {strongN} STRONG
                </span>
                {problems > 0 && (
                  <span className="px-2 py-0.5 rounded-lg text-[9px] font-black border bg-red-500/15 text-red-300 border-red-500/40">
                    ⚠ {problems} problem{problems > 1 ? 's' : ''}
                  </span>
                )}
                <span className="px-2 py-0.5 rounded-lg text-[9px] font-black border bg-black/30 text-slate-500 border-slate-600/30" title="Total 15s price checks since boot">
                  ✓ {view.checks} checks
                </span>
              </>
            )}
            <button onClick={() => setPaused(p => !p)} className="quantum-btn-ghost px-2 py-0.5 rounded-lg text-[9px] font-black" title="Poll pause/resume (server loop chalta rehta hai)">
              {paused ? '▶ resume' : '⏸ pause'}
            </button>
          </div>
          <p className="text-[9px] text-slate-600 mt-1 leading-relaxed">
            Har STRONG/ACTION signal + <span className="text-emerald-400 font-bold">Active Traded Auto-Trade (Full CoinDCX Position Control)</span> har <span className="text-violet-400 font-bold">15 sec</span> me live price se recheck aur Deep Monitor hota hai (Dynamic SL Trail · Reversal Profit-Book · TP1/TP2 touch) + ~60s me committee re-vote.
          </p>
        </div>
      </div>

      {/* v21.22.0 ACTIVE AUTO-TRADE DEEP MONITOR — 15s REALTIME ANALYSIS (SIRF ACTIVE TRADES) */}
      {view?.autoTradeDeepMonitor && (
        <div className="mb-2.5 rounded-xl border border-emerald-500/35 bg-emerald-950/20 p-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
              <span className="px-2 py-0.5 rounded-md font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                ⚡ AUTO-TRADE DEEP MONITOR (15s REALTIME) · SIRF ACTIVE TRADES
              </span>
              <span className="text-slate-300 font-bold">
                Active Traded: <span className="text-emerald-300 font-black">{activeAutoTrades.length}</span>
              </span>
              <span className="text-slate-400">
                · SL Trailed: <span className="text-cyan-300 font-black">{view.autoTradeDeepMonitor.trailingActiveCount}</span>
              </span>
              <span className="text-slate-400">
                · TP1 Locked: <span className="text-amber-300 font-black">{view.autoTradeDeepMonitor.tp1LockedCount}</span>
              </span>
              {view.autoTradeDeepMonitor.reversalAlertCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 font-black animate-pulse">
                  🛡️ {view.autoTradeDeepMonitor.reversalAlertCount} Reversal Profit-Book Guard Armed
                </span>
              )}
            </div>
            <span className="text-[9px] text-emerald-300/80 font-mono">
              🔒 Full CoinDCX Position Control · 100% Wallet + TP1/TP2 + Multi-Stage SL Trail + Reversal Auto Profit-Book
            </span>
          </div>
          {activeAutoTrades.length > 0 ? (
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
              {activeAutoTrades.map((at, idx) => {
                const isLong = at.side !== 'SHORT';
                const ccySym = at.ccy === 'INR' ? '₹' : '$';
                return (
                  <div key={`${at.symbol}-${idx}`} className="rounded-lg bg-black/40 border border-emerald-500/30 p-2 text-[10px] font-mono">
                    <div className="flex items-center justify-between gap-1 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <span className="font-black text-white">{at.symbol}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${isLong ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                          {at.side} · {at.leverage || 10}x ({at.walletDeployPct || 100}% Wallet)
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-emerald-500/15 text-emerald-200 border border-emerald-500/35">
                          🔒 FULL CONTROL
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                          {at.stageLabel}
                        </span>
                      </div>
                      <span className={`font-black ${at.currentR >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {at.currentR >= 0 ? '+' : ''}{at.currentR}R (Peak +{at.peakR}R)
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-[9px] text-slate-300 mt-1">
                      <span>Entry: <b>{ccySym}{fmtPx(at.entry)}</b></span>
                      <span>LTP: <b className="text-white">{ccySym}{fmtPx(at.ltp)}</b></span>
                      <span className="text-amber-300">Trailed SL: <b>{ccySym}{fmtPx(at.trailedStopLoss)}</b></span>
                      <span className="text-emerald-300">TP1: <b>{ccySym}{fmtPx(at.t1)}</b>{at.tp1Hit ? ' ✅' : ''}</span>
                      <span className="text-cyan-300">TP2: <b>{ccySym}{fmtPx(at.t2)}</b>{at.tp2Hit ? ' 🏆' : ''}</span>
                    </div>
                    <div className="mt-1 text-[9px] text-emerald-300/90 flex items-center justify-between">
                      <span>{at.trendStatus}</span>
                      <span>Fee-BE: {ccySym}{fmtPx(at.feeBreakevenPrice)} {at.feeCovered ? '✅ Covered' : '⏳'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-1 text-[9px] text-slate-400">
              Jab bhi MTF Dual-Board se Auto-Trade lagega, uska 15s Deep Monitor (Live PnL, Multi-Stage Trailing SL, TP1/TP2 distance, aur Bullish/Bearish Reversal Profit-Book Guard) yahan realtime chalega.
            </div>
          )}
        </div>
      )}

      {err && <div className="text-[10px] text-amber-400/90 font-bold mb-2">⚠ {err}</div>}

      {view && rows.length === 0 && (
        <div className="text-[10px] text-slate-500 py-3 text-center">
          Abhi koi STRONG/ACTION signal watch me nahi hai — board par jab bhi aayega, 15s watch khud shuru ho jayega.
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
          {rows.slice(0, 14).map(r => {
            const st = STATE_STYLE[r.state] || STATE_STYLE.PENDING;
            const long = r.side !== 'SHORT';
            const cur = r.market === 'FUTURES' ? '' : r.market === 'GLOBALFUTURES' ? '' : '₹';
            const suffix = r.market === 'FUTURES' ? ' USDT' : r.market === 'GLOBALFUTURES' ? ' USDC' : '';
            const moveTone = r.movePct == null ? '' : r.movePct > 0 ? 'text-emerald-300' : r.movePct < 0 ? 'text-red-300' : '';
            return (
              <div key={`${r.market}-${r.symbol}`} className="bg-black/25 rounded-xl px-2.5 py-2 border border-slate-800/60">
                <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
                  <span className="text-slate-500">{DESK_TAG[r.market] || '·'}</span>
                  <span className="font-black text-slate-200">{r.symbol}</span>
                  <span className={`font-black ${long ? 'text-emerald-400' : 'text-red-400'}`}>{r.side}</span>
                  <span className={`px-1.5 py-0.5 rounded font-black border ${r.grade === 'STRONG' ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' : 'bg-slate-600/20 text-slate-300 border-slate-600/40'}`}>
                    {r.grade}{r.aiScore != null ? ` · ${r.aiScore}` : ''}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded font-black border ${st.chip}`}>{st.label}</span>
                  {r.isAutoTrade && (
                    <span className="px-1.5 py-0.5 rounded font-black border bg-emerald-500/20 text-emerald-300 border-emerald-500/50">
                      ⚡ AUTO-TRADE DEEP MONITOR {r.autoTradeMonitor ? `· ${r.autoTradeMonitor.stageLabel}` : ''}
                    </span>
                  )}
                  {r.ultrafast === 'REJECTED' && (
                    <span className="px-1.5 py-0.5 rounded font-black border bg-rose-500/20 text-rose-300 border-rose-500/50 animate-pulse" title={r.ultrafastAnswer || 'realtime 1m chart against'}>⚡ UC REJECTED</span>
                  )}
                  {r.ultrafast === 'CONFIRMED' && (
                    <span className="px-1.5 py-0.5 rounded font-black border bg-cyan-500/15 text-cyan-300 border-cyan-500/40" title={r.ultrafastAnswer || 'realtime 1m chart agrees'}>⚡ UC OK</span>
                  )}
                  <span className="ml-auto text-slate-400">
                    LTP <span className="text-slate-100 font-black">{cur}{fmtPx(r.ltp)}{suffix}</span>
                    {r.movePct != null && <span className={`ml-1 ${moveTone}`}>({r.movePct >= 0 ? '+' : ''}{r.movePct}%)</span>}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap text-[9px] text-slate-500 mt-1">
                  <span>E {fmtPx(r.entry)}</span>
                  <span className="text-red-400/70">SL {fmtPx(r.stopLoss)}</span>
                  <span className="text-emerald-400/70">T1 {fmtPx(r.target1)}</span>
                  <span>T2 {fmtPx(r.target2)}</span>
                  <span className="ml-auto">
                    {r.lastCheckAgeS != null ? `✓ ${r.lastCheckAgeS}s ago · ${r.checks} checks` : 'first check…'}
                  </span>
                </div>
                {r.reason && (
                  <div className={`text-[9px] mt-1 leading-relaxed ${r.state === 'INVALIDATED' ? 'text-red-300 font-bold' : r.state === 'WEAKENING' ? 'text-amber-300' : 'text-slate-600'}`}>
                    {r.state === 'INVALIDATED' ? '⛔' : r.state === 'WEAKENING' ? '⚠️' : 'ℹ️'} {r.reason}
                  </div>
                )}
                {(r.events || []).length > 0 && (
                  <div className="text-[9px] text-slate-600 mt-1">
                    {r.events.slice(0, 2).map((e, i) => (
                      <span key={i} className="mr-2">• {e.type}{e.note ? ` — ${String(e.note).slice(0, 60)}` : ''}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view && (view.eventsFeed || []).length > 0 && (
        <div className="mt-2.5 pt-2 border-t border-slate-800/60">
          <div className="text-[9px] font-black text-slate-600 tracking-wider mb-1">EVENT FEED — recheck loop ne ye pakda</div>
          <div className="space-y-0.5 max-h-24 overflow-y-auto">
            {view.eventsFeed.slice(0, 6).map((e, i) => (
              <div key={`${e.at}-${i}`} className="text-[9px] font-mono text-slate-500 flex gap-2">
                <span className="text-slate-700">{new Date(e.at).toLocaleTimeString('en-IN', { hour12: false })}</span>
                <span className="text-slate-400">{DESK_TAG[e.market] || ''}{e.symbol}</span>
                <span className={e.type === 'INVALIDATED' || e.type === 'FLIPPED' || e.type === 'UC_REJECTED' ? 'text-red-300' : e.type === 'PROMOTED' || e.type === 'RECOVERED' || e.type === 'UC_CONFIRMED' ? 'text-emerald-300' : 'text-amber-300'}>{e.type}</span>
                {e.reason && <span className="text-slate-600 truncate">{String(e.reason).slice(0, 70)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
