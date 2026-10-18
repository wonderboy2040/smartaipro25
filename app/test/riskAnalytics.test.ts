// ============================================================
// test/riskAnalytics.test.ts — v13.2 A4 PORTFOLIO RISK ANALYTICS
// ------------------------------------------------------------
// LOCKED HERE (plan A4):
//   • REAL Sortino — downside deviation, NOT sharpe × 1.3 (the
//     client riskEngine placeholder this module replaces)
//   • seriesStats: annualized return/vol, Sharpe (rf-aware),
//     max drawdown on the cumulative path, <10 points → null
//   • pearson correlation: +1 identical, −1 mirrored, null short
//   • rebalanceSuggestions: vol-parity × equal-weight blend target,
//     drift > 3% → concrete trim/add lines, <2 holdings → empty
//   • computePortfolioRiskAnalytics end-to-end with injected
//     fetchers: per-holding rows, portfolio-level stats on
//     VALUE-WEIGHTED aligned returns, correlation matrix,
//     skipped-list honesty for no-series assets, 1h cache
//   • never throws on garbage input
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  dailyReturns, mean, stdev, downsideDev, seriesStats, pearson,
  rebalanceSuggestions, computePortfolioRiskAnalytics,
  __resetRiskAnalyticsForTests, __testables,
} from '../server/ai/riskAnalytics.js';

// deterministic pseudo-series generator (LCG)
function series(n, start, drift, vol, seed) {
  let x = start, s = seed;
  const out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    x *= 1 + drift + vol * ((s / 233280) - 0.5);
    out.push(Number(x.toFixed(6)));
  }
  return out;
}

describe('A4 risk math (pure)', () => {
  it('dailyReturns computes simple returns, skips bad closes', () => {
    expect(dailyReturns([100, 110, 99])).toEqual([(110 - 100) / 100, (99 - 110) / 110]);
    expect(dailyReturns([100])).toEqual([]);
    expect(dailyReturns([0, 100, 110])).toEqual([(110 - 100) / 100]);
  });

  it('mean + stdev basics', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(stdev([5, 5, 5])).toBe(0);
    expect(stdev([1, 3])).toBeCloseTo(Math.sqrt(2), 6);
  });

  it('downsideDev counts ONLY below-MAR deviation (over ALL n)', () => {
    // half +2%, half −2% → target downside dev = sqrt((1/2)·0.02²) = 0.01414
    const rets = Array.from({ length: 20 }, (_, i) => (i % 2 ? -0.02 : 0.02));
    expect(downsideDev(rets, 0)).toBeCloseTo(0.02 / Math.SQRT2, 8);
    expect(downsideDev(Array(20).fill(0.01), 0)).toBe(0); // no downside → 0
  });

  it('Sortino is REAL downside deviation — not sharpe × 1.3', () => {
    // skewed series: small wins, rare crashes → sortino << sharpe×1.3
    const rets = [];
    for (let i = 0; i < 60; i++) rets.push(i % 6 === 5 ? -0.08 : 0.012);
    const st = seriesStats(rets, 0.065);
    expect(st).not.toBeNull();
    expect(st.sortino).not.toBeCloseTo(st.sharpe * 1.3, 1);
    expect(st.sortino).toBeLessThan(st.sharpe); // crashes punished harder
    expect(st.points).toBe(60);
  });

  it('seriesStats annualizes and computes max drawdown', () => {
    // 1% daily → 252% simple annualization
    const st = seriesStats(Array(60).fill(0.01), 0);
    expect(st.annReturnPct).toBeCloseTo(252, 0);
    // drawdown: 10 flat days, then +10% then −20% (peak 1.10 → 0.88 = −20% of peak)
    const ddSeries = [...Array(10).fill(0), 0.10, -0.20, ...Array(10).fill(0.001)];
    const st2 = seriesStats(ddSeries, 0);
    expect(st2.maxDrawdownPct).toBeCloseTo(20, 0);
  });

  it('seriesStats refuses <10 points (honest skip)', () => {
    expect(seriesStats([0.01, 0.02], 0.065)).toBeNull();
  });

  it('pearson: +1 identical, −1 mirrored, null on short series', () => {
    const a = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.015, -0.005, 0.01, 0.02, -0.01, 0.005];
    expect(pearson(a, a)).toBe(1);
    expect(pearson(a, a.map(x => -x))).toBe(-1);
    expect(pearson(a.slice(0, 5), a.slice(0, 5))).toBeNull();
  });
});

describe('A4 rebalance drift engine', () => {
  it('vol-parity × equal-weight blend with concrete trim/add lines', () => {
    const reb = rebalanceSuggestions([
      { label: 'A', weight: 0.7, annVolPct: 20 },
      { label: 'B', weight: 0.3, annVolPct: 40 },
    ]);
    // inv-vol targets: A 2/3, B 1/3 → blend 70% of that + 30% equal
    expect(reb.rows.length).toBe(2);
    const a = reb.rows.find(r => r.label === 'A');
    expect(a.currentPct).toBe(70);
    expect(a.targetPct).toBeCloseTo(61.67, 0);
    expect(a.driftPct).toBeGreaterThan(3);
    expect(reb.suggestions.length).toBeGreaterThan(0);
    expect(reb.suggestions[0]).toContain('Trim A');
    expect(reb.suggestions[0]).toContain('add to B');
  });

  it('balanced book → no suggestions, rows still present', () => {
    const reb = rebalanceSuggestions([
      { label: 'A', weight: 0.5, annVolPct: 20 },
      { label: 'B', weight: 0.5, annVolPct: 20 },
    ]);
    expect(reb.suggestions).toEqual([]);
  });

  it('fewer than 2 live holdings → empty', () => {
    expect(rebalanceSuggestions([{ label: 'A', weight: 1, annVolPct: 20 }])).toEqual([]);
  });
});

