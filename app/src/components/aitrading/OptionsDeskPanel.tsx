// ============================================================
// src/components/aitrading/OptionsDeskPanel.tsx — INDIA OPTIONS
// ------------------------------------------------------------
// Index selector · spot/VIX/PCR/max-pain strip · OI chain table
// (Greeks per strike) · ensemble-driven strategy cards with full
// P&L math. Clearly labels bs-model vs live NSE data.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { fetchOptionsDesk, fetchIncomeSetups, fetchOptionSignals, fetchOptionsScan, fetchCouncilVerdict } from './useAITrading';
import { openOptionPaperTrade } from '../intraday/PaperTradePanel';
import { apiFetch } from '../../utils/api';
import type { OptionsDesk, Strategy, GexProfile, IncomeView, OrderTicket, OptionSignalsView, OptionSignalCard, OptionsScanView, OptionsScanRow, CouncilStamp } from './types';

const INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'];

// v9.4 — premium formatter for the F&O signal cards (NSE ₹0.05 tick
// world): ≥100 → 1dp, else 2dp — "110.0" / "86.50" / "0.85".
const prem = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  return v >= 100 ? v.toFixed(1) : v.toFixed(2);
};

// ------------------------------------------------------------
// v9.4 — F&O OPTION SIGNAL CARDS. The user's exact requested format:
//
//     Stock name : Nifty50 17Sep 23400 CE
//     Target     : 110.00
//     Entry (Buy): 86.50
//     Stop Loss  : 77.00
//
// One card per index (NIFTY + SENSEX side by side), each distilled
// from the ensemble's INDEX consensus: LONG → BUY the ATM CE,
// SHORT → BUY the ATM PE; Target/SL = the option re-priced at the
// index plan's target1/stopLoss. Source chip stays honest (live NSE
// premiums vs BS model — SENSEX chain is BSE/datacenter-blocked so it
// rides the model with its label).
// ------------------------------------------------------------
function OptionSignalCardView({ c, onOpened }: { c: OptionSignalCard; onOpened?: (msg: string, ok: boolean) => void }) {
  const bull = c.direction === 'LONG';
  // v11.1 NSE+SENSEX addendum — three-way source honesty: live NSE /
  // live BSE / model. v21.0.4: the SENSEX desk now gets the REAL BSE
  // chain (Groww public mirror → direct BSE ladder), so the model chip
  // only fires when BOTH live paths are unreachable — still its own
  // explicit rose label instead of the generic amber "sometimes down"
  // framing NIFTY's recoverable fallback uses.
  const srcLabel = c.source === 'nse' ? 'LIVE NSE PREMIUM'
    : c.source === 'bse' ? 'LIVE BSE PREMIUM'
      : c.source === 'bs-model-sensex-always' ? 'SENSEX MODEL · NO LIVE FEED'
        : 'BS MODEL PREMIUM';
  const srcCls = c.source === 'nse' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
    : c.source === 'bse' ? 'bg-teal-500/10 text-teal-300 border-teal-500/25'
      : c.source === 'bs-model-sensex-always' ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
        : 'bg-amber-500/10 text-amber-300 border-amber-500/30';
  const srcTitle = c.source === 'nse' ? 'Live NSE chain premiums'
    : c.source === 'bse' ? 'Live BSE chain premiums (direct BSE ya Groww public mirror relay)'
      : c.source === 'bs-model-sensex-always'
        ? 'Live sources unreachable: BSE direct + Groww mirror dono is server se blocked — Black-Scholes model estimates. Auto-retry chalu rehta hai; live prices ke liye apna broker cross-check karo.'
        : 'NSE chain temporarily blocked from this server — Black-Scholes model premiums (IV anchored to India VIX). Recoverable: next successful NSE fetch restores live data.';
  // v9.6 superintelligence tier styling (AI score 85+ ELITE · 75+ STRONG · 65+ ACTION)
  const tier = (c.tier as string) || 'WATCH';
  const tierCls = tier === 'ELITE' ? 'bg-violet-500/15 text-violet-300 border-violet-500/40'
    : tier === 'STRONG' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
    : tier === 'ACTION' ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
    : 'bg-slate-600/20 text-slate-400 border-slate-600/40';
  // v9.5 F&O PAPER: one-click option paper trade (1 lot) from the card.
  const [paperBusy, setPaperBusy] = useState(false);
  const [paperMsg, setPaperMsg] = useState<string | null>(null);
  // v10.18 (deep-recheck #3): timer-ref toast — two rapid paper trades
  // used to let the FIRST timer erase the SECOND message early.
  const paperMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPaper = useCallback(async () => {
    if (paperBusy) return;
    setPaperBusy(true); setPaperMsg(null);
    const r = await openOptionPaperTrade({
      symbol: c.symbol, strike: c.strike, type: c.type, expiry: c.expiry,
      entry: c.entry, target: c.target, stopLoss: c.stopLoss,
      iv: c.iv, lotSize: c.lotSize, name: c.name,
    });
    setPaperBusy(false);
    const msg = r.ok
      ? `🧪 F&O paper trade opened — ${c.name} · 1 lot (${c.lotSize}) @ ₹${prem(c.entry)} · Paper Desk me abhi dikhega (watcher premium live re-price karega)`
      : `⛔ ${r.error || 'option paper trade failed'}`;
    setPaperMsg(msg);
    onOpened?.(msg, r.ok);
    if (paperMsgTimer.current) clearTimeout(paperMsgTimer.current);
    paperMsgTimer.current = setTimeout(() => setPaperMsg(null), 8000);
  }, [c, paperBusy, onOpened]);
  useEffect(() => () => { if (paperMsgTimer.current) clearTimeout(paperMsgTimer.current); }, []);
  return (
    <div className={`quantum-panel rounded-2xl p-4 ${bull ? 'border-l-2 border-l-emerald-500/60' : 'border-l-2 border-l-red-500/60'}`} data-testid="option-signal-card">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] font-black text-slate-500 tracking-wider">🎯 F&amp;O SIGNAL CARD</span>
        {c.aiScore != null && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${tierCls}`}
            title="AI score = 35% index-consensus + 20% POP-at-expiry + 15% reward:risk + 15% delta-fit (ATM ideal) + 15% grade">
            🧠 AI {c.aiScore} · {tier}
          </span>
        )}
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${bull ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-red-500/15 text-red-300 border-red-500/30'}`}>
          {c.trendTag || `${bull ? '▲ BULLISH' : '▼ BEARISH'} INDEX`}{c.consensus?.confidence != null ? ` · ${c.consensus.confidence}% conf` : ''}
        </span>
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${srcCls}`} title={srcTitle}>
          {srcLabel}
        </span>
        {c.dte != null && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${c.dte <= 1 ? 'bg-red-500/10 text-red-300 border-red-500/30' : 'bg-slate-600/20 text-slate-300 border-slate-600/30'}`}>
            {c.dte === 0 ? 'AAJ EXPIRY ⚠️' : `${c.dte} din baaki`}
          </span>
        )}
      </div>

      {/* v11.1 NSE+SENSEX addendum — the PERSISTENT (non-dismissible)
          limitation banner every SENSEX model card must carry. v21.0.4:
          fires only when BOTH live paths (direct BSE + Groww public
          mirror) are unreachable — until then the desk serves the
          REAL BSE chain with live premiums. */}
      {c.source === 'bs-model-sensex-always' && (
        <div className="mt-2 rounded-lg bg-rose-500/[0.07] border border-rose-500/30 px-2.5 py-1.5 text-[9px] text-rose-200/90 leading-relaxed" data-testid="sensex-model-banner">
          ⚠ SENSEX premiums are model-estimated — live BSE quotes (direct + Groww public mirror) are unreachable from this server right now; auto-retry chalu rehta hai. For live SENSEX option prices, cross-check your broker.
          {c.structuralDiscount ? ` AI score pe −${c.structuralDiscount} structural discount laga hai (no live-market cross-check possible).` : ''}
        </div>
      )}

      {/* THE card — user's exact format */}
      <div className="mt-2.5 rounded-xl bg-black/40 border border-cyan-500/20 p-3 font-mono">
        <div className="text-[9px] text-slate-500 font-black tracking-wider mb-2">STOCK NAME</div>
        <div className="text-base sm:text-lg font-black text-white tracking-tight break-words">{c.name}</div>
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] text-slate-400 font-bold">Target</span>
            <span className="font-black text-emerald-300">₹{prem(c.target)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] text-slate-400 font-bold">Entry (Buy)</span>
            <span className="font-black text-cyan-300">₹{prem(c.entry)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] text-slate-400 font-bold">Stop Loss</span>
            <span className="font-black text-red-300">₹{prem(c.stopLoss)}</span>
          </div>
        </div>
        {c.tradeable === false && (
          <div className="mt-2.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/25 px-2.5 py-1.5 text-[9px] text-amber-200/90 leading-relaxed">
            ⚠️ Grade <b>{c.consensus?.grade || 'NEUTRAL'}</b> + AI score <b>{c.aiScore ?? '—'}</b> — ye WATCHLIST card hai. Entry MAT karo jab tak 75+ AI score ya ACTION/STRONG grade na ho (cards har 60s me auto-update hoti hain).
          </div>
        )}
      </div>

      {/* v9.6 — AI score meter */}
      {c.aiScore != null && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-black/40 overflow-hidden" role="img" aria-label={`AI score ${c.aiScore} of 100`}>
            <div className={`h-full rounded-full ${c.aiScore >= 85 ? 'bg-violet-400/80' : c.aiScore >= 75 ? 'bg-emerald-400/80' : c.aiScore >= 65 ? 'bg-cyan-400/70' : 'bg-slate-500/60'}`} style={{ width: `${Math.max(4, Math.min(100, c.aiScore))}%` }} />
          </div>
          <span className="text-[8px] font-mono font-black text-slate-500 shrink-0">AI {c.aiScore}/100</span>
        </div>
      )}

      {/* v9.6 — 3-tier exit discipline (premium terms) */}
      {c.exitPlan && (
        <div className="mt-2 grid grid-cols-3 gap-1 text-center">
          <div className="bg-black/30 rounded-lg px-1.5 py-1">
            <div className="text-[7px] text-slate-600 font-black tracking-wider">T1 · 50% BOOK</div>
            <div className="text-[10px] font-mono font-black text-amber-300">₹{prem(c.exitPlan.t1)}</div>
            <div className="text-[7px] text-slate-500">{c.exitPlan.t1Note}</div>
          </div>
          <div className="bg-black/30 rounded-lg px-1.5 py-1">
            <div className="text-[7px] text-slate-600 font-black tracking-wider">T2 · 40% BOOK</div>
            <div className="text-[10px] font-mono font-black text-emerald-300">₹{prem(c.exitPlan.t2)}</div>
            <div className="text-[7px] text-slate-500">{c.exitPlan.t2Note}</div>
          </div>
          <div className="bg-black/30 rounded-lg px-1.5 py-1">
            <div className="text-[7px] text-slate-600 font-black tracking-wider">HARD STOP</div>
            <div className="text-[10px] font-mono font-black text-red-300">₹{prem(c.exitPlan.hardStop)}</div>
            <div className="text-[7px] text-slate-500">{c.exitPlan.timeExit}</div>
          </div>
        </div>
      )}

      {/* pro context footer — v9.6 superintelligence metrics */}
      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-center">
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">STRIKE{c.strikeBias ? ` · ${c.strikeBias}` : ''}</div>
          <div className="text-[11px] font-mono font-black text-slate-200">{c.strike} {c.type}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">DELTA / IV</div>
          <div className="text-[11px] font-mono font-black text-slate-200">{c.delta != null ? c.delta.toFixed(2) : '—'} / {c.iv != null ? `${c.iv.toFixed(1)}%` : '—'}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">POP (EXPIRY)</div>
          <div className={`text-[11px] font-mono font-black ${c.pop != null && c.pop >= 45 ? 'text-emerald-300' : 'text-amber-300'}`}>{c.pop != null ? `${c.pop}%` : '—'}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">THETA / DAY</div>
          <div className="text-[11px] font-mono font-black text-red-300">{c.theta != null ? `−₹${Math.abs(c.theta).toFixed(1)}` : '—'}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">BREAKEVEN</div>
          <div className="text-[11px] font-mono font-black text-slate-200">{c.breakeven != null ? c.breakeven.toLocaleString('en-IN') : '—'}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">1 LOT ({c.lotSize})</div>
          <div className="text-[11px] font-mono font-black text-slate-200">₹{c.perLotCost?.toLocaleString('en-IN')}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">RISK : REWARD</div>
          <div className="text-[11px] font-mono font-black text-slate-200">₹{c.perLotRisk?.toLocaleString('en-IN')} : ₹{c.perLotReward?.toLocaleString('en-IN')}{c.rr != null ? ` (${c.rr}R)` : ''}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5">
          <div className="text-[8px] text-slate-600 font-black tracking-wider">EXP. MOVE</div>
          <div className="text-[11px] font-mono font-black text-cyan-300">{c.expectedMovePct != null ? `${c.expectedMovePct}%` : '—'}</div>
        </div>
      </div>
      {c.indexLevels && c.indexLevels.target1 != null && (
        <div className="mt-1.5 text-[9px] font-mono text-slate-500 leading-relaxed">
          📐 index plan: spot {c.indexLevels.spot?.toLocaleString('en-IN')} → target {c.indexLevels.target1?.toLocaleString('en-IN')} / SL {c.indexLevels.stopLoss?.toLocaleString('en-IN')} · premium = option re-priced in BS at those levels
        </div>
      )}

      {/* v9.6 — the machine verdict */}
      {c.machineNote && (
        <div className="mt-1.5 rounded-lg bg-gradient-to-r from-cyan-500/[0.08] to-violet-500/[0.08] border border-cyan-500/20 px-2.5 py-1.5 text-[9px] text-cyan-100/90 leading-relaxed font-mono">
          {c.machineNote}
        </div>
      )}

      {/* v9.5 — F&O PAPER TRADE: the card's own levels, one click, same desk */}
      <div className="mt-2.5">
        <button
          onClick={onPaper}
          disabled={paperBusy || c.tradeable === false}
          className={`w-full px-3 py-2 rounded-xl text-[11px] font-black border transition-colors ${
            c.tradeable === false
              ? 'bg-slate-700/20 border-slate-600/30 text-slate-500 cursor-not-allowed'
              : 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/25 disabled:opacity-50'}`}
          title={c.tradeable === false
            ? `Grade ${c.consensus?.grade || 'NEUTRAL'} — ACTION/STRONG hone par hi trade khulega`
            : `1 lot (${c.lotSize} qty) · premium ₹${prem(c.entry)} · SL ₹${prem(c.stopLoss)} · target ₹${prem(c.target)} · Paper Desk me watcher-managed (T1 50% book + breakeven trail + SL/T2 + 15:10 square-off)`}
        >
          {paperBusy ? '⏳ opening…' : c.tradeable === false ? '🧪 PAPER (ACTION/STRONG grade chahiye)' : `🧪 PAPER TRADE — 1 LOT (₹${c.perLotCost?.toLocaleString('en-IN')})`}
        </button>
        {paperMsg && (
          <div className={`mt-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-bold leading-relaxed ${paperMsg.startsWith('⛔') ? 'bg-red-500/10 border border-red-500/25 text-red-200' : 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-200'}`}>
            {paperMsg}
          </div>
        )}
      </div>
      <p className="text-[9px] text-slate-500 mt-1.5 italic leading-relaxed">{c.note} Expiry-day hold karke mat baitho — 14:30 se pehle square-off.</p>
    </div>
  );
}

