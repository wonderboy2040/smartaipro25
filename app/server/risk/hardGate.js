// ============================================================
// server/risk/hardGate.js — v20.9.0 SHARED HARD RISK GATE
// ------------------------------------------------------------
// AUDIT (H1): SAPTA (proTraderAuto) aur Bot Lab (botRisk) ke risk
// gates alag-alag the — SAPTA me daily-loss halt / drawdown stop /
// event-day guard / stale-feed KAHIN nahi the (sirf maxConcurrent +
// maxTradesPerDay + cooldown + killSwitch). Ye module EK shared,
// PURE gate hai jo dono desks call karte hain:
//
//   • daily_loss      (realized + open unrealized, INR ya %)
//   • peak_drawdown   (peak equity se, start-equity se NAHI)
//   • max_open        (concurrent positions)
//   • max_consecutive_losses (us din ka streak → pause)
//   • event_day       (eventGuard blackout — result/RBI/FOMC din)
//   • stale_feed      (purana scan/feed = no trade)
//   • kill_switch     (hamesha jeeta)
//
// Ground rules (plan §11.1): HARD RULES, AI ke UPAR. Koi bhi decider
// (Jev/gates/ensemble) in reasons ko override NAHI kar sakta. Every
// reason string STABLE hai — events/dashboard/telegram filter isi pe
// depend karte hain. Pure functions only (no fs, no clock reads —
// `now` hamesha inject hota hai) — tests bina mock ke chalte hain.
// ============================================================

/** Wilson lower bound (95%) — chhote-n par win-rate ko honest
 *  conservative side pe rakhne ke liye (audit B2/B3). */
export function wilsonLowerBound(wins, n, z = 1.96) {
  const w = Number(wins), N = Number(n);
  if (!Number.isFinite(w) || !Number.isFinite(N) || N <= 0 || w < 0) return null;
  const p = w / N;
  const denom = 1 + (z * z) / N;
  const center = p + (z * z) / (2 * N);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * N)) / N);
  return Math.max(0, Math.min(1, (center - margin) / denom));
}

/**
 * Peak-based drawdown % — account.peakEquity se (M2 fix). Start-se-loss
 * equity FLOOR hai, drawdown nahi — dono alag rules.
 * @returns {number|null} null = state invalid (peak/eq uncomputable)
 */
export function drawdownFromPeakPct({ peakEquity, equity }) {
  const peak = Number(peakEquity), eq = Number(equity);
  if (!Number.isFinite(peak) || !Number.isFinite(eq) || peak <= 0) return null;
  return ((peak - eq) / peak) * 100;
}

/** Start-based equity-floor % (below-start loss, legacy rule). */
export function lossFromStartPct({ startingEquity, equity }) {
  const s = Number(startingEquity), eq = Number(equity);
  if (!Number.isFinite(s) || !Number.isFinite(eq) || s <= 0) return null;
  return ((s - eq) / s) * 100;
}

/** Consecutive-loss streak ENDING at the last settled trade (day-scoped
 *  when `sinceTs` diya gaya — sirf us din ke closed trades ginta hai,
 *  warna poora list). Pure — caller sorts/queries the journal. */
export function currentLossStreak({ settled = [], sinceTs = null } = {}) {
  let streak = 0;
  const list = (Array.isArray(settled) ? settled : [])
    .filter((t) => t && (sinceTs == null || Number(t.closedTs ?? t.ts ?? 0) >= sinceTs))
    .sort((a, b) => Number(b.closedTs ?? b.ts ?? 0) - Number(a.closedTs ?? b.ts ?? 0));
  for (const t of list) {
    const pnl = Number(t.pnl ?? t.netPnl ?? t.pnlINR);
    if (!Number.isFinite(pnl)) break; // unknown outcome breaks an honest streak
    if (pnl < 0) streak++;
    else break;
  }
  return streak;
}

/**
 * THE SHARED GATE (audit A1). PURE — sara state caller inject karta hai.
 *
 * @param {object} a
 *   killSwitch      bool (any active switch)
 *   dailyPnl        realized+unrealized P&L of the day (currency units)
 *   maxDailyLoss    positive number, same units (block threshold)
 *   peakEquity / equity / startingEquity — account state
 *   maxDrawdownPct  peak-se drawdown kill %
 *   equityFloorPct  start-se-loss floor % (optional, legacy rule)
 *   openCount / maxOpen — concurrent positions
 *   lossStreak / maxConsecutiveLosses — aaj ka streak
 *   eventBlocked    bool — eventGuard blackout for THIS symbol/desk
 *   eventLabel      string — kaunsa event (reason me jata hai)
 *   scanAgeSec      seconds since last fresh scan/feed (null = unknown)
 *   maxScanAgeSec   stale threshold
 */
