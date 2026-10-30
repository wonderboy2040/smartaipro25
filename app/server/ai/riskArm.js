// ============================================================
// server/ai/riskArm.js — v21.29.0 (R2 LIVE RISK ARM)
// ------------------------------------------------------------
// Pure helpers that gate the LIVE arm and label live sizing. Design rules:
//   • Missing risk caps BLOCK arming; the user may only override with a
//     TYPED acknowledgement (never a silent default, never auto-applied).
//   • The SAFE preset is a SUGGESTION ONLY. This module never writes config.
//   • Liquidation must sit beyond the stop + a buffer; otherwise the trade
//     is blocked (a stop that cannot fire before liquidation is not a stop).
//   • Consecutive-loss pause is a time-boxed new-entry block.
//   • Risk-based qty + margin caps carry explicit labels so the UI/audit can
//     show WHY the final size is what it is.
// ============================================================

export const RISK_ACK_PHRASE = 'I ACCEPT THE RISK CAPS';

/** Conservative starting point shown to the user. NEVER auto-applied. */
export const RISK_SAFE_PRESET = Object.freeze({
  riskPerTradePct: 1,
  maxRiskPerTradePct: 2,
  maxLeverage: 5,
  maxWalletDeployPct: 25,
  dailyLossPct: 1.5,
  maxOpenPositions: 1,
  maxNotionalPerTradeINR: 50000,
  maxTradesPerDay: 5,
  postSuccessCooldownMin: 5,
  consecutiveLossPauseAfter: 3,
  consecutiveLossPauseMin: 120,
});

const REQUIRED_CAPS = [
  { key: 'riskPerTradePct', label: 'Per-trade risk %', min: 0.1, hint: '1 = 1% of live wallet risked per trade' },
  { key: 'maxLeverage', label: 'Max leverage', min: 1, hint: 'hard ceiling; e.g. 5' },
  { key: 'maxWalletDeployPct', label: 'Max wallet deploy %', min: 1, hint: 'e.g. 25 = at most 25% of wallet margin' },
  { key: 'dailyLossPct', label: 'Daily loss stop %', min: 0.1, hint: 'e.g. 1.5 = stop new entries after -1.5% day' },
];

/** List the required caps that are absent/zero. Empty = armable. */
export function riskCapsMissing(cfg = {}) {
  const missing = [];
  for (const c of REQUIRED_CAPS) {
    const v = Number(cfg?.[c.key]);
    if (!(Number.isFinite(v) && v >= c.min)) {
      missing.push({ key: c.key, label: c.label, min: c.min, value: cfg?.[c.key] ?? null, hint: c.hint });
    }
  }
  return missing;
}

/**
 * Evaluate whether LIVE may be armed.
 * `acknowledged`/`phrase` are the CURRENT request's typed override; the
 * persisted `cfg.riskCapsAcknowledged` + `cfg.riskCapsAckPhrase` are also
 * honoured (a previous explicit acknowledgement).
 */
export function evaluateLiveArmRisk(cfg = {}, { acknowledged = false, phrase = '' } = {}) {
  const missing = riskCapsMissing(cfg);
  const normPhrase = (v) => String(v || '').trim().toUpperCase();
  const typedNow = acknowledged === true && normPhrase(phrase) === RISK_ACK_PHRASE;
  const persisted = cfg?.riskCapsAcknowledged === true
    && normPhrase(cfg?.riskCapsAckPhrase) === RISK_ACK_PHRASE;
  const ackOk = typedNow || persisted;
  const ok = missing.length === 0 || ackOk;
  const blockers = [];
  if (missing.length > 0 && !ackOk) {
    blockers.push(`LIVE arm blocked — missing risk caps: ${missing.map(m => m.key).join(', ')}. Set the caps or type "${RISK_ACK_PHRASE}" to override (not recommended).`);
  }
  return {
    ok,
    armable: ok,
    missing,
    blockerCount: blockers.length,
    blockers,
    ackRequired: missing.length > 0,
    ackOk,
    ackPhrase: RISK_ACK_PHRASE,
    overrideActive: missing.length > 0 && ackOk,
    preset: { ...RISK_SAFE_PRESET },
    // Hard rule surfaced everywhere: the preset is advisory.
    presetOnly: true,
    note: 'SAFE preset sirf suggestion hai — apply karna ek explicit config action hai (auto-apply kabhi nahi).',
  };
}

/**
 * Validate a config PATCH before it is persisted. Pure: the route uses the
 * verdict, this module never writes config.
 *   • a malformed typed acknowledgement is rejected outright
 *   • switching executionMode → live is gated only on the ARMING request
 *     (unrelated edits to an already-live config stay possible; the tick gate
 *     still blocks unsafe LIVE entries)
 */
