// ============================================================
// server/ai/sentiment.js — V2 MODEL #12: SentimentPulse
// ------------------------------------------------------------
// Ensemble 11 → 14 upgrade, Phase 1. The committee finally reads
// what the WORLD is saying, not just the chart:
//
//   INDIA   — free financial RSS headlines (Moneycontrol market
//             reports + buzzing stocks, Economic Times markets),
//             filtered by symbol/company-name match and scored by
//             a weighted news lexicon (surge/rally/upgrade vs
//             plunge/crash/downgrade …).
//   CRYPTO  — Alternative.me Fear & Greed Index (free, no key)
//             + perp funding-rate sign (Binance fapi public
//             premiumIndex — crowding gauge; no key).
//
// Architecture contract (models.js bus): the model VOTE is
// synchronous — sentimentVote(ctx) reads a server-side cache
// warmed by refreshSentiment(market) (15-min TTL, headlines don't
// change that fast — mirrors the signals.js 60s/45s cache
// pattern, just wider). Cold cache → honest ABSTAIN, never a
// invented number.
//
// LLM reuse (the plan's "no extra LLM cost" rule): the AI Council
// prompt is extended with 1-2 lines of this desk's context via
// sentimentContextFor(market) — the SAME Gemini→Groq→Cerebras
// call that already runs. When the council response carries an
// optional `sentiment` block, absorbCouncilSentiment() folds the
// LLM-refined score back into the cache for the NEXT cycle.
//
// Weight in MODELS[]: 0.7 (below median) — deliberately low until
// adaptive.js earns it a multiplier from ≥8 settled outcomes.
// ============================================================

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

function vote(dir, conf, reasons) {
  return { dir, conf: Math.round(clamp(conf)), reasons: reasons.filter(Boolean) };
}

// ---------------- data sources (all free, no keys) ----------------
const RSS_FEEDS = [
  'https://www.moneycontrol.com/rss/marketreports.xml',
  'https://www.moneycontrol.com/rss/buzzingstocks.xml',
  'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
];

const FNG_URL = 'https://api.alternative.me/fng/?limit=1';
const FUNDING_URL = (sym) => `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`;

const CACHE_TTL = 15 * 60 * 1000; // 15 min — plan-specified
const MAX_HEADLINES_PER_FEED = 25;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ---------------- symbol → company-name aliases (India universe) ----------------
// Headlines say "Infosys", the scanner says "INFY" — the matcher
// needs both. Word-boundary regexes are built per term at match time.
const SYMBOL_ALIASES = {
  HDFCBANK: ['hdfc bank', 'hdfcbank'], ICICIBANK: ['icici bank', 'icici'], SBIN: ['sbi', 'state bank'],
  AXISBANK: ['axis bank'], KOTAKBANK: ['kotak'], INDUSINDBK: ['indusind'],
  INFY: ['infosys', 'infy'], TCS: ['tcs', 'tata consultancy'], WIPRO: ['wipro'], HCLTECH: ['hcl tech', 'hcl technologies'],
  TECHM: ['tech mahindra'], RELIANCE: ['reliance industries', 'reliance', 'ril'],
  ONGC: ['ongc'], BPCL: ['bpcl'], NTPC: ['ntpc'], POWERGRID: ['power grid'],
  COALINDIA: ['coal india'], MARUTI: ['maruti', 'maruti suzuki'], TATAMOTORS: ['tata motors'],
  EICHERMOT: ['eicher motors'], HEROMOTOCO: ['hero motocorp', 'hero moto'], 'BAJAJ-AUTO': ['bajaj auto'],
  SUNPHARMA: ['sun pharma'], CIPLA: ['cipla'], DRREDDY: ['dr reddy', 'dr. reddy'], DIVISLAB: ["divi's lab", 'divis lab'],
  HINDUNILVR: ['hindustan unilever', 'hul'], ITC: ['itc'], NESTLEIND: ['nestle india', 'nestle'],
  BAJFINANCE: ['bajaj finance'], BAJAJFINSV: ['bajaj finserv'], SBILIFE: ['sbi life'], HDFCLIFE: ['hdfc life'],
  SHRIRAMFIN: ['shriram finance'], TATASTEEL: ['tata steel'], JSWSTEEL: ['jsw steel'], HINDALCO: ['hindalco'],
  LT: ['larsen', 'l&t', 'larsen & toubro'], ULTRACEMCO: ['ultratech'], GRASIM: ['grasim'],
  ADANIENT: ['adani enterprises'], ADANIPORTS: ['adani ports', 'adani port'], BHARTIARTL: ['bharti airtel', 'airtel'],
  ASIANPAINT: ['asian paints'], TITAN: ['titan company', 'titan'],
};

