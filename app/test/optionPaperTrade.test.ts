// ============================================================
// v9.5 F&O OPTION PAPER TRADING + direction-vocabulary tests
//   • openPaperTrade OPTION — validation, storage, lot-multiplied P&L
//   • injectOptionPaperQuotes — BS re-pricing from the index spot
//   • evaluatePaper on an option row — T1 50% book + lot math
//   • _publicTrade/_sanitizeRestoredTrade — option fields round-trip
//   • evaluateExecutionGate — BUY/SELL aliases accepted (the
//     "signal side is LONG, requested BUY" bug class)
// Store + journal are mocked so tests never touch server/data/.
// Fake timers pin IST to ~10:00 (pre-square-off, market window) so
// the 15:10 EOD close never interferes with the assertions.
// ============================================================
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));

import {
  openPaperTrade, evaluatePaper, injectOptionPaperQuotes,
  optionUnderlyingsForWatcher, getPaperSummary, restorePaperTrades,
  _resetForTests,
} from '../server/intraday/paperTrading.js';
import { evaluateExecutionGate } from '../server/ai/ensemble.js';
import { bsPrice, yearsToExpiry } from '../server/ai/lib/blackScholes.js';

// IST 10:00 on a weekday → istMinutes 600 (< 910 sqoff, NSE window).
const FAKE_NOW = new Date('2026-09-11T04:30:00Z');
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(FAKE_NOW); });
afterAll(() => { vi.useRealTimers(); });

const NOW_MS = FAKE_NOW.getTime();
const nextWeek = new Date(NOW_MS + 7 * 24 * 3600_000).toISOString().slice(0, 10);

const OPTION_BODY = {
  symbol: 'NIFTY23400CE',
  direction: 'LONG',
  entry: 86.5, qty: 2,
  stopLoss: 77, target1: 110, target2: 145,
  market: 'INDIA',
  assetKind: 'OPTION', underlying: 'NIFTY',
  strike: 23400, optType: 'CE', expiry: nextWeek,
  iv: 13, lotSize: 75,
  label: 'Nifty50 15Sep 23400 CE',
};

beforeEach(() => {
  _resetForTests();
});

describe('v9.5 — F&O option paper trade: open + validation', () => {
  it('opens with the full option identity and premium-LONG direction', () => {
    const r = openPaperTrade(OPTION_BODY);
    expect(r.ok).toBe(true);
    expect(r.trade.assetKind).toBe('OPTION');
    expect(r.trade.underlying).toBe('NIFTY');
    expect(r.trade.strike).toBe(23400);
    expect(r.trade.optType).toBe('CE');
    expect(r.trade.expiry).toBe(nextWeek);
    expect(r.trade.lotSize).toBe(75);
    expect(r.trade.label).toBe('Nifty50 15Sep 23400 CE');
    expect(r.trade.direction).toBe('LONG');        // premium BUY = LONG
    expect(r.trade.capital).toBeCloseTo(86.5 * 75 * 2, 1); // lots × lot premium
  });

  it('rejects option rows that try to pass direction SHORT (option BUY is premium-LONG)', () => {
    const r = openPaperTrade({ ...OPTION_BODY, direction: 'SHORT' });
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/premium-BUY/i);
  });

  it('rejects unsupported underlying / missing IV / bad expiry / bad lotSize', () => {
    expect(openPaperTrade({ ...OPTION_BODY, underlying: 'AAPL' }).error).toMatch(/unsupported underlying/i);
    expect(openPaperTrade({ ...OPTION_BODY, iv: 0 }).error).toMatch(/IV required/i);
    expect(openPaperTrade({ ...OPTION_BODY, expiry: '15/09/2026' }).error).toMatch(/expiry/i);
    expect(openPaperTrade({ ...OPTION_BODY, lotSize: 0 }).error).toMatch(/lotSize/i);
  });

  it('rejects CRYPTO market on option rows', () => {
    const r = openPaperTrade({ ...OPTION_BODY, market: 'CRYPTO' });
    expect(r.error).toMatch(/INDIA-market only/i);
  });
});

