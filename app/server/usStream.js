// usStream — multi-source self-healing real-time US equity feed
// ---------------------------------------------------------------
// ARCHITECTURE (2026-09 ultra-fast pass — fixes "US stocks (non-ETF) not
// realtime while ETFs are"):
//   Priority 0: TradingView america/scan BATCH — ONE POST covers EVERY
//               gap symbol (stocks AND ETFs) with live 'last'/'close'
//               prices. This is the cadence equalizer: previously the
//               Yahoo fallback served only 12 symbols per 5s cycle
//               (round-robin), so symbols late in the list (portfolio
//               US stocks resolved from INDMoney) refreshed every 15-30s
//               while early-list symbols (default ETFs SPY/QQQ) refreshed
//               every 5s — exactly the ETF-vs-stock asymmetry the user
//               reported. One batch request = every US symbol ticks at
//               the SAME ~3s cadence.
//   Priority 1: Finnhub WebSocket trade stream — instant push for the symbols
//               the key actually covers (empirically: NVDA/QQQ/AAPL/MU tick,
//               SPY/SMH/VGT/VOOG receive ZERO trades on the free tier).
//   Priority 2: Yahoo session fallback poller (per-symbol round-robin) —
//               fills the symbols TV's scanner didn't return. Every
//               subscribed symbol that has not seen a WS trade in the last
//               10s is eligible. Works EVEN WITH NO FINNHUB KEY.
//   Priority 3: Yahoo session bootstrap — one instant live snapshot per symbol
//               the moment it is subscribed, so a freshly-loaded site paints
//               correct US prices immediately.
//   Priority 4: Finnhub REST quote — LAST RESORT only (Yahoo down). Empirically
//               returns the PREVIOUS session close while the market is open,
//               so it is freshness-gated (see isStaleUsQuote + index.js gate).
//
// LIFECYCLE: WS + fallback poller run ONLY while SSE clients are active
// (idle server = Render free tier friendly). On socket drop the reconnect is
// actually scheduled (audit M-2) and the reconnect-deadlock (timer cleared by
// _disconnect while _reconnectAt still in the future blocked a new client's
// _connect forever) is fixed via _ensureConnected().
// ---------------------------------------------------------------
import WebSocket from 'ws';
import { setTick } from './liveFeed.js';
import { TV_SCAN_HEADERS } from './lib/tvHeaders.js';

// FIX (audit L-1): do NOT fall back to VITE_* vars — those are browser-exposed
// at build time. Server-side processes must read server-side names only.
const KEY = process.env.FINNHUB_API_KEY || '';
const WS_URL = KEY ? `wss://ws.finnhub.io?token=${KEY}` : '';

const _subscribed = new Set();      // plain US tickers (SPY, QQQ, ...)
const _refcounts = new Map();       // sym -> interested SSE clients (2026 perf audit M2)
const _evictTimers = new Map();     // sym -> pending unsubscribe timer
const _session = new Map();         // sym -> { pc, high, low, vol, price, at, wsAt?, inFlight }
const _lastWsTick = new Map();      // sym -> epoch ms of last WS trade
let _ws = null;
let _connecting = false;
let _reconnectAt = 0;
let _activeClients = 0;
let _reconnectTimer = null;
let _fallbackTimer = null;
let _wsAliveTimer = null;           // v10.13: ping + idle watchdog interval
let _lastWsFrameAt = 0;             // v10.13: ANY message/pong on the live socket
// v7.0.2: Finnhub handshake failure streak → exponential backoff + jitter
// (mirrors cryptoStream's breaker). A fixed 3-5s reconnect loop used to
// hammer a down/auth-failing upstream for hours while clients were up.
let _wsFailStreak = 0;
let _wsFactory = null;              // test injection
let _fetchImpl = null;              // test injection
let _tvFailStreak = 0;              // TV batch circuit breaker
let _tvDisabledUntil = 0;
let _lastClosedRefresh = 0;         // closed-market refresh throttle

