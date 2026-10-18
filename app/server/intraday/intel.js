// ============================================================
// intraday/intel — External FREE market-intelligence engine
// (verified keyless sources — 2026-09 v4.6)
// ------------------------------------------------------------
// Powers GET /api/intraday-intel:
//   • CoinLobster MCP (https://coinlobster.com/mcp — keyless,
//     stateless JSON-RPC, free caps verified via my_access):
//       – market_digest  → whale leaders (net $ flow), unusual-flow
//                          radar, forced liquidations, top movers
//       – market_movers  → 24h gainers/losers board (~300 coins)
//       – whale_radar    → per-coin UNUSUAL whale flow flags
//   • CoinGecko REST (keyless, 10-30 calls/min) → search/trending
//     (retail interest gauge — leading indicator vs price movers)
//   • alternative.me Fear & Greed Index (keyless, daily)
//   • HONEST source registry: Tapetide (401 — Bearer auth, paid),
//     Upstox demo URL (dead 404 — listing-article hoax), Bitget
//     datahub (server alive, upstream tools timeout/dead) are NOT
//     called — status surfaced so the UI stays honest.
// Pure functions (parse*/intelAnalysis) — vitest covered without
// network. Impure fetchers carry 3-fail circuit breakers + 15s
// timeouts so a dead source can never stall the route.
// ============================================================

const COINLOBSTER_URL = 'https://coinlobster.com/mcp';
const COINGECKO_TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';

const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : '');

/** $-flow humanizer: 1234567 → "$1.23M" */
export function fmtUsdFlow(v) {
  const n = num(v);
  if (n == null) return null;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

// ------------------------------------------------------------
// SSE / JSON-RPC parsing (CoinLobster replies as
// "event: message data: {...}" — sometimes on ONE line).
// ------------------------------------------------------------
export function extractMcpJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const idx = text.indexOf('data:');
  if (idx >= 0) {
    const raw = text.slice(idx + 5).trim();
    try { return JSON.parse(raw); } catch { /* multi-frame below */ }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* next */ }
    }
  }
  try { return JSON.parse(text); } catch { return null; }
}

/** Parse a CoinLobster tools/call result text → the inner JSON payload. */
export function parseToolPayload(text) {
  const j = extractMcpJson(text);
  const inner = j?.result?.content?.map((c) => c.text || '').join('\n') || '';
  if (!inner) return null;
  try { return JSON.parse(inner); } catch { return null; }
}

// ------------------------------------------------------------
// PURE PARSERS — one per upstream shape, fully defensive.
// ------------------------------------------------------------

/** Fear & Greed: {"data":[{"value":"63","value_classification":"Greed",...}]} */
export function parseFearGreed(json) {
  const d = json?.data?.[0];
  const value = num(Number(d?.value));
  if (value == null) return null;
  const label = str(d?.value_classification) || 'Neutral';
  const zone = value <= 24 ? 'EXTREME FEAR' : value <= 44 ? 'FEAR'
    : value <= 55 ? 'NEUTRAL' : value <= 75 ? 'GREED' : 'EXTREME GREED';
  return { value, label: `${label} (${value})`, zone, rawLabel: label };
}

/**
 * CoinLobster market_digest → whale leaders, radar flags, movers,
 * liquidation skew (structured when present; summary-regex fallback).
 */
export function parseDigest(json) {
  if (!json || typeof json !== 'object') return null;
  const mapLeader = (x) => ({
    coin: str(x?.coin).toUpperCase(),
    netUsd24h: num(x?.net_usd_24h),
  });
  const buyers = (json.whale_leaders?.buyers || []).map(mapLeader).filter((x) => x.coin);
  const sellers = (json.whale_leaders?.sellers || []).map(mapLeader).filter((x) => x.coin);
  const radarNow = (json.radar_now || []).map((x) => ({
    coin: str(x?.coin).toUpperCase(),
    window: str(x?.window) || '1h',
    direction: str(x?.direction) || 'buy',
    unusual: !!x?.unusual,
    locked: !!x?.locked,
  })).filter((x) => x.coin);
  const topMovers = (json.top_movers || []).map((x) => ({
    coin: str(x?.coin).toUpperCase(),
    priceUsd: num(x?.price_usd),
    chgPct24h: num(x?.chg_24h_pct),
  })).filter((x) => x.coin).slice(0, 6);

  // Forced liquidations — structured field first, summary regex fallback.
  let liqLongUsd = num(json.liquidations?.usd_24h_long ?? json.liquidations_24h_long);
  let liqShortUsd = num(json.liquidations?.usd_24h_short ?? json.liquidations_24h_short);
  if (liqLongUsd == null && liqShortUsd == null) {
    const m = /forced closes\s*\$?([\d.]+)\s*([KMB])?\s*(long|short)-side/i.exec(str(json.summary));
    if (m) {
      const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] || 1;
      const val = parseFloat(m[1]) * mult;
      if (m[3].toLowerCase() === 'long') liqLongUsd = val; else liqShortUsd = val;
    }
  }
  return { buyers, sellers, radarNow, topMovers, liqLongUsd, liqShortUsd, summary: str(json.summary) };
}

