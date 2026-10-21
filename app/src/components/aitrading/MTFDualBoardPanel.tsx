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
  /** Optional: deep analysis kholne ke liye (row ke 🔬 button). */
  onDeep?: (symbol: string, market: MarketKind) => void;
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

const tierCls = (tier?: string) =>
  tier === 'ELITE' ? 'bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/40'
    : tier === 'STRONG' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
      : tier === 'ACTION' ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
        : tier === 'WATCH' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40'
          : 'bg-slate-500/15 text-slate-400 border border-slate-500/40';

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
  const [mode, setMode] = useState<TradePlanModeId>('INTRADAY');
  const [holdMin, setHoldMin] = useState<number>(45);
  const [minScore, setMinScore] = useState<number>(75);
  const [deskFilter, setDeskFilter] = useState<'ALL' | 'MAIN' | 'METALS' | 'EQUITY_SIM'>('ALL');
  const [board, setBoard] = useState<MtfDualBoardView | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  const [auto, setAuto] = useState<MtfAutoStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const [liveOrdering, setLiveOrdering] = useState<string | null>(null);
  const [paperOrdering, setPaperOrdering] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const reqRef = useRef(0);

  // debounced fetch inputs (typing/slider storm se bachne ke liye)
  const [debounced, setDebounced] = useState({ mode, holdMin, minScore, limit: 6 });
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced({ mode, holdMin, minScore, limit: 6 }), 350);
    return () => window.clearTimeout(t);
  }, [mode, holdMin, minScore]);

  const loadBoard = useCallback(async () => {
    const id = ++reqRef.current;
    setBoardBusy(true);
    const b = await fetchMtfDualBoard(market, debounced);
    if (reqRef.current === id) { if (b) setBoard(b); setBoardBusy(false); }
  }, [market, debounced]);

  const loadAuto = useCallback(async () => {
    const a = await fetchMtfAutoStatus();
    if (a) setAuto(a);
    return a;
  }, []);

  useEffect(() => { void loadBoard(); }, [loadBoard]);
  useEffect(() => {
    void loadAuto();
    // v21.22.0 ULTRA-FAST REALTIME SL TRAIL & DIRECTION FOLLOW-THROUGH POLL:
    // Poll every 3 seconds when any trade is active so SL trailing & direction verification update in real time!
    const cadenceMs = (auto?.openCount ?? 0) > 0 || (auto?.deepMonitor?.activeCount ?? 0) > 0 ? 3_000 : 8_000;
    const t = window.setInterval(() => { if (!document.hidden) void loadAuto(); }, cadenceMs);
    return () => window.clearInterval(t);
  }, [loadAuto, auto?.openCount, auto?.deepMonitor?.activeCount]);
  useEffect(() => {
    // v21.22.0 ULTRA-FAST 24x7 DIRECT PRICE FETCHING: poll board every 8s
    const t = window.setInterval(() => { if (!document.hidden) void loadBoard(); }, 8_000);
    return () => window.clearInterval(t);
  }, [loadBoard]);

  const notify = useCallback((ok: boolean, msg: string) => {
    setNote(`${ok ? '✅' : '⛔'} ${msg}`);
    window.setTimeout(() => setNote(null), 7000);
  }, []);

  const pickMode = useCallback((m: TradePlanModeId) => {
    const h = MODES.find(x => x.id === m)?.hold ?? 45;
    setMode(m);
    setHoldMin(h);
    void updateMtfAutoConfigApi({ mode: m, holdMin: h });
  }, []);

  const onToggle = useCallback(async (enabled: boolean) => {
    setBusy(true);
    const st = await setMtfAutoEnabledApi(enabled);
    setBusy(false);
    if (st) { setAuto(st); notify(true, enabled ? 'MTF AUTO-LINK ARMED — 75+ confirmed Deep-Trend rows auto-execute honge' : 'MTF AUTO-LINK DISARMED — naye entries band'); }
    else notify(false, 'toggle fail — server check karo');
  }, [notify]);

  const { wallet: liveWallet } = useWalletPoll();
  const counts = board?.counts;
  const rows = useMemo(() => board?.rows || [], [board?.rows]);
  const metalsRows = useMemo(() => board?.metalsRows || [], [board?.metalsRows]);
  const equitySimRows = useMemo(() => board?.equitySimRows || [], [board?.equitySimRows]);
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
    : (Number(walletINR) > 0 ? Number(walletINR) : Number(auto?.walletAmountINR) || 10000);
  const activeLeverage = effectiveWalletINR < 10000 ? (auto?.belowTenKLeverage ?? 10) : (auto?.aboveTenKLeverage ?? 5);
  const walletDeployPct = auto?.walletDeployPct ?? 100;
  const deployed95WalletINR = Math.round(effectiveWalletINR * (walletDeployPct / 100));
  const buyingPower95INR = Math.round(deployed95WalletINR * activeLeverage);
  // v21.23.13 [HONEST LIVE BADGE]: pehle primary branch (executionMode ===
  // 'live') canLive ko BYPASS karta tha — CoinDCX creds missing hone par bhi
  // button 🟢 LIVE ON dikhta tha, engine har live attempt reject +
  // escalating backoff (5m→4h) khata rehta, user ko kabhi reason nahi
  // dikhta tha. Ab DONO branches canLive demand karti hain — button green
  // = LIVE truly armed AND executable (creds + site live dono confirm).
  const isLiveAuto = Boolean(armed && canLive && (auto?.executionMode === 'live' || auto?.autoSyncSiteLive !== false));
  const activeTradedRows = useMemo(
    () => (auto?.deepMonitor?.trades || []).filter(t => t.traded !== false),
    [auto?.deepMonitor?.trades],
  );

  /** 🧪 PAPER TEST ORDER — opens a Paper Trade directly for this MTF Dual Board card and registers it in the Deep Monitor so the user can test and verify whether price genuinely follows the LONG/SHORT signal direction + 3s Auto SL Trail! */
  const onPaperOrder = useCallback(async (row: MtfDualRow) => {
    if (row.side !== 'LONG' && row.side !== 'SHORT') {
      notify(false, `${row.symbol}: directional signal (LONG/SHORT) required`);
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
        mode,
        holdMin,
        minScore,
        maxOpenPositions: 1,
        deepMonitorEnabled: true,
      };
      if (effectiveWalletINR > 0) cfgPatch.walletAmountINR = effectiveWalletINR;
      const stCfg = await updateMtfAutoConfigApi(cfgPatch);
      if (stCfg) setAuto(stCfg);
      const stArm = await setMtfAutoEnabledApi(true);
      if (stArm) setAuto(stArm);
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
  }, [mode, holdMin, minScore, effectiveWalletINR, notify, loadAuto]);

  /** ⚡ LIVE ORDER — places real CoinDCX Futures order directly for this MTF Dual Board card using .env keys (100% Wallet + Leverage). */
  const onLiveOrder = useCallback(async (row: MtfDualRow) => {
    if (row.side !== 'LONG' && row.side !== 'SHORT') {
      notify(false, `${row.symbol}: directional signal (LONG/SHORT) required`);
      return;
    }
    if (row.trapVeto || row.zoneWallVeto || row.reversalRisk || row.trigger?.opposingFlow || row.trigger?.postPeakTrap) {
      notify(false, `🛑 ${row.symbol}: Post-Peak Exhaustion / Reversal / Liquidity Trap Risk active — late entry blocked to prevent SL hit!`);
      return;
    }
    if (activeTradedRows.length >= 1) {
      notify(
        false,
        `🔒 1 Session = 1 Trade Lock: ${activeTradedRows[0]?.symbol} (${activeTradedRows[0]?.side}) abhi active hai — ye trade complete hone ke baad hi next trade lagega!`,
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
        `⚡ LIVE ORDER PLACED — ${row.symbol} ${row.side} · ${f?.leverage ?? activeLeverage}x · 100% Wallet (₹${deployed95WalletINR.toLocaleString('en-IN')}) · qty ${f?.qty ?? '—'} @ ${targetMkt === 'INDIA' ? '₹' : '$'}${fmt(f?.price ?? row.plan?.entry)} · SL ${fmt(f?.stopLoss ?? row.plan?.stopLoss)} · T1 ${fmt(f?.t1 ?? row.plan?.t1)} · T2 ${fmt(f?.t2 ?? row.plan?.t2)} (Full Position Control Armed)`,
      );
      onExecuteLive?.(row, activeLeverage);
      onPaperOpened?.(row.symbol, targetMkt);
      void loadAuto();
    } else {
      notify(false, `${row.symbol} LIVE order failed: ${r?.error || r?.reason || 'check CoinDCX/Dhan wallet/margin'}`);
    }
  }, [market, mode, holdMin, activeLeverage, deployed95WalletINR, activeTradedRows, notify, onExecuteLive, onPaperOpened, loadAuto]);

  /** ⚡ SINGLE LIVE BUTTON — turns ON Auto-Trade Intelligence, fetches CoinDCX Wallet, deploys 100% of wallet on strictly 1 Verified Strong Trade per session, and takes Full Control! */
  const onAutoLiveExecute = useCallback(async () => {
    setBusy(true);
    try {
      const cfgPatch: Record<string, unknown> = {
        executionMode: 'live',
        mode,
        holdMin,
        minScore,
        walletDeployPct: 100,
        maxOpenPositions: 1,
        deepMonitorEnabled: true,
      };
      if (effectiveWalletINR > 0) cfgPatch.walletAmountINR = effectiveWalletINR;
      const stCfg = await updateMtfAutoConfigApi(cfgPatch);
      // v21.23.13 [HONEST ARM — LIVE]: /config ya /toggle fail par bhi code
      // aage badh ke engine PURANE mode (paper) me arm ho sakta tha — user
      // LIVE samajh baithta tha. Ab har step fail par HONEST abort + reason.
      if (!stCfg) {
        notify(false, '⛔ AUTO-LIVE config save NAHI hua (server error) — LIVE mode arm nahi hua. Retry karo.');
        setBusy(false); return;
      }
      setAuto(stCfg);
      const stArm = await setMtfAutoEnabledApi(true);
      if (!stArm) {
        notify(false, '⛔ AUTO-LINK arm fail (server error) — LIVE ON nahi hua. Retry karo.');
        setBusy(false); return;
      }
      setAuto(stArm);
      // v21.23.13 [CREDS PRE-FLIGHT]: creds missing = engine har live attempt
      // instantly reject + per-symbol escalating backoff (5m→4h) khayega —
      // din bhar ka silent no-op ('button ON par trade nahi lagta' ka seedha
      // vector). Button green dikhana jhootha hota — honest abort + clear
      // next-step (keys Execution Console / Settings me connect karo).
      if (stArm?.coindcxConnected === false) {
        notify(false, '⛔ CoinDCX API keys CONNECTED NAHI hain — LIVE auto-trade order execute nahi hoga. Pehle CoinDCX API keys connect karo, phir ⚡ LIVE dabao. (Engine armed hai par live entry creds ke bina reject hogi.)');
        await loadAuto();
        setBusy(false); return;
      }

      // Strictly 1 trade per session: if an active position is already open, do NOT place a 2nd trade!
      const preActiveCount = (stArm?.deepMonitor?.trades || activeTradedRows || []).filter(t => t.traded !== false).length;
      if (preActiveCount > 0) {
        notify(
          true,
          `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — 1 Active Session Trade under Full Deep Monitor Control (100% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} @ ${activeLeverage}x · Next trade after current trade finishes)`,
        );
        await loadAuto();
        return;
      }

      const r = await runMtfAutoTick();
      const openedCount = r?.tick?.opened?.length ?? 0;
      const tickInFlight = Boolean((r?.tick as { inFlight?: boolean } | undefined)?.inFlight);
      if (openedCount > 0) {
        notify(true, `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — opened 1 Verified Strong live trade (100% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} · ${activeLeverage}x leverage · ${liveFutMarginCcy} margin · 1 Session = 1 Trade Lock Active)`);
        await loadAuto();
        setBusy(false);
        return;
      }
      // Re-check status after tick: if 1 trade is active (or tick was already in-flight), never stack a 2nd order!
      const freshStatus = await loadAuto();
      const alreadyActiveCount = (freshStatus?.deepMonitor?.trades || stArm?.deepMonitor?.trades || []).filter(t => t.traded !== false).length;
      if (alreadyActiveCount > 0 || tickInFlight) {
        notify(true, `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — ${alreadyActiveCount || 1} Active Position under Full Deep Monitor Control (100% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} @ ${activeLeverage}x · Dynamic SL Trail + Reversal Profit Book)`);
        return;
      }
      // If 0 trades are active and auto-tick was waiting on micro trigger bar, pick ONLY 1 top Verified STRONG/ELITE signal!
      const preferCoinDcx = liveFutWalletINR > 0 && market === 'INDIA' && !canLive;
      const allPool = preferCoinDcx ? [...metalsRows, ...rows] : [...rows, ...metalsRows];
      const topStrongVerified = allPool
        .filter(x =>
          x.ok
          && (x.side === 'LONG' || x.side === 'SHORT')
          && x.directionVerified === true
          && x.triggerFired === true
          && !x.reversalRisk
          && !x.trigger?.reversalRisk
          && !x.trigger?.opposingFlow
          && (x.ollamaTrio?.approvedCount == null || x.ollamaTrio.approvedCount >= 2)
          && (x.tier === 'STRONG' || x.tier === 'ELITE' || Number(x.superScore) >= 80)
          && Number(x.superScore) >= 75
          && x.plan?.entry
          && x.plan?.stopLoss
          && !x.trapVeto
          && !x.zoneWallVeto
          && !x.counterTrend,
        )
        .sort((a, b) => (Number(b.superScore) || 0) - (Number(a.superScore) || 0))
        .slice(0, 1);

      if (topStrongVerified.length === 1) {
        const cand = topStrongVerified[0];
        const candMkt = (cand.assetClass === 'METALS' ? 'METALS' : cand.assetClass === 'EQUITY_SIM' ? 'GLOBALFUTURES' : cand.market === 'INDIA' ? 'INDIA' : market) as MarketKind;
        const directRes = await openMtfBoardLive(cand.symbol, candMkt, cand.side as 'LONG' | 'SHORT', mode, cand.holdMin ?? holdMin, activeLeverage);
        if (directRes?.ok) {
          const f = directRes.filled;
          const actualDeployINR = Number((f as { walletDeployINR?: number } | undefined)?.walletDeployINR) > 0
            ? Math.round(Number((f as { walletDeployINR?: number }).walletDeployINR))
            : deployed95WalletINR;
          notify(
            true,
            `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — ${cand.symbol} ${cand.side} (${cand.tier} ${cand.superScore}) · ${f?.leverage ?? activeLeverage}x · 100% Wallet ₹${actualDeployINR.toLocaleString('en-IN')} · qty ${f?.qty ?? '—'} @ ${candMkt === 'INDIA' ? '₹' : '$'}${fmt(f?.price ?? cand.plan?.entry)} (1 Session = 1 Trade Lock Active)`,
          );
          onPaperOpened?.(cand.symbol, candMkt);
          await loadAuto();
          return;
        }
        const lastErr = `${cand.symbol}: ${directRes?.error || directRes?.reason || 'order failed'}`;
        notify(true, `🟢 LIVE AUTO-TRADE INTELLIGENCE ON (100% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} @ ${activeLeverage}x · Deep Monitor Watching — ${lastErr})`);
      } else {
        notify(true, `🟢 LIVE AUTO-TRADE INTELLIGENCE ON — Watching 24×7 for Verified STRONG (PAKKA LONG/SHORT) Signal · 1 Session = 1 Full-Wallet Trade (₹${deployed95WalletINR.toLocaleString('en-IN')} @ ${activeLeverage}x)`);
      }
      await loadAuto();
    } finally {
      setBusy(false);
    }
  }, [rows, metalsRows, market, mode, holdMin, minScore, activeLeverage, effectiveWalletINR, deployed95WalletINR, liveFutWalletINR, liveFutMarginCcy, canLive, activeTradedRows, notify, onPaperOpened, loadAuto]);

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
    return `${isLiveAuto ? '🟢 LIVE AUTO-TRADE INTELLIGENCE ON' : '⏸ AUTO-TRADE STANDBY'} · 100% Wallet ₹${deployed95WalletINR.toLocaleString('en-IN')} / ₹${Math.round(effectiveWalletINR).toLocaleString('en-IN')} @ ${activeLeverage}x (Buying Power ₹${buyingPower95INR.toLocaleString('en-IN')}) · Active Traded: ${activeTradedRows.length} · day ${auto.day ?? '—'} · trades ${auto.dayCount}/${auto.maxTradesPerDay}${isLiveAuto && auto.coindcxConnected === false ? ' · ⚠ CoinDCX keys NOT connected — live order reject hoga' : ''}${skipWhy}`;
  }, [auto, isLiveAuto, activeLeverage, effectiveWalletINR, deployed95WalletINR, buyingPower95INR, activeTradedRows.length]);

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
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-black border border-cyan-500/40 bg-cyan-500/10 text-cyan-200" title="100% CoinDCX Wallet Auto-Deployment + Wallet-Tier Leverage (< ₹10,000 → 10x · ≥ ₹10,000 → 5x)">
              ⚡ 100% WALLET ₹{deployed95WalletINR.toLocaleString('en-IN')} / ₹{Math.round(effectiveWalletINR).toLocaleString('en-IN')}{liveFutWalletINR > 0 ? ` (${liveFutMarginCcy})` : ''} → {activeLeverage}x LEV
            </span>
            {counts && (
              <span className="text-[9px] font-black font-mono text-slate-400" title="rows · 75+ over bar · auto-eligible · STRONG/ELITE · trigger fired">
                {counts.rows} rows · <span className="text-emerald-300">{counts.overBar}≥75</span> · <span className="text-cyan-300">{counts.eligible} auto-ready</span> · <span className="text-amber-300">🪙 {metalsRows.length} XAU/XAG</span> · <span className="text-sky-300">🌎 {equitySimRows.length} Equity Sim</span>
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

      {/* ================= SINGLE ONE-CLICK LIVE AUTO-TRADE INTELLIGENCE BAR (User Spec #1, #2, #3, #5) ================= */}
      <div className={`mt-2 border rounded-xl px-3 py-2.5 transition-all ${isLiveAuto ? 'border-emerald-500/50 bg-gradient-to-r from-emerald-950/40 via-emerald-900/20 to-cyan-950/30 shadow-lg shadow-emerald-950/30' : 'border-slate-500/30 bg-slate-900/40'}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap text-[11px] font-black tracking-wide">
              <span className={isLiveAuto ? 'text-emerald-300' : 'text-slate-200'}>
                {isLiveAuto ? '🟢 AUTO-TRADE INTELLIGENCE — LIVE ON (24×7 REALTIME)' : '⚡ AUTO-TRADE SUPER INTELLIGENCE (ONE-CLICK LIVE)'}
              </span>
              <span className="px-2 py-0.5 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-[9px] font-mono text-cyan-200">
                💰 100% CoinDCX Wallet: ₹{deployed95WalletINR.toLocaleString('en-IN')} × {activeLeverage}x = ₹{buyingPower95INR.toLocaleString('en-IN')} Buying Power
              </span>
              <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-[9px] font-mono text-emerald-200">
                🔒 Full CoinDCX Active Position Control · Sirf Active Traded Positions · TP1/TP2 + SL Trail + Reversal Profit-Book
              </span>
            </div>
            <div className="mt-1 text-[9px] font-mono text-slate-400">
              {statusLine}
            </div>
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
            <button
              type="button"
              data-testid="mtf-single-live-auto-btn"
              disabled={busy}
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
              title="Click karne par Auto Trade Intelligence ON hoga — CoinDCX Wallet fetch karke 100% wallet amount + Leverage ke saath trade lagega, Active Positions ko Full Control pe lega aur TP1/TP2 tak Deep Monitor + Trailing SL + Reversal Profit Book chalega">
              <Power size={13} className={isLiveAuto ? 'text-emerald-300 animate-pulse' : 'text-amber-300'} />
              {busy
                ? '⏳ ACTIVATING LIVE AI…'
                : isLiveAuto
                  ? `🟢 LIVE ON (${activeLeverage}x · 100% WALLET)`
                  : `⚡ LIVE`}
            </button>
          </div>
        </div>

        {/* ================= DEDICATED ACTIVE-TRADE DEEP MONITOR PANEL (Sirf Active Traded Positions) ================= */}
        {activeTradedRows.length > 0 && (
          <div className="mt-2.5 pt-2.5 border-t border-emerald-500/30">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
              <div className="flex items-center gap-2 flex-wrap text-[10px] font-black text-emerald-300">
                <span>🔬 ACTIVE AUTO-TRADE DEEP MONITOR — REALTIME TP1 / TP2 & REVERSAL PROFIT GUARD · FULL COINDCX POSITION CONTROL (SIRF ACTIVE TRADES)</span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[9px]">
                  {activeTradedRows.length} Active Traded · {auto?.deepMonitor?.trailingActiveCount ?? 0} SL Trailed · {auto?.deepMonitor?.tp1LockedCount ?? 0} TP1 Hit
                </span>
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
                return (
                  <div key={`${t.symbol}-${i}`} className="rounded-xl bg-black/45 border border-emerald-500/35 p-2.5 text-[10px] font-mono">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-black text-white">{t.symbol}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${isPaperRow ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/50' : 'bg-amber-500/25 text-amber-200 border border-amber-400/50'}`}>
                          {isPaperRow ? '🧪 PAPER TEST' : '⚡ LIVE COINDCX'}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${isLong ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                          {t.side} · {t.leverage || activeLeverage}x · {t.walletDeployPct || 100}% Wallet
                        </span>
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

      {/* ================= CARD GRID (Signal-Board parity + Gold/Silver XAU/XAG + Equity Sim) ================= */}
      {boardBusy && !displayedRows.length && <div className="text-[10px] text-slate-400 animate-pulse py-3">Dual-TF board compute ho raha hai…</div>}
      {!boardBusy && !displayedRows.length && (
        <div className="quantum-panel rounded-2xl p-6 text-center mt-2">
          <div className="text-2xl mb-1">😌</div>
          <div className="text-[11px] font-bold text-amber-400">Board par abhi koi high-confidence directional setup nahi</div>
          <div className="text-[10px] text-slate-500 mt-1">Sirf WATCH+ LONG/SHORT rows dikhte hain — NEUTRAL, counter-HTF aur data-down rows honest khaali rehte hain (fake signal nahi).</div>
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
            const scorePct = Math.max(2, Math.min(100, Number(r.superScore) || 0));
            const key = `${r.symbol}-${r.mode}`;
            const open = !!expanded[key];
            const canPaper = r.ok && (r.side === 'LONG' || r.side === 'SHORT') && p?.entry && p?.stopLoss && p?.t1 && !r.counterHtf;
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
            const rowLiveReady = canPaper && !!r.directionVerified && !r.counterTrend && !r.counterHtf && !hasBoardConflict && !r.svaConflict && !r.councilConflict && Number(r.superScore ?? 0) >= 65;
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
                      {r.signals?.board?.aiScore != null && <span> · board {r.signals.board.side ? `${r.signals.board.side} ` : ''}{r.signals.board.aiScore}</span>}
                      {r.signals?.mtf6?.agreementPct != null && <span> · MTF6 {r.signals.mtf6.agreementPct}%</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider ${tierCls(r.tier)}`} title={(r.drivers || []).join(' · ') || 'drivers n/a'}>
                      {r.superScore ?? '—'} {r.tier}
                    </span>
                    <div className="mt-1 h-1.5 w-24 bg-slate-800 rounded-full overflow-hidden ml-auto" title={`Super-score ${r.superScore ?? '—'}/100`}>
                      <div className={`h-full rounded-full ${scorePct >= 85 ? 'bg-fuchsia-400' : scorePct >= 80 ? 'bg-emerald-400' : scorePct >= 65 ? 'bg-cyan-400' : 'bg-amber-400'}`} style={{ width: `${scorePct}%` }} />
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
                  <span className="px-1.5 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 font-black" title="100% CoinDCX Wallet Auto-Deployment + Wallet-Tier Leverage (< ₹10,000 → 10x · ≥ ₹10,000 → 5x)">
                    ⚡ 100% Wallet · {activeLeverage}x LEV
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
                    {r.autoEligible
                      ? <span className="px-1.5 py-0.5 rounded text-[9px] font-black border border-emerald-500/50 text-emerald-300 bg-emerald-500/10" title="Full confirm: score≥bar + trigger fired + TF-fit GOOD/OK + dual aligned + not counter-trend + grade A/B + cost<0.5R">✅ AUTO-READY</span>
                      : <span className="px-1.5 py-0.5 rounded text-[9px] font-black border border-slate-500/40 text-slate-400" title={(r.autoBlockers || []).join(' · ') || 'blocked'}>⛔ {r.autoBlockers?.[0] || 'blocked'}{(r.autoBlockers?.length || 0) > 1 ? ` +${(r.autoBlockers?.length || 0) - 1}` : ''}</span>}
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
                    {canLive && rowLiveReady && (
                      <button
                        onClick={() => void onLiveOrder(r)}
                        disabled={liveOrdering === r.symbol || busy}
                        title={`Place real CoinDCX Futures ${r.side} order (${activeLeverage}x leverage — Wallet ₹${Math.round(effectiveWalletINR).toLocaleString('en-IN')}) — sirf direction-verified, non-counter-HTF setups`}
                        className="px-1.5 py-0.5 rounded text-[9px] font-black border border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 disabled:opacity-40">
                        {liveOrdering === r.symbol ? '…' : `⚡ LIVE ${activeLeverage}x`}
                      </button>
                    )}
                    {onDeep && (
                      <button onClick={() => onDeep(r.symbol, r.market as MarketKind)} title="Deep analysis + MTF trade plan kholo"
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
        <div>• <b className="text-slate-400">One-Click Live Auto-Trade & Deep Monitor</b>: 100% CoinDCX Futures Wallet deployment (<b className="text-slate-400">&lt; ₹10,000 → 10x · ≥ ₹10,000 → 5x</b>) + Full Control of CoinDCX Active Positions (Sirf Active Traded Positions) + 15s Live Signal Recheck + 5-Stage Dynamic SL Trailing & Reversal Profit-Booking until TP1/TP2.</div>
      </div>
    </div>
  );
});
