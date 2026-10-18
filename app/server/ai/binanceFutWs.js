// ============================================================
// server/ai/binanceFutWs.js — v10.15 BINANCE FUTURES WS ACCELERATOR
// ------------------------------------------------------------
// THE GAP (deep-recheck #2, Section 1): when CoinDCX's futures
// socket goes dark (WAF blip / 403 / silent-contract cooldown), the
// FUT_ domain falls back to Binance REST at a 5-SECOND cache — that
// is the "ab pehle jaisa ultra-fast nahi lag raha" moment for
// BTC/ETH/SOL. Binance publishes a futures combined stream
// (wss://fstream.binance.com) that pushes sub-second; it was used
// NOWHERE in the repo (zero `fstream` references).
//
// This module is the accelerator TIER between the CoinDCX socket and
// the Binance REST path:
//   FUT priority: CoinDCX Socket.IO → BINANCE FUT WS (this) →
//                 Binance REST 5s → stale-serve.
//
// Architecture — modeled directly on cryptoStream.js's proven spot
// Binance client (the file that already handles combined-stream
// subscription, the 3-fail circuit breaker, the 5-min rapid-cycle
// backoff, and geo-block 451 handling — copied, not reinvented):
//   • ONE combined `wss://fstream.binance.com/stream?streams=` socket
//     for the currently-refcounted FUT bases, capped at 20 streams.
//   • HOT STANDBY semantics: cxRtStream tells this module `wantOpen`
//     = "CoinDCX WS is NOT healthy right now". While the CoinDCX WS
//     is proving ticks, this socket stays CLOSED (zero upstream cost,
//     normal operation unchanged — byte-identical to today). The
//     moment CoinDCX goes dark/unproven/cooling, the accelerator
//     opens; the instant CoinDCX lands a tick again, it closes.
//   • Render idle-friendly: opens/closes with the SSE client gate
//     exactly like every other stream (no clients → closed).
//   • Honest label: ticks land as `binance-fut-ws` so the UI badge
//     distinguishes sub-second WS pushes from the 5s `binance-fut-rt`
//     REST fallback.
//   • 1:1 USDT-perp domain — no projection, no ratio (unlike the spot
//     INR anchor projection in cryptoStream.js): a Binance BTCUSDT
//     perp tick IS the FUT_BTC price domain.
//   • Source-priority gate: a tick NEVER overwrites a fresh
//     `coindcx-fut-ws` (<3s) or `coindcx-fut-rt` (<2.5s) tick —
//     CoinDCX is the desk's authoritative exchange, and the badge
//     must not flap between sources when both are alive.
//   • Geo-block (HTTP 451) honesty: a host that can't reach Binance
//     fails the handshake → 3-fail breaker → 30-min cooldown → the
//     Binance REST 5s path (and CoinDCX REST) carry on alone.
// ============================================================
import WebSocket from 'ws';
import { setTick, getTick } from '../liveFeed.js';

const BINANCE_FUT_WS_BASE = 'wss://fstream.binance.com/stream?streams=';
const BINANCE_FUT_MAX_STREAMS = 20;          // cap the combined stream list (cryptoStream parity)
const BINANCE_FUT_RECONNECT_MS = 5000;
const BINANCE_FUT_FAIL_LIMIT = 3;            // consecutive dead handshakes → breaker
const BINANCE_FUT_COOLDOWN_MS = 30 * 60 * 1000;
// rapid-cycle backoff (cryptoStream v10.13 L2 pattern): 5+ connect-then-drop
// cycles within 5 minutes → 60s hold-off + jitter, so an unhealthy upstream
// is never hammered in a tight loop.
const BINANCE_FUT_RAPID_CYCLES = 5;
const BINANCE_FUT_RAPID_WINDOW_MS = 5 * 60 * 1000;
const BINANCE_FUT_RAPID_BACKOFF_MS = 60 * 1000;
const BINANCE_FUT_MAX_FRAME_BYTES = 1_000_000;  // upstream frame size cap
// v20.7.10: SILENCE KILL — NAT idle half-open sockets: koi frame/close
// event nahi, _ensure ka readyState===OPEN check hamesha return → kabhi
// recover nahi hota + socket leak. cxSpotWs/cxRtStream me pehle se tha;
// Binance fut client me missing tha. Tickers ~1 msg/s → 45s = dead.
const BINANCE_FUT_SILENT_KILL_MS = 45_000;
const BINANCE_FUT_SILENT_PROBE_MS = 15_000;
const BINANCE_FUT_RESUB_DEBOUNCE_MS = 2000;     // re-connect after universe changes
const BINANCE_FUT_TICK_FRESH_MS = 5000;         // "healthy" proof window
const BINANCE_FUT_CONNECT_TIMEOUT_MS = 8000;
// source-priority gates (CoinDCX is authoritative while fresh):
const CX_WS_FRESH_MS = 3000;   // a coindcx-fut-ws tick < 3s old owns the key
const CX_RT_FRESH_MS = 2500;   // a coindcx-fut-rt tick < 2.5s old owns the key (2s cadence)

