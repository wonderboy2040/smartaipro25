// ============================================================
// test/directionProof.test.ts — v20.4.2 SYMMETRIC DIRECTION CERTIFICATE
// ------------------------------------------------------------
// The user-facing questions this file answers ONCE AND FOREVER:
//   Q1: "SHORT signal pe LONG jata hai ya SHORT?"  → SHORT. 100%.
//   Q2: "LONG signal pe SHORT jata hai ya LONG?"   → LONG.  100%.
//
// Every hop of the direction chain is locked here END-TO-END,
// SYMMETRICALLY for BOTH directions:
//   clicked card side → gauntlet side-veto (server) → exchange
//   order body (buy/sell) → booked position.side → SL/TP level
//   polarity → exit order side. A SHORT card can NEVER produce a
//   LONG trade (and a LONG card can NEVER produce a SHORT trade)
//   on ANY desk (spot / margin / futures), in ANY mode (paper /
//   live), through ANY caller (manual / agent). 20 locks total:
//   10 SHORT (the original v20.4 certificate) + 10 LONG (v20.4.2
//   mirror — the user's explicit "100% pakka" demand, both ways).
//
// v20.4 root-cause context (why the symptom EVER appeared): the
// probrain counter-tape STRONG-ban was fed INDIA-only ltf data,
// so on CRYPTO a lagging 1h bear stack could print STRONG SHORT
// into a rising 15m tape — the fresh consensus then flipped by
// execution time. Fixed at SOURCE in signals.js (tapeEnriched).
// The signal-generation lock lives in cryptoCounterTape.test.ts;
// THIS file locks the EXECUTION side of the contract.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockPrivate = vi.fn();
const mockPrivateGET = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxPrivateGET: (...args) => mockPrivateGET(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
  loadJSON: undefined, saveJSON: undefined,
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => [
    { market: 'BTCINR', last_price: '100' },
    { market: 'ETHINR', last_price: '50' },
  ]),
  lastTickerSource: () => 'coindcx',
}));

