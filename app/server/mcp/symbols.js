// ============================================================
// server/mcp/symbols.js — exchange-symbol resolution for INDMoney holdings
// ------------------------------------------------------------
// INDMoney's MCP payload identifies holdings by NAME (and internal
// codes like INDS33035 / ISINs). To drive REAL-TIME prices in the
// SmartAI frontend we need tradeable symbols:
//   • India stocks/ETFs → NSE symbol   (Groww search v1, verified live)
//   • US stocks         → US ticker    (TradingView america scanner
//                                       description-equal filter, verified
//                                       live; + static mega-cap map)
//   • Crypto            → BTC/ETH/…    (static name map — the frontend
//                                       CoinDCX/Binance pollers use these)
// Mutual funds / FDs / bonds / EPF / NPS etc. have no live exchange
// price — they resolve to `noLive` and keep INDMoney's own unit price
// (NAV), refreshed on every portfolio sync.
//
// All remote lookups are cached in server/data/mcp-symbol-cache.json
// (name→symbol mappings are stable; cache TTL is generous).
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from './durable.js';

const SYMBOL_CACHE_FILE = 'mcp-symbol-cache.json';
const SYMBOL_CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days (hits)
const MISS_CACHE_TTL = 36 * 60 * 60 * 1000;        // 36h (misses — retry sooner)
const LOOKUP_TIMEOUT = 6000;
const VERIFY_TIMEOUT = 5000;
const GROWW_SEARCH = 'https://groww.in/v1/api/search/v1/entity';
const TV_AMERICA_SCAN = 'https://scanner.tradingview.com/america/scan';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';

// ---------------- crypto name → exchange-agnostic symbol ----------------
// Frontend crypto pollers quote these against INR (CoinDCX) / USDT (Binance).
const CRYPTO_MAP = new Map(Object.entries({
  'bitcoin': 'BTC', 'btc': 'BTC', 'ethereum': 'ETH', 'ether': 'ETH', 'eth': 'ETH',
  'binance coin': 'BNB', 'bnb': 'BNB', 'binancecoin': 'BNB',
  'solana': 'SOL', 'sol': 'SOL', 'xrp': 'XRP', 'ripple': 'XRP',
  'cardano': 'ADA', 'ada': 'ADA', 'dogecoin': 'DOGE', 'doge': 'DOGE',
  'polkadot': 'DOT', 'dot': 'DOT', 'chainlink': 'LINK', 'link': 'LINK',
  'litecoin': 'LTC', 'ltc': 'LTC', 'avalanche': 'AVAX', 'avax': 'AVAX',
  'shiba inu': 'SHIB', 'shib': 'SHIB', 'shibainu': 'SHIB',
  'polygon': 'MATIC', 'matic': 'MATIC', 'uniswap': 'UNI', 'uni': 'UNI',
  'tether': 'USDT', 'usdt': 'USDT', 'usd coin': 'USDC', 'usdc': 'USDC',
  'wrapped bitcoin': 'WBTC', 'wbtc': 'WBTC', 'bitcoin cash': 'BCH', 'bch': 'BCH',
  'stellar': 'XLM', 'xlm': 'XLM', 'monero': 'XMR', 'xmr': 'XMR',
  'eos': 'EOS', 'tron': 'TRX', 'trx': 'TRX', 'cosmos': 'ATOM', 'atom': 'ATOM',
  'filecoin': 'FIL', 'fil': 'FIL', 'internet computer': 'ICP', 'icp': 'ICP',
  'near protocol': 'NEAR', 'near': 'NEAR', 'aptos': 'APT', 'apt': 'APT',
  'arbitrum': 'ARB', 'arb': 'ARB', 'optimism': 'OP', 'pepe': 'PEPE',
  'the graph': 'GRT', 'grt': 'GRT', 'aave': 'AAVE', 'maker': 'MKR',
  'injective': 'INJ', 'inj': 'INJ', 'sui': 'SUI', 'toncoin': 'TON',
}));

