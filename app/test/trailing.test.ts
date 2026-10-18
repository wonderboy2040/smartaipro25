// ============================================================
// test/trailing.test.ts — v6.5 TRAILING STOP-LOSS
// ------------------------------------------------------------
// computeTrailSl (the pure ratchet) + the crypto watcher integration
// (peak tracking, journal TRAIL entries, close after trail-down).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
  loadJSON: undefined, saveJSON: undefined,
}));
vi.mock('../server/ai/dhan.js', () => ({
  dhanConnected: () => false,
  dhanPlaceOrder: vi.fn(),
  dhanCancelOrder: vi.fn(),
}));
const tickers = vi.fn(async () => [{ market: 'BTCINR', last_price: String(_tickerPrice) }]);
let _tickerPrice = 100;
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: (...args) => tickers(...args),
}));

import { computeTrailSl } from '../server/ai/ensemble.js';
import {
  executeSignal, watchPositions, loadJournal, __resetForTests, loadConfig,
} from '../server/ai/coindcxOrders.js';
import { loadJSON as loadJSONOrig, saveJSON } from '../server/lib/store.js';

// v20.2: paper-fill slippage OFF for this suite — its subject is
// leverage/trailing math, not fill realism (locked in aiOrders/v202 tests).
process.env.AI_COINDCX_SLIP_BPS = '0';

const STRONG = {
  symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'STRONG',
  confidence: 82, agreement: 0.78, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 95, target1: 105, target2: 110,
    risk: 5, riskPct: 5, rewardRisk: 2, atrUsed: 3, planStyle: 'atr-based',
  },
  votes: [], summary: 'x',
};

describe('computeTrailSl — the pure ratchet', () => {
  const base = { side: 'LONG', entryPrice: 100, initialRisk: 5, price: 108, armR: 1.0, offsetR: 1.0 };

  it('is NOT armed below +1R profit (initial SL stands)', () => {
    expect(computeTrailSl({ ...base, peakPrice: 104.9, currentSl: 95 })).toBeNull();
  });

  it('locks BREAKEVEN once profit crosses armR × R', () => {
    const out = computeTrailSl({ ...base, peakPrice: 106, currentSl: 95 });
    expect(out).not.toBeNull();
    expect(out!.stage).toBe('breakeven');
    expect(out!.sl).toBe(100);
  });

  it('trails peak − offsetR × R once profit runs beyond stage 1', () => {
    // profit 10 = 2R > (arm + 0.5*off) = 1.5R → stage 2
    const out = computeTrailSl({ ...base, peakPrice: 110, currentSl: 95 });
    expect(out!.stage).toBe('trail');
    expect(out!.sl).toBeCloseTo(105, 6); // 110 − 1×5
  });

  it('RATCHET-ONLY: a candidate at/below the current SL is rejected', () => {
    // already trailed to 105; peak 110 again → candidate 105 = current → null
    expect(computeTrailSl({ ...base, peakPrice: 110, currentSl: 105 })).toBeNull();
    // current even higher (tighter) → null
    expect(computeTrailSl({ ...base, peakPrice: 110, currentSl: 106 })).toBeNull();
  });

  it('never trails past the live price (that close is the SL hit itself)', () => {
    // price fell back to 104.9 while candidate would be 105 → rejected
    expect(computeTrailSl({ ...base, peakPrice: 110, currentSl: 95, price: 104.9 })).toBeNull();
  });

  it('SHORT mirror: breakeven then trail ABOVE the price', () => {
    const s = { side: 'SHORT', entryPrice: 100, initialRisk: 5, price: 94, armR: 1, offsetR: 1 };
    const be = computeTrailSl({ ...s, peakPrice: 94, currentSl: 105 });
    expect(be!.stage).toBe('breakeven');
    expect(be!.sl).toBe(100);
    const tr = computeTrailSl({ ...s, peakPrice: 90, currentSl: 100 });
    expect(tr!.stage).toBe('trail');
    expect(tr!.sl).toBeCloseTo(95, 6); // 90 + 5
    expect(computeTrailSl({ ...s, peakPrice: 90, currentSl: 94.5 })).toBeNull(); // ratchet
  });

  it('unusable inputs → null (never throws)', () => {
    expect(computeTrailSl(null as never)).toBeNull();
    expect(computeTrailSl({ ...base, peakPrice: 0 })).toBeNull();
    expect(computeTrailSl({ ...base, entryPrice: NaN })).toBeNull();
    expect(computeTrailSl({ ...base, initialRisk: -5 })).toBeNull();
  });
});

