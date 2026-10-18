// ============================================================
// server/bots/botRisk.js — Jev Bot Lab v20.8.0 → v20.9.0
// ------------------------------------------------------------
// Plan §11.1: HARD RULES, AI ke UPAR. Jev/strategy/gates inme se
// kisi rule ko override NAHI kar sakte (plan ground rule #4).
// Every check returns a stable reason string so vetoes are
// auditable and the dashboard can show WHY a trade was blocked.
//
// v20.9.0 AUDIT FIXES (deep-audit plan Phase A):
//   [A2/M2] drawdown kill ab PEAK equity se hai (start se nahi) —
//           +30% chadh ke -25% girna ab kill karta hai. Start-se-loss
//           alag "equity_floor" rule ban gaya.
//   [A3/M1] eventGuardCheck ab PRE-DECIDER hard rule hai — SAARE arms
//           (rules/gated/jev) ke liye. Pehle sirf gated arm me tha.
//   [A4/M3] botRiskConfig: har key env-mappable + CLAMPED (upper bhi),
//           0-value invalid → default + warning event. Fee gate ab
//           EDGE ke liye bhi fail-closed. Equity NaN → account_state_invalid.
//           Sab kuch shared hardGate.js (server/risk/) se derive hota
//           hai — SAPTA wahi gate use karta hai (audit A1).
// ============================================================
// v21.1.0: hardGateCheck import removed — botRisk ka apna _accountStateReasons
// usi shared-gate semantics ko fail-closed re-implement karta tha (divergence
// risk), import unused tha. Sirf jo helpers actually use hote hain.
import { drawdownFromPeakPct, wilsonLowerBound } from '../risk/hardGate.js';

export const BOT_RISK_DEFAULTS = {
  riskPerTradePct: 0.5,
  botDailyLossPct: 2.0,          // per-bot daily loss kill
  totalDailyLossPct: 4.0,        // all-bots combined kill
  maxOpenPerBot: 1,
  maxOpenTotal: 3,
  maxDrawdownKillPct: 10,        // from PEAK equity (v20.9.0 A2)
  equityFloorPct: 20,            // from START equity (legacy floor, v20.9.0)
  maxLeverageCrypto: 3,
  maxTradesPerBotPerDay: 4,
  reentryCooldownMin: 30,
  staleFeedSeconds: 90,
  squareOffIST: '15:10',
  minEdgeOverCostMult: 1.5,      // fee gate multiplier
  maxConsecutiveLosses: 3,       // aaj ka loss-streak pause (v20.9.0 A1)
  mode: 'PAPER',                 // ALWAYS paper by default (ground rule #5)
};

// v20.9.0 (A4): env key → [default, lo, hi] — upper bounds bhi enforced.
// Purana `num()` helper me upper bound NAHI tha: BOT_RISK_PER_TRADE_PCT=50
// silently accept hota tha (25x the safe cap). Exact-0 bhi invalid hai
// (botDailyLossPct=0 ka matlab "kabhi trade nahi" — silently, bina reason).
const ENV_KEYS = {
  BOT_RISK_PER_TRADE_PCT: ['riskPerTradePct', 0.05, 2],
  BOT_DAILY_LOSS_PCT: ['botDailyLossPct', 0.25, 10],
  BOT_TOTAL_DAILY_LOSS_PCT: ['totalDailyLossPct', 0.5, 20],
  BOT_MAX_OPEN_PER_BOT: ['maxOpenPerBot', 1, 10],
  BOT_MAX_OPEN_TOTAL: ['maxOpenTotal', 1, 20],
  BOT_MAX_DRAWDOWN_KILL_PCT: ['maxDrawdownKillPct', 1, 50],
  BOT_EQUITY_FLOOR_PCT: ['equityFloorPct', 1, 90],
  BOT_MAX_LEVERAGE_CRYPTO: ['maxLeverageCrypto', 1, 5],
  BOT_MAX_TRADES_PER_BOT_PER_DAY: ['maxTradesPerBotPerDay', 1, 50],
  BOT_REENTRY_COOLDOWN_MIN: ['reentryCooldownMin', 0, 720],
  BOT_STALE_FEED_SECONDS: ['staleFeedSeconds', 10, 1800],
  BOT_MIN_EDGE_OVER_COST_MULT: ['minEdgeOverCostMult', 1, 10],
  BOT_MAX_CONSECUTIVE_LOSSES: ['maxConsecutiveLosses', 1, 10],
};

