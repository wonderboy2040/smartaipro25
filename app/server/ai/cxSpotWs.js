// ============================================================
// server/ai/cxSpotWs.js — v11.3 CoinDCX OFFICIAL SPOT WebSocket
// ------------------------------------------------------------
// LIVE-VERIFIED CONTRACT (2026-09-17, wss://stream-spot.coindcx.com):
//   • protocol : Socket.IO v4 / Engine.IO 4 — URL pins
//                ?EIO=4&transport=websocket (client-sent '2' pings KILL
//                this socket; the SERVER pings at pingInterval and the
//                client answers '3' — cxSocketIo handles both).
//   • channels : "currentPrices@spot@1s"  → event "currentPrices@spot#update"
//                (+ "#snapshot" full book on join) — {pr:"SPOT", prices:
//                {"BTCINR": 6123456.5, "BTCUSDT": 76421.4, …}} — every
//                pair whose price changed in the last 1s/10s. INR pairs
//                refresh in ~10s bursts, USDT pairs ~1s.
//                "priceStats@spot@60s"   → event "priceStats@spot#update"
//                (+ "#snapshot") — {stats: {"BTCINR": {pc, v, ts}, …}} —
//                24h change % + 24h volume per market.
//   • payload.data is a JSON-encoded STRING (parsed defensively).
//   • keepalive: app-level ping every 25s (cxSocketIo does this).
//
// WHY: the spot board's ONLY INR anchor was the REST ticker
// (api.coindcx.com/exchange/ticker) — a Cloudflare-fronted host that
// times out from Render datacenter IPs (production incident:
// "502 Failed to fetch crypto prices. The operation was aborted due
// to timeout"). The socket server on stream-spot.coindcx.com is a
// DIFFERENT host + protocol and is datacenter-reachable (verified from
// a network where every CoinDCX REST host is 403-challenged). This
// module keeps an official, always-on INR price book so the whole
// crypto price layer survives REST blackouts:
//
//   fetchCoinDcxTickers() chain (cryptoStream.js):
//     REST ticker → spot-WS book (THIS module) → Binance×fx synth
//     → deep-stale serve. The SSE poller ALSO re-anchors the Binance
//     projection from the WS book when REST is dark.
//
// LIFECYCLE: demand-driven, Render-free-tier friendly. spotWsDemand()
// is a cheap heartbeat every consumer call; the socket self-closes
// ~2 min after demand stops (no SSE clients AND no ticker fetches).
// Handshake fail-streak → 30 min cooldown; drops → backoff reconnect.
// ============================================================
import { createCxSocketIo } from './cxSocketIo.js';

const SPOT_WS_URL = 'wss://stream-spot.coindcx.com/socket.io/?EIO=4&transport=websocket';
const PRICE_CHANNEL = 'currentPrices@spot@1s';
const STATS_CHANNEL = 'priceStats@spot@60s';

const SPOT_WS_DEMAND_IDLE_MS = 120_000;  // no demand for 2 min → close
const SPOT_WS_FAIL_LIMIT = 3;            // consecutive handshake failures → cooldown
const SPOT_WS_COOLDOWN_MS = 30 * 60_000;
const SPOT_WS_RECONNECT_MS = 3_000;      // base delay, ×2 backoff → 24s cap
/** v11.4 recheck: a socket can be protocol-alive (engine.io pings answered)
 *  yet stop delivering book updates. cxRtStream has a silent-contract
 *  watchdog for exactly this; the spot layer had none — a silent zombie
 *  kept leg 2 of the ticker chain dark until the socket happened to drop.
 *  Kill + reconnect after this long without a single book update. */
const SPOT_WS_SILENT_KILL_MS = 120_000;
/** A market's price row is SERVABLE for this long after its last tick.
 *  INR pairs refresh in ~10s bursts on the live wire; 45s rides out a
 *  burst gap without serving dust. */
const PRICE_FRESH_MS = 45_000;
const STATS_FRESH_MS = 3 * 60_000;
/** Minimum book size before the WS can act as a fetchCoinDcxTickers
 *  fallback (a half-populated book means the socket just connected). */
const MIN_SERVABLE_MARKETS = 25;

// ---- state ----
const _prices = new Map();   // market "BTCINR" -> { price, at }
const _stats = new Map();    // market "BTCINR" -> { pc, v, at }
let _io = null;              // cxSocketIo controller
let _demandAt = 0;           // last consumer heartbeat (ms)
let _failStreak = 0;
let _disabledUntil = 0;
let _reconnectTimer = null;
let _idleTimer = null;
let _dataWatchdog = null;    // v11.4 recheck: silent-socket killer
let _connectedAt = 0;        // v11.4 recheck: ns-connect epoch (zombie budget anchor)
let _lastUpdateAt = 0;       // last book update (socket liveness)
// Enable matrix (the cxRtStream hermetic pattern):
//   AI_CX_SPOT_WS=0  → always off
//   AI_CX_SPOT_WS=1  → always on
//   unset            → on in production/development, OFF under vitest
//     (NODE_ENV=test) so no unit suite ever opens a real socket.
let _enabled = process.env.AI_CX_SPOT_WS === '1'
  ? true
  : process.env.AI_CX_SPOT_WS === '0'
    ? false
    : process.env.NODE_ENV !== 'test';

