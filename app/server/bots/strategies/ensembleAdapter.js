// ============================================================
// server/bots/strategies/ensembleAdapter.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §6.5 ENSEMBLE-ADAPTER: aapki existing 14-model ensemble ka
// STRONG signal ko ek CANDIDATE SOURCE banao. Ye backtest karega
// ki current site signals ka ASLI edge kitna hai, aur gated/jev
// unhe improve karte hain ya nahi (trust.js calibration ko ground
// truth milta hai).
//
// Honest-data design: live 14-model history RECOMPUTE nahi hoti —
// adapter consumes a RECORDED signal log (ts, symbol, market, side,
// confidence, agreement, grade) aligned onto candle bars. Backtest
// of live signals is only as honest as the recording; we therefore
// also export the recorder used by the live runner.
//
// Stop/target (ADAPTER CHOICE, documented, sweepable): stop = 1.5
// ATR from the signal-bar close; target = 2R. Causality: signal
// timestamp must fall INSIDE the signal bar (not after its close).
// ============================================================
import { nn, prepareShared, finishShared } from '../core/features.js';
import { makeSnapshot, r4, missingFeatures } from './contract.js';

export const ENSEMBLE_ADAPTER_DEFAULTS = {
  stopAtr: 1.5,
  targetR: 2.0,
  minConfidence: 75,        // ensemble.js STRONG gate parity
  atrPeriodBarsCrypto: 2016,
  atrPeriodBarsIndia: 350,
  gradesAccepted: ['STRONG'],
};

/**
 * Build the adapter around a signal log.
 * @param {Array} signalLog  [{ts, symbol, market, side:'LONG'|'SHORT',
 *                             confidence, agreement, grade}]
 */
