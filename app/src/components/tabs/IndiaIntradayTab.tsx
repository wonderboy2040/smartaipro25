// ============================================================
// src/components/tabs/IndiaIntradayTab.tsx — v6.10 INDIA DESK
// ------------------------------------------------------------
// The India half of the old AI Trading tab, now a SELF-CONTAINED
// desk — nothing crypto on this screen:
//   ┌ COMMAND BAR     NIFTY/VIX regime · engine status · refresh
//   ├ NSE CLOCK       live IST session phase + countdown
//   ├ QUICK NAV       sticky section jump chips
//   ├ 00 AGENT        NSE auto-trade agent console (v10.3)
//   ├ 00b ASK AI      Pro Trader MCP agent chat (v10.3 wiring)
//   ├ 📊 DESK STATS   v6.10 one-glance strip (scanned·actionable·
//   │                 STRONG·avg conf·mood)
//   ├ 🏆 TOP 5 PICKS  full-universe composite ranking (44 stocks
//   │                 + NIFTY/BANKNIFTY → ranked 5 best trades)
//   ├ 01 SIGNAL BOARD multi-model consensus cards (16 voting + 4 shadow)
//   ├ 01b MORNING BRIEF · 02 OPTIONS DESK (NSE indices)
//   ├ 02b SWING DESK  multi-day India setups
//   ├ 03 EXECUTION    India positions · Dhan · risk gates
//   └ 04 BACKTEST · 05 ALERTS · 06 MODELS · 07 LEDGER
// ============================================================
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAITrading } from '../aitrading/useAITrading';
import { SignalCard, UltrafastChecklist } from '../aitrading/SignalCard';
import { MtfBlock, EdgeBlock } from '../aitrading/DeepQualityBlock';
// v21.15.0: MTF TRADE PLAN panel (user spec — 15m→5m intraday · 1h→15m swing · 5m→1m scalp)
import { TradePlanPanel } from '../aitrading/TradePlanPanel';
// v21.16.0: MTF SIGNALS BOARD (Dual-Timeframe) + AUTO-LINK (paper) panel
import { MTFDualBoardPanel } from '../aitrading/MTFDualBoardPanel';
// v20.7.5 DEEP ANALYSIS ACCURACY UPGRADE — 15s self-recheck of the open
// modal + freshness chips + the FULL indicator transparency grid.
import { useDeepAutoRecheck, DeepFreshnessChip, DeepTransitionLog, DeepIndicatorGrid, DeepPinnedCompare, isPinnableSignal, deepPinVerdict, type DeepModalState } from '../aitrading/deepAnalysisExtras';
// v20.7.5 THE 15s SIGNAL RECHECK PANEL — STRONG/ACTION signals ka live
// re-validation state (server loop same cadence par chalta hai).
import { SignalRecheckPanel } from '../aitrading/SignalRecheckPanel';
import { CandleChart } from '../aitrading/CandleChart';
import { MarketClockStrip } from '../aitrading/MarketClockStrip';
import { EngineHealthStrip } from '../aitrading/EngineHealthStrip';
import { OpsHealthStrip } from '../aitrading/OpsHealthStrip';
import { QuickNav } from '../aitrading/QuickNav';
import { OptionsDeskPanel } from '../aitrading/OptionsDeskPanel';
import { OrderConsole } from '../aitrading/OrderConsole';
import { ModelRegistry } from '../aitrading/ModelRegistry';
import { BacktestPanel } from '../aitrading/BacktestPanel';
import { GateReplayPanel } from '../intraday/GateReplayPanel';
import { ModelPerformancePanel } from '../aitrading/ModelPerformancePanel';
import { StrategyHealthPanel } from '../aitrading/StrategyHealthPanel';
// v11.6 → v11.7 FIX: the MCP mesh ops view was originally wired only into the
// DEAD tabs/AITradingTab.tsx (unreachable from App.tsx since the v6.9 desk
// split) — users could never see it. Re-wired here onto the LIVE India desk.
import { MeshStatusPanel } from '../aitrading/MeshStatusPanel';
import { AlertsPanel } from '../aitrading/AlertsPanel';
import { MorningBriefPanel, SwingDeskPanel, SignalLedgerPanel, TrustLayerPanel, PerfAnalyticsPanel, SectorMapPanel } from '../aitrading/ProPanels';
// v9.1 PAPER DESK (Phase-1 merge of the orphaned v4 intraday tree — the
// panels were fully built/tested, just unreachable from the shipped UI,
// which is why "Paper Trading" never started on the India desk):
//   • useIntradayStream — SSE live quotes for open paper positions
//   • PaperTradePanel / openPaperTrade — server-managed simulator
//     (T1 50% book + breakeven trail + SL/T2/EOD auto-exit)
//   • TrackRecordPanel / JournalPanel / CommitteePanel — the
//     accountability + AI-coaching layer over those virtual trades
//   • UniverseEditor — the scanner watchlist those scans run on
import { useIntradayStream } from '../intraday/useIntradayStream';
import { PaperTradePanel, openPaperTrade } from '../intraday/PaperTradePanel';
import { TrackRecordPanel } from '../intraday/TrackRecordPanel';
import { JournalPanel } from '../intraday/JournalPanel';
import { CommitteePanel } from '../intraday/CommitteePanel';
import { UniverseEditor } from '../intraday/UniverseEditor';
import { adaptAISignal } from '../intraday/adaptAISignal';
import type { LiveQuote } from '../intraday/types';
// v10.3 PARITY (CoinDCX level): the two missing panels —
//   • ProTraderAgentPanel — the ASK-AI chat (8 MCP tools, /api/intraday-agent)
//     jo purane dead IntradayTab me tha par naye desk me wire nahi hua tha
//   • IndiaAgentPanel — the NSE auto-trade agent console (/api/india/agent)
import { ProTraderAgentPanel } from '../intraday/ProTraderAgentPanel';
import { IndiaAgentPanel } from '../aitrading/IndiaAgentPanel';
// v20.7.9 ULTRAFAST INDIA PRICES: the board cards used to ride ONLY the
// 5s intraday-watcher SSE, while the server's FASTER 3s India push stream
// (/api/stream?in=… — Groww NSE 3s poll, refcounted, NSE-window gated,
// index fallback Yahoo) existed but nothing on this tab subscribed to it.
// The tab now opens ONE /api/stream connection for its board symbols and
// prefers the 3s push tick, falling back to the 5s watcher quote (which
// still owns paper/tracked symbols the push stream doesn't carry).
import { useCxLivePrices } from '../aitrading/useCxLivePrices';
// v11.0 GLOBAL MARKET COUNCIL — 6-seat verdict surface + near-miss
// journal (India desk: onchain seat structurally abstains, options-flow
// seat rides the NSE chain read).
import { CouncilVerdictPanel } from '../aitrading/CouncilVerdictPanel';
import { NearMissPanel } from '../aitrading/NearMissPanel';
import {
  SectionLabel, RegimeChips, BreadthStrip, RefreshCountdown, DeskStatsStrip,
  IndiaHowToTrade, useDeskViewMode, ViewModeToggle, ProSectionsNote,
  FreshnessBadge,
} from '../aitrading/deskShared';
import type { AISignal, DhanStatus } from '../aitrading/types';

