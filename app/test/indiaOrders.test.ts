// ============================================================
// test/indiaOrders.test.ts — v6.5 INDIA (DHAN) GAUNTLET
// ------------------------------------------------------------
// Every gate of executeIndiaSignal + the India watcher (trailing,
// SL/TP, 15:15 square-off) + dhan.js transport pieces (scrip CSV
// parse, connect validation, order bodies). Fake timers pin IST
// trading hours so the clock gates are deterministic.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- mocks (BEFORE importing the engines) ----
const mockDhanPlace = vi.fn();
const mockDhanCancel = vi.fn();
// v18.9: fill verification + day-rollover reconcile paths
const mockDhanStatus = vi.fn();
const mockDhanPositions = vi.fn();
vi.mock('../server/ai/dhan.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../server/ai/dhan.js')>();
  return {
    ...orig,
    dhanConnected: () => true,
    dhanPlaceOrder: (...a) => mockDhanPlace(...a),
    dhanCancelOrder: (...a) => mockDhanCancel(...a),
    dhanOrderStatus: (...a) => mockDhanStatus(...a),
    dhanPositions: (...a) => mockDhanPositions(...a),
  };
});
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: vi.fn(),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
  loadJSON: undefined, saveJSON: undefined,
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => []),
}));
// data.js: NSE-open gate + TV India prices (watcher/positions pricing)
let _tvLtp = 100;
const mockIsNseOpen = vi.fn(() => true);
vi.mock('../server/ai/data.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../server/ai/data.js')>();
  return {
    ...orig,
    isNseOpen: (...a) => mockIsNseOpen(...a),
    fetchTVIndiaBatch: vi.fn(async (symbols) => {
      const out = {};
      for (const s of symbols) out[s] = { symbol: s, ltp: _tvLtp, open: _tvLtp, high: _tvLtp, low: _tvLtp, volume: 1000, changePct: 0 };
      return out;
    }),
  };
});

import {
  executeIndiaSignal, watchIndiaPositions, closeIndiaPosition,
} from '../server/ai/indiaOrders.js';
import {
  __resetForTests, loadJournal, __setJournalForTests, loadConfig,
} from '../server/ai/coindcxOrders.js';
import { __ledgerRaw } from '../server/ai/ledger.js';
import { parseScripCsv, __setScripsForTests } from '../server/ai/dhan.js';
import { loadJSON as loadJSONOrig, saveJSON } from '../server/lib/store.js';

// A fresh STRONG India signal (market INDIA — venue gate must pass)
const STRONG_IN = (over = {}) => ({
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 78, agreement: 0.74, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 95, target1: 105, target2: 110,
    risk: 5, riskPct: 5, rewardRisk: 2, atrUsed: 3.5, planStyle: 'atr-based',
  },
  votes: [], summary: 'x', ...over,
});

/** IST clock pin: 2026-01-14 is a Wednesday. 05:30 UTC = 11:00 IST. */
const IST_1100 = new Date('2026-01-14T05:30:00Z');
const IST_1520 = new Date('2026-01-14T09:50:00Z'); // 15:20 IST — past square-off

