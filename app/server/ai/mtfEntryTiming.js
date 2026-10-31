// ============================================================
// server/ai/mtfEntryTiming.js — v21.30.0 [SIGNAL TIMING + DIRECTION]
// ------------------------------------------------------------
// Pure, fail-open entry-timing guard for the MTF auto/board entry path.
// The board re-scores every ~2s, but the auto tick may see a row that has
// already been overtaken by price (a fresh reversal) or a row whose stated
// side disagrees with the deep/trigger context. The old live-quote check
// allowed a chase of up to 55% of risk and an adverse move of 25% — far too
// loose for a 1-session/1-trade lock.
//
// Rules:
//   • BLOCK only clear, numeric contradictions (side vs context dir, certificate
//     order side, closed-bar side flip, stale row, chase/adverse ratio).
//   • Missing fields are NEVER treated as a block (fail-open).
//   • Thresholds are exported so tests/config can pin them.
// ============================================================

export const ENTRY_TIMING_DEFAULTS = Object.freeze({
  maxChaseRiskRatio: 0.35,   // live already >35% of risk past entry = late
  maxAdverseRiskRatio: 0.15, // live already >15% of risk toward SL = reversal
  maxRowAgeMs: 90_000,       // board row older than 90s = stale signal
});

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sideOf(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 'LONG';
  if (s === 'SHORT' || s === 'SELL') return 'SHORT';
  return null;
}

/**
 * @returns {{
 *   ok: boolean, side: 'LONG'|'SHORT'|null, blockers: string[],
 *   metrics: object, thresholds: object
 * }}
 */
export function evaluateEntryTiming({
  row = {},
  side = null,
  livePrice = null,
  rowAgeMs = null,
  now = Date.now(),
  maxChaseRiskRatio = ENTRY_TIMING_DEFAULTS.maxChaseRiskRatio,
  maxAdverseRiskRatio = ENTRY_TIMING_DEFAULTS.maxAdverseRiskRatio,
  maxRowAgeMs = ENTRY_TIMING_DEFAULTS.maxRowAgeMs,
} = {}) {
  const blockers = [];
  const s = sideOf(side ?? row?.side);
  if (!s) blockers.push('direction unresolved — LONG/SHORT required');

  const rowSide = sideOf(row?.side);
  if (rowSide && s && rowSide !== s) {
    blockers.push(`direction disagreement: row side ${rowSide} ≠ execution side ${s}`);
  }

  // Direction certificate is the hard contract: LONG→buy / SHORT→sell.
  const cert = row?.directionCertificate && typeof row.directionCertificate === 'object'
    ? row.directionCertificate
    : null;
  if (cert) {
    if (cert.ok === false) {
      blockers.push(`direction certificate blocked (${cert.verdict || 'invalid'}): ${cert.reasons?.[0] || 'no reason'}`);
    }
    const certSide = sideOf(cert.side ?? cert.signalSide);
    if (certSide && s && certSide !== s) {
      blockers.push(`direction certificate side ${certSide} ≠ execution side ${s}`);
    }
    const expectedOrder = s === 'LONG' ? 'buy' : s === 'SHORT' ? 'sell' : null;
    const certOrder = String(cert.orderSide || '').trim().toLowerCase();
    if (expectedOrder && certOrder && certOrder !== expectedOrder) {
      blockers.push(`direction certificate order side ${certOrder.toUpperCase()} ≠ ${expectedOrder.toUpperCase()} for ${s}`);
    }
  }

  const contextDir = num(row?.context?.dir ?? row?.trendDir);
  if (contextDir && s) {
    if ((s === 'LONG' && contextDir < 0) || (s === 'SHORT' && contextDir > 0)) {
      blockers.push(`direction disagreement: ${s} against deep-TF context dir ${contextDir}`);
    }
  }
  const triggerDir = num(row?.trigger?.dir ?? row?.triggerDir);
  if (triggerDir && s) {
    if ((s === 'LONG' && triggerDir < 0) || (s === 'SHORT' && triggerDir > 0)) {
      blockers.push(`direction disagreement: ${s} against trigger dir ${triggerDir}`);
    }
  }

  // Fresh closed-bar reversal: the last CLOSED bar still pointed the other way.
  if (row?.sideStable === false) {
    blockers.push('closed-bar reversal: last closed bar side differs from the live side (late flip)');
  }
  // NOTE: `triggerStable === false` alone is NOT a block — for an eligible
  // row (trigger currently fired) it normally means the forming bar just
  // fired while the closed bar had not, i.e. a fresh entry, not a late one.
  // `sideStable` + the quote-ratio checks cover the actual reversal risk.
  if (row?.trigger?.overextended === true) {
    blockers.push('entry overextended (chase risk)');
  }

  const age = num(rowAgeMs)
    ?? (num(row?.builtAt) != null ? Math.max(0, now - num(row.builtAt)) : null);
  if (age != null && age > maxRowAgeMs) {
    blockers.push(`signal row ${Math.round(age / 1000)}s old > ${Math.round(maxRowAgeMs / 1000)}s (stale)`);
  }

  const entry = num(row?.plan?.entry);
  const sl = num(row?.plan?.stopLoss);
  const px = num(livePrice);
  const risk = entry != null && sl != null ? Math.abs(entry - sl) : null;
  let chaseRatio = null;
  let adverseRatio = null;
  if (s && px != null && px > 0 && entry != null && entry > 0 && risk != null && risk > 0) {
    const favorable = s === 'LONG' ? px - entry : entry - px;
    chaseRatio = favorable / risk;
    adverseRatio = -favorable / risk;
    if (chaseRatio > maxChaseRiskRatio) {
      blockers.push(`late chase: live already ${(chaseRatio * 100).toFixed(0)}% of risk past ${s} entry (max ${(maxChaseRiskRatio * 100).toFixed(0)}%)`);
    }
    if (adverseRatio > maxAdverseRiskRatio) {
      blockers.push(`reversal: live already ${(adverseRatio * 100).toFixed(0)}% of risk against ${s} (max ${(maxAdverseRiskRatio * 100).toFixed(0)}%)`);
    }
  }

  return {
    ok: blockers.length === 0,
    side: s,
    blockers,
    metrics: {
      rowAgeMs: age,
      chaseRatio: chaseRatio == null ? null : Math.round(chaseRatio * 1000) / 1000,
      adverseRatio: adverseRatio == null ? null : Math.round(adverseRatio * 1000) / 1000,
      contextDir,
      triggerDir,
      livePrice: px,
    },
    thresholds: { maxChaseRiskRatio, maxAdverseRiskRatio, maxRowAgeMs },
  };
}
