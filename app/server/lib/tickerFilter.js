// ============================================================
// lib/tickerFilter — v12.7 BANDWIDTH: /api/crypto-prices ?symbols=
// ------------------------------------------------------------
// The client used to download the FULL ~400-market CoinDCX ticker
// array (~300KB raw, ~50KB gz) every 30s while reading only its own
// ~20-symbol watchlist — the single biggest pure-EGRESS lever on the
// Render free tier (recheck R2-#1). This filter slices the CACHED
// server-side array to exactly the requested spot-INR bases (~8KB).
//
// Contract:
//   • no / empty / garbage param → the FULL array (backward compatible
//     for tests, tools, and any legacy consumer)
//   • `symbols=BTC,SOL` → only rows whose `market` is `<BASE>INR` for
//     a requested base (case-insensitive, 2-10 alphanumerics)
//   • duplicates collapse; unknown symbols simply match nothing
//   • row order preserved (the client keys off market, not position)
// ============================================================

/** Slice a CoinDCX ticker array to the requested spot-INR bases. */
export function filterTickersBySymbols(tickers, symbolsParam) {
  const arr = Array.isArray(tickers) ? tickers : [];
  if (!symbolsParam) return arr;
  const wanted = new Set(String(symbolsParam)
    .split(',')
    .map(s => String(s || '').trim().toUpperCase())
    .filter(s => /^[A-Z0-9]{2,10}$/.test(s)));
  if (wanted.size === 0) return arr; // garbage param → honest full serve
  const out = [];
  for (const t of arr) {
    const m = String(t?.market || ''); // spot INR pairs look like "BTCINR"
    const base = m.endsWith('INR') ? m.slice(0, -3) : '';
    if (base && wanted.has(base)) out.push(t);
  }
  return out;
}
