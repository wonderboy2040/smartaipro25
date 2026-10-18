// ============================================================
// server/ai/globalFutures.js — GLOBAL EQUITY FUTURES desk (v10.4)
// ------------------------------------------------------------
// The user's ask: "Global futures me like Apple Google Nvidia
// SpaceX aise futures ko bhi add kardo — signals se trade le sake
// auto and manual accurately."
//
// CFD-style synthetic futures on the world's biggest companies:
//   • AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META — REAL Yahoo
//     Finance quotes (regularMarketPrice, live) + REAL 1h candles
//     (3mo, the same feed the crypto LTF layer uses)
//   • SPACEX — private company, koi public price NAHI hota. A
//     deterministic SYNTHETIC walk (seeded per-hour random walk
//     anchored near the tender-valuation per-share equivalent)
//     powers it — clearly labeled SIM on every surface, kabhi bhi
//     "real" claim nahi hota.
//
// Trading honesty: CoinDCX par ye contracts LISTED NAHI hain. So
// this desk is PAPER/NOTIFY-only — a LIVE click is rejected with
// the honest reason (the futures CoinDCX desk B-BTC_USDT style
// perps ke liye hai; ye desk practice + signal-research hai).
//
// Same plumbing as the other desks:
//   • executeGlobalSignal()   the SAME gauntlet: kill switch → auto
//                             policy → fresh signal (venue
//                             GLOBALFUTURES) → leverage sanity →
//                             journal caps (daily cap / loss cap /
//                             one-per-pair / concentration)
//   • watchGlobalPositions()  SL / TP2 / trailing / partial-TP /
//                             liquidation sweep (paper semantics)
//   • closeGlobalPosition()  manual close at the live quote
//
// Currency honesty: quotes are USD; the journal + risk caps stay
// INR — every USD amount carries its INR twin at the live USDINR
// (the SAME shared fetchUsdInr cache futures.js uses).
// ============================================================
import crypto from 'node:crypto';
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';
import { recordExecution, settlePositionOutcome, markPartialOutcome } from './ledger.js';
import { computeTrailSl, maxSaneLeverage, fitPlanToRiskCap, evaluateExecutionGate } from './ensemble.js';
import { pRound } from './lib/priceRound.js';
import { withJournalLock, pushEntry, todayIST, dailyStats, loadProTraderConfig } from './coindcxOrders.js';
import { computeIndicatorsFromCandles } from './lib/indicators.js';
import { fetchFinnhubQuote } from './finnhubQuote.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ---------------- universe ----------------
// v10.5.3 FULL-UNIVERSE SCAN (Issue #2): the desk used to be a
// hand-typed 8-name array — MU (Micron) was never in it, so it never
// got scanned and never got a signal card. The universe is now a
// periodically-refreshed CACHE built exactly like the crypto desk's
// dynamic spot universe (signals.js: "dynamic discovery with a static
// seed fallback"):
//
//   • GLOBAL_FUTURES_SEED      — the liquid desk watchlist (guarantees
//                                the board works even when CoinDCX
//                                lists no equity perps; includes MU +
//                                the chip complex + the momentum names)
//   • refreshGlobalUniverse()  — every 30 min, re-pulls CoinDCX's
//                                active USDT-perp instrument list
//                                (server/mcp/coindcx.js —
//                                fetchGlobalFuturesInstruments), diffs
//                                in newly LISTED equity names and drops
//                                delisted discoveries. SPACEX stays the
//                                private-company SIM special case.
//   • GLOBAL_FUTURES_UNIVERSE  — the LIVE merged array (mutated IN
//                                PLACE so every consumer — the board
//                                scan in signals.js, the quotes feed,
//                                the markets view — reads the fresh set
//                                with zero wiring changes).
//
// Yahoo mapping: most US tickers map 1:1; GLOBAL_YAHOO_ALIAS carries
// the class-A/B + special-share edge cases so a discovery can never
// silently price as another company.
export const GLOBAL_FUTURES_SEED = [
  { symbol: 'AAPL', name: 'Apple', yahoo: 'AAPL', sim: false },
  { symbol: 'MSFT', name: 'Microsoft', yahoo: 'MSFT', sim: false },
  { symbol: 'GOOGL', name: 'Alphabet (Google)', yahoo: 'GOOGL', sim: false },
  { symbol: 'AMZN', name: 'Amazon', yahoo: 'AMZN', sim: false },
  { symbol: 'NVDA', name: 'NVIDIA', yahoo: 'NVDA', sim: false },
  { symbol: 'TSLA', name: 'Tesla', yahoo: 'TSLA', sim: false },
  { symbol: 'META', name: 'Meta Platforms', yahoo: 'META', sim: false },
  // the chip complex + momentum names the user actually asks about —
  // MU was the headline miss of the 8-name era
  { symbol: 'MU', name: 'Micron Technology', yahoo: 'MU', sim: false },
  { symbol: 'AMD', name: 'Advanced Micro Devices', yahoo: 'AMD', sim: false },
  { symbol: 'INTC', name: 'Intel', yahoo: 'INTC', sim: false },
  { symbol: 'AVGO', name: 'Broadcom', yahoo: 'AVGO', sim: false },
  { symbol: 'QCOM', name: 'Qualcomm', yahoo: 'QCOM', sim: false },
  { symbol: 'TXN', name: 'Texas Instruments', yahoo: 'TXN', sim: false },
  { symbol: 'SMCI', name: 'Super Micro Computer', yahoo: 'SMCI', sim: false },
  { symbol: 'PLTR', name: 'Palantir', yahoo: 'PLTR', sim: false },
  { symbol: 'COIN', name: 'Coinbase', yahoo: 'COIN', sim: false },
  { symbol: 'NFLX', name: 'Netflix', yahoo: 'NFLX', sim: false },
  { symbol: 'ORCL', name: 'Oracle', yahoo: 'ORCL', sim: false },
  { symbol: 'ADBE', name: 'Adobe', yahoo: 'ADBE', sim: false },
  { symbol: 'UBER', name: 'Uber Technologies', yahoo: 'UBER', sim: false },
  // SPACEX — private company, koi public price NAHI hota: the
  // deterministic synthetic walk below powers it, clearly labeled SIM
  // on every surface. This special case is DESIGNED to stay (it is the
  // honest way to show a non-traded name), never a "discovery".
  { symbol: 'SPACEX', name: 'SpaceX (SIM)', yahoo: null, sim: true },
];

/** Yahoo tickers for class-A/B shares and special bases — a discovered
 *  symbol maps through this before touching the quote feed so a dual
 *  listing can never silently return another company's price. */
export const GLOBAL_YAHOO_ALIAS = {
  BRK: 'BRK-B', BRKB: 'BRK-B', BRK_B: 'BRK-B', 'BRK.B': 'BRK-B', // Berkshire class B
  BRKA: 'BRK-A', BRK_A: 'BRK-A', 'BRK.A': 'BRK-A', // Berkshire class A
  BF: 'BF-B', BFB: 'BF-B', BF_B: 'BF-B', 'BF.B': 'BF-B',   // Brown-Forman class B
  BFA: 'BF-A', BF_A: 'BF-A', 'BF.A': 'BF-A',
  GOOG: 'GOOG',  // class C (explicit identity)
  GOOGL: 'GOOGL', // class A (explicit identity)
  LEN: 'LEN-B', LENB: 'LEN-B', // Lennar class B dual listing
  MOG_A: 'MOG-A', MOGA: 'MOG-A', // Moog class A
  HEI_A: 'HEI-A', HEIA: 'HEI-A', // HEICO class A
};
export function yahooForGlobal(symbol) {
  const s = String(symbol || '').toUpperCase();
  return GLOBAL_YAHOO_ALIAS[s] || s; // most US tickers map 1:1
}

// discovery cap — each scanned symbol costs one Yahoo 1h/3mo candle
// fetch (150s cache) + one quote call (10s cache) per board refresh,
// so the dynamically-added tail stays bounded.
const GLOBAL_DISCOVERED_MAX = Number(process.env.AI_GLOBAL_DISCOVERED_MAX) > 0
  ? Math.floor(Number(process.env.AI_GLOBAL_DISCOVERED_MAX))
  : 8;
const GLOBAL_UNIVERSE_REFRESH_MS = 30 * 60_000; // 30 min

/** The LIVE universe — mutated in place by refreshGlobalUniverse(). */
export const GLOBAL_FUTURES_UNIVERSE = GLOBAL_FUTURES_SEED.map(u => ({ ...u }));

let _universeTimer = null;

/**
 * Merge the seed with CoinDCX's live equity-perp discoveries:
 *   seed names ALWAYS stay (stable desk — a delisting on CoinDCX
 *   cannot wipe the practice board), newly discovered names append
 *   (up to GLOBAL_DISCOVERED_MAX), delisted discoveries drop out.
 * Returns { size, discovered, added, dropped }.
 */