export function botRiskConfig(env = process.env) {
  const cfg = { ...BOT_RISK_DEFAULTS };
  const warnings = [];
  for (const [k, [field, lo, hi]] of Object.entries(ENV_KEYS)) {
    const raw = Number(env[k]);
    if (!Number.isFinite(raw)) continue;                 // not set → default
    // v20.9.1 [M]: BOT_REENTRY_COOLDOWN_MIN=0 VALID hai ("no cooldown" —
    // declared range [0,720] bhi yahi kehta hai); pehle `raw <= 0` check
    // use default 30 pe silently revert kar deta tha sirf ek warning ke saath.
    const zeroAllowed = field === 'reentryCooldownMin';
    if (raw < 0 || (raw === 0 && !zeroAllowed)) {
      warnings.push(`${k}=${env[k]} invalid (must be >= 0${zeroAllowed ? '' : ', > 0 for this knob'}) — using default ${BOT_RISK_DEFAULTS[field]}`);
      continue;
    }
    if (raw === 0) { cfg[field] = 0; continue; }         // explicit zero (cooldown-off only)
    // v20.9.0 (A4 — audit semantics "BOT_RISK_PER_TRADE_PCT=50 → clamp 2"):
    // out-of-range POSITIVE values clamp to the boundary (user ka intent
    // direction preserve), sirf zero/negative invalid hote hain.
    const clamped = Math.min(hi, Math.max(lo, raw));
    if (clamped !== raw) warnings.push(`${k}=${raw} clamped to ${clamped} (allowed ${lo}..${hi})`);
    cfg[field] = field === 'maxTradesPerBotPerDay' ? Math.floor(clamped) : clamped;
  }
  cfg.mode = env.BOTS_MODE === 'LIVE' ? 'LIVE' : 'PAPER';
  cfg._envWarnings = warnings; // caller (botRunner init) logs these once
  return cfg;
}

/** v20.8.4: the account-state reasons shared by the full check and the
 *  pre-decider check (DRY — reason strings stay byte-identical so events
 *  and dashboard filters don't diverge). Pure account/openCount state:
 *  NO feed age, NO fee gate — those need candidate context.
 *  v20.9.0 (A2/A3/A4): peak-drawdown + equity floor split, event guard,
 *  account_state_invalid, loss streak. */
