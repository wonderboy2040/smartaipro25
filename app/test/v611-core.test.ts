// ============================================================
// test/v611-core.test.ts — GLAMA TIER-2/3 FEATURES (v6.11)
// ------------------------------------------------------------
// Pure-module + gauntlet coverage:
//   1. trust.js — calibration buckets, Brier, monthly trend,
//      insufficient-data honesty, governance p-values
//   2. perf.js — expectancy/MDD/Sharpe/Sortino/streaks/PF on a
//      known R-series; insufficient honesty; byMarket split
//   3. correlation.js — pearson/returnsOf math + skip honesty
//   4. sectors.js — F-Score bounds + SECTOR_MAP coverage
//   5. narrative.js — story + watch line + null-safety
//   6. optionsDesk — computeSkewFlow (real vs synthetic)
//   7. NOTIFY gauntlet — telegram + journal audit, NO position,
//      daily quota NOT consumed
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v611');

const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => [{ market: 'BTCINR', last_price: '100' }]),
}));

const { __setLedgerForTests, __ledgerRaw, recordExecution, markOutcome } = await import('../server/ai/ledger.js');
const { trustReport, governance, __testables: trustTestables } = await import('../server/ai/trust.js');
const { perfReport, __testables: perfTestables } = await import('../server/ai/perf.js');
const { pearson, returnsOf, __testables: corrTestables } = await import('../server/ai/correlation.js');
const { fscoreOf, __testables: sectorTestables } = await import('../server/ai/sectors.js');
const { explainTicker } = await import('../server/ai/narrative.js');
const { computeSkewFlow } = await import('../server/ai/optionsDesk.js');
const {
  executeSignal, loadJournal, dailyStatsExport, __resetForTests, __setJournalForTests, __setConfigForTests,
} = await import('../server/ai/coindcxOrders.js');
const { INDIA_UNIVERSE } = await import('../server/ai/data.js');

beforeEach(() => {
  __resetForTests();
  __setLedgerForTests(null);
  mockPrivate.mockReset();
  mockPrivate.mockResolvedValue({ orders: [{ id: 'oid-1' }] });
});

// ---------------- helpers ----------------
/** Stamp n settled entries: alternating conf/r outcomes at given month offsets. */
function stampLedger(rows) {
  // rows: [{ conf, r, monthsAgo, market, mode, votes }]
  for (const row of rows) {
    const sig = {
      symbol: row.symbol || 'BTC', market: row.market || 'CRYPTO', side: row.r > 0 ? 'LONG' : 'SHORT',
      grade: 'ACTION', confidence: row.conf, agreement: 0.6, summary: 't',
      plan: { entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4, riskPct: 3.2, rewardRisk: 2 },
      votes: row.votes || [{ id: 'trend', dir: 1, conf: 70 }, { id: 'momentum', dir: 1, conf: 60 }],
    };
    const e = recordExecution(sig, { mode: row.mode || 'paper', market: sig.market, source: 'test' });
    markOutcome(e.id, { r: row.r, pnlINR: row.r * 320, reason: 'test', exit: row.r > 0 ? 106 : 96.8 });
    // backdate the outcome timestamp AFTER settling (monthly-trend input);
    // hash-chaining itself is covered by the v67 suite. __setLedgerForTests
    // persists the mutated state back to disk (raw load is a fresh read).
    const ts = Date.now() - (row.monthsAgo || 0) * 31 * 86400_000;
    const l = __ledgerRaw();
    const found = l.entries.find(x => x.id === e.id);
    if (found) { found.outcome.ts = ts; found.ts = ts; }
    __setLedgerForTests(l);
  }
}