export async function refreshGlobalUniverse() {
  const { fetchGlobalFuturesInstruments } = await import('../mcp/coindcx.js');
  let discovered = [];
  try { discovered = await fetchGlobalFuturesInstruments(); }
  catch { discovered = []; /* CoinDCX unreachable → seed-only (honest degrade) */ }
  const bySymbol = new Map(GLOBAL_FUTURES_SEED.map(u => [u.symbol, { ...u }]));
  const added = [];
  for (const d of (Array.isArray(discovered) ? discovered : [])) {
    if (bySymbol.has(d.symbol)) continue;
    if (bySymbol.size >= GLOBAL_FUTURES_SEED.length + GLOBAL_DISCOVERED_MAX) break;
    bySymbol.set(d.symbol, {
      symbol: d.symbol, name: d.symbol, yahoo: yahooForGlobal(d.symbol),
      sim: false, discovered: true,
    });
    added.push(d.symbol);
  }
  const next = [...bySymbol.values()];
  const dropped = GLOBAL_FUTURES_UNIVERSE
    .filter(u => u.discovered && !next.some(n => n.symbol === u.symbol))
    .map(u => u.symbol);
  // in-place swap — every consumer holding the array reference sees it
  GLOBAL_FUTURES_UNIVERSE.length = 0;
  GLOBAL_FUTURES_UNIVERSE.push(...next);
  _candleCache.clear(); // stale candles for dropped symbols must not linger
  return {
    size: GLOBAL_FUTURES_UNIVERSE.length,
    discovered: (Array.isArray(discovered) ? discovered : []).length,
    added,
    dropped,
  };
}

/** Boot hook — first merge immediately (non-blocking, never throws),
 *  then every 30 minutes. unref'd so it never holds the process. */
export function startGlobalUniverseRefresh() {
  refreshGlobalUniverse().catch(e => console.warn('[globalFutures] universe refresh failed:', e?.message || e));
  if (_universeTimer) return;
  _universeTimer = setInterval(() => {
    refreshGlobalUniverse().catch(e => console.warn('[globalFutures] universe refresh failed:', e?.message || e));
  }, GLOBAL_UNIVERSE_REFRESH_MS);
  if (typeof _universeTimer.unref === 'function') _universeTimer.unref();
}

export function globalPairFor(symbol) {
  return `${String(symbol || '').toUpperCase()}-USD`;
}
export function baseOfGlobalPair(pair) {
  return String(pair || '').replace(/-USD$/, '').toUpperCase();
}
export function globalInstrumentMeta(symbol) {
  return GLOBAL_FUTURES_UNIVERSE.find(u => u.symbol === String(symbol || '').toUpperCase()) || null;
}

// ---------------- USDINR (shared, same cache as futures.js) ----------------
export async function fetchUsdInrShared() {
  const { fetchUsdInr } = await import('./futures.js');
  return fetchUsdInr();
}
const inrOfUsd = (usd, usdInr) => (Number.isFinite(usd) ? Math.round(usd * usdInr * 100) / 100 : null);

// ---------------- SPACEX synthetic engine ----------------
// Deterministic random walk — mulberry32 PRNG seeded by (symbol-hash,
// hour-index): every process/watcher/scan computes the SAME series for
// the same hour window. LTP advances per 60s bucket (a sim instrument
// with a live feel), anchored near the private-tender per-share
// equivalent. Clearly labeled SIM everywhere.
const SPACEX_ANCHOR = 210; // USD per synthetic share-unit (tender-valuation flavored anchor)
const SPACEX_HOURLY_VOL = 0.0035; // ≈ 0.35%/hour ≈ 1.6%/day — mega-cap-tech vol flavor
const SPACEX_DRIFT = 0.00018; // mild structural drift
function _hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function _mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Deterministic price at an exact ms timestamp — smooth-ish walk, changes every minute bucket. */
export function syntheticPriceAt(symbol, atMs = Date.now()) {
  const sym = String(symbol || '').toUpperCase();
  const base = sym === 'SPACEX' ? SPACEX_ANCHOR : 100;
  const vol = SPACEX_HOURLY_VOL;
  const minuteBucket = Math.floor(atMs / 60_000);
  const hourIndex = Math.floor(minuteBucket / 60);
  // hourly steps: cumulative from a fixed epoch (max ~2 years lookback keeps it O(1000))
  const EPOCH_HOUR = Math.floor(Date.UTC(2025, 0, 1) / 3600_000);
  const fromHour = Math.max(EPOCH_HOUR, hourIndex - 24 * 120); // bounded: 120 days of steps max
  const rand = _mulberry32(_hashSeed(`${sym}:${fromHour}`));
  let logP = 0;
  for (let h = fromHour; h <= hourIndex; h++) {
    const r = rand(); // [0,1)
    const z = (r - 0.5) * 2 * 1.732; // approx unit-normal via uniform
    logP += SPACEX_DRIFT + z * vol * 0.9;
  }
  // intra-hour smooth tail: sin interpolation between bucket endpoints
  const frac = (minuteBucket % 60) / 60;
  const wobble = Math.sin(frac * Math.PI) * 0.0015;
  return Math.max(1, r6(base * Math.exp(logP + wobble)));
}
function r6(v) { return Math.round(v * 1e6) / 1e6; }

/** Synthetic 1h candles for a SIM symbol (SPACEX) — deterministic per hour window. */
export function syntheticCandles(symbol, bars = 500) {
  const sym = String(symbol || '').toUpperCase();
  const nowHour = Math.floor(Date.now() / 3600_000);
  const out = [];
  for (let i = bars - 1; i >= 0; i--) {
    const hour = nowHour - i;
    const open = syntheticPriceAt(sym, hour * 3600_000);
    const close = syntheticPriceAt(sym, (hour + 1) * 3600_000 - 1);
    const hi = Math.max(open, close) * (1 + 0.0012);
    const lo = Math.min(open, close) * (1 - 0.0012);
    out.push({
      time: hour * 3600_000,
      open: r6(open), high: r6(hi), low: r6(lo), close: r6(close),
      volume: 800_000 + Math.floor(_mulberry32(_hashSeed(`${sym}:v:${hour}`))() * 900_000),
    });
  }
  return out;
}

// ============================================================
// v10.7 COINDCX GLOBAL FUTURES RT FEED (app-parity pricing)
// ------------------------------------------------------------
// THE BUG (user report): the site priced this desk from Yahoo stock
// spot (regularMarketPrice), but the CoinDCX app's Global Futures are
// USDC-margined PERPS that trade 24/7 — AAPL showed 332.27 (Yahoo,
// frozen outside US hours) while the app showed 333.62 USDC (live
// perp LTP). Positions SL/TP/P&L were equally frozen.
//
// THE FIX: price this desk from CoinDCX's OWN public derivatives RT
// feed — the same public.coindcx.com market_data family the crypto
// perp desk uses — scoped to the USDC margin domain. Yahoo becomes
// the FALLBACK (only for symbols the feed doesn't cover / feed down).
//
// The exact USDC-scoping query param is tried in EVERY plausible
// shape (scalar, array-style — the instruments endpoint's own
// convention, then a combined-feed scan) and a variant is accepted
// ONLY if it returns >= 3 live B-<EQUITY>_USDC rows (the repo's
// "CoinDCX field-name lesson, learned twice" pattern: never trust
// one key shape). The working variant is sticky; a total failure backs
// off 10s→40s (jittered, v10.11) so a blocked feed costs one probe round
// per backoff window, not one per poll — and a WAF blip heals in 10s.
// ============================================================
const GLOBAL_RT_URL = 'https://public.coindcx.com/market_data/v3/current_prices/futures/rt';
// v10.11 (#4 endpoint-contract research, docs.coindcx.com): the RT endpoint
// is DOCUMENTED with NO query params (sample response = USDT pairs only),
// so USDC-scoping stays an undocumented best-effort. The array-style
// `margin_currency_short_name[]=…` IS CoinDCX's documented multi-value
// convention on the derivatives family (active_instruments), so it goes
// FIRST; the scalar shape (documented on the single `instrument` endpoint)
// second; the param-less combined feed last. A variant is still accepted
// only with >= 3 live B-<EQUITY>_USDC rows, and the working one is sticky.
const GLOBAL_RT_PARAM_VARIANTS = [
  'margin_currency_short_name%5B%5D=USDC', // array-style — documented convention
  'margin_currency_short_name=USDC',       // scalar — instrument-endpoint shape
  '', // combined feed — USDC keys inside a shared payload
];
const GLOBAL_RT_CACHE_MS = 5_000;    // live perp LTP — positions stream polls 1s
// v10.11 (#2): the flat 60s negative cache is now a jittered exponential
// backoff — 10s after the FIRST failed probe round, doubling to a 40s cap.
// A WAF blip recovers in 10s (was: a full minute of Yahoo-only prices);
// a hard outage still backs off politely (max one probe round / 40s).
// ±0-2s jitter desynchronizes multiple server instances hammering the
// same blocked feed. A single SUCCESS resets the streak (fail-1 = 10s).
const GLOBAL_RT_NEG_BASE_MS = 10_000;
const GLOBAL_RT_NEG_MAX_MS = 40_000;
const GLOBAL_RT_NEG_JITTER_MS = 2_000;
const GLOBAL_RT_PROBE_DEADLINE_MS = 6_000; // a blocked feed must never stall the caller
const GLOBAL_RT_MIN_ROWS = 3;        // honest proof we got the USDC domain
let _rtCache = null;                 // Map<BASE, row>
let _rtAt = 0;
let _rtDownUntil = 0;                // negative cache (CHECKED — v10.6.1 lesson)
let _rtFailStreak = 0;               // consecutive failed probe rounds (v10.11 backoff)
let _rtVariant = 0;                  // sticky working param variant
let _rtInflight = null;              // single-flight probe