// Poll tuning. Market open: gap symbols refreshed every 3s — the TV
// america/scan batch covers ALL of them in ONE request (ultra-fast pass),
// Yahoo per-symbol round-robin mops up the TV misses. Market closed:
// prices are static — a 30s refresh is plenty.
const FALLBACK_POLL_MS = 3000;
const CLOSED_REFRESH_MS = 30 * 1000;   // market closed: full refresh cadence
const WS_GAP_MS = 10 * 1000;        // no WS trade for 10s → fallback owns the symbol
const SESSION_FRESH_OPEN_MS = 4000;      // market open: re-fetch if older than 4s
const SESSION_FRESH_CLOSED_MS = 60 * 1000; // market closed: re-fetch if older than 60s
const YAHOO_TIMEOUT_MS = 5000;
const MAX_FALLBACK_BATCH = 12;      // per-cycle Yahoo round-robin cap (rate safety)
const TV_BATCH_CAP = 60;            // max gap symbols per TV batch request
const TV_TIMEOUT_MS = 4500;
const TV_FAIL_LIMIT = 5;            // circuit breaker: consecutive TV failures
const TV_COOLDOWN_MS = 10 * 60 * 1000; // then stop calling TV for 10 minutes
const EVICT_GRACE_MS = 90 * 1000;   // refcount-0 symbols unsubscribe after this
const BOOT_CONCURRENCY = 6;         // fresh-symbol Yahoo bootstrap semaphore
// v10.13 (deep-recheck M1 stream): Finnhub WS liveness. Without a ping +
// idle watchdog, a half-open TCP (laptop sleep→resume, NAT rebind) leaves
// readyState OPEN forever — _ensureConnected() short-circuits on OPEN and
// Priority-1 instant trades are lost for the PROCESS LIFETIME while the
// Yahoo fallback keeps prices flowing (silent cadence degradation). Ping
// every 30s; no frame/pong for 90s while connected → terminate → the normal
// failure-reconnect path takes over.
const WS_PING_MS = 30 * 1000;
const WS_IDLE_KILL_MS = 90 * 1000;
const WS_MAX_FRAME_BYTES = 1_000_000; // v10.13 (L10): upstream frame size cap

// ---------------------------------------------------------------
// Pure helpers (exported for unit tests + reuse in index.js)
// ---------------------------------------------------------------

// 2026 perf audit (L2): the formatter is stateless — hoist it to module scope
// instead of rebuilding a new Intl.DateTimeFormat on every call (10-30/s on
// the hot poll path).
const _etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
});

/** US regular-session hours, America/New_York, Mon-Fri 9:30-16:00. */
export function usMarketOpen(date = new Date()) {
  const parts = _etFmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value || '';
  const weekday = get('weekday').substring(0, 3);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  let h = parseInt(get('hour'), 10);
  if (isNaN(h) || h === 24) h = 0;
  const m = parseInt(get('minute'), 10) || 0;
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960;
}

/**
 * Finnhub REST freshness gate (fixes RC1 — stale previous-session quotes).
 * The free-tier REST /quote returns the PREVIOUS session close with t=<last
 * close> while the market is open. While the market is open we treat any
 * quote older than 5 minutes as invalid so callers fall through to Yahoo.
 */
export function isStaleUsQuote(quoteTimeMs, nowMs, marketOpen) {
  if (!marketOpen) return false;          // closed market: last close IS the price
  if (!quoteTimeMs || quoteTimeMs <= 0) return false; // no timestamp → trust caller
  return (nowMs - quoteTimeMs) > 5 * 60 * 1000;
}

