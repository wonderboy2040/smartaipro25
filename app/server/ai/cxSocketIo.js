// ============================================================
// server/ai/cxSocketIo.js — CoinDCX socket.io WS client (EIO=4)
// ------------------------------------------------------------
// docs.coindcx.com "Sockets" (re-verified LIVE 2026-09-17):
//   • endpoints : wss://stream.coindcx.com      (futures domain)
//                wss://stream-spot.coindcx.com (spot domain)
//   • protocol  : Socket.IO v4 = Engine.IO 4 — the URL pins
//                ?EIO=4&transport=websocket. PRODUCTION INCIDENT
//                (v11.3): the old EIO=3 URL completed the handshake
//                but the server KILLED the socket ~1s after the
//                ns-connect ack — the futures WS never delivered a
//                single tick. EIO=4 flows (live-verified, 270 events
//                in 40s + 90s survival with the app-level ping).
//   • channels  : book-style   "currentPrices@futures@rt" / "currentPrices@spot@1s"
//                 per-pair     "B-<PAIR>@prices-futures" / "B-<PAIR>@prices"
//   • join     : socket.emit('join', { channelName })
//   • event    : socket.on(name, payload) — payload.data is a
//                JSON-encoded STRING on the book channels
//   • keepalive: app-level ping every 25s — emit('ping', {data:'Ping message'})
//                + Engine.IO liveness: SERVER sends '2', client must
//                answer '3'. The client must NEVER send its own '2'
//                ping on these sockets (live-verified: a client '2'
//                kills the connection within ~200ms).
//   • auth     : market-data channels need NONE ("order book and market data
//                is available without authentication")
//
// WHY RAW 'ws' AND NOT socket.io-client@4.x: the v4 client pulls a
// sizeable dependency tree the repo does not otherwise carry, and the
// repo keeps `npm audit` at 0 vulnerabilities — the EIO=4 framing is
// hand-rolled here instead (~60 lines, fully unit-tested via an
// injected ws factory). Engine.IO 4 framing on the websocket transport
// is plain text frames and IDENTICAL to v3 for the ops we use:
//     server→client : '0{sid…}' open · '2' ping · '40{sid…}' ns-ack ·
//                     '42["event",data]' event · '41' ns-disconnect
//     client→server : '40' ns-connect · '3' pong · '42["join",{…}]' ·
//                     '42["leave",{…}]' · '42["ping",{…}]'
// (EIO4's own client-ping op — a bare '2' from the client — is NOT
// sent: CoinDCX's servers treat it as a protocol violation and drop
// the socket, live-verified 2026-09-17.)
// ============================================================
import WebSocket from 'ws';

const CONNECT_TIMEOUT_MS = 8_000;   // handshake must complete or we terminate
const APP_PING_MS = 25_000;         // CoinDCX-documented app-level keepalive

/**
 * Create a CoinDCX futures Socket.IO-v2 controller.
 *   { url, onEvent(name, payload), onOpen(), onClose(), onError(err),
 *     wsFactory(url)?, nowFn()? }
 * Returns { connect, close, join, leave, state }.
 * NEVER throws after construction — all failures surface via onClose.
 */