export function evaluateLiveArmConfigPatch({
  currentCfg = {}, patch = {}, armingLive = false,
} = {}) {
  const normPhrase = (v) => String(v || '').trim().toUpperCase();
  const wantsAck = patch?.riskCapsAcknowledged === true;
  const typedAck = wantsAck && normPhrase(patch?.riskCapsAckPhrase) === RISK_ACK_PHRASE;
  if (wantsAck && !typedAck) {
    return {
      ok: false, gated: false, reason: 'risk-ack-phrase',
      error: `typed acknowledgement phrase must be exactly "${RISK_ACK_PHRASE}"`,
      ackPhrase: RISK_ACK_PHRASE, presetOnly: true,
    };
  }
  const merged = {
    ...currentCfg,
    ...patch,
    desks: { ...(currentCfg?.desks || {}), ...(patch?.desks || {}) },
  };
  const arm = evaluateLiveArmRisk(merged, {
    acknowledged: typedAck,
    phrase: patch?.riskCapsAckPhrase,
  });
  if (!armingLive) {
    return { ok: true, gated: false, typedAck, arm, presetOnly: true };
  }
  return {
    ok: arm.ok,
    gated: true,
    typedAck,
    arm,
    reason: arm.ok ? null : 'live-arm-risk',
    error: arm.ok ? null : (arm.blockers[0] || 'LIVE arm blocked — risk caps missing'),
    presetOnly: true,
  };
}

/**
 * Stop must fire before liquidation: require liquidation distance >= stop
 * distance + buffer. Also validates the polarity (LONG liq below entry,
 * SHORT liq above entry) — an inverted liq is a data error, never a pass.
 */
export function evaluateLiquidationDistanceGuard({
  side, entry, liqPrice, stopLoss = null, minBufferPct = 0.5,
} = {}) {
  const s = String(side || '').toUpperCase();
  const e = Number(entry);
  const liq = Number(liqPrice);
  const sl = Number(stopLoss);
  if ((s !== 'LONG' && s !== 'SHORT') || !(e > 0) || !(liq > 0)) {
    return { ok: false, checked: false, reason: 'invalid-input', error: 'side/entry/liqPrice required' };
  }
  const liqDistancePct = +((Math.abs(e - liq) / e) * 100).toFixed(4);
  const stopDistancePct = sl > 0 ? +((Math.abs(e - sl) / e) * 100).toFixed(4) : null;
  const bufferPct = Math.max(0.05, Number(minBufferPct) || 0.5);
  const polarityOk = s === 'LONG' ? liq < e : liq > e;
  if (!polarityOk) {
    return {
      ok: false, checked: true, reason: 'liq-polarity', liqDistancePct, stopDistancePct,
      requiredPct: stopDistancePct, error: `${s} liquidation ${liq} is on the wrong side of entry ${e}`,
    };
  }
  const requiredPct = stopDistancePct == null ? bufferPct : +(stopDistancePct + bufferPct).toFixed(4);
  const ok = liqDistancePct >= requiredPct;
  return {
    ok, checked: true,
    liqDistancePct, stopDistancePct, bufferPct, requiredPct,
    reason: ok ? 'safe' : 'too-close',
    label: ok
      ? `liq ${liqDistancePct}% away ≥ stop ${stopDistancePct ?? '—'}% + ${bufferPct}% buffer`
      : `BLOCKED: liq only ${liqDistancePct}% away — needs ≥ ${requiredPct}% (stop ${stopDistancePct ?? '—'}% + ${bufferPct}% buffer)`,
  };
}

/**
 * Consecutive-loss pause. `closedRows` = newest-last closed trade rows
 * (`{ pnl, closeReason, closedAt, executionMode }`). Only a LOSING streak
 * counts; a break-even/unknown row resets nothing (conservative: unknown is
 * skipped, not counted as a win).
 */
export function consecutiveLossState(closedRows = [], { liveOnly = false, now = Date.now() } = {}) {
  const rows = (Array.isArray(closedRows) ? closedRows : [])
    .filter(r => r && r.status !== 'OPEN')
    .filter(r => !liveOnly || String(r.executionMode || '').toUpperCase() === 'LIVE')
    .slice()
    .sort((a, b) => Number(a.closedAt || 0) - Number(b.closedAt || 0));
  let streak = 0;
  let lastLossAt = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const pnl = Number(r.pnl);
    const reason = String(r.closeReason || '').toUpperCase();
    if (Number.isFinite(pnl) && pnl > 0) break;
    const isLoss = (Number.isFinite(pnl) && pnl < 0) || reason.includes('LOSS') || reason.includes('SL');
    if (!isLoss) continue; // unknown/break-even — skip, streak continues
    streak++;
    const at = Number(r.closedAt) || 0;
    if (at > lastLossAt) lastLossAt = at;
  }
  return { streak, lastLossAt, now };
}

