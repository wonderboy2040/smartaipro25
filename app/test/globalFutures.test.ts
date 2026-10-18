// ============================================================
// test/globalFutures.test.ts — v10.4 GLOBAL EQUITY FUTURES desk
// ------------------------------------------------------------
// Covers: the SPACEX deterministic synthetic engine, the quote feed
// (Yahoo real names + sim), the board context builder, the PAPER/
// NOTIFY gauntlet (LIVE honesty reject, journal caps, one-per-pair,
// USD-domain sizing), the position watcher (SL close, trailing),
// and manual close.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v10.5.3: controllable CoinDCX equity-perp discoveries for the
// full-universe-scan suite (refreshGlobalUniverse reads this through
// the mocked module below).
const gfInstruments = vi.hoisted(() => ({ rows: [] as Array<{ symbol: string; pair: string }> }));

vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false, // practice mode — no exchange legs
  coindcxPrivate: vi.fn(),
  coindcxPrivateGET: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
  fetchGlobalFuturesInstruments: vi.fn(async () => gfInstruments.rows),
}));

import {
  GLOBAL_FUTURES_UNIVERSE, GLOBAL_FUTURES_SEED, globalPairFor, baseOfGlobalPair,
  syntheticPriceAt, syntheticCandles, buildGlobalCtxSync,
  fetchGlobalQuotes, executeGlobalSignal, watchGlobalPositions,
  closeGlobalPosition, globalFuturesMarketsView, __resetGlobalForTests,
  refreshGlobalUniverse, yahooForGlobal,
} from '../server/ai/globalFutures.js';
import { getSignals, __clearSignalCaches } from '../server/ai/signals.js';
import { __ledgerRaw } from '../server/ai/ledger.js';
import { __resetForTests, __setJournalForTests, loadJournal, __setConfigForTests } from '../server/ai/coindcxOrders.js';

const r2 = (v) => Math.round(v * 100) / 100;

// ---------------- fixtures ----------------
const STRONG_GLOBAL = {
  symbol: 'NVDA', market: 'GLOBALFUTURES', side: 'LONG', grade: 'STRONG',
  confidence: 84, agreement: 0.8, generatedAt: Date.now(),
  ltp: 120, plan: {
    entry: 120, stopLoss: 116, target1: 124, target2: 128,
    risk: 4, riskPct: 3.3, rewardRisk: 2, atrUsed: 3, planStyle: 'atr-based',
  },
  votes: [], summary: 'x', executable: true,
};
const freshSignal = async () => ({ ...STRONG_GLOBAL });

// A believable 1h Yahoo candle payload (120 bars, gentle uptrend)
const CANDLE_TS = Array.from({ length: 140 }, (_, i) => 1704153600 + i * 3600);
const CANDLE_ROWS = {
  timestamp: CANDLE_TS,
  indicators: {
    quote: [CANDLE_TS.reduce((acc, _t, i) => {
      const c = 100 + i * 0.2 + Math.sin(i / 7) * 1.5;
      acc.open.push(r2(c - 0.3)); acc.high.push(r2(c + 0.8));
      acc.low.push(r2(c - 0.8)); acc.close.push(r2(c));
      acc.volume.push(1_000_000 + (i % 20) * 25_000);
      return acc;
    }, { open: [], high: [], low: [], close: [], volume: [] })],
  },
};
const chartPayload = (price, prev) => ({
  chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev } }] },
});

// ---------------- fetch routing ----------------
const origFetch = globalThis.fetch;
function routeYahoo({ priceBy = {}, candlesBy = {} } = {}) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('interval=1h')) {
      for (const [sym, payload] of Object.entries(candlesBy)) {
        if (u.includes(`/${sym}?`) || u.includes(`/${sym}&`)) {
          return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    }
    if (u.includes('query1.finance.yahoo.com')) {
      const m = u.match(/chart\/([A-Z]+)\?/);
      const sym = m ? m[1] : null;
      const p = (sym && priceBy[sym]) || { price: 100, prev: 99 };
      const payload = chartPayload(p.price, p.prev);
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  });
}

