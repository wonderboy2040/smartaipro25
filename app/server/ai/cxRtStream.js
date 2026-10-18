// ============================================================
// server/ai/cxRtStream.js — v10.11 COINDCX DIRECT ULTRA-FAST RT
// ------------------------------------------------------------
// THE BUG (user report, v10.10): the CoinDCX tab's three desks — SPOT,
// GLOBAL FUTURES (USDT perps) and EQUITY SIM (USDC) — showed
// signal-card prices that were minutes old (board cache 90s +
// futures price cache 20s + frontend 30s poll). Stale LTP next to
// a fresh-looking call = "wrong call / wrong signal" experience.
//
// THE v10.10 FIX: a dedicated 2s DIRECT-from-CoinDCX poller that feeds
// liveFeed (and therefore the /api/stream SSE) for the two domains the
// existing streams never covered:
//   FUT_<BASE>   B-<BASE>_USDT perp LTP   (public.coindcx.com
//                /market_data/v3/current_prices/futures/rt)
//   GLOB_<SYM>   B-<SYM>_USDC global equity perp LTP (same feed,
//                USDC margin domain — CoinDCX app parity) with the
//                Finnhub fallback first and Yahoo as the final
//                fallback (10s cadence, never 2s) for names the RT
//                feed doesn't carry.
// SPOT needs nothing new — cryptoStream already publishes INR ticks
// at 2s (CoinDCX anchor) with the ~1s Binance WS accelerator.
//
// THE v10.11 UPGRADE (user plan #1/#3/#5):
//   • WEBSOCKET ACCELERATOR — CoinDCX's documented futures socket
//     (wss://stream.coindcx.com). v11.3 (live-verified): the protocol
//     is Socket.IO v4 / Engine.IO 4 and the attributable stream is the
//     FULL-BOOK channel "currentPrices@futures@rt" (~500 USDT perps,
//     ~1/sec, ls/pc/v/mp rows with pair keys) — the old per-pair
//     "@prices-futures" price-change events carry NO pair identity.
//     The socket pushes ticks EVENT-DRIVEN — no 2s ceiling while it
//     flows. The REST poller becomes the degrade path + the
//     illiquidity floor:
//       WS healthy (attributable ticks < 30s old)  → REST @ 10s floor
//       WS down / unproven / silent-contract       → REST @ 2s (v10.10)
//     The "healthy" proof is an ACTUAL landed tick — a socket that
//     connects but never yields an attributable price-change (docs'
//     sample payload is incomplete, so attribution is best-effort)
//     keeps the full 2s REST cadence: ZERO regression possible.
//   • SOURCE TRANSPARENCY (#1) — every tick carries its source label:
//     'coindcx-fut-rt' / 'coindcx-fut-ws' (USDT perps), 'coindcx-glob-rt'
//     / 'coindcx-glob-ws' (USDC equity perps), 'finnhub-global-rt'
//     (fallback #1), 'yahoo-global-rt' (final fallback), 'global-sim-rt'
//     (SPACEX), 'binance-fut-rt' (CoinDCX-dark fallback). The SSE wire
//     carries it as `source` and the frontend renders the badge.
//   • v10.15 BINANCE FUT WS ACCELERATOR (deep-recheck #2 S1) — while the
//     CoinDCX socket is dark/unproven/cooling, wss://fstream.binance.com
//     combined <base>usdt@ticker streams serve FUT_ SUB-SECOND (source
//     'binance-fut-ws'), hot-standby style: the socket opens ONLY when
//     the CoinDCX WS isn't proving ticks, and closes the moment it is.
//     The Binance REST 5s path becomes the NEXT fallback instead of the
//     only one — the "CoinDCX socket dark → 5s REST" speed cliff is gone.
//
// Behaviour mirrors cryptoStream.js (the proven pattern):
//   • refcounted per-symbol subscriptions, graceful 90s eviction
//   • timer only runs while ≥1 SSE client is connected (Render
//     free-tier friendly — zero upstream cost when nobody watches)
//   • shared single-flight upstream fetches (futures.js /
//     globalFutures.js own the caches; we just ask for ≤1.3s-fresh
//     data, so the stream and the board compute share round-trips)
//   • serve-stale on transient failure: liveFeed keeps the last
//     good tick; the SSE throttle hides sub-400ms jitter.
// ============================================================
import { setTick, getTick } from '../liveFeed.js';
import { fetchFuturesPrices } from './futures.js';
import { fetchGlobalFuturesRt, fetchGlobalQuotes, syntheticPriceAt, GLOBAL_FUTURES_UNIVERSE } from './globalFutures.js';
import { createCxSocketIo } from './cxSocketIo.js';
// v18.10: the OFFICIAL spot socket's health rides the same status
// frame — the CoinDCX desk badge can honestly say "SPOT - WS" when the
// INR book is WS-owned (sub-second direct pushes are live).
import { spotWsStatus } from './cxSpotWs.js';
import { mergeFutBook, futBookStats, _resetFutBookForTest } from './cxBookState.js';
import {
  syncBinanceFutAccelerator, binanceFutHealthy, binanceFutStatus, setBinanceFutOnLand,
  _setBinanceFutWsFactoryForTest, _resetBinanceFutWsForTest, _setBinanceFutNowForTest, _setBinanceFutWsEnabledForTest,
} from './binanceFutWs.js';

const POLL_MS = 2000;              // full-speed REST cadence (WS down / unproven)
const REST_HEARTBEAT_MS = 10_000;  // REST floor cadence (WS healthy + writing)
// v12.6 BANDWIDTH: prolonged total-WS-outage backoff (see _restIntervalMs)
const WS_LONG_DARK_BACKOFF_MS = 120_000; // 2 min of no WS ticks anywhere → slow down
const WS_LONG_DARK_POLL_MS = 5000;      // the outage cadence (was 2s — ~13GB/day)
const RT_MAX_AGE_MS = 1300;        // ask the shared caches for ≤1.3s-old rows
const FALLBACK_MS = 10_000;        // Finnhub/Yahoo fallback cadence (rate-polite)
const EVICT_GRACE_MS = 90_000;     // unsubscribes wait for SSE auto-reconnect
// v11.3: the futures socket's FULL-BOOK channel — one join covers every
// USDT perp (~500 pairs, ~1/sec, ATTRIBUTABLE pair keys: ls/pc/v/mp in
// each row). The old per-pair "@prices-futures" price-change events carry
// NO pair identity, so they could never be attributed when more than one
// channel was joined — the book channel fixes that structurally.
const FUT_BOOK_CHANNEL = 'currentPrices@futures@rt';
// Binance perp fallback (the SAME chain the futures board itself uses when
// CoinDCX RT goes dark — 1:1 USDT domain, zero projection risk). Cached 5s
// so a WAF blip on CoinDCX never stalls the stream longer than one beat.
// v12.7 BANDWIDTH (recheck R2-#4 — the 17-35GB/day whale): the FULL
// ~500-symbol fapi/ticker/24hr book is 1-2MB per beat while CoinDCX is
// dark; the stream only ever reads the SUBSCRIBED bases. ?symbols=
// (Binance JSON-array param) cuts the payload to exactly those (~2-40KB,
// and a fraction of the request weight). Cache is signature-keyed so a
// symbol-set change never serves a stale slice.
const BINANCE_FUT_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const BINANCE_FUT_CACHE_MS = 5_000;
let _bnFut = { at: 0, sig: '', byBase: null }; // { at, sig, byBase: Map<BASE, row> }

