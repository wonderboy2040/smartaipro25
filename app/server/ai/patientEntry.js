// ============================================================
// server/ai/patientEntry.js — v10.15 GAP 3: PATIENT ENTRY
// ------------------------------------------------------------
// THE GAP (superintelligence upgrade plan): entry is a single
// instantaneous decision — when the signal fires, the order goes.
// A superintelligent desk distinguishes "this setup is valid" from
// "this is the right PRICE to get it", and waits for a retest rather
// than chasing an extended candle.
//
//   • EXTENDED (price > 1.5 ATR beyond the signal's anchor) → a
//     RESTING limit at a defined pullback level with a validity
//     window (15m crypto / 10m India). Fills → better entry. Window
//     expires unfilled → cancel + journal `missed-pullback` (a GOOD
//     outcome — it means you didn't chase).
//   • AT-ANCHOR (price near the anchor) → enter immediately, exactly
//     as today (zero behavior change).
//
// The pullback level uses the order-flow depth module (already
// shipped): the limit sits just above a detected BID WALL for longs
// (where support genuinely sits), just below an ASK WALL for shorts —
// never an arbitrary ATR fraction. No readable depth → the signal's
// own anchor (plan.entry) — the natural patient level.
//
// Both paths journal (ENTRY_MODE markers) so the weekly review can
// answer "did patient entries beat immediate entries?" — the feature
// is self-validating, not a matter of belief.
//
// Flag: AI_ENABLE_PATIENT_ENTRY or the agent knob (default OFF —
// ship-last per the plan, A/B-able against the immediate baseline).
// ============================================================

/** Feature flag (env OR agent knob). OFF by default. */
export function patientEntryEnabled(cfg) {
  if (['true', '1', 'on', 'yes'].includes(String(process.env.AI_ENABLE_PATIENT_ENTRY || '').trim().toLowerCase())) return true;
  return cfg?.patientEntry === true;
}

/** The resting-order validity window (minutes). Crypto 15 / India 10. */
export function patientWindowMin(desk) {
  const n = Number(process.env.AI_PATIENT_WINDOW_MIN);
  if (Number.isFinite(n) && n > 0 && n <= 60) return n;
  return String(desk || '').toUpperCase() === 'INDIA' ? 10 : 15;
}

/**
 * Classify one entry: is the price AT the signal's anchor, or has it
// run EXTENDED beyond it? PURE.
 * @param {{ ltp:number, entry:number, atr:number }} a  the live price,
 *   the signal's plan entry (the anchor), and the ATR in PRICE units
 *   (plan.atrUsed — same units as entry/ltp)
 * @returns {'at-anchor'|'extended'} 'at-anchor' on any missing data
 *   (the immediate path is the honest default — never block an entry
 *   because the extension read was unavailable).
 */
export function classifyEntry({ ltp, entry, atr } = {}) {
  const p = Number(ltp);
  const e = Number(entry);
  const a = Number(atr);
  if (!(p > 0) || !(e > 0) || !(a > 0)) return 'at-anchor';
  return Math.abs(p - e) > 1.5 * a ? 'extended' : 'at-anchor';
}

/**
 * The resting limit level for an extended entry. PURE.
 * LONG  → just ABOVE the highest reachable bid wall (support), else anchor
 * SHORT → just BELOW the lowest reachable ask wall (resistance), else anchor
 * @param {{ side:string, ltp:number, entry:number, depth?:object }} a
 *   depth = a readDepth() result (bidWalls/askWalls with raw prices)
 * @returns {{ level:number, basis:'bid-wall'|'ask-wall'|'anchor' }}
 */
export function pullbackLevelFor({ side, ltp, entry, depth } = {}) {
  const isLong = !/SHORT|SELL/i.test(String(side || ''));
  const p = Number(ltp);
  const anchor = Number(entry);
  const walls = isLong ? depth?.bidWalls : depth?.askWalls;
  if (p > 0 && Array.isArray(walls) && walls.length > 0) {
    // reachable walls: LONG → below the live price (within 5%); SHORT → above
    const reach = walls
      .map(w => Number(w.price))
      .filter(v => v > 0 && (isLong ? v < p && v > p * 0.95 : v > p && v < p * 1.05))
      .sort((a, b) => (isLong ? b - a : a - b)); // LONG: highest wall below; SHORT: lowest above
    if (reach.length > 0) {
      const wall = reach[0];
      // just inside the wall: LONG limit a hair ABOVE it (queue priority
      // at the support), SHORT a hair BELOW
      const level = isLong ? wall * 1.0005 : wall * 0.9995;
      return { level: Math.round(level * 1e6) / 1e6, basis: isLong ? 'bid-wall' : 'ask-wall' };
    }
  }
  return { level: anchor > 0 ? anchor : p, basis: 'anchor' };
}

/** Was the resting level touched? PURE (the fill condition). */
export function levelTouched({ side, level, ltp } = {}) {
  const l = Number(level);
  const p = Number(ltp);
  if (!(l > 0) || !(p > 0)) return false;
  const isLong = !/SHORT|SELL/i.test(String(side || ''));
  return isLong ? p <= l : p >= l;
}

/**
 * One sweep of the pending patient order. PURE decision core — the
 * agents call this each tick with the freshest LTP they have.
 * @param {{ pending:{symbol,side,level,expiresAt}, ltp:number, now:number }} a
 * @returns {{action:'fill'|'wait'|'expire'}}
 *   fill   → the level was touched — execute at market (≈ the limit)
 *   wait   → window still open, level untouched
 *   expire → window over unfilled — cancel + journal missed-pullback
 */
export function patientPendingAction({ pending, ltp, now = Date.now() } = {}) {
  if (!pending || !(Number(pending.level) > 0)) return { action: 'expire' };
  if (Number(now) >= Number(pending.expiresAt)) return { action: 'expire' };
  if (levelTouched({ side: pending.side, level: pending.level, ltp })) return { action: 'fill' };
  return { action: 'wait' };
}
