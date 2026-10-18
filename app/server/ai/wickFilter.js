// ============================================================
// server/ai/wickFilter.js — v10.6 CROSS-EXCHANGE PRICE VALIDATION
// ------------------------------------------------------------
// THE GAP (Pro Upgrade #3): signals and paper/live fills trusted
// CoinDCX's own feed as the SOLE source of truth. A single bad
// tick / thin-liquidity flash wick on one venue could trigger a
// false stop-out or a false entry signal — nobody was checking.
//
// THE FIX: a lightweight SECONDARY price check against Binance's
// public feed (free, no key — spot /api/v3 + futures /fapi/v1).
// Binance is a VALIDATOR here, never a trading feed:
//
//   before a tick may drive a signal vote or an SL/TP trigger:
//     deviation = |coindcxPrice − binanceRef| / binanceRef
//     • deviation ≤ threshold            → ACCEPT (act normally)
//     • deviation > threshold, FRESH     → SUPPRESS (do NOT act —
//       the move may be a wick; wait for it to either revert or
//       prove itself sustained)
//     • price back within threshold       → the episode CLOSES as a
//       WICK → the suppressing caller journals `WICK_SUPPRESSED`
//       (auditable, never silently dropped)
//     • deviation persists > REVERT_WINDOW → ACCEPT with
//       `sustained` (it's a real move / real venue divergence —
//       refusing to act forever on a sustained gap would be worse)
//
// CRYPTO desk prices are INR; the validator normalizes through
// the live USDTINR rate from the SAME CoinDCX ticker book the
// desk already uses (no extra upstream call). FUTURES desk is
// natively USDT → compared 1:1 against Binance perps.
//
// Honesty rules (this codebase's standing philosophy):
//   • Binance unreachable → filter PASSES THROUGH (a validator
//     outage must never freeze trading; negative-cached 5 min so
//     the board doesn't pay a timeout every run)
//   • kill switch: AI_DISABLE_WICK_FILTER=1 → ACCEPT everything
//   • state is per (market, base) — episodes never leak across
//     symbols, and a suppressed symbol only suppresses ACTIONS,
//     never the display stream.
// ============================================================
import { fetchCoinDcxTickers } from '../cryptoStream.js';

const SPOT_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price';
const FUT_PRICE_URL = 'https://fapi.binance.com/fapi/v1/ticker/price';

const REF_TTL_MS = 3000;              // reference book freshness (fast tier)
const REF_NEG_TTL_MS = 5 * 60_000;    // validator down → retry at most 12/h
const REVERT_WINDOW_MS = 15_000;      // "reverts within N seconds"

// majors: deep books on both venues — a 0.5% cross-venue gap is
// already suspicious. Illiquid alts legitimately drift wider.
const MAJOR_BASES = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'TRX', 'MATIC', 'LTC', 'NEAR', 'APT', 'ARB', 'OP']);

const _ref = {
  spot: { at: 0, map: null, inflight: null, downUntil: 0 },
  fut: { at: 0, map: null, inflight: null, downUntil: 0 },
};
const _usdtInr = { at: 0, val: null };

// per (market|base) episode state:
//   { suspectAt, devPct, refPrice, price }  — null = clean
const _state = new Map();
// stats ring for the status view (never grows unbounded)
const _stats = { accepted: 0, suppressed: 0, wickEpisodes: 0, sustained: 0, lastAt: null, lastBases: [] };

const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

export function wickFilterEnabled() {
  return !['1', 'true', 'on', 'yes'].includes(String(process.env.AI_DISABLE_WICK_FILTER || '').trim().toLowerCase());
}

/** Deviation threshold for a base: majors tight, alts wide. */
export function wickThresholdPct(base) {
  const major = Number(process.env.AI_WICK_THRESHOLD_PCT);
  const alt = Number(process.env.AI_WICK_ALT_THRESHOLD_PCT);
  if (MAJOR_BASES.has(String(base || '').toUpperCase())) {
    return Number.isFinite(major) && major > 0 ? major : 0.5;
  }
  return Number.isFinite(alt) && alt > 0 ? alt : 1.5;
}