/** Parse one RT payload variant into Map<BASE, row> for USDC pairs.
 *  Accepts both the B-<BASE>_USDC key shape and a <BASE>/USDC shape. */
function _parseRtUsdcRows(j) {
  const map = new Map();
  const prices = j?.prices && typeof j.prices === 'object' ? j.prices : null;
  if (!prices) return map;
  for (const [rawKey, p] of Object.entries(prices)) {
    if (!p || typeof p !== 'object') continue;
    const last = num(p.ls);
    if (!(last > 0)) continue; // dark/illiquid rows carry ls=0
    const key = String(rawKey);
    const m = key.match(/^B-([A-Z0-9.]+)_USDC$/) || key.match(/^([A-Z0-9.]+)\/USDC$/);
    if (!m) continue;
    const base = m[1];
    if (!base || map.has(base)) continue;
    map.set(base, {
      pair: key,
      price: last,
      mark: num(p.mp) || last,
      changePct: num(p.pc) || 0,
      high: num(p.h), low: num(p.l), volume: num(p.v),
      // v10.13 (deep-recheck M3): epoch unit normalization to MILLISECONDS
      // (CoinDCX's top-level ts is seconds; cxRtStream's WS out-of-order
      // guard and liveFeed freshness compare against ms values).
      ts: (() => { const rawTs = num(j?.ts); return rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now(); })(),
      source: 'coindcx-usdc',
    });
  }
  return map;
}

async function _fetchRtVariant(param) {
  const r = await fetch(`${GLOBAL_RT_URL}${param ? `?${param}` : ''}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const rows = _parseRtUsdcRows(await r.json().catch(() => null));
  return rows.size >= GLOBAL_RT_MIN_ROWS ? rows : null;
}

/**
 * CoinDCX Global Futures live prices (the feed the app itself shows).
 * Returns Map<BASE, { pair, price, mark, changePct, high, low, volume,
 * ts, source: 'coindcx-usdc' }> — or null when the feed is unreachable
 * (callers honestly fall back to Yahoo).
 */
export async function fetchGlobalFuturesRt({ maxAgeMs = GLOBAL_RT_CACHE_MS } = {}) {
  if (_rtCache && Date.now() - _rtAt < maxAgeMs) return _rtCache;
  if (Date.now() < _rtDownUntil) return null; // backoff negative cache (10s→40s)
  if (_rtInflight) return _rtInflight;        // single-flight: board + stream + watcher share one probe
  const loop = (async () => {
    try {
      for (let i = 0; i < GLOBAL_RT_PARAM_VARIANTS.length; i++) {
        const idx = (_rtVariant + i) % GLOBAL_RT_PARAM_VARIANTS.length;
        let rows = null;
        try { rows = await _fetchRtVariant(GLOBAL_RT_PARAM_VARIANTS[idx]); } catch { rows = null; }
        if (rows) {
          _rtVariant = idx; _rtCache = rows; _rtAt = Date.now();
          _rtFailStreak = 0; // v10.11 (#2): one success fully heals the backoff
          return rows;
        }
      }
      return null;
    } finally {
      _rtInflight = null;
    }
  })();
  // Deadline race: a hung/blocked upstream costs this ONE round's budget
  // (≤6s), then the backoff negative cache serves null instantly — the
  // board/positions callers degrade to Finnhub/Yahoo without a stall. A late
  // background SUCCESS still populates the cache (the positive-cache
  // check runs before the negative-cache check, so the next poll that
  // finds it fresh serves it). Both timers are unref'd — they never
  // hold the process open.
  _rtInflight = Promise.race([
    loop,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), GLOBAL_RT_PROBE_DEADLINE_MS);
      if (typeof t === 'object' && t && typeof t.unref === 'function') t.unref();
    }),
  ]);
  const winner = await _rtInflight;
  if (!winner) {
    // v10.11 (#2) jittered exponential backoff: 10s → 20s → 40s (cap), ±2s
    _rtFailStreak += 1;
    const backoff = Math.min(GLOBAL_RT_NEG_MAX_MS, GLOBAL_RT_NEG_BASE_MS * 2 ** (_rtFailStreak - 1));
    _rtDownUntil = Date.now() + backoff + Math.floor(Math.random() * GLOBAL_RT_NEG_JITTER_MS);
  }
  return winner;
}

// ---------------- REAL quotes (CoinDCX RT → Finnhub → Yahoo) ----------------
let _quotesCache = null, _quotesAt = 0;
/**
 * Live quotes for the whole global universe:
 * Map symbol → { price, changePct, source: 'coindcx-usdc' | 'finnhub' |
 * 'yahoo' | 'sim', sim }
 * 5s cache — the RT feed is ~1s fresh, the positions SSE stream polls at 1s
 * with server-side dedupe, and ONE upstream call prices every symbol.
 *
 * v10.11 (#3) fallback priority (was: RT → Yahoo):
 *   1. CoinDCX USDC RT feed  — the app-parity 24/7 perp LTP (unchanged)
 *   2. FINNHUB REST quote    — shared module (ai/finnhubQuote.js) shares
 *                              the US desk's micro-cache + 55/min rate
 *                              limiter. Outside US hours this is a clean,
 *                              instant last-close quote — exactly when the
 *                              24/7 perps need a fallback. While the US
 *                              market is OPEN the shared staleness gate
 *                              (isStaleUsQuote — free-tier REST serves the
 *                              previous close) rejects it, so it can NEVER
 *                              serve an open-market stale price.
 *   3. Yahoo chart quote     — final fallback: Finnhub down / rate-limited
 *                              / freshness-gated / no key configured.
 *   4. SIM names             — deterministic synthetic walk (unchanged).
 */
export async function fetchGlobalQuotes({ maxAgeMs = 5_000 } = {}) {
  if (_quotesCache && Date.now() - _quotesAt < maxAgeMs) return _quotesCache;
  const map = new Map();
  // 1) CoinDCX Global Futures RT — the app-parity source (USDC domain)
  const rt = await fetchGlobalFuturesRt().catch(() => null);
  for (const u of GLOBAL_FUTURES_UNIVERSE) {
    if (u.sim) continue;
    const row = rt?.get(u.symbol);
    if (row) {
      map.set(u.symbol, {
        symbol: u.symbol, price: row.price, changePct: row.changePct,
        high: row.high, low: row.low, mark: row.mark, dcxPair: row.pair,
        source: 'coindcx-usdc', sim: false, ts: row.ts,
      });
    }
  }
  // 1b) v21.3.0 (Issue-6): USDC CANDLESTICK PATH — the RT probe failed
  // (403/WAF/undocumented endpoint) to perp LTP ab DOCUMENTED candlesticks
  // endpoint se aata hai (24/7, same family the futures desk uses). Ye
  // REALTIME perp price hai — Yahoo spot-ke-frozen-close se pehle YE
  // aata hai, isliye chain me Finnhub se UPAR.
  const needCandles = GLOBAL_FUTURES_UNIVERSE.filter(u => !u.sim && !map.has(u.symbol));
  if (needCandles.length > 0) {
    try {
      const gc = await fetchGlobalUsdcCandleQuotes({ bases: needCandles.map(u => u.symbol) }).catch(() => null);
      for (const u of needCandles) {
        const row = gc?.get(u.symbol);
        if (row && row.price > 0) {
          map.set(u.symbol, {
            symbol: u.symbol, price: row.price, changePct: row.changePct || 0,
            source: 'coindcx-usdc-candles', sim: false, ts: row.ts || Date.now(),
          });
        }
      }
    } catch { /* honest fallthrough to Finnhub/Yahoo */ }
  }
  // 2) Finnhub — FIRST fallback for the symbols the RT feed didn't cover
  //    (unlisted-on-CoinDCX names, or the feed is down → full fallback).
  //    Finnhub tickers match the Yahoo `yahoo:` field for US large-caps —
  //    no second mapping table needed. Never throws; a null row (no key /
  //    over budget / stale-gated) simply falls through to Yahoo below.
  const need = GLOBAL_FUTURES_UNIVERSE.filter(u => !u.sim && !map.has(u.symbol));
  if (need.length > 0) {
    await Promise.allSettled(need.map(async (u) => {
      try {
        const fh = u.yahoo ? await fetchFinnhubQuote(u.yahoo) : null;
        if (fh && fh.price > 0) {
          map.set(u.symbol, {
            symbol: u.symbol, price: fh.price, changePct: fh.change ?? 0,
            high: fh.high, low: fh.low,
            source: 'finnhub', sim: false, ts: fh.time || Date.now(),
          });
        }
      } catch { /* honest fallthrough to Yahoo */ }
    }));
  }
  // 3) Yahoo — ONLY the symbols Finnhub didn't cover either
  const needYahoo = GLOBAL_FUTURES_UNIVERSE.filter(u => !u.sim && !map.has(u.symbol));
  await Promise.allSettled(needYahoo.map(async (u) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(u.yahoo)}?interval=1d&range=5d`;
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const meta = (await r.json())?.chart?.result?.[0]?.meta;
      const price = num(meta?.regularMarketPrice);
      const prev = num(meta?.chartPreviousClose ?? meta?.previousClose);
      if (price > 0) {
        // v21.4.1 [C4]: ts HONEST — regularMarketPrice US hours ke bahar
        // FROZEN last close hai (IST trader ke liye ~18h tak). Purana
        // `ts: Date.now()` use fresh dikha deta tha; ab meta ka apna
        // regularMarketTime (last trade, unix sec) use hota hai — watcher
        // staleness checks aur consumers dono ko sach dikhta hai.
        const rt = num(meta?.regularMarketTime);
        map.set(u.symbol, {
          symbol: u.symbol, price, changePct: prev > 0 ? ((price - prev) / prev) * 100 : 0,
          source: 'yahoo', sim: false, ts: (rt != null && rt > 0) ? rt * 1000 : Date.now(),
        });
      }
    } catch { /* dead ticker → skipped honestly */ }
  }));
  // 3) SIM names stay the deterministic synthetic walk
  for (const u of GLOBAL_FUTURES_UNIVERSE.filter(x => x.sim)) {
    const price = syntheticPriceAt(u.symbol);
    map.set(u.symbol, {
      symbol: u.symbol, price, changePct: 0, source: 'sim', sim: true,
      ts: Date.now(),
    });
  }
  if (map.size === 0) throw new Error('global quotes: every feed unreachable');
  _quotesCache = map; _quotesAt = Date.now();
  return map;
}
export async function fetchGlobalLtpMap() {
  const m = await fetchGlobalQuotes().catch(() => null);
  return m || new Map();
}