describe('A4 computePortfolioRiskAnalytics (end-to-end, injected fetchers)', () => {
  beforeEach(() => __resetRiskAnalyticsForTests());

  const mkAssets = () => ([
    { key: 'a1', id: 'a1', name: 'Reliance', symbol: 'RELIANCE', market: 'IN', kind: 'stock', value: 60000 },
    { key: 'a2', id: 'a2', name: 'BTC', symbol: 'BTC', market: 'IN', kind: 'crypto', value: 30000 },
    { key: 'a3', id: 'a3', name: 'FD', symbol: null, market: 'IN', kind: 'fixed', value: 10000 },
  ]);

  const fetchers = {
    yahoo: async (sym) => (sym === 'RELIANCE.NS' ? series(120, 100, 0.001, 0.015, 11) : []),
    binance: async (base) => (base === 'BTC' ? series(120, 50, 0.0015, 0.03, 77).map(p => ({ close: p })) : null),
  };

  it('full payload: holdings, portfolio, correlation, skipped, rebalance', async () => {
    const out = await computePortfolioRiskAnalytics(mkAssets(), { fetchers });
    expect(out.ok).toBe(true);
    // 2 holdings with series; the FD honestly skipped
    expect(out.holdings.length).toBe(2);
    expect(out.skipped.length).toBe(1);
    expect(out.skipped[0].label).toBe('FD');
    // value weights vs the WHOLE portfolio (FD included): 60/100 = 60%
    const rel = out.holdings.find(h => h.label === 'RELIANCE');
    expect(rel.weightPct).toBe(60);
    expect(rel.sharpe).not.toBeNull();
    expect(rel.sortino).not.toBeNull();
    // portfolio-level stats on value-weighted aligned returns
    expect(out.portfolio).not.toBeNull();
    expect(out.portfolio.alignedPoints).toBeGreaterThanOrEqual(10);
    // correlation matrix 2×2, diagonal 1
    expect(out.correlation.symbols.length).toBe(2);
    expect(out.correlation.matrix[0][0]).toBe(1);
    expect(out.correlation.matrix[0][1]).not.toBeNull();
    // rebalance rows exist for 2 holdings
    expect(out.rebalance.rows.length).toBe(2);
  });

  it('caches per asset signature for 1h', async () => {
    const a1 = await computePortfolioRiskAnalytics(mkAssets(), { fetchers });
    expect(a1.cached).toBeUndefined();
    const a2 = await computePortfolioRiskAnalytics(mkAssets(), { fetchers });
    expect(a2.cached).toBe(true);
    // a changed signature (new value) recomputes
    const changed = mkAssets(); changed[0].value = 65000;
    const a3 = await computePortfolioRiskAnalytics(changed, { fetchers });
    expect(a3.cached).toBeUndefined();
  });

  it('empty assets → honest no-assets', async () => {
    const out = await computePortfolioRiskAnalytics([], {});
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-assets');
  });

  it('never throws on garbage input', async () => {
    await expect(computePortfolioRiskAnalytics(null, {})).resolves.toMatchObject({ ok: false });
    const garbage = [{ value: 'NaN' }, { value: -5 }, undefined, { key: 'x', kind: 'stock', symbol: 'ZZZ', market: 'IN', value: 100 }];
    const out = await computePortfolioRiskAnalytics(garbage, {
      fetchers: { yahoo: async () => { throw new Error('net down'); }, binance: async () => null },
    });
    expect(out.ok).toBe(true); // degraded but honest
    expect(out.holdings.length).toBe(0);
    expect(out.skipped.length).toBeGreaterThan(0);
  });

  it('crypto leg: Binance closes first, Yahoo BTC-USD fallback', async () => {
    let yahooCalls = [];
    const f2 = {
      yahoo: async (sym) => { yahooCalls.push(sym); return sym === 'ETH-USD' ? series(60, 2, 0.001, 0.02, 5) : []; },
      binance: async () => null, // Binance dark → fallback fires
    };
    const out = await computePortfolioRiskAnalytics([{ key: 'e', symbol: 'ETH', market: 'IN', kind: 'crypto', value: 5000 }], { fetchers: f2 });
    expect(yahooCalls).toContain('ETH-USD');
    expect(out.holdings.length).toBe(1);
  });

  it('yahoo symbol resolution: IN → .NS, US → plain, crypto handled apart', () => {
    expect(__testables.yahooSymbolFor({ symbol: 'RELIANCE', market: 'IN' })).toBe('RELIANCE.NS');
    expect(__testables.yahooSymbolFor({ symbol: 'AAPL', market: 'US' })).toBe('AAPL');
    expect(__testables.yahooSymbolFor({ symbol: 'RELIANCE.NS', market: 'IN' })).toBe('RELIANCE.NS');
    expect(__testables.yahooSymbolFor({ symbol: null, market: 'IN' })).toBeNull();
  });
});
