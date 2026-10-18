// ============================================================
// test/circuitLimitGuard.test.ts — v11.1 GAP 2 REGRESSION SUITE
// ------------------------------------------------------------
// Locks the India-specific circuit-limit guard end-to-end:
//   1. circuitGuard pure math: proximity, same-direction ENTRY risk
//      (LONG→upper / SHORT→lower) with the exact reason flag, target
//      clamps, adverse-side classification for OPEN positions, and the
//      disarm-on-garbage rule.
//   2. Engine: analyzeIntradayFromScanner penalizes + flags + clamps
//      when the Groww quote carries the band; a normal band far away
//      leaves the signal byte-identical (no interference).
//   3. growwQuote: highPriceRange/lowPriceRange captured as
//      upperCircuit/lowerCircuit (same fetch, one more field).
//   4. paperCircuitWatch: open LONG drifting into the LOWER circuit
//      emits an URGENT CIRCUIT_RISK event once (10-min cooldown),
//      crypto/option trades ignored.
//   5. alerts: CIRCUIT_RISK renders the distinct urgent label.
// Hermetic — no network.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  circuitProximityOf, entryCircuitRisk, adverseCircuitRisk,
  circuitProximityPct, circuitEntryPenalty, circuitGuardConfig,
} from '../server/ai/circuitGuard.js';
import { analyzeIntradayFromScanner } from '../server/intraday/engine.js';

// ---- store + journal mocked so paper tests never touch disk ----
vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));

import { paperCircuitWatch, openPaperTrade, evaluatePaper, _resetForTests } from '../server/intraday/paperTrading.js';
import { dispatchOutcomeAlert } from '../server/intraday/alerts.js';
import * as growwQuote from '../server/ai/growwQuote.js';

const SAT_NOON_IST = new Date('2026-08-29T06:30:00Z'); // outside NSE session → pace == raw

beforeEach(() => {
  _resetForTests();
  growwQuote.__resetGrowwForTests();
  delete process.env.AI_CIRCUIT_PROXIMITY_PCT;
  delete process.env.AI_CIRCUIT_PENALTY;
});
afterEach(() => {
  delete process.env.AI_CIRCUIT_PROXIMITY_PCT;
  delete process.env.AI_CIRCUIT_PENALTY;
});

