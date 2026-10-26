// ============================================================
// server/ai/autoTradeSuperAgent.js — v21.26.0 PER-TRADE AI SUPER AGENT
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "jab bhi AUTO trade lagta hai, us trade ke liye
// ek AI super intelligence agent immediately active ho — realtime WebSocket
// price par TP1/TP2 monitor kare, highest profit trail kare, trade clearly
// against ho to bahut hi kam loss me close kare, aur market pakka opposite
// move kare to purana trade band karke immediately naya trade live direction
// me laga de. TP2 hit + close ke baad agent wapas IDLE ho jaye."
//
// WHAT THIS FILE OWNS (and what it deliberately does NOT):
//   • OWNS: tick routing (liveFeed.subscribe → per-trade handler), the
//     per-trade registry / state machine, stream subscription hold/release,
//     a 1s fallback/watchdog, and status telemetry.
//   • DOES NOT own trade logic. Every decision lives in
//     mtfAutoLink.mtfAutoSuperAgentManage() — the SAME direction certificate,
//     AUTO readiness gates, quota/cooldown/budget guards and UC flip-reverse
//     path as the 15s/60s loops.
//
// LATENCY HONESTY:
//   The primary path is the actual WebSocket tick event (`liveFeed.setTick`
//   subscriber loop). There is no fabricated 1ms feed and no polling on the
//   hot path — `pollingMs: 0`. Actual market latency is the upstream source's
//   latency (Binance USDT perps: sub-second; CoinDCX book: ~1s; India: poller).
//   The 1s interval below is a WATCHDOG/fallback only: it runs when a symbol's
//   WS key has been silent >1.2s, so a dead socket never freezes an exit.
// ============================================================
import { subscribe, getTick } from '../liveFeed.js';
import {
  mtfAutoSuperAgentManage,
  markAutoTradeSuperAgentIdle,
} from './mtfAutoLink.js';

const FALLBACK_MS = 1_000;
const FALLBACK_STALE_MS = 1_200;   // WS key silent this long → fallback quote
const VELOCITY_WINDOW_MS = 12_000;
const VELOCITY_MIN_SPAN_MS = 2_000;
const VELOCITY_MIN_MOVE_PCT = 0.0018;  // 0.18% adverse over ≥2s
const VELOCITY_HARD_MOVE_PCT = 0.0035; // 0.35% adverse = confirmed outright
const VELOCITY_CONSECUTIVE = 4;
const MAX_TICK_SAMPLES = 60;
const MAX_IDLE_LOG = 20;
const LIVE_CTX_WARM_MS = 10_000;
const FX_WARM_MS = 60_000;

const REGISTRY = new Map();   // `${market}|${symbol}` → entry
const IDLE_LOG = [];

let _started = false;
let _startedAt = null;
let _deps = null;
let _unsub = null;
let _fallbackTimer = null;
let _fallbackBusy = false;
let _lastTickAt = null;
let _lastActionAt = null;
let _quotesCache = {};
let _fxCache = null;
let _lastFxAt = 0;
let _liveCtx = null;
let _lastLiveCtxAt = 0;
let _liveCtxWarming = false;

function _keyOf(trade) {
  return `${String(trade?.market || '').toUpperCase()}|${String(trade?.symbol || '').toUpperCase()}`;
}

function _expectedKey(trade) {
  const sym = String(trade?.symbol || '').toUpperCase();
  const exec = String(trade?.execMarket || trade?.market || '').toUpperCase();
  if (exec === 'GLOBALFUTURES') return `GLOB_${sym}`;
  if (exec === 'INDIA' || String(trade?.market || '').toUpperCase() === 'INDIA') return `IN_${sym}`;
  // FUTURES / METALS / CRYPTO-perp all ride the FUT_ namespace in liveFeed.
  if (exec === 'FUTURES' || exec === 'METALS' || exec === 'CRYPTO') return `FUT_${sym}`;
  return `IN_${sym}`;
}

function _altKeys(trade) {
  const sym = String(trade?.symbol || '').toUpperCase();
  const exec = String(trade?.execMarket || trade?.market || '').toUpperCase();
  const out = new Set();
  out.add(`FUT_${sym}`);
  out.add(`IN_${sym}`);
  if (exec === 'GLOBALFUTURES') {
    out.add(`GLOB_${sym}`);
    out.add(`US_${sym}`);
  }
  out.delete(_expectedKey(trade));
  return [...out];
}