/** CoinLobster market_movers → gainers/losers board. */
export function parseMovers(json) {
  if (!json || !Array.isArray(json.gainers)) return null;
  const mapRow = (x) => ({
    coin: str(x?.coin).toUpperCase(),
    priceUsd: num(x?.price_usd),
    chgPct24h: num(x?.chg_24h_pct),
    volUsd24h: num(x?.vol_usd_24h),
  });
  return {
    gainers: (json.gainers || []).map(mapRow).filter((x) => x.coin).slice(0, 10),
    losers: (json.losers || []).map(mapRow).filter((x) => x.coin).slice(0, 10),
  };
}

/** CoinLobster whale_radar → unusual-flow windows (1h/4h). */
export function parseRadar(json) {
  if (!json || typeof json !== 'object') return null;
  const out = [];
  for (const winName of ['1h', '4h']) {
    for (const x of json.windows?.[winName] || []) {
      out.push({
        coin: str(x?.coin).toUpperCase(),
        window: winName,
        netUsd: num(x?.netUsd),
        buyUsd: num(x?.buyUsd),
        sellUsd: num(x?.sellUsd),
      });
    }
  }
  return out.filter((x) => x.coin).slice(0, 12);
}

/** CoinGecko search/trending → retail-interest coins. */
export function parseTrending(json) {
  if (!json || !Array.isArray(json.coins)) return null;
  return json.coins.map((c) => {
    const it = c?.item || {};
    const chg = it?.data?.price_change_percentage_24h;
    return {
      symbol: str(it.symbol).toUpperCase(),
      name: str(it.name),
      rank: num(it.market_cap_rank),
      chgPct24hUsd: num(chg?.usd),
    };
  }).filter((x) => x.symbol).slice(0, 8);
}

