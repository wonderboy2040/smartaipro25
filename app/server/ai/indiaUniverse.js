// ============================================================
// server/ai/indiaUniverse.js — v10.17 FULL UNIVERSE SCAN
// ------------------------------------------------------------
// THE GAP: the India desks scanned a FIXED ~45-name F&O base +
// watchlist. The best setup of the day sitting outside that list
// (IRFC breakout, HFCL volume blast, persistent midcap squeeze)
// could never surface on the Signal Board or Trending Movers —
// the desk was structurally blind to ~85% of the NSE tape.
//
// THE FIX (plan Section 1 — "full universe scan + tiered cadence"):
//   • DISCOVERY — one TradingView India scanner FILTER query
//     (type=stock · exchange=NSE · sorted by turnover) returns the
//     ~220 most-traded NSE names every 10 min. Honest fallback: a
//     curated static seed (~180 liquid names) when the scanner is
//     unreachable. Zero additional auth, same public endpoint the
//     tickers-batch path already uses.
//   • TIERED CADENCE — Tier 1 (base ∪ watchlist-hot) is scanned
//     EVERY cycle; Tier 2 (the rest of the discovered universe) is
//     scanned in ROTATING SLICES (~¼ per cycle) so the whole market
//     gets covered every ~4 board cycles (~4 min) without ever
//     exploding a single scan's upstream cost.
//   • HOT PROMOTION — any T2 symbol that shows HEAT in its freshly
//     scanned row (|chg| ≥ 2.5% · relVol ≥ 2 · RSI ≥ 72 / ≤ 28) is
//     promoted into the hot set for the next 20 min (cap 15), i.e.
//     it rides Tier-1 cadence exactly while it matters.
//
// Feature flag: AI_INDIA_FULL_UNIVERSE=off reverts every caller to
// the legacy static universe (byte-identical scan behavior).
// ============================================================

import { TV_SCAN_HEADERS } from '../lib/tvHeaders.js';

// ---------------- configuration ----------------
/** Full-universe size (discovery depth). Env-tunable. */
const FULL_SIZE = Math.max(60, Math.min(500, parseInt(process.env.AI_INDIA_FULL_UNIVERSE_SIZE, 10) || 220));
/** Tier-2 symbols fetched per scan cycle (rotation slice). */
const T2_SLICE_TARGET = 50;
/** Promotion TTL — how long a hot symbol rides Tier-1. */
const HOT_TTL_MS = 20 * 60_000;
/** Max simultaneously-hot Tier-2 symbols. */
const HOT_CAP = 15;
/** Discovery cache window. */
const DISCOVER_CACHE_MS = 10 * 60_000;
/** Discovery negative cache (scanner down — don't hammer). */
const DISCOVER_NEG_MS = 90 * 1000;
const DISCOVER_TIMEOUT_MS = 10_000;

/** Whole feature kill switch (default ON). */
export function fullIndiaUniverseEnabled() {
  return String(process.env.AI_INDIA_FULL_UNIVERSE || '').toLowerCase() !== 'off';
}