// ---- state ----
let _ws = null;
let _streams = '';            // current combined stream list (set-change detect)
let _reconnectTimer = null;
let _resubTimer = null;
let _failStreak = 0;
let _disabledUntil = 0;
let _gotData = false;
let _lastTickAt = 0;          // last attributable tick epoch (the health proof)
let _wsFactory = null;        // test injection
let _nowFn = () => Date.now();
let _tierEnabled = true;      // production ON; _resetBinanceFutWsForTest disables (hermetic suites)
let _onLand = null;           // host hook (cxRtStream syncs its REST cadence on a landed tick)
const _cycleTimes = [];       // open→close cycle timestamps (rapid-cycle backoff)

// the tier decision, driven by cxRtStream (the ONLY caller):
let _gate = { active: false, wantOpen: false, universe: [] };

export function _setBinanceFutWsFactoryForTest(fn) {
  _wsFactory = fn;
  // arming the factory = opting the tier INTO a hermetic suite (the
  // cxRtStream pattern: _setDcxWsFactoryForTest + _setDcxWsEnabledForTest
  // folded into one call — the legacy suites that never arm a factory
  // get a fully-disabled tier and ZERO real sockets).
  if (fn) _tierEnabled = true;
}
export function _setBinanceFutWsEnabledForTest(v) { _tierEnabled = !!v; }
export function _setBinanceFutNowForTest(fn) { _nowFn = fn || (() => Date.now()); }

/** Host hook: cxRtStream registers its cadence-sync so a landed
 *  accelerator tick slows the REST poller to the 10s floor instantly
 *  (not on the next beat). Never throws into the socket path. */
export function setBinanceFutOnLand(fn) { _onLand = typeof fn === 'function' ? fn : null; }

/** Sub-second FUT coverage live? (a binance-fut-ws tick < 5s old) */
export function binanceFutHealthy() {
  return _lastTickAt > 0 && (_nowFn() - _lastTickAt) < BINANCE_FUT_TICK_FRESH_MS;
}

/** Snapshot for the SSE status frame + /api/feed-status. */
export function binanceFutStatus() {
  const now = _nowFn();
  const cooling = now < _disabledUntil;
  return {
    enabled: _tierEnabled,
    connected: !!_ws && _ws.readyState === WebSocket.OPEN,
    healthy: binanceFutHealthy(),
    lastTickAt: _lastTickAt || null,
    streams: _gate.universe.length,
    wantOpen: _gate.wantOpen,
    cooldownActive: cooling,
    cooldownRemainMs: cooling ? Math.max(0, _disabledUntil - now) : 0,
    failStreak: _failStreak,
  };
}

// ---------------------------------------------------------------
// The single sync entry — cxRtStream calls this on every state flip
// (client up/down, universe change, CoinDCX WS health flip, poll beat).
// Idempotent + cheap; computes whether the socket should exist.
// ---------------------------------------------------------------
export function syncBinanceFutAccelerator({ active, wantOpen, universe } = {}) {
  if (active != null) _gate.active = !!active;
  if (wantOpen != null) _gate.wantOpen = !!wantOpen;
  if (Array.isArray(universe)) _gate.universe = [...new Set(universe.map(s => String(s || '').trim().toUpperCase()).filter(Boolean))];

  const shouldOpen = _tierEnabled && _gate.active && _gate.wantOpen && _gate.universe.length > 0;
  if (!shouldOpen) {
    if (_ws || _reconnectTimer || _resubTimer) _closeBinanceFutWs(_gate.active ? 'tier-idle' : 'idle');
    return;
  }
  _ensureBinanceFutWs();
}