describe('v9.5 — injectOptionPaperQuotes: BS re-pricing from the index spot', () => {
  it('injects a live BS premium quote for the open option row', async () => {
    openPaperTrade(OPTION_BODY);
    const quotes: Record<string, { price: number }> = {};
    const spot = 23460;
    await injectOptionPaperQuotes(quotes, async (u) => {
      expect(u).toBe('NIFTY');
      return { price: spot };
    });
    // SAME T formula as the engine — exact expectation, no drift.
    // v21.0.6: RISK_FREE aligned to optionsDesk.js (0.069).
    const T = Math.max(0, yearsToExpiry(`${nextWeek}T15:30:00+05:30`, new Date(NOW_MS)));
    const expected = +Math.max(0.05, bsPrice(spot, 23400, T, 0.069, 13 / 100, 'CE')).toFixed(2);
    expect(quotes.NIFTY23400CE).toBeDefined();
    expect(quotes.NIFTY23400CE.price).toBeCloseTo(expected, 2);
  });

  it('prices at intrinsic when expiry has passed (T = 0)', async () => {
    openPaperTrade({ ...OPTION_BODY, expiry: '2020-01-01' });
    const quotes: Record<string, { price: number }> = {};
    await injectOptionPaperQuotes(quotes, async () => ({ price: 24000 }));
    expect(quotes.NIFTY23400CE.price).toBe(600); // 24000 − 23400
  });

  it('no-op with no fetcher or no open option rows', async () => {
    openPaperTrade(OPTION_BODY);
    const quotes: Record<string, unknown> = {};
    await injectOptionPaperQuotes(quotes, undefined);
    expect(quotes.NIFTY23400CE).toBeUndefined();
    _resetForTests();
    const q2: Record<string, unknown> = {};
    await injectOptionPaperQuotes(q2, async () => ({ price: 23400 }));
    expect(Object.keys(q2)).toHaveLength(0);
  });

  it('PE option re-prices off the same machinery', async () => {
    openPaperTrade({ ...OPTION_BODY, symbol: 'SENSEX80000PE', optType: 'PE', type: 'PE', underlying: 'SENSEX', strike: 80000 });
    const quotes: Record<string, { price: number }> = {};
    await injectOptionPaperQuotes(quotes, async () => ({ price: 79500 }));
    const T = Math.max(0, yearsToExpiry(`${nextWeek}T15:30:00+05:30`, new Date(NOW_MS)));
    const expected = +Math.max(0.05, bsPrice(79500, 80000, T, 0.069, 13 / 100, 'PE')).toFixed(2);
    expect(quotes.SENSEX80000PE.price).toBeCloseTo(expected, 2);
  });

  it('optionUnderlyingsForWatcher lists the open underlying only', () => {
    expect(optionUnderlyingsForWatcher()).toHaveLength(0);
    openPaperTrade(OPTION_BODY);
    expect(optionUnderlyingsForWatcher()).toEqual(['NIFTY']);
  });
});

describe('v9.5 — option P&L uses the lot multiplier', () => {
  it('unrealized P&L = qty(lots) × (premium − entry) × lotSize', () => {
    const r = openPaperTrade(OPTION_BODY);
    expect(r.ok).toBe(true);
    const events: unknown[] = [];
    evaluatePaper({ NIFTY23400CE: { price: 91.5 } }, events); // +5 premium pts
    const t = getPaperSummary().open[0];
    expect(t).toBeDefined();
    expect(t.status).toBe('OPEN');
    expect(t.unrealizedPnl).toBeCloseTo(2 * 5 * 75, 1); // 2 lots × ₹5 × 75
    expect(t.assetKind).toBe('OPTION');
    expect(t.label).toBe('Nifty50 15Sep 23400 CE');
  });

  it('T1 books half the lots, realized part is lot-multiplied, rest trails', () => {
    const r = openPaperTrade(OPTION_BODY);
    expect(r.ok).toBe(true);
    const events: unknown[] = [];
    evaluatePaper({ NIFTY23400CE: { price: 111 } }, events); // T1 = 110 hit
    const t = getPaperSummary().open[0];
    expect(t.status).toBe('PARTIAL');
    expect(t.t1Hit).toBe(true);
    expect(t.remainingQty).toBe(1);           // 1 of 2 lots booked
    expect(t.realizedPnl).toBeCloseTo(1 * (110 - 86.5) * 75, 1); // 1 lot × ₹23.5 × 75
    // trail: premium back to entry closes the rest at breakeven
    evaluatePaper({ NIFTY23400CE: { price: 86.5 } }, events);
    const t2 = getPaperSummary().open[0];
    expect(t2).toBeUndefined(); // fully closed now
  });
});

