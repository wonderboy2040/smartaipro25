// ============================================================
// server/ai/directionCertificate.js - v21.25.0 DIRECTION CERTIFICATE
// ------------------------------------------------------------
// ONE shared, pure contract for every LONG/SHORT decision in SmartAI Pro.
//
// USER SPEC (verbatim intent): "LONG/SHORT signal ka matlab wahi hona
// chahiye jo order side jaata hai - agar ulta ho raha hai to fix karo
// aur explicit direction certificate dikhao."
//
// DOCTRINE:
//   * LONG / BUY  -> LONG  -> exchange order side "buy"
//   * SHORT / SELL -> SHORT -> exchange order side "sell"
//   * Unknown / missing side -> NEVER silently LONG. Caller rejects/blocks.
//   * Exchange `activePos` sign is authoritative when present:
//       positive => LONG, negative => SHORT.
//     A declared side that disagrees is surfaced as a mismatch (hard block).
//   * Hard integrity (side valid + order mapped + geometry valid + no
//     activePos mismatch) is deliberately SEPARATE from PAKKA verification
//     (deep/trigger alignment, board/SVA/council conflicts). A certificate
//     can be structurally valid but still WAIT/CONFLICT - never the reverse.
//
// This module has no imports and no side effects so board, auto-link, live
// execution, UI and tests can all share exactly the same rules.
// ============================================================

export const DIRECTION_CERT_VERSION = 'direction-cert-v1';

const SIDE_ALIAS = Object.freeze({
  LONG: 'LONG',
  BUY: 'LONG',
  BULL: 'LONG',
  BULLISH: 'LONG',
  '+1': 'LONG',
  '1': 'LONG',
  SHORT: 'SHORT',
  SELL: 'SHORT',
  BEAR: 'SHORT',
  BEARISH: 'SHORT',
  '-1': 'SHORT',
});

const ORDER_ALIAS = Object.freeze({
  BUY: 'buy',
  LONG: 'buy',
  BULL: 'buy',
  BULLISH: 'buy',
  SELL: 'sell',
  SHORT: 'sell',
  BEAR: 'sell',
  BEARISH: 'sell',
});

const clean = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalize every supported side vocabulary to canonical LONG/SHORT.
 * Unknown values return null - this function NEVER defaults to LONG.
 * @param {unknown} value
 * @returns {'LONG'|'SHORT'|null}
 */
export function normalizeSide(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (value > 0) return 'LONG';
    if (value < 0) return 'SHORT';
    return null;
  }
  return SIDE_ALIAS[clean(value)] || null;
}

/**
 * Strict normalization with an explicit reason. Useful at execution
 * boundaries where a silent fallback is unacceptable.
 * @param {unknown} value
 * @returns {{ ok: boolean, side: 'LONG'|'SHORT'|null, raw: unknown, reason: string|null }}
 */
export function normalizeSideStrict(value) {
  const side = normalizeSide(value);
  return {
    ok: side != null,
    side,
    raw: value ?? null,
    reason: side ? null : `invalid direction side "${String(value ?? '')}" - LONG/BUY or SHORT/SELL required`,
  };
}

/** +1 for LONG/BUY, -1 for SHORT/SELL, null for unknown. */
export function sideSign(value) {
  const side = normalizeSide(value);
  return side === 'LONG' ? 1 : side === 'SHORT' ? -1 : null;
}

/** Canonical signal side -> exchange order side ('buy'|'sell'|null). */
export function orderSideForSignal(value) {
  const side = normalizeSide(value);
  return side === 'LONG' ? 'buy' : side === 'SHORT' ? 'sell' : null;
}

/** Canonical opposite side; unknown stays null (never defaults to LONG). */
export function oppositeSideOf(value) {
  const side = normalizeSide(value);
  return side === 'LONG' ? 'SHORT' : side === 'SHORT' ? 'LONG' : null;
}

/**
 * Audit entry/SL/T1/T2 geometry for a side.
 * LONG:  SL < entry < T1 <= T2
 * SHORT: SL > entry > T1 >= T2
 * Missing targets are only invalid when `requireTargets` is true.
 *
 * @param {object} p
 * @returns {object} honest audit - no throw, no side guessing
 */
