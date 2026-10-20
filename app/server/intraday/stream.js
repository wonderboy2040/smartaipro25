// ============================================================
// intraday/stream — SSE live-quote push + outcome watcher
// ------------------------------------------------------------
// ONE shared watcher loop (5s cadence, failure-backoff to 30s):
//   symbols = latest scan signals ∪ open tracked signals ∪ open
//   paper trades → per-market quotes (Groww NSE for INDIA,
//   CoinDCX INR for CRYPTO) →
//     1. evaluate tracked-signal outcomes (T1/T2/SL/trail/EOD)
//     2. evaluate paper trades (auto-manage + square-off)
//     3. broadcast fresh quotes + outcome events to SSE clients
//     4. push outcome alerts to Telegram
//
// 2026-09 multi-market pass: the watcher runs while the NSE window
// is open OR any CRYPTO symbol is in the watch set (24/7 market).
// Regime frames are market-tagged: `regime` (NIFTY/VIX) and
// `crypto-regime` (BTC) — clients render the one they need.
//
// The watcher runs on its own during NSE hours (09:15–15:40 IST
// grace window) so the track record + Telegram outcome alerts work
// even with ZERO connected browser clients. SSE clients simply
// attach to the broadcast; N clients still cost ONE poller.
// ============================================================
import { istMinutes, getISTParts, istDayKey, dayKeyFor, isNseHoliday } from './time.js';
import { isCryptoSymbolBase } from './engine.js';
import { evaluateTracked, watcherSymbolsByMarket } from './trackRecord.js';
// v13.2 B6: SSE frame byte telemetry
import { trackSseWrite } from '../ai/bandwidth.js';
import { evaluatePaper, paperSymbolsByMarket, injectOptionPaperQuotes, optionUnderlyingsForWatcher, paperCircuitWatch } from './paperTrading.js';
import { getMarketRegime, getCryptoRegime } from './regime.js';
import { growwApiLtp, growwApiArmed } from '../ai/growwApi.js';

// v21.6 ULTRAFAST: 5s → 3s — quotes ride the SHARED micro-caches
// (growwQuote 1.5s public / growwApi 1s official / CoinDCX 2s ticker),
// so the faster loop costs ~zero extra upstream; outcome evaluation
// (T1/T2/SL/trail/EOD) now reacts within 3s of a level print.
const POLL_MS = 3000;
const BACKOFF_MS = 30000;
const FAILURE_STREAK_LIMIT = 3;
// v9.5: index symbols the option paper-trades re-price from (Groww has
// no index quotes — these ride the Yahoo map in _fetchQuotes).
// v10.13 (deep-recheck L9): UNION with inStream's INDEX_SYMBOLS — the old
// 7-name subset let a paper trade on NIFTY50/NIFTYBANK/CNXIT fall through
// to Groww's garbage index ltp (the exact v10.12.1 bug class, verified live
// 19425-vs-23398). Every name here has a YF_INDEX_MAP entry.
const INDEX_SYMBOLS = new Set([
  'NIFTY', 'NIFTY50', 'BANKNIFTY', 'NIFTYBANK', 'SENSEX', 'INDIAVIX',
  'CNXIT', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50',
]);
// v9.4: 24 → 34. The watch set = paper ∪ scan ∪ tracked, and tracked rows
// accumulate through the day (MAX_PER_DAY=40). With the old 24 cap the
// paper symbols — inserted last — were the FIRST to be silently dropped
// once the desk had been running for a few hours, exactly the "paper
// trade lagane par realtime price fetch nahi ho raha" report: the
// position card froze at entry while the quotes ticked for everyone else.
// Groww calls ride the 3s micro-cache shared with /api/quote + the SSE
// poller, so 34 symbols × every 5s is still one digit % of the cache's
// dedupe budget.
const MAX_WATCH_NSE = 56; // v21.13: 34 → 56 — MAX_PER_DAY (80) ke against cap mismatch; busy days me late tracked rows ab quotes se starve nahi hote (Groww calls 3s micro-cache pe ride)
const MAX_WATCH_CRYPTO = 40; // v21.4.1 [C5]: 14 → 40 — fetch ek hi batched ticker round hai, slice sirf map-lookup tha; 14 ke baad wali tracked rows kabhi evaluate hi nahi hoti thi (reconcile zombies)

