// ============================================================
// server/ai/correlation.js — CROSS-ASSET CORRELATION MATRIX (v6.11)
// ------------------------------------------------------------
// Glama-inspired (oneqaz "cross-asset correlations" + staskh
// "price_correlation"): 60-day daily-return Pearson correlations
// across the desk's whole world — NIFTY + NSE sector indices +
// global risk proxies (GOLD/CRUDE/DXY/USVIX) + crypto majors.
//
// Why a trader cares: a long INDIA IT + short BTC portfolio is
// ONE bet in disguise when the 60d correlation is +0.7. The
// matrix makes hidden concentration visible BEFORE the risk
// report has to. Crypto majors also get an India-link read
// (BTC↔NIFTY) — the "risk-on/risk-off" channel.
//
// Honesty: an unreachable Yahoo ticker is DROPPED (not zero-filled
// — a fake 0 correlation is a lie that looks like information).
// Pairs with < 40 overlapping returns are skipped. 15-min cache.
// ============================================================
import { fetchYahooDailyCloses, YF_SYMBOL } from './data.js';

const ASSETS = [
  { key: 'NIFTY', label: 'NIFTY 50', group: 'INDEX' },
  { key: 'BANKNIFTY', label: 'Bank Nifty', group: 'INDEX' },
  { key: 'IT', label: 'NSE IT', group: 'SECTOR' },
  { key: 'AUTO', label: 'NSE Auto', group: 'SECTOR' },
  { key: 'PHARMA', label: 'NSE Pharma', group: 'SECTOR' },
  { key: 'FMCG', label: 'NSE FMCG', group: 'SECTOR' },
  { key: 'METAL', label: 'NSE Metal', group: 'SECTOR' },
  { key: 'GOLD', label: 'Gold', group: 'GLOBAL' },
  { key: 'CRUDE', label: 'Crude Oil', group: 'GLOBAL' },
  { key: 'DXY', label: 'Dollar Index', group: 'GLOBAL' },
  { key: 'USVIX', label: 'US VIX', group: 'GLOBAL' },
  { key: 'BTC', label: 'Bitcoin', group: 'CRYPTO' },
  { key: 'ETH', label: 'Ethereum', group: 'CRYPTO' },
];
const MIN_OVERLAP = 40;
const WINDOW = 60;          // daily returns used
const CACHE_TTL = 15 * 60 * 1000;

let _cache = null, _cacheAt = 0;

/** Daily simple returns from a close series (oldest-first). */
export function returnsOf(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

/** Pearson correlation of equal-length arrays. */
export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a2 = x[i] - mx, b2 = y[i] - my;
    num += a2 * b2; dx += a2 * a2; dy += b2 * b2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
}

export async function correlationMatrix() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;

  const closes = {};
  await Promise.allSettled(ASSETS.map(async a => {
    const yk = YF_SYMBOL(a.key);
    if (!yk) return;
    const c = await fetchYahooDailyCloses(yk, '4mo');
    if (c.length >= MIN_OVERLAP + 1) closes[a.key] = c;
  }));

  const live = ASSETS.filter(a => closes[a.key]);
  const rets = {};
  for (const a of live) rets[a.key] = returnsOf(closes[a.key]).slice(-WINDOW);

  // symmetric matrix (null = insufficient overlap — shown as '—')
  const matrix = live.map(a => live.map(b => {
    const ra = rets[a.key], rb = rets[b.key];
    const overlap = Math.min(ra.length, rb.length);
    return overlap >= MIN_OVERLAP ? pearson(ra, rb) : null;
  }));

  // interesting pairs (upper triangle, cross-group + within-group)
  const pairs = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const v = matrix[i][j];
      if (v != null) pairs.push({ a: live[i].key, b: live[j].key, groupA: live[i].group, groupB: live[j].group, r: v });
    }
  }
  const byR = [...pairs].sort((x, y) => y.r - x.r);
  const btcNifty = pairs.find(p => (p.a === 'BTC' && p.b === 'NIFTY') || (p.a === 'NIFTY' && p.b === 'BTC')) || null;
  const readLink = (r) => {
    if (r == null) return 'data overlap kam hai — link abhi measure nahi ho paya';
    if (r >= 0.5) return 'strong positive — crypto risk-on/off India ke saath move kar raha hai (ek hi "risk" bet lag raha hai)';
    if (r >= 0.2) return 'mild positive — dono ek hi risk regime me hain, diversification partial';
    if (r > -0.2) return 'near-zero — BTC India book ke liye real diversifier hai';
    return 'negative — BTC India weakness ke against hedge jaisa behave kar raha hai';
  };

  const out = {
    ok: true,
    asOf: Date.now(),
    window: WINDOW,
    assets: live.map(a => ({ key: a.key, label: a.label, group: a.group })),
    skipped: ASSETS.filter(a => !closes[a.key]).map(a => a.key),
    matrix,
    top: {
      mostPositive: byR.slice(0, 3),
      mostNegative: byR.slice(-3).reverse(),
    },
    riskLink: btcNifty ? { pair: 'BTC↔NIFTY', r: btcNifty.r, read: readLink(btcNifty.r) } : null,
    note: '60 din ke daily-return Pearson correlations. Skipped tickers honest-empty hain (host-block ya thin data) — 0 se fill nahi kiya. Correlation diversification ka INPUT hai, prediction nahi.',
  };
  _cache = out; _cacheAt = Date.now();
  return out;
}

export const __testables = { ASSETS, MIN_OVERLAP, WINDOW };

// ---------------- v10.1 B4: PAIR-LEVEL CORRELATION ----------------
// The matrix above is index/asset level; the agent's correlation guard
// needs COIN-vs-COIN reads (e.g. SOL candidate vs the BTC position the
// book already holds). Same math (60d daily returns, Pearson), same
// honesty (unreachable data → null, never a fake 0), cached per
// unordered pair for 15 min.
const _pairCache = new Map(); // "A|B" → { r, at }

/**
 * 60-day daily-return Pearson correlation between two crypto bases.
 * @returns {number|null} r in [-1,1], null when data is unavailable
 *   for either side (the caller must treat null as UNKNOWN, not 0).
 */
export async function pairCorrelation(baseA, baseB) {
  const a = String(baseA || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const b = String(baseB || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!a || !b || a === b) return a === b && a ? 1 : null;
  const key = [a, b].sort().join('|');
  const hit = _pairCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.r;
  const [ca, cb] = await Promise.all([
    fetchYahooDailyCloses(`${a}-USD`, '4mo').catch(() => null),
    fetchYahooDailyCloses(`${b}-USD`, '4mo').catch(() => null),
  ]);
  if (!Array.isArray(ca) || !Array.isArray(cb)) return null; // unknown, not zero
  const ra = returnsOf(ca).slice(-WINDOW);
  const rb = returnsOf(cb).slice(-WINDOW);
  if (Math.min(ra.length, rb.length) < MIN_OVERLAP) return null;
  const r = pearson(ra, rb);
  if (r != null) _pairCache.set(key, { r, at: Date.now() });
  return r;
}
