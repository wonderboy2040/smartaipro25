// ============================================================
// server/ai/sectors.js — SECTOR MAP + CONTEXT CHAIN + F-SCORE (v6.11)
// ------------------------------------------------------------
// Glama-inspired trio:
//   • mukul8896 "market+sector sentiment" → SECTOR MAP: the India
//     universe grouped into sectors, each with breadth (% above
//     EMA20), avg momentum, mood label + sector-index overlay from
//     Yahoo (^CNXIT, ^CNXAUTO …).
//   • oneqaz "macro→ETF→symbol context chain" → CONTEXT CHAIN:
//     NIFTY trend + VIX + global proxies (DXY/CRUDE/GOLD) →
//     strongest sectors → top aligned symbols. The top-down lens
//     a discretionary trader runs before picking a chart.
//   • staskh "piotroski_score" → F-SCORE (trend-quality edition):
//     9 price-action checks (EMA stack, RSI health, MACD, ADX,
//     VWAP, relative volume, 52w position …). HONEST LABEL: this
//     is Piotroski-STYLE trend quality — balance-sheet Piotroski
//     (ROA/CFO/leverage) needs fundamentals data jo is host se
//     reachable nahi hai. Score 0-9, grade A/B/C.
//
// v11.1 GAP 1 — FULL-UNIVERSE SYNC: the desk's top-down lens was
// stuck on the ORIGINAL 45-name static map while the scanner
// underneath it now sees the whole ~220-name NSE F&O tape
// (indiaUniverse.js). A genuinely strong name outside the 45 could
// never surface through the sector lens. Now (AI_INDIA_FULL_UNIVERSE
// on, the default):
//   • universe = base 45 ∪ discovered ~220 (same TV chunked batch)
//   • symbol→sector = curated static table FIRST (the original 45 +
//     the seed classification), then TV's own `sector` taxonomy for
//     everything else, honest OTHERS bucket for the rest
//   • breadth / momentum / leader / laggard / context-chain / F-Score
//     logic UNCHANGED — only the membership scaled 5x
// Flag OFF → the legacy static 45-name path, byte-identical payload.
//
// Read-only. 5-min cache on the TV batch (same source the signal
// board uses — one scan, many desks).
// ============================================================
import { fetchTVIndiaBatch, fetchTVIndiaBatchChunked, INDIA_UNIVERSE, fetchYahooQuotes } from './data.js';
import { fullIndiaUniverseEnabled, discoverNSEFullUniverse, validNSESymbol } from './indiaUniverse.js';

// ---------------- sector mapping (full 45-symbol universe) ----------------
export const SECTOR_MAP = {
  BANKING: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK'],
  IT: ['INFY', 'TCS', 'WIPRO', 'HCLTECH', 'TECHM'],
  ENERGY: ['RELIANCE', 'ONGC', 'BPCL', 'NTPC', 'POWERGRID', 'COALINDIA'],
  AUTO: ['MARUTI', 'TATAMOTORS', 'EICHERMOT', 'HEROMOTOCO', 'BAJAJ-AUTO'],
  PHARMA: ['SUNPHARMA', 'CIPLA', 'DRREDDY', 'DIVISLAB'],
  FMCG: ['HINDUNILVR', 'ITC', 'NESTLEIND'],
  FINANCIALS: ['BAJFINANCE', 'BAJAJFINSV', 'SBILIFE', 'HDFCLIFE', 'SHRIRAMFIN'],
  METAL: ['TATASTEEL', 'JSWSTEEL', 'HINDALCO'],
  INFRA: ['LT', 'ULTRACEMCO', 'GRASIM', 'ADANIENT', 'ADANIPORTS'],
  CONSUMER: ['BHARTIARTL', 'ASIANPAINT', 'TITAN'],
};