// ---------------- 1. trust layer ----------------
describe('trust: calibration + Brier + monthly', () => {
  it('refuses to calibrate below 10 settled entries (honesty)', () => {
    stampLedger(Array.from({ length: 8 }, (_, i) => ({ conf: 80, r: i % 2 ? 1 : -1 })));
    const t = trustReport();
    expect(t.sufficient).toBe(false);
    expect(t.brier).toBeNull();
    expect(String(t.note)).toContain('Insufficient');
  });

  it('computes calibration buckets: claimed band vs realized WR', () => {
    // 12 settled at conf 70 (bucket 65-75): 8 wins → 66.7% realized
    stampLedger(Array.from({ length: 12 }, (_, i) => ({ conf: 70, r: i < 8 ? 1 : -1 })));
    const t = trustReport();
    expect(t.sufficient).toBe(true);
    const b = t.calibration.find(x => x.bucket === '65-75%');
    expect(b).toBeTruthy();
    expect(b.n).toBe(12);
    expect(b.winRate).toBeCloseTo(66.7, 1);
    expect(b.gap).toBeCloseTo(66.7 - 70, 1);
  });

  it('Brier: perfect claims → 0; coin claims → ~0.25', () => {
    // perfect: claim 100, all wins
    __setLedgerForTests(null);
    stampLedger(Array.from({ length: 12 }, () => ({ conf: 100, r: 1 })));
    expect(trustReport().brier).toBeCloseTo(0, 4);
    // coin: claim 50 with a 50/50 outcome
    __setLedgerForTests(null);
    stampLedger(Array.from({ length: 12 }, (_, i) => ({ conf: 50, r: i % 2 ? 1 : -1 })));
    expect(trustReport().brier).toBeCloseTo(0.25, 4);
  });

  it('monthly trend groups by IST month and reports drift', () => {
    __setLedgerForTests(null);
    stampLedger([
      { conf: 70, r: 1, monthsAgo: 2 }, { conf: 70, r: 1, monthsAgo: 2 },
      { conf: 70, r: -1, monthsAgo: 2 }, { conf: 70, r: 1, monthsAgo: 2 },
      { conf: 70, r: 1, monthsAgo: 1 }, { conf: 70, r: 1, monthsAgo: 1 },
      { conf: 70, r: 1, monthsAgo: 1 }, { conf: 70, r: 1, monthsAgo: 1 },
      { conf: 70, r: 1 }, { conf: 70, r: 1 }, { conf: 70, r: 1 }, { conf: 70, r: -1 },
    ]);
    const t = trustReport();
    expect(t.monthly.length).toBeGreaterThanOrEqual(2);
    expect(t.monthly[0].n).toBe(4);
    // months: [2mo: 3/4=75%] [1mo: 4/4=100%] [now: 3/4=75%]
    // prior avg (weighted) = (75+100)/2 = 87.5 → drift = 75 − 87.5 = −12.5
    expect(t.drift).toBeCloseTo(-12.5, 1);
  });
});

describe('trust: governance p-values', () => {
  it('labels a perfect model SIGNIFICANT and small-n NEEDS DATA', () => {
    __setLedgerForTests(null);
    // attribution semantics (ledger.js): model aligned-with-side on a WIN,
    // or opposing a losing trade → calledItRight. A PERFECT model therefore
    // votes +1 on winning LONGs AND +1 against losing SHORTs (dir stays +1).
    stampLedger(Array.from({ length: 14 }, (_, i) => ({
      conf: 70, r: i % 2 ? 1 : -1,
      votes: [
        { id: 'trend', dir: 1, conf: 70 },                              // always right
        ...(i < 4 ? [{ id: 'momentum', dir: 1, conf: 60 }] : []),        // small sample
      ],
    })));
    const g = governance();
    const trend = g.models.find(m => m.model === 'trend');
    const momentum = g.models.find(m => m.model === 'momentum');
    // base rate = 7/14 = 50% — 'trend' hits 14/14
    expect(trend.n).toBe(14);
    expect(trend.hitRate).toBeCloseTo(100, 1);
    expect(trend.pValue).toBeLessThan(0.05);
    expect(trend.verdict).toBe('SIGNIFICANT');
    // momentum small-n → refuses a verdict
    expect(momentum.n).toBe(4);
    expect(momentum.verdict).toBe('NEEDS DATA');
  });
});