let _origCreds = null;
beforeEach(() => {
  // v18.9: shouldAdvanceTime — executeIndiaSignal now polls dhanOrderStatus
  // (fill verification) with 300-600ms sleeps; frozen timers would hang the
  // journal lock and cascade-timeout every later test.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(IST_1100);
  __resetForTests();
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'k', secret: 's', connectedAt: Date.now() });
  _tvLtp = 100;
  // Re-seed EVERY mock implementation here — mockReturnValue(false) set by
  // an individual test leaks across tests (vi.restoreAllMocks does NOT
  // reset vi.fn implementations, only spyOn spies).
  mockIsNseOpen.mockReset();
  mockIsNseOpen.mockReturnValue(true);
  mockDhanPlace.mockReset();
  mockDhanPlace.mockResolvedValue({ orderId: 'DH-1', orderStatus: 'TRANSIT', securityId: '2885', lotUnits: 1, tickSize: 0.05 });
  // v18.9: default fill status — TRADED with no averageTradedPrice → the
  // gauntlet keeps the signal LTP as entryPrice (legacy assertion basis)
  mockDhanStatus.mockReset();
  mockDhanStatus.mockResolvedValue({ orderStatus: 'TRADED', averageTradedPrice: null });
  mockDhanPositions.mockReset();
  mockDhanPositions.mockResolvedValue([]);
  mockDhanCancel.mockReset();
  mockDhanCancel.mockResolvedValue({ ok: true });
});
afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('India gauntlet — gates', () => {
  it('kill switch rejects (shared with crypto)', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), killSwitch: true });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Kill switch/);
    expect(loadJournal().entries.at(-1)!.status).toBe('REJECTED');
  });

  it('MODE GATE: live while indiaMode=paper is rejected server-side', async () => {
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/India LIVE mode is not enabled/);
  });

  it('MARKET GATE: live rejected when NSE is closed', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
    mockIsNseOpen.mockReturnValue(false);
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/NSE is closed/);
  });

  it('MARKET GATE: live rejected before 09:30 (opening chop)', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
    vi.setSystemTime(new Date('2026-01-14T03:45:00Z')); // 09:15 IST — NSE open, chop window
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/09:30/);
  });

  it('MARKET GATE: live rejected after 15:00 (too late for fresh entry)', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
    vi.setSystemTime(new Date('2026-01-14T09:45:00Z')); // 15:15 IST
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/15:00/);
  });

  it('VENUE GATE: a CRYPTO signal never executes on the India path', async () => {
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN({ market: 'CRYPTO' }) as never });
    // market mismatch → the deep consensus gets rejected by the venue gate
    expect(out.ok).toBe(false);
  });

  it('LIVE demands STRONG — an ACTION-grade fresh signal is rejected', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN({ grade: 'ACTION', confidence: 66, agreement: 0.62 }) });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/STRONG/);
  });

  it('v9.0.2: PAPER on FLAT consensus SYNTHESIZES a practice plan (v6.12 ACTION floor no longer dead-ends practice)', async () => {
    // Pre-v6.12: FLAT consensus + user click = synthesized practice
    // trade. v6.12 flipped it to a hard reject — which dead-ended the
    // whole India paper desk ("paper trading start hi nhi ho raha").
    // v9.0.2: practice opens with the honest fresh grade journaled.
    const flat = { ...STRONG_IN(), side: 'FLAT', dir: 0, confidence: 0, plan: null };
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', side: 'LONG', mode: 'paper', getFreshIndiaSignal: async () => flat });
    expect(out.ok).toBe(true);
    expect(out.fitted).toMatch(/practice plan @ live price/i);
  });

  it('v21.13: PAPER on a side-flip (fresh SHORT, clicked LONG) REALIGNS to the fresh side', async () => {
    // v9.0.2 opened the STALE clicked side (engine ke fresh view ke
    // against) — v21.13 me engine's CURRENT view hi practice hota hai
    // (crypto path ke saath parity).
    const flip = { ...STRONG_IN(), side: 'SHORT' };
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', side: 'LONG', mode: 'paper', getFreshIndiaSignal: async () => flip });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('SHORT'); // REALIGNED to fresh consensus
    expect(out.fitted).toMatch(/REALIGNED to fresh consensus SHORT/i);
  });

  it('risk auto-fit: an over-cap paper stop is fitted, never bounced (v6.4 policy, India too)', async () => {
    const over = STRONG_IN({
      plan: {
        entry: 100, stopLoss: 94, target1: 106, target2: 112,
        risk: 6, riskPct: 6, rewardRisk: 2, atrUsed: 4, planStyle: 'atr-based',
      },
    });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => over });
    expect(out.ok).toBe(true);
    expect(out.fitted).toMatch(/auto-fitted/);
    expect(out.position!.sl).toBeCloseTo(95, 1); // 5% cap on ₹100
  });
});