import {
  executeSignal, watchPositions, __resetForTests, __setConfigForTests,
  __setJournalForTests, loadJournal, loadConfig,
} from '../server/ai/coindcxOrders.js';
import {
  executeFuturesSignal, __resetFuturesForTests, __setUsdInrForTests,
} from '../server/ai/futures.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// ---------------- fixtures: STRONG 80+ SHORT plans ----------------
// A SHORT plan's geometry: stop ABOVE entry, targets BELOW.
const SPOT_SHORT = {
  symbol: 'BTC', market: 'CRYPTO', side: 'SHORT', grade: 'STRONG',
  confidence: 82, agreement: 0.78, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 103.2, target1: 96.8, target2: 93.6,
    risk: 3.2, riskPct: 3.2, rewardRisk: 2, atrUsed: 2, planStyle: 'atr-based',
  },
  votes: [], summary: 'x', executable: true,
};
const SPOT_LONG = { ...SPOT_SHORT, side: 'LONG', plan: { ...SPOT_SHORT.plan, stopLoss: 96.8, target1: 103.2, target2: 106.4 } };
const FUT_SHORT = {
  symbol: 'BTC', market: 'FUTURES', side: 'SHORT', grade: 'STRONG',
  confidence: 84, agreement: 0.8, generatedAt: Date.now(),
  ltp: 50000, plan: {
    entry: 50000, stopLoss: 51600, target1: 48400, target2: 46800,
    risk: 1600, riskPct: 3.2, rewardRisk: 2, atrUsed: 1000, planStyle: 'atr-based',
  },
  votes: [], summary: 'x', executable: true,
};
const FUT_LONG = { ...FUT_SHORT, side: 'LONG', plan: { ...FUT_SHORT.plan, stopLoss: 48400, target1: 51600, target2: 53200 } };

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  __resetFuturesForTests();
  __setUsdInrForTests(84);
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockPrivateGET.mockReset();
  // default private transport: spot create + margin (active_pairs
  // unreachable → B-<BASE>_INR convention fallback) both succeed.
  mockPrivate.mockImplementation(async (path) => {
    if (path === '/exchange/v1/margin/active_pairs') throw new Error('unreachable');
    if (path === '/exchange/v1/margin/orders') return { orders: [{ id: 'margin-order-1' }] };
    return { orders: [{ id: 'order-123' }] };
  });
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ============================================================
// SPOT DESK — the CoinDcxTab signal card → /api/ai/execute
// ============================================================
describe('SPOT desk: STRONG 80+ SHORT card → trade direction', () => {

  it('PAPER: a STRONG SHORT 82% card opens a SHORT paper position (never LONG)', async () => {
    const out = await executeSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'paper',
      getFreshSignal: async () => ({ ...SPOT_SHORT }),
    });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('SHORT');
    // SHORT paper entry fills ADVERSELY (below mid, the sell-side fill)
    expect(out.position!.entryPrice).toBeLessThan(100);
    // plan levels ride along with the SHORT geometry
    expect(out.position!.sl).toBeCloseTo(103.2, 1);
    expect(out.position!.tp2).toBeCloseTo(93.6, 1);
    const j = loadJournal();
    expect(j.positions[0].side).toBe('SHORT');
    expect(j.entries.at(-1)!.status).toBe('FILLED');
  });

  it('PAPER: clicked SHORT while the fresh consensus flipped LONG → v21.23.2 BLOCKS (silent inversion nahi)', async () => {
    // v21.13 me flipped fresh side silently khul jaata tha (clicked SHORT,
    // trade LONG — user ko "short ka long" dikhta tha). v21.23.2: conflict =
    // honest REJECT — clicked side ke OPPOSITE trade kabhi nahi khulta.
    const out = await executeSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'paper',
      getFreshSignal: async () => ({ ...SPOT_LONG }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fresh consensus LONG/i);
    expect(out.error).toMatch(/blocked \(no auto-flip\)/i);
    const j = loadJournal();
    const flipRej = j.entries.find(e => e.status === 'REJECTED' && e.flippedFrom === 'SHORT');
    expect(flipRej).toBeDefined();
    expect(flipRej!.flippedTo).toBe('LONG');
  });

  it('LIVE: a STRONG SHORT signal sends a SELL order to CoinDCX and books a SHORT position', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'live',
      getFreshSignal: async () => ({ ...SPOT_SHORT }),
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('live');
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/orders/create');
    expect(call).toBeDefined();
    expect(call![3].side).toBe('sell');           // SHORT → sell. Always.
    expect(call![3].market).toBe('BTCINR');
    expect(out.position!.side).toBe('SHORT');
    expect(loadJournal().entries.at(-1)!.status).toBe('SUBMITTED');
  });

  it('LIVE: clicked SHORT but fresh consensus LONG → HONEST REJECT, no order is ever sent (silent flip is impossible)', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'live',
      getFreshSignal: async () => ({ ...SPOT_LONG }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fresh consensus LONG/i);
    expect(out.error).toMatch(/blocked \(no auto-flip\)/i);
    // THE certificate line: not a single signed request left the server.
    expect(mockPrivate).not.toHaveBeenCalled();
    expect(loadJournal().entries.at(-1)!.status).toBe('REJECTED');
    expect(loadJournal().positions).toHaveLength(0);
  });

  it('LIVE MARGIN (2x): SHORT margin order body — side sell + margin_amount_short', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now(), cryptoLeverage: 2 });
    const out = await executeSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'live', qtyINR: 300, leverage: 2,
      getFreshSignal: async () => ({ ...SPOT_SHORT }),
    });
    expect(out.ok).toBe(true);
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/margin/orders');
    expect(call).toBeDefined();
    const body = call![3];
    expect(body.side).toBe('sell');
    expect(body.margin.margin_amount_short).toBeCloseTo(300, 0);
    expect(body.margin.margin_amount_long).toBe(0);
    expect(out.position!.side).toBe('SHORT');
    // SHORT liquidation sits ABOVE entry
    expect(out.position!.liquidation!).toBeGreaterThan(100);
  });

  it('EXIT: a SHORT position\'s stop breach closes by BUYING back (polarity + order side)', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now() });
    // A SHORT live position whose trailed stop (99.5) sits below the live
    // price (100) — breakeven-locked runner. SHORT SL fires when price >= sl.
    const j = loadJournal();
    j.positions.push({
      id: 'short-exit-1', pair: 'BTCINR', side: 'SHORT', mode: 'live', market: 'CRYPTO', source: 'manual',
      qty: 10, entryPrice: 100, notionalINR: 1000, sl: 99.5, tp: 96.8, tp2: 93.6,
      initialRisk: 0.5, peakPrice: 99, signal: {}, openedAt: Date.now(), status: 'OPEN',
    });
    __setJournalForTests(j);
    const closures = await watchPositions({});
    expect(closures).toHaveLength(1);
    expect(closures[0].reason).toMatch(/STOP-LOSS/i);
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/orders/create');
    expect(call).toBeDefined();
    expect(call![3].side).toBe('buy');            // closing a SHORT = buy-back
    expect(call![3].market).toBe('BTCINR');
    expect(loadJournal().positions[0].status).toBe('CLOSED');
  });
});

