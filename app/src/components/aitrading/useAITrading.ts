// ============================================================
// src/components/aitrading/useAITrading.ts — data hook
// ------------------------------------------------------------
// Polls the /api/ai/* endpoints on a staggered cadence and exposes
// execute / config / kill-switch / close actions with honest
// loading + error states. Signals refresh every 30s (active tab
// only), options desk on demand per index.
// v7.0.1: positions poll is now DYNAMIC — 10s while any position is
// OPEN (realtime LTP + uPnL feel, server caches make it cheap), 45s
// when flat. Open positions are exactly when the user is watching.
//
// v10.5.3 REALTIME POSITIONS: while any position is open the hook
// subscribes to /api/ai/positions/stream (SSE) and merges per-row
// {ltp, unrealizedPnl} deltas in place — the panel updates on every
// price tick, price-driven (the old 5s REST poll is kept ONLY as the
// disconnect fallback + 45s reconciliation while streaming).
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getProxyBase, getSessionToken } from '../../utils/api';
import { createTickBatcher } from '../../utils/tickBatcher';
import { desktopNotify, desktopNotifyPermission } from '../../utils/desktopNotify';
import type { AISignal, OptionsDesk, OptionSignalsView, OptionsScanView, SignalBoard, TradingState, JournalPosition, JournalEntry, BacktestResult, StrategyLabResult, AlertsStatus, DhanStatus, SwingBoard, WhaleRadar, LedgerView, MorningBrief, OrderbookView, AgentView, WalletView, MarketKind, TrustView, PerfView, CorrView, SectorView, IncomeView, NarrativeView, EdgeStats, LtfSnapshot, CouncilStatusView, CouncilStamp, CouncilCalibrationView, NearMissEntry, FuturesPrecheckResult } from './types';

export interface DeepSignalResult {
  ok: boolean;
  signal?: AISignal;
  indicators?: Record<string, unknown>;
  /** v6.11: rule-based regime story (glama explain_ticker). */
  narrative?: NarrativeView | null;
  /** v6.12: LTF (15m/1h) indicator snapshot + walk-forward edge stats. */
  ltf?: LtfSnapshot | null;
  edge?: EdgeStats | null;
  priceSource?: string | null;
  /** v20.7.5: server compute-time stamp — the deep modal's freshness
   *  chip + 15s auto-recheck cadence read this (fresh=1 runs compute
   *  NOW; cached answers carry the original compute time). */
  recheckedAt?: number | null;
  error?: string;
}

export interface ExecuteResult {
  ok: boolean;
  error?: string;
  mode?: string;
  orderId?: string | null;
  filled?: { qty: number; price: number; notionalINR: number; leverage?: number; marginINR?: number };
  position?: JournalPosition;
  /** v6.4: set when the ATR stop was auto-fitted to the risk cap. */
  fitted?: string;
  /** v7.0.2: notify-mode server note (alert-only — no order/position). */
  note?: string;
}

/** v6.6: sizing + leverage parameters for a ticket execute. */
export interface ExecuteOpts {
  /** crypto: the MARGIN you commit (₹); india: the capital budget (₹) */
  qtyINR?: number;
  /** crypto only — clamped server-side to config.cryptoLeverage */
  leverage?: number;
}

/** v10.5.3: how the positions panel is being fed right now —
 *  'stream' = SSE diff-push (live, price-driven), 'poll' = REST
 *  fallback (5s while open), null = flat / not connected. */
export type PositionsFeed = 'stream' | 'poll' | null;

/** A per-position delta pushed by /api/ai/positions/stream `tick`. */
interface PositionTick {
  id: string;
  ltp?: number | null;
  unrealizedPnlINR?: number | null;
  unrealizedPnlUSDT?: number | null;
  usdInr?: number | null;
  priceSource?: string | null;
  sl?: number | null;
  tp?: number | null;
  tp2?: number | null;
  trailing?: 'breakeven' | 'trail' | null;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  exitStage?: string | null;
  qty?: number;
  ts?: number;
}

