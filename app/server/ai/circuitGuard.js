// ============================================================
// server/ai/circuitGuard.js — v11.1 GAP 2: CIRCUIT-LIMIT GUARD
// ------------------------------------------------------------
// THE GAP (India Intraday deep-analysis plan): NSE stocks trade
// inside daily price bands (2/5/10/20% depending on the scrip).
// Once a stock HITS its band it FREEZES there — no further trades
// until it releases. The desk's whole 220-symbol universe now scans
// far more small/mid-caps than the original 45-name base, and those
// circuit far more often. Two failure modes were unguarded:
//
//   1. ENTRY: chasing a LONG into an upper circuit (or a SHORT into
//      a lower circuit) is the classic retail trap — you get filled
//      right before the freeze and cannot manage the position at
//      all. Worse: at a FROZEN upper circuit, BUY orders literally
//      cannot fill (only sellers get filled) — the signal is
//      untradeable in the direction it proposes.
//   2. OPEN POSITION: a LONG drifting toward the LOWER circuit is
//      approaching a state where the EXIT SELL cannot execute — the
//      usual "tighten the stop" playbook is useless when the stock
//      is about to stop trading entirely. That needs an URGENT,
//      distinct alert (different from a normal SL-approach warning).
//
// DATA SOURCE: Groww's live-price payload carries the day's band
// natively (highPriceRange / lowPriceRange — the ±band on the
// previous close the broker enforces). It rides the SAME fetch the
// desk already makes per symbol — zero extra upstream calls.
//
// All functions PURE + env-tunable (AI_CIRCUIT_PROXIMITY_PCT /
// AI_CIRCUIT_PENALTY). Missing bands (crypto, feed gaps, indices)
// → null / inert — the guard never invents a band.
// ============================================================

/** Proximity threshold (% distance from the band that counts as "near"). */
export function circuitProximityPct() {
  const v = parseFloat(process.env.AI_CIRCUIT_PROXIMITY_PCT);
  return Number.isFinite(v) && v > 0 && v <= 20 ? v : 1.5;
}

/** Confidence penalty for a same-direction entry near the adverse band. */
export function circuitEntryPenalty() {
  const v = parseFloat(process.env.AI_CIRCUIT_PENALTY);
  return Number.isFinite(v) && v > 0 && v <= 60 ? v : 18;
}

/** At-band tolerance (bps of price) — "frozen at the circuit". */
const AT_BAND_BPS = 5;

/**
 * PURE: how close is `ltp` to the day's upper/lower circuit band?
 * Returns null when the band is unknown or the numbers don't sanity-
 * check (this is a GUARD — garbage data must disarm it, not arm it).
 */
export function circuitProximityOf(ltp, upper, lower) {
  const p = Number(ltp), up = Number(upper), lo = Number(lower);
  if (!(p > 0) || !(up > 0) || !(lo > 0) || !(up > lo)) return null;
  // Sanity: a real band brackets the previous close; the price must
  // live (roughly) inside it. A quote wildly outside = garbage feed.
  if (p < lo * 0.8 || p > up * 1.25) return null;
  const th = circuitProximityPct();
  const distUpperPct = ((up - p) / p) * 100; // % upside left before the upper freeze
  const distLowerPct = ((p - lo) / p) * 100; // % downside left before the lower freeze
  const atTolPct = (AT_BAND_BPS / 10000) * 100; // ~0.05%
  return {
    upper: up, lower: lo,
    distUpperPct: +distUpperPct.toFixed(2),
    distLowerPct: +distLowerPct.toFixed(2),
    nearUpper: distUpperPct <= th,
    nearLower: distLowerPct <= th,
    atUpper: distUpperPct <= atTolPct,
    atLower: distLowerPct <= atTolPct,
    thresholdPct: th,
  };
}

/**
 * PURE: same-direction ENTRY risk from the circuit band.
 * LONG near/at the UPPER circuit / SHORT near/at the LOWER circuit →
 * heavy confidence penalty + a distinct reason flag + target clamps
 * (a LONG target printed above the upper band can literally never
 * fill — price cannot exceed the band).
 * Opposite-direction entries are NOT penalized: fading a band is a
 * legitimate play and is actually the side that fills at a freeze
 * (at an upper circuit only SELLERS get filled).
 */
