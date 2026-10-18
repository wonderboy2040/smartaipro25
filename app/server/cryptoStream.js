// cryptoStream — ultra-fast INR crypto feed (server-side, pushed to SSE)
// ---------------------------------------------------------------
// Layer 1 (anchor): CoinDCX public ticker poll every 2s while SSE clients
//   are connected. When no clients → timer pauses → server idle → Render
//   free tier happy.
// Layer 2 (accelerator, 2026 ultra-fast pass): Binance USDT ticker stream
//   (wss://stream.binance.com) — pushes ~1s updates which are PROJECTED
//   into INR using a live anchor ratio:
//       ratio = coindcx_INR_price / binance_USDT_price   (refreshed every
//               CoinDCX poll — captures USD/INR + India premium exactly)
//       projected_INR = binance_USDT × ratio
//   This gives sub-second crypto ticks that never diverge from the true
//   INR price (the ratio re-anchors every 2s, and projection stops if the
//   anchor goes stale >60s). Binance is geo-blocked on some hosts (HTTP
//   451) — the WS simply fails to open there, a 3-failure circuit breaker
//   disables it for 30 minutes, and CoinDCX polling carries on alone.
//
// 2026 perf audit (H2): ONE shared cached round-trip (fetchCoinDcxTickers,
//   in-flight deduped) serves both the SSE poller and /api/crypto-prices;
//   the parsed by-market Map is reused between polls.
//
// v11.3 — THE PERMANENT FIX for "502 Failed to fetch crypto prices" on
//   Render: api.coindcx.com REST is Cloudflare-fronted and times out from
//   datacenter IPs. The official SPOT WEBSOCKET (stream-spot.coindcx.com
//   — different host, different protocol, datacenter-reachable; live-
//   verified 2026-09-17) now backs the whole chain:
//     fetchCoinDcxTickers() = REST → spot-WS book (official, cxSpotWs)
//                             → Binance 24h tickers × live USDINR fx
//                             → deep-stale serve (3 min) → throw
//   The SSE poller re-anchors Binance projection from the WS book when
//   REST is dark, so INR ticks never stop while ANY official source lives.
// ---------------------------------------------------------------
import WebSocket from 'ws';
import { setTick } from './liveFeed.js';
import { spotWsDemand, spotWsStatus, spotWsTickerArray, spotWsPrice, setSpotWsOnPrice, _resetSpotWsForTest } from './ai/cxSpotWs.js';

const POLL_MS = 2000;             // 2s SSE push cadence (serves the CACHE — zero upstream cost)
// v12.6 BANDWIDTH FIX (the 5GB-exhaustion whale): the shared upstream
// cache window WAS 2000ms == the SSE poll period, so every 2s beat
// re-downloaded the FULL CoinDCX exchange ticker list (~400-800
// markets, several hundred KB) — ~20GB/day of Render outbound with
// ONE open browser. Two changes:
//   1. the REST anchor re-fetch window is now 20s (the live ticks come
//      from the WS books — REST is only the INR anchor);
//   2. when the official CoinDCX spot-WS book is servable AND fresh
//      (<10s), it serves WITHOUT hitting REST at all (WS-first — the
//      REST list is only fetched to re-anchor when the WS book ages).
// SSE UX is unchanged: clients still get 2s pushes from the merged
// tick cache (WS sub-second + the 20s REST re-anchor).
const UPSTREAM_CACHE_MS = 20_000;  // REST anchor re-fetch window (was 2s — the bandwidth whale)
const UPSTREAM_STALE_MS = 30000;  // serve-stale window when upstream errors
const WS_FIRST_MAX_AGE_MS = 10_000; // WS book fresher than this serves without REST
// v11.3: deep-stale serve — the LAST resort before a 502. A 3-min-old
// official ticker array keeps every board/poller alive (prices drift a
// little; a dead board drifts everything).
const UPSTREAM_DEEP_STALE_MS = 180_000;
const EVICT_GRACE_MS = 90000;     // unsubscribes wait for SSE auto-reconnect