export function auditDirectionalGeometry({
  side,
  entry,
  stopLoss,
  t1 = null,
  t2 = null,
  targets = null,
  requireTargets = false,
  tolerance = 1e-9,
} = {}) {
  const canonical = normalizeSide(side);
  const e = numOrNull(entry);
  const sl = numOrNull(stopLoss);
  const targetList = (Array.isArray(targets) ? targets : [t1, t2])
    .map(numOrNull)
    .filter((v) => v != null && v > 0);
  const tol = Math.max(1e-12, Number(tolerance) || 1e-9);

  const sideValid = canonical != null;
  const entryValid = e != null && e > 0;
  const stopLossValid = sl != null && sl > 0;
  const targetsPresent = targetList.length > 0;
  const slOnCorrectSide = Boolean(sideValid && entryValid && stopLossValid
    && (canonical === 'LONG' ? sl < e - tol : sl > e + tol));
  const targetsOnCorrectSide = Boolean(sideValid && entryValid
    && targetList.every((t) => (canonical === 'LONG' ? t > e + tol : t < e - tol)));
  const targetsOrdered = (() => {
    if (!targetsOnCorrectSide || targetList.length < 2) return targetsOnCorrectSide;
    for (let i = 1; i < targetList.length; i++) {
      if (canonical === 'LONG' ? targetList[i] < targetList[i - 1] - tol : targetList[i] > targetList[i - 1] + tol) return false;
    }
    return true;
  })();
  const targetsValid = requireTargets
    ? Boolean(targetsPresent && targetsOnCorrectSide && targetsOrdered)
    : Boolean(!targetsPresent || (targetsOnCorrectSide && targetsOrdered));
  const geometryValid = Boolean(sideValid && entryValid && stopLossValid && slOnCorrectSide && targetsValid);

  const reasons = [];
  if (!sideValid) reasons.push('side invalid (LONG/BUY or SHORT/SELL required)');
  if (!entryValid) reasons.push('entry invalid');
  if (!stopLossValid) reasons.push('stopLoss invalid');
  if (sideValid && entryValid && stopLossValid && !slOnCorrectSide) {
    reasons.push(`${canonical} SL ${sl} is on the wrong side of entry ${e}`);
  }
  if (requireTargets && !targetsPresent) reasons.push('targets missing (T1/T2 required)');
  if (targetsPresent && !targetsOnCorrectSide) {
    reasons.push(`${canonical} target is on the wrong side of entry ${e}`);
  }
  if (targetsPresent && targetsOnCorrectSide && !targetsOrdered) {
    reasons.push('target ladder is not strictly ordered');
  }

  return {
    side: canonical,
    entry: e,
    stopLoss: sl,
    targets: targetList,
    t1: numOrNull(t1),
    t2: numOrNull(t2),
    sideValid,
    entryValid,
    stopLossValid,
    targetsPresent,
    slOnCorrectSide,
    targetsOnCorrectSide,
    targetsOrdered,
    targetsValid,
    geometryValid,
    slDistance: sideValid && entryValid && stopLossValid ? Math.abs(e - sl) : null,
    slDistancePct: sideValid && entryValid && stopLossValid && e > 0 ? Math.abs(e - sl) / e : null,
    reasons,
  };
}

/**
 * Resolve the authoritative side for an exchange active position.
 * `activePos` (or positionAmt) sign wins over any declared side.
 */
export function resolveActivePosSide({ activePos, positionAmt, side, declaredSide } = {}) {
  const rawActivePos = activePos ?? positionAmt ?? null;
  const ap = numOrNull(rawActivePos);
  const activePosPresent = ap != null;
  const activePosSign = activePosPresent && ap !== 0 ? (ap > 0 ? 1 : -1) : 0;
  const activePosSide = activePosSign === 1 ? 'LONG' : activePosSign === -1 ? 'SHORT' : null;
  const declared = normalizeSide(side ?? declaredSide);
  const effective = activePosSide || declared;
  const conflict = Boolean(activePosSide && declared && activePosSide !== declared);
  return {
    side: effective,
    declaredSide: declared,
    activePosSide,
    activePosSign,
    activePosPresent,
    rawActivePos,
    source: activePosSide ? 'activePos' : declared ? 'declared' : 'none',
    conflict,
    reason: conflict
      ? `activePos ${ap} says ${activePosSide} but declared side says ${declared}`
      : activePosSide ? `activePos ${ap} authoritative ${activePosSide}` : declared ? 'declared side used (no activePos sign)' : 'no valid side',
  };
}

