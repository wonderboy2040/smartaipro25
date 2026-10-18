// ============================================================
// test/v189IndiaClock.test.ts — v18.9 INDIA + CLOCK + FRONTEND
// ------------------------------------------------------------
//   1.  Dhan FILL VERIFICATION — TRADED fills book the broker's
//       average price; REJECTED never books a phantom position
//   2.  INDIA DAY-ROLLOVER — yesterday's positions reconcile
//       (paper STALE_SQOFF; live verified against dhanPositions)
//       instead of being managed against today's fresh prices
//   3.  UNKNOWN counts for one-per-symbol (no stacked live orders)
//   4.  data.js isNseOpen is HOLIDAY-AWARE (shares time.js)
//   5.  paperTrading evaluatePaper per-tick day-rollover guard
//   6.  trackRecord levels FROZEN at first publish
//   7.  committee persona quorum (2 of 3)
//   8.  Frontend source contracts (lot-size input, REFRESH_MS,
//       posSeq SSE bump, preview gate, SET NaN guard, fx fallback)
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- mocks (BEFORE importing the engines) ----
const mockDhanPlace = vi.fn();
const mockDhanCancel = vi.fn();
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
// data.js mock state — vi.hoisted so the vi.mock factory (hoisted above
// module body) can safely assign into it at factory-run time.
const h = vi.hoisted(() => ({
  tvLtp: 100,
  realIsNseOpen: null as null | ((now?: Date) => boolean),
  realTVBatch: null as null | unknown,
}));
const mockIsNseOpen = vi.fn();
const mockTVBatch = vi.fn();
vi.mock('../server/ai/data.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../server/ai/data.js')>();
  h.realIsNseOpen = orig.isNseOpen;
  return {
    ...orig,
    isNseOpen: (...a: unknown[]) => mockIsNseOpen(...(a as never[])),
    fetchTVIndiaBatch: (...a: unknown[]) => mockTVBatch(...(a as never[])),
  };
});

import { executeIndiaSignal, watchIndiaPositions } from '../server/ai/indiaOrders.js';
import {
  __resetForTests, loadJournal, __setJournalForTests, loadConfig,
} from '../server/ai/coindcxOrders.js';
import { isNseOpen } from '../server/ai/data.js';
import { isNseMarketOpen } from '../server/intraday/time.js';
import { loadJSON as loadJSONOrig, saveJSON } from '../server/lib/store.js';
import fs from 'node:fs';

const STRONG_IN = (over = {}) => ({
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 78, agreement: 0.74, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 95, target1: 105, target2: 110,
    risk: 5, riskPct: 5, rewardRisk: 2, atrUsed: 3.5, planStyle: 'atr-based',
  },
  votes: [], summary: 'x', ...over,
});

/** IST clock pin: 2026-01-14 Wed 11:00 IST. 2026-01-13 = Tuesday. */
const WED_1100 = new Date('2026-01-14T05:30:00Z');

let _origCreds = null;
beforeEach(() => {
  // shouldAdvanceTime: the v18.9 Dhan fill-verification polls sleep 300-600ms
  // — with frozen fake timers those sleeps would hang the journal lock and
  // cascade-timeout every later test.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(WED_1100);
  __resetForTests();
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'k', secret: 's', connectedAt: Date.now() });
  h.tvLtp = 100;
  mockDhanPlace.mockReset();
  mockDhanCancel.mockReset();
  mockDhanStatus.mockReset();
  mockDhanPositions.mockReset();
  mockDhanPlace.mockResolvedValue({ orderId: 'e1', orderStatus: 'TRANSIT', securityId: '1333', lotUnits: 1 });
  mockDhanStatus.mockResolvedValue(null);
  mockDhanPositions.mockResolvedValue([]);
  mockDhanCancel.mockResolvedValue({ ok: true });
  // re-seed data.js passthroughs: default = the REAL holiday-aware
  // isNseOpen (the v18.9 gate under test) + a TV batch at h.tvLtp
  mockIsNseOpen.mockClear();
  mockTVBatch.mockClear();
  mockIsNseOpen.mockImplementation((...a: unknown[]) => (h.realIsNseOpen ?? (() => true))(...(a as [])));
  mockTVBatch.mockImplementation(async (symbols: string[]) => {
    const out: Record<string, unknown> = {};
    for (const s of symbols) out[s] = { symbol: s, ltp: h.tvLtp, open: h.tvLtp, high: h.tvLtp, low: h.tvLtp, volume: 1000, changePct: 0 };
    return out;
  });
  // LIVE arming (same as the v6.5 gauntlet tests)
  saveJSON('ai-trading-config.json', { ...loadConfig(), indiaMode: 'live', indiaLiveConfirmedAt: Date.now() });
});
afterEach(() => {
  vi.useRealTimers();
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
  vi.restoreAllMocks();
});