// Binance accelerator tuning
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';
const BINANCE_MAX_STREAMS = 20;            // cap the combined stream list
const BINANCE_RECONNECT_MS = 5000;
const BINANCE_FAIL_LIMIT = 3;              // consecutive dead handshakes → breaker
const BINANCE_COOLDOWN_MS = 30 * 60 * 1000;
// v10.13 (deep-recheck L2): rapid-cycle backoff for post-open drops. The
// 3-fail breaker only counted HANDSHAKE failures — a socket that repeatedly
// connects then gets kicked (LB idle kill / 5s reconnect loop) reconnected
// every 5s forever. 5+ connect-then-drop cycles within 5 minutes → hold off
// 60s (with jitter) so an unhealthy upstream isn't hammered tight-loop.
const BINANCE_RAPID_CYCLES = 5;
const BINANCE_RAPID_WINDOW_MS = 5 * 60 * 1000;
const BINANCE_RAPID_BACKOFF_MS = 60 * 1000;
const BINANCE_MAX_FRAME_BYTES = 1_000_000;  // v10.13 (L10): upstream frame size cap
// v20.7.10: SILENCE KILL — NAT idle-timeout half-open sockets koi frame
// ya close event nahi dete; _ensureBinanceWs ka readyState===OPEN check
// phir HAMESHA return kar deta tha (accelerator kabhi recover nahi hota,
// socket leak). cxSpotWs (SPOT_WS_SILENT_KILL_MS) + cxRtStream dono me ye
// watchdog pehle se tha — Binance spot/fut clients me missing tha.
// Binance tickers ~1 msg/s emit karte hain → 45s silence = definitely dead.
const BINANCE_SILENT_KILL_MS = 45_000;
const BINANCE_SILENT_PROBE_MS = 15_000;
const BINANCE_RESUB_DEBOUNCE_MS = 2000;    // re-connect after universe changes
const ANCHOR_MAX_AGE_MS = 60 * 1000;       // stop projecting on a stale anchor

const _subscribed = new Set();
const _refcounts = new Map();    // base -> number of interested SSE clients
const _evictTimers = new Map();  // base -> pending eviction timer
let _timer = null;
let _activeClients = 0;

export function cryptoStreamEnabled() { return true; }

// ---------------------------------------------------------------
// Shared upstream fetch — used by the SSE poller AND /api/crypto-prices
// v11.3 chain: REST → official spot-WS book → Binance×fx synth →
// deep-stale. `_tsource` records which leg served (observability header).
// ---------------------------------------------------------------
const _upstream = { inFlight: null, at: 0, tickers: null };
const _byMarket = { src: null, map: null };
let _cryptoFetchImpl = null; // test injection
let _tsource = 'coindcx-rest';
const _cfetch = (url, opts) => (_cryptoFetchImpl || globalThis.fetch)(url, opts);

export function _setCryptoFetchForTest(fn) { _cryptoFetchImpl = fn; }

/** Which leg served the last fetchCoinDcxTickers() — surfaced as the
 *  X-Price-Source header on /api/crypto-prices + server logs. */
export function lastTickerSource() { return _tsource; }
/** v18.6.4: the upstream ticker batch's OWN clock (for stale-source
 *  honest timestamping — see pollOnce). */
export function lastTickerAt() { return _upstream.at || 0; }

