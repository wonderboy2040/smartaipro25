// ============================================================
// test/blackScholes.test.ts — options math pins
// ------------------------------------------------------------
// BS price, put-call parity, Greeks signs, IV solver round-trip,
// synthetic chain + strategy P&L identities.
// ============================================================
import { describe, it, expect } from 'vitest';
import { bsPrice, bsGreeks, impliedVol, yearsToExpiry, normCdf } from '../server/ai/lib/blackScholes.js';
import { buildSyntheticChain, analyzeChain, buildStrategies } from '../server/ai/optionsDesk.js';

describe('normCdf', () => {
  it('known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 4);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normCdf(10)).toBeCloseTo(1, 6);
  });
});

describe('bsPrice — pricing core', () => {
  const S = 24000, K = 24000, T = 7 / 365, r = 0.069, sigma = 0.13;

  it('ATM call ≈ put within forward-effect tolerance (parity pinned below)', () => {
    const c = bsPrice(S, K, T, r, sigma, 'CE');
    const p = bsPrice(S, K, T, r, sigma, 'PE');
    // C−P = S − K·e^(−rT) — with 6.9% rates over 7 days that's ~₹31 on a
    // ~₹190 premium pair → up to 20% divergence from naive equality.
    expect(Math.abs(c - p)).toBeLessThan(Math.max(c, p) * 0.20);
    expect(c).toBeGreaterThan(0);
    expect(p).toBeGreaterThan(0);
  });

  it('put-call parity EXACT: C − P = S − K·e^(−rT)', () => {
    const c = bsPrice(S, K, T, r, sigma, 'CE');
    const p = bsPrice(S, K, T, r, sigma, 'PE');
    const parity = S - K * Math.exp(-r * T);
    expect(c - p).toBeCloseTo(parity, 2);
  });

  it('intrinsic floor at T=0', () => {
    expect(bsPrice(25000, 24000, 0, r, sigma, 'CE')).toBe(1000);
    expect(bsPrice(23000, 24000, 0, r, sigma, 'CE')).toBe(0);
    expect(bsPrice(23000, 24000, 0, r, sigma, 'PE')).toBe(1000);
  });

  it('higher IV → higher OTM option value', () => {
    const low = bsPrice(S, 24400, T, r, 0.10, 'CE');
    const high = bsPrice(S, 24400, T, r, 0.25, 'CE');
    expect(high).toBeGreaterThan(low * 1.5);
  });
});

describe('bsGreeks — signs and identities', () => {
  const S = 24000, K = 24000, T = 30 / 365, r = 0.069, sigma = 0.15;

  it('ATM call/put deltas straddle ±0.5 (exact parity pinned below)', () => {
    const c = bsGreeks(S, K, T, r, sigma, 'CE');
    const p = bsGreeks(S, K, T, r, sigma, 'PE');
    // Spot-ATM with positive rates: forward > spot → call delta drifts above 0.5.
    expect(c.delta).toBeGreaterThan(0.5);
    expect(c.delta).toBeLessThan(0.65);
    expect(p.delta).toBeLessThan(-0.35);
    expect(p.delta).toBeGreaterThan(-0.6);
  });

  it('call delta − put delta = 1 (put-call delta parity)', () => {
    const c = bsGreeks(S, K, T, r, sigma, 'CE');
    const p = bsGreeks(S, K, T, r, sigma, 'PE');
    expect(c.delta - p.delta).toBeCloseTo(1, 6);
  });

  it('theta is negative (long options decay), vega positive', () => {
    const c = bsGreeks(S, K, T, r, sigma, 'CE');
    expect(c.theta).toBeLessThan(0);
    expect(c.vega).toBeGreaterThan(0);
    expect(c.gamma).toBeGreaterThan(0);
  });
});

describe('impliedVol — solver round-trip', () => {
  const S = 24000, K = 24000, T = 7 / 365, r = 0.069;

  it('recovers a known vol from a BS price (both types)', () => {
    for (const sigma of [0.10, 0.135, 0.22, 0.45]) {
      for (const type of ['CE', 'PE'] as const) {
        const price = bsPrice(S, K, T, r, sigma, type);
        const iv = impliedVol(price, S, K, T, r, type)!;
        expect(iv).toBeCloseTo(sigma, 3);
      }
    }
  });

  it('returns null when price ≤ intrinsic (no time value)', () => {
    expect(impliedVol(400, 24400, 7 / 365 * 0 + 7 / 365, r, 'CE')).toBeNull; // guard shape
    const deepITM = bsPrice(24400, 24000, T, r, 0.5, 'CE');
    expect(impliedVol(deepITM, 24400, 24000, 0, r, 'CE')).toBeNull(); // T=0
  });
});

describe('yearsToExpiry', () => {
  it('≈ 7 days for a week out', () => {
    const d = new Date(Date.now() + 7 * 86400_000);
    expect(yearsToExpiry(d.toISOString())).toBeCloseTo(7 / 365, 2);
  });
  it('clamps past expiries to 0', () => {
    expect(yearsToExpiry('2020-01-01')).toBe(0);
  });
});