// Static fallback seed — liquid NSE names BEYOND the desks' ~45-name
// base. Used ONLY when the TV filter query is unreachable (outage /
// geo-block). Symbols follow the same grammar the whole repo already
// validates against (/^[A-Z0-9&-]+$/). Delistings degrade honestly:
// the tickers-batch simply returns no row for a dead name.
export const INDIA_FULL_FALLBACK_SEED = [
  // Banks & financials
  'PNB', 'CANBK', 'BANKBARODA', 'UNIONBANK', 'IDFCFIRSTB', 'FEDERALBNK', 'AUBANK',
  'YESBANK', 'INDIANBANK', 'LICI', 'ICICIPRULI', 'ICICIGI', 'HDFCAMC', 'BAJAJHLDNG',
  'CHOLAFIN', 'MUTHOOTFIN', 'MANAPPURAM', 'PFC', 'RECLTD', 'IRFC', 'HUDCO', 'LICHSGFIN',
  'STARHEALTH', 'ANGELONE', 'BSE', 'MCX', 'IEX', 'PAYTM', 'POLICYBZR', 'JIOFIN',
  // IT
  'PERSISTENT', 'COFORGE', 'MPHASIS', 'LTIM', 'TATAELXSI', 'LTTS', 'KPITTECH',
  // Auto & ancillaries
  'ASHOKLEY', 'TVSMOTOR', 'BALKRISIND', 'MRF', 'APOLLOTYRE', 'MOTHERSON', 'BOSCHLTD',
  'EXIDEIND', 'UNOMINDA', 'TIINDIA', 'ESCORTS', 'SONACOMS', 'BHARATFORG', 'ETERNAL', 'ZOMATO',
  // Pharma & healthcare
  'AUROPHARMA', 'LUPIN', 'ALKEM', 'TORNTPHARM', 'GLENMARK', 'IPCALAB', 'NATCOPHARM',
  'BIOCON', 'SYNGENE', 'ZYDUSLIFE', 'LAURUSLABS', 'GRANULES', 'ABBOTINDIA', 'GLAND',
  'APOLLOHOSP', 'MAXHEALTH', 'LALPATHLAB', 'FORTIS',
  // FMCG & consumer
  'GODREJCP', 'DABUR', 'COLPAL', 'MARICO', 'VBL', 'UBL', 'RADICO', 'BRITANNIA',
  'TRENT', 'NYKAA', 'DMART', 'ABFRL', 'PAGEIND', 'BATAINDIA', 'JUBLFOOD', 'IHCL',
  // Metals & mining
  'NMDC', 'SAIL', 'JINDALSTEL', 'APLAPOLLO',
  // Power & energy
  'TATAPOWER', 'ADANIPOWER', 'ADANIGREEN', 'IREDA', 'NHPC', 'TORNTPOWER', 'SUZLON', 'NLCIND',
  'OIL', 'IGL', 'INOXGREEN',
  // Cement, infra & realty
  'DLF', 'GODREJPROP', 'OBEROIRLTY', 'IRCTC', 'RVNL', 'SHREECEM', 'RAMCOCEM', 'NBCC', 'NCC',
  // Chemicals
  'PIDILITIND', 'UPL', 'DEEPAKNTR', 'SRF', 'AARTIIND',
  // Defence & industrials
  'BEL', 'HAL', 'BDL', 'MAZDOCK', 'COCHINSHIP', 'DATAPATTNS', 'CGPOWER', 'BHEL', 'CUMMINSIND',
  // Telecom, travel & logistics
  'IDEA', 'INDUSTOWER', 'DELHIVERY', 'CONCOR', 'INDIGO',
  // Consumer durables & electronics
  'VOLTAS', 'HAVELLS', 'DIXON',
];

// ---------------- pure helpers (all test-locked) ----------------

/** Symbol grammar — same shape the repo validates everywhere. */
export function validNSESymbol(s) {
  return typeof s === 'string' && /^[A-Z0-9&-]{2,15}$/.test(s.trim().toUpperCase());
}

/**
 * PURE: TV filter-query rows → validated liquidity rows.
 * Input: [{ name, exchange, close, change, volume, value_traded,
 *           relative_volume_10d_calc, market_cap_basic, sector? }]
 * Output: [{ symbol, ltp, changePct, volume, valueTraded, relVolume,
 *            marketCap, sector }] — NSE-only, deduped, value_traded-desc.
 * v11.1 GAP 1: `sector` (d[8], appended LAST so the locked column
 * contract indices are stable) carries TV's own sector taxonomy —
 * the sector desk buckets the FULL 220-name universe with it.
 */