// ---------------- 2. perf analytics ----------------
describe('perf: R-series analytics', () => {
  it('refuses below 5 settled trades', () => {
    stampLedger(Array.from({ length: 4 }, () => ({ conf: 70, r: 1 })));
    const p = perfReport();
    expect(p.sufficient).toBe(false);
  });

  it('computes expectancy, MDD, streaks and profit factor on a known series', () => {
    __setLedgerForTests(null);
    // series: +1, +1, +1, -1, +2, -1, -1, +3  (cum: 1,2,3,2,4,3,2,5)
    stampLedger([
      { conf: 70, r: 1 }, { conf: 70, r: 1 }, { conf: 70, r: 1 }, { conf: 70, r: -1 },
      { conf: 70, r: 2 }, { conf: 70, r: -1 }, { conf: 70, r: -1 }, { conf: 70, r: 3 },
    ]);
    const p = perfReport();
    expect(p.sufficient).toBe(true);
    expect(p.settled).toBe(8);
    expect(p.expectancy).toBeCloseTo(0.63, 1);   // 5/8 = 0.625 → r2 rounds 0.63
    expect(p.totalR).toBe(5);
    expect(p.winRate).toBeCloseTo(62.5, 1);       // 5/8 wins
    // MDD: peak 4 → trough 2 → 2R
    expect(p.mdd.r).toBe(2);
    // streaks: 3 wins in a row; 2 losses
    expect(p.streaks).toEqual({ win: 3, loss: 2 });
    // PF: gross win 1+1+1+2+3=8 / gross loss 3 → 2.67
    expect(p.profitFactor).toBeCloseTo(2.67, 1);
    // equity curve ends at totalR
    expect(p.equityCurveR.at(-1)).toBe(5);
  });

  it('MDD helper: monotonic curve → 0; V-shape → correct depth', () => {
    expect(perfTestables.maxDrawdown([1, 2, 3, 4]).mdd).toBe(0);
    expect(perfTestables.maxDrawdown([5, 4, 3, 6]).mdd).toBe(2);
  });

  it('splits stats by market and mode', () => {
    __setLedgerForTests(null);
    stampLedger([
      { conf: 70, r: 1, market: 'INDIA', mode: 'paper' },
      { conf: 70, r: -1, market: 'INDIA', mode: 'paper' },
      { conf: 70, r: 2, market: 'CRYPTO', mode: 'live' },
      { conf: 70, r: 1, market: 'CRYPTO', mode: 'live' },
      { conf: 70, r: 1, market: 'FUTURES', mode: 'paper' },
    ]);
    const p = perfReport();
    expect(p.byMarket.india?.n).toBe(2);
    expect(p.byMarket.india?.totalR).toBe(0);
    expect(p.byMarket.crypto?.n).toBe(2);
    expect(p.byMarket.crypto?.totalR).toBe(3);
    expect(p.byMode.live?.n).toBe(2);
  });
});

// ---------------- 3. correlation math ----------------
describe('correlation: pearson + returns', () => {
  it('pearson: identical → +1, inverted → −1, alternating → ~0', () => {
    const a = [1, 2, 3, 4, 5, 6];
    expect(pearson(a, [...a])).toBeCloseTo(1, 3);
    expect(pearson(a, a.map(x => -x))).toBeCloseTo(-1, 3);
    expect(Math.abs(pearson(a, [1, -1, 1, -1, 1, -1]))).toBeLessThan(0.9);
  });

  it('returnsOf: simple daily returns, oldest-first', () => {
    expect(returnsOf([100, 110, 99])).toEqual([0.1, -0.1]);
    expect(returnsOf([100])).toEqual([]);
  });

  it('matrix module exposes the asset set + honest overlap floor', () => {
    expect(corrTestables.ASSETS.length).toBeGreaterThanOrEqual(13);
    expect(corrTestables.MIN_OVERLAP).toBe(40);
  });
});