export function useAITrading(active: boolean, scope?: { markets?: Array<'INDIA' | 'CRYPTO' | 'FUTURES' | 'GLOBALFUTURES' | 'METALS'> }) {
  // v6.9: market-scoped loading — the India desk only pays for the India
  // board; the CoinDCX desk loads spot + futures. Default = all (legacy).
  // v21.8.0: + METALS — the GOLD (XAU/USDT) + SILVER (XAG/USDT) desk.
  const markets = scope?.markets ?? ['INDIA', 'CRYPTO', 'FUTURES'];
  const [india, setIndia] = useState<SignalBoard | null>(null);
  const [crypto, setCrypto] = useState<SignalBoard | null>(null);
  const [futures, setFutures] = useState<SignalBoard | null>(null);
  const [globalFut, setGlobalFut] = useState<SignalBoard | null>(null); // v10.4 GLOBAL equity futures SIM desk
  const [metals, setMetals] = useState<SignalBoard | null>(null); // v21.8.0 GOLD XAU + SILVER XAG perps desk (CoinDcxTab)
  const [state, setState] = useState<TradingState | null>(null);
  const [positions, setPositions] = useState<JournalPosition[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // v7.0.2: board fetch failure state — a dead API used to render NOTHING
  // between the section header and the next section (silent hole).
  const [boardError, setBoardError] = useState(false);
  // v21.4.1 [D3]: PER-MARKET board errors — purana boardError all-or-nothing
  // tha: CoinDcxTab dono desks (FUTURES+GLOBALFUTURES) ek hi hook se padhta
  // hai, ek desk 500 de aur doosra 200 → boardError false rehta hai aur
  // fail hone wale desk ka section SILENT HOLE ban jaata tha (loading bhi
  // nahi, unreachable panel bhi nahi). Ab har desk ka apna error flag hai.
  const [boardErrors, setBoardErrors] = useState<Record<string, boolean>>({});
  // v10.5.3 REALTIME POSITIONS: feed mode + reconnect epoch
  const [positionsLive, setPositionsLive] = useState<PositionsFeed>(null);
  const [positionsEpoch, setPositionsEpoch] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  // v10.18 (deep-recheck #3): positions request sequence guard. Up to four
  // uncoordinated callers race through loadPositions (the 45s SSE-live
  // reconciliation poll, the 5s fallback poll, closePos/executeSignal
  // refreshes, the visibility refresh) — a slow REST response landing
  // AFTER a newer one used to wholesale-revert the panel (and a poll
  // started BEFORE a close that resolved AFTER closePos's own refresh
  // resurrected the just-closed position as OPEN for up to 45s). Only
  // the LATEST request's response applies.
  const posSeqRef = useRef(0);
  // v21.13.x recheck (P3): boards request sequence guard — loadPositions
  // ka exact pattern. The 30s interval can overlap a slow poll (30s abort
  // timeout) ya rescan (90s); a LATE older response overwriting a NEWER
  // board = a brief stale flash (re-ranked cards snap back). Sirf the
  // LATEST loadBoards call applies its responses.
  const boardsSeqRef = useRef(0);

  const loadBoards = useCallback(async (opts?: { rescan?: boolean }) => {
    const seq = ++boardsSeqRef.current;
    // v12.5 RESCAN: ?rescan=1 → server-side noCache — a FULL fresh
    // universe scan (single-flight on the server). Cold scans are
    // heavier than the 60s-cache read — the timeout widens so a slow
    // universe (India 500+ names / 100+ pairs) can never race the abort.
    const rescan = !!opts?.rescan;
    const timeoutMs = rescan ? 90_000 : 30_000;
    // v12.7 BANDWIDTH: the `t=${Date.now()}` cache-buster is GONE — every
    // 30s poll used to force a full re-download of the (identical)
    // 100-400KB board inside the server's 60s cache window. Without the
    // buster, Express's weak ETag answers 304 for the byte-identical
    // cached board (zero body transfer). RESCAN keeps a distinct URL
    // (&rescan=1) so it always bypasses caches — by design.
    const qs = (m: string) => `market=${m}&limit=10${rescan ? '&rescan=1' : ''}`;
    const jobs: Array<Promise<void>> = [];
    let anyOk = false;
    const markOk = () => { anyOk = true; };
    const markMkt = (m: string, ok: boolean) => {
      setBoardErrors(prev => ((prev[m] ?? false) !== ok ? { ...prev, [m]: ok } : prev));
    };
    // v18.5 FIX: a 304 (ETag revalidation of the byte-identical cached
    // board) is NOT a failure — it means "board unchanged, server healthy".
    // The old `r.ok ? r.json() : null` treated 304 as an error: state was
    // kept but markOk() was skipped → the tab flipped to "Signal board
    // unreachable" for a minute after every reload/revalidation. Now:
    // 304 → keep state + mark healthy; 200 → parse + set + mark healthy.
    const boardJob = (m: string, setter: (b: unknown) => void) =>
      apiFetch(`${getProxyBase()}/api/ai/signals?${qs(m)}`, { signal: AbortSignal.timeout(timeoutMs) })
        .then(r => {
          if (r.status === 304) { markOk(); markMkt(m, false); return 'KEEP'; } // sentinel — state stays, healthy
          if (!r.ok) return null;
          return r.json().catch(() => null);
        }).catch(() => null)
        .then(j => {
          if (seq !== boardsSeqRef.current) return; // stale response — a newer loadBoards already landed
          if (j === 'KEEP') return; // 304 revalidation — board unchanged, healthy
          if (j) { setter(j); markOk(); markMkt(m, false); _notifyNewStrongs(m, j); }
          else markMkt(m, true); // v21.4.1 [D3]: fetch/parse fail — sirf YE desk error me
        });
    if (markets.includes('INDIA')) jobs.push(boardJob('INDIA', setIndia as (b: unknown) => void));
    if (markets.includes('CRYPTO')) jobs.push(boardJob('CRYPTO', setCrypto as (b: unknown) => void));
    if (markets.includes('FUTURES')) jobs.push(boardJob('FUTURES', setFutures as (b: unknown) => void));
    if (markets.includes('GLOBALFUTURES')) jobs.push(boardJob('GLOBALFUTURES', setGlobalFut as (b: unknown) => void));
    if (markets.includes('METALS')) jobs.push(boardJob('METALS', setMetals as (b: unknown) => void));
    await Promise.allSettled(jobs);
    if (seq !== boardsSeqRef.current) return; // stale call — the newer load owns the flags
    setBoardError(!anyOk); // v7.0.2: every requested board failed
    setLoading(false);
  }, [markets.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // v12.5 RESCAN — the user's "button click → fresh top trade signals"
  // lever: busts the 60s server cache for every desk this hook serves
  // and re-runs the FULL ensemble scan (deep-AI agent, fresh prices,
  // fresh consensus, fresh guards). Guarded against double-fire (the
  // button disables itself while a scan runs — a cold India scan can
  // take tens of seconds).
  const [rescanning, setRescanning] = useState(false);
  const rescan = useCallback(async () => {
    if (rescanning) return;
    setRescanning(true);
    try { await loadBoards({ rescan: true }); }
    finally { setRescanning(false); }
  }, [rescanning, loadBoards]);

  const loadState = useCallback(async () => {
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/trading/state`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) setState(await r.json());
    } catch { /* skip */ }
  }, []);

  const loadPositions = useCallback(async () => {
    const seq = ++posSeqRef.current;
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/positions`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const j = await r.json();
        if (seq !== posSeqRef.current) return; // stale response — a newer load already landed
        setPositions(Array.isArray(j.positions) ? j.positions : []);
        setEntries(Array.isArray(j.entries) ? j.entries : []);
      }
    } catch { /* skip */ }
  }, []);

  // Boot + staggered polling (active tab only — background tabs cost zero).
  const hasOpen = positions.some(p => p.status === 'OPEN');
  useEffect(() => {
    if (!active) return;
    loadBoards();
    loadState();
    loadPositions();
  }, [active, loadBoards, loadState, loadPositions]);
  useEffect(() => {
    if (!active) return;
    // v20.5 LATENCY: 30s board polling (was 60s) so a fresh signal
    // surfaces within the user's 30s target. The server-side cache is
    // 60s so most polls answer 304-equivalent (cache hit) — bandwidth
    // stays low. The cache TTL > poll cadence is the intended pattern
    // (the panel re-renders with the SAME payload until the next
    // 60s server re-compute). Combined with the SSE tick re-rank in
    // signals.js / useIntradayStream the top-5 panel also moves on
    // live price between board cycles.
    const b = setInterval(() => { if (activeRef.current && !document.hidden) loadBoards(); }, 30_000);
    const s = setInterval(() => { if (activeRef.current && !document.hidden) loadState(); }, 30_000);
    return () => { clearInterval(b); clearInterval(s); };
  }, [active, loadBoards, loadState]);

  // -----------------------------------------------------------------
  // v10.5.3 REALTIME POSITIONS — SSE diff-push while positions are
  // open (the real "ULTRA STREAM"; the old path was a 5s REST poll).
  //   • `positions` event → full snapshot (connect + structural
  //     changes: open/close/partial) — replaces the rows wholesale.
  //   • `tick` event → { id, ltp, unrealizedPnl, ... } — buffered and
  //     applied in ONE batched state update every 800ms (v10.17 perf
  //     fix: the per-event setPositions re-rendered the whole tab
  //     5-15×/sec — the console "lag"). Only the LATEST delta per id
  //     survives in a flush window; hidden tabs render zero times.
  //     (SSE delivery is ordered — the structural `positions` event
  //     always precedes its own ticks, so unknown-id merges are a
  //     non-race; the 45s REST reconciliation covers any drift.)
  //   • onerror → EventSource auto-reconnects; until it does, the
  //     REST poll below drops back to its fast 5s fallback cadence.
  //   • visibility: returning to the tab forces an immediate flush +
  //     REST refresh + a fresh socket (prices moved while backgrounded).
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!active || !hasOpen) {
      setPositionsLive(null);
      return;
    }
    const session = getSessionToken();
    const url = session
      ? `${getProxyBase()}/api/ai/positions/stream?session=${encodeURIComponent(session)}`
      : `${getProxyBase()}/api/ai/positions/stream`;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined; // v20.3: stale-token re-attach
    try { es = new EventSource(url); } catch { return; }
    const src = es;

    const batcher = createTickBatcher<PositionTick>((deltas) => {
      setPositions(prev => {
        const byId = new Map(deltas.map(d => [d.id, d]));
        let changed = false;
        const next = prev.map(p => {
          const d = byId.get(p.id);
          if (!d) return p;
          changed = true;
          return { ...p, ...d };
        });
        return changed ? next : prev;
      });
    }, { intervalMs: 800 });

    src.onopen = () => setPositionsLive('stream');
    src.addEventListener('positions', (e) => {
      try {
        const j = JSON.parse((e as MessageEvent).data);
        batcher.flushNow(); // structural snapshot replaces buffered ticks
        // v18.9: the SSE structural snapshot must WIN over any in-flight
        // older REST response — bump the sequence exactly like the REST
        // loader does (an agent-close at t1.0 used to get resurrected by
        // a stale REST read landing at t1.5 because SSE never bumped the
        // guard — the server only pushes on structural change, so it
        // wouldn't re-send either).
        posSeqRef.current += 1;
        if (Array.isArray(j.positions)) setPositions(j.positions);
        if (Array.isArray(j.entries)) setEntries(j.entries);
      } catch { /* malformed frame */ }
    });
    src.addEventListener('tick', (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as PositionTick;
        batcher.push(d);
      } catch { /* malformed frame */ }
    });
    src.onerror = () => {
      setPositionsLive('poll');
      // v20.3: EventSource's native reconnect re-tries the SAME stale-token
      // URL forever after a re-login. Close and re-attach with a FRESH
      // url (epoch re-runs this effect, rebuilding it) — the 5s fallback
      // poll covers the gap.
      try { src.close(); } catch { /* noop */ }
      if (!retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = undefined; setPositionsEpoch(n => n + 1); }, 10_000);
      }
    };

    // Reconnect-on-visibility: force REST refresh + resubscribe when the
    // tab comes back (covers "prices moved a lot while backgrounded").
    const onVis = () => {
      if (!document.hidden) {
        batcher.flushNow();
        loadPositions();
        setPositionsEpoch(n => n + 1); // re-runs this effect → fresh socket
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (retryTimer) clearTimeout(retryTimer);
      batcher.dispose();
      try { src.close(); } catch { /* noop */ }
      setPositionsLive(null);
    };
  }, [active, hasOpen, positionsEpoch, loadPositions]);

  // REST poll — now the FALLBACK + reconciliation path: 5s while any
  // position is open AND the stream is down; relaxed to 45s while the
  // SSE stream is live (it pushes every change anyway; the periodic
  // REST pass only reconciles book-keeping the stream doesn't carry).
  useEffect(() => {
    if (!active) return;
    const fast = hasOpen && positionsLive !== 'stream';
    const p = setInterval(() => { if (activeRef.current && !document.hidden) loadPositions(); }, fast ? 5_000 : 45_000);
    return () => clearInterval(p);
  }, [active, loadPositions, hasOpen, positionsLive]);

  const executeSignal = useCallback(async (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: ExecuteOpts): Promise<ExecuteResult> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: signal.symbol, side: signal.side, mode,
          ...(opts?.qtyINR != null ? { qtyINR: opts.qtyINR } : {}),
          ...(opts?.leverage != null ? { leverage: opts.leverage } : {}),
        }),
        signal: AbortSignal.timeout(40000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      loadPositions(); loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadPositions, loadState]);

  const updateConfig = useCallback(async (patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/trading/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (j.ok) loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadState]);

  const killSwitch = useCallback(async (enabled: boolean) => updateConfig({ killSwitch: enabled }), [updateConfig]);

  const closePos = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/positions/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      loadPositions(); loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadPositions, loadState]);

  // v6.3 PRO: deep single-symbol analysis (every model vote, fresh run,
  // AI Council note) — powers the 🔬 button on each signal card.
  // v20.7.5: `fresh` (default ON for user clicks) adds ?fresh=1 — the
  // server BYPASSES its 30s deep cache and runs the ensemble NOW. The
  // "deep analysis galat/purana data dikha rahi thi" report was exactly
  // this: a cached answer older than the board card it sat next to.
  // The 15s modal auto-recheck calls with fresh=false and rides the cache.
  const fetchDeep = useCallback(async (symbol: string, market: MarketKind, opts?: { fresh?: boolean }): Promise<DeepSignalResult> => {
    try {
      const freshQ = (opts?.fresh !== false) ? '&fresh=1' : '';
      const r = await apiFetch(`${getProxyBase()}/api/ai/deep/${encodeURIComponent(symbol)}?market=${market}${freshQ}&t=${Date.now()}`, {
        signal: AbortSignal.timeout(40000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    }
  }, []);

  // v6.5: India gauntlet execution (Dhan paper/live) — same flow shape
  // as the crypto execute so the cards can share one handler.
  const executeIndia = useCallback(async (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: ExecuteOpts): Promise<ExecuteResult> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/india/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: signal.symbol, side: signal.side, mode, ...(opts?.qtyINR != null ? { qtyINR: opts.qtyINR } : {}) }),
        signal: AbortSignal.timeout(40000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      loadPositions(); loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadPositions, loadState]);

  // v6.5: walk-forward backtest (per desk).
  const runBacktest = useCallback(async (market: 'INDIA' | 'CRYPTO', minGrade = 'ACTION', opts: { walkForward?: boolean } = {}): Promise<BacktestResult | null> => {
    try {
      // v21.1.1 [audit A5]: walk-forward toggle — server pe ?walkForward=1
      // tha par UI se kabhi send nahi hota tha (Phase-4 feature browser
      // se unreachable tha). BacktestPanel ab toggle deta hai.
      const wf = opts.walkForward ? '&walkForward=1' : '';
      const r = await apiFetch(`${getProxyBase()}/api/ai/backtest?market=${market}&minGrade=${minGrade}${wf}&t=${Date.now()}`, {
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }, []);

  // v10.8: NL Custom Strategy Lab — description → bounded rules → replay.
  const runStrategyLab = useCallback(async (
    description: string,
    market: 'INDIA' | 'CRYPTO' = 'CRYPTO',
  ): Promise<StrategyLabResult | null> => {
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/strategy-lab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, market }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return { ok: false, error: j?.error || `lab failed (${r.status})` } as StrategyLabResult;
      return j;
    } catch { return { ok: false, error: 'lab request failed — network/timeout' } as StrategyLabResult; }
  }, []);

  // v6.5: alerts + AI council keys.
  const fetchAlertsStatus = useCallback(async (): Promise<AlertsStatus | null> => {
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/alerts/config?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }, []);

  const saveAlertsConfig = useCallback(async (patch: Record<string, string | null>): Promise<{ ok: boolean; error?: string; status?: AlertsStatus['status'] }> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/alerts/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(15000),
      });
      return await r.json().catch(() => ({ ok: false, error: 'bad response' }));
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, []);

  const testAlert = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/alerts/test`, { method: 'POST', signal: AbortSignal.timeout(20000) });
      return await r.json().catch(() => ({ ok: false, error: 'bad response' }));
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, []);

  // v6.8: GLOBAL FUTURES gauntlet execution (CoinDCX USDT perps).
  const executeFutures = useCallback(async (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; marginUSDT?: number; leverage?: number }): Promise<ExecuteResult> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/futures/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: signal.symbol, side: signal.side, mode,
          ...(opts?.qtyINR != null ? { qtyINR: opts.qtyINR } : {}),
          ...(opts?.marginUSDT != null ? { marginUSDT: opts.marginUSDT } : {}),
          ...(opts?.leverage != null ? { leverage: opts.leverage } : {}),
        }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      loadPositions(); loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadPositions, loadState]);

  // v21.3.0 (Issue-4): READ-ONLY pre-flight for the ⚡ EXECUTE LIVE modal —
  // the same gauntlet + would-be ticket, dry-run (koi order nahi lagta).
  const futuresPrecheck = useCallback(async (signal: AISignal, opts?: { marginUSDT?: number; leverage?: number }): Promise<FuturesPrecheckResult | null> => {
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/futures/execute/precheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: signal.symbol, side: signal.side,
          ...(opts?.marginUSDT != null ? { marginUSDT: opts.marginUSDT } : {}),
          ...(opts?.leverage != null ? { leverage: opts.leverage } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }, []);

  // v10.4: GLOBAL EQUITY FUTURES SIM desk execution (AAPL/MSFT/GOOGL/
  // AMZN/NVDA/TSLA/META + SPACEX — paper/notify only; the server rejects
  // LIVE honestly because CoinDCX par ye contracts listed nahi hain).
  const executeGlobal = useCallback(async (signal: AISignal, mode: 'paper' | 'live' | 'notify', opts?: { qtyINR?: number; marginUSDT?: number; leverage?: number }): Promise<ExecuteResult> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/global/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: signal.symbol, side: signal.side, mode, // 'live' server pe gate-0 REJECT hota hai with the honest SIM-desk reason
          ...(opts?.qtyINR != null ? { qtyINR: opts.qtyINR } : {}),
          ...(opts?.marginUSDT != null ? { marginUSDT: opts.marginUSDT } : {}),
          ...(opts?.leverage != null ? { leverage: opts.leverage } : {}),
        }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      loadPositions(); loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadPositions, loadState]);

  // v6.5: Dhan broker connect/status.
  const fetchDhanStatus = useCallback(async (): Promise<DhanStatus | null> => {
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/dhan/status?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }, []);

  const dhanConnect = useCallback(async (clientId: string, accessToken: string): Promise<{ ok: boolean; error?: string }> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/dhan/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, accessToken }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (j.ok) loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadState]);

  const dhanDisconnect = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setBusy(true);
    try {
      const r = await apiFetch(`${getProxyBase()}/api/ai/dhan/disconnect`, { method: 'POST', signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (j.ok) loadState();
      return j;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    } finally { setBusy(false); }
  }, [loadState]);

  return {
    india, crypto, futures, globalFut, metals, state, positions, entries, loading, busy, boardError,
    /** v21.4.1 [D3]: per-market board errors — ek desk fail ho aur doosra
     *  chal raha ho to CoinDcxTab sirf FAIL desk ka honest unreachable
     *  panel dikhata hai (silent hole nahi). Key = market name. */
    boardErrors,
    /** v10.5.3: 'stream' = SSE live push, 'poll' = REST fallback, null = flat. */
    positionsLive,
    refresh: loadBoards, executeSignal, updateConfig, killSwitch, closePos, fetchDeep,
    /** v12.5: RESCAN — full fresh universe scan (server cache bypassed);
     *  rescanning = a cold scan is in flight (button's busy state). */
    rescan, rescanning,
    /** v10.17: explicit positions/entries refetch (clear-closed button etc). */
    refreshPositions: loadPositions,
    executeIndia, runBacktest, runStrategyLab, fetchAlertsStatus, saveAlertsConfig, testAlert,
    fetchDhanStatus, dhanConnect, dhanDisconnect, executeFutures, futuresPrecheck, executeGlobal,
  };
}

// Options desk fetch (per-index, on demand with 60s client cache).
const deskCache = new Map<string, { at: number; data: OptionsDesk }>();

// v21.7.0 (Issue-1) STALE-FOREVER FIX: error fallbacks pehle LAST-CACHED
// payload ko hamesha ke liye serve karte the (koi max-age nahi) — ek lambi
// backend hiccup/session-expiry par F&O cards ghanton-purane entry/exit
// dikhate rehte the aur "live" lagte the. Ab har options-family fallback
// MAX-AGE capped hai: signal cards (trade decisions) 2 min, desk 10 min,
// scan 2 min. Uske baad null → UI honest STALE/error state dikhaata hai.
const OPTION_SIGNALS_STALE_MAX_MS = 2 * 60_000;
const OPTIONS_DESK_STALE_MAX_MS = 10 * 60_000;
const OPTIONS_SCAN_STALE_MAX_MS = 2 * 60_000;

// v20.2 DESKTOP PUSH — fires a native OS notification when a NEW
// STRONG/ELITE signal lands on any served board while the tab is
// hidden (the visible tab doesn't need a toast — it IS the display).
// Per (market:symbol:side) dedup — a 60s refresh of the same signal
// never re-pings. Permission must be granted via the AlertsPanel
// button (browser policy requires a user gesture).
const _seenStrongs = new Set<string>();
function _notifyNewStrongs(market: string, board: unknown): void {
  try {
    if (desktopNotifyPermission() !== 'granted') return;
    if (!document.hidden) return;
    const sigs = (board as { signals?: Array<{ symbol?: string; side?: string; grade?: string; superIntel?: { aiScore?: number }; confidence?: number; plan?: { entry?: number; stopLoss?: number } }> })?.signals;
    if (!Array.isArray(sigs) || sigs.length === 0) return;
    for (const s of sigs) {
      const strong = s?.grade === 'STRONG' || (s?.superIntel?.aiScore ?? 0) >= 80;
      if (!strong || !s?.symbol || !s?.side) continue;
      const key = `${market}:${s.symbol}:${s.side}`;
      if (_seenStrongs.has(key)) continue;
      _seenStrongs.add(key);
      // v20.3: bound the set — FIFO eviction of the OLDEST half. The old
      // bulk clear() forgot every key at once, so still-live signals
      // re-toasted for a whole board cycle right after the 400-key cap.
      if (_seenStrongs.size > 400) {
        const it = _seenStrongs.values();
        for (let k = 0; k < 200; k++) { const r = it.next(); if (r.done) break; _seenStrongs.delete(r.value); }
      }
      const ai = s.superIntel?.aiScore ?? s.confidence ?? 0;
      const body = `${s.side} · AI score ${Math.round(ai)} · conf ${Math.round(s.confidence ?? 0)}%`
        + (s.plan?.entry != null ? ` · entry ${s.plan.entry} · SL ${s.plan.stopLoss ?? '—'}` : '');
      desktopNotify(`⚡ ${s.symbol} — STRONG signal (${market})`, body);
      break; // one toast per board cycle (throttled 30s in desktopNotify)
    }
  } catch { /* notifications are always optional */ }
}
export async function fetchOptionsDesk(symbol: string, force = false): Promise<OptionsDesk | null> {
  const hit = deskCache.get(symbol);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.data;
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/options?symbol=${symbol}&t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return (hit && Date.now() - hit.at < OPTIONS_DESK_STALE_MAX_MS) ? hit.data : null;
    const data = await r.json();
    deskCache.set(symbol, { at: Date.now(), data });
    return data;
  } catch { return (hit && Date.now() - hit.at < OPTIONS_DESK_STALE_MAX_MS) ? hit.data : null; }
}

// v9.4 — F&O OPTION SIGNAL CARDS (NIFTY + SENSEX, one request; client
// cache 30s = server's 30s re-rank cadence — v21.7.0: 60s se 30s, har
// strip poll fresh view laata hai).
let _optSigCache: { at: number; data: OptionSignalsView } | null = null;
export async function fetchOptionSignals(force = false): Promise<OptionSignalsView | null> {
  if (!force && _optSigCache && Date.now() - _optSigCache.at < 30_000) return _optSigCache.data;
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/option-signals?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return (_optSigCache && Date.now() - _optSigCache.at < OPTION_SIGNALS_STALE_MAX_MS) ? _optSigCache.data : null;
    const data = await r.json();
    _optSigCache = { at: Date.now(), data };
    return data;
  } catch { return (_optSigCache && Date.now() - _optSigCache.at < OPTION_SIGNALS_STALE_MAX_MS) ? _optSigCache.data : null; }
}

// v10.17 — WHOLE-F&O OPTIONS SCANNER (indices + top stock underlyings,
// one ranked view; server 90s cached, client 45s).
let _optScanCache: { at: number; data: OptionsScanView } | null = null;
export async function fetchOptionsScan(force = false): Promise<OptionsScanView | null> {
  if (!force && _optScanCache && Date.now() - _optScanCache.at < 45_000) return _optScanCache.data;
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/options-scan${force ? '?fresh=1' : ''}`, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) return (_optScanCache && Date.now() - _optScanCache.at < OPTIONS_SCAN_STALE_MAX_MS) ? _optScanCache.data : null;
    const data = await r.json();
    _optScanCache = { at: Date.now(), data };
    return data;
  } catch { return (_optScanCache && Date.now() - _optScanCache.at < OPTIONS_SCAN_STALE_MAX_MS) ? _optScanCache.data : null; }
}