export function parseDiscoveryRows(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const d = item?.d;
    if (!Array.isArray(d)) continue;
    // column contract: [name, exchange, close, change, volume,
    // value_traded, rel_volume_10d_calc, market_cap_basic, sector?]
    const symbol = String(d[0] || '').trim().toUpperCase();
    const exchange = String(d[1] || '').trim().toUpperCase();
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const ltp = num(d[2]);
    if (!validNSESymbol(symbol)) continue;
    if (exchange && exchange !== 'NSE') continue; // BSE-only duplicates out
    if (!(ltp > 0)) continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const tvSector = typeof d[8] === 'string' ? d[8].trim().slice(0, 60) : null;
    out.push({
      symbol,
      ltp: Math.round(ltp * 100) / 100,
      changePct: num(d[3]) ?? 0,
      volume: num(d[4]) ?? 0,
      valueTraded: num(d[5]) ?? 0,
      relVolume: num(d[6]) != null && d[6] > 0 ? Math.round(d[6] * 100) / 100 : null,
      marketCap: num(d[7]) ?? 0,
      sector: tvSector && tvSector.length > 0 ? tvSector : null,
    });
  }
  // liquidity order: turnover first, volume as tiebreak (already
  // sorted upstream, but never TRUST the wire — re-sort locally).
  out.sort((a, b) => (b.valueTraded || 0) - (a.valueTraded || 0) || (b.volume || 0) - (a.volume || 0));
  return out.slice(0, FULL_SIZE);
}

/**
 * PURE: Tier split. T1 = base ∪ hot (always scanned — hot names ride
 * Tier-1 cadence for their whole TTL); T2 = the rest of the discovered
 * universe (rotation). Base order is preserved (callers rely on the
 * seed order for stable upstream batches); hot names append after the
 * base so ticker batches stay deterministic.
 */
export function splitTiers(base, discovered, hot) {
  const baseSet = new Set((Array.isArray(base) ? base : []).filter(validNSESymbol));
  const hotSet = new Set((Array.isArray(hot) ? hot : []).filter(validNSESymbol));
  const t1 = [...baseSet, ...[...hotSet].filter(h => !baseSet.has(h))];
  const t2 = [];
  const seen = new Set(t1);
  for (const row of Array.isArray(discovered) ? discovered : []) {
    const sym = row?.symbol || row;
    if (!validNSESymbol(sym)) continue;
    if (seen.has(sym)) continue; // T1 members (incl. hot) never double-seat in T2
    seen.add(sym);
    t2.push(sym);
  }
  return { t1, t2, fullCount: t1.length + t2.length };
}

/**
 * PURE: rotation slice — take `size` symbols starting at `ptr`,
 * wrapping around. Deterministic, no hidden state.
 */
export function nextSlice(t2, ptr, size = T2_SLICE_TARGET) {
  const list = Array.isArray(t2) ? t2 : [];
  if (list.length === 0 || !(size > 0)) return { slice: [], nextPtr: 0 };
  const start = ((ptr % list.length) + list.length) % list.length;
  // adaptive: a quarter of T2 per cycle keeps whole-market coverage
  // at ~4 cycles even when discovery grows the universe (never below
  // the floor size, never more than the whole list).
  const take = Math.min(Math.max(size, Math.ceil(list.length / 4)), list.length);
  const slice = [];
  for (let i = 0; i < take; i++) {
    slice.push(list[(start + i) % list.length]);
  }
  const nextPtr = (start + take) % list.length;
  return { slice, nextPtr };
}

/**
 * PURE: heat rule — does this freshly-scanned TV row deserve Tier-1
 * promotion? Rows use EITHER shape (liquidity discovery row or the
 * board's tv-batch row — both carry changePct/relVolume/rsi-ish).
 */
export function isHot(row) {
  if (!row || typeof row !== 'object') return false;
  const chg = Math.abs(Number(row.changePct ?? row.change ?? 0) || 0);
  const rel = Number(row.relVolume ?? 0) || 0;
  const rsi = Number(row.rsi ?? NaN);
  if (chg >= 2.5) return true;
  if (rel >= 2) return true;
  if (Number.isFinite(rsi) && (rsi >= 72 || rsi <= 28)) return true;
  return false;
}

/** PURE: merge freshly-scanned hot rows into the hot map (TTL + cap).
 *  Accepts a Map (the production state) OR an array of [sym, expiry]
 *  pairs (the test fixtures). */
