// ============================================================
// server/ai/orderFlowDepth.js — v10.6 ORDER-FLOW / LEVEL-2 DEPTH
// ------------------------------------------------------------
// THE GAP (Pro Upgrade #1): InstFlow only read a single top-N
// imbalance number from the CoinDCX orderbook. No true ladder
// analysis — no multi-band imbalance, no large-order/iceberg wall
// detection, no book-velocity (spoof) read, and NOTHING on the
// India side beyond end-of-day FII/DII prints.
//
// THIS MODULE (pure + cached, honest degrade everywhere):
//   • CoinDCX depth-snapshot puller — top 20-50 levels via the
//     SAME public endpoint family the OrderbookPanel uses. Cached
//     2s (the positionsStream fast tier) so N viewers of a signal
//     card share ONE upstream call; single-flight + negative-cache.
//   • India Level-2 — Dhan marketfeed/quote carries NSE best-5
//     bids/asks (the repo's live India broker; the plan named Angel
//     One but THIS desk's creds are Dhan — same best-5 L2 data,
//     no new broker integration required). 3s cache, only when
//     Dhan is connected.
//   • analyzeDepth() — PURE:
//       - imbalance at TWO bands: top-5 (shallow/impulse) vs
//         top-20 (deep/conviction) — the divergence between the
//         bands is the interesting signal (shallow-heavy +
//         deep-light = spoof-prone pump)
//       - WALL detection: any single level ≥ WALL_X × the side's
//         median level size = a wall (iceberg candidate)
//       - VELOCITY: keeps a ring of the last 3 snapshots; a wall
//         that VANISHES between snapshots = spoof flag (down-
//         weight, never silently trust a stacked book)
//   • VolumeFlow fold-in (the plan's "cheaper to ship first"
//     route): the board attaches ctx.depth for the top-turnover
//     slice; the VolumeFlow seat weighs it (zero change to the
//     14-model registry, quorum caps, or weight tuning).
//
// FUTURES desk: CoinDCX perp depth is not public — the spot INR
// book votes as a PROXY (same precedent as InstFlow, flagged).
// ============================================================
import { dhanConnected, dhanPrivate, resolveDhanSymbol } from './dhan.js';

const DEPTH_URL = 'https://public.coindcx.com/market_data/v3/orders';
const DEPTH_TTL_MS = 2000;          // fast tier (positionsStream class)
const DHAN_DEPTH_TTL_MS = 3000;     // L2 quote cadence
const NEG_TTL_MS = 60_000;          // endpoint down → retry at most 1/min
const DEPTH_FETCH_TIMEOUT_MS = 6000; // per-endpoint cap (unchanged)
// v11.8.2: the CoinDCX→Binance fallback chain used to be able to stall
// a caller for TWO full 6s timeouts back-to-back (12s worst case) — a
// live agentTick entry decision can black out for 12s and the agent's
// single-flight guard then skips every cycle in the window. The chain
// now shares ONE 6s budget: the Binance fallback gets whatever remains
// (floor 750ms so it is still a real attempt, not an instant abort).
const DEPTH_CHAIN_BUDGET_MS = 6000;
const FALLBACK_FLOOR_MS = 750;
const RING_KEEP = 3;                // velocity ring (spoof detection)
const WALL_X = 4;                   // level ≥ 4× side median = wall
const _WALL_VANISH_FACTOR = 1.5;     // wall "gone" when back under this × median

const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

// base → { at, snap, negUntil, inflight, ring: [{ts, walls}] }
const _cryptoBooks = new Map();
// symbol → { at, snap, negUntil, inflight }
const _indiaBooks = new Map();

/** v10.18 (deep-recheck #3): user-keyed book caches are bounded — the
 *  /api/ai/depth route lets a caller grow the key space forever
 *  (~10-20KB retained per slot on a Render free dyno). Evict the
 *  stalest slots past the cap (same MAX_CACHE_KEYS discipline the
 *  board caches already use). */
const BOOK_CACHE_CAP = 200;
function _evictBooks(map, keepKey) {
  if (map.size <= BOOK_CACHE_CAP) return;
  const stale = [...map.entries()]
    .filter(([k, s]) => k !== keepKey && !s.inflight)
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  for (const [k] of stale.slice(0, map.size - BOOK_CACHE_CAP)) map.delete(k);
}

