// ============================================================
// server/ai/optionsScan.js — v10.17 OPTIONS SCANNER
// ------------------------------------------------------------
// THE GAP: the options desk served ONE underlying at a time
// (OptionsDeskPanel selector) and the option-signal cards covered
// only NIFTY + SENSEX. There was no way to see, in ONE glance,
// where the whole F&O options market was leaning today — which
// underlying has the strongest PE-writing support, which chain is
// coiling for a gamma-flip move, where credit is richest.
//
// THE SCAN (plan Section 1 — "options scanner"):
//   • underlyings = 3 indices (NIFTY · SENSEX · BANKNIFTY) + the top
//     stock-option names by NSE turnover (from the SAME full-universe
//     discovery the Signal Board now rides — one truth, no new feed)
//   • each underlying loads its REAL NSE chain via the existing
//     optionsDesk machinery (live premiums + OI + IV) with the honest
//     Black-Scholes model-chain fallback, clearly source-tagged
//   • every row gets a DETERMINISTIC direction read (OI lean · PCR ·
//     max-pain position · gamma-flip side), a GEX pin/flip zone and
//     an expected-move band — zero LLM calls, fully explainable
//   • rows ranked by a transparent scan score (conviction × flow ×
//     movement potential × data quality)
//
// Cadence: 90s cache + single-flight (chains are the expensive bit);
// NSE politeness: underlyings fetched in bounded groups of 4 with a
// 350ms gap between groups — never a stampede.
// ============================================================
import { getOptionsDesk, expiryLabel } from './optionsDesk.js';
import { discoverNSEFullUniverse } from './indiaUniverse.js';

const INDEX_UNDERLYINGS = ['NIFTY', 'SENSEX', 'BANKNIFTY'];
/** Stock-option underlyings considered (F&O names with liquid chains). */
const STOCK_OPTION_SEED = new Set([
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK',
  'INFY', 'TCS', 'TATAMOTORS', 'TATASTEEL', 'ADANIENT', 'BAJFINANCE',
  'NTPC', 'ONGC', 'HINDALCO', 'JSWSTEEL', 'COALINDIA', 'SUNPHARMA',
  'DLF', 'LT', 'TITAN', 'SBILIFE', 'MARUTI', 'BHARTIARTL', 'HCLTECH',
  'WIPRO', 'TECHM', 'ULTRACEMCO', 'TRENT', 'BEL', 'HAL', 'IREDA',
  'ZOMATO', 'ETERNAL', 'DIXON', 'VOLTAS', 'INDIGO', 'LICI', 'CHOLAFIN',
  'IRFC', 'RVNL', 'PNB', 'INDUSINDBK', 'HFCL', 'JIOFIN', 'ZEEL', 'IDFCFIRSTB',
]);
const DEFAULT_STOCKS = Math.max(0, Math.min(10, parseInt(process.env.AI_OPTIONS_SCAN_STOCKS, 10) || 6));
const GROUP_SIZE = 4;
const GROUP_GAP_MS = 350;
const CACHE_MS = 90 * 1000;

const r1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ---------------- PURE core (test-locked) ----------------

/**
 * PURE: pick the top-N stock option underlyings from the discovered
 * turnover-ranked universe, intersected with the F&O seed. Discovery
 * rows may be the seed-fallback shape (ltp 0) — order is still the
 * curated liquidity order, which is the best offline approximation.
 */