// ------------------------------------------------------------
// v11.1 GAP 1 — the EXTENDED static classification. Covers every
// name in INDIA_FULL_FALLBACK_SEED (the discovery-outage universe)
// plus the wider F&O names the desks scan, using the SAME ten
// buckets the original map defined + six well-scoped new ones
// (HEALTHCARE / CHEMICALS / DEFENCE / REALTY / TELECOM / TRANSPORT)
// so a 220-name universe buckets honestly instead of dumping into
// catch-alls. Curated table ALWAYS wins over TV's taxonomy.
// ------------------------------------------------------------
export const EXTENDED_SECTOR_CLASSIFICATION = {
  // Banks
  PNB: 'BANKING', CANBK: 'BANKING', BANKBARODA: 'BANKING', UNIONBANK: 'BANKING',
  IDFCFIRSTB: 'BANKING', FEDERALBNK: 'BANKING', AUBANK: 'BANKING', YESBANK: 'BANKING',
  INDIANBANK: 'BANKING',
  // Non-bank financials, insurers, exchanges, platforms
  LICI: 'FINANCIALS', ICICIPRULI: 'FINANCIALS', ICICIGI: 'FINANCIALS', HDFCAMC: 'FINANCIALS',
  BAJAJHLDNG: 'FINANCIALS', CHOLAFIN: 'FINANCIALS', MUTHOOTFIN: 'FINANCIALS',
  MANAPPURAM: 'FINANCIALS', PFC: 'FINANCIALS', RECLTD: 'FINANCIALS', IRFC: 'FINANCIALS',
  HUDCO: 'FINANCIALS', LICHSGFIN: 'FINANCIALS', STARHEALTH: 'FINANCIALS',
  ANGELONE: 'FINANCIALS', BSE: 'FINANCIALS', MCX: 'FINANCIALS', IEX: 'FINANCIALS',
  PAYTM: 'FINANCIALS', POLICYBZR: 'FINANCIALS', JIOFIN: 'FINANCIALS',
  // IT
  PERSISTENT: 'IT', COFORGE: 'IT', MPHASIS: 'IT', LTIM: 'IT', TATAELXSI: 'IT',
  LTTS: 'IT', KPITTECH: 'IT',
  // Auto & ancillaries
  ASHOKLEY: 'AUTO', TVSMOTOR: 'AUTO', BALKRISIND: 'AUTO', MRF: 'AUTO',
  APOLLOTYRE: 'AUTO', MOTHERSON: 'AUTO', BOSCHLTD: 'AUTO', EXIDEIND: 'AUTO',
  UNOMINDA: 'AUTO', TIINDIA: 'AUTO', ESCORTS: 'AUTO', SONACOMS: 'AUTO',
  BHARATFORG: 'AUTO', 'M&M': 'AUTO',
  // Pharma
  AUROPHARMA: 'PHARMA', LUPIN: 'PHARMA', ALKEM: 'PHARMA', TORNTPHARM: 'PHARMA',
  GLENMARK: 'PHARMA', IPCALAB: 'PHARMA', NATCOPHARM: 'PHARMA', BIOCON: 'PHARMA',
  SYNGENE: 'PHARMA', ZYDUSLIFE: 'PHARMA', LAURUSLABS: 'PHARMA', GRANULES: 'PHARMA',
  ABBOTINDIA: 'PHARMA', GLAND: 'PHARMA',
  // Hospitals & diagnostics
  APOLLOHOSP: 'HEALTHCARE', MAXHEALTH: 'HEALTHCARE', LALPATHLAB: 'HEALTHCARE', FORTIS: 'HEALTHCARE',
  // FMCG
  GODREJCP: 'FMCG', DABUR: 'FMCG', COLPAL: 'FMCG', MARICO: 'FMCG', VBL: 'FMCG',
  UBL: 'FMCG', RADICO: 'FMCG', BRITANNIA: 'FMCG',
  // Consumer / retail / discretionary / new-age
  TRENT: 'CONSUMER', NYKAA: 'CONSUMER', DMART: 'CONSUMER', ABFRL: 'CONSUMER',
  PAGEIND: 'CONSUMER', BATAINDIA: 'CONSUMER', JUBLFOOD: 'CONSUMER', IHCL: 'CONSUMER',
  ZOMATO: 'CONSUMER', ETERNAL: 'CONSUMER',
  VOLTAS: 'CONSUMER', HAVELLS: 'CONSUMER', DIXON: 'CONSUMER',
  // Metals & mining
  NMDC: 'METAL', SAIL: 'METAL', JINDALSTEL: 'METAL', APLAPOLLO: 'METAL', VEDL: 'METAL',
  // Power & energy
  TATAPOWER: 'ENERGY', ADANIPOWER: 'ENERGY', ADANIGREEN: 'ENERGY', IREDA: 'ENERGY',
  NHPC: 'ENERGY', TORNTPOWER: 'ENERGY', SUZLON: 'ENERGY', NLCIND: 'ENERGY',
  OIL: 'ENERGY', IGL: 'ENERGY', INOXGREEN: 'ENERGY', GAIL: 'ENERGY',
  PETRONET: 'ENERGY', IOC: 'ENERGY',
  // Cement & infra & industrials
  SHREECEM: 'INFRA', RAMCOCEM: 'INFRA', NBCC: 'INFRA', NCC: 'INFRA', RVNL: 'INFRA',
  // Realty
  DLF: 'REALTY', GODREJPROP: 'REALTY', OBEROIRLTY: 'REALTY',
  // Chemicals
  PIDILITIND: 'CHEMICALS', UPL: 'CHEMICALS', DEEPAKNTR: 'CHEMICALS', SRF: 'CHEMICALS',
  AARTIIND: 'CHEMICALS',
  // Defence & heavy industrials
  BEL: 'DEFENCE', HAL: 'DEFENCE', BDL: 'DEFENCE', MAZDOCK: 'DEFENCE',
  COCHINSHIP: 'DEFENCE', DATAPATTNS: 'DEFENCE', CGPOWER: 'DEFENCE', BHEL: 'DEFENCE',
  CUMMINSIND: 'DEFENCE',
  // Telecom
  IDEA: 'TELECOM', INDUSTOWER: 'TELECOM',
  // Travel, transport & logistics
  IRCTC: 'TRANSPORT', DELHIVERY: 'TRANSPORT', CONCOR: 'TRANSPORT', INDIGO: 'TRANSPORT',
};