let _deps = null;               // { fetchGrowwNseQuote, fetchCoinDcxTickers, sendTelegramRaw, escapeHtml, dispatchOutcomeAlert }
// v10.13 (deep-recheck M4): per-market scan sets. The old single
// _scanSymbols was wholesale-replaced by EVERY completed scan — an India
// scan evicted the crypto scanner's signal symbols (and vice versa), so
// the other market's signal-card quotes froze until ITS next scan ran.
// Each market now owns its own set; _watchSet() unions both.
let _scanIndia = new Set();     // latest INDIA scan's published signal symbols
let _scanCrypto = new Set();    // latest CRYPTO scan's published signal symbols
let _latestQuotes = { data: {}, ts: 0, day: '', utcDay: '' };
const _clients = new Set();       // SSE response writers
let _timer = null;
let _currentPollMs = POLL_MS;
let _failureStreak = 0;
let _lastRegimePush = 0;
let _lastCryptoRegimePush = 0;
let _ticking = false; // v10.13 (deep-recheck L1): poll re-entrancy guard
let _lastSentQuotes = {}; // v12.10 BANDWIDTH: per-symbol dead-tick filter

function _debug() { return process.env.INTRADAY_DEBUG === '1'; }

// Weekday window: 09:15 → 15:40 IST (grace past close for EOD reconcile).
function _inWindow() {
  if (_debug()) return true;
  const { weekday } = getISTParts();
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  // v18.9: weekday HOLIDAYS — the v11.4 calendar existed only in the
  // scanner route; this watcher used to poll a frozen closed tape for
  // 6.5h on Republic Day / Diwali and evaluate paper/track outcomes
  // against frozen prints.
  try { if (isNseHoliday()) return false; } catch { /* fail-open: poll */ }
  const m = istMinutes();
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 40;
}