// ---- v10.11 CoinDCX futures WebSocket (docs.coindcx.com) ----
// v11.3 (live-verified 2026-09-17): EIO=4 — the EIO=3 URL completes the
// handshake but the server kills the socket ~1s after the ns-ack, so the
// accelerator NEVER delivered a tick in production. EIO=4 flows.
const DCX_WS_URL = 'wss://stream.coindcx.com/socket.io/?EIO=4&transport=websocket';
const WS_TICK_FRESH_MS = 30_000;      // a landed tick within 30s proves the WS contract works
const WS_SILENT_KILL_MS = 120_000;    // ns-connected but ZERO attributable ticks → contract mismatch (crypto domain)
const WS_FAIL_LIMIT = 3;              // consecutive handshake failures → cooldown
const WS_COOLDOWN_MS = 10 * 60_000;   // then stop hammering the socket for 10 min
const WS_RECONNECT_MS = 3_000;        // base reconnect delay (backoff ×2 → 24s cap)
// v10.14 (deep-recheck S2) DOMAIN-AWARE LIVENESS: crypto USDT perps tick
// sub-second — 2 min of total silence really IS a broken contract. But
// USDC equity perps (AAPL/MU/SPCX synthetics) legitimately go minutes
// without a print, ESPECIALLY in US premarket (04:00–09:30 ET) when the
// underlying market itself hasn't opened. The old flat 120s watchdog
// mistook a quiet-but-healthy GLOB-only session for a docs mismatch →
// killed the socket → benched the accelerator for 10 min = the
// "ultra-fast feel gone in premarket" regression. GLOB-only sessions
// now get a 5-min budget (7.5-min in premarket) and a shorter 3-min
// cooldown when the quiet-kill does fire; FUT-subscribed sessions keep
// the strict crypto thresholds unchanged.
const GLOB_SILENT_KILL_MS = 300_000;
const GLOB_PREMARKET_SILENT_KILL_MS = 450_000;
const GLOB_QUIET_COOLDOWN_MS = 3 * 60_000;

// ---- per-domain state (same shape as cryptoStream's spot book) ----
const _futSubscribed = new Set();      // BASE (BTC, ETH, …)
const _globSubscribed = new Set();     // SYM (AAPL, NVDA, …)
const _futRefcounts = new Map();
const _globRefcounts = new Map();
const _evictTimers = new Map();        // "FUT:BTC" / "GLOB:AAPL" → timer
let _timer = null;
let _timerMs = 0;                      // current REST interval (2s or 10s floor)
let _activeClients = 0;
let _sessionStartAt = 0;               // v12.6: darkness-window anchor (never-proven WS)
// (v11.4 poll coalescing state lives at _pollOnce itself)
let _fallbackAt = 0;                   // last Finnhub/Yahoo fallback fetch epoch

// ---- WS state ----
let _io = null;                        // the cxSocketIo controller
let _wsFactory = null;                 // test injection
let _wsEnabled = true;                 // production ON; _resetCxRtForTest disables (hermetic suites)
let _wsFailStreak = 0;                 // consecutive handshake failures
let _wsDisabledUntil = 0;              // circuit-breaker cooldown
let _wsCooldownReason = null;          // v10.14: 'handshake-streak' | 'silent-contract' | 'glob-quiet'
let _wsReconnectTimer = null;
let _wsLastTickAt = 0;                 // last ATTRIBUTABLE WS tick epoch (the proof)
let _wsOpenedAt = 0;                   // ns-connect epoch (silent-contract watchdog)

// test injection
let _nowFn = () => Date.now();
let _usPremarketFn = null;             // v10.14: injectable premarket clock (hermetic tests)
export function _setCxRtNowForTest(fn) { _nowFn = fn || (() => Date.now()); }
export function _setDcxWsFactoryForTest(fn) { _wsFactory = fn; }
export function _setDcxWsEnabledForTest(v) { _wsEnabled = !!v; }
export function _setUsPremarketForTest(fn) { _usPremarketFn = fn; }
// v10.15: re-export the accelerator tier's injection hooks so the
// cxRtStream suites can arm BOTH sockets from one import (the file
// already followed this style with _setBinanceFutFetchForTest).
export { _setBinanceFutWsFactoryForTest, _setBinanceFutNowForTest, _setBinanceFutWsEnabledForTest };

const _num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };

// v10.15: a landed accelerator tick slows the REST poller to the 10s
// floor INSTANTLY (not on the next beat) — same contract as a landed
// CoinDCX WS tick. Registered once at import; hermetic resets are safe
// (the callback only touches state _resetCxRtForTest clears).
setBinanceFutOnLand(() => { _syncRestCadence(); });

// ---------------------------------------------------------------
// Client lifecycle — start/stop the REST poller + WS with the
// connection count (exactly cryptoClientUp/cryptoClientDown semantics).
// ---------------------------------------------------------------
export function cxRtClientUp() { _activeClients++; _startIfNeeded(); }
export function cxRtClientDown() { _activeClients = Math.max(0, _activeClients - 1); _stopIfIdle(); }

// ---------------------------------------------------------------
// v10.15 — the Binance futures WS accelerator tier sync.
// Called on EVERY state flip (client up/down, universe change, cx WS
// health change, each poll beat): idempotent, cheap, and the ONLY
// place that maps cxRtStream state → the tier's open/close decision.
// wantOpen = "CoinDCX WS is NOT proving ticks right now" — normal
// operation (cx healthy) keeps the accelerator CLOSED so behavior is
// byte-identical to v10.14 until CoinDCX actually goes dark.
// ---------------------------------------------------------------
function _syncBinanceFutTier() {
  syncBinanceFutAccelerator({
    active: _activeClients > 0,
    wantOpen: !_wsHealthy(),
    universe: [..._futSubscribed],
  });
}