export function makeEnsembleAdapter(signalLog = [], overrides = {}) {
  const cfg = { ...ENSEMBLE_ADAPTER_DEFAULTS, ...overrides };
  // index signals by (symbol|market) -> sorted ts list (binary search later)
  const byKey = new Map();
  for (const s of signalLog) {
    const k = `${String(s.symbol).toUpperCase()}|${String(s.market || '').toUpperCase()}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  for (const arr of byKey.values()) arr.sort((a, b) => a.ts - b.ts);

  const instrumentTypeFor = (market) => (market === 'INDIA' ? 'equity-intraday' : 'crypto');
  const atrPeriodFor = (market) => (market === 'INDIA' ? cfg.atrPeriodBarsIndia : cfg.atrPeriodBarsCrypto);

  return {
    id: 'ensemble',
    baseId: 'ensemble',
    desk: 'both',
    // v20.8.4 (M — honest descriptor): static 'crypto' is only the FALLBACK
    // fee model. The candidate carries the market-correct instrumentType
    // (instrumentTypeFor above); INDIA-market runs MUST pass the override
    // to runThreeArmBacktest/runBacktest ({ instrumentType: 'equity-intraday' })
    // or the cost stack silently becomes crypto taker fees.
    instrumentType: 'crypto',
    lotSize: 1,

    prepare(bars, opts = {}) {
      const market = opts.market || 'CRYPTO';
      const rows = prepareShared(bars, { atrPeriod: atrPeriodFor(market), emaFast: 50, emaSlow: 200 });
      finishShared(rows, bars, { intervalMin: 5 });
      return rows;
    },

    detect(rows, i, ctx = {}) {
      const market = ctx.market || 'CRYPTO';
      const key = `${String(ctx.symbol || '?').toUpperCase()}|${String(market).toUpperCase()}`;
      const sigs = byKey.get(key);
      if (!sigs?.length) return null;
      const row = rows[i];
      const bar = row?.bar;
      if (!bar) return null;
      const t0 = nn(bar.time);
      const next = rows[i + 1]?.bar?.time ?? (t0 != null ? t0 + 300000 : null);
      if (t0 == null || next == null) return null;
      // signal must fire INSIDE this bar (causal: bar close hasn't happened yet
      // at signal time — but its features end at the PRIOR bar; engine fills next open)
      let sig = null;
      for (const s of sigs) {
        if (s.ts >= t0 && s.ts < next) { sig = s; break; }
        if (s.ts >= next) break;
      }
      if (!sig) return null;
      if (!cfg.gradesAccepted.includes(String(sig.grade || 'STRONG').toUpperCase())) return null;
      if ((nn(sig.confidence) ?? 0) < cfg.minConfidence) return null;

      const cPrev = nn(rows[i - 1]?.bar?.close) ?? nn(bar.open); // decision uses PRIOR close (shift(1))
      const atr = nn(row.atr);
      if (cPrev == null || atr == null || !(atr > 0)) return null;
      const side = String(sig.side || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
      const dir = side === 'LONG' ? 1 : -1;
      const stop = cPrev - dir * cfg.stopAtr * atr;
      const stopDist = Math.abs(cPrev - stop);
      if (!(stopDist > 0)) return null;
      const target = cPrev + dir * cfg.targetR * stopDist;

      const features = {
        ensemble_confidence: nn(sig.confidence),
        ensemble_agreement: nn(sig.agreement),
        atr_pct: r4(atr / cPrev * 100),
        vol_ratio_tod: r4(row.volRatioTod),
        trend_align: (row.emaFast != null && row.emaSlow != null)
          ? (dir === 1 ? (row.emaFast > row.emaSlow ? 1 : -1) : (row.emaFast < row.emaSlow ? 1 : -1)) : null,
        stop_atr: cfg.stopAtr,
        target_r: cfg.targetR,
        ema_fast_dist_atr: r4(row.emaFast != null ? (cPrev - row.emaFast) / atr : null),
        ema_slow_dist_atr: r4(row.emaSlow != null ? (cPrev - row.emaSlow) / atr : null),
      };
      const miss = missingFeatures(features, ['ensemble_confidence', 'ensemble_agreement', 'atr_pct', 'trend_align']);
      if (miss) { ctx.state?.droppedByNaN?.push?.({ i, miss }); return null; }

      return {
        symbol: ctx.symbol || '?', side, stop: r4(stop), target: r4(target), entry: r4(cPrev),
        features, instrumentType: instrumentTypeFor(market),
        audit: { expectedStop: r4(stop), expectedTarget: r4(target), signalTs: sig.ts },
      };
    },

    snapshot(sym, ts, row, cand) {
      const f = cand?.features || {};
      const lines = [
        `Instrument: ${sym}. The site's 14-model ensemble just graded this ${cand?.side} signal ${cand?.features?.ensemble_confidence}% confidence, agreement ${f.ensemble_agreement}.`,
        `Volatility (ATR) is ${f.atr_pct}% of price. Trend align ${f.trend_align}. Volume ${f.vol_ratio_tod}x baseline.`,
        `Proposed trade: ${cand?.side} entry ~${cand?.entry}, stop ${cand?.stop} (${f.stop_atr} ATR), target ${cand?.target} (2R).`,
      ];
      return makeSnapshot({ symbol: sym, ts, proposed: cand?.side === 'LONG' ? 'enter_long' : 'enter_short', features: f, contextLines: lines });
    },

    gates() {
      return [
        function weak_committee(row, ctx = {}) {
          const f = ctx.features || {};
          const conf = nn(f.ensemble_confidence);
          if (conf == null) return 'weak_committee:insufficient_data';
          return conf >= 80 ? null : 'weak_committee'; // STRONG floor 75; control arm demands 80
        },
        function split_committee(row, ctx = {}) {
          const f = ctx.features || {};
          const agr = nn(f.ensemble_agreement);
          if (agr == null) return 'split_committee:insufficient_data';
          return agr >= 0.6 ? null : 'split_committee';
        },
        function against_trend(row, ctx = {}) {
          const f = ctx.features || {};
          const ta = nn(f.trend_align);
          if (ta == null) return 'against_trend:insufficient_data';
          return ta === 1 ? null : 'against_trend';
        },
      ];
    },

    jevPrompt() {
      return {
        instructions: 'A 14-model ensemble committee just emitted a STRONG-grade trade signal. Decide whether to take it or stand aside.',
        criteria: {
          enter_long: 'Take the long signal',
          enter_short: 'Take the short signal',
          wait: 'Stand aside, the committee is likely herding on one stale factor',
        },
        extra: {
          fakeout_risk: {
            type: 'score',
            instructions: 'How likely is this signal to be a crowd-herding fakeout?',
            criteria: ['very unlikely', 'unlikely', 'possible', 'likely', 'very likely'],
          },
        },
      };
    },
  };
}

export const ensembleAdapter = makeEnsembleAdapter();
export default ensembleAdapter;