export function pickStockUnderlyings(discoveredRows, n = DEFAULT_STOCKS) {
  const out = [];
  for (const row of Array.isArray(discoveredRows) ? discoveredRows : []) {
    const sym = String(row?.symbol || '').trim().toUpperCase();
    if (STOCK_OPTION_SEED.has(sym) && !out.includes(sym)) out.push(sym);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * PURE: deterministic direction read off the desk analytics.
 * Returns { pts, direction, why } — pts is a signed conviction tally:
 *   +1 puts being written (support)   · −1 calls being written (cap)
 *   +1 PCR > 1.2 (put-heavy = support floor) · −1 PCR < 0.7 (call chase)
 *   +1 spot above max-pain · −1 below
 *   +1 spot above gamma flip (positive-gamma zone) · −1 below
 */
export function directionRead(desk) {
  const a = desk?.analytics || {};
  const pts = [];
  const oiLean = a.flow?.oiLean;
  if (typeof oiLean === 'number' && Number.isFinite(oiLean)) {
    if (oiLean <= -0.15) pts.push(['PE writing — support ban raha hai', 1]);
    else if (oiLean >= 0.15) pts.push(['CE writing — upar cap lag raha hai', -1]);
  }
  const pcr = a.pcr;
  if (typeof pcr === 'number' && Number.isFinite(pcr)) {
    if (pcr >= 1.2) pts.push(['PCR ' + r2(pcr) + ' — put-heavy book (support floor)', 1]);
    else if (pcr <= 0.7) pts.push(['PCR ' + r2(pcr) + ' — call-heavy book (top pressure)', -1]);
  }
  if (typeof a.maxPain === 'number' && desk?.spot > 0 && a.maxPain > 0) {
    const off = (desk.spot - a.maxPain) / a.maxPain;
    if (off >= 0.005) pts.push(['spot max-pain ke upar — writers ko upar khinchne ka motive', 1]);
    else if (off <= -0.005) pts.push(['spot max-pain ke neeche — writers ko neeche khinchne ka motive', -1]);
  }
  const flip = a.gex?.gammaFlip;
  if (typeof flip === 'number' && desk?.spot > 0 && flip > 0) {
    const off = (desk.spot - flip) / flip;
    if (off >= 0.002) pts.push(['positive-GEX zone (gamma flip ke upar) — dealers move damp karte hain', 1]);
    else if (off <= -0.002) pts.push(['negative-GEX zone (gamma flip ke neeche) — move accelerate ho sakta hai', -1]);
  }
  const total = pts.reduce((s, [, v]) => s + v, 0);
  const direction = total >= 2 ? 'BULLISH' : total <= -2 ? 'BEARISH' : 'NEUTRAL';
  return { pts: total, direction, why: pts.map(([w]) => w) };
}

/**
 * PURE: transparent scan score (0-100-ish, ranking only).
 *   conviction (|direction pts| × 8) + flow (|oiSkew| × 25, cap 20)
 *   + movement potential (expected-move % × 5, cap 15)
 *   + data quality (+5 live NSE chain) − staleness penalty (dte > 8)
 */
export function scanScoreOf(row) {
  let s = 0;
  s += Math.min(32, Math.abs(row?.directionPts || 0) * 8);
  if (typeof row?.oiSkew === 'number' && Number.isFinite(row.oiSkew)) {
    s += Math.min(20, Math.abs(row.oiSkew) * 25);
  }
  const em = row?.expectedMovePct;
  if (typeof em === 'number' && Number.isFinite(em)) s += Math.min(15, em * 5);
  // v11.1: live-chain bonus covers BOTH exchanges ('nse' | 'bse').
  if (row?.source === 'nse' || row?.source === 'bse') s += 5;
  if ((row?.dte ?? 0) > 8) s -= 5;
  return Math.round(s);
}

/**
 * PURE: one scan row from a loaded options desk.
 * kind: 'index' | 'stock'. Degrades honestly when the desk is a
 * bs-model chain (no OI → direction from IV/skew only, tagged).
 */
export function optionScanRow(desk, kind) {
  if (!desk?.ok) {
    return {
      symbol: desk?.symbol || '?', kind, ok: false,
      reason: desk?.reason || 'chain unavailable',
    };
  }
  const a = desk.analytics || {};
  const dir = directionRead(desk);
  const gex = a.gex || null;
  const row = {
    symbol: desk.symbol,
    kind,
    ok: true,
    spot: desk.spot,
    changePct: desk.spotChangePct ?? null,
    dte: desk.dte,
    expiry: desk.expiry,
    expiryLabel: expiryLabel(desk.expiry),
    source: desk.source, // 'nse' | 'bse' (live) | 'bs-model-*' (honest model)
    synthetic: !['nse', 'bse'].includes(desk.source),
    lotSize: desk.lotSize || 1,
    // analytics surface (all null-safe)
    atmIV: a.atmIV ?? null,
    pcr: a.pcr ?? null,
    maxPain: a.maxPain ?? null,
    oiSkew: a.oiSkew ?? null,
    ivPercentile: a.ivPercentile ?? null,
    skewValue: a.skew?.value ?? null,
    skewRead: a.skew?.read ?? null,
    flowRead: a.flow?.read ?? null,
    oiLean: a.flow?.oiLean ?? null,
    callPutVolRatio: a.flow?.callPutVolRatio ?? null,
    expectedMovePct: gex?.expectedMove?.pct ?? null,
    expectedMoveBand: gex?.expectedMove
      ? { low: gex.expectedMove.low, high: gex.expectedMove.high }
      : null,
    // GEX pin/flip zone
    gammaFlip: gex?.gammaFlip ?? null,
    callWall: gex?.callWall ?? null,
    putWall: gex?.putWall ?? null,
    totalNetGex: gex?.totalNetGex ?? null,
    gexRegimeNote: gex?.regimeNote ?? null,
    // deterministic direction + score
    directionPts: dir.pts,
    direction: dir.direction,
    directionWhy: dir.why,
  };
  row.scanScore = scanScoreOf(row);
  row.verdict = buildVerdict(row);
  return row;
}

/** PURE: the one-line Hinglish read the scanner UI shows per row. */
export function buildVerdict(row) {
  if (!row?.ok) return row?.reason || 'chain unavailable';
  const bits = [];
  if (row.direction === 'BULLISH') bits.push('🟢 PE-writing/support read');
  else if (row.direction === 'BEARISH') bits.push('🔴 CE-writing/pressure read');
  else bits.push('⚪ balanced chain');
  if (row.atmIV != null) bits.push(`ATM IV ${r1(row.atmIV)}%`);
  if (row.expectedMovePct != null) bits.push(`expected move ±${r1(row.expectedMovePct)}%`);
  if (row.gammaFlip != null) bits.push(`gamma flip ${row.gammaFlip}`);
  if (row.dte === 0) bits.push('⚠ expiry-day theta');
  return bits.join(' · ');
}

// ---------------- scan execution ----------------

let _cache = { at: 0, data: null };
let _inflight = null;

async function _loadDeskSafe(sym) {
  try {
    const d = await getOptionsDesk(sym);
    return d;
  } catch (e) {
    return { ok: false, symbol: sym, reason: e?.message || 'failed' };
  }
}

/**
 * The options scan: indices + top stock underlyings, each mapped to
 * ONE deterministic ranked row. 90s cache, single-flight, honest
 * per-row degradation. Underlyings fetched in bounded groups of 4
 * with a 350ms gap (NSE politeness — never a burst).
 */
export async function scanOptionsUniverse(opts = {}) {
  if (!opts.force && _cache.data && Date.now() - _cache.at < CACHE_MS) {
    return _cache.data;
  }
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const discovered = await discoverNSEFullUniverse();
      const stocks = pickStockUnderlyings(discovered.rows, DEFAULT_STOCKS);
      const underlyings = [
        ...INDEX_UNDERLYINGS.map(s => ({ s, kind: 'index' })),
        ...stocks.map(s => ({ s, kind: 'stock' })),
      ];

      const rows = [];
      for (let i = 0; i < underlyings.length; i += GROUP_SIZE) {
        const group = underlyings.slice(i, i + GROUP_SIZE);
        const desks = await Promise.all(group.map(u => _loadDeskSafe(u.s)));
        group.forEach((u, k) => rows.push(optionScanRow(desks[k], u.kind)));
        if (i + GROUP_SIZE < underlyings.length) {
          await new Promise(r => setTimeout(r, GROUP_GAP_MS));
        }
      }

      const live = rows.filter(r => r.ok && (r.source === 'nse' || r.source === 'bse'));
      const model = rows.filter(r => r.ok && r.source !== 'nse' && r.source !== 'bse');
      const failed = rows.filter(r => !r.ok);
      const ranked = rows.filter(r => r.ok).sort((a, b) => (b.scanScore ?? 0) - (a.scanScore ?? 0));
      const data = {
        ok: true,
        asOf: Date.now(),
        scanned: rows.length,
        liveCount: live.length,
        modelCount: model.length,
        failedCount: failed.length,
        rows: ranked,
        failed: failed.map(f => ({ symbol: f.symbol, reason: f.reason })),
        methodology: 'scan score = conviction (|direction pts|×8) + OI-flow (|oiSkew|×25, cap 20) + expected-move potential (±% ×5, cap 15) + live-chain bonus (+5) − far-expiry drag (dte>8 −5). Direction = deterministic tally: OI lean · PCR · max-pain side · gamma-flip side. Koi LLM nahi — poora read explainable hai.',
        note: live.length === 0 && model.length > 0
          ? 'NSE is server se reachable nahi — sab rows Black-Scholes model-chain par hain (premiums estimates, OI reads unavailable).'
          : model.length > 0
            ? `${model.length} row(s) model-chain par hain (live exchange chain unreachable for un) — tagged, ranked with the honesty penalty.`
            : null,
      };
      _cache = { at: Date.now(), data };
      return data;
    } catch (e) {
      return {
        ok: false, asOf: Date.now(), scanned: 0, rows: [], failed: [],
        error: `options scan failed: ${e?.message || e}`,
      };
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// ---------------- test hooks ----------------
export function __resetOptionsScanForTests() {
  _cache = { at: 0, data: null };
  _inflight = null;
}
export function __setScanCacheForTests(data) {
  _cache = { at: Date.now(), data };
}
export function __seedForTests() { return STOCK_OPTION_SEED; }