function _startIfNeeded() {
  if (_timer || (_futSubscribed.size === 0 && _globSubscribed.size === 0)) return;
  _sessionStartAt = _nowFn(); // v12.6: the 2-min "fresh session" grace begins
  _pollOnce(); // instant first tick — a fresh page paints live prices NOW
  _timerMs = _restIntervalMs();
  _timer = setInterval(_pollOnce, _timerMs);
  if (_timer.unref) _timer.unref();
  _ensureWs();
  _syncBinanceFutTier();
}

function _stopIfIdle() {
  if (_activeClients > 0 || !_timer) return;
  clearInterval(_timer);
  _timer = null;
  _closeWs('idle');
  _syncBinanceFutTier();
}

/** REST cadence: 10s floor while the WS is proven writing ticks
 *  (event-driven freshness + a guaranteed floor for illiquid perp
 *  channels that can go minutes without a price-change event);
 *  full 2s whenever the WS is down / unproven / silent.
 *  v10.15: the floor ALSO applies when the Binance futures WS
 *  accelerator owns FUT sub-second (CoinDCX WS dark) AND no GLOB
 *  symbol needs the 2s REST floor — GLOB has no Binance path, so a
 *  GLOB-subscribed session keeps the full 2s cadence whenever the
 *  CoinDCX WS is dark. */
function _restIntervalMs() {
  if (_wsHealthy()) return REST_HEARTBEAT_MS;
  if (_futSubscribed.size > 0 && _globSubscribed.size === 0 && binanceFutHealthy()) return REST_HEARTBEAT_MS;
  // v12.6 BANDWIDTH: a PROLONGED total-WS outage (no cx WS, no Binance
  // fut tier for 2+ minutes) backs the full REST poller off to 5s —
  // the 2s cadence hammers the futures price map (~100-300KB/beat,
  // ~13GB/day) exactly when every accelerator is dark; 5s halves that
  // while keeping the RT feed honest. The first 2 minutes of a session
  // stay at 2s (a blip must not feel slow); any WS tick resets the
  // window (the latch releases on _syncRestCadence seeing health).
  const _bnLastLand = Number(binanceFutStatus()?.lastTickAt) || 0;
  const anchor = Math.max(_wsLastTickAt || 0, _bnLastLand || 0, _sessionStartAt || 0);
  if (anchor > 0 && (_nowFn() - anchor) > WS_LONG_DARK_BACKOFF_MS) return WS_LONG_DARK_POLL_MS;
  return POLL_MS;
}

/** Healthy = ns-connected AND an attributable tick landed recently.
 *  Connection alone proves nothing (the event payload's attribution
 *  shape is best-effort from incomplete docs) — only a LANDED tick
 *  downgrades the REST cadence, so the desks can never regress. */
function _wsHealthy() {
  return !!_io
    && _io.state().connected
    && (_nowFn() - _wsLastTickAt) < WS_TICK_FRESH_MS;
}

/** Restart the REST interval when the desired cadence flips
 *  (WS healed → slow to 10s floor; WS dropped → back to 2s). */
function _syncRestCadence() {
  if (!_timer) return;
  const want = _restIntervalMs();
  if (want === _timerMs) return;
  clearInterval(_timer);
  _timerMs = want;
  _timer = setInterval(_pollOnce, _timerMs);
  if (_timer.unref) _timer.unref();
}

// ---------------------------------------------------------------
// Subscriptions (refcounted, graceful eviction — the cryptoStream
// M2 pattern: the subscribed set must never grow forever).
// ---------------------------------------------------------------
export function ensureCxRtSubscribed({ fut, glob } = {}) {
  const newFut = [];
  const newGlob = [];
  for (const s of fut || []) {
    const base = String(s).trim().toUpperCase();
    if (!base) continue;
    _cancelEviction(`FUT:${base}`);
    _futRefcounts.set(base, (_futRefcounts.get(base) || 0) + 1);
    if (!_futSubscribed.has(base)) { _futSubscribed.add(base); newFut.push(base); }
  }
  // v11.3: live socket → nothing to join for FUT (the book channel is
  // already joined once per socket); only GLOB grows the join list.
  for (const s of glob || []) {
    const sym = String(s).trim().toUpperCase();
    if (!sym) continue;
    _cancelEviction(`GLOB:${sym}`);
    _globRefcounts.set(sym, (_globRefcounts.get(sym) || 0) + 1);
    if (!_globSubscribed.has(sym)) { _globSubscribed.add(sym); newGlob.push(sym); }
  }
  // live socket → join the NEW GLOB channels immediately (no reconnect
  // needed; FUT rides the always-joined book channel).
  // v11.4 recheck: was gated on `.connected` — a GLOB symbol subscribed
  // during the ~8s handshake window never entered io._channels (join()
  // queues safely until the ns-connect ack), so it silently lost WS ticks
  // for the socket's LIFETIME and rode the 10s REST floor instead.
  if (_io) {
    for (const sym of newGlob) _io.join(_globChannel(sym));
  }
  // a fresh universe while clients are live → immediate poll so the
  // new symbols get their first tick within ~2s, not POLL_MS + lag.
  if (_activeClients > 0 && (newFut.length || newGlob.length)) {
    if (!_timer) _startIfNeeded();
    else { _ensureWs(); _syncBinanceFutTier(); _pollOnce(); }
  }
}

export function releaseCxRtSubscribed({ fut, glob } = {}) {
  for (const s of fut || []) {
    const base = String(s).trim().toUpperCase();
    if (!base) continue;
    const n = (_futRefcounts.get(base) || 1) - 1;
    if (n > 0) { _futRefcounts.set(base, n); continue; }
    _futRefcounts.delete(base);
    // v11.3: no per-pair FUT channel to leave — the book channel serves
    // all pairs and stays joined while ANY subscription exists.
    _scheduleEviction('FUT', base, () => { _futSubscribed.delete(base); });
  }
  for (const s of glob || []) {
    const sym = String(s).trim().toUpperCase();
    if (!sym) continue;
    const n = (_globRefcounts.get(sym) || 1) - 1;
    if (n > 0) { _globRefcounts.set(sym, n); continue; }
    _globRefcounts.delete(sym);
    _scheduleEviction('GLOB', sym, () => { _globSubscribed.delete(sym); _leaveChannel(_globChannel(sym)); });
  }
}

