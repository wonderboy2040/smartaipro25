// ============================================================
// server/ai/lib/usdinr.js — v20.2 SINGLE USDINR SOURCE
// ------------------------------------------------------------
// PROBLEM: cryptoStream.js and futures.js each kept a PRIVATE
// in-memory USDINR cache, both with a hard 84 fallback. A cold
// boot + Yahoo FX outage = 84 everywhere (at a real USDINR of ~88
// that is a ~5% error on every INR-twin conversion — P&L, equity,
// portfolio heat). Two caches also meant two upstream fetches that
// could disagree.
//
// FIX: ONE module. The live fetchers stay where they are (Yahoo
// chart / Yahoo quotes — no new upstream), but every successful
// read is RECORDED here and persisted to server/data/usdinr.json.
// Boot re-hydrates the last-known-good rate, so the flat 84 now
// appears ONLY when this process has never seen a live rate AND no
// disk stamp exists (first-ever boot, offline).
// ============================================================
import { loadJSON, saveJSON } from '../../intraday/store.js';

const FILE = 'usdinr.json';

let _disk = loadJSON(FILE, { rate: null, at: 0, source: null });
let _mem = Number(_disk?.rate) > 0 ? { rate: Number(_disk.rate), at: Number(_disk.at) || 0 } : null;

/** The best last-known rate (memory > disk), or null when never known. */
export function usdInrLastKnown() {
  if (_mem && Number(_mem.rate) > 0) return _mem.rate;
  if (Number(_disk?.rate) > 0) return Number(_disk.rate);
  return null;
}

/** Record a fresh live rate (40–150 sanity band). Persists to disk
 *  (skipped under NODE_ENV=test so vitest runs never pollute the
 *  production data dir — the in-memory mirror still updates). */
export function usdInrRecord(value, source = 'live') {
  const v = Number(value);
  if (!(v > 40 && v < 150)) return usdInrLastKnown();
  _mem = { rate: v, at: Date.now() };
  if (process.env.NODE_ENV !== 'test') {
    try { saveJSON(FILE, { rate: v, at: _mem.at, source }); } catch { /* disk optional (read-only fs) */ }
  }
  return v;
}

/** The fallback EVERY `|| 84` site should use: last-known-good first. */
export function usdInrFallback() {
  const lk = usdInrLastKnown();
  return lk != null ? lk : 84;
}

/** Test hook — hermetic reset. */
export function __resetUsdInrStoreForTests() {
  _mem = null;
  _disk = { rate: null, at: 0, source: null };
}