export async function fetchCoinDcxTickers() {
  const now = Date.now();
  if (_upstream.tickers && (now - _upstream.at) < UPSTREAM_CACHE_MS) return _upstream.tickers;
  if (_upstream.inFlight) return _upstream.inFlight;
  const p = (async () => {
    // heartbeat: any ticker consumer keeps the official spot-WS armed
    spotWsDemand();
    // v12.6 WS-FIRST: a servable + fresh official spot-WS book serves
    // without a REST round-trip. REST stays the re-anchor: when the WS
    // book ages past WS_FIRST_MAX_AGE_MS (or is not servable), the
    // full list is fetched and the WS ratio re-syncs from it.
    const _st = spotWsStatus();
    const wsFresh = _st.servable && _st.ageMs != null && _st.ageMs >= 0 && _st.ageMs < WS_FIRST_MAX_AGE_MS;
    if (wsFresh) {
      const wsArr = spotWsTickerArray();
      if (Array.isArray(wsArr) && wsArr.length > 0) {
        _tsource = 'coindcx-spot-ws';
        return wsArr;
      }
    }
    try {
      const r = await _cfetch(`https://api.coindcx.com/exchange/ticker?t=${Date.now()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`CoinDCX upstream ${r.status}`);
      const tickers = await r.json();
      if (!Array.isArray(tickers)) throw new Error('bad payload');
      _upstream.tickers = tickers;
      _upstream.at = Date.now();
      _tsource = 'coindcx-rest';
      return tickers;
    } catch (e) {
      // Transient upstream failure: serve the stale cache briefly instead of
      // failing every consumer at once.
      if (_upstream.tickers && (Date.now() - _upstream.at) < UPSTREAM_STALE_MS) {
        _tsource = 'coindcx-rest-stale';
        return _upstream.tickers;
      }
      // v11.3 leg 2 — the OFFICIAL spot WebSocket book (different CoinDCX
      // host + protocol; datacenter-reachable when REST is not).
      const wsArr = spotWsStatus().servable ? spotWsTickerArray() : [];
      if (wsArr.length > 0) {
        _tsource = 'coindcx-spot-ws';
        return wsArr;
      }
      // v11.3 leg 3 — Binance/Bybit USDT 24h tickers projected to INR at
      // the live fx rate (honest approximation: no India premium, marked
      // __synthetic on every row).
      const synth = await _binanceTickerSynth().catch(() => null);
      if (synth && synth.length > 0) {
        _tsource = 'binance-fx-synth';
        return synth;
      }
      // v11.3 leg 4 — deep stale: 3-min-old official data beats a dead board.
      if (_upstream.tickers && (Date.now() - _upstream.at) < UPSTREAM_DEEP_STALE_MS) {
        _tsource = 'coindcx-rest-deep-stale';
        return _upstream.tickers;
      }
      throw e;
    }
  })();
  _upstream.inFlight = p;
  try { return await p; } finally { _upstream.inFlight = null; }
}

// ---------------------------------------------------------------
// v11.3 leg 3 — Binance spot 24h tickers → CoinDCX-shaped INR rows.
// api.binance.com → data-api.binance.vision mirror → Bybit v5 spot.
// A local USDINR fx cache (Yahoo chart) mirrors futures.js logic without
// an import cycle. v20.2: every successful read is recorded into the
// SHARED disk-backed ai/lib/usdinr store — the flat-84 fallback now only
// appears when no live rate was ever seen (cold boot + FX outage).
// Every row is marked __synthetic.
// ---------------------------------------------------------------
let _usdInr = { rate: 0, at: 0 };
const FX_CACHE_MS = 10 * 60_000;
import { usdInrRecord, usdInrFallback as _usdInrFallbackShared } from './ai/lib/usdinr.js';

async function _fetchUsdInr() {
  if (_usdInr.rate > 0 && Date.now() - _usdInr.at < FX_CACHE_MS) return _usdInr.rate;
  try {
    const r = await _cfetch('https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j = await r.json();
      const v = parseFloat(j?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (v > 40 && v < 150) {
        _usdInr = { rate: v, at: Date.now() };
        usdInrRecord(v, 'yahoo-chart');
        return v;
      }
    }
  } catch { /* fall through to the last-known rate */ }
  return _usdInr.rate > 0 ? _usdInr.rate : _usdInrFallbackShared();
}

async function _binanceTickerSynth() {
  const fx = await _fetchUsdInr();
  if (!(fx > 0)) return null;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  // Leg A/B: Binance spot 24h tickers (full book) + the keyless mirror.
  for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
    try {
      const r = await _cfetch(`${host}/api/v3/ticker/24hr`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const raw = await r.json();
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const out = [];
      for (const x of raw) {
        if (!x || typeof x.symbol !== 'string' || !x.symbol.endsWith('USDT')) continue;
        const base = x.symbol.slice(0, -4);
        const last = parseFloat(x.lastPrice);
        if (!base || !(last > 0)) continue;
        const pc = parseFloat(x.priceChangePercent) || 0;
        out.push({
          market: `${base}INR`,
          last_price: String(last * fx),
          change_24_hour: String(pc),
          high: String((parseFloat(x.highPrice) || last) * fx),
          low: String((parseFloat(x.lowPrice) || last) * fx),
          volume: String(parseFloat(x.volume) || 0),
          timestamp: Date.now(),
          __synthetic: 'binance-fx',
        });
      }
      if (out.length > 0) return out;
    } catch { /* next leg */ }
  }
  // Leg C: Bybit v5 spot tickers (newest-first, quoteVolume in USDT).
  try {
    const r = await _cfetch('https://api.bybit.com/v5/market/tickers?category=spot', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const out = [];
        for (const x of list) {
          if (!x || typeof x.symbol !== 'string' || !x.symbol.endsWith('USDT')) continue;
          const base = x.symbol.slice(0, -4);
          const last = parseFloat(x.lastPrice);
          if (!base || !(last > 0)) continue;
          const pc = ((parseFloat(x.price24hPcnt) || 0) * 100);
          out.push({
            market: `${base}INR`,
            last_price: String(last * fx),
            change_24_hour: String(pc),
            volume: String(parseFloat(x.volume24h) || 0),
            timestamp: Date.now(),
            __synthetic: 'binance-fx',
          });
        }
        if (out.length > 0) return out;
      }
    }
  } catch { /* give up honestly */ }
  return null;
}

/** Parsed market -> ticker Map, rebuilt only when the upstream array changes. */
function _getByMarket(tickers) {
  if (_byMarket.src !== tickers) {
    const map = new Map();
    for (const t of tickers) map.set(t.market, t);
    _byMarket.src = tickers;
    _byMarket.map = map;
  }
  return _byMarket.map;
}

// Call when an SSE client connects / disconnects
export function cryptoClientUp() { _activeClients++; spotWsDemand(); _startIfNeeded(); }
export function cryptoClientDown() { _activeClients = Math.max(0, _activeClients - 1); _stopIfIdle(); }

function _startIfNeeded() {
  if (_timer || _subscribed.size === 0) return;
  pollOnce();
  _timer = setInterval(pollOnce, POLL_MS);
  if (_timer.unref) _timer.unref();
  _ensureBinanceWs();
}

function _stopIfIdle() {
  if (_activeClients > 0 || !_timer) return;
  clearInterval(_timer);
  _timer = null;
  _closeBinanceWs('idle');
}

// ---------------------------------------------------------------
// Anchor poll (CoinDCX INR — the authoritative price)
// ---------------------------------------------------------------
const _cdcxLast = new Map();  // base -> { price, change, high, low, volume, at }
const _anchorRatio = new Map(); // base -> coindcx_INR / binance_USDT

async function pollOnce() {
  if (_subscribed.size === 0 || _activeClients === 0) return;
  // v20.9.3 FIX (M): post-cooldown self-heal. The 3-strike 30-min breaker
  // set _binanceDisabledUntil and NOTHING ever re-evaluated it — the spot
  // WS accelerator stayed dark for the rest of the session (sub-second INR
  // projection silently gone; only the 2s REST anchor kept prices honest).
  // _ensureBinanceWs is idempotent + cooldown-gated internally, so calling
  // it every beat is free (same discipline as cxRtStream's poll → ensure).
  try { _ensureBinanceWs(); } catch { /* best-effort re-arm */ }
  try {
    const tickers = await fetchCoinDcxTickers();
    // v18.6.4 STALE-ANCHOR HONESTY: jab upstream chain cached/stale rows
    // serve kar rahi ho (coindcx-rest-stale / deep-stale), tick ka `time`
    // + anchor `at` upstream batch ke APNE clock par set hota hai —
    // Date.now() se re-stamp karne par 60s ANCHOR_MAX_AGE_MS guard
    // kabhi trigger nahi hota tha aur stale projection "fresh" dikhti
    // thi (eviction + staleness chips dono dhokha khaate the).
    // v20.7.3 FIX: deep-stale source was missed — a batch up to 3 minutes
    // old still got Date.now(), so the anchor guard never tripped.
    const tsrc = lastTickerSource();
    const isStaleSrc = tsrc === 'coindcx-rest-stale' || tsrc === 'coindcx-rest-deep-stale';
    const batchAt = isStaleSrc ? (lastTickerAt() || Date.now()) : Date.now();
    const byMarket = _getByMarket(tickers);
    for (const base of _subscribed) {
      const t = byMarket.get(`${base}INR`);
      if (!t) continue;
      const price = parseFloat(t.last_price);
      if (!(price > 0)) continue;
      _cdcxLast.set(base, {
        price,
        change: parseFloat(t.change_24_hour) || 0,
        high: parseFloat(t.high) || price,
        low: parseFloat(t.low) || price,
        volume: parseFloat(t.volume) || 0,
        at: batchAt,
      });
      // Re-anchor the Binance→INR projection ratio.
      const b = _binanceLast.get(base);
      if (b && b.price > 0 && price > 0) _anchorRatio.set(base, price / b.price);
      const chg = parseFloat(t.change_24_hour) || 0;
      // v20.7.8 [M2]: honest wire label. The old ternary stamped EVERY
      // non-WS row 'coindcx-live' — a degraded leg (stale REST cache,
      // 3-min-deep-stale, or a Binance×fx SYNTHETIC row) rode the venue-
      // live ⚡ badge while being an approximation. coindcxOrders' trada-
      // bility gate reads lastTickerSource() (batch-level) and is NOT
      // affected; this is the SSE provenance field only.
      const feedLabel =
        t.feed === 'coindcx-spot-ws' ? 'coindcx-spot-ws'
        : (tsrc === 'coindcx-rest-stale' || tsrc === 'coindcx-rest-deep-stale') ? tsrc
        : t.__synthetic ? 'binance-fx-synth'
        : 'coindcx-live';
      setTick(`IN_${base}`, {
        price,
        change: chg,
        high: parseFloat(t.high) || price,
        low: parseFloat(t.low) || price,
        volume: parseFloat(t.volume) || 0,
        time: batchAt,
        // 24h-ago price (crypto "today" = rolling 24h window)
        prevClose: (chg > -100) ? price / (1 + chg / 100) : undefined,
      }, feedLabel);
    }
  } catch {
    // v11.3: REST dark AND the chain empty — the official spot-WS book
    // can still own the INR anchor (keeps the Binance projection honest
    // and INR ticks flowing at the WS's own cadence).
    _anchorFromSpotWs();
  }
}

/** v11.3: re-anchor from the official spot-WS book when the REST chain
 *  threw — INR ticks keep landing (source 'coindcx-spot-ws') and the
 *  Binance projection ratio stays fresh instead of silently expiring. */
function _anchorFromSpotWs() {
  for (const base of _subscribed) {
    const price = spotWsPrice(`${base}INR`);
    if (!(price > 0)) continue;
    const prev = _cdcxLast.get(base);
    _cdcxLast.set(base, {
      price,
      change: prev?.change || 0,
      high: Math.max(prev?.high || price, price),
      low: Math.min(prev?.low || price, price),
      volume: prev?.volume || 0,
      at: Date.now(),
    });
    const b = _binanceLast.get(base);
    if (b && b.price > 0 && price > 0) _anchorRatio.set(base, price / b.price);
    setTick(`IN_${base}`, {
      price,
      change: prev?.change || 0,
      high: Math.max(prev?.high || price, price),
      low: Math.min(prev?.low || price, price),
      volume: prev?.volume || 0,
      time: Date.now(),
      prevClose: (prev?.change > -100) ? price / (1 + (prev?.change || 0) / 100) : undefined,
    }, 'coindcx-spot-ws');
  }
}

// ---------------------------------------------------------------
// v18.10 DIRECT SPOT-WS ULTRA-FAST PUSH — jab official CoinDCX spot
// socket pe price PRINT hota hai, tick liveFeed me USI moment land
// hota hai (source 'coindcx-spot-ws'); 2s poller ka intezaar khatam.
// 24x7: crypto exchange kabhi nahi band — socket demand pe hamesha
// armed rehta hai (SSE client → cryptoClientUp → spotWsDemand).
// The 2s poller KEEPS RUNNING (stats/high/low enrichment + the REST
// chain re-anchor); this push only cuts the latency, never replaces
// the honest chain. SSE wire discipline unchanged: 1 update/sec/symbol
// + 0.05% dead-band (index.js) → bandwidth bhi unchanged.
// Registered ONCE at import; never throws into the socket (cxSpotWs
// wraps the call defensively).
// ---------------------------------------------------------------
setSpotWsOnPrice((market, price) => {
  try {
    const m = /^([A-Z0-9]+)INR$/.exec(String(market || ''));
    if (!m || !(price > 0)) return; // INR pairs only — IN_ namespace keys
    const base = m[1];
    if (!_subscribed.has(base)) return; // nobody is watching this coin
    const prev = _cdcxLast.get(base);
    const change = Number(prev?.change) || 0;
    const high = Math.max(prev?.high || price, price);
    const low = Math.min(prev?.low || price, price);
    const volume = prev?.volume || 0;
    _cdcxLast.set(base, { price, change, high, low, volume, at: Date.now() });
    const b = _binanceLast.get(base);
    if (b && b.price > 0) _anchorRatio.set(base, price / b.price);
    setTick(`IN_${base}`, {
      price,
      change,
      high,
      low,
      volume,
      time: Date.now(),
      prevClose: change > -100 ? price / (1 + change / 100) : undefined,
    }, 'coindcx-spot-ws');
  } catch { /* never let a push break the book merge */ }
});

// ---------------------------------------------------------------
// Binance USDT ticker accelerator (anchor-ratio INR projection)
// ---------------------------------------------------------------
let _binanceWs = null;
let _binanceStreams = '';          // current stream list (for set-change detect)
let _binanceReconnectTimer = null;
let _binanceResubTimer = null;
let _binanceFailStreak = 0;
let _binanceDisabledUntil = 0;
let _binanceGotData = false;
let _binanceWsFactory = null;      // test injection
const _binanceLast = new Map();    // base -> { price, at } (USDT)
const _binanceCycleTimes = [];     // v10.13: open→close cycle timestamps (rapid-cycle backoff)

function _binanceTargetStreams() {
  const bases = [..._subscribed].slice(0, BINANCE_MAX_STREAMS);
  return bases.map(b => `${b.toLowerCase()}usdt@ticker`).join('/');
}

function _ensureBinanceWs() {
  if (_activeClients === 0 || _subscribed.size === 0) return;
  if (Date.now() < _binanceDisabledUntil) return;
  const streams = _binanceTargetStreams();
  if (!streams) return;
  if (_binanceWs && _binanceWs.readyState === WebSocket.OPEN && streams === _binanceStreams) return;

  if (_binanceWs) { // v10.13 (L3): dead second clause removed — the old
    // `|| (_binanceWs && _binanceWs.readyState === WebSocket.CONNECTING)`
    // could never add anything once the first term was true.
    // Universe changed — debounce a swap to a fresh combined stream.
    if (streams !== _binanceStreams) _scheduleBinanceResub();
    return;
  }
  _openBinanceWs(streams);
}

function _scheduleBinanceResub() {
  if (_binanceResubTimer) return;
  _binanceResubTimer = setTimeout(() => {
    _binanceResubTimer = null;
    if (_activeClients === 0) return;
    const streams = _binanceTargetStreams();
    if (!streams || streams === _binanceStreams) return;
    _closeBinanceWs('resub');
    _openBinanceWs(streams);
  }, BINANCE_RESUB_DEBOUNCE_MS);
  if (typeof _binanceResubTimer.unref === 'function') _binanceResubTimer.unref();
}

function _openBinanceWs(streams) {
  try {
    const ws = _binanceWsFactory
      ? _binanceWsFactory(BINANCE_WS_BASE + streams)
      : new WebSocket(BINANCE_WS_BASE + streams);
    _binanceWs = ws;
    _binanceStreams = streams;
    _binanceGotData = false;
    // v20.7.10: per-socket silence watchdog (dekh upar constant ka comment)
    let _lastMsgAt = Date.now();
    const silenceProbe = setInterval(() => {
      if (_binanceWs !== ws) { clearInterval(silenceProbe); return; }
      if (ws.readyState === WebSocket.OPEN && Date.now() - _lastMsgAt > BINANCE_SILENT_KILL_MS) {
        try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* noop */ }
      }
    }, BINANCE_SILENT_PROBE_MS);
    if (typeof silenceProbe.unref === 'function') silenceProbe.unref();
    const connectTimeout = setTimeout(() => {
      // Handshake never completed — treat as a failure (geo-block case).
      if (_binanceWs === ws && ws.readyState !== WebSocket.OPEN) {
        try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* noop */ }
      }
    }, 8000);
    if (typeof connectTimeout.unref === 'function') connectTimeout.unref();

    ws.on('open', () => {
      if (_binanceWs !== ws) return;
      clearTimeout(connectTimeout);
    });
    ws.on('message', (raw) => {
      if (_binanceWs !== ws) return;
      if (raw && raw.length > BINANCE_MAX_FRAME_BYTES) return; // v10.13 (L10)
      _binanceGotData = true;
      _binanceFailStreak = 0;
      _lastMsgAt = Date.now(); // v20.7.10: silence watchdog feed
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const d = msg?.data;
      const stream = String(msg?.stream || '');
      if (!d || !stream) return;
      const base = stream.split('usdt@')[0]?.toUpperCase();
      const usdt = parseFloat(d.c);
      if (!base || !(usdt > 0)) return;
      _binanceLast.set(base, { price: usdt, at: Date.now() });
      _projectTick(base, usdt);
    });
    ws.on('close', () => {
      clearTimeout(connectTimeout);
      clearInterval(silenceProbe); // v20.7.10: watchdog band
      if (_binanceWs !== ws) return; // stale handler from a replaced socket
      _binanceWs = null;
      _binanceStreams = '';
      _registerBinanceFailure(!_binanceGotData);
      if (_activeClients > 0) _scheduleBinanceReconnect();
    });
    ws.on('error', () => {
      clearTimeout(connectTimeout); // v10.13 (L4): the 8s connect timer now clears on every terminal path
      if (_binanceWs !== ws) return;
      // v11.4 recheck: the ws lib emits BOTH error and close for a failed
      // handshake — nulling here makes the close handler's stale-guard
      // return early, so one failed attempt counts ONE strike (it was
      // counting two, arming the 3-strike breaker after just 2 attempts).
      _binanceWs = null;
      _binanceStreams = '';
      _registerBinanceFailure(!_binanceGotData);
      try { ws.close(); } catch { /* noop */ }
    });
  } catch {
    _registerBinanceFailure(true);
  }
}

function _registerBinanceFailure(handshakeFailed) {
  if (!handshakeFailed) return; // a live socket that dropped ≠ geo-block
  _binanceFailStreak++;
  if (_binanceFailStreak >= BINANCE_FAIL_LIMIT) {
    _binanceDisabledUntil = Date.now() + BINANCE_COOLDOWN_MS;
    _binanceFailStreak = 0;
  }
}

// v10.13 (L2): count an open→close cycle for the rapid-cycle backoff.
function _recordBinanceCycle() {
  const now = Date.now();
  _binanceCycleTimes.push(now);
  while (_binanceCycleTimes.length && now - _binanceCycleTimes[0] > BINANCE_RAPID_WINDOW_MS) _binanceCycleTimes.shift();
  return _binanceCycleTimes.length >= BINANCE_RAPID_CYCLES;
}

function _scheduleBinanceReconnect() {
  if (_binanceReconnectTimer || Date.now() < _binanceDisabledUntil) return;
  // v10.13 (L2): rapid connect-then-drop cycles → 60s hold-off + jitter
  // instead of the tight 5s loop (which repeated forever because the
  // fail-streak breaker only counts handshake failures).
  let delay = BINANCE_RECONNECT_MS + Math.floor(Math.random() * 1000); // always jittered
  if (_recordBinanceCycle()) {
    delay = BINANCE_RAPID_BACKOFF_MS + Math.floor(Math.random() * 5000);
    _binanceCycleTimes.length = 0; // re-arm after the hold-off
  }
  _binanceReconnectTimer = setTimeout(() => {
    _binanceReconnectTimer = null;
    if (_activeClients > 0) _ensureBinanceWs();
  }, delay);
  if (typeof _binanceReconnectTimer.unref === 'function') _binanceReconnectTimer.unref();
}

function _closeBinanceWs(reason) {
  if (_reasonLog) _reasonLog('binance-ws closed: ' + reason);
  if (_binanceReconnectTimer) { clearTimeout(_binanceReconnectTimer); _binanceReconnectTimer = null; }
  if (_binanceResubTimer) { clearTimeout(_binanceResubTimer); _binanceResubTimer = null; }
  if (_binanceWs) {
    const ws = _binanceWs;
    _binanceWs = null;
    try {
      ws.removeAllListeners();
      ws.on('error', () => {}); // swallow close-before-connected nextTick error
      if (ws.readyState === WebSocket.CONNECTING) {
        if (typeof ws.terminate === 'function') ws.terminate();
        else ws.close();
      } else {
        ws.close();
      }
    } catch { /* noop */ }
  }
  _binanceStreams = '';
}

/** Project a Binance USDT tick into INR using the live anchor ratio.
 *  v20.2 DIVERGENCE GUARD: when the projection drifts >0.30% beyond the
 *  CoinDCX anchor (Binance moved, the venue hasn't confirmed within the
 *  anchor window), the tick is relabeled 'binance-proj-drift' — the UI
 *  shows an amber PROJ pill instead of the same-nested ⚡ live badge, so
 *  an extrapolated price never masquerades as a venue-confirmed one. */
const PROJ_DRIFT_PCT = 0.30;
function _projectTick(base, usdt) {
  if (!_subscribed.has(base)) return;
  const ratio = _anchorRatio.get(base);
  const anchor = _cdcxLast.get(base);
  if (!(ratio > 0) || !anchor) return;                 // no anchor yet — CoinDCX poll owns the symbol
  if (Date.now() - anchor.at > ANCHOR_MAX_AGE_MS) return; // stale anchor — stop projecting
  const price = usdt * ratio;
  if (!(price > 0)) return;
  const deltaPct = anchor.price > 0 ? (price / anchor.price - 1) * 100 : 0;
  const chg = (anchor.change || 0) + deltaPct;
  const src = Math.abs(deltaPct) > PROJ_DRIFT_PCT ? 'binance-proj-drift' : 'binance-crypto-ws';
  setTick(`IN_${base}`, {
    price,
    change: chg,
    high: Math.max(anchor.high || price, price),
    low: Math.min(anchor.low || price, price),
    volume: anchor.volume || 0,
    time: Date.now(),
    prevClose: (chg > -100) ? price / (1 + chg / 100) : undefined,
  }, src);
}

let _reasonLog = null; // test injection / debug

export function ensureCryptoSubscribed(symbols) {
  // 2026 perf audit fix (H2): an EMPTY list no longer falls back to a default
  // 12-crypto set — previously every SSE connection (even crypto-less ones)
  // dragged the full CoinDCX ticker poll along. Real frontend clients always
  // send their crypto watchlist; nothing else needs a default.
  if (!symbols || !symbols.length) return;
  let universeChanged = false;
  for (const s of symbols) {
    const base = String(s).trim().toUpperCase();
    if (!base) continue;
    // Interested again → cancel any pending eviction.
    if (_evictTimers.has(base)) {
      clearTimeout(_evictTimers.get(base));
      _evictTimers.delete(base);
    }
    _refcounts.set(base, (_refcounts.get(base) || 0) + 1);
    if (!_subscribed.has(base)) { _subscribed.add(base); universeChanged = true; }
  }
  if (_activeClients > 0 && (universeChanged || _binanceWs)) _ensureBinanceWs();
  // Don't start timer here — only start when a client connects via cryptoClientUp()
}

/**
 * Refcount release (2026 perf audit M2): when the LAST SSE client that wanted
 * a symbol disconnects we don't unsubscribe instantly (EventSource reconnects
 * within ~3s on blips) — we evict after a grace period. Without this, the
 * subscribed set grew forever: every symbol ever watched kept being polled
 * for the process lifetime.
 */
export function releaseCryptoSubscribed(symbols) {
  for (const s of symbols || []) {
    const base = String(s).trim().toUpperCase();
    if (!base) continue;
    const n = (_refcounts.get(base) || 1) - 1;
    if (n > 0) { _refcounts.set(base, n); continue; }
    _refcounts.delete(base);
    if (_evictTimers.has(base)) continue;
    const t = setTimeout(() => {
      _evictTimers.delete(base);
      if (_refcounts.has(base)) return; // someone re-subscribed meanwhile
      _subscribed.delete(base);
      _cdcxLast.delete(base);
      _anchorRatio.delete(base);
      _binanceLast.delete(base);
    }, EVICT_GRACE_MS);
    if (typeof t.unref === 'function') t.unref();
    _evictTimers.set(base, t);
  }
}

// ---------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------
export function _setBinanceWsFactoryForTest(fn) { _binanceWsFactory = fn; }
export function _setBinanceDebugLogForTest(fn) { _reasonLog = fn; }
export function _resetCryptoStreamForTest() {
  _subscribed.clear(); _refcounts.clear();
  for (const t of _evictTimers.values()) clearTimeout(t);
  _evictTimers.clear();
  if (_timer) { clearInterval(_timer); _timer = null; }
  _activeClients = 0;
  _upstream.inFlight = null; _upstream.at = 0; _upstream.tickers = null;
  _byMarket.src = null; _byMarket.map = null;
  _closeBinanceWs('test-reset');
  _cdcxLast.clear(); _anchorRatio.clear(); _binanceLast.clear();
  _binanceFailStreak = 0; _binanceDisabledUntil = 0; _binanceGotData = false;
  _cryptoFetchImpl = null;
  _tsource = 'coindcx-rest';
  _usdInr = { rate: 0, at: 0 };
  _resetSpotWsForTest(); // v11.3: the spot-WS tier resets with its host
}