function _scheduleEviction(domain, sym, fn) {
  const key = `${domain}:${sym}`;
  if (_evictTimers.has(key)) return;
  const t = setTimeout(() => {
    _evictTimers.delete(key);
    // someone re-subscribed meanwhile → keep polling
    if (domain === 'FUT' ? _futRefcounts.has(sym) : _globRefcounts.has(sym)) return;
    fn();
  }, EVICT_GRACE_MS);
  if (typeof t.unref === 'function') t.unref();
  _evictTimers.set(key, t);
}

function _cancelEviction(key) {
  if (_evictTimers.has(key)) {
    clearTimeout(_evictTimers.get(key));
    _evictTimers.delete(key);
  }
}

// ---------------------------------------------------------------
// The REST poll — DIRECT CoinDCX, both perpetual domains in one
// tick so the browser gets a coherent snapshot per beat. This is
// now the degrade path + the illiquidity floor under the WS.
// ---------------------------------------------------------------
// v11.4 recheck: COALESCING re-entrancy guard (same discipline as usStream
// _fallbackPoll / inStream _tick) — a slow beat must never overlap the next
// one; overlapping requests stack exactly when upstreams are unhealthy.
// A beat that arrives while one is running JOINS it (awaiting the in-flight
// promise) instead of being dropped — callers like the test hook (and the
// subscribe-triggered immediate poll) then observe the beat they asked for.
let _pollInflight = null;
function _pollOnce() {
  if (_activeClients === 0) return Promise.resolve();
  if (_pollInflight) return _pollInflight;
  _pollInflight = (async () => {
    try {
      const now = _nowFn();
      const jobs = [];
      if (_futSubscribed.size > 0) jobs.push(_pollFutures(now));
      if (_globSubscribed.size > 0) jobs.push(_pollGlobal(now));
      await Promise.allSettled(jobs);
      _wsSilentContractWatchdog(now);
      _syncRestCadence();
      // post-cooldown recovery: a watchdog kill / circuit-breaker arms NO
      // reconnect timer (by design), so the next REST beat retries the WS
      // once the cooldown has expired. Without this, a single silent-contract
      // kill would keep the accelerator off for the whole process lifetime.
      _ensureWs();
      // v10.15: the Binance tier follows the (possibly changed) cx WS health.
      _syncBinanceFutTier();
    } finally {
      _pollInflight = null;
    }
  })();
  return _pollInflight;
}

/** v11.3: map a fetchFuturesPrices row's `source` to the liveFeed
 *  source label — honest per-tick attribution across ALL legs. */
function _futRowSource(r) {
  if (r?.source === 'ws-book') return 'coindcx-fut-ws';
  if (r?.source === 'binance-fut' || r?.source === 'bybit-fut') return 'binance-fut-rt';
  return 'coindcx-fut-rt';
}

async function _pollFutures(_now) {
  const covered = new Set();
  try {
    const rows = await fetchFuturesPrices({ maxAgeMs: RT_MAX_AGE_MS });
    if (Array.isArray(rows)) {
      // one pass — subscribed bases only (the whole RT book is ~100 rows)
      const byBase = new Map(rows.map(r => [r.base, r]));
      for (const base of _futSubscribed) {
        const r = byBase.get(base);
        if (!r || !(r.last > 0)) continue;
        covered.add(base);
        // v11.3 HONEST LABEL: fetchFuturesPrices now has fallback legs
        // (WS book / Binance-fut / Bybit-fut) — the tick must say which
        // feed ACTUALLY served it, never blanket-'coindcx-fut-rt'.
        const src = _futRowSource(r);
        const chg = Number(r.changePct) || 0;
        setTick(`FUT_${base}`, {
          price: r.last,
          change: chg,
          high: r.high > 0 ? r.high : r.last,
          low: r.low > 0 ? r.low : r.last,
          volume: r.volume || 0,
          time: r.ts > 0 ? r.ts : _nowFn(),
          prevClose: chg > -100 ? r.last / (1 + chg / 100) : undefined,
        }, src);
      }
    }
  } catch { /* transient upstream failure — fallback below + liveFeed serves the last good tick */ }
  // CoinDCX RT dark (WAF blip / 403 / timeout) → Binance USDT perps, same
  // domain, honestly labeled. The stream never goes silent on one feed.
  // v10.15: symbols the Binance FUT WS is already serving sub-second
  // (<5s-old 'binance-fut-ws' tick) are NOT re-fetched over REST — the WS
  // is the accelerator tier, REST 5s is only the tier BELOW it.
  const missing = [..._futSubscribed].filter(b => !covered.has(b) && !_binanceWsFreshFor(b));
  if (missing.length > 0) {
    // v12.7: only the MISSING bases ride the Binance fallback — the
    // full ~500-symbol book was the outage-mode bandwidth whale.
    const byBase = await _binanceFutBook(missing).catch(() => null);
    if (byBase) {
      for (const base of missing) {
        const r = byBase.get(base);
        if (!r || !(r.last > 0)) continue;
        const chg = Number(r.changePct) || 0;
        setTick(`FUT_${base}`, {
          price: r.last,
          change: chg,
          high: r.high > 0 ? r.high : r.last,
          low: r.low > 0 ? r.low : r.last,
          volume: r.volume || 0,
          time: _nowFn(),
          prevClose: chg > -100 ? r.last / (1 + chg / 100) : undefined,
        }, 'binance-fut-rt');
      }
    }
  }
}

/** Binance USDT-perp 24h ticker book, Map<BASE, row>, 5s cache — the
 *  fallback chain for the FUT domain (mirrors the board's own).
 *  Test-injectable via _setBinanceFutFetchForTest. */
let _bnFutFetchImpl = null;
export function _setBinanceFutFetchForTest(fn) { _bnFutFetchImpl = fn; }
// v11.4 recheck: in-flight dedup + negative cache — on failure nothing
// was cached, so during a CoinDCX-dark + slow-Binance episode every 2s
// beat stacked ANOTHER full ~1-2MB fapi/ticker/24hr fetch while the
// previous was still pending (the exact rate-limit/ban vector the
// usStream/inStream guards exist for).
let _bnFutInflight = null;
let _bnFutNegUntil = 0;
/** v12.7: canonical signature of a bases request (sorted, upper, joined) —
 * empty string = the full-book request. */
