// ============================================================
// server/ai/positionsStream.js — v10.5.3 REALTIME POSITIONS
// ------------------------------------------------------------
// THE BUG: the Execution Console's "ULTRA STREAM" was a 5-second REST
// poll (`useAITrading` → GET /api/ai/positions every 5s). A fast crypto
// move updated 4-5 times on the exchange before the panel showed it —
// "pata hi nahi chal raha profit/loss".
//
// THE FIX: a server-pushed SSE channel (the same EventSource
// architecture /api/stream + /api/intraday-stream already use — no new
// dependency, ?session= auth works for EventSource exactly like the
// intraday desk). ONE shared diff-poller for N connected clients:
//
//   GET /api/ai/positions/stream
//     event: positions → the FULL view (positions[] + entries[] +
//                        stats — same shape as the REST endpoint),
//                        sent on connect + whenever the book's
//                        STRUCTURE changes (open/close/partial/status)
//     event: tick       → { id, ltp, unrealizedPnlINR, ... } — a small
//                        delta for ONE position whose price moved.
//                        Price-driven: pushed the moment the shared
//                        recompute sees a new LTP, not on a timer.
//     event: status     → 15s keepalive heartbeat.
//
// CADENCE (deliberate — see getPositionsWithPnl's upstream chains):
//   • 1s  while clients are connected and every open position is in a
//       cached-feed domain (crypto = CoinDCX 2s ticker cache, futures
//       = 20s RT cache, global = 10s Yahoo cache) — the poller itself
//       is nearly free; only CHANGED rows are pushed per tick.
//   • 5s  while an INDIA position is open — the India leg prices from
//       the UNCACHED TradingView scanner batch, so 5s keeps upstream
//       load exactly at the old REST-poll rate (12 req/min, unchanged)
//       while upgrading delivery from poll to push.
//   • 15s while no position is open / no clients — heartbeat cadence
//       that still catches agent-opened positions within seconds of
//       the agent's own tick.
//   • 0   when the last client disconnects (timer stops — a tab nobody
//       is watching costs nothing; the REST endpoint stays for
//       reconciliation).
// ============================================================
import { getPositionsWithPnl } from './coindcxOrders.js';
// v13.2 B6: SSE frame byte telemetry
import { trackSseWrite } from './bandwidth.js';

const TICK_FAST_MS = 1000;   // cached-feed domains (crypto/futures/global)
const TICK_INDIA_MS = 5000;  // India open → uncached TV scanner cadence (old REST rate)
const TICK_IDLE_MS = 15000;  // no open positions / no clients
const SNAPSHOT_FRESH_MS = 5000;

let _clients = new Set();    // SSE response writers
let _timer = null;           // self-rescheduling timeout handle
let _polling = false;
let _lastView = null;        // { positions, entries, stats, ts }
let _lastSig = new Map();    // id → signature of the last PUSHED state
let _lastEntriesLen = -1;    // structural-change anchors
let _lastPositionsLen = -1;
let _lastOpenIds = new Set();

/** Pure cadence decision — exported for the regression suite. */
export function nextDelay(hasClients, indiaOpen) {
  if (!hasClients) return TICK_IDLE_MS;
  return indiaOpen ? TICK_INDIA_MS : TICK_FAST_MS;
}

function _broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const write of _clients) {
    try { write(payload); } catch { /* client gone */ }
  }
}

function _sigOf(p) {
  return [
    p.ltp, p.status, p.qty, p.sl, p.tp, p.tp2,
    p.unrealizedPnlINR, p.unrealizedPnlUSDT, p.usdInr,
    p.trailing, p.tp1Hit, p.tp2Hit, p.priceSource, p.exitStage,
  ].join('|');
}