function _targetStreams() {
  const bases = _gate.universe.slice(0, BINANCE_FUT_MAX_STREAMS);
  return bases.map(b => `${b.toLowerCase()}usdt@ticker`).join('/');
}

function _ensureBinanceFutWs() {
  if (!_tierEnabled || !_gate.active || !_gate.wantOpen || _gate.universe.length === 0) return;
  if (_nowFn() < _disabledUntil) return;
  const streams = _targetStreams();
  if (!streams) return;
  if (_ws && _ws.readyState === WebSocket.OPEN && streams === _streams) return;
  if (_ws) {
    // universe changed — debounce a swap to a fresh combined stream
    if (streams !== _streams) _scheduleResub();
    return;
  }
  _openBinanceFutWs(streams);
}

function _scheduleResub() {
  if (_resubTimer) return;
  _resubTimer = setTimeout(() => {
    _resubTimer = null;
    if (!_gate.active || !_gate.wantOpen) return;
    const streams = _targetStreams();
    if (!streams || streams === _streams) return;
    _closeBinanceFutWs('resub');
    _openBinanceFutWs(streams);
  }, BINANCE_FUT_RESUB_DEBOUNCE_MS);
  if (typeof _resubTimer.unref === 'function') _resubTimer.unref();
}

function _openBinanceFutWs(streams) {
  try {
    const ws = _wsFactory
      ? _wsFactory(BINANCE_FUT_WS_BASE + streams)
      : new WebSocket(BINANCE_FUT_WS_BASE + streams);
    _ws = ws;
    _streams = streams;
    _gotData = false;
    // v20.7.10: per-socket silence watchdog (constant ka comment upar)
    let _lastMsgAt = Date.now();
    const silenceProbe = setInterval(() => {
      if (_ws !== ws) { clearInterval(silenceProbe); return; }
      if (ws.readyState === WebSocket.OPEN && Date.now() - _lastMsgAt > BINANCE_FUT_SILENT_KILL_MS) {
        try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* noop */ }
      }
    }, BINANCE_FUT_SILENT_PROBE_MS);
    if (typeof silenceProbe.unref === 'function') silenceProbe.unref();
    const connectTimeout = setTimeout(() => {
      // handshake never completed — treat as a failure (geo-block 451 case)
      if (_ws === ws && ws.readyState !== WebSocket.OPEN) {
        try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* noop */ }
      }
    }, BINANCE_FUT_CONNECT_TIMEOUT_MS);
    if (typeof connectTimeout.unref === 'function') connectTimeout.unref();

    ws.on('open', () => {
      if (_ws !== ws) return;
      clearTimeout(connectTimeout);
    });
    ws.on('message', (raw) => {
      if (_ws !== ws) return;
      if (raw && raw.length > BINANCE_FUT_MAX_FRAME_BYTES) return;
      _gotData = true;
      _failStreak = 0;
      _lastMsgAt = Date.now(); // v20.7.10: silence watchdog feed
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const d = msg?.data;
      const stream = String(msg?.stream || '');
      if (!d || !stream) return;
      const base = stream.split('usdt@')[0]?.toUpperCase();
      const last = parseFloat(d.c);
      if (!base || !(last > 0)) return;
      _landTick(base, {
        last,
        changePct: parseFloat(d.P) || 0,
        high: parseFloat(d.h) || 0,
        low: parseFloat(d.l) || 0,
        volume: parseFloat(d.v) || 0,
        // Binance fstream speaks ms event time (E) — normalize anyway so a
        // seconds-shaped field can never poison the out-of-order guard.
        time: (() => { let t = parseFloat(d.E) || 0; if (t > 0 && t < 1e12) t *= 1000; return t; })(),
        prevClose: parseFloat(d.x) || 0,
      });
    });
    ws.on('close', () => {
      clearTimeout(connectTimeout);
      clearInterval(silenceProbe); // v20.7.10: watchdog band
      if (_ws !== ws) return; // stale handler from a replaced socket
      _ws = null;
      _streams = '';
      _registerFailure(!_gotData);
      if (_gate.active && _gate.wantOpen) _scheduleReconnect();
    });
    ws.on('error', () => {
      clearTimeout(connectTimeout);
      if (_ws !== ws) return;
      // v11.4 recheck: ws emits BOTH error and close for failed handshakes —
      // nulling here makes the close handler's stale-guard skip the second
      // _registerFailure (one failed attempt = ONE strike, not two).
      _ws = null;
      _streams = '';
      _registerFailure(!_gotData);
      try { ws.close(); } catch { /* noop */ }
    });
  } catch {
    _registerFailure(true);
  }
}