// v10.17 — CLEAR CLOSED POSITIONS (Execution Console button). Server
// purges CLOSED rows from the journal (the tamper-evident LEDGER keeps
// the permanent audit trail) and stamps a HOUSEKEEP entry.
export async function clearClosedPositions(): Promise<{ ok: boolean; removed?: number; error?: string }> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/positions/clear-closed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });
    return await r.json().catch(() => ({ ok: false, error: 'bad response' }));
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// ---------------- v11.0: GLOBAL MARKET COUNCIL fetchers ----------------
// Module-level + client-cached (the fetchOptionsDesk pattern): the
// stamps themselves ride the signal BOARD (30s poll, zero extra cost);
// these fetchers cover status / near-miss / deep verdicts / calibration.
// Panels poll them on 60s+ cadences with document.hidden gates.
let _councilStatusCache: { at: number; data: CouncilStatusView } | null = null;
export async function fetchCouncilStatus(force = false): Promise<CouncilStatusView | null> {
  if (!force && _councilStatusCache && Date.now() - _councilStatusCache.at < 60_000) return _councilStatusCache.data;
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/council/status?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return _councilStatusCache?.data || null;
    const data = await r.json();
    _councilStatusCache = { at: Date.now(), data };
    return data;
  } catch { return _councilStatusCache?.data || null; }
}