// ============================================================
// 1. pure guard math
// ============================================================
describe('circuitGuard — pure functions', () => {
  it('computes band proximity with exact distances (RELIANCE-style ±10% band)', () => {
    const prox = circuitProximityOf(1244.3, 1364, 1116); // prev close 1240 ±10%
    expect(prox).toBeTruthy();
    expect(prox!.upper).toBe(1364);
    expect(prox!.lower).toBe(1116);
    expect(prox!.distUpperPct).toBeCloseTo(9.63, 1);
    expect(prox!.distLowerPct).toBeCloseTo(10.28, 1);
    expect(prox!.nearUpper).toBe(false);
    expect(prox!.nearLower).toBe(false);
  });

  it('flags near-band at the 1.5% default threshold (env-tunable)', () => {
    expect(circuitProximityOf(1345, 1364, 1116)!.nearUpper).toBe(true);  // 1.41% below upper
    expect(circuitProximityOf(1340, 1364, 1116)!.nearUpper).toBe(false); // 1.79% below — outside
    expect(circuitProximityOf(1130, 1364, 1116)!.nearLower).toBe(true);  // 1.25% above lower
  });

  it('widens the threshold from AI_CIRCUIT_PROXIMITY_PCT', () => {
    process.env.AI_CIRCUIT_PROXIMITY_PCT = '5';
    expect(circuitProximityPct()).toBe(5);
    expect(circuitProximityOf(1300, 1364, 1116)!.nearUpper).toBe(true); // 4.9% below upper
    delete process.env.AI_CIRCUIT_PROXIMITY_PCT;
    expect(circuitProximityOf(1300, 1364, 1116)!.nearUpper).toBe(false);
  });

  it('disarms on missing / garbage bands (never invents a circuit)', () => {
    expect(circuitProximityOf(100, null, 90)).toBeNull();
    expect(circuitProximityOf(100, undefined, 90)).toBeNull();
    expect(circuitProximityOf(100, 90, 110)).toBeNull();        // inverted band
    expect(circuitProximityOf(50, 100, 90)).toBeNull();          // price wildly below band
    expect(circuitProximityOf(250, 110, 90)).toBeNull();        // price wildly above band
    expect(circuitProximityOf(null, 110, 90)).toBeNull();
  });

  it('same-direction ENTRY risk: LONG near/at upper → heavy penalty + the exact reason flag', () => {
    const r = entryCircuitRisk('LONG', 1350, 1364, 1116);
    expect(r.risk).toBe(true);
    expect(r.penalty).toBe(18); // default AI_CIRCUIT_PENALTY
    expect(r.reason).toMatch(/^⚠ Near upper circuit — entry risk/);
    expect(r.reason).toContain('1364');
    expect(r.clampLong).toEqual({ cap: 1364 });
    // frozen AT the band
    const at = entryCircuitRisk('LONG', 1364, 1364, 1116);
    expect(at.risk).toBe(true);
    expect(at.reason).toMatch(/^⚠ AT upper circuit ₹1364 — stock frozen/);
  });

  it('same-direction ENTRY risk: SHORT near lower → penalty + flag; opposite fades are NOT penalized', () => {
    const s = entryCircuitRisk('SHORT', 1130, 1364, 1116);
    expect(s.risk).toBe(true);
    expect(s.reason).toMatch(/^⚠ Near lower circuit — entry risk/);
    // a SHORT near the UPPER band is a fade FROM the band — allowed
    expect(entryCircuitRisk('SHORT', 1350, 1364, 1116).risk).toBe(false);
    // a LONG near the LOWER band is a fade FROM the band — allowed
    expect(entryCircuitRisk('LONG', 1130, 1364, 1116).risk).toBe(false);
  });

  it('no risk when the price sits mid-band (normal stock: no interference)', () => {
    const r = entryCircuitRisk('LONG', 1244, 1364, 1116);
    expect(r.risk).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.penalty).toBe(0);
  });

  it('penalty is env-tunable and bounded', () => {
    process.env.AI_CIRCUIT_PENALTY = '25';
    expect(circuitEntryPenalty()).toBe(25);
    process.env.AI_CIRCUIT_PENALTY = '999';
    expect(circuitEntryPenalty()).toBe(18); // bounded default
    expect(circuitGuardConfig().source).toContain('groww');
  });

  it('adverseCircuitRisk: LONG adverse = LOWER band, SHORT adverse = UPPER band, frozen detected', () => {
    const longNearLower = adverseCircuitRisk({ side: 'BUY' }, { price: 1130, upperCircuit: 1364, lowerCircuit: 1116 });
    expect(longNearLower!.adverse).toBe(true);
    expect(longNearLower!.band).toBe('LOWER');
    expect(longNearLower!.frozen).toBe(false);
    expect(longNearLower!.note).toContain('LOWER circuit');
    const longFrozen = adverseCircuitRisk({ side: 'LONG' }, { price: 1116, upperCircuit: 1364, lowerCircuit: 1116 });
    expect(longFrozen!.frozen).toBe(true);
    expect(longFrozen!.note).toContain('FROZEN');
    const shortNearUpper = adverseCircuitRisk({ side: 'SELL' }, { price: 1350, upperCircuit: 1364, lowerCircuit: 1116 });
    expect(shortNearUpper!.adverse).toBe(true);
    expect(shortNearUpper!.band).toBe('UPPER');
    // favorable-side proximity is NOT adverse
    const longNearUpper = adverseCircuitRisk({ side: 'LONG' }, { price: 1350, upperCircuit: 1364, lowerCircuit: 1116 });
    expect(longNearUpper!.adverse).toBe(false);
    // no bands / garbage side → null (guard inert)
    expect(adverseCircuitRisk({ side: 'LONG' }, { price: 100 })).toBeNull();
    expect(adverseCircuitRisk({ side: 'FLAT' }, { price: 100, upperCircuit: 110, lowerCircuit: 90 })).toBeNull();
  });
});