function _registerFailure(handshakeFailed) {
  if (!handshakeFailed) return; // a live socket that dropped ≠ geo-block
  _failStreak++;
  if (_failStreak >= BINANCE_FUT_FAIL_LIMIT) {
    _disabledUntil = _nowFn() + BINANCE_FUT_COOLDOWN_MS;
    _failStreak = 0;
  }
}

function _recordCycle() {
  const now = _nowFn();
  _cycleTimes.push(now);
  while (_cycleTimes.length && now - _cycleTimes[0] > BINANCE_FUT_RAPID_WINDOW_MS) _cycleTimes.shift();
  return _cycleTimes.length >= BINANCE_FUT_RAPID_CYCLES;
}

function _scheduleReconnect() {
  if (_reconnectTimer || _nowFn() < _disabledUntil) return;
  let delay = BINANCE_FUT_RECONNECT_MS + Math.floor(Math.random() * 1000); // always jittered
  if (_recordCycle()) {
    delay = BINANCE_FUT_RAPID_BACKOFF_MS + Math.floor(Math.random() * 5000);
    _cycleTimes.length = 0; // re-arm after the hold-off
  }
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_gate.active && _gate.wantOpen) _ensureBinanceFutWs();
  }, delay);
  if (typeof _reconnectTimer.unref === 'function') _reconnectTimer.unref();
}

function _closeBinanceFutWs(_reason) {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_resubTimer) { clearTimeout(_resubTimer); _resubTimer = null; }
  if (_ws) {
    const ws = _ws;
    _ws = null;
    try {
      ws.removeAllListeners();
      ws.on('error', () => {});
      if (ws.readyState === 0 /* CONNECTING */ && typeof ws.terminate === 'function') {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch { /* noop */ }
  }
  _streams = '';
}

// ---------------------------------------------------------------
// Tick landing — the source-priority gate + out-of-order guard.
// ---------------------------------------------------------------
function _landTick(base, row) {
  if (!_gate.universe.includes(base)) return; // only the refcounted FUT set
  const key = `FUT_${base}`;
  const now = _nowFn();
  const cur = getTick(key);
  if (cur) {
    // SOURCE PRIORITY: CoinDCX owns the key while ITS ticks are fresh —
    // the accelerator must never fight the authoritative exchange for the
    // badge (a flapping source label is worse than a steady 2s cadence).
    if (cur.source === 'coindcx-fut-ws' && (now - (cur.time || 0)) < CX_WS_FRESH_MS) return;
    if (cur.source === 'coindcx-fut-rt' && (now - (cur.time || 0)) < CX_RT_FRESH_MS) return;
    // out-of-order guard — a late frame must never regress a newer tick
    if ((cur.time || 0) > row.time + 1500) return;
  }
  const time = row.time > 0 ? row.time : now;
  const chg = row.changePct || 0;
  _lastTickAt = now; // the HEALTH PROOF
  setTick(key, {
    price: row.last,
    change: chg,
    high: row.high > 0 ? row.high : row.last,
    low: row.low > 0 ? row.low : row.last,
    volume: row.volume || 0,
    time,
    prevClose: row.prevClose > 0 ? row.prevClose : (chg > -100 ? row.last / (1 + chg / 100) : undefined),
  }, 'binance-fut-ws');
  // host hook — cxRtStream slows its REST poller to the 10s floor NOW
  if (_onLand) { try { _onLand(); } catch { /* never throw into the socket path */ } }
}

// ---------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------
export function _resetBinanceFutWsForTest() {
  _closeBinanceFutWs('test-reset');
  _gate = { active: false, wantOpen: false, universe: [] };
  _failStreak = 0;
  _disabledUntil = 0;
  _gotData = false;
  _lastTickAt = 0;
  _cycleTimes.length = 0;
  _wsFactory = null;
  _nowFn = () => Date.now();
  _tierEnabled = false; // hermetic default — suites opt back in by arming the factory
  // NOTE: _onLand is owned by the HOST (cxRtStream) and stays registered —
  // the callback only touches host state that _resetCxRtForTest resets.
}