export function mergeHot(hot, rows, now = Date.now(), ttlMs = HOT_TTL_MS, cap = HOT_CAP) {
  const next = hot instanceof Map ? new Map(hot) : new Map(Array.isArray(hot) ? hot : []);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isHot(row)) continue;
    const sym = String(row.symbol || '').trim().toUpperCase();
    if (!validNSESymbol(sym)) continue;
    if (next.has(sym)) next.set(sym, now + ttlMs); // refresh the ride
    else if (next.size < cap) next.set(sym, now + ttlMs);
    // over cap → fittest survive: earliest-expiring entries evicted
    else {
      let oldest = null, oldestAt = Infinity;
      for (const [k, v] of next) if (v < oldestAt) { oldestAt = v; oldest = k; }
      if (oldest != null && oldestAt < now + ttlMs) { next.delete(oldest); next.set(sym, now + ttlMs); }
    }
  }
  return next;
}

/** PURE: prune expired hot entries (Map or pair-array in, Map out). */
export function pruneHot(hot, now = Date.now()) {
  const next = new Map();
  const entries = hot instanceof Map
    ? [...hot]
    : (Array.isArray(hot) ? hot : []);
  for (const [k, v] of entries) {
    if (v > now) next.set(k, v);
  }
  return next;
}

// ---------------- discovery (network) ----------------

let _discovered = { at: 0, rows: [], ok: false };
let _negUntil = 0;
let _inflight = null;