// ============================================================
// v21.0.6 [audit B1] — LIVE-CHAIN premium re-pricing (desk parity).
// Paper exits (SL/T1/T2/BE/EOD) ab VAHI premium use karte hain jo
// options desk dikhata hai (fetchChain = data.js ladder). BS model
// sirf fallback (chain down / contract row missing).
// ============================================================
const LIVE_CHAIN = {
  symbol: 'NIFTY', source: 'nse', via: 'groww', lotSize: 75, spot: 23460,
  expiryDates: [nextWeek],
  rows: [
    { strike: 23350, expiry: nextWeek, callLTP: 141.2, putLTP: 30.1, callOI: 100, putOI: 100 },
    { strike: 23400, expiry: nextWeek, callLTP: 99.25, putLTP: 51.4, callOI: 200, putOI: 200 },
    { strike: 23450, expiry: nextWeek, callLTP: 64.8, putLTP: 83.2, callOI: 300, putOI: 300 },
    { strike: 23500, expiry: nextWeek, callLTP: 38.9, putLTP: 122.6, callOI: 400, putOI: 400 },
    { strike: 23550, expiry: nextWeek, callLTP: 21.5, putLTP: 170.3, callOI: 500, putOI: 500 },
  ],
};

describe('v21.0.6 — injectOptionPaperQuotes: LIVE chain first, BS fallback', () => {
  it('live chain LTP wins (desk parity) — BS math not used when the row exists', async () => {
    openPaperTrade(OPTION_BODY);
    const quotes: Record<string, { price: number }> = {};
    const spot = 23460; // same spot the BS path would use
    await injectOptionPaperQuotes(quotes, async () => ({ price: spot }), async () => LIVE_CHAIN);
    expect(quotes.NIFTY23400CE).toBeDefined();
    expect(quotes.NIFTY23400CE.price).toBe(99.25); // chain callLTP — NOT the BS value
    const T = Math.max(0, yearsToExpiry(`${nextWeek}T15:30:00+05:30`, new Date(NOW_MS)));
    const bs = +Math.max(0.05, bsPrice(spot, 23400, T, 0.069, 13 / 100, 'CE')).toFixed(2);
    expect(bs).not.toBe(99.25); // sanity: the two paths genuinely differ
  });

  it('chain fetcher absent/null → honest BS fallback (hermetic legacy path)', async () => {
    openPaperTrade(OPTION_BODY);
    const quotes: Record<string, { price: number }> = {};
    const spot = 23460;
    await injectOptionPaperQuotes(quotes, async () => ({ price: spot }), async () => null);
    const T = Math.max(0, yearsToExpiry(`${nextWeek}T15:30:00+05:30`, new Date(NOW_MS)));
    const expected = +Math.max(0.05, bsPrice(spot, 23400, T, 0.069, 13 / 100, 'CE')).toFixed(2);
    expect(quotes.NIFTY23400CE.price).toBeCloseTo(expected, 2);
  });

  it('chain up but contract row missing (expiry rolled) → BS fallback for that trade', async () => {
    openPaperTrade({ ...OPTION_BODY, expiry: '2030-01-01' });
    const quotes: Record<string, { price: number }> = {};
    await injectOptionPaperQuotes(quotes, async () => ({ price: 23460 }), async () => LIVE_CHAIN);
    expect(quotes.NIFTY23400CE).toBeDefined(); // BS re-priced (row for 2030 expiry nahi hai)
    expect(quotes.NIFTY23400CE.price).toBeGreaterThan(0);
  });

  it('PE side + SENSEX underlying route through the BSE ladder fetcher', async () => {
    openPaperTrade({ ...OPTION_BODY, symbol: 'SENSEX80000PE', optType: 'PE', type: 'PE', underlying: 'SENSEX', strike: 80000, lotSize: 20 });
    const quotes: Record<string, { price: number }> = {};
    let asked = '';
    await injectOptionPaperQuotes(quotes, async () => ({ price: 79500 }), async (u: string) => {
      asked = u;
      return { ...LIVE_CHAIN, symbol: 'SENSEX', source: 'bse', rows: LIVE_CHAIN.rows.map(r => ({ ...r, strike: r.strike - 23400 + 80000, putLTP: r.strike === 23400 ? 71.4 : r.putLTP })) };
    });
    expect(asked).toBe('SENSEX');
    expect(quotes.SENSEX80000PE.price).toBe(71.4);
  });
});