export function entryCircuitRisk(direction, ltp, upper, lower) {
  const prox = circuitProximityOf(ltp, upper, lower);
  const dir = String(direction || '').toUpperCase();
  if (!prox) return { risk: false, penalty: 0, reason: null, prox: null, clampLong: null, clampShort: null };
  const chasingUpper = dir === 'LONG' && (prox.nearUpper);
  const chasingLower = dir === 'SHORT' && (prox.nearLower);
  if (!chasingUpper && !chasingLower) {
    return { risk: false, penalty: 0, reason: null, prox, clampLong: null, clampShort: null };
  }
  const penalty = circuitEntryPenalty();
  const band = chasingUpper ? prox.upper : prox.lower;
  const dist = chasingUpper ? prox.distUpperPct : prox.distLowerPct;
  const side = chasingUpper ? 'upper' : 'lower';
  const at = chasingUpper ? prox.atUpper : prox.atLower;
  const reason = at
    ? `⚠ AT ${side} circuit ₹${band} — stock frozen, ${dir === 'LONG' ? 'buy' : 'sell'} fills unlikely`
    : `⚠ Near ${side} circuit — entry risk (band ₹${band}, ${dist.toFixed(1)}% away)`;
  return {
    risk: true,
    penalty,
    reason,
    prox,
    // targets beyond the band are physically unreachable — clamp them
    clampLong: chasingUpper ? { cap: prox.upper } : null,
    clampShort: chasingLower ? { floor: prox.lower } : null,
  };
}

/**
 * PURE: adverse-circuit risk for an OPEN position.
 * A LONG's adverse side is the LOWER circuit (exit sell stops
 * filling as price freezes down there); a SHORT's adverse side is
 * the UPPER circuit (exit buy queues behind the freeze). Returns
 * null when bands are unknown or the position side is unusable.
 */
export function adverseCircuitRisk(pos, quote) {
  const sideRaw = String(pos?.side || pos?.direction || '').toUpperCase();
  const long = sideRaw === 'BUY' || sideRaw === 'LONG';
  const short = sideRaw === 'SELL' || sideRaw === 'SHORT';
  const prox = circuitProximityOf(quote?.price ?? quote?.ltp, quote?.upperCircuit, quote?.lowerCircuit);
  if (!prox || (!long && !short)) return null;
  const adverseBand = long ? 'LOWER' : 'UPPER';
  const distPct = long ? prox.distLowerPct : prox.distUpperPct;
  const near = long ? prox.nearLower : prox.nearUpper;
  const frozen = long ? prox.atLower : prox.atUpper;
  const bandPx = long ? prox.lower : prox.upper;
  if (!near) return { adverse: false, band: adverseBand, distPct, frozen: false, upper: prox.upper, lower: prox.lower, note: null };
  const note = frozen
    ? `FROZEN AT ${adverseBand} circuit ₹${bandPx} — trading band se bahar nahi ja sakta; exit ${long ? 'SELL' : 'BUY'} fill hone ka chance kam. Usual SL playbook yahan kaam nahi karta — jo nikal sake abhi nikalo, warna reopening gap ka risk.`
    : `${adverseBand} circuit ₹${bandPx} sirf ${distPct.toFixed(1)}% door hai — exit liquidity sook rahi hai. Freeze hone se PEHLE nikalna better hai (SL tightening yahan kaam nahi karti).`;
  return { adverse: true, band: adverseBand, distPct, frozen, upper: prox.upper, lower: prox.lower, note };
}

/** Introspection for status/debug surfaces. */
export function circuitGuardConfig() {
  return {
    proximityPct: circuitProximityPct(),
    entryPenalty: circuitEntryPenalty(),
    source: 'groww highPriceRange/lowPriceRange (same quote fetch)',
    note: 'Circuit guard: same-direction entry near band → penalty + flag + target clamp; open position near adverse band → urgent CIRCUIT_RISK alert. Bands unknown → guard inert.',
  };
}
