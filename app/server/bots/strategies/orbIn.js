// ============================================================
// server/bots/strategies/orbIn.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// ORB-IN (NSE) — plan §6.1, spec-faithful:
//   Opening range   09:15-09:30 IST (15 min; 5/15/30 sweepable)
//   Detection bar   5-min
//   Confirmation    pichli bar range ke andar close, YE bar bahar
//                   close (gap-through days bhi pakadta hai)
//   Entry           confirming bar ke agle bar ka open (engine rule:
//                   no same-bar lookahead)
//   Stop            range ka opposite edge
//   Target          2R (1.5/2/3 sweepable)
//   Range filter    0.5-2.0 x ATR warna us din no trade
//   Last entry      11:30 IST (open + 135 min)
//   Frequency       ek symbol, ek din, ek attempt
//   Square-off      15:10 IST (engine-enforced)
//   Variants        OFF (retest/fakeout baseline honest rahe)
//
// Causality comments (plan §6 requirement) — every indicator:
//   • orHigh/orLow  : only bars INSIDE today's opening window,
//                     all strictly at-or-before the signal bar.
//   • ATR/EMA       : features.js causal series (window ends at
//                     the signal bar; never forward).
//   • priorH/priorL : priorSessionLevels — strictly yesterday.
//   • volRatioTod   : same-time-of-day baseline from PRIOR
//                     sessions only.
// ============================================================
import { nn, prepareShared, finishShared, istDayKey } from '../core/features.js';
import { istMinutes } from '../core/engine.js';
import { makeSnapshot, r4, missingFeatures } from './contract.js';

export const ORB_IN_DEFAULTS = {
  rangeMinutes: 15,        // 09:15 + 15 = 09:30
  targetR: 2.0,
  rangeMinAtr: 0.5,
  rangeMaxAtr: 2.0,
  lastEntryMinutes: 135,   // 11:30 IST
  // v20.8.1 honest-doc FIX (H3): 350 bars on 5-min NSE data = ~4.7
  // trading days (75 bars/day), NOT the "14 days" the old comment
  // claimed (that math was 15-min bars). Value unchanged for behavioral
  // stability; recalibrating to a true 14-day window (1050 bars) is a
  // documented future experiment.
  atrPeriodBars: 350,
};

const OPEN_IST = 9 * 60 + 15; // 09:15
const FEATURES_REQUIRED = [
  'or_size_atr', 'extension_atr', 'trend_align', 'ema_fast_dist_atr', 'ema_slow_dist_atr',
  'vol_ratio_tod', 'upper_wick_pct', 'lower_wick_pct', 'body_pct', 'touches_before_break',
  'overnight_gap_atr', 'dist_pdh_atr', 'dist_pdl_atr', 'room_to_target_atr',
  'minutes_from_open', 'atr_pct',
];

// v20.8.0 PERF: fast integer day key (IST) — no ICU formatting in hot loops.
const sessionKeyIST = (bar) => istDayKey(nn(bar.time));

/** NSE session key fn exported for the candle store / audit ctx. */
export function orbInSessionKey(bar) { return sessionKeyIST(bar); }