export const REVERT_WINDOW = REVERT_WINDOW_MS;

// ---------------- reference books (Binance public, no key) ----------------
async function _fetchRefBook(which) {
  const slot = which === 'fut' ? _ref.fut : _ref.spot;
  if (slot.map && Date.now() - slot.at < REF_TTL_MS) return slot.map;
  // v10.6.1 FIX: the negative-cache was SET on failure but never
  // CHECKED — a Binance outage made every board/watcher pass pay a
  // fresh 4s timeout instead of the designed 1-retry-per-5-min. An
  // outage stays a pass-through (ACCEPT); it must not become a tax.
  if (Date.now() < slot.downUntil) return null;
  if (slot.inflight) return slot.inflight;
  slot.inflight = (async () => {
    try {
      const r = await fetch(which === 'fut' ? FUT_PRICE_URL : SPOT_PRICE_URL, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Mozilla/5.0 (SmartAI wick-validator)' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty book');
      const map = new Map();
      for (const row of rows) {
        // spot: "BTCUSDT" → BTC; futures: same shape on fapi
        const s = String(row?.symbol || '');
        if (!s.endsWith('USDT')) continue;
        const p = num(row?.price);
        if (!(p > 0)) continue;
        map.set(s.slice(0, -4), p);
      }
      if (map.size === 0) throw new Error('no USDT rows');
      slot.map = map;
      slot.at = Date.now();
      slot.downUntil = 0;
      return map;
    } catch (e) {
      // validator down → negative-cache (pass-through for the TTL window)
      slot.downUntil = Date.now() + REF_NEG_TTL_MS;
      slot.map = null;
      slot.at = Date.now();
      return null;
    } finally {
      slot.inflight = null;
    }
  })();
  return slot.inflight;
}

/** USDT→INR rate from the shared CoinDCX ticker cache (USDTINR pair). */
async function _usdtInrRate() {
  if (_usdtInr.val && Date.now() - _usdtInr.at < 10_000) return _usdtInr.val;
  try {
    const tickers = await fetchCoinDcxTickers();
    const row = (Array.isArray(tickers) ? tickers : []).find(t => t?.market === 'USDTINR');
    const p = num(row?.last_price);
    if (p > 0) { _usdtInr.val = p; _usdtInr.at = Date.now(); return p; }
  } catch { /* honest degrade */ }
  return _usdtInr.val; // stale rate beats none; null → no reference
}

// ---------------- the state machine (PURE, testable) ----------------
/**
 * ONE tick assessment. Pure w.r.t. the module state map (reset via
 * __resetWickForTests). `refPrice` must already be in the SAME
 * currency domain as `price` (caller normalizes).
 *
 * @returns {{action:'ACCEPT'|'SUPPRESS', deviationPct:number|null,
 *            episode:'wick'|'sustained'|null, firstSeen:number|null,
 *            threshold:number}}
 */
