// ============================================================
// test/cryptoPricesFilter.test.ts — v12.7 BANDWIDTH (recheck R2-#1)
// ------------------------------------------------------------
// /api/crypto-prices ?symbols= : the client's ~20-symbol watchlist used
// to re-download the FULL ~400-market ticker array (~300KB raw) every
// 30s. The server now slices the CACHED array to exactly the requested
// spot-INR bases (~8KB). This locks the filter's contract:
//   • exact-base slicing, case-insensitive, dedup'd
//   • no/empty/garbage param → FULL array (backward compatible)
//   • order preserved; unknown symbols match nothing; never throws
// ============================================================
import { describe, it, expect } from 'vitest';
import { filterTickersBySymbols } from '../server/lib/tickerFilter.js';

const mk = (market, last = '100') => ({ market, last_price: last, change_24_hour: '1.0', high: '110', low: '90', volume: '5' });
const FULL = [
  mk('BTCINR', '6100000'), mk('ETHINR', '150000'), mk('SOLINR', '14500'),
  mk('DOGECOININR'), mk('XRPINR'), ...Array.from({ length: 30 }, (_, i) => mk(`C${i}INR`)),
];

describe('lib/tickerFilter — v12.7 ?symbols= egress cut', () => {
  it('slices the full book to exactly the requested bases (the ~300KB→~8KB cut)', () => {
    const out = filterTickersBySymbols(FULL, 'BTC,SOL');
    expect(out).toHaveLength(2);
    expect(out.map(t => t.market)).toEqual(['BTCINR', 'SOLINR']);
    expect(out[0].last_price).toBe('6100000'); // the row itself untouched
  });

  it('case-insensitive + whitespace tolerant + duplicates collapse', () => {
    const out = filterTickersBySymbols(FULL, ' btc , SOL,btc ');
    expect(out.map(t => t.market)).toEqual(['BTCINR', 'SOLINR']);
  });

  it('no param → the FULL array (backward compatible, same reference)', () => {
    expect(filterTickersBySymbols(FULL, undefined)).toBe(FULL);
    expect(filterTickersBySymbols(FULL, null)).toBe(FULL);
    expect(filterTickersBySymbols(FULL, '')).toBe(FULL);
  });

  it('garbage param → honest full serve (never an empty array)', () => {
    expect(filterTickersBySymbols(FULL, ',,,')).toBe(FULL);
    expect(filterTickersBySymbols(FULL, '!!,,??')).toBe(FULL);
  });

  it('unknown symbols match nothing but never break the response', () => {
    const out = filterTickersBySymbols(FULL, 'BTC,UNKNOWN');
    expect(out.map(t => t.market)).toEqual(['BTCINR']);
    // a well-formed but absent base → empty slice (an honest miss, not an error)
    expect(filterTickersBySymbols(FULL, 'ZZZZZZ')).toEqual([]);
  });

  it('order is preserved (client keys off market, not position) and non-array input never throws', () => {
    const out = filterTickersBySymbols(FULL, 'XRP,ETH');
    expect(out.map(t => t.market)).toEqual(['ETHINR', 'XRPINR']); // FULL's order, not the param's
    expect(() => filterTickersBySymbols(null, 'BTC')).not.toThrow();
    expect(filterTickersBySymbols(null, 'BTC')).toEqual([]);
    expect(() => filterTickersBySymbols([{ weird: 'row' }], 'BTC')).not.toThrow();
  });
});