// ============================================================
// SPOT DESK — the LONG mirror (v20.4.2)
// A LONG plan's geometry: stop BELOW entry, targets ABOVE.
// Every lock below is the exact mirror of the SHORT locks above.
// ============================================================
describe('SPOT desk: STRONG 80+ LONG card → trade direction (mirror)', () => {

  it('PAPER: a STRONG LONG 82% card opens a LONG paper position (never SHORT)', async () => {
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'paper',
      getFreshSignal: async () => ({ ...SPOT_LONG }),
    });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('LONG');
    // LONG paper entry fills ADVERSELY (above mid, the buy-side fill)
    expect(out.position!.entryPrice).toBeGreaterThan(100);
    // plan levels ride along with the LONG geometry
    expect(out.position!.sl).toBeCloseTo(96.8, 1);
    expect(out.position!.tp2).toBeCloseTo(106.4, 1);
    const j = loadJournal();
    expect(j.positions[0].side).toBe('LONG');
    expect(j.entries.at(-1)!.status).toBe('FILLED');
  });

  it('PAPER: clicked LONG while the fresh consensus flipped SHORT → v21.23.2 BLOCKS (mirror — "long ka short" kabhi nahi)', async () => {
    // v21.23.2 mirror: clicked LONG card ke against fresh SHORT consensus
    // aaye to trade REJECT hota hai — silent flip nahi (user complaint ka
    // exact scenario: "long trade signal ka short jaa raha hai").
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'paper',
      getFreshSignal: async () => ({ ...SPOT_SHORT }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fresh consensus SHORT/i);
    expect(out.error).toMatch(/blocked \(no auto-flip\)/i);
    const j = loadJournal();
    const flipRej = j.entries.find(e => e.status === 'REJECTED' && e.flippedFrom === 'LONG');
    expect(flipRej).toBeDefined();
    expect(flipRej!.flippedTo).toBe('SHORT');
  });

  it('LIVE: a STRONG LONG signal sends a BUY order to CoinDCX and books a LONG position', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live',
      getFreshSignal: async () => ({ ...SPOT_LONG }),
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('live');
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/orders/create');
    expect(call).toBeDefined();
    expect(call![3].side).toBe('buy');            // LONG → buy. Always.
    expect(call![3].market).toBe('BTCINR');
    expect(out.position!.side).toBe('LONG');
    expect(loadJournal().entries.at(-1)!.status).toBe('SUBMITTED');
  });

  it('LIVE: clicked LONG but fresh consensus SHORT → HONEST REJECT, no order is ever sent (silent flip is impossible)', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live',
      getFreshSignal: async () => ({ ...SPOT_SHORT }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fresh consensus SHORT/i);
    expect(out.error).toMatch(/blocked \(no auto-flip\)/i);
    // THE mirror certificate line: not a single signed request left the server.
    expect(mockPrivate).not.toHaveBeenCalled();
    expect(loadJournal().entries.at(-1)!.status).toBe('REJECTED');
    expect(loadJournal().positions).toHaveLength(0);
  });

  it('LIVE MARGIN (2x): LONG margin order body — side buy + margin_amount_long', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now(), cryptoLeverage: 2 });
    const out = await executeSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', qtyINR: 300, leverage: 2,
      getFreshSignal: async () => ({ ...SPOT_LONG }),
    });
    expect(out.ok).toBe(true);
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/margin/orders');
    expect(call).toBeDefined();
    const body = call![3];
    expect(body.side).toBe('buy');
    expect(body.margin.margin_amount_long).toBeCloseTo(300, 0);
    expect(body.margin.margin_amount_short).toBe(0);
    expect(out.position!.side).toBe('LONG');
    // LONG liquidation sits BELOW entry
    expect(out.position!.liquidation!).toBeLessThan(100);
  });

  it('EXIT: a LONG position\'s stop breach closes by SELLING (polarity + order side)', async () => {
    __setConfigForTests({ ...loadConfig(), mode: 'live', liveConfirmedAt: Date.now() });
    // A LONG live position whose trailed stop (100.5) sits above the live
    // price (100) — breakeven-locked runner. LONG SL fires when price <= sl.
    const j = loadJournal();
    j.positions.push({
      id: 'long-exit-1', pair: 'BTCINR', side: 'LONG', mode: 'live', market: 'CRYPTO', source: 'manual',
      qty: 10, entryPrice: 100, notionalINR: 1000, sl: 100.5, tp: 103.2, tp2: 106.4,
      initialRisk: 0.5, peakPrice: 101, signal: {}, openedAt: Date.now(), status: 'OPEN',
    });
    __setJournalForTests(j);
    const closures = await watchPositions({});
    expect(closures).toHaveLength(1);
    expect(closures[0].reason).toMatch(/STOP-LOSS/i);
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/orders/create');
    expect(call).toBeDefined();
    expect(call![3].side).toBe('sell');           // closing a LONG = sell-out
    expect(call![3].market).toBe('BTCINR');
    expect(loadJournal().positions[0].status).toBe('CLOSED');
  });
});