function _newEntry(row) {
  return {
    key: _keyOf(row),
    symbol: String(row.symbol || '').toUpperCase(),
    market: String(row.market || '').toUpperCase(),
    execMarket: String(row.execMarket || row.market || 'FUTURES').toUpperCase(),
    side: String(row.side || '').toUpperCase(),
    tradeKey: _expectedKey(row),
    altKeys: _altKeys(row),
    state: row.superAgentState || 'ARMED',
    idleReason: row.superAgentIdleReason || null,
    entry: Number(row.entry) || 0,
    stopLoss: Number(row.stopLoss) || 0,
    t1: Number(row.t1) || 0,
    t2: Number(row.t2) || 0,
    paperId: row.paperId ?? null,
    executionMode: row.executionMode || 'PAPER',
    openedAt: Number(row.openedAt) || 0,
    // telemetry
    ticks: [],
    tickCount: 0,
    lastTickAt: 0,
    lastPrice: 0,
    lastTickAgeMs: null,
    lastHandlerMs: null,
    lastSource: null,
    lastAction: null,
    lastActionAt: null,
    lastError: null,
    armedAt: Date.now(),
    busy: false,
    pending: null,
    subscribed: false,
  };
}

function _pushIdle(entry, reasonOverride = null) {
  IDLE_LOG.push({
    at: Date.now(),
    symbol: entry.symbol,
    market: entry.market,
    execMarket: entry.execMarket,
    state: 'IDLE',
    reason: reasonOverride || entry.idleReason || entry.lastAction || 'TRADE_CLOSED',
    ticks: entry.tickCount,
    lastPrice: entry.lastPrice || null,
    opener: entry.openedAt || null,
  });
  if (IDLE_LOG.length > MAX_IDLE_LOG) IDLE_LOG.splice(0, IDLE_LOG.length - MAX_IDLE_LOG);
}

function _warn(message) {
  try { console.warn(`[auto-super-agent] ${message}`); } catch { /* non-fatal */ }
}

// ------------------------------------------------------------
// Stream subscription hold / release
// ------------------------------------------------------------
function _subSpec(entry) {
  const exec = entry.execMarket;
  if (exec === 'GLOBALFUTURES') return { glob: [entry.symbol] };
  if (exec === 'INDIA' || entry.market === 'INDIA') return { india: [entry.symbol] };
  if (exec === 'FUTURES' || exec === 'METALS' || entry.market === 'CRYPTO') return { fut: [entry.symbol] };
  return { crypto: [entry.symbol] };
}

function _domainOf(entry) {
  if (entry.execMarket === 'INDIA' || entry.market === 'INDIA') return 'india';
  if (entry.execMarket === 'FUTURES' || entry.execMarket === 'METALS' || entry.execMarket === 'GLOBALFUTURES') return 'cxrt';
  return 'crypto';
}

function _ensureSubsFor(entry) {
  if (!_deps || entry.subscribed) return;
  let acquired = false;
  try {
    _deps.ensureSubs?.(_subSpec(entry));
    acquired = true;
    _deps.clientUp?.(_domainOf(entry));
    entry.subscribed = true;
  } catch (e) {
    entry.lastError = `ensureSubs: ${e?.message || e}`;
    // ensureSubs may already have incremented the stream refcount. Roll it
    // back so a partially-failed arm can never leave the upstream stream
    // pinned forever (the agent would never call release on an unsubscribed
    // entry).
    if (acquired) {
      try { _deps.releaseSubs?.(_subSpec(entry)); } catch { /* best-effort */ }
    }
    entry.subscribed = false;
  }
}

function _releaseSubsFor(entry) {
  if (!_deps || !entry.subscribed) return;
  try {
    _deps.releaseSubs?.(_subSpec(entry));
    _deps.clientDown?.(_domainOf(entry));
  } catch { /* best-effort */ }
  entry.subscribed = false;
}