// ---- test injection ----
let _wsFactory = null;
let _nowFn = () => Date.now();
export function _setSpotWsFactoryForTest(fn) { _wsFactory = fn; }
export function _setSpotWsNowForTest(fn) { _nowFn = fn || (() => Date.now()); }
export function _setSpotWsEnabledForTest(v) { _enabled = !!v; }

// ---- v18.10 DIRECT-PUSH HOOK (ultra-fast INR) ----
// The book's ONLY reader used to be the 2s REST poller in
// cryptoStream — a price change on the official socket waited up to
// 2s before it reached the browser. Registered handler (cryptoStream)
// receives (market, price) the INSTANT the exchange prints it and
// writes the liveFeed tick itself; the SSE wire's per-symbol 1s
// throttle + 0.05% dead-band keep bandwidth identical. The 2s poller
// keeps running (enrichment: stats/high/low + the REST chain anchor).
let _onPrice = null;
export function setSpotWsOnPrice(fn) { _onPrice = typeof fn === 'function' ? fn : null; }
export function _getSpotWsOnPriceForTest() { return _onPrice; }

const _num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** Consumer heartbeat — called by fetchCoinDcxTickers() and the SSE
 *  client lifecycle. Idempotent, allocation-free. Also arms the idle
 *  watchdog: the socket self-closes ~2 min after the LAST demand. */
export function spotWsDemand() {
  _demandAt = _nowFn();
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  _ensure();
  _armIdleWatchdog();
}

/** Latest INR/USDT price for a market key ("BTCINR"), or null. */
export function spotWsPrice(market) {
  const row = _prices.get(String(market || '').toUpperCase());
  if (!row) return null;
  if (_nowFn() - row.at > PRICE_FRESH_MS) return null;
  return row.price;
}

/** Fresh book stats (diagnostics + the fallback gate). */
export function spotWsStatus() {
  const now = _nowFn();
  let fresh = 0;
  for (const row of _prices.values()) if (now - row.at <= PRICE_FRESH_MS) fresh++;
  return {
    enabled: _enabled,
    connected: !!_io && _io.state().connected,
    markets: _prices.size,
    freshMarkets: fresh,
    servable: fresh >= MIN_SERVABLE_MARKETS,
    lastUpdateAt: _lastUpdateAt,
    ageMs: _lastUpdateAt ? now - _lastUpdateAt : null,
    cooling: now < _disabledUntil,
    channel: PRICE_CHANNEL,
  };
}

/** CoinDCX-ticker-shaped array synthesized from the live WS book —
 *  the OFFICIAL fallback leg for fetchCoinDcxTickers(). Field parity
 *  with api.coindcx.com/exchange/ticker rows: market / last_price /
 *  change_24_hour / volume as STRINGS (repo-wide parseFloat consumers);
 *  high/low/bid/ask are NOT carried by the WS (consumers already
 *  `parseFloat(x) || price` them). Rows carry feed: 'coindcx-spot-ws'
 *  for honest source labeling. */
export function spotWsTickerArray() {
  const now = _nowFn();
  const out = [];
  for (const [market, row] of _prices) {
    if (now - row.at > PRICE_FRESH_MS) continue;
    const st = _stats.get(market);
    out.push({
      market,
      last_price: String(row.price),
      change_24_hour: String(st && now - st.at <= STATS_FRESH_MS ? (st.pc ?? 0) : 0),
      volume: String(st && now - st.at <= STATS_FRESH_MS ? (st.v ?? 0) : 0),
      timestamp: row.at,
      feed: 'coindcx-spot-ws',
    });
  }
  return out;
}