// ---------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------
export function _setWsFactoryForTest(fn) { _wsFactory = fn; }
export function _setUsFetchForTest(fn) { _fetchImpl = fn; }
export function _resetUsStreamForTest() {
  _subscribed.clear(); _session.clear(); _lastWsTick.clear();
  _refcounts.clear();
  for (const t of _evictTimers.values()) clearTimeout(t);
  _evictTimers.clear();
  _ws = null; _connecting = false; _reconnectAt = 0; _activeClients = 0;
  clearTimeout(_reconnectTimer); _reconnectTimer = null;
  clearInterval(_fallbackTimer); _fallbackTimer = null;
  clearInterval(_wsAliveTimer); _wsAliveTimer = null; // v10.13
  _lastWsFrameAt = 0;
  _tvFailStreak = 0; _tvDisabledUntil = 0; _lastClosedRefresh = 0;
  _fbPolling = false;
}
export function usDebugState() {
  return {
    activeClients: _activeClients,
    subscribed: [..._subscribed],
    wsOpen: !!(_ws && _ws.readyState === WebSocket.OPEN),
    reconnectAt: _reconnectAt,
    lastWsTick: Object.fromEntries(_lastWsTick),
    fallbackTimer: !!_fallbackTimer,
  };
}

const _fetch = (url, opts) => (_fetchImpl || globalThis.fetch)(url, opts);
const _makeWs = (url) => (_wsFactory ? _wsFactory(url) : new WebSocket(url));

export function usStreamEnabled() { return !!KEY; }

export function usClientUp() {
  _activeClients++;
  _ensureConnected();
  _startFallbackPoller();
}

export function usClientDown() {
  _activeClients = Math.max(0, _activeClients - 1);
  if (_activeClients === 0) {
    _disconnect();
    clearInterval(_fallbackTimer);
    _fallbackTimer = null;
  }
}

function _disconnect() {
  if (_ws) { try { _ws.close(); } catch { /* ws teardown best-effort */ } _ws = null; }
  _connecting = false;
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  clearInterval(_wsAliveTimer); // v10.13: no pings/watchdog on a dead socket
  _wsAliveTimer = null;
  // NOTE: _reconnectAt is intentionally left as-is; _ensureConnected()
  // re-schedules a timer for the remaining backoff when a new client
  // arrives (fixes the reconnect deadlock where the cleared timer plus a
  // future _reconnectAt refused _connect() forever for a new client).
}

// FIX (audit M-2 + deadlock): one place decides whether to connect NOW or
// (re)schedule. Previously a cleared timer + future _reconnectAt deadlocked.
function _ensureConnected() {
  if (!WS_URL || (_ws && _ws.readyState === WebSocket.OPEN)) return;
  if (_connecting) return;
  if (Date.now() < _reconnectAt) {
    _scheduleReconnect(_reconnectAt - Date.now());
    return;
  }
  _connect();
}

function _scheduleReconnect(delayMs) {
  clearTimeout(_reconnectTimer);
  _reconnectAt = Math.max(_reconnectAt, Date.now() + delayMs);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_activeClients > 0) _connect();
  }, Math.max(0, delayMs));
  if (typeof _reconnectTimer.unref === 'function') _reconnectTimer.unref();
}

// v7.0.2: failure-path reconnect with backoff (3s → 6s → 12s → 24s → 30s cap
// + jitter). A successful OPEN resets the streak so ordinary blips still
// reconnect fast (~3s, same as the old fixed close-path delay).
function _scheduleFailureReconnect() {
  const base = Math.min(30_000, 3000 * 2 ** _wsFailStreak);
  _wsFailStreak = Math.min(_wsFailStreak + 1, 5);
  _scheduleReconnect(base + Math.floor(Math.random() * 1000));
}