// ---------------- CoinDCX public depth (spot INR book) ----------------
/** Tolerant level normalizer (same shapes swing.js handles). */
export function normalizeLevels(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const p = num(x?.price ?? x?.p ?? (Array.isArray(x) ? x[0] : NaN));
    const q = num(x?.quantity ?? x?.q ?? x?.volume ?? (Array.isArray(x) ? x[1] : NaN));
    if (p > 0 && q > 0) out.push({ price: p, qty: q });
  }
  return out;
}

async function _fetchCoinDcxDepth(base, levels, timeoutMs = DEPTH_FETCH_TIMEOUT_MS) {
  const pair = `B-${base}_INR`;
  const r = await fetch(`${DEPTH_URL}?pair=${encodeURIComponent(pair)}&limit=${levels}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Mozilla/5.0 (SmartAI depth reader)' },
  });
  if (!r.ok) throw new Error(`depth HTTP ${r.status}`);
  const j = await r.json();
  const bids = normalizeLevels(j?.bids || j?.buy || j?.bid_book).slice(0, levels);
  const asks = normalizeLevels(j?.asks || j?.sell || j?.ask_book).slice(0, levels);
  if (bids.length === 0 || asks.length === 0) throw new Error('empty ladder');
  // books arrive price-DESC (best first) on CoinDCX; keep best-first order
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks, pair };
}

// v11.8 RENDER-REACHABILITY FALLBACK — Binance public spot ladder.
// Same rationale as swing.js getOrderbook: public.coindcx.com REST is
// 403/timeout-challenged from several datacenter IPs (live-verified
// 2026-09-18: depth.crypto.booksCached stayed 0 all day, so VolumeFlow's
// L2 fold-in never fired on the crypto desk). Binance depth is keyless
// and datacenter-friendly; the ladder comes back in the USDT domain and
// readDepth rescales it onto the caller's INR anchor before analysis
// (wall distances / slippage stay in the trading domain).
async function _fetchBinanceDepth(base, levels, timeoutMs = DEPTH_FETCH_TIMEOUT_MS) {
  const r = await fetch(`https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(`${base}USDT`)}&limit=${Math.min(100, Math.max(5, levels))}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Mozilla/5.0 (SmartAI depth reader)' },
  });
  if (!r.ok) throw new Error(`binance depth HTTP ${r.status}`);
  const j = await r.json();
  const bids = normalizeLevels(j?.bids).slice(0, levels);
  const asks = normalizeLevels(j?.asks).slice(0, levels);
  if (bids.length === 0 || asks.length === 0) throw new Error('empty binance ladder');
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks, pair: `${base}USDT`, source: 'binance-usdt' };
}

/** Get (cached) the raw depth snapshot for a crypto base. */
async function getCoinDcxDepth(base, { maxAgeMs = DEPTH_TTL_MS, levels = 50 } = {}) {
  const sym = String(base || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!sym) return null;
  const slot = _cryptoBooks.get(sym) || { at: 0, snap: null, negUntil: 0, inflight: null };
  _cryptoBooks.set(sym, slot);
  _evictBooks(_cryptoBooks, sym);
  if (slot.snap && Date.now() - slot.at < maxAgeMs) return slot.snap;
  if (Date.now() < slot.negUntil) return slot.snap; // endpoint down — stale beats hammering
  if (slot.inflight) return slot.inflight;
  slot.inflight = (async () => {
    // v11.8.2: ONE 6s budget across the whole chain (see consts above).
    const deadline = Date.now() + DEPTH_CHAIN_BUDGET_MS;
    try {
      const snap = await _fetchCoinDcxDepth(sym, levels);
      slot.snap = snap; slot.at = Date.now(); slot.negUntil = 0;
      return snap;
    } catch {
      // v11.8: CoinDCX REST unreachable → Binance USDT ladder (rescaled
      // to the INR anchor by readDepth). Only when BOTH fail do we go
      // negative-cache + stale/null (honest degrade as before).
      try {
        const bSnap = await _fetchBinanceDepth(sym, levels, Math.max(FALLBACK_FLOOR_MS, deadline - Date.now()));
        slot.snap = bSnap; slot.at = Date.now(); slot.negUntil = 0;
        return bSnap;
      } catch {
        slot.negUntil = Date.now() + NEG_TTL_MS;
        slot.at = Date.now();
        return slot.snap; // stale or null — honest degrade
      }
    } finally {
      slot.inflight = null;
    }
  })();
  return slot.inflight;
}