// ---------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------
function _onEvent(name, payload) {
  if (name !== 'currentPrices@spot#update'
    && name !== 'currentPrices@spot#snapshot'
    && name !== 'priceStats@spot#update'
    && name !== 'priceStats@spot#snapshot') return;
  if (!payload || typeof payload !== 'object') return;
  // payload.data is a JSON-encoded STRING on the live wire (verified).
  let d = payload.data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return; }
  }
  if (!d || typeof d !== 'object') return;
  const now = _nowFn();
  if (d.prices && typeof d.prices === 'object') {
    for (const [rawMarket, raw] of Object.entries(d.prices)) {
      const market = String(rawMarket).toUpperCase();
      if (!/^[A-Z0-9]{2,18}(INR|USDT|BTC|USDC)$/.test(market)) continue;
      const price = _num(raw);
      if (!(price > 0)) continue;
      _prices.set(market, { price, at: now });
      // v18.10: direct event-driven push — sub-2s latency from the
      // exchange socket to the SSE wire (defensive: a broken consumer
      // must never kill the socket's book merge).
      if (_onPrice) { try { _onPrice(market, price); } catch { /* consumer error — book still fresh */ } }
    }
    _lastUpdateAt = now;
  }
  if (d.stats && typeof d.stats === 'object') {
    for (const [rawMarket, raw] of Object.entries(d.stats)) {
      if (!raw || typeof raw !== 'object') continue;
      const market = String(rawMarket).toUpperCase();
      if (!/^[A-Z0-9]{2,18}(INR|USDT|BTC|USDC)$/.test(market)) continue;
      _stats.set(market, { pc: _num(raw.pc), v: _num(raw.v), at: now });
    }
  }
}

// ---------------------------------------------------------------
// Socket lifecycle (the proven cryptoStream/binanceFutWs pattern)
// ---------------------------------------------------------------
function _ensure() {
  if (!_enabled) return;
  if (_io) return;
  if (_nowFn() < _disabledUntil) return;
  let io;
  try {
    io = createCxSocketIo({
      url: SPOT_WS_URL,
      wsFactory: _wsFactory || undefined,
      nowFn: _nowFn,
      onEvent: _onEvent,
      onOpen: () => { _failStreak = 0; _connectedAt = _nowFn(); },
      onClose: (wasNs) => {
        if (!wasNs) _registerFailure();
        _io = null;
        _scheduleReconnect();
      },
    });
  } catch {
    _registerFailure();
    return;
  }
  _io = io;
  io.connect();
  io.join(PRICE_CHANNEL);
  io.join(STATS_CHANNEL);
  _armDataWatchdog();
}

function _registerFailure() {
  _failStreak += 1;
  if (_failStreak >= SPOT_WS_FAIL_LIMIT) {
    _disabledUntil = _nowFn() + SPOT_WS_COOLDOWN_MS;
    _failStreak = 0;
  }
}

function _scheduleReconnect() {
  if (_reconnectTimer || _nowFn() < _disabledUntil) return;
  if (_nowFn() - _demandAt > SPOT_WS_DEMAND_IDLE_MS) return; // demand stopped — stay down
  const delay = Math.min(24_000, SPOT_WS_RECONNECT_MS * 2 ** Math.min(_failStreak, 3));
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_nowFn() - _demandAt <= SPOT_WS_DEMAND_IDLE_MS) _ensure();
  }, delay);
  if (typeof _reconnectTimer.unref === 'function') _reconnectTimer.unref();
}

/** Idle watchdog — armed on every demand tick; closes the socket when
 *  demand has been silent for 2 min (no SSE clients, no board polls). */
function _armIdleWatchdog() {
  if (_idleTimer) return;
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (_nowFn() - _demandAt > SPOT_WS_DEMAND_IDLE_MS) _close('idle');
  }, SPOT_WS_DEMAND_IDLE_MS + 5_000);
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

/** v11.4 recheck: silent-socket watchdog — a connected socket that has
 *  delivered NO book update for SPOT_WS_SILENT_KILL_MS (or never delivered
 *  anything since connect) is a zombie: engine.io keeps it protocol-alive
 *  forever while every price row ages past PRICE_FRESH_MS. Kill it; the
 *  onClose handler schedules the reconnect. NOT counted as a handshake
 *  failure (the handshake worked). */
function _armDataWatchdog() {
  if (_dataWatchdog) return;
  _dataWatchdog = setInterval(() => {
    if (!_io || !_io.state().connected) return;
    const now = _nowFn();
    const silentFor = _lastUpdateAt
      ? now - _lastUpdateAt
      : (_connectedAt ? now - _connectedAt : 0);
    if (silentFor > SPOT_WS_SILENT_KILL_MS) {
      _close('silent');
    }
  }, 30_000);
  if (typeof _dataWatchdog.unref === 'function') _dataWatchdog.unref();
}

function _close(reason) {
  if (reason === 'idle' || reason === 'test-reset' || reason === 'silent') {
    // keep the book (stale rows age out naturally) — only the socket goes
  }
  if (_dataWatchdog) { clearInterval(_dataWatchdog); _dataWatchdog = null; }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_io) {
    try { _io.close(); } catch { /* already dead */ }
    _io = null;
  }
}

export function _resetSpotWsForTest() {
  _close('test-reset');
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  _prices.clear();
  _stats.clear();
  _failStreak = 0;
  _disabledUntil = 0;
  _demandAt = 0;
  _connectedAt = 0;
  _lastUpdateAt = 0;
  _wsFactory = null;
  _enabled = false; // hermetic default — WS suites opt back in via _setSpotWsEnabledForTest(true)
}