// ---------------------------------------------------------------
// Yahoo session bootstrap / fallback (live, keyless, correct prevClose)
// ---------------------------------------------------------------
function _fetchYahooSession(sym) {
  // Cache with in-flight sharing: concurrent callers (bootstrap + fallback
  // poller) share ONE round-trip. Entry is either a clean value or a wrapper
  // holding { inFlight: promise } while the fetch is running.
  const cached = _session.get(sym);
  const maxAge = usMarketOpen() ? SESSION_FRESH_OPEN_MS : SESSION_FRESH_CLOSED_MS;
  if (cached && !cached.inFlight && (Date.now() - cached.at) < maxAge) return Promise.resolve(cached);
  if (cached && cached.inFlight) return cached.inFlight;

  const prev = cached ? { ...cached } : null; // clean snapshot (cached is a value here)
  const fetchStartAt = Date.now();
  const p = (async () => {
    let out = null;
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`;
      const r = await _fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI US realtime stream)' },
        signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
      });
      if (r.ok) {
        const j = await r.json();
        const m = j?.chart?.result?.[0]?.meta;
        const price = m?.regularMarketPrice;
        if (typeof price === 'number' && price > 0) {
          const pc = (typeof m.chartPreviousClose === 'number' && m.chartPreviousClose > 0)
            ? m.chartPreviousClose
            : (typeof m.previousClose === 'number' ? m.previousClose : price);
          out = {
            price, pc,
            high: m.regularMarketDayHigh || price,
            low: m.regularMarketDayLow || price,
            vol: m.regularMarketVolume || 0,
            t: (m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now()),
            at: Date.now(),
          };
        }
      }
    } catch { /* upstream transient */ }
    let result;
    if (out) result = out;
    else if (prev && prev.price > 0) {
      // Yahoo failed → serve last-known price, retry in ~5s (at is nudged so
      // the cache goes stale quickly without hammering a dead upstream).
      result = { ...prev, at: Date.now() - maxAge + 5000 };
    } else {
      result = { price: 0, pc: 0, high: 0, low: 0, vol: 0, t: 0, at: Date.now() };
    }
    // RACE FIX (2026 ultra-fast pass): while this Yahoo fetch was in flight,
    // the Finnhub WS trade handler may have mutated the inFlight wrapper with
    // a FRESHER trade price (ref.price/wsAt). Overwriting the wrapper with the
    // (now older) Yahoo snapshot made the price visibly flip back at bootstrap
    // time. Merge instead: keep WS price/t/high/low when the WS tick is newer
    // than the fetch start, take pc/vol from Yahoo.
    const cur = _session.get(sym);
    if (cur && cur.inFlight === p && cur.wsAt && cur.wsAt >= fetchStartAt && cur.price > 0) {
      result = {
        ...result,
        price: cur.price,
        t: cur.t || result.t,
        high: Math.max(result.high || 0, cur.high || 0) || cur.price,
        low: (result.low > 0 && cur.low > 0) ? Math.min(result.low, cur.low) : (result.low || cur.low || cur.price),
        wsAt: cur.wsAt,
        at: Date.now(),
      };
    }
    _session.set(sym, result); // clean value — replaces the inFlight wrapper
    return result;
  })();
  _session.set(sym, { ...(prev || { price: 0, pc: 0, at: 0 }), inFlight: p });
  return p;
}

/**
 * Freshest-known US quote from the running stream session (shared with
 * /api/quote so the browser poller and the SSE stream don't BOTH hit
 * Yahoo for the same symbol — ONE round-trip serves both consumers).
 * Returns null when the session is stale/absent so the caller falls back.
 */
export function getUsSessionQuote(sym, opts = {}) {
  const s = _session.get(String(sym || '').toUpperCase());
  if (!s || !(s.price > 0) || s.inFlight) return null;
  const maxStale = opts.maxStaleMs || (usMarketOpen() ? 8000 : 90 * 1000);
  const freshest = Math.max(s.at || 0, s.wsAt || 0);
  if (Date.now() - freshest > maxStale) return null;
  return {
    price: s.price,
    change: s.pc ? ((s.price - s.pc) / s.pc) * 100 : 0,
    high: s.high || s.price,
    low: s.low || s.price,
    volume: s.vol || 0,
    prevClose: s.pc || s.price,
    time: s.t || freshest || Date.now(),
    source: (s.wsAt && (!s.at || s.wsAt >= s.at)) ? 'finnhub-stream' : 'yahoo-us-fallback',
  };
}

/** Finnhub REST quote — LAST RESORT (Yahoo down). Freshness-gated. */
async function _fetchFinnhubSession(sym) {
  if (!KEY) return null;
  try {
    const r = await _fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${KEY}`,
      { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j.c !== 'number' || j.c <= 0) return null;
    // Stale while market open (previous-session close) → reject (caller keeps Yahoo/last).
    if (isStaleUsQuote(j.t ? j.t * 1000 : 0, Date.now(), usMarketOpen())) return null;
    return {
      price: j.c,
      pc: j.pc || j.c,
      high: j.h || j.c,
      low: j.l || j.c,
      vol: 0,
      t: j.t ? j.t * 1000 : Date.now(),
      at: Date.now(),
    };
  } catch { return null; }
}

/** Instant live snapshot for a newly-subscribed symbol (Yahoo first). */
async function _bootstrapSymbol(sym) {
  let s = await _fetchYahooSession(sym);
  let source = 'yahoo-us-fallback';
  if (!(s.price > 0)) {
    const fh = await _fetchFinnhubSession(sym);
    // v10.13 (deep-recheck M5): REST bootstrap honestly labeled — this is a
    // REST /quote round-trip, not the push stream. 'finnhub-stream' is
    // reserved for actual WS trades (set in the trade handler).
    if (fh) { s = fh; source = 'finnhub-rest'; }
  }
  if (s.price > 0) {
    setTick(`US_${sym}`, {
      price: s.price,
      change: s.pc ? ((s.price - s.pc) / s.pc) * 100 : 0,
      high: s.high || s.price,
      low: s.low || s.price,
      volume: s.vol || 0,
      time: s.t || Date.now(),
      prevClose: s.pc || undefined,
    }, source);
  }
}

// ---------------------------------------------------------------
// TradingView america/scan BATCH (Priority 0) — ONE POST for all gap
// symbols. TV's anonymous scanner serves live 'last'/'close' prices for
// US stocks AND ETFs; the 4-exchange probe (NASDAQ/NYSE/AMEX/ARCA) means
// a wrong-exchange guess never blocks a symbol (first resolve wins).
// Circuit breaker: 5 consecutive failures → 10-minute cooldown, so a
// blocked/rate-limited scanner can never wedge the fallback path.
// ---------------------------------------------------------------
const TV_BATCH_COLUMNS = ['close', 'change', 'high', 'low', 'volume', 'last'];

async function _fetchTvUsBatch(symbols) {
  if (!symbols.length) return {};
  if (_tvFailStreak >= TV_FAIL_LIMIT) {
    if (Date.now() < _tvDisabledUntil) return {};
    _tvFailStreak = 0; // cooldown elapsed — one probe to re-qualify
  }
  try {
    const tickers = [];
    for (const sym of symbols) {
      tickers.push(`NASDAQ:${sym}`, `NYSE:${sym}`, `AMEX:${sym}`, `ARCA:${sym}`);
    }
    const r = await _fetch('https://scanner.tradingview.com/america/scan', {
      method: 'POST',
      headers: TV_SCAN_HEADERS,
      body: JSON.stringify({ symbols: { tickers }, columns: TV_BATCH_COLUMNS }),
      signal: AbortSignal.timeout(TV_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`scan ${r.status}`);
    const j = await r.json();
    const rows = j?.data;
    if (!Array.isArray(rows)) throw new Error('bad payload');
    const out = {};
    for (const row of rows) {
      if (!row || !Array.isArray(row.d)) continue;
      const rawSym = String(row.s || '').split(':')[1];
      if (!rawSym) continue;
      const sym = rawSym.toUpperCase();
      if (out[sym]) continue; // first exchange that resolves wins
      const last = parseFloat(row.d[5]);
      const close = parseFloat(row.d[0]);
      const price = (last > 0) ? last : (close > 0 ? close : 0);
      if (!(price > 0)) continue;
      const changePct = parseFloat(row.d[1]) || 0; // TV 'change' = percent
      const pc = (changePct !== 0 && isFinite(changePct)) ? price / (1 + changePct / 100) : price;
      out[sym] = {
        price, pc: pc > 0 ? pc : price,
        change: changePct,
        high: parseFloat(row.d[2]) || price,
        low: parseFloat(row.d[3]) || price,
        vol: parseFloat(row.d[4]) || 0,
        t: Date.now(),
        at: Date.now(),
      };
    }
    _tvFailStreak = 0;
    return out;
  } catch {
    _tvFailStreak++;
    if (_tvFailStreak >= TV_FAIL_LIMIT) _tvDisabledUntil = Date.now() + TV_COOLDOWN_MS;
    return {};
  }
}

/** Publish a fallback-sourced quote as a tick + session entry (no WS stomp). */
function _publishFallbackQuote(sym, s, source) {
  const lastWs = _lastWsTick.get(sym) || 0;
  if (lastWs > (s.at || 0)) return; // fresher WS tick arrived mid-fetch
  setTick(`US_${sym}`, {
    price: s.price,
    change: s.pc ? ((s.price - s.pc) / s.pc) * 100 : (s.change || 0),
    high: s.high || s.price,
    low: s.low || s.price,
    volume: s.vol || 0,
    time: s.t || Date.now(),
    prevClose: s.pc || undefined,
  }, source);
  // Keep the shared session fresh for /api/quote — but never stomp a
  // fresher WS-updated session entry.
  const cur = _session.get(sym);
  if (!cur || !cur.wsAt || (s.at || 0) >= (cur.wsAt || 0)) {
    _session.set(sym, { ...s });
  }
}

// ---------------------------------------------------------------
// WS-gap fallback poller — TV batch first, Yahoo round-robin second
// ---------------------------------------------------------------
function _startFallbackPoller() {
  if (_fallbackTimer || _subscribed.size === 0) return;
  _fallbackTimer = setInterval(_fallbackPoll, FALLBACK_POLL_MS);
  if (typeof _fallbackTimer.unref === 'function') _fallbackTimer.unref();
}

let _fbCursor = 0;
let _fbPolling = false; // v10.13 (deep-recheck M7): re-entrancy guard
async function _fallbackPoll() {
  // v10.13: the 3s interval can fire while a slow TV batch (4.5s timeout) is
  // still in flight — overlapping _fetchTvUsBatch POSTs to
  // scanner.tradingview.com stack exactly when the upstream is unhealthy
  // (the rate-limit/ban vector the circuit breaker exists to prevent).
  // Yahoo is in-flight-deduped already; the TV batch was not.
  if (_fbPolling) return;
  _fbPolling = true;
  try {
    if (_activeClients === 0 || _subscribed.size === 0) return;

    // Closed market: prices are static — one full refresh per 30s is plenty
    // (the 3s timer keeps ticking but skips the upstream work).
    if (!usMarketOpen()) {
      if (Date.now() - _lastClosedRefresh < CLOSED_REFRESH_MS) return;
      _lastClosedRefresh = Date.now();
    }

    // Symbols the WS has NOT ticked recently → fallback owns them.
    const now = Date.now();
    const gaps = [..._subscribed].filter(sym => (now - (_lastWsTick.get(sym) || 0)) > WS_GAP_MS);
    if (gaps.length === 0) return;

    // ---- Priority 0: TV america/scan batch (ONE request, ALL symbols) ----
    const tvBatch = await _fetchTvUsBatch(gaps.slice(0, TV_BATCH_CAP));
    for (const [sym, s] of Object.entries(tvBatch)) {
      _publishFallbackQuote(sym, s, 'tv-us-batch');
    }

    // ---- Priority 2: Yahoo per-symbol round-robin for TV misses ----
    // (also the ONLY path when TV is circuit-broken / unreachable)
    const leftovers = gaps.filter(sym => !tvBatch[sym]);
    if (leftovers.length === 0) return;
    const batch = [];
    for (let i = 0; i < Math.min(leftovers.length, MAX_FALLBACK_BATCH); i++) {
      batch.push(leftovers[(_fbCursor + i) % leftovers.length]);
    }
    _fbCursor = (_fbCursor + batch.length) % Math.max(1, leftovers.length);

    await Promise.allSettled(batch.map(async (sym) => {
      const s = await _fetchYahooSession(sym);
      if (!(s.price > 0)) return;
      _publishFallbackQuote(sym, s, 'yahoo-us-fallback');
    }));
  } catch { /* transient — retry next cycle */ }
  finally { _fbPolling = false; }
}

// ---------------------------------------------------------------
// Finnhub WebSocket (primary push source)
// ---------------------------------------------------------------
function _connect() {
  if (!WS_URL || _connecting || (_ws && _ws.readyState === WebSocket.OPEN)) return;
  if (_activeClients === 0) return; // don't connect if no clients
  if (Date.now() < _reconnectAt) { _scheduleReconnect(_reconnectAt - Date.now()); return; }
  _connecting = true;
  try {
    const ws = _makeWs(WS_URL);
    _ws = ws;
    ws.on('open', () => {
      _connecting = false;
      _wsFailStreak = 0; // v7.0.2: healthy handshake resets the backoff streak
      _lastWsFrameAt = Date.now(); // v10.13: liveness baseline
      for (const s of _subscribed) ws.send(JSON.stringify({ type: 'subscribe', symbol: s }));
      // v10.13 (deep-recheck M1): ping + idle watchdog — a half-open TCP
      // socket otherwise stays OPEN forever and Priority-1 trades are lost
      // silently for the process lifetime (Yahoo keeps 3s prices flowing).
      clearInterval(_wsAliveTimer);
      _wsAliveTimer = setInterval(() => {
        if (_ws !== ws || ws.readyState !== WebSocket.OPEN) { clearInterval(_wsAliveTimer); _wsAliveTimer = null; return; }
        try { ws.ping(); } catch { /* dead — watchdog will catch it */ }
        if (Date.now() - _lastWsFrameAt > WS_IDLE_KILL_MS) {
          console.warn('[us-stream] Finnhub WS idle >90s (half-open?) — terminating for reconnect');
          try { ws.terminate(); } catch { /* already gone */ }
        }
      }, WS_PING_MS);
      if (typeof _wsAliveTimer.unref === 'function') _wsAliveTimer.unref();
    });
    ws.on('message', (raw) => {
      if (raw && raw.length > WS_MAX_FRAME_BYTES) return; // v10.13 (L10): frame size cap
      _lastWsFrameAt = Date.now(); // ANY frame (incl. pong) proves liveness
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      const latest = {};
      for (const t of msg.data) latest[t.s] = t;
      for (const sym of Object.keys(latest)) {
        if (!_subscribed.has(sym)) continue; // not ours (e.g. dropped long ago)
        const t = latest[sym];
        const price = t.p;
        if (!(price > 0)) continue;
        _lastWsTick.set(sym, Date.now());
        const ref = _session.get(sym);
        const pc = ref?.pc || 0;
        setTick(`US_${sym}`, {
          price,
          change: pc ? ((price - pc) / pc) * 100 : 0,
          high: Math.max(ref?.high || price, price),
          low: (ref?.low && ref.low < price) ? ref.low : price,
          volume: (typeof t.v === 'number' && t.v > 0) ? t.v : 0,
          time: t.t || Date.now(),
          prevClose: pc || undefined,
        }, 'finnhub-stream');
        // Track the session running high/low + freshest price so they don't
        // go stale (getUsSessionQuote serves /api/quote from this).
        if (ref) {
          ref.price = price;
          ref.t = t.t || Date.now();
          ref.wsAt = Date.now();
          if (price > (ref.high || 0)) ref.high = price;
          if (!ref.low || price < ref.low) ref.low = price;
        }
      }
    });
    ws.on('close', () => {
      // 2026 perf audit (M1): stale-handler guard. Race: last client leaves →
      // _disconnect() closes socket A (handshake takes ms) → new client →
      // _connect() sets _ws = B → A's 'close' finally fires → without this
      // guard it would null out B (leaked OPEN socket + duplicate trades).
      if (_ws !== ws) return;
      _connecting = false; _ws = null;
      if (_wsAliveTimer) { clearInterval(_wsAliveTimer); _wsAliveTimer = null; } // v10.13
      // Only reconnect if clients still active (FIX audit M-2: actually schedule it).
      // v7.0.2: backoff path — never got a healthy OPEN on this socket.
      if (_activeClients > 0) _scheduleFailureReconnect();
    });
    ws.on('error', () => {
      if (_ws !== ws) return; // stale handler from a replaced socket (M1)
      _connecting = false; try { ws.close(); } catch { /* ws teardown best-effort */ }
      _ws = null;
      if (_wsAliveTimer) { clearInterval(_wsAliveTimer); _wsAliveTimer = null; } // v10.13
      if (_activeClients > 0) _scheduleFailureReconnect();
    });
  } catch { _connecting = false; _scheduleFailureReconnect(); }
}

// ---------------------------------------------------------------
// Subscription API (called from /api/stream)
// ---------------------------------------------------------------

/** FIFO semaphore (2026 perf audit M4): a big watchlist first-subscribing
 *  60 symbols used to fire 60 PARALLEL Yahoo chart fetches (burst CPU +
 *  rate-limit exposure exactly at page-load). Bounded here instead. */
const _bootSem = { active: 0, queue: [] };
function _enqueueBootstrap(sym) {
  const run = () => {
    _bootstrapSymbol(sym)
      .catch(() => { })
      .finally(() => {
        _bootSem.active--;
        while (_bootSem.queue.length && _bootSem.active < BOOT_CONCURRENCY) {
          _bootSem.active++;
          _bootSem.queue.shift()();
        }
      });
  };
  if (_bootSem.active < BOOT_CONCURRENCY) { _bootSem.active++; run(); }
  else _bootSem.queue.push(run);
}

export function ensureUsSubscribed(symbols) {
  const fresh = [];
  for (const s of symbols || []) {
    const sym = String(s).replace('.NS', '').replace('.BO', '').trim().toUpperCase();
    if (!sym) continue;
    // Refcount up + cancel any pending eviction (2026 perf audit M2).
    if (_evictTimers.has(sym)) {
      clearTimeout(_evictTimers.get(sym));
      _evictTimers.delete(sym);
    }
    _refcounts.set(sym, (_refcounts.get(sym) || 0) + 1);
    if (!_subscribed.has(sym)) {
      _subscribed.add(sym);
      fresh.push(sym);
      _enqueueBootstrap(sym); // instant live Yahoo snapshot (RC3 fix), bounded
    }
  }
  // (Re)connect / subscribe on the live socket when clients are already active.
  if (_activeClients > 0) {
    _ensureConnected();
    _startFallbackPoller();
    if (_ws && _ws.readyState === WebSocket.OPEN && fresh.length) {
      fresh.forEach(s => { try { _ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); } catch { /* reconnect will resubscribe */ } });
    }
  }
}

// ---------------------------------------------------------------
// Refcount release (2026 perf audit M2) — the subscribed set used to grow
// forever: every US symbol ever requested stayed WS-subscribed + Yahoo-
// polled for the whole process lifetime. Now the LAST interested client
// leaving schedules a graceful unsubscribe (long enough for an EventSource
// auto-reconnect to re-claim the symbol on a blip).
// ---------------------------------------------------------------
export function releaseUsSubscribed(symbols) {
  for (const s of symbols || []) {
    const sym = String(s).replace('.NS', '').replace('.BO', '').trim().toUpperCase();
    if (!sym) continue;
    const n = (_refcounts.get(sym) || 1) - 1;
    if (n > 0) { _refcounts.set(sym, n); continue; }
    _refcounts.delete(sym);
    if (_evictTimers.has(sym)) continue;
    const t = setTimeout(() => {
      _evictTimers.delete(sym);
      if (_refcounts.has(sym)) return; // re-subscribed meanwhile
      _subscribed.delete(sym);
      _lastWsTick.delete(sym);
      _session.delete(sym);
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        try { _ws.send(JSON.stringify({ type: 'unsubscribe', symbol: sym })); } catch { /* reconnect will resync */ }
      }
    }, EVICT_GRACE_MS);
    if (typeof t.unref === 'function') t.unref();
    _evictTimers.set(sym, t);
  }
}

// Housekeeping: keep the session map bounded.
setInterval(() => {
  if (_session.size > 500) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of _session) if ((v.at || 0) < cutoff && !v.inFlight) _session.delete(k);
  }
}, 5 * 60 * 1000).unref?.();