// TV's own sector taxonomy (observed live on the India scanner:
// "Technology Services", "Process Industries", "Finance", …) → the
// desk's bucket grammar. Unknown strings → honest OTHERS.
export const TV_SECTOR_TO_DESK = {
  'Finance': 'FINANCIALS',
  'Technology Services': 'IT',
  'Electronic Technology': 'IT',
  'Energy Minerals': 'ENERGY',
  'Utilities': 'ENERGY',
  'Producer Durables': 'INFRA',
  'Industrial Services': 'INFRA',
  'Commercial Services': 'INFRA',
  'Consumer Durables': 'CONSUMER',
  'Consumer Non-Durables': 'FMCG',
  'Retail Trade': 'CONSUMER',
  'Consumer Services': 'CONSUMER',
  'Health Technology': 'PHARMA',
  'Health Services': 'HEALTHCARE',
  'Non-Energy Minerals': 'METAL',
  'Process Industries': 'CHEMICALS',
  'Communications': 'TELECOM',
  'Transportation': 'TRANSPORT',
};

/**
 * PURE: the merged symbol→sector lookup for the FULL universe.
 * Priority: original SECTOR_MAP (curated 45) → EXTENDED static
 * classification (curated seed/F&O names) → TV's live `sector`
 * string mapped through TV_SECTOR_TO_DESK. TV rows without a sector
 * string and without a static classification simply don't enter the
 * map — callers bucket those as OTHERS explicitly (honest, counted).
 */
export function buildSectorMap(tvRows) {
  const map = new Map();
  for (const [sec, syms] of Object.entries(SECTOR_MAP)) {
    for (const s of syms) map.set(s, sec);
  }
  for (const [s, sec] of Object.entries(EXTENDED_SECTOR_CLASSIFICATION)) {
    if (!map.has(s)) map.set(s, sec);
  }
  for (const row of Array.isArray(tvRows) ? tvRows : []) {
    const sym = String(row?.symbol || '').trim().toUpperCase();
    const tvSec = String(row?.sector || '').trim();
    if (!validNSESymbol(sym) || map.has(sym) || !tvSec) continue;
    map.set(sym, TV_SECTOR_TO_DESK[tvSec] || 'OTHERS');
  }
  return map;
}