// ---------------- news lexicon (weighted, compact) ----------------
// Phrases score first (more specific), then single words with
// word boundaries. Weights ~ news-move half-life, not precision.
const LEX_BULL_PHRASES = [
  ['record high', 3], ['all-time high', 3], ['upper circuit', 3], ['stake buy', 2.5],
  ['order win', 2.5], ['contract win', 2.5], ['buy rating', 2], ['target raised', 2.5],
  ['profit surges', 3], ['profit surge', 3], ['jumps on', 2], ['rally on', 2], ['beats estimates', 2.5],
  ['beats estimate', 2.5], ['top gainer', 2], ['strong buy', 2.5],
];
const LEX_BULL_WORDS = [
  ['surge', 2], ['surges', 2], ['rally', 2], ['rallies', 2], ['soar', 2], ['soars', 2],
  ['jump', 1.5], ['jumps', 1.5], ['gain', 1], ['gains', 1.5], ['beat', 1], ['beats', 1.5],
  ['upgrade', 2], ['upgraded', 2], ['outperform', 1.5], ['bullish', 2], ['breakout', 1.5],
  ['buyback', 1.5], ['dividend', 0.5], ['expansion', 0.5], ['recovery', 1], ['rebounds', 1.5],
];
const LEX_BEAR_PHRASES = [
  ['plunges', 3], ['sell-off', 2.5], ['selloff', 2.5], ['lower circuit', 3], ['block deal', 0.5],
  ['profit booking', 1.5], ['misses estimates', 2.5], ['misses estimate', 2.5], ['target cut', 2.5],
  ['falls on', 2], ['drops on', 2], ['probe', 1.5], ['stake sale', 1], ['fraud', 3], ['scam', 3],
];
const LEX_BEAR_WORDS = [
  ['plunge', 2.5], ['crash', 2.5], ['crashes', 2.5], ['slump', 1.5], ['slumps', 1.5],
  ['tumble', 2], ['tumbles', 2], ['fall', 1], ['falls', 1.5], ['drop', 1.5], ['drops', 1.5],
  ['miss', 1], ['misses', 1.5], ['downgrade', 2], ['downgraded', 2], ['underperform', 1.5],
  ['bearish', 2], ['breakdown', 1.5], ['loss', 1], ['losses', 1.5], ['weak', 0.5],
  ['penalty', 1.5], ['raid', 2], ['resigns', 1], ['warning', 1],
];

// ---------------- cache ----------------
// { INDIA: {at, score, bySymbol, headlineCount, sources, refinedBy},
//   CRYPTO: {at, score, fng, fngLabel, fundingBps8h, sources, refinedBy} }
const _cache = new Map();
const _inflight = new Map();

function cacheGet(market) {
  const c = _cache.get(market);
  return c && Date.now() - c.at < CACHE_TTL ? c : null;
}

