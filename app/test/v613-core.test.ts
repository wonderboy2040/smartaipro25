// ============================================================
// test/v613-core.test.ts — v6.13 ORDER TICKET + SIMPLE VIEW
// ------------------------------------------------------------
// User ka seedha sawaal: "F&O Options me kaisa trade karna hai —
// kab lena · konsa expiry · kab exit · limit order kaise lagana"
// (CoinDCX bhi same). Ye suite pin karta hai ki:
//   • buildOrderTicket har strategy ko broker-ready dega:
//     KAB (session phase aware) · EXPIRY (DTE/theta aware) ·
//     per-leg LIMIT price (NSE ₹0.05 tick, BUY up / SELL down) ·
//     EXIT (SL/target/time) · lot rows
//   • expiry-day (DTE 0) = red flag + 14:30 square-off
//   • directional + sub-ACTION grade = honest "entry MAT karo"
//   • premium-% based exits (naked) vs combined-premium (spread)
//   • credit setups ko grade-line se immunity (wo low-conviction
//     design hi hote hain)
//   • daysToExpiry calendar math
// ============================================================
import { describe, expect, it } from 'vitest';
import { buildOrderTicket, daysToExpiry, buildStrategies } from '../server/ai/optionsDesk.js';

const mkDesk = (over: Record<string, unknown> = {}) => ({
  ok: true,
  symbol: 'NIFTY',
  spot: 24600,
  expiry: '2031-06-18', // fixed Thursday future date — no time-bomb
  dte: 3,
  lotSize: 75,
  rows: [],
  analytics: { atmIV: 12 },
  ...over,
});

const mkStrat = (over: Record<string, unknown> = {}) => ({
  id: 'bull-call-spread',
  name: 'Bull Call Spread',
  bias: 'BULLISH',
  conviction: 'ACTION',
  legs: [
    { action: 'BUY', type: 'CE', strike: 24600, premium: 180.25, iv: 12, delta: 0.5, theta: -8 },
    { action: 'SELL', type: 'CE', strike: 24700, premium: 95.5, iv: 12, delta: 0.3, theta: -6 },
  ],
  netDebit: 84.75,
  netCredit: null,
  maxProfit: 15.25,
  maxLoss: 84.75,
  breakevens: [24684.75],
  perLot: { maxProfit: 1143.75, maxLoss: 6356.25 },
  ...over,
});

// Thu 2031-06-19 15:30 IST ke theek UNDER = MORNING window (IST 10:00 Thu);
// Date.UTC(2031, 5, 19, 4, 30) = 10:00 IST same day, expiry +1 din.
const MORNING_NOW = Date.UTC(2031, 5, 18, 4, 30); // Thu 10:00 IST, expiry Fri 2031-06-19... see daysToExpiry tests

describe('v6.13 · daysToExpiry', () => {
  it('expiry-day = 0 (IST calendar semantics — aaj 10:00, aaj expiry)', () => {
    expect(daysToExpiry('2031-06-18', Date.UTC(2031, 5, 18, 4, 30))).toBe(0);
  });
  it('same IST date, late night UTC — aaj hi count hota hai', () => {
    // 2031-06-18 19:00 IST (expiry 15:30 nikal chuka — desk next expiry serve karega)
    expect(daysToExpiry('2031-06-18', Date.UTC(2031, 5, 18, 13, 30))).toBe(0);
  });
  it('kal ka expiry = 1', () => {
    expect(daysToExpiry('2031-06-19', Date.UTC(2031, 5, 18, 4, 30))).toBe(1);
  });
  it('do din baad = 2', () => {
    expect(daysToExpiry('2031-06-20', Date.UTC(2031, 5, 18, 4, 30))).toBe(2);
  });
  it('UTC-midnight edge: IST date pehle din ki ho sakti hai (5:30 shift)', () => {
    // 2031-06-18 20:00 UTC = 2031-06-19 01:30 IST → expiry 06-20 = 1 din baaki
    expect(daysToExpiry('2031-06-20', Date.UTC(2031, 5, 18, 20, 0))).toBe(1);
  });
  it('bad expiry = null (honest)', () => {
    expect(daysToExpiry('not-a-date', Date.UTC(2031, 5, 18))).toBeNull();
  });
});