/** TV India scanner filter query — top NSE stocks by turnover. */
async function _fetchDiscovery() {
  const body = {
    filter: [
      { left: 'type', operation: 'equal', right: 'stock' },
      { left: 'exchange', operation: 'in_range', right: ['NSE'] },
    ],
    symbols: { tickers: [] },
    columns: [
      'name', 'exchange', 'close', 'change', 'volume',
      'value_traded', 'relative_volume_10d_calc', 'market_cap_basic',
      // v11.1 GAP 1: TV's own sector taxonomy — lets the sector desk
      // bucket the FULL discovered universe, not just the base 45.
      // Appended last: the locked column-contract indices stay stable.
      'sector',
    ],
    sort: { sortBy: 'value_traded', sortOrder: 'desc' },
    options: { lang: 'en' },
    range: [0, FULL_SIZE],
  };
  const res = await fetch(`https://scanner.tradingview.com/india/scan?t=${Date.now()}`, {
    method: 'POST',
    headers: TV_SCAN_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TV discovery HTTP ${res.status}`);
  const data = await res.json();
  const rows = parseDiscoveryRows(data?.data || []);
  if (rows.length < 40) throw new Error(`TV discovery too thin (${rows.length})`);
  return rows;
}

/**
 * Discovered full universe (cached 10 min, single-flight, honest
 * negative cache). Falls back to the static seed with ok:false so
 * callers can label the mode honestly.
 */
export async function discoverNSEFullUniverse() {
  if (Date.now() - _discovered.at < DISCOVER_CACHE_MS && _discovered.rows.length > 0) {
    return _discovered;
  }
  if (Date.now() < _negUntil) return _discovered; // scanner down — hold last/seed
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const rows = await _fetchDiscovery();
      _discovered = { at: Date.now(), rows, ok: true };
    } catch (e) {
      console.warn('[india-universe] discovery failed:', e?.message || e);
      _negUntil = Date.now() + DISCOVER_NEG_MS;
      if (_discovered.rows.length === 0) {
        // static seed fallback — every row zeroed except the symbol
        // (no turnover data → T2 order = curated order, honest ok:false)
        _discovered = {
          at: Date.now(),
          rows: INDIA_FULL_FALLBACK_SEED.map(symbol => ({
            symbol, ltp: 0, changePct: 0, volume: 0, valueTraded: 0, relVolume: null, marketCap: 0,
          })),
          ok: false,
        };
      }
    } finally {
      _inflight = null;
    }
    return _discovered;
  })();
  return _inflight;
}

// ---------------- the ONE tiered-universe call ----------------

let _hot = new Map();
let _ptr = 0;

/**
 * The tiered scan universe for ONE cycle. ADVANCES the shared T2
 * rotation pointer (board + movers + scanner share the rotation —
 * combined callers simply cover T2 faster, never slower).
 * opts.exclude: symbols the user explicitly removed from their
 * watchlist — honoured against discovered T2 names too (removing a
 * base name means "don't scan it", not "don't scan it in T1").
 * Returns { scan, t1Count, t2Count, sliceCount, fullCount, hot, mode }.
 */
export async function tieredScanUniverse(base, opts = {}) {
  if (!fullIndiaUniverseEnabled()) {
    const legacy = [...(Array.isArray(base) ? base : [])].filter(validNSESymbol);
    return { scan: legacy, t1Count: legacy.length, t2Count: 0, sliceCount: 0, fullCount: legacy.length, hot: [], mode: 'legacy-static' };
  }
  const exclude = new Set((Array.isArray(opts.exclude) ? opts.exclude : []).map(s => String(s || '').trim().toUpperCase()).filter(Boolean));
  const discovered = await discoverNSEFullUniverse();
  const discoveredRows = exclude.size > 0
    ? discovered.rows.filter(r => !exclude.has(r.symbol))
    : discovered.rows;
  _hot = pruneHot(_hot, Date.now());
  // a removed symbol's heat never rides T1 either
  if (exclude.size > 0 && _hot.size > 0) _hot = new Map([..._hot].filter(([k]) => !exclude.has(k)));
  const { t1, t2, fullCount } = splitTiers(base, discoveredRows, [..._hot.keys()]);
  const { slice, nextPtr } = nextSlice(t2, _ptr);
  _ptr = nextPtr;
  const hotInScan = slice.filter(s => _hot.has(s));
  return {
    scan: [...t1, ...slice],
    t1Count: t1.length,
    t2Count: t2.length,
    sliceCount: slice.length,
    fullCount,
    hot: [..._hot.keys()],
    hotInScan,
    mode: discovered.ok ? 'tiered-full' : 'tiered-seed-fallback',
  };
}

/**
 * Feed freshly-scanned TV rows back into the hot engine (called by
 * every scanner AFTER its batch lands — promotion applies NEXT cycle).
 */
export function absorbScanRows(rows) {
  if (!fullIndiaUniverseEnabled()) return [];
  _hot = mergeHot(_hot, rows, Date.now());
  return [..._hot.keys()];
}

// ---------------- test hooks ----------------
export function __resetIndiaUniverseForTests() {
  _discovered = { at: 0, rows: [], ok: false };
  _negUntil = 0;
  _inflight = null;
  _hot = new Map();
  _ptr = 0;
}
export function __setDiscoveredForTests(rows, ok = true) {
  _discovered = { at: Date.now(), rows, ok };
}
export function __setHotForTests(hot) {
  _hot = new Map(Array.isArray(hot) ? hot : Object.entries(hot || {}));
}
export function __hotForTests() { return _hot; }
export function __ptrForTests() { return _ptr; }
export function __setPtrForTests(p) { _ptr = p; }
export function __fullSizeForTests() { return FULL_SIZE; }

// ------------------------------------------------------------
// v20.2 BOARD UNIVERSE OVERRIDES — the UniverseEditor finally affects
// the board the user actually watches. The editor's POST
// /api/intraday-universe writes { removedBase, custom } to
// server/data/intraday-universe.json; the board reads the SAME file
// here (30s TTL) — removedBase symbols are excluded from the tiered
// scan AND the legacy static scan, custom symbols ride Tier-1
// cadence. (Previously the editor only affected the legacy v4
// scanner — a user removing TATAMOTORS still saw it on the board.)
// ------------------------------------------------------------
import { loadJSON } from '../intraday/store.js';

let _uniOverridesAt = 0;
let _uniOverridesCache = null;
export function boardUniverseOverrides() {
  const now = Date.now();
  if (_uniOverridesCache && now - _uniOverridesAt < 30_000) return _uniOverridesCache;
  let removedBase = [];
  let custom = [];
  try {
    const st = loadJSON('intraday-universe.json', { removedBase: [], custom: [] });
    removedBase = (Array.isArray(st?.removedBase) ? st.removedBase : []).filter(validNSESymbol);
    custom = (Array.isArray(st?.custom) ? st.custom : []).filter(validNSESymbol);
  } catch { /* universe overrides are optional */ }
  _uniOverridesCache = { removedBase: new Set(removedBase), custom };
  _uniOverridesAt = now;
  return _uniOverridesCache;
}

/** Test hook — clear the overrides cache between cases. */
export function __clearBoardUniverseOverridesForTests() {
  _uniOverridesCache = null;
  _uniOverridesAt = 0;
}