export function assessTick({ market, base, price, refPrice, now = Date.now() }) {
  const key = `${String(market || '').toUpperCase()}|${String(base || '').toUpperCase()}`;
  const threshold = wickThresholdPct(base);
  const p = num(price);
  const ref = num(refPrice);
  const prev = _state.get(key) || null;

  // no reference / unusable numbers → pass-through (never block on
  // validator blindness)
  if (!(p > 0) || !(ref > 0)) {
    // if we were mid-episode and the reference vanished, close it as
    // resolved-without-verdict — suppress lifts either way
    if (prev) _state.delete(key);
    return { action: 'ACCEPT', deviationPct: null, episode: null, firstSeen: null, threshold };
  }

  const deviationPct = Math.abs(p - ref) / ref * 100;

  if (deviationPct <= threshold) {
    // back in line. Were we suppressing?
    if (prev) {
      _state.delete(key);
      if (prev.sustainedAt) {
        // v10.6.1: the gap closed AFTER the episode had already been
        // accepted as sustained — we ACTED on those ticks, so this is
        // NOT a wick (no WICK_SUPPRESSED journal). Clean close.
        _stats.accepted++;
        _stats.lastAt = now;
        return { action: 'ACCEPT', deviationPct: r4(deviationPct), episode: null, firstSeen: null, threshold };
      }
      _stats.wickEpisodes++;
      _stats.accepted++;
      _stats.lastAt = now;
      return { action: 'ACCEPT', deviationPct: r4(deviationPct), episode: 'wick', firstSeen: prev.suspectAt, threshold };
    }
    _stats.accepted++;
    return { action: 'ACCEPT', deviationPct: r4(deviationPct), episode: null, firstSeen: null, threshold };
  }

  // deviation > threshold
  if (!prev) {
    _state.set(key, { suspectAt: now, devPct: r4(deviationPct), refPrice: ref, price: p });
    _stats.suppressed++;
    _stats.lastAt = now;
    return { action: 'SUPPRESS', deviationPct: r4(deviationPct), episode: null, firstSeen: now, threshold };
  }

  // already suspect: fresh (< window) → keep suppressing; stale →
  // the gap is SUSTAINED (real move / real divergence) → accept.
  if (now - prev.suspectAt < REVERT_WINDOW_MS) {
    _stats.suppressed++;
    return { action: 'SUPPRESS', deviationPct: r4(deviationPct), episode: null, firstSeen: prev.suspectAt, threshold };
  }
  // v10.6.1 FIX: keep the state with a sustainedAt marker instead of
  // deleting it — otherwise the NEXT still-deviating tick opened a
  // fresh episode and re-suppressed for another 15s (SUPPRESS →
  // ACCEPT(1 tick) → SUPPRESS → …), making SL/TP checks erratic
  // exactly during a persistent real move. Once sustained, acceptance
  // HOLDS while the deviation stays; the state clears when price
  // returns within threshold.
  if (!prev.sustainedAt) {
    _state.set(key, { ...prev, sustainedAt: now });
    _stats.sustained++;
  }
  _stats.accepted++;
  _stats.lastAt = now;
  return { action: 'ACCEPT', deviationPct: r4(deviationPct), episode: 'sustained', firstSeen: prev.suspectAt, threshold };
}

// ---------------- the async wrapper (fetches + normalizes) ----------------
/**
 * Validate one live tick against the cross-venue reference.
 *
 * @param {object} a { market:'CRYPTO'|'FUTURES', base:'BTC', price:number }
 *   CRYPTO prices are INR (spot desk) — normalized via live USDTINR.
 *   FUTURES prices are USDT — compared 1:1 against Binance perps.
 * @returns the assessTick verdict; `refPrice`/`refSource` attached
 *   when a reference existed (the journal entry wants them).
 */
export async function validateTick({ market, base, price }) {
  const mkt = String(market || '').toUpperCase();
  const sym = String(base || '').toUpperCase();
  if (!wickFilterEnabled() || (mkt !== 'CRYPTO' && mkt !== 'FUTURES')) {
    return { action: 'ACCEPT', deviationPct: null, episode: null, firstSeen: null, threshold: null, refPrice: null, refSource: null };
  }
  const book = await _fetchRefBook(mkt === 'FUTURES' ? 'fut' : 'spot');
  if (!book) return { action: 'ACCEPT', deviationPct: null, episode: null, firstSeen: null, threshold: null, refPrice: null, refSource: null };
  const refUsdt = book.get(sym);
  if (!(refUsdt > 0)) {
    return { action: 'ACCEPT', deviationPct: null, episode: null, firstSeen: null, threshold: null, refPrice: null, refSource: null };
  }
  let refPrice = refUsdt;
  let refSource = mkt === 'FUTURES' ? 'binance-perp-usdt' : 'binance-spot-usdt';
  if (mkt === 'CRYPTO') {
    // INR desk: normalize the USDT reference into INR at the live rate
    const fx = await _usdtInrRate();
    if (!(fx > 0)) {
      return { action: 'ACCEPT', deviationPct: null, episode: null, firstSeen: null, threshold: null, refPrice: null, refSource: null };
    }
    refPrice = refUsdt * fx;
    refSource = `binance-spot × USDTINR ${r2(fx)}`;
  }
  const verdict = assessTick({ market: mkt, base: sym, price, refPrice });
  return { ...verdict, refPrice: r4(refPrice), refSource };
}