// ---------------- static US name → ticker map (fallback tier) ----------------
// Used when INDMoney's payload carries no usable ticker and before the
// remote search tiers. Name keys are lowercase normalized full names.
const US_NAME_MAP = new Map(Object.entries({
  'apple': 'AAPL', 'apple inc': 'AAPL', 'microsoft': 'MSFT', 'microsoft corp': 'MSFT',
  'alphabet': 'GOOGL', 'google': 'GOOGL', 'alphabet inc': 'GOOGL', 'amazon': 'AMZN',
  'amazon com inc': 'AMZN', 'meta platforms': 'META', 'meta': 'META', 'facebook': 'META',
  'nvidia': 'NVDA', 'nvidia corp': 'NVDA', 'tesla': 'TSLA', 'tesla inc': 'TSLA',
  'netflix': 'NFLX', 'netflix inc': 'NFLX', 'intel': 'INTC', 'intel corp': 'INTC',
  'amd': 'AMD', 'advanced micro devices': 'AMD', 'qualcomm': 'QCOM',
  'broadcom': 'AVGO', 'salesforce': 'CRM', 'oracle': 'ORCL', 'adobe': 'ADBE',
  'cisco': 'CSCO', 'ibm': 'IBM', 'international business machines': 'IBM',
  'johnson & johnson': 'JNJ', 'johnson and johnson': 'JNJ', 'jpmorgan chase': 'JPM',
  'jpmorgan': 'JPM', 'visa': 'V', 'mastercard': 'MA', 'walmart': 'WMT',
  'wells fargo': 'WFC', 'bank of america': 'BAC', 'goldman sachs': 'GS',
  'morgan stanley': 'MS', 'coca cola': 'KO', 'coca-cola': 'KO', 'pepsico': 'PEP',
  'mcdonald': 'MCD', 'mcdonalds': 'MCD', 'starbucks': 'SBUX', 'nike': 'NKE',
  'disney': 'DIS', 'walt disney': 'DIS', 'boeing': 'BA', 'lockheed martin': 'LMT',
  'exxon mobil': 'XOM', 'exxonmobil': 'XOM', 'chevron': 'CVX', 'pfizer': 'PFE',
  'merck': 'MRK', 'abbvie': 'ABBV', 'eli lilly': 'LLY', 'unitedhealth': 'UNH',
  'verizon': 'VZ', 'at&t': 'T', 'comcast': 'CMCSA', 'paypal': 'PYPL',
  'uber': 'UBER', 'airbnb': 'ABNB', 'shopify': 'SHOP', 'snowflake': 'SNOW',
  'palantir': 'PLTR', 'crowdstrike': 'CRWD', 'cloudflare': 'NET',
  'micron': 'MU', 'micron technology': 'MU', 'micron technology inc': 'MU',
  'spacex': 'SPCX', 'space x': 'SPCX', 'space exploration technologies': 'SPCX',
  'space exploration technologies corp': 'SPCX',
  'texas instruments': 'TXN', 'applied materials': 'AMAT', 'lam research': 'LRCX',
  'kla corp': 'KLAC', 'kla': 'KLAC', 'analog devices': 'ADI', 'marvell': 'MRVL',
  'marvell technology': 'MRVL', 'western digital': 'WDC', 'seagate': 'STX',
  'asml': 'ASML', 'asml holding': 'ASML', 'tsmc': 'TSM', 'taiwan semiconductor': 'TSM',
  'arm holdings': 'ARM', 'ast labs': 'ASTS', 'rocket lab': 'RKLB',
  'ast space mobile': 'ASTS', 'planet labs': 'PL', 'blackrock': 'BLK',
  'charles schwab': 'SCHW',
  'robinhood': 'HOOD', 'coinbase': 'COIN', 'microstrategy': 'MSTR',
  'block inc': 'SQ', 'square': 'SQ', 'spotify': 'SPOT', 'roblox': 'RBLX',
  'unity software': 'U', 'duolingo': 'DUOL', 'rivian': 'RIVN', 'lucid': 'LCID',
  'lucid motors': 'LCID', 'polestar': 'PSNY', 'joby aviation': 'JOBY', 'archer aviation': 'ACHR',
  'intuitive machines': 'LUNR',
  'coreweave': 'CRWV', 'tempus ai': 'TEM', 'servicenow': 'NOW',
  'workday': 'WDAY', 'snowflake inc': 'SNOW', 'atlassian': 'TEAM',
  'zscaler': 'ZS', 'okta': 'OKTA', 'sentinelone': 'S', 'fortinet': 'FTNT',
  't-mobile': 'TMUS', 'tmobile us': 'TMUS', 'verizon communications': 'VZ',
  'honeywell': 'HON', 'caterpillar': 'CAT', 'deere': 'DE', '3m': 'MMM',
  'philips': 'PHG', 'siemens': 'SIEGY', 'toyota': 'TM',
  'spdr s&p 500 etf trust': 'SPY', 'vanguard s&p 500 etf': 'VOO',
  'invesco qqq trust': 'QQQ', 'ishares core s&p 500 etf': 'IVV',
  'financial select sector spdr fund': 'XLF', 'energy select sector spdr fund': 'XLE',
  'smh etf': 'SMH', 'vaneck semiconductor etf': 'SMH', 'vanEck semiconductor ETF': 'SMH',
  'vanguard total stock market etf': 'VTI',
  'ark innovation etf': 'ARKK', 'vanguard growth etf': 'VUG',
  'vanguard information technology etf': 'VGT', 'brown advisory sustainable growth': 'BASGX',
  'ishares msci india etf': 'INDA', 'ishares russell 2000 etf': 'IWM',
  'spdr gold shares': 'GLD', 'ishares gold trust': 'IAU',
  'procure space etf': 'UFO', 'ark next generation internet etf': 'ARKW',
  'global x robotics etf': 'BOTZ', 'first trust cloud computing etf': 'SKYY',
  'invesco solar etf': 'TAN', 'ark genomic revolution etf': 'ARKG',
  'jefferies': 'JEF', 'linde': 'LIN', 'amgen': 'AMGN', 'gilead': 'GILD',
  'regeneron': 'REGN', 'vertex': 'VRTX', 'moderna': 'MRNA', 'novavax': 'NVAX',
  'anthem': 'ELV', 'elevance health': 'ELV', 'cigna': 'CI', 'humana': 'HUM',
  'booking holdings': 'BKNG', 'expedia': 'EXPE',
}));