describe('India gauntlet — sizing + journal caps', () => {
  it('paper: whole-share sizing within indiaMaxOrderINR (default ₹5000 → 50 shares @ ₹100)', async () => {
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(true);
    expect(out.filled!.qty).toBe(50);
    expect(out.filled!.notionalINR).toBeCloseTo(5000, 0);
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.market).toBe('INDIA');
    expect(p.symbol).toBe('RELIANCE');
    expect(p.initialRisk).toBeCloseTo(5, 1);
    expect(j.entries.at(-1)!.status).toBe('FILLED');
  });

  it('v20.3: PAPER practice fill against a FLIPPED consensus is stamped relaxed (calibration corpus stays clean)', async () => {
    // request SHORT while the fresh consensus says LONG → practice synth plan
    const out = await executeIndiaSignal({
      symbol: 'RELIANCE', mode: 'paper', side: 'SHORT',
      getFreshIndiaSignal: async () => STRONG_IN(),
    });
    expect(out.ok).toBe(true);
    const raw = __ledgerRaw();
    const e = raw.entries.at(-1);
    expect(e?.market).toBe('INDIA');
    expect(e?.mode).toBe('paper');
    expect(e?.relaxed).toBe(true);
  });

  it('PAPER never dead-ends on share price: 1-share practice fallback with honest note', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMaxOrderINR: 150 });
    const pricey = STRONG_IN({
      ltp: 250,
      plan: {
        entry: 250, stopLoss: 237.5, target1: 262.5, target2: 275,
        risk: 12.5, riskPct: 5, rewardRisk: 2, atrUsed: 9, planStyle: 'atr-based',
      },
    });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => pricey });
    expect(out.ok).toBe(true); // practice opens, never bounces
    expect(out.filled!.qty).toBe(1);
    expect(out.fitted).toMatch(/practice 1-share/);
  });

  it('LIVE honestly rejects when the budget buys 0 shares', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now(), indiaMaxOrderINR: 150 });
    const pricey = STRONG_IN({
      ltp: 250,
      plan: {
        entry: 250, stopLoss: 237.5, target1: 262.5, target2: 275,
        risk: 12.5, riskPct: 5, rewardRisk: 2, atrUsed: 9, planStyle: 'atr-based',
      },
    });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => pricey });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/0 shares/);
  });

  it('one-per-symbol blocks a duplicate India position', async () => {
    await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/one-per-symbol/);
  });

  it('shared daily trade cap counts India orders too', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), dailyMaxTrades: 1 });
    await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    const out = await executeIndiaSignal({ symbol: 'TCS', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN({ symbol: 'TCS' }) });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Daily trade cap/);
  });
});

describe('India gauntlet — LIVE Dhan path', () => {
  beforeEach(() => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
  });

  it('places a MARKET entry + a protective SL-M, journals SUBMITTED', async () => {
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(true);
    expect(out.orderId).toBe('DH-1');
    expect(out.slOrderId).toBe('DH-1');
    expect(mockDhanPlace).toHaveBeenCalledTimes(2);
    const [entryArgs] = mockDhanPlace.mock.calls[0];
    expect(entryArgs.kind).toBe('ENTRY');
    expect(entryArgs.side).toBe('LONG');
    expect(entryArgs.quantity).toBe(50);
    const [slArgs] = mockDhanPlace.mock.calls[1];
    expect(slArgs.kind).toBe('SL');
    expect(slArgs.triggerPrice).toBeCloseTo(95, 1);
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.mode).toBe('live');
    expect(p.market).toBe('INDIA');
    expect(p.securityId).toBe('2885');
    expect(j.entries.at(-1)!.status).toBe('SUBMITTED');
    expect(j.entries.at(-1)!.reason).toMatch(/broker SL-M armed/);
  });

  it('SL placement failure does NOT fail the trade (watcher still guards)', async () => {
    mockDhanPlace.mockImplementation(async (args) => {
      if (args.kind === 'SL') throw new Error('SL order rejected');
      return { orderId: 'DH-2', orderStatus: 'TRANSIT', securityId: '2885', lotUnits: 1, tickSize: 0.05 };
    });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(true);
    expect(out.slOrderId).toBeNull();
    expect(loadJournal().entries.at(-1)!.reason).toMatch(/watcher guarding only/);
  });

  it('entry failure → FAILED journal entry, no position', async () => {
    mockDhanPlace.mockRejectedValue(new Error('insufficient margin'));
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/insufficient margin/);
    const j = loadJournal();
    expect(j.entries.at(-1)!.status).toBe('FAILED');
    expect(j.positions).toHaveLength(0);
  });
});

