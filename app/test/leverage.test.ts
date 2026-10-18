// ============================================================
// test/leverage.test.ts — v6.6 CRYPTO LEVERAGE
// ------------------------------------------------------------
// Pure math (computeLeverageView / maxSaneLeverage), the leverage
// gates inside executeSignal (server clamp, liq-before-SL policy),
// the LIVE CoinDCX MARGIN order body, and the paper liquidation
// close in the watcher.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
  loadJSON: undefined, saveJSON: undefined,
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => [
    { market: 'BTCINR', last_price: '100' },
  ]),
}));

import { computeLeverageView, maxSaneLeverage } from '../server/ai/ensemble.js';
import {
  executeSignal, watchPositions, __resetForTests, __setConfigForTests,
  loadJournal, loadConfig, updateConfig,
} from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// v20.2: paper-fill slippage OFF for this suite — its subject is
// leverage/trailing math, not fill realism (locked in aiOrders/v202 tests).
process.env.AI_COINDCX_SLIP_BPS = '0';

const STRONG = {
  symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'STRONG',
  confidence: 82, agreement: 0.78, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4,
    risk: 3.2, riskPct: 3.2, rewardRisk: 2, atrUsed: 2, planStyle: 'atr-based',
  },
  votes: [], summary: 'x',
};
const freshSignal = async () => ({ ...STRONG });

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  // default: no active-pairs list reachable → convention fallback (B-BTC_INR)
  mockPrivate.mockImplementation(async (path) => {
    if (path === '/exchange/v1/margin/active_pairs') throw new Error('unreachable');
    return { orders: [{ id: 'margin-order-1' }] };
  });
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ---------------- pure math ----------------
describe('maxSaneLeverage', () => {
  it('a 5% stop allows up to 19x mathematically, capped at the config ceiling', () => {
    expect(maxSaneLeverage(5, 10)).toBe(10);
    expect(maxSaneLeverage(5, 20)).toBe(19);
  });

  it('a 10% stop caps leverage at 9x', () => {
    expect(maxSaneLeverage(10, 10)).toBe(9);
  });

  it('a 30% stop (wide crypto stop) caps leverage at 3x', () => {
    expect(maxSaneLeverage(30, 10)).toBe(3);
  });

  it('garbage inputs fall back to 1x', () => {
    expect(maxSaneLeverage(NaN)).toBe(1);
    expect(maxSaneLeverage(0)).toBe(1);
    expect(maxSaneLeverage(-5)).toBe(1);
  });
});

describe('computeLeverageView', () => {
  it('computes notional/qty/liquidation/risk for a LONG with 5x', () => {
    const v = computeLeverageView({ side: 'LONG', entry: 100, stopLoss: 96.8, target2: 106.4, marginINR: 1000, leverage: 5 });
    expect(v).not.toBeNull();
    expect(v!.notionalINR).toBe(5000);
    expect(v!.qty).toBeCloseTo(50, 4);
    // liquidation ≈ 100 × (1 − 0.95/5) = 81
    expect(v!.liquidation).toBeCloseTo(81, 1);
    // ₹ risk = 50 × 3.2 = 160 = 16% of the ₹1000 margin
    expect(v!.riskINR).toBeCloseTo(160, 0);
    expect(v!.effRiskOnMarginPct).toBeCloseTo(16, 0);
    expect(v!.rewardT2INR).toBeCloseTo(50 * 6.4, 0);
    // liquidation distance 19% vs SL 3.2% → SL fires first, plan works
    expect(v!.liqBeforeSl).toBe(false);
  });

  it('SHORT mirrors the liquidation above entry', () => {
    const v = computeLeverageView({ side: 'SHORT', entry: 100, stopLoss: 103.2, target2: 93.6, marginINR: 500, leverage: 3 });
    expect(v!.liquidation).toBeCloseTo(100 * (1 + 0.95 / 3), 1); // ≈131.67
    expect(v!.liqBeforeSl).toBe(false);
  });

  it('flags liqBeforeSl when leverage puts liquidation inside the stop', () => {
    // 3.2% stop, 30x → liq at ~3.17% < 3.2% stop distance
    const v = computeLeverageView({ side: 'LONG', entry: 100, stopLoss: 96.8, target2: 106.4, marginINR: 1000, leverage: 30 });
    expect(v!.liqBeforeSl).toBe(true);
    expect(v!.maxSaneLeverage).toBe(10); // 95/3.2 = 29.7 → capped by default 10
  });

  it('returns null for broken inputs (SL on the wrong side / zero margin)', () => {
    expect(computeLeverageView({ side: 'LONG', entry: 100, stopLoss: 104, target2: 96, marginINR: 100, leverage: 2 })).toBeNull();
    expect(computeLeverageView({ side: 'LONG', entry: 100, stopLoss: 96, target2: 104, marginINR: 0, leverage: 2 })).toBeNull();
  });
});

