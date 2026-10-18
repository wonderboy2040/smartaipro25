// ============================================================
// server/bots/strategies/orbCrypto.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// ORB-CRYPTO — plan §6.2: same ORB logic, explicit session
// definition (calendar midnight TODO NAHI — plan §5 explicitly
// forbids "session boundary calendar midnight se" as a mistake;
// we test UTC-day / London-open / NY-open as SEPARATE variants
// and track each as its own strategy-variant).
//   • range = session-open ke pehle cfg.rangeMinutes
//   • one-and-done per session (crypto 24/7 => session-scoped)
//   • confirmation: prev close inside, this close outside
//   • stop: opposite range edge; target 2R (sweepable)
//   • crypto taker fees via tradingCosts 'crypto' model
//   • leverage 3x start (botRisk caps at maxLeverageCrypto)
// Causality: identical discipline to orbIn (all windows end at
// the signal bar; prior-session levels strictly prior).
// ============================================================
import { nn, prepareShared, finishShared, utcDayKey as _utcDayKey } from '../core/features.js';
import { makeSnapshot, r4, missingFeatures } from './contract.js';

export const SESSION_VARIANTS = {
  utc: { offsetMin: 0, label: 'UTC day' },
  london: { offsetMin: 8 * 60, label: 'London open (08:00 UTC)' },
  ny: { offsetMin: 13 * 60 + 30, label: 'NY open (13:30 UTC)' },
};

export const ORB_CRYPTO_DEFAULTS = {
  session: 'utc',           // 'utc' | 'london' | 'ny'  (plan: teeno alag variants)
  rangeMinutes: 30,
  targetR: 2.0,
  rangeMinAtr: 0.5,
  rangeMaxAtr: 2.5,         // crypto ranges run wider than NSE open
  // v20.8.1 honest-doc FIX (H3): 2016 bars on 24/7 5-min data = 7 days,
  // NOT the "14 days" the old comment claimed (14d = 4032). Value
  // unchanged for behavioral stability; a true 14-day window is a
  // documented future experiment.
  atrPeriodBars: 2016,
  maxHoldBars: 288,         // 24h max hold => session-scoped trade (v20.8.1: engine now HONORS this)
};

const FEATURES_REQUIRED = ['or_size_atr', 'extension_atr', 'trend_align', 'vol_ratio_tod', 'body_pct', 'room_to_target_atr', 'atr_pct'];

function utcSessionKey(bar, offsetMin) {
  const t = nn(bar.time);
  if (t == null) return null;
  // v20.8.0 PERF: integer session-day key (UTC day of t − offset) —
  // one Date allocation replaced by arithmetic.
  return Math.floor((t - offsetMin * 60000) / 86400000);
}

