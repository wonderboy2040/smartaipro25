// ============================================================
// src/components/aitrading/ReversalPanel.tsx
// ------------------------------------------------------------
// v12.8 SECTION 02f — SUPERINTELLIGENCE REVERSAL RECOVERY AI
// (user spec, XRP story): "long me minimal loss ₹100-150 accept
// karke close → opposite SHORT me ₹500+ profit book → reversal
// LONG pe wapas entry → phir profit book."
//
// SELF-CONTAINED (the ManualTradeMonitor contract): fetches
// /api/ai/reversal itself — 12s while a cycle is ACTIVE/WAITING
// (the engine ticks server-side every 60s; this just repaints),
// 30s idle. Config edits PUT /api/ai/reversal/config (same clamp
// table as the agent-config route; engine cache force-refreshed).
//
// The board: every ₹-cycle with its leg timeline —
//   LEG-1 LONG  @entry  → −₹150 CUT     (loss-cap, minimal loss)
//   LEG-2 SHORT @flip   → +₹512 BOOKED  (target)
//   LEG-3 LONG  @re-entry → LIVE +₹180  (waiting/active/ended)
// plus the guards (legs left · cooldown · cycle-stop distance).
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getProxyBase } from '../../utils/api';

interface ReversalLegView {
  leg: number | null;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  status: string;
  closePrice?: number | null;
  pnlINR?: number | null;
  closeReason?: string | null;
  openedAt?: number;
  closedAt?: number | null;
}
interface ReversalCycleView {
  cycleId: string;
  pair: string;
  mode: string;
  legs: ReversalLegView[];
  legCount: number;
  openLeg: { leg: number | null; side: string; qty: number; entryPrice: number } | null;
  live: { leg: number | null; side: string; price: number; pnlINR: number | null; state?: string } | null;
  netINR: number;
  state: 'ACTIVE' | 'WAITING' | 'ENDED';
  lastClosedAt?: number | null;
  /** v12.9 manual cycles: the stamped flip plan (side/qty/SL/TP). */
  plan?: { side: string; qty: number; entry: number; sl: number | null; tp: number | null } | null;
}
interface ReversalConfigView {
  enabled: boolean;
  /** v13.1: loss-cap crossing pe the sweep CLOSES the manual leg
   *  itself (default OFF — the v12.7 "never auto-close a manual
   *  trade" rule; ON = the ₹ cap actually caps). */
  autoCut?: boolean;
  lossCapINR: number;
  profitTargetINR: number;
  maxLegs: number;
  cooldownMin: number;
  cycleStopINR: number;
  reentryWindowMin: number;
  minReentryConf: number;
  requireEnsembleConfirm: boolean;
}
interface ReversalData {
  ok: boolean;
  config: ReversalConfigView;
  cycles: ReversalCycleView[];
  /** v12.9: the ENGINE-CONNECTED manual-trade ₹ cycles (grouped by
   *  t.reversal.cycleId — manual trades ACTIVATE at the thresholds). */
  manualCycles?: ReversalCycleView[];
  activeCycles: number;
}

type Notify = ((good: boolean, msg: string) => void) | undefined;

/** The PUT /api/ai/reversal/config wire keys (agent-config naming). */
type ReversalPatch = Partial<Record<
  'reversalEnabled' | 'reversalLossCapINR' | 'reversalProfitTargetINR' | 'reversalMaxLegs' |
  'reversalCooldownMin' | 'reversalCycleStopINR' | 'reversalReentryWindowMin' |
  'reversalMinReentryConf' | 'reversalRequireEnsembleConfirm' | 'reversalAutoCut',
  number | boolean
>>;

const STATE_STYLE: Record<string, { chip: string; label: string; icon: string }> = {
  ACTIVE: { chip: 'bg-violet-500/15 border-violet-500/40 text-violet-300', label: 'ACTIVE — leg chal rahi hai', icon: '⚡' },
  WAITING: { chip: 'bg-amber-500/15 border-amber-500/40 text-amber-300', label: 'WAITING — reversal confirm ka intezaar', icon: '⏳' },
  ENDED: { chip: 'bg-slate-500/15 border-slate-600/40 text-slate-400', label: 'ENDED', icon: '🏁' },
};