function _bnFutSig(bases) {
  return Array.isArray(bases) && bases.length > 0
    ? [...new Set(bases.map(b => String(b || '').toUpperCase()).filter(Boolean))].sort().join(',')
    : '';
}
/** v21.13.x recheck (P2): per-symbol request URLs — fapi IGNORES the
 * ?symbols= JSON-array param (live-verified: full ~793-row ~1.1MB book
 * comes back anyway) so the v12.7 filter was silently defeated and a
 * CoinDCX-dark episode re-pulled the whale every 2s poll. Single
 * `symbol=` params work: ~20 tiny rows, LOWER total weight (N×1 vs 40).
 * Null when the caller wants the full book. */
function _bnFutSymbolUrls(sig) {
  if (!sig) return null;
  const symbols = sig.split(',').map(b => `${b}USDT`).slice(0, 100);
  return symbols.length > 0
    ? symbols.map(s => `${BINANCE_FUT_URL}?symbol=${encodeURIComponent(s)}`)
    : null;
}
async function _binanceFutBook(bases) {
  const now = _nowFn();
  const sig = _bnFutSig(bases);
  if (_bnFut.byBase && (now - _bnFut.at) < BINANCE_FUT_CACHE_MS && _bnFut.sig === sig) return _bnFut.byBase;
  if (now < _bnFutNegUntil) throw new Error('binance fut: negative cache');
  if (_bnFutInflight && _bnFutInflight.sig === sig) return _bnFutInflight.p;
  const inflight = { sig, p: null };
  inflight.p = (async () => {
    const f = _bnFutFetchImpl || globalThis.fetch;
    const urls = _bnFutSymbolUrls(sig);
    let j = null;
    if (urls) {
      // per-symbol fan-out (each row ~600B — total ~2-20KB); a failed
      // symbol is skipped honestly, zero rows = the legacy full-book leg
      const settled = await Promise.allSettled(urls.map(async (u) => {
        const r = await f(u, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) throw new Error(`binance fut HTTP ${r.status}`);
        return r.json();
      }));
      j = settled.filter(s => s.status === 'fulfilled').map(s => s.value).filter(Boolean);
      if (!Array.isArray(j) || j.length === 0) j = null; // fall to the full-book leg
    }
    // v21.13.x recheck (P2b): the row extraction is retried against the
    // full book when the per-symbol leg resolves but yields ZERO valid
    // bases (fapi answers invalid symbols with {"code":-1121} OBJECTS —
    // non-empty j, no rows). One shared extractor, two legs.
    const wanted = sig ? new Set(sig.split(',')) : null;
    const byBase = new Map();
    for (const x of (j || [])) {
      if (!x || typeof x.symbol !== 'string' || !x.symbol.endsWith('USDT')) continue;
      const base = x.symbol.slice(0, -4);
      if (wanted && !wanted.has(base)) continue; // belt-and-braces: only what we asked
      const last = parseFloat(x.lastPrice);
      if (!base || !(last > 0)) continue;
      byBase.set(base, {
        last,
        changePct: parseFloat(x.priceChangePercent) || 0,
        high: parseFloat(x.highPrice) || 0,
        low: parseFloat(x.lowPrice) || 0,
        volume: parseFloat(x.volume) || 0,
      });
    }
    // v21.13.x recheck (P2b): the full-book leg runs whenever ZERO valid
    // bases were extracted — per-symbol all-rejected (j null), per-symbol
    // resolving as error objects ({"code":-1121}: non-empty j, no rows),
    // ya the no-sig full-book caller (urls null, j null). One condition,
    // every path covered.
    if (byBase.size === 0) {
      const r = await f(BINANCE_FUT_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error(`binance fut HTTP ${r.status}`);
      j = await r.json();
      if (!Array.isArray(j)) j = null;
      for (const x of (j || [])) {
        if (!x || typeof x.symbol !== 'string' || !x.symbol.endsWith('USDT')) continue;
        const base = x.symbol.slice(0, -4);
        if (wanted && !wanted.has(base)) continue;
        const last = parseFloat(x.lastPrice);
        if (!base || !(last > 0)) continue;
        byBase.set(base, {
          last,
          changePct: parseFloat(x.priceChangePercent) || 0,
          high: parseFloat(x.highPrice) || 0,
          low: parseFloat(x.lowPrice) || 0,
          volume: parseFloat(x.volume) || 0,
        });
      }
    }
    if (byBase.size === 0) throw new Error('binance fut: empty');
    _bnFut = { at: _nowFn(), sig, byBase };
    return byBase;
  })();
  _bnFutInflight = inflight;
  try {
    return await inflight.p;
  } catch (e) {
    // 10s negative cache — the poll cadence keeps ticking but the fetch
    // backs off instead of stacking.
    _bnFutNegUntil = _nowFn() + 10_000;
    throw e;
  } finally {
    if (_bnFutInflight === inflight) _bnFutInflight = null;
  }
}

/** v10.15: is FUT_<base> currently served by the Binance WS accelerator
 *  (a fresh <5s binance-fut-ws tick)? Such symbols skip the REST fallback. */
function _binanceWsFreshFor(base) {
  const t = getTick(`FUT_${base}`);
  return !!t && t.source === 'binance-fut-ws' && (_nowFn() - (t.time || 0)) < 5000;
}

async function _pollGlobal(now) {
  try {
    // 1) CoinDCX USDC perp RT — the app-parity direct feed (2s)
    const rt = await fetchGlobalFuturesRt({ maxAgeMs: RT_MAX_AGE_MS }).catch(() => null);
    const covered = new Set();
    if (rt && rt.size > 0) {
      for (const sym of _globSubscribed) {
        const row = rt.get(sym);
        if (!row || !(row.price > 0)) continue;
        covered.add(sym);
        const chg = Number(row.changePct) || 0;
        setTick(`GLOB_${sym}`, {
          price: row.price,
          change: chg,
          high: row.high > 0 ? row.high : row.price,
          low: row.low > 0 ? row.low : row.price,
          volume: row.volume || 0,
          time: row.ts > 0 ? row.ts : now,
          prevClose: chg > -100 ? row.price / (1 + chg / 100) : undefined,
        }, 'coindcx-glob-rt');
      }
    }
    // 2) Finnhub-first / Yahoo-final fallback — ONLY names the RT feed
    //    doesn't carry, and only every 10s (the shared Finnhub key is
    //    rate-limited at 55/min; Yahoo politely tolerates 10s polls).
    const missing = [..._globSubscribed].filter(s => !covered.has(s));
    if (missing.length > 0) {
      if (now - _fallbackAt >= FALLBACK_MS) {
        _fallbackAt = now;
        const q = await fetchGlobalQuotes({ maxAgeMs: FALLBACK_MS }).catch(() => null);
        if (q) {
          for (const sym of missing) {
            const row = q.get(sym);
            if (!row || !(row.price > 0)) continue;
            // SIM rows (source 'sim') skip here — the dedicated synthetic
            // branch below ticks them at the TRUE 2s cadence with the
            // honest 'global-sim-rt' label.
            if (row.sim) continue;
            covered.add(sym);
            const chg = Number(row.changePct) || 0;
            // v10.11 (#1): the honest source label — Finnhub served it or
            // Yahoo did; the frontend badge shows exactly which.
            const src = row.source === 'finnhub' ? 'finnhub-global-rt' : 'yahoo-global-rt';
            setTick(`GLOB_${sym}`, {
              price: row.price,
              change: chg,
              high: row.high > 0 ? row.high : row.price,
              low: row.low > 0 ? row.low : row.price,
              volume: row.volume || 0,
              time: row.ts > 0 ? row.ts : _nowFn(),
              prevClose: chg > -100 ? row.price / (1 + chg / 100) : undefined,
            }, src);
          }
        }
      }
      // 3) SIM names (SPACEX — no public price exists BY DESIGN) — the
      //    deterministic synthetic walk ticks them live at the same 2s
      //    cadence, honestly labeled so the SIM desk never looks frozen.
      const simSet = new Set(GLOBAL_FUTURES_UNIVERSE.filter(u => u.sim).map(u => u.symbol));
      for (const sym of missing) {
        if (covered.has(sym) || !simSet.has(sym)) continue;
        const price = syntheticPriceAt(sym, now);
        if (!(price > 0)) continue;
        const prev = syntheticPriceAt(sym, now - 24 * 3600_000);
        setTick(`GLOB_${sym}`, {
          price,
          change: prev > 0 ? (price / prev - 1) * 100 : 0,
          high: price, low: price, volume: 0,
          time: now,
          prevClose: prev > 0 ? prev : undefined,
        }, 'global-sim-rt');
      }
    }
  } catch { /* transient — retry next beat */ }
}

// ---------------------------------------------------------------
// v10.11 THE WEBSOCKET ACCELERATOR — CoinDCX's documented futures
// socket pushes price-change events per instrument; each ATTRIBUTABLE
// event lands in liveFeed immediately (no 2s REST ceiling). Lifecycle
// mirrors cryptoStream's Binance accelerator: handshake watchdog,
// fail-streak circuit breaker, reconnect backoff, idle-close.
// ---------------------------------------------------------------
const _globChannel = (sym) => `B-${sym}_USDC@prices-futures`;

function _ensureWs() {
  if (!_wsEnabled) return;
  if (_activeClients === 0) return;
  if (_futSubscribed.size === 0 && _globSubscribed.size === 0) return;
  if (_nowFn() < _wsDisabledUntil) return;
  if (_io) return;
  let io;
  try {
    io = createCxSocketIo({
      url: DCX_WS_URL,
      wsFactory: _wsFactory || undefined,
      nowFn: _nowFn,
      onEvent: _onWsEvent,
      onOpen: () => {
        _wsFailStreak = 0;      // handshake made it — normal liveness
        _wsOpenedAt = _nowFn(); // silent-contract watchdog starts HERE
        _syncRestCadence();
      },
      onClose: (wasNs) => {
        // handshake never completed (geo-block / auth reject) → streak;
        // a live ns-connected socket that dropped is NOT a contract
        // failure (WAF blips close healthy sockets all day) — just reconnect.
        if (!wasNs) _registerWsFailure();
        _io = null;
        _wsLastTickAt = 0;      // unproven again → REST back to full 2s NOW
        _syncRestCadence();
        if (_activeClients > 0) _scheduleWsReconnect();
      },
    });
  } catch {
    _registerWsFailure();
    return;
  }
  _io = io;
  io.connect();
  // queue the joins (cxSocketIo holds them until the ns-connect ack)
  // v11.3: ONE book channel covers EVERY USDT perp (attributable pair
  // keys) — the per-pair FUT joins are gone. GLOB (USDC equity perps)
  // is NOT carried by the book channel (live-verified: zero _USDC keys
  // in 45s of book updates) — its per-pair channels stay joined.
  io.join(FUT_BOOK_CHANNEL);
  for (const sym of _globSubscribed) io.join(_globChannel(sym));
  _syncBinanceFutTier(); // cx socket (re)arming — the tier re-evaluates
}

function _closeWs(_reason) {
  if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
  if (_io) {
    try { _io.close(); } catch { /* already dead */ }
    _io = null;
  }
  _wsLastTickAt = 0;
  _syncBinanceFutTier(); // cx gone → the accelerator tier may take over FUT
}

function _leaveChannel(ch) {
  if (_io && _io.state().connected) {
    try { _io.leave(ch); } catch { /* socket gone — nothing to leave */ }
  }
}

function _registerWsFailure() {
  _wsFailStreak += 1;
  if (_wsFailStreak >= WS_FAIL_LIMIT) {
    _wsDisabledUntil = _nowFn() + WS_COOLDOWN_MS;
    _wsCooldownReason = 'handshake-streak';
    _wsFailStreak = 0;
  }
}

function _scheduleWsReconnect() {
  if (_wsReconnectTimer || _nowFn() < _wsDisabledUntil) return;
  const delay = Math.min(24_000, WS_RECONNECT_MS * 2 ** Math.min(_wsFailStreak, 3));
  _wsReconnectTimer = setTimeout(() => {
    _wsReconnectTimer = null;
    if (_activeClients > 0) _ensureWs();
  }, delay);
  if (_wsReconnectTimer.unref) _wsReconnectTimer.unref();
}

/** US premarket window — Mon–Fri 04:00–09:30 America/New_York
 *  (equity-perp synthetic flow is sparsest exactly here). Timezone
 *  math via Intl so the server's own TZ is irrelevant; ANY parse failure
 *  conservatively says "regular hours" (the shorter budget). */
function _isUsPremarketDefault(nowMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date(nowMs));
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    const wd = get('weekday');
    if (wd === 'Sat' || wd === 'Sun') return false;
    const h = parseInt(get('hour'), 10) % 24;
    const m = parseInt(get('minute'), 10);
    const mins = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
    return mins >= 4 * 60 && mins < 9 * 60 + 30;
  } catch { return false; }
}
function _isUsPremarket(nowMs) {
  return _usPremarketFn ? !!_usPremarketFn(nowMs) : _isUsPremarketDefault(nowMs);
}