// ---------------- fetchers (defensive, allSettled) ----------------
async function fetchText(url, timeoutMs = 8000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** Pull RSS <item><title> entries (regex parse — RSS XML is stable
 *  enough for titles; a full XML parser is not worth the dependency). */
async function fetchHeadlines() {
  const feeds = await Promise.allSettled(RSS_FEEDS.map((u) => fetchText(u)));
  const titles = [];
  const okSources = [];
  feeds.forEach((res, i) => {
    if (res.status !== 'fulfilled' || typeof res.value !== 'string') return;
    const xml = res.value;
    let n = 0;
    const re = /<item[\s>][\s\S]*?<title>([\s\S]*?)<\/title>/gi;
    let m;
    while ((m = re.exec(xml)) && n < MAX_HEADLINES_PER_FEED) {
      const title = m[1]
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .trim();
      if (title && title.length > 10) { titles.push(title); n++; }
    }
    if (n > 0) okSources.push(new URL(RSS_FEEDS[i]).hostname);
  });
  return { titles, okSources };
}

async function fetchFearGreed() {
  const txt = await fetchText(FNG_URL, 6000);
  const j = JSON.parse(txt);
  const d = Array.isArray(j?.data) ? j.data[0] : null;
  const v = d ? Number(d.value) : NaN;
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('bad fng payload');
  return { value: Math.round(v), label: String(d.value_classification || '') };
}

/** Average BTC+ETH perp funding (8h rate, decimal) in bps. */
async function fetchFundingBps() {
  const rs = await Promise.allSettled(['BTC', 'ETH'].map((s) => fetchText(FUNDING_URL(s), 6000)));
  const vals = rs.filter(r => r.status === 'fulfilled')
    .map(r => { try { return Number(JSON.parse(r.value)?.lastFundingRate); } catch { return NaN; } })
    .filter(v => Number.isFinite(v));
  if (vals.length === 0) throw new Error('funding unreachable');
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(avg * 10000 * 100) / 100; // decimal → bps (8h)
}

// ---------------- lexicon scoring ----------------
function scoreHeadline(title) {
  const t = ` ${title.toLowerCase()} `;
  let s = 0;
  for (const [p, w] of LEX_BULL_PHRASES) if (t.includes(p)) s += w;
  for (const [p, w] of LEX_BEAR_PHRASES) if (t.includes(p)) s -= w;
  for (const [w_, weight] of LEX_BULL_WORDS) if (new RegExp(`\\b${w_}\\b`).test(t)) s += weight;
  for (const [w_, weight] of LEX_BEAR_WORDS) if (new RegExp(`\\b${w_}\\b`).test(t)) s -= weight;
  // per-headline saturation: ±6 → ±100 scale
  return Math.max(-100, Math.min(100, (s / 6) * 100));
}

function matchesSymbol(titleLower, symbol) {
  const terms = [...(SYMBOL_ALIASES[symbol] || []), symbol.toLowerCase()];
  return terms.some((term) => {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(titleLower);
  });
}

// ---------------- the refresh (async, cached, single-flight) ----------------
async function refreshIndia() {
  const { titles, okSources } = await fetchHeadlines();
  if (titles.length === 0) return null; // feeds unreachable → honest abstain
  let mSum = 0, mN = 0;
  const bySymbol = {};
  for (const title of titles) {
    const sc = scoreHeadline(title);
    mSum += sc; mN++;
    const lower = title.toLowerCase();
    for (const [sym] of Object.entries(SYMBOL_ALIASES)) {
      if (matchesSymbol(lower, sym)) {
        bySymbol[sym] = bySymbol[sym] || { sum: 0, n: 0, top: [] };
        bySymbol[sym].sum += sc;
        bySymbol[sym].n += 1;
        if (Math.abs(sc) > 20 && bySymbol[sym].top.length < 3) bySymbol[sym].top.push(title.slice(0, 90));
      }
    }
  }
  const marketScore = mN > 0 ? Math.round((mSum / mN) * 2.2) : 0; // market mood, amplified (avg headline is mild)
  return {
    at: Date.now(), market: 'INDIA', score: Math.max(-100, Math.min(100, marketScore)),
    bySymbol: Object.fromEntries(Object.entries(bySymbol).map(([k, v]) => [k, {
      score: Math.max(-100, Math.min(100, Math.round((v.sum / v.n) * 1.6))),
      headlines: v.n, top: v.top,
    }])),
    headlineCount: titles.length, sources: okSources, refinedBy: null,
  };
}

async function refreshCrypto() {
  const [fngR, fundR] = await Promise.allSettled([fetchFearGreed(), fetchFundingBps()]);
  if (fngR.status !== 'fulfilled' && fundR.status !== 'fulfilled') return null;
  let score = 0;
  const parts = [];
  let fng = null, fngLabel = null, fundingBps8h = null;
  if (fngR.status === 'fulfilled') {
    fng = fngR.value.value; fngLabel = fngR.value.label;
    // Fear & Greed read: contrarian at the extremes, mild
    // continuation in the meat of the range.
    if (fng <= 24) { score += 40; parts.push(`F&G ${fng} Extreme Fear — contrarian long territory`); }
    else if (fng <= 44) { score -= 10; parts.push(`F&G ${fng} (${fngLabel}) — fear persists`); }
    else if (fng >= 76) { score -= 40; parts.push(`F&G ${fng} Extreme Greed — contrarian short territory`); }
    else if (fng >= 56) { score += 10; parts.push(`F&G ${fng} (${fngLabel}) — greed/momentum`); }
    else parts.push(`F&G ${fng} neutral zone`);
  } else parts.push('F&G unreachable');
  if (fundR.status === 'fulfilled') {
    fundingBps8h = fundR.value; // bps per 8h
    if (fundingBps8h > 10) { score -= 22; parts.push(`perp funding +${r1(fundingBps8h)}bps/8h — crowded longs pay`); }
    else if (fundingBps8h < -3) { score += 22; parts.push(`perp funding ${r1(fundingBps8h)}bps/8h — shorts pay, squeeze fuel`); }
    else parts.push(`perp funding ${r1(fundingBps8h)}bps/8h — balanced`);
  } else parts.push('funding unreachable');
  return {
    at: Date.now(), market: 'CRYPTO',
    score: Math.max(-100, Math.min(100, Math.round(score))),
    fng, fngLabel, fundingBps8h, sources: parts, refinedBy: null,
  };
}

/**
 * Warm the sentiment cache for a market ('INDIA' | 'CRYPTO' — FUTURES
 * reads the CRYPTO cache, perps share crypto sentiment). Single-flight,
 * 15-min TTL. Resolves to the fresh cache entry or null when every
 * source is unreachable (the vote then abstains honestly).
 */
export async function refreshSentiment(market) {
  const mkt = market === 'INDIA' ? 'INDIA' : 'CRYPTO';
  const hit = cacheGet(mkt);
  if (hit) return hit;
  if (_inflight.has(mkt)) return _inflight.get(mkt);
  const p = (async () => {
    try {
      const fresh = mkt === 'INDIA' ? await refreshIndia() : await refreshCrypto();
      if (fresh) _cache.set(mkt, fresh);
      return fresh;
    } catch {
      return null;
    } finally { _inflight.delete(mkt); }
  })();
  _inflight.set(mkt, p);
  return p;
}

// ---------------- the VOTE (sync, models.js contract) ----------------
/**
 * SentimentPulse — ensemble seat #12.
 * dir ∈ {-1,0,1}, conf 0-100, honest abstain on cold cache.
 */
export function sentimentVote(ctx) {
  const mkt = ctx?.market === 'INDIA' ? 'INDIA' : 'CRYPTO';
  const c = cacheGet(mkt);
  if (!c) {
    return vote(0, 0, [mkt === 'INDIA' ? 'News feeds unreachable — SentimentPulse abstains (honest degrade)' : 'Fear&Greed/funding unreachable — SentimentPulse abstains']);
  }
  const symbol = String(ctx?.symbol || '').toUpperCase();
  let score = c.score;
  const reasons = [];
  if (mkt === 'INDIA') {
    const per = c.bySymbol?.[symbol];
    if (per) {
      // 65% own-headlines + 35% market mood — a stock with its own
      // news leads, the tape still matters.
      score = Math.round((per.score * 0.65 + c.score * 0.35));
      reasons.push(`${symbol}: ${per.headlines} recent headline${per.headlines === 1 ? '' : 's'}, news score ${per.score > 0 ? '+' : ''}${per.score}`);
      if (per.top?.length) reasons.push(`e.g. "${per.top[0]}"`);
    } else {
      reasons.push(`no ${symbol}-specific headlines in ${c.headlineCount} scanned — voting the market mood only`);
      score = Math.round(c.score * 0.6); // less signal → weaker vote
    }
    reasons.push(`India headline mood ${c.score > 0 ? '+' : ''}${c.score} (${c.sources?.join(', ') || 'rss'})`);
  } else {
    reasons.push(...(c.sources || []));
  }
  if (c.refinedBy) reasons.push(`LLM-refined by ${c.refinedBy} (AI Council pass)`);
  const dir = score >= 15 ? 1 : score <= -15 ? -1 : 0;
  if (dir === 0) return vote(0, 0, [...reasons, 'sentiment muddled — abstaining rather than guessing']);
  // Deliberately low ceiling (58): this is a 0.7-weight context
  // model, never the loudest voice in the room.
  const conf = 38 + Math.min(20, Math.abs(score) * 0.16);
  return vote(dir, conf, reasons);
}

// ---------------- AI Council reuse (no extra LLM cost) ----------------
/** 1-2 prompt lines for the SAME council call — headlines context. */
export function sentimentContextFor(market) {
  const mkt = market === 'INDIA' ? 'INDIA' : 'CRYPTO';
  const c = cacheGet(mkt);
  if (!c) return null;
  if (mkt === 'INDIA') {
    const hottest = Object.entries(c.bySymbol || {})
      .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score)).slice(0, 3)
      .map(([s, v]) => `${s} ${v.score > 0 ? '+' : ''}${v.score}`);
    return `News sentiment desk (RSS lexicon, ${c.headlineCount} headlines scanned): market mood ${c.score > 0 ? '+' : ''}${c.score}${hottest.length ? `; most-mentioned: ${hottest.join(', ')}` : ''}.`;
  }
  return `Crypto sentiment desk: ${c.sources?.join(' · ') || 'no data'}; composite ${c.score > 0 ? '+' : ''}${c.score}.`;
}