// ---------------- India L2 (Dhan best-5 ladder) ----------------
/** Tolerant Dhan marketfeed/quote depth parse (v2 shapes drift). */
export function parseDhanDepth(raw, securityId) {
  const d = raw?.data?.[String(securityId)]?.depth
    ?? raw?.data?.[securityId]?.depth
    ?? raw?.depth
    ?? null;
  if (!d) return null;
  const bp = Array.isArray(d.buy_price) ? d.buy_price : [];
  const bq = Array.isArray(d.buy_quantity) ? d.buy_quantity : [];
  const sp = Array.isArray(d.sell_price) ? d.sell_price : [];
  const sq = Array.isArray(d.sell_quantity) ? d.sell_quantity : [];
  const bids = [], asks = [];
  for (let i = 0; i < 5; i++) {
    const p = num(bp[i]), q = num(bq[i]);
    if (p > 0 && q > 0) bids.push({ price: p, qty: q });
  }
  for (let i = 0; i < 5; i++) {
    const p = num(sp[i]), q = num(sq[i]);
    if (p > 0 && q > 0) asks.push({ price: p, qty: q });
  }
  if (bids.length === 0 || asks.length === 0) return null;
  return { bids, asks, pair: 'NSE-L2' };
}

async function getIndiaDepth(symbol, { maxAgeMs = DHAN_DEPTH_TTL_MS } = {}) {
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9&-]/g, '');
  if (!sym || !dhanConnected()) return null;
  const slot = _indiaBooks.get(sym) || { at: 0, snap: null, negUntil: 0, inflight: null, secId: null };
  _indiaBooks.set(sym, slot);
  _evictBooks(_indiaBooks, sym);
  if (slot.snap && Date.now() - slot.at < maxAgeMs) return slot.snap;
  if (Date.now() < slot.negUntil) return slot.snap;
  if (slot.inflight) return slot.inflight;
  slot.inflight = (async () => {
    try {
      if (slot.secId == null) {
        const sid = await resolveDhanSymbol(sym);
        if (!(sid > 0)) throw new Error('no securityId');
        slot.secId = sid;
      }
      const raw = await dhanPrivate('/marketfeed/quote', {
        method: 'POST',
        body: { ISEM: [{ exchangeSegment: 'NSE_EQ', securityId: slot.secId }] },
      });
      const snap = parseDhanDepth(raw, slot.secId);
      if (!snap) throw new Error('no depth in response');
      slot.snap = snap; slot.at = Date.now(); slot.negUntil = 0;
      return snap;
    } catch {
      slot.negUntil = Date.now() + NEG_TTL_MS;
      slot.at = Date.now();
      return slot.snap; // stale or null
    } finally {
      slot.inflight = null;
    }
  })();
  return slot.inflight;
}

// ---------------- PURE: the ladder analysis ----------------
/** Walls on one side: levels ≥ WALL_X × the side's median size.
 * v10.6.1 FIX: the wall's price stays RAW (full venue precision) —
 * r2() collapsed sub-₹0.01 tokens (SHIB/BONK/PEPE books) to price 0
 * (garbage distPct, false spoof flags) and broke the UI's wall-marker
 * matching on >2-decimal books. Only qty/x get rounded. */
export function findWalls(levels, x = WALL_X) {
  if (!Array.isArray(levels) || levels.length < 3) return [];
  const sorted = [...levels].map(l => l.qty).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return [];
  return levels
    .filter(l => l.qty >= x * median)
    .map(l => ({ price: l.price, qty: r2(l.qty), x: r4(l.qty / median) }));
}

function _bandImbalance(levels, n) {
  const slice = levels.slice(0, n);
  if (slice.length === 0) return null;
  const vol = slice.reduce((s, l) => s + l.qty, 0);
  return vol; // side volume
}

/**
 * Analyze one snapshot (+ optional previous ring for velocity).
 * PURE — callers pass plain arrays; `ring` is this module's velocity
 * history for the base (managed by readDepth, tests inject their own).
 */