// Yahoo sector-index overlay (absent sectors honestly stay null)
const SECTOR_INDEX = { IT: 'IT', AUTO: 'AUTO', PHARMA: 'PHARMA', FMCG: 'FMCG', METAL: 'METAL', BANKING: 'BANKNIFTY' };

const CACHE_TTL = 5 * 60 * 1000;
let _cache = null, _cacheAt = 0;

// NOTE: TV 'change' and Yahoo 'changePct' are ALREADY in percent —
// round only, NEVER re-multiply (the classic double-scaling bug).
const pct = (v) => Math.round(Number(v) * 10) / 10;

// ---------------- F-Score (trend quality, Piotroski-STYLE) ----------------
/**
 * 9 checks, 1 point each — all from ONE TV snapshot row:
 *   1 price>EMA20        trend above short-term mean
 *   2 EMA20>EMA50        stack in order
 *   3 RSI 45-70          momentum healthy, not exhausted
 *   4 MACD>signal        momentum turning with price
 *   5 ADX>20             a real trend exists
 *   6 changePct>0        today participating green
 *   7 price>VWAP         intraday strength
 *   8 relVolume>1        participation above 10d average
 *   9 52w position>50%   nearer highs than lows
 */
export function fscoreOf(row) {
  const n = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
  const ltp = n(row?.ltp), ema20 = n(row?.ema20), ema50 = n(row?.ema50);
  const rsi = n(row?.rsi), macd = n(row?.macd), macdSignal = n(row?.macdSignal);
  const adx = n(row?.adx), chg = n(row?.changePct), vwap = n(row?.vwap);
  const relVol = n(row?.relVolume), hi = n(row?.high52w), lo = n(row?.low52w);
  const pos52 = (ltp != null && hi != null && lo != null && hi > lo) ? (ltp - lo) / (hi - lo) : null;

  const checks = [
    { k: 'trend', ok: ltp != null && ema20 != null && ltp > ema20 },
    { k: 'stack', ok: ema20 != null && ema50 != null && ema20 > ema50 },
    { k: 'momo', ok: rsi != null && rsi >= 45 && rsi <= 70 },
    { k: 'macd', ok: macd != null && macdSignal != null && macd > macdSignal },
    { k: 'adx', ok: adx != null && adx > 20 },
    { k: 'green', ok: chg != null && chg > 0 },
    { k: 'vwap', ok: ltp != null && vwap != null && ltp > vwap },
    { k: 'vol', ok: relVol != null && relVol > 1 },
    { k: '52w', ok: pos52 != null && pos52 > 0.5 },
  ];
  const score = checks.filter(c => c.ok).length;
  return {
    score,
    grade: score >= 7 ? 'A' : score >= 5 ? 'B' : 'C',
    checks: checks.map(c => ({ k: c.k, pass: !!c.ok })),
    pos52: pos52 != null ? Math.round(pos52 * 1000) / 10 : null,
    rsi, adx, relVol,
    disclaimer: 'Piotroski-STYLE trend-quality score — price-action based. Balance-sheet Piotroski (ROA/CFO/leverage) is host se unreachable, isliye honestly yeh proxy hai.',
  };
}

// ---------------- sector rows from a scanned TV batch ----------------
/** One sector aggregate row from its scanned TV rows (shape identical
 *  to the legacy map — only the membership scaled). */