async function _poll() {
  if (_polling) return;
  _polling = true;
  try {
    const view = await getPositionsWithPnl();
    _lastView = { ...view, ts: Date.now() };
    const positions = Array.isArray(view.positions) ? view.positions : [];
    const entries = Array.isArray(view.entries) ? view.entries : [];

    const openIds = new Set(positions.filter(p => p.status === 'OPEN').map(p => p.id));
    // structural = open/close transition, book-size change or audit-row change
    let structural = entries.length !== _lastEntriesLen
      || positions.length !== _lastPositionsLen;
    for (const id of openIds) if (!_lastOpenIds.has(id)) structural = true;
    for (const id of _lastOpenIds) if (!openIds.has(id)) structural = true;
    if (_lastSig.size === 0) structural = true; // first ever push

    if (structural) {
      _broadcast('positions', { positions, entries, stats: view.stats || null, ts: _lastView.ts });
      _lastSig.clear();
      for (const p of positions) _lastSig.set(p.id, _sigOf(p));
      _lastEntriesLen = entries.length;
      _lastPositionsLen = positions.length;
      _lastOpenIds = openIds;
      return;
    }

    // price-driven per-row deltas — ONLY changed rows leave the server
    for (const p of positions) {
      if (p.status !== 'OPEN') continue;
      const sig = _sigOf(p);
      if (_lastSig.get(p.id) === sig) continue;
      _lastSig.set(p.id, sig);
      _broadcast('tick', {
        id: p.id, pair: p.pair, symbol: p.symbol ?? null, market: p.market ?? null,
        side: p.side, status: p.status, qty: p.qty,
        ltp: p.ltp ?? null,
        unrealizedPnlINR: p.unrealizedPnlINR ?? null,
        unrealizedPnlUSDT: p.unrealizedPnlUSDT ?? null,
        usdInr: p.usdInr ?? null,
        priceSource: p.priceSource ?? null,
        sl: p.sl ?? null, tp: p.tp ?? null, tp2: p.tp2 ?? null,
        trailing: p.trailing ?? null,
        tp1Hit: !!p.tp1Hit, tp2Hit: !!p.tp2Hit,
        exitStage: p.exitStage ?? null,
        ts: _lastView.ts,
      });
    }
  } catch (e) {
    console.warn('[positions-stream] poll error:', e?.message || e);
  } finally {
    _polling = false;
  }
}

function _schedule(delayMs) {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _timer = setTimeout(async () => {
    _timer = null;
    if (_clients.size === 0) return; // nobody watching — stay parked
    await _poll();
    // adapt the next delay to what the open book actually contains
    const positions = Array.isArray(_lastView?.positions) ? _lastView.positions : [];
    const indiaOpen = positions.some(p => p.status === 'OPEN' && p.market === 'INDIA');
    _schedule(nextDelay(_clients.size > 0, indiaOpen));
  }, delayMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}

function _ensureTimer() {
  if (_timer) return;
  _schedule(250); // connect → first push within a quarter second
}

// ------------------------------------------------------------
// SSE endpoint handler — register on express (auth'd like every
// /api/ai/* route; EventSource sends ?session= per requireAuth).
// ------------------------------------------------------------
export function positionsStreamHandler(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  // v20.7.8 [L9]: guard the first raw write — index.js's identical SSE site
  // wraps this exact line ("a synchronous throw here would skip the cleanup
  // handlers"); a destroyed-socket race at connect must not escape the
  // handler before on('close') registration below.
  try { res.write('retry: 3000\n\n'); } catch { return; }

  // 2026 perf audit (H1) pattern: backpressure guard — a stalled client
  // (phone sleep / zero-window TCP) must not buffer SSE writes forever.
  // v13.2 B6: wrapped for byte telemetry.
  const write = trackSseWrite('sse:positions', (payload) => {
    try {
      const ok = res.write(payload);
      if (ok || !res.socket || res.socket.writableLength <= 128 * 1024) return true;
      try { _clients.delete(write); res.destroy(); } catch { /* noop */ }
      return false;
    } catch {
      return false;
    }
  });
  _clients.add(write);

  // Fresh-enough view → paint instantly; otherwise the shared poller's
  // first tick (≤250ms away) delivers the snapshot to everyone.
  if (_lastView && Date.now() - _lastView.ts < SNAPSHOT_FRESH_MS) {
    try {
      write(`event: positions\ndata: ${JSON.stringify({
        positions: _lastView.positions, entries: _lastView.entries,
        stats: _lastView.stats || null, ts: _lastView.ts,
      })}\n\n`);
    } catch { /* client gone */ }
  }

  const keepalive = setInterval(() => {
    try {
      write(`event: status\ndata: ${JSON.stringify({ stream: 'positions', clients: _clients.size, ts: Date.now() })}\n\n`);
    } catch { /* noop */ }
  }, 15000);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  _ensureTimer();

  req.on('close', () => {
    clearInterval(keepalive);
    _clients.delete(write);
    if (_clients.size === 0 && _timer) {
      // last client left — park the poller (heartbeat cadence keeps the
      // module warm but costs nothing while nobody is watching)
      _schedule(TICK_IDLE_MS);
    }
    try { res.end(); } catch { /* noop */ }
  });
}

// ---------------- test hooks ----------------
/** Drive ONE poll cycle and await it (the regression suite's "tick"). */
export async function __tickForTests() { await _poll(); }
export function __clientsForTests() { return _clients.size; }
export function __lastViewForTests() { return _lastView; }
export function __resetPositionsStreamForTests() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _clients = new Set();
  _polling = false;
  _lastView = null;
  _lastSig = new Map();
  _lastEntriesLen = -1;
  _lastPositionsLen = -1;
  _lastOpenIds = new Set();
}
