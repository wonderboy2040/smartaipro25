// ============================================================
// server/ai/perpIntel.js — v12.0 PERP POSITIONING INTELLIGENCE
// ------------------------------------------------------------
// The derivatives-positioning engine for the CoinDCX GLOBAL
// FUTURES desk. Pro perp traders do not read price alone — they
// read WHO is positioned, HOW aggressively, and at WHAT carry:
//
//   • FUNDING       — the real cost of holding a side (crowded
//                     longs PAY; negative funding = squeeze fuel)
//   • OPEN INTEREST — OI↑+P↑ new longs (trend fuel) · OI↑+P↓
//                     new shorts · OI↓+P↑ short squeeze (fuel
//                     burning out) · OI↓+P↓ long unwind
//   • TOP-TRADER L/S RATIO — how the biggest accounts are lean
//   • TAKER BUY/SELL RATIO — who is crossing the spread right
//                     now (aggressive flow)
//
// All five come from Binance fapi's PUBLIC data endpoints (no
// key, same honest-reference stance as get_funding_rate /
// sentiment's fundingBps8h — CoinDCX publishes no public
// positioning endpoints). Every field degrades honestly: a
// blocked endpoint nulls ITS field, never the whole record.
//
// PURITY: readPerpPositioning(intel) is pure (object-in →
// read-out) — the OI/price matrix, taker flow and crowd logic
// are unit-testable (test/perpIntel.test.ts).
//
// Kill-switch: AI_DISABLE_PERP_INTEL=1 (default ON — all public
// endpoints, zero cost).
// ============================================================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const FAPI = 'https://fapi.binance.com';

const CACHE_TTL_MS = 60_000;          // positioning shifts intra-hour
const CACHE_MAX = 300;                // bounded — desk universes are ≤ ~50
const FETCH_TIMEOUT_MS = 6000;

const _cache = new Map();             // pair → {at, val}
const _inflight = new Map();          // pair → promise (single-flight)

export const perpIntelEnabled = () => !String(process.env.AI_DISABLE_PERP_INTEL || '').match(/^\s*(1|true|yes|on)\s*$/i);

// null/undefined → null (NEVER 0 — a missing field must not fire its
// read branch: no OI history ≠ "flat OI")
const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

async function _fapiJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`fapi HTTP ${r.status} @ ${url.replace(FAPI, '')}`);
  return r.json();
}

// ---------------- per-symbol intel (5 public calls, allSettled) ----------------
/**
 * One symbol's full positioning snapshot.
 * @param {string} base  e.g. 'BTC' (pair = BTCUSDT)
 * @returns {Promise<object>} honest-degrade record (ok:false on total failure)
 */