// ---------------- config ----------------
describe('cryptoLeverage config', () => {
  it('defaults to 3 and clamps to 1..10', () => {
    expect(loadConfig().cryptoLeverage).toBe(3);
    updateConfig({ cryptoLeverage: 7 });
    expect(loadConfig().cryptoLeverage).toBe(7);
    updateConfig({ cryptoLeverage: 50 });
    expect(loadConfig().cryptoLeverage).toBe(10);
    updateConfig({ cryptoLeverage: 0 });
    expect(loadConfig().cryptoLeverage).toBe(1);
  });
});

// ---------------- execute path ----------------
describe('executeSignal with leverage (paper)', () => {
  it('scales qty by leverage: ₹500 margin @ 4x on ₹100 BTC = 20 units', async () => {
    updateConfig({ cryptoLeverage: 5 }); // default ceiling is 3 — raise for 4x
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', qtyINR: 500, leverage: 4, getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    expect(out.filled!.qty).toBeCloseTo(20, 4);
    expect(out.filled!.notionalINR).toBeCloseTo(2000, 0);
    expect(out.filled!.leverage).toBe(4);
    expect(out.filled!.marginINR).toBeCloseTo(500, 0);
    const p = out.position!;
    expect(p.leverage).toBe(4);
    expect(p.marginINR).toBeCloseTo(500, 0);
    // liquidation ≈ 100 × (1 − 0.95/4) = 76.25
    expect(p.liquidation).toBeCloseTo(76.25, 1);
  });

  it('server clamps a client leverage above the config ceiling', async () => {
    __setConfigForTests({ cryptoLeverage: 3 });
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', qtyINR: 500, leverage: 10, getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    expect(out.filled!.leverage).toBe(3);
    expect(out.position!.leverage).toBe(3);
  });

  it('PAPER auto-reduces leverage when liquidation would fire before the SL', async () => {
    // 12% stop survives the risk gate only when the user has widened
    // "Max stop %" (default 5 would auto-FIT it tighter first, after which
    // every sane leverage is fine). Wide-stop config + 10x request:
    // sane max = floor(95/12) = 7 → paper reduces, never dead-ends.
    const wide = { ...STRONG, plan: { ...STRONG!.plan!, stopLoss: 88, risk: 12, riskPct: 12 } };
    updateConfig({ cryptoLeverage: 10, maxRiskPct: 15 });
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', qtyINR: 500, leverage: 10, getFreshSignal: async () => wide });
    expect(out.ok).toBe(true);
    expect(out.filled!.leverage).toBe(7);
    expect(out.fitted).toMatch(/auto-reduced 10x → 7x/);
  });

  it('LIVE rejects honestly when liquidation would fire before the SL', async () => {
    const wide = { ...STRONG, plan: { ...STRONG!.plan!, stopLoss: 88, risk: 12, riskPct: 12 } };
    updateConfig({ cryptoLeverage: 10, maxRiskPct: 15 });
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', qtyINR: 500, leverage: 10, getFreshSignal: async () => wide });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Leverage gate/);
    expect(out.error).toMatch(/≤ 7x/);
  });
});