// ----------------------------------------------------------------
// v21.3.0 (Issue-6: "Equity sim USDC me realtime price fetch nahi ho
// raha") — 24/7 CANDLESTICK PRICE PATH.
//
// THE ROOT CAUSE: the desk's realtime chain was RT-probe → Finnhub →
// Yahoo. The RT probe (v3/current_prices/futures/rt with USDC params)
// is an UNDOCUMENTED endpoint that 403s on many networks — and Yahoo's
// regularMarketPrice is the FROZEN last close outside US hours (which
// is EXACTLY when an IST user trades — US market 20:30–02:00 IST).
// Result: prices looked frozen, SL/TP never evaluated, positions P&L
// stood still — "realtime price fetch nahi ho raha".
//
// THE FIX: when the RT probe fails, price the USDC perps from the
// DOCUMENTED candlesticks endpoint (the same family the futures desk
// uses — /market_data/candlesticks?pair=b-<sym>_usdc&pcode=f):
// last 1m candle close = the perp LTP, 24/7. 10s TTL + concurrency-6
// batching + negative backoff (403/WAF-blip ek round me hi politely
// ruk jaata hai). Yahoo stays the LAST fallback (ab honestly
// 'us-closed' labeled through the market-phase badge).
// ----------------------------------------------------------------
const GLOBAL_CANDLES_URL = 'https://public.coindcx.com/market_data/candlesticks';
const GLOB_CANDLE_TTL_MS = 10_000;
const GLOB_CANDLE_NEG_MS = 60_000;   // 403/network fail → 1 min off
const GLOB_CANDLE_CONCURRENCY = 6;
// v21.4.1 [C2]: serve-side staleness gate — candle entries 90s se purani
// ho jaayein (9 consecutive refresh rounds fail) to PRUNE. Pehle negative
// backoff window (60s) me _gcCache entries BINA age-check ke serve hoti
// thi — RT + candle dono hosts same hain (public.coindcx.com), WAF block
// pe dono saath jaate hain, aur chain candle se PEHLE Finnhub try karti
// hai → minutes-to-hours purani USDC prices 'coindcx-usdc-candles' label
// ke saath serve hoti rehti thi (fresh Finnhub uske AAGE kabhi nahi pahunch
// paata tha). Prune hone par leg fall-through hota hai — SL/TP frozen
// prices pe evaluate hona band.
const GLOB_CANDLE_STALE_MS = 90_000;
let _gcCache = new Map();            // BASE → { at, price, changePct, ts }
let _gcDownUntil = 0;
let _gcInflight = null;

function _gcPruneStale() {
  const cutoff = Date.now() - GLOB_CANDLE_STALE_MS;
  for (const [k, v] of _gcCache) {
    if (!v || !Number.isFinite(v.at) || v.at < cutoff) _gcCache.delete(k);
  }
  return _gcCache;
}

/** v21.4.1: test hook — seed the candle cache directly (prune-gate tests
 * ke liye; __resetGlobalForTests ise clear karta hai). */
export function __seedGcCacheForTests(entries) {
  _gcCache = new Map(Object.entries(entries || {}));
}

async function _fetchOneUsdcCandle(base) {
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 30 * 60; // last 30 min of 1m bars is plenty
    const url = `${GLOBAL_CANDLES_URL}?pair=${encodeURIComponent(`b-${String(base).toLowerCase()}_usdc`)}&from=${from}&to=${to}&resolution=1&pcode=f`;
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const rows = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
    if (!rows || rows.length === 0) return null;
    // sort by time asc, take the LAST candle with a positive close
    const sorted = rows
      .map(x => ({ t: Number(x.time) < 1e12 ? Number(x.time) * 1000 : Number(x.time), c: num(x.close), o: num(x.open) }))
      .filter(c => c.c > 0 && c.o > 0)
      .sort((a, b) => a.t - b.t);
    const last = sorted[sorted.length - 1];
    if (!last) return null;
    const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    return { price: last.c, changePct: prev && prev.c > 0 ? ((last.c - prev.c) / prev.c) * 100 : 0, ts: last.t };
  } catch { return null; }
}

/** USDC perp LTPs from the candlestick endpoint — Map<BASE, row>.
 *  Only called for symbols the RT probe missed. */
export async function fetchGlobalUsdcCandleQuotes({ bases = null } = {}) {
  const want = (Array.isArray(bases) && bases.length > 0
    ? bases
    : GLOBAL_FUTURES_UNIVERSE.filter(u => !u.sim).map(u => u.symbol))
    .map(s => String(s).toUpperCase());
  const fresh = want.filter(b => {
    const hit = _gcCache.get(b);
    return !(hit && Date.now() - hit.at < GLOB_CANDLE_TTL_MS);
  });
  if (Date.now() < _gcDownUntil || fresh.length === 0) {
    return _gcPruneStale(); // v21.4.1 [C2]: negative-cache / all-fresh — STALE-PRUNED serve (fresher fallbacks ko chance)
  }
  if (_gcInflight) return _gcInflight;
  const job = (async () => {
    let ok = 0, fail = 0;
    for (let i = 0; i < fresh.length; i += GLOB_CANDLE_CONCURRENCY) {
      const slice = fresh.slice(i, i + GLOB_CANDLE_CONCURRENCY);
      const outs = await Promise.allSettled(slice.map(_fetchOneUsdcCandle));
      outs.forEach((o, k) => {
        if (o.status === 'fulfilled' && o.value && o.value.price > 0) {
          _gcCache.set(slice[k], { at: Date.now(), price: o.value.price, changePct: o.value.changePct, ts: o.value.ts });
          ok++;
        } else { fail++; }
      });
    }
    // hard-fail round (WAF block) → back off 60s so a blocked network
    // costs one probe round per minute, not one per poll
    if (ok === 0 && fail > 0) _gcDownUntil = Date.now() + GLOB_CANDLE_NEG_MS;
    return _gcPruneStale(); // v21.4.1 [C2]: successful round bhi stale keys sweep
  })();
  _gcInflight = job;
  try { return await job; } finally { _gcInflight = null; }
}