// ============================================================
// v21.0.6 [audit B2] — 1-lot option trades: T1 no longer closes
// everything. Un-splittable runner ab T1 pe SL→breakeven le leta
// hai, T2/BE-trail KABHI reach nahi hote the (track record +0.5R
// pe structurally capped tha).
// ============================================================
describe('v21.0.6 — 1-lot option T1: BE-protect instead of full close', () => {
  it('qty=1 T1 touch → nothing booked, SL moves to entry, T2 fully closes later', () => {
    const r = openPaperTrade({ ...OPTION_BODY, qty: 1 });
    expect(r.ok).toBe(true);
    const events: any[] = [];
    // T1 = 110 hit
    evaluatePaper({ NIFTY23400CE: { price: 111 } }, events);
    let t = getPaperSummary().open[0];
    expect(t).toBeDefined();          // NOT closed
    expect(t.status).toBe('OPEN');     // nothing booked → not even PARTIAL
    expect(t.t1Hit).toBe(true);
    expect(t.stopLoss).toBe(86.5);     // SL → breakeven (was 77)
    expect(t.remainingQty).toBe(1);   // full runner intact
    expect(events.some(e => e.type === 'PAPER_T1_BE' && /breakeven/i.test(e.note))).toBe(true);
    // pullback to entry → BE trail exit (was the old SL level 77 — NOT hit)
    evaluatePaper({ NIFTY23400CE: { price: 86.5 } }, events);
    t = getPaperSummary().open[0];
    expect(t).toBeUndefined(); // closed at breakeven via new SL
  });

  it('qty=1 T1 touch → runner rides to T2 for the full +1.0R', () => {
    const r = openPaperTrade({ ...OPTION_BODY, qty: 1 });
    expect(r.ok).toBe(true);
    const events: any[] = [];
    evaluatePaper({ NIFTY23400CE: { price: 111 } }, events); // T1 → BE-protect
    evaluatePaper({ NIFTY23400CE: { price: 146 } }, events); // T2 = 145 hit
    const ev = events.find(e => e.type === 'PAPER_CLOSE' && e.note?.includes('T2'));
    expect(ev).toBeTruthy();
    const t = getPaperSummary().open[0];
    expect(t).toBeUndefined();
  });
});

// v21.0.6 [audit] — restore path symbol cap 15 → 20 (openPaperTrade
// _validateSym parity; BANKNIFTY51000CE 16-char restore pe drop hota tha).
describe('v21.0.6 — 16-char F&O symbol survives the restore round-trip', () => {
  it('BANKNIFTY51000CE restores with option identity intact', () => {
    openPaperTrade({ ...OPTION_BODY, symbol: 'BANKNIFTY51000CE', underlying: 'BANKNIFTY', strike: 51000, lotSize: 35 });
    const pub = getPaperSummary().open[0];
    const r = restorePaperTrades({ trades: [{ ...pub, id: pub.id + 2000 }] });
    expect(r.ok).toBe(true);
    const restored = (r.summary.open || []).find((t) => t.id === pub.id + 2000);
    expect(restored?.symbol).toBe('BANKNIFTY51000CE');
    expect(restored?.assetKind).toBe('OPTION');
  });
});

