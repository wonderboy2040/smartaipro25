// ============================================================
// test/globalRisk.test.ts — v10.15 GAP 4
// ------------------------------------------------------------
// THE GLOBAL RISK BRAIN contract:
//   • ONE exposure view across BOTH desks (risk deployed, net bias)
//   • combined heat over the shared cap → the SECOND desk's entry is
//     vetoed regardless of which desk asks
//   • correlated risk-off (VIX spike + BTC breakdown TOGETHER) →
//     BOTH desks' sizing is down-weighted at once
//   • each leg alone (VIX spike only / BTC breakdown only) ≠ risk-off
//   • unreachable market data → riskOff FALSE + dataOk false (missing
//     data is not a signal — never a fake de-risk)
//   • positions without a readable SL count as `unpriced`, never as
//     an invented risk number
//   • independent regimes → no interference
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockPrivate = vi.fn();
const mockPrivateGET = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxPrivateGET: (...args) => mockPrivateGET(...args),
  coindcxConnected: () => false,
  coindcxStatus: () => ({ connected: false }),
  fetchGlobalFuturesInstruments: vi.fn(async () => []),
}));

const JOURNAL = {
  positions: [
    // crypto futures: entry 60000, sl 59000, qty 0.5 → 500 USDT risk × fx 84 = ₹42,000... too big for the test cap;
    // use the numbers to force SPECIFIC heat outcomes below.
    { id: 'c1', market: 'FUTURES', pair: 'B-BTC_USDT', side: 'LONG', status: 'OPEN', entryPrice: 100, sl: 95, qty: 100 },   // 500 USDT → ₹42,000? no: (100-95)*100 = 500 units→×84 = ₹42,000
    { id: 'c2', market: 'CRYPTO', pair: 'ETHINR', side: 'SHORT', status: 'OPEN', entryPrice: 3000, sl: 3060, qty: 2 },      // 60×2 = ₹120 (INR domain)
    { id: 'i1', market: 'INDIA', pair: 'RELIANCE', side: 'LONG', status: 'OPEN', entryPrice: 1200, sl: 1176, qty: 10 },     // 24×10 = ₹240
    { id: 'i2', market: 'INDIA', pair: 'SBIN', side: 'LONG', status: 'OPEN', entryPrice: 800, sl: 788, qty: 25 },           // 12×25 = ₹300
    // no readable SL → unpriced, never invented
    { id: 'c3', market: 'FUTURES', pair: 'B-SOL_USDT', side: 'LONG', status: 'OPEN', entryPrice: 150, sl: null, qty: 10 },
    // CLOSED / UNKNOWN-status noise: CLOSED never counts
    { id: 'c4', market: 'CRYPTO', pair: 'XRPINR', side: 'LONG', status: 'CLOSED', entryPrice: 50, sl: 45, qty: 100 },
  ],
};
const mockLoadJournal = vi.fn(() => JOURNAL);
vi.mock('../server/ai/coindcxOrders.js', async () => {
  const actual = await vi.importActual('../server/ai/coindcxOrders.js');
  return { ...actual, loadJournal: () => mockLoadJournal() };
});
vi.mock('../server/ai/futures.js', async () => {
  const actual = await vi.importActual('../server/ai/futures.js');
  return { ...actual, fetchUsdInr: async () => 84 };
});

import {
  deskExposure, riskOffOf, globalRiskView, globalRiskGate,
  globalHeatCapPct, riskOffMultiplier, globalRiskEnabled,
  _setGlobalRiskFetchForTest, _setGlobalRiskMatrixForTest, _resetGlobalRiskForTest,
} from '../server/ai/globalRisk.js';

const yahooCloses = (closes) => ({ json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: closes }] } }] } }) });

// VIX calm 14→15, BTC healthy above its 20d average
const CALM_MARKET = {
  vixFetch: yahooCloses([14, 14, 14, 14, 14, 15]),
  btcFetch: yahooCloses(Array.from({ length: 25 }, (_, i) => 60000 + i * 100)), // rising — above SMA20
};
// VIX spike 15→28 (+87%) AND BTC below SMA20 by >1.5%
const RISK_OFF_MARKET = {
  vixFetch: yahooCloses([15, 15, 15, 15, 15, 28]),
  btcFetch: yahooCloses([...Array(19).fill(60000), 59000, 58000]), // last < SMA20×0.985
};
// only ONE leg: VIX spiking, BTC healthy
const VIX_ONLY = { vixFetch: RISK_OFF_MARKET.vixFetch, btcFetch: CALM_MARKET.btcFetch };
const BTC_ONLY = { vixFetch: CALM_MARKET.vixFetch, btcFetch: RISK_OFF_MARKET.btcFetch };