// ---------------- 4. F-Score + sector map ----------------
describe('sectors: F-Score (trend quality)', () => {
  const perfectRow = {
    ltp: 105, ema20: 100, ema50: 95, rsi: 58, macd: 1, macdSignal: 0.5,
    adx: 28, changePct: 1.2, vwap: 104, relVolume: 1.4, high52w: 110, low52w: 80,
  };
  const brokenRow = {
    ltp: 80, ema20: 100, ema50: 110, rsi: 20, macd: -2, macdSignal: -1,
    adx: 8, changePct: -2, vwap: 95, relVolume: 0.4, high52w: 120, low52w: 82,
  };
  it('all 9 checks pass → 9/A; all fail → 0/C', () => {
    expect(fscoreOf(perfectRow).score).toBe(9);
    expect(fscoreOf(perfectRow).grade).toBe('A');
    expect(fscoreOf(brokenRow).score).toBe(0);
    expect(fscoreOf(brokenRow).grade).toBe('C');
  });
  it('null-safety: empty row → score without throwing', () => {
    const f = fscoreOf({});
    expect(f.score).toBe(0);
    expect(f.checks.length).toBe(9);
    expect(f.pos52).toBeNull();
  });
  it('SECTOR_MAP covers the whole 45-stock universe exactly once', () => {
    const all = Object.values(sectorTestables.SECTOR_MAP).flat();
    expect(new Set(all).size).toBe(all.length);           // no dupes
    for (const s of INDIA_UNIVERSE) {
      expect(all).toContain(s);
    }
    expect(all.length).toBe(INDIA_UNIVERSE.length);
  });
});

// ---------------- 5. narrative ----------------
describe('narrative: explainTicker', () => {
  const signal = { symbol: 'SBIN', market: 'INDIA', side: 'SHORT', confidence: 57, ltp: 1030, changePct: -0.8 };
  const ind = {
    ema20: 1035.8, ema50: 1038.1, rsi: 38, macd: -2.1, macdSignal: -1.4,
    atr: 14.2, adx: 31, vwap: 1033, bbUpper: 1050, bbLower: 1010,
    relVolume: 1.8, high52w: 912, low52w: 781,
  };
  it('tells the trend/momo/vol/struct story with a watch line', () => {
    const n = explainTicker(signal, ind);
    expect(n).toBeTruthy();
    expect(n.title).toContain('SBIN');
    expect(n.title).toContain('BEARISH');
    expect(n.story.length).toBeGreaterThanOrEqual(5);
    expect(n.story.join(' ')).toContain('Trend DOWN');
    expect(n.story.join(' ')).toContain('RSI 38');
    expect(n.watch).toContain('Kya dekhna hai');
  });
  it('null-safe: no ltp → null; sparse indicators + no day change → null', () => {
    expect(explainTicker({ ...signal, ltp: null }, ind)).toBeNull();
    expect(explainTicker({ ...signal, changePct: 0 }, {})).toBeNull();
    // a day-change alone still yields an honest one-liner, not a crash
    const one = explainTicker(signal, {});
    expect(one).toBeTruthy();
    expect(one.story.length).toBe(1);
  });
});