/**
 * Journal-entry shape for a closed wick episode (the CALLER holds the
 * journal lock and pushes it — this module never imports the journal,
 * avoiding a require cycle with the watchers).
 */
export function wickJournalEntry({ market, base, pair, verdict }) {
  const v = verdict || {};
  return {
    kind: 'WICK_SUPPRESSED',
    day: null, // caller stamps todayIST()
    pair: pair || null,
    market: String(market || '').toUpperCase(),
    reason: `wick_suppressed — ${base} deviated ${v.deviationPct != null ? v.deviationPct : '?'}% vs ${v.refSource || 'cross-venue ref'} and reverted within ${Math.round(REVERT_WINDOW_MS / 1000)}s; tick not acted on (no signal vote / no SL-TP trigger fired on the bad print)`,
    deviationPct: v.deviationPct ?? null,
    refPrice: v.refPrice ?? null,
    refSource: v.refSource ?? null,
    suppressSince: v.firstSeen ?? null,
  };
}

// ---------------- status view ----------------
export function wickFilterStatus() {
  return {
    enabled: wickFilterEnabled(),
    revertWindowSec: Math.round(REVERT_WINDOW_MS / 1000),
    majorThresholdPct: wickThresholdPct('BTC'),
    altThresholdPct: wickThresholdPct('RANDOMALT'),
    refBooks: {
      spot: _ref.spot.map ? { symbols: _ref.spot.map.size, ageSec: Math.round((Date.now() - _ref.spot.at) / 1000) } : null,
      futures: _ref.fut.map ? { symbols: _ref.fut.map.size, ageSec: Math.round((Date.now() - _ref.fut.at) / 1000) } : null,
    },
    // v10.6.1: sustained-accepted symbols are NOT suppressed — only
    // fresh-gap episodes are "currently suppressed".
    currentlySuppressed: [..._state.entries()].filter(([, v]) => !v.sustainedAt).map(([k, v]) => ({
      market: k.split('|')[0], base: k.split('|')[1],
      devPct: v.devPct, since: v.suspectAt,
    })),
    stats: { ..._stats, lastBases: undefined },
  };
}

// ---------------- test hooks ----------------
export const __testables = {
  _state, _stats, _ref,
  __resetWickForTests() {
    _state.clear();
    _stats.accepted = 0; _stats.suppressed = 0; _stats.wickEpisodes = 0; _stats.sustained = 0;
    _stats.lastAt = null; _stats.lastBases = [];
    _ref.spot = { at: 0, map: null, inflight: null, downUntil: 0 };
    _ref.fut = { at: 0, map: null, inflight: null, downUntil: 0 };
    _usdtInr.val = null; _usdtInr.at = 0;
  },
  __setRefBookForTests(which, map, ageMs = 0) {
    const slot = which === 'fut' ? _ref.fut : _ref.spot;
    slot.map = map instanceof Map ? map : new Map(Object.entries(map || {}));
    slot.at = Date.now() - ageMs;
    slot.downUntil = 0;
  },
  __setUsdtInrForTests(rate) { _usdtInr.val = rate; _usdtInr.at = Date.now(); },
};
