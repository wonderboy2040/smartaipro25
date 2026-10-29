// ============================================================
// src/components/aitrading/MTFDualBoardPanel.tsx — v21.17.0
// ------------------------------------------------------------
// 🧠 MTF SIGNALS BOARD (DUAL-TIMEFRAME) — SUPERINTELLIGENCE-EDITION UI
//
// v21.17.0 CHANGES (user spec):
//   • UI ab Superintelligence Signal Board ke card-style language me —
//     quantum-panel cards grid (SignalCard jaisa 4-box trade-plan grid:
//     ENTRY · STOP · TARGETS · EXIT-BY), tier badge + score bar, P(win)
//     chip, drivers, TF-fit + cost chips.
//   • CRYPTO rows ab **USDT** pricing me (Binance chain) — header pe
//     "$ · USDT" chip, chhote mono me ₹ equivalent (fx cross-view).
//     India rows ₹ hi rehte hain.
//   • Naya 🧪 PAPER button har usable card pe — us row ke exact levels
//     par paper trade (server hi levels/qty decide karta hai, client
//     sirf symbol bhejta hai). Auto-link ke saath manual rail bhi.
//
// Fuse (server: mtfDualBoard.js): 30% context trend + 25% trigger action
// + 20% plan confidence + 15% 1d+4h bias + 10% board base, dual/triple
// alignment bonus, MISMATCH cap 70, counter-trend cap 74.
// ============================================================
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Power } from 'lucide-react';
import {
  fetchMtfDualBoard, fetchMtfAutoStatus, runMtfAutoTick,
  setMtfAutoEnabledApi, updateMtfAutoConfigApi, openMtfBoardLive, openMtfBoardPaper,
  type MtfDualBoardView, type MtfDualRow, type MtfAutoStatus, type TradePlanModeId,
} from './useAITrading';
import { useWalletPoll } from './useWalletPoll';
import type { MarketKind } from './types';

interface Props {
  market: MarketKind;
  /** Optional: deep analysis kholne ke liye (row ke 🔬 button).
   *  v21.26.3: the full row is passed too, so the DEEP modal can PIN the
   *  row's MAIN AI snapshot (same aiScore + tier as this card's headline)
   *  instead of opening a pin-less fresh run with a different number. */
  onDeep?: (symbol: string, market: MarketKind, row?: MtfDualRow) => void;
  /** Optional: paper trade khulne ke baad parent ko batao (toast/refresh). */
  onPaperOpened?: (symbol: string, market: MarketKind) => void;
  /** v21.18.0: Live Mode auto/manual execution + Wallet amount for <₹10k=10x / ≥₹10k=5x */
  canLive?: boolean;
  walletINR?: number | null;
  onExecuteLive?: (row: MtfDualRow, leverage: number) => void;
}

// v21.18.0 USER SPEC: sirf 2 dual-timeframe modes — 15m Deep + 5m Action, ya 1h Deep + 15m Action
const MODES: Array<{ id: TradePlanModeId; label: string; tf: string; hold: number }> = [
  { id: 'INTRADAY', label: '⚡ 15m Deep + 5m Action', tf: '15m deep · 5m action', hold: 45 },
  { id: 'SWING', label: '🕐 1h Deep + 15m Action', tf: '1h deep · 15m action', hold: 120 },
];

// v21.26.0 [AUTO-MODE PARITY]: the board MUST open on the mode the AUTO
// engine actually trades. Pehle default INTRADAY tha aur SWING auto engine
// ke saath first board fetch INTRADAY rows dikha deta tha (user-visible
// "LONG signal" vs executed SWING "SHORT" mismatch, WLD 2026-10-29).
// Last server-confirmed auto mode localStorage me persist hota hai, taaki
// first paint se hi wahi mode render ho (server hydration baad me confirm
// karta hai). Storage read failure = honest INTRADAY fallback.
const AUTO_MODE_STORE_KEY = 'mtf-auto-view-v1';
const readStoredAutoView = (): { mode: TradePlanModeId; holdMin: number; minScore: number } => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(AUTO_MODE_STORE_KEY) : null;
    const j = raw ? JSON.parse(raw) : null;
    const mode = MODES.some(x => x.id === j?.mode) ? (j.mode as TradePlanModeId) : 'INTRADAY';
    const hold = Number(j?.holdMin);
    const ms = Number(j?.minScore);
    return {
      mode,
      holdMin: hold > 0 ? hold : (MODES.find(x => x.id === mode)?.hold ?? 45),
      minScore: ms >= 65 && ms <= 95 ? ms : 75,
    };
  } catch {
    return { mode: 'INTRADAY', holdMin: 45, minScore: 75 };
  }
};
const STORED_AUTO_VIEW = readStoredAutoView();
const persistAutoView = (v: { mode?: TradePlanModeId; holdMin?: number | null; minScore?: number | null }) => {
  try {
    if (typeof window === 'undefined') return;
    const prev = readStoredAutoView();
    const mode = MODES.some(x => x.id === v.mode) ? (v.mode as TradePlanModeId) : prev.mode;
    window.localStorage.setItem(AUTO_MODE_STORE_KEY, JSON.stringify({
      mode,
      holdMin: Number(v.holdMin) > 0 ? Number(v.holdMin) : prev.holdMin,
      minScore: Number(v.minScore) >= 65 && Number(v.minScore) <= 95 ? Number(v.minScore) : prev.minScore,
    }));
  } catch { /* storage unavailable - mode still hydrates from /status */ }
};

const tierCls = (tier?: string) =>
  tier === 'ELITE' ? 'bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/40'
    : tier === 'STRONG' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
      : tier === 'ACTION' ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
        : tier === 'WATCH' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40'
          : 'bg-slate-500/15 text-slate-400 border border-slate-500/40';

// v21.26.3: the MAIN ensemble tier badge — identical vocabulary to the DEEP
// ENSEMBLE ring (85+ ELITE / 80+ STRONG / 65+ ACTION / else WATCH). A missing
// board signal renders neutral, never a fabricated tier.
const mainAiTierCls = (tier?: string | null) =>
  tier ? tierCls(tier) : 'bg-slate-600/20 text-slate-400 border border-slate-600/40';

const fitCls = (v?: string | null) =>
  v === 'GOOD' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
    : v === 'OK' ? 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10'
      : v === 'STRETCH' ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
        : 'text-red-300 border-red-500/40 bg-red-500/10';

