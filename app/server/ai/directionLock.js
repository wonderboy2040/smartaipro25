// ============================================================
// server/ai/directionLock.js — v21.24.0 CROSS-ENGINE
// PER-SYMBOL DIRECTION LOCK (audit/direction-guards Phase 2, item 1)
// ------------------------------------------------------------
// PROBLEM (audit Section 2, Engine map): Auto-Agent (Engine A/C),
// PRO AUTO (Engine D) aur MTF Auto-Link (Engine E) alag-alag direction
// engines follow karte hain — koi global "one coin, one direction" lock
// nahi tha. Dono engines ek hi coin par OPPOSITE side trades khol
// sakte the.
//
// YE MODULE: jab KOI BHI engine trade kholta hai, {symbol → side, at,
// source} stamp hota hai. Dusra engine usi symbol par OPPOSITE side ki
// entry `flipReentryBlockMin` (default 240m = 4h, agent.js ke
// flipReentryBlockMin jaisa) window ke liye BLOCK karta hai.
//
// PURITY CONTRACT: in-memory Map (process-wide shared), koi fs nahi —
// restart pe locks reset (fresh session = fresh locks; open positions
// ke liye engines apne book se already-open guard use karte hain).
// Tests `__resetDirectionLockForTests()` se state clear kar sakte hain
// (mtfAutoLink ka `__resetMtfAutoForTests` bhi ye call karta hai).
// ============================================================

/** market → domain normalization (same underlying coin = same lock domain). */
function domainOf(market) {
  const m = String(market || '').toUpperCase();
  if (m === 'INDIA') return 'INDIA';
  if (m === 'GLOBALFUTURES' || m === 'EQUITY_SIM') return 'GLOBALFUTURES';
  return 'CRYPTO'; // CRYPTO | FUTURES | METALS — USDT-perp domain
}

/** symbol normalization: B-BTC_USDT / BTCUSDT / SOL-USDT / btc → BTC. */
function normSym(symbol) {
  return String(symbol || '').toUpperCase().trim()
    .replace(/^B-/, '')
    .replace(/[._-](USDT|USDC|INR|USD|PERP)$/i, '')
    .replace(/(USDT|USDC|INR)$/i, '');
}

const DEFAULT_BLOCK_MIN = 240; // 4h — agent.js flipReentryBlockMin parity
const LOCKS = new Map();       // `${domain}:${sym}` → { side, at, source, domain, symbol }

const keyOf = (symbol, market) => `${domainOf(market)}:${normSym(symbol)}`;

/**
 * Kisi bhi engine ke trade-open ke baad call karo — symbol ki side lock
 * ho jayegi. Same-side re-entry allowed (refresh timestamp); OPPOSITE
 * side `blockMin` ke liye blocked.
 */
export function lockDirection({ symbol, market, side, source = 'unknown', blockMin = DEFAULT_BLOCK_MIN, now = Date.now() } = {}) {
  const sideUp = String(side || '').toUpperCase();
  if (sideUp !== 'LONG' && sideUp !== 'SHORT') return null;
  const key = keyOf(symbol, market);
  const prev = LOCKS.get(key);
  const rec = { side: sideUp, at: now, source, domain: domainOf(market), symbol: normSym(symbol), blockMin };
  // Agar purana lock opposite side ka tha aur abhi active hai — naya lock
  // replace kar dena sahi hai (naye signal ne flip maara), par tabhi jab
  // caller flip-side entry OPEN kar raha ho — ye function trade-open ke
  // BAAD call hota hai, isliye overwrite hi semantics hai.
  LOCKS.set(key, rec);
  return { ...rec, replaced: prev ? { side: prev.side, at: prev.at, source: prev.source } : null };
}

/**
 * Entry se PEHLE call karo. Opposite-side lock active hai → allowed:false.
 * @returns {{allowed: boolean, reason?: string, lockSide?: string, lockAgeMin?: number,
 *            remainingMin?: number, source?: string, key?: string}}
 */
export function directionLockGate({ symbol, market, side, blockMin = null, now = Date.now() } = {}) {
  const sideUp = String(side || '').toUpperCase();
  if (sideUp !== 'LONG' && sideUp !== 'SHORT') return { allowed: true };
  const key = keyOf(symbol, market);
  const rec = LOCKS.get(key);
  if (!rec || rec.side === sideUp) return { allowed: true, key };
  const windowMs = Math.max(1, Number(blockMin ?? rec.blockMin ?? DEFAULT_BLOCK_MIN)) * 60_000;
  const ageMs = now - rec.at;
  if (ageMs >= windowMs) return { allowed: true, key }; // expired
  const remainingMin = Math.ceil((windowMs - ageMs) / 60_000);
  return {
    allowed: false,
    key,
    lockSide: rec.side,
    lockAgeMin: Math.floor(ageMs / 60_000),
    remainingMin,
    source: rec.source,
    reason: `direction lock: ${rec.side} open ${Math.floor(ageMs / 60_000)}m pehle (${rec.source}) — ${sideUp} entry ${remainingMin}m ke liye blocked (cross-engine one-coin-one-direction)`,
  };
}

/** Ops/test view — active locks (expired purged). */
export function directionLockSnapshot(now = Date.now()) {
  const out = [];
  for (const [key, rec] of LOCKS) {
    const windowMs = Math.max(1, Number(rec.blockMin || DEFAULT_BLOCK_MIN)) * 60_000;
    if (now - rec.at >= windowMs) { LOCKS.delete(key); continue; }
    out.push({ key, ...rec, remainingMin: Math.ceil((windowMs - (now - rec.at)) / 60_000) });
  }
  return out;
}

/** Manual unlock (kill-switch / user override). */
export function clearDirectionLock(symbol, market) {
  return LOCKS.delete(keyOf(symbol, market));
}

export const DIRECTION_LOCK_DEFAULT_BLOCK_MIN = DEFAULT_BLOCK_MIN;

/** Tests — clear all locks. */
export function __resetDirectionLockForTests() { LOCKS.clear(); }