function _accountStateReasons(cfg, bot, account, openCounts, now, opts = {}) {
  const reasons = [];
  const startEq = Number(account.startingEquity) || 0;
  const eq = Number(account.equity);
  // v20.9.0 (A4/M3): invalid account state pe SILENT skip mana hai —
  // pehle `startEq > 0 && isFinite(eq)` ke andar saare loss checks chhupe
  // the, ek NaN equity teeno ko bypass kar deti thi.
  if (!(startEq > 0)) reasons.push('account_state_invalid(startingEquity)');
  else if (!Number.isFinite(eq)) reasons.push('account_state_invalid(equity)');
  else {
    const tp = account.todayPnl;
    const todayNet = typeof tp === 'number' ? tp : Number(tp?.net);
    const todayPct = ((Number.isFinite(todayNet) ? todayNet : 0) / startEq) * 100;
    if (todayPct <= -cfg.botDailyLossPct) reasons.push(`bot_daily_loss(${todayPct.toFixed(2)}%)`);
    // total daily loss across bots (per-CURRENCY aggregate in the
    // botRunner; openCounts.totalTodayPnl is already this bot's currency)
    // v20.8.4 FIX (M — honest denominator)
    const totalStart = Number(openCounts.totalTodayStartEq);
    const denom = Number.isFinite(totalStart) && totalStart > 0 ? totalStart : startEq;
    const totalTodayPct = ((Number(openCounts.totalTodayPnl) || 0) / denom) * 100;
    if (totalTodayPct <= -cfg.totalDailyLossPct) reasons.push(`total_daily_loss(${totalTodayPct.toFixed(2)}%)`);
    // v20.9.0 (A2/M2 — THE drawdown kill): PEAK equity se. accounts.js
    // `peakEquity` track karta hai (applyTrade me Math.max) — purana rule
    // start-equity se naapta tha: +30% ke baad -25% (peak se) bhi survive
    // kar leta tha kyunki start se abhi bhi -2% hi tha.
    // v20.9.3 FIX (M): FAIL-CLOSED on unusable peak — pehle invalid/missing
    // peakEquity SILENTLY startEq pe fall karta tha. accounts.js har account
    // creation pe peakEquity seed karta hai (line 37), to missing peak =
    // legacy/corrupt state; shared hardGate (v20.9.1) isi case pe
    // account_state_invalid(peak) block karta hai — ab dono desks same
    // semantics share karte hain (divergent lenient fallback tha).
    const rawPeak = Number(account.peakEquity);
    if (!Number.isFinite(rawPeak) || !(rawPeak > 0)) {
      reasons.push('account_state_invalid(peak)');
    } else {
      const ddPct = drawdownFromPeakPct({ peakEquity: rawPeak, equity: eq });
      if (ddPct != null && ddPct >= cfg.maxDrawdownKillPct) reasons.push(`max_drawdown_kill(${ddPct.toFixed(2)}% from peak)`);
    }
    // v20.9.0 (A2): start-based rule ab alag EQUITY FLOOR hai — "kitna
    // neeche gir sakte ho shuru se" ka hard floor, drawdown se alag.
    const flPct = ((startEq - eq) / startEq) * 100;
    if (flPct >= cfg.equityFloorPct) reasons.push(`equity_floor(${flPct.toFixed(2)}% below start)`);
  }
  // open position caps
  const perBot = Number(openCounts.perBot?.[bot]) || 0;
  if (perBot >= cfg.maxOpenPerBot) reasons.push(`max_open_per_bot(${perBot})`);
  const totalOpen = Number(openCounts.total) || 0;
  if (totalOpen >= cfg.maxOpenTotal) reasons.push(`max_open_total(${totalOpen})`);
  // trades/day cap
  if ((Number(account.tradesToday) || 0) >= cfg.maxTradesPerBotPerDay) reasons.push(`max_trades_per_day(${account.tradesToday})`);
  // re-entry cooldown
  if (account.lastTradeTs && now - Number(account.lastTradeTs) < cfg.reentryCooldownMin * 60000) {
    reasons.push(`reentry_cooldown(${Math.ceil((cfg.reentryCooldownMin * 60000 - (now - account.lastTradeTs)) / 60000)}m left)`);
  }
  // v20.9.0 (A3/M1): event-day blackout — PRE-DECIDER HARD rule for ALL
  // arms. Pehle sirf gated arm ke gates me ctx.eventDay milta tha; rules
  // arm to hamesha 'take' karta tha, aur jev arm ko info hi nahi mili thi
  // (A/B unfair + live risk). botRunner ab `eventGuard` inject karta hai.
  if (opts.eventGuard?.blocked) reasons.push(`event_day_blackout(${opts.eventGuard.label || 'scheduled event'})`);
  // v20.9.0 (A1): consecutive-loss streak (aaj) — caller computes from
  // settled trades of the day and injects (hardGate.currentLossStreak).
  if (Number.isFinite(Number(opts.lossStreak)) && Number(opts.lossStreak) >= cfg.maxConsecutiveLosses) {
    reasons.push(`max_consecutive_losses(${opts.lossStreak})`);
  }
  return reasons;
}

/**
 * v20.8.4 FIX (H3 — paid-call burn): the cheap pre-DECIDER pass. The four
 * account-state check groups above are knowable BEFORE any (paid) Jev call
 * — a jev-armed bot past its 4-trade cap or inside the 30-min cooldown
 * used to spend a Jev API call per candidate and THEN get vetoed by
 * botRiskCheck (same class as the v20.8.2 staleness fix). Fee gate and
 * staleness stay POST-decider (they need candidate sizing / feed context).
 * v20.9.0: eventGuard + lossStreak bhi pre-decider (audit A3/A1).
 */
export function botRiskPreCheck(a = {}) {
  const {
    cfg = BOT_RISK_DEFAULTS, bot = '?', account = {}, openCounts = {},
    now = Date.now(), eventGuard = null, lossStreak = null,
  } = a;
  const reasons = _accountStateReasons(cfg, bot, account, openCounts, now, { eventGuard, lossStreak });
  return { ok: reasons.length === 0, reasons, pre: true };
}