// v21.17.0 DEEP AUDIT: jab `d` omit ho (price levels: entry/SL/T1/T2/ltp),
// server ke `pRoundLadder` ki adaptive precision (2..8dp) preserve karo —
// warna DOT ($1.09, SL 1.0949, T1 1.0851) ya WLD ($0.47, SL 0.4716) UI me
// `.toFixed(2)` se `1.09 · 1.09 · 1.09` me collapse ho jaate the!
const fmt = (v: unknown, d?: number) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  if (typeof d === 'number') return n.toFixed(d);
  const clean = Number(n.toFixed(8));
  const s = String(clean);
  const dot = s.indexOf('.');
  const actualDp = dot >= 0 ? s.length - dot - 1 : 0;
  const a = Math.abs(clean);
  const minDp = a === 0 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return clean.toFixed(Math.min(8, Math.max(minDp, actualDp)));
};
const fmtAge = (ms?: number | null) => {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const dirArrow = (d?: number | null) => (d == null ? '·' : d > 0 ? '▲' : d < 0 ? '▼' : '·');

export const MTFDualBoardPanel = memo(function MTFDualBoardPanel({ market, onDeep, onPaperOpened, canLive = false, walletINR = null, onExecuteLive }: Props) {
  const [mode, setMode] = useState<TradePlanModeId>(STORED_AUTO_VIEW.mode);
  const [holdMin, setHoldMin] = useState<number>(STORED_AUTO_VIEW.holdMin);
  const [minScore, setMinScore] = useState<number>(STORED_AUTO_VIEW.minScore);
  const [deskFilter, setDeskFilter] = useState<'ALL' | 'MAIN' | 'METALS' | 'EQUITY_SIM'>('ALL');
  const [board, setBoard] = useState<MtfDualBoardView | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  const [auto, setAuto] = useState<MtfAutoStatus | null>(null);
  const [autoFresh, setAutoFresh] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const [liveOrdering, setLiveOrdering] = useState<string | null>(null);
  const [paperOrdering, setPaperOrdering] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const reqRef = useRef(0);
  const boardInflightRef = useRef(false);
  const hydratedRef = useRef(false);
  const userTouchedRef = useRef(false);
  // v21.23.18 [STABLE LIVE]: status-poll ordering + single-flight. Pehle ek
  // slow/stale /status response naye toggle state ko overwrite kar sakta tha,
  // aur ek timeout turant button OFF kar deta tha.
  const autoReqRef = useRef(0);
  const autoInflightRef = useRef<Promise<MtfAutoStatus | null> | null>(null);
  const autoFailStreakRef = useRef(0);

  // debounced fetch inputs (typing/slider storm se bachne ke liye)
  const [debounced, setDebounced] = useState({ mode, holdMin, minScore, limit: 6 });
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced({ mode, holdMin, minScore, limit: 6 }), 350);
    return () => window.clearTimeout(t);
  }, [mode, holdMin, minScore]);

  const loadBoard = useCallback(async () => {
    if (boardInflightRef.current) return; // 2s poll: slow response kabhi request pile-up na kare
    boardInflightRef.current = true;
    const id = ++reqRef.current;
    setBoardBusy(true);
    try {
      const b = await fetchMtfDualBoard(market, debounced);
      if (reqRef.current === id) { if (b) setBoard(b); }
    } finally {
      boardInflightRef.current = false;
      if (reqRef.current === id) setBoardBusy(false);
    }
  }, [market, debounced]);

  const loadAuto = useCallback(async () => {
    // Single-flight: poll + button-click overlap me request pile-up nahi.
    // Sab awaiters ko wahi fresh response milta hai.
    if (autoInflightRef.current) return autoInflightRef.current;
    const run = (async (): Promise<MtfAutoStatus | null> => {
      const id = ++autoReqRef.current;
      const a = await fetchMtfAutoStatus();
      // A newer toggle/config mutation ne is response ko stale kar diya —
      // purana ON/OFF state naye authoritative state ko overwrite nahi karega.
      if (id !== autoReqRef.current) return a;
      if (a) {
        autoFailStreakRef.current = 0;
        setAuto(a);
        setAutoFresh(true);
        // Hydrate the editor from the server ONCE. Before this the panel always
        // showed INTRADAY/45/75 even when the saved config was SWING/30/80 —
        // pressing LIVE would then silently overwrite the saved values.
        if (!hydratedRef.current) {
          hydratedRef.current = true;
          if (!userTouchedRef.current) {
            if (a.mode && MODES.some(x => x.id === a.mode)) setMode(a.mode);
            if (Number(a.holdMin) > 0) setHoldMin(Number(a.holdMin));
            if (Number(a.minScore) >= 65 && Number(a.minScore) <= 95) setMinScore(Number(a.minScore));
          }
        }
        // v21.26.0 [AUTO-MODE PARITY]: server auto mode ko viewer mode ke
        // saath pinned rakho (user mid-click nahi hai to). Persist bhi karo
        // taaki next mount first paint se hi AUTO mode render kare.
        if (!userTouchedRef.current && a.mode && MODES.some(x => x.id === a.mode)) {
          setMode(a.mode);
          persistAutoView({ mode: a.mode, holdMin: a.holdMin, minScore: a.minScore });
        }
      } else {
        // v21.23.18 [LIVE STABILITY]: ek failed/timeout poll button ko OFF
        // nahi karta. 3 consecutive failures (~30s+) ke baad hi status stale
        // mark hota hai — aur stale hone par bhi LIVE armed state ON rehta hai
        // (sirf amber warning dikhti hai), kyunki server config authoritative
        // hai aur network wapas aate hi fresh status aa jaata hai.
        autoFailStreakRef.current += 1;
        if (autoFailStreakRef.current >= 3) setAutoFresh(false);
      }
      return a;
    })();
    autoInflightRef.current = run;
    try { return await run; } finally { autoInflightRef.current = null; }
  }, []);

  /** Mutation response ko authoritative maano — koi bhi older in-flight poll
   *  ise overwrite nahi kar sakta. Partial response (config fallback) ko last
   *  known status ke saath merge karte hain taaki LIVE badge/active panel
   *  momentarily empty na ho. */
  const applyAutoStatus = useCallback((s: MtfAutoStatus | null | undefined) => {
    if (!s) return;
    autoReqRef.current += 1;
    autoFailStreakRef.current = 0;
    setAuto(prev => {
      if (typeof (s as Partial<MtfAutoStatus>).enabled !== 'boolean' && prev) {
        return { ...prev, ...s, enabled: prev.enabled };
      }
      return s;
    });
    setAutoFresh(true);
    // v21.26.0: persist the server-confirmed auto mode for the next mount's
    // first paint (partial responses fall back to the previous stored view).
    persistAutoView({ mode: s.mode, holdMin: s.holdMin, minScore: s.minScore });
  }, []);

  useEffect(() => { void loadBoard(); }, [loadBoard]);
  useEffect(() => {
    void loadAuto();
    // v21.23.13 ULTRA-FAST REALTIME SL TRAIL & DIRECTION FOLLOW-THROUGH POLL:
    // Poll every 2 seconds when any trade is active so SL trailing & direction verification update in real time!
    // A7: idle poll 10s (was 5s) — status math (deep monitor + quotes) is
    // heavy and nothing changes between auto ticks; active trades stay 2s.
    const cadenceMs = (auto?.openCount ?? 0) > 0 || (auto?.deepMonitor?.activeCount ?? 0) > 0 ? 2_000 : 10_000;
    const t = window.setInterval(() => { if (!document.hidden) void loadAuto(); }, cadenceMs);
    return () => window.clearInterval(t);
  }, [loadAuto, auto?.openCount, auto?.deepMonitor?.activeCount]);
  useEffect(() => {
    // v21.23.13 ULTRA-FAST 24x7 DIRECT PRICE FETCHING: poll board every 2s
    const t = window.setInterval(() => { if (!document.hidden) void loadBoard(); }, 2_000);
    return () => window.clearInterval(t);
  }, [loadBoard]);

  const notify = useCallback((ok: boolean, msg: string) => {
    setNote(`${ok ? '✅' : '⛔'} ${msg}`);
    window.setTimeout(() => setNote(null), 7000);
  }, []);

  const pickMode = useCallback(async (m: TradePlanModeId) => {
    const h = MODES.find(x => x.id === m)?.hold ?? 45;
    const prevMode = mode;
    const prevHold = holdMin;
    userTouchedRef.current = true;
    setMode(m);
    setHoldMin(h);
    // v21.23.17 [HONEST CONFIG]: a failed save used to leave the UI showing a
    // mode the engine never accepted. Revert + show the real server reason.
    const res = await updateMtfAutoConfigApi({ mode: m, holdMin: h });
    if (res.ok) applyAutoStatus(res.status);
    else {
      setMode(prevMode);
      setHoldMin(prevHold);
      notify(false, `mode save fail — ${res.error}`);
    }
  }, [mode, holdMin, notify, applyAutoStatus]);

  const onToggle = useCallback(async (enabled: boolean) => {
    setBusy(true);
    const res = await setMtfAutoEnabledApi(enabled);
    setBusy(false);
    if (res.ok) {
      applyAutoStatus(res.status);
      notify(true, enabled ? 'MTF AUTO-LINK ARMED — 75+ confirmed Deep-Trend rows auto-execute honge' : 'MTF AUTO-LINK DISARMED — naye entries band');
    } else {
      notify(false, `toggle fail — ${res.error}`);
    }
  }, [notify, applyAutoStatus]);

  const { wallet: liveWallet } = useWalletPoll();
  const counts = board?.counts;
  const rows = useMemo(() => board?.rows || [], [board?.rows]);
  const metalsRows = useMemo(() => board?.metalsRows || [], [board?.metalsRows]);
  const equitySimRows = useMemo(() => board?.equitySimRows || [], [board?.equitySimRows]);
  const scanRows = useMemo(() => board?.scanRows || [], [board?.scanRows]);
  const displayedRows = useMemo(() => {
    if (deskFilter === 'METALS') return metalsRows;
    if (deskFilter === 'EQUITY_SIM') return equitySimRows;
    if (deskFilter === 'MAIN') return rows;
    // 'ALL': combine Top 6 + Gold/Silver (XAU/XAG) + Equity Sim (deduped by symbol)
    const seen = new Set<string>();
    const combined: MtfDualRow[] = [];
    for (const r of [...rows, ...metalsRows, ...equitySimRows]) {
      if (!r?.symbol || seen.has(r.symbol)) continue;
      seen.add(r.symbol);
      combined.push(r);
    }
    return combined;
  }, [deskFilter, rows, metalsRows, equitySimRows]);
  const armed = !!auto?.enabled;
  const paperArmed = Boolean(armed && auto?.executionMode === 'paper');
  const isUsdBoard = board?.quoteCcy === 'USDT' || board?.quoteCcy === 'USD';
  const ccyTag = board?.quoteCcy === 'USD' ? '$ · USD' : isUsdBoard ? '$ · USDT' : '₹ · INR';
  const liveFx = Number((liveWallet as unknown as { coindcxInrPerUsdt?: number })?.coindcxInrPerUsdt) > 40
    ? Number((liveWallet as unknown as { coindcxInrPerUsdt?: number })?.coindcxInrPerUsdt)
    : (Number(board?.fx) > 40 ? Number(board?.fx) : 102);
  const liveFutUsdt = Number(liveWallet?.deployableFuturesUSDT ?? (liveWallet?.futures?.usdt as { free?: number } | undefined)?.free ?? 0) || 0;
  const liveFutInr = Number(liveWallet?.deployableFuturesINR ?? (liveWallet?.futures?.inr as { free?: number } | undefined)?.free ?? 0) || 0;
  const liveFutWalletINR = Math.round(liveFutUsdt * liveFx + liveFutInr);
  const liveFutMarginCcy: 'INR' | 'USDT' = liveFutInr > 0 && liveFutInr >= liveFutUsdt * liveFx ? 'INR' : 'USDT';
  const effectiveWalletINR = liveFutWalletINR > 0
    ? liveFutWalletINR
    : (Number(walletINR) > 0
      ? Number(walletINR)
      : (Number(auto?.effectiveWalletINR) > 0
        ? Number(auto?.effectiveWalletINR)
        : Number(auto?.walletAmountINR) || 10000));
  const activeLeverage = auto?.riskCaps?.effectiveLeverage ?? auto?.activeLeverage
    ?? (effectiveWalletINR < 10000 ? (auto?.belowTenKLeverage ?? 10) : (auto?.aboveTenKLeverage ?? 5));
  const walletDeployPct = auto?.riskCaps?.effectiveWalletDeployPct ?? auto?.effectiveWalletDeployPct ?? auto?.walletDeployPct ?? 100;
  const deployed95WalletINR = Math.round(effectiveWalletINR * (walletDeployPct / 100));
  const buyingPower95INR = Math.round(deployed95WalletINR * activeLeverage);
  const liveEntriesPaused = auto?.liveEntryPaused === true;
  // v21.23.13 [HONEST LIVE BADGE]: pehle primary branch (executionMode ===
  // 'live') canLive ko BYPASS karta tha — CoinDCX creds missing hone par bhi
  // button 🟢 LIVE ON dikhta tha, engine har live attempt reject +
  // escalating backoff (5m→4h) khata rehta, user ko kabhi reason nahi
  // dikhta tha. Ab DONO branches canLive demand karti hain — button green
  // = LIVE truly armed AND executable (creds + site live dono confirm).
  // A3 [DESK-READY HONESTY]: green LIVE badge sirf tab jab server is DESK ke
  // liye ready:true bole (creds + live arming + executionMode). Pehle
  // executionMode='live' alone green kar deta tha jabki India arming alag
  // hoti hai — button ON par order reject hota rehta tha, reason invisible.
  const deskKey: 'india' | 'crypto' = market === 'INDIA' ? 'india' : 'crypto';
  const deskReadiness = auto?.deskReady?.[deskKey] || null;
  const deskArmable = auto?.deskArmable?.[deskKey] || null;
  // v21.26.2 [LIVE-READY RECONCILE]: the legacy CoinDCX desk state
  // (`/api/ai/trading/state.blocked.notConnected`) only looks at the saved
  // mcp-coindcx.json file, while this engine resolves the SAME keys from .env
  // (`loadCredsForOrder`) and persists them on the first live order. A missing
  // file therefore showed "LIVE execution is not enabled" even though the
  // server's own deskReady said ready:true. Server deskReady is the
  // execute-right-now authority for this desk; GLOBALFUTURES stays PAPER-only.
  const engineLiveReady = market !== 'GLOBALFUTURES'
    && auto?.executionMode === 'live'
    && deskReadiness?.ready === true;
  const liveExecEnabled = canLive || engineLiveReady;
  const canArmLive = liveExecEnabled && (!auto?.deskArmable || deskArmable?.armable === true);
  // v21.23.18 [STABLE LIVE + HONEST READINESS]:
  // Pehle isLiveAuto volatile `autoFresh` + `deskReadiness.ready` par depend
  // karta tha — ek slow /status poll ya India typed-LIVE arming missing hone
  // par button apne aap OFF dikhne lagta tha, jabki server engine still
  // enabled:true + executionMode:'live' tha. Ab server ka ARMED state
  // authoritative hai: button ON rahega, aur readiness/stale reason alag
  // amber warning ke roop me dikhega. User kabhi bhi click karke OFF kar
  // sakta hai (armed state me button disable nahi hota).
  const liveArmed = Boolean(armed && auto?.executionMode === 'live');
  const isLiveAuto = liveArmed;
  const liveStatusStale = Boolean(liveArmed && !autoFresh);
  const liveWarnWhy = isLiveAuto
    ? (liveStatusStale
        ? 'Status poll stale — LIVE engine last known ON; server/network wapas aate hi fresh status aa jayega'
        : !liveExecEnabled
          ? 'LIVE execution is not enabled for this desk/tab — engine live entries reject karega'
          : deskReadiness && deskReadiness.ready === false
            ? (deskReadiness.why || 'Desk not ready (server) — engine live entries reject karega')
            : null)
    : null;
  const liveBlockWhy = liveWarnWhy;
  const armBlockWhy = !isLiveAuto && deskArmable?.armable === false
    ? (deskArmable.why || 'LIVE prerequisites are not met')
    : null;
  // v21.26.0 AI SUPER AGENT: this desk's live tick agents (WS hot path) and
  // their states. Purely display — the server agent remains the single owner.
  const superAgentTrades = (auto?.superAgent?.trades || []).filter(t => (
    deskKey === 'india'
      ? String(t.market || '').toUpperCase() === 'INDIA'
      : String(t.market || '').toUpperCase() !== 'INDIA'
  ));
  const superAgentStates = [...new Set(superAgentTrades.map(t => t.state).filter(Boolean))];
  const superAgentTitle = auto?.superAgent
    ? [
        `Primary: ${auto.superAgent.primarySource || 'WebSocket tick'} · polling ${auto.superAgent.pollingMs ?? 0}ms · fallback watchdog ${auto.superAgent.fallbackMs ?? 1000}ms`,
        'TP2 hit → agent IDLE · confirmed reversal → minimal-loss close + immediate reverse entry',
        ...superAgentTrades.map(t => `${t.symbol} ${t.side || ''} ${t.state} · ${t.tickCount ?? 0} ticks · ${t.lastSource || 'waiting'} · handler ${t.lastHandlerMs ?? '—'}ms`),
      ].join('\n')
    : 'AI super agent status unavailable';
  const activeTradedRows = useMemo(
    () => (auto?.deepMonitor?.trades || []).filter(t => t.traded !== false),
    [auto?.deepMonitor?.trades],
  );
  // LIVE-only lock set: PAPER test rows deep monitor me dikhte rehte hain,
  // par 1-session-1-trade live lock / pre-flight count unhe count nahi karta.
  const activeLiveRows = useMemo(
    () => activeTradedRows.filter(t => String(t.executionMode || '').toUpperCase() === 'LIVE' || Boolean(t.livePositionId)),
    [activeTradedRows],
  );
  const liveDeskLabel = market === 'INDIA' ? 'DHAN' : 'COINDCX';

  // A7 [WHY NO TRADE]: aggregate the most frequent auto-pick blockers across
  // rows that cleared the score bar — the UI now shows WHY the engine is
  // idle instead of leaving the user to inspect each expanded card.
  const topNearMissBlockers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of [...rows, ...metalsRows, ...equitySimRows]) {
      if (Number(r.superScore) < minScore || !Array.isArray(r.autoBlockers)) continue;
      for (const b of r.autoBlockers) {
        if (!b) continue;
        counts.set(b, (counts.get(b) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([text, n]) => `${text} ×${n}`)
      .join(' · ');
  }, [rows, metalsRows, equitySimRows, minScore]);

  /** 🧪 PAPER TEST ORDER — opens a Paper Trade directly for this MTF Dual Board card and registers it in the Deep Monitor so the user can test and verify whether price genuinely follows the LONG/SHORT signal direction + 3s Auto SL Trail! */
  const onPaperOrder = useCallback(async (row: MtfDualRow) => {
    if (row.side !== 'LONG' && row.side !== 'SHORT') {
      notify(false, `${row.symbol}: directional signal (LONG/SHORT) required`);
      return;
    }
    // v21.25.0 DIRECTION CERTIFICATE: hard-block when signal→order is not clean.
    const cert = row.directionCertificate || null;
    if (cert && cert.ok !== true) {
      notify(false, `⛔ ${row.symbol}: direction certificate ${cert.verdict} — ${cert.reasons[0] || 'signal/order direction invalid'}`);
      return;
    }
    setPaperOrdering(row.symbol);
    const targetMkt = (row.assetClass === 'METALS' ? 'METALS' : row.assetClass === 'EQUITY_SIM' ? 'GLOBALFUTURES' : row.market === 'INDIA' ? 'INDIA' : market) as MarketKind;
    const r = await openMtfBoardPaper(row.symbol, targetMkt, mode, row.holdMin ?? holdMin);
    setPaperOrdering(null);
    if (r?.ok && r.trade) {
      notify(
        true,
        `🧪 PAPER DIRECTION TEST OPENED — ${row.symbol} ${row.side} · qty ${r.trade.qty} @ ${targetMkt === 'INDIA' ? '₹' : '$'}${fmt(r.trade.entry)} · SL ${fmt(r.trade.stopLoss)} · T1 ${fmt(r.trade.target1)} · T2 ${fmt(r.trade.target2)} (3s Realtime Direction Follow-Through & Auto SL Trail Active)`,
      );
      onPaperOpened?.(row.symbol, targetMkt);
      void loadAuto();
    } else {
      notify(false, `${row.symbol} PAPER test failed: ${r?.error || 'quote/plan unavailable'}`);
    }
  }, [market, mode, holdMin, notify, onPaperOpened, loadAuto]);

  /** 🧪 PAPER AUTO-TEST — runs AUTO Trade Intelligence in Paper Mode to test auto-picked signals & verify direction follow-through + 3s Auto SL Trail risk-free! */
  const onAutoPaperExecute = useCallback(async () => {
    setBusy(true);
    try {
      const cfgPatch: Record<string, unknown> = {
        executionMode: 'paper',
        // v21.23.14: PAPER TEST must be paper-only even when another desk is
        // live. Without this, autoSyncSiteLive:true (default) turned the
        // paper-test tick into REAL CoinDCX/India orders on a live site.
        autoSyncSiteLive: false,
        mode,
        holdMin,
        minScore,
        maxOpenPositions: 1,
        deepMonitorEnabled: true,
      };
      if (effectiveWalletINR > 0) cfgPatch.walletAmountINR = effectiveWalletINR;
      const resCfg = await updateMtfAutoConfigApi(cfgPatch);
      if (!resCfg.ok) {
        // v21.23.17 [HONEST PAPER ARM]: the old path armed the engine even
        // when the config POST failed, so the paper test could silently run
        // with stale mode/desk settings. Abort + show the REAL server reason.
        notify(false, `⛔ PAPER AUTO-TEST config save fail — ${resCfg.error}. Engine arm nahi hua; retry karo.`);
        return;
      }
      applyAutoStatus(resCfg.status);
      const resArm = await setMtfAutoEnabledApi(true);
      if (!resArm.ok) {
        notify(false, `⛔ PAPER AUTO-TEST arm fail — ${resArm.error}. Retry karo.`);
        return;
      }
      applyAutoStatus(resArm.status);
      const r = await runMtfAutoTick();
      const openedCount = r?.tick?.opened?.length ?? 0;
      if (openedCount > 0) {
        notify(true, `🧪 PAPER AUTO-TEST ON — opened 1 Verified ${r?.tick?.opened?.[0]?.side || ''} Paper Trade (${r?.tick?.opened?.[0]?.symbol || ''}) · 3s Realtime Direction Follow-Through & Auto SL Trail Active!`);
      } else {
        notify(true, `🧪 PAPER AUTO-TEST ARMED — Watching 24×7 for fresh early-trend Verified STRONG (PAKKA LONG/SHORT) signal (Post-Peak / Late-Trend entries blocked)`);
      }
      await loadAuto();
    } finally {
      setBusy(false);
    }
  }, [mode, holdMin, minScore, effectiveWalletINR, notify, loadAuto, applyAutoStatus]);

  /** ⚡ LIVE ORDER — places real CoinDCX Futures order directly for this MTF Dual Board card using .env keys (100% wallet + wallet-tier leverage). */
  const onLiveOrder = useCallback(async (row: MtfDualRow) => {
    if (liveEntriesPaused) {
      notify(false, '⏸ LIVE entries Phase 0 me PAUSED hain — pehle "RESUME ENTRIES" dabao. Existing positions ka SL management chalu hai.');
      return;
    }
    if (row.side !== 'LONG' && row.side !== 'SHORT') {
      notify(false, `${row.symbol}: directional signal (LONG/SHORT) required`);
      return;
    }
    // v21.25.0 DIRECTION CERTIFICATE: LIVE never fires on an invalid/ambiguous side.
    const cert = row.directionCertificate || null;
    if (cert && cert.ok !== true) {
      notify(false, `⛔ ${row.symbol}: LIVE blocked — direction certificate ${cert.verdict} (${cert.reasons[0] || 'signal/order direction invalid'})`);
      return;
    }
    if (row.trapVeto || row.zoneWallVeto || row.reversalRisk || row.trigger?.opposingFlow || row.trigger?.postPeakTrap) {
      notify(false, `🛑 ${row.symbol}: Post-Peak Exhaustion / Reversal / Liquidity Trap Risk active — late entry blocked to prevent SL hit!`);
      return;
    }
    if (activeLiveRows.length >= 1) {
      notify(
        false,
        `🔒 1 Session = 1 Trade Lock: ${activeLiveRows[0]?.symbol} (${activeLiveRows[0]?.side}) abhi LIVE active hai — ye trade complete hone ke baad hi next trade lagega! (PAPER test rows live lock nahi khaate)`,
      );
      return;
    }
    setLiveOrdering(row.symbol);
    const targetMkt = (row.assetClass === 'METALS' ? 'METALS' : row.assetClass === 'EQUITY_SIM' ? 'GLOBALFUTURES' : row.market === 'INDIA' ? 'INDIA' : market) as MarketKind;
    const r = await openMtfBoardLive(row.symbol, targetMkt, row.side, mode, row.holdMin ?? holdMin, activeLeverage);
    setLiveOrdering(null);
    if (r?.ok) {
      const f = r.filled;
      notify(
        true,
        `⚡ LIVE ORDER PLACED — ${row.symbol} ${row.side} · ${f?.leverage ?? activeLeverage}x · ${walletDeployPct}% Wallet (₹${deployed95WalletINR.toLocaleString('en-IN')}) · qty ${f?.qty ?? '—'} @ ${targetMkt === 'INDIA' ? '₹' : '$'}${fmt(f?.price ?? row.plan?.entry)} · SL ${fmt(f?.stopLoss ?? row.plan?.stopLoss)} · T1 ${fmt(f?.t1 ?? row.plan?.t1)} · T2 ${fmt(f?.t2 ?? row.plan?.t2)} (Full Position Control Armed)`,
      );
      onExecuteLive?.(row, activeLeverage);
      onPaperOpened?.(row.symbol, targetMkt);
      void loadAuto();
    } else {
      notify(false, `${row.symbol} LIVE order failed: ${r?.error || r?.reason || 'check CoinDCX/Dhan wallet/margin'}`);
    }
  }, [market, mode, holdMin, activeLeverage, walletDeployPct, deployed95WalletINR, activeLiveRows, liveEntriesPaused, notify, onExecuteLive, onPaperOpened, loadAuto]);

  /** ⚡ SINGLE LIVE BUTTON — turns ON Auto-Trade Intelligence, fetches CoinDCX Wallet, deploys 100% of it on strictly 1 Verified Strong Trade per session, and takes Full Control! */
  const onAutoLiveExecute = useCallback(async () => {
    if (!liveExecEnabled) {
      notify(false, '⛔ LIVE execution is not enabled for this desk/tab — arm it in the desk console first.');
      return;
    }
    const status = auto ?? await loadAuto();
    if (status?.liveEntryPaused) {
      notify(false, `⏸ LIVE entries Phase 0 me PAUSED hain — pehle "RESUME ENTRIES" dabao. Existing positions ka SL management chalu hai.`);
      return;
    }
    const arm = status?.deskArmable?.[deskKey];
    if (status?.deskArmable && arm?.armable === false) {
      notify(false, `⛔ LIVE arm blocked — ${arm.why || 'LIVE prerequisites are not met'}`);
      return;
    }
    setBusy(true);
    try {
      const cfgPatch: Record<string, unknown> = {
        executionMode: 'live',
        mode,
        holdMin,
        minScore,
        walletDeployPct: 100,
        maxOpenPositions: 2,
        maxTradesPerDay: 0,
        // v21.26.1 USER SPEC: daily trade quota UNLIMITED (0 sentinel) -
        // the 1-session / 1-open-trade lock still applies; only the daily
        // count cap is removed.
        // User spec v21.25: FULL 100% CoinDCX wallet deployment. Leverage is
        // wallet-tier driven — below ₹10,000 → 10x, ₹10,000+ → 5x. The 10x
        // ceiling only lets the tier rule decide; it never over-leverages a
        // ₹10k+ wallet (tier leverage stays 5x and wins the min()).
        riskPerTradePct: 1,
        maxRiskPerTradePct: 2,
        maxLeverage: 10,
        maxWalletDeployPct: 100,
        dailyLossPct: 1.5,
        deepMonitorEnabled: true,
      };
      if (effectiveWalletINR > 0) cfgPatch.walletAmountINR = effectiveWalletINR;
      const resCfg = await updateMtfAutoConfigApi(cfgPatch);
      // v21.23.13 [HONEST ARM — LIVE]: /config ya /toggle fail par bhi code
      // aage badh ke engine PURANE mode (paper) me arm ho sakta tha — user
      // LIVE samajh baithta tha. Ab har step fail par HONEST abort + reason.
      if (!resCfg.ok) {
        notify(false, `⛔ AUTO-LIVE config save fail — ${resCfg.error}. LIVE mode arm nahi hua. Retry karo.`);
        setBusy(false); return;
      }
      applyAutoStatus(resCfg.status);
      const resArm = await setMtfAutoEnabledApi(true);
      if (!resArm.ok) {
        notify(false, `⛔ AUTO-LINK arm fail — ${resArm.error}. LIVE ON nahi hua. Retry karo.`);
        setBusy(false); return;
      }
      const stArm = resArm.status;
      applyAutoStatus(stArm);
      // v21.23.13 [CREDS PRE-FLIGHT]: creds missing = engine har live attempt
      // instantly reject + per-symbol escalating backoff (5m→4h) khayega —
      // din bhar ka silent no-op ('button ON par trade nahi lagta' ka seedha
      // vector). Button green dikhana jhootha hota — honest abort + clear
      // next-step (keys Execution Console / Settings me connect karo).
      // v21.23.16: only the crypto desk depends on CoinDCX creds. India LIVE
      // uses Dhan and is gated by the separate typed-LIVE arming; the old
      // unconditional check blocked a correctly armed India panel whenever
      // CoinDCX keys were absent.
      if (deskKey === 'crypto' && stArm?.coindcxConnected === false) {
        notify(false, '⛔ CoinDCX API keys CONNECTED NAHI hain — LIVE auto-trade order execute nahi hoga. Pehle CoinDCX API keys connect karo, phir ⚡ LIVE dabao. (Engine armed hai par live entry creds ke bina reject hogi.)');
        await loadAuto();
        setBusy(false); return;
      }

      // Strictly 1 trade per session: if an active LIVE position is already
      // open, do NOT place a 2nd trade! PAPER test rows live lock nahi khaate.
      const preActiveCount = (stArm?.deepMonitor?.trades || activeLiveRows || [])
        .filter(t => t.traded !== false)
        .filter(t => String(t.executionMode || '').toUpperCase() === 'LIVE' || Boolean(t.livePositionId))
        .length;
      if (preActiveCount > 0) {
        notify(
          true,
          `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — 1 Active Session Trade under Full Deep Monitor Control (${walletDeployPct}% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} @ ${activeLeverage}x · Next trade after current trade finishes)`,
        );
        await loadAuto();
        return;
      }

      const r = await runMtfAutoTick();
      const openedCount = r?.tick?.opened?.length ?? 0;
      const tickInFlight = Boolean((r?.tick as { inFlight?: boolean } | undefined)?.inFlight);
      if (openedCount > 0) {
        notify(true, `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — opened 1 Verified Strong live trade (${walletDeployPct}% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} · ${activeLeverage}x leverage · ${liveFutMarginCcy} margin · 1 Session = 1 Trade Lock Active)`);
        await loadAuto();
        setBusy(false);
        return;
      }
      // Re-check status after tick: if 1 LIVE trade is active (or tick was already in-flight), never stack a 2nd order!
      const freshStatus = await loadAuto();
      const alreadyActiveCount = (freshStatus?.deepMonitor?.trades || stArm?.deepMonitor?.trades || [])
        .filter(t => t.traded !== false)
        .filter(t => String(t.executionMode || '').toUpperCase() === 'LIVE' || Boolean(t.livePositionId))
        .length;
      if (alreadyActiveCount > 0 || tickInFlight) {
        notify(true, `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — ${alreadyActiveCount || 1} Active Position under Full Deep Monitor Control (${walletDeployPct}% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} @ ${activeLeverage}x · Dynamic SL Trail + Reversal Profit Book)`);
        return;
      }
      // A5 [NO CLIENT-SIDE FALLBACK ENTRY]: pehle yahan UI board rows se apna
      // verified pool banata tha aur seedha live order bhej deta tha
      // — auto engine ke gates (cooldown / day quota / backoff / desk scope /
      // fresh quote) bypass ho jaate the. Ab sirf engine hi order karta hai;
      // UI arm karke honest "watching" state dikhata hai.
      notify(
        true,
        `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — Watching 24×7 for engine-verified STRONG (PAKKA LONG/SHORT) Signal · 1 Session = 1 Full-Wallet Trade (₹${deployed95WalletINR.toLocaleString('en-IN')} @ ${activeLeverage}x) · client-side fallback entry disabled`,
      );
      await loadAuto();
    } finally {
      setBusy(false);
    }
  }, [mode, holdMin, minScore, activeLeverage, walletDeployPct, effectiveWalletINR, deployed95WalletINR, liveFutMarginCcy, activeLiveRows, auto, liveExecEnabled, deskKey, notify, loadAuto, applyAutoStatus]);

  /** v21.24.0 PHASE 0 — live entries pause/resume. Pause is instant; resume
   *  needs explicit confirmation because it re-arms real-money entries. */
  const onToggleLivePause = useCallback(async () => {
    const nextPaused = !liveEntriesPaused;
    if (!nextPaused) {
      const ok = typeof window === 'undefined' || window.confirm(
        'LIVE auto entries RESUME karein? Existing positions alag se managed rehte hain; naye ELITE/STRONG signals real orders lenge (100% wallet deploy; leverage wallet-tier: below ₹10,000 → 10x, ₹10,000+ → 5x; 1% risk/trade).',
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await updateMtfAutoConfigApi({ liveEntryPaused: nextPaused });
      if (res.ok) {
        applyAutoStatus(res.status);
        notify(true, nextPaused
          ? '⏸ LIVE ENTRIES PAUSED — naye live/UC-flip orders band; existing position ka deep monitor + SL sync chalu.'
          : '▶ LIVE ENTRIES RESUMED — Phase 0 risk caps active hain.');
      } else {
        notify(false, `pause toggle fail — ${res.error}`);
      }
    } finally {
      setBusy(false);
    }
  }, [liveEntriesPaused, notify, applyAutoStatus]);

  const statusLine = useMemo(() => {
    if (!auto) return 'status loading…';
    // v21.23.13 [IDLE-REASON TRANSPARENCY]: 'auto trade lag nahi raha'
    // complaint ka aadha root-cause tha INVISIBILITY — engine ticks ke skip
    // reasons (1-session lock / quota / backoff / no eligible row) sirf
    // AUTO EVENTS drawer me the. Ab last tick ke top skip reasons status
    // line me hi dikhte hain — user ko turant dikhe engine KYA idle hai.
    const skipWhy = Array.isArray(auto.lastTick?.skipped) && auto.lastTick.skipped.length > 0
      ? ` · ⏳ last-tick skip: ${auto.lastTick.skipped.slice(0, 2).join(' | ')}`
      : '';
    // v21.23.18: readiness/stale ab ⚠ warning hai — button ko OFF nahi karti.
    const warnWhy = liveWarnWhy ? ` · ⚠ ${liveWarnWhy}` : '';
    const credsWarn = auto.executionMode === 'live' && auto.coindcxConnected === false
      ? ' · ⚠ CoinDCX keys NOT connected — live order reject hoga'
      : '';
    const nearMiss = activeLiveRows.length === 0 && topNearMissBlockers
      ? ` · 🚧 top blockers: ${topNearMissBlockers}`
      : '';
    const paperCount = Math.max(0, activeTradedRows.length - activeLiveRows.length);
    const paperTag = paperCount > 0 ? ` · 🧪 Paper: ${paperCount} (live lock nahi)` : '';
    const staleTag = liveStatusStale ? ' · STATUS STALE' : '';
    const tierDiag = ` · 🎯 ELITE/STRONG ${counts?.strong ?? 0} · trigger-fired ${counts?.fired ?? 0}`;
    const quotaUsed = Number.isFinite(Number(auto.dayQuotaCount)) ? Number(auto.dayQuotaCount) : auto.dayCount;
    const quotaLimitLabel = (auto.quotaUnlimited === true || Number(auto.maxTradesPerDay) === 0)
      ? 'unlimited'
      : String(auto.maxTradesPerDay);
    const runTag = liveEntriesPaused
      ? '⏸ LIVE ENTRIES PAUSED (existing positions managed)'
      : isLiveAuto
        ? `🟢 LIVE AUTO-TRADE INTELLIGENCE ON${staleTag}`
        : paperArmed
          ? '🧪 AUTO-TRADE PAPER ON — REAL ORDERS OFF'
          : '⏸ AUTO-TRADE STANDBY';
    return `${runTag} · ${walletDeployPct}% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} / ₹${Math.round(effectiveWalletINR).toLocaleString('en-IN')} @ ${activeLeverage}x (Buying Power ₹${buyingPower95INR.toLocaleString('en-IN')}) · Active LIVE: ${activeLiveRows.length}${paperTag} · day ${auto.day ?? '—'} · trades ${quotaUsed}/${quotaLimitLabel}${tierDiag}${warnWhy}${credsWarn}${nearMiss}${skipWhy}`;
  }, [auto, isLiveAuto, paperArmed, liveEntriesPaused, liveStatusStale, liveWarnWhy, topNearMissBlockers, activeLeverage, walletDeployPct, effectiveWalletINR, deployed95WalletINR, buyingPower95INR, activeTradedRows.length, activeLiveRows.length, counts]);

  return (
    <div className="mt-3" aria-label="mtf dual timeframe signals board">
      {/* ================= header strip (desk-board parity) ================= */}
      <div className="quantum-panel rounded-2xl p-3 bg-gradient-to-br from-violet-500/[0.06] via-transparent to-cyan-500/[0.05] border border-violet-500/20">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] font-black text-violet-200 tracking-wider">🧠 MTF SIGNALS BOARD <span className="text-slate-500">(DUAL-TIMEFRAME · PURE 8 INSTITUTIONAL TOP INDICATORS · PAKKA LONG/SHORT LOCK · 3-MODEL OLLAMA AI)</span></span>
            <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-black border font-mono ${isUsdBoard ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10'}`}
              title="24×7 Direct Ultra-Fast Market Price Fetching">
              {ccyTag}{isUsdBoard && board?.fx ? ` · ₹${fmt(board.fx, 1)}/USDT` : ''} · ⚡ 24×7 DIRECT LIVE
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black border border-emerald-500/45 bg-emerald-500/15 text-emerald-200" title="8 Institutional Top Indicators Integrated: 1. SMC (BOS/CHoCH/OB) · 2. Liquidity Sweep/Trap · 3. Volume Profile (POC/VAH/VAL) · 4. Fair Value Gap (FVG) · 5. ICT (OTE/MSS) · 6. EMA Ribbon · 7. Supply & Demand Zones · 8. Price Action — P(win) ledger-calibrated hota hai (n ≥ 20), warna heuristic estimate">
              🏆 PURE 8 INSTITUTIONAL CONFLUENCE{board?.worldIndicatorsInfo?.avgWinRatePct != null ? ` · ${board.worldIndicatorsInfo.avgWinRatePct}% AVG P(WIN)` : ' · P(WIN) LEDGER-CALIBRATING'}
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black border border-teal-500/45 bg-teal-500/15 text-teal-200" title="1. SMC · 2. Liquidity Sweep/Trap · 3. Volume Profile · 4. Fair Value Gap · 5. ICT · 6. EMA · 7. Supply & Demand · 8. Price Action">
              🎯 SMC · LIQ-SWEEP · VOL-PROFILE · FVG · ICT · EMA · SUPPLY/DEMAND · PRICE-ACTION
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200" title="Super Score Tiers: ELITE 85+ · STRONG 80+ · ACTION 65+">
              SUPER SCORE: ELITE 85+ · STRONG 80+ · ACTION 65+
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black border border-amber-500/45 bg-amber-500/15 text-amber-200" title="Top 6 Deep-Trend (LONG ya SHORT) + Gold/Silver (XAU/XAG Perps) + Equity Sim">
              🔥 TOP 6 DEEP-TREND + 🪙 XAU/XAG + 🌎 EQUITY SIM
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black border border-violet-500/45 bg-violet-500/15 text-violet-200" title="Optimized for 3 Local Ollama AI Models (Fast Scan + Deep Reasoner + Risk/Vision Sentinel)">
              🤖 3-MODEL OLLAMA TURBO: {(board?.ollamaTrio?.models || ['qwen3:8b', 'deepseek-r1:14b', 'qwen2.5vl:7b']).join(' + ')}
            </span>
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black border border-cyan-500/40 bg-cyan-500/10 text-cyan-200" title="Full 100% CoinDCX Wallet Auto-Deployment + wallet-tier leverage (below ₹10,000 → 10x, ₹10,000+ → 5x)">
              ⚡ {walletDeployPct}% WALLET ₹{deployed95WalletINR.toLocaleString('en-IN')} / ₹{Math.round(effectiveWalletINR).toLocaleString('en-IN')}{liveFutWalletINR > 0 ? ` (${liveFutMarginCcy})` : ''} → {activeLeverage}x LEV
            </span>
            {counts && (
              <span className="text-[9px] font-black font-mono text-slate-400" title="rows · 75+ over bar · auto-eligible · STRONG/ELITE · trigger fired">
                {counts.rows} rows · <span className="text-emerald-300">{counts.overBar}≥75</span> · <span className="text-cyan-300">{counts.eligible} auto-ready</span> · <span className="text-amber-300">{counts.strong} ELITE/STRONG</span> · <span className="text-rose-300">{counts.fired} fired</span> · <span className="text-amber-300">🪙 {metalsRows.length} XAU/XAG</span> · <span className="text-sky-300">🌎 {equitySimRows.length} Equity Sim</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => void loadBoard()} className="p-1 rounded border border-slate-500/30 hover:border-violet-500/50" title="24×7 Direct Board Refresh">
              <RefreshCw size={11} className={boardBusy ? 'animate-spin text-violet-300' : 'text-slate-400'} />
            </button>
          </div>
        </div>

        {/* mode + asset desk filter + thresholds */}
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {MODES.map(m => (
            <button key={m.id} onClick={() => pickMode(m.id)} title={`${m.tf} · default hold ${m.hold}m`}
              className={`px-2 py-0.5 rounded text-[10px] font-black border ${mode === m.id ? 'border-violet-400/60 text-violet-200 bg-violet-500/10' : 'border-slate-500/30 text-slate-400 hover:border-slate-400/50'}`}>
              {m.label}
            </button>
          ))}
          {/* v21.26.0 [AUTO-MODE PARITY]: jo mode AUTO engine trade karega,
              wahi explicitly dikhta hai; viewed-mode mismatch par loud warning
              (WLD 2026-10-29: user INTRADAY LONG card dekh raha tha jabki
              auto SWING SHORT le raha tha). */}
          <span
            data-testid="mtf-auto-mode-badge"
            className={`px-2 py-0.5 rounded text-[10px] font-black border ${auto?.mode && auto.mode !== mode ? 'border-rose-500/60 text-rose-200 bg-rose-500/15' : 'border-emerald-500/50 text-emerald-200 bg-emerald-500/10'}`}
            title="AUTO TRADE engine isi mode ke rows pick karta hai (server config authoritative)">
            🤖 AUTO MODE: {auto?.mode ?? mode}
          </span>
          {auto?.mode && auto.mode !== mode && (
            <span data-testid="mtf-auto-mode-mismatch" className="px-2 py-0.5 rounded text-[10px] font-black border border-rose-500/70 text-rose-100 bg-rose-500/25">
              ⚠ Board {mode} dikha raha hai par AUTO engine {auto.mode} pe chal raha hai — auto entry {auto.mode} rows se hogi
            </span>
          )}
          <span className="text-slate-600 mx-0.5">|</span>
          <button
            type="button"
            onClick={() => setDeskFilter('ALL')}
            className={`px-2 py-0.5 rounded text-[10px] font-black border ${deskFilter === 'ALL' ? 'border-emerald-400/60 text-emerald-200 bg-emerald-500/15' : 'border-slate-600/40 text-slate-400 hover:border-slate-400/50'}`}>
            🔥 ALL ({rows.length + metalsRows.length + equitySimRows.length})
          </button>
          <button
            type="button"
            onClick={() => setDeskFilter('MAIN')}
            className={`px-2 py-0.5 rounded text-[10px] font-black border ${deskFilter === 'MAIN' ? 'border-cyan-400/60 text-cyan-200 bg-cyan-500/15' : 'border-slate-600/40 text-slate-400 hover:border-slate-400/50'}`}>
            ⚡ TOP 6 {market === 'INDIA' ? 'NSE' : 'CRYPTO'} ({rows.length})
          </button>
          <button
            type="button"
            onClick={() => setDeskFilter('METALS')}
            className={`px-2 py-0.5 rounded text-[10px] font-black border ${deskFilter === 'METALS' ? 'border-amber-400/70 text-amber-200 bg-amber-500/20' : 'border-amber-500/30 text-amber-300/80 hover:border-amber-400/60'}`}>
            🪙 GOLD & SILVER · XAU/XAG PERPS ({metalsRows.length})
          </button>
          <button
            type="button"
            onClick={() => setDeskFilter('EQUITY_SIM')}
            className={`px-2 py-0.5 rounded text-[10px] font-black border ${deskFilter === 'EQUITY_SIM' ? 'border-sky-400/70 text-sky-200 bg-sky-500/20' : 'border-sky-500/30 text-sky-300/80 hover:border-sky-400/60'}`}>
            🌎 EQUITY SIM ({equitySimRows.length})
          </button>
          <span className="text-[9px] text-slate-500 ml-1">HOLD</span>
          <input type="number" min={5} max={600} value={holdMin} onChange={e => setHoldMin(Math.max(5, Math.min(600, Number(e.target.value) || 45)))}
            className="w-14 bg-slate-900/60 border border-slate-500/30 rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-200" title="Hold window (minutes) — TF-fit verdict isi par banta hai" />
          <span className="text-[9px] text-slate-500">SCORE BAR</span>
          <input type="range" min={65} max={90} step={5} value={minScore} onChange={e => setMinScore(Number(e.target.value))}
            className="w-24 accent-violet-400" title="Board ka 75+ bar" />
          <span className={`text-[10px] font-black font-mono ${minScore >= 75 ? 'text-emerald-300' : 'text-amber-300'}`}>{minScore}+</span>
        </div>

        {note && <div className="mt-1.5 text-[10px] font-bold text-slate-300">{note}</div>}
      </div>

      {/* ================= v21.25.0 DIRECTION CERTIFICATE INTEGRITY STRIP ================= */}
      {board?.directionIntegrity && (
        <div
          data-testid="mtf-direction-integrity"
          className={`mt-2 rounded-xl border px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap text-[9px] font-mono ${
            board.directionIntegrity.ok
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-red-500/50 bg-red-500/10'
          }`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-black tracking-wider ${board.directionIntegrity.ok ? 'text-emerald-300' : 'text-red-300'}`}>
              🧭 DIRECTION CERTIFICATE
            </span>
            <span className="text-slate-200">{board.directionIntegrity.label}</span>
            <span className="px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 font-black">
              LONG → BUY
            </span>
            <span className="px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200 font-black">
              SHORT → SELL
            </span>
            {board.directionIntegrity.pakka > 0 && (
              <span className="px-1.5 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 font-black">
                🔒 PAKKA {board.directionIntegrity.pakka}
              </span>
            )}
            {(board.directionIntegrity.mismatches > 0 || (counts?.directionBlocked ?? 0) > 0) && (
              <span className="px-1.5 py-0.5 rounded border border-red-500/50 bg-red-500/15 text-red-200 font-black">
                ⛔ {board.directionIntegrity.mismatches} mismatch · {counts?.directionBlocked ?? board.directionIntegrity.blocked} blocked
              </span>
            )}
          </div>
          <span className="text-[8px] text-slate-400">
            Har row ka signal side ↔ exchange order side certificate server se verified · invalid side = entry BLOCKED
          </span>
        </div>
      )}

      {/* ================= SINGLE ONE-CLICK LIVE AUTO-TRADE INTELLIGENCE BAR (User Spec #1, #2, #3, #5) ================= */}
      <div className={`mt-2 border rounded-xl px-3 py-2.5 transition-all ${isLiveAuto ? 'border-emerald-500/50 bg-gradient-to-r from-emerald-950/40 via-emerald-900/20 to-cyan-950/30 shadow-lg shadow-emerald-950/30' : 'border-slate-500/30 bg-slate-900/40'}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap text-[11px] font-black tracking-wide">
              <span className={liveEntriesPaused ? 'text-amber-300' : isLiveAuto ? 'text-emerald-300' : 'text-slate-200'}>
                {liveEntriesPaused
                  ? '⏸ AUTO-TRADE INTELLIGENCE — LIVE ENTRIES PAUSED (SL MANAGEMENT ON)'
                  : isLiveAuto ? '🟢 AUTO-TRADE INTELLIGENCE — LIVE ON (24×7 REALTIME)' : paperArmed ? '🧪 AUTO-TRADE INTELLIGENCE — PAPER ON (LIVE OFF)' : '⚡ AUTO-TRADE SUPER INTELLIGENCE (ONE-CLICK LIVE)'}
              </span>
              <span className="px-2 py-0.5 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-[9px] font-mono text-cyan-200">
                💰 {walletDeployPct}% CoinDCX Wallet: ₹{deployed95WalletINR.toLocaleString('en-IN')} × {activeLeverage}x = ₹{buyingPower95INR.toLocaleString('en-IN')} Buying Power
              </span>
              <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-[9px] font-mono text-emerald-200">
                🔒 Full CoinDCX Active Position Control · Sirf Active Traded Positions · TP1/TP2 + SL Trail + Reversal Profit-Book
              </span>
              {auto?.superAgent?.running && (
                <span
                  data-testid="mtf-super-agent-badge"
                  className={`px-2 py-0.5 rounded-md border text-[9px] font-mono ${
                    superAgentTrades.length > 0
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                      : 'bg-slate-500/10 border-slate-500/30 text-slate-300'
                  }`}
                  title={superAgentTitle}
                >
                  🤖 AI SUPER AGENT · {superAgentTrades.length > 0
                    ? `${superAgentTrades.length} × ${superAgentStates.join(' / ')}`
                    : 'READY · WS TICK 0ms'}
                </span>
              )}
            </div>
            <div className="mt-1 text-[9px] font-mono text-slate-400">
              {statusLine}
            </div>
            {auto?.directionIntegrity && (
              <div
                data-testid="mtf-auto-direction-integrity"
                className={`mt-1 inline-flex items-center gap-2 flex-wrap text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                  auto.directionIntegrity.ok
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                    : 'border-red-500/45 bg-red-500/10 text-red-200'
                }`}
                title={auto.directionIntegrity.issues.map(i => `${i.symbol || '?'}: ${i.verdict} ${i.reasons[0] || ''}`).join(' · ') || 'Auto book + deep monitor direction certificate clean'}
              >
                <span className="font-black">🧭 AUTO BOOK + DEEP MONITOR</span>
                <span>{auto.directionIntegrity.label}</span>
                {(auto.directionBlockedCount ?? auto.directionIntegrity.blocked) > 0 && (
                  <span className="font-black text-red-200">⛔ {auto.directionBlockedCount ?? auto.directionIntegrity.blocked} blocked</span>
                )}
              </div>
            )}
            {(liveWarnWhy || (!isLiveAuto && armBlockWhy)) && (
              <div className="mt-1 text-[9px] font-bold text-amber-300" data-testid="mtf-live-warning">
                ⚠ {liveWarnWhy || armBlockWhy}
              </div>
            )}
            {paperArmed && (
              <div className="mt-1 text-[9px] font-bold text-cyan-300" data-testid="mtf-paper-mode-warning">
                🧪 PAPER MODE ARMED — engine sirf paper trades karega, real CoinDCX orders OFF hain. Real auto-trade ke liye ⚡ LIVE dabao (wallet + CoinDCX keys ready).
              </div>
            )}
            {auto?.riskCaps && (
              <div
                data-testid="mtf-phase0-strip"
                className="mt-1.5 flex items-center gap-2 flex-wrap text-[9px] font-mono text-slate-300"
              >
                <span className="px-1.5 py-0.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-200 font-black">
                  🛡 LIVE RISK · {auto.riskCaps.activeRiskPct || '—'}% risk/trade (hard {auto.riskCaps.maxRiskPerTradePct}%) · {auto.riskCaps.effectiveWalletDeployPct}% deploy · {auto.riskCaps.effectiveLeverage}x wallet-tier · daily loss stop {auto.riskCaps.dailyLossPct || '—'}% · max {auto.maxOpenPositions ?? '-'} open / {(auto.quotaUnlimited || Number(auto.maxTradesPerDay) === 0) ? 'unlimited' : `${auto.maxTradesPerDay}/day`}
                </span>
                {auto.phase0 && (
                  <span className={`px-1.5 py-0.5 rounded border font-black ${auto.phase0.verdict === 'OK' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}>
                    AUDIT {auto.phase0.verdict} · open {auto.phase0.unresolved.operationalOpen} · excess stop {auto.phase0.stopIntegrity.excessStopR}R · dup {auto.phase0.duplicates.groups} · manual {auto.phase0.manualExits.total} · qty mismatch {auto.phase0.reconciliation.qtyMismatches}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* USER SPEC #5 + PAPER TESTING: "LIVE" Button + "🧪 PAPER TEST" Button for Direction Follow-Through Verification */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              type="button"
              data-testid="mtf-paper-test-auto-btn"
              disabled={busy}
              onClick={() => void onAutoPaperExecute()}
              className={`px-3 py-2 rounded-xl text-xs font-black tracking-wider border transition-all flex items-center gap-1.5 shadow-md ${
                armed && auto?.executionMode === 'paper'
                  ? 'border-cyan-400 bg-cyan-500/25 text-cyan-100 hover:bg-cyan-500/35 shadow-cyan-500/20'
                  : 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
              } disabled:opacity-50`}
              title="Paper Auto-Test Mode: Auto-Trade Intelligence ko Paper Mode me test karo — check karo ki jo LONG/SHORT signal mila hai vo pakka direction follow kar raha hai + 3s Ultra-Fast Auto SL Trail kaam kar raha hai">
              🧪 {armed && auto?.executionMode === 'paper' ? 'PAPER AUTO ON' : 'PAPER TEST'}
            </button>
            {armed && (
              <button
                type="button"
                data-testid="mtf-live-pause-btn"
                disabled={busy}
                onClick={() => void onToggleLivePause()}
                className={`px-3 py-2 rounded-xl text-xs font-black tracking-wider border transition-all flex items-center gap-1.5 shadow-md ${
                  liveEntriesPaused
                    ? 'border-amber-400 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
                    : 'border-slate-400/60 bg-slate-700/40 text-slate-200 hover:bg-slate-700/60'
                } disabled:opacity-50`}
                title={liveEntriesPaused
                  ? 'Resume LIVE entries (100% wallet + wallet-tier leverage active). Existing position management is unaffected.'
                  : 'Pause NEW live entries only. Existing positions continue deep monitor + SL sync.'}
              >
                {liveEntriesPaused ? '▶ RESUME ENTRIES' : '⏸ PAUSE ENTRIES'}
              </button>
            )}
            <button
              type="button"
              data-testid="mtf-single-live-auto-btn"
              disabled={busy || (!armed && auto != null && autoFresh && !canArmLive)}
              onClick={() => {
                if (isLiveAuto) {
                  void onToggle(false);
                } else {
                  void onAutoLiveExecute();
                }
              }}
              className={`px-4 py-2 rounded-xl text-xs font-black tracking-wider border transition-all flex items-center gap-2 shadow-md ${
                isLiveAuto
                  ? 'border-emerald-400 bg-emerald-500/25 text-emerald-100 hover:bg-emerald-500/35 shadow-emerald-500/20'
                  : 'border-amber-400/80 bg-gradient-to-r from-amber-500/30 to-rose-500/30 text-amber-100 hover:from-amber-500/45 hover:to-rose-500/45 shadow-amber-500/15'
              } disabled:opacity-50`}
              title={isLiveAuto
                ? `LIVE auto-trade armed${liveEntriesPaused ? ' — entries PAUSED (existing positions still managed)' : ''} — engine-verified STRONG signal par ${walletDeployPct}% wallet + ${activeLeverage}x leverage order, TP1/TP2 Deep Monitor + Trailing SL active${liveStatusStale ? ' · ⚠ status poll stale hai, engine last known ON' : ''}${deskReadiness && deskReadiness.ready === false ? ` · ⚠ ${deskReadiness.why || 'desk not ready'}` : ''}`
                : armBlockWhy
                  ? `LIVE arm blocked: ${armBlockWhy}`
                  : liveBlockWhy
                    ? `LIVE blocked: ${liveBlockWhy}`
                    : `Click karne par Auto Trade Intelligence ON hoga — CoinDCX Wallet fetch karke ${walletDeployPct}% wallet + ${activeLeverage}x wallet-tier leverage ke saath trade lagega, Active Positions ko Full Control pe lega aur TP1/TP2 tak Deep Monitor + Trailing SL + Reversal Profit Book chalega`}>
              <Power size={13} className={isLiveAuto ? 'text-emerald-300 animate-pulse' : 'text-amber-300'} />
              {busy
                ? '⏳ ACTIVATING LIVE AI…'
                : liveEntriesPaused
                  ? '⏸ ENTRIES PAUSED'
                  : isLiveAuto
                    ? `🟢 LIVE ON (${activeLeverage}x · ${walletDeployPct}% WALLET)`
                    : `⚡ LIVE`}
            </button>
          </div>
        </div>

        {/* ================= DEDICATED ACTIVE-TRADE DEEP MONITOR PANEL (Sirf Active Traded Positions) ================= */}
        {activeTradedRows.length > 0 && (
          <div className="mt-2.5 pt-2.5 border-t border-emerald-500/30">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
              <div className="flex items-center gap-2 flex-wrap text-[10px] font-black text-emerald-300">
                <span>🔬 ACTIVE AUTO-TRADE DEEP MONITOR — REALTIME TP1 / TP2 & REVERSAL PROFIT GUARD · FULL {liveDeskLabel} POSITION CONTROL (SIRF ACTIVE TRADES)</span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[9px]">
                  {activeTradedRows.length} Active Traded · {auto?.deepMonitor?.trailingActiveCount ?? 0} SL Trailed · {auto?.deepMonitor?.tp1LockedCount ?? 0} TP1 Hit
                </span>
                {auto?.deepMonitor?.directionIntegrity && (
                  <span
                    data-testid="mtf-deep-direction-integrity"
                    className={`px-1.5 py-0.5 rounded border text-[9px] font-mono ${
                      auto.deepMonitor.directionIntegrity.ok
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                        : 'bg-red-500/20 border-red-500/50 text-red-200'
                    }`}
                    title={auto.deepMonitor.directionIntegrity.issues.map(i => `${i.symbol || '?'}: ${i.verdict} ${i.reasons[0] || ''}`).join(' · ') || 'All active trades certified'}
                  >
                    🧭 {auto.deepMonitor.directionIntegrity.valid}/{auto.deepMonitor.directionIntegrity.total} certified
                    {(auto.deepMonitor.directionBlockedCount ?? auto.deepMonitor.directionIntegrity.blocked) > 0
                      ? ` · ⛔ ${auto.deepMonitor.directionBlockedCount ?? auto.deepMonitor.directionIntegrity.blocked} blocked`
                      : ' · LONG→BUY / SHORT→SELL ✓'}
                  </span>
                )}
              </div>
              <span className="text-[9px] font-mono text-slate-400">
                ⚡ 3s Ultra-Fast Auto SL Trail + Live Direction Follow-Through Verification
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {activeTradedRows.map((t, i) => {
                const isLong = t.side === 'LONG'; // v21.23.12: `!== 'SHORT'` unknown/undefined side ko green LONG styling de deta tha — honest strict check
                const ccySym = t.ccy === 'INR' ? '₹' : '$';
                const isPaperRow = String(t.executionMode || '').toUpperCase() === 'PAPER';
                const isIndiaRow = String(t.market || t.execMarket || '').toUpperCase() === 'INDIA';
                return (
                  <div key={`${t.symbol}-${i}`} className="rounded-xl bg-black/45 border border-emerald-500/35 p-2.5 text-[10px] font-mono">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-black text-white">{t.symbol}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${isPaperRow ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/50' : 'bg-amber-500/25 text-amber-200 border border-amber-400/50'}`}>
                          {isPaperRow ? '🧪 PAPER TEST' : isIndiaRow ? '⚡ LIVE DHAN' : '⚡ LIVE COINDCX'}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${isLong ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                          {t.side} · {t.leverage || activeLeverage}x · {t.walletDeployPct || walletDeployPct}% Wallet
                        </span>
                        {t.orderSide && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black font-mono bg-cyan-500/15 text-cyan-200 border border-cyan-500/40"
                            title="Direction certificate: signal side → actual exchange order side">
                            🧭 {t.side} → {t.orderSide.toUpperCase()}
                          </span>
                        )}
                        {t.directionBlocked && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-red-500/30 text-red-100 border border-red-400/70"
                            title={t.directionCertificate?.reasons.join(' · ') || 'direction certificate blocked this trade — no SL trail / no profit-book action'}>
                            ⛔ DIRECTION BLOCKED{t.directionCertificate?.verdict ? ` · ${t.directionCertificate.verdict}` : ''}
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-emerald-500/15 text-emerald-200 border border-emerald-500/35">
                          🔒 FULL CONTROL
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-cyan-500/15 text-cyan-300 border border-cyan-500/35">
                          {t.stageLabel}
                        </span>
                      </div>
                      <span className={`font-black ${t.currentR >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {t.currentR >= 0 ? '+' : ''}{t.currentR}R (Peak +{t.peakR}R)
                      </span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-5 gap-1.5 text-[9px]">
                      <div className="bg-slate-900/70 rounded px-1.5 py-1">
                        <div className="text-slate-500">ENTRY</div>
                        <div className="font-bold text-slate-200">{ccySym}{fmt(t.entry)}</div>
                      </div>
                      <div className="bg-slate-900/70 rounded px-1.5 py-1">
                        <div className="text-slate-500">LIVE LTP</div>
                        <div className="font-bold text-white">{ccySym}{fmt(t.ltp)}</div>
                      </div>
                      <div className="bg-slate-900/70 rounded px-1.5 py-1">
                        <div className="text-amber-400/80">AUTO-TRAIL SL</div>
                        <div className="font-bold text-amber-300">{ccySym}{fmt(t.trailedStopLoss)}</div>
                      </div>
                      <div className="bg-slate-900/70 rounded px-1.5 py-1">
                        <div className="text-emerald-400/80">TP1 {t.tp1Hit ? '✅' : ''}</div>
                        <div className="font-bold text-emerald-300">{ccySym}{fmt(t.t1)}</div>
                      </div>
                      <div className="bg-slate-900/70 rounded px-1.5 py-1">
                        <div className="text-cyan-400/80">TP2 {t.tp2Hit ? '🏆' : ''}</div>
                        <div className="font-bold text-cyan-300">{ccySym}{fmt(t.t2)}</div>
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap text-[9px] text-emerald-300/90">
                      <span className={t.directionFollowing !== false ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>
                        {t.followThroughVerdict || t.trendStatus}
                      </span>
                      <span>
                        Initial SL: {ccySym}{fmt(t.initialStopLoss)} → Auto-SL: <b className="text-amber-300">{ccySym}{fmt(t.trailedStopLoss)}</b> · Fee-BE: {ccySym}{fmt(t.feeBreakevenPrice)} {t.feeCovered ? '✅ Profit Safe' : '⏳ Guarded'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ================= PHASE 3.3: 30-DAY MTF DIRECTION SCORECARD STRIP ================= */}
      {board?.directionScorecard && (
        <div data-testid="mtf-direction-scorecard" className="mt-2 rounded-xl border border-cyan-500/30 bg-slate-950/80 px-3 py-1.5 flex items-center justify-between flex-wrap gap-2 text-[9px] font-mono">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-black text-cyan-300 uppercase">📊 MTF Direction Scorecard ({board.directionScorecard.windowDays}d):</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700/70 text-slate-200">
              Scans: <b>{board.directionScorecard.totalScans}</b> ({board.directionScorecard.resolvedCount} resolved · {board.directionScorecard.pendingCount} live)
            </span>
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 font-black">
              Direction Hit: {board.directionScorecard.directionHitRate != null ? `${board.directionScorecard.directionHitRate}%` : 'calibrating…'}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 font-black">
              T1 Hit: {board.directionScorecard.t1HitPct != null ? `${board.directionScorecard.t1HitPct}%` : '—'}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/40 text-violet-200">
              Avg R: {board.directionScorecard.avgR != null ? `${board.directionScorecard.avgR >= 0 ? '+' : ''}${board.directionScorecard.avgR}R` : '—'}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-200">
              Wrong-Way: {board.directionScorecard.wrongWayRate != null ? `${board.directionScorecard.wrongWayRate}%` : '0%'}
            </span>
          </div>
          <span className="text-[8px] text-slate-400">
            {board.directionScorecard.calibrated ? '✓ Ledger-Calibrated (n ≥ 20)' : '⏳ Uncalibrated (<20 resolved scans)'}
          </span>
        </div>
      )}

      {/* ================= v21.23.13 EARLY RADAR — leading setups BEFORE PAKKA verification ================= */}
      {board?.earlyRadar && board.earlyRadar.length > 0 && (
        <div data-testid="mtf-early-radar" className="mt-2 rounded-xl border border-amber-500/35 bg-amber-500/5 px-3 py-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-black text-amber-300 tracking-wider">
              ⚡ EARLY RADAR — trend PAKKA confirm se PEHLE ke leading setups
            </span>
            <span className="text-[8px] text-slate-400">
              Sirf detection alert · auto/live locked · PAKKA verify hone par wahi setup main card me promote hota hai
            </span>
          </div>
          <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-3 gap-1.5">
            {board.earlyRadar.map(e => {
              const isLong = e.side === 'LONG';
              const eIsUsd = e.quoteCcy === 'USDT' || e.quoteCcy === 'USD';
              const eCcy = eIsUsd ? '$' : '₹';
              return (
                <div key={`early-${e.symbol}`} data-testid={`mtf-early-${e.symbol}`}
                  className="rounded-lg border border-amber-500/25 bg-black/30 px-2 py-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-black text-slate-100">{e.symbol}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border ${isLong ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/50' : 'bg-rose-500/20 text-rose-200 border-rose-400/50'}`}>
                      {e.side}
                    </span>
                    <span className="px-1 py-0.5 rounded text-[8px] font-black bg-amber-500/20 text-amber-200 border border-amber-400/40">
                      {e.earlyIgnition ? '⚡ EARLY IGNITION' : '⚡ TRIGGER FIRED'}
                    </span>
                    <span className="ml-auto text-[9px] font-mono text-slate-400">{e.superScore ?? '—'} {e.tier ?? ''}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 flex-wrap text-[9px] font-mono">
                    {e.entry != null && <span className="text-slate-300">E {eCcy}{fmt(e.entry)}</span>}
                    {e.triggerLevel != null && <span className="text-cyan-300">trigger {eCcy}{fmt(e.triggerLevel)}</span>}
                    {e.t1 != null && <span className="text-emerald-300">T1 {eCcy}{fmt(e.t1)}</span>}
                    {e.tfFit && <span className={e.tfFit === 'GOOD' || e.tfFit === 'OK' ? 'text-emerald-300' : 'text-amber-300'}>{e.tfFit}</span>}
                  </div>
                  <div className="mt-0.5 text-[8px] text-slate-500 truncate" title={e.reason || ''}>{e.reason || 'Leading setup'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ================= CARD GRID (Signal-Board parity + Gold/Silver XAU/XAG + Equity Sim) ================= */}
      {boardBusy && !displayedRows.length && <div className="text-[10px] text-slate-400 animate-pulse py-3">Dual-TF board compute ho raha hai…</div>}
      {!boardBusy && !displayedRows.length && (
        <div className="quantum-panel rounded-2xl p-6 text-center mt-2">
          <div className="text-2xl mb-1">😌</div>
          <div className="text-[11px] font-bold text-amber-400">Board par abhi koi WATCH+ trade-ready directional setup nahi</div>
          <div className="text-[10px] text-slate-500 mt-1">
            {scanRows.length > 0
              ? `${scanRows.length} coins scan hue — neeche FULL MARKET SCAN me sabki honest state hai. NEUTRAL/WAIT rows non-tradeable hain (fake signal nahi).`
              : 'Sirf WATCH+ LONG/SHORT rows dikhte hain — NEUTRAL, counter-HTF aur data-down rows honest khaali rehte hain (fake signal nahi).'}
          </div>
        </div>
      )}
      {displayedRows.length > 0 && (
        <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2.5">
          {displayedRows.map((r: MtfDualRow) => {
            const long = r.side === 'LONG';
            const sideCls = long ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
              : r.side === 'SHORT' ? 'bg-red-500/15 text-red-300 border border-red-500/40'
                : 'bg-slate-500/15 text-slate-400 border border-slate-500/40';
            const p = r.plan || null;
            const wp = r.signals?.board?.winProb || null;
            // v21.25.0 DIRECTION CERTIFICATE — explicit signal → order side.
            const dirCert = r.directionCertificate || null;
            const dirBlocked = Boolean(dirCert && dirCert.ok !== true);
            const orderSide = dirCert?.orderSide ?? r.orderSide ?? null;
            const dirVerdict = dirCert?.verdict ?? r.directionVerdict ?? null;
            const scorePct = Math.max(2, Math.min(100, Number(r.superScore) || 0));
            // v21.26.3 SINGLE AI SCORE: the headline is the MAIN ensemble's
            // aiScore/tier — the exact pair the DEEP ENSEMBLE modal shows.
            // The MTF fusion score is rendered separately (never as "AI score").
            const mainAi = r.signals?.board || null;
            const mainAiScore = mainAi?.aiScore != null && Number.isFinite(Number(mainAi.aiScore)) ? Number(mainAi.aiScore) : null;
            const mainAiTier = mainAi?.aiTier || null;
            const mainAiPct = Math.max(2, Math.min(100, mainAiScore ?? 0));
            // ✅ only when BOTH engines agree the row is tradeable: MTF gates
            // cleared AND the main ensemble signal is genuinely available.
            const isAutoReady = r.autoEligible === true
              && r.ensembleSignalAvailable === true
              && (r.side === 'LONG' || r.side === 'SHORT')
              && r.triggerFired === true;
            const autoBlockedLabel = r.ensembleSignalAvailable === false
              ? 'AI ENSEMBLE NOT READY'
              : (r.autoBlockers?.[0] || 'blocked');
            const key = `${r.symbol}-${r.mode}`;
            const open = !!expanded[key];
            const canPaper = r.ok && !dirBlocked && (r.side === 'LONG' || r.side === 'SHORT') && p?.entry && p?.stopLoss && p?.t1
              && !r.counterHtf && !r.counterTrend && r.ensembleSignalAvailable !== false
              && r.directionVerified === true && r.triggerFired === true && r.autoEligible === true
              && Number(r.superScore ?? 0) >= 65;
            const isRowUsd = r.quoteCcy === 'USDT' || r.quoteCcy === 'USD';
            const rowCcyPrefix = isRowUsd ? '$' : '₹';
            const assetTag = r.assetClass === 'METALS' || r.symbol === 'XAU' || r.symbol === 'XAG'
              ? { label: r.symbol === 'XAU' ? '🪙 GOLD PERP (XAU/USDT)' : '🥈 SILVER PERP (XAG/USDT)', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/50' }
              : r.assetClass === 'EQUITY_SIM' || r.market === 'GLOBALFUTURES'
                ? { label: '🌎 EQUITY SIM (US)', cls: 'bg-sky-500/20 text-sky-200 border-sky-400/50' }
                : r.market === 'INDIA'
                  ? { label: '🇮🇳 NSE INTRADAY', cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40' }
                  : { label: '⚡ CRYPTO PERP', cls: 'bg-violet-500/15 text-violet-200 border-violet-400/40' };
            // v21.23.1 HONEST P(WIN): fabricated `?? 95` fallback HATA — priority:
            // ledger-calibrated → server winRatePct → heuristic confluence → plan estimate.
            // Koi number nahi hai to chip honest '—' dikhata hai (jhoothe 95% claim nahi).
            const winRateIsCalibrated = r.pWinCalibrated != null;
            const winRateShown = winRateIsCalibrated
              ? r.pWinCalibrated
              : (r.winRatePct ?? r.heuristicConfluencePct ?? r.worldIndicators?.estimatedWinRatePct ?? null);
            const worldAligned = r.worldIndicators?.alignedCount ?? 0;
            const inst8Aligned = r.worldIndicators?.aligned8Count ?? Math.min(8, worldAligned);
            const inst8List = r.worldIndicators?.institutional8 || [];
            const isPakka = Boolean(r.directionVerified ?? r.worldIndicators?.directionVerified);
            const oppBoardSide = r.boardSide || r.signals?.board?.side || null;
            const hasBoardConflict = Boolean(r.boardSideConflict || (oppBoardSide && r.side && oppBoardSide !== r.side));
            const rowLiveReady = canPaper && !dirBlocked && !!r.directionVerified && !r.counterTrend && !r.counterHtf && !hasBoardConflict && !r.svaConflict && !r.councilConflict
              && r.assetClass !== 'EQUITY_SIM' && r.market !== 'GLOBALFUTURES' && Number(r.superScore ?? 0) >= 65;
            return (
              <div key={key} data-testid={`mtf-card-${r.symbol}`} className="quantum-panel rounded-2xl p-3 border border-violet-500/15">
                {/* card header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-black text-slate-100">{r.symbol}</span>
                      <span className={`px-1.5 py-0.5 rounded-md text-[8px] font-black border ${assetTag.cls}`}>
                        {assetTag.label}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-black tracking-wider ${sideCls}`}>
                        {r.side ?? 'WAIT'} {r.triggerFired ? '· ⚡ FIRED' : r.side ? '· ⏸ PENDING' : ''}
                      </span>
                      {dirCert && (
                        <span
                          data-testid={`mtf-dir-cert-${r.symbol}`}
                          className={`px-1.5 py-0.5 rounded-md text-[9px] font-black border font-mono ${
                            dirBlocked
                              ? 'bg-red-500/25 text-red-100 border-red-400/70'
                              : dirCert.pakka
                                ? 'bg-emerald-500/20 text-emerald-100 border-emerald-400/60'
                                : 'bg-cyan-500/15 text-cyan-200 border-cyan-500/45'
                          }`}
                          title={`Direction certificate ${dirCert.version}: ${dirCert.label} · ${dirCert.reasons.join(' · ') || 'side + order + geometry verified'}`}
                        >
                          🧭 {r.side && orderSide ? `${r.side} → ${orderSide.toUpperCase()}` : (dirVerdict || 'NO DIRECTION')}
                          {dirCert.pakka ? ' 🔒 PAKKA' : dirBlocked ? ' ⛔' : ''}
                        </span>
                      )}
                      {dirBlocked && (
                        <span
                          data-testid={`mtf-dir-blocked-${r.symbol}`}
                          className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-red-500/30 text-red-100 border border-red-400/70"
                          title={dirCert?.reasons.join(' · ') || 'direction certificate blocked this row'}
                        >
                          ⛔ DIRECTION BLOCKED · {dirVerdict}
                        </span>
                      )}
                      {isPakka && (r.side === 'LONG' || r.side === 'SHORT') && (
                        <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-black border ${long ? 'bg-emerald-500/25 text-emerald-100 border-emerald-400/60' : 'bg-rose-500/25 text-rose-100 border-rose-400/60'}`}
                          title="Pakka Verified Direction Lock: Deep Context TF + Action Trigger TF + 8 Institutional Indicators Aligned + Zero Trap/Wall Veto + Cross-Engine Direction Match">
                          🔒 PAKKA {r.side} VERIFIED
                        </span>
                      )}
                      {hasBoardConflict && (
                        <span data-testid={`mtf-conflict-chip-${r.symbol}`}
                          className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-red-500/30 text-red-100 border border-red-400/70"
                          title={`Cross-Engine Direction Conflict: Board Ensemble says ${oppBoardSide} (${r.signals?.board?.aiScore ?? '—'}) while MTF Dual Board says ${r.side} — capped ≤64 & blocked from auto-entry`}>
                          ⚠ BOARD: {oppBoardSide}{r.signals?.board?.aiScore != null ? ` ${r.signals.board.aiScore}` : ''} vs MTF: {r.side}
                        </span>
                      )}
                      {r.ensembleSignalAvailable === false && (
                        <span data-testid={`mtf-ensemble-warming-${r.symbol}`}
                          className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-amber-500/20 text-amber-200 border border-amber-400/60"
                          title="Main AI-BOARD ensemble is missing, non-actionable, or too weak for this scan — PAPER/LIVE entries are blocked until cross-engine confirmation is ready">
                          AI ENSEMBLE NOT READY
                        </span>
                      )}
                      {!isPakka && r.pakkaDirectionLabel?.startsWith('CONFLICT-') && (
                        <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-red-500/25 text-red-200 border border-red-400/60"
                          title="Direction Conflict across Board Ensemble / SVA Verifier / AI Council — Auto-Trade blocked">
                          🛑 {r.pakkaDirectionLabel}
                        </span>
                      )}
                      {r.trapVeto && (
                        <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-red-500/25 text-red-200 border border-red-400/60" title="Liquidity Sweep / Bull-Bear Trap Veto Active">
                          🛑 TRAP VETO
                        </span>
                      )}
                      {r.trigger?.postPeakTrap && (
                        <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-rose-500/25 text-rose-200 border border-rose-400/60" title="Anti-Late-Entry Guard: Trend wave already peaked — post-momentum exhaustion trap blocked!">
                          🛑 POST-PEAK TRAP{r.trigger?.rangePct != null ? ` (${fmt(r.trigger.rangePct, 0)}% Range)` : ''}
                        </span>
                      )}
                      <span
                        className={`px-1.5 py-0.5 rounded-md text-[9px] font-black border ${winRateIsCalibrated ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/50' : 'bg-emerald-500/10 text-emerald-300/90 border-emerald-500/35'}`}
                        title={winRateIsCalibrated
                          ? 'P(win) LEDGER-CALIBRATED (n ≥ 20 resolved trades, signalLedger σ-calibration) — authoritative number'
                          : 'P(win) HEURISTIC ESTIMATE (confluence × score blend) — ledger-calibrated number abhi accumulate ho raha hai; yeh guaranteed win-rate claim NAHI hai'}
                      >
                        🏆 {inst8Aligned}/8 Top Institutional Ind · {winRateShown != null ? `${winRateShown}%${winRateIsCalibrated ? '' : '~'} P(WIN)` : 'P(WIN) CALIBRATING'}
                      </span>
                      {r.earlyIgnition && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-amber-500/20 text-amber-200 border border-amber-500/50" title="Ultra-Fast Early Trend Ignition — fresh EMA5/9/20 + MACD velocity">⚡ EARLY IGNITION</span>}
                      {r.counterTrend && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-red-500/15 text-red-300 border border-red-500/40">⚠ COUNTER</span>}
                      {r.counterHtf && (
                        <span data-testid={`mtf-htf-conflict-chip-${r.symbol}`}
                          className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-red-500/30 text-red-100 border border-red-400/70"
                          title={`1d+4h HTF bias ${r.htfBias || 'opposite'} is against this ${r.side} — counter-HTF rows are capped at WATCH, not direction-verified, and can never be auto-traded or live-ordered`}>
                          ⚠ HTF {r.htfBias || 'AGAINST'} vs {r.side}
                        </span>
                      )}
                      {r.dualAligned && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-cyan-500/15 text-cyan-300 border border-cyan-500/40" title="context + trigger + side teeno aligned">DUAL ✓</span>}
                      {r.tripleAligned && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/40" title="1d+4h extended bias bhi aligned">TRIPLE ✓</span>}
                    </div>
                    <div className="mt-0.5 text-[9px] text-slate-500 font-mono">
                      {r.label} · hold {r.holdMin}m · {isRowUsd ? `$ ${fmt(r.ltp ?? p?.entry)} ${r.quoteCcy}` : `₹ ${fmt(r.ltp ?? p?.entry)}`}
                      {r.ltpInr != null && <span className="text-slate-600"> (≈ ₹{fmt(r.ltpInr, 0)})</span>}
                      {r.signals?.board?.aiScore != null && <span> · main AI {r.signals.board.side ? `${r.signals.board.side} ` : ''}{r.signals.board.aiScore}{r.signals.board.aiTier ? ` ${r.signals.board.aiTier}` : ''}</span>}
                      {r.signals?.mtf6?.agreementPct != null && <span> · MTF6 {r.signals.mtf6.agreementPct}%</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {/* v21.26.3 HEADLINE = MAIN AI SCORE (DEEP ENTROPY PARITY).
                        Same aiScore + tier as the DEEP ENSEMBLE ring. */}
                    <div className="flex items-center justify-end gap-1">
                      <span className="text-[8px] font-black tracking-wider text-slate-500">MAIN AI</span>
                      <span
                        data-testid={`mtf-main-ai-${r.symbol}`}
                        className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider ${mainAiTierCls(mainAiTier)}`}
                        title={mainAiScore != null
                          ? `MAIN ENSEMBLE AI score ${mainAiScore} · tier ${mainAiTier || '—'} · grade ${mainAi?.grade || '—'} · conf ${mainAi?.confidence ?? '—'}% — bilkul wahi number jo DEEP ENSEMBLE ANALYSIS ring dikhata hai.`
                          : 'Main AI-BOARD ensemble par is symbol ka signal nahi hai — MTF fusion score iske bina tradeable nahi.'}
                      >
                        {mainAiScore != null ? `${mainAiScore} ${mainAiTier || mainAi?.grade || ''}`.trim() : 'NOT ON BOARD'}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-24 bg-slate-800 rounded-full overflow-hidden ml-auto"
                      title={mainAiScore != null ? `Main AI ${mainAiScore}/100 (${mainAiTier || mainAi?.grade || '—'})` : 'Main AI score unavailable'}>
                      <div className={`h-full rounded-full ${mainAiScore == null ? 'bg-slate-600' : mainAiPct >= 85 ? 'bg-fuchsia-400' : mainAiPct >= 80 ? 'bg-emerald-400' : mainAiPct >= 65 ? 'bg-cyan-400' : 'bg-amber-400'}`} style={{ width: `${mainAiPct}%` }} />
                    </div>
                    {/* Secondary, clearly-labelled MTF fusion metric (NOT the AI score). */}
                    <div className="mt-1 flex items-center justify-end gap-1">
                      <span className="text-[8px] font-black tracking-wider text-slate-500">MTF FUSION</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[9px] font-black tracking-wider ${tierCls(r.tier)}`} title={(r.drivers || []).join(' · ') || 'MTF dual-timeframe fusion score (context 30% · trigger 25% · plan 20% · HTF bias 15% · board base 10%)'}>
                        {r.superScore ?? '—'} {r.tier}
                      </span>
                    </div>
                    <div className="mt-1 h-1 w-24 bg-slate-800/70 rounded-full overflow-hidden ml-auto" title={`MTF fusion ${r.superScore ?? '—'}/100 (secondary timing metric)`}>
                      <div className={`h-full rounded-full ${scorePct >= 85 ? 'bg-fuchsia-400/70' : scorePct >= 80 ? 'bg-emerald-400/70' : scorePct >= 65 ? 'bg-cyan-400/70' : 'bg-amber-400/70'}`} style={{ width: `${scorePct}%` }} />
                    </div>
                  </div>
                </div>

                {/* 8 Institutional Indicators live alignment strip */}
                {inst8List.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1 flex-wrap text-[8px] font-mono">
                    {inst8List.map(ind => {
                      const shortTag = ind.id === 'smc' ? 'SMC'
                        : ind.id === 'liquiditySweep' ? 'LIQ-SWEEP'
                          : ind.id === 'volumeProfile' ? 'VOL-PROFILE'
                            : ind.id === 'fvg' ? 'FVG'
                              : ind.id === 'ict' ? 'ICT'
                                : ind.id === 'emaRibbon' ? 'EMA'
                                  : ind.id === 'supplyDemand' ? 'SUP/DEM'
                                    : 'PRICE-ACT';
                      return (
                        <span key={ind.id}
                          title={`${ind.label}${ind.detail ? ` — ${ind.detail}` : ''}`}
                          className={`px-1.5 py-0.5 rounded border font-black ${ind.aligned ? 'border-emerald-500/45 bg-emerald-500/10 text-emerald-200' : 'border-slate-600/40 bg-slate-800/40 text-slate-400'}`}>
                          {ind.aligned ? '✓' : '·'} {shortTag}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* chips row */}
                <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[9px] font-mono">
                  <span className={`px-1.5 py-0.5 rounded border font-black ${fitCls(r.tfFit)}`} title={r.tfFitNote || ''}>
                    TF-FIT {r.tfFit ?? '—'}{r.tfFitRatio != null ? ` ${fmt(r.tfFitRatio, 2)}×` : ''}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded border ${((r.costR ?? 0) > 0.2) ? 'text-amber-300 border-amber-500/40' : 'text-slate-300 border-slate-500/30'}`} title="Round-trip cost R me (T1 risk ke against)">
                    COST {r.costR != null ? `${fmt(r.costR, 2)}R` : '—'}
                  </span>
                  {p?.netRR?.t2 != null && <span className="px-1.5 py-0.5 rounded border border-slate-500/30 text-slate-300" title="Net RR (cost ke baad)">netRR {fmt(p.netRR.t1, 1)}/{fmt(p.netRR.t2, 1)}</span>}
                  <span className="px-1.5 py-0.5 rounded border border-slate-500/30 text-slate-400" title="Context (deep) / Trigger (action) / Extended (1d+4h) bias">
                    C{dirArrow(r.trendDir)} T{dirArrow(r.triggerDir)} E{dirArrow(r.extendedDir)}
                  </span>
                  {wp && (
                    <span className={`px-1.5 py-0.5 rounded border font-black ${wp.verdict === 'EDGE' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : wp.verdict === 'NO-EDGE' ? 'text-red-300 border-red-500/40 bg-red-500/10' : 'text-amber-300 border-amber-500/40'}`}
                      title={`P(win) ${wp.pWin}% · EV ${fmt(wp.evR, 2)}R ${wp.calibrated ? '· ledger-calibrated' : '· uncalibrated'}`}>
                      P(WIN) {wp.pWin}% · {wp.verdict}
                    </span>
                  )}
                  {r.grade && <span className="px-1.5 py-0.5 rounded border border-slate-500/30 text-slate-400">grade {r.grade}</span>}
                  <span className="px-1.5 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 font-black" title="Full 100% CoinDCX Wallet Auto-Deployment + wallet-tier leverage (below ₹10,000 → 10x, ₹10,000+ → 5x)">
                    ⚡ {walletDeployPct}% Wallet · {activeLeverage}x LEV
                  </span>
                  {r.feeProtection?.feeBreakevenPrice != null && (
                    <span className="px-1.5 py-0.5 rounded border border-emerald-500/35 bg-emerald-500/10 text-emerald-200" title="Confirmed reversal par is fee-covered floor ke upar/neeche zero-loss exit hota hai">
                      🛡️ Fee-BE {rowCcyPrefix}{fmt(r.feeProtection.feeBreakevenPrice)}
                    </span>
                  )}
                  {r.ollamaTrio && (
                    <span className="px-1.5 py-0.5 rounded border border-violet-500/45 bg-violet-500/15 text-violet-200 font-black" title={r.ollamaTrio.liveNote || (r.ollamaTrio.ruleBasedGuard ? 'Rule-based 3-seat guard — Ollama live models offline (koi live AI response nahi)' : '3-Model Local Ollama AI Ensemble (live)')}>
                      🧠 {r.ollamaTrio.honestLabel || r.ollamaTrio.verdict}{r.ollamaTrio.latencyMs != null ? ` (${r.ollamaTrio.latencyMs}ms)` : ''}
                    </span>
                  )}
                  {r.aiAgents && (
                    <span className="px-1.5 py-0.5 rounded border border-violet-500/35 bg-violet-500/10 text-violet-200" title={`Top AI Agents: ${(r.aiAgents.topSeats || []).join(', ') || '16-seat ensemble'} · Ollama: ${r.aiAgents.councilModel || r.aiAgents.ollamaScanModel || 'ready'}`}>
                      🤖 {r.aiAgents.svaAction ? `SVA ${r.aiAgents.svaAction}` : 'AI Agents'}{r.aiAgents.voters ? ` · ${r.aiAgents.voters}/16` : ''}
                    </span>
                  )}
                </div>

                {/* 4-box trade plan grid (SignalCard language) */}
                {p ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-2">
                    <div className="bg-black/30 rounded-lg px-2 py-1.5" title={p.entryZoneLow != null && p.entryZoneHigh != null ? `Entry zone ${fmt(p.entryZoneLow)}–${fmt(p.entryZoneHigh)}` : ''}>
                      <div className="text-[8px] text-slate-500 font-black tracking-wider">⏱ ENTRY</div>
                      <div className="text-[11px] font-mono font-bold text-slate-100">{rowCcyPrefix}{fmt(p.entry)}</div>
                      {p.pullbackEntry != null && <div className="text-[8px] text-slate-500 font-mono">pb {fmt(p.pullbackEntry)} · bo {fmt(p.breakoutEntry)}</div>}
                    </div>
                    <div className="bg-black/30 rounded-lg px-2 py-1.5" title={`Risk per unit ${fmt(Math.abs((p.entry ?? 0) - (p.stopLoss ?? 0)))} · R-multiple sizing`}>
                      <div className="text-[8px] text-slate-500 font-black tracking-wider">🛑 STOP (TRAIL GUARD)</div>
                      <div className="text-[11px] font-mono font-bold text-red-300">{fmt(p.stopLoss)} <span className="text-[9px] text-slate-500">({fmt(p.stopPct)}%)</span></div>
                    </div>
                    <div className="bg-black/30 rounded-lg px-2 py-1.5" title="T1 pe 50% book + runner BE-trail · T2 full close (paper engine)">
                      <div className="text-[8px] text-slate-500 font-black tracking-wider">🎯 TARGETS (TP1 · TP2)</div>
                      <div className="text-[11px] font-mono font-bold text-emerald-300">{fmt(p.t1)} · {fmt(p.t2)}</div>
                    </div>
                    <div className="bg-black/30 rounded-lg px-2 py-1.5" title={r.suggestedHoldMin && r.suggestedHoldMin !== r.holdMin ? `Suggested ${r.suggestedHoldMin}m (TF-fit ke hisaab se)` : 'Plan window ke andar T1 na aaye to time-stop'}>
                      <div className="text-[8px] text-slate-500 font-black tracking-wider">⏰ EXIT-BY</div>
                      <div className="text-[11px] font-mono font-bold text-amber-300">{r.holdMin}m{r.suggestedHoldMin != null && r.suggestedHoldMin !== r.holdMin ? <span className="text-[9px] text-slate-500"> →{r.suggestedHoldMin}m</span> : null}</div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-[10px] text-amber-300/90 font-bold">⚠ {r.error || 'plan unavailable'} — is row par ticket nahi bana (honest degrade, koi fake level nahi).</div>
                )}

                {/* drivers + auto status + actions */}
                <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    {isAutoReady
                      ? <span className="px-1.5 py-0.5 rounded text-[9px] font-black border border-emerald-500/50 text-emerald-300 bg-emerald-500/10" title="Full confirm: main AI ensemble available + score≥bar + trigger fired + TF-fit GOOD/OK + dual aligned + not counter-trend + grade A/B + cost<0.5R">✅ AUTO-READY</span>
                      : <span className="px-1.5 py-0.5 rounded text-[9px] font-black border border-slate-500/40 text-slate-400" title={[...(r.ensembleSignalAvailable === false ? ['main AI-BOARD ensemble signal unavailable'] : []), ...(r.autoBlockers || [])].join(' · ') || 'blocked'}>⛔ {autoBlockedLabel}{(r.autoBlockers?.length || 0) > 1 ? ` +${(r.autoBlockers?.length || 0) - 1}` : ''}</span>}
                    {r.autoPickBlockers?.length ? <span className="ml-1 text-[8px] text-amber-300/70 font-mono" title={r.autoPickBlockers.join(' · ')}>pick: {r.autoPickBlockers[0]}</span> : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {(r.drivers || []).length > 0 && (
                      <button onClick={() => setExpanded(s => ({ ...s, [key]: !s[key] }))} className="text-[9px] text-slate-500 hover:text-slate-300 font-mono" title="Fuse drivers dekho">
                        {open ? '▾' : '▸'} why {r.superScore}?
                      </button>
                    )}
                    {canPaper && (
                      <button
                        type="button"
                        data-testid={`mtf-card-paper-${r.symbol}`}
                        onClick={() => void onPaperOrder(r)}
                        disabled={paperOrdering === r.symbol || busy}
                        title={`Open Paper Test ${r.side} trade on ${r.symbol} — test & verify in real time whether live price follows the ${r.side} direction + 3s Ultra-Fast Auto SL Trail`}
                        className="px-1.5 py-0.5 rounded text-[9px] font-black border border-cyan-500/60 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40">
                        {paperOrdering === r.symbol ? '…' : `🧪 PAPER ${r.side}`}
                      </button>
                    )}
                    {liveExecEnabled && rowLiveReady && (
                      <button
                        onClick={() => void onLiveOrder(r)}
                        disabled={liveOrdering === r.symbol || busy || liveEntriesPaused}
                        title={liveEntriesPaused
                          ? 'LIVE entries Phase 0 me PAUSED hain — pehle RESUME ENTRIES dabao'
                          : `Place real CoinDCX Futures ${r.side} order (${activeLeverage}x leverage — Wallet ₹${Math.round(effectiveWalletINR).toLocaleString('en-IN')}) — sirf direction-verified, non-counter-HTF setups`}
                        className="px-1.5 py-0.5 rounded text-[9px] font-black border border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 disabled:opacity-40">
                        {liveOrdering === r.symbol ? '…' : `⚡ LIVE ${activeLeverage}x`}
                      </button>
                    )}
                    {onDeep && (
                      <button onClick={() => onDeep(r.symbol, r.market as MarketKind, r)} title="Deep analysis + MTF trade plan kholo"
                        className="px-1.5 py-0.5 rounded text-[9px] font-black border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10">🔬</button>
                    )}
                  </div>
                </div>

                {open && (
                  <div className="mt-2 border-t border-slate-700/30 pt-1.5 space-y-0.5">
                    {(r.drivers || []).map((d, i) => (
                      <div key={i} className="text-[9px] font-mono text-slate-400">· {d}</div>
                    ))}
                    {(r.gates || []).length > 0 && (
                      <div className="text-[9px] font-mono text-amber-300/80">gates: {(r.gates || []).join(' · ')}</div>
                    )}
                    {(r.components || []).length > 0 && (
                      <div className="text-[9px] font-mono text-slate-500">
                        fuse: {(r.components || []).map(c => `${c.k} ${c.w * 100}%×${c.v}`).join(' · ')}
                      </div>
                    )}
                    {r.context && (
                      <div className="text-[9px] font-mono text-slate-500">
                        ctx[{r.contextTf}] {r.context.struct ?? ''} · RSI {fmt(r.context.rsi, 0)} · ADX {fmt(r.context.adx, 0)} · ST {r.context.supertrend ?? '—'}
                        {r.trigger && <span> · trig[{r.triggerTf}] vol {fmt(r.trigger.volRatio, 2)}× · body {fmt(r.trigger.bodyPct, 0)}%</span>}
                      </div>
                    )}
                    {(r.warnings || []).length > 0 && (
                      <div className="text-[9px] font-mono text-amber-300/70">warn: {(r.warnings || []).map(w => w.code).join(' · ')}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ================= v21.25.1 FULL MARKET SCAN — never-empty coin universe ================= */}
      {scanRows.length > 0 && (
        <div data-testid="mtf-market-scan" className="mt-2 rounded-xl border border-slate-500/25 bg-slate-950/60 px-3 py-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-black text-slate-200 tracking-wider">
              🔍 FULL MARKET SCAN — {scanRows.length} coins
            </span>
            <span className="text-[8px] text-slate-500">
              {scanRows.filter(s => s.actionable).length} WATCH+ · {scanRows.filter(s => !s.actionable).length} NEUTRAL/WAIT · action sirf WATCH+ cards par
            </span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
            {scanRows.map(s => {
              const sLong = s.side === 'LONG';
              const sCcy = s.quoteCcy === 'USDT' || s.quoteCcy === 'USD' ? '$' : '₹';
              return (
                <div
                  key={`scan-${s.symbol}`}
                  data-testid={`mtf-scan-${s.symbol}`}
                  className={`rounded-lg border px-2 py-1.5 ${s.actionable ? 'border-slate-500/40 bg-slate-900/60' : 'border-slate-700/40 bg-black/30'}`}
                  title={[s.blocker, s.directionVerdict ? `cert ${s.directionVerdict}` : null, s.htfBias ? `HTF ${s.htfBias}` : null].filter(Boolean).join(' · ') || 'Scanned — no blocker detail'}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[10px] font-black text-slate-100">{s.symbol}</span>
                    <span className="text-[9px] font-mono text-slate-400">{s.superScore ?? '—'}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                    {s.actionable ? (
                      <span className={`px-1 py-0.5 rounded text-[8px] font-black border ${sLong ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-red-500/15 text-red-300 border-red-500/40'}`}>
                        {s.side}
                      </span>
                    ) : (
                      <span className="px-1 py-0.5 rounded text-[8px] font-black border border-slate-600/50 text-slate-400 bg-slate-800/40">WAIT</span>
                    )}
                    <span className={`px-1 py-0.5 rounded text-[8px] font-black ${tierCls(s.tier)}`}>{s.tier}</span>
                    {s.autoEligible && (
                      <span className="px-1 py-0.5 rounded text-[8px] font-black border border-emerald-500/40 bg-emerald-500/15 text-emerald-200">AUTO</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-1 text-[8px] font-mono text-slate-500">
                    <span>{s.ltp != null ? `${sCcy}${fmt(s.ltp)}` : '—'}</span>
                    <span>{s.triggerFired ? 'trigger ✓' : s.directionVerified ? 'waiting' : 'scan'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ================= linked book + events ================= */}
      <div className="mt-2 flex items-center gap-2 flex-wrap text-[10px]">
        <button onClick={() => setShowBook(s => !s)} className="font-black text-slate-300 border border-slate-500/30 rounded px-2 py-0.5 hover:border-slate-400/50">
          📒 LINKED BOOK ({auto?.openCount ?? 0} open)</button>
        <button onClick={() => setShowLog(s => !s)} className="font-black text-slate-300 border border-slate-500/30 rounded px-2 py-0.5 hover:border-slate-400/50">
          🧾 AUTO EVENTS ({auto?.events?.length ?? 0})</button>
      </div>
      {showBook && auto?.book?.length ? (
        <div className="mt-1.5 space-y-0.5">
          {auto.book.slice(0, 10).map(b => (
            <div key={`${b.paperId}-${b.symbol}`} className="flex items-center gap-1.5 text-[9px] font-mono flex-wrap">
              <span className={b.status === 'OPEN' ? 'text-emerald-300' : 'text-slate-500'}>{b.status}</span>
              <span className="font-bold text-slate-200">{b.symbol}</span>
              <span className={b.side === 'LONG' ? 'text-emerald-300' : 'text-red-300'}>{b.side}</span>
              {b.orderSide && (
                <span className={`px-1 rounded border text-[8px] font-black ${b.orderSide === 'buy' ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}`}
                  title="Direction certificate: signal side → exchange order side">
                  → {b.orderSide.toUpperCase()}
                </span>
              )}
              {b.directionBlocked && <span className="px-1 rounded border border-red-500/50 bg-red-500/20 text-red-200 text-[8px] font-black">⛔ BLOCKED</span>}
              <span className="text-slate-300">{b.score} {b.tier}</span>
              <span className="text-slate-400">qty {b.qty} · risk ₹{fmt(b.riskINR, 0)}{b.ccy === 'USDT' ? ` ($${fmt(b.riskUsdt, 2)})` : ''} · e {b.ccy === 'USDT' ? '$' : '₹'}{fmt(b.entry)} · sl {fmt(b.stopLoss)}</span>
              <span className="text-slate-500">{b.holdMin}m window · {fmtAge(b.openedAt)} ago{b.closeReason ? ` · ${b.closeReason}` : ''}{b.pnl != null ? ` · ${b.ccy === 'USDT' ? '$' : '₹'}${fmt(b.pnl, 2)}` : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
      {showLog && auto?.events?.length ? (
        <div className="mt-1.5 space-y-0.5">
          {auto.events.slice(0, 10).map((e, i) => (
            <div key={i} className="text-[9px] font-mono">
              <span className="text-slate-500">{fmtAge(e.at)} ago</span>{' '}
              <span className={e.kind === 'entry' ? 'text-emerald-300' : e.kind === 'time-exit' ? 'text-amber-300' : 'text-slate-400'}>[{e.kind}]</span>{' '}
              <span className="text-slate-300">{e.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ================= institutional verification & execution summary ================= */}
      <div className="mt-2 text-[9px] text-slate-500 leading-relaxed">
        <div>• <b className="text-slate-400">8 Institutional Top Indicators Integrated</b>: 1. SMC (BOS/CHoCH/OB) · 2. Liquidity Sweep/Trap · 3. Volume Profile (POC/VAH/VAL) · 4. Fair Value Gap (FVG) · 5. ICT (OTE 62–79%/MSS) · 6. EMA (9/20/50/200) · 7. Supply & Demand Zones · 8. Price Action (+ Supertrend/VWAP/Ichimoku + CVD/Chandelier/TTM Squeeze).</div>
        <div>• <b className="text-slate-400">Pakka LONG/SHORT Direction Lock</b>: Deep Context TF + Action Trigger TF + 8 Institutional Pillars consensus + Liquidity Trap Veto & Supply/Demand Wall Veto — false breakout traps auto-blocked.</div>
        <div>• <b className="text-slate-400">One-Click Live Auto-Trade & Deep Monitor</b>: Full {walletDeployPct}% CoinDCX Futures Wallet deployment (<b className="text-slate-400">{activeLeverage}x wallet-tier leverage · 1% risk/trade</b>) + Full Control of CoinDCX Active Positions (Sirf Active Traded Positions) + 15s Live Signal Recheck + 5-Stage Dynamic SL Trailing & Reversal Profit-Booking until TP1/TP2.</div>
      </div>
    </div>
  );
});
