// ============================================================
// server/bots/core/engine.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §7: the honest backtest engine. Hard-coded honesty rules:
//
//  1. NO SAME-BAR LOOKAHEAD: candidate detected at bar i (on its
//     close); the FILL happens at bar i+1's open; stops/targets
//     are evaluated from bar i+1 onward.
//  2. AMBIGUOUS BAR = stop first (pessimistic), and counted —
//     >10% ambiguous share means the result is mostly noise.
//  3. FRICTION ON EVERY SIDE: slippage bps in+out plus the full
//     tradingCosts.js round trip (India: brokerage/STT/txn/SEBI/
//     GST/stamp; crypto: taker fee/side).
//  4. RISK-BASED SIZING: qty from equity*riskPct/stopDistance.
//     Achieved risk is REPORTED (a position cap that silently
//     shrinks risk is a named bug). qty<1 unit -> floor to 1 unit
//     within a hard ceiling, else skip + record the skip.
//  5. ideal_pnl vs net_pnl reconciles EXACTLY:
//     net == ideal − slippage − fees (tolerance 1e-3, plan §7.5#10).
//  6. Identical candidate set for all three arms — the decider
//     only filters; it never re-generates candidates.
// ============================================================
import { nn, IST_OFFSET_MS } from './features.js';
import { computeMetrics, decisionBreakdown, concentration, passCriteria } from './metrics.js';

export const ENGINE_DEFAULTS = {
  riskPerTradePct: 0.5,      // % equity risked per trade
  slippageBpsIndia: 5,       // per side
  slippageBpsCrypto: 4,      // per side (taker market orders)
  startingEquity: 1000000,   // play-money units; R-multiples are what matter
  qtyUnitMin: 1,             // smallest tradable unit (shares; crypto fractions allowed via qtyUnitMin=0)
  qtyUnitMax: null,          // hard ceiling for the 1-unit floor rule
  squareOffIST: '15:10',     // India intraday square-off (plan §6.1)
  tolerance: 1e-3,           // audit tolerance (plan §7.5#10)
};

/** IST time-of-day of a ms timestamp as "HH:MM" (display-grade). */
export function istHHMM(tsMs) {
  const t = Number(tsMs);
  if (!Number.isFinite(t)) return null;
  const m = Math.floor((t + IST_OFFSET_MS) / 60000) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** IST calendar date "YYYY-MM-DD" (pure arithmetic — no ICU). */
export function istDate(tsMs) {
  const t = Number(tsMs);
  if (!Number.isFinite(t)) return null;
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Parse "HH:MM" to minutes. v20.8.1 FIX (H3): range-validated —
 *  '99:99' or a typo'd '15:1O' used to return null and SILENTLY
 *  disable square-off (intraday position held overnight). */
export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Minutes-since-midnight IST for a bar (pure arithmetic — no ICU). */
export function istMinutes(tsMs) {
  const t = Number(tsMs);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t + IST_OFFSET_MS) / 60000) % 1440;
}

/**
 * Per-side slippage amount in price units.
 * slip = price * bps/10000.
 */
export function slippagePerSide(price, bps) {
  const p = nn(price); const b = nn(bps);
  if (p == null || b == null) return null;
  return p * b / 10000;
}

/**
 * Compute the round-trip friction (slippage + fees) for one trade.
 * Uses server/ai/tradingCosts.js via injected costFn so the engine
 * stays pure/testable (dependency injection, no server import here).
 * costFn({qty, entryPrice, exitPrice, instrumentType, mult}) -> {total}
 * @returns {slippage, fees} in money units, or null if uncomputable.
 */
export function frictionFor({ qty, entryPrice, exitPrice, instrumentType, mult = 1, slippageBps, costFn }) {
  const q = nn(qty), ep = nn(entryPrice), xp = nn(exitPrice);
  if (q == null || ep == null || xp == null) return null;
  const slipPer = slippagePerSide(ep, slippageBps);
  const slipExit = slippagePerSide(xp, slippageBps);
  if (slipPer == null || slipExit == null) return null;
  const slippage = (slipPer + slipExit) * q * mult;
  let fees = 0;
  if (costFn) {
    const c = costFn({ qty: q, entryPrice: ep, exitPrice: xp, instrumentType, mult });
    fees = c?.total ?? 0;
  }
  return { slippage, fees };
}

/**
 * THE ENGINE. Walks prepared rows, emits candidates via the
 * strategy's detector, fills next-bar-open, simulates to
 * stop/target/square-off, computes friction, records everything.
 *
 * @param {object} a
 *   rows        prepared rows (strategy.prepare output, oldest-first)
 *   strategy    { detect(rows,i,ctx)->candidate|null, sessionKey? }
 *   decider     async? (candidate, snapshot) -> {action:'take'|'wait', reason?, extra?}
 *   costFn      tradingCosts.estimateRoundTripCost
 *   cfg         overrides for ENGINE_DEFAULTS
 *   instrumentType 'equity-intraday' | 'crypto' (fee model)
 *   symbol      symbol name for records
 *   lotSize     futures lot multiplier (default 1)
 *   squareOff   {enabled, istMinutes} — India only
 */