function OptionSignalCardsStrip({ onOpened }: { onOpened?: (msg: string, ok: boolean) => void }) {
  const [view, setView] = useState<OptionSignalsView | null>(null);
  const [err, setErr] = useState(false);
  // v21.0.2 OPTIONS AUTO-ENTRY toggle state (server loop: optionsAutoEntry.js)
  const [autoOn, setAutoOn] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const seqRef = useRef(0);
  // v10.18 (deep-recheck #3): viewRef — the `else if (!view)` check below
  // captured the MOUNT-time view (always null), so every failed poll set
  // err=true even with data on screen (render masked it, but it was a
  // latent trap). The ref reads the CURRENT data state.
  const viewRef = useRef<OptionSignalsView | null>(null);
  // v21.7.0 (Issue-1): staleness badge ke liye render-tick — view.asOf ka
  // age dikhana (old data ko "live" mask karne ka end).
  const [, setAgeTick] = useState(0);

  useEffect(() => {
    let alive = true;
    // v21.0.2: options auto-entry status fetch (enabled? + quota view)
    (async () => {
      try {
        const r = await apiFetch('/api/ai/options-auto/status', { signal: AbortSignal.timeout(6000) });
        const j = await r.json().catch(() => null);
        if (alive && j?.ok) {
          setAutoOn(!!j.enabled);
          if (j.enabled) {
            setAutoNote(`AUTO ON — quota ${j.entriesToday}/${j.cfg?.quotaPerDay} · cooldown ${j.cooldownRemainingMin}m${j.windowOpen ? '' : ' · NSE band hai (window khulte hi chalu)'}`);
          } else setAutoNote(null);
        }
      } catch { /* status best-effort */ }
    })();
    const run = async (force = false) => {
      const seq = ++seqRef.current;
      const v = await fetchOptionSignals(force);
      if (!alive || seq !== seqRef.current) return;
      if (v) { viewRef.current = v; setView(v); setErr(false); }
      else if (!viewRef.current) setErr(true);
    };
    run(true);
    // v9.7: 30s poll — the strip label ("30s re-rank") aur the server's
    // 30s cards cache dono se aligned (pehle 60s poll chal raha tha,
    // label jhooth bolta tha).
    // v10.18: hidden tabs skip the poll (every sibling poller gates on
    // document.hidden — a backgrounded options tab no longer burns a
    // 12s-timeout API call every 30s).
    const iv = setInterval(() => { if (!document.hidden) run(false); setAgeTick(t => t + 1); }, 30_000);
    // v21.7.0 (Issue-1): TAB WAPAS KHOLTE HI FORCE-FRESH — pura hidden
    // session ke baad wapas aane par pehli paint ≤30s purani cache se hoti
    // thi. visibilitychange par turant fresh fetch ("site open tak fresh
    // signals" user spec).
    const onVis = () => { if (!document.hidden) run(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const toggleAuto = useCallback(async () => {
    if (autoBusy) return;
    setAutoBusy(true);
    try {
      const r = await apiFetch('/api/ai/options-auto/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autoOn }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => null);
      if (j?.ok) {
        setAutoOn(!!j.enabled);
        setAutoNote(j.enabled
          ? `AUTO ON — tradeable cards se paper entry (quota ${j.entriesToday}/${j.cfg?.quotaPerDay}, ${j.cfg?.cooldownMin}m cooldown) · exit watcher SL/T1/T2/14:30-expiry/15:10 khud sambhalta hai`
          : 'AUTO OFF — manual paper buttons hi chalenge');
      }
    } catch { setAutoNote('toggle fail — server se status nahi mila'); }
    finally { setAutoBusy(false); }
  }, [autoOn, autoBusy]);

  const desks = view?.desks || [];
  // v9.6: server sends the merged TOP-4 by AI score; older servers
  // fall back to the per-desk cards.
  const cards = view?.cards?.length ? view.cards : desks.flatMap(d => d.cards || []);
  if (err && !view) {
    return (
      <div className="quantum-panel rounded-2xl p-4 text-[11px] text-slate-400">
        <span className="font-black text-slate-300">🎯 F&amp;O Signal Cards</span> — option desks load nahi huin (auto-retry 60s me). Neeche chain + strategies zinda hain.
      </div>
    );
  }
  return (
    <div className="space-y-2" aria-label="F&O option signal cards">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-black text-slate-200">🎯 F&amp;O SIGNAL CARDS</span>
        {/* v21.7.0 (Issue-1) FRESHNESS BADGE — data kab ka hai, saaf dikhna
            chahiye. <1m LIVE · <3m amber · usse zyada RED STALE (fetch atka
            hai — 30s poll khud retry karta rahega). */}
        {view?.asOf ? (() => {
          const ageMin = Math.floor((Date.now() - view.asOf) / 60_000);
          if (ageMin < 1) return <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">● LIVE</span>;
          if (ageMin < 3) return <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500/15 text-amber-300 border border-amber-400/30">● {ageMin}m purana</span>;
          return <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-red-500/15 text-red-300 border border-red-400/30">● STALE {ageMin}m — retry chalu</span>;
        })() : null}
        <span className="text-[9px] text-slate-500 font-mono">Nifty50 + Sensex · AI-scored TOP 4 (ATM/ITM/OTM candidates) · premium Entry/Target/SL · 30s re-rank</span>
        {/* v21.0.2 OPTIONS AUTO-ENTRY toggle — NIFTY/SENSEX tradeable cards
            se paper auto-entry (server loop optionsAutoEntry.js, default OFF). */}
        <button onClick={toggleAuto} disabled={autoBusy}
          title="Auto-Entry (paper): tradeable option cards (STRONG/ACTION ya AI 75+) se automatically 1-lot paper trade kholta hai — quota 3/day, 20m cooldown. Exit watcher khud sambhalta hai (SL / T1 50% book / T2 / BE-trail / expiry-day 14:30 / 15:10 square-off)."
          className={`ml-auto px-2.5 py-1 rounded-lg text-[10px] font-black border transition-colors ${autoOn
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40 hover:bg-emerald-500/30'
            : 'bg-slate-800/50 text-slate-400 border-slate-600/40 hover:text-slate-200'}`}>
          {autoBusy ? '⏳…' : autoOn ? '🟢 AUTO-ENTRY ON' : '⚪ AUTO-ENTRY OFF'}
        </button>
      </div>
      {autoNote && (
        <div className={`rounded-lg px-2.5 py-1.5 text-[10px] font-bold leading-relaxed ${autoOn ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-200/90' : 'bg-slate-700/20 border border-slate-600/25 text-slate-400'}`}>
          {autoNote}
        </div>
      )}
      {cards.length > 0 ? (
        <div className="grid md:grid-cols-2 gap-2.5">
          {cards.map(c => <OptionSignalCardView key={`${c.symbol}-${c.strike}-${c.type}-${c.expiry}`} c={c} onOpened={onOpened} />)}
        </div>
      ) : (
        <div className="quantum-panel rounded-2xl p-4 text-[11px] text-slate-400">
          {desks.some(d => d.ok)
            ? (desks.find(d => d.noCardReason)?.noCardReason || 'Aaj kisi index pe directional consensus nahi — neutral desk. Option chain + income setups neeche hain.')
            : 'Option desks load ho rahi hain (NSE/BSE is server se blocked ho sakte hain — BS model fallback 30s me aata hai)...'}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// v6.13 — TRADE STEPS: the "trade kaise karna hai" block.
// Server computes every number (session phase · DTE-aware expiry
// advice · per-leg LIMIT prices at the 0.05 tick · exit rules ·
// lot sizing); this just renders it as 4 numbered steps.
// ------------------------------------------------------------
function StepShell({ n, title, children, tone = 'cyan' }: { n: string; title: string; children: React.ReactNode; tone?: 'cyan' | 'amber' }) {
  return (
    <div className="flex gap-2 items-start">
      <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black ${tone === 'cyan' ? 'bg-cyan-500/20 text-cyan-300' : 'bg-amber-500/20 text-amber-300'}`} aria-label={`step ${n}`}>{n}</span>
      <div className="min-w-0">
        <div className="text-[9px] font-black text-slate-500 tracking-wider uppercase">{title}</div>
        <div className="text-[10px] text-slate-300 leading-relaxed mt-0.5">{children}</div>
      </div>
    </div>
  );
}

function TradeSteps({ t, symbol, expiry, name }: { t: OrderTicket; symbol: string; expiry?: string; name: string }) {
  return (
    <div className="mt-2.5 rounded-xl border border-cyan-500/25 bg-cyan-500/[0.05] p-3 space-y-2.5" aria-label="order ticket — 4 steps">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-black text-cyan-300 tracking-wider">🎫 ORDER TICKET — 4 STEP ME TRADE</span>
        {t.dte != null && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${t.expiryDay ? 'bg-red-500/10 text-red-300 border-red-500/30' : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'}`}>
            {t.expiryDay ? 'AAJ EXPIRY ⚠️' : `${t.dte} din baaki`}
          </span>
        )}
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${t.sessionTradeable ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25' : 'bg-amber-500/10 text-amber-300 border-amber-500/30'}`}>
          {t.sessionTradeable ? '🟢 entry window OPEN' : '⏰ entry window BAND'}
        </span>
      </div>
      <StepShell n="1" title="Kab lena hai">{t.whenText}</StepShell>
      <StepShell n="2" title="Kya lena hai · konsa expiry">
        <b className="text-white">{name}</b> — {symbol} {expiry ? `· expiry ${expiry}` : ''}
        <div className="mt-0.5 text-amber-200/80">{t.expiryText}</div>
      </StepShell>
      <StepShell n="3" title="Limit order kaise lagana hai">
        <div className="space-y-1">
          {(t.legs || []).map((l, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap bg-black/30 rounded-lg px-2.5 py-1.5 font-mono text-[10px]">
              <span className={`font-black w-10 ${l.action === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{l.action}</span>
              <span className="text-slate-200 font-bold">{symbol} {expiry} {l.strike} {l.type}</span>
              <span className="ml-auto">LTP ₹{l.ltp} → <b className="text-cyan-300">LIMIT ₹{l.limit}</b></span>
              <span className="text-slate-500">qty {l.qtyPerLot}/lot</span>
            </div>
          ))}
          <div className="text-[10px] text-slate-400 leading-relaxed pt-0.5">
            Broker (Dhan/Kite) me: <b className="text-slate-200">Product = MIS</b> (intraday) · <b className="text-slate-200">Order type = LIMIT</b> · price box me upar wala LIMIT price daalo. <b className="text-red-300">MARKET order kabhi nahi</b> — options me spread slip turant premium kha jaata hai. Fill nahi mile to limit price ko 1 tick (₹0.05) upar/neeche karo, chase mat karo.
          </div>
        </div>
      </StepShell>
      <StepShell n="4" title="Kab exit karna hai" tone="amber">
        <div className="space-y-1">
          <div className="bg-red-500/[0.07] border border-red-500/20 rounded-lg px-2.5 py-1.5 text-[10px] text-red-200/90 leading-relaxed">{t.exit.sl}</div>
          <div className="bg-emerald-500/[0.07] border border-emerald-500/20 rounded-lg px-2.5 py-1.5 text-[10px] text-emerald-200/90 leading-relaxed">{t.exit.target}</div>
          <div className="bg-amber-500/[0.07] border border-amber-500/20 rounded-lg px-2.5 py-1.5 text-[10px] text-amber-200/90 leading-relaxed">⏱️ {t.exit.time}</div>
        </div>
      </StepShell>
      {t.lotRows?.length > 0 && (
        <div className="text-[10px] text-slate-400 font-mono leading-relaxed bg-black/25 rounded-lg px-2.5 py-1.5">
          💰 Sizing (max loss per position, 1 lot = {t.legs[0]?.qtyPerLot ?? '—'} qty):{' '}
          {t.lotRows.map(r => `${r.lots} lot → ₹${r.maxLoss.toLocaleString('en-IN')}`).join(' · ')}
          <span className="text-slate-500"> — risk budget ₹5,000 hai to 1 lot se zyada mat lo.</span>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'bull' | 'bear' | 'neutral' }) {
  const cls = tone === 'bull' ? 'text-emerald-300' : tone === 'bear' ? 'text-red-300' : 'text-slate-200';
  return (
    <div className="bg-black/30 rounded-xl px-3 py-2 text-center min-w-[86px]">
      <div className="text-[9px] text-slate-500 font-black tracking-wider">{label}</div>
      <div className={`text-sm font-mono font-black ${cls}`}>{value}</div>
    </div>
  );
}

function StrategyCard({ s, lotSize, spot, symbol, expiry }: { s: Strategy; lotSize: number; spot: number; symbol: string; expiry?: string }) {
  const bull = s.bias === 'BULLISH';
  // v6.7: payoff SVG — expiry P&L per share across ±6% of spot
  const payoff = s.payoff || [];
  const W = 260, H = 64;
  const xs = payoff.map(p => p.s);
  const ys = payoff.map(p => p.pnl);
  const xLo = Math.min(...xs, spot * 0.94), xHi = Math.max(...xs, spot * 1.06);
  const yLo = Math.min(...ys, 0), yHi = Math.max(...ys, 0);
  const px = (v: number) => ((v - xLo) / (xHi - xLo || 1)) * W;
  const py = (v: number) => H - ((v - yLo) / (yHi - yLo || 1)) * H;
  const spotX = px(spot);
  const zeroY = py(0);
  const path = payoff.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.s).toFixed(1)},${py(p.pnl).toFixed(1)}`).join(' ');
  return (
    <div className={`quantum-panel rounded-2xl p-4 ${bull ? 'border-l-2 border-l-emerald-500/50' : s.bias === 'BEARISH' ? 'border-l-2 border-l-red-500/50' : 'border-l-2 border-l-violet-500/50'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-black text-white">{s.name}</span>
        <span className={`px-2 py-0.5 rounded-md text-[9px] font-black ${bull ? 'bg-emerald-500/15 text-emerald-300' : s.bias === 'BEARISH' ? 'bg-red-500/15 text-red-300' : 'bg-violet-500/15 text-violet-300'}`}>{s.bias}</span>
        <span className="px-2 py-0.5 rounded-md text-[9px] font-black bg-slate-600/20 text-slate-300">{s.conviction} conviction</span>
        {s.pop != null && (
          <span className={`px-2 py-0.5 rounded-md text-[9px] font-black border ${s.pop >= 60 ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25' : s.pop >= 40 ? 'bg-amber-500/10 text-amber-300 border-amber-500/25' : 'bg-red-500/10 text-red-300 border-red-500/25'}`} title="Probability of profit at expiry (lognormal N(d2) of the breakevens)">
            POP {s.pop}%
          </span>
        )}
        {s.netDebit != null && <span className="text-[11px] font-mono text-amber-300 font-bold">debit ₹{s.netDebit}</span>}
        {s.netCredit != null && <span className="text-[11px] font-mono text-emerald-300 font-bold">credit ₹{s.netCredit}</span>}
      </div>
      <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">{s.rationale}</p>

      {/* v6.13 — ORDER TICKET: 4-step trade guide (KAB · KYA/EXPIRY · LIMIT · EXIT) */}
      {s.orderTicket && <TradeSteps t={s.orderTicket} symbol={symbol} expiry={expiry} name={s.name} />}

      {/* Legs */}
      <div className="mt-2.5 grid gap-1">
        {s.legs.map((l, i) => (
          <div key={i} className="flex items-center gap-2 text-xs bg-black/30 rounded-lg px-3 py-1.5">
            <span className={`font-black ${l.action === 'BUY' ? 'text-emerald-400' : 'text-red-400'} w-12`}>{l.action}</span>
            <span className="font-mono font-bold text-slate-200 w-10">{l.type}</span>
            <span className="font-mono text-slate-400 w-20">strike {l.strike}</span>
            <span className="font-mono text-amber-300 ml-auto">@ ₹{l.premium}</span>
            {l.delta != null && <span className="font-mono text-slate-500 text-[10px]">Δ{l.delta}</span>}
          </div>
        ))}
      </div>

      {/* P&L grid */}
      <div className="grid grid-cols-3 gap-1.5 mt-2.5">
        <div className="bg-emerald-500/5 rounded-lg px-2 py-1.5 text-center border border-emerald-500/15">
          <div className="text-[8px] text-emerald-400/70 font-black tracking-wider">MAX PROFIT</div>
          <div className="text-xs font-mono font-black text-emerald-300">{s.maxProfit == null ? 'Unlimited' : `₹${s.maxProfit}`}</div>
        </div>
        <div className="bg-red-500/5 rounded-lg px-2 py-1.5 text-center border border-red-500/15">
          <div className="text-[8px] text-red-400/70 font-black tracking-wider">MAX LOSS</div>
          <div className="text-xs font-mono font-black text-red-300">₹{s.maxLoss ?? '—'}</div>
        </div>
        <div className="bg-black/30 rounded-lg px-2 py-1.5 text-center">
          <div className="text-[8px] text-slate-500 font-black tracking-wider">BREAKEVEN</div>
          <div className="text-xs font-mono font-black text-slate-300">{(s.breakevens || []).map(b => Math.round(b)).join(' / ') || '—'}</div>
        </div>
      </div>
      <div className="flex gap-2 mt-1.5 text-[10px] text-slate-500 font-mono">
        {s.perLot?.maxLoss != null && <span>per lot (×{lotSize}): max loss ₹{Math.round(s.perLot.maxLoss)}</span>}
        {s.perLot?.maxProfit != null && <span className="text-emerald-500/70">· max profit ₹{Math.round(s.perLot.maxProfit)}</span>}
      </div>
      {/* v6.7 payoff curve */}
      {payoff.length > 3 && (
        <div className="mt-2.5 bg-black/30 rounded-xl p-2">
          <div className="flex items-center justify-between text-[8px] text-slate-600 font-black tracking-wider mb-1">
            <span>EXPIRY PAYOFF / share</span>
            <span className="font-mono">green = profit zone</span>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" role="img" aria-label="Payoff curve at expiry">
            <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="rgba(148,163,184,0.25)" strokeWidth="1" strokeDasharray="3,3" />
            <line x1={spotX} y1="0" x2={spotX} y2={H} stroke="rgba(34,211,238,0.4)" strokeWidth="1" strokeDasharray="2,3" />
            <path d={`${path} L${W},${zeroY} L0,${zeroY} Z`} fill="url(#payGrad)" opacity="0.25" />
            <path d={path} fill="none" stroke={bull ? '#34d399' : s.bias === 'BEARISH' ? '#f87171' : '#a78bfa'} strokeWidth="2" />
            <defs>
              <linearGradient id="payGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity="0.6" />
                <stop offset="50%" stopColor="transparent" stopOpacity="0" />
                <stop offset="100%" stopColor="#f87171" stopOpacity="0.6" />
              </linearGradient>
            </defs>
          </svg>
          <div className="flex justify-between text-[8px] font-mono text-slate-600">
            <span>{Math.round(xLo).toLocaleString('en-IN')}</span>
            <span className="text-cyan-500/70">spot {spot?.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
            <span>{Math.round(xHi).toLocaleString('en-IN')}</span>
          </div>
        </div>
      )}
      <p className="text-[10px] text-slate-500 mt-2 italic">📍 {s.exitPlan}</p>
    </div>
  );
}

// ------------------------------------------------------------
// v10.17 — WHOLE-F&O OPTIONS SCANNER view. One ranked list across
// 3 indices + the top stock-option underlyings: deterministic
// direction read (OI lean · PCR · max-pain · gamma-flip), GEX pin
// zone, expected-move band, source honesty (LIVE NSE vs BS model).
// ------------------------------------------------------------
const dirChip = (d?: string) => d === 'BULLISH'
  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  : d === 'BEARISH'
    ? 'bg-red-500/15 text-red-300 border-red-500/30'
    : 'bg-slate-600/20 text-slate-300 border-slate-600/30';

function ScanRow({ r, council, onRequestCouncil, councilBusy }: { r: OptionsScanRow; council?: CouncilStamp | null; onRequestCouncil?: (sym: string) => void; councilBusy?: boolean }) {
  // v11.0: the council cross-check chip — scanner's deterministic read
  // vs the 6-seat council verdict. ALIGN (green) / CONTRADICT (red) /
  // no-data (grey honesty tag). On-demand only (deep verdict = ~9 LLM
  // calls when uncached — never auto-fired for 10 scanner rows).
  let councilChip: ReactElement | null = null;
  if (council) {
    const scanDir = r.direction === 'BULLISH' ? 'LONG' : r.direction === 'BEARISH' ? 'SHORT' : 'NEUTRAL';
    const align = council.direction === scanDir && scanDir !== 'NEUTRAL';
    const contradict = council.direction !== 'NEUTRAL' && scanDir !== 'NEUTRAL' && council.direction !== scanDir;
    councilChip = (
      <span
        className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${align
          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
          : contradict ? 'bg-red-500/15 text-red-300 border-red-500/30'
            : 'bg-slate-600/20 text-slate-400 border-slate-600/30'}`}
        title={`Council ${council.direction} ${Math.round(council.confidence)} · agree ${Math.round(council.agreement * 100)}% · gate ${council.gate || '—'}${(council.gateReasons || []).length ? ' — ' + council.gateReasons.join(' · ') : ''}`}
      >
        🏛 {align ? 'COUNCIL ALIGNS' : contradict ? 'COUNCIL CONTRADICTS' : `COUNCIL ${council.direction}`}
      </span>
    );
  } else {
    councilChip = (
      <button
        onClick={() => onRequestCouncil?.(r.symbol)}
        disabled={councilBusy}
        className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-slate-600/20 text-slate-500 border-slate-600/30 hover:text-slate-300 disabled:opacity-50"
        title="6-seat council cross-check (deep verdict, ~15-25s pehli baar — 90s cached)"
      >
        🏛 cross-check
      </button>
    );
  }
  return (
    <div className="px-4 py-3 border-b border-white/[0.03] hover:bg-white/[0.02]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-black font-mono text-white">{r.symbol}</span>
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${r.kind === 'index' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-slate-600/20 text-slate-400'}`}>
          {r.kind === 'index' ? 'IDX' : 'STOCK'}
        </span>
        {r.spot != null && <span className="text-[11px] font-mono text-slate-300">{r.spot?.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</span>}
        {r.changePct != null && (
          <span className={`text-[11px] font-black font-mono ${(r.changePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {(r.changePct ?? 0) >= 0 ? '+' : ''}{r.changePct?.toFixed(2)}%
          </span>
        )}
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${dirChip(r.direction)}`}>
          {r.direction === 'BULLISH' ? '🟢 BULL READ' : r.direction === 'BEARISH' ? '🔴 BEAR READ' : '⚪ BALANCED'}
        </span>
        {r.dte != null && (
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${r.dte === 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-600/20 text-slate-400'}`} title="days to expiry">
            {r.dte === 0 ? 'EXPIRY DAY' : `${r.dte}d`}
          </span>
        )}
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${r.source === 'nse' ? 'bg-emerald-500/15 text-emerald-300' : r.source === 'bse' ? 'bg-teal-500/15 text-teal-300' : r.source === 'bs-model-sensex-always' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`} title={r.source === 'nse' ? 'real NSE option chain' : r.source === 'bse' ? 'real BSE option chain (direct ya Groww public mirror se)' : r.source === 'bs-model-sensex-always' ? 'live BSE sources (direct + Groww mirror) unreachable — Black-Scholes model chain, auto-retry on' : 'exchange chain unreachable — Black-Scholes model chain (premiums estimates)'}>
          {r.source === 'nse' ? 'LIVE NSE' : r.source === 'bse' ? 'LIVE BSE' : r.source === 'bs-model-sensex-always' ? 'SENSEX MODEL' : 'BS MODEL'}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-black font-mono text-cyan-300" title="scan score = conviction + OI flow + movement potential + data quality">{r.scanScore ?? 0}</span>
          <span className="w-16 h-1.5 rounded-full bg-slate-700 overflow-hidden" aria-hidden="true">
            <span className="block h-full bg-gradient-to-r from-cyan-500 to-emerald-400" style={{ width: `${Math.max(4, Math.min(100, (r.scanScore ?? 0)))}%` }} />
          </span>
        </span>
      </div>
      <div className="text-[10px] text-slate-400 font-mono mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {r.atmIV != null && <span className="text-slate-500">IV {r.atmIV.toFixed(1)}%</span>}
        {r.pcr != null && <span className="text-slate-500">PCR {r.pcr.toFixed(2)}</span>}
        {r.maxPain != null && <span className="text-slate-500">maxPain {r.maxPain.toLocaleString('en-IN')}</span>}
        {r.gammaFlip != null && <span className="text-slate-500">γflip {r.gammaFlip.toLocaleString('en-IN')}</span>}
        {r.putWall != null && <span className="text-emerald-500/70">put wall {r.putWall.toLocaleString('en-IN')}</span>}
        {r.callWall != null && <span className="text-red-500/70">call wall {r.callWall.toLocaleString('en-IN')}</span>}
        {r.expectedMovePct != null && (
          <span className="text-slate-400" title={r.expectedMoveBand ? `band ${r.expectedMoveBand.low}–${r.expectedMoveBand.high}` : undefined}>
            exp move ±{r.expectedMovePct.toFixed(1)}%
          </span>
        )}
        <span className="text-slate-600">{r.expiryLabel || r.expiry}</span>
      </div>
      {r.verdict && <div className="text-[10px] text-slate-300 mt-1">{r.verdict}</div>}
      <div className="mt-1">{councilChip}</div>
      {(r.directionWhy?.length ?? 0) > 0 && (
        <div className="text-[9px] text-slate-500 mt-0.5 leading-relaxed">{r.directionWhy!.join(' · ')}</div>
      )}
    </div>
  );
}

function OptionsScannerView({ scan, loading, err, onRefresh }: { scan: OptionsScanView | null; loading: boolean; err: boolean; onRefresh: () => void }) {
  const rows = scan?.rows || [];
  // v11.0: per-symbol council cross-checks — on-demand, 90s client cache.
  const [councilMap, setCouncilMap] = useState<Record<string, CouncilStamp | null>>({});
  const [councilBusy, setCouncilBusy] = useState<string | null>(null);
  const onRequestCouncil = useCallback(async (sym: string) => {
    if (councilBusy) return;
    setCouncilBusy(sym);
    try {
      const stamp = await fetchCouncilVerdict(sym, 'INDIA');
      setCouncilMap(m => ({ ...m, [sym]: stamp }));
    } finally { setCouncilBusy(null); }
  }, [councilBusy]);
  return (
    <div className="quantum-panel rounded-2xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between flex-wrap gap-2">
        <span className="text-xs font-black text-slate-200">
          🔍 WHOLE-F&O OPTIONS SCANNER
          {scan && <span className="text-slate-500 font-mono ml-2 text-[10px]">{scan.liveCount ?? 0} live · {scan.modelCount ?? 0} model · {scan.failedCount ?? 0} failed</span>}
        </span>
        <button onClick={onRefresh} disabled={loading}
          className="quantum-btn-ghost px-3 py-1 rounded-lg text-[10px] font-black disabled:opacity-50">
          <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span> Re-scan
        </button>
      </div>
      {loading && rows.length === 0 && (
        <div className="p-6 text-center text-[11px] text-slate-500">chains load ho rahi hain… (3 indices + top F&O stocks, ~10s pehli baar)</div>
      )}
      {err && rows.length === 0 && !loading && (
        <div className="p-6 text-center text-[11px] text-red-400">options scan unavailable — thodi der baad retry karo</div>
      )}
      {rows.length === 0 && !loading && !err && (
        <div className="p-6 text-center text-[11px] text-slate-500">koi chain load nahi hui</div>
      )}
      <div className="max-h-[28rem] overflow-y-auto">
        {rows.map(r => <ScanRow key={`${r.kind}-${r.symbol}`} r={r} council={councilMap[r.symbol] ?? null} onRequestCouncil={onRequestCouncil} councilBusy={councilBusy === r.symbol} />)}
      </div>
      {(scan?.failed?.length ?? 0) > 0 && (
        <div className="px-4 py-2 text-[9px] text-slate-600 border-t border-white/5">
          skip: {scan!.failed!.map(f => `${f.symbol} (${f.reason})`).join(' · ')}
        </div>
      )}
      {scan?.note && <div className="px-4 py-2 text-[9px] text-amber-300/80 border-t border-white/5">⚠️ {scan.note}</div>}
      {scan?.methodology && (
        <div className="px-4 py-2 text-[8px] text-slate-600 leading-relaxed border-t border-white/5">{scan.methodology}</div>
      )}
    </div>
  );
}

// v21.0.3: onPaperOpened — jab bhi option paper trade khulta hai
// (manual 🧪 button), tab ko turant pata chal jata hai: toast + Paper
// Desk instant refresh (15s poll ka inteza nahi). Pehle strip ke
// andar ka msg hi dikhta tha aur panel bad-me update hota tha
// ("paper trade show nahi hua" complaint ka UX hissa).
export const OptionsDeskPanel = memo(function OptionsDeskPanel({ onPaperOpened }: {
  onPaperOpened?: (msg: string, ok: boolean) => void;
}) {
  const [symbol, setSymbol] = useState('NIFTY');
  const [desk, setDesk] = useState<OptionsDesk | null>(null);
  const [loading, setLoading] = useState(true);
  const seqRef = useRef(0);
  // v10.17: WHOLE-F&O SCANNER sub-view (indices + top stock underlyings,
  // one ranked deterministic view — GET /api/ai/options-scan)
  const [scanMode, setScanMode] = useState(false);
  const [scan, setScan] = useState<OptionsScanView | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanErr, setScanErr] = useState(false);

  const load = useCallback(async (sym: string, force = false) => {
    // v6.2: sequence guard — rapid NIFTY→BANKNIFTY switching leaves two
    // fetches in flight and the LAST-RESOLVED response used to win,
    // painting NIFTY's (up to 30s-uncached) chain under a BANKNIFTY-
    // highlighted selector. Only the CURRENT request's response applies.
    const seq = ++seqRef.current;
    setLoading(true);
    const d = await fetchOptionsDesk(sym, force);
    if (seq !== seqRef.current) return; // stale response for a previous index — discard
    setDesk(d);
    setLoading(false);
  }, []);

  useEffect(() => { load(symbol); }, [symbol, load]);

  // v21.7.0 (Issue-1) DESK AUTO-REFRESH — pehle chain desk sirf symbol-switch
  // ya manual Refresh par hi jaagta tha; minutes-purana data "live" dikhata
  // rehta tha. Ab: (a) har 10 min force refresh (user spec "every 10 min me
  // refresh"), (b) tab wapas visible hote hi force refresh (site kholte hi
  // fresh). Hidden ticks skip (poller hygiene — har sibling yahi karta hai).
  useEffect(() => {
    const iv = setInterval(() => { if (!document.hidden) load(symbol, true); }, 10 * 60_000);
    const onVis = () => { if (!document.hidden) load(symbol, true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [symbol, load]);

  // v10.17: scan loads lazily — only when the sub-view is opened.
  const loadScan = useCallback(async (force = false) => {
    setScanLoading(true);
    setScanErr(false);
    const v = await fetchOptionsScan(force);
    if (!v || !v.ok) setScanErr(true);
    if (v) setScan(v);
    setScanLoading(false);
  }, []);
  useEffect(() => { if (scanMode && !scan && !scanLoading) loadScan(); }, [scanMode, scan, scanLoading, loadScan]);

  const spot = desk?.spot ?? 0;
  const atm = desk?.rows?.length
    ? desk.rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best), desk.rows[0])
    : null;
  const gex = desk?.analytics?.gex ?? null;
  // v10.18 (deep-recheck #3): maxOI computed ONCE per render — it used
  // to live INSIDE the per-row .map(), re-scanning the whole 100-250
  // strike chain per row (O(n²) on every repaint — the same jank class
  // the v10.17 render-storm fix killed elsewhere).
  const maxOI = Math.max(1, ...(desk?.rows || []).map(x => Math.max(x.callOI, x.putOI)));

  return (
    <section className="space-y-3" aria-label="India options desk">
      {/* Index selector + refresh */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 quantum-panel p-1 rounded-2xl">
          {INDICES.map(ix => (
            <button key={ix} onClick={() => setSymbol(ix)}
              aria-pressed={symbol === ix}
              className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${symbol === ix ? 'bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-lg shadow-orange-500/20' : 'text-slate-400 hover:text-slate-200'}`}>
              {ix}
            </button>
          ))}
        </div>
        {/* v10.17: whole-F&O scanner toggle — one ranked view across
            indices + top stock-option underlyings */}
        <button onClick={() => setScanMode(m => !m)}
          aria-pressed={scanMode}
          className={`px-3 py-2 rounded-xl text-xs font-black border transition-all ${scanMode
            ? 'bg-gradient-to-r from-cyan-600 to-sky-600 text-white border-cyan-400/50 shadow-lg shadow-cyan-500/20'
            : 'quantum-btn-ghost border-transparent'}`}>
          🔍 SCANNER
        </button>
        <button onClick={() => load(symbol, true)} disabled={loading}
          className="quantum-btn-ghost px-3 py-2 rounded-xl text-xs font-bold disabled:opacity-50">
          <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span> Refresh
        </button>
        {!scanMode && desk?.source && (
          <span className={`px-2 py-1 rounded-lg text-[10px] font-black border ${desk.source === 'nse' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
            : desk.source === 'bse' ? 'bg-teal-500/15 text-teal-300 border-teal-500/30'
              : desk.source === 'bs-model-sensex-always' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}
            title={desk.sourceVia === 'groww'
              ? `Real ${desk.source === 'nse' ? 'NSE NIFTY' : 'BSE SENSEX'} chain — Groww public page se relay (live LTP / OI / IV)`
              : desk.source === 'bse' ? 'Real BSE option chain (direct)' : desk.source === 'nse' ? 'Real NSE option chain (direct)' : undefined}>
            {desk.source === 'nse' ? (desk.sourceVia === 'groww' ? 'LIVE NSE CHAIN · GROWW' : 'LIVE NSE CHAIN') : desk.source === 'bse' ? (desk.sourceVia === 'groww' ? 'LIVE BSE CHAIN · GROWW' : 'LIVE BSE CHAIN') : desk.source === 'bs-model-sensex-always' ? 'SENSEX MODEL CHAIN — NO LIVE FEED' : 'BS MODEL CHAIN — NSE BLOCKED'}
          </span>
        )}
        {!scanMode && desk?.consensus && (
          <span className={`px-2 py-1 rounded-lg text-[10px] font-black border ${desk.consensus.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : desk.consensus.side === 'SHORT' ? 'bg-red-500/15 text-red-300 border-red-500/30' : 'bg-slate-600/20 text-slate-300 border-slate-600/30'}`}>
            ENSEMBLE: {desk.consensus.side} {desk.consensus.confidence}% ({desk.consensus.grade})
          </span>
        )}
      </div>

      {/* v10.17: the whole-F&O scanner REPLACES the single-index desk
          body while toggled on (chains are the expensive bit — the
          desk's own chain keeps its cache warm behind the scenes). */}
      {scanMode ? (
        <OptionsScannerView scan={scan} loading={scanLoading} err={scanErr} onRefresh={() => loadScan(true)} />
      ) : (
      <>
      {desk?.syntheticNote && (
        <div className={`quantum-panel rounded-xl px-4 py-2.5 text-[11px] leading-relaxed border ${desk.source === 'bs-model-sensex-always' ? 'text-rose-200/80 border-rose-500/30' : 'text-amber-200/80 border-amber-500/20'}`} data-testid={desk.source === 'bs-model-sensex-always' ? 'sensex-model-banner' : undefined}>
          ⚠️ {desk.syntheticNote}
        </div>
      )}

      {/* v9.4 — F&O OPTION SIGNAL CARDS: Nifty50 + Sensex, the user's
          exact format (Stock name / Target / Entry (Buy) / Stop Loss) */}
      <OptionSignalCardsStrip onOpened={onPaperOpened} />

      {/* Metrics strip */}
      <div className="flex flex-wrap gap-2">
        <Metric label="SPOT" value={desk ? desk.spot?.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'} />
        <Metric label="DAY %" value={desk?.spotChangePct != null ? `${desk.spotChangePct >= 0 ? '+' : ''}${desk.spotChangePct.toFixed(2)}%` : '—'} tone={(desk?.spotChangePct ?? 0) >= 0 ? 'bull' : 'bear'} />
        <Metric label="INDIA VIX" value={desk?.vix != null ? desk.vix.toFixed(1) : '—'} />
        <Metric label="EXPIRY" value={desk ? `${desk.expiry}${desk.dte != null ? ` · ${desk.dte}d` : ''}` : '—'} />
        <Metric label="LOT SIZE" value={desk ? String(desk.lotSize) : '—'} />
        <Metric label="PCR" value={desk?.analytics?.pcr != null ? desk.analytics.pcr.toFixed(2) : 'n/a'} tone={desk?.analytics?.pcr != null ? (desk.analytics.pcr > 1.4 ? 'bull' : desk.analytics.pcr < 0.6 ? 'bear' : 'neutral') : 'neutral'} />
        <Metric label="MAX PAIN" value={desk?.analytics?.maxPain != null ? desk.analytics.maxPain.toLocaleString('en-IN') : 'n/a'} />
        <Metric label="ATM IV" value={desk?.analytics?.atmIV != null ? `${desk.analytics.atmIV.toFixed(1)}%` : 'n/a'} />
        {gex && <Metric label="GAMMA FLIP" value={gex.gammaFlip != null ? gex.gammaFlip.toLocaleString('en-IN') : 'n/a'} tone="neutral" />}
        {gex && <Metric label="CALL WALL" value={gex.callWall != null ? gex.callWall.toLocaleString('en-IN') : 'n/a'} tone="bear" />}
        {gex && <Metric label="PUT WALL" value={gex.putWall != null ? gex.putWall.toLocaleString('en-IN') : 'n/a'} tone="bull" />}
        {gex && <Metric label="EXP MOVE" value={gex.expectedMove?.pct != null ? `±${gex.expectedMove.pct}%` : 'n/a'} tone="neutral" />}
        {desk?.analytics?.skew?.value != null && (
          <Metric label="IV SKEW" value={`${desk.analytics.skew.value > 0 ? '+' : ''}${desk.analytics.skew.value}`} tone={desk.analytics.skew.value >= 2.5 ? 'bear' : desk.analytics.skew.value < -0.5 ? 'bull' : 'neutral'} />
        )}
        {desk?.analytics?.flow?.callPutVolRatio != null && (
          <Metric label="C/P VOL" value={desk.analytics.flow.callPutVolRatio.toFixed(2)} tone={desk.analytics.flow.callPutVolRatio >= 1.5 ? 'bull' : desk.analytics.flow.callPutVolRatio <= 0.67 ? 'bear' : 'neutral'} />
        )}
      </div>

      {/* v6.11: skew + flow reads (glama tv-mcp) */}
      {(desk?.analytics?.skew || desk?.analytics?.flow) && (
        <div className="grid sm:grid-cols-2 gap-2">
          {desk?.analytics?.skew && (
            <div className="quantum-panel rounded-2xl p-3">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1">📐 IV SKEW (OTM put − call, 2–6%)</div>
              <div className="text-[10px] text-slate-300 leading-relaxed">{desk.analytics.skew.read}</div>
              <div className="text-[9px] font-mono text-slate-600 mt-1">put IV {desk.analytics.skew.putIV ?? '—'} · call IV {desk.analytics.skew.callIV ?? '—'}</div>
            </div>
          )}
          {desk?.analytics?.flow && (
            <div className="quantum-panel rounded-2xl p-3">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1">🌊 OPTIONS FLOW (aaj ka premium)</div>
              <div className="text-[10px] text-slate-300 leading-relaxed">{desk.analytics.flow.read} · {desk.analytics.flow.oiLeanRead}</div>
              <div className="text-[9px] font-mono text-slate-600 mt-1">CE vol {desk.analytics.flow.callVolume?.toLocaleString('en-IN')} · PE vol {desk.analytics.flow.putVolume?.toLocaleString('en-IN')}</div>
            </div>
          )}
        </div>
      )}

      {/* v6.11: income setup ranker (glama tv-mcp rank_income_setups) */}
      <IncomeRanker />

      {/* v6.7 GEX profile — dealer gamma positioning */}
      {gex && (
        <GexChart gex={gex} spot={desk?.spot ?? 0} />
      )}

      {/* OI chain table */}
      <div className="quantum-panel rounded-2xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between">
          <span className="text-xs font-black text-slate-200">📊 OPTION CHAIN — {symbol} · {desk?.expiry || ''}</span>
          <span className="text-[10px] text-slate-500 font-mono">{desk?.rows?.length || 0} strikes</span>
        </div>
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-[#0d1424] z-10">
              <tr className="text-[9px] text-slate-500 font-black tracking-wider">
                <th className="px-2 py-2 text-right">CE OI</th>
                <th className="px-2 py-2 text-right">CE IV</th>
                <th className="px-2 py-2 text-right">CE LTP</th>
                <th className="px-2 py-2 text-right">CE Δ</th>
                <th className="px-3 py-2 text-center text-cyan-400">STRIKE</th>
                <th className="px-2 py-2 text-left">PE Δ</th>
                <th className="px-2 py-2 text-left">PE LTP</th>
                <th className="px-2 py-2 text-left">PE IV</th>
                <th className="px-2 py-2 text-left">PE OI</th>
              </tr>
            </thead>
            <tbody>
              {(desk?.rows || []).map(r => {
                const isATM = atm?.strike === r.strike;
                return (
                  <tr key={r.strike} className={`border-t border-white/[0.03] hover:bg-white/[0.03] ${isATM ? 'bg-cyan-500/10' : ''}`}>
                    <td className="px-2 py-1.5 text-right relative">
                      {r.callOI > 0 && <div className="absolute right-0 top-1 bottom-1 bg-emerald-500/10 rounded" style={{ width: `${(r.callOI / maxOI) * 100}%` }} />}
                      <span className="relative text-emerald-300/90">{r.callOI ? (r.callOI / 1000).toFixed(0) + 'k' : '—'}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-slate-500">{r.callIV != null ? r.callIV.toFixed(0) : '—'}</td>
                    <td className="px-2 py-1.5 text-right text-slate-200">{r.callLTP ? r.callLTP.toFixed(1) : '—'}</td>
                    <td className="px-2 py-1.5 text-right text-slate-500">{r.callGreeks?.delta != null ? r.callGreeks.delta.toFixed(2) : '—'}</td>
                    <td className={`px-3 py-1.5 text-center font-black ${isATM ? 'text-cyan-300' : 'text-slate-300'}`}>{r.strike}</td>
                    <td className="px-2 py-1.5 text-left text-slate-500">{r.putGreeks?.delta != null ? r.putGreeks.delta.toFixed(2) : '—'}</td>
                    <td className="px-2 py-1.5 text-left text-slate-200">{r.putLTP ? r.putLTP.toFixed(1) : '—'}</td>
                    <td className="px-2 py-1.5 text-left text-slate-500">{r.putIV != null ? r.putIV.toFixed(0) : '—'}</td>
                    <td className="px-2 py-1.5 text-left relative">
                      {r.putOI > 0 && <div className="absolute left-0 top-1 bottom-1 bg-red-500/10 rounded" style={{ width: `${(r.putOI / maxOI) * 100}%` }} />}
                      <span className="relative text-red-300/90">{r.putOI ? (r.putOI / 1000).toFixed(0) + 'k' : '—'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Strategy cards */}
      <div>
        <div className="text-[10px] font-black text-slate-500 tracking-[0.2em] uppercase mb-2">Ensemble-Driven Strategies — POP + payoff ke saath</div>
        <div className="grid gap-3 lg:grid-cols-2">
          {(desk?.strategies || []).map(s => <StrategyCard key={s.id} s={s} lotSize={desk?.lotSize || 1} spot={spot} symbol={symbol} expiry={desk?.expiry} />)}
          {(desk?.strategies || []).length === 0 && (
            <div className="quantum-panel rounded-2xl p-6 text-center text-slate-500 text-xs">
              {loading ? 'Building strategies…' : 'No strategies — index data unavailable'}
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </section>
  );
});

// ---------------- v6.7: GEX bar chart ----------------
function GexChart({ gex, spot }: { gex: GexProfile; spot: number }) {
  const per = (gex.perStrike || []).slice(-24); // right-most strikes window
  if (per.length < 6) return null;
  const maxAbs = Math.max(...per.map(p => Math.abs(p.netGex)), 1);
  const lo = per[0].strike, hi = per[per.length - 1].strike;
  const posOf = (k: number) => ((k - lo) / (hi - lo || 1)) * 100;
  const net = gex.totalNetGex ?? 0;
  const em = gex.expectedMove;
  return (
    <div className="quantum-panel rounded-2xl p-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-xs font-black text-slate-200">⚡ GEX PROFILE — dealer gamma positioning</span>
        <span className={`px-2 py-0.5 rounded-md text-[9px] font-black border ${net > 0 ? 'bg-violet-500/10 text-violet-300 border-violet-500/25' : 'bg-amber-500/10 text-amber-300 border-amber-500/25'}`}>
          {net > 0 ? 'POSITIVE (pin regime)' : 'NEGATIVE (trend regime)'}
        </span>
      </div>
      {/* per-strike bars (center-anchored) */}
      <div className="relative h-24 flex items-center">
        <div className="absolute left-0 right-0 top-1/2 h-px bg-white/10" />
        {per.map(p => {
          const h = Math.max(2, (Math.abs(p.netGex) / maxAbs) * 46);
          const w = Math.max(3, 80 / per.length);
          const left = posOf(p.strike);
          return (
            <div key={p.strike}
              title={`strike ${p.strike} · net GEX ${p.netGex.toLocaleString('en-IN')}`}
              className={p.netGex >= 0 ? 'absolute bg-violet-400/60 rounded-t' : 'absolute bg-amber-400/60 rounded-b'}
              style={{
                left: `${Math.min(99, Math.max(0, left - w / 2.2))}%`,
                width: `${w}%`,
                top: p.netGex >= 0 ? `${50 - (h / 1.24)}%` : '50%',
                height: `${h / 1.24}%`,
              }} />
          );
        })}
        {gex.gammaFlip != null && (
          <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-cyan-400/70" style={{ left: `${posOf(gex.gammaFlip)}%` }}>
            <span className="absolute -top-0.5 left-1 text-[8px] font-black text-cyan-300 whitespace-nowrap">flip {gex.gammaFlip}</span>
          </div>
        )}
        {gex.callWall != null && (
          <div className="absolute top-0 bottom-0 border-l border-dashed border-red-400/50" style={{ left: `${posOf(gex.callWall)}%` }}>
            <span className="absolute bottom-0 left-1 text-[8px] font-black text-red-300 whitespace-nowrap">C-wall</span>
          </div>
        )}
        {gex.putWall != null && (
          <div className="absolute top-0 bottom-0 border-l border-dashed border-emerald-400/50" style={{ left: `${posOf(gex.putWall)}%` }}>
            <span className="absolute bottom-0 left-1 text-[8px] font-black text-emerald-300 whitespace-nowrap">P-wall</span>
          </div>
        )}
        {spot > 0 && (
          <div className="absolute top-0 bottom-0 border-l-2 border-cyan-300/60" style={{ left: `${posOf(Math.min(hi, Math.max(lo, spot)))}%` }}>
            <span className="absolute top-0 left-1 text-[8px] font-black text-cyan-200 whitespace-nowrap">spot</span>
          </div>
        )}
      </div>
      <div className="flex justify-between text-[8px] font-mono text-slate-600 mt-1">
        <span>{lo.toLocaleString('en-IN')}</span>
        <span>{hi.toLocaleString('en-IN')}</span>
      </div>
      <div className="mt-2.5 grid sm:grid-cols-2 gap-1.5">
        {em && (
          <div className="bg-cyan-500/5 border border-cyan-500/15 rounded-lg px-2.5 py-1.5">
            <div className="text-[9px] font-black text-cyan-300/80 tracking-wider">EXPECTED MOVE (1 expiry, {em.method})</div>
            <div className="text-[11px] font-mono text-slate-200">{em.low?.toLocaleString('en-IN')} — {em.high?.toLocaleString('en-IN')} {em.pct != null ? <span className="text-slate-500">(±{em.pct}%)</span> : null}</div>
          </div>
        )}
        <div className="bg-black/30 rounded-lg px-2.5 py-1.5">
          <div className="text-[9px] font-black text-slate-500 tracking-wider">READ</div>
          <div className="text-[10px] text-slate-400 leading-snug">{gex.regimeNote}{gex.gammaFlip != null ? ` · Spot ${spot > gex.gammaFlip ? 'ABOVE' : 'BELOW'} the flip (${gex.gammaFlip.toLocaleString('en-IN')})` : ''}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------- v6.11: Income Setup Ranker (glama tv-mcp) ----------------
function IncomeRanker() {
  const [view, setView] = useState<IncomeView | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setView(await fetchIncomeSetups());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="quantum-panel rounded-2xl p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] font-black text-slate-200">💰 INCOME SETUP RANKER — teeno indices ke credit setups ranked</span>
        <button onClick={load} className="quantum-btn-ghost px-2 py-1 rounded-lg text-[10px] font-bold" aria-label="Refresh income ranker">
          <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span>
        </button>
      </div>
      {(!view || view.count === 0) && (
        <div className="py-3 text-center text-[10px] text-slate-500">{loading ? 'Strategies build ho rahe hain…' : (view?.note || 'koi credit setup nahi bana')}</div>
      )}
      {view && view.count > 0 && (
        <div className="space-y-1.5">
          {(view.top || []).map((r, i) => (
            <div key={`${r.symbol}-${r.id}`} className={`bg-black/25 rounded-xl px-3 py-2 flex items-center gap-2 flex-wrap ${i === 0 ? 'border-l-2 border-l-cyan-500/60' : ''}`}>
              <span className="text-[9px] font-black text-slate-600 w-4">{i + 1}</span>
              <span className="text-[10px] font-black text-white">{r.symbol}</span>
              <span className="text-[9px] text-slate-400">{r.name}</span>
              <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-cyan-500/15 text-cyan-300">score {r.score ?? '—'}</span>
              <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-emerald-500/10 text-emerald-300">POP {r.pop ?? '—'}%</span>
              <span className="text-[9px] font-mono text-slate-500">credit ₹{r.credit}</span>
              {r.riskReward != null && <span className="text-[9px] font-mono text-slate-600">c/l {r.riskReward}</span>}
              <span className={`ml-auto text-[8px] font-black ${r.source === 'nse' || r.source === 'bse' ? 'text-slate-600' : 'text-amber-400/70'}`}>{r.source === 'nse' || r.source === 'bse' ? 'live' : 'model'}</span>
            </div>
          ))}
          <div className="text-[8px] text-slate-600 leading-relaxed">{view.methodology} · {view.note}</div>
        </div>
      )}
    </div>
  );
}