describe('executeSignal with leverage (LIVE margin order)', () => {
  it('leverage > 1 routes through the MARGIN API with a B-pair and margin block', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now(), cryptoLeverage: 5 });
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', qtyINR: 400, leverage: 5, getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    expect(out.orderId).toBe('margin-order-1');
    const marginCall = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/margin/orders');
    expect(marginCall).toBeDefined();
    const body = marginCall![3];
    expect(body.pair).toBe('B-BTC_INR');         // v18.9: convention fallback carries the underscore (CoinDCX margin pair naming)
    expect(body.side).toBe('buy');
    expect(body.order_type).toBe('market_order');
    expect(body.leverage).toBe(5);
    expect(body.total_quantity).toBe('20');       // (400 × 5) / 100
    // margin_amount_* = the MARGIN you commit (notional ÷ leverage) = 400
    expect(body.margin.margin_amount_long).toBeCloseTo(400, 0);
    expect(body.margin.margin_amount_short).toBe(0);
    expect(body.margin.margin_amount_needed).toBeCloseTo(400, 0);
    expect(body.margin.margin_currency_long).toBe('INR');
    expect(out.position!.leverage).toBe(5);
    expect(out.position!.marginINR).toBeCloseTo(400, 0);
    expect(out.position!.marginPair).toBe('B-BTC_INR'); // v18.9: underscore convention
    expect(out.position!.liquidation).toBeCloseTo(81, 1);
  });

  it('SHORT margin order fills margin_amount_short', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now(), cryptoLeverage: 2 });
    const short = { ...STRONG, side: 'SHORT' };
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', qtyINR: 300, leverage: 2, getFreshSignal: async () => short });
    expect(out.ok).toBe(true);
    const marginCall = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/margin/orders');
    const body = marginCall![3];
    expect(body.side).toBe('sell');
    expect(body.leverage).toBe(2);
    expect(body.total_quantity).toBe('6');        // (300 × 2) / 100
    expect(body.margin.margin_amount_short).toBeCloseTo(300, 0); // the margin, not the notional
    expect(body.margin.margin_amount_long).toBe(0);
  });

  it('leverage 1 keeps the battle-tested SPOT path (no margin call)', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now(), cryptoLeverage: 5 });
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', qtyINR: 400, getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    expect(mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/margin/orders')).toBeUndefined();
    const spotCall = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/orders/create');
    expect(spotCall).toBeDefined();
    // v12.1 LIVE-FIX: spot contract = `market` field + `market_order`
    expect(spotCall![3].market).toBe('BTCINR');
    expect(spotCall![3].order_type).toBe('market_order');
    expect(out.position!.leverage).toBeUndefined();
  });

  it('uses the exchange active-pairs list when reachable', async () => {
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/margin/active_pairs') return [{ pair: 'B-BTC_INR', leverage: 5 }];
      return { orders: [{ id: 'm1' }] };
    });
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now(), cryptoLeverage: 5 });
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', qtyINR: 400, leverage: 5, getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    const marginCall = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/margin/orders');
    expect(marginCall![3].pair).toBe('B-BTC_INR'); // exchange-listed name wins
  });
});

// ---------------- watcher: paper liquidation ----------------
describe('watchPositions — liquidation close', () => {
  const tickersAt = async (price: string) => {
    const { fetchCoinDcxTickers } = await import('../server/cryptoStream.js');
    vi.mocked(fetchCoinDcxTickers).mockImplementation(async () => [{ market: 'BTCINR', last_price: price }]);
  };

  it('closes a leveraged paper position AT the liquidation price when breached', async () => {
    updateConfig({ cryptoLeverage: 5 });
    // margin 500 @ 5x on ₹100 → 25 units, liquidation ≈ 81
    await executeSignal({ symbol: 'BTC', mode: 'paper', qtyINR: 500, leverage: 5, getFreshSignal: freshSignal });
    const j = loadJournal();
    expect(j.positions[0].leverage).toBe(5);
    // price crashes through the liquidation: 80 ≤ 81 → LIQUIDATED (not the 96.8 SL)
    await tickersAt('80');
    const closures = await watchPositions({});
    expect(closures).toHaveLength(1);
    expect(closures[0].reason).toMatch(/LIQUIDATED/);
    const j2 = loadJournal();
    const closed = j2.positions[0];
    expect(closed.status).toBe('CLOSED');
    expect(closed.closeReason).toBe('LIQUIDATED (est.)');
    expect(closed.closePrice).toBe(81);       // closed AT the liquidation level
    // loss = (81 − 100) × 25 = −475 ≈ the committed margin (honest sim)
    // v18.9 FEE HONESTY: gross −475 minus both-side taker fees (100+81)×25×0.10% = −4.53
    expect(closed.pnlINR).toBeCloseTo(-479.53, 1);
  });

  it('liquidation check wins over SL when price is beyond BOTH', async () => {
    updateConfig({ cryptoLeverage: 5 });
    await executeSignal({ symbol: 'BTC', mode: 'paper', qtyINR: 500, leverage: 5, getFreshSignal: freshSignal });
    const { __setJournalForTests } = await import('../server/ai/coindcxOrders.js');
    const j = loadJournal();
    j.positions[0].liquidation = 96;           // above the natural 81 — inside the SL 96.8
    __setJournalForTests(j);
    // price 90: below BOTH liq 96 and SL 96.8 → liquidation closes first
    await tickersAt('90');
    const closures = await watchPositions({});
    expect(closures).toHaveLength(1);
    expect(closures[0].reason).toMatch(/LIQUIDATED/);
    const j2 = loadJournal();
    expect(j2.positions[0].closeReason).toBe('LIQUIDATED (est.)');
  });
});