// ------------------------------------------------------------
// DEEP ANALYSIS — deterministic Hinglish verdicts (zero AI tokens).
// ------------------------------------------------------------
export function intelAnalysis(parts) {
  const { fearGreed, digest, movers, trending } = parts || {};
  const bullets = [];
  let bias = 'NEUTRAL';
  let score = 0;

  // --- 1. Sentiment (Fear & Greed) ---
  let sentiment = null;
  if (fearGreed) {
    const { value, zone } = fearGreed;
    let note = '';
    if (value <= 24) { note = 'extreme fear — historically a contrarian BUY zone, panic already priced'; score += 2; }
    else if (value <= 44) { note = 'fear zone — weak hands exiting, quality dips possible'; score += 1; }
    else if (value <= 55) { note = 'neutral — no crowd edge, follow levels not mood'; }
    else if (value <= 75) { note = 'greed zone — trail stops tight, chase nahi karo'; score -= 1; }
    else { note = 'extreme greed — historically a contrarian SELL/euphoria zone'; score -= 2; }
    sentiment = { zone, value, note };
    bullets.push(`Sentiment: ${fearGreed.rawLabel} (${value}/100) — ${note}`);
  }

  // --- 2. Whale net-flow ---
  let whales = null;
  if (digest && (digest.buyers.length || digest.sellers.length)) {
    const buySum = digest.buyers.reduce((s, x) => s + (x.netUsd24h || 0), 0);
    const sellSum = digest.sellers.reduce((s, x) => s + (x.netUsd24h || 0), 0); // negative values
    const net = buySum + sellSum;
    const dir = net > 0 ? 'ACCUMULATION' : net < 0 ? 'DISTRIBUTION' : 'FLAT';
    whales = { netUsd: r2(net), direction: dir, buySumUsd: r2(buySum), sellSumUsd: r2(sellSum) };
    score += net > 0 ? 1 : net < 0 ? -1 : 0;
    bullets.push(`Whale flow: ${dir} — net ${fmtUsdFlow(net)} (top buyers ${digest.buyers.slice(0, 2).map((x) => x.coin).join(', ') || '—'}; top sellers ${digest.sellers.slice(0, 2).map((x) => x.coin).join(', ') || '—'})`);
    // Cross-check sentiment vs whales (the interesting contradiction).
    if (fearGreed && fearGreed.value <= 44 && net > 0) {
      bullets.push('Divergence: crowd FEARS while whales ACCUMULATE — smart-money buy-the-fear setup');
      score += 1;
    } else if (fearGreed && fearGreed.value >= 56 && net < 0) {
      bullets.push('Divergence: crowd GREEDY while whales DISTRIBUTE — distribution-into-euphoria risk');
      score -= 1;
    }
  }

  // --- 3. Liquidation skew ---
  let liq = null;
  if (digest && (digest.liqLongUsd != null || digest.liqShortUsd != null)) {
    const l = digest.liqLongUsd || 0;
    const s = digest.liqShortUsd || 0;
    const total = l + s;
    if (total > 0) {
      const longShare = Math.round((l / total) * 100);
      liq = { longUsd: r2(l), shortUsd: r2(s), longSharePct: longShare };
      if (longShare >= 65) {
        bullets.push(`Liquidations: ${longShare}% long-side ($${(l / 1e6).toFixed(0)}M flushed) — long squeeze ho chuka, bounce fuel ready`);
        score += 1; // post-flush = cleaner positioning
      } else if (longShare <= 35) {
        bullets.push(`Liquidations: ${100 - longShare}% short-side — short squeeze chal raha, FOMO spike ke liye alert`);
        score -= 1; // squeeze spikes are unstable
      } else {
        bullets.push(`Liquidations: balanced ${longShare}/$100 long/short — koi ek side clean flushed nahi`);
      }
    }
  }

  // --- 4. Retail vs whale divergence (trending vs movers) ---
  if (trending && trending.length && digest && digest.topMovers.length) {
    const trendSet = new Set(trending.map((t) => t.symbol));
    const moverSet = new Set(digest.topMovers.map((m) => m.coin));
    const overlap = [...trendSet].filter((s) => moverSet.has(s));
    if (overlap.length >= 2) {
      bullets.push(`Retail-whale overlap: ${overlap.slice(0, 3).join(', ')} dono lists me — hot momentum, both crowds chasing`);
    } else if (overlap.length === 0) {
      bullets.push('Retail-whale divergence: trending coins aur price movers alag-alag — moves abhi broad nahi, selective');
    }
  }

  // --- 5. Movers sanity (thin-volume pump warning) ---
  if (movers && movers.gainers.length) {
    const thin = movers.gainers.filter((g) => (g.chgPct24h || 0) > 30 && (g.volUsd24h == null || g.volUsd24h < 5e6));
    if (thin.length >= 2) {
      bullets.push(`Pump-check: ${thin.slice(0, 2).map((t) => t.coin).join(', ')} +30% moves thin/unknown volume ke saath — exit liquidity trap risk`);
      score -= 1;
    }
  }

  bias = score >= 2 ? 'RISK-ON' : score <= -2 ? 'RISK-OFF' : score >= 1 ? 'CAUTIOUS-BULLISH' : score <= -1 ? 'CAUTIOUS-BEARISH' : 'NEUTRAL';
  const verdict = bias === 'RISK-ON' ? 'External intel supports LONG bias — size normal, levels follow karo'
    : bias === 'RISK-OFF' ? 'External intel RISK-OFF hai — fresh longs avoid, wait for flush ya F&G reset'
    : bias === 'CAUTIOUS-BULLISH' ? 'External intel mildly bullish — selective entries, tight stops'
    : bias === 'CAUTIOUS-BEARISH' ? 'External intel mildly bearish — rallies sell zone, longs chhote rakho'
    : 'External intel mixed — levels-based trading karo, sentiment edge nahi';

  return { bullets, bias, verdict, sentiment, whales, liquidations: liq, score };
}

// ------------------------------------------------------------
// IMPURE FETCHERS — timeouts + 3-fail circuit breakers.
// ------------------------------------------------------------

function makeBreaker(threshold = 3, cooldownMs = 5 * 60 * 1000) {
  const st = { fails: 0, openedAt: 0 };
  return {
    canTry() { return st.fails < threshold || (Date.now() - st.openedAt) > cooldownMs; },
    ok() { st.fails = 0; },
    fail() {
      st.fails += 1;
      if (st.fails >= threshold) st.openedAt = Date.now();
    },
    state() { return st.fails < threshold ? 'ok' : (Date.now() - st.openedAt) > cooldownMs ? 'half-open' : 'open'; },
  };
}

const CL_BREAKER = makeBreaker();
const CG_BREAKER = makeBreaker();
const FG_BREAKER = makeBreaker();

/** Stateless CoinLobster MCP tools/call (JSON-RPC over HTTP POST). */
async function coinLobsterCall(tool, args = {}, timeoutMs = 15000) {
  const res = await fetch(COINLOBSTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e6, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`CoinLobster HTTP ${res.status}`);
  const text = await res.text();
  const payload = parseToolPayload(text);
  if (!payload) throw new Error('CoinLobster payload unparsable');
  return payload;
}