// ============================================================
// FUTURES DESK — the CoinDcxTab card → /api/ai/futures/execute
// ============================================================
describe('FUTURES desk: STRONG 80+ SHORT card → trade direction', () => {
  beforeEach(() => {
    __setConfigForTests({
      mode: 'live', cryptoLeverage: 10, maxRiskPct: 5, dailyMaxTrades: 50,
      dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50, liveConfirmedAt: Date.now(),
    });
    // instrument meta (max leverage 10, min qty 0.001)
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('derivatives/futures/data/instrument')) {
        const body = { instrument: { pair: 'B-BTC_USDT', max_leverage_long: 10, max_leverage_short: 10, quantity_precision: 4, min_qty: 0.001, status: 'active' } };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });
    // futures transport: wallets funded, position resolvable, tpsl records
    mockPrivateGET.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      throw new Error(`unexpected GET ${path}`);
    });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      if (path === '/exchange/v1/derivatives/futures/positions') return [
        { id: 'pos-short-1', pair: 'B-BTC_USDT', active_pos: -0.006, avg_price: 50000, liquidation_price: 54000, leverage: 3, margin_type: 'isolated', mark_price: 50000, take_profit_trigger: null, stop_loss_trigger: null },
      ];
      if (path === '/exchange/v1/derivatives/futures/orders/create') return { order: { id: 'fut-short-1' } };
      if (path === '/exchange/v1/derivatives/futures/positions/create_tpsl') return { ok: true };
      throw new Error(`unexpected ${path}`);
    });
    return () => { globalThis.fetch = origFetch; };
  });

  it('PAPER: a STRONG SHORT 84% futures card opens a SHORT position', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_SHORT }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('SHORT');
    expect(out.position!.pair).toBe('B-BTC_USDT');
    // SHORT geometry: stop above entry, TP2 below
    expect(out.position!.sl).toBeCloseTo(51600, 0);
    expect(out.position!.tp2).toBeCloseTo(46800, 0);
    expect(loadJournal().positions[0].side).toBe('SHORT');
  });

  it('PAPER: clicked SHORT while fresh flipped LONG → practice STILL opens SHORT (requested side honored)', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_LONG }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('SHORT');
    expect(out.fitted).toMatch(/FLIPPED/i);
  });

  it('LIVE: a STRONG SHORT sends a nested SELL order + arms SHORT-polarity native TP/SL', async () => {
    const tpslCalls = [];
    mockPrivate.mockImplementation(async (path, _k, _s, body) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      if (path === '/exchange/v1/derivatives/futures/positions') return [
        { id: 'pos-short-1', pair: 'B-BTC_USDT', active_pos: -0.006, avg_price: 50000, liquidation_price: 54000, leverage: 3, margin_type: 'isolated', mark_price: 50000, take_profit_trigger: null, stop_loss_trigger: null },
      ];
      if (path === '/exchange/v1/derivatives/futures/orders/create') return { order: { id: 'fut-short-1' } };
      if (path === '/exchange/v1/derivatives/futures/positions/create_tpsl') { tpslCalls.push(body); return { ok: true }; }
      throw new Error(`unexpected ${path}`);
    });
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'live', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_SHORT }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('live');
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/derivatives/futures/orders/create');
    expect(call).toBeDefined();
    expect(call![3].order.side).toBe('sell');     // SHORT perp → sell. Always.
    expect(out.position!.side).toBe('SHORT');
    // native TP/SL rides the SHORT geometry: stop ABOVE, profit BELOW
    expect(tpslCalls).toHaveLength(1);
    expect(Number(tpslCalls[0].stop_loss.stop_price)).toBeGreaterThan(50000);
    expect(Number(tpslCalls[0].take_profit.stop_price)).toBeLessThan(50000);
    expect(out.position!.exchangePositionId).toBe('pos-short-1');
  });

  it('LIVE: clicked SHORT but fresh flipped LONG → HONEST REJECT, no futures order is sent', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'SHORT', mode: 'live', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_LONG }), source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fresh consensus LONG hai, aapne SHORT/i);
    const create = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/derivatives/futures/orders/create');
    expect(create).toBeUndefined();
    expect(loadJournal().entries.at(-1)!.status).toBe('REJECTED');
  });
});

