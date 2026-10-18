// ============================================================
// src/components/aitrading/IndiaAgentPanel.tsx — NSE
// SUPERINTELLIGENCE AUTO-AGENT console (v10.3)
// ------------------------------------------------------------
// The India desk's autonomous agent, in ONE panel (the AgentPanel
// twin — that one is CoinDCX-wallet coupled, this one is Dhan/NSE):
//   ┌ AGENT STATUS     running/idle/paused · mode · NSE clock
//   ├ NEXT-TRADE SIZING what the agent WOULD order on the next
//   │                  qualifying signal (₹X risk → Y shares)
//   ├ 3-TRADE METER    daily quota slots · realized P&L · loss cap
//   ├ PRO STRATEGY     T1 40% + BE-lock · T2 40% · runner 20% trail
//   │                  + NSE clock: entries 09:30–15:00 · EOD 15:15
//   ├ CONFIG           risk%/trade · capital · min score · hold ·
//   │                  cooldown · partial-TP toggles
//   ├ OPEN POSITIONS   exit-stage ENTRY → T1 → RUNNER + booked P&L
//   ├ TODAY'S TRADES   fill log with sizes + reasons
//   ├ TOP PICKS        India board STRONG/ACTION picks
//   ├ BLOCKERS         "entry kyun nahi ho raha" strip
//   └ LIVE LOG         every scan decision (entry/skip/exit/error)
//
// The agent runs SERVER-SIDE (30s loop, NSE hours only). This panel
// polls /api/india/agent every 15s — start/stop are real API calls.
// PAPER is the default; LIVE needs typed phrase + Dhan connected +
// India Risk mode LIVE (typed) — same arming as the crypto agent.
// ============================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api';
import { describeApiError } from '../../utils/apiError';

const POLL_MS = 15_000;