describe('crypto watcher — trailing integration', () => {
  let _origCreds = null;
  beforeEach(() => {
    __resetForTests();
    _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
    saveJSON('mcp-coindcx.json', { apiKey: 'k', secret: 's', connectedAt: Date.now() });
    _tickerPrice = 100;
    mockPrivate.mockReset();
    mockPrivate.mockResolvedValue({ orders: [{ id: 'o1' }] });
  });
  afterEach(() => {
    saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
    vi.restoreAllMocks();
  });

  it('runs the peak up, ratchets SL to breakeven, journals a TRAIL entry, then closes on the trail', async () => {
    // open @100, SL 95 (R=5), TP2 110 (never reached — the trail exits first)
    const open = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: async () => ({ ...STRONG }) });
    expect(open.ok).toBe(true);

    // watcher pass 1: price 104 (below 1R) → no trail, peak recorded
    _tickerPrice = 104;
    await watchPositions({});
    let j = loadJournal();
    let p = j.positions[0];
    expect(p.peakPrice).toBeCloseTo(104, 1);
    expect(p.sl).toBeCloseTo(95, 1);
    expect(j.entries.some(e => e.kind === 'TRAIL')).toBe(false);

    // watcher pass 2: price 106.5 (1.3R) → breakeven lock + TRAIL entry
    _tickerPrice = 106.5;
    await watchPositions({});
    j = loadJournal();
    p = j.positions[0];
    expect(p.status).toBe('OPEN');
    expect(p.sl).toBeCloseTo(100, 1);
    expect(p.trailing).toBe('breakeven');
    const trailEntry = j.entries.find(e => e.kind === 'TRAIL');
    expect(trailEntry).toBeDefined();
    expect(trailEntry!.pair).toBe('BTCINR');

    // watcher pass 3: price 108.5 (1.7R) → trail SL = 108.5 − 5 = 103.5
    _tickerPrice = 108.5;
    await watchPositions({});
    j = loadJournal();
    p = j.positions[0];
    expect(p.status).toBe('OPEN');
    expect(p.sl).toBeCloseTo(103.5, 1);
    expect(p.trailing).toBe('trail');

    // watcher pass 4: price falls to 103 → below trailed SL → CLOSE at the trail, not the stale 95
    _tickerPrice = 103;
    const closures = await watchPositions({});
    j = loadJournal();
    p = j.positions[0];
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toContain('STOP-LOSS');
    expect(p.closePrice).toBeCloseTo(103, 1);
    // v18.9 FEE HONESTY: gross qty 10 × (103−100) = 30 minus both-side taker fees (100+103)×10×0.10% = 2.03
    expect(p.pnlINR).toBeCloseTo(30 - 2.03, 1);
    expect(closures).toHaveLength(1);
  });

  it('trail can be disabled via config (initial SL never moves)', async () => {
    const cfg = loadConfig();
    saveJSON('ai-trading-config.json', { ...cfg, trailEnabled: false });
    await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: async () => ({ ...STRONG }) });
    _tickerPrice = 112;
    await watchPositions({});
    const j = loadJournal();
    expect(j.positions[0].sl).toBeCloseTo(95, 1);
    expect(j.entries.some(e => e.kind === 'TRAIL')).toBe(false);
  });

  it('SHORT paper position trails a falling peak (mirror)', async () => {
    const SHORT = {
      ...STRONG, side: 'SHORT', plan: {
        entry: 100, stopLoss: 105, target1: 95, target2: 90,
        risk: 5, riskPct: 5, rewardRisk: 2, atrUsed: 3, planStyle: 'atr-based',
      },
    };
    await executeSignal({ symbol: 'BTC', mode: 'paper', side: 'SHORT', getFreshSignal: async () => ({ ...SHORT }) });
    _tickerPrice = 91.5; // 1.7R profit → peak 91.5 → trail = 91.5 + 5 = 96.5
    await watchPositions({});
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.sl).toBeCloseTo(96.5, 1);
    expect(p.trailing).toBe('trail');
  });
});