// NSE symbol shape: 2-20 chars, letters/digits/-& (e.g. M&M, BSE-A).
const NSE_SYM_RE = /^[A-Z0-9][A-Z0-9&-]{1,19}$/;
// US ticker shape: 1-5 letters (occasionally with . or - for share classes).
const US_TICKER_RE = /^[A-Z][A-Z.-]{0,5}$/;

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9&\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------- persistent name→symbol cache ----------------
let _symCache = null;
function symbolCache() {
  if (_symCache) return _symCache;
  _symCache = loadJSON(SYMBOL_CACHE_FILE, { map: {} });
  if (!_symCache.map || typeof _symCache.map !== 'object') _symCache.map = {};
  return _symCache;
}
// Durable boot-restore hook: drop the in-memory cache so the next access
// re-reads the (re-hydrated) disk file.
export function __dropSymbolCacheForBoot() { _symCache = null; }
function cacheGet(key) {
  const rec = symbolCache().map[key];
  if (!rec || typeof rec !== 'object') return undefined; // unresolved marker is {miss:1}
  // Misses retry much sooner than hits — a resolution-engine upgrade or an
  // INDMoney payload change should re-resolve within a day and a half.
  const ttl = rec.symbol == null ? MISS_CACHE_TTL : SYMBOL_CACHE_TTL;
  if (Date.now() - (rec.ts || 0) > ttl) return undefined;
  return rec.symbol != null ? rec.symbol : null;
}
function cachePut(key, symbol) {
  const c = symbolCache();
  c.map[key] = { symbol, ts: Date.now() };
  // keep the cache bounded
  const keys = Object.keys(c.map);
  if (keys.length > 400) {
    keys.sort((a, b) => c.map[a].ts - c.map[b].ts);
    for (const k of keys.slice(0, keys.length - 400)) delete c.map[k];
  }
  saveJSON(SYMBOL_CACHE_FILE, c);
  // Durable write-through — resolution results survive Render restarts,
  // killing the per-boot re-lookup latency.
  try { durablePut(SYMBOL_CACHE_FILE, c); } catch { /* optional */ }
}

// ---------------- test hook ----------------
let _fetchImpl = null; // injected in tests
export function __setFetchForTests(fn) { _fetchImpl = fn; }
function uf(url, opts) { return (_fetchImpl || fetch)(url, opts); }