export function hardGateCheck(a = {}) {
  const {
    killSwitch = false,
    dailyPnl = null, maxDailyLoss = null,
    peakEquity = null, equity = null, startingEquity = null,
    maxDrawdownPct = null, equityFloorPct = null,
    openCount = null, maxOpen = null,
    lossStreak = null, maxConsecutiveLosses = null,
    eventBlocked = false, eventLabel = null,
    scanAgeSec = null, maxScanAgeSec = null,
    account = null, // optional {peakEquity, equity, startingEquity} shorthand
  } = a;
  const reasons = [];

  // 1. kill switch — hamesha pehle, hamesha jeeta
  if (killSwitch) reasons.push('kill_switch');

  // 2. account state validity — NaN/missing equity pe SILENT pass
  //    allowed hi nahi (audit M3: "equity NaN ho to teeno silently skip")
  const acc = account || { peakEquity, equity, startingEquity };
  const hasDrawdownRule = Number.isFinite(Number(maxDrawdownPct)) && Number(maxDrawdownPct) > 0;
  const hasFloorRule = Number.isFinite(Number(equityFloorPct)) && Number(equityFloorPct) > 0;
  if (hasDrawdownRule || hasFloorRule) {
    if (!Number.isFinite(Number(acc.equity))) reasons.push('account_state_invalid(equity)');
  }

  // 3. daily loss (INR/USDT absolute — SAPTA style; % version Bot Lab
  //    apne equity denominator se pehle compute karke yahi pass karta hai)
  if (Number.isFinite(Number(dailyPnl)) && Number.isFinite(Number(maxDailyLoss)) && maxDailyLoss > 0) {
    if (dailyPnl <= -maxDailyLoss) reasons.push(`daily_loss(${Number(dailyPnl).toFixed(0)} <= -${maxDailyLoss})`);
  }

  // 4. peak-based drawdown kill (audit M2 — "start se loss" nahi, PEAK se)
  //    v20.9.1 [M]: FAIL-CLOSED — pehle invalid/missing peakEquity (undefined/
  //    NaN) pe dd==null SILENTLY pass hota tha: account_state_invalid(peak)
  //    sirf tab push hota tha jab peak FINITE ho — jo contradictory tha.
  //    Drawdown rule active + valid equity + unusable peak → ab BLOCK.
  //    (Current consumers — botRisk startEq fallback — pre-guard karte
  //    hain; ye shared gate ka agla consumer safe karne ke liye hai.)
  if (hasDrawdownRule && Number.isFinite(Number(acc.equity))) {
    const dd = drawdownFromPeakPct({ peakEquity: acc.peakEquity, equity: acc.equity });
    if (dd == null) reasons.push('account_state_invalid(peak)');
    else if (dd >= maxDrawdownPct) reasons.push(`max_drawdown_kill(${dd.toFixed(2)}% from peak)`);
  }

  // 5. equity floor (legacy start-based rule — alag reason, alag threshold)
  //    v20.9.1 [M]: FAIL-CLOSED — missing startingEquity pe fl==null silently
  //    pass hota tha; ab floor rule active + unusable start → BLOCK.
  if (hasFloorRule && Number.isFinite(Number(acc.equity))) {
    const fl = lossFromStartPct({ startingEquity: acc.startingEquity, equity: acc.equity });
    if (fl == null) reasons.push('account_state_invalid(start)');
    else if (fl >= equityFloorPct) reasons.push(`equity_floor(${fl.toFixed(2)}% below start)`);
  }

  // 6. concurrent positions
  if (Number.isFinite(Number(openCount)) && Number.isFinite(Number(maxOpen)) && maxOpen > 0) {
    if (openCount >= maxOpen) reasons.push(`max_open(${openCount}>=${maxOpen})`);
  }

  // 7. consecutive losses (aaj) — tilt guard
  if (Number.isFinite(Number(lossStreak)) && Number.isFinite(Number(maxConsecutiveLosses)) && maxConsecutiveLosses > 0) {
    if (lossStreak >= maxConsecutiveLosses) reasons.push(`max_consecutive_losses(${lossStreak})`);
  }

  // 8. event-day blackout (audit A3 — hard rule for ALL arms)
  if (eventBlocked) reasons.push(`event_day_blackout(${eventLabel || 'scheduled event'})`);

  // 9. stale scan/feed
  if (scanAgeSec != null && Number.isFinite(Number(maxScanAgeSec)) && maxScanAgeSec > 0 && scanAgeSec > maxScanAgeSec) {
    reasons.push(`stale_feed(${Math.round(scanAgeSec)}s)`);
  }

  return { ok: reasons.length === 0, reasons };
}

/** Shared clamp helper (audit A4) — upper bounds bhi enforced. */
export const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