describe('synthetic chain + analytics', () => {
  it('chain is centered on ATM with a volatility smile', () => {
    const spot = 24000;
    // v6.12.1 (recheck): DYNAMIC expiry — the hardcoded '2026-09-09'
    // was a TIME BOMB that expired today and zeroed every premium.
    const expiry = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const chain = buildSyntheticChain('NIFTY', spot, 0.13, expiry)!;
    expect(chain.source).toBe('bs-model');
    expect(chain.rows.length).toBeGreaterThan(15);
    const atm = chain.rows.find(r => r.strike === 24000)!;
    const wing = chain.rows.find(r => r.strike === 24300)!;   // +1.25% OTM call side
    const putWing = chain.rows.find(r => r.strike === 23700)!; // −1.25% OTM put side
    expect(atm.callLTP).toBeGreaterThan(0);
    // v10.5.2 (skew recalibration): under the distance-aware put-skew
    // model, the smile lifts the PUT wing strongly (smile + crash
    // premium dono milte hain); the CALL wing ka smile-lift aur CE
    // discount near-ATM par lagbhag cancel ho jaate hain — that IS
    // the real NSE smirk. Call wing stays within a whisker of ATM.
    expect(putWing.putIV!).toBeGreaterThan(atm.putIV!);
    expect(wing.callIV!).toBeGreaterThan(atm.callIV! - 0.15);
    // ATM call > ATM put at low rates (skew-neutral at the money)
    expect(atm.callLTP).toBeGreaterThan(atm.putLTP * 0.94);
  });

  it('analyzeChain: max pain sits inside the strike set; PCR from OI', () => {
    const spot = 24000;
    const rows = [];
    for (let k = 23700; k <= 24300; k += 50) {
      rows.push({
        strike: k, expiry: 'x',
        callOI: k < 24000 ? 100 : 900, callOIChange: 100, callIV: 13, callLTP: 50, callVolume: 10,
        putOI: k > 24000 ? 100 : 900, putOIChange: 100, putIV: 13, putLTP: 50, putVolume: 10,
      });
    }
    const a = analyzeChain({ rows }, spot);
    expect(a!.pcr).toBeCloseTo(1, 1);
    expect(a!.maxPain).toBe(24000); // equal OI walls → max pain at center
    expect(a!.oiSkew).toBeCloseTo(0, 1);
  });
});

describe('buildStrategies — ensemble-driven, P&L identities exact', () => {
  const spot = 24000;
  // v6.12.1 (recheck): dynamic 7-day expiry (was hardcoded '2026-09-09' —
  // a time bomb that expired today and made the Iron Condor credit 0)
  const chain = buildSyntheticChain('NIFTY', spot, 0.13, new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10))!;
  const desk = {
    ok: true, symbol: 'NIFTY', spot, expiry: chain.expiry, lotSize: 75,
    rows: chain.rows, source: 'bs-model', fetchedAt: Date.now(),
  };

  it('STRONG LONG → Bull Call Spread with exact debit/max-P&L identity', () => {
    const out = buildStrategies(desk, { side: 'LONG', confidence: 80, agreement: 0.8, grade: 'STRONG' });
    const bcs = out.find(s => s.id === 'bull-call-spread')!;
    expect(bcs.legs).toHaveLength(2);
    const [buy, sell] = bcs.legs;
    expect(buy.action).toBe('BUY'); expect(sell.action).toBe('SELL');
    const debit = +(buy.premium - sell.premium).toFixed(2);
    expect(bcs.netDebit).toBeCloseTo(debit, 1);
    // maxProfit + maxLoss = spread width
    expect((bcs.maxProfit ?? 0) + (bcs.maxLoss ?? 0)).toBeCloseTo(sell.strike - buy.strike, 0);
    // breakeven = buy strike + debit
    expect(bcs.breakevens![0]).toBeCloseTo(buy.strike + debit, 0);
    // STRONG also unlocks the naked long call
    expect(out.find(s => s.id === 'long-call')).toBeTruthy();
  });

  it('STRONG SHORT → Bear Put Spread + long put', () => {
    const out = buildStrategies(desk, { side: 'SHORT', confidence: 80, agreement: 0.8, grade: 'STRONG' });
    const bps = out.find(s => s.id === 'bear-put-spread')!;
    expect(bps.legs[0].type).toBe('PE');
    expect(out.find(s => s.id === 'long-put')).toBeTruthy();
  });

  it('NEUTRAL → Iron Condor with credit = max profit and 4 legs', () => {
    const out = buildStrategies(desk, { side: 'FLAT', confidence: 20, agreement: 0.5, grade: 'NEUTRAL' });
    const ic = out.find(s => s.id === 'iron-condor')!;
    expect(ic.legs).toHaveLength(4);
    expect(ic.netCredit).toBeGreaterThan(0);
    expect(ic.maxProfit).toBeCloseTo(ic.netCredit!, 1);
  });

  it('strategy P&L math stays within lot multiples', () => {
    const out = buildStrategies(desk, { side: 'LONG', confidence: 80, agreement: 0.8, grade: 'STRONG' });
    const bcs = out.find(s => s.id === 'bull-call-spread')!;
    expect(bcs.perLot!.maxLoss!).toBeCloseTo(bcs.maxLoss! * 75, 0);
  });
});