export function evaluateConsecutiveLossPause({
  closedRows = [], liveOnly = false, pauseAfter = 3, pauseMin = 120, pausedUntil = 0, now = Date.now(),
} = {}) {
  const st = consecutiveLossState(closedRows, { liveOnly, now });
  const threshold = Math.max(0, Math.floor(Number(pauseAfter) || 0));
  const holdMs = Math.max(0, Number(pauseMin) || 0) * 60_000;
  const until = Math.max(Number(pausedUntil) || 0, st.streak >= threshold && threshold > 0 ? st.lastLossAt + holdMs : 0);
  const blocked = until > now;
  return {
    blocked,
    streak: st.streak,
    threshold,
    pauseMin: Math.max(0, Number(pauseMin) || 0),
    lastLossAt: st.lastLossAt,
    pausedUntil: until || null,
    msLeft: blocked ? until - now : 0,
    reason: blocked
      ? `consecutive-loss pause: ${st.streak} losing trade(s) ≥ ${threshold} — new entries resume ${new Date(until).toISOString()}`
      : null,
  };
}

/**
 * Risk-based sizing + cap labels. PURE.
 * `qty` is the smaller of the risk-budget qty and the notional-cap qty.
 */
export function computeRiskBasedSizing({
  walletINR = 0, riskPerTradeINR = 0, riskPerTradePct = 0,
  entry = 0, stopLoss = 0, maxNotionalINR = null, leverage = 1, fxRate = 1,
} = {}) {
  const e = Number(entry);
  const sl = Number(stopLoss);
  const lev = Math.max(1, Number(leverage) || 1);
  const fx = Number(fxRate) > 0 ? Number(fxRate) : 1;
  const wallet = Number(walletINR) > 0 ? Number(walletINR) : 0;
  const pct = Number(riskPerTradePct) > 0 ? Number(riskPerTradePct) : 0;
  const configuredRisk = Number(riskPerTradeINR) > 0 ? Number(riskPerTradeINR) : 0;
  const pctRiskINR = wallet > 0 && pct > 0 ? (wallet * pct) / 100 : null;
  const riskINR = pctRiskINR != null
    ? Math.min(configuredRisk > 0 ? configuredRisk : pctRiskINR, pctRiskINR)
    : configuredRisk;
  const stopDist = e > 0 && sl > 0 ? Math.abs(e - sl) : 0;
  if (!(e > 0) || !(stopDist > 0) || !(riskINR > 0)) {
    return {
      ok: false, reason: 'invalid-inputs', qty: 0, riskINR: riskINR || null,
      labels: ['risk sizing unavailable (entry/SL/risk missing)'],
    };
  }
  const riskQty = riskINR / (stopDist * fx); // fx: INR per USDT for USD desks
  const capINR = Number(maxNotionalINR) > 0 ? Number(maxNotionalINR) : null;
  const capQty = capINR != null ? capINR / (e * fx) : Infinity;
  const qtyRaw = Math.min(riskQty, capQty);
  const capApplied = capQty < riskQty ? 'notional-cap' : 'risk-budget';
  const notionalINR = qtyRaw * e * fx;
  const marginINR = notionalINR / lev;
  return {
    ok: true,
    qty: +qtyRaw.toFixed(8),
    riskINR: +riskINR.toFixed(2),
    riskPct: wallet > 0 ? +((riskINR / wallet) * 100).toFixed(3) : null,
    stopDistancePct: +((stopDist / e) * 100).toFixed(4),
    notionalINR: +notionalINR.toFixed(2),
    marginINR: +marginINR.toFixed(2),
    leverage: lev,
    capApplied,
    capINR: capINR != null ? capINR : null,
    labels: [
      `risk-based qty ${+qtyRaw.toFixed(8)} @ ${capApplied === 'risk-budget' ? `₹${(+riskINR.toFixed(2))} risk` : `₹${capINR} notional cap`}`,
      `stop ${+((stopDist / e) * 100).toFixed(3)}% · margin ₹${(+marginINR.toFixed(2))} @ ${lev}x`,
      `risk ${+riskINR.toFixed(2)} INR${wallet > 0 ? ` (${+(riskINR / wallet * 100).toFixed(2)}% of ₹${wallet})` : ''}`,
    ],
  };
}
