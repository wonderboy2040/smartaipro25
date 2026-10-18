// ============================================================
// server/ai/cxBookState.js — v11.3 shared CoinDCX futures BOOK state
// ------------------------------------------------------------
// LIVE CONTRACT (verified 2026-09-17 against wss://stream.coindcx.com):
// the futures socket's "currentPrices@futures@rt" channel pushes FULL
// book updates ~1/sec with ATTRIBUTABLE pair keys — the per-pair
// "@prices-futures" price-change events carry NO pair identity, so the
// book channel is the only attributable event stream:
//
//   42["currentPrices@futures#update", {"event":"…","data":"{…string…}"}]
//   data (JSON-encoded STRING) = {
//     vs, ts, pr:"futures", pST,
//     prices: {
//       "B-BTC_USDT": { "ls":0.3019, "pc":88.798, "v":174166875.67,
//                       "mp":0.30219656, "bmST":…, "cmRT":…, "btST":…, "ctRT":… }
//     }
//   }
// Rows are PARTIAL (merge semantics): a row may carry only `mp`, only
// `v`, or `ls`+`pc`+`v` — fields present are updates, absent fields
// keep their last known value. ~500 USDT pairs per beat.
//
// WHY A STANDALONE MODULE: cxRtStream.js OWNS the socket lifecycle but
// futures.js needs the book as a fetchFuturesPrices fallback leg when
// public.coindcx.com REST is WAF-blocked — and futures.js is statically
// imported BY cxRtStream, so the shared state must live in a leaf module
// with zero imports of its own (no cycle, no dynamic-import weight).
// ============================================================

/** Freshness window for a book row to be served by futBookSnapshot(). */
const FUT_BOOK_FRESH_MS = 5_000;
/** Row retention — quiet perps may go minutes without an update. */
const FUT_BOOK_RETAIN_MS = 10 * 60_000;
/** Prune cadence (piggybacked on merge; unref'd timer-free by design). */
const FUT_BOOK_PRUNE_EVERY = 200;

const _book = new Map(); // pair "B-BTC_USDT" -> { last, mark, changePct, volume, ts, at }
let _pruneCounter = 0;
let _lastUpdateAt = 0;  // last book update epoch (socket liveness, ms)

const _num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Merge one book update into the state.
 * @param {object} pricesObj the parsed `prices` object of an update
 * @param {number} tsMs the update's top-level ts (ms; seconds auto-scaled)
 */
export function mergeFutBook(pricesObj, tsMs) {
  if (!pricesObj || typeof pricesObj !== 'object') return 0;
  let ts = _num(tsMs);
  if (ts > 0 && ts < 1e12) ts *= 1000; // seconds → ms
  const at = Date.now();
  let merged = 0;
  for (const [rawPair, raw] of Object.entries(pricesObj)) {
    if (!raw || typeof raw !== 'object') continue;
    const pair = String(rawPair).toUpperCase();
    if (!/^B-[A-Z0-9.]+_(USDT|USDC)$/.test(pair)) continue;
    const prev = _book.get(pair) || {};
    const next = {
      last: _num(raw.ls) || prev.last || 0,
      mark: _num(raw.mp) || prev.mark || 0,
      changePct: Number.isFinite(parseFloat(String(raw.pc ?? '')))
        ? _num(raw.pc)
        : (prev.changePct ?? 0),
      volume: _num(raw.v) || prev.volume || 0,
      ts: ts || _num(raw.btST) || _num(raw.cmRT) || prev.ts || at,
      at,
    };
    // A heartbeat-only row (no ls/mp/v/pc) still refreshes `at` — the
    // pair is alive on the exchange even when nothing traded.
    _book.set(pair, next);
    merged++;
  }
  if (merged > 0) _lastUpdateAt = at;
  if (++_pruneCounter % FUT_BOOK_PRUNE_EVERY === 0) pruneFutBook();
  return merged;
}

/** Drop rows older than the retention window (quiet pairs). */
function pruneFutBook() {
  const cutoff = Date.now() - FUT_BOOK_RETAIN_MS;
  for (const [pair, row] of _book) {
    if ((row.at || 0) < cutoff) _book.delete(pair);
  }
}

/**
 * Fresh rows for fetchFuturesPrices's fallback leg.
 * @returns {Map<string, {pair, base, last, mark, changePct, high, low, volume, ts, source}>}
 *   shape-compatible with fetchFuturesPrices REST rows (high/low = 0 —
 *   the WS book carries no 24h extremes; every consumer already treats
 *   high/low <= 0 as "use last"). source 'ws-book' is the honest label.
 */
export function futBookSnapshot(maxAgeMs = FUT_BOOK_FRESH_MS) {
  const cutoff = Date.now() - maxAgeMs;
  const out = new Map();
  for (const [pair, row] of _book) {
    if ((row.at || 0) < cutoff) continue;
    const last = row.last > 0 ? row.last : (row.mark > 0 ? row.mark : 0);
    if (!(last > 0)) continue;
    const m = pair.match(/^B-([A-Z0-9.]+)_/);
    out.set(pair, {
      pair,
      base: m ? m[1] : pair,
      last,
      mark: row.mark > 0 ? row.mark : last,
      changePct: row.changePct ?? 0,
      high: 0,
      low: 0,
      volume: row.volume || 0,
      ts: row.ts || row.at,
      source: 'ws-book',
    });
  }
  return out;
}

/** One row lookup (tests + diagnostics). */
function _futBookRow(pair) {
  return _book.get(String(pair || '').toUpperCase()) || null;
}

/** Socket-liveness: epoch of the last merged book update (0 = never). */
function _futBookLastUpdateAt() { return _lastUpdateAt; }

/** Diagnostics for status endpoints/tests. */
export function futBookStats() {
  let fresh = 0;
  const cutoff = Date.now() - FUT_BOOK_FRESH_MS;
  for (const row of _book.values()) if ((row.at || 0) >= cutoff) fresh++;
  return { pairs: _book.size, fresh, lastUpdateAt: _lastUpdateAt };
}

export function _resetFutBookForTest() {
  _book.clear();
  _lastUpdateAt = 0;
  _pruneCounter = 0;
}