let _nearMissCache: { at: number; data: { ok: boolean; entries: NearMissEntry[]; stats: { total: number; last24h: number; byReason: [string, number][] } } } | null = null;
export async function fetchCouncilNearMiss(force = false, limit = 25): Promise<NearMissEntry[]> {
  if (!force && _nearMissCache && Date.now() - _nearMissCache.at < 60_000) return _nearMissCache.data?.entries || [];
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/council/near-miss?limit=${limit}&t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return _nearMissCache?.data?.entries || [];
    const data = await r.json();
    _nearMissCache = { at: Date.now(), data };
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch { return _nearMissCache?.data?.entries || []; }
}

/** DEEP council verdict for ONE symbol (6 seats + debate + judge;
 *  user-initiated deep-dives only — ~9 LLM calls when uncached). */
export async function fetchCouncilVerdict(symbol: string, market: string, force = false): Promise<CouncilStamp | null> {
  const cacheKey = `v:${market}:${symbol}`;
  const hit = _verdictCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < 90_000) return hit.data;
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/council/verdict/${encodeURIComponent(symbol)}?market=${encodeURIComponent(market)}${force ? '&fresh=1' : ''}`, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) return hit?.data || null;
    const j = await r.json();
    const stamp = j?.stamp || null;
    if (stamp) _verdictCache.set(cacheKey, { at: Date.now(), data: stamp });
    return stamp;
  } catch { return hit?.data || null; }
}

let _councilCalCache: { at: number; data: CouncilCalibrationView } | null = null;
export async function fetchCouncilCalibration(force = false): Promise<CouncilCalibrationView | null> {
  if (!force && _councilCalCache && Date.now() - _councilCalCache.at < 60_000) return _councilCalCache.data;
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/council/calibration?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return _councilCalCache?.data || null;
    const data = await r.json();
    _councilCalCache = { at: Date.now(), data };
    return data;
  } catch { return _councilCalCache?.data || null; }
}

const _verdictCache = new Map<string, { at: number; data: CouncilStamp }>();
if (typeof setInterval === 'function') {
  const t = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of _verdictCache) if (v.at < cutoff) _verdictCache.delete(k);
    // v20.7.12 [M-7]: deskCache pe bhi wahi sweeper — per-symbol Map kabhi
    // evict nahi hota tha (unbounded growth in long sessions; hit-TTL sirf
    // READ path pe kaam karta hai, stale entries hamesha rehte the).
    for (const [k, v] of deskCache) if (v.at < cutoff) deskCache.delete(k);
  }, 5 * 60_000);
  t.unref?.();
}

// ---------------- v6.7: swing · whales · ledger · brief · orderbook ----------------
export async function fetchSwingBoard(market: MarketKind): Promise<SwingBoard | null> {
  const m = market === 'INDIA' ? 'INDIA' : 'CRYPTO'; // futures → underlying crypto desk
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/swing?market=${m}&t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---------------- v21.15.0 MTF TRADE PLAN (15m→5m · 1h→15m · 5m→1m) ----------------
export type TradePlanModeId = 'INTRADAY' | 'SWING' | 'SCALP';

export interface TradePlanView {
  ok: boolean;
  error?: string;
  symbol?: string | null;
  market?: string;
  quoteCcy?: 'USDT' | 'USDC' | 'INR';
  mode?: TradePlanModeId;
  modeLabel?: string;
  contextTf?: string;
  triggerTf?: string;
  holdMin?: number;
  ltp?: number | null;
  ts?: number;
  asOf?: number;
  bias?: string;
  side?: 'LONG' | 'SHORT' | null;
  dir?: number;
  grade?: 'A' | 'B' | 'C';
  confidence?: number;
  alignedWithContext?: boolean;
  counterTrend?: boolean;
  triggerFired?: boolean;
  directionVerified?: boolean;
  trapVeto?: boolean;
  zoneWallVeto?: boolean;
  worldIndicators?: {
    alignedCount: number | null;
    totalCount: number;
    aligned8Count?: number | null;
    total8Count?: number;
    confluencePct: number | null;
    estimatedWinRatePct: number | null;
    directionVerified?: boolean;
    trapVeto?: boolean;
    zoneWallVeto?: boolean;
    highAccuracy95Ready?: boolean;
    chandelierStop?: number | null;
    institutional8?: Array<{ id: string; label: string; dir?: number; aligned: boolean; detail?: string }>;
  } | null;
  context?: {
    tf?: string; dir?: number; score?: number; trend?: string | null; structure?: string;
    close?: number; ema20?: number | null; ema50?: number | null; ema200?: number | null;
    rsi?: number | null; rsiRead?: string; adx?: number | null; atr?: number | null; atrPct?: number | null;
    macdHist?: number | null; supertrend?: string | null; vwap?: number | null; vwapDistPct?: number | null;
    slope?: number | null; note?: string; bars?: number;
  } | null;
  trigger?: {
    tf?: string; score?: number; broke?: boolean; volRatio?: number | null; bodyPct?: number | null;
    rsi?: number | null; macdHist?: number | null; atr?: number | null; atrPct?: number | null;
    ema9?: number | null; ema20?: number | null; vwap?: number | null; distEma20Pct?: number | null;
    overextended?: boolean; pullbackReclaim?: boolean; patterns?: string[];
    lastBar?: { time?: number; open?: number; high?: number; low?: number; close?: number };
    prevBar?: { high?: number | null; low?: number | null };
    bars?: number;
  } | null;
  plan?: {
    entry?: number | null; entryZoneLow?: number | null; entryZoneHigh?: number | null;
    pullbackEntry?: number | null; breakoutEntry?: number | null;
    triggerLevel?: number | null; invalidateLevel?: number | null;
    stopLoss?: number | null; stopBasis?: string; stopPct?: number | null; riskPerShare?: number | null;
    t1?: number | null; t2?: number | null; nearestStructureTarget?: number | null;
    wideStructureStop?: number | null; wideStopNote?: string | null;
    grossRR?: { t1?: number; t2?: number }; netRR?: { t1?: number | null; t2?: number | null };
    qty?: number | null; qtyRaw?: number | null; qtyCapped?: boolean; leverage?: number;
    riskInr?: number | null; capital?: number | null; riskPctPerTrade?: number;
  } | null;
  tfFit?: { verdict?: 'GOOD' | 'OK' | 'STRETCH' | 'MISMATCH'; ratioT1?: number | null; ratioT2?: number | null; expectedTravelPct?: number | null; t1Pct?: number | null; t2Pct?: number | null; bars?: number; k?: number; note?: string; suggestHoldMin?: number } | null;
  costs?: { roundTripPct?: number | null; costPerTrade?: number | null; costR?: number | null; model?: string; probeNotional?: number } | null;
  checklist?: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  warnings?: Array<{ code: string; text: string }>;
  timePlan?: { holdMin?: number; bars?: number; triggerMin?: number; beRule?: string; t1Rule?: string; trailRule?: string; timeStopRule?: string; hardExitRule?: string } | null;
  dataAge?: { ctxBars?: number; trigBars?: number; ctxLastTime?: number | null; trigLastTime?: number | null; istTime?: string | null };
  notes?: string[];
}

/** v21.15.0 — MTF trade plan (context→trigger plan + TF-fit + cost-in-R).
 *  Server: /api/ai/trade-plan/:symbol (30s cache; fresh=1 bypass). */
export async function fetchTradePlan(
  symbol: string,
  market: MarketKind,
  opts: { mode?: TradePlanModeId; holdMin?: number; side?: 'LONG' | 'SHORT'; ltp?: number; capital?: number; riskPctPerTrade?: number; fresh?: boolean } = {},
): Promise<TradePlanView | null> {
  try {
    const qs = new URLSearchParams();
    // v21.17.0 DEEP AUDIT: pass true market (INDIA/CRYPTO/FUTURES/GLOBALFUTURES/METALS) so GLOBALFUTURES uses Yahoo US equities and CRYPTO/FUTURES use USDT chain.
    qs.set('market', market || 'INDIA');
    if (opts.mode) qs.set('mode', opts.mode);
    if (opts.holdMin) qs.set('hold', String(Math.round(opts.holdMin)));
    if (opts.side) qs.set('side', opts.side);
    if (opts.ltp && Number.isFinite(opts.ltp)) qs.set('ltp', String(opts.ltp));
    if (opts.capital && Number.isFinite(opts.capital)) qs.set('capital', String(Math.round(opts.capital)));
    if (opts.riskPctPerTrade && Number.isFinite(opts.riskPctPerTrade)) qs.set('riskPct', String(opts.riskPctPerTrade));
    if (opts.fresh) qs.set('fresh', '1');
    const r = await apiFetch(`${getProxyBase()}/api/ai/trade-plan/${encodeURIComponent(symbol)}?${qs.toString()}&t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => null);
    if (!j) return null;
    return j as TradePlanView; // ok:false payloads bhi return hote hain (panel honest error dikhata hai)
  } catch { return null; }
}