const fmtINR = (n: number | null | undefined, dp = 0) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp })}`;
};
const ago = (ts: number | null) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ---- panel-local view types (mirrors indiaAgentStatus payload) ----
interface IndiaAgentLogLine { ts: number; level: string; text: string }
interface IndiaAgentPick {
  symbol: string; side: string; grade: string; confidence: number;
  aiScore: number | null; ltp: number | null; voters: number | null;
  plan: { entry: number; stopLoss: number; target2: number; riskPct: number } | null;
}
interface IndiaAgentView {
  ok: boolean;
  engine: string;
  config: Record<string, any>;
  trading: { mode: string; killSwitch: boolean; connected: boolean };
  market: { nseOpen: boolean; entryWindowOpen: boolean; squareOffNow: boolean; entryFrom: string; entryUntil: string; squareOffAt: string };
  state: {
    running: boolean; runningSince: number | null; lastScanAt: number | null; scans: number;
    lastEntryAt: number | null; lastEntrySymbol: string | null;
    tickSec: number; nextScanInSec: number | null; lastSkip: { key: string; text: string; at: number } | null;
    log: IndiaAgentLogLine[];
  };
  today: {
    trades: { ts: number; symbol: string; side: string; mode: string; status: string; qty: number | null; price: number | null; reason: string | null }[];
    tradesCount: number; maxTrades: number; realizedPnlINR: number | null; lossCapINR: number | null;
  };
  openPositions: {
    id: string; symbol: string; side: string; mode: string; qty: number;
    entryPrice: number; sl: number | null; tp: number | null; tp2: number | null;
    openedAt: number; ageMin: number | null; maxHoldMin: number;
    tp1Hit: boolean; tp2Hit: boolean; bookedPnlINR: number | null;
    remainingQty: number | null; originalQty: number | null; exitStage: string;
    /** v10.15 GAP 1: the live conviction re-vote (null when OFF). */
    conviction?: { state: string; delta: number | null; currentScore: number | null; entryScore: number | null; side?: string | null } | null;
  }[];
  picks: IndiaAgentPick[];
  sizingPreview: { desk: string | null; symbol?: string; riskINR: number; riskPct: number; equityINR: number; budgetINR?: number; qty?: number; entry?: number; note: string } | null;
  blockers: { key: string; soft?: boolean; text: string }[];
  accuracy: { quorumAwareEntry: boolean; quorumPenalty: number; effectiveMinAiScore: number; thinCommitteeMinAiScore: number; rollingWinRate: number | null; lastNearMisses: { symbol: string; aiScore: number; needScore: number; voters: number; quorumCapped: boolean }[] };
}

const LOG_STYLE: Record<string, string> = {
  entry: 'text-emerald-300', exit: 'text-orange-300', error: 'text-red-400',
  skip: 'text-slate-500', info: 'text-cyan-300',
};
const STAGE_STYLE: Record<string, { label: string; cls: string }> = {
  ENTRY: { label: '🟢 ENTRY', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  T1_HIT: { label: '🟡 T1 HIT', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  T2_HIT: { label: '🟡 T2 HIT', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  RUNNER: { label: '⚡ RUNNER', cls: 'bg-orange-500/15 text-orange-300 border-orange-500/40' },
};

/** The NSE-clock strategy card — the India-specific discipline at a glance. */
function IndiaStrategyCard({ cfg, market }: { cfg: Record<string, any>; market: IndiaAgentView['market'] }) {
  const t1 = Number(cfg?.tp1ClosePct ?? 40);
  const t2 = Number(cfg?.tp2ClosePct ?? 40);
  const runner = Number(cfg?.runnerPct ?? 20);
  return (
    <div className="bg-gradient-to-br from-orange-500/[0.08] to-emerald-500/[0.05] border border-orange-500/20 rounded-xl p-3">
      <div className="text-[10px] font-black text-orange-300 tracking-wider mb-2">🎯 PRO STRATEGY — NSE INTRADAY EXIT PLAN</div>
      <div className="space-y-1 text-[10px] font-mono text-slate-300">
        <div className="flex items-center gap-2">
          <span className="text-cyan-300 font-black w-14 shrink-0">ENTRY</span>
          <span>capital-based sizing — risk {cfg?.riskPerTradePct ?? 1.5}% of {fmtINR(cfg?.equityINR)}, whole shares, gauntlet-gated</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-amber-300 font-black w-14 shrink-0">T1 (1R)</span>
          <span>book {t1}% → SL {cfg?.breakEvenAfterTp1 ? '→ breakeven (risk-free runner)' : 'unchanged'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-orange-300 font-black w-14 shrink-0">T2 (2R)</span>
          <span>book {t2}% → SL → T1 (profit lock), tp2 reference clear (runner free)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-fuchsia-300 font-black w-14 shrink-0">RUNNER</span>
          <span>{runner}% trails — venue watcher ratchet + time-exit {cfg?.maxHoldMin ?? 90}m + trend-flip</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-red-300 font-black w-14 shrink-0">NSE CLK</span>
          <span>entries {market.entryFrom}–{market.entryUntil} IST · EOD square-off {market.squareOffAt} · M–F only</span>
        </div>
      </div>
      {!cfg?.partialTpEnabled && (
        <div className="text-[9px] text-amber-400/90 mt-1.5 font-mono">⚠ Partial TP OFF — venue watcher ka full-exit at TP2/SL apply hota hai</div>
      )}
    </div>
  );
}

export const IndiaAgentPanel = memo(function IndiaAgentPanel() {
  const [view, setView] = useState<IndiaAgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [livePhrase, setLivePhrase] = useState('');
  const [showCfg, setShowCfg] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<Record<string, any> | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const viewRef = useRef<IndiaAgentView | null>(null);
  viewRef.current = view;
  // v10.18 (deep-recheck #3): toast timer ref (see notify)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const notify = useCallback((ok: boolean, text: string) => {
    setToast({ ok, text });
    // v10.18 (deep-recheck #3): timer-ref toast — the first timer used to
    // erase a newer message early (two actions within 6s).
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await apiFetch('/api/india/agent', { signal: AbortSignal.timeout(12000) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d?.ok) throw new Error(describeApiError(d, res.status, `status ${res.status}`));
      setView(d);
      setError(null);
    } catch (e) {
      setError((e as { message?: string })?.message || 'agent status unavailable');
    }
  }, []);

  useEffect(() => {
    poll();
    // v10.18 (deep-recheck #3): hidden tabs skip the poll — every sibling
    // poller already gates on document.hidden; a backgrounded India tab
    // used to fire a 12s-timeout API call every 15s forever.
    const id = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const start = useCallback(async (mode: 'paper' | 'live') => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/india/agent/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, liveConfirmPhrase: mode === 'live' ? livePhrase : undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d?.ok) throw new Error(describeApiError(d, res.status, `start failed (${res.status})`));
      notify(true, mode === 'live' ? '🔴 India AGENT LIVE armed — ab qualifying NSE signals REAL Dhan orders denge' : '🧪 India AGENT PAPER me chalu — qualifying signals virtual trades journal honge (2 hafte track record dekho, phir LIVE)');
      setLivePhrase('');
      await poll();
    } catch (e) { notify(false, `⛔ ${(e as { message?: string })?.message || 'start failed'}`); }
    finally { setBusy(false); }
  }, [livePhrase, notify, poll]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/india/agent/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d?.ok) throw new Error(describeApiError(d, res.status, 'stop failed'));
      notify(true, '🛑 India AGENT stopped — open positions venue watcher (SL/TP/EOD) aage guard karega');
      await poll();
    } catch (e) { notify(false, `⛔ ${(e as { message?: string })?.message || 'stop failed'}`); }
    finally { setBusy(false); }
  }, [notify, poll]);

  const saveConfig = useCallback(async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/india/agent/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d?.ok) throw new Error(describeApiError(d, res.status, 'config save failed'));
      notify(true, '✅ Agent config saved');
      setCfgDraft(null);
      await poll();
    } catch (e) { notify(false, `⛔ ${(e as { message?: string })?.message || 'config save failed'}`); }
    finally { setBusy(false); }
  }, [notify, poll]);

  const cfg = view?.config || {};
  const running = !!view?.state?.running;
  const mode = String(cfg.mode || 'paper').toUpperCase();
  const quota = view?.today;
  const picks = view?.picks || [];
  const preview = view?.sizingPreview;
  const blockers = view?.blockers || [];
  const hardBlockers = blockers.filter(b => !b.soft);
  const softBlockers = blockers.filter(b => b.soft);

  const NUM_FIELD = (key: string, label: string, opts: { step?: number; suffix?: string; hint?: string } = {}) => (
    <label className="block">
      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">{label}</span>
      <input type="number" step={opts.step ?? 1} value={cfgDraft?.[key] ?? cfg[key] ?? ''}
        onChange={e => setCfgDraft(d => ({ ...(d || {}), [key]: e.target.value }))}
        className="mt-1 w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-orange-500/50" />
      {opts.hint && <span className="text-[8px] text-slate-600">{opts.hint}</span>}
    </label>
  );

  return (
    <div className="quantum-panel rounded-2xl border border-orange-500/20 overflow-hidden bg-black/40">
      {/* ---- header ---- */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs font-black text-transparent bg-clip-text bg-gradient-to-r from-orange-300 to-emerald-300">
            🤖 NSE SUPERINTELLIGENCE AGENT
          </span>
          <span className={`px-2 py-0.5 rounded-md text-[9px] font-black font-mono border ${running
            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 animate-pulse'
            : 'bg-slate-500/15 text-slate-400 border-slate-600/40'}`}>
            {running ? `RUNNING · ${mode}` : 'STOPPED'}
          </span>
          {view?.market && (
            <span className={`px-2 py-0.5 rounded-md text-[9px] font-black font-mono border ${view.market.squareOffNow
              ? 'bg-red-500/15 text-red-300 border-red-500/30'
              : view.market.entryWindowOpen
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                : view.market.nseOpen ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-slate-500/15 text-slate-400 border-slate-600/40'}`}>
              {view.market.squareOffNow ? '🌇 EOD 15:15+' : view.market.entryWindowOpen ? '🟢 ENTRY WINDOW' : view.market.nseOpen ? '⏰ NSE OPEN (no-entry window)' : '🌙 NSE CLOSED'}
            </span>
          )}
          {view?.trading?.killSwitch && (
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black font-mono border bg-red-500/15 text-red-300 border-red-500/30">🛑 KILL SWITCH</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {running ? (
            <button onClick={stop} disabled={busy}
              className="px-3 py-1.5 rounded-xl bg-red-500/20 border border-red-500/40 text-red-200 font-black text-[11px] hover:bg-red-500/30 transition-all disabled:opacity-40">
              ⏹ STOP
            </button>
          ) : (
            <>
              <button onClick={() => start('paper')} disabled={busy}
                className="px-3 py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 font-black text-[11px] hover:bg-emerald-500/30 transition-all disabled:opacity-40">
                ▶ START PAPER
              </button>
              <div className="flex items-center gap-1">
                <input value={livePhrase} onChange={e => setLivePhrase(e.target.value)} placeholder='type LIVE'
                  className="w-20 bg-black/40 border border-red-500/25 rounded-lg px-2 py-1.5 text-[10px] font-mono text-red-200 placeholder:text-red-500/40 focus:outline-none focus:border-red-500/50" />
                <button onClick={() => start('live')} disabled={busy || livePhrase.trim().toUpperCase() !== 'LIVE'}
                  className="px-3 py-1.5 rounded-xl bg-red-500/20 border border-red-500/40 text-red-200 font-black text-[11px] hover:bg-red-500/30 transition-all disabled:opacity-30">
                  🔴 START LIVE
                </button>
              </div>
            </>
          )}
          <button onClick={() => setShowCfg(s => !s)}
            className="px-2.5 py-1.5 rounded-xl bg-white/[0.03] border border-white/10 text-slate-300 font-black text-[10px] hover:border-orange-500/40 transition-all">
            ⚙ CFG
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-[11px] text-red-300 font-bold bg-red-500/[0.06] border-b border-red-500/15">
          ⛔ Agent status unavailable — {error}. Har 15s me retry ho raha hai.
        </div>
      )}
      {toast && (
        <div className={`px-4 py-2 text-[11px] font-bold border-b ${toast.ok ? 'text-emerald-300 bg-emerald-500/[0.06] border-emerald-500/15' : 'text-red-300 bg-red-500/[0.06] border-red-500/15'}`}>
          {toast.text}
        </div>
      )}

      {!view ? (
        <div className="p-10 text-center text-xs text-slate-500">agent status load ho raha hai…</div>
      ) : (
        <div className="p-3 md:p-4 space-y-3">
          {/* ---- status strip ---- */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-[10px] font-mono">
            <div className="bg-black/30 rounded-lg px-2.5 py-2">
              <div className="text-slate-500 text-[9px] font-bold">SCANS</div>
              <div className="text-slate-200 font-black">{view.state.scans}</div>
              <div className="text-slate-600 text-[9px]">{ago(view.state.lastScanAt)} · next in {view.state.nextScanInSec ?? '—'}s</div>
            </div>
            <div className="bg-black/30 rounded-lg px-2.5 py-2">
              <div className="text-slate-500 text-[9px] font-bold">QUOTA TODAY</div>
              <div className="text-slate-200 font-black">{quota?.tradesCount ?? 0}/{quota?.maxTrades ?? 3}</div>
              <div className="text-slate-600 text-[9px]">{view.state.lastEntrySymbol ? `last: ${view.state.lastEntrySymbol} ${ago(view.state.lastEntryAt)}` : 'aaj koi entry nahi'}</div>
            </div>
            <div className="bg-black/30 rounded-lg px-2.5 py-2">
              <div className="text-slate-500 text-[9px] font-bold">REALIZED TODAY</div>
              <div className={`font-black ${(quota?.realizedPnlINR ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                {(quota?.realizedPnlINR ?? 0) > 0 ? '+' : ''}{fmtINR(quota?.realizedPnlINR ?? 0, 0)}
              </div>
              <div className="text-slate-600 text-[9px]">loss cap −{fmtINR(quota?.lossCapINR ?? 0)} → stand-down</div>
            </div>
            <div className="bg-black/30 rounded-lg px-2.5 py-2">
              <div className="text-slate-500 text-[9px] font-bold">ROLLING WIN-RATE</div>
              <div className="text-slate-200 font-black">{view.accuracy?.rollingWinRate != null ? `${view.accuracy.rollingWinRate}%` : '—'}</div>
              <div className="text-slate-600 text-[9px]">last {cfg.rollingWindow ?? 10} closed · floor {cfg.minRollingWinRate ?? 35}%</div>
            </div>
          </div>

          {/* ---- quota meter ---- */}
          <div className="flex items-center gap-1.5">
            {Array.from({ length: Math.max(1, quota?.maxTrades || 3) }).map((_, i) => (
              <div key={i} className={`h-2 flex-1 rounded-full ${i < (quota?.tradesCount ?? 0) ? 'bg-gradient-to-r from-orange-400 to-emerald-400' : 'bg-white/[0.06]'}`} />
            ))}
          </div>

          {/* ---- blockers ---- */}
          {(hardBlockers.length > 0 || softBlockers.length > 0) && (
            <div className="space-y-1">
              {hardBlockers.map(b => (
                <div key={b.key} className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[10px] font-mono text-amber-200">{b.text}</div>
              ))}
              {softBlockers.map(b => (
                <div key={b.key} className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-1.5 text-[10px] font-mono text-slate-400">{b.text}</div>
              ))}
            </div>
          )}

          {/* ---- strategy + sizing ---- */}
          <div className="grid gap-2 lg:grid-cols-2">
            <IndiaStrategyCard cfg={cfg} market={view.market} />
            {preview && (
              <div className="bg-black/25 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-black text-violet-300 tracking-wider">📐 NEXT TRADE SIZING {preview.symbol ? `· ${preview.symbol}` : ''}</span>
                  {preview.desk && <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-orange-500/15 text-orange-300">{preview.desk}</span>}
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
                  <div className="bg-black/30 rounded-lg px-2 py-1.5">
                    <div className="text-slate-500 text-[9px] font-bold">RISK / TRADE</div>
                    <div className="text-red-300 font-black text-xs">{fmtINR(preview.riskINR ?? 0)}</div>
                    <div className="text-slate-500 text-[9px]">{preview.riskPct}% of {fmtINR(preview.equityINR ?? 0)} capital</div>
                  </div>
                  <div className="bg-black/30 rounded-lg px-2 py-1.5">
                    <div className="text-slate-500 text-[9px] font-bold">EST. ORDER</div>
                    <div className="text-cyan-300 font-black text-xs">{fmtINR(preview.budgetINR ?? 0)}</div>
                    <div className="text-slate-500 text-[9px]">{preview.qty ? `${preview.qty} shares @ ${preview.entry}` : 'plan ka intezaar'}</div>
                  </div>
                </div>
                <div className="text-[9px] text-slate-600 mt-1.5 font-mono">{preview.note}</div>
              </div>
            )}
          </div>

          {/* ---- near-miss diagnostics (v10.2 parity) ---- */}
          {view.accuracy?.lastNearMisses?.length > 0 && (
            <div className="bg-black/25 rounded-xl p-2.5">
              <div className="text-[9px] font-black text-slate-500 tracking-wider mb-1.5">🔍 NEAR-MISSES — kitne percent door the qualify se</div>
              <div className="flex gap-1.5 flex-wrap">
                {view.accuracy.lastNearMisses.map((nm, i) => (
                  <span key={i} className="px-2 py-1 rounded-lg text-[9px] font-mono border bg-black/30 border-slate-700/50 text-slate-300">
                    {nm.symbol}: {nm.aiScore}/{nm.needScore} ({nm.voters} voters{nm.quorumCapped ? ' · quorum-capped' : ''})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ---- open positions ---- */}
          <div>
            <div className="text-[10px] font-black text-slate-400 tracking-wider mb-1.5">📂 OPEN AGENT POSITIONS ({view.openPositions.length})</div>
            {view.openPositions.length === 0 ? (
              <div className="text-[10px] text-slate-600 font-mono">koi open agent position nahi</div>
            ) : (
              <div className="space-y-1.5">
                {view.openPositions.map(p => {
                  const stage = STAGE_STYLE[p.exitStage] || STAGE_STYLE.ENTRY;
                  const holdPct = p.maxHoldMin > 0 ? Math.min(100, Math.round(((p.ageMin ?? 0) / p.maxHoldMin) * 100)) : 0;
                  // v10.15 GAP 1: the live conviction bar (green ▲ / amber ▼ / red flip)
                  const cv = p.conviction;
                  const cvCls = cv?.state === 'STRENGTHENING' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                    : cv?.state === 'WEAKENING' ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                    : cv?.state === 'FLIPPED' ? 'bg-red-500/15 text-red-300 border-red-500/40' : '';
                  return (
                    <div key={p.id} className="bg-black/30 rounded-xl px-3 py-2 flex items-center gap-2 flex-wrap text-[10px] font-mono">
                      <span className={`px-1.5 py-0.5 rounded border text-[9px] font-black ${stage.cls}`}>{stage.label}</span>
                      {cv && cv.state !== 'UNKNOWN' && cvCls && (
                        <span className={`px-1.5 py-0.5 rounded border text-[9px] font-black ${cvCls}`}
                          title={`Live conviction — ensemble re-vote: entry ${cv.entryScore ?? '?'} → now ${cv.currentScore ?? '?'} (${cv.side ?? '?'}) · delta ${cv.delta != null ? cv.delta : '?'}${cv.state === 'FLIPPED' ? ' — conviction-flip exit fires' : cv.state === 'WEAKENING' ? ' — in-profit SL → breakeven' : ''}`}>
                          CONVICTION {cv.state === 'STRENGTHENING' ? '▲' : cv.state === 'WEAKENING' ? '▼' : '⯅'} {cv.state}{cv.delta != null ? ` ${cv.delta > 0 ? '+' : ''}${cv.delta}` : ''}
                        </span>
                      )}
                      <span className="text-slate-200 font-black">{p.symbol}</span>
                      <span className={p.side === 'LONG' ? 'text-emerald-300' : 'text-red-300'}>{p.side}</span>
                      <span className="text-slate-400">{p.remainingQty ?? p.qty}{p.originalQty ? `/${p.originalQty}` : ''} sh @ ₹{p.entryPrice}</span>
                      <span className="text-red-300/80">SL ₹{p.sl ?? '—'}</span>
                      <span className="text-slate-500">age {p.ageMin ?? '—'}/{p.maxHoldMin}m</span>
                      {p.bookedPnlINR != null && p.bookedPnlINR !== 0 && (
                        <span className={p.bookedPnlINR > 0 ? 'text-emerald-300' : 'text-red-300'}>booked {p.bookedPnlINR > 0 ? '+' : ''}₹{p.bookedPnlINR}</span>
                      )}
                      <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden mt-1">
                        <div className={`h-full rounded-full ${holdPct >= 80 ? 'bg-red-400' : 'bg-cyan-400/60'}`} style={{ width: `${holdPct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ---- today's trades ---- */}
          {view.today.trades.length > 0 && (
            <div>
              <div className="text-[10px] font-black text-slate-400 tracking-wider mb-1.5">🧾 TODAY'S AGENT TRADES</div>
              <div className="space-y-1">
                {view.today.trades.map((t, i) => (
                  <div key={i} className="bg-black/30 rounded-lg px-2.5 py-1.5 text-[10px] font-mono flex items-center gap-2 flex-wrap">
                    <span className="text-slate-500">{new Date(t.ts).toLocaleTimeString('en-IN', { hour12: false })}</span>
                    <span className="text-slate-200 font-black">{t.symbol}</span>
                    <span className={t.side === 'LONG' ? 'text-emerald-300' : 'text-red-300'}>{t.side}</span>
                    <span className="text-slate-500">{t.status}</span>
                    {t.qty != null && <span className="text-slate-400">{t.qty} sh{t.price != null ? ` @ ₹${t.price}` : ''}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ---- top picks ---- */}
          {picks.length > 0 && (
            <div>
              <div className="text-[10px] font-black text-slate-400 tracking-wider mb-1.5">🏆 TOP INDIA PICKS (agent inhi me se entry karega)</div>
              <div className="grid gap-1.5 md:grid-cols-3">
                {picks.map((p, i) => (
                  <div key={i} className="bg-black/30 rounded-xl px-2.5 py-2 text-[10px] font-mono">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-200 font-black">{p.symbol}</span>
                      <span className={p.side === 'LONG' ? 'text-emerald-300' : 'text-red-300'}>{p.side}</span>
                    </div>
                    <div className="text-slate-500 text-[9px]">{p.grade} · conf {p.confidence}%{p.aiScore != null ? ` · AI ${p.aiScore}` : ''}{p.voters != null ? ` · ${p.voters}v` : ''}</div>
                    {p.plan && <div className="text-slate-600 text-[9px]">E ₹{p.plan.entry} · SL ₹{p.plan.stopLoss} · T2 ₹{p.plan.target2}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ---- config drawer ---- */}
          {showCfg && (
            <div className="bg-black/25 rounded-xl p-3 border border-white/8">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-black text-orange-300 tracking-wider">⚙ AGENT CONFIG</span>
                <div className="flex gap-1.5">
                  <button onClick={() => setCfgDraft(null)}
                    className="px-2 py-1 rounded-lg text-[9px] font-black border border-white/10 text-slate-400 hover:text-slate-200">reset</button>
                  <button onClick={() => cfgDraft && saveConfig(Object.fromEntries(Object.entries(cfgDraft).map(([k, v]) => [k, Number(v)])))} disabled={!cfgDraft || busy}
                    className="px-2.5 py-1 rounded-lg text-[9px] font-black bg-orange-500/20 border border-orange-500/40 text-orange-200 hover:bg-orange-500/30 disabled:opacity-30">SAVE</button>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {NUM_FIELD('maxTradesPerDay', 'Trades / day', { hint: 'IST midnight reset' })}
                {NUM_FIELD('riskPerTradePct', 'Risk % / trade', { step: 0.25, hint: 'of desk capital' })}
                {NUM_FIELD('equityINR', 'Desk capital ₹', { step: 1000, hint: 'sizing base' })}
                {NUM_FIELD('dailyLossCapPct', 'Daily loss cap %', { step: 0.5 })}
                {NUM_FIELD('minAiScore', 'Min AI score', { hint: `thin committee: ${view.accuracy?.thinCommitteeMinAiScore ?? cfg.minAiScore + 10}` })}
                {NUM_FIELD('minConfidence', 'Min conf %', { hint: 'STRONG bar' })}
                {NUM_FIELD('cooldownMin', 'Cooldown min')}
                {NUM_FIELD('maxHoldMin', 'Max hold min', { hint: 'time-exit base' })}
              </div>
              <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                {([['partialTpEnabled', 'Partial TP (T1/T2/runner)'], ['breakEvenAfterTp1', 'BE-lock after T1'], ['dynamicTimeExit', 'ATR-adaptive hold']] as const).map(([key, label]) => (
                  <button key={key}
                    onClick={() => saveConfig({ [key]: !cfg[key] })}
                    className={`px-2.5 py-1 rounded-lg text-[9px] font-black border transition-all ${cfg[key]
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : 'bg-white/[0.03] text-slate-500 border-white/10'}`}>
                    {cfg[key] ? '✓' : '✗'} {label}
                  </button>
                ))}
              </div>
              <div className="text-[9px] text-slate-600 mt-2 font-mono leading-relaxed">
                LIVE arming alag hai: Risk settings me India mode LIVE (typed) + Dhan connected + agent start me "LIVE" type karo. Quorum rule: &lt;5 voters signals ko +{view.accuracy?.quorumPenalty ?? 10} score chahiye.
              </div>
            </div>
          )}

          {/* ---- live log ---- */}
          <div>
            <div className="text-[10px] font-black text-slate-400 tracking-wider mb-1.5">📜 LIVE LOG (latest 40)</div>
            <div className="bg-black/40 rounded-xl p-2.5 max-h-56 overflow-y-auto scroll-thin space-y-0.5">
              {view.state.log.length === 0 && <div className="text-[10px] text-slate-600 font-mono">log khali — agent start karo</div>}
              {view.state.log.map((l, i) => (
                <div key={i} className="text-[9.5px] font-mono flex gap-2 leading-relaxed">
                  <span className="text-slate-600 shrink-0">{new Date(l.ts).toLocaleTimeString('en-IN', { hour12: false })}</span>
                  <span className={LOG_STYLE[l.level] || 'text-slate-400'}>{l.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="text-[9px] text-slate-600 font-mono leading-relaxed pt-1 border-t border-white/5">
            🛡️ Safety inheritance: har agent entry wahi gauntlet pass karti hai jo manual click karti hai — kill switch · India LIVE arming · daily caps · one-per-symbol · concentration guard. Paper-first: LIVE se pehle ≥2 hafte paper track record dekho.
          </div>
        </div>
      )}
    </div>
  );
});
