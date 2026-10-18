// ============================================================
// server/bots/core/audit.js — Jev Bot Lab v20.8.1
// ------------------------------------------------------------
// Plan §7.6 MECHANICAL AUDIT: an INDEPENDENT verifier that re-checks
// every recorded trade using only the OHLC data.
//
// v20.8.1 FIX (H1 — the old "verifier" audited the strategy against
// ITSELF): expectedStop/expectedTarget are stamped on the trade BY the
// strategy, so a fabricated trade with consistently fabricated fields
// passed 100%. The auditor now re-derives levels from CANDLES when
// ctx.bars is provided:
//   • ORB ranges re-derived from the 09:15-09:30 (or session-open)
//     window of the actual bars
//   • LVL prior-session [L,H] re-derived from the previous session
//   • entry must equal the NEXT bar's open (no same-bar lookahead)
//   • exit must lie within the exit bar's [low, high]
//   • exit must be the FIRST stop/target hit (pessimistic ambiguous)
// The legacy no-bars path keeps the expected* cross-checks (still
// catches corruption) but is no longer the primary mode — the CLI and
// API pass bars.
// Tolerance: 1e-3 on price levels (plan §7.5#10, 4dp rounding).
// ============================================================
import { nn, istDayKey, utcDayKey } from './features.js';
import { istMinutes, istDate } from './engine.js';

const TOL = 1e-3;

// ---------------- candle-derived independent facts ----------------

/** Index bars by timestamp for O(1) lookups. */
function indexBars(bars) {
  const byT = new Map();
  for (let i = 0; i < bars.length; i++) byT.set(nn(bars[i].time), i);
  return byT;
}

/** First bar strictly AFTER ts (the fill bar), or null. */
function fillBar(bars, byT, ts) {
  const i = byT.get(nn(ts));
  if (i == null) return null;
  return bars[i + 1] || null;
}

/** ORB opening-range re-derivation (india: 09:15-09:30 IST window;
 *  crypto: the session's first `rangeMinutes`). */
function orbRange(bars, byT, ts, { desk, rangeMinutes = 15, offsetMin = 0 }) {
  const i = byT.get(nn(ts));
  if (i == null) return null;
  const dayOf = (t) => (desk === 'india' ? istDayKey(t) : Math.floor((t - offsetMin * 60000) / 86400000));
  const sess = dayOf(nn(bars[i].time));
  if (sess == null) return null;
  let orHigh = null, orLow = null;
  for (let j = 0; j < bars.length; j++) {
    const t = nn(bars[j].time);
    if (t == null || dayOf(t) !== sess) continue;
    let inWindow = false;
    if (desk === 'india') {
      const m = istMinutes(t);
      inWindow = m != null && m >= 9 * 60 + 15 && m < 9 * 60 + 15 + rangeMinutes;
    } else {
      const d = new Date(t - offsetMin * 60000);
      inWindow = (d.getUTCHours() * 60 + d.getUTCMinutes()) < rangeMinutes;
    }
    if (!inWindow) continue;
    const h = nn(bars[j].high), l = nn(bars[j].low);
    if (h != null) orHigh = orHigh == null ? h : Math.max(orHigh, h);
    if (l != null) orLow = orLow == null ? l : Math.min(orLow, l);
  }
  if (orHigh == null || orLow == null || !(orHigh > orLow)) return null;
  return { orHigh, orLow };
}

/** LVL prior-session range re-derivation (the IMMEDIATELY preceding
 *  session only — not every earlier session). */
function priorSessionRange(bars, byT, ts, { desk }) {
  const i = byT.get(nn(ts));
  if (i == null) return null;
  const dayOf = (t) => (desk === 'india' ? istDayKey(t) : utcDayKey(t));
  const sess = dayOf(nn(bars[i].time));
  // walk back to the last bar of the PREVIOUS session
  let prevSess = null;
  for (let j = i - 1; j >= 0; j--) {
    const t = nn(bars[j].time);
    if (t == null) continue;
    const d = dayOf(t);
    if (d !== sess) { prevSess = d; break; }
  }
  if (prevSess == null) return null;
  let H = null, L = null;
  for (let j = 0; j < i; j++) {
    const t = nn(bars[j].time);
    if (t == null || dayOf(t) !== prevSess) continue;
    const h = nn(bars[j].high), l = nn(bars[j].low);
    if (h != null) H = H == null ? h : Math.max(H, h);
    if (l != null) L = L == null ? l : Math.min(L, l);
  }
  if (H == null || L == null || !(H > L)) return null;
  return { H, L };
}

/**
 * Audit a trade list.
 * @param {Array} trades  recorded trades (from engine or CSV-shaped rows)
 * @param {object} ctx    { strategyId, bars?, intervalMin?, minutesFromOpen(t)?,
 *                          lastEntryMinutes?, dayKey(t)?, sessionKey(t)?,
 *                          orb?: {desk, rangeMinutes, offsetMin, targetR},
 *                          lvl?: {entryFracR, stopFracR, targetFracR} }
 * @returns {satisfied, total, failures: [{i, rule, why}]}
 */
