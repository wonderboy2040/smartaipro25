// ============================================================
// server/mcp/settings.js — SERVER-side app settings (durable)
// ------------------------------------------------------------
// PROBLEM (user-reported, v6.1): the Portfolio tab's user-entered
// calibrations used to live ONLY in the browser:
//   • "Match App" (USA · INDMoney) — the implied FX rate was stored
//     in localStorage('usdAppRate'). Result: the value never reached
//     a second device, and clearing site cookies/caches silently
//     reverted the 🦅 USA Invested / Avg Price / P&L to the live-FX
//     numbers ("price alag bta raha hai").
//   • Crypto · CoinDCX "Set Basis" was already server-side but was
//     missing from durableBootRestoreAll (fixed separately in
//     durable.js).
//
// FIX: a tiny server-side key/value store, persisted to
// server/data/mcp-settings.json AND mirrored to the encrypted
// GitHub durable backup (durablePut) — same restart-safe pipeline
// the MCP credentials use. Every device that logs in with the PIN
// reads the SAME settings via GET /api/mcp/settings, so the
// calibration survives: multiple devices, cookie/cache wipes,
// browser changes, and Render redeploys.
//
// Validation is per-key and strict: unknown keys are rejected, and
// every known key sanitizes its value (or throws a 400-shaped
// error the routes layer maps to JSON).
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from './durable.js';

const SETTINGS_FILE = 'mcp-settings.json';

// ---- known keys + validators/sanitizers --------------------
// Each entry: (value) => sanitized value | null (clear), throws a
// { status: 400, code: 'BAD_REQUEST' } error on invalid input.
const KEYS = {
  // INDMoney's internal (buy-time) USD-INR rate implied by the app's
  // USD Invested. null = use the live FX rate (the legacy default).
  usdAppRate: (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 50 || n >= 150) {
      throw Object.assign(
        new Error('`usdAppRate` must be a number between 50 and 150 (INR per USD), or null to reset'),
        { status: 400, code: 'BAD_REQUEST' },
      );
    }
    return Math.round(n * 1e6) / 1e6;
  },
};

/** Current settings as a FLAT map ({ usdAppRate: 92.0006 }) — only
 *  keys with a non-null value are included. File shape is an
 *  implementation detail ({ settings: { key: { value, updatedAt } },
 *  updatedAt }) so the restore layer can compare freshness. */
export function getSettings() {
  const store = loadJSON(SETTINGS_FILE, { settings: {} }) || {};
  const out = {};
  for (const k of Object.keys(KEYS)) {
    const rec = store?.settings?.[k];
    if (rec && rec.value != null) out[k] = rec.value;
  }
  return out;
}

/** Set (or clear, when value == null) one setting. Validates strictly,
 *  stamps updatedAt, persists to disk + pushes the encrypted durable
 *  backup. Returns the new flat settings map. */
export function setSetting(key, value) {
  if (!Object.prototype.hasOwnProperty.call(KEYS, key) || typeof key !== 'string') {
    throw Object.assign(
      new Error(`Unknown setting key: ${String(key)} (known: ${Object.keys(KEYS).join(', ')})`),
      { status: 400, code: 'BAD_REQUEST' },
    );
  }
  const clean = KEYS[key](value);
  const store = loadJSON(SETTINGS_FILE, { settings: {} }) || {};
  if (!store.settings || typeof store.settings !== 'object') store.settings = {};
  if (clean == null) delete store.settings[key];
  else store.settings[key] = { value: clean, updatedAt: Date.now() };
  store.updatedAt = Date.now();
  saveJSON(SETTINGS_FILE, store);
  try { durablePut(SETTINGS_FILE, store); } catch { /* optional */ }
  return getSettings();
}