// ----------------------------------------------------------------
// v21.3.0 (Issue-6): US MARKET PHASE — pre/open/post/closed + countdown.
// The equity desk perps trade 24/7 par UNDERLYING spot session nahi —
// ye badge user ko batata hai ki quote ka matlab kya hai (perp live vs
// spot closed). Finnhub staleness gate + Yahoo pre/post sab isi pe
// anchor hote hain.
// ----------------------------------------------------------------
export function usMarketPhase(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const h = Number(parts.hour) % 24; // hour12:false 24 ko hi deta hai
    const m = Number(parts.minute);
    const minutes = h * 60 + m;
    const wk = String(parts.weekday || '');
    const weekend = wk === 'Sat' || wk === 'Sun';
    // Sat: Friday post-market ended; Sun 18:00 ET se pre-market Monday
    if (wk === 'Sat') return { phase: 'CLOSED', label: 'US market closed (weekend)', nextChange: 'Monday 04:00 ET pre-market', isET: true };
    if (wk === 'Sun') {
      return minutes >= 18 * 60
        ? { phase: 'PRE', label: 'US pre-market', nextChange: 'open 09:30 ET', isET: true }
        : { phase: 'CLOSED', label: 'US market closed (weekend)', nextChange: 'Sunday 18:00 ET pre-market', isET: true };
    }
    if (weekend) return { phase: 'CLOSED', label: 'US market closed', nextChange: 'next weekday 04:00 ET', isET: true };
    if (minutes < 4 * 60) return { phase: 'CLOSED', label: 'US market closed', nextChange: 'pre-market 04:00 ET', isET: true };
    if (minutes < 9 * 60 + 30) return { phase: 'PRE', label: 'US pre-market', nextChange: `open ${9 * 60 + 30 - minutes}m`, isET: true };
    if (minutes < 16 * 60) return { phase: 'OPEN', label: 'US market OPEN', nextChange: `close ${(16 * 60) - minutes}m`, isET: true };
    if (minutes < 20 * 60) return { phase: 'POST', label: 'US after-hours', nextChange: 'closes 20:00 ET', isET: true };
    return { phase: 'CLOSED', label: 'US market closed', nextChange: 'pre-market 04:00 ET (kal)', isET: true };
  } catch {
    return { phase: 'UNKNOWN', label: 'US market phase nahi mila', nextChange: null, isET: false };
  }
}

// ---------------- candles (Yahoo 1h real / synthetic SIM) ----------------
let _candleCache = new Map();
/**
 * 1h candles for one global symbol. Real names: Yahoo 1h/3mo (the
 * exact feed the crypto LTF layer already uses — proven even where
 * CoinDCX is blocked). SIM names: the deterministic synthetic walk.
 */