// ---------------- 1. Dhan fill verification ----------------
describe('v18.9 India #1 — live entry fills are verified, not assumed', () => {
  it('TRADED + averageTradedPrice → entryPrice books the BROKER fill, not the signal LTP', async () => {
    mockDhanStatus.mockResolvedValue({ orderStatus: 'TRADED', averageTradedPrice: 100.75 });
    const r = await executeIndiaSignal({
      symbol: 'RELIANCE', side: 'LONG', mode: 'live', qtyINR: 5000,
      getFreshIndiaSignal: async () => ({ ...STRONG_IN() }),
    });
    expect(r.ok).toBe(true);
    expect(mockDhanStatus).toHaveBeenCalled();
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.status).toBe('OPEN');
    expect(p.fillVerified).toBe(true);
    expect(p.entryPrice).toBe(100.75); // broker average, not 100
  });

  it('REJECTED → FAILED entry, NO position booked (no phantom to later "close")', async () => {
    mockDhanStatus.mockResolvedValue({ orderStatus: 'REJECTED', rejectedReason: 'margin shortfall' });
    const r = await executeIndiaSignal({
      symbol: 'RELIANCE', side: 'LONG', mode: 'live', qtyINR: 5000,
      getFreshIndiaSignal: async () => ({ ...STRONG_IN() }),
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/REJECT/i);
    const j = loadJournal();
    expect(j.positions).toHaveLength(0);
    expect(j.entries.some(e => e.status === 'FAILED')).toBe(true);
  });
});

// ---------------- 2. day-rollover reconcile ----------------
describe('v18.9 India #2 — yesterday’s positions reconcile, never get next-day managed', () => {
  it('PAPER position from Tuesday auto-managed on Wednesday → STALE_SQOFF close instead', async () => {
    const openedTuesday = new Date('2026-01-13T06:00:00Z').getTime();
    __setJournalForTests({
      entries: [],
      positions: [{
        id: 'old1', pair: 'RELIANCE', symbol: 'RELIANCE', side: 'LONG', mode: 'paper', market: 'INDIA', source: 'manual',
        qty: 10, entryPrice: 100, sl: 60, tp: null, tp2: 200, // far levels — would never close on its own
        peakPrice: 102, openedAt: openedTuesday, status: 'OPEN',
      }],
    });
    const closures = await watchIndiaPositions({});
    expect(closures.length).toBeGreaterThanOrEqual(1);
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toContain('STALE_SQOFF');
    // NO dhan order was placed for a paper row
    expect(mockDhanPlace).not.toHaveBeenCalled();
  });

  it('LIVE position gone from the broker book → MISSED_SQOFF close (broker auto-square)', async () => {
    const openedTuesday = new Date('2026-01-13T06:00:00Z').getTime();
    __setJournalForTests({
      entries: [],
      positions: [{
        id: 'old2', pair: 'RELIANCE', symbol: 'RELIANCE', side: 'LONG', mode: 'live', market: 'INDIA', source: 'manual',
        qty: 10, entryPrice: 100, sl: 60, tp: null, tp2: 200,
        peakPrice: 102, openedAt: openedTuesday, status: 'OPEN', securityId: '1333', exchangeOrderId: 'e9',
      }],
    });
    mockDhanPositions.mockResolvedValue([]); // broker holds nothing
    const closures = await watchIndiaPositions({});
    expect(closures.length).toBeGreaterThanOrEqual(1);
    const j = loadJournal();
    expect(j.positions[0].status).toBe('CLOSED');
    expect(j.positions[0].closeReason).toContain('MISSED_SQOFF');
    expect(mockDhanPlace).not.toHaveBeenCalled(); // no naked next-day order
  });

  it('LIVE position STILL held at the broker (CNC carry) → carriedOvernight flag + alert, never auto-traded', async () => {
    const openedTuesday = new Date('2026-01-13T06:00:00Z').getTime();
    __setJournalForTests({
      entries: [],
      positions: [{
        id: 'old3', pair: 'RELIANCE', symbol: 'RELIANCE', side: 'LONG', mode: 'live', market: 'INDIA', source: 'manual',
        qty: 10, entryPrice: 100, sl: 60, tp: null, tp2: 200,
        peakPrice: 102, openedAt: openedTuesday, status: 'OPEN', securityId: '1333', exchangeOrderId: 'e9',
      }],
    });
    mockDhanPositions.mockResolvedValue([{ securityId: '1333', netQty: 10 }]);
    await watchIndiaPositions({});
    const j = loadJournal();
    expect(j.positions[0].status).toBe('OPEN');
    expect(j.positions[0].carriedOvernight).toBe(true);
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /OVERNIGHT CARRY/.test(String(e.reason || '')))).toBe(true);
    expect(mockDhanPlace).not.toHaveBeenCalled();
  });

  it('today’s LIVE-UNKNOWN position is surfaced (alert) but NEVER auto-closed (naked-order protect)', async () => {
    __setJournalForTests({
      entries: [],
      positions: [{
        id: 'unk1', pair: 'RELIANCE', symbol: 'RELIANCE', side: 'LONG', mode: 'live', market: 'INDIA', source: 'manual',
        qty: 10, entryPrice: 100, sl: 95, tp: null, tp2: 90, // SL would trip at ltp 100? no — 100 > 95; use sl above
        peakPrice: 100, openedAt: Date.now(), status: 'UNKNOWN', securityId: '1333',
      }],
    });
    h.tvLtp = 100;
    await watchIndiaPositions({});
    const j = loadJournal();
    expect(j.positions[0].status).toBe('UNKNOWN'); // untouched
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /UNKNOWN live India position/.test(String(e.reason || '')))).toBe(true);
  });
});

