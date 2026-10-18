// ============================================================
// server/bots/strategies/lvl.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// LVL (Liquidity Sweep) — plan §6.3, reference-slide faithful:
//   Range = pichle session ka [L, H], R = H - L.
//   LONG (low sweep):
//     1. price ne L ke neeche wick/trade kiya (min sweepAtr beyond L)
//     2. candle wapas range ke ANDAR close hui
//     3. entry L + 0.25R, stop L + 0.125R, target L + 0.50R (R:R ~1:2)
//   SHORT mirror.
//
//   DHYAN (plan): stop bahut tight hai — friction multiply hota hai:
//   friction_R ~ 2 * slippage_bps * price / stop_distance. Isliye ye
//   strategy NET numbers ke bina kisi conclusion ke layak nahi.
//   Engine friction already models this; we also expose frictionRiskR
//   on the candidate so the fee gate can veto honestly.
//
// Causality: prior-session range strictly from the PRIOR session
// (features.js priorSessionLevels with session key); sweep + reclaim
// both observed on the signal bar's OWN high/low/close.
// India variant: prior-day range sweep, pehle 90 min me (plan's
// stated HYPOTHESIS — backtest will prove/disprove, slide transfer
// nahi hota).
// ============================================================
import { nn, prepareShared, finishShared, istDayKey, utcDayKey } from '../core/features.js';
import { istMinutes } from '../core/engine.js';
import { makeSnapshot, r4, missingFeatures } from './contract.js';
// v20.9.1 [H2]: REAL-cost friction — placeholder 5bps formula ki jagah
// tradingCosts ka actual round-trip model (engine wali slip convention ke saath).
import { estimateRoundTripCost } from '../../ai/tradingCosts.js';

export const LVL_DEFAULTS = {
  desk: 'crypto',                    // 'crypto' | 'india'
  sweepAtr: 0.15,                    // min sweep beyond level, in ATR
  entryFracR: 0.25,                  // entry at L + 0.25R (long)
  stopFracR: 0.125,                  // stop at L + 0.125R (long)
  targetFracR: 0.50,                 // target at L + 0.50R (long)
  firstMinutesOnly: 90,              // India: pehle 90 min (crypto: null)
  confirmBothBtcEth: false,          // crypto option: BTC+ETH same direction
  atrPeriodBarsCrypto: 2016,
  atrPeriodBarsIndia: 350,
  onePerSession: true,
};

const FEATURES_REQUIRED = ['sweep_atr', 'range_r_atr', 'reclaim_close', 'body_pct', 'dist_pdh_atr', 'dist_pdl_atr', 'atr_pct'];

function sessionKeyFor(bar, desk) {
  const t = nn(bar.time);
  if (t == null) return null;
  // v20.8.0 PERF: integer session-day keys — IST epoch-day for the India
  // desk, UTC epoch-day for crypto (plan §5: explicit session def).
  return desk === 'india' ? istDayKey(t) : utcDayKey(t);
}

