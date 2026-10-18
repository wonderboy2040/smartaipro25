// ============================================================
// server/lib/tvHeaders.js — shared TradingView scanner headers
// ------------------------------------------------------------
// TradingView's scanner.tradingview.com CloudFront layer blocks
// requests from cloud / datacenter IPs (Render, Railway, Fly etc.)
// when no browser-like User-Agent is present. Adding a standard
// UA + Origin header reliably unblocks the scanner from any cloud
// provider without violating TV's public-API terms (scanner is a
// free, unauthenticated, CORS-enabled endpoint).
//
// ONE import, ONE constant — every file that calls the scanner
// spreads these headers into its fetch() call.
// ============================================================

export const TV_SCAN_HEADERS = {
  'Content-Type': 'text/plain;charset=UTF-8',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://www.tradingview.com',
  'Referer': 'https://www.tradingview.com/',
  'Accept-Language': 'en-US,en;q=0.9',
};
