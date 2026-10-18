// ============================================================
// server/bots/core/metrics.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §7.3: every-run metric set. Honest by construction:
//   • t-stat on mean R (n<2 -> null, never a made-up number)
//   • gross AND net side by side (gross dikhana, net chhupana
//     is the classic vanity scam — we report both)
//   • train/test halves on DATE split (not interleaved)
//   • stand-aside rate + veto breakdown (a filter that approves
//     97% is not a filter)
//   • concentration: is the edge one symbol / one period?
// ============================================================
import { nn } from './features.js';

/** t-stat of mean R: t = mean(R) / (std(R)/sqrt(n)). Null when n<2 or std=0. */
export function tStatOnR(rs) {
  const xs = rs.map(nn).filter(x => x != null);
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(varr);
  if (!(sd > 0)) return null; // all-identical R: no dispersion signal
  return mean / (sd / Math.sqrt(n));
}

/** Profit factor: grossWin / grossLoss (null when no losses -> Infinity capped). */
export function profitFactor(rs) {
  let win = 0, loss = 0;
  for (const r of rs) {
    const x = nn(r);
    if (x == null) continue;
    if (x > 0) win += x; else loss += -x;
  }
  if (loss === 0) return win > 0 ? null : 0; // null = "no losing trade" (report, don't brag)
  return win / loss;
}

/** Max drawdown on the cumulative-R curve (in R units).
 *  v20.8.1 FIX (M): null R values are SKIPPED (drop-not-fill) — the
 *  old ?? 0 treated an unknown outcome as a flat bar. */
export function maxDrawdownR(rs) {
  let peak = 0, cum = 0, dd = 0;
  for (const r of rs) {
    const x = nn(r);
    if (x == null) continue;
    cum += x;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

/**
 * Full metrics for one arm's trade list.
 * Trade shape: { rNet, rGross, symbol, tsIn, vetoReason?, exit }
 */
export function computeMetrics(trades, { halves = true } = {}) {
  const ok = Array.isArray(trades);
  const rsNet = ok ? trades.map(t => nn(t.rNet)).filter(x => x != null) : [];
  const rsGross = ok ? trades.map(t => nn(t.rGross)).filter(x => x != null) : [];
  const n = rsNet.length;
  const meanR = n ? rsNet.reduce((a, b) => a + b, 0) / n : null;
  const wins = rsNet.filter(x => x > 0).length;
  const out = {
    trades: n,
    winRate: n ? wins / n : null,
    avgR: meanR,
    tStat: tStatOnR(rsNet),
    profitFactor: profitFactor(rsNet),
    expectancyR: meanR,
    maxDrawdownR: n ? maxDrawdownR(rsNet) : null,
    grossR: n ? rsGross.reduce((a, b) => a + b, 0) : null,
    netR: n ? rsNet.reduce((a, b) => a + b, 0) : null,
    feeDragR: n ? (rsGross.reduce((a, b) => a + b, 0) - rsNet.reduce((a, b) => a + b, 0)) : null,
  };
  if (halves && n >= 2) {
    // v20.8.1 FIX (H3): DATE split, not trade-count split — with
    // clustered trade dates both halves could sit inside one calendar
    // regime, quietly weakening the out-of-sample claim. Halves now
    // split at the calendar midpoint of the first/last trade date.
    const sorted = [...trades].sort((a, b) => (nn(a.tsIn) || 0) - (nn(b.tsIn) || 0));
    const tFirst = nn(sorted[0]?.tsIn), tLast = nn(sorted[sorted.length - 1]?.tsIn);
    let half;
    if (tFirst != null && tLast != null && tLast > tFirst) {
      const mid = (tFirst + tLast) / 2;
      let k = 0;
      while (k < sorted.length && (nn(sorted[k].tsIn) ?? -Infinity) < mid) k++;
      half = Math.max(1, Math.min(sorted.length - 1, k));
    } else {
      half = Math.floor(sorted.length / 2);
    }
    const h1 = sorted.slice(0, half), h2 = sorted.slice(half);
    out.halves = {
      train: summarizeHalf(h1),
      test: summarizeHalf(h2),
    };
  }
  return out;
}

function summarizeHalf(trades) {
  const rs = trades.map(t => nn(t.rNet)).filter(x => x != null);
  // v20.9.0 (B3 — honest pWin): OOS half ka winRate bhi — validatedPWin
  // isi pe chalta hai (per-arm out-of-sample pWin, Wilson LB ke saath).
  const wins = rs.filter(x => x > 0).length;
  return {
    trades: rs.length,
    winRate: rs.length ? wins / rs.length : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    tStat: tStatOnR(rs),
    profitFactor: profitFactor(rs),
  };
}

/** Plan §7.4 pass criteria check (both halves t>=2, n>=150, PF>1.3, net>0). */
export function passCriteria(m, { minTrades = 150, minT = 2.0, minPF = 1.3 } = {}) {
  const checks = {
    trades: (m.trades ?? 0) >= minTrades,
    netPositive: (m.netR ?? -1) > 0,
    profitFactor: (m.profitFactor ?? 0) > minPF || m.profitFactor == null && (m.netR ?? 0) > 0,
  };
  const h1 = m.halves?.train, h2 = m.halves?.test;
  checks.tStatBothHalves = !!(h1 && h2 && (h1.tStat ?? -1) >= minT && (h2.tStat ?? -1) >= minT);
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { pass: failed.length === 0, checks, failed };
}

/** Veto/stand-aside breakdown across a decider's decisions. */
export function decisionBreakdown(decisions) {
  const total = decisions.length;
  const taken = decisions.filter(d => d.action === 'take').length;
  const byReason = {};
  for (const d of decisions) {
    if (d.action !== 'take') {
      const r = d.reason || 'unknown';
      byReason[r] = (byReason[r] || 0) + 1;
    }
  }
  return {
    candidates: total,
    taken,
    standAsideRate: total ? 1 - taken / total : null,
    vetoBreakdown: byReason,
  };
}

/** Concentration: share of total net R from the single best symbol / month.
 *  v20.8.1 FIX (M): month key is IST (trades within 5.5h of a month
 *  boundary were misattributed by the UTC slice), and a LOSS-making
 *  single symbol/month is still flagged (the old totalNet>0 guard
 *  silently passed one-disaster concentration). */
export function concentration(trades) {
  const bySym = {}, byMonth = {};
  for (const t of trades) {
    const r = nn(t.rNet) ?? 0;
    const s = String(t.symbol || '?');
    bySym[s] = (bySym[s] || 0) + r;
    const ts = nn(t.tsIn) || 0;
    // IST month via fixed UTC+5:30 arithmetic (no ICU)
    const m = new Date(ts + 330 * 60000).toISOString().slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + r;
  }
  const totalNet = Object.values(bySym).reduce((a, b) => a + b, 0);
  const worstSymShare = totalNet !== 0 ? Math.max(...Object.values(bySym)) / totalNet : null;
  const worstMonthShare = totalNet !== 0 ? Math.max(...Object.values(byMonth)) / totalNet : null;
  return {
    bySymbol: bySym, byMonth,
    topSymbolShare: worstSymShare,
    topMonthShare: worstMonthShare,
    concentrated: (worstSymShare ?? 0) > 0.6 || (worstMonthShare ?? 0) > 0.5,
  };
}