export function makeLvl(overrides = {}) {
  const cfg = { ...LVL_DEFAULTS, ...overrides };
  const atrPeriod = cfg.desk === 'india' ? cfg.atrPeriodBarsIndia : cfg.atrPeriodBarsCrypto;
  const sKey = (bar) => sessionKeyFor(bar, cfg.desk);

  return {
    id: cfg.desk === 'india' ? 'lvl_in' : 'lvl',
    desk: cfg.desk,
    instrumentType: cfg.desk === 'india' ? 'equity-intraday' : 'crypto',
    lotSize: 1,
    sessionKey: sKey,

    prepare(bars, _opts = {}) {
      const rows = prepareShared(bars, { atrPeriod, emaFast: 50, emaSlow: 200 });
      finishShared(rows, bars, { intervalMin: 5, sessionKey: sKey });
      for (let i = 0; i < rows.length; i++) {
        const bar = rows[i].bar;
        const sess = sKey(bar);
        const prev = i > 0 ? rows[i - 1] : null;
        // v20.8.0 FIX: SHARED per-session attempt box — detect()'s
        // one-per-session mutation must be visible to later bars.
        if (!prev || sKey(prev.bar) !== sess) rows[i]._attempt = { used: false };
        else rows[i]._attempt = prev._attempt;
        rows[i]._lvl = {
          sess,
          // priorH/priorL from finishShared = PRIOR session levels (causal)
          pH: rows[i].priorH, pL: rows[i].priorL,
        };
      }
      return rows;
    },

    detect(rows, i, ctx = {}) {
      const c = { ...cfg, ...(ctx.cfg || {}) };
      const row = rows[i];
      if (!row?._lvl) return null;
      const L = nn(row._lvl.pL), H = nn(row._lvl.pH);
      if (L == null || H == null) return null;
      const R = H - L;
      if (!(R > 0)) return null;
      if (c.onePerSession && row._attempt?.used) return null;
      const bar = row.bar;
      const h = nn(bar.high), l = nn(bar.low), cl = nn(bar.close);
      const atr = nn(row.atr);
      if (h == null || l == null || cl == null || atr == null || !(atr > 0)) return null;

      // India window: pehle 90 min (plan hypothesis — proved by backtest)
      if (c.desk === 'india' && c.firstMinutesOnly != null) {
        const m = istMinutes(bar.time);
        const open = 9 * 60 + 15;
        if (m == null || m - open > c.firstMinutesOnly) return null;
      }

      const sweptLow = l < L - (c.sweepAtr * atr) * 1;   // min sweep beyond L
      const sweptHigh = h > H + (c.sweepAtr * atr);
      const closedBackInside = cl >= L && cl <= H;

      let side = null;
      if (sweptLow && closedBackInside) side = 'LONG';
      else if (sweptHigh && closedBackInside) side = 'SHORT';
      // v20.8.0 FIX: attempt burns only when a CANDIDATE actually forms
      // (sweep + reclaim). A sweep that closes outside is NOT a trade
      // attempt — burning it here would kill the next, valid setup
      // within the session (one-per-session = one TRADE, not one poke).
      if (!side) return null;
      row._attempt.used = true;

      // Plan §6.3 exact geometry (R:R ~ 1:2 with the reference's fractions)
      const entry = side === 'LONG' ? L + c.entryFracR * R : H - c.entryFracR * R;
      const stop = side === 'LONG' ? L + c.stopFracR * R : H - c.stopFracR * R;
      const target = side === 'LONG' ? L + c.targetFracR * R : H - c.targetFracR * R;
      const stopDist = Math.abs(entry - stop);
      if (!(stopDist > 0)) return null;

      const an = row.anatomy || {};
      const dir = side === 'LONG' ? 1 : -1;
      const sweepDepthAtr = side === 'LONG' ? (L - l) / atr : (h - H) / atr;
      const features = {
        sweep_atr: r4(sweepDepthAtr),
        range_r_atr: r4(R / atr),
        reclaim_close: closedBackInside ? 1 : 0,
        body_pct: r4(an.bodyPct),
        upper_wick_pct: r4(an.upperWickPct),
        lower_wick_pct: r4(an.lowerWickPct),
        dist_pdh_atr: r4(row.priorH != null ? (row.priorH - cl) / atr : null),
        dist_pdl_atr: r4(row.priorL != null ? (cl - row.priorL) / atr : null),
        vol_ratio_tod: r4(row.volRatioTod),
        trend_align: (row.emaFast != null && row.emaSlow != null)
          ? (dir === 1 ? (row.emaFast > row.emaSlow ? 1 : -1) : (row.emaFast < row.emaSlow ? 1 : -1)) : null,
        minutes_from_open: c.desk === 'india' ? ((istMinutes(bar.time) ?? 0) - (9 * 60 + 15)) : null,
        atr_pct: r4(atr / cl * 100),
      };
      const miss = missingFeatures(features, FEATURES_REQUIRED);
      if (miss) { ctx.state?.droppedByNaN?.push?.({ i, miss }); return null; }

      // Tight-stop friction flag (plan §6.3 dhyan): friction in R units.
      // v20.9.1 [H2]: "runtime gate recomputes" comment JHOOTA tha — kuch
      // recompute nahi hota tha, hardcoded 5bps placeholder hi use hota
      // tha. Ab REAL round-trip cost (estimateRoundTripCost) + engine slip
      // convention (india 5bps/side, crypto 4bps/side) se derive hota hai.
      // EMPIRICAL context (real BTC 5m, 3131 bars, v20.9.1 backtest): rules
      // arm 3 trades / 0% win / feeDrag 53R — 0.125R-stop geometry retail
      // costs pe structurally friction-dominated hai; friction_dominant
      // gate hi live account ko bacha raha hai. Gate HONEST hai, loose nahi.
      const _instr = cfg.desk === 'india' ? 'equity-intraday' : 'crypto';
      const _slipBps = cfg.desk === 'india' ? 5 : 4; // ENGINE_DEFAULTS (per side)
      let _frFrac = null; // round-trip friction as fraction of price
      try {
        const _cost = estimateRoundTripCost({ qty: 1, entryPrice: entry, exitPrice: entry, instrumentType: _instr, mult: 1 });
        if (_cost?.total != null && entry > 0) _frFrac = _cost.total / entry;
      } catch { /* cost model unavailable — placeholder fallback below */ }
      const _frFracTotal = (_frFrac != null ? _frFrac : 2 * 0.0005) + 2 * _slipBps / 10000;
      const frictionRiskR = _frFracTotal * cl / stopDist;

      return {
        symbol: ctx.symbol || '?', side, stop: r4(stop), target: r4(target), entry: r4(entry),
        features, frictionRiskR: r4(frictionRiskR),
        audit: {
          expectedEntry: r4(entry), expectedStop: r4(stop), expectedTarget: r4(target),
          sweepAtr: r4(sweepDepthAtr), minSweepAtr: c.sweepAtr, closeBackInside: closedBackInside,
        },
      };
    },

    snapshot(sym, ts, row, cand) {
      const f = cand?.features || {};
      const lines = [
        `Instrument: ${sym} (${cfg.desk === 'india' ? 'NSE' : 'crypto perp'}), 5-minute bars.`,
        `Prior session range [${r4(cand?.audit ? row._lvl.pL : null)}, ${r4(row._lvl?.pH)}] = ${f.range_r_atr} ATR.`,
        `Price swept ${cand?.side === 'LONG' ? 'below the prior low' : 'above the prior high'} by ${f.sweep_atr} ATR and closed back inside the range.`,
        `Bar body ${f.body_pct}, reclaim close confirmed. Volume ${f.vol_ratio_tod}x baseline.`,
        `Proposed trade: ${cand?.side} entry ~${cand?.entry}, tight stop ${cand?.stop}, target ${cand?.target} (R:R ~1:2, friction-heavy setup).`,
      ];
      return makeSnapshot({ symbol: sym, ts, proposed: cand?.side === 'LONG' ? 'enter_long' : 'enter_short', features: f, contextLines: lines });
    },

    gates() {
      return [
        function shallow_sweep(row, ctx = {}) {
          const f = ctx.features || {};
          const s = nn(f.sweep_atr);
          if (s == null) return 'shallow_sweep:insufficient_data';
          return s >= cfg.sweepAtr ? null : 'shallow_sweep';
        },
        function no_reclaim(row, ctx = {}) {
          const f = ctx.features || {};
          return Number(f.reclaim_close) === 1 ? null : 'no_reclaim';
        },
        function friction_dominant(row, ctx = {}) {
          const _f = ctx.features || {};
          const fr = nn(ctx.frictionRiskR ?? row?.frictionRiskR);
          if (fr == null) return 'friction_dominant:insufficient_data';
          // tight-stop killer: friction >= 10% of the 0.5R target = walk away
          return fr <= 0.05 ? null : 'friction_dominant';
        },
      ];
    },

    jevPrompt() {
      return {
        instructions: 'A rule-based strategy proposes this liquidity-sweep reversal trade (sweep of the prior session range, close back inside). Decide whether to take it or stand aside.',
        criteria: {
          enter_long: 'Take the long sweep-reversal',
          enter_short: 'Take the short sweep-reversal',
          wait: 'Stand aside, the sweep looks like a real breakout, not a trap',
        },
        extra: {
          fakeout_risk: {
            type: 'score',
            instructions: 'How likely is this "sweep" actually the start of a genuine breakout (worst case for the reversal)?',
            criteria: ['very unlikely', 'unlikely', 'possible', 'likely', 'very likely'],
          },
        },
      };
    },
  };
}

export const lvl = makeLvl();
export default lvl;