function normalizeConflictList(conflicts, conflictFlags = {}) {
  const out = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(conflicts)) conflicts.forEach(push);
  else if (typeof conflicts === 'string') push(conflicts);
  const flags = conflictFlags && typeof conflictFlags === 'object' ? conflictFlags : {};
  const labels = {
    boardSideConflict: 'board ensemble opposite side',
    svaConflict: 'SVA verifier FLIP/opposite call',
    councilConflict: 'AI council hard-no',
    directionLockConflict: 'cross-engine direction lock conflict',
    mtf6Conflict: 'MTF-6 bias against side',
    trapVeto: 'liquidity sweep / trap veto',
    zoneWallVeto: 'supply/demand wall veto',
    reversalRisk: 'reversal/exhaustion risk',
    counterTrend: 'counter-trend setup',
    counterHtf: 'counter-HTF setup',
  };
  for (const [k, label] of Object.entries(labels)) {
    if (flags[k] === true) push(label);
  }
  return out;
}

/**
 * Build the explicit per-signal/per-trade direction certificate.
 * Hard integrity is `ok`; PAKKA verification is `pakka` (requires ok +
 * directionVerified + zero conflicts).
 *
 * @param {object} p
 * @returns {object}
 */
export function buildDirectionCertificate({
  symbol = null,
  market = null,
  side = null,
  declaredSide = null,
  activePos = undefined,
  positionAmt = undefined,
  entry = null,
  stopLoss = null,
  t1 = null,
  t2 = null,
  targets = null,
  orderSide = null,
  requireTargets = true,
  directionVerified = false,
  conflicts = null,
  conflictFlags = {},
  source = null,
  extra = null,
} = {}) {
  const resolver = resolveActivePosSide({ activePos, positionAmt, side, declaredSide });
  const canonical = resolver.side;
  const audit = auditDirectionalGeometry({
    side: canonical,
    entry,
    stopLoss,
    t1,
    t2,
    targets,
    requireTargets,
  });
  const mappedOrderSide = orderSideForSignal(canonical);
  const suppliedRaw = orderSide == null ? null : clean(orderSide);
  const suppliedOrder = suppliedRaw ? (ORDER_ALIAS[suppliedRaw] || null) : null;
  const orderSideInvalid = Boolean(suppliedRaw && !suppliedOrder);
  const orderMismatch = Boolean(suppliedOrder && mappedOrderSide && suppliedOrder !== mappedOrderSide);
  const conflictList = normalizeConflictList(conflicts, conflictFlags);

  const checks = {
    sideValid: Boolean(canonical),
    orderSideMapped: Boolean(mappedOrderSide),
    orderSideValid: !orderSideInvalid,
    orderSideAligned: !orderMismatch && !orderSideInvalid,
    activePosChecked: resolver.activePosPresent,
    activePosAligned: !resolver.conflict,
    geometryValid: audit.geometryValid,
    stopLossValid: audit.stopLossValid,
    targetsValid: audit.targetsValid,
  };
  const ok = Boolean(
    checks.sideValid
    && checks.orderSideMapped
    && checks.orderSideValid
    && checks.orderSideAligned
    && checks.activePosAligned
    && checks.geometryValid
  );

  const reasons = [];
  if (!checks.sideValid) reasons.push(...resolver.reason ? [resolver.reason] : ['invalid side']);
  if (!checks.orderSideMapped) reasons.push('order side could not be mapped (unknown side)');
  if (orderSideInvalid) reasons.push(`supplied order side "${String(orderSide)}" invalid — buy/sell required`);
  if (orderMismatch) reasons.push(`supplied order side "${orderSide}" conflicts with ${canonical} -> ${mappedOrderSide}`);
  if (resolver.conflict) reasons.push(resolver.reason);
  if (!checks.geometryValid) reasons.push(...audit.reasons);
  if (ok && conflictList.length) reasons.push(...conflictList.map((c) => `verification conflict: ${c}`));

  const verdict = !ok
    ? (!canonical ? 'INVALID_SIDE'
      : !mappedOrderSide ? 'ORDER_MAP_FAILED'
        : orderMismatch || orderSideInvalid ? 'ORDER_SIDE_MISMATCH'
          : resolver.conflict ? 'ACTIVE_POS_MISMATCH'
            : 'INVALID_GEOMETRY')
    : conflictList.length ? 'CONFLICT'
      : directionVerified ? 'PAKKA'
        : 'WAIT';

  const verificationStatus = verdict;
  const pakka = Boolean(ok && directionVerified && conflictList.length === 0);
  const sideLabel = canonical || 'INVALID';
  const orderLabel = mappedOrderSide ? mappedOrderSide.toUpperCase() : 'NO-ORDER';
  const label = !ok
    ? `BLOCKED ${sideLabel} - ${reasons[0] || verdict}`
    : pakka
      ? `PAKKA ${sideLabel} -> ${orderLabel}`
      : `${verdict} ${sideLabel} -> ${orderLabel}`;

  return {
    version: DIRECTION_CERT_VERSION,
    symbol: symbol == null ? null : String(symbol).toUpperCase(),
    market: market == null ? null : String(market).toUpperCase(),
    source: source == null ? null : String(source),
    side: canonical,
    signalSide: canonical,
    declaredSide: resolver.declaredSide,
    rawSide: side ?? declaredSide ?? null,
    sideSign: sideSign(canonical),
    oppositeSide: oppositeSideOf(canonical),
    orderSide: mappedOrderSide,
    orderSideLabel: orderLabel,
    orderSideSupplied: orderSide ?? null,
    activePos: {
      raw: resolver.rawActivePos,
      present: resolver.activePosPresent,
      sign: resolver.activePosSign,
      side: resolver.activePosSide,
      source: resolver.source,
      authoritative: resolver.source === 'activePos',
      conflict: resolver.conflict,
      reason: resolver.reason,
    },
    geometry: audit,
    checks,
    ok,
    blocked: !ok,
    mismatch: Boolean(resolver.conflict || orderMismatch),
    activePosMismatch: Boolean(resolver.conflict),
    orderMismatch,
    conflicts: conflictList,
    directionVerified: Boolean(directionVerified && ok),
    pakka,
    verdict,
    verificationStatus,
    reasons: [...new Set(reasons)],
    label,
    extra: extra && typeof extra === 'object' ? extra : null,
    asOf: Date.now(),
  };
}