/** Fold the council's optional `sentiment` block into the cache for
 *  the NEXT cycle (plan: extend the same LLM call — tolerant parse). */
export function absorbCouncilSentiment(parsed, market) {
  try {
    const mkt = market === 'INDIA' ? 'INDIA' : 'CRYPTO';
    const c = _cache.get(mkt);
    if (!c || !parsed || typeof parsed !== 'object') return false;
    const s = Number(parsed.score);
    if (!Number.isFinite(s) || Math.abs(s) > 100) return false;
    // 50/50 blend of lexicon + LLM read — the LLM sees the same
    // headlines with better semantics, the lexicon keeps it grounded.
    c.score = Math.max(-100, Math.min(100, Math.round((c.score + s) / 2)));
    c.refinedBy = String(parsed.model || 'council');
    if (parsed.note) c.note = String(parsed.note).slice(0, 120);
    c.at = Date.now(); // hold the entry fresh through this cycle
    return true;
  } catch { return false; }
}

// ---------------- transparency ----------------
export function sentimentStatus() {
  const out = { enabled: true, ttlMin: CACHE_TTL / 60000, markets: {} };
  for (const m of ['INDIA', 'CRYPTO']) {
    const c = _cache.get(m);
    out.markets[m] = c ? {
      ageMin: Math.round((Date.now() - c.at) / 60000), score: c.score,
      ...(m === 'INDIA' ? { headlines: c.headlineCount, symbolsMentioned: Object.keys(c.bySymbol || {}).length } : { fng: c.fng, fngLabel: c.fngLabel, fundingBps8h: c.fundingBps8h }),
      refinedBy: c.refinedBy || null,
    } : null;
  }
  return out;
}

export const __testables = {
  _cache, cacheGet, scoreHeadline, matchesSymbol, SYMBOL_ALIASES,
  __setCache(mkt, entry) { _cache.set(mkt, { at: Date.now(), ...entry }); },
  __clear() { _cache.clear(); _inflight.clear(); },
};