describe('v9.5 — option fields survive the restore round-trip', () => {
  it('sanitize keeps assetKind/strike/expiry/lotSize/label', () => {
    openPaperTrade(OPTION_BODY);
    const pub = getPaperSummary().open[0];
    const r = restorePaperTrades({
      trades: [{
        ...pub,
        // simulate a wiped server: force-merge under a fresh id
        id: pub.id + 1000,
      }],
    });
    expect(r.ok).toBe(true);
    const restored = (r.summary.open || []).find((t) => t.id === pub.id + 1000);
    expect(restored?.assetKind).toBe('OPTION');
    expect(restored?.strike).toBe(23400);
    expect(restored?.lotSize).toBe(75);
    expect(restored?.label).toBe('Nifty50 15Sep 23400 CE');
    expect(restored?.expiry).toBe(nextWeek);
  });

  it('drops option identity when the option fields are corrupted', () => {
    openPaperTrade(OPTION_BODY);
    const pub = getPaperSummary().open[0];
    const r = restorePaperTrades({
      trades: [{
        ...pub,
        id: pub.id + 1001,
        strike: 'NaN',
        iv: 0,
      }],
    });
    expect(r.ok).toBe(true);
    const row = (r.summary.open || []).find((t) => t.id === pub.id + 1001);
    expect(row?.assetKind).toBeUndefined(); // equity-shaped fallback row
  });
});