export function createCxSocketIo({
  url, onEvent, onOpen, onClose, onError, wsFactory, nowFn,
} = {}) {
  const _now = nowFn || (() => Date.now());
  let _ws = null;
  let _nsConnected = false;
  const _channels = new Set();
  let _appPingTimer = null;
  let _connectTimeout = null;

  const _safe = (fn, ...args) => { try { fn && fn(...args); } catch { /* listener errors are the caller's problem */ } };

  function _send(frame) {
    try {
      if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(frame);
    } catch { /* dead socket — the close handler owns the recovery */ }
  }

  function _clearTimers() {
    if (_connectTimeout) { clearTimeout(_connectTimeout); _connectTimeout = null; }
    if (_appPingTimer) { clearInterval(_appPingTimer); _appPingTimer = null; }
  }

  function _onNsConnected() {
    // (re)join every channel — CoinDCX channels do not survive reconnects
    for (const ch of _channels) {
      _send(`42["join",${JSON.stringify({ channelName: ch })}]`);
    }
    // the documented app-level keepalive (a silent socket gets dropped)
    if (_appPingTimer) clearInterval(_appPingTimer);
    _appPingTimer = setInterval(() => _send('42["ping",{"data":"Ping message"}]'), APP_PING_MS);
    if (_appPingTimer.unref) _appPingTimer.unref();
    _safe(onOpen);
  }

  function _handleFrame(raw) {
    const s = String(raw);
    if (s.startsWith('0')) {
      // Engine.IO 3 OPEN handshake — the namespace connect ('40') goes
      // out ONLY after this frame (protocol order; a '40' that races
      // ahead of the handshake is not guaranteed to be honored).
      _send('40');
      return;
    }
    if (s === '2') { _send('3'); return; }              // Engine.IO 3: server ping → pong
    if (s.startsWith('40')) {                            // '40' | '40{"sid":…}' — ns-connect ACK
      if (_connectTimeout) { clearTimeout(_connectTimeout); _connectTimeout = null; }
      _nsConnected = true;
      _onNsConnected();
      return;
    }
    if (s.startsWith('42')) {                            // '42["event",payload]'
      try {
        const arr = JSON.parse(s.slice(2));
        if (Array.isArray(arr) && typeof arr[0] === 'string') _safe(onEvent, arr[0], arr[1]);
      } catch { /* malformed frame — ignore */ }
      return;
    }
    // '41' ns disconnect, '1' engine close, rest — ignored
  }

  function connect() {
    if (_ws) return;
    let ws;
    try {
      ws = wsFactory ? wsFactory(url) : new WebSocket(url);
    } catch (e) {
      _safe(onError, e);
      // treat as a closed HANDSHAKE attempt (wasNs=false) so the owner's
      // failure-streak + reconnect logic runs exactly like a geo-block
      _safe(onClose, false);
      return;
    }
    _ws = ws;
    // handshake watchdog — a socket that never completes the Engine.IO
    // open + ns-connect ack within the budget is terminated (geo-block /
    // auth-reject / silent handshake — none of them may hang the owner).
    _connectTimeout = setTimeout(() => {
      if (_ws === ws && !_nsConnected) {
        try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* noop */ }
      }
    }, CONNECT_TIMEOUT_MS);
    if (_connectTimeout.unref) _connectTimeout.unref();

    ws.on('open', () => {
      if (_ws !== ws) return;
      // NOTE: the '40' ns-connect is NOT sent here — Engine.IO 3 requires
      // the server's '0' handshake frame first (see _handleFrame).
    });
    ws.on('message', (raw) => {
      if (_ws !== ws) return;
      // v10.13 (deep-recheck L10): upstream frame size cap — a misbehaving
      // peer must not be able to OOM the process via a giant frame (the
      // String() + JSON.parse below would happily buffer/parse it).
      if (raw && raw.length > 1_000_000) return;
      _handleFrame(typeof raw === 'string' ? raw : raw.toString());
    });
    ws.on('error', () => {
      if (_ws !== ws) return;
      try { ws.close(); } catch { /* the close handler runs the recovery */ }
    });
    ws.on('close', () => {
      if (_ws !== ws) return; // stale handler from a replaced/closed socket
      _ws = null;
      const wasNs = _nsConnected;
      _nsConnected = false;
      _clearTimers();
      _safe(onClose, wasNs);
    });
  }

  function join(channel) {
    if (!channel) return;
    _channels.add(String(channel));
    if (_nsConnected) _send(`42["join",${JSON.stringify({ channelName: String(channel) })}]`);
  }

  function leave(channel) {
    if (!_channels.delete(String(channel))) return;
    if (_nsConnected) _send(`42["leave",${JSON.stringify({ channelName: String(channel) })}]`);
  }

  function close() {
    const ws = _ws;
    _ws = null;
    _nsConnected = false;
    _clearTimers();
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.on('error', () => {});
        if (ws.readyState === 0 /* CONNECTING */ && typeof ws.terminate === 'function') {
          ws.terminate();
        } else {
          ws.close();
        }
      } catch { /* already dead */ }
    }
  }

  function state() {
    return {
      socket: !!_ws,
      connected: _nsConnected,
      channels: [..._channels],
    };
  }

  return { connect, close, join, leave, state };
}