// ---------------- 6. options skew + flow ----------------
describe('optionsDesk: computeSkewFlow', () => {
  const chain = (rows) => ({ rows, source: 'nse' });
  it('computes OTM put−call IV skew + volume flow on a real chain', () => {
    const spot = 100;
    const mk = (strike, putIV, callIV, cvol, pvol, dCall, dPut) => ({
      strike, putIV, callIV, callVolume: cvol, putVolume: pvol,
      callOIChange: dCall, putOIChange: dPut, callOI: 500, putOI: 500,
    });
    const c = chain([
      mk(94, 18, 14, 100, 900, 400, 500),   // OTM put zone
      mk(96, 17, 14.5, 100, 800, 350, 300),
      mk(100, 15, 15, 500, 500, 0, 0),      // ATM
      mk(104, 14, 12.5, 700, 200, 600, 80), // OTM call zone — calls adding OI
      mk(106, 13.5, 12, 600, 100, 500, 60),
    ]);
    const out = computeSkewFlow(c, spot);
    expect(out).toBeTruthy();
    // put IV avg (18+17)/2 = 17.5; call avg (12.5+12)/2 = 12.25 → skew ≈ +5.3
    expect(out.skew.value).toBeCloseTo(5.3, 1);
    expect(out.skew.read).toContain('put skew');
    // vol ratio: calls 2000 / puts 2500 = 0.8
    expect(out.flow.callPutVolRatio).toBeCloseTo(0.8, 2);
    expect(out.flow.oiLean).toBeGreaterThan(0); // calls adding more
    expect(out.flow.oiLeanRead).toContain('bullish');
  });
  it('synthetic chain (no volume/OI) → honest null', () => {
    const c = chain([{ strike: 100, putIV: 15, callIV: 15, callVolume: 0, putVolume: 0, callOI: 0, putOI: 0 }]);
    expect(computeSkewFlow(c, 100)).toBeNull();
  });
});

// ---------------- 7. NOTIFY gauntlet ----------------
describe('notify gauntlet (crypto desk)', () => {
  const STRONG = (symbol = 'BTC') => ({
    symbol, market: 'CRYPTO', side: 'LONG', grade: 'STRONG',
    confidence: 82, agreement: 0.78, generatedAt: Date.now(), ltp: 100,
    plan: { entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4, riskPct: 3.2, rewardRisk: 2 },
    votes: [{ id: 'trend', dir: 1, conf: 80 }], summary: 'x',
  });

  it('runs the gauntlet, sends telegram, audits the journal, creates NO position', async () => {
    __setConfigForTests({ mode: 'paper', dailyMaxTrades: 3, cryptoLeverage: 1 });
    __setJournalForTests({ entries: [], positions: [] });
    const sendTelegram = vi.fn(async () => ({ ok: true }));
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'notify',
      getFreshSignal: async () => STRONG('BTC'),
      source: 'test', sendTelegram,
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('notify');
    expect(out.notified).toBe(true);
    expect(out.telegramSent).toBe(true);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(String(sendTelegram.mock.calls[0][0])).toContain('BTCINR');
    expect(String(sendTelegram.mock.calls[0][0])).toContain('NOTIFY');
    // telegram NOT sent: honest note instead
    expect(out.alert).toBeTruthy();
    expect(out.alert.pair).toBe('BTCINR');
    // journal: NOTIFIED audit entry, zero positions
    const j = loadJournal();
    expect(j.positions.length).toBe(0);
    expect(j.entries.some(e => e.status === 'NOTIFIED')).toBe(true);
    // daily quota NOT consumed by notifications
    expect(dailyStatsExport(j).tradesCount).toBe(0);
  });

  it('telegram unconfigured → ok with honest note (audit still written)', async () => {
    __setConfigForTests({ mode: 'paper', dailyMaxTrades: 3, cryptoLeverage: 1 });
    __setJournalForTests({ entries: [], positions: [] });
    const out = await executeSignal({
      symbol: 'ETH', side: 'LONG', mode: 'notify',
      getFreshSignal: async () => STRONG('ETH'),
      source: 'test',
    });
    expect(out.ok).toBe(true);
    expect(out.telegramSent).toBe(false);
    expect(String(out.note)).toContain('Telegram');
    expect(loadJournal().entries.some(e => e.status === 'NOTIFIED')).toBe(true);
  });

  it('kill switch still blocks a notification (alert bhi trust nahi karta dead engine ko)', async () => {
    __setConfigForTests({ killSwitch: true, mode: 'paper', cryptoLeverage: 1 });
    __setJournalForTests({ entries: [], positions: [] });
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'notify',
      getFreshSignal: async () => STRONG('BTC'),
      source: 'test', sendTelegram: vi.fn(async () => ({ ok: true })),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('Kill switch');
  });
});