// ---------------- Groww (India) ----------------
// GET /v1/api/search/v1/entity?q=<name> → content[] with title,
// entity_type (Stocks/ETF/Scheme/Future/Option…), nse_scrip_code,
// company_short_name. Verified live: resolves both the user's ETFs
// ("Motilal Oswal Nifty 500 Momentum 50 ETF" → MOMENTUM50,
//  "Nippon India ETF Nifty Midcap 150" → MID150BEES).
async function growwSearch(name) {
  try {
    const r = await uf(`${GROWW_SEARCH}?q=${encodeURIComponent(name)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.content) ? j.content : null;
  } catch { return null; }
}

function nseSymbolFrom(item) {
  if (!item || typeof item !== 'object') return null;
  const et = String(item.entity_type || '').toUpperCase();
  if (et === 'FUTURE' || et === 'OPTION' || et === 'OPTION_CHAIN' || et === 'DERIVATIVE') return null;
  // Mutual-fund schemes are NAV-priced — NOT exchange symbols.
  if (et === 'SCHEME' || et === 'MUTUAL_FUND' || et === 'MF') return null;
  let sym = item.nse_scrip_code || item.company_short_name || item.symbol;
  if (typeof sym !== 'string') return null;
  sym = sym.replace(/\s+/g, '').toUpperCase();
  // Rights entitlements / odd scrips should not become live symbols.
  if (sym.includes('-RE') || sym.includes('-BE') || sym.length > 20) return null;
  return NSE_SYM_RE.test(sym) ? sym : null;
}

// Best-match Groww entry for a holding name. Prefers an exact title match;
// else the first Stocks/ETF entry whose title shares ≥3 significant words.
export function pickGrowwMatch(name, content) {
  if (!Array.isArray(content) || content.length === 0) return null;
  const want = normName(name);
  if (!want) return null;
  const scored = [];
  for (const item of content) {
    const sym = nseSymbolFrom(item);
    if (!sym) continue;
    const title = normName(item.title);
    const et = String(item.entity_type || '').toUpperCase();
    if (title === want) return { symbol: sym, exact: true };
    const wantWords = want.split(' ').filter(w => w.length > 2);
    const titleWords = new Set(title.split(' ').filter(w => w.length > 2));
    const overlap = wantWords.filter(w => titleWords.has(w)).length;
    if (wantWords.length >= 2 && overlap >= Math.min(3, wantWords.length)) {
      scored.push({ symbol: sym, score: overlap + (et === 'ETF' || et === 'STOCKS' ? 1 : 0) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length ? { symbol: scored[0].symbol, exact: false } : null;
}

export async function resolveIndSymbol(name) {
  const key = `IN:${normName(name)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const match = pickGrowwMatch(name, await growwSearch(name));
  const symbol = match ? match.symbol : null;
  cachePut(key, symbol);
  return symbol;
}

// ---------------- US ticker ----------------
// PROVENANCE (2026-09 deep audit — the SPCX / MU realtime fix):
// INDMoney's US holdings sometimes arrive with NO ticker, an ISIN, or a
// company short-name in the symbol field. The OLD resolver had exactly one
// remote tier — TradingView's description-EQUAL filter — which silently
// failed whenever TV's description differs from INDMoney's name by even a
// comma ("Micron Technology, Inc." vs "Micron Technology Inc."). The result
// was a noLive row (no realtime price) or a WRONG pseudo-ticker that never
// quotes. The new engine collects CANDIDATES in confidence order, then
// VERIFIES each with a real Yahoo quote before accepting it:
//   T1  raw symbol (ticker-shaped, incl. "NASDAQ:MU" / "MU:NSDQ" forms)
//   T2  paren-ticker inside the name — "SpaceX (SPCX)" → SPCX
//   T3  static US_NAME_MAP (normalized full-name keys)
//   T4  Yahoo search API (relevance-ranked, US EQUITY/ETF filter)
//   T5  TV description-equal (kept as a last resort, unchanged)
// A candidate that fails verification falls through to the next tier, so a
// short-name like "SPACEX" (ticker-shaped but NOT a ticker) can never win.
// Results are cached under a VERSIONED key — engine upgrades re-resolve.
const RESOLVE_ENGINE_VERSION = 'v2';

// Extract a ticker-shaped token from arbitrary text. Handles the exchange
// forms INDMoney occasionally sends: "NASDAQ:MU", "MU:NSDQ", "NMS:MU".
const EXCHANGE_TOKENS = new Set([
  'NASDAQ', 'NSDQ', 'NYSE', 'NMS', 'AMEX', 'ARCA', 'BATS', 'CBOE', 'OTC', 'PINX', 'NYSEAMERICAN', 'NGS', 'NGM',
]);
export function extractTickerToken(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  // Split composite forms first — any segment may be the ticker.
  const parts = s.split(':').map(p => p.trim()).filter(Boolean);
  const cands = (parts.length > 1 ? parts : [s]).filter(c => US_TICKER_RE.test(c) && !EXCHANGE_TOKENS.has(c));
  // Prefer the first non-exchange ticker-shaped segment.
  for (const c of cands) return c;
  return null;
}

// "SpaceX (SPCX)" / "Micron Technology Inc. (MU)" → SPCX / MU.
export function extractParenTicker(name) {
  const m = /\(([^)]{1,8})\)\s*$/.exec(String(name || ''));
  if (!m) return null;
  const t = m[1].trim().toUpperCase();
  return US_TICKER_RE.test(t) ? t : null;
}

// Yahoo search — relevance-ranked quotes with symbol + shortname +
// quoteType + exchange. Anonymous, keyless, verified live:
//   "Micron Technology Inc." → MU (NMS)   "SpaceX" → SPCX (NMS)
// Pure scoring helper (unit-testable without network).
const YAHOO_US_EXCHANGES = new Set([
  'NMS', 'NYQ', 'PCX', 'ASE', 'NGM', 'NGS', 'NCM', 'BTS', 'CBS', 'NEC', 'MNX', 'CXI',
]);
export function pickYahooSearchMatch(quotes, name) {
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  const want = normName(name);
  if (!want) return null;
  const wantWords = new Set(want.split(' ').filter(w => w.length > 2));
  let best = null;
  let bestScore = 0;
  for (const q of quotes) {
    if (!q || typeof q.symbol !== 'string') continue;
    const sym = q.symbol.trim().toUpperCase();
    if (!US_TICKER_RE.test(sym)) continue;                 // US ticker shape only
    if (q.quoteType && !['EQUITY', 'ETF'].includes(q.quoteType)) continue;
    if (q.exchange && !YAHOO_US_EXCHANGES.has(String(q.exchange).toUpperCase())) continue;
    const short = normName(q.shortname || q.shortName || '');
    const long = normName(q.longname || q.longName || '');
    let score = 0;
    if (short && short === want) score += 100;
    else if (long && long === want) score += 90;
    else {
      const hitWords = [...wantWords].filter(w => (short && short.includes(w)) || (long && long.includes(w))).length;
      if (wantWords.size > 0) score += Math.round((hitWords / wantWords.size) * 60);
    }
    if (score > bestScore) { bestScore = score; best = sym; }
  }
  // Loose floor: single distinctive names like "SpaceX" share zero tokens
  // with "Space Exploration Technologies" — Yahoo's top US equity is still
  // the right answer, so accept ANY filtered candidate when scoring is weak
  // but the query is at least one 4+ char word (not "inc" / "the").
  if (!best) {
    const distinctive = want.split(' ').some(w => w.replace(/[^a-z0-9]/g, '').length >= 4);
    if (distinctive) {
      const first = quotes.find(q => q && typeof q.symbol === 'string'
        && US_TICKER_RE.test(q.symbol.trim().toUpperCase())
        && (!q.quoteType || ['EQUITY', 'ETF'].includes(q.quoteType))
        && (!q.exchange || YAHOO_US_EXCHANGES.has(String(q.exchange).toUpperCase())));
      if (first) return first.symbol.trim().toUpperCase();
    }
  }
  return bestScore >= 40 ? best : null;
}

async function yahooSearchUS(name) {
  try {
    const r = await uf(`${YAHOO_SEARCH}?q=${encodeURIComponent(name)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.quotes) ? j.quotes : null;
  } catch { return null; }
}

// Does this ticker actually quote on Yahoo? (One small chart call; cached
// so a sync resolving 40 names costs ≤40 round-trips ONCE.)
// Returns 'ok' (quotes), 'notfound' (definitively unknown symbol) or
// 'unknown' (Yahoo unreachable — caller may keep high-confidence
// candidates tentatively, matching the pre-verification behaviour).
const _verifyCache = new Map(); // sym → { ts, verdict }
async function yahooQuoteVerdict(sym) {
  const s = String(sym || '').toUpperCase();
  if (!s) return 'notfound';
  const hit = _verifyCache.get(s);
  if (hit && Date.now() - hit.ts < 24 * 60 * 60 * 1000) return hit.verdict;
  let verdict = 'unknown';
  try {
    const r = await uf(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI symbol verify)' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT),
    });
    if (r.ok) {
      const j = await r.json();
      const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      verdict = (typeof price === 'number' && price > 0) ? 'ok' : 'notfound';
    } else if (r.status === 404 || r.status === 422) {
      verdict = 'notfound';       // Yahoo knows this symbol is not real
    } else {
      verdict = 'unknown';        // 5xx / 429 — Yahoo itself unreachable
    }
  } catch { verdict = 'unknown'; } // timeout / DNS — not the symbol's fault
  _verifyCache.set(s, { ts: Date.now(), verdict });
  return verdict;
}
async function yahooQuoteOk(sym) { return (await yahooQuoteVerdict(sym)) === 'ok'; }

async function tvAmericaDescriptionLookup(name) {
  try {
    const r = await uf(TV_AMERICA_SCAN, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        filter: [{ left: 'description', operation: 'equal', right: String(name) }],
        columns: ['name', 'description'],
      }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const first = Array.isArray(j?.data) ? j.data[0] : null;
    if (!first) return null;
    // j.data[0].s = "NASDAQ:AAPL" → AAPL
    const ticker = String(first.s || '').split(':')[1] || '';
    return /^[A-Z][A-Z.-]{0,5}$/.test(ticker) ? ticker : null;
  } catch { return null; }
}

/**
 * Resolve a US holding → verified ticker (or null).
 * Order: raw symbol → paren ticker → static map → Yahoo search → TV.
 * Every accepted candidate is verified with a real Yahoo quote; a failing
 * candidate falls through so short-name pseudo-tickers can never win.
 */
export async function resolveUsSymbol(name, rawSymbol) {
  const nName = normName(name);
  // T1 — payload symbol. Handles plain "MU", "NASDAQ:MU", "MU:NSDQ".
  // (ISINs / long codes fail US_TICKER_RE and simply fall through.)
  const rawTok = extractTickerToken(rawSymbol);
  // T2 — "SpaceX (SPCX)" style names.
  const parenTok = extractParenTicker(name);
  // T3 — static map (exact normalized full-name hit).
  const mapTok = US_NAME_MAP.get(nName) || null;

  // Fast path: a high-confidence candidate that VERIFIES wins immediately.
  // If Yahoo itself is unreachable ('unknown'), keep the candidate
  // tentatively (matches pre-verification behaviour — better a live symbol
  // than a silent NAV row during a Yahoo blip).
  let tentative = null;
  for (const cand of [rawTok, parenTok, mapTok]) {
    if (!cand) continue;
    const verdict = await yahooQuoteVerdict(cand);
    if (verdict === 'ok') return cand;
    if (verdict === 'unknown' && !tentative) tentative = cand;
  }

  // Versioned cache — engine upgrades must re-resolve old entries.
  const key = `US${RESOLVE_ENGINE_VERSION}:${nName}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // T4 — Yahoo relevance search (handles comma/period name drift).
  let out = null;
  const searched = await yahooSearchUS(name);
  const searchHit = pickYahooSearchMatch(searched, name);
  if (searchHit && (await yahooQuoteOk(searchHit))) {
    out = searchHit;
  }

  // T5 — TV description-equal (last resort, original behaviour).
  if (!out) {
    const tvTok = await tvAmericaDescriptionLookup(name);
    if (tvTok && (await yahooQuoteOk(tvTok))) out = tvTok;
  }

  // Yahoo unreachable AND a high-confidence candidate existed → keep it
  // (do NOT cache a miss for a name we simply could not verify).
  if (!out && tentative) return tentative;

  cachePut(key, out);
  return out;
}

// ---------------- crypto ----------------
export function resolveCryptoSymbol(name, rawSymbol) {
  // Case-insensitive map lookup (names/symbols arrive in mixed case).
  const tryKey = (s) => {
    const k = String(s || '').trim().toLowerCase();
    return k && CRYPTO_MAP.has(k) ? CRYPTO_MAP.get(k) : null;
  };
  const bySym = tryKey(rawSymbol);
  if (bySym) return bySym;
  const byName = tryKey(name);
  if (byName) return byName;
  // "Bitcoin (BTC)" or "BTC — Bitcoin"
  const paren = /\(([^)]{2,6})\)\s*$/.exec(String(name || ''));
  if (paren) {
    const p = tryKey(paren[1]);
    if (p) return p;
  }
  return null;
}

// ---------------- decision engine ----------------
// Holding (from fetchPortfolio) + its stamped assetEnum → market/kind/live.
// Exported pure so tests can drive it without any network.
export function classifyHolding(h) {
  const enumv = String(h?.assetEnum || '').toUpperCase();
  const label = String(h?.assetType || '');
  const name = String(h?.name || '');

  if (enumv === 'CRYPTO' || /crypto/i.test(label)) {
    return { market: 'IN', kind: 'crypto', tryResolve: 'crypto' };
  }
  if (enumv === 'US_STOCK') {
    return { market: 'US', kind: 'stock', tryResolve: 'us' };
  }
  if (enumv === 'IND_STOCK' || enumv === '' && /stock|etf/i.test(label)) {
    // ETFs from INDMoney arrive under IND_STOCK with "ETF" in the name.
    const kind = /etf/i.test(name) || /etf/i.test(label) ? 'etf' : 'stock';
    return { market: 'IN', kind, tryResolve: 'ind' };
  }
  if (enumv === 'MF' || /mutual fund/i.test(label)) {
    return { market: 'IN', kind: 'mf', tryResolve: null }; // NAV-based, no exchange symbol
  }
  // BOND/EPF/NPS/SA/FD/INSURANCE/VEHICLE/RE + anything else: INR, not live.
  const kind = /gold/i.test(label) ? 'gold'
    : /bond/i.test(label) ? 'bond'
    : /retirement|epf|nps|ppf/i.test(`${enumv} ${label}`) ? 'retirement'
    : /fixed income|fd/i.test(`${enumv} ${label}`) ? 'fixed'
    : 'other';
  return { market: 'IN', kind, tryResolve: null };
}

// Resolve ONE holding → { market, kind, symbol, noLive }.
export async function resolveHoldingSymbol(h) {
  const cls = classifyHolding(h);
  if (cls.tryResolve === 'crypto') {
    const sym = resolveCryptoSymbol(h?.name, h?.symbol);
    return { ...cls, symbol: sym, noLive: !sym };
  }
  if (cls.tryResolve === 'us') {
    const sym = await resolveUsSymbol(h?.name, h?.symbol);
    return { ...cls, symbol: sym, noLive: !sym };
  }
  if (cls.tryResolve === 'ind') {
    // A payload-provided ticker-ish symbol wins if it is NSE-shaped.
    const raw = typeof h?.symbol === 'string' ? h.symbol.trim().toUpperCase() : '';
    if (raw.length >= 2 && raw.length <= 20 && NSE_SYM_RE.test(raw) && !/^INDS?\d/.test(raw)) {
      return { ...cls, symbol: raw, noLive: false };
    }
    const sym = await resolveIndSymbol(h?.name);
    return { ...cls, symbol: sym, noLive: !sym };
  }
  return { ...cls, symbol: null, noLive: true };
}

// Resolve a batch (sequential, cached; a few ms per uncached name).
export async function resolveSymbolsForHoldings(holdings) {
  const out = [];
  for (const h of Array.isArray(holdings) ? holdings : []) {
    try { out.push(await resolveHoldingSymbol(h)); }
    catch { const cls = classifyHolding(h); out.push({ ...cls, symbol: null, noLive: true }); }
  }
  return out;
}

export function __resetSymbolCacheForTests() {
  _symCache = null;
}