// ============================================================
// FUTURES DESK — the LONG mirror (v20.4.2)
// Every lock below is the exact mirror of the SHORT locks above.
// ============================================================
describe('FUTURES desk: STRONG 80+ LONG card → trade direction (mirror)', () => {
  beforeEach(() => {
    __setConfigForTests({
      mode: 'live', cryptoLeverage: 10, maxRiskPct: 5, dailyMaxTrades: 50,
      dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50, liveConfirmedAt: Date.now(),
    });
    // instrument meta (max leverage 10, min qty 0.001)
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('derivatives/futures/data/instrument')) {
        const body = { instrument: { pair: 'B-BTC_USDT', max_leverage_long: 10, max_leverage_short: 10, quantity_precision: 4, min_qty: 0.001, status: 'active' } };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });
    // futures transport: wallets funded, LONG position resolvable, tpsl records
    mockPrivateGET.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      throw new Error(`unexpected GET ${path}`);
    });
    mockPrivate.mockImplementation(async (path) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      if (path === '/exchange/v1/derivatives/futures/positions') return [
        { id: 'pos-long-1', pair: 'B-BTC_USDT', active_pos: 0.006, avg_price: 50000, liquidation_price: 46000, leverage: 3, margin_type: 'isolated', mark_price: 50000, take_profit_trigger: null, stop_loss_trigger: null },
      ];
      if (path === '/exchange/v1/derivatives/futures/orders/create') return { order: { id: 'fut-long-1' } };
      if (path === '/exchange/v1/derivatives/futures/positions/create_tpsl') return { ok: true };
      throw new Error(`unexpected ${path}`);
    });
    return () => { globalThis.fetch = origFetch; };
  });

  it('PAPER: a STRONG LONG 84% futures card opens a LONG position', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_LONG }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('LONG');
    expect(out.position!.pair).toBe('B-BTC_USDT');
    // LONG geometry: stop below entry, TP2 above
    expect(out.position!.sl).toBeCloseTo(48400, 0);
    expect(out.position!.tp2).toBeCloseTo(53200, 0);
    expect(loadJournal().positions[0].side).toBe('LONG');
  });

  it('PAPER: clicked LONG while fresh flipped SHORT → practice STILL opens LONG (requested side honored)', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_SHORT }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('LONG');
    expect(out.fitted).toMatch(/FLIPPED/i);
  });

  it('LIVE: a STRONG LONG sends a nested BUY order + arms LONG-polarity native TP/SL', async () => {
    const tpslCalls = [];
    mockPrivate.mockImplementation(async (path, _k, _s, body) => {
      if (path === '/exchange/v1/derivatives/futures/wallets') return [
        { id: 'w1', currency_short_name: 'USDT', balance: '500', locked_balance: '0', cross_order_margin: '0', cross_user_margin: '0' },
      ];
      if (path === '/exchange/v1/derivatives/futures/positions') return [
        { id: 'pos-long-1', pair: 'B-BTC_USDT', active_pos: 0.006, avg_price: 50000, liquidation_price: 46000, leverage: 3, margin_type: 'isolated', mark_price: 50000, take_profit_trigger: null, stop_loss_trigger: null },
      ];
      if (path === '/exchange/v1/derivatives/futures/orders/create') return { order: { id: 'fut-long-1' } };
      if (path === '/exchange/v1/derivatives/futures/positions/create_tpsl') { tpslCalls.push(body); return { ok: true }; }
      throw new Error(`unexpected ${path}`);
    });
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_LONG }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('live');
    const call = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/derivatives/futures/orders/create');
    expect(call).toBeDefined();
    expect(call![3].order.side).toBe('buy');      // LONG perp → buy. Always.
    expect(out.position!.side).toBe('LONG');
    // native TP/SL rides the LONG geometry: stop BELOW, profit ABOVE
    expect(tpslCalls).toHaveLength(1);
    expect(Number(tpslCalls[0].stop_loss.stop_price)).toBeLessThan(50000);
    expect(Number(tpslCalls[0].take_profit.stop_price)).toBeGreaterThan(50000);
    expect(out.position!.exchangePositionId).toBe('pos-long-1');
  });

  it('LIVE: clicked LONG but fresh flipped SHORT → HONEST REJECT, no futures order is sent', async () => {
    const out = await executeFuturesSignal({
      symbol: 'BTC', side: 'LONG', mode: 'live', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...FUT_SHORT }), source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fresh consensus SHORT hai, aapne LONG/i);
    const create = mockPrivate.mock.calls.find(c => c[0] === '/exchange/v1/derivatives/futures/orders/create');
    expect(create).toBeUndefined();
    expect(loadJournal().entries.at(-1)!.status).toBe('REJECTED');
  });
});