// v6.13: simple-view me sirf trade-flow sections dikhte hain; pro nav ke andar walon ko `pro: true` lagaya gaya hai.
// v21.22.0: Expert Picks, Top 5 Picks, Manual Trade Tracker, and Superintelligence Reversal AI
// permanently removed from both tabs per user instruction.
const NAV = [
  { id: 'in-agent', label: 'AGENT', emoji: '🤖', pro: false },
  { id: 'in-chat', label: 'ASK AI', emoji: '💬', pro: false },
  { id: 'in-signals', label: 'SIGNALS', emoji: '📡', pro: false },
  { id: 'in-recheck', label: 'RECHECK', emoji: '🔁', pro: false },
  { id: 'in-options', label: 'OPTIONS', emoji: '📊', pro: false },
  { id: 'in-execute', label: 'EXECUTE', emoji: '⚙️', pro: false },
  { id: 'in-paper-desk', label: 'PAPER', emoji: '📋', pro: false },
  { id: 'in-brief', label: 'BRIEF', emoji: '📰', pro: true },
  { id: 'in-sectors', label: 'SECTORS', emoji: '🗺️', pro: true },
  { id: 'in-swing', label: 'SWING', emoji: '🗂️', pro: true },
  { id: 'in-backtest', label: 'BACKTEST', emoji: '🧪', pro: true },
  { id: 'in-alerts', label: 'ALERTS', emoji: '🔔', pro: true },
  { id: 'in-models', label: 'MODELS', emoji: '🧠', pro: true },
  { id: 'in-ledger', label: 'LEDGER', emoji: '🔗', pro: true },
  { id: 'in-trust', label: 'TRUST', emoji: '🛡️', pro: true },
];

// v20.7.12 [H2-1]: module-scope simple list (per-render array nahi —
// memo'd QuickNav ko bust karta tha)
const NAV_SIMPLE = NAV.filter(n => !n.pro);