export async function fetchGlobalCandles(symbol, { maxAgeMs = 150_000 } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const hit = _candleCache.get(sym);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.candles;
  const inst = globalInstrumentMeta(sym);
  let candles = null;
  if (inst && !inst.sim) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(inst.yahoo)}?interval=1h&range=3mo`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI global-futures)' },
        signal: AbortSignal.timeout(9000),
      });
      if (r.ok) {
        const res = (await r.json())?.chart?.result?.[0];
        const ts = res?.timestamp;
        const q = res?.indicators?.quote?.[0];
        if (Array.isArray(ts) && q) {
          const rows = [];
          for (let i = 0; i < ts.length; i++) {
            if (q.open?.[i] == null || q.close?.[i] == null) continue;
            rows.push({
              time: ts[i] * 1000,
              open: q.open[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i],
              close: q.close[i], volume: q.volume?.[i] || 0,
            });
          }
          if (rows.length >= 60) candles = rows;
        }
      }
    } catch { /* honest degrade to null */ }
  } else if (inst && inst.sim) {
    candles = syntheticCandles(sym);
  }
  if (!candles) return null;
  _candleCache.set(sym, { candles, at: Date.now() });
  return candles;
}

// ---------------- board context builder ----------------
/** Build a GLOBALFUTURES ctx the signals.js model loop can consume —
 *  the INDIA-index pattern (candles → computeIndicatorsFromCandles). */
export function buildGlobalCtxSync(symbol, quote, candles, regime) {
  const ltp = quote?.price;
  if (!(ltp > 0)) return null;
  let ind = null;
  if (Array.isArray(candles) && candles.length >= 30) {
    ind = computeIndicatorsFromCandles(candles);
  }
  if (!ind) return null; // no candles → honest abstain (not a fake board row)
  return {
    market: 'GLOBALFUTURES', symbol, ltp, changePct: quote?.changePct ?? 0,
    volume: candles?.[candles.length - 1]?.volume ?? 0,
    pair: globalPairFor(symbol), ind, candles: candles || null, options: null, regime,
    // v10.7: the LTP carries its TRUE source — CoinDCX USDC RT (app parity)
    // wins over the Yahoo fallback; candles stay Yahoo 1h either way.
    priceSource: quote?.sim ? 'synthetic-sim' : quote?.source === 'coindcx-usdc' ? 'coindcx-usdc' : 'yahoo-1h',
    isSim: !!quote?.sim,
  };
}

// ---------------- journal helpers (same files as the other desks) ----------------
const JOURNAL_FILE = 'ai-trading-journal.json';
const MAX_JOURNAL = 500;
const CLOSED_POSITION_TTL = 90 * 24 * 3600_000;
function loadJournalFresh() {
  return loadJSON(JOURNAL_FILE, { entries: [], positions: [] });
}
function saveJournalFresh(j) {
  if (Array.isArray(j.entries) && j.entries.length > MAX_JOURNAL) {
    j.entries = j.entries.slice(-MAX_JOURNAL);
  }
  if (Array.isArray(j.positions)) {
    const cutoff = Date.now() - CLOSED_POSITION_TTL;
    const keep = j.positions.filter(p => p.status !== 'CLOSED' || (p.closedAt || p.openedAt || 0) >= cutoff);
    if (keep.length !== j.positions.length) j.positions = keep;
  }
  try { durablePut(JOURNAL_FILE, j); } catch { /* best-effort */ }
  saveJSON(JOURNAL_FILE, j);
  return j;
}

// ============================================================
// EXECUTION GAUNTLET (paper/notify only — CoinDCX doesn't list these)
// ============================================================
export async function executeGlobalSignal(opts) {
  const {
    symbol, side, mode, qtyINR, marginUSDT, leverage,
    getFreshSignal, wantAuto = false, source = 'manual', sendTelegram,
  } = opts || {};
  const cfg = await import('./coindcxOrders.js').then(m => m.loadConfig());
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pair = globalPairFor(sym);
  const wantMode = mode === 'notify' ? 'notify' : 'paper'; // LIVE impossible — honest below
  const day = todayIST();
  const entry = { kind: 'ORDER', day, symbol: pair, side, mode: wantMode, market: 'GLOBALFUTURES', source };

  const reject = (reason, error, extra = {}) => withJournalLock(() => {
    const j = loadJournalFresh();
    pushEntry(j, { ...entry, status: 'REJECTED', reason, ...extra });
    saveJournalFresh(j);
  }).then(() => ({ ok: false, error: error || reason }));

  // --- gate 0: LIVE honesty — these contracts exist nowhere ---
  if (mode === 'live') {
    return reject(
      'Global Equity Futures is a SIM desk — CoinDCX par AAPL/MSFT/GOOGL/NVDA/SPACEX contracts listed NAHI hain. PAPER/NOTIFY hi chalta hai.',
      'SIM desk — LIVE possible nahi (CoinDCX par ye equities listed nahi). PAPER ya NOTIFY use karo.',
    );
  }
  // --- gate 1: kill switch ---
  if (cfg.killSwitch) return reject('Kill switch ON — execution disabled');
  // v21.1.1 [audit C12]: per-strategy kill rule parity — SIM desk pe bhi
  // negative-expectancy strategy pause ho (Phase-4 spec: "har strategy").
  // LIVE gate 0 pe reject hota hai isliye block sirf paper/notify pe lagta
  // hai — wahi modes hain jo ledger me settle hote hain.
  try {
    const { strategyGuardBlocked } = await import('./strategyGuard.js');
    const sg = strategyGuardBlocked(source, 'GLOBALFUTURES');
    if (sg.blocked) return reject(sg.reason, sg.reason);
  } catch { /* guard unavailable — never break the flow */ }
  // --- gate 2: auto policy ---
  if (wantAuto && !cfg.allowAuto) return { ok: false, error: 'Auto-execution is OFF (enable it in Risk settings)' };
  if (wantAuto && cfg.mode !== 'live') return { ok: false, error: 'Auto-execution only runs in LIVE mode' };

  // --- gate 3: fresh signal (venue GLOBALFUTURES) ---
  // v11.5: mode flows into the fresh-signal source — paper/notify may use
  // the board-cached fallback when the deep path is down (LIVE is rejected
  // at gate 0 on this SIM desk, so the fallback can never touch money).
  const signal = await getFreshSignal(pair, { mode: wantMode });
  if (!signal) return reject('No fresh ensemble signal available for this global symbol');

  const gates = { minConfidence: cfg.minConfidence, minAgreement: cfg.minAgreement };
  const riskCap = Number(cfg.maxRiskPct) > 0 ? Number(cfg.maxRiskPct) : 5;

  // PAPER practice fallback (the futures desk's honesty model)
  let effectiveSignal = signal;
  let synthNote = null;
  // v12.7 (recheck R1-#9): an ABSENT side no longer silently defaults
  // LONG — an unspecified request inherits the fresh signal's side (the
  // client always sends side; a missing side is a malformed call, and
  // minting a LONG from nothing was a free directional bias).
  const _reqRaw = String(side || '').toUpperCase();
  const reqSide = _reqRaw === 'SHORT' || _reqRaw === 'LONG' ? _reqRaw
    : (signal.side === 'SHORT' || signal.side === 'LONG' ? signal.side : 'LONG');
  const sideConflict = signal.side !== 'FLAT' && signal.side !== reqSide;
  if (sideConflict || signal.side === 'FLAT' || !signal.plan) {
    const { buildTradePlan } = await import('./ensemble.js');
    const synthPlan = buildTradePlan(
      { side: reqSide, dir: reqSide === 'LONG' ? 1 : -1 },
      { ltp: signal.ltp, ind: {} }, 'GLOBALFUTURES',
    );
    if (synthPlan && signal.ltp > 0) {
      effectiveSignal = { ...signal, side: reqSide, plan: synthPlan };
      synthNote = sideConflict
        ? `practice plan @ live global price (fresh consensus FLIPPED: ${signal.side} ${signal.confidence}%)`
        : `practice plan @ live global price (fresh consensus: ${signal.side} ${signal.confidence}%)`;
    }
  }
  const floorNote = (!synthNote && signal.grade !== 'STRONG' && signal.grade !== 'ACTION' && (Number(signal.confidence) || 0) < 55)
    ? `practice floor relaxed (fresh ${signal.grade ?? '—'} · ${signal.confidence ?? 0}% — journaled)` : null;

  let fitNote = null;
  const planRiskPct = Number(effectiveSignal?.plan?.riskPct);
  if (Number.isFinite(planRiskPct) && planRiskPct > riskCap) {
    const fitted = fitPlanToRiskCap(effectiveSignal, riskCap);
    if (fitted.note) { effectiveSignal = fitted.signal; fitNote = fitted.note; }
  }
  const verdict = evaluateExecutionGate(effectiveSignal, {
    side: side || effectiveSignal.side, gates,
    requireStrong: false, // SIM desk — no live bar to enforce
    maxAgeMs: 600_000, maxRiskPct: riskCap, venue: 'GLOBALFUTURES',
    practice: true,
  });
  if (!verdict.ok) {
    return reject(verdict.reason, `Signal gate: ${verdict.reason}`, {
      signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
    });
  }

  // --- NOTIFY: gauntlet pass → alert + audit, no position ---
  if (wantMode === 'notify') {
    const alertPrice = Number(effectiveSignal.ltp) > 0 ? Number(effectiveSignal.ltp) : null;
    return withJournalLock(async () => {
      const j = loadJournalFresh();
      const stats = dailyStats(j);
      const plan = effectiveSignal.plan;
      const capsNote = `trades ${stats.tradesCount}/${cfg.dailyMaxTrades} · realized ₹${r2(stats.realizedPnlINR)}`;
      const lines = [
        `🔔 <b>SmartAI NOTIFY (Global Futures SIM)</b> — ${sym} ${effectiveSignal.side}`,
        `<b>${signal.grade || '—'}</b> · conf ${signal.confidence ?? '—'}% · agreement ${Math.round((signal.agreement ?? 0) * 100)}%`,
        plan ? `Entry ${pRound(plan.entry)} · SL ${pRound(plan.stopLoss)} · T1 ${pRound(plan.target1)} · T2 ${pRound(plan.target2)} · risk ${r2(plan.riskPct)}%` : 'plan nahi bana',
        `Book: ${capsNote}`,
        [synthNote, fitNote, floorNote].filter(Boolean).join(' · ') || undefined,
        '— notify-only: koi position NAHI bana (SIM desk).',
      ].filter(Boolean);
      let telegramSent = false;
      if (typeof sendTelegram === 'function') {
        try { telegramSent = !!(await sendTelegram(lines.join('\n'))).ok; } catch { /* best-effort */ }
      }
      pushEntry(j, {
        ...entry, status: 'NOTIFIED', ...(alertPrice ? { price: pRound(alertPrice) } : {}),
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [synthNote, fitNote, floorNote, verdict.reason].filter(Boolean).join(' · ') || 'gauntlet pass',
        telegramSent,
      });
      saveJournalFresh(j);
      return {
        ok: true, mode: 'notify', notified: true, telegramSent,
        alert: { pair: sym, side: effectiveSignal.side, grade: signal.grade, confidence: signal.confidence,
          plan: plan ? { entry: pRound(plan.entry), stopLoss: pRound(plan.stopLoss), target2: pRound(plan.target2) } : null,
          caps: capsNote },
        note: telegramSent ? 'Telegram alert bhej diya (journal AUDIT: NOTIFIED). Koi position nahi bani — SIM desk.'
          : 'Gauntlet pass + journal AUDIT likha, par Telegram configured nahi — Alerts & AI Keys me token daalo.',
      };
    });
  }

  // --- sizing (USD margin domain, same as futures) ---
  const price = effectiveSignal.ltp;
  if (!(price > 0)) return { ok: false, error: 'No live global price for sizing' };
  const usdInr = await fetchUsdInrShared();
  const levCapConfig = Number(cfg.cryptoLeverage) >= 1 ? Math.floor(Number(cfg.cryptoLeverage)) : 1;
  const levCapInstrument = 5; // sim desk ceiling — mega-cap equity futures margins rarely exceed 5x
  let lev = Math.max(1, Math.floor(Number(leverage) || 1));
  if (lev > levCapConfig) lev = levCapConfig;
  if (lev > levCapInstrument) lev = levCapInstrument;

  let margin = Number(marginUSDT) > 0 ? Number(marginUSDT)
    : (Number(qtyINR) > 0 ? Number(qtyINR) / usdInr : Math.min(cfg.maxOrderINR, 1000) / usdInr);
  margin = Math.round(margin * 1000) / 1000;

  // leverage sanity — liquidation must sit OUTSIDE the SL
  const slDistPct = Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price)) / price * 100;
  const saneLev = maxSaneLeverage(slDistPct, Math.min(levCapConfig, levCapInstrument));
  let levNote = null;
  if (lev > 1 && lev > saneLev) {
    levNote = `leverage auto-reduced ${lev}x → ${saneLev}x (liquidation est. would fire before the ${r2(slDistPct)}% SL)`;
    lev = saneLev;
  }

  const qtyPrecision = 2; // sim desk: fractional shares ×100 allowed
  const rawQty = (margin * lev) / price;
  const qty = Math.floor(rawQty * 10 ** qtyPrecision) / 10 ** qtyPrecision;
  if (!(qty > 0)) return { ok: false, error: `Quantity rounds to 0 for ${pair} — increase the margin` };
  const notionalUSD = r2(qty * price);
  const marginUsed = r2(notionalUSD / lev);
  if (marginUsed < 1) return { ok: false, error: `Margin ₹${inrOfUsd(marginUsed, usdInr)} too small for ${pair} — increase the order size` };
  const liquidation = lev > 1 && effectiveSignal.plan?.stopLoss != null
    ? pRound(effectiveSignal.side !== 'SHORT' ? price * (1 - 0.95 / lev) : price * (1 + 0.95 / lev))
    : null;

  // --- FINAL MUTATION under the journal lock (fresh copy) ---
  return withJournalLock(async () => {
    const j = loadJournalFresh();
    const stats = dailyStats(j);
    // v20.2 SIM DESK SEPARATION: dailyStats now EXCLUDES GLOBALFUTURES
    // entries from the REAL desks' budget — so the SIM desk's own
    // self-discipline caps read the sim* counters instead. (Practice
    // discipline stays enforced; a simulated trade can never block a
    // real CRYPTO/FUTURES entry ever again.)
    const simTrades = stats.simTradesCount ?? 0;
    const simRealized = stats.simRealizedPnlINR ?? 0;
    if (simTrades >= cfg.dailyMaxTrades) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Daily trade cap (${cfg.dailyMaxTrades}) hit` });
      saveJournalFresh(j);
      return { ok: false, error: `Daily trade cap (${cfg.dailyMaxTrades}) reached — resets at IST midnight` };
    }
    if (simRealized <= -cfg.dailyMaxLossINR) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Daily loss cap (₹${cfg.dailyMaxLossINR}) hit` });
      saveJournalFresh(j);
      return { ok: false, error: `Daily loss cap (₹${cfg.dailyMaxLossINR}) breached — trading paused for today` };
    }
    if (j.positions.some(p => p.pair === pair && (p.status === 'OPEN' || p.status === 'UNKNOWN'))) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: 'Position already open for this global pair' });
      saveJournalFresh(j);
      return { ok: false, error: `An open position already exists for ${pair} (one-per-pair rule)` };
    }
    const openCount = j.positions.filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length;
    if (openCount >= (cfg.maxOpenPositions || 5)) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Max open positions (${cfg.maxOpenPositions || 5}) hit` });
      saveJournalFresh(j);
      return { ok: false, error: `Concentration guard: ${openCount} positions already open (max ${cfg.maxOpenPositions || 5})` };
    }

    let ledgerEntryId = null;
    // v20.3: relaxed stamp parity — practice entries built against a
    // flipped/sub-floor consensus stay OUT of the calibration corpus on
    // the GLOBALFUTURES (SIM) desk too.
    try {
      ledgerEntryId = recordExecution(signal, {
        mode: 'paper', market: 'GLOBALFUTURES', source,
        ...(synthNote || floorNote ? { relaxed: true } : {}),
      })?.id || null;
    } catch { /* best-effort */ }
    const position = {
      id: crypto.randomUUID(), pair, symbol: sym, market: 'GLOBALFUTURES', side: effectiveSignal.side, mode: 'paper', source,
      qty, entryPrice: price, notionalUSDT: notionalUSD, notionalINR: inrOfUsd(notionalUSD, usdInr),
      marginUSDT: marginUsed, marginINR: inrOfUsd(marginUsed, usdInr),
      leverage: lev, ...(lev > 1 ? { liquidation } : {}),
      sl: effectiveSignal.plan?.stopLoss ?? null, tp: effectiveSignal.plan?.target1 ?? null, tp2: effectiveSignal.plan?.target2 ?? null,
      initialRisk: pRound(Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price))),
      peakPrice: pRound(price),
      isSim: !!globalInstrumentMeta(sym)?.sim,
      signal: { grade: signal.grade, confidence: signal.confidence, agreement: signal.agreement, summary: synthNote || signal.summary },
      openedAt: Date.now(), status: 'OPEN',
      ...(ledgerEntryId ? { ledgerEntryId } : {}),
    };
    j.positions.push(position);
    pushEntry(j, {
      ...entry, status: 'FILLED', qty, price: pRound(price), notionalUSDT: notionalUSD, notionalINR: inrOfUsd(notionalUSD, usdInr),
      leverage: lev, marginUSDT: marginUsed,
      signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
      reason: [verdict.reason, synthNote, fitNote, levNote, floorNote].filter(Boolean).join(' · '),
    });
    saveJournalFresh(j);
    return {
      ok: true, mode: 'paper', position,
      filled: { qty, price: pRound(price), notionalUSDT: notionalUSD, notionalINR: inrOfUsd(notionalUSD, usdInr), leverage: lev, marginUSDT: marginUsed },
      ...(synthNote || fitNote || levNote || floorNote ? { fitted: [synthNote, fitNote, levNote, floorNote].filter(Boolean).join(' · ') } : {}),
    };
  });
}