/** v10.14: the silence budget for a GLOB-only session (no FUT symbols).
 *  Regular hours: 5 min. US premarket: 7.5 min. */
function _globSilentBudgetMs(now) {
  return _isUsPremarket(now) ? GLOB_PREMARKET_SILENT_KILL_MS : GLOB_SILENT_KILL_MS;
}

/** ns-connected with ZERO attributable ticks → either the event payload's
 *  attribution shape differs from our best-effort parse (a real contract
 *  mismatch — crypto proves itself within seconds) or a quiet equity-perp
 *  session (GLOB-only). Kill the socket + cooldown; the 2s REST poller owns
 *  both desks meanwhile. This is why a docs mismatch can never freeze
 *  prices. v10.14: the budget + cooldown are DOMAIN-AWARE (see S2 note). */
function _wsSilentContractWatchdog(now) {
  if (!_io || !_io.state().connected) return;
  if (_wsLastTickAt > 0) return;                 // ticks ARE landing — healthy
  const hasFut = _futSubscribed.size > 0;
  const budgetMs = hasFut ? WS_SILENT_KILL_MS : _globSilentBudgetMs(now);
  if (!_wsOpenedAt || (now - _wsOpenedAt) < budgetMs) return;
  const quietGlob = !hasFut;
  _closeWs(quietGlob ? 'glob-quiet' : 'silent-contract');
  _wsCooldownReason = quietGlob ? 'glob-quiet' : 'silent-contract';
  _wsDisabledUntil = now + (quietGlob ? GLOB_QUIET_COOLDOWN_MS : WS_COOLDOWN_MS);
}