// ============================================================
// 2. engine integration
// ============================================================
describe('analyzeIntradayFromScanner — circuit entry guard', () => {
  const bullTv = {
    close: 812, open: 800, high: 816, low: 795, volume: 5e6, change: 1.5,
    ema10: 810, ema20: 805, sma20: 802, sma50: 790,
    rsi: 61, macd: 2.5, macdSignal: 1.5,
    atr: 10, vwap: 806,
    adx: 27, adxPlus: 25, adxMinus: 10,
    relVolume: 1.8, pivotMiddle: 806, pivotS1: 798, pivotR1: 814,
    recommend: 1, last: 812, exchange: 'NSE',
  };
  const baseGroww = { price: 812, change: 1.5, high: 816, low: 795, volume: 5e6, prevClose: 800 };

  it('LONG near the upper circuit: heavy confidence penalty + the reason flag + targets clamped below the band', () => {
    const normal = analyzeIntradayFromScanner('XYZ', bullTv, baseGroww, { now: SAT_NOON_IST });
    // a tight +1% band above price → near-upper for the LONG signal
    const nearBand = analyzeIntradayFromScanner('XYZ', bullTv, { ...baseGroww, price: 812, upperCircuit: 820, lowerCircuit: 790 }, { now: SAT_NOON_IST });
    expect(normal).toBeTruthy();
    expect(nearBand).toBeTruthy();
    expect(nearBand!.direction).toBe('LONG');
    expect(nearBand!.nearCircuit).toBe(true);
    expect(nearBand!.circuitRisk).toBeTruthy();
    expect(nearBand!.circuitRisk!.band).toBe('UPPER');
    // penalty applied (default 18) with the exact flag in the reasons list
    expect(normal!.quantConfidence - nearBand!.quantConfidence).toBeGreaterThanOrEqual(18);
    expect(nearBand!.reasons.some((r: string) => r.startsWith('⚠ Near upper circuit — entry risk'))).toBe(true);
    expect(normal!.reasons.some((r: string) => r.includes('circuit'))).toBe(false);
    // targets physically clamped: cannot exceed the upper band
    expect(nearBand!.target1).toBeLessThanOrEqual(820);
    expect(nearBand!.target2).toBeLessThanOrEqual(820);
  });

  it('a normal wide band leaves the signal byte-identical (no interference, bands still exposed)', () => {
    const without = analyzeIntradayFromScanner('XYZ', bullTv, baseGroww, { now: SAT_NOON_IST });
    const withFarBand = analyzeIntradayFromScanner('XYZ', bullTv, { ...baseGroww, upperCircuit: 893, lowerCircuit: 731 }, { now: SAT_NOON_IST });
    expect(withFarBand!.quantConfidence).toBe(without!.quantConfidence);
    expect(withFarBand!.nearCircuit).toBe(false);
    expect(withFarBand!.circuitRisk).toBeTruthy(); // band known, mid-band
    expect(withFarBand!.circuitRisk!.band).toBeNull();
    expect(without!.circuitRisk).toBeNull();       // no band on the quote → guard inert
  });

  it('crypto market never arms the guard (no circuits on 24/7 spot pairs)', () => {
    const s = analyzeIntradayFromScanner('BTC', { ...bullTv, exchange: 'BINANCE' }, { price: 812, change: 1.5, high: 816, low: 795, volume: 5e6, prevClose: 800, upperCircuit: 820, lowerCircuit: 790 }, { now: SAT_NOON_IST, market: 'CRYPTO' });
    expect(s).toBeTruthy();
    expect((s as any).nearCircuit).toBe(false);
    expect((s as any).circuitRisk).toBeNull();
  });
});

// ============================================================
// 3. growwQuote band capture
// ============================================================
describe('growwQuote — circuit band capture (same fetch, two more fields)', () => {
  it('highPriceRange/lowPriceRange become upperCircuit/lowerCircuit', async () => {
    growwQuote._setGrowwFetchForTest(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ltp: 1244.3, dayChange: 4.3, dayChangePerc: 0.35,
        high: 1253.4, low: 1242.8, volume: 1134834,
        highPriceRange: 1364, lowPriceRange: 1116,
        lastTradeTime: Math.floor(Date.now() / 1000),
      }),
    })) as any);
    const q = await growwQuote.fetchGrowwNseQuote('RELIANCE');
    expect(q).toBeTruthy();
    expect(q!.upperCircuit).toBe(1364);
    expect(q!.lowerCircuit).toBe(1116);
    expect(q!.source).toBe('groww-nse-realtime');
  });

  it('absent / garbage band fields degrade honestly (fields simply omitted)', async () => {
    growwQuote._setGrowwFetchForTest(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ltp: 100, dayChange: 1, dayChangePerc: 1, high: 101, low: 99, volume: 1,
        highPriceRange: null, lowPriceRange: 'x',
        lastTradeTime: Math.floor(Date.now() / 1000),
      }),
    })) as any);
    const q = await growwQuote.fetchGrowwNseQuote('ABC');
    expect(q).toBeTruthy();
    expect(q!.upperCircuit).toBeUndefined();
    expect(q!.lowerCircuit).toBeUndefined();
  });
});