describe('v6.13 · buildOrderTicket — structure', () => {
  const t = buildOrderTicket(mkDesk(), mkStrat(), { side: 'LONG', confidence: 72, agreement: 0.8, grade: 'ACTION' }, MORNING_NOW);
  it('ticket ban gaya (data full hai)', () => {
    expect(t).toBeTruthy();
  });
  it('per-leg LIMIT prices ₹0.05 tick pe: BUY up, SELL down', () => {
    expect(t!.legs).toHaveLength(2);
    const [buy, sell] = t!.legs;
    // BUY: max(ltp+0.05, ltp*1.01) → max(180.30, 182.05) = 182.05
    expect(buy.limit).toBe(182.05);
    expect(buy.action).toBe('BUY');
    expect(buy.qtyPerLot).toBe(75);
    // SELL: ltp*0.99 → 94.54… → 94.55 tick round
    expect(sell.limit).toBe(94.55);
    expect(sell.limit! * 20).toBeCloseTo(Math.round(sell.limit! * 20), 8);
  });
  it('kind debit + dte present + lot rows 1/2/3 scaling', () => {
    expect(t!.kind).toBe('debit');
    expect(t!.dte).toBeGreaterThanOrEqual(0);
    expect(t!.lotRows).toHaveLength(3);
    expect(t!.lotRows[0].maxLoss).toBe(6356);
    expect(t!.lotRows[2].maxLoss).toBe(6356 * 3);
  });
  it('exit block teeno keys (sl/target/time) non-empty', () => {
    expect(t!.exit.sl.length).toBeGreaterThan(10);
    expect(t!.exit.target.length).toBeGreaterThan(10);
    expect(t!.exit.time.length).toBeGreaterThan(10);
  });
});

describe('v6.13 · KAB — session phase honesty', () => {
  const cons = { side: 'LONG', confidence: 72, agreement: 0.8, grade: 'ACTION' };
  it('MORNING window me entry OK bolta hai', () => {
    const t = buildOrderTicket(mkDesk(), mkStrat(), cons, Date.UTC(2031, 5, 18, 4, 45)); // 10:15 IST
    expect(t!.whenText).toMatch(/MORNING/i);
    expect(t!.sessionTradeable).toBe(true);
    expect(t!.whenText).not.toMatch(/MAT karo/i);
  });
  it('OPENING noise (9:15–9:30) me wait bolta hai', () => {
    const t = buildOrderTicket(mkDesk(), mkStrat(), cons, Date.UTC(2031, 5, 18, 3, 50)); // 09:20 IST
    expect(t!.whenText).toMatch(/9:30 ka wait karo/i);
    expect(t!.sessionTradeable).toBe(false);
  });
  it('NO_NEW_ENTRIES (15:15+) me fresh entry band', () => {
    const t = buildOrderTicket(mkDesk(), mkStrat(), cons, Date.UTC(2031, 5, 18, 9, 50)); // 15:20 IST
    expect(t!.whenText).toMatch(/15:15|square-off/i);
  });
  it('CLOSED (weekend) me order nahi', () => {
    const t = buildOrderTicket(mkDesk(), mkStrat(), cons, Date.UTC(2031, 5, 21, 5, 0)); // Sat
    expect(t!.whenText).toMatch(/band|nahi/i);
    expect(t!.sessionTradeable).toBe(false);
  });
  it('directional + WATCH grade = honest "entry MAT karo" prefix', () => {
    const t = buildOrderTicket(mkDesk(), mkStrat(), { side: 'LONG', confidence: 40, agreement: 0.5, grade: 'WATCH' }, MORNING_NOW);
    expect(t!.whenText).toMatch(/WATCH-grade hai — ACTION hone tak entry MAT karo/i);
  });
  it('credit/neutral setups grade-line se immune (low conviction DESIGN hai)', () => {
    const condor = mkStrat({
      id: 'iron-condor', bias: 'NEUTRAL', netDebit: null, netCredit: 42,
      legs: [
        { action: 'SELL', type: 'CE', strike: 24800, premium: 30, iv: 12, delta: 0.2, theta: -3 },
        { action: 'BUY', type: 'CE', strike: 24900, premium: 12, iv: 12, delta: 0.1, theta: -2 },
        { action: 'SELL', type: 'PE', strike: 24400, premium: 28, iv: 12, delta: -0.2, theta: -3 },
        { action: 'BUY', type: 'PE', strike: 24300, premium: 10, iv: 12, delta: -0.1, theta: -2 },
      ],
    });
    const t = buildOrderTicket(mkDesk(), condor, { side: 'FLAT', confidence: 10, agreement: 0.2, grade: 'NEUTRAL' }, MORNING_NOW);
    expect(t!.whenText).not.toMatch(/MAT karo/i);
    expect(t!.kind).toBe('credit');
  });
});