// ---------------- v21.16.0 MTF SIGNALS BOARD (DUAL-TIMEFRAME) + AUTO-LINK ----------------
export interface MtfDualRow {
  ok: boolean; error?: string | null;
  symbol: string; market: string; assetClass?: 'CRYPTO' | 'METALS' | 'EQUITY_SIM' | 'INDIA' | string; mode: TradePlanModeId; label?: string;
  contextTf?: string; triggerTf?: string; holdMin?: number;
  ltp?: number | null;
  /** v21.17.0 + v21.22.0: price domain — CRYPTO/METALS rows USDT, EQUITY_SIM rows USD, INDIA rows INR */
  quoteCcy?: 'USDT' | 'USD' | 'INR' | null; priceSrc?: string | null; fx?: number | null; ltpInr?: number | null;
  superScore: number | null; tier: string;
  scoreBand?: string;
  winRatePct?: number | null;
  heuristicConfluencePct?: number | null;
  pWinCalibrated?: number | null;
  directionVerified?: boolean;
  boardSideConflict?: boolean;
  boardSide?: 'LONG' | 'SHORT' | string | null;
  svaConflict?: boolean;
  councilConflict?: boolean;
  pakkaDirectionLabel?: string | null;
  trapVeto?: boolean;
  zoneWallVeto?: boolean;
  worldIndicators?: {
    alignedCount: number | null;
    totalCount: number;
    aligned8Count?: number | null;
    total8Count?: number;
    confluencePct: number | null;
    estimatedWinRatePct: number | null;
    directionVerified?: boolean;
    trapVeto?: boolean;
    zoneWallVeto?: boolean;
    highAccuracy95Ready?: boolean;
    chandelierStop?: number | null;
    institutional8?: Array<{ id: string; label: string; dir?: number; aligned: boolean; detail?: string }>;
  } | null;
  ollamaTrio?: {
    optimized?: boolean;
    reachable?: boolean;
    models?: string[];
    fastModel?: string;
    deepModel?: string;
    sentinelModel?: string;
    approvedCount?: number;
    totalModels?: number;
    voteScore?: number;
    verdict?: string;
    // v21.23.3 HONESTY: sentinel ka honest path — offline pe "Rule-Based Guard n/3",
    // live pe "Live Ollama (...)"; raw verdict rule-based ho sakta hai (offline bhi
    // "3/3 OLLAMA AI LOCK" bol deta tha — fabricated claim).
    honestLabel?: string;
    ruleBasedGuard?: boolean;
    liveVerdict?: string | null;
    scoreBoost?: number;
    latencyMs?: number | null;
    liveNote?: string | null;
  } | null;
  side: 'LONG' | 'SHORT' | null; dir?: number | null;
  grade?: 'A' | 'B' | 'C' | null; bias?: string | null;
  trendDir?: number | null; triggerDir?: number | null; extendedDir?: number | null;
  htfBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | string | null;
  counterHtf?: boolean;
  dualAligned?: boolean; tripleAligned?: boolean; triggerFired?: boolean;
  tfFit?: string | null; tfFitNote?: string | null; tfFitRatio?: number | null;
  suggestedHoldMin?: number | null; expectedTravelPct?: number | null;
  earlyIgnition?: boolean; reversalRisk?: boolean;
  counterTrend?: boolean; costR?: number | null;
  drivers?: string[]; gates?: string[];
  components?: Array<{ k: string; w: number; v: number; contrib: number | null }>;
  autoEligible: boolean; autoBlockers: string[]; autoPickBlockers?: string[];
  plan?: { entry?: number | null; entryZoneLow?: number | null; entryZoneHigh?: number | null; pullbackEntry?: number | null; breakoutEntry?: number | null; triggerLevel?: number | null; stopLoss?: number | null; stopPct?: number | null; t1?: number | null; t2?: number | null; netRR?: { t1?: number | null; t2?: number | null }; qty?: number | null; wideStopNote?: string | null; chandelierStop?: number | null } | null;
  context?: { struct?: string; rsi?: number | null; adx?: number | null; atrPct?: number | null; supertrend?: string | null; note?: string } | null;
  trigger?: { volRatio?: number | null; bodyPct?: number | null; rsi?: number | null; patterns?: string[]; opposingFlow?: boolean; reversalRisk?: boolean; postPeakTrap?: boolean; rangePct?: number | null; pullbackReclaim?: boolean } | null;
  timePlan?: TradePlanView['timePlan'];
  warnings?: Array<{ code: string; text: string }>;
  aiAgents?: {
    voters?: number | null;
    agreementPct?: number | null;
    topSeats?: string[];
    svaAction?: string | null;
    svaScore?: number | null;
    councilModel?: string | null;
    ollamaReachable?: boolean;
    ollamaScanModel?: string;
    ollamaDeepModel?: string;
    ollamaTrioModels?: string[];
    ollamaVerdict?: string;
    councilVerdict?: string | null;
    councilNote?: string | null;
  } | null;
  feeProtection?: {
    roundTripFeePct?: number;
    feeBreakevenPrice?: number | null;
    zeroLossRule?: string;
  } | null;
  leverageRule?: { below10k: number; above10k: number; thresholdINR: number; walletDeployPct?: number } | null;
  signals?: { board?: { side?: 'LONG' | 'SHORT' | string | null; aiScore?: number | null; grade?: string | null; confidence?: number | null; winProb?: { verdict?: string | null; pWin?: number | null; evR?: number | null; calibrated?: boolean } | null } | null; mtf6?: { consensus?: string; agreementPct?: number; phase?: string; htfBias?: string | null; ltfTrigger?: string | null; timing?: string | null } | null } | null;
  asOf?: number;
}