export async function fetchCoinLobsterDigest() {
  if (!CL_BREAKER.canTry()) return null;
  try {
    const p = await coinLobsterCall('market_digest');
    const parsed = parseDigest(p);
    if (!parsed) throw new Error('digest shape invalid');
    CL_BREAKER.ok();
    return parsed;
  } catch (e) {
    CL_BREAKER.fail();
    console.warn('[intel] CoinLobster digest failed:', e?.message || e);
    return null;
  }
}

export async function fetchCoinLobsterMovers() {
  if (!CL_BREAKER.canTry()) return null;
  try {
    const p = await coinLobsterCall('market_movers');
    const parsed = parseMovers(p);
    if (!parsed) throw new Error('movers shape invalid');
    CL_BREAKER.ok();
    return parsed;
  } catch (e) {
    CL_BREAKER.fail();
    console.warn('[intel] CoinLobster movers failed:', e?.message || e);
    return null;
  }
}

export async function fetchCoinLobsterRadar() {
  if (!CL_BREAKER.canTry()) return null;
  try {
    const p = await coinLobsterCall('whale_radar');
    const parsed = parseRadar(p);
    CL_BREAKER.ok();
    return parsed;
  } catch (e) {
    CL_BREAKER.fail();
    console.warn('[intel] CoinLobster radar failed:', e?.message || e);
    return null;
  }
}

export async function fetchFearGreed() {
  if (!FG_BREAKER.canTry()) return null;
  try {
    const res = await fetch(FEAR_GREED_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`F&G HTTP ${res.status}`);
    const parsed = parseFearGreed(await res.json());
    FG_BREAKER.ok();
    return parsed;
  } catch (e) {
    FG_BREAKER.fail();
    console.warn('[intel] Fear&Greed failed:', e?.message || e);
    return null;
  }
}

export async function fetchCoinGeckoTrending() {
  if (!CG_BREAKER.canTry()) return null;
  try {
    const res = await fetch(COINGECKO_TRENDING_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 429) throw new Error('CoinGecko 429 rate-limited');
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const parsed = parseTrending(await res.json());
    if (!parsed) throw new Error('trending shape invalid');
    CG_BREAKER.ok();
    return parsed;
  } catch (e) {
    CG_BREAKER.fail();
    console.warn('[intel] CoinGecko trending failed:', e?.message || e);
    return null;
  }
}

// ------------------------------------------------------------
// HONEST source registry (verified 2026-09-03 from sandbox).
// ------------------------------------------------------------
export const SOURCE_REGISTRY = [
  { name: 'CoinLobster MCP', kind: 'MCP', expected: 'LIVE', note: 'Whales, liquidations, movers — keyless, free caps (25 rows)' },
  { name: 'CoinGecko', kind: 'REST', expected: 'LIVE', note: 'Trending coins — keyless, rate-limited (429-aware)' },
  { name: 'Fear & Greed (alternative.me)', kind: 'REST', expected: 'LIVE', note: 'Crypto sentiment index — keyless, daily' },
  { name: 'Tapetide MCP', kind: 'MCP', expected: 'AUTH', note: 'India stocks — OAuth account login (connectable: Intraday TAB → Tapetide Research desk)' },
  { name: 'Upstox MCP (demo)', kind: 'MCP', expected: 'DEAD', note: 'Listing URL 404 — not a real free server' },
  { name: 'Bitget Signal MCP', kind: 'MCP', expected: 'DEAD', note: 'Server responds but upstream tools timeout — skipped' },
];

/**
 * Aggregate builder — parallel fetch, all-settled, honest statuses.
 * Called by the route with a 60s cache; also exported for tests.
 */
export async function buildCryptoIntel() {
  const t0 = Date.now();
  const [fearGreed, digest, movers, radar, trending] = await Promise.all([
    fetchFearGreed(),
    fetchCoinLobsterDigest(),
    fetchCoinLobsterMovers(),
    fetchCoinLobsterRadar(),
    fetchCoinGeckoTrending(),
  ]);

  const analysis = intelAnalysis({ fearGreed, digest, movers, trending });

  const sources = SOURCE_REGISTRY.map((s) => ({
    ...s,
    status: s.expected === 'LIVE'
      ? (s.name.startsWith('CoinLobster') ? (digest || movers ? 'LIVE' : 'DOWN')
        : s.name.startsWith('CoinGecko') ? (trending ? 'LIVE' : 'DOWN')
        : (fearGreed ? 'LIVE' : 'DOWN'))
      : s.expected,
  }));

  return {
    ok: !!(fearGreed || digest || movers || trending),
    asOf: new Date().toISOString(),
    latencyMs: Date.now() - t0,
    fearGreed,
    digest,
    radar,
    movers,
    trending,
    analysis,
    sources,
  };
}