beforeEach(() => {
  __resetForTests();
  __resetGlobalForTests();
  gfInstruments.rows = [];
  __setConfigForTests({ mode: 'paper', minConfidence: 75, minAgreement: 0.7, maxRiskPct: 5, dailyMaxTrades: 50, dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

// ============================================================
// universe + pair helpers + the SPACEX synthetic engine
// ============================================================
describe('global futures universe + pairs', () => {
  it('covers the user-named companies + SPACEX, SIM flagged only on SPACEX', () => {
    const syms = GLOBAL_FUTURES_UNIVERSE.map(u => u.symbol);
    for (const want of ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'MU', 'SPACEX']) {
      expect(syms).toContain(want);
    }
    expect(GLOBAL_FUTURES_UNIVERSE.filter(u => u.sim).map(u => u.symbol)).toEqual(['SPACEX']);
  });
  it('derives the -USD pair name and back', () => {
    expect(globalPairFor('nvda')).toBe('NVDA-USD');
    expect(baseOfGlobalPair('NVDA-USD')).toBe('NVDA');
  });
});

// ============================================================
// v10.5.3 FULL-UNIVERSE SCAN — CoinDCX discovery merge (Issue #2)
// ============================================================
describe('refreshGlobalUniverse — the full-universe scan', () => {
  it('MU ships in the SEED (the headline miss of the 8-name era)', () => {
    const mu = GLOBAL_FUTURES_UNIVERSE.find(u => u.symbol === 'MU');
    expect(mu).toBeTruthy();
    expect(mu.name).toBe('Micron Technology');
    expect(mu.yahoo).toBe('MU');
    expect(mu.sim).toBe(false);
  });

  it('merges EVERY returned USDT-margined global-equity symbol (not just the old 8)', async () => {
    // 8 discoveries = exactly the GLOBAL_DISCOVERED_MAX tail — every one
    // of them must land in the universe alongside the seed
    gfInstruments.rows = [
      { symbol: 'AAPL', pair: 'B-AAPL_USDT' },  // seed dup — must NOT double-add
      { symbol: 'DIS', pair: 'B-DIS_USDT' },
      { symbol: 'KO', pair: 'B-KO_USDT' },
      { symbol: 'JPM', pair: 'B-JPM_USDT' },
      { symbol: 'WMT', pair: 'B-WMT_USDT' },
      { symbol: 'XOM', pair: 'B-XOM_USDT' },
      { symbol: 'CVX', pair: 'B-CVX_USDT' },
      { symbol: 'PFE', pair: 'B-PFE_USDT' },
      { symbol: 'MCD', pair: 'B-MCD_USDT' },
    ];
    const out = await refreshGlobalUniverse();
    const syms = GLOBAL_FUTURES_UNIVERSE.map(u => u.symbol);
    for (const want of ['DIS', 'KO', 'JPM', 'WMT', 'XOM', 'CVX', 'PFE', 'MCD']) {
      expect(syms).toContain(want);
    }
    expect(out.size).toBe(GLOBAL_FUTURES_SEED.length + 8);
    // seed dup filtered, exactly one AAPL
    expect(syms.filter(s => s === 'AAPL')).toHaveLength(1);
    // SPACEX remains the ONLY sim — discoveries are real-market names
    expect(GLOBAL_FUTURES_UNIVERSE.filter(u => u.sim).map(u => u.symbol)).toEqual(['SPACEX']);
    // discovered entries carry the Yahoo mapping + provenance flag
    const ko = GLOBAL_FUTURES_UNIVERSE.find(u => u.symbol === 'KO');
    expect(ko.yahoo).toBe('KO');
    expect(ko.discovered).toBe(true);
  });

  it('caps the discovery tail — the scan stays bounded', async () => {
    gfInstruments.rows = Array.from({ length: 30 }, (_, i) => ({
      symbol: `T${i}`, pair: `B-T${i}_USDT`,
    }));
    const out = await refreshGlobalUniverse();
    expect(out.size).toBe(GLOBAL_FUTURES_SEED.length + 8); // GLOBAL_DISCOVERED_MAX default
    expect(GLOBAL_FUTURES_UNIVERSE.filter(u => u.discovered)).toHaveLength(8);
  });

  it('delisted discoveries DROP OUT on the next refresh; seed names never drop', async () => {
    gfInstruments.rows = [{ symbol: 'DIS', pair: 'B-DIS_USDT' }, { symbol: 'KO', pair: 'B-KO_USDT' }];
    await refreshGlobalUniverse();
    expect(GLOBAL_FUTURES_UNIVERSE.map(u => u.symbol)).toContain('DIS');
    // next refresh: DIS delisted, KO still listed
    gfInstruments.rows = [{ symbol: 'KO', pair: 'B-KO_USDT' }];
    const out = await refreshGlobalUniverse();
    const syms = GLOBAL_FUTURES_UNIVERSE.map(u => u.symbol);
    expect(syms).not.toContain('DIS'); // discovery gone with its listing
    expect(out.dropped).toContain('DIS');
    expect(syms).toContain('KO');
    expect(syms).toContain('MU');     // seed is permanent
    expect(syms).toContain('SPACEX'); // the SIM special case is designed to stay
  });

  it('class-A/B discoveries map to the CORRECT Yahoo ticker (never another company)', async () => {
    gfInstruments.rows = [
      { symbol: 'BRKB', pair: 'B-BRKB_USDT' }, // Berkshire class B → BRK-B
      { symbol: 'LENB', pair: 'B-LENB_USDT' }, // Lennar class B → LEN-B
      { symbol: 'GOOG', pair: 'B-GOOG_USDT' }, // class C → stays GOOG
    ];
    await refreshGlobalUniverse();
    expect(GLOBAL_FUTURES_UNIVERSE.find(u => u.symbol === 'BRKB').yahoo).toBe('BRK-B');
    expect(GLOBAL_FUTURES_UNIVERSE.find(u => u.symbol === 'LENB').yahoo).toBe('LEN-B');
    expect(GLOBAL_FUTURES_UNIVERSE.find(u => u.symbol === 'GOOG').yahoo).toBe('GOOG');
    expect(yahooForGlobal('BF_B')).toBe('BF-B');
  });

  it('markets view reports universe provenance (seed + discovered counts)', async () => {
    gfInstruments.rows = [{ symbol: 'DIS', pair: 'B-DIS_USDT' }, { symbol: 'KO', pair: 'B-KO_USDT' }];
    await refreshGlobalUniverse();
    routeYahoo({ priceBy: { AAPL: { price: 227, prev: 225 } } });
    const view = await globalFuturesMarketsView();
    expect(view.ok).toBe(true);
    expect(view.count).toBe(GLOBAL_FUTURES_UNIVERSE.length);
    expect(view.universe.seed).toBe(GLOBAL_FUTURES_SEED.length);
    expect(view.universe.discovered).toBe(2);
    expect(view.universe.mode).toBe('seed+coindcx-discovery');
    expect(view.markets.find(m => m.symbol === 'DIS').discovered).toBe(true);
  });
});

describe('SPACEX deterministic synthetic engine', () => {
  it('is deterministic — same timestamp, same price (every observer/process)', () => {
    const at = Date.UTC(2026, 8, 14, 10, 30);
    expect(syntheticPriceAt('SPACEX', at)).toBe(syntheticPriceAt('SPACEX', at));
  });
  it('moves with time (minute buckets) and stays positive', () => {
    const t0 = Date.UTC(2026, 8, 14, 10, 0);
    const p0 = syntheticPriceAt('SPACEX', t0);
    const p1 = syntheticPriceAt('SPACEX', t0 + 90 * 60_000);
    expect(p0).toBeGreaterThan(0);
    expect(p1).toBeGreaterThan(0);
    expect(p1).not.toBe(p0); // the walk is alive
  });
  it('candles: 500 hourly bars, OHLC-consistent, oldest-first', () => {
    const c = syntheticCandles('SPACEX', 500);
    expect(c).toHaveLength(500);
    for (let i = 0; i < c.length; i++) {
      expect(c[i].high).toBeGreaterThanOrEqual(Math.max(c[i].open, c[i].close));
      expect(c[i].low).toBeLessThanOrEqual(Math.min(c[i].open, c[i].close));
      if (i > 0) expect(c[i].time).toBeGreaterThan(c[i - 1].time);
    }
  });
});

// ============================================================
// quote feed + board context
// ============================================================
describe('fetchGlobalQuotes + buildGlobalCtxSync', () => {
  it('prices the real names from Yahoo and SPACEX from the sim (clearly labeled)', async () => {
    routeYahoo({ priceBy: { AAPL: { price: 227.5, prev: 225 } } });
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    expect(q.size).toBe(GLOBAL_FUTURES_UNIVERSE.length);
    expect(q.get('AAPL')).toMatchObject({ price: 227.5, source: 'yahoo', sim: false });
    expect(q.get('AAPL').changePct).toBeCloseTo((227.5 - 225) / 225 * 100, 3);
    const sx = q.get('SPACEX');
    expect(sx.source).toBe('sim');
    expect(sx.sim).toBe(true);
    expect(sx.price).toBeGreaterThan(0);
  });
  it('builds a GLOBALFUTURES ctx with candles-derived indicators', () => {
    routeYahoo({ candlesBy: { NVDA: CANDLE_ROWS } });
    const candles = syntheticCandles('SPACEX'); // any shaped candles work for the builder
    const ctx = buildGlobalCtxSync('NVDA', { price: 120, changePct: 1.5, sim: false }, candles, { ndxChange: 0.8 });
    expect(ctx.market).toBe('GLOBALFUTURES');
    expect(ctx.pair).toBe('NVDA-USD');
    expect(ctx.ltp).toBe(120);
    expect(ctx.ind).toBeTruthy();
    expect(ctx.ind.rsi).toBeGreaterThan(0);
    expect(ctx.priceSource).toBe('yahoo-1h');
    expect(ctx.isSim).toBe(false);
  });
  it('no quote → null ctx (honest abstain, no fake row)', () => {
    expect(buildGlobalCtxSync('NVDA', null, syntheticCandles('SPACEX'), {})).toBeNull();
  });
});

// ============================================================
// THE GAUNTLET
// ============================================================
describe('executeGlobalSignal', () => {
  it('LIVE is honestly rejected — CoinDCX par ye equities listed nahi (SIM desk)', async () => {
    const out = await executeGlobalSignal({
      symbol: 'NVDA', side: 'LONG', mode: 'live',
      marginUSDT: 100, leverage: 3,
      getFreshSignal: freshSignal, source: 'manual',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/SIM desk|listed nahi/i);
    const j = loadJournal();
    expect(j.entries.some(e => e.status === 'REJECTED' && e.market === 'GLOBALFUTURES')).toBe(true);
    expect(j.positions).toHaveLength(0);
  });

  it('v20.3: PAPER practice fill against a FLIPPED consensus is stamped relaxed (calibration corpus stays clean)', async () => {
    // request SHORT while the fresh consensus says LONG → practice synth plan
    const out = await executeGlobalSignal({
      symbol: 'NVDA', side: 'SHORT', mode: 'paper', marginUSDT: 100, leverage: 3,
      getFreshSignal: async () => ({ ...STRONG_GLOBAL, side: 'LONG' }), source: 'manual',
    });
    expect(out.ok).toBe(true);
    const raw = __ledgerRaw();
    const e = raw.entries.at(-1);
    expect(e?.market).toBe('GLOBALFUTURES');
    expect(e?.mode).toBe('paper');
    expect(e?.relaxed).toBe(true);
  });

  it('PAPER: fresh signal → journal position in the USD domain', async () => {
    const out = await executeGlobalSignal({
      symbol: 'NVDA', side: 'LONG', mode: 'paper',
      marginUSDT: 100, leverage: 3,
      getFreshSignal: freshSignal, source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('paper');
    // qty = 100×3 / 120 = 2.5
    expect(out.filled.qty).toBeCloseTo(2.5, 4);
    expect(out.filled.leverage).toBe(3);
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.market).toBe('GLOBALFUTURES');
    expect(p.pair).toBe('NVDA-USD');
    expect(p.symbol).toBe('NVDA');
    expect(p.mode).toBe('paper');
    expect(p.notionalUSDT).toBeCloseTo(2.5 * 120, 0);
    expect(p.sl).toBe(116);
    expect(p.tp2).toBe(128);
    expect(j.entries[0].kind).toBe('ORDER');
    expect(j.entries[0].status).toBe('FILLED');
    expect(j.entries[0].market).toBe('GLOBALFUTURES');
  });

  it('one-per-pair: a second NVDA position is rejected', async () => {
    await executeGlobalSignal({ symbol: 'NVDA', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 2, getFreshSignal: freshSignal, source: 'manual' });
    const out = await executeGlobalSignal({ symbol: 'NVDA', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 2, getFreshSignal: freshSignal, source: 'manual' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/one-per-pair/i);
  });

  it('NOTIFY: gauntlet pass → alert + audit, NO position', async () => {
    let sent = 0;
    const out = await executeGlobalSignal({
      symbol: 'AAPL', side: 'LONG', mode: 'notify',
      getFreshSignal: async () => ({ ...STRONG_GLOBAL, symbol: 'AAPL', ltp: 227, plan: { ...STRONG_GLOBAL.plan, entry: 227, stopLoss: 223, target1: 231, target2: 235 } }),
      source: 'manual',
      sendTelegram: async () => { sent++; return { ok: true }; },
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('notify');
    expect(out.telegramSent).toBe(true);
    expect(sent).toBe(1);
    const j = loadJournal();
    expect(j.positions).toHaveLength(0);
    expect(j.entries.some(e => e.status === 'NOTIFIED' && e.market === 'GLOBALFUTURES')).toBe(true);
  });

  it('daily trade cap: the configured cap blocks new entries', async () => {
    __setConfigForTests({ mode: 'paper', minConfidence: 75, minAgreement: 0.7, maxRiskPct: 5, dailyMaxTrades: 1, dailyMaxLossINR: 100_000, maxOrderINR: 1_000_000, maxOpenPositions: 50 });
    const first = await executeGlobalSignal({ symbol: 'TSLA', side: 'LONG', mode: 'paper', marginUSDT: 50, leverage: 2, getFreshSignal: async () => ({ ...STRONG_GLOBAL, symbol: 'TSLA', ltp: 250 }), source: 'manual' });
    expect(first.ok).toBe(true);
    const second = await executeGlobalSignal({ symbol: 'META', side: 'LONG', mode: 'paper', marginUSDT: 50, leverage: 2, getFreshSignal: async () => ({ ...STRONG_GLOBAL, symbol: 'META', ltp: 500 }), source: 'manual' });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/Daily trade cap/i);
  });

  it('REGRESSION (live-server catch): an OPEN GLOBALFUTURES position never breaks getPositionsWithPnl', async () => {
    // The live smoke test caught 'Assignment to constant variable' — the
    // global-quote map was re-assigned over a `const`. An open position
    // must price through the desk feed, never 500 the positions route.
    const out = await executeGlobalSignal({
      symbol: 'MSFT', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 2,
      getFreshSignal: async () => ({ ...STRONG_GLOBAL, symbol: 'MSFT', ltp: 500, plan: { ...STRONG_GLOBAL.plan, entry: 500, stopLoss: 484, target1: 516, target2: 532 } }),
      source: 'manual',
    });
    expect(out.ok).toBe(true);
    routeYahoo({ priceBy: { MSFT: { price: 505, prev: 500 } } });
    const { getPositionsWithPnl } = await import('../server/ai/coindcxOrders.js');
    const view = await getPositionsWithPnl(); // must NOT throw
    const p = (view.positions || []).find(x => x.pair === 'MSFT-USD');
    expect(p).toBeTruthy();
    expect(p.ltp).toBe(505);
    expect(p.priceSource).toBe('yahoo');
    expect(p.unrealizedPnlUSDT).toBeGreaterThan(0); // LONG, price rose
  });
});

// ============================================================
// THE WATCHER (paper semantics)
// ============================================================
describe('watchGlobalPositions', () => {
  const seedPosition = async (over = {}) => {
    const out = await executeGlobalSignal({
      symbol: 'NVDA', side: 'LONG', mode: 'paper',
      marginUSDT: 100, leverage: 2,
      getFreshSignal: freshSignal, source: 'agent',
    });
    expect(out.ok).toBe(true);
    return out.position;
  };

  it('closes a PAPER position when the quote crosses the SL (USD-domain P&L)', async () => {
    const p = await seedPosition();
    // entry 120, SL 116 → force the quote BELOW the stop
    routeYahoo({ priceBy: { NVDA: { price: 115, prev: 120 } } });
    const out = await watchGlobalPositions({});
    const closures = Array.isArray(out) ? out : (out?.closures || []);
    expect(closures.some(c => c.pair === 'NVDA-USD' && /STOP-LOSS/i.test(c.reason))).toBe(true);
    const j = loadJournal();
    const pos = j.positions.find(x => x.id === p.id);
    expect(pos.status).toBe('CLOSED');
    expect(pos.closeReason).toMatch(/STOP-LOSS/i);
    // qty = 100×2 / 120 = 1.66 (2dp floor) · exit at the SL 116:
    // (116−120) × 1.66 = −6.64 USD (STOP-LOSS closes AT the stop, not beyond)
    expect(pos.pnlUSDT).toBeCloseTo(-6.64, 1);
  });

  it('leaves the position alone while price stays inside the plan', async () => {
    const p = await seedPosition();
    routeYahoo({ priceBy: { NVDA: { price: 121, prev: 120 } } });
    await watchGlobalPositions({});
    const j = loadJournal();
    expect(j.positions.find(x => x.id === p.id).status).toBe('OPEN');
  });
});

// ============================================================
// manual close + markets view
// ============================================================
describe('closeGlobalPosition + markets view', () => {
  it('manual close settles at the live quote', async () => {
    const out = await executeGlobalSignal({
      symbol: 'AAPL', side: 'LONG', mode: 'paper', marginUSDT: 100, leverage: 1,
      getFreshSignal: async () => ({ ...STRONG_GLOBAL, symbol: 'AAPL', ltp: 200, plan: { ...STRONG_GLOBAL.plan, entry: 200, stopLoss: 196, target1: 204, target2: 208 } }),
      source: 'manual',
    });
    expect(out.ok).toBe(true);
    const id = out.position.id;
    routeYahoo({ priceBy: { AAPL: { price: 205, prev: 200 } } });
    const closed = await closeGlobalPosition(id);
    expect(closed.ok).toBe(true);
    expect(closed.position.status).toBe('CLOSED');
    expect(closed.position.closePrice).toBe(205);
    const j = loadJournal();
    const e = j.entries.find(x => x.kind === 'CLOSE' && x.pair === 'AAPL-USD');
    expect(e).toBeTruthy();
    expect(e.market).toBe('GLOBALFUTURES');
  });

  it('markets view lists the whole universe with SIM honesty', async () => {
    routeYahoo({ priceBy: { AAPL: { price: 227, prev: 225 } } });
    const view = await globalFuturesMarketsView();
    expect(view.ok).toBe(true);
    expect(view.count).toBe(GLOBAL_FUTURES_UNIVERSE.length);
    const nvda = view.markets.find(m => m.symbol === 'NVDA');
    expect(nvda.pair).toBe('NVDA-USD');
    const spacex = view.markets.find(m => m.symbol === 'SPACEX');
    expect(spacex.sim).toBe(true);
    expect(spacex.source).toBe('sim');
  });
});

// ============================================================
// BOARD INTEGRATION — the full ensemble on the GLOBAL desk
// ============================================================
describe('getSignals("GLOBALFUTURES") board', () => {
  it('runs the 10-model committee over the global universe (Yahoo candles + SPACEX sim)', async () => {
    __resetGlobalForTests();
    __clearSignalCaches();
    // candles for all 7 real names + the regime tickers fall through the
    // generic chart branch (default price 100/prev 99 — a +1% NDX regime)
    routeYahoo({ candlesBy: Object.fromEntries(
      GLOBAL_FUTURES_UNIVERSE.filter(u => !u.sim).map(u => [u.yahoo, CANDLE_ROWS]),
    ) });
    const board = await getSignals('GLOBALFUTURES', {}, { noCache: true, limit: 8 });
    expect(board.ok).toBe(true);
    expect(board.market).toBe('GLOBALFUTURES');
    expect(board.marketOpen).toBe(true); // 24/7 SIM desk
    expect(board.superIntelMeta.universeMode).toBe('global-equity-futures');
    expect(board.superIntelMeta.universeSize).toBe(GLOBAL_FUTURES_UNIVERSE.length);
    // the board is a RANKED list with plan + consensus on every row
    for (const s of (board.signals || [])) {
      expect(s.market).toBe('GLOBALFUTURES');
      expect(['LONG', 'SHORT']).toContain(s.side);
      expect(s.plan).toBeTruthy();
      expect(s.plan.entry).toBeGreaterThan(0);
      expect(s.superIntel).toBeTruthy();
      expect(s.votes.length).toBeGreaterThan(0);
    }
    // signals come from the universe only (never a hallucinated ticker)
    const universe = new Set(GLOBAL_FUTURES_UNIVERSE.map(u => u.symbol));
    for (const s of (board.signals || [])) expect(universe.has(s.symbol)).toBe(true);
  });
});