export function analyzeDepth({ bids, asks, ring = [], now = Date.now(), ltp = null }) {
  if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
    return { ok: false };
  }
  const bestBid = bids[0].price, bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = bestAsk > 0 ? r4(((bestAsk - bestBid) / bestAsk) * 100) : null;

  // two-band imbalance: shallow (top-5) vs deep (top-20 → all if < 20)
  const bid5 = _bandImbalance(bids, 5), ask5 = _bandImbalance(asks, 5);
  const bid20 = _bandImbalance(bids, 20), ask20 = _bandImbalance(asks, 20);
  const imbalanceTop5 = (bid5 != null && ask5 != null && bid5 + ask5 > 0)
    ? r4(bid5 / (bid5 + ask5)) : null;
  const imbalanceTop20 = (bid20 != null && ask20 != null && bid20 + ask20 > 0)
    ? r4(bid20 / (bid20 + ask20)) : null;

  // walls
  const bidWalls = findWalls(bids);
  const askWalls = findWalls(asks);

  // velocity: walls in the PREVIOUS snapshots that vanished in this one.
  // v10.6.1: raw prices both sides (walls are raw now) — the 1e-9
  // exact-match works because both come from the same normalizeLevels
  // precision, and rounding differences can no longer fake a vanish.
  const thisWallSet = new Set([...bidWalls, ...askWalls].map(w => `${w.price}`));
  let spoofRisk = false;
  const vanishedWalls = [];
  for (const prev of ring.slice(0, RING_KEEP - 1)) {
    if (!(now - prev.ts < 60_000)) continue; // stale ring rows don't count
    for (const w of prev.walls || []) {
      if (thisWallSet.has(`${w.price}`)) continue;
      // is the level still present (small) or GONE entirely?
      const stillThere = [...bids, ...asks].some(l => Math.abs(l.price - w.price) < 1e-9);
      if (!stillThere) { spoofRisk = true; vanishedWalls.push(w); }
    }
  }

  // distance of the nearest wall from price (in %) — support/resistance read
  const px = ltp != null && ltp > 0 ? ltp : mid;
  const wallDist = (w, side) => side === 'bid'
    ? r4(((px - w.price) / px) * 100)
    : r4(((w.price - px) / px) * 100);
  const nearBidWall = bidWalls.length ? { ...bidWalls[0], distPct: wallDist(bidWalls[0], 'bid') } : null;
  const nearAskWall = askWalls.length ? { ...askWalls[0], distPct: wallDist(askWalls[0], 'ask') } : null;

  return {
    ok: true,
    bestBid: r2(bestBid), bestAsk: r2(bestAsk), mid: r2(mid),
    spreadPct, ltp: ltp != null ? r2(ltp) : null,
    imbalanceTop5, imbalanceTop20,
    bidWalls: bidWalls.slice(0, 3), askWalls: askWalls.slice(0, 3),
    nearBidWall, nearAskWall,
    spoofRisk, vanishedWalls: vanishedWalls.slice(0, 3),
    levels: { bids: bids.length, asks: asks.length },
    ts: now,
  };
}

// velocity rings (per crypto base — India's 5-level quote is too
// thin for wall-velocity to mean anything)
const _rings = new Map();

function _pushRing(base, walls, now) {
  const ring = (_rings.get(base) || []).filter(r => now - r.ts < 60_000);
  ring.unshift({ ts: now, walls });
  _rings.set(base, ring.slice(0, RING_KEEP));
  // v10.18: velocity rings are user-keyed too — cap them the same way
  // (a ring is tiny, but the key space was unbounded).
  if (_rings.size > BOOK_CACHE_CAP) {
    for (const k of [..._rings.keys()].slice(0, _rings.size - BOOK_CACHE_CAP)) _rings.delete(k);
  }
}

// ---------------- the unified reader ----------------
/**
 * One depth read for a (market, symbol) — the /api/ai/depth endpoint
 * (UI ladder widget) and the agent's slippage estimator both call
 * this. FUTURES uses the spot book as a PROXY (perp depth is not
 * public on CoinDCX — same precedent as InstFlow, flagged honestly).
 */