export const orbIn = {
  id: 'orb_in',
  desk: 'india',
  instrumentType: 'equity-intraday',
  lotSize: 1,
  // v20.8.2 FIX (H2): the runner's cross-tick one-attempt-per-day
  // persistence gates on strategy.sessionKey — orbIn exported the key
  // fn SEPARATELY (orbInSessionKey) but never set it on the object, so
  // attemptKey was null and the ONLY bot that could trade re-detected
  // the same breakout every 60s and could trade a re-break the backtest
  // suppresses (orbCrypto/lvl both set sessionKey correctly).
  sessionKey: orbInSessionKey,

  prepare(bars, opts = {}) {
    const cfg = { ...ORB_IN_DEFAULTS, ...opts };
    const rows = prepareShared(bars, { atrPeriod: cfg.atrPeriodBars, emaFast: 50, emaSlow: 200 });
    finishShared(rows, bars, { intervalMin: 5, sessionKey: sessionKeyIST });
    // strategy column: per-bar opening-range state for the day
    for (let i = 0; i < rows.length; i++) {
      const bar = rows[i].bar;
      const m = istMinutes(bar.time);
      const day = sessionKeyIST(bar);
      const prev = i > 0 ? rows[i - 1] : null;
      const prevDay = prev ? sessionKeyIST(prev.bar) : null;
      // v20.8.0 FIX (one-attempt-per-day was broken): per-bar range
      // snapshots stay causal (orHigh freezes bar-by-bar), but the
      // attempt flag lives in a SHARED per-day box — a mutation by
      // detect() at bar i must be visible at bar i+1. The old per-bar
      // copy silently reset the flag, so a second breakout the same
      // day could trade twice in the live path too.
      if (prevDay !== day) rows[i]._attempt = { used: false };
      else rows[i]._attempt = prev._attempt;
      if (prevDay !== day) { rows[i]._orb = { day, orHigh: null, orLow: null, rangeDone: false, touches: 0, orBars: 0 }; }
      else rows[i]._orb = { ...prev._orb };
      const orb = rows[i]._orb;
      const inWindow = m != null && m >= OPEN_IST && m < OPEN_IST + cfg.rangeMinutes;
      if (inWindow) {
        const h = nn(bar.high), l = nn(bar.low);
        if (h != null) orb.orHigh = orb.orHigh == null ? h : Math.max(orb.orHigh, h);
        if (l != null) orb.orLow = orb.orLow == null ? l : Math.min(orb.orLow, l);
        orb.orBars++;
      } else if (orb.orHigh != null && !orb.rangeDone) {
        orb.rangeDone = true; // first bar AFTER the window freezes the range (causal)
      }
    }
    return rows;
  },

  /**
   * Detect at bar i's close. Returns a candidate or null.
   * ctx.state is engine-owned scratch (survives across bars).
   */
  detect(rows, i, ctx = {}) {
    const cfg = { ...ORB_IN_DEFAULTS, ...(ctx.cfg || {}) };
    const row = rows[i];
    if (!row || !row._orb) return null;
    const orb = row._orb;
    if (!orb.rangeDone || orb.orHigh == null || orb.orLow == null) return null;
    const bar = row.bar;
    const m = istMinutes(bar.time);
    if (m == null) return null;
    const minutesFromOpen = m - OPEN_IST;
    if (minutesFromOpen > cfg.lastEntryMinutes) return null;       // last-entry cutoff
    if (row._attempt?.used) return null;                           // one attempt/day (shared box)
    if (minutesFromOpen < cfg.rangeMinutes) return null;           // range still forming
    const c = nn(bar.close);
    if (c == null || row.atr == null || !(row.atr > 0)) return null;
    const orSize = orb.orHigh - orb.orLow;
    if (!(orSize > 0)) return null;
    const orSizeAtr = orSize / row.atr;
    if (orSizeAtr < cfg.rangeMinAtr || orSizeAtr > cfg.rangeMaxAtr) { row._attempt.used = true; return null; } // band out => no trade TODAY

    // Confirmation: previous bar closed INSIDE, this bar closed OUTSIDE.
    const prev = rows[i - 1];
    if (!prev) return null;
    const pc = nn(prev.bar.close);
    if (pc == null) return null;
    const prevInside = pc <= orb.orHigh && pc >= orb.orLow;
    if (!prevInside) return null;
    const brokeUp = c > orb.orHigh;
    const brokeDown = c < orb.orLow;
    if (!brokeUp && !brokeDown) return null;
    row._attempt.used = true;

    const side = brokeUp ? 'LONG' : 'SHORT';
    const stop = brokeUp ? orb.orLow : orb.orHigh;
    const stopDist = Math.abs(c - stop);
    if (!(stopDist > 0)) return null;
    const target = brokeUp ? c + cfg.targetR * stopDist : c - cfg.targetR * stopDist;

    const features = this.snapshotFeatures(rows, i, { side, c, stop, stopDist, target, orSize, orSizeAtr, minutesFromOpen, orb });
    // PLAN §5: incomplete features => DROP the candidate, never 0-fill.
    // v20.8.1 FIX: volume-less feeds (NIFTY INDEX returns no volume —
    // med=0 made vol_ratio_tod null for EVERY bar) used to drop every
    // candidate, silently making orb_in a no-op bot. When the feed has
    // NO volume at all, the feature is undefined-by-concept and is
    // excluded from the required list (recorded on the candidate).
    let required = FEATURES_REQUIRED;
    const feedHasVolume = this._feedHasVolume(rows, i);
    if (!feedHasVolume) required = required.filter(k => k !== 'vol_ratio_tod');
    const miss = missingFeatures(features, required);
    if (miss) {
      ctx.state?.droppedByNaN?.push?.({ i, miss });
      return null;
    }
    return {
      symbol: ctx.symbol || '?', side, stop: r4(stop), target: r4(target), entry: r4(c),
      features,
      feedVolumeless: !feedHasVolume,
      audit: {
        expectedStop: r4(stop), expectedTarget: r4(target),
        rangeSizeAtr: r4(orSizeAtr), confirmOutside: true,
      },
      sessionDay: orb.day,
    };
  },

  /** Does ANY bar in today's session carry a real volume? (index
   *  feeds legitimately have none — see detect's required-features
   *  note). */
  _feedHasVolume(rows, i) {
    for (let j = Math.max(0, i - 100); j <= i; j++) {
      if (nn(rows[j]?.bar?.volume) != null) return true;
    }
    return false;
  },

  /** The exact feature set gates AND jev both see (plan §6.1 list). */
  snapshotFeatures(rows, i, x) {
    const row = rows[i];
    const { side, c, stop: _stop, stopDist, target, orSize: _orSize, orSizeAtr, minutesFromOpen, orb } = x;
    const atr = row.atr;
    const dir = side === 'LONG' ? 1 : -1;
    const emaF = row.emaFast, emaS = row.emaSlow;
    const trendAlign = (emaF != null && emaS != null)
      ? (dir === 1 ? (emaF > emaS ? 1 : -1) : (emaF < emaS ? 1 : -1)) : null;
    const overnightGap = (row.priorC != null) ? (rows[i].bar.open != null ? rows[i].bar.open - row.priorC : null) : null;
    const roomToTarget = Math.abs(target - c);
    // touches_before_break: how many bars (post-range, pre-signal)
    // poked beyond the broken edge without closing outside.
    let touches = 0;
    for (let j = i - 1; j >= 0; j--) {
      const rj = rows[j];
      if (!rj?._orb || rj._orb.day !== orb.day) break;
      if (rj._orb.orHigh == null || !rj._orb.rangeDone) break;
      const hj = nn(rj.bar.high), lj = nn(rj.bar.low);
      const cj = nn(rj.bar.close);
      if (cj == null) break;
      if (side === 'LONG' && hj != null && hj > rj._orb.orHigh && cj <= rj._orb.orHigh) touches++;
      if (side === 'SHORT' && lj != null && lj < rj._orb.orLow && cj >= rj._orb.orLow) touches++;
      if (istMinutes(rj.bar.time) != null && istMinutes(rj.bar.time) - OPEN_IST < 0) break;
    }
    const an = row.anatomy || {};
    return {
      or_size_atr: r4(orSizeAtr),
      extension_atr: r4(stopDist > 0 ? (c - (side === 'LONG' ? orb.orHigh : orb.orLow)) / atr * dir : null),
      trend_align: trendAlign,
      ema_fast_dist_atr: r4(emaF != null ? (c - emaF) / atr : null),
      ema_slow_dist_atr: r4(emaS != null ? (c - emaS) / atr : null),
      // v20.8.1 FIX (M): ema_fast_slope_atr is now ACTUALLY produced —
      // the average_not_turning gate read a feature that never existed
      // and silently fell back to raw price-unit slope.
      ema_fast_slope_atr: r4(row.emaFastSlope != null ? row.emaFastSlope / atr : null),
      vol_ratio_tod: r4(row.volRatioTod),
      upper_wick_pct: r4(an.upperWickPct),
      lower_wick_pct: r4(an.lowerWickPct),
      body_pct: r4(an.bodyPct),
      touches_before_break: touches,
      overnight_gap_atr: r4(overnightGap != null && atr > 0 ? overnightGap / atr : null),
      dist_pdh_atr: r4(row.priorH != null ? (row.priorH - c) / atr : null),
      dist_pdl_atr: r4(row.priorL != null ? (c - row.priorL) / atr : null),
      room_to_target_atr: r4(roomToTarget / atr),
      minutes_from_open: minutesFromOpen,
      atr_pct: r4(atr / c * 100),
    };
  },

  snapshot(sym, ts, row, cand) {
    const f = cand?.features || {};
    const lines = [
      `Instrument: ${sym} (NSE), 5-minute bars. Time: ${new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`,
      `Opening range size ${f.or_size_atr} ATR. Price closed ${cand?.side === 'LONG' ? 'above' : 'below'} the range.`,
      `Breakout bar volume is ${f.vol_ratio_tod}x the usual for this time of day.`,
      `Trend align score ${f.trend_align} (fast EMA dist ${f.ema_fast_dist_atr} ATR, slow ${f.ema_slow_dist_atr} ATR).`,
      `Prior day high ${f.dist_pdh_atr} ATR away, prior day low ${f.dist_pdl_atr} ATR away. Overnight gap ${f.overnight_gap_atr} ATR.`,
      `Bar anatomy: body ${f.body_pct}, upper wick ${f.upper_wick_pct}, lower wick ${f.lower_wick_pct}. Prior touches without close: ${f.touches_before_break}.`,
      `Proposed trade: ${cand?.side} entry ~${cand?.entry}, stop ${cand?.stop}, target ${cand?.target} (2R).`,
    ];
    return makeSnapshot({ symbol: sym, ts, proposed: cand?.side === 'LONG' ? 'enter_long' : 'enter_short', features: f, contextLines: lines });
  },

  /** Control-arm gates (plan §6.1) — each returns a stable veto reason. */
  gates() {
    return [
      function average_not_turning(row, ctx = {}) {
        const f = ctx.features || row?.features || {};
        // v20.9.1 [H2]: ema_fast_slope_atr PEHLE SE slope/ATR (dimensionless,
        // typically 0.05-0.6) hai — use ATR se PHIR divide karna double-
        // normalization thi (NIFTY ATR ~50 → ratio ~0.001 vs 0.02 threshold
        // — physically unreachable; orb_in ka gated arm = default arm
        // PERMANENT no-trade tha, rules-vs-gated A/B hi meaningless).
        const slopeAtr = nn(f.ema_fast_slope_atr);
        if (slopeAtr != null) return Math.abs(slopeAtr) >= 0.02 ? null : 'average_not_turning';
        // raw-slope fallback (ctx.emaFastSlope): normalize HERE exactly once
        const raw = nn(ctx.emaFastSlope);
        const atr = nn(row?.atr) ?? nn(f.atr) ?? null;
        if (raw == null || atr == null || !(atr > 0)) return 'average_not_turning:insufficient_data';
        return Math.abs(raw) / atr >= 0.02 ? null : 'average_not_turning';
      },
      function against_trend(row, ctx = {}) {
        const f = ctx.features || row?.features || {};
        const ta = nn(f.trend_align);
        if (ta == null) return 'against_trend:insufficient_data';
        return ta === 1 ? null : 'against_trend';
      },
      function low_volume(row, ctx = {}) {
        const f = ctx.features || row?.features || {};
        const v = nn(f.vol_ratio_tod);
        if (v == null) return 'low_volume:insufficient_data';
        return v >= 1.0 ? null : 'low_volume';
      },
      function blocked_by_level(row, ctx = {}) {
        const f = ctx.features || row?.features || {};
        const room = nn(f.room_to_target_atr);
        const pdh = nn(f.dist_pdh_atr), pdl = nn(f.dist_pdl_atr);
        if (room == null) return 'blocked_by_level:insufficient_data';
        // prior-day level sitting within the target path (<0.25 ATR of path)
        // v20.8.1 FIX (H2 — copy-paste mirror bug): both sides checked BOTH
        // levels, so a prior-day LOW below price vetoed LONGs (and PDH vetoed
        // SHORTs) — systematic over-vetoing that corrupted the gated
        // control arm. LONG checks only the level ABOVE (PDH); SHORT only
        // the level BELOW (PDL).
        const side = ctx.side || (f.trend_align === 1 ? 'LONG' : 'SHORT');
        const inPath = side === 'LONG'
          ? (pdh != null && pdh > 0 && pdh < room - 0.1)
          : (pdl != null && pdl > 0 && pdl < room - 0.1);
        return inPath ? 'blocked_by_level' : null;
      },
      // event_day gate is wired at RUNTIME via eventGuardCheck (needs live
      // event calendar); the static variant here only checks known flags.
      function event_day(row, ctx = {}) {
        if (ctx.eventDay === true) return 'event_day';
        return null;
      },
    ];
  },

  jevPrompt() {
    return {
      instructions: 'A rule-based strategy proposes this opening range breakout trade on an NSE instrument. Decide whether to take it or stand aside.',
      criteria: {
        enter_long: 'Take the long breakout',
        enter_short: 'Take the short breakdown',
        wait: 'Stand aside, setup is weak or likely to fail',
      },
      extra: {
        fakeout_risk: {
          type: 'score',
          instructions: 'How likely is this breakout to fail and reverse into the range?',
          criteria: ['very unlikely', 'unlikely', 'possible', 'likely', 'very likely'],
        },
      },
    };
  },
};

export default orbIn;