export async function getPerpIntel(base) {
  const pair = `${String(base || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}USDT`;
  if (!/^[A-Z0-9]{2,18}USDT$/.test(pair)) return { ok: false, base: String(base), pair, reason: 'invalid symbol' };

  const hit = _cache.get(pair);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;
  let p = _inflight.get(pair);
  if (p) return p;

  p = (async () => {
    const [prem, oi, oiHist, lsHist, takerHist] = await Promise.allSettled([
      _fapiJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${pair}`),
      _fapiJson(`${FAPI}/fapi/v1/openInterest?symbol=${pair}`),
      _fapiJson(`${FAPI}/futures/data/openInterestHist?symbol=${pair}&period=1h&limit=25`),
      _fapiJson(`${FAPI}/futures/data/topLongShortAccountRatio?symbol=${pair}&period=1h&limit=25`),
      _fapiJson(`${FAPI}/futures/data/takerlongshortRatio?symbol=${pair}&period=1h&limit=25`),
    ]);

    // funding / mark — the anchor; without it the record is useless
    if (prem.status !== 'fulfilled') {
      return {
        ok: false, base: String(base).toUpperCase(), pair, at: Date.now(),
        reason: `premiumIndex unreachable (${prem.reason?.message || prem.reason || 'network'})`,
      };
    }
    const markPrice = num(prem.value?.markPrice);
    const fundingRate8h = num(prem.value?.lastFundingRate);
    const fundingBps8h = fundingRate8h != null ? r2(fundingRate8h * 10_000) : null;

    // open interest (current, contracts)
    const openInterest = oi.status === 'fulfilled' ? num(oi.value?.openInterest) : null;

    // OI 24h history — also gives the implied price 24h ago
    // (price ≈ sumOpenInterestValue / sumOpenInterest per bucket)
    let oi24hAgo = null, oiChangePct24h = null, price24hAgo = null, change24hPct = null, oiValueUSDT = null;
    if (oiHist.status === 'fulfilled' && Array.isArray(oiHist.value) && oiHist.value.length >= 2) {
      const rows = oiHist.value;
      const last = rows[rows.length - 1];
      const first = rows[0];
      oiValueUSDT = num(last?.sumOpenInterestValue);
      const oiLast = num(last?.sumOpenInterest);
      const oiFirst = num(first?.sumOpenInterest);
      const valFirst = num(first?.sumOpenInterestValue);
      if (oiLast != null && oiFirst != null && oiFirst > 0) {
        oi24hAgo = oiFirst;
        oiChangePct24h = r2(((oiLast - oiFirst) / oiFirst) * 100);
      }
      if (valFirst != null && oiFirst != null && oiFirst > 0 && markPrice != null) {
        price24hAgo = r2(valFirst / oiFirst);
        if (price24hAgo > 0) change24hPct = r2(((markPrice - price24hAgo) / price24hAgo) * 100);
      }
    }

    // top-trader long/short ratio (current + 24h delta)
    let topLongShortRatio = null, topLongShortDelta24h = null;
    if (lsHist.status === 'fulfilled' && Array.isArray(lsHist.value) && lsHist.value.length >= 1) {
      const rows = lsHist.value;
      topLongShortRatio = r2(num(rows[rows.length - 1]?.longShortRatio));
      const first = num(rows[0]?.longShortRatio);
      if (first != null && first > 0 && topLongShortRatio != null) {
        topLongShortDelta24h = r2(((topLongShortRatio - first) / first) * 100);
      }
    }

    // taker buy/sell ratio — latest + 24h average (aggressive flow)
    let takerRatio24h = null, takerNow = null;
    if (takerHist.status === 'fulfilled' && Array.isArray(takerHist.value) && takerHist.value.length >= 1) {
      const rows = takerHist.value;
      const ratios = rows.map(x => num(x?.buySellRatio)).filter(v => v != null && v > 0);
      if (ratios.length > 0) {
        takerRatio24h = r2(ratios.reduce((a, b) => a + b, 0) / ratios.length);
        takerNow = r2(num(rows[rows.length - 1]?.buySellRatio));
      }
    }

    const intel = {
      ok: true, base: String(base).toUpperCase(), pair, at: Date.now(),
      markPrice, fundingRate8h, fundingBps8h, nextFundingTs: num(prem.value?.nextFundingTime) || null,
      openInterest, oiValueUSDT, oi24hAgo, oiChangePct24h, price24hAgo, change24hPct,
      topLongShortRatio, topLongShortDelta24h, takerRatio24h, takerNow,
      sources: {
        funding: 'binance-fapi-premiumIndex', oi: oi.status === 'fulfilled' ? 'binance-fapi-openInterest' : null,
        oiHist: oiHist.status === 'fulfilled' ? 'binance-fapi-openInterestHist' : null,
        topTraders: lsHist.status === 'fulfilled' ? 'binance-fapi-topLongShort' : null,
        taker: takerHist.status === 'fulfilled' ? 'binance-fapi-takerLongShort' : null,
      },
    };
    intel.read = readPerpPositioning(intel);
    return intel;
  })().catch(e => ({ ok: false, base: String(base).toUpperCase(), pair, at: Date.now(), reason: String(e?.message || e) }));

  _inflight.set(pair, p);
  const cleanup = () => _inflight.delete(pair);
  p.then(cleanup, cleanup);
  const val = await p;
  if (val?.ok) {
    if (_cache.size >= CACHE_MAX) { const k = _cache.keys().next().value; _cache.delete(k); }
    _cache.set(pair, { at: Date.now(), val });
  }
  return val;
}

// ---------------- PURE: the positioning read ----------------
/**
 * Derive the pro-trader positioning read from one intel record.
 * LONG-aligned score 0-100 (invert mentally for SHORT) + bias +
 * Hinglish reasons. PURE — unit-tested.
 *
 * Matrix (the classic OI×price 2×2):
 *   OI↑ P↑ → LONGS BUILDING   — trend has fresh fuel
 *   OI↑ P↓ → SHORTS BUILDING  — fresh shorts pressing
 *   OI↓ P↑ → SHORT SQUEEZE    — rally running on covering, fuel burns out
 *   OI↓ P↓ → LONG UNWIND      — selling pressure but exhausting
 */
export function readPerpPositioning(intel) {
  const i = intel || {};
  const reasons = [];
  let score = 50;
  let matrix = null;

  const oiChg = num(i.oiChangePct24h);
  const pChg = num(i.change24hPct);
  if (oiChg != null && pChg != null) {
    const oiUp = oiChg > 1.5, oiDown = oiChg < -1.5, pUp = pChg > 0.5, pDown = pChg < -0.5;
    if (oiUp && pUp) { matrix = 'LONGS_BUILDING'; score += 14; reasons.push(`OI ${r1(oiChg)}%↑ + price ${r1(pChg)}%↑ — naye longs trend ko fuel de rahe hain`); }
    else if (oiUp && pDown) { matrix = 'SHORTS_BUILDING'; score -= 14; reasons.push(`OI ${r1(oiChg)}%↑ + price ${r1(pChg)}%↓ — naye shorts pressure bana rahe hain`); }
    else if (oiDown && pUp) { matrix = 'SHORT_SQUEEZE'; score += 4; reasons.push(`OI ${r1(oiChg)}%↓ + price ${r1(pChg)}%↑ — short-covering rally, fuel jald khatam ho sakta hai`); }
    else if (oiDown && pDown) { matrix = 'LONG_UNWIND'; score -= 4; reasons.push(`OI ${r1(oiChg)}%↓ + price ${r1(pChg)}%↓ — long unwind, bechne ka pressure thak raha hai`); }
    else { matrix = 'FLAT'; reasons.push(`OI ${r1(oiChg)}% · price ${r1(pChg)}% — dono side range me, koi clear positioning nahi`); }
  }

  // aggressive taker flow (24h average — one-hour spikes alone mislead)
  const taker = num(i.takerRatio24h);
  if (taker != null) {
    if (taker >= 1.10) { score += 10; reasons.push(`taker buy/sell ${taker} — buyers aggressively spread cross kar rahe hain`); }
    else if (taker >= 1.03) { score += 5; reasons.push(`taker buy/sell ${taker} — halka buy-side aggression`); }
    else if (taker <= 0.90) { score -= 10; reasons.push(`taker buy/sell ${taker} — sellers aggressively beech rahe hain`); }
    else if (taker <= 0.97) { score -= 5; reasons.push(`taker buy/sell ${taker} — halki sell-side aggression`); }
    else reasons.push(`taker buy/sell ${taker} — balanced aggressive flow`);
  }

  // top-trader lean (aligned, modest weight — not gospel)
  const ls = num(i.topLongShortRatio);
  if (ls != null) {
    if (ls >= 2.5) { score += 5; reasons.push(`top-trader L/S ${ls} — bade accounts long-heavy (careful: yahan crowding bhi hai)`); }
    else if (ls <= 0.6) { score -= 5; reasons.push(`top-trader L/S ${ls} — bade accounts short-heavy (careful: yahan crowding bhi hai)`); }
    else reasons.push(`top-trader L/S ${ls} — balanced`);
  }

  // funding — carry + crowding (contrarian at extremes)
  const fBps = num(i.fundingBps8h);
  if (fBps != null) {
    if (fBps > 15) { score -= 8; reasons.push(`funding +${r1(fBps)}bps/8h — longs bahut crowded aur pay kar rahe hain (squeeze risk)`); }
    else if (fBps > 5) { score -= 3; reasons.push(`funding +${r1(fBps)}bps/8h — longs thoda pay kar rahe hain`); }
    else if (fBps < -5) { score += 8; reasons.push(`funding ${r1(fBps)}bps/8h — shorts pay kar rahe hain, squeeze fuel ready`); }
    else if (fBps < 0) { score += 3; reasons.push(`funding ${r1(fBps)}bps/8h — shorts halka sa pay kar rahe hain`); }
    else reasons.push(`funding ${r1(fBps)}bps/8h — balanced carry`);
  }

  score = Math.round(Math.max(1, Math.min(99, score)));
  const bias = score >= 62 ? 'BULLISH' : score <= 38 ? 'BEARISH' : 'NEUTRAL';
  const crowdedLongs = fBps != null && fBps > 15 && (ls != null && ls >= 2.5);
  const crowdedShorts = fBps != null && fBps < -5 && (ls != null && ls <= 0.6);
  if (crowdedLongs) reasons.push('🚩 LONGS CROWDED — ek negative print par squeeze-down possible');
  if (crowdedShorts) reasons.push('🚩 SHORTS CROWDED — ek positive print par squeeze-up possible');

  return {
    bias, score, matrix,
    label: bias === 'BULLISH' ? 'POSITIONING BULLISH' : bias === 'BEARISH' ? 'POSITIONING BEARISH' : 'POSITIONING NEUTRAL',
    crowdedLongs, crowdedShorts,
    confidence: matrix != null && taker != null && fBps != null ? 'full' : (matrix != null || taker != null) ? 'partial' : 'thin',
    reasons: reasons.slice(0, 6),
  };
}

// ---------------- wire payload (board/card-facing compact view) ----------------
/**
 * Compact wire payload for signal cards / agent answers — the full intel
 * record's positioning-relevant slice (no big histories on the wire).
 */
export function perpIntelWire(intel) {
  if (!intel || !intel.ok) return null;
  const i = intel;
  return {
    pair: i.pair,
    markPrice: i.markPrice ?? null,
    fundingBps8h: i.fundingBps8h ?? null,
    nextFundingTs: i.nextFundingTs ?? null,
    openInterest: i.openInterest ?? null,
    oiValueUSDT: i.oiValueUSDT ?? null,
    oiChangePct24h: i.oiChangePct24h ?? null,
    change24hPct: i.change24hPct ?? null,
    topLongShortRatio: i.topLongShortRatio ?? null,
    takerRatio24h: i.takerRatio24h ?? null,
    read: i.read ? {
      bias: i.read.bias, score: i.read.score, label: i.read.label, matrix: i.read.matrix,
      crowdedLongs: !!i.read.crowdedLongs, crowdedShorts: !!i.read.crowdedShorts,
      confidence: i.read.confidence ?? 'thin',
      reasons: (i.read.reasons || []).slice(0, 3),
    } : null,
  };
}

// ---------------- batch + board view ----------------
/**
 * Batch intel — allSettled (each call bounded by its own 6s AbortSignal;
 * every symbol independent, one slow symbol never blocks the others).
 * Callers that need a HARD deadline wrap this in Promise.race (the
 * board's 2.5s warm pattern) — in-flight fetches still land in cache.
 * @returns {Promise<Map<string, object>>} base → intel record
 */
export async function getPerpIntelFor(bases, deadlineMs) {
  void deadlineMs; // accepted for signature compat; per-call timeouts bound the batch
  const list = (Array.isArray(bases) ? bases : []).map(String).filter(Boolean).slice(0, 40);
  const entries = await Promise.allSettled(list.map(b => getPerpIntel(b)));
  const out = new Map();
  list.forEach((b, idx) => {
    const r = entries[idx];
    if (r?.status === 'fulfilled' && r.value) out.set(String(b).toUpperCase(), r.value);
  });
  return out;
}

/**
 * Desk-level view for the PERP INTELLIGENCE panel: the top-N perps
 * by 24h turnover with their full positioning reads + a desk
 * summary (avg funding regime, aggregate bias).
 */
export async function perpIntelBoardView(limit = 12) {
  const { fetchFuturesPrices } = await import('./futures.js');
  const rows = await fetchFuturesPrices().catch(() => []);
  const top = (Array.isArray(rows) ? rows : [])
    .filter(x => x && x.base && x.volume > 0 && x.last > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, Math.max(1, Math.min(25, Number(limit) || 12)));
  if (top.length === 0) return { ok: false, reason: 'futures universe unreachable', symbols: [], at: Date.now() };

  const intelMap = await getPerpIntelFor(top.map(x => x.base), 5000);
  const symbols = top.map(x => {
    const intel = intelMap.get(String(x.base).toUpperCase());
    return {
      base: x.base, pair: x.pair || `${x.base}USDT`,
      last: x.last, changePct: x.changePct ?? null, volume24hUSDT: x.volume,
      intel: intel || { ok: false, base: x.base, reason: 'intel unreachable' },
    };
  }).filter(s => s.intel?.ok); // panel shows only symbols with honest data

  const funded = symbols.map(s => num(s.intel?.fundingBps8h)).filter(v => v != null);
  const avgFundingBps = funded.length > 0 ? r2(funded.reduce((a, b) => a + b, 0) / funded.length) : null;
  const bull = symbols.filter(s => s.intel?.read?.bias === 'BULLISH').length;
  const bear = symbols.filter(s => s.intel?.read?.bias === 'BEARISH').length;
  return {
    ok: symbols.length > 0, at: Date.now(),
    summary: {
      scanned: symbols.length,
      bullish: bull, bearish: bear, neutral: symbols.length - bull - bear,
      avgFundingBps8h: avgFundingBps,
      fundingRegime: avgFundingBps == null ? 'unknown' : avgFundingBps > 10 ? 'LONGS PAYING (crowded)' : avgFundingBps < -3 ? 'SHORTS PAYING (squeeze fuel)' : 'BALANCED',
      note: 'Binance fapi public reference — CoinDCX par public positioning endpoint nahi hai. Har field honestly degrade hota hai.',
    },
    symbols,
  };
}

// ---------------- test hooks ----------------
export function __resetPerpIntelForTests() { _cache.clear(); _inflight.clear(); }
export function __seedPerpIntelForTests(base, intel) {
  const pair = `${String(base).toUpperCase()}USDT`;
  _cache.set(pair, { at: Date.now(), val: intel });
}