export function initIntradayStream(deps) {
  _deps = deps || {};
  if (_timer) return;
  _timer = setInterval(_tick, POLL_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
  console.log('[intraday-stream] watcher initialised (3s cadence, NSE-hours gated + 24/7 CRYPTO)');
}

export function setScanSymbols(symbols, market = 'INDIA') {
  const list = Array.isArray(symbols) ? symbols.map(s => String(s).toUpperCase()) : [];
  const isCrypto = String(market).toUpperCase() === 'CRYPTO';
  // v10.13 (M4): write ONLY this market's set — a scan for one market must
  // never evict the other market's symbols (see the _scanIndia note).
  // The crypto-base heuristic is kept for INDIA scans that somehow carry
  // crypto names (legacy rows) — those route to the crypto set so Groww is
  // never asked for a coin.
  if (isCrypto) {
    _scanCrypto = new Set(list);
  } else {
    _scanIndia = new Set(list.filter(s => !isCryptoSymbolBase(s)));
    // v11.4 recheck: UNION, not replace — assigning `new Set(strays)` here
    // evicted the real crypto scan set whenever an INDIA scan carried stray
    // crypto names (the exact bug class the v10.13 M4 note above forbids).
    const strays = list.filter(s => isCryptoSymbolBase(s));
    if (strays.length) _scanCrypto = new Set([..._scanCrypto, ...strays]);
  }
}

export function getLatestQuotes() {
  return _latestQuotes;
}

// ------------------------------------------------------------
// Watch-set assembly: symbol → market classification. Legacy rows
// (persisted before the market field existed) fall back to the
// crypto-base heuristic so BTC rows are never routed to Groww.
// v9.4 PRIORITY ORDER: PAPER first, then the latest scan, then
// tracked rows. Map preserves insertion order and _fetchQuotes slices
// to MAX_WATCH_NSE — the user's open paper positions have live P&L
// on screen, so they must be the LAST symbols anyone would drop when
// the tracked set fills up through the day.
// ------------------------------------------------------------
function _watchSet() {
  const symMarket = new Map();
  // v21.3.0: `mark` ab market-string leta hai (INDIA/CRYPTO/FUTURES/
  // GLOBALFUTURES) — futures board rows USDT quotes pe evaluate hote hain,
  // global USDC pe; INR routing galat units se fake SL_HIT deti thi.
  const mark = (sym, mkt) => {
    if (!sym) return;
    const s = String(sym).toUpperCase();
    if (!symMarket.has(s)) symMarket.set(s, mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'GLOBALFUTURES' ? mkt : (mkt ? 'INDIA' : 'CRYPTO'));
  };
  const paper = paperSymbolsByMarket();
  paper.india.forEach(s => mark(s, 'INDIA'));
  paper.crypto.forEach(s => mark(s, 'CRYPTO'));
  // v9.5: open OPTION paper trades need their UNDERLYING index spot
  // (NIFTY/SENSEX) for the BS premium re-pricing below. Indices skip
  // the Groww equity feed, so _fetchQuotes routes them to Yahoo.
  optionUnderlyingsForWatcher().forEach(s => mark(s, 'INDIA'));
  // v11.4 recheck: TRACKED rows come BEFORE the scan set.
  // v21.17.0 DEEP RECHECK: tracked.crypto BEFORE paper.futures — agar same
  // base symbol (BTC) tracked.crypto (INR) aur paper.futures (USDT) dono me
  // hai, to plain `quotes.BTC` INR hi rehta hai (v21.4.1 [C1] invariant)
  // aur `paper.futures` ko `extraFut` → `byMarket['FUTURES|BTC']` se apna
  // USDT quote milta hai.
  const tracked = watcherSymbolsByMarket();
  (tracked.india || []).forEach(s => mark(s, 'INDIA'));
  (tracked.crypto || []).forEach(s => mark(s, 'CRYPTO'));
  (paper.futures || []).forEach(s => mark(s, 'FUTURES'));
  (paper.global || []).forEach(s => mark(s, 'GLOBALFUTURES'));
  (tracked.futures || []).forEach(s => mark(s, 'FUTURES'));   // v21.3.0 (defensive: legacy mocks/tests)
  (tracked.global || []).forEach(s => mark(s, 'GLOBALFUTURES'));
  // v10.13 (M4): union of BOTH markets' scan sets — neither scan evicts the
  // other's symbols any more.
  _scanIndia.forEach(s => mark(s, 'INDIA'));
  _scanCrypto.forEach(s => mark(s, 'CRYPTO'));
  return symMarket;
}

// v9.4: test hook — the watch-set ORDER is a user-facing contract now
// (paper trades must always receive quotes). Exposed for the
// regression suite; production code uses _watchSet directly.
export function watchSetForTests() {
  return _watchSet();
}

// v21.4.1: test hook — the market-qualified quote map (byMarket) is an
// accountability-correctness contract (cross-desk BTC rows). Read-only
// wrapper over the internal fetcher; deps inject via initIntradayStream.
export function __fetchQuotesForTests(symMarket) {
  return _fetchQuotes(symMarket);
}

async function _fetchQuotes(symMarket) {
  const out = {};
  // v21.4.1 [C1]: market-qualified quote keys — har desk ki apni entry
  // (`INDIA|RELIANCE`, `CRYPTO|BTC`, `FUTURES|BTC`, `GLOBALFUTURES|AAPL`).
  // Plain `out` keys UI/paper/SSE ke liye pehle jaise first-write-wins
  // hain (paper INR priority), par evaluateTracked ab qualified keys
  // pe truth padhta hai — CRYPTO aur FUTURES dono desks ka same base
  // symbol (BTC) kabhi cross-domain mix nahi karega.
  const outM = {};
  const QK = (mkt, s) => `${mkt}|${s}`;
  const india = [];
  const crypto = [];
  const futures = [];      // v21.3.0: USDT-perp tracked board rows
  const global = [];       // v21.3.0: USDC equity-perp tracked board rows
  for (const [sym, mkt] of symMarket.entries()) {
    if (mkt === 'FUTURES') futures.push(sym);
    else if (mkt === 'GLOBALFUTURES') global.push(sym);
    else (mkt === 'CRYPTO' ? crypto : india).push(sym);
  }

  // INDIA: OFFICIAL Groww Trading-API LTP tier first (v21.6) — ONE batched
  // call (≤50 syms) at 1s freshness when GROWW_API_KEY+SECRET are set; the
  // per-symbol public Groww quote fills the rest (≤34 watcher symbols in
  // ONE parallel round — the server-side Groww micro-cache de-dupes these
  // against the /api/quote poll flood).
  // v10.12 (#1 source transparency): every quote is tagged with the
  // upstream that actually served it — the intraday signal cards render
  // the Groww·live / Yahoo·delayed pill from this field (LiveQuote.src →
  // LiveSourceBadge). Groww → 'groww-live'; API → 'groww-api'; indices
  // below → 'yahoo-delayed'; crypto → 'coindcx-inr'.
  const apiLtp = (india.length && growwApiArmed())
    ? await growwApiLtp(india.slice(0, MAX_WATCH_NSE)).catch(() => new Map())
    : new Map();
  if (india.length && typeof _deps.fetchGrowwNseQuote === 'function') {
    for (let i = 0; i < Math.min(india.length, MAX_WATCH_NSE); i += 24) {
      const batch = india.slice(i, i + 24);
      await Promise.allSettled(batch.map(async (sym) => {
        try {
          // Tier 1: official 1s LTP (price) + public quote (change/band)
          const ltp = apiLtp.get(sym);
          const q = await _deps.fetchGrowwNseQuote(sym);
          if (ltp > 0) {
            out[sym] = {
              price: ltp, change: q?.change ?? 0, ts: Date.now(), src: 'groww-api',
              ...(q?.upperCircuit > 0 && q?.lowerCircuit > 0 ? { upperCircuit: q.upperCircuit, lowerCircuit: q.lowerCircuit } : {}),
            };
            outM[QK('INDIA', sym)] = out[sym];
            return;
          }
          // Tier 2: public Groww quote
          // v11.1 GAP 2: Groww's day price band (upper/lower circuit) rides
          // the quote through to the circuit-limit watch — same fetch,
          // zero extra upstream cost. Absent bands → fields simply omitted.
          if (q && q.price > 0) out[sym] = {
            price: q.price, change: q.change ?? 0, ts: Date.now(), src: 'groww-live',
            ...(q.upperCircuit > 0 && q.lowerCircuit > 0 ? { upperCircuit: q.upperCircuit, lowerCircuit: q.lowerCircuit } : {}),
          };
          if (out[sym]) outM[QK('INDIA', sym)] = out[sym]; // v21.4.1 [C1]
        } catch { /* skip */ }
      }));
    }
  }

  // v9.5: INDEX symbols (NIFTY/SENSEX — needed by open OPTION paper
  // trades) have no honest Groww equity quote — Groww's CASH/NIFTY
  // endpoint actually serves a garbage ltp for the index name (observed
  // live: 19425 when ^NSEI was 23398). Yahoo's index tickers are the
  // truth here, so they OVERRIDE anything Groww set for indices.
  if (typeof _deps.fetchIndexSpot === 'function') {
    await Promise.allSettled(india.filter(s => INDEX_SYMBOLS.has(s)).map(async (sym) => {
      try {
        const q = await _deps.fetchIndexSpot(sym);
        // fetchIndexSpot = the Yahoo index fetcher (^NSEI etc.) — honestly
        // labeled 'yahoo-delayed' (Groww serves stocks/ETFs only, and its
        // CASH/NIFTY endpoint serves a garbage index ltp — see the v9.5 note
        // above, verified live 19425 vs 23398).
        if (q?.price > 0) { out[sym] = { price: q.price, change: q.change ?? 0, ts: Date.now(), src: 'yahoo-delayed' }; outM[QK('INDIA', sym)] = out[sym]; }
      } catch { /* skip */ }
    }));
  }

  // CRYPTO: CoinDCX INR quotes — ONE shared 2s-cached ticker round-trip
  // (same cache the live /api/crypto-prices + SSE price stream use).
  if (crypto.length && typeof _deps.fetchCoinDcxTickers === 'function') {
    try {
      const tickers = await _deps.fetchCoinDcxTickers();
      const byMkt = new Map();
      for (const t of tickers) byMkt.set(t.market, t);
      for (const sym of crypto.slice(0, MAX_WATCH_CRYPTO)) {
        const t = byMkt.get(`${sym}INR`);
        const price = parseFloat(t?.last_price);
        if (price > 0) {
          out[sym] = { price, change: parseFloat(t.change_24_hour) || 0, ts: Date.now(), src: 'coindcx-inr' };
          outM[QK('CRYPTO', sym)] = out[sym]; // v21.4.1 [C1]
        }
      }
    } catch { /* CoinDCX transient */ }
  }

  // v21.3.0 (Issue-3: FUTURES/GLOBALFUTURES board accountability): tracked
  // futures rows need USDT quotes (CoinDCX perp RT — the SAME single-flight
  // 2s-cached round the futures board rides; Binance-fut fallback built in).
  // Unit-mismatch (INR quotes vs USDT plans) is exactly why futures rows
  // were never trackable before.
  // v21.4.1 [C4]: ts ab honest — futures row ka apna upstream ts (deep-stale
  // serve 3min tak ho sakta hai) Date.now() se replace karke fresh dikhana jhooth tha.
  if (futures.length > 0) {
    try {
      const futMod = await import('../ai/futures.js');
      const rows = await futMod.fetchFuturesPrices({ maxAgeMs: 5000 }).catch(() => null);
      const byBase = new Map((Array.isArray(rows) ? rows : []).map(x => [String(x.base).toUpperCase(), x]));
      // v21.23.10 [METALS-QUOTES]: fetchFuturesPrices ki universe me XAU/XAG
      // NAHI hain (FUTURES_UNIVERSE perps only; leg-3 Binance synth bhi wahi
      // universe scan karta hai) → CoinDCX RT dark hote hi metals (Gold &
      // Silver desk) ke manual paper trades ki SL/T1/T2 evaluation SILENT
      // freeze hoti thi ("profit kabhi book nahi hota" symptom). Rows missing
      // → fetchMetalsPrices se fill (same row shape: base/last/changePct/ts).
      const missingMetals = futures.filter(s => !byBase.has(s) && futMod.isMetalsBase(s));
      if (missingMetals.length > 0) {
        const mrows = await futMod.fetchMetalsPrices().catch(() => null);
        for (const m of (Array.isArray(mrows) ? mrows : [])) {
          const mb = String(m?.base || m?.symbol || '').toUpperCase();
          if (missingMetals.includes(mb)) byBase.set(mb, m);
        }
      }
      for (const sym of futures) {
        const r = byBase.get(sym);
        const price = parseFloat(r?.last ?? r?.price);
        if (price > 0) {
          out[sym] = { price, change: parseFloat(r?.changePct) || 0, ts: Number.isFinite(r?.ts) ? r.ts : Date.now(), src: 'coindcx-fut-usdt' };
          outM[QK('FUTURES', sym)] = out[sym]; // v21.4.1 [C1]
        }
      }
    } catch { /* futures feed transient — rows stay unevaluated this tick */ }
  }
  // v21.4.1 [C1] COLLISION REPAIR — ek base symbol CRYPTO bucket me bhi ho
  // sakta hai (paper/tracked-crypto INR first-write-wins) AUR FUTURES desk
  // pe bhi tracked (BTC/ETH/SOL…). Upar wali futures leg use miss kar degi
  // (bucket classification). Tracked futures symbols jo kisi aur bucket me
  // gaye, unke liye USDT quote SIRF qualified key pe — plain `out` me INR
  // quote paper/UI ko milti rehti hai, FUTURES row ko apna USDT truth outM
  // se milta hai. Wahi single-flight round share hota hai — koi extra
  // upstream cost nahi.
  try {
    const trackedNow = watcherSymbolsByMarket();
    // v21.17.0: PAPER futures rows bhi is coverage list me — agar BTC ka
    // CRYPTO (INR) paper row pehle mark ho chuka hai, to FUTURES paper row
    // ka USDT quote SIRF is qualified leg se aata hai (warna cross-domain
    // INR quote se false SL_HIT).
    const paperFut = (paperSymbolsByMarket().futures || []).map(s => String(s).toUpperCase());
    const extraFut = [...new Set([...(trackedNow.futures || []), ...paperFut])]
      .map(s => String(s).toUpperCase())
      .filter(s => symMarket.get(s) !== 'FUTURES');
    if (extraFut.length > 0) {
      const { fetchFuturesPrices } = await import('../ai/futures.js');
      const rows = await fetchFuturesPrices({ maxAgeMs: 5000 }).catch(() => null);
      const byBase = new Map((Array.isArray(rows) ? rows : []).map(x => [String(x.base).toUpperCase(), x]));
      for (const sym of extraFut) {
        const r = byBase.get(sym);
        const price = parseFloat(r?.last ?? r?.price);
        if (price > 0) outM[QK('FUTURES', sym)] = { price, change: parseFloat(r?.changePct) || 0, ts: Number.isFinite(r?.ts) ? r.ts : Date.now(), src: 'coindcx-fut-usdt' };
      }
    }
  } catch { /* transient — qualified keys optional hain */ }
  // v21.3.0: GLOBALFUTURES tracked rows — the USDC quote chain (CoinDCX
  // USDC RT → candle path → Finnhub → Yahoo; 5s-cached inside the module).
  if (global.length > 0) {
    try {
      const { fetchGlobalLtpMap } = await import('../ai/globalFutures.js');
      const m = await fetchGlobalLtpMap().catch(() => null);
      if (m) {
        for (const sym of global) {
          const row = m.get(sym);
          const price = parseFloat(row?.price);
          // v21.4.1 [C4]: ts honest — row ka apna ts (Yahoo frozen-close
          // bhi ab apne real ts se aayega, globalFutures.js fix ke saath).
          if (price > 0) {
            out[sym] = { price, change: parseFloat(row?.changePct) || 0, ts: Number.isFinite(row?.ts) ? row.ts : Date.now(), src: 'global-usdc' };
            outM[QK('GLOBALFUTURES', sym)] = out[sym]; // v21.4.1 [C1]
          }
        }
      }
    } catch { /* transient */ }
  }
  return { quotes: out, byMarket: outM }; // v21.4.1 [C1]: qualified map saath me
}

async function _tick() {
  // v10.13 (deep-recheck L1): re-entrancy guard — a slow quote round can
  // exceed the 5s interval; overlapping ticks stack upstream load exactly
  // when the upstream is unhealthy.
  if (_ticking) return;
  _ticking = true;
  try {
    const symMarket = _watchSet();
    // v21.3.0: FUTURES/GLOBALFUTURES tracked rows bhi 24/7 hain — NSE
    // window band hone par watcher band nahi hota jab perp rows open hon.
    const vals = [...symMarket.values()];
    const hasCrypto = vals.includes('CRYPTO') || vals.includes('FUTURES') || vals.includes('GLOBALFUTURES');
    // Run while the NSE window is open OR any crypto/futures symbol is watched (24/7).
    if (!_inWindow() && !hasCrypto) return;
    if (symMarket.size === 0) return;

    const quotesPack = await _fetchQuotes(symMarket);
    const quotes = quotesPack.quotes;
    const byMarket = quotesPack.byMarket; // v21.4.1 [C1]: per-desk truth
    const got = Object.keys(quotes).length;
    if (got === 0) {
      _failureStreak++;
      if (_failureStreak >= FAILURE_STREAK_LIMIT) {
        // Back off: clear the timer and retry slowly until success.
        clearInterval(_timer);
        _currentPollMs = BACKOFF_MS;
        _timer = setInterval(_tick, BACKOFF_MS);
        if (typeof _timer.unref === 'function') _timer.unref();
      }
      return;
    }
    if (_failureStreak >= FAILURE_STREAK_LIMIT) {
      // Recovered — restore fast cadence.
      clearInterval(_timer);
      _currentPollMs = POLL_MS;
      _timer = setInterval(_tick, POLL_MS);
      if (typeof _timer.unref === 'function') _timer.unref();
    }
    _failureStreak = 0;

    // Idle backoff: when no SSE clients are listening and NSE window is closed,
    // slow down watcher to 30s so 24/7 crypto doesn't hammer outbound bandwidth when unused
    if (_clients.size === 0 && !_inWindow() && _failureStreak === 0) {
      if (_currentPollMs !== BACKOFF_MS) {
        clearInterval(_timer);
        _currentPollMs = BACKOFF_MS;
        _timer = setInterval(_tick, BACKOFF_MS);
        if (typeof _timer.unref === 'function') _timer.unref();
      }
    } else if ((_clients.size > 0 || _inWindow()) && _currentPollMs !== POLL_MS && _failureStreak === 0) {
      clearInterval(_timer);
      _currentPollMs = POLL_MS;
      _timer = setInterval(_tick, POLL_MS);
      if (typeof _timer.unref === 'function') _timer.unref();
    }

    // v9.5 F&O: re-price open OPTION paper trades and inject their premiums
    // into this tick's quotes BEFORE the latest-quotes merge + evaluation —
    // SL/T1/T2/EOD, P&L and manual close (getLatestQuotes) then see them
    // like any equity LTP.
    // v21.0.6 [audit B1]: LIVE chain LTP FIRST (the SAME data.js ladder the
    // options desk displays — direct NSE / Groww mirror / BSE), BS model
    // sirf fallback (chain down / row missing). Exits ab desk-parity
    // premium pe act karte hain.
    try { await injectOptionPaperQuotes(quotes, _deps.fetchIndexSpot, _deps.fetchOptionChainFor); } catch (e) { console.warn('[intraday-stream] option reprice:', e?.message); }

    // 2026 perf audit (M2): reset at the IST day boundary (NSE session) AND
    // the UTC day boundary (crypto session) — each market starts its own
    // session with a clean, live-only map.
    const today = istDayKey();
    const utcDay = dayKeyFor('CRYPTO');
    if (_latestQuotes.day !== today || _latestQuotes.utcDay !== utcDay) {
      _latestQuotes = { data: {}, ts: 0, day: today, utcDay };
      _lastSentQuotes = {};
    }
    // v21.17.0 DEEP RECHECK: qualified keys (`FUTURES|BTC`, `GLOBALFUTURES|AAPL`)
    // bhi `_latestQuotes.data` me merge hote hain taaki manual close
    // (`closePaperTrade(id, getLatestQuotes().data)`) aur SSE clients ko
    // per-desk USDT/USDC quote mile jab plain key INR ho.
    _latestQuotes = { data: { ..._latestQuotes.data, ...quotes, ...byMarket }, ts: Date.now(), day: today, utcDay };
    // v10.13 (deep-recheck L7): prune departed symbols. The map was
    // merge-only — symbols that left the watch set kept their frozen last
    // quote forever and a fresh client's initial snapshot served them as if
    // live. A key absent from the CURRENT watch set for >10 minutes can
    // never refresh again — drop it (paper/tracked legs are always in the
    // watch set, so live positions are never pruned).
    {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const k of Object.keys(_latestQuotes.data)) {
        const baseKey = k.includes('|') ? k.split('|')[1] : k;
        if (!symMarket.has(baseKey) && (_latestQuotes.data[k]?.ts || 0) < cutoff) {
          delete _latestQuotes.data[k];
        }
      }
    }

    // Outcome evaluation (tracked signals + paper trades).
    // v21.4.1 [C1] + v21.17.0: evaluateTracked AUR evaluatePaper dono ko
    // market-qualified `byMarket` map — same base symbol cross-desk (CRYPTO
    // INR vs FUTURES USDT) ab kabhi mix nahi.
    const events = [];
    try { evaluateTracked(quotes, events, byMarket); } catch (e) { console.warn('[intraday-stream] track eval:', e?.message); }
    try { evaluatePaper(quotes, events, byMarket); } catch (e) { console.warn('[intraday-stream] paper eval:', e?.message); }
    // v11.1 GAP 2: circuit-limit watch — open equity paper positions
    // drifting toward an ADVERSE circuit (LONG→lower / SHORT→upper)
    // emit URGENT CIRCUIT_RISK events (10-min per-symbol cooldown).
    // Rides the SAME quotes the watcher already fetched — zero extra
    // upstream cost; inert when Groww serves no bands for a symbol.
    try { paperCircuitWatch(quotes, events); } catch (e) { console.warn('[intraday-stream] circuit watch:', e?.message); }

    // v12.10 BANDWIDTH: Only broadcast quotes that changed (|Δprice| ≥ 0.05% or new).
    // The client merges incoming updates into its livePrices map, so sending only changed
    // rows cuts ~95% of egress on this 5s stream.
    if (_clients.size > 0) {
      const changed = {};
      for (const [sym, q] of Object.entries({ ...quotes, ...byMarket })) {
        const prev = _lastSentQuotes[sym];
        const price = Number(q?.price);
        if (!prev || !Number.isFinite(prev.price) || (Number.isFinite(price) && Math.abs(price - prev.price) / (prev.price || 1) >= 0.0005)) {
          changed[sym] = q;
          _lastSentQuotes[sym] = { price, ts: Date.now() };
        }
      }
      if (Object.keys(changed).length > 0) {
        _broadcast('quotes', changed);
      }
    }
    for (const ev of events) {
      _broadcast('outcome', ev);
      if (typeof _deps.dispatchOutcomeAlert === 'function') {
        _deps.dispatchOutcomeAlert(ev, {
          sendTelegramRaw: _deps.sendTelegramRaw,
          escapeHtml: _deps.escapeHtml,
        }).catch(() => { });
      }
    }

    // Regime pushes every 60s — NIFTY (India) + BTC (crypto), tagged.
    if (Date.now() - _lastRegimePush > 60 * 1000) {
      _lastRegimePush = Date.now();
      getMarketRegime(_debug()).then(r => { if (r) _broadcast('regime', r); }).catch(() => { });
    }
    if (Date.now() - _lastCryptoRegimePush > 60 * 1000) {
      _lastCryptoRegimePush = Date.now();
      getCryptoRegime(_debug()).then(r => { if (r) _broadcast('crypto-regime', r); }).catch(() => { });
    }
  } catch (e) {
    console.warn('[intraday-stream] tick error:', e?.message);
  } finally {
    _ticking = false;
  }
}