/** One socket event → liveFeed / book state.
 *  v11.3 PRIMARY PATH — the book channel (currentPrices@futures@rt):
 *    42["currentPrices@futures#update", {"event":"…","data":"<JSON string>"}]
 *    data (once parsed) = { vs, ts, pr, pST, prices: { "B-BTC_USDT":
 *      { ls?, pc?, v?, mp?, bmST?, cmRT? }, … } } — ~500 ATTRIBUTABLE
 *    pair rows ~1/sec. `ls` rows land ticks immediately (event-driven
 *    freshness, no 2s REST ceiling); `mp`-only rows land ONLY when the
 *    symbol has no fresh tick (mark price is a keep-alive, never a
 *    replacement for a fresher last price). EVERY row merges into the
 *    shared book state (cxBookState) — futures.js serves it as the
 *    fetchFuturesPrices fallback when public.coindcx.com REST is
 *    WAF-blocked.
 *  Legacy path kept verbatim (below) for the per-pair
 *  "@prices-futures" price-change events — tolerant to every payload
 *  shape the docs have ever shown:
 *    {channelName:'B-BTC_USDT@prices-futures', data:{…}}
 *    {channelName:'…', p:'…'}          (fields inline)
 *    {pair:'B-BTC_USDT', data:{…}}
 *    {prices:{'B-BTC_USDT':{…}, …}}    (book-style full update)
 *  Price fields: p | ls | price | last_price; change: pc | change | dp;
 *  time: T | ts | btST; high/low/volume: h | l | v. */
function _onWsEvent(name, payload) {
  if (name === 'currentPrices@futures#update' || name === 'currentPrices@futures#snapshot') {
    _onFutBookEvent(payload);
    return;
  }
  if (name !== 'price-change') return; // only the documented price channel event
  if (!payload || typeof payload !== 'object') return;

  // book-style full update → many ticks at once
  const book = payload.prices && typeof payload.prices === 'object'
    ? payload.prices
    : (payload.data && typeof payload.data === 'object' && payload.data.prices && typeof payload.data.prices === 'object'
      ? payload.data.prices
      : null);
  if (book) {
    for (const [rawKey, d] of Object.entries(book)) {
      const m = String(rawKey).toUpperCase().match(/^B-([A-Z0-9.]+)_(USDT|USDC)$/);
      if (!m) continue;
      _landWsTick(m[2] === 'USDC' ? 'GLOB' : 'FUT', m[1], d);
    }
    return;
  }

  // single event — attribute via channelName / pair
  const chStr = String(payload.channelName || payload.channel || '').toUpperCase();
  const pairStr = String(payload.pair || payload.instrument || '').toUpperCase();
  const m = chStr.match(/^B-([A-Z0-9.]+)_(USDT|USDC)/) || pairStr.match(/^B-([A-Z0-9.]+)_(USDT|USDC)$/);
  if (!m) return; // unattributable — the REST poller keeps the desks alive
  const row = payload.data && typeof payload.data === 'object' && (payload.data.p != null || payload.data.ls != null || payload.data.price != null)
    ? payload.data
    : payload;
  _landWsTick(m[2] === 'USDC' ? 'GLOB' : 'FUT', m[1], row);
}

function _landWsTick(domain, sym, d) {
  // only subscribed symbols (the socket carries the WHOLE channel stream)
  if (domain === 'FUT' ? !_futSubscribed.has(sym) : !_globSubscribed.has(sym)) return;
  if (!d || typeof d !== 'object') return;
  const price = _num(d.p) || _num(d.ls) || _num(d.price) || _num(d.last_price);
  if (!(price > 0)) return;
  const change = _num(d.pc) || _num(d.change) || _num(d.dp) || 0;
  let time = _num(d.T) || _num(d.ts) || _num(d.btST) || _nowFn();
  // v10.13 (deep-recheck M3): epoch UNIT normalization. The guard below
  // compares this tick against ticks written by the REST pollers (futures.js
  // `j.ts`, globalFutures `j.ts` — CoinDCX serves SECONDS) and the
  // Date.now()-ms fallbacks. A seconds-based WS T against a ms-based last
  // tick made the out-of-order guard reject by LUCK of unit order (and a
  // seconds value stored into liveFeed poisoned frontend freshness).
  // Everything is ms from here on: < 1e12 means seconds.
  if (time > 0 && time < 1e12) time *= 1000;
  const key = `${domain}_${sym}`;
  // out-of-order guard — a late WS frame must never regress a newer tick
  const last = getTick(key);
  if (last && last.time > time + 1500) return;
  _wsLastTickAt = _nowFn(); // the HEALTH PROOF — REST slows to the 10s floor
  setTick(key, {
    price,
    change,
    high: _num(d.h) || price,
    low: _num(d.l) || price,
    volume: _num(d.v) || 0,
    time,
    prevClose: change > -100 ? price / (1 + change / 100) : undefined,
  }, domain === 'FUT' ? 'coindcx-fut-ws' : 'coindcx-glob-ws');
  _syncRestCadence(); // the proof just landed — slow REST to the floor NOW
  if (domain === 'FUT') _syncBinanceFutTier(); // cx owns FUT again → tier stands down
}