function utcMinutesIntoSession(bar, offsetMin) {
  const t = nn(bar.time);
  if (t == null) return null;
  const d = new Date(t - offsetMin * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function makeOrbCrypto(overrides = {}) {
  const cfg = { ...ORB_CRYPTO_DEFAULTS, ...overrides };
  const variant = SESSION_VARIANTS[cfg.session] || SESSION_VARIANTS.utc;
  const sKey = (bar) => utcSessionKey(bar, variant.offsetMin);

  const strat = {
    id: `orb_crypto_${cfg.session}`,
    baseId: 'orb_crypto',
    desk: 'crypto',
    instrumentType: 'crypto',
    lotSize: 1,
    sessionVariant: cfg.session,

    sessionKey: sKey,

    prepare(bars, opts = {}) {
      const c = { ...cfg, ...opts };
      const rows = prepareShared(bars, { atrPeriod: c.atrPeriodBars, emaFast: 50, emaSlow: 200 });
      finishShared(rows, bars, { intervalMin: 5, sessionKey: (b) => sKey(b) });
      for (let i = 0; i < rows.length; i++) {
        const bar = rows[i].bar;
        const sess = sKey(bar);
        const prev = i > 0 ? rows[i - 1] : null;
        const prevSess = prev ? sKey(prev.bar) : null;
        // v20.8.0 FIX: one-and-done needs a SHARED per-session attempt
        // box (per-bar copies never see detect()'s mutation).
        if (prevSess !== sess) rows[i]._attempt = { used: false };
        else rows[i]._attempt = prev._attempt;
        if (prevSess !== sess) rows[i]._orb = { sess, orHigh: null, orLow: null, rangeDone: false, orBars: 0 };
        else rows[i]._orb = { ...prev._orb };
        const orb = rows[i]._orb;
        const m = utcMinutesIntoSession(bar, variant.offsetMin);
        if (m != null && m >= 0 && m < c.rangeMinutes) {
          const h = nn(bar.high), l = nn(bar.low);
          if (h != null) orb.orHigh = orb.orHigh == null ? h : Math.max(orb.orHigh, h);
          if (l != null) orb.orLow = orb.orLow == null ? l : Math.min(orb.orLow, l);
          orb.orBars++;
        } else if (orb.orHigh != null && !orb.rangeDone) orb.rangeDone = true;
      }
      return rows;
    },

    detect(rows, i, ctx = {}) {
      const c = { ...cfg, ...(ctx.cfg || {}) };
      const row = rows[i];
      if (!row?._orb) return null;
      const orb = row._orb;
      if (!orb.rangeDone || orb.orHigh == null || orb.orLow == null) return null;
      if (row._attempt?.used) return null; // one-and-done per session (shared box)
      const bar = row.bar;
      const m = utcMinutesIntoSession(bar, variant.offsetMin);
      if (m == null || m < c.rangeMinutes) return null;
      const c0 = nn(bar.close);
      if (c0 == null || row.atr == null || !(row.atr > 0)) return null;
      const orSize = orb.orHigh - orb.orLow;
      if (!(orSize > 0)) return null;
      const orSizeAtr = orSize / row.atr;
      if (orSizeAtr < c.rangeMinAtr || orSizeAtr > c.rangeMaxAtr) { row._attempt.used = true; return null; }

      const prev = rows[i - 1];
      if (!prev) return null;
      const pc = nn(prev.bar.close);
      if (pc == null || pc > orb.orHigh || pc < orb.orLow) return null; // prev must be INSIDE
      const brokeUp = c0 > orb.orHigh, brokeDown = c0 < orb.orLow;
      if (!brokeUp && !brokeDown) return null;
      row._attempt.used = true;

      const side = brokeUp ? 'LONG' : 'SHORT';
      const stop = brokeUp ? orb.orLow : orb.orHigh;
      const stopDist = Math.abs(c0 - stop);
      if (!(stopDist > 0)) return null;
      const target = brokeUp ? c0 + c.targetR * stopDist : c0 - c.targetR * stopDist;

      const an = row.anatomy || {};
      const dir = side === 'LONG' ? 1 : -1;
      const features = {
        or_size_atr: r4(orSizeAtr),
        extension_atr: r4((c0 - (side === 'LONG' ? orb.orHigh : orb.orLow)) / row.atr * dir),
        trend_align: (row.emaFast != null && row.emaSlow != null)
          ? (dir === 1 ? (row.emaFast > row.emaSlow ? 1 : -1) : (row.emaFast < row.emaSlow ? 1 : -1)) : null,
        vol_ratio_tod: r4(row.volRatioTod),
        body_pct: r4(an.bodyPct),
        upper_wick_pct: r4(an.upperWickPct),
        lower_wick_pct: r4(an.lowerWickPct),
        room_to_target_atr: r4(Math.abs(target - c0) / row.atr),
        minutes_from_open: m,
        atr_pct: r4(row.atr / c0 * 100),
        session_variant: c.session,
      };
      const miss = missingFeatures(features, FEATURES_REQUIRED);
      if (miss) { ctx.state?.droppedByNaN?.push?.({ i, miss }); return null; }
      return {
        symbol: ctx.symbol || '?', side, stop: r4(stop), target: r4(target), entry: r4(c0),
        features,
        maxHoldBars: c.maxHoldBars,
        audit: { expectedStop: r4(stop), expectedTarget: r4(target), confirmOutside: true, session: orb.sess },
      };
    },

    snapshot(sym, ts, row, cand) {
      const f = cand?.features || {};
      const lines = [
        `Instrument: ${sym} (crypto perp), 5-minute bars. Session: ${variant.label}, ${f.minutes_from_open} minutes in.`,
        `Opening range size ${f.or_size_atr} ATR. Price closed ${cand?.side === 'LONG' ? 'above' : 'below'} the range.`,
        `Volume ${f.vol_ratio_tod}x the same-time baseline. Trend align ${f.trend_align}.`,
        `Bar body ${f.body_pct}, upper wick ${f.upper_wick_pct}, lower wick ${f.lower_wick_pct}.`,
        `Proposed trade: ${cand?.side} entry ~${cand?.entry}, stop ${cand?.stop}, target ${cand?.target} (2R), leverage 3x.`,
      ];
      return makeSnapshot({ symbol: sym, ts, proposed: cand?.side === 'LONG' ? 'enter_long' : 'enter_short', features: f, contextLines: lines });
    },

    gates() {
      return [
        function against_trend(row, ctx = {}) {
          const f = ctx.features || {};
          const ta = nn(f.trend_align);
          if (ta == null) return 'against_trend:insufficient_data';
          return ta === 1 ? null : 'against_trend';
        },
        function low_volume(row, ctx = {}) {
          const f = ctx.features || {};
          const v = nn(f.vol_ratio_tod);
          if (v == null) return 'low_volume:insufficient_data';
          return v >= 0.9 ? null : 'low_volume'; // crypto baseline slightly looser
        },
        function thin_range(row, ctx = {}) {
          const f = ctx.features || {};
          const sz = nn(f.or_size_atr);
          if (sz == null) return 'thin_range:insufficient_data';
          return sz >= 0.3 ? null : 'thin_range'; // dust-thin range = noise breakout
        },
      ];
    },

    jevPrompt() {
      return {
        instructions: `A rule-based strategy proposes this ${variant.label} opening range breakout on a crypto perpetual. Decide whether to take it or stand aside.`,
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
  return strat;
}

export const orbCrypto = makeOrbCrypto();
export default orbCrypto;