function _broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const write of _clients) {
    try { write(payload); } catch { /* client gone */ }
  }
}

// ------------------------------------------------------------
// SSE endpoint handler — attach to express: app.get('/api/intraday-stream', intradayStreamHandler)
// ------------------------------------------------------------
export function intradayStreamHandler(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 3000\n\n');

  const write = trackSseWrite('sse:intraday', (payload) => {
    // 2026 perf audit (H1): backpressure guard — a stalled client (phone
    // sleep / zero-window TCP) makes Node buffer every SSE write forever.
    // Kill the connection once the socket buffer exceeds 128KB; the browser
    // EventSource auto-reconnects when it wakes.
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
  // Restore fast 5s cadence if watcher was in idle backoff
  if (_currentPollMs !== POLL_MS && _failureStreak === 0) {
    clearInterval(_timer);
    _currentPollMs = POLL_MS;
    _timer = setInterval(_tick, POLL_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
  }

  // Initial snapshot so a fresh client paints instantly.
  try {
    if (_latestQuotes.ts > 0) {
      write(`event: quotes\ndata: ${JSON.stringify(_latestQuotes.data)}\n\n`);
      // v18.5 FIX: seed the dead-tick map from the snapshot we just sent —
      // otherwise the very next _tick sees every watch-set symbol as
      // "changed" vs a stale/empty _lastSentQuotes and re-broadcasts the
      // full frame to ALL clients (one duplicate full frame per connect).
      for (const [sym, q] of Object.entries(_latestQuotes.data || {})) {
        const price = Number(q?.price);
        if (Number.isFinite(price)) _lastSentQuotes[sym] = { price, ts: Date.now() };
      }
    }
    write(`event: status\ndata: ${JSON.stringify({ watcher: _inWindow() ? 'live' : 'idle', clients: _clients.size, ts: Date.now() })}\n\n`);
    getMarketRegime(_debug()).then(r => { if (r) write(`event: regime\ndata: ${JSON.stringify(r)}\n\n`); }).catch(() => { });
    getCryptoRegime(_debug()).then(r => { if (r) write(`event: crypto-regime\ndata: ${JSON.stringify(r)}\n\n`); }).catch(() => { });
  } catch { /* client gone */ }

  const keepalive = setInterval(() => {
    try {
      write(`event: status\ndata: ${JSON.stringify({ watcher: _inWindow() ? 'live' : 'idle', clients: _clients.size, ts: Date.now() })}\n\n`);
    } catch { /* noop */ }
  }, 15000);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  req.on('close', () => {
    clearInterval(keepalive);
    _clients.delete(write);
    try { res.end(); } catch { /* noop */ }
  });
}