function _sectorRow(name, list, quotes) {
  const n = list.length || 1;
  const above = list.filter(r => r.ltp != null && r.ema20 != null && r.ltp > r.ema20).length;
  const avgChg = list.reduce((s, r) => s + (r.changePct ?? 0), 0) / n;
  const avgRsi = list.reduce((s, r) => s + (r.rsi ?? 50), 0) / n;
  const breadth = (above / n) * 100;
  const mood = breadth >= 60 && avgChg > 0 ? 'BULLISH' : breadth <= 40 && avgChg < 0 ? 'BEARISH' : 'NEUTRAL';
  const ranked = [...list].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
  return {
    sector: name,
    symbols: n,
    breadth: Math.round(breadth),
    avgChangePct: pct(avgChg),
    avgRsi: Math.round(avgRsi),
    mood,
    indexChangePct: quotes[SECTOR_INDEX[name]]?.changePct != null ? pct(quotes[SECTOR_INDEX[name]].changePct) : null,
    leader: ranked[0] ? { symbol: ranked[0].symbol, changePct: pct(ranked[0].changePct ?? 0) } : null,
    laggard: ranked.length ? { symbol: ranked[ranked.length - 1].symbol, changePct: pct(ranked[ranked.length - 1].changePct ?? 0) } : null,
  };
}

// ---------------- the combined desk ----------------
export async function sectorDesk() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;

  // ---- v11.1 GAP 1: flag OFF → the legacy static path, byte-identical ----
  if (!fullIndiaUniverseEnabled()) {
    const [tv, quotes] = await Promise.all([
      fetchTVIndiaBatch(INDIA_UNIVERSE).catch(() => ({})),
      fetchYahooQuotes(['NIFTY', 'INDIAVIX', 'DXY', 'CRUDE', 'GOLD', 'IT', 'AUTO', 'PHARMA', 'FMCG', 'METAL', 'BANKNIFTY']).catch(() => ({})),
    ]);
    const rows = Object.values(tv || {});
    if (rows.length < 10) {
      return {
        ok: false,
        error: 'TV India scanner unreachable — sector map data nahi mila (thodi der baad retry karo)',
        sectors: [], chain: null, fscore: null,
      };
    }
    const out = _buildDeskPayload(rows, Object.entries(SECTOR_MAP).map(([name, syms]) => [name, syms.map(s => tv[s]).filter(Boolean)]), quotes, {
      mode: 'base-45',
      note: 'Sector map = TV live snapshot (5-min cache). Context chain = top-down lens. F-Score = trend-quality proxy (disclaimer ke saath). Read-only — koi order nahi.',
    });
    _cache = out; _cacheAt = Date.now();
    return out;
  }

  // ---- v11.1 GAP 1: flag ON (default) → the FULL discovered universe ----
  const [discovered, quotes] = await Promise.all([
    discoverNSEFullUniverse().catch(() => ({ rows: [], ok: false })),
    fetchYahooQuotes(['NIFTY', 'INDIAVIX', 'DXY', 'CRUDE', 'GOLD', 'IT', 'AUTO', 'PHARMA', 'FMCG', 'METAL', 'BANKNIFTY']).catch(() => ({})),
  ]);
  const discoveredSyms = (Array.isArray(discovered?.rows) ? discovered.rows : [])
    .map(r => String(r?.symbol || '').trim().toUpperCase())
    .filter(validNSESymbol);
  const universe = [...new Set([...INDIA_UNIVERSE, ...discoveredSyms])];
  const tv = await fetchTVIndiaBatchChunked(universe).catch(() => ({}));
  const rows = Object.values(tv || {});
  if (rows.length < 10) {
    return {
      ok: false,
      error: 'TV India scanner unreachable — sector map data nahi mila (thodi der baad retry karo)',
      sectors: [], chain: null, fscore: null,
    };
  }

  // Bucket every scanned symbol: curated static table first, TV's own
  // taxonomy next, honest OTHERS for the remainder — a strong F&O name
  // outside the original 45 now COUNTS in breadth/momentum/leaders.
  const lookup = buildSectorMap(discovered?.rows);
  const buckets = new Map();
  for (const r of rows) {
    const sec = lookup.get(r.symbol) || 'OTHERS';
    if (!buckets.has(sec)) buckets.set(sec, []);
    buckets.get(sec).push(r);
  }
  const out = _buildDeskPayload(rows, [...buckets.entries()], quotes, {
    mode: discovered?.ok ? 'full-dynamic' : 'full-seed-fallback',
    note: `Sector map = TV live snapshot of the FULL discovered universe (${rows.length} names, 5-min cache; static curated classification + TV sector taxonomy). Context chain = top-down lens. F-Score = trend-quality proxy (disclaimer ke saath). Read-only — koi order nahi.`,
  });
  _cache = out; _cacheAt = Date.now();
  return out;
}