describe('v6.13 · KONSA EXPIRY — DTE/theta advice', () => {
  const cons = { side: 'LONG', confidence: 72, agreement: 0.8, grade: 'ACTION' };
  it('expiry-day (dte 0) = red flag + 14:00–14:30 square-off', () => {
    const t = buildOrderTicket(mkDesk({ expiry: '2031-06-18' }), mkStrat(), cons, Date.UTC(2031, 5, 18, 4, 30));
    expect(t!.expiryDay).toBe(true);
    expect(t!.expiryText).toMatch(/AAJ ke expiry/i);
    expect(t!.expiryText).toMatch(/14:00–14:30/i);
  });
  it('dte 1 = "kal expiry — aaj hi close karo"', () => {
    const t = buildOrderTicket(mkDesk({ expiry: '2031-06-19' }), mkStrat(), cons, Date.UTC(2031, 5, 18, 4, 30));
    expect(t!.expiryText).toMatch(/Kal \(2031-06-19\) expiry/i);
  });
  it('dte 3 = "current weekly best liquidity"', () => {
    const t = buildOrderTicket(mkDesk({ expiry: '2031-06-21' }), mkStrat(), cons, Date.UTC(2031, 5, 18, 4, 30));
    expect(t!.expiryText).toMatch(/best liquidity/i);
  });
  it('dte ≥ 5 = "premium dheere move"', () => {
    const t = buildOrderTicket(mkDesk({ expiry: '2031-06-25' }), mkStrat(), cons, Date.UTC(2031, 5, 18, 4, 30));
    expect(t!.expiryText).toMatch(/dheere move/i);
  });
});

describe('v6.13 · EXIT — strategy-kind ke hisaab se', () => {
  const cons = { side: 'LONG', confidence: 72, agreement: 0.8, grade: 'ACTION' };
  // expiry 2 din baaki — non-expiry-day branch test karna hai
  const DESK2 = mkDesk({ expiry: '2031-06-20' });
  it('debit spread = combined premium 50% SL + 50% max-profit target + MIS 15:15', () => {
    const t = buildOrderTicket(DESK2, mkStrat(), cons, MORNING_NOW);
    expect(t!.exit.sl).toMatch(/combined premium 50%/i);
    expect(t!.exit.target).toMatch(/50% max profit/i);
    expect(t!.exit.time).toMatch(/15:15/i);
  });
  it('naked long call = premium −40% SL (index level nahi)', () => {
    const naked = mkStrat({
      id: 'long-call', name: 'Long Call (ATM)', conviction: 'STRONG',
      legs: [{ action: 'BUY', type: 'CE', strike: 24600, premium: 180.25, iv: 12, delta: 0.5, theta: -8 }],
      netDebit: 180.25, netCredit: null, maxProfit: null, maxLoss: 180.25,
      perLot: { maxProfit: null, maxLoss: 13518.75 },
    });
    const t = buildOrderTicket(mkDesk(), naked, { side: 'LONG', confidence: 80, agreement: 0.85, grade: 'STRONG' }, MORNING_NOW);
    expect(t!.exit.sl).toMatch(/premium −40%/i);
    expect(t!.exit.sl).toMatch(/₹108\.15/);
  });
  it('credit harvester = 50% credit book + short-strike adjust', () => {
    const condor = mkStrat({
      id: 'iron-condor', bias: 'NEUTRAL', netDebit: null, netCredit: 42,
      legs: [
        { action: 'SELL', type: 'CE', strike: 24800, premium: 30, iv: 12, delta: 0.2, theta: -3 },
        { action: 'BUY', type: 'CE', strike: 24900, premium: 12, iv: 12, delta: 0.1, theta: -2 },
        { action: 'SELL', type: 'PE', strike: 24400, premium: 28, iv: 12, delta: -0.2, theta: -3 },
        { action: 'BUY', type: 'PE', strike: 24300, premium: 10, iv: 12, delta: -0.1, theta: -2 },
      ],
    });
    const t = buildOrderTicket(mkDesk(), condor, { side: 'FLAT', confidence: 10, agreement: 0.2, grade: 'NEUTRAL' }, MORNING_NOW);
    expect(t!.exit.target).toMatch(/50% credit/i);
    expect(t!.exit.sl).toMatch(/SHORT strike/i);
  });
});