function armMarket(m) {
  _setGlobalRiskFetchForTest(async (url) => {
    if (String(url).includes('%5EVIX')) return m.vixFetch;
    if (String(url).includes('BTC-USD')) return m.btcFetch;
    throw new Error('unexpected fetch');
  });
}
function armCorrelation(r) {
  _setGlobalRiskMatrixForTest(async () => ({ riskLink: { pair: 'BTC↔NIFTY', r } }));
}

const ORIG_ENV = {
  CAP: process.env.AI_GLOBAL_HEAT_CAP_PCT,
  MUL: process.env.AI_RISKOFF_MUL,
  DIS: process.env.AI_DISABLE_GLOBAL_RISK,
};

beforeEach(() => {
  _resetGlobalRiskForTest();
  armMarket(CALM_MARKET);
  armCorrelation(0.35);
  delete process.env.AI_GLOBAL_HEAT_CAP_PCT;
  delete process.env.AI_RISKOFF_MUL;
  delete process.env.AI_DISABLE_GLOBAL_RISK;
});
afterEach(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('deskExposure — the ONE cross-desk view (pure)', () => {
  it('sums per-position stop-distance risk across BOTH desks with the right currency domains', () => {
    const e = deskExposure(JOURNAL, 84);
    // crypto: c1 (100−95)×100 = 500 units × 84 fx = ₹42,000 + c2 (3060−3000)×2 = ₹120 (INR)
    expect(e.desks.crypto.riskINR).toBe(42_120);
    expect(e.desks.crypto.open).toBe(3);       // c1, c2 + unpriced c3
    expect(e.desks.crypto.unpriced).toBe(1);   // c3 has no SL — counted, never invented
    // india: 240 + 300 = ₹540
    expect(e.desks.india.riskINR).toBe(540);
    expect(e.desks.india.open).toBe(2);
    // combined: 42660, net bias 4 long − 1 short = +3 (c1, i1, i2, c3 long; c2 short)
    expect(e.total.riskINR).toBe(42_660);
    expect(e.total.netDirBias).toBe(3);
    expect(e.total.unpriced).toBe(1);
    // CLOSED rows never count
    expect(e.total.open).toBe(5);
  });

  it('positions without a readable SL are unpriced — never a fabricated number', () => {
    const e = deskExposure({ positions: [{ market: 'FUTURES', pair: 'B-X_USDT', side: 'LONG', status: 'OPEN', entryPrice: 100, qty: 5 }] }, 84);
    expect(e.desks.crypto.riskINR).toBe(0);
    expect(e.desks.crypto.unpriced).toBe(1);
  });

  it('empty journal → zero exposure, no crash', () => {
    const e = deskExposure({ positions: [] }, 84);
    expect(e.total.riskINR).toBe(0);
    expect(e.total.open).toBe(0);
    expect(e.total.netDirBias).toBe(0);
  });
});

describe('riskOffOf — correlated risk-off detection (pure)', () => {
  const mk = (closes) => closes;

  it('VIX spike AND BTC breakdown together → risk-off', () => {
    const r = riskOffOf({ vix: 28, vix5dAgo: 15, btcCloses: mk([...Array(19).fill(60000), 59000, 58000]) });
    expect(r.riskOff).toBe(true);
    expect(r.vixSpike).toBe(true);
    expect(r.btcBreakdown).toBe(true);
    expect(r.dataOk).toBe(true);
  });

  it('each leg ALONE is not risk-off (no over-reaction to a single signal)', () => {
    const vixOnly = riskOffOf({ vix: 28, vix5dAgo: 15, btcCloses: mk(Array.from({ length: 25 }, (_, i) => 60000 + i)) });
    expect(vixOnly.vixSpike).toBe(true);
    expect(vixOnly.riskOff).toBe(false);
    const btcOnly = riskOffOf({ vix: 18, vix5dAgo: 15, btcCloses: mk([...Array(19).fill(60000), 59000, 58000]) });
    expect(btcOnly.btcBreakdown).toBe(true);
    expect(btcOnly.riskOff).toBe(false);
  });

  it('VIX below 25 is not a spike; BTC within 1.5% of SMA20 is not a breakdown', () => {
    expect(riskOffOf({ vix: 22, vix5dAgo: 15, btcCloses: mk([...Array(19).fill(60000), 59200, 59100]) }).riskOff).toBe(false);
  });

  it('missing market data → dataOk false, riskOff FALSE (never a fake de-risk)', () => {
    const r = riskOffOf({ vix: null, vix5dAgo: null, btcCloses: [] });
    expect(r.dataOk).toBe(false);
    expect(r.riskOff).toBe(false);
  });
});

describe('globalRiskView / globalRiskGate — the combined payload + gate', () => {
  it('combined heat over the shared cap → veto fires with the cross-desk reason', async () => {
    // total risk ₹42,660 vs capital 10k + 10k = 20k → heat 213% >> 6% cap
    const g = await globalRiskGate({ cryptoEquityINR: 10_000, indiaCapitalINR: 10_000 });
    expect(g.veto).toBe(true);
    expect(g.reason).toContain('global heat');
    expect(g.heatPct).toBe(213.3);
    expect(g.heatCapPct).toBe(6);
  });

  it('independent small books → no veto, no interference', async () => {
    // same exposure but a huge capital base → heat well under the cap
    const g = await globalRiskGate({ cryptoEquityINR: 1_000_000, indiaCapitalINR: 1_000_000 });
    expect(g.veto).toBe(false);
    expect(g.reason).toBeNull();
    expect(g.heatPct).toBeLessThan(6);
  });

  it('the heat cap is env-tunable (tighter cap vetoes what the default allows)', async () => {
    // big capital base: heat 2.13% — UNDER the 6% default (no veto)…
    process.env.AI_GLOBAL_HEAT_CAP_PCT = '1'; // …but a 1% cap vetoes it
    expect(globalHeatCapPct()).toBe(1);
    const g = await globalRiskGate({ cryptoEquityINR: 1_000_000, indiaCapitalINR: 1_000_000 });
    expect(g.veto).toBe(true);
    expect(g.heatPct).toBe(2.1);
    expect(g.heatCapPct).toBe(1);
  });

  it('correlated risk-off market → BOTH desks get the size-down multiplier from the same view', async () => {
    armMarket(RISK_OFF_MARKET);
    const g = await globalRiskGate({ cryptoEquityINR: 1_000_000, indiaCapitalINR: 1_000_000 });
    expect(g.riskOff).toBe(true);
    expect(g.sizeMul).toBe(0.5); // AI_RISKOFF_MUL default
    // the view carries the legs for transparency
    const v = await globalRiskView({ cryptoEquityINR: 1_000_000, indiaCapitalINR: 1_000_000, force: true });
    expect(v.riskOff.vixSpike).toBe(true);
    expect(v.riskOff.btcBreakdown).toBe(true);
    expect(v.btcNifty).toBe(0.35); // the India↔crypto link from the matrix
  });

  it('single-leg markets → riskOff false → sizeMul 1 (no interference)', async () => {
    armMarket(VIX_ONLY);
    expect((await globalRiskGate({ cryptoEquityINR: 1_000_000, indiaCapitalINR: 1_000_000 })).sizeMul).toBe(1);
    armMarket(BTC_ONLY);
    expect((await globalRiskGate({ cryptoEquityINR: 1_000_000, indiaCapitalINR: 1_000_000 })).sizeMul).toBe(1);
  });

  it('risk-off multiplier is env-tunable (bounded to (0,1])', async () => {
    process.env.AI_RISKOFF_MUL = '0.25';
    expect(riskOffMultiplier()).toBe(0.25);
    process.env.AI_RISKOFF_MUL = '3'; // >1 clamped — never an aggressiveness boost
    expect(riskOffMultiplier()).toBe(1);
  });

  it('AI_DISABLE_GLOBAL_RISK → the brain is a no-op (veto never fires)', async () => {
    process.env.AI_DISABLE_GLOBAL_RISK = 'true';
    expect(globalRiskEnabled()).toBe(false);
    const g = await globalRiskGate({ cryptoEquityINR: 10_000, indiaCapitalINR: 10_000 });
    expect(g.veto).toBe(false);
  });

  it('unreachable market data → honest degrade: no veto-from-ignorance, no risk-off', async () => {
    _setGlobalRiskFetchForTest(async () => { throw new Error('network down'); });
    _setGlobalRiskMatrixForTest(async () => null);
    const v = await globalRiskView({ cryptoEquityINR: 1_000_000, indiaCapitalINR: 1_000_000, force: true });
    expect(v.riskOff.dataOk).toBe(false);
    expect(v.riskOff.riskOff).toBe(false);
    expect(v.btcNifty).toBeNull(); // unknown, never a fake 0
  });
});