// ------------------------------------------------------------
// Registry sync (new AUTO entry → immediately armed)
// ------------------------------------------------------------
function _syncRegistry() {
  if (!_deps) return;
  let rows = [];
  try { rows = _deps.getOpenTrades?.() || []; }
  catch (e) {
    // A transient book-read failure is NOT an empty book. Treating it as one
    // would release every stream and stamp all agents IDLE for a full second.
    _warn(`registry sync failed: ${e?.message || e}`);
    return;
  }
  if (!Array.isArray(rows)) return;
  const seen = new Set();
  for (const row of rows) {
    if (!row?.symbol || !row?.market) continue;
    const key = _keyOf(row);
    seen.add(key);
    let entry = REGISTRY.get(key);
    if (!entry) {
      entry = _newEntry(row);
      REGISTRY.set(key, entry);
      _ensureSubsFor(entry);
      continue;
    }
    // A confirmed flip closes the old row and opens the reverse row under the
    // SAME market|symbol key. The registry entry must become a FRESH agent:
    // keeping the old trade's tick samples would let pre-flip velocity
    // instantly confirm an adverse move on the new position.
    const identityChanged = String(row.openedAt || '') !== String(entry.openedAt || '')
      || String(row.side || '').toUpperCase() !== String(entry.side || '').toUpperCase()
      || (row.paperId != null && entry.paperId != null && String(row.paperId) !== String(entry.paperId));
    if (identityChanged) {
      entry.ticks = [];
      entry.tickCount = 0;
      entry.lastTickAt = 0;
      entry.lastPrice = 0;
      entry.lastTickAgeMs = null;
      entry.lastHandlerMs = null;
      entry.lastSource = null;
      entry.lastAction = null;
      entry.lastActionAt = null;
      entry.lastError = null;
      entry.idleReason = null;
      entry.armedAt = Date.now();
      entry.pending = null;
    }
    // Same trade, refreshed book levels/provenance.
    entry.side = String(row.side || entry.side || '').toUpperCase();
    entry.execMarket = String(row.execMarket || entry.execMarket).toUpperCase();
    entry.tradeKey = _expectedKey(entry);
    entry.altKeys = _altKeys(entry);
    entry.state = row.superAgentState || entry.state;
    entry.idleReason = row.superAgentIdleReason || entry.idleReason;
    entry.entry = Number(row.entry) || entry.entry;
    entry.stopLoss = Number(row.stopLoss) || entry.stopLoss;
    entry.t1 = Number(row.t1) || entry.t1;
    entry.t2 = Number(row.t2) || entry.t2;
    entry.paperId = row.paperId ?? entry.paperId;
    entry.executionMode = row.executionMode || entry.executionMode;
  }
  for (const [key, entry] of [...REGISTRY.entries()]) {
    if (seen.has(key)) continue;
    _releaseSubsFor(entry);
    REGISTRY.delete(key);
    // The row already carries the agent's own IDLE reason when the agent
    // closed it; external closes (paper SL/TP2, exchange sync) get stamped
    // too so the UI never shows a ghost "MONITORING" state.
    try {
      markAutoTradeSuperAgentIdle({
        symbol: entry.symbol,
        market: entry.market,
        reason: entry.idleReason || entry.lastAction || 'TRADE_CLOSED',
      });
    } catch { /* non-fatal */ }
    _pushIdle(entry);
  }
  // Warm the fallback caches (quotes / fx / live handlers) in the same turn a
  // trade is armed. A brand-new AUTO entry must not wait for the 1s watchdog
  // before its first exit decision has the injected live handlers available.
  if (REGISTRY.size > 0) {
    try { _refreshSharedCache(); } catch { /* non-fatal */ }
  }
}

// ------------------------------------------------------------
// Rolling tick-velocity confirmation (adverse direction)
// ------------------------------------------------------------
function _pushSample(entry, price, at) {
  entry.ticks.push({ at, price });
  if (entry.ticks.length > MAX_TICK_SAMPLES) entry.ticks.splice(0, entry.ticks.length - MAX_TICK_SAMPLES);
  while (entry.ticks.length > 2 && at - entry.ticks[0].at > VELOCITY_WINDOW_MS) entry.ticks.shift();
}