const pxv = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

function LegRow({ leg }: { leg: ReversalLegView }) {
  const long = leg.side === 'LONG';
  const closed = leg.status === 'CLOSED';
  const pnl = leg.pnlINR ?? null;
  return (
    <div className={`flex items-center gap-2 text-[10px] font-mono px-2 py-1 rounded-lg border ${closed ? 'border-slate-700/40 bg-slate-900/40' : 'border-violet-500/30 bg-violet-500/10'}`}>
      <span className={`px-1.5 py-0.5 rounded font-black text-[9px] ${long ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{leg.side}</span>
      <span className="text-slate-400">L{leg.leg ?? '·'}</span>
      <span className="text-slate-300">@{leg.entryPrice}</span>
      {closed ? (
        <>
          <span className="text-slate-500">→</span>
          <span className="text-slate-300">{leg.closePrice}</span>
          <span className={`font-bold ${pnl != null ? (pnl >= 0 ? 'text-emerald-300' : 'text-rose-300') : 'text-slate-500'}`}>
            {pnl != null ? `${pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(pnl))}` : '—'}
          </span>
          <span className="text-slate-600 truncate max-w-[130px]" title={leg.closeReason || ''}>{leg.closeReason || ''}</span>
        </>
      ) : (
        <span className="text-violet-300 font-bold">OPEN</span>
      )}
    </div>
  );
}

function CycleCard({ c, cfg, manual }: { c: ReversalCycleView; cfg: ReversalConfigView; manual?: boolean }) {
  const st = STATE_STYLE[c.state] || STATE_STYLE.ENDED;
  const livePnl = c.live?.pnlINR ?? null;
  const legsLeft = Math.max(0, cfg.maxLegs - c.legCount);
  return (
    <div className={`rounded-xl border p-3 space-y-2 ${manual ? 'border-violet-700/40 bg-violet-950/10' : 'border-slate-700/50 bg-slate-900/60'}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-black text-slate-100">{c.pair}</span>
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${st.chip}`}>{st.icon} {st.label}</span>
          {manual
            ? <span className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-violet-500/15 text-violet-300 border-violet-500/40">MANUAL ✋</span>
            : c.mode === 'live' && <span className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-red-500/15 text-red-300 border-red-500/40">LIVE</span>}
          {c.live?.state === 'LOSS_CAP' && <span className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-rose-500/15 text-rose-300 border-rose-500/40">LOSS-CAP</span>}
          {c.live?.state === 'PROFIT_TARGET' && <span className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-emerald-500/15 text-emerald-300 border-emerald-500/40">₹ TARGET</span>}
        </div>
        <div className="flex items-center gap-2">
          {c.live && livePnl != null && (
            <span className={`text-[11px] font-mono font-bold ${livePnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              LIVE {livePnl >= 0 ? '+' : '−'}₹{Math.abs(Math.round(livePnl))} @ {pxv(c.live.price)}
            </span>
          )}
          <span className={`text-sm font-black font-mono ${c.netINR >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            NET {c.netINR >= 0 ? '+' : '−'}₹{Math.abs(Math.round(c.netINR))}
          </span>
        </div>
      </div>
      <div className="space-y-1">
        {c.legs.map((l, i) => <LegRow key={`${c.cycleId}-${i}`} leg={l} />)}
      </div>
      {manual && c.plan && (
        <div className="text-[10px] font-mono text-violet-200/90 bg-violet-500/10 border border-violet-500/30 rounded-lg px-2.5 py-1.5">
          FLIP plan — <b>{c.plan.side}</b> qty {c.plan.qty} @ ~{pxv(c.plan.entry)}{c.plan.sl != null ? ` · SL ${pxv(c.plan.sl)} (₹${cfg.lossCapINR}) / TP ${pxv(c.plan.tp)} (₹${cfg.profitTargetINR})` : ''}
          <span className="block text-violet-400/70 text-[9px] mt-0.5">(Manual trade — execute aap karo; engine plan + Telegram push live hai.)</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[9px] text-slate-500 font-mono flex-wrap">
        <span>legs {c.legCount}/{cfg.maxLegs}{c.state !== 'ENDED' && legsLeft > 0 ? ` · ${legsLeft} left` : ''}</span>
        <span>·</span>
        <span>loss-cap ₹{cfg.lossCapINR}</span>
        <span>·</span>
        <span>target ₹{cfg.profitTargetINR}</span>
        {c.state !== 'ENDED' && (<><span>·</span><span>cycle-stop ₹{cfg.cycleStopINR}</span></>)}
      </div>
    </div>
  );
}

/** v12.9: NO-CAPS input — the user's own calculation, verbatim (the
 *  min/max attributes are GONE; the only guard is save-time > 0). */
function NumField({ label, value, onChange, step = 1, suffix }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number" value={value} step={step}
          onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }}
          className="w-full bg-slate-900/80 border border-slate-700/60 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-100 focus:border-violet-500/60 focus:outline-none"
        />
        {suffix && <span className="text-[10px] text-slate-500 font-bold">{suffix}</span>}
      </div>
    </label>
  );
}

export const ReversalPanel = memo(function ReversalPanel({ notify }: { notify?: Notify }) {
  const [data, setData] = useState<ReversalData | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ReversalConfigView | null>(null);
  const activeRef = useRef(true);
  const loadSeqRef = useRef(0);
  const liveRef = useRef(false); // cycles with state ≠ ENDED (cadence picker — ref, not state: the scheduler chain must read the FRESH value)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/reversal?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) })
        .then(x => x.json()).catch(() => null);
      if (seq !== loadSeqRef.current) return;
      if (!r?.ok) { setError(true); return; }
      setError(false);
      setData(r as ReversalData);
      liveRef.current = (r.cycles || []).some((c: ReversalCycleView) => c.state !== 'ENDED')
        || (r.manualCycles || []).some((c: ReversalCycleView) => c.state !== 'ENDED');
      setForm(prev => prev ? prev : r.config as ReversalConfigView);
    } catch { if (seq === loadSeqRef.current) setError(true); }
  }, []);

  // 12s while cycles live, 30s idle (server engine ticks every 60s —
  // this is the repaint, the discipline itself never waits on the UI).
  useEffect(() => {
    activeRef.current = true;
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (!activeRef.current) return;
        await load();
        schedule();
      }, liveRef.current ? 12_000 : 30_000);
    };
    schedule();
    return () => { activeRef.current = false; if (timer) clearTimeout(timer); };
  }, [load]);

  const save = useCallback(async (patch: ReversalPatch) => {
    if (busy || !form) return;
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/reversal/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(x => x.json()).catch(() => ({ ok: false, error: 'network error' }));
      if (r.ok) {
        setData(prev => prev ? { ...prev, config: r.config } : prev);
        setForm(r.config as ReversalConfigView);
        if (patch.reversalEnabled != null) {
          notify?.(true, r.config.enabled
            ? `🔄 Reversal AI ON — loss-cap ₹${r.config.lossCapINR} · target ₹${r.config.profitTargetINR} · max ${r.config.maxLegs} legs. Futures desk ke open positions ab ₹-cycle me manage honge.`
            : '⏸ Reversal AI OFF — normal SL/TP/trailing discipline wapas.');
        } else {
          notify?.(true, '✅ Reversal AI thresholds update ho gayi — agla watcher pass (60s) se live.');
        }
      } else notify?.(false, `⛔ ${r.error || 'save failed'}`);
    } finally { setBusy(false); }
  }, [busy, form, notify]);

  const cfg = data?.config;
  const cycles = data?.cycles || [];
  const manualCycles = data?.manualCycles || [];
  const liveCycles = cycles.filter(c => c.state !== 'ENDED');
  const endedCycles = cycles.filter(c => c.state === 'ENDED').slice(0, 3);
  const liveManual = manualCycles.filter(c => c.state !== 'ENDED');
  const endedManual = manualCycles.filter(c => c.state === 'ENDED').slice(0, 3);
  // v12.9: no-caps save guard — the ONLY rule is positive numbers
  const thresholdsSane = (f: ReversalConfigView | null): f is ReversalConfigView => !!f
    && f.lossCapINR > 0 && f.profitTargetINR > 0 && f.maxLegs >= 1 && f.cooldownMin > 0
    && f.cycleStopINR > 0 && f.reentryWindowMin > 0 && f.minReentryConf >= 0;

  if (error && !data) {
    return (
      <div className="quantum-panel rounded-2xl p-4 text-center">
        <div className="text-2xl mb-1">🔄</div>
        <div className="text-xs text-red-400 font-bold">Reversal AI board unreachable</div>
        <div className="text-[10px] text-slate-500 mt-1">30s me auto-retry ho raha hai.</div>
      </div>
    );
  }

  return (
    <div className="quantum-panel rounded-2xl p-3.5 space-y-3">
      {/* header + master toggle */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="text-xs font-black text-slate-100 flex items-center gap-1.5">
            🔄 REVERSAL RECOVERY AI
            {cfg?.enabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 font-black">ON</span>}
            {liveCycles.length > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-black">{liveCycles.length} cycle live</span>}
          </div>
        </div>
        <button
          disabled={busy || !cfg}
          onClick={() => cfg && save({ reversalEnabled: !cfg.enabled })}
          className={`px-3 py-1.5 rounded-xl text-[11px] font-black border transition-colors ${cfg?.enabled
            ? 'bg-violet-600/90 text-white border-violet-500 hover:bg-violet-500'
            : 'bg-slate-800/80 text-slate-300 border-slate-600/60 hover:bg-slate-700'}`}
        >
          {cfg?.enabled ? '⏸ PAUSE Reversal AI' : '⚡ ENABLE Reversal AI'}
        </button>
      </div>

      {/* the user's exact scenario, spelled out */}
      <div className="text-[10px] leading-relaxed text-slate-400 border border-slate-700/40 bg-slate-900/40 rounded-xl px-3 py-2">
        <b className="text-slate-300">Kaise kaam karta hai (aapka XRP plan):</b> LONG −₹150 me cut → ensemble reversal confirm → <b className="text-rose-300">SHORT flip</b> → +₹500 pe <b className="text-emerald-300">BOOK</b> → reversal LONG confirm → <b className="text-emerald-300">LONG re-entry</b> → phir book. Failed signal net-positive cycle ban jata hai. Guards: leg budget · cooldown · cycle-stop ₹ · ensemble gate. CoinDCX <b>FUTURES desk</b> positions pe AUTO; <b className="text-violet-300">MANUAL trades</b> threshold-cross pe <b>ACTIVATE</b> hote hain — exact FLIP plan (qty/SL/TP) banner + Telegram + yahan board pe. Thresholds <b>NO CAPS</b> — hamare hisaab se set karo.
      </div>

      {/* config grid — v12.9: NO CAPS, editable verbatim (user spec) */}
      {form && cfg && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <NumField label="Loss cap / leg" value={form.lossCapINR} step={10} suffix="₹" onChange={(v) => setForm(f => f ? { ...f, lossCapINR: v } : f)} />
          <NumField label="Profit target / leg" value={form.profitTargetINR} step={50} suffix="₹" onChange={(v) => setForm(f => f ? { ...f, profitTargetINR: v } : f)} />
          <NumField label="Max legs / cycle" value={form.maxLegs} onChange={(v) => setForm(f => f ? { ...f, maxLegs: v } : f)} />
          <NumField label="Leg cooldown" value={form.cooldownMin} step={0.5} suffix="min" onChange={(v) => setForm(f => f ? { ...f, cooldownMin: v } : f)} />
          <NumField label="Cycle stop (net)" value={form.cycleStopINR} step={50} suffix="₹" onChange={(v) => setForm(f => f ? { ...f, cycleStopINR: v } : f)} />
          <NumField label="Re-entry window" value={form.reentryWindowMin} step={5} suffix="min" onChange={(v) => setForm(f => f ? { ...f, reentryWindowMin: v } : f)} />
          <NumField label="Re-entry conf bar" value={form.minReentryConf} suffix="%" onChange={(v) => setForm(f => f ? { ...f, minReentryConf: v } : f)} />
        </div>
      )}
      {form && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer select-none">
            <input type="checkbox" checked={form.requireEnsembleConfirm} onChange={(e) => setForm(f => f ? { ...f, requireEnsembleConfirm: e.target.checked } : f)} className="accent-violet-500" />
            Ensemble gate — flip tabhi jab AI reversal confirm kare (pullback me vetoh)
          </label>
          {/* v13.1 AUTO-CUT — the XRP lesson: ₹150 cap crossed but the
              advisory plan went unread for 44 min → −₹2,250. ON = the
              sweep closes the manual leg AT the crossing price itself. */}
          <label className="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer select-none"
            title="LOSS-CAP crossing pe manual trade AUTO-CLOSE ho jayega (crossing price par) + Telegram push + flip plan board pe. Default OFF hai (site manual trade kabhi auto-close nahi karti — v12.7 rule); ON karne par cap actually cap ban jata hai.">
            <input type="checkbox" checked={!!form.autoCut} onChange={(e) => setForm(f => f ? { ...f, autoCut: e.target.checked } : f)} className="accent-rose-500" />
            <b className={form.autoCut ? 'text-rose-300' : 'text-slate-500'}>✂️ AUTO-CUT manual legs at loss-cap</b>
          </label>
          <button
            disabled={busy || !thresholdsSane(form)}
            onClick={() => form && save({
              reversalLossCapINR: form.lossCapINR, reversalProfitTargetINR: form.profitTargetINR,
              reversalMaxLegs: form.maxLegs, reversalCooldownMin: form.cooldownMin,
              reversalCycleStopINR: form.cycleStopINR, reversalReentryWindowMin: form.reentryWindowMin,
              reversalMinReentryConf: form.minReentryConf,
              reversalRequireEnsembleConfirm: form.requireEnsembleConfirm,
              ...(form.autoCut != null ? { reversalAutoCut: form.autoCut } : {}),
            })}
            className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-violet-600/90 text-white border border-violet-500 hover:bg-violet-500 disabled:opacity-50"
          >
            💾 Save thresholds
          </button>
          <span className="text-[9px] text-slate-600 font-mono">NO CAPS — aapke hisaab se (sab {'>'} 0 ho)</span>
        </div>
      )}

      {/* cycles */}
      {cycles.length === 0 && manualCycles.length === 0 && (
        <div className="text-[11px] text-slate-500 border border-dashed border-slate-800/60 rounded-xl px-3 py-2.5">
          {cfg?.enabled
            ? '🔄 Koi cycle nahi — futures desk pe position khulegi to engine leg-1 bana dega; MANUAL trade record karo to wo bhi ₹-cycle me activate hoga (loss-cap pe plan + flip levels).'
            : '⏸ Reversal AI OFF hai. ENABLE karo — futures desk ke open positions AUTO ₹-cycle me manage honge, manual trades threshold-cross pe ACTIVATE honge.'}
        </div>
      )}
      {liveCycles.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-black text-slate-300 uppercase tracking-wider">Futures desk — live cycles</div>
          {liveCycles.map(c => <CycleCard key={c.cycleId} c={c} cfg={cfg!} />)}
        </div>
      )}
      {liveManual.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-black text-violet-300 uppercase tracking-wider">✋ Manual trades — engine-connected cycles</div>
          {liveManual.map(c => <CycleCard key={c.cycleId} c={c} cfg={cfg!} manual />)}
        </div>
      )}
      {(endedCycles.length > 0 || endedManual.length > 0) && (
        <div className="space-y-2">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-wider">Recent ended cycles</div>
          {endedCycles.map(c => <CycleCard key={c.cycleId} c={c} cfg={cfg!} />)}
          {endedManual.map(c => <CycleCard key={c.cycleId} c={c} cfg={cfg!} manual />)}
        </div>
      )}
    </div>
  );
});

export default ReversalPanel;