// ============================================================
// MANUAL CLOSE (market — at the live quote)
// ============================================================
export async function closeGlobalPosition(positionId) {
  return withJournalLock(async () => {
    const j = loadJournalFresh();
    const p = j.positions.find(x => x.id === positionId && x.market === 'GLOBALFUTURES' && x.status === 'OPEN');
    if (!p) return { ok: false, error: 'Open GLOBALFUTURES position not found' };
    const quotes = await fetchGlobalLtpMap();
    const ltp = quotes.get(p.symbol)?.price;
    if (!(ltp > 0)) return { ok: false, error: 'Live global price unavailable — thodi der baad close karo' };
    const usdInr = await fetchUsdInrShared();
    const long = p.side === 'LONG';
    const pnlUSD = (long ? ltp - p.entryPrice : p.entryPrice - ltp) * p.qty;
    const bookedUSD = Number(p.bookedPnlUSDT) || 0;
    p.status = 'CLOSED';
    p.closedAt = Date.now();
    p.closePrice = ltp;
    p.pnlUSDT = r2(pnlUSD + bookedUSD);
    p.pnlINR = inrOfUsd(p.pnlUSDT, usdInr);
    p.closeReason = 'Manual close';
    try { settlePositionOutcome(p, 'Manual close'); } catch { /* best-effort */ }
    pushEntry(j, {
      kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'GLOBALFUTURES', mode: p.mode, source: p.source,
      qty: p.qty, entryPrice: p.entryPrice, closePrice: ltp, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR, reason: 'Manual close (SIM desk)',
    });
    saveJournalFresh(j);
    return { ok: true, position: { ...p, ltp: r2(ltp), unrealizedPnlINR: p.pnlINR, unrealizedPnlUSDT: p.pnlUSDT } };
  });
}