export function auditTrades(trades, ctx = {}) {
  const intervalMin = Math.max(1, nn(ctx.intervalMin) ?? 5);
  const bars = Array.isArray(ctx.bars) ? ctx.bars : null;
  const byT = bars ? indexBars(bars) : null;
  const daySeen = new Map(), sessSeen = new Map();
  const failures = [];
  let satisfied = 0;
  const list = Array.isArray(trades) ? trades : [];
  list.forEach((t, idx) => {
    // v20.8.1 FIX (H2): session uses the TRADE's own stamped session
    // first (orbCrypto stamps its UTC-session key) — the old fallback
    // bucketed cross-midnight-UTC sessions by IST date, missing real
    // dupes and creating false ones.
    const day = ctx.dayKey ? ctx.dayKey(t) : istDate(t.tsIn);
    const session = (t.session != null ? t.session : (ctx.sessionKey ? ctx.sessionKey(t) : day));
    const _rec = { ...t, day, session };
    if (!daySeen.has(day)) daySeen.set(day, t.tsIn);
    if (!sessSeen.has(session)) sessSeen.set(session, t.tsIn);

    const fails = [];
    const fail = (rule) => fails.push(rule);

    // ---- universal candle-derived checks (when bars provided) ----
    let fb = null;
    if (bars && byT) {
      fb = fillBar(bars, byT, t.tsIn);
      if (!fb) {
        fail('fill_bar_missing');
      } else {
        // entry must be the NEXT bar's open (no same-bar lookahead)
        if (Math.abs(nn(t.entry) - nn(fb.open)) > TOL) fail('entry_not_next_open');
        // exit must lie inside the exit bar's range
        const eb = byT.get(nn(t.tsOut)) != null ? bars[byT.get(nn(t.tsOut))] : null;
        if (!eb) {
          fail('exit_bar_missing');
        } else {
          const h = nn(eb.high), l = nn(eb.low), x = nn(t.exit);
          if (h == null || l == null || x == null || x > h + TOL || x < l - TOL) fail('exit_outside_bar_range');
          // exit must be the FIRST stop/target hit from the fill bar
          const dir = t.side === 'LONG' ? 1 : -1;
          const iFill = byT.get(nn(fb.time));
          const iExit = byT.get(nn(t.tsOut));
          if (iFill != null && iExit != null && iExit >= iFill && nn(t.stop) != null) {
            for (let j = iFill; j < iExit; j++) {
              const h2 = nn(bars[j].high), l2 = nn(bars[j].low);
              if (h2 == null || l2 == null) continue;
              const stopped = dir === 1 ? l2 <= t.stop : h2 >= t.stop;
              const targeted = nn(t.target) != null ? (dir === 1 ? h2 >= t.target : l2 <= t.target) : false;
              if (stopped || targeted) { fail('exit_not_first_hit'); break; }
            }
            // ambiguous exit bar must be booked pessimistic (stop)
            const h3 = nn(eb.high), l3 = nn(eb.low);
            const stoppedNow = dir === 1 ? l3 <= t.stop : h3 >= t.stop;
            const targetedNow = nn(t.target) != null ? (dir === 1 ? h3 >= t.target : l3 <= t.target) : false;
            if (stoppedNow && targetedNow && t.exitWhy !== 'stop') fail('ambiguous_not_pessimistic');
          }
        }
      }
    }

    // ---- strategy-specific independent re-derivation ----
    const sid = ctx.strategyId;
    if (sid === 'orb_in' || sid === 'orb_crypto') {
      const oc = ctx.orb || {};
      const desk = oc.desk || (sid === 'orb_in' ? 'india' : 'crypto');
      const rangeMinutes = oc.rangeMinutes || (sid === 'orb_in' ? 15 : 30);
      const range = bars ? orbRange(bars, byT, t.tsIn, { desk, rangeMinutes, offsetMin: oc.offsetMin || 0 }) : null;
      if (range) {
        const stopShould = t.side === 'LONG' ? range.orLow : range.orHigh;
        const iSig = byT.get(nn(t.tsIn));
        const c = iSig != null ? nn(bars[iSig].close) : null;
        if (Math.abs(nn(t.stop) - stopShould) > TOL) fail('stop_at_range_edge');
        if (c != null) {
          const targetR = oc.targetR || 2.0;
          const targetShould = t.side === 'LONG' ? c + targetR * Math.abs(c - stopShould) : c - targetR * Math.abs(c - stopShould);
          if (nn(t.target) != null && Math.abs(nn(t.target) - targetShould) > Math.max(TOL, 1e-3 * Math.abs(targetShould))) fail('target_2r');
        }
      } else if (t.expectedStop != null) {
        // legacy (no bars): cross-check the strategy's own stamps
        if (Math.abs(nn(t.stop) - nn(t.expectedStop)) > TOL) fail('stop_at_range_edge');
        if (t.expectedTarget != null && Math.abs(nn(t.target) - nn(t.expectedTarget)) > TOL) fail('target_2r');
      }
      if (t.rangeSizeAtr != null && !(t.rangeSizeAtr >= 0.5 - TOL)) fail('range_size_in_band');
      if (sid === 'orb_in') {
        // v20.8.1: minutes-from-open is SELF-COMPUTED from the trade's own
        // timestamp when ctx doesn't provide it — the auditor no longer
        // depends on the caller remembering the helper (the CLI forgot it
        // and every audit printed a meaningless 0/N). ctx helper contract:
        // minutesFromOpen(tsIn) -> minutes.
        const mIst = istMinutes(t.tsIn);
        const mfo = ctx.minutesFromOpen ? ctx.minutesFromOpen(t.tsIn) : (mIst != null ? mIst - (9 * 60 + 15) : null);
        // v20.8.1 FIX (H2): window tolerance is one INTERVAL, not +2 min —
        // the engine fills one bar later, so a legit 11:30 signal fills at
        // 11:35 and the old +2 window flagged it.
        if (mfo != null && mfo > (ctx.lastEntryMinutes ?? 135) + intervalMin) fail('entry_before_last_entry');
        if (mfo != null && mfo < 0) fail('entry_after_open');
        const firstOfDay = daySeen.get(day);
        if (firstOfDay != null && firstOfDay !== t.tsIn) fail('one_attempt_per_day');
      } else {
        const firstOfSess = sessSeen.get(session);
        if (firstOfSess != null && firstOfSess !== t.tsIn) fail('one_per_session');
      }
      if (t.confirmOutside !== true) fail('confirm_close_outside');
    } else if (sid === 'lvl') {
      const lc = ctx.lvl || {};
      const desk = lc.desk || 'crypto';
      const pr = bars ? priorSessionRange(bars, byT, t.tsIn, { desk }) : null;
      if (pr) {
        const R = pr.H - pr.L;
        const eF = lc.entryFracR ?? 0.25, sF = lc.stopFracR ?? 0.125, tF = lc.targetFracR ?? 0.50;
        const entryShould = t.side === 'LONG' ? pr.L + eF * R : pr.H - eF * R;
        const stopShould = t.side === 'LONG' ? pr.L + sF * R : pr.H - sF * R;
        const targetShould = t.side === 'LONG' ? pr.L + tF * R : pr.H - tF * R;
        // v20.8.1 FIX (H2): the engine FILLS at the next bar's open, so the
        // recorded entry legitimately differs from the intended level —
        // audit the fill against the re-derived next open (above) and the
        // intended level here, each within a realistic band.
        if (Math.abs(nn(t.stop) - stopShould) > Math.max(TOL, 1e-3 * R)) fail('stop_offset');
        if (nn(t.target) != null && Math.abs(nn(t.target) - targetShould) > Math.max(TOL, 1e-3 * R)) fail('target_offset');
        if (t.expectedEntry != null && Math.abs(nn(t.expectedEntry) - entryShould) > Math.max(TOL, 1e-3 * R)) fail('entry_offset');
      } else {
        if (t.expectedStop != null && Math.abs(nn(t.stop) - nn(t.expectedStop)) > TOL) fail('stop_offset');
        if (t.expectedTarget != null && Math.abs(nn(t.target) - nn(t.expectedTarget)) > TOL) fail('target_offset');
        if (t.expectedEntry != null && Math.abs(nn(t.entry) - nn(t.expectedEntry)) > Math.max(TOL, 0.05 * Math.abs(nn(t.entry) - nn(t.stop) || 1))) fail('entry_offset');
      }
      if ((t.sweepAtr ?? -1) < (t.minSweepAtr ?? 0) - TOL) fail('sweep_beyond_level');
      if (t.closeBackInside !== true) fail('close_back_inside');
    }

    if (fails.length) failures.push({ i: idx, rule: fails[0], why: `trade ${t.symbol}@${t.tsIn} (${fails.join(',')})` });
    else satisfied++;
  });
  return { satisfied, total: list.length, failures };
}

/** Format "N/N satisfied" (plan's reporting contract). */
export function auditLine(a) {
  return `${a.satisfied}/${a.total} satisfied`;
}

/** CSV export for the audit script (scripts/botlab-backtest.mjs). */
export function tradesToCsv(trades) {
  // v20.8.1 FIX (L): exitWhy appeared twice in the column list.
  const cols = ['symbol', 'side', 'tsIn', 'tsOut', 'entry', 'stop', 'target', 'exit', 'exitWhy', 'qty', 'rGross', 'rNet', 'ambiguous'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const t of trades || []) lines.push(cols.map(c => esc(t[c])).join(','));
  return lines.join('\n');
}