describe('v6.13 · honesty + integration', () => {
  it('missing data → null (koi fake ticket nahi)', () => {
    expect(buildOrderTicket(null as never, mkStrat(), null, MORNING_NOW)).toBeNull();
    expect(buildOrderTicket({ ok: false } as never, mkStrat(), null, MORNING_NOW)).toBeNull();
    expect(buildOrderTicket(mkDesk(), { ...mkStrat(), legs: [] }, null, MORNING_NOW)).toBeNull();
    expect(buildOrderTicket(mkDesk(), { ...mkStrat(), legs: [{ ...mkStrat().legs[0], premium: 0 }] }, null, MORNING_NOW)).toBeNull();
  });
  it('buildStrategies har strategy ko ticket attach karta hai (sunny-day data)', () => {
    const desk = {
      ok: true, symbol: 'NIFTY', spot: 24600, expiry: '2031-06-19', dte: 1, lotSize: 75,
      rows: [
        { strike: 24550, callOI: 1000, putOI: 900, callIV: 12, putIV: 12.5, callLTP: 220, putLTP: 45, callOIChange: 10, putOIChange: -5 },
        { strike: 24600, callOI: 2000, putOI: 1800, callIV: 12, putIV: 12, callLTP: 180, putLTP: 95, callOIChange: 20, putOIChange: -10 },
        { strike: 24650, callOI: 1500, putOI: 1200, callIV: 11.8, putIV: 12.2, callLTP: 130, putLTP: 145, callOIChange: 5, putOIChange: 8 },
        { strike: 24700, callOI: 1200, putOI: 800, callIV: 11.5, putIV: 12, callLTP: 95, putLTP: 210, callOIChange: -5, putOIChange: 12 },
        { strike: 24750, callOI: 900, putOI: 600, callIV: 11.2, putIV: 12, callLTP: 62, putLTP: 280, callOIChange: -2, putOIChange: 4 },
        { strike: 24800, callOI: 700, putOI: 500, callIV: 11, putIV: 11.8, callLTP: 38, putLTP: 360, callOIChange: -1, putOIChange: 2 },
        { strike: 24850, callOI: 500, putOI: 400, callIV: 10.8, putIV: 11.6, callLTP: 20, putLTP: 440, callOIChange: 0, putOIChange: 1 },
        { strike: 24400, callOI: 800, putOI: 1100, callIV: 12.8, putIV: 13, callLTP: 480, putLTP: 28, callOIChange: 3, putOIChange: -6 },
        { strike: 24300, callOI: 600, putOI: 900, callIV: 13, putIV: 13.5, callLTP: 620, putLTP: 10, callOIChange: 1, putOIChange: -3 },
        { strike: 24200, callOI: 400, putOI: 700, callIV: 13.2, putIV: 14, callLTP: 780, putLTP: 4, callOIChange: 0, putOIChange: -1 },
      ],
      analytics: { pcr: 1.1, maxPain: 24600, atmIV: 12, ivPercentile: 40, oiSkew: 0.1, callOI: 1, putOI: 1 },
    };
    const out = buildStrategies(desk as never, { side: 'LONG', confidence: 72, agreement: 0.8, grade: 'ACTION' });
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s.orderTicket).toBeTruthy();
      expect(s.orderTicket!.legs.length).toBe(s.legs.length);
      for (const l of s.orderTicket!.legs) {
        // har limit price valid tick + LTP ke fill-friendly side pe
        expect(l.limit).toBeGreaterThan(0);
        expect(Math.round(l.limit * 20)).toBeCloseTo(l.limit * 20, 6);
      }
    }
  });
});
