// ============================================================
// server/ai/perf.js — PORTFOLIO PERFORMANCE ANALYTICS (v6.11)
// ------------------------------------------------------------
// Glama-inspired (oneqaz-trading-mcp portfolio analytics: MDD /
// Sharpe / Sortino / Calmar): the ledger's SETTLED entries are an
// R-multiple series — exactly what a risk-normalized performance
// report needs. Every stat is computed on R (pnl / initial risk)
// so paper and live, ₹5k and ₹5L trades are directly comparable.
//
//   EXPECTANCY   avg R per trade  (the one number that pays you)
//   MDD          max peak-to-trough drawdown of the cumulative-R
//                equity curve (in R units — currency-free)
//   SHARPE       mean R / std R  (per-trade, NOT annualized —
//                trade frequency varies wildly day to day, so we
//                label it honestly instead of faking a √252)
//   SORTINO      mean R / downside deviation (only downside vol
//                is punished — a 2R win is not "risk")
//   CALMAR       expectancy / |MDD| — reward per unit of worst pain
//   STREAKS      longest win / loss runs
//   PROFIT FACTOR gross win R / gross loss |R|
//
// Honesty rules: < 5 settled entries → insufficient (no invented
// stats); MDD of a curve that never fell = 0 (not hidden); losing
// curve → Calmar/Sharpe reported negative, not clipped. Read-only.
// ============================================================
import { __ledgerRaw } from './ledger.js';

const MIN_SETTLED = 5;

function settledSeries() {
  const raw = __ledgerRaw();
  return (raw?.entries || [])
    .filter(e => e?.outcome && e.outcome.r != null)
    .sort((a, b) => (a.outcome.ts || a.ts) - (b.outcome.ts || b.ts))
    .map(e => ({
      r: Number(e.outcome.r),
      pnlINR: Number.isFinite(Number(e.outcome.pnlINR)) ? Number(e.outcome.pnlINR) : null,
      market: e.market || 'CRYPTO',
      mode: e.mode || 'paper',
      symbol: e.symbol,
      reason: e.outcome.reason || null,
      ts: e.outcome.ts || e.ts,
    }));
}

/** Max drawdown of a cumulative series (in the series' own units). */
function maxDrawdown(cum) {
  let peak = -Infinity, mdd = 0, peakIdx = 0, troughIdx = 0, curPeakIdx = 0;
  cum.forEach((v, i) => {
    if (v > peak) { peak = v; curPeakIdx = i; }
    const dd = peak - v;
    if (dd > mdd) { mdd = dd; peakIdx = curPeakIdx; troughIdx = i; }
  });
  return { mdd: Math.round(mdd * 100) / 100, peakIdx, troughIdx };
}

export function perfReport() {
  const series = settledSeries();
  const base = { ok: true, settled: series.length, asOf: Date.now() };
  if (series.length < MIN_SETTLED) {
    return {
      ...base,
      sufficient: false,
      note: `Insufficient data — ${series.length}/${MIN_SETTLED} settled trades. Kuch positions close hone do, phir yahan asli numbers dikhenge.`,
    };
  }

  const rs = series.map(s => s.r);
  const n = rs.length;
  const wins = rs.filter(r => r > 0);
  const losses = rs.filter(r => r <= 0);
  const mean = rs.reduce((s, r) => s + r, 0) / n;
  const variance = rs.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  // downside deviation: only the negative deviations from 0 (the R
  // "risk line"), squared — classic Sortino denominator
  const downside = rs.filter(r => r < 0).map(r => r ** 2);
  const downsideDev = downside.length > 0 ? Math.sqrt(downside.reduce((s, v) => s + v, 0) / n) : 0;

  // equity curve (cumulative R) + MDD
  const cum = [];
  let run = 0;
  for (const r of rs) { run += r; cum.push(Math.round(run * 100) / 100); }
  const { mdd } = maxDrawdown(cum);

  // streaks
  let winStreak = 0, lossStreak = 0, curW = 0, curL = 0;
  for (const r of rs) {
    if (r > 0) { curW++; curL = 0; } else { curL++; curW = 0; }
    winStreak = Math.max(winStreak, curW);
    lossStreak = Math.max(lossStreak, curL);
  }

  const grossWinR = wins.reduce((s, r) => s + r, 0);
  const grossLossR = Math.abs(losses.reduce((s, r) => s + r, 0));

  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

  // split by market + mode (desk-level honesty)
  const group = (key) => {
    const rows = series.filter(s => key === 'ALL' || s[key[0]] === key[1]);
    if (rows.length === 0) return null;
    const rr = rows.map(s => s.r);
    return {
      n: rows.length,
      winRate: Math.round((rr.filter(r => r > 0).length / rows.length) * 1000) / 10,
      avgR: r2(rr.reduce((s, r) => s + r, 0) / rows.length),
      totalR: r2(rr.reduce((s, r) => s + r, 0)),
    };
  };

  return {
    ...base,
    sufficient: true,
    expectancy: r2(mean),
    winRate: Math.round((wins.length / n) * 1000) / 10,
    totalR: r2(rs.reduce((s, r) => s + r, 0)),
    totalPnlINR: Math.round((series.reduce((s, x) => s + (x.pnlINR || 0), 0)) * 100) / 100,
    mdd: { r: mdd, note: mdd === 0 ? 'curve kabhi dip me nahi gaya (abhi)' : null },
    sharpe: {
      perTrade: r2(std > 0 ? mean / std : null),
      note: 'per-trade R basis — annualization frequency-dependent hota hai, isliye honestly skipped',
    },
    sortino: { perTrade: r2(downsideDev > 0 ? mean / downsideDev : null) },
    calmar: { expectancyOverMdd: r2(mdd > 0 ? mean / mdd : null), note: mdd === 0 ? 'no drawdown yet — Calmar undefined (infinity)' : null },
    streaks: { win: winStreak, loss: lossStreak },
    profitFactor: r2(grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? null : 0)),
    avgWinR: r2(wins.length ? grossWinR / wins.length : null),
    avgLossR: r2(losses.length ? -grossLossR / losses.length : null),
    equityCurveR: cum,
    byMarket: {
      india: group(['market', 'INDIA']),
      crypto: group(['market', 'CRYPTO']),
      futures: group(['market', 'FUTURES']),
    },
    byMode: { paper: group(['mode', 'paper']), live: group(['mode', 'live']) },
    note: 'Sab stats R-multiples par (pnl / initial risk) — paper/live aur size-independent. MDD currency-free R units me. Read-only.',
  };
}

export const __testables = { maxDrawdown, settledSeries, MIN_SETTLED };