export interface MtfDirectionScorecardBucket {
  n: number;
  directionHitRate: number | null;
  t1HitPct: number | null;
  slFirstPct: number | null;
  wrongWayRate: number | null;
  avgR: number | null;
  wilsonLB: number | null;
}

export interface MtfDirectionScorecardView extends MtfDirectionScorecardBucket {
  windowDays: number;
  totalScans: number;
  resolvedCount: number;
  pendingCount: number;
  calibrated: boolean;
  alignedBucket?: MtfDirectionScorecardBucket;
  conflictBucket?: MtfDirectionScorecardBucket;
}

export interface MtfDualBoardView {
  ok: boolean; error?: string;
  market?: string; mode?: TradePlanModeId; modeLabel?: string;
  contextTf?: string; triggerTf?: string; holdMin?: number; minScore?: number;
  topDeepTrendLimit?: number; scannedCount?: number;
  directionScorecard?: MtfDirectionScorecardView | null;
  liveFeed24x7?: { active: boolean; cadenceMs: number; directTickOverlay: number; asOf: number };
  // v21.23.1: `avgWinRatePct` ab nullable — missing rows pe fabricated 88 nahi milta.
  worldIndicatorsInfo?: { count: number; names: string[]; targetWinRatePct: number | null; avgWinRatePct: number | null };
  ollamaTrio?: { reachable: boolean; base?: string; fastModel: string; deepModel: string; sentinelModel: string; models: string[]; count: number; keepAlive?: string };
  counts?: { rows: number; overBar: number; eligible: number; strong: number; fired: number; unavailable: number; metalsEligible?: number; equitySimEligible?: number };
  quoteCcy?: 'USDT' | 'USD' | 'INR' | null; fx?: number | null;
  rows?: MtfDualRow[];
  metalsRows?: MtfDualRow[];
  equitySimRows?: MtfDualRow[];
  asOf?: number; cached?: boolean; notes?: string[];
}