/** Shared payload builder (identical computation for both paths). */
function _buildDeskPayload(rows, sectorEntries, quotes, meta) {
  // ---- sectors ----
  const sectors = sectorEntries
    .filter(([, list]) => list.length > 0)
    .map(([name, list]) => _sectorRow(name, list, quotes))
    .sort((a, b) => b.avgChangePct - a.avgChangePct);

  // ---- macro → sector → symbol context chain ----
  const nifty = quotes['NIFTY'];
  const vix = quotes['INDIAVIX'];
  const macro = {
    niftyChangePct: nifty?.changePct != null ? pct(nifty.changePct) : null,
    vix: vix?.price ?? null,
    vixRegime: vix?.price == null ? null : vix.price < 12 ? 'CALM' : vix.price < 16 ? 'NORMAL' : vix.price < 20 ? 'ELEVATED' : 'STRESS',
    dollar: quotes['DXY']?.changePct != null ? pct(quotes['DXY'].changePct) : null,
    crude: quotes['CRUDE']?.changePct != null ? pct(quotes['CRUDE'].changePct) : null,
    gold: quotes['GOLD']?.changePct != null ? pct(quotes['GOLD'].changePct) : null,
  };
  const bias = macro.niftyChangePct == null ? 'UNKNOWN'
    : macro.niftyChangePct > 0.4 ? 'RISK-ON'
    : macro.niftyChangePct < -0.4 ? 'RISK-OFF' : 'FLAT';
  const strongest = sectors.filter(s => s.mood !== 'BEARISH').slice(0, 3);
  const chain = {
    macro: { ...macro, bias },
    read: `Macro ${bias}${macro.vixRegime ? ` · VIX ${macro.vixRegime}` : ''} → strongest: ${strongest.slice(0, 2).map(s => s.sector).join(', ') || '—'} → wahan se leaders pick karo, BEARISH sectors me counter-trend long mat lo.`,
    strongest: strongest.map(s => {
      const list = (sectorEntries.find(([name]) => name === s.sector)?.[1]) || [];
      const tops = [...list].sort((a, b) => (fscoreOf(b).score) - (fscoreOf(a).score)).slice(0, 2)
        .map(r => ({ symbol: r.symbol, changePct: pct(r.changePct ?? 0), fscore: fscoreOf(r).score }));
      return { sector: s.sector, mood: s.mood, breadth: s.breadth, top: tops };
    }),
  };

  // ---- F-Score board (top quality across the universe) ----
  const scored = rows.map(r => ({ symbol: r.symbol, ltp: r.ltp, ...fscoreOf(r) }))
    .sort((a, b) => b.score - a.score);
  const fscore = {
    top: scored.slice(0, 8).map(s => ({
      symbol: s.symbol, ltp: s.ltp, score: s.score, grade: s.grade, rsi: s.rsi, pos52: s.pos52, adx: s.adx,
    })),
    bottom: scored.slice(-3).map(s => ({ symbol: s.symbol, score: s.score, grade: s.grade })),
    distribution: {
      A: scored.filter(s => s.grade === 'A').length,
      B: scored.filter(s => s.grade === 'B').length,
      C: scored.filter(s => s.grade === 'C').length,
    },
    disclaimer: scored[0]?.disclaimer,
  };

  return {
    ok: true,
    asOf: Date.now(),
    universe: rows.length,
    sectorMode: meta.mode,
    sectors,
    chain,
    fscore,
    note: meta.note,
  };
}

export const __testables = { SECTOR_MAP, SECTOR_INDEX, EXTENDED_SECTOR_CLASSIFICATION, TV_SECTOR_TO_DESK, buildSectorMap };
export function __resetSectorDeskForTests() { _cache = null; _cacheAt = 0; }