// ============================================================
// POSITION WATCHER (paper semantics — SL/TP/trailing/partial/liq)
// ============================================================
export async function watchGlobalPositions({ sendTelegram } = {}) {
  return withJournalLock(async () => {
    const j = loadJournalFresh();
    const closures = [];
    const watchErrors = [];
    let dirty = false;
    const cfg = await import('./coindcxOrders.js').then(m => m.loadConfig());
    const pro = loadProTraderConfig();
    const usdInr = await fetchUsdInrShared();

    const open = j.positions.filter(p => p.market === 'GLOBALFUTURES' && p.status === 'OPEN');
    if (open.length === 0) return closures;

    const quotes = await fetchGlobalLtpMap();

    for (const p of open) {
      const price = quotes.get(p.symbol)?.price;
      if (!(price > 0)) continue;
      const long = p.side === 'LONG';

      // liquidation estimate first (paper sim — always executes)
      if (p.leverage > 1 && p.liquidation != null && p.liquidation > 0) {
        if (long ? price <= p.liquidation : price >= p.liquidation) {
          const liq = p.liquidation;
          const pnlUSD = (long ? liq - p.entryPrice : p.entryPrice - liq) * p.qty;
          p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = liq;
          p.pnlUSDT = r2(pnlUSD); p.pnlINR = inrOfUsd(pnlUSD, usdInr);
          p.closeReason = 'LIQUIDATED (est.)';
          try { settlePositionOutcome(p, 'LIQUIDATED (est.)'); } catch { /* best-effort */ }
          dirty = true;
          pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'GLOBALFUTURES', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: liq, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR, reason: 'LIQUIDATED (est. — price crossed the liquidation level)' });
          closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: 'LIQUIDATED (est.)' });
          continue;
        }
      }

      // trailing SL (same ratchet math as the futures desk)
      if (cfg.trailEnabled && p.sl != null && p.sl > 0) {
        const prevPeak = Number(p.peakPrice);
        const peak = long
          ? Math.max(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price)
          : Math.min(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price);
        p.peakPrice = pRound(peak);
        const risk = Number(p.initialRisk) > 0 ? Number(p.initialRisk) : Math.abs(p.entryPrice - p.sl);
        if (risk > 0) {
          const trail = computeTrailSl({ side: p.side, entryPrice: p.entryPrice, peakPrice: peak, currentSl: p.sl, initialRisk: risk, price, armR: cfg.trailArmR, offsetR: cfg.trailOffsetR });
          if (trail) {
            pushEntry(j, { kind: 'TRAIL', day: todayIST(), pair: p.pair, market: 'GLOBALFUTURES', reason: `SL ${trail.stage}: ${p.sl} → ${trail.sl} (peak ${pRound(peak)})`, from: p.sl, to: trail.sl });
            p.sl = trail.sl;
            p.trailing = trail.stage;
            dirty = true;
          }
        }
        dirty = true;
      }

      const closeAt = async (exitPrice, reason, exitQty = p.qty) => {
        const pnlUSD = (long ? exitPrice - p.entryPrice : p.entryPrice - exitPrice) * exitQty;
        p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = exitPrice;
        p.pnlUSDT = r2(pnlUSD + (Number(p.bookedPnlUSDT) || 0));
        p.pnlINR = inrOfUsd(p.pnlUSDT, usdInr);
        p.closeReason = reason;
        try { settlePositionOutcome(p, reason); } catch { /* best-effort */ }
        dirty = true;
        pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'GLOBALFUTURES', mode: p.mode, source: p.source, qty: exitQty, entryPrice: p.entryPrice, closePrice: exitPrice, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR, reason });
        closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason });
      };

      // ---- v7.0 PRO TRADER: 3-tier partial take-profit (agent positions) ----
      // v11.4 recheck: gate was `pro.enabled` — a key loadProTraderConfig
      // never returns — so partial-TP NEVER fired on the Global desk.
      if (pro.partialTpEnabled && p.source === 'agent' && !p.tp1Hit && p.tp != null && p.tp > 0) {
        if (long ? price >= p.tp : price <= p.tp) {
          // v11.4 recheck: old formula divided the fraction back out of the
          // CURRENT qty (treating it as a post-T1 remainder) — at T1 nothing
          // has closed yet, so 40% booked 66.7% and 50% closed the WHOLE
          // position. p.qty here IS the original qty → plain pct of it.
          const closeQty = r2(Math.max(0, p.qty * ((Number(p.tp1ClosePctOverride) || pro.tp1ClosePct) / 100)));
          const partialQty = Math.min(p.qty, closeQty || p.qty);
          if (partialQty > 0 && partialQty < p.qty) {
            const pnlUSD = (long ? p.tp - p.entryPrice : p.entryPrice - p.tp) * partialQty;
            p.qty = r2(p.qty - partialQty);
            p.bookedPnlUSDT = r2((Number(p.bookedPnlUSDT) || 0) + pnlUSD);
            p.bookedPnlINR = inrOfUsd(p.bookedPnlUSDT, usdInr);
            p.tp1Hit = true;
            if (pro.breakEvenAfterTp1 && p.sl != null) {
              p.sl = pRound(p.entryPrice);
              p.trailing = 'breakeven';
            }
            try { markPartialOutcome(p, 1); } catch { /* best-effort */ }
            dirty = true;
            pushEntry(j, { kind: 'PARTIAL', day: todayIST(), pair: p.pair, market: 'GLOBALFUTURES', reason: `T1 hit — ${pro.tp1ClosePct}% booked, SL → breakeven`, qty: partialQty, price: pRound(p.tp), pnlUSDT: r2(pnlUSD), pnlINR: inrOfUsd(pnlUSD, usdInr) });
          } else {
            await closeAt(p.tp, 'TARGET-1 (full — small position)');
          }
        }
      } else if (pro.partialTpEnabled && p.source === 'agent' && p.tp1Hit && !p.tp2Hit && p.tp2 != null && p.tp2 > 0) {
        if (long ? price >= p.tp2 : price <= p.tp2) {
          const closeQty = r2(p.qty * (pro.tp2ClosePct / (100 - pro.tp1ClosePct)));
          const partialQty = Math.min(p.qty, Math.max(0, closeQty));
          if (partialQty > 0 && partialQty < p.qty) {
            const pnlUSD = (long ? p.tp2 - p.entryPrice : p.entryPrice - p.tp2) * partialQty;
            p.qty = r2(p.qty - partialQty);
            p.bookedPnlUSDT = r2((Number(p.bookedPnlUSDT) || 0) + pnlUSD);
            p.bookedPnlINR = inrOfUsd(p.bookedPnlUSDT, usdInr);
            p.tp2Hit = true;
            if (p.sl != null && p.tp != null) {
              p.sl = pRound(Math.max(p.tp, p.entryPrice));
              p.trailing = 't1';
            }
            try { markPartialOutcome(p, 2); } catch { /* best-effort */ }
            dirty = true;
            pushEntry(j, { kind: 'PARTIAL', day: todayIST(), pair: p.pair, market: 'GLOBALFUTURES', reason: `T2 hit — ${pro.tp2ClosePct}% booked, SL → T1`, qty: partialQty, price: pRound(p.tp2), pnlUSDT: r2(pnlUSD), pnlINR: inrOfUsd(pnlUSD, usdInr) });
          } else {
            await closeAt(p.tp2, 'TARGET-2 (full — small runner)');
          }
        }
      }

      if (p.status !== 'OPEN') continue;

      // ---- SL / TP2 (classic full-exit path — manual desk) ----
      if (p.sl != null && p.sl > 0 && (long ? price <= p.sl : price >= p.sl)) {
        await closeAt(p.sl, 'STOP-LOSS');
        continue;
      }
      if (p.tp2 != null && p.tp2 > 0 && (long ? price >= p.tp2 : price <= p.tp2)) {
        await closeAt(p.tp2, 'TARGET-2');
        continue;
      }
    }
    if (dirty) saveJournalFresh(j);
    if (closures.length > 0 && typeof sendTelegram === 'function') {
      const lines = closures.map(c => `• ${c.pair} — ${c.reason}: ₹${c.pnlINR ?? '?'}`);
      try { await sendTelegram(`🌍 <b>GLOBAL FUTURES (SIM) watcher</b>\n${lines.join('\n')}`); } catch { /* best-effort */ }
    }
    return { closures, watchErrors };
  });
}

// ---------------- markets view (frontend desk list) ----------------
export async function globalFuturesMarketsView() {
  const quotes = await fetchGlobalLtpMap();
  const rows = GLOBAL_FUTURES_UNIVERSE.map(u => {
    const q = quotes.get(u.symbol);
    return {
      pair: globalPairFor(u.symbol), symbol: u.symbol, name: u.name,
      last: q?.price ?? null, changePct: q?.changePct ?? null,
      sim: u.sim, source: q?.source ?? null,
      // v10.7: the CoinDCX Global Futures pair when the RT feed prices it
      // (B-AAPL_USDC — the app-parity identifier), null on Yahoo/sim.
      dcxPair: q?.dcxPair ?? null,
      discovered: !!u.discovered,
    };
  });
  return {
    ok: true, count: rows.length, markets: rows, fetchedAt: Date.now(),
    // v21.3.0 (Issue-6): US market phase — pre/open/post/closed badge +
    // the honest "spot frozen / perp 24/7" context for the equity desk.
    usMarket: usMarketPhase(),
    // v21.3.0: quote-chain provenance summary (kitne symbols kis source
    // se price le rahe hain — frozen-feed diagnosis at a glance).
    priceSources: rows.reduce((acc, r) => { const s = r.source || 'none'; acc[s] = (acc[s] || 0) + 1; return acc; }, {}),
    // v10.5.3 universe provenance: seed size + CoinDCX-discovered tail
    universe: {
      seed: GLOBAL_FUTURES_SEED.length,
      discovered: rows.filter(r => r.discovered).length,
      mode: 'seed+coindcx-discovery',
    },
  };
}

// ---------------- test hooks ----------------
export function __resetGlobalForTests() {
  _quotesCache = null; _quotesAt = 0;
  _candleCache = new Map();
  // v21.3.0: candle-quote path state resets with the rest
  _gcCache = new Map(); _gcDownUntil = 0; _gcInflight = null;
  // v10.7: the RT feed state resets too (sticky variant + caches) so
  // every case starts from a clean probe. v10.11: the backoff streak
  // resets with it (a leaky streak would poison cadence assertions).
  _rtCache = null; _rtAt = 0; _rtDownUntil = 0; _rtFailStreak = 0; _rtVariant = 0; _rtInflight = null;
  // v10.5.3: restore the SEED universe (drop test-time discoveries so
  // each case starts hermetic) + stop the refresh timer
  if (_universeTimer) { clearInterval(_universeTimer); _universeTimer = null; }
  GLOBAL_FUTURES_UNIVERSE.length = 0;
  GLOBAL_FUTURES_UNIVERSE.push(...GLOBAL_FUTURES_SEED.map(u => ({ ...u })));
}
/** v10.7: inject/inspect the RT feed state from the regression suite. */
export function __setGlobalRtForTests(rowsByBase) {
  _rtCache = new Map(Object.entries(rowsByBase || {}));
  _rtAt = Date.now();
  _rtDownUntil = 0;
}
export function __globalRtStateForTests() {
  return {
    variant: _rtVariant, down: Date.now() < _rtDownUntil,
    downUntil: _rtDownUntil,           // v10.11: exact backoff boundary (jitter-aware asserts)
    failStreak: _rtFailStreak,         // v10.11: consecutive failed probe rounds
    size: _rtCache?.size ?? 0,
  };
}