export async function readDepth(market, symbol, { ltp = null, levels = 50 } = {}) {
  const mkt = String(market || '').toUpperCase();
  if (mkt === 'INDIA') {
    const snap = await getIndiaDepth(symbol);
    if (!snap) return { ok: false, market: mkt, symbol, reason: 'Dhan L2 unavailable (not connected / market closed / no securityId)' };
    const analysis = analyzeDepth({ bids: snap.bids, asks: snap.asks, ltp, now: Date.now() });
    return { ok: true, market: mkt, symbol, source: 'dhan-nse-l2', ...analysis,
      ladder: { bids: snap.bids.slice(0, 5), asks: snap.asks.slice(0, 5) },
      book: { bids: snap.bids, asks: snap.asks } }; // best-5 IS the book on Dhan
  }
  // CRYPTO (spot INR book) + FUTURES (spot proxy)
  const base = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const snap = await getCoinDcxDepth(base, { levels });
  if (!snap) return { ok: false, market: mkt, symbol: base, reason: 'CoinDCX public depth unavailable right now' };
  const now = Date.now();
  // v11.8: a Binance USDT fallback ladder must land in the SAME price
  // domain the desk trades (INR) before any wall-distance or slippage
  // math runs — linear rescale onto the caller's INR anchor (ltp).
  // Without an anchor the ladder stays USDT and is LABELED as such
  // (distances approximate, imbalance/velocity still exact — they are
  // ratio-based and domain-agnostic).
  let bids = snap.bids, asks = snap.asks;
  let srcLabel = mkt === 'FUTURES' ? 'coindcx-spot-book (perp proxy)' : 'coindcx-spot-inr';
  if (snap.source === 'binance-usdt') {
    const mid = (bids[0]?.price + asks[0]?.price) / 2;
    if (ltp > 0 && mid > 0) {
      const f = ltp / mid;
      bids = bids.map(l => ({ price: l.price * f, qty: l.qty }));
      asks = asks.map(l => ({ price: l.price * f, qty: l.qty }));
      srcLabel = 'binance-usdt-book (rescaled to INR anchor)';
    } else {
      srcLabel = 'binance-usdt-book (unanchored — CoinDCX unreachable, distances approximate)';
    }
    if (mkt === 'FUTURES') srcLabel += ' · perp proxy';
  }
  const analysis = analyzeDepth({ bids, asks, ring: _rings.get(base) || [], ltp, now });
  _pushRing(base, [...analysis.bidWalls, ...analysis.askWalls], now);
  return {
    ok: true, market: mkt, symbol: base,
    source: srcLabel,
    proxy: mkt === 'FUTURES' || undefined,
    ...analysis,
    // v10.6.1: `ladder` stays the UI's top-5 view; `book` carries the
    // deeper walk levels the slippage estimator needs (the agent passes
    // levels:20 — the walk must not stop at 5).
    ladder: { bids: bids.slice(0, 5), asks: asks.slice(0, 5) },
    book: { bids: bids.slice(0, 20), asks: asks.slice(0, 20) },
  };
}

// ---------------- slippage estimation (Pro Upgrade #6) ----------------
/**
 * Walk the ladder to fill a NOTIONAL (quote currency — INR for the spot
 * book) and report how far the fill VWAP drifts from the touch.
 * PURE — callers pass the readDepth() output.
 * @param {object} a { side:'BUY'|'SELL', notional:number, depth:{ladder,ok} }
 * @returns {{pct:number|null, bookExhausted:boolean, filledPct:number}}
 *   pct = expected slippage % (positive = paying up); null when the
 *   book is unusable (honest degrade → single order). bookExhausted =
 *   the notional ran past the visible ladder — the pct is a LOWER
 *   BOUND (callers should force the max split).
 */
export function estimateSlippagePct({ side, notional, depth }) {
  const isSell = String(side).toUpperCase() === 'SELL';
  // v10.6.1: prefer the deeper `book` (readDepth's top-20 walk levels)
  // over the UI's 5-level `ladder` — the walk must span the book the
  // splitter will actually lean on. Plain-ladder inputs (tests, older
  // callers) keep working unchanged.
  const _usable = (src) => (Array.isArray(src?.bids) && src.bids.length > 0
    && Array.isArray(src?.asks) && src.asks.length > 0) ? src : null;
  const src = _usable(depth?.book) || _usable(depth?.ladder);
  const levels = isSell ? (src?.bids || []) : (src?.asks || []);
  const n = Number(notional);
  if (!Array.isArray(levels) || levels.length === 0 || !(n > 0)) return { pct: null, bookExhausted: false, filledPct: 0 };
  const touch = levels[0].price;
  if (!(touch > 0)) return { pct: null, bookExhausted: false, filledPct: 0 };
  let remaining = n, filled = 0, cost = 0;
  for (const l of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining / l.price, l.qty); // base qty this level can absorb
    cost += take * l.price;
    filled += take;
    remaining -= take * l.price;
  }
  if (filled <= 0) return { pct: null, bookExhausted: false, filledPct: 0 };
  const vwap = cost / filled;
  // ADVERSE magnitude, always ≥ 0: a BUY pays up (vwap > touch), a
  // SELL hits lower levels (vwap < touch). Both mean paying the spread
  // + depth impact — the number the splitter needs.
  const adversePct = isSell ? ((touch - vwap) / touch) * 100 : ((vwap - touch) / touch) * 100;
  const bookExhausted = remaining > n * 0.02; // >2% of the notional left unfilled
  return {
    pct: r4(adversePct),
    bookExhausted,
    filledPct: r4(Math.min(100, ((n - remaining) / n) * 100)),
  };
}