describe('v9.5 — evaluateExecutionGate side-vocabulary aliases', () => {
  const mkSignal = (side: string, over: Record<string, unknown> = {}) => ({
    symbol: 'BTC', market: 'FUTURES', side, grade: 'STRONG',
    confidence: 80, agreement: 1, generatedAt: Date.now(),
    plan: { riskPct: 1, stopLoss: 100, target1: 120 },
    ...over,
  });

  it('accepts BUY against a LONG signal (the futures paper-trades bug)', () => {
    const v = evaluateExecutionGate(mkSignal('LONG'), { side: 'BUY', venue: 'FUTURES', requireStrong: true });
    expect(v.ok).toBe(true);
  });

  it('accepts SELL against a SHORT signal', () => {
    const v = evaluateExecutionGate(mkSignal('SHORT'), { side: 'SELL', venue: 'FUTURES', requireStrong: true });
    expect(v.ok).toBe(true);
  });

  it('still rejects a genuine direction conflict (BUY vs SHORT)', () => {
    const v = evaluateExecutionGate(mkSignal('SHORT'), { side: 'BUY', venue: 'FUTURES', requireStrong: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/fresh consensus SHORT hai, aapne LONG/);
  });

  it('still rejects FLAT and cross-venue signals', () => {
    expect(evaluateExecutionGate(mkSignal('FLAT'), { side: 'BUY', venue: 'FUTURES' }).ok).toBe(false);
    expect(evaluateExecutionGate(mkSignal('LONG', { market: 'INDIA' }), { side: 'LONG', venue: 'FUTURES' }).ok).toBe(false);
  });
});

// v21.0.3 — EXPIRY-FORMAT + SYMBOL-LENGTH REGRESSION (the "option paper
// trade show nahi hua" root cause). Live NSE chain DD-Mmm-YYYY expiries
// bhejta tha; openPaperTrade ka ISO regex unhe reject kar deta tha aur
// trade KABHI panel me nahi dikhta tha. Ab expiry normalize hoke accept
// hota hai (data.js bhi source par ISO karta hai — ye defensive layer hai).
// BANKNIFTY51000CE (16 chars) pehle 15-char symbol cap me bhi reject hota tha.
describe('v21.0.3 — expiry-format normalization + F&O symbol length', () => {
  it('accepts a DD-Mmm-YYYY (NSE live) expiry and stores it as ISO', () => {
    const dmy = new Date(NOW_MS + 7 * 24 * 3600_000);
    const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const raw = `${dmy.getUTCDate()}-${MONS[dmy.getUTCMonth()]}-${dmy.getUTCFullYear()}`;
    const r = openPaperTrade({ ...OPTION_BODY, expiry: raw });
    expect(r.ok).toBe(true);
    expect(r.trade.expiry).toBe(nextWeek); // ISO me store
  });

  it('still rejects genuinely-broken expiry formats', () => {
    expect(openPaperTrade({ ...OPTION_BODY, expiry: '15/09/2026' }).error).toMatch(/expiry/i);
    expect(openPaperTrade({ ...OPTION_BODY, expiry: '' }).error).toMatch(/expiry/i);
  });

  it('accepts 16-char F&O contract ids (BANKNIFTY51000CE)', () => {
    const r = openPaperTrade({
      ...OPTION_BODY,
      symbol: 'BANKNIFTY51000CE', underlying: 'BANKNIFTY', strike: 51000, lotSize: 35,
      label: 'BankNifty 17Sep 51000 CE',
    });
    expect(r.ok).toBe(true);
    expect(r.trade.symbol).toBe('BANKNIFTY51000CE');
    expect(r.trade.underlying).toBe('BANKNIFTY');
  });
});

// v21.0.2 — EXPIRY-DAY 14:30 EARLY SQUARE-OFF
// Card advertise karta hai "expiry-day 14:30" (optionsDesk exitPlan.timeExit);
// pehle engine flat 15:10 chalata tha. Ab expiry wale OPTION trades aaj hi
// expire ho rahe hon to 14:30 pe EOD_SQOFF fire hota hai (40 min theta burn bacha).
describe('v21.0.2 — expiry-day 14:30 early square-off', () => {
  // FAKE_NOW = 2026-09-11 (Friday) 10:00 IST — aaj hi expiry karte hain
  const todayISO = new Date(NOW_MS + (5.5 * 3600_000)).toISOString().slice(0, 10);

  it('expiry-day option squares off at 14:30 (870), not 15:10 (910)', () => {
    const r = openPaperTrade({ ...OPTION_BODY, expiry: todayISO });
    expect(r.ok).toBe(true);
    // clock → 14:29 — abhi nahi band hona chahiye
    vi.setSystemTime(new Date(NOW_MS + (14 * 60 + 29 - 600) * 60_000));
    let events: any[] = [];
    evaluatePaper({ NIFTY23400CE: { price: 90 } }, events);
    expect((r.trade as any).status === 'OPEN' || (r.trade as any).status === 'PARTIAL').toBe(true);
    expect(events.some(e => e.note?.includes('square-off'))).toBe(false);
    // clock → 14:31 — expiry-day sqoff fire
    vi.setSystemTime(new Date(NOW_MS + (14 * 60 + 31 - 600) * 60_000));
    events = [];
    evaluatePaper({ NIFTY23400CE: { price: 90 } }, events);
    const ev = events.find(e => e.type === 'PAPER_CLOSE');
    expect(ev).toBeTruthy();
    expect(ev.note).toContain('expiry-day 14:30');
  });

  it('non-expiry-day option still squares off at 15:10 (next-week expiry)', () => {
    const r = openPaperTrade({ ...OPTION_BODY }); // expiry = nextWeek
    expect(r.ok).toBe(true);
    // 14:31 pe nahi band hona chahiye
    vi.setSystemTime(new Date(NOW_MS + (14 * 60 + 31 - 600) * 60_000));
    let events: any[] = [];
    evaluatePaper({ NIFTY23400CE: { price: 90 } }, events);
    expect(events.some(e => e.note?.includes('square-off'))).toBe(false);
    // 15:11 pe haan
    vi.setSystemTime(new Date(NOW_MS + (15 * 60 + 11 - 600) * 60_000));
    events = [];
    evaluatePaper({ NIFTY23400CE: { price: 90 } }, events);
    const ev = events.find(e => e.type === 'PAPER_CLOSE');
    expect(ev).toBeTruthy();
    expect(ev.note).toContain('15:10');
  });
});