// ============================================================
// 4. paperCircuitWatch — the urgent adverse-circuit event
// ============================================================
describe('paperCircuitWatch — open paper positions', () => {
  it('a LONG drifting into the LOWER circuit emits CIRCUIT_RISK once (10-min cooldown)', () => {
    const open = openPaperTrade({
      symbol: 'XYZ', direction: 'LONG', entry: 100, qty: 10,
      stopLoss: 92, target1: 108, target2: 112, market: 'INDIA',
    });
    expect(open.ok).toBe(true);
    const events: any[] = [];
    const quotes = { XYZ: { price: 91.5, upperCircuit: 110, lowerCircuit: 91 } }; // 0.55% above the lower freeze
    expect(paperCircuitWatch(quotes, events)).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('CIRCUIT_RISK');
    expect(events[0].symbol).toBe('XYZ');
    expect(events[0].band).toBe('LOWER');
    expect(events[0].note).toContain('exit liquidity');
    // cooldown: second watch call within 10 min → no repeat
    const events2: any[] = [];
    expect(paperCircuitWatch(quotes, events2)).toBe(0);
    expect(events2.length).toBe(0);
    // per-symbol cooldown independence: another symbol's adverse circuit alerts on the same call
    openPaperTrade({ symbol: 'ABC', direction: 'SHORT', entry: 100, qty: 5, stopLoss: 106, target1: 94, target2: 90, market: 'INDIA' });
    const events3: any[] = [];
    expect(paperCircuitWatch({ ...quotes, ABC: { price: 109.5, upperCircuit: 110, lowerCircuit: 90 } }, events3)).toBe(1);
    expect(events3[0].symbol).toBe('ABC');
    expect(events3[0].band).toBe('UPPER');
  });

  it('ignores crypto trades and option premium trades (no equity band semantics)', () => {
    const a = openPaperTrade({ symbol: 'BTC', direction: 'LONG', entry: 5000000, qty: 0.01, stopLoss: 4800000, target1: 5300000, target2: 5500000, market: 'CRYPTO' });
    const b = openPaperTrade({
      symbol: 'NIFTY24400CE', direction: 'LONG', entry: 86.5, qty: 1,
      stopLoss: 77, target1: 110, target2: 130, market: 'INDIA',
      assetKind: 'OPTION', underlying: 'NIFTY', strike: 24400, optType: 'CE',
      expiry: '2026-09-22', iv: 13, lotSize: 75, label: 'Nifty50 22Sep 24400 CE',
    });
    expect(a.ok && b.ok).toBe(true);
    const events: any[] = [];
    const quotes = {
      BTC: { price: 4800001, upperCircuit: 5500000, lowerCircuit: 4700000 },
      NIFTY24400CE: { price: 77.5, upperCircuit: 120, lowerCircuit: 76 },
    };
    expect(paperCircuitWatch(quotes, events)).toBe(0);
    expect(events.length).toBe(0);
  });

  it('a mid-band position generates no event (no interference)', () => {
    openPaperTrade({ symbol: 'XYZ', direction: 'LONG', entry: 100, qty: 10, stopLoss: 92, target1: 108, target2: 112, market: 'INDIA' });
    const events: any[] = [];
    expect(paperCircuitWatch({ XYZ: { price: 101, upperCircuit: 110, lowerCircuit: 90 } }, events)).toBe(0);
    expect(events.length).toBe(0);
  });
});

// ============================================================
// 5. alerts — the distinct urgent CIRCUIT_RISK label
// ============================================================
describe('dispatchOutcomeAlert — CIRCUIT_RISK urgent alert', () => {
  it('renders the circuit label (never an SL-approach framing) and skips P&L lines', async () => {
    const sendTelegramRaw = vi.fn(async () => true);
    const ok = await dispatchOutcomeAlert({
      type: 'CIRCUIT_RISK', symbol: 'XYZ', direction: 'LONG',
      price: 91.5, band: 'LOWER', frozen: false, distPct: 0.55,
      note: 'LOWER circuit ₹91 sirf 0.6% door hai — exit liquidity sook rahi hai.',
    }, { sendTelegramRaw, escapeHtml: (x: string) => x });
    expect(ok).toBe(true);
    const msg = String(sendTelegramRaw.mock.calls[0][0]);
    expect(msg).toContain('🚨');
    expect(msg).toContain('CIRCUIT-LIMIT RISK');
    expect(msg).not.toContain('STOP LOSS HIT');
    expect(msg).toContain('LOWER circuit');
    expect(msg).not.toContain('P&L');
  });

  it('PAPER_CLOSE events show the NET (post-cost) P&L as headline with gross secondary', async () => {
    const sendTelegramRaw = vi.fn(async () => true);
    await dispatchOutcomeAlert({
      type: 'PAPER_CLOSE', symbol: 'XYZ', price: 108, pnl: 80, pnlNet: 17.27,
      note: 'Paper trade T2 hit',
    }, { sendTelegramRaw, escapeHtml: (x: string) => x });
    const msg = String(sendTelegramRaw.mock.calls[0][0]);
    expect(msg).toContain('net of costs');
    expect(msg).toContain('17.27');
    expect(msg).toContain('80.00'); // gross stays visible
  });
});