/** v21.16.0 + v21.22.0 — Dual-TF board (board signals × MTF superintelligence fuse + World Top 10 Indicators + Gold/Silver + Equity Sim). */
export async function fetchMtfDualBoard(
  market: MarketKind,
  opts: { mode?: TradePlanModeId; holdMin?: number; minScore?: number; limit?: number; fresh?: boolean } = {},
): Promise<MtfDualBoardView | null> {
  try {
    const qs = new URLSearchParams();
    const mktParam = market === 'INDIA' ? 'INDIA' : market === 'METALS' ? 'METALS' : market === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : 'CRYPTO';
    qs.set('market', mktParam);
    if (opts.mode) qs.set('mode', opts.mode);
    if (opts.holdMin) qs.set('hold', String(Math.round(opts.holdMin)));
    if (opts.minScore) qs.set('minScore', String(Math.round(opts.minScore)));
    if (opts.limit) qs.set('limit', String(Math.round(opts.limit)));
    if (opts.fresh) qs.set('fresh', '1');
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-dual/board?${qs.toString()}&t=${Date.now()}`, { signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => null);
    return j as MtfDualBoardView | null;
  } catch { return null; }
}

export interface MtfAutoStatus {
  ok: boolean; enabled: boolean; mode?: TradePlanModeId; holdMin?: number | null;
  minScore: number; riskPerTradeINR: number; maxPositionsINR: number; maxNotionalPerTradeINR?: number;
  maxTradesPerDay: number; maxOpenPositions?: number; cooldownMin: number;
  desks?: { india: boolean; crypto: boolean }; timeStopEnabled?: boolean;
  inrPerUsdt?: number; ccyMode?: string;
  executionMode?: 'paper' | 'live';
  autoSyncSiteLive?: boolean;
  siteLiveActive?: boolean;
  coindcxConnected?: boolean;
  walletAmountINR?: number;
  walletDeployPct?: number;
  wallet95Deployment?: {
    walletDeployPct: number;
    walletTotalINR: number;
    walletTotalUSDT: number;
    deployedWalletINR: number;
    deployedWalletUSDT: number;
    leverage: number;
    buyingPowerINR: number;
    buyingPowerUSDT: number;
    exchangeSafeInitialMarginUSDT: number;
    exchangeSafeInitialMarginINR: number;
  };
  belowTenKLeverage?: number;
  aboveTenKLeverage?: number;
  activeLeverage?: number;
  feeAwareReversalExit?: boolean;
  deepMonitorEnabled?: boolean;
  deepMonitor?: {
    activeCount: number;
    trailingActiveCount: number;
    tp1LockedCount: number;
    reversalAlertCount: number;
    trades: Array<{
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
      movePctFromEntry?: number;
      mfePct?: number;
      roePct?: number;
      directionFollowing?: boolean;
      followThroughVerdict?: string;
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
      buyingPowerINR?: number;
    }>;
    checkedAt: number;
  };
  day?: string | null; dayCount: number; openCount: number; openNotionalINR: number;
  book?: Array<{ paperId: number | null; liveOrderId?: string | null; executionMode?: string; symbol: string; market: string; execMarket?: string; ccy?: 'USDT' | 'INR'; fxUsed?: number | null; side: string; score: number; tier: string; mode?: string; holdMin?: number; entry: number; stopLoss: number; t1: number; t2: number; qty: number; leverage?: number; walletINR?: number; feeBreakevenPrice?: number | null; marginINR?: number; marginUsdt?: number | null; riskINR: number; riskUsdt?: number | null; notional: number; notionalUsdt?: number | null; openedAt: number; status: string; closeReason?: string | null; closedAt?: number | null; pnl?: number | null; drivers?: string[] }>;
  events?: Array<{ at: number; kind: string; text: string }>;
  lastTick?: { at: number; opened: number; closed: number; skipped: string[] } | null;
  paperOnly?: boolean; note?: string;
}

export async function fetchMtfAutoStatus(): Promise<MtfAutoStatus | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-auto/status?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function updateMtfAutoConfigApi(patch: Record<string, unknown>): Promise<MtfAutoStatus | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-auto/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    return j?.config ? await fetchMtfAutoStatus() : null;
  } catch { return null; }
}

export async function setMtfAutoEnabledApi(enabled: boolean): Promise<MtfAutoStatus | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-auto/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export interface MtfAutoPreviewRow { symbol: string; side: 'LONG' | 'SHORT' | null; superScore: number | null; tier: string; entry: number | null; stopLoss: number | null; t1: number | null; t2: number | null; tfFit?: string | null; holdMin?: number; eligible: boolean; blockers: string[] }
export interface MtfAutoPreview { ok: boolean; enabled: boolean; mode?: TradePlanModeId; minScore: number; preview: Record<string, { counts: MtfDualBoardView['counts'] | null; picks: MtfAutoPreviewRow[] }> }

export async function fetchMtfAutoPreview(): Promise<MtfAutoPreview | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-auto/preview?t=${Date.now()}`, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// v21.17.0 — 🧪 manual paper entry straight from a dual-board card.
export interface MtfBoardPaperResult { ok: boolean; trade?: { id: number; symbol: string; direction: string; entry: number; qty: number; stopLoss: number; target1?: number | null; target2?: number | null; market?: string }; ccy?: 'USDT' | 'INR'; fx?: number | null; error?: string; row?: { symbol: string; side: string | null; superScore: number | null; tier: string; tfFit?: string | null; autoEligible?: boolean; blockers?: string[] } }

export async function openMtfBoardPaper(symbol: string, market: MarketKind, mode?: TradePlanModeId, holdMin?: number): Promise<MtfBoardPaperResult | null> {
  try {
    const mkt = market === 'INDIA' ? 'INDIA' : market === 'METALS' ? 'METALS' : market === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : 'CRYPTO';
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-dual/paper`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, market: mkt, ...(mode ? { mode } : {}), ...(holdMin ? { hold: Math.round(holdMin) } : {}) }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return j as MtfBoardPaperResult;
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'network error' };
  }
}

// v21.20.0 — ⚡ direct LIVE order execution straight from an MTF Dual-Timeframe Signal Board card (uses .env CoinDCX API key + secret).
export interface MtfBoardLiveResult {
  ok: boolean;
  mode?: 'live';
  orderId?: string | null;
  filled?: { qty: number; price: number; notionalUSDT?: number | null; notionalINR?: number | null; leverage: number; marginUSDT?: number | null; stopLoss?: number | null; t1?: number | null; t2?: number | null };
  error?: string;
  reason?: string;
}

export async function openMtfBoardLive(
  symbol: string,
  market: MarketKind,
  side: 'LONG' | 'SHORT',
  mode?: TradePlanModeId,
  holdMin?: number,
  leverage?: number,
): Promise<MtfBoardLiveResult | null> {
  try {
    const mkt = market === 'INDIA' ? 'INDIA' : market === 'METALS' ? 'METALS' : market === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : 'CRYPTO';
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-dual/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        market: mkt,
        side,
        ...(mode ? { mode } : {}),
        ...(holdMin ? { hold: Math.round(holdMin) } : {}),
        ...(leverage ? { leverage: Math.round(leverage) } : {}),
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: j?.error || j?.reason || `HTTP ${r.status}` };
    return j as MtfBoardLiveResult;
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'network error' };
  }
}

// v21.23.1: `opened`/`closed` element types — pehle `unknown[]` tha, jisse
// MTFDualBoardPanel.tsx(242) par `?.[0]?.side` / `?.[0]?.symbol` access
// TS2339 (Property does not exist on type '{}') de raha tha aur `npm run check`
// ka tsc gate FAIL hota tha. Ab elements properly typed hain.
export interface MtfAutoTickOpenedRow {
  symbol?: string;
  side?: string;
  [k: string]: unknown;
}
export interface MtfAutoTickClosedRow {
  symbol?: string;
  market?: string;
  reason?: string;
  pnl?: number | null;
  [k: string]: unknown;
}
export async function runMtfAutoTick(): Promise<{ ok: boolean; tick?: { opened: MtfAutoTickOpenedRow[]; closed: MtfAutoTickClosedRow[]; skipped: string[]; candidates: number } } | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/mtf-auto/run`, { method: 'POST', signal: AbortSignal.timeout(90000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchWhales(market: MarketKind): Promise<WhaleRadar | null> {
  const m = market === 'INDIA' ? 'INDIA' : 'CRYPTO'; // futures → underlying crypto desk
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/whales?market=${m}&t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchLedger(limit = 20): Promise<LedgerView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/ledger?limit=${limit}&t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchMorningBrief(): Promise<MorningBrief | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/brief?t=${Date.now()}`, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchOrderbook(symbol: string): Promise<OrderbookView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/orderbook?symbol=${symbol}&t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    // 502 with an honest error payload is still a displayable view
    return await r.json().catch(() => null);
  } catch { return null; }
}

// ---------------- v6.8: agent · wallet · futures markets ----------------
export async function fetchAgentStatus(): Promise<AgentView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/agent?t=${Date.now()}`, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function startAgent(mode: 'paper' | 'live' | 'notify', liveConfirmPhrase?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, ...(mode === 'live' && liveConfirmPhrase ? { liveConfirmPhrase } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    return await r.json().catch(() => ({ ok: false, error: 'bad response' }));
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function stopAgent(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/agent/stop`, { method: 'POST', signal: AbortSignal.timeout(15000) });
    return await r.json().catch(() => ({ ok: false, error: 'bad response' }));
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function saveAgentConfig(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/agent/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(15000),
    });
    return await r.json().catch(() => ({ ok: false, error: 'bad response' }));
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function fetchWallet(): Promise<WalletView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/wallet?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    // 4xx/5xx with an honest payload is still displayable
    // v20.9.1 [L]: 401 body ({error:{message}}) TRUTHY parse hota tha aur
    // wallet={error:...} store ho jata tha (WalletStrip sab-dashes render
    // karta tha). Non-OK → null (session-expired flow khud handle karta hai).
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

// ---------------- v6.11: glama Tier-2/3 fetchers ----------------
export async function fetchTrust(): Promise<TrustView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/trust?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchPerf(): Promise<PerfView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/perf?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchCorrelations(): Promise<CorrView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/correlations?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchSectors(): Promise<SectorView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/sectors?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function fetchIncomeSetups(): Promise<IncomeView | null> {
  try {
    const r = await apiFetch(`${getProxyBase()}/api/ai/income?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