/** v11.3 book-channel event → book state + liveFeed ticks. */
function _onFutBookEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  // payload.data is a JSON-encoded STRING on the live wire (verified):
  // {"event":"…","data":"{\"pr\":\"futures\",\"prices\":{…}}"}
  let d = payload.data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return; }
  }
  if (!d || typeof d !== 'object' || !d.prices || typeof d.prices !== 'object') return;
  mergeFutBook(d.prices, _num(d.ts));
  for (const [rawPair, row] of Object.entries(d.prices)) {
    if (!row || typeof row !== 'object') continue;
    const m = String(rawPair).toUpperCase().match(/^B-([A-Z0-9.]+)_(USDT|USDC)$/);
    if (!m) continue;
    const domain = m[2] === 'USDC' ? 'GLOB' : 'FUT';
    const sym = m[1];
    const last = _num(row.ls);
    const mark = _num(row.mp);
    if (last > 0) {
      _landWsTick(domain, sym, row);           // true last price — always lands
    } else if (mark > 0) {
      _landMarkIfStale(domain, sym, row);      // mark price — keep-alive only
    } else {
      _proveWsHealth(domain, sym);             // heartbeat row — liveness proof
    }
  }
}

/** Mark-price keep-alive: land mp ONLY when the symbol's current tick
 *  is stale (>8s) — a mark price is an index-weighted estimate, never
 *  a replacement for a fresher last price. */
function _landMarkIfStale(domain, sym, row) {
  const key = `${domain}_${sym}`;
  const last = getTick(key);
  if (last && (_nowFn() - (last.time || 0)) < 8_000) return;
  _landWsTick(domain, sym, { ...row, ls: row.mp });
}

/** A heartbeat-only book row (no ls/mp) still proves the socket is
 *  delivering OUR channels — the REST floor may engage. */
function _proveWsHealth(domain, sym) {
  if (domain === 'FUT' ? !_futSubscribed.has(sym) : !_globSubscribed.has(sym)) return;
  _wsLastTickAt = _nowFn();
  _syncRestCadence();
}
// ---------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------
export function _resetCxRtForTest() {
  _futSubscribed.clear(); _globSubscribed.clear();
  _futRefcounts.clear(); _globRefcounts.clear();
  for (const t of _evictTimers.values()) clearTimeout(t);
  _evictTimers.clear();
  if (_timer) { clearInterval(_timer); _timer = null; }
  _timerMs = 0;
  _activeClients = 0;
  _sessionStartAt = 0; // v12.6
  _fallbackAt = 0;
  _bnFut = { at: 0, sig: '', byBase: null };
  _bnFutFetchImpl = null;
  _closeWs('test-reset');
  if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
  _wsFactory = null;
  _wsEnabled = false; // hermetic default — WS suites opt back in via _setDcxWsEnabledForTest(true)
  _wsFailStreak = 0;
  _wsDisabledUntil = 0;
  _wsCooldownReason = null;
  _wsLastTickAt = 0;
  _wsOpenedAt = 0;
  _usPremarketFn = null;
  _resetBinanceFutWsForTest(); // v10.15: the accelerator tier resets with its host
  _resetFutBookForTest();      // v11.3: the shared book state resets with its writer
}

/** Direct poll invocation for the regression suite (the interval itself
 *  stays private). Also runs the silent-contract watchdog + cadence sync. */
export async function _pollOnceForTest() { await _pollOnce(); }

export function _cxRtStateForTest() {
  return {
    activeClients: _activeClients,
    timer: !!_timer,
    restMs: _timerMs,
    ws: _io ? _io.state() : { socket: false, connected: false, channels: [] },
    wsHealthy: _wsHealthy(),
    wsDisabledUntil: _wsDisabledUntil,
    wsCooldownReason: _wsCooldownReason,
    fut: [..._futSubscribed],
    glob: [..._globSubscribed],
    fallbackAt: _fallbackAt,
    binanceFut: binanceFutStatus(), // v10.15: the accelerator tier's state
    book: futBookStats(),           // v11.3: the shared WS book state
  };
}

/** v10.14 (deep-recheck S2 #3): PUBLIC WS health for the SSE `status`
 *  frame + /api/feed-status — the UI can now say WHY the ultra-fast
 *  badge degraded ("GLOB feed quiet — cooling down 2m") instead of
 *  silently reverting to REST. Pure snapshot, no side effects. */
export function cxRtWsStatus() {
  const now = _nowFn();
  const cooling = now < _wsDisabledUntil;
  // v18.10: official SPOT socket health (fresh book = the INR anchor
  // is WS-owned; direct pushes are flowing sub-2s).
  const spot = spotWsStatus();
  return {
    enabled: _wsEnabled,
    connected: !!_io && _io.state().connected,
    healthy: _wsHealthy(),
    lastTickAt: _wsLastTickAt || null,
    openedAt: _wsOpenedAt || null,
    failStreak: _wsFailStreak,
    cooldownActive: cooling,
    cooldownRemainMs: cooling ? Math.max(0, _wsDisabledUntil - now) : 0,
    cooldownReason: cooling ? _wsCooldownReason : null,
    domains: { fut: _futSubscribed.size, glob: _globSubscribed.size },
    premarketBudget: _futSubscribed.size === 0 && _globSubscribed.size > 0
      ? _globSilentBudgetMs(now) : null, // the live GLOB-only silence budget
    // v10.15: the Binance futures WS accelerator tier — the UI can show
    // "FUT ab Binance WS se sub-second" while the CoinDCX socket cools.
    binanceFut: binanceFutStatus(),
    // v18.10: SPOT-WS tier — { enabled, connected, servable,
    // freshMarkets, markets, ageMs, cooling }. servable = a fresh
    // full book (>=25 markets): the direct ultra-fast INR pushes are
    // LIVE and REST is just the enrichment pass.
    spotWs: {
      enabled: spot.enabled,
      connected: spot.connected,
      servable: spot.servable,
      freshMarkets: spot.freshMarkets,
      markets: spot.markets,
      ageMs: spot.ageMs,
      cooling: spot.cooling,
    },
  };
}