/**
 * TWAP-lite splitter: expected slippage over the threshold (or the
 * book exhausted before the notional filled) → 2-4 child orders.
 * Returns the split (always ≥1 child). PURE.
 * @param {object} a { side, notional, depth, thresholdPct }
 * @returns {{ children: number, slippagePct: number|null, reason: string }}
 */
export function splitOrderForSlippage({ side, notional, depth, thresholdPct = 0.35 }) {
  const est = estimateSlippagePct({ side, notional, depth });
  const slip = est.pct;
  const thr = Number.isFinite(Number(thresholdPct)) && Number(thresholdPct) > 0 ? Number(thresholdPct) : 0.35;
  if (slip == null) {
    return { children: 1, slippagePct: null, reason: 'no depth read — single order (honest degrade)' };
  }
  if (est.bookExhausted) {
    return { children: 4, slippagePct: slip, reason: `notional exceeds the visible book (only ${est.filledPct}% fillable, slip ≥ ${slip}% seen) — TWAP-lite into 4 child orders` };
  }
  if (slip <= thr) {
    return { children: 1, slippagePct: slip, reason: `expected slip ${slip}% ≤ ${thr}% — single order` };
  }
  const kids = Math.max(2, Math.min(4, Math.ceil(slip / thr)));
  return { children: kids, slippagePct: slip, reason: `expected slip ${slip}% > ${thr}% — TWAP-lite into ${kids} child orders` };
}

// ---------------- board warming (VolumeFlow ctx.depth) ----------------
/**
 * Warm depth for the board's top-turnover slice (the plan's VolumeFlow
 * fold-in). Rate-guarded per base like warmInstFlow; fire-and-forget
 * safe. Returns base → analysis (null entries skipped) for ctx attach.
 */
export async function warmDepthBatch(market, bases, { ltpOf = null, levels = 20 } = {}) {
  const mkt = String(market || '').toUpperCase();
  const list = (Array.isArray(bases) ? bases : []).slice(0, 8);
  const out = new Map();
  await Promise.allSettled(list.map(async (b) => {
    const ltp = typeof ltpOf === 'function' ? ltpOf(b) : null;
    const r = await readDepth(mkt, b, { ltp, levels }).catch(() => null);
    if (r?.ok) out.set(String(b).toUpperCase(), r);
  }));
  return out;
}

// ---------------- status ----------------
export function depthStatus() {
  return {
    crypto: {
      booksCached: [..._cryptoBooks.values()].filter(s => s.snap).length,
      ttlMs: DEPTH_TTL_MS,
      wallX: WALL_X,
      ringsTracked: _rings.size,
    },
    india: {
      available: dhanConnected(),
      booksCached: [..._indiaBooks.values()].filter(s => s.snap).length,
      ttlMs: DHAN_DEPTH_TTL_MS,
    },
  };
}

// ---------------- test hooks ----------------
export const __testables = {
  _cryptoBooks, _indiaBooks, _rings,
  __resetDepthForTests() {
    _cryptoBooks.clear(); _indiaBooks.clear(); _rings.clear();
  },
  __setCryptoDepthForTests(base, bids, asks, ageMs = 0) {
    _cryptoBooks.set(String(base).toUpperCase(), {
      at: Date.now() - ageMs, snap: { bids, asks, pair: `B-${base}_INR` }, negUntil: 0, inflight: null,
    });
  },
  __setIndiaDepthForTests(symbol, bids, asks, ageMs = 0) {
    _indiaBooks.set(String(symbol).toUpperCase(), {
      at: Date.now() - ageMs, snap: { bids, asks, pair: 'NSE-L2' }, negUntil: 0, inflight: null, secId: 12345,
    });
  },
  __pushRingForTests(base, walls, ts = Date.now()) {
    const ring = _rings.get(base) || [];
    ring.push({ ts, walls });
    _rings.set(base, ring.slice(-RING_KEEP));
  },
};