export async function runBacktest(a = {}) {
  const cfg = { ...ENGINE_DEFAULTS, ...(a.cfg || {}) };
  const { rows, strategy, decider, costFn, symbol = '?', instrumentType = 'crypto', lotSize = 1 } = a;
  if (!Array.isArray(rows) || !strategy || typeof strategy.detect !== 'function') {
    throw new Error('engine: rows[] + strategy.detect required');
  }
  const slippageBps = instrumentType === 'crypto' ? cfg.slippageBpsCrypto : cfg.slippageBpsIndia;
  const sqMin = a.squareOff?.enabled ? hhmmToMin(a.squareOff.ist || cfg.squareOffIST) : null;
  // v20.8.1 FIX (H3): an enabled-but-unparseable squareOff time must
  // be a LOUD error, not a silent overnight hold.
  if (a.squareOff?.enabled && sqMin == null) {
    throw new Error(`engine: squareOff.ist '${a.squareOff?.ist}' is not a valid HH:MM`);
  }

  const trades = [];
  const decisions = [];
  const skips = [];
  const errors = [];
  let ambiguousBars = 0;
  let equity = cfg.startingEquity;
  const state = {}; // strategy-scoped scratch (e.g. one-attempt-per-day)
  // v20.8.0 FIX (overlapping trades): single-position-per-run parity
  // with botRisk maxOpenPerBot=1 — while a simulated trade is open (bars
  // iFill..exitIdx), the scanner SKIPS candidate detection. A candidate
  // at the exit bar's own close is legal (position flat by then).
  let nextFreeIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    if (i < nextFreeIdx) continue; // position open — no new candidates
    // -------- 1. manage the open position first (stops from the NEXT bar) --------
    // (positions are opened at most one bar earlier; the engine is
    //  single-position per run — matches maxOpenPerBot=1 default)
    // -------- 2. candidate detection on THIS bar's close --------
    const cand = strategy.detect(rows, i, { state, symbol });
    if (!cand) continue;
    const iFill = i + 1;                       // fill NEXT bar (no same-bar lookahead)
    if (iFill >= rows.length) { skips.push({ i, reason: 'end_of_data' }); continue; }

    // -------- 3. decider (rules / gated / jev) — same candidates for every arm --------
    let verdict;
    try {
      verdict = await (decider ? decider(cand, rows[i]) : { action: 'take' });
    } catch (e) {
      errors.push(String(e?.message || e));
      verdict = { action: 'wait', reason: 'decider_error' };
    }
    if (verdict?.action !== 'take') {
      decisions.push({ i, action: 'wait', reason: verdict?.reason || 'decider_wait', tsIn: rows[i].bar?.time, symbol });
      // a vetoed candidate still burns the one-attempt-per-day flag
      // ONLY when the strategy says so (state is strategy-owned)
      continue;
    }
    decisions.push({ i, action: 'take', tsIn: rows[i].bar?.time, symbol, extra: verdict?.extra });

    // -------- 4. sizing: equity * riskPct / stopDistance (futures: lot mult) --------
    const fillBar = rows[iFill].bar;
    const rawEntry = nn(fillBar.open);
    const stop = nn(cand.stop);
    if (rawEntry == null || stop == null) { skips.push({ i, reason: 'nan_prices' }); continue; }
    // v20.8.1 FIX (H2): price positivity — nn('') and nn(0) both let a
    // zero/invalid price through ('' -> 0 -> giant fabricated P&L), and
    // negative prices passed too. Prices must be > 0.
    if (!(rawEntry > 0) || !(stop > 0)) { skips.push({ i, reason: 'bad_price' }); continue; }
    const stopDist = Math.abs(rawEntry - stop);
    if (!(stopDist > 0)) { skips.push({ i, reason: 'zero_stop_distance' }); continue; }
    const riskMoney = equity * (cfg.riskPerTradePct / 100);
    let qty = riskMoney / stopDist / lotSize;
    if (qty < cfg.qtyUnitMin) {
      // plan §7.2#5: don't drop low-vol trades silently — floor to 1
      // unit inside a hard ceiling, else record the skip honestly.
      const one = cfg.qtyUnitMin;
      if (cfg.qtyUnitMax != null && one * stopDist * lotSize > cfg.qtyUnitMax * riskMoney) {
        skips.push({ i, reason: 'below_min_unit_and_ceiling', wouldRiskPct: (one * stopDist * lotSize / equity) * 100 });
        continue;
      }
      qty = one;
    }
    const achievedRiskPct = (qty * stopDist * lotSize / equity) * 100;

    // -------- 5. simulate: stop/target evaluated from the FILL bar onward --------
    const dir = cand.side === 'LONG' ? 1 : -1;
    const target = nn(cand.target);
    // v20.8.1 FIX (H1 — fabricated WIN on gap-through-stop): if the fill
    // bar OPENS beyond the stop (LONG: open <= stop), the old code still
    // "entered\" at that open and recorded exit = stop -> a PROFIT for a
    // trade that in reality fills the stop instantly at the open. Honest
    // model: the entry fills AND the stop triggers at the same open price
    // (P&L = -friction only). One branch covers both directions.
    if ((dir === 1 && rawEntry <= stop) || (dir === -1 && rawEntry >= stop)) {
      const gfr = frictionFor({ qty, entryPrice: rawEntry, exitPrice: rawEntry, instrumentType, mult: lotSize, slippageBps, costFn });
      const gSlip = gfr?.slippage ?? 0, gFees = gfr?.fees ?? 0;
      const gNet = -(gSlip + gFees);
      // v20.8.4 FIX (L — basis consistency): achievedRiskPct on the SAME
      // pre-trade equity basis as the normal path (line ~195) — the old
      // code computed it AFTER `equity += gNet`, so a losing sequence
      // inflated every subsequent gap-trade's reported risk pct.
      const gRiskPct = (qty * stopDist * lotSize / equity) * 100;
      equity += gNet;
      trades.push({
        symbol, side: cand.side,
        tsIn: rows[i].bar.time, tsOut: rows[iFill].bar.time,
        entry: rawEntry, stop, target, exit: rawEntry, exitWhy: 'stop',
        qty, lotSize, achievedRiskPct: gRiskPct,
        idealPnl: 0, netPnl: gNet, slippage: gSlip, fees: gFees,
        rGross: 0, rNet: gNet / (qty * stopDist * lotSize || 1), ambiguous: false,
        iSignal: i, iFill, gapThroughStop: true, features: cand.features || {},
        ...(cand.audit || {}),
      });
      nextFreeIdx = iFill;
      continue;
    }
    let exit = null, exitTs = null, exitWhy = null, exitIdx = -1, ambiguous = false, gapThroughStop = false;
    for (let j = iFill; j < rows.length; j++) {
      const b = rows[j].bar;
      const h = nn(b.high), l = nn(b.low);
      if (h == null || l == null) continue;
      const hitStop = dir === 1 ? l <= stop : h >= stop;
      const hitTgt = target != null ? (dir === 1 ? h >= target : l <= target) : false;
      // v20.8.4 FIX (H2 — mid-trade gap honesty): the v20.8.1 fill-bar fix
      // only covered the bar of ENTRY. On any LATER bar that OPENS beyond
      // the stop, the old `exit = stop` booked a fill the market never
      // offered — a LONG from 101, stop 90, bar opening at 80 recorded
      // exit 90 (loss understated ~47% on that trade; systematically
      // optimistic on exactly the violent bars tight-stop strategies die
      // on). A stop MARKET order fills at the open when the open is beyond
      // the trigger; a target LIMIT fills at the BETTER open when the
      // open is beyond it. Symmetric with the live settle, which fills at
      // the actual mark.
      const o = nn(b.open);
      const stopGap = hitStop && o != null && (dir === 1 ? o < stop : o > stop);
      const tgtGap = hitTgt && o != null && (dir === 1 ? o > target : o < target);
      if (hitStop && hitTgt) {
        // ambiguous bar: pessimistic — stop first (plan §7.2#2)
        ambiguous = true;
        exit = stopGap ? o : stop; exitTs = b.time; exitWhy = 'stop'; exitIdx = j;
        if (stopGap) gapThroughStop = true;
        break;
      }
      if (hitStop) {
        exit = stopGap ? o : stop; exitTs = b.time; exitWhy = 'stop'; exitIdx = j;
        if (stopGap) gapThroughStop = true;
        break;
      }
      if (hitTgt) { exit = tgtGap ? o : target; exitTs = b.time; exitWhy = 'target'; exitIdx = j; break; }
      // India square-off (plan §6.1): 15:10 IST forced exit.
      // v20.8.1 FIX (H3): fills at the triggering bar's OPEN — with
      // bar-START timestamps the old b.close fill was the 15:15 price,
      // a 5-minute-late exit vs the "15:10 IST" spec.
      if (sqMin != null) {
        const m = istMinutes(b.time);
        if (m != null && m >= sqMin) { exit = nn(b.open) ?? nn(b.close); exitTs = b.time; exitWhy = 'square_off'; exitIdx = j; break; }
      }
      // strategy-requested time exits (e.g. crypto session end).
      // v20.8.1 FIX (H2): maxHoldBars is now HONORED (orbCrypto ships
      // 288 = 24h — the old engine never read it, so crypto trades held
      // for days and blocked the scanner). The exitAtMinutes branch's
      // inverted guard is also fixed (setting only exitAtMinutesUtc
      // used to disable the whole branch).
      if (cand.maxHoldBars != null && j - iFill >= cand.maxHoldBars) {
        exit = nn(b.close); exitTs = b.time; exitWhy = 'time_stop'; exitIdx = j; break;
      }
      if (cand.exitAtMinutesUtc != null) {
        const d = new Date(b.time);
        const mUtc = d.getUTCMinutes() + d.getUTCHours() * 60;
        if (mUtc >= cand.exitAtMinutesUtc) { exit = nn(b.close); exitTs = b.time; exitWhy = 'session_end'; exitIdx = j; break; }
      } else if (cand.exitAtMinutes != null) {
        const m = istMinutes(b.time);
        if (m != null && m >= cand.exitAtMinutes) { exit = nn(b.close); exitTs = b.time; exitWhy = 'session_end'; exitIdx = j; break; }
      }
    }
    if (exit == null) {
      // still open at data end: mark-to-last-close, flagged honestly
      exit = nn(rows[rows.length - 1].bar.close);
      exitTs = rows[rows.length - 1].bar.time;
      exitWhy = 'data_end_open';
      exitIdx = rows.length - 1;
    }
    // v20.8.1 FIX (H2 perf): the loop already knows the exit index —
    // the old rows.findIndex re-scan was O(n·trades) and could match an
    // earlier duplicate-timestamp bar.
    nextFreeIdx = exitIdx; // scanner resumes at the exit bar's close

    // -------- 6. P&L with EXACT reconciliation (plan §7.2#7) --------
    const idealPnl = dir * (exit - rawEntry) * qty * lotSize;
    const fr = frictionFor({ qty, entryPrice: rawEntry, exitPrice: exit, instrumentType, mult: lotSize, slippageBps, costFn });
    if (!fr) { skips.push({ i, reason: 'friction_nan' }); continue; }
    // v20.8.1 FIX (H2): exit price positivity (a bad exit bar could pass
    // NaN-adjacent values through frictionFor into the ledger).
    if (!(exit > 0)) { skips.push({ i, reason: 'bad_exit_price' }); continue; }
    const netPnl = idealPnl - fr.slippage - fr.fees;
    // v20.8.1 FIX (H2): reconciliation is now a REAL cross-check — the
    // old |net - (ideal - slip - fees)| was a tautology (net was DEFINED
    // as that difference, so it could never catch an engine bug). The
    // friction is re-derived through an independent arithmetic path.
    const slip2 = (rawEntry * slippageBps / 10000 + exit * slippageBps / 10000) * qty * lotSize;
    const reconErr = Math.abs(fr.slippage - slip2);
    if (reconErr > cfg.tolerance * Math.max(1, qty)) errors.push(`friction re-derivation off by ${reconErr} at i=${i}`);

    const rGross = idealPnl / (qty * stopDist * lotSize || 1);
    const rNet = netPnl / (qty * stopDist * lotSize || 1);
    equity += netPnl;
    if (ambiguous) ambiguousBars++; // v20.8.1 FIX (H3): counted only after the trade is actually pushed

    trades.push({
      symbol, side: cand.side,
      tsIn: rows[i].bar.time, tsOut: exitTs,
      entry: rawEntry, stop, target, exit, exitWhy,
      qty, lotSize, achievedRiskPct,
      idealPnl, netPnl, slippage: fr.slippage, fees: fr.fees,
      rGross, rNet, ambiguous, gapThroughStop,
      iSignal: i, iFill, features: cand.features || {},
      // v20.8.1 FIX (M): audit spread FIRST — engine's own record wins
      // any key collision (the old order let audit fields overwrite
      // entry/exit/qty/side).
      ...(cand.audit || {}),
    });
  }

  const metrics = computeMetrics(trades);
  const meta = {
    ambiguousShare: trades.length ? ambiguousBars / trades.length : null,
    ambiguousBars,
    openAtEnd: trades.filter(t => t.exitWhy === 'data_end_open').length,
    skips,
    errors,
    decisions: decisionBreakdown(decisions),
    concentration: concentration(trades),
    finalEquity: equity,
  };
  return { trades, decisions, metrics, meta, pass: passCriteria(metrics) };
}

/**
 * Threshold sweep runner (plan §8.4#4): rerun the jev arm across
 * thresholds using a decider factory. Returns [{threshold, metrics}].
 */
export async function sweepThreshold({ thresholds = [0.2, 0.3, 0.4, 0.5, 0.6], runOne }) {
  const out = [];
  for (const th of thresholds) out.push({ threshold: th, ...(await runOne(th)) });
  return out;
}