// ---------------- 3. one-per-symbol includes UNKNOWN ----------------
describe('v18.9 India #3 — UNKNOWN blocks a second live order on the same symbol', () => {
  it('executeIndiaSignal REJECTS when an UNKNOWN row exists for the symbol', async () => {
    __setJournalForTests({
      entries: [],
      positions: [{
        id: 'unk2', pair: 'RELIANCE', symbol: 'RELIANCE', side: 'LONG', mode: 'live', market: 'INDIA', source: 'manual',
        qty: 5, entryPrice: 100, sl: 95, openedAt: Date.now(), status: 'UNKNOWN', securityId: '1333',
      }],
    });
    const r = await executeIndiaSignal({
      symbol: 'RELIANCE', side: 'LONG', mode: 'live', qtyINR: 5000,
      getFreshIndiaSignal: async () => ({ ...STRONG_IN() }),
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/one-per-symbol/i);
    expect(mockDhanPlace).not.toHaveBeenCalled();
  });
});

// ---------------- 4. holiday-aware isNseOpen ----------------
describe('v18.9 #4 — data.js isNseOpen shares the NSE holiday calendar', () => {
  it('Republic Day (Mon 2026-01-26, 10:00 IST) → CLOSED (old twin said open)', () => {
    // 04:30 UTC = 10:00 IST on 2026-01-26 (Monday)
    expect(isNseOpen(new Date('2026-01-26T04:30:00Z'))).toBe(false);
    expect(isNseMarketOpen(new Date('2026-01-26T04:30:00Z'))).toBe(false); // same definition
  });
  it('a normal Wednesday 10:00 IST → OPEN', () => {
    expect(isNseOpen(new Date('2026-01-14T04:30:00Z'))).toBe(true);
  });
  it('weekend stays closed', () => {
    expect(isNseOpen(new Date('2026-01-17T04:30:00Z'))).toBe(false); // Saturday
  });
});

// ---------------- 8. frontend source contracts ----------------
describe('v18.9 frontend — source contracts (money-display fixes)', () => {
  const read = (p) => fs.readFileSync(p, 'utf8');

  it('ManualTradePrompt: lot-size is a validated user input (no more hardcoded 75)', () => {
    const src = read('src/components/aitrading/ManualTradePrompt.tsx');
    expect(src).toMatch(/const \[lotSize, setLotSize\]/);
    expect(src).toMatch(/lotSize: lotValid \? Math\.round\(lotNum\) : 75/);
    expect(src).not.toMatch(/lotSize: 75,/); // the old hardcoded submit line
    expect(src).toMatch(/AbortSignal\.timeout\(20_000\)/); // fetch timeout
  });

  it('deskShared: REFRESH_MS matches the real 60s board poll; mood is percentage-point math', () => {
    const src = read('src/components/aitrading/deskShared.tsx');
    // v20.7.11 dead-code purge: REFRESH_MS de-exported (internal-only now) —
    // the 60s value contract survives.
    expect(src).toMatch(/const REFRESH_MS = 60_000/);
    expect(src).toMatch(/\(\(b\.bull - b\.bear\) \/ Math\.max\(1, b\.bull \+ b\.bear \+ \(b\.flat \|\| 0\)\)\) \* 100/);
  });

  it('useAITrading: the SSE positions snapshot bumps the posSeq staleness guard', () => {
    const src = read('src/components/aitrading/useAITrading.ts');
    // exactly one bump inside the SSE 'positions' handler (plus the REST loader's own)
    const handler = src.split("src.addEventListener('positions'")[1]?.split('});')[0] || '';
    expect(handler).toMatch(/posSeqRef\.current \+= 1/);
  });

  it('SignalCard: the crypto order preview hides while the trade ticket is open', () => {
    const src = read('src/components/aitrading/SignalCard.tsx');
    expect(src).toMatch(/signal\.market === 'CRYPTO' && onExecute && !ticketOpen && \(\s*<CryptoOrderPreview/);
  });

  it('OrderConsole: SET is disabled for non-numeric input (no fake "Saved")', () => {
    const src = read('src/components/aitrading/OrderConsole.tsx');
    // v20.7.8: the guard moved to fNum/fBad (empty-string hole + positivity
    // gates) — the OLD raw regex no longer matches. Lock the NEW contract:
    // empty → NaN, finite + positive checks, and the button binds fBad.
    expect(src).toMatch(/const fNum = f\.val\.trim\(\) === '' \? NaN : Number\(f\.val\)/);
    expect(src).toMatch(/const fBad = !Number\.isFinite\(fNum\) \|\| \(f\.positive \? !\(fNum > 0\) : fNum < 0\)/);
    expect(src).toMatch(/disabled=\{busy \|\| fBad\}/);
  });

  // v20.0: assetPnl source-contract case removed — the whole
  // portfolio/P&L module tree was deleted in the two-desk rebuild.
});