/**
 * THE HARD CHECK — runs AFTER the decider approves, BEFORE exec.
 * Nothing here consults an LLM. Nothing here can be talked around.
 *
 * @param {object} a
 *   cfg        botRiskConfig()
 *   bot        bot id ('orb_in', ...)
 *   account    { equity, startingEquity, peakEquity, todayPnl, tradesToday, lastTradeTs }
 *   openCounts { perBot: {bot: n}, total, totalTodayPnl, totalTodayStartEq }
 *   feedAgeSec seconds since last candle/tick (null = unknown)
 *   now        epoch ms
 *   killSwitches { active: Set<string>|array, anyActive: bool }
 *   feeGate    { expectedGross, roundTripCost } (from tradingCosts)
 *   eventGuard { blocked, label } (pre-decider me bhi ja chuka hota hai;
 *               yahan phir se — decider ke dauran window shift ho sakti hai)
 *   lossStreak number (aaj ka consecutive-loss streak)
 */
export function botRiskCheck(a = {}) {
  const {
    cfg = BOT_RISK_DEFAULTS, bot = '?', account = {}, openCounts = {},
    feedAgeSec = null, now = Date.now(), killSwitches = {}, feeGate = null,
    eventGuard = null, lossStreak = null,
  } = a;
  const reasons = [];

  // 1. kill switch (file / UI / Telegram all funnel here)
  const ks = killSwitches.active;
  const ksHit = killSwitches.anyActive
    || (ks && (Array.isArray(ks) ? ks.includes(bot) : ks.has?.(bot)))
    || (ks === true);
  if (ksHit) reasons.push('kill_switch');

  // 2-7. account state (shared with the pre-decider pass — v20.8.4)
  reasons.push(..._accountStateReasons(cfg, bot, account, openCounts, now, { eventGuard, lossStreak }));

  // 8. stale feed (plan §9 flow step 1: purana feed = no trade)
  // v20.8.2 FIX (H2 — double standard): the tick pre-check allows
  // staleFeedSeconds + one 5m interval — the runner passes feedMaxAgeSec.
  const maxAge = Number(a.feedMaxAgeSec) > 0 ? Number(a.feedMaxAgeSec) : cfg.staleFeedSeconds;
  if (feedAgeSec != null && feedAgeSec > maxAge) reasons.push(`stale_feed(${Math.round(feedAgeSec)}s)`);

  // 9. fee gate (plan §11.2): expected_gross > minEdgeOverCostMult * round_trip_cost
  // v20.8.1 FIX (H3): cost fail-CLOSED.
  // v20.9.0 FIX (A4/M3): EDGE bhi fail-closed — `Number.isFinite(eg) && ...`
  // ki wajah se NaN/undefined expectedGross SILENTLY pass ho jata tha.
  if (feeGate) {
    const eg = Number(feeGate.expectedGross), rcRaw = feeGate.roundTripCost;
    const uncomputable = rcRaw == null || !Number.isFinite(Number(rcRaw));
    const rc = Number(rcRaw);
    if (uncomputable) {
      reasons.push('fee_gate:cost_uncomputable');
    } else if (!Number.isFinite(eg)) {
      // v20.9.0: edge uncomputable (unvalidated pWin → expectedGross null)
      // = NO trade. A non-number expected edge is not permission.
      reasons.push('fee_gate:edge_uncomputable');
    } else if (!(eg > cfg.minEdgeOverCostMult * rc)) {
      reasons.push(`fee_gate(edge ${eg.toFixed(2)} <= ${cfg.minEdgeOverCostMult}x cost ${rc.toFixed(2)})`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Fee-gate inputs (plan §11.2): expected_gross from BACKTEST p_win,
 * never from Jev's claimed probability.
 *   expected_gross = p_win * reward - (1 - p_win) * risk
 * v20.9.0 (B3): pWin NULL (unvalidated) → null return (fee gate
 * fail-closed upstream). Default 0.35 ki jagah caller per-arm OOS
 * Wilson-LB pWin deta hai — nahi mila to null.
 */
export function expectedGross({ pWin, rewardMoney, riskMoney }) {
  // v20.9.0 (B3): pWin NULL (unvalidated) → null return (fee gate
  // fail-closed upstream). Number(null) === 0 hota hai — explicit null
  // guard zaroori (0 ek VALID pWin hai, null nahi).
  const p = pWin == null ? null : Number(pWin);
  const rw = Number(rewardMoney), rk = Number(riskMoney);
  if (!Number.isFinite(p) || !Number.isFinite(rw) || !Number.isFinite(rk)) return null;
  if (p < 0 || p > 1) return null;
  return p * rw - (1 - p) * rk;
}

/**
 * v20.9.0 (B3 — honest pWin): per-bot AND per-arm, out-of-sample half
 * se, Wilson lower bound ke saath. Backtest route ab
 * st.backtest.arms[arm] = { pWinOos, nOos } persist karta hai
 * (metrics.halves.test). Validation bar: nOos >= minN (default 30).
 * Unvalidated → null (LIVE me fee-gate veto, PAPER me conservative
 * floor + pwin_unvalidated stamp — botRunner decide karta hai).
 */
export function validatedPWin(st, arm = null, { minN = 30 } = {}) {
  const arms = st?.backtest?.arms;
  if (arms && typeof arms === 'object') {
    // v20.9.1 [M]: arm EXPLICITLY maanga gaya hai par uska slot missing hai
    // (e.g. jev-armed bot jiska last backtest Jev ke bina chala) — pehle
    // doosre arm (gated) ki pWin SILENTLY borrow ho jati thi (fee gate ko
    // jev arm ka overstated edge dikhta tha). Fail-closed null.
    if (arm != null && !arms[arm]) return null;
    const slot = arm != null && arms[arm] ? arms[arm] : (arms.gated || arms.rules);
    const p = Number(slot?.pWinOos), n = Number(slot?.nOos);
    if (Number.isFinite(p) && p > 0 && p < 1 && Number.isFinite(n) && n >= minN) {
      return wilsonLowerBound(Math.round(p * n), n);
    }
    return null;
  }
  // legacy state (v20.8.1-v20.8.5 single pWin, in-sample whole-period):
  // wo OOS nahi hai — validated nahi mana jayega (audit B3: "in-sample
  // hota hai (optimistic)").
  return null;
}

/** Position sizing for the live runner (risk-based, leverage-capped). */
export function sizePosition({ equity, riskPerTradePct, stopDistance, price, leverage = 1, maxLeverage = 3, qtyUnitMin = 0, qtyUnitMax = null }) {
  const eq = Number(equity), rp = Number(riskPerTradePct), sd = Number(stopDistance), pr = Number(price);
  if (![eq, rp, sd, pr].every(Number.isFinite) || eq <= 0 || rp <= 0 || sd <= 0 || pr <= 0) return null;
  const lev = Math.max(1, Math.min(Number(leverage) || 1, Number(maxLeverage) || 3));
  const riskMoney = eq * (rp / 100);
  let qty = riskMoney / sd;
  const notional = qty * pr;
  const maxNotional = eq * lev;
  if (notional > maxNotional) {
    // leverage cap shrinks size — the ACHIEVED risk then shrinks too;
    // we report it so the "position cap ne risk shrink kiya" named bug
    // (plan §7.5#4) stays visible instead of silent.
    qty = maxNotional / pr;
  }
  if (qtyUnitMin > 0 && qty < qtyUnitMin) {
    // v20.8.1 FIX (H3 — engine parity): the 1-unit floor can INFLATE
    // risk far past the configured pct (engine skips those trades as
    // 'below_min_unit_and_ceiling'). Live now applies the same rule:
    // floor only while the achieved risk stays within qtyUnitMax x
    // target, else refuse the trade.
    const inflatedRisk = qtyUnitMin * sd;
    const maxInflated = (qtyUnitMax != null ? qtyUnitMax : 3) * riskMoney;
    if (inflatedRisk > maxInflated) {
      return { skip: 'sizing_over_risk', wouldRiskPct: (inflatedRisk / eq) * 100 };
    }
    qty = qtyUnitMin;
  }
  const achievedRiskMoney = qty * sd;
  return {
    qty: Math.round(qty * 1e6) / 1e6,
    leverage: lev,
    achievedRiskPct: (achievedRiskMoney / eq) * 100,
    riskShrunkByCap: achievedRiskMoney < riskMoney * 0.999,
    riskInflatedByMinUnit: achievedRiskMoney > riskMoney * 1.001,
    notional: qty * pr,
  };
}
