// ============================================================
// test/instrumentCase2126.test.ts — v21.26.6 PAIR-CASE REGRESSION
// ------------------------------------------------------------
// LIVE INCIDENT (2026-10-29): the BNB auto trade qualified every gate but
// died with "Quantity 0 below exchange min (2) for B-BNB_USDT — requires
// ~151.2 USDT margin at 10x" on a ~10 USDT wallet.
//
// ROOT CAUSE: CoinDCX's /derivatives/futures/data/instrument endpoint is
// CASE-SENSITIVE. `pair=b-bnb_usdt` (lowercase) silently returns the DEFAULT
// instrument — live-verified B-LAB_USDT (min_quantity 1, quantity_increment
// 1). Every perp then inherited LAB's 0-dp precision + min-qty, so BNB/ETH/
// SOL/BTC quantities floored to 0 and the order was rejected. Uppercase
// `pair=B-BNB_USDT` returns the REAL row (min_quantity 0.01 / increment 0.01).
//
// This locks the fix: the instrument URL must carry the UPPERCASE pair and
// the returned meta must be the requested symbol's real row (never B-LAB).
// Hermetic: global fetch is mocked; no network.
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';

const REAL = {
  BNB: { pair: 'B-BNB_USDT', min_quantity: 0.01, quantity_increment: 0.01, quantity_precision: 2, max_leverage_long: 10 },
  XRP: { pair: 'B-XRP_USDT', min_quantity: 0.1, quantity_increment: 0.1, quantity_precision: 1, max_leverage_long: 10 },
  LAB: { pair: 'B-LAB_USDT', min_quantity: 1, quantity_increment: 1, quantity_precision: 0, max_leverage_long: 10 },
};

function instrumentResponse(pair) {
  const key = String(pair || '').toUpperCase().replace(/^B-/, '').replace(/_USDT$/, '');
  const row = REAL[key] || REAL.LAB; // lowercase requests get the LAB default
  return { instrument: row };
}

describe('v21.26.6 instrument pair-case', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests the UPPERCASE pair so CoinDCX returns the real instrument (never the LAB default)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      calls.push(u);
      const m = /[?&]pair=([^&]+)/.exec(u);
      const pair = m ? decodeURIComponent(m[1]) : '';
      // Mirror the live endpoint: lowercase names resolve to the LAB default.
      const real = /^B-[A-Z0-9]+_USDT$/.test(pair) ? pair : 'B-LAB_USDT';
      return {
        ok: true, status: 200,
        json: async () => instrumentResponse(real),
      };
    }));

    const { fetchFuturesInstrumentMeta } = await import('../server/ai/futures.js');
    const meta = await fetchFuturesInstrumentMeta('B-BNB_USDT');

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain('pair=B-BNB_USDT');
    expect(calls[0]).not.toContain('pair=b-bnb_usdt');
    expect(meta?.minQty).toBeCloseTo(0.01, 8);
    expect(meta?.qtyPrecision).toBe(2);
    expect(meta?.pair).toBe('B-BNB_USDT');
  });

  it('a lowercase caller request is still normalized to uppercase before the network call', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      calls.push(u);
      const m = /[?&]pair=([^&]+)/.exec(u);
      const pair = m ? decodeURIComponent(m[1]) : '';
      const real = /^B-[A-Z0-9]+_USDT$/.test(pair) ? pair : 'B-LAB_USDT';
      return { ok: true, status: 200, json: async () => instrumentResponse(real) };
    }));

    const { fetchFuturesInstrumentMeta } = await import('../server/ai/futures.js');
    const meta = await fetchFuturesInstrumentMeta('b-xrp_usdt');

    expect(calls[0]).toContain('pair=B-XRP_USDT');
    expect(meta?.minQty).toBeCloseTo(0.1, 8);
    expect(meta?.pair).toBe('B-XRP_USDT');
  });
});