describe('India watcher — SL/TP + 15:15 square-off + trailing', () => {
  it('closes a paper LONG at the stop with a CLOSE journal entry', async () => {
    await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    _tvLtp = 94.9; // below SL 95
    const closures = await watchIndiaPositions({});
    expect(closures).toHaveLength(1);
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toMatch(/STOP-LOSS/);
    expect(j.entries.at(-1)!.kind).toBe('CLOSE');
    expect(j.entries.at(-1)!.market).toBe('INDIA');
  });

  it('trails the peak (1.7R → SL = peak − 1R) and closes when price falls through', async () => {
    await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    _tvLtp = 108.5; // peak 108.5 → trail SL 103.5 (TP2 110 not yet hit)
    await watchIndiaPositions({});
    let j = loadJournal();
    expect(j.positions[0].sl).toBeCloseTo(103.5, 1);
    expect(j.positions[0].trailing).toBe('trail');
    expect(j.entries.some(e => e.kind === 'TRAIL' && e.market === 'INDIA')).toBe(true);
    _tvLtp = 103.2;
    const closures = await watchIndiaPositions({});
    expect(closures).toHaveLength(1);
    expect(closures[0].reason).toMatch(/STOP-LOSS/);
  });

  it('SQUARE-OFF: at 15:15+ IST every open India position force-closes (live: exit order + SL cancel)', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
    const out = await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    expect(out.ok).toBe(true);
    vi.setSystemTime(IST_1520); // 15:20 IST
    _tvLtp = 102;
    const closures = await watchIndiaPositions({});
    expect(closures).toHaveLength(1);
    expect(closures[0].reason).toMatch(/square-off 15:15/);
    // exit order placed + leftover SL cancelled
    const lastCall = mockDhanPlace.mock.calls.at(-1)![0];
    expect(lastCall.side).toBe('SELL'); // closing a LONG
    expect(mockDhanCancel).toHaveBeenCalledWith('DH-1');
    const j = loadJournal();
    expect(j.positions[0].status).toBe('CLOSED');
  });

  it('live close failure → WATCH_ERROR persisted, position stays open (retry next tick)', async () => {
    saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
    await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'live', getFreshIndiaSignal: async () => STRONG_IN() });
    mockDhanPlace.mockClear();
    mockDhanPlace.mockRejectedValue(new Error('exchange down'));
    vi.setSystemTime(IST_1520);
    const closures = await watchIndiaPositions({});
    expect(closures).toHaveLength(0);
    const j = loadJournal();
    expect(j.positions[0].status).toBe('OPEN');
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR')).toBe(true);
  });

  it('manual close routes India positions through the Dhan path', async () => {
    await executeIndiaSignal({ symbol: 'RELIANCE', mode: 'paper', getFreshIndiaSignal: async () => STRONG_IN() });
    _tvLtp = 101;
    const id = loadJournal().positions[0].id;
    const out = await closeIndiaPosition(id);
    expect(out.ok).toBe(true);
    expect(out.position!.closeReason).toBe('Manual close');
  });
});

describe('dhan.js — scrip master + connect validation', () => {
  it('parseScripCsv maps NSE equity only (BSE/derivatives filtered)', () => {
    const csv = [
      'SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SCRIP_ID,SEM_TICK_SIZE',
      'EQUITY,RELIANCE,1,NSE,E,2885,0.05',
      'EQUITY,RELIANCE,1,BSE,E,500325,0.05',      // BSE — filtered (first NSE wins)
      'INDEX,NIFTY,75,NSE,I,999,5',               // index — filtered
      'OPTIDX,NIFTY25JAN24000CE,75,NSE,D,123,5',  // derivative — filtered
      'EQUITY,TCS,1,NSE,E,11536,0.05',
    ].join('\n');
    const map = parseScripCsv(csv);
    expect(map.RELIANCE.securityId).toBe('2885');
    expect(map.TCS.securityId).toBe('11536');
    expect(map.NIFTY).toBeUndefined();
    expect(Object.keys(map)).toHaveLength(2);
  });

  it('dhanConnect validates clientId + token shape', async () => {
    const dhan = await import('../server/ai/dhan.js');
    expect(() => dhan.dhanConnect('abc', 'x'.repeat(40))).toThrow(/Client ID/);
    expect(() => dhan.dhanConnect('110001234', 'short')).toThrow(/Access Token/);
  });
});