/**
 * Board-level integrity summary (rows may be board rows, deep-monitor rows
 * or auto-book records). Never throws on malformed rows.
 */
export function summarizeBoardDirectionIntegrity(rows = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const issues = [];
  let valid = 0;
  let blocked = 0;
  let uncertified = 0;
  let mismatches = 0;
  let conflicts = 0;
  let pakka = 0;
  let long = 0;
  let short = 0;
  let buy = 0;
  let sell = 0;

  for (const row of list) {
    const cert = row.directionCertificate || row.directionCert || null;
    if (!cert || typeof cert !== 'object') {
      uncertified += 1;
      const side = normalizeSide(row.side);
      if (side === 'LONG') long += 1;
      if (side === 'SHORT') short += 1;
      issues.push({ symbol: row.symbol ?? null, verdict: 'UNCERTIFIED', reasons: ['direction certificate missing'] });
      continue;
    }
    if (cert.ok === true) valid += 1;
    else blocked += 1;
    if (cert.mismatch === true) mismatches += 1;
    if (Array.isArray(cert.conflicts) && cert.conflicts.length > 0) conflicts += 1;
    if (cert.pakka === true) pakka += 1;
    const side = normalizeSide(cert.side ?? row.side);
    if (side === 'LONG') long += 1;
    if (side === 'SHORT') short += 1;
    if (cert.orderSide === 'buy') buy += 1;
    if (cert.orderSide === 'sell') sell += 1;
    if (cert.ok !== true || cert.mismatch === true) {
      issues.push({
        symbol: row.symbol ?? cert.symbol ?? null,
        verdict: cert.verdict || 'BLOCKED',
        reasons: Array.isArray(cert.reasons) ? cert.reasons.slice(0, 4) : [],
      });
    }
  }

  const total = list.length;
  const allValid = total > 0 && valid === total;
  const ok = allValid && mismatches === 0;
  const status = total === 0 ? 'EMPTY' : ok ? 'OK' : 'ATTENTION';
  const label = total === 0
    ? 'DIRECTION INTEGRITY: no rows'
    : `DIRECTION INTEGRITY: ${valid}/${total} certified · ${long} LONG→BUY · ${short} SHORT→SELL · ${mismatches} mismatch${uncertified ? ` · ${uncertified} uncertified` : ''}${blocked ? ` · ${blocked} blocked` : ''}`;

  return {
    version: DIRECTION_CERT_VERSION,
    status,
    ok,
    total,
    valid,
    blocked,
    uncertified,
    mismatches,
    conflicts,
    pakka,
    long,
    short,
    buy,
    sell,
    allValid,
    label,
    issues: issues.slice(0, 12),
    asOf: Date.now(),
  };
}