function _velocity(entry) {
  const side = String(entry.side || '').toUpperCase();
  const isLong = side === 'LONG';
  const now = Date.now();
  const recent = entry.ticks.filter(s => now - s.at <= VELOCITY_WINDOW_MS);
  if (recent.length < 3) return { adverse: false, pct: 0, spanMs: 0, consecutive: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const spanMs = Math.max(0, last.at - first.at);
  if (!(first.price > 0)) return { adverse: false, pct: 0, spanMs, consecutive: 0 };
  // Positive = AGAINST the trade.
  const movePct = isLong
    ? (first.price - last.price) / first.price
    : (last.price - first.price) / first.price;
  let consecutive = 0;
  for (let i = recent.length - 1; i > 0; i--) {
    const adverseStep = isLong
      ? recent[i].price < recent[i - 1].price
      : recent[i].price > recent[i - 1].price;
    if (!adverseStep) break;
    consecutive++;
  }
  const adverse = Boolean(
    movePct > 0
    && spanMs >= VELOCITY_MIN_SPAN_MS
    && (
      movePct >= VELOCITY_HARD_MOVE_PCT
      || (movePct >= VELOCITY_MIN_MOVE_PCT && consecutive >= VELOCITY_CONSECUTIVE)
    )
  );
  return {
    adverse,
    pct: +(movePct * 100).toFixed(3),
    spanMs,
    consecutive,
  };
}

// ------------------------------------------------------------
// Price routing
// ------------------------------------------------------------
function _fallbackPrice(entry) {
  // 1) Same liveFeed key (covers a source that forgot to notify subscribers).
  try {
    const t = getTick(entry.tradeKey);
    if (Number(t?.price) > 0) return { price: Number(t.price), ageMs: Math.max(0, Date.now() - (Number(t.time) || Date.now())) };
  } catch { /* non-fatal */ }
  // 2) Market-qualified quote map from the server stream.
  try {
    const px = _deps?.getQuoteFor?.(entry.symbol, entry.market, entry.execMarket);
    if (Number(px) > 0) return { price: Number(px), ageMs: null };
  } catch { /* non-fatal */ }
  return null;
}

function _manageP() {
  const live = _liveCtx || null;
  return {
    paper: _deps?.paper || {},
    quotes: _quotesCache || {},
    getBoardRow: _deps?.getBoardRow,
    getLiveCtx: _deps?.getLiveCtx,
    fx: _fxCache,
    walletEquityINR: live?.walletEquityINR,
    siteLiveByDesk: live?.siteLiveByDesk,
    siteLiveActive: live?.siteLiveActive,
    killSwitch: (() => { try { return _deps?.isKillSwitch?.() === true; } catch { return false; } })(),
    notify: _deps?.notify,
    liveUpdateSl: live?.liveUpdateSl,
    liveClose: live?.liveClose,
    liveExecute: live?.liveExecute,
  };
}

async function _handlePrice(entry, price, source, tickAgeMs = null) {
  if (!_started || !entry || !(Number(price) > 0)) return;
  // CROSS-DOMAIN FIREWALL (before the velocity ring): `_altKeys` deliberately
  // listens to sibling namespaces, and liveFeed uses `IN_<sym>` for crypto INR
  // spot too. An INR spot tick (~100× USDT) must never enter a USDT perp
  // trade's sample ring — one poisoned sample would keep "confirming" an
  // adverse move for the whole 12s window even though manage() rejects it.
  const ref = Number(entry.entry) || 0;
  if (ref > 0) {
    const ratio = Number(price) / ref;
    if (ratio <= 0.35 || ratio >= 2.85) {
      entry.lastError = `cross-domain tick ignored (${source || '?'} ratio ${ratio.toFixed(3)})`;
      return;
    }
  }
  if (entry.busy) {
    // Coalesce: keep only the newest price; process it when the current
    // handler yields (exits await the exchange — the newest tick must win).
    entry.pending = { price: Number(price), source, tickAgeMs };
    return;
  }
  entry.busy = true;
  const started = Date.now();
  const at = started;
  try {
    _pushSample(entry, Number(price), at);
    const vel = _velocity(entry);
    const res = await mtfAutoSuperAgentManage({
      symbol: entry.symbol,
      market: entry.market,
      ltp: Number(price),
      now: at,
      tickAgeMs: Number.isFinite(Number(tickAgeMs)) ? Number(tickAgeMs) : null,
      velocityAdverse: vel.adverse,
      velocityPct: vel.pct,
      p: _manageP(),
    });
    entry.tickCount += 1;
    entry.lastTickAt = Date.now();
    entry.lastPrice = Number(price);
    entry.lastSource = source || null;
    entry.lastTickAgeMs = Number.isFinite(Number(tickAgeMs)) ? Number(tickAgeMs) : null;
    entry.lastHandlerMs = Date.now() - started;
    entry.lastError = null;
    _lastTickAt = Date.now();
    if (res?.state) entry.state = res.state;
    if (res?.idleReason) entry.idleReason = res.idleReason;
    if (res?.action) {
      entry.lastAction = res.action;
      entry.lastActionAt = Date.now();
      _lastActionAt = entry.lastActionAt;
    }
    if (res?.closed || res?.flipped) _syncRegistry();
  } catch (e) {
    entry.lastError = String(e?.message || e).slice(0, 200);
    _warn(`${entry.symbol} ${entry.market}: ${entry.lastError}`);
  } finally {
    entry.busy = false;
    const pending = entry.pending;
    entry.pending = null;
    if (pending && Number(pending.price) > 0 && Number(pending.price) !== Number(price)) {
      _handlePrice(entry, pending.price, pending.source, pending.tickAgeMs).catch(() => {});
    }
  }
}

function _onLiveTick(key, tick) {
  if (!_started || REGISTRY.size === 0) return;
  const keyUp = String(key || '').toUpperCase();
  if (!keyUp) return;
  const price = Number(tick?.price);
  if (!(price > 0)) return;
  const ageMs = Math.max(0, Date.now() - (Number(tick?.time) || Date.now()));
  for (const entry of REGISTRY.values()) {
    if (entry.tradeKey !== keyUp && !entry.altKeys.includes(keyUp)) continue;
    // Snapshot-ish telemetry is stamped synchronously; the handler itself is
    // async only when an exit/flip needs an exchange call.
    _handlePrice(entry, price, keyUp, ageMs).catch(() => {});
  }
}

// ------------------------------------------------------------
// Shared cache warm (quotes / fx / live ctx) — fallback path only
// ------------------------------------------------------------
function _refreshSharedCache() {
  const now = Date.now();
  try {
    const q = _deps?.getQuotes?.();
    if (q && typeof q === 'object') _quotesCache = q;
  } catch { /* keep previous */ }
  const hasLive = [...REGISTRY.values()].some(e => String(e.executionMode).toUpperCase() === 'LIVE');
  if (hasLive && _deps?.getLiveCtx && !_liveCtxWarming && now - _lastLiveCtxAt >= LIVE_CTX_WARM_MS) {
    _liveCtxWarming = true;
    Promise.resolve(_deps.getLiveCtx())
      .then((lc) => {
        if (lc && typeof lc === 'object') {
          _liveCtx = lc;
          _lastLiveCtxAt = Date.now();
        }
      })
      .catch(() => { /* manage() will await getLiveCtx itself if needed */ })
      .finally(() => { _liveCtxWarming = false; });
  }
  if (_deps?.getFx && now - _lastFxAt >= FX_WARM_MS) {
    _lastFxAt = now;
    Promise.resolve(_deps.getFx())
      .then((fx) => { if (Number(fx) > 0) _fxCache = Number(fx); })
      .catch(() => { /* non-fatal */ });
  }
}

async function _fallbackTick() {
  if (!_started || _fallbackBusy) return;
  _fallbackBusy = true;
  try {
    _syncRegistry();
    _refreshSharedCache();
    const now = Date.now();
    for (const entry of [...REGISTRY.values()]) {
      if (entry.busy) continue;
      // Primary WS path already delivered a fresh tick — do not double-handle.
      if (now - (entry.lastTickAt || 0) < FALLBACK_STALE_MS) continue;
      const q = _fallbackPrice(entry);
      if (!q) continue;
      await _handlePrice(entry, q.price, 'fallback', q.ageMs);
    }
  } catch (e) {
    _warn(`fallback tick: ${e?.message || e}`);
  } finally {
    _fallbackBusy = false;
  }
}

// ------------------------------------------------------------
// Public lifecycle
// ------------------------------------------------------------
/**
 * Start the per-trade agent. Idempotent — routes may call it on boot and after
 * config changes. `deps` is a bag of injected server functions (see routes.js);
 * the agent never imports the HTTP layer or executes orders itself.
 */
export function startAutoTradeSuperAgent(deps = {}) {
  _deps = deps;
  if (_started) {
    // Refresh deps only — do not double-subscribe.
    return autoTradeSuperAgentStatus();
  }
  _started = true;
  _startedAt = Date.now();
  try {
    _unsub = subscribe(_onLiveTick);
  } catch (e) {
    _warn(`subscribe failed: ${e?.message || e}`);
  }
  _fallbackTimer = setInterval(() => { _fallbackTick().catch(() => {}); }, FALLBACK_MS);
  if (_fallbackTimer.unref) _fallbackTimer.unref();
  // First registry sync immediately — an AUTO trade opened just before boot
  // is armed without waiting a full second.
  try { _syncRegistry(); } catch { /* non-fatal */ }
  return autoTradeSuperAgentStatus();
}

/** Force an immediate open-book re-sync (routes calls this right after a tick
 *  that may have opened/closed a trade — new entries arm within the same turn). */
export function refreshAutoTradeSuperAgent() {
  if (!_started) return false;
  try {
    _syncRegistry();
    return true;
  } catch (e) {
    _warn(`refresh failed: ${e?.message || e}`);
    return false;
  }
}

export function stopAutoTradeSuperAgent() {
  if (_fallbackTimer) {
    clearInterval(_fallbackTimer);
    _fallbackTimer = null;
  }
  if (typeof _unsub === 'function') {
    try { _unsub(); } catch { /* non-fatal */ }
    _unsub = null;
  }
  for (const entry of REGISTRY.values()) _releaseSubsFor(entry);
  REGISTRY.clear();
  _started = false;
}

export function autoTradeSuperAgentStatus() {
  const trades = [...REGISTRY.values()].map(e => ({
    key: e.key,
    symbol: e.symbol,
    market: e.market,
    execMarket: e.execMarket,
    side: e.side,
    state: e.state,
    idleReason: e.idleReason,
    tradeKey: e.tradeKey,
    executionMode: e.executionMode,
    paperId: e.paperId,
    entry: e.entry,
    stopLoss: e.stopLoss,
    t1: e.t1,
    t2: e.t2,
    ltp: e.lastPrice || null,
    tickCount: e.tickCount,
    lastTickAt: e.lastTickAt || null,
    lastTickAgeMs: e.lastTickAgeMs,
    lastHandlerMs: e.lastHandlerMs,
    lastSource: e.lastSource,
    lastAction: e.lastAction,
    lastActionAt: e.lastActionAt,
    lastError: e.lastError,
    subscribed: e.subscribed,
    armedAt: e.armedAt,
  }));
  return {
    ok: true,
    running: _started,
    engine: 'liveFeed.subscribe → mtfAutoSuperAgentManage',
    primarySource: 'WebSocket tick event (same event-loop turn as setTick)',
    // Honest latency contract: there is NO 1ms fabricated market feed and no
    // polling on the hot path.
    pollingMs: 0,
    fallbackMs: FALLBACK_MS,
    fallbackStaleMs: FALLBACK_STALE_MS,
    startedAt: _startedAt,
    lastTickAt: _lastTickAt,
    lastActionAt: _lastActionAt,
    registryCount: REGISTRY.size,
    subscribedKeys: [...REGISTRY.values()].filter(e => e.subscribed).map(e => e.tradeKey),
    velocityGuard: {
      windowMs: VELOCITY_WINDOW_MS,
      minSpanMs: VELOCITY_MIN_SPAN_MS,
      minMovePct: VELOCITY_MIN_MOVE_PCT * 100,
      hardMovePct: VELOCITY_HARD_MOVE_PCT * 100,
      consecutiveTicks: VELOCITY_CONSECUTIVE,
      note: 'Minimal-loss exit additionally requires currentR <= superAgentMinLossR and the 60s LIVE age guard.',
    },
    trades,
    idle: IDLE_LOG.slice(-10),
    note: 'Realtime path = upstream WebSocket tick; 1s fallback = watchdog for a silent/dead symbol. TP2 → IDLE; confirmed flip → close + reverse.',
  };
}

/** Test/hermetic hook. */
export function __resetAutoTradeSuperAgentForTests() {
  stopAutoTradeSuperAgent();
  IDLE_LOG.length = 0;
  _deps = null;
  _quotesCache = {};
  _fxCache = null;
  _lastFxAt = 0;
  _liveCtx = null;
  _lastLiveCtxAt = 0;
  _liveCtxWarming = false;
  _lastTickAt = null;
  _lastActionAt = null;
  _startedAt = null;
}