export default memo(function IndiaIntradayTab() {
  // v6.9: India-scoped loading — the India desk never pays for the
  // crypto/futures boards.
  const t = useAITrading(true, { markets: ['INDIA'] });
  const { india, state, positions, entries, loading, busy, refresh, refreshPositions, executeIndia, updateConfig, closePos, fetchDeep, positionsLive, rescan, rescanning } = t;
  const { runBacktest, runStrategyLab, fetchAlertsStatus, saveAlertsConfig, testAlert, fetchDhanStatus, dhanConnect, dhanDisconnect } = t;
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  // v6.13: SIMPLE (trade-flow only) / PRO (poora desk) — persist hota hai
  const [viewMode, setViewMode] = useDeskViewMode();
  const simple = viewMode === 'simple';

  // ---- v9.1 PAPER DESK state ----
  // SSE live quotes feed the open-position P&L. v10.12 (#1): the SIGNAL
  // BOARD cards now consume the same stream for their live LTP overlay +
  // source pill (Groww·live / Yahoo·delayed), so the stream stays connected
  // in EVERY view mode — not just while the pro-mode paper desk renders.
  // (The server watcher broadcasts regardless; one more attached client
  // costs nothing.)
  const stream = useIntradayStream(true);
  // v20.7.9: the 3s ultrafast push feed for the BOARD's signal symbols
  // (server inStream → /api/stream?in=…). Sorted-key hygiene, hidden-park,
  // zombie-kill and the never-stop watchdog all come free from the hook.
  // (Uses `india` — `board` is aliased further down, after this line.)
  const indiaPushSyms = useMemo(() => (india?.signals || []).map(s => s.symbol), [india?.generatedAt, india?.signals]); // eslint-disable-line react-hooks/exhaustive-deps
  const cxPush = useCxLivePrices(true, [], [], [], indiaPushSyms);
  const pushFor = cxPush.forSignal;
  // Live-quote lookup for a board signal — 3s PUSH tick first (fresher),
  // then the 5s watcher quote, then null (snapshot fallback). The watcher
  // leg keeps its 30s FRESHNESS GATE; the push leg's own gate lives inside
  // useCxLivePrices.forSignal (30s + feed-alive logic).
  const liveFor = useCallback((symbol: string): LiveQuote | null => {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    const push = pushFor('INDIA', sym);
    if (push && push.price > 0) {
      return { price: push.price, change: push.change, ts: push.time, src: push.src || 'groww-live' };
    }
    const q = stream.livePrices[sym];
    if (!q || !(q.price > 0)) return null;
    const at = q.ts || stream.lastQuoteAt;
    return (at > 0 && Date.now() - at <= 30_000) ? q : null;
  }, [pushFor, stream.livePrices, stream.lastQuoteAt]);
  // bump → Paper/TrackRecord/Journal panels refetch (after open/close).
  const [paperRefresh, setPaperRefresh] = useState(0);
  // v20.2 B8: TrackRecord/Journal self-poll — "Currently Tracking" LTP +
  // journal rows pehle sirf paper open/close pe refresh hote the (stale
  // indefinitely). 60s visibility-gated tick dono panels ko live rakhta hai.
  const [trackTick, setTrackTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setTrackTick(v => v + 1); }, 60_000);
    return () => clearInterval(t);
  }, []);
  const [universeOpen, setUniverseOpen] = useState(false);
  // open Paper-Desk symbols, lifted UP from PaperTradePanel so the board
  // cards can show ✓ PAPER OPEN (the old tab kept this in a dead ref — fixed).
  const [paperOpenSymbols, setPaperOpenSymbols] = useState<ReadonlySet<string>>(new Set());
  const handlePaperSymbols = useCallback((next: Set<string>) => {
    setPaperOpenSymbols(prev => {
      if (prev.size === next.size && [...next].every(x => prev.has(x))) return prev; // no-change → no re-render
      return new Set(next);
    });
  }, []);
  const [deep, setDeep] = useState<DeepModalState | null>(null);
  const [dhan, setDhan] = useState<DhanStatus | null>(null);

  const board = india;
  const models = board?.models || [];
  const canLiveIndia = state?.config?.indiaMode === 'live' && !!dhan?.connected;

  // Dhan status boot-load (light: profile ping only when connected)
  useEffect(() => {
    let alive = true;
    fetchDhanStatus().then(s => { if (alive && s) setDhan(s); }).catch(() => {});
    return () => { alive = false; };
  }, [fetchDhanStatus]);
  const refreshDhan = useCallback(() => {
    fetchDhanStatus().then(s => { if (s) setDhan(s); }).catch(() => {});
  }, [fetchDhanStatus]);
  // v20.7.12 [H2-1]: stable dhan handlers (OrderConsole ko per-render naye
  // inline async arrows na milen — tab live-push flush se 1.25/s re-render
  // hota hai aur OrderConsole heavy hai)
  const onDhanConnectStable = useCallback(async (id: string, tok: string) => {
    const r = await dhanConnect(id, tok); refreshDhan(); return r;
  }, [dhanConnect, refreshDhan]);
  const onDhanDisconnectStable = useCallback(async () => {
    const r = await dhanDisconnect(); refreshDhan(); return r;
  }, [dhanDisconnect, refreshDhan]);

  // v10.18 (deep-recheck #3): timer-ref toast — a stale timer used to
  // wipe a newer execution message early (two actions inside 6s).
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((ok: boolean, text: string) => {
    setToast({ ok, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const onExecuteIndia = useCallback(async (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; leverage?: number }) => {
    const r = await executeIndia(signal, mode, opts);
    if (r.ok) {
      // v7.0.2: notify-mode is NOT a paper trade — the old toast fell into
      // the paper branch and said "paper trade opened … qty undefined".
      if (mode === 'notify') {
        notify(true, `🔔 Notify-only — ${r.note || 'gauntlet chala, alert + journal audit likha. Koi order/position NAHI bana.'}`);
      } else {
        notify(true, mode === 'live'
          ? `✅ Dhan LIVE order placed — ${signal.symbol} ${signal.side} · ${r.filled?.qty ?? '—'} shares @ ₹${r.filled?.price ?? '—'} · broker SL-M armed · 15:15 square-off${r.fitted ? ` · ⚙️ ${r.fitted}` : ''}`
          : `🧪 India paper trade opened — ${signal.symbol} ${signal.side} · ${r.filled?.qty ?? '—'} shares @ ₹${r.filled?.price ?? '—'} (watcher SL/TP + trailing)${r.fitted ? ` · ⚙️ ${r.fitted}` : ''}`);
      }
    } else {
      notify(false, `⛔ ${r.error || 'execution failed'}`);
    }
    return r; // v7.0.2: the ticket's own banner awaits this honest result
  }, [executeIndia, notify]);

  // v9.1 PAPER DESK BRIDGE — the Superintelligence board's signal, opened
  // as a server-managed Paper Desk position (/api/intraday-paper): T1 par
  // 50% book, breakeven trail, SL/T2 watcher + 15:10 EOD square-off, live
  // P&L + durable history + AI journal — the full simulator, one click.
  const onDeskPaper = useCallback(async (signal: AISignal) => {
    const adapted = adaptAISignal(signal);
    if (!adapted) {
      notify(false, `⛔ ${signal.symbol}: Paper Desk ke liye tradeable levels (entry/SL/targets) incomplete hain`);
      return;
    }
    // Size mirrors the ticket math: budget ÷ entry (min 1 share).
    const budget = state?.config?.indiaMaxOrderINR ?? 5000;
    const qty = Math.max(1, Math.floor(budget / adapted.entry));
    const r = await openPaperTrade(adapted, qty);
    if (r.ok) {
      notify(true, `📈 Paper Desk trade opened — ${signal.symbol} ${qty} shares @ ₹${adapted.entry.toFixed(2)} · T1 50% book + breakeven trail + SL/T2/EOD auto-exit (08 PAPER DESK me track)`);
      setPaperRefresh(k => k + 1); // panels + badges refetch
    } else {
      notify(false, `⛔ ${r.error || 'Paper Desk open failed'}`);
    }
  }, [state?.config?.indiaMaxOrderINR, notify]);

  const onSaveConfig = useCallback(async (patch: Record<string, unknown>) => {
    const r = await updateConfig(patch);
    if (!r.ok) notify(false, `⛔ ${r.error}`);
    else if (patch.killSwitch) notify(true, '☠️ Kill switch ON — auto disabled, mode → paper, open orders cancelled');
    else if (patch.indiaMode === 'live') notify(true, '🔴 India LIVE armed — Dhan par ab STRONG India signals REAL orders de sakte hain');
    else if (patch.indiaMode === 'paper') notify(true, '🧪 India paper mode — orders simulated');
    return r;
  }, [updateConfig, notify]);

  const onClose = useCallback(async (id: string) => {
    const r = await closePos(id);
    notify(r.ok, r.ok ? '✅ Position closed' : `⛔ ${r.error}`);
  }, [closePos, notify]);

  // v6.12.1: request token — a stale fetchDeep response (modal closed
  // via Escape mid-flight, or a new deep scan started) can no longer
  // re-open the modal with late data.
  const deepReq = useRef(0);
  const onDeep = useCallback(async (signal: AISignal) => {
    const id = ++deepReq.current;
    // v20.7.9 THE BOARD-vs-DEEP MISMATCH FIX: PIN the clicked signal —
    // the modal renders the EXACT card the user clicked + a LIVE
    // RE-VERIFICATION comparison, never a silently-swapped drifted
    // re-run (the "deep analysis ka data alag kyun?" complaint).
    // Top/Expert-picks stubs (no confidence) stay pin-less.
    const pin = isPinnableSignal(signal) ? signal : null;
    setDeep({ loading: true, pinned: pin, pinnedAt: pin ? Date.now() : null });
    // v20.7.5: user click → fresh=1 (server deep-cache bypass — ensemble
    // runs NOW; the open modal then self-rechecks every 15s).
    const r = await fetchDeep(signal.symbol, signal.market);
    if (deepReq.current !== id) return; // stale — dropped
    if (r.ok && r.signal) setDeep(prev => ({ ...prev, loading: false, signal: r.signal, indicators: r.indicators, narrative: r.narrative, ltf: r.ltf, edge: r.edge, recheckedAt: r.recheckedAt ?? Date.now() }));
    else setDeep(prev => ({ ...prev, loading: false, error: r.error || 'deep analysis unavailable' }));
  }, [fetchDeep]);
  // v20.7.12 [H2-1]: ExpertPicks ka stable onDeep (har render pe naya
  // inline arrow nahi — tab live-push flushes se re-render hota hai)
  const onDeepExpert = useCallback((sym: string) => { onDeep({ symbol: sym, market: 'INDIA' } as AISignal); }, [onDeep]);

  // v20.7.12 [H3-3]: EXECUTE ROUTING — CoinDcxTab jaisa hi: CONFIRMED →
  // pinned plan; DRIFTED → LIVE plan (same side fresh numbers); FLIPPED →
  // execute band (dead thesis); UNKNOWN → verdict ka wait. Pehle modal ka
  // 🚀 button HAMESHA pinned (~90s purana) plan se jaata tha.
  const deepPinV = deep?.pinned && deep?.signal
    ? deepPinVerdict(deep.pinned, deep.signal)
    : null;
  const deepExecSig = deep
    ? (deepPinV
      ? (deepPinV.verdict === 'CONFIRMED' ? deep.pinned!
        : deepPinV.verdict === 'DRIFTED' ? deep.signal!
          : null)
      : (deep.pinned ?? deep.signal))
    : null;
  const deepPrimary = deep ? (deep.pinned ?? deep.signal) : null;
  const deepCardSig = deepExecSig ?? deepPrimary;
  const deepCardCanExec = !!deepExecSig;
  const deepCardTick = deepCardSig ? liveFor(deepCardSig.symbol) : null;

  // v20.7.5: the OPEN deep modal re-checks ITSELF every 15s — grade /
  // side / confidence drift becomes a VISIBLE transition log instead of
  // silent stale numbers (the "deep analysis galat info" fix).
  const deepAuto = useDeepAutoRecheck(deep, setDeep, fetchDeep, deepReq, 'INDIA');

  // v6.12: Escape closes the deep modal (keyboard a11y)
  // v6.13.1: body scroll lock when deep modal is open
  useEffect(() => {
    if (!deep) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { deepReq.current++; setDeep(null); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [deep]);

  return (
    <div className="space-y-4">
      {/* ============ COMMAND BAR (India-branded) ============ */}
      <div className="quantum-panel rounded-2xl p-4 bg-gradient-to-r from-orange-500/[0.08] via-transparent to-amber-500/[0.05] border border-orange-500/15">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black tracking-wide bg-gradient-to-r from-orange-300 to-amber-200 bg-clip-text text-transparent">🇮🇳 INDIA INTRADAY DESK</h2>
              <span className="quantum-badge">v6.13</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5">
              NSE 86-name core universe (500+ full mode) + NIFTY/BANKNIFTY → {models.length || 16}-model consensus · TOP-5 composite rank · options desk · Dhan gauntlet
              {canLiveIndia && <span className="text-red-400 font-black"> · INDIA LIVE ARMED (Dhan)</span>}
              <span className="text-orange-400/80 font-bold"> · crypto alag tab me (₿ CoinDCX)</span>
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <RegimeChips board={board} market="INDIA" />
            <RefreshCountdown board={board} loading={loading} />
            <ViewModeToggle mode={viewMode} onSet={setViewMode} />
            {/* v12.5 RESCAN — full NSE universe fresh scan (cache bypass) */}
            <button onClick={() => rescan()} disabled={rescanning || loading}
              title="RESCAN — poora NSE universe dobara fresh scan (deep AI ensemble, cache bypass). Naye top intraday signals — fresh prices, fresh consensus, fresh guards. Cold scan me kuch second lag sakte hain."
              className={`px-3 py-2 rounded-xl text-xs font-black border transition-all disabled:opacity-50 ${rescanning
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-400/50 animate-pulse'
                : 'bg-gradient-to-r from-cyan-600/30 to-violet-600/30 text-cyan-200 border-cyan-500/40 hover:from-cyan-500/40 hover:to-violet-500/40'}`}>
              <span className={rescanning ? 'inline-block animate-spin' : ''}>🔁</span>
              {rescanning ? 'SCANNING…' : 'RESCAN'}
            </button>
            <button onClick={() => refresh()} disabled={loading}
              className="quantum-btn-ghost px-3 py-2 rounded-xl text-xs font-bold disabled:opacity-50">
              <span className={loading ? 'inline-block animate-spin' : ''}>🔄</span>
            </button>
          </div>
        </div>
      </div>

      {/* ============ NSE SESSION CLOCK (v6.9) ============ */}
      <MarketClockStrip marketOpen={board?.marketOpen} />

      {/* ============ v21.0.3 LOCAL LLM (OLLAMA) MODEL STRIP ============
          User request: "konsa local ollama model use ho raha hai ye dono
          tabs me accurately show hona chahiye" — pehle ye strip sirf
          COLLAPSED chat panel ke andar thi (2 interactions deep). Ab
          desk-top par hamesha visible: chip par SCAN + DEEP model
          (QWEN3·8B ↗R1·14B), hover par vision/ctx/installed models,
          30s auto-refresh + RECHECK. */}
      <div className="quantum-panel rounded-2xl py-1.5">
        <EngineHealthStrip />
        {/* v21.1.0 (Phase-3): operational health — feed ages / kills /
            exec heartbeat / data-dirs, /api/health se 30s poll. */}
        <OpsHealthStrip />
      </div>

      {/* ============ v6.12 PRO SESSION GATE ============ */}
      {board?.sessionPhase && (
        <div className={`mt-1.5 mb-1.5 rounded-lg border px-3 py-1.5 flex items-center gap-2 flex-wrap ${board.sessionPhase.tradeable
          ? 'bg-emerald-500/10 border-emerald-500/25'
          : 'bg-amber-500/10 border-amber-500/30'}`}
          aria-label="session phase gate">
          <span className={`text-[10px] font-black tracking-wider ${board.sessionPhase.tradeable ? 'text-emerald-300' : 'text-amber-300'}`}>
            {board.sessionPhase.tradeable ? '🟢 SESSION' : '⏰ SESSION GATE'}
          </span>
          <span className="text-[10px] font-mono text-slate-300">{board.sessionPhase.phase}</span>
          <span className="text-[10px] text-slate-400">· {board.sessionPhase.note}</span>
          {!board.sessionPhase.tradeable && (
            <span className="text-[9px] font-black text-amber-300/90">— abhi fresh intraday entries grade-cap ho rahe hain (WATCH tak)</span>
          )}
        </div>
      )}

      {/* ============ STICKY QUICK NAV (v6.9; v6.13 simple-mode filter) ============ */}
      <QuickNav items={simple ? NAV_SIMPLE : NAV} />

      {/* ============ 📊 DESK STATS (v6.10 one-glance) ============ */}
      <DeskStatsStrip board={board} deskLabel="🇮🇳 INDIA DESK SNAPSHOT" />

      {/* toast */}
      {toast && (
        <div className={`quantum-panel rounded-xl px-4 py-2.5 text-xs font-bold border ${toast.ok ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300'}`}
          role="status" aria-live="polite">
          {toast.text}
        </div>
      )}

      {/* ============ 00 · NSE AUTO-TRADE AGENT (v10.3 · CoinDCX parity) ============
          The India desk's autonomous agent — auto entry (75+ AI score,
          quorum-aware) · 3 trades/day · T1/T2/runner PRO exits · NSE
          clock (09:30–15:00 entries, 15:15 EOD square-off) · trend-flip
          + time-exit · paper-first (LIVE needs typed arming). */}
      <div id="in-agent">
        <SectionLabel num="00" title="India Auto-Trade Agent" sub="NSE autonomous desk — auto entry/exit · daily 3 trades · capital-based sizing · T1 40%+BE / T2 40% / runner trail · 15:15 EOD square-off — sab gauntlet-gated (Dhan)" />
        <div className="mt-2.5">
          <IndiaAgentPanel />
        </div>
      </div>

      {/* ============ 00b · ASK AI — PRO TRADER MCP AGENT (v10.3 wiring fix) ============
          CoinDCX parity: the desk ka conversational agent (8 live tools —
          signals / deep scan / quotes / regime / track-record / paper
          positions / news / sizing). Backend (/api/intraday-agent) pehle
          se mounted tha — sirf naye desk me panel wire nahi hua tha. */}
      <div id="in-chat">
        <SectionLabel num="00b" title="Ask AI — Pro Trader Agent" sub="intraday desk ka conversational agent — buy/sell reasoning, tools se live data (signals · deep scan · quotes · regime · track-record · positions · news · sizing)" />
        <div className="mt-2.5">
          <ProTraderAgentPanel />
        </div>
      </div>

      {/* ============ MARKET BREADTH ============ */}
      <BreadthStrip board={board} />

      {/* ============ India how-to-trade guide ============ */}
      <IndiaHowToTrade />

      {/* ============ 01 · MTF DUAL-TIMEFRAME SIGNAL BOARD (v21.22.0 — 9-Point Superintelligence Upgrade) ============ */}
      <div id="in-signals">
        <div className="flex items-end justify-between flex-wrap gap-2 mb-2.5">
          <SectionLabel num="01" title="MTF Dual-Timeframe Signal Board" sub={`NSE equities + indices + GOLD/SILVER (XAU/XAG) + EQUITY SIM → 2-Timeframe Modes (15m Deep + 5m Action · 1h Deep + 15m Action) · 8 Institutional + 10 World Top Indicators (Ledger-Calibrated Win-Rate) · 24×7 6s Direct Prices · 3-Model Local Ollama AI · Single LIVE Auto-Trade (100% CoinDCX Wallet + <₹10k→10x / ≥₹10k→5x Leverage) · Full CoinDCX Active Position Control & Active-Trade-Only Deep Monitor (TP1/TP2 Trailing SL + Reversal Profit Book)`} />
          <div className="flex items-center gap-2">
            <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono flex items-center gap-1
              ${stream.connected ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10'}`}
              title={stream.connected ? 'Intraday SSE stream connected — quotes ~5s cadence (NSE hours).' : 'Intraday stream disconnected — auto-retry chal raha hai; board snapshot values use ho rahe hain.'}>
              <span className={`w-1.5 h-1.5 rounded-full ${stream.connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400 animate-pulse'}`} />
              {stream.connected
                ? `NSE STREAM · ${stream.lastQuoteAt ? `${Math.max(0, Math.round((Date.now() - stream.lastQuoteAt) / 1000))}s ago` : 'waiting'}`
                : 'NSE stream down — retrying'}
            </span>
            <FreshnessBadge board={board} />
          </div>
        </div>
        <div id="in-mtf-dual">
          <MTFDualBoardPanel
            market="INDIA"
            canLive={canLiveIndia}
            walletINR={state?.config?.indiaMaxOrderINR ?? null}
            onPaperOpened={() => { void refresh(); }}
            onExecuteLive={(row, lev) => {
              setToast({ ok: true, text: `⚡ Live order placed: ${row.symbol} ${row.side} (${lev}x · 100% Wallet · Full Position Control)` });
              void refresh();
            }}
            onDeep={(sym) => onDeepExpert(sym)}
          />
        </div>
      </div>

      {/* ============ 01r · 15s SIGNAL RECHECK (v20.7.5) ============ */}
      <div id="in-recheck" className="mt-4">
        <SignalRecheckPanel />
      </div>

      {/* ============ 01a · GLOBAL MARKET COUNCIL (v11.0) ============ */}
      <div>
        <SectionLabel num="01a" title="Global Market Council" sub="6 specialist AI seats (India: Technical · Macro · Sentiment · Options-Flow · Risk) · calibrated consensus · precision gate · 10-agent MCP mesh" />
        <div className="mt-2.5 space-y-3">
          <CouncilVerdictPanel board={board} />
          <NearMissPanel />
        </div>
      </div>

      {/* ============ 01b · MORNING BRIEF (PRO) ============ */}
      {!simple && (
        <div id="in-brief">
          <SectionLabel num="01b" title="Morning Brief" sub="ek nazar me poora desk — market · top signals · open book · guards · ledger · next-actions" />
          <div className="mt-2.5">
            <MorningBriefPanel />
          </div>
        </div>
      )}

      {/* ============ 01c · SECTOR MAP + CONTEXT CHAIN + F-SCORE (v6.11 · PRO) ============ */}
      {!simple && (
        <div id="in-sectors">
          <SectionLabel num="01c" title="Sector Map + Context Chain" sub="macro→sector→symbol top-down lens · 45 stocks 10 sectors me · F-Score trend-quality board (Piotroski-style)" />
          <div className="mt-2.5">
            <SectorMapPanel />
          </div>
        </div>
      )}

      {/* ============ 02 · OPTIONS DESK ============ */}
      <div id="in-options">
        <SectionLabel num="02" title="Options Desk" sub="NSE indices — live chain / BS model · PCR · max pain · GEX + gamma flip · strategies with POP" />
        <div className="mt-2.5">
          {/* v21.0.3: onPaperOpened — option paper trade khulte hi
              toast + paperRefresh bump (panel instant refresh, 15s
              poll nahi). v21.0.3 root-cause ke saath: expiry ab ISO
              normalize hota hai, trade reject nahi hota. */}
          <OptionsDeskPanel onPaperOpened={(msg, ok) => {
            notify(ok, msg);
            if (ok) setPaperRefresh(k => k + 1);
          }} />
        </div>
      </div>

      {/* ============ 02b · SWING DESK (India · PRO) ============ */}
      {!simple && (
        <div id="in-swing">
          <SectionLabel num="02b" title="Swing Desk" sub="multi-day India setups (analysis only) — 3–8 din horizon · 1.8×ATR stop · 2R/3R targets" />
          <div className="mt-2.5">
            <SwingDeskPanel market="INDIA" />
          </div>
        </div>
      )}

      {/* ============ 03 · EXECUTION CONSOLE (India venue) ============ */}
      <div id="in-execute">
        <SectionLabel num="03" title="Execution Console" sub="India positions + Dhan gauntlet — STRONG signals only · trailing SL · 15:15 square-off · audited" />
        <div className="mt-2.5">
          <OrderConsole
            state={state} positions={positions} entries={entries} busy={busy} venue="INDIA" positionsLive={positionsLive}
            onClose={onClose} onSaveConfig={onSaveConfig}
            onPositionsChanged={refreshPositions}
            dhan={dhan} onDhanConnect={onDhanConnectStable}
            onDhanDisconnect={onDhanDisconnectStable}
            onDhanRefresh={refreshDhan}
          />
        </div>
      </div>

      {/* ============ 04 · BACKTEST LAB (India · PRO) ============ */}
      {!simple && (
        <div id="in-backtest">
          <SectionLabel num="04" title="Backtest Lab" sub={`the SAME ${models.length || 16}-model ensemble replayed on India history — win rate · avg R · equity curve · learned gates`} />
          <div className="mt-2.5">
            <BacktestPanel market="INDIA" runBacktest={runBacktest} runStrategyLab={runStrategyLab} />
          </div>
          {/* v20.2 GATE REPLAY — the intraday gates (MTF ladder · chase ·
              OB/OS · conf ladder) ka 5m-bar replay: tuning ab data se. */}
          <div className="mt-2.5">
            <GateReplayPanel symbols={(board?.signals || []).map(s => s?.symbol).filter(Boolean)} />
          </div>
          {/* v10.6 Pro Upgrade #5: the walk-forward dashboard — per-model
              30/90d win-rates + calibration chart + regime tilt state. */}
          <div className="mt-2.5">
            <ModelPerformancePanel desk="INDIA" />
          </div>
          {/* v21.1.0 (Phase-4): strategy health + GO-LIVE gate — rolling
              30-trade kill rule + paper-readiness counters. */}
          <div className="mt-2.5">
            <StrategyHealthPanel />
          </div>
          {/* v11.6 MCP mesh ops — 10 data agents' health, free-tier budgets
              and the mesh-backed ensemble seats (shadow/voting state). */}
          <div className="mt-2.5">
            <MeshStatusPanel />
          </div>
        </div>
      )}

      {/* ============ 05 · ALERTS & AI KEYS (PRO) ============ */}
      {!simple && (
        <div id="in-alerts">
          <SectionLabel num="05" title="Alerts & AI Keys" sub="Telegram pings on STRONG signals · AI Council keys — app se hi, Render env ki zaroorat nahi" />
          <div className="mt-2.5">
            <AlertsPanel fetchAlertsStatus={fetchAlertsStatus} saveAlertsConfig={saveAlertsConfig} testAlert={testAlert} busy={busy} notify={notify} />
          </div>
        </div>
      )}

      {/* ============ 06 · MODEL REGISTRY (PRO) ============ */}
      {!simple && (
        <div id="in-models">
          <SectionLabel num="06" title="Model Registry" sub="the superintelligence bus — every analyst, weight & status" />
          <div className="mt-2.5">
            <ModelRegistry models={models} />
          </div>
        </div>
      )}

      {/* ============ 07 · SIGNAL LEDGER (PRO) ============ */}
      {!simple && (
        <div id="in-ledger">
          <SectionLabel num="07" title="Signal Ledger" sub="SHA-256 hash chain — har executed signal provable, koi edit possible nahi (dono desks)" />
          <div className="mt-2.5">
            <SignalLedgerPanel />
          </div>
        </div>
      )}

      {/* ============ 07b · TRUST LAYER + PERFORMANCE (v6.11 · PRO) ============ */}
      {!simple && (
        <div id="in-trust">
          <SectionLabel num="07b" title="Trust Layer + Performance Lab" sub="engine ki confidence kitni sahi hai — calibration · Brier · monthly trend · model p-values · MDD/Sharpe/Sortino" />
          <div className="mt-2.5 grid gap-3 lg:grid-cols-2">
            <TrustLayerPanel />
            <PerfAnalyticsPanel />
          </div>
        </div>
      )}

      {/* ============ 08 · PAPER DESK & AI JOURNAL (v9.1 · PRO) ============
          The orphaned v4 intraday tree, merged into the live desk:
          server-managed virtual trades (T1 50% book → breakeven trail →
          SL/T2/EOD auto-exit) + signal track record + AI-reviewed journal
          + committee debate. Board cards open positions via 📈 DESK PAPER.
          v21.0.3: PaperTradePanel ab SIMPLE view me bhi dikhta hai —
          "option paper trade kholo aur kahi dikhe nahi" ka fix (options
          cards 02 me hain, paper positions yahan — dono hamesha saath
          dikhenge). Journal/TrackRecord/Committee PRO-only rehte hain. */}
      <div id="in-paper-desk">
        <div className="flex items-end justify-between gap-2 flex-wrap">
          <SectionLabel num="08" title="Paper Desk & AI Journal" sub="virtual trade simulator (server-managed T1/trail/SL/EOD) · signal track record · AI-reviewed trade journal · committee debate" />
          <button onClick={() => setUniverseOpen(true)}
            title="Universe edit karo — v20.2 se ye SIGNAL BOARD pe bhi apply hota hai (remove kiya hua symbol board se gayab, custom symbol Tier-1 scan me aata hai) + committee/briefing/track-record scans isi se chalte hain (server-side persisted)"
            className="quantum-btn-ghost px-2.5 py-1.5 rounded-lg text-[10px] font-black shrink-0">
            ⚙ UNIVERSE
          </button>
        </div>
        <div className="mt-2.5 space-y-3">
          {/* v21.23.13 [DESK-SCOPED]: desk="INDIA" — crypto tab ke MTF board
              PAPER clicks (market FUTURES/CRYPTO rows) ab Intraday tab me
              DIKHITE NAHI, sirf CoinDcxTab ke Paper Desk me dikhenge. */}
          <PaperTradePanel desk="INDIA" livePrices={stream.livePrices} refreshKey={paperRefresh} onOpenSymbolsChange={handlePaperSymbols} />
          {!simple && (
            <>
              <TrackRecordPanel refreshKey={paperRefresh + trackTick} />
              <JournalPanel desk="INDIA" refreshKey={paperRefresh + trackTick} />
              <CommitteePanel />
            </>
          )}
        </div>
      </div>

      {/* ============ v6.13: SIMPLE-mode me PRO sections ka pointer ============ */}
      {simple && (
        <ProSectionsNote names="Brief · Sector Map · Swing · Backtest · Alerts · Models · Ledger · Trust · Track Record · Journal" />
      )}

      {/* ============ DEEP ANALYSIS MODAL ============ */}
      {deep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Deep analysis"
          onClick={() => { deepReq.current++; setDeep(null); }}>
          <div className="quantum-panel rounded-2xl p-5 max-w-2xl w-full max-h-[85vh] overflow-y-auto animate-scale-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-black text-orange-300 tracking-wide">🔬 DEEP ENSEMBLE ANALYSIS</h3>
                {/* v20.7.5: freshness chips + 15s self-recheck (the
                    "galat/purana info" superintel fix). */}
                {!deep.loading && deep.signal && (
                  <DeepFreshnessChip recheckedAt={deep.recheckedAt} nextRecheckAt={deepAuto.nextRecheckAt} rechecks={deepAuto.rechecks} />
                )}
              </div>
              <button onClick={() => { deepReq.current++; setDeep(null); }} className="quantum-btn-ghost px-2.5 py-1 rounded-lg text-xs font-black" aria-label="Close">✕</button>
            </div>
            {deep.loading && (
              <div className="py-8 text-center">
                {/* v20.7.9: the PINNED card renders IMMEDIATELY while the
                    live re-verification computes — plus its LIVE LTP overlay
                    (the old modal showed a frozen snapshot price). */}
                {deep.pinned ? (
                  <>
                    <SignalCard signal={deep.pinned} onExecuteIndia={onExecuteIndia} canLiveIndia={canLiveIndia} busy={busy}
                      orderBudgetINR={state?.config?.maxOrderINR}
                      indiaBudgetINR={state?.config?.indiaMaxOrderINR ?? 5000}
                      liveLtp={liveFor(deep.pinned.symbol)?.price ?? null}
                      liveSrc={liveFor(deep.pinned.symbol)?.src ?? null} />
                    <div className="mt-3 flex items-center justify-center gap-2 text-[10px] font-black text-cyan-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                      LIVE RE-VERIFICATION chal raha hai — fresh {models.length || 16}-model ensemble {deep.pinned.symbol} par abhi compute ho raha hai…
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-4xl mb-3 animate-float">🧠</div>
                    <div className="text-xs text-slate-400">Running a fresh {models.length || 16}-model ensemble on {deep.signal?.symbol ?? 'the symbol'}…</div>
                  </>
                )}
              </div>
            )}
            {!deep.loading && deep.error && !deep.pinned && (
              <div className="py-8 text-center text-xs text-red-400 font-bold">⛔ {deep.error}</div>
            )}
            {/* v20.7.9: failed live re-run + pinned card → the original
                signal still renders (click context survives) + honest strip. */}
            {!deep.loading && deep.error && deep.pinned && (
              <>
                <SignalCard signal={deep.pinned} onExecuteIndia={onExecuteIndia} canLiveIndia={canLiveIndia} busy={busy}
                  orderBudgetINR={state?.config?.maxOrderINR}
                  indiaBudgetINR={state?.config?.indiaMaxOrderINR ?? 5000}
                  liveLtp={liveFor(deep.pinned.symbol)?.price ?? null}
                  liveSrc={liveFor(deep.pinned.symbol)?.src ?? null} />
                <div className="mt-2 py-2 text-center text-[10px] text-amber-400 font-bold">⚠ Live re-verification abhi unavailable ({deep.error}) — upar wahi BOARD CARD hai jise aapne click kiya tha</div>
              </>
            )}
            {!deep.loading && deep.signal && (
              <>
                {/* v20.7.9: PRIMARY card = the PINNED board signal; the live
                    re-run lives in DeepPinnedCompare below. The modal card
                    now also gets the LIVE LTP + source pill (A2 fix — frozen
                    snapshot price in the deep modal).
                    v20.7.12 [H3-3]: DRIFTED pe ticket LIVE plan pe shift,
                    FLIPPED/UNKNOWN pe execute band (detail upar). */}
                {deepCardSig && (
                  <SignalCard signal={deepCardSig} onExecuteIndia={deepCardCanExec ? onExecuteIndia : undefined} onDeep={onDeep} canLiveIndia={canLiveIndia} busy={busy}
                    orderBudgetINR={state?.config?.maxOrderINR} riskCapPct={board?.riskCap ?? state?.config?.maxRiskPct ?? 5}
                    indiaBudgetINR={state?.config?.indiaMaxOrderINR ?? 5000}
                    onPaperTrade={deepCardCanExec ? onDeskPaper : undefined} paperOpenForSymbol={paperOpenSymbols.has(deepCardSig.symbol)}
                    liveLtp={deepCardTick?.price ?? null}
                    liveSrc={deepCardTick?.src ?? null} />
                )}
                {deepPinV?.verdict === 'DRIFTED' && (
                  <div className="mt-2 py-2 text-center text-[10px] text-amber-400 font-bold">⚠ Board card DRIFT tha — trade ticket abhi ke LIVE plan pe shift ho gaya hai (upar wahi card, fresh entry/SL/targets)</div>
                )}
                {deepPinV?.verdict === 'FLIPPED' && (
                  <div className="mt-2 py-2 text-center text-[10px] text-red-400 font-bold">⛔ LIVE re-run ne side ULAAT di hai — trade button band hai. Fresh signal board se kholo (upar compare table me side dikhta hai)</div>
                )}
                {deepPinV?.verdict === 'UNKNOWN' && (
                  <div className="mt-2 py-2 text-center text-[10px] text-slate-400 font-bold">❔ Live re-run ka verdict pending — trade button tab tak band hai jab tak CONFIRM/DRIFT/FLIP na aaye</div>
                )}
                {deep.pinned && deep.signal && (
                  <DeepPinnedCompare pinned={deep.pinned} pinnedAt={deep.pinnedAt} live={deep.signal} recheckedAt={deep.recheckedAt} />
                )}
                {/* v20.9.3 FIX (M): ultrafast checklist from the LIVE deep payload
                    (India desk usually PENDING — honest N/A render, no dead space). */}
                {deep.signal?.ultrafast && <div className="mt-2"><UltrafastChecklist v={deep.signal.ultrafast} /></div>}
                <MtfBlock ltf={deep.ltf} quality={(deep.pinned ?? deep.signal).quality} />
                {/* v21.15.0: MTF TRADE PLAN — 15m deep + 5m action (user spec),
                    1h deep + 15m action, aur 15-20 min exit ke liye 5m→1m.
                    TF-FIT verdict batata hai kaunsa hold window is TF par
                    realistic hai (honest, measured calibration). */}
                <TradePlanPanel
                  symbol={(deep.pinned ?? deep.signal).symbol}
                  market={deep.signal.market}
                  side={(() => { const sd = (deep.pinned ?? deep.signal).side; return sd === 'LONG' || sd === 'SHORT' ? sd : null; })()}
                  ltp={liveFor(deep.signal.symbol)?.price ?? deep.signal.ltp ?? null}
                  capital={state?.config?.indiaMaxOrderINR ?? null}
                  riskPctPerTrade={board?.riskCap ?? state?.config?.maxRiskPct ?? 1}
                />
                {/* v20.2: deep modal ka apna price chart — plan levels ke
                    saath candles (SignalCard ka lazy toggle yahan default
                    open hai — deep analysis me chart FIRST-CLASS hai). */}
                <div className="mt-3">
                  <CandleChart symbol={deep.signal.symbol} market={deep.signal.market} ltp={liveFor(deep.signal.symbol)?.price ?? deep.signal.ltp} plan={deep.signal.plan} defaultTf="15m" side={deep.signal.side} />
                </div>
                <EdgeBlock edge={deep.edge} />
                {/* v20.7.5: the 15s self-recheck's VISIBLE transition log. */}
                <DeepTransitionLog log={deepAuto.log} />
                {deep.narrative && (
                  <div className="mt-3 bg-cyan-500/[0.05] border border-cyan-500/15 rounded-xl p-3" aria-label="regime narrative">
                    <div className="text-[10px] font-black text-cyan-300 tracking-wider mb-1.5">📖 EXPLAIN TICKER — {deep.narrative.title}</div>
                    <ul className="space-y-1">
                      {(deep.narrative.story || []).slice(0, 6).map((s, i) => (
                        <li key={i} className="text-[10px] text-slate-300 leading-relaxed">• {s}</li>
                      ))}
                    </ul>
                    <div className="text-[10px] text-amber-300/90 mt-1.5 font-bold">⚠️ {deep.narrative.watch}</div>
                  </div>
                )}
                {/* v20.7.5: FULL indicator transparency grid — classic stack
                    + the v20.7.4 confluence stack (Fib GP · VP POC/VAH/VAL ·
                    patterns · S/D zones · price action · EMA100/200). */}
                <DeepIndicatorGrid ind={deep.indicators} />
              </>
            )}
          </div>
        </div>
      )}

      {/* ============ v9.1: SCANNER UNIVERSE EDITOR (Paper Desk ke saath) ============ */}
      {universeOpen && (
        <UniverseEditor market="INDIA" onClose={() => setUniverseOpen(false)} onChanged={() => setPaperRefresh(k => k + 1)} />
      )}
    </div>
  );
});
