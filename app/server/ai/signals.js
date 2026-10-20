// ============================================================
// server/ai/signals.js — ensemble ORCHESTRATOR
// ------------------------------------------------------------
// Wires data (data.js) → models (models.js) → aggregation
// (ensemble.js) → LLM verification (AI Council) → ranked signal
// board, with a short server-side cache (scanner calls cost).
//
//   getSignals(market)      full board  (India stocks + indices,
//                            crypto majors) — 60s/45s cache
//   getDeepSignal(sym,mkt)  ONE symbol, all model votes + AI note
//   getFreshSignalForExec   the execute gauntlet's data source —
//                           always a FRESH single-symbol run
// ============================================================
import { computeIndicatorsFromCandles } from './lib/indicators.js';
import { ensureAscending } from './lib/candles.js'; // v21.23.12: seat-level L2.5 guards (tape/sessionVwap/resample)
import { buildMTFSnapshot, mtfWire6Payload, __clearMtfCaches, isStaleIntradaySeries } from './mtf.js';
import {
  INDIA_UNIVERSE, CRYPTO_UNIVERSE, fetchTVIndiaBatch, fetchTVIndiaBatchChunked, fetchTVCryptoBatch,
  fetchCoinDcxCandles, fetchBinanceKlines, fetchYahooQuotes, isNseOpen,
} from './data.js';
// v10.17 FULL UNIVERSE SCAN — TV filter-query discovery + tiered
// cadence (T1 base∪hot every cycle · T2 rotating slices) + hot
// promotion. Flag AI_INDIA_FULL_UNIVERSE=off reverts to the static base.
import { tieredScanUniverse, absorbScanRows, fullIndiaUniverseEnabled as _fullIndiaUniverseEnabled, boardUniverseOverrides } from './indiaUniverse.js';
import { FUTURES_UNIVERSE, futuresPairFor, fetchFuturesPrices, fetchFuturesCandles, METALS_BASES, isMetalsBase, fetchMetalsFapiCandles, fetchMetalsPrices, fetchMetalsYahooCandles } from './futures.js';
// v20.7.12 [M-2]: USDINR last-known-good fallback (disk-backed) — flat-84
// hardcode (signals.js:2240) TV-only fallback contexts ko ~6% misprice
// kar raha tha jab real USDINR ~89 ho (v20.2 ne baaki sab sites fix kiye the,
// ye sync-branch chhoot gaya tha).
import { usdInrFallback } from './lib/usdinr.js';
// v21.13.x recheck (B1): maCrossFromCandles import removed — it was a
// dead import since v21.13 (the deep-path MACROSS revival calls the
// registered seat fn, not this helper directly).
import { MODELS, runQuantModels, aiCouncilVoteFromVerdict, v2ModelsEnabled, mtfConfluenceEnabled, tapeVote, meshModelsEnabled, structurePro } from './models.js';
// v21.3.0 (Issue-5) lineage: Jev AI confirmation on board signals
// (v21.14: Laya removed — jev-only confirm layer)
import { confirmBoardSignals as _confirmBoardSignals, boardAiConfirmActive as _boardAiConfirmActive } from './boardAiConfirm.js';

// v21.3.0 (Issue-3: "Signal Board wrong directions — sab SL hit"):
// HARD HTF VETO + CHOP FILTER. Pehle ek counter-4h/1d signal sirf
// −7/−10 conf + STRONG→ACTION demote paata tha — 90% conviction wala
// counter-trend signal phir bhi ACTION card ban ke rank karta tha.
// Ab: (a) 1d/4h DIRECTLY against hone par grade WATCH + aiScore cap 62
// (80+ badge namumkin); (b) SPLIT phase (6-TF weight 50/50 — no dominant
// side) ya ADX<15 (no trend strength) = range/chop — grade cap WATCH.
// Dono env se off kar sakte hain (back-compat / A-B testing).
const VETO_COUNTER_HTF = String(process.env.AI_VETO_COUNTER_HTF ?? '1') !== '0';
const VETO_CHOP = String(process.env.AI_VETO_CHOP ?? '1') !== '0';
// v11.6 MESH-BACKED SEATS — the MCP mesh finally votes on trade
// decisions (Phase 1A), shadow-gated (Phase 2) + honesty-gated (1B)
// + correlation-discounted (1C), warmed at T3 cadence only (Phase 3).
import { warmMeshModels, applyMeshModelGating } from './meshModels.js';
import { applyCoreCorrelationDiscounts, coreSeatCorrelationView } from './seatCorrelation.js';
// v2 signal-accuracy upgrade: sentiment (news/F&G/funding), institutional
// flow (FII/DII + orderbook), fundamentals (India swing-only deep path)
import { refreshSentiment, sentimentContextFor, absorbCouncilSentiment } from './sentiment.js';
import { refreshFiiDii, warmInstFlow } from './instFlow.js';
import { attachFundamentals } from './fundamentals.js';
// v6.7 self-correcting ensemble: live-outcome Bayesian weight multipliers
import { adaptiveMultipliers, applyAdaptiveWeights } from './adaptive.js';
import { modelStats as _ledgerModelStats } from './ledger.js';
import { explainTicker } from './narrative.js';
import { aggregateVotes, aggregateVotesWithMeta, buildTradePlan, buildSignal, DEFAULT_GATES, applyRegimeWeights, classifyRegimeFor, regimeMulFor, regimeWeightsEnabled, applyStrictAgreementCap, buildOptionsPlanCtx } from './ensemble.js';
// v6.12 PRO TRADER BRAIN — quality/honesty layer over the consensus
import { qualityVerdict, sessionPhase as sessionPhaseOf } from './probrain.js';
import { smcVote } from './lib/smc.js';
import { simulateSymbol } from './backtest.js';
// v9 SUPERINTELLIGENCE PRO TRADER ENGINE — the Signal Board upgrade:
// dynamic full-universe scan + AI SCORE (0-100) + complete trade
// blueprint (entry timing / leverage / exit time) on every signal.
// v12.4 SIGNAL CONTINUITY ENGINE — age/flips tracking, OB/OS + flip
// trust guards (board AND deep paths — the LIVE gate reads the deep
// one), and open-position pinning (traded symbols never vanish).
import { applySignalTrustGuards, remember, pinHoldingOnBoard, __resetSignalMemoryForTests } from './signalMemory.js';
// v12.6: the entry-quality multipliers drive the board's rank key.
import { QUALITY_PULLBACK_SCORE_MUL, QUALITY_EXTENDED_SCORE_MUL, QUALITY_HARD_SCORE_MUL } from './entryTiming.js';
import { discoverSpotUniverse, discoverFuturesUniverse, binancePriceMap, fetchUsdInr, expertScoreFactors } from './expertPicks.js';
import { validateTick } from './wickFilter.js';

/**
 * v21.4.1 [deep-recheck A1]: ADX value normalizer — number | string |
 * {adx, plusDI, minusDI} object teeno shapes se ek honest number.
 *
 * BUG jo ye fix karta hai: `ctx.ind.adx` har desk pe OBJECT hai
 * ({adx, plusDI, minusDI} — tvToInd, computeIndicatorsFromCandles aur
 * buildGlobalCtxSync teeno object form bhejte hain). Purana read
 * `parseFloat(String(object))` → NaN → null karta tha — isliye v21.3.0
 * ka "ADX < 15 → chop cap" leg KABHI fire nahi hota tha (sirf SPLIT
 * phase leg kaam karta tha). Board + deep + expert picks — teeno
 * ab isi normalizer ko padhte hain.
 */
export function readAdxNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v && typeof v === 'object' && v.adx != null) {
    const n = Number(v.adx);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * v21.1.1 [audit C2]: REVIVED VOTES ko correlation discount dobara lagao.
 * Pass-1 `applyCoreCorrelationDiscounts` pass-2 revival (smc/structure/
 * tape/pattern… splice+push) se PEHLE chalta hai — revived vote fresh
 * weight le aata hai, discount GAYA. India path pe tape seat har cycle
 * revive hota hai (trend↔tape is the PRIMARY dedup pair) — yani headline
 * false-diversity fix wahi undo ho raha tha. Ye helper sirf un votes ko
 * touch karta hai jinpe corrDiscounted laga hi nahi (idempotent — already-
 * discounted votes untouched).
 */
function _rediscountRevivedVotes(votes) {
  try {
    if (!Array.isArray(votes) || votes.length === 0) return votes;
    const v = coreSeatCorrelationView();
    if (!v || !v.pairs) return votes;
    const discountBySeat = {};
    for (const key of Object.keys(v.pairs)) {
      const pr = v.pairs[key];
      if (pr && Number.isFinite(pr.discount) && pr.discount > 0 && pr.discount < 1) {
        discountBySeat[pr.redundant] = Math.min(discountBySeat[pr.redundant] ?? 1, pr.discount);
      }
    }
    if (Object.keys(discountBySeat).length === 0) return votes;
    for (let i = 0; i < votes.length; i++) {
      const vt = votes[i];
      if (!vt || !vt.id || vt.corrDiscounted === true) continue; // pass-1 wale already discounted
      const disc = discountBySeat[vt.id];
      if (!Number.isFinite(disc) || disc >= 1) continue;
      votes[i] = { ...vt, weight: Math.round((vt.weight || 0) * disc * 1000) / 1000, corrDiscount: disc, corrDiscounted: true, corrRediscounted: true };
    }
    return votes;
  } catch { return votes; /* guard must never break the board */ }
}
import { readDepth, warmDepthBatch } from './orderFlowDepth.js';
// v11.8: REAL option-chain ctx for the India index seats (OptionsFlow
// was designed for exactly NIFTY/BANKNIFTY but the board never attached
// ctx.options — the seat sat abstained on every India board).
import { getOptionsDesk } from './optionsDesk.js';
import { computeSuperScore, buildSuperBlueprint } from './superIntel.js';
// v12.0 PRO TRADER UPGRADE — the calibrated WIN-PROBABILITY engine
// (ledger outcomes + funding/positioning + confluence → P(win), EV in R)
// and the PERP POSITIONING INTELLIGENCE engine (funding / OI / top-trader
// L/S / taker flow — Binance fapi public reference).
import { computeWinProb, calibrationSnapshot } from './winProb.js';
import { getPerpIntel, getPerpIntelFor, perpIntelWire, perpIntelEnabled } from './perpIntel.js';
// v10.15 GAP 2: Event Guard — the board attaches the next scheduled
// event per signal (the signal-card ⚠ chip a manual trader sees).
import { eventGuardCheck } from './eventGuard.js';
// v11.0 GLOBAL MARKET COUNCIL — 6 specialist LLM seats + precision
// gate as an ANALYSIS layer over the board (flag-gated, default OFF;
// execution gauntlets untouched — safety-critical boundary).
import { councilEnabled, runCouncilBoard, runCouncilDeep, councilStampOf, gateThresholds } from './council.js';
import { verifySignal, verificationWire } from './signalVerifier.js';
// v20.9.2 ULTRAFAST CHART VERIFICATION AGENT (UCV-A1) — the deep AI
// superintelligence layer that answers "LONG pakka long jayega? SHORT
// pakka short jayega?" against the REALTIME ultrafast 1m chart before
// an 80+ signal is trusted (direction-mismatch fix).
import { verifySignalUltrafast, ultrafastWire, ultrafastGatePatch } from './ultrafastVerifier.js';
// v13.2 A2: LLM second-opinion validator (borderline band, candle-cached)
import { llmValidateSignal, llmValidateCached, llmValidatorEnabled, inBorderlineBand } from './llmValidator.js';
// v18.8 ENGINE CHAIN UNIFICATION: the board's council seats ride the
// ONE shared provider chain (sentinel + 6 cloud engines + local ollama).
// ollamaProbe comes from llmSentinel directly so llmChain test mocks
// (councilAsk/aiKeysPresent only) keep working untouched.
import { councilAsk, councilAskDeep, aiKeysPresent } from './llmChain.js';
import { ollamaProbe } from './llmSentinel.js';

// v9: how many coins the Superintelligence Signal Board scans for the
// dynamic desks (spot + futures). 40 = every liquid CoinDCX book by
// 24h turnover, bounded so the board stays fast under the 30s client
// timeout (TV is chunked 40/call, candles flow in bounded batches).
const SUPER_UNIVERSE_SIZE = 40;

/** v9: TV crypto scanner over a LARGE universe — chunked at 40 symbols
 * per scanner call (the scanner's documented batch ceiling). */
async function fetchTVCryptoChunked(symbols) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 40) chunks.push(symbols.slice(i, i + 40));
  const outs = await Promise.allSettled(chunks.map(ch => fetchTVCryptoBatch(ch)));
  for (const o of outs) if (o.status === 'fulfilled' && o.value) Object.assign(out, o.value);
  return out;
}

/** v9: LTF candles for the WHOLE universe in bounded parallel waves
 * (12 in flight at a time) — every scanned coin gets the full LTF
 * revival treatment, not just the top-10 by pre-confidence. */
async function loadCandlesBounded(symbols, fetchOne) {
  const map = new Map();
  const BATCH = 12;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const outs = await Promise.allSettled(batch.map(fetchOne));
    batch.forEach((b, j) => {
      const v = outs[j].status === 'fulfilled' ? outs[j].value : null;
      if (Array.isArray(v) && v.length >= 30) map.set(b, v);
    });
  }
  return map;
}

/** v9: stash the Superintelligence scoring inputs on the context (never
 * part of the signal payload — buildSignal picks its own fields). */
function attachSuperCtx(ctx, tvRow, candles) {
  ctx.__tv = tvRow || null;
  ctx.__ltfInd = Array.isArray(candles) && candles.length >= 30 ? computeIndicatorsFromCandles(candles) : null;
  ctx.__smc = null; // filled by the pass-1 SMC revival when it fires
}

/** v9: rescale a USD-domain candle set onto the desk's own price anchor
 * (spot INR / futures USDT). The CoinDCX candle feed can be WAF-blocked
 * — the Yahoo 1h fallback keeps the revival ALIVE, but its OHLC is USD.
 * Every price field is linear, so ×scale lands every ATR/EMA/VWAP in the
 * trading domain the plan prices use. Ratios (RSI, relVolume) are
 * scale-invariant.
 * Domain guard: the observed scale must sit within ±50% of the EXPECTED
 * cross-domain ratio — spot INR ≈ ltp/tv.usdPrice (≈ live fx), futures
 * USDT ≈ 1. A stale/mismatched Yahoo series can never slip through. */
function rescaleCandlesToLtp(candles, ltp, expectedScale = null) {
  if (!Array.isArray(candles) || candles.length < 30 || !(ltp > 0)) return null;
  const last = candles[candles.length - 1]?.close;
  if (!(last > 0)) return null;
  const scale = ltp / last;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const exp = Number(expectedScale);
  if (Number.isFinite(exp) && exp > 0) {
    if (scale < exp * 0.5 || scale > exp * 1.5) return null;
  } else if (scale <= 0.2 || scale >= 5) {
    return null; // no reference anchor — conservative sanity bound
  }
  return candles.map(c => ({
    time: c.time, volume: c.volume,
    open: c.open * scale, high: c.high * scale, low: c.low * scale, close: c.close * scale,
  }));
}

/** v21.9.0 METALS CANDLE CHAIN — board/deep/tape sab isi se guarte hain:
 *   1. Binance fapi klines (XAUUSDT/XAGUSDT, USDT 1:1 — v21.9.0 interval
 *      mapping fix ke baad YEHI pehli bar reliably kaam kar rahi hai)
 *   2. Yahoo COMEX GC=F/SI=F candles → desk ke live anchor pe RESCALED
 *      (expected scale ≈ 1: COMEX USD ≈ spot USD ≈ USDT perp — ±50%
 *      domain guard rescaleCandlesToLtp me built-in)
 * Binance geo-block (Indian ISPs) + CoinDCX WAF dono ke against ye
 * chain geo-chaloos rehti hai. ltp <= 0 ho to rescale skip — raw COMEX
 * candles hi return (ratios RSI/MACD ke liye phir bhi sahi hain). */
async function fetchMetalsCandleChain(base, resolution, ltp, limit = 300) {
  const fapi = await fetchMetalsFapiCandles(base, resolution, limit).catch(() => null);
  if (Array.isArray(fapi) && fapi.length >= 30) return fapi;
  const y = await fetchMetalsYahooCandles(base, resolution, limit).catch(() => null);
  if (!Array.isArray(y) || y.length < 30) return null;
  if (!(ltp > 0)) return y;
  return rescaleCandlesToLtp(y, ltp, 1) || y;
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ---------------- caches ----------------
const _cache = new Map(); // key → { at, payload }
const MAX_CACHE_KEYS = 80; // keys are user-influenced (deep/:symbol) — bound the map
function cacheGet(key, ttlMs) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.payload;
  return null;
}
function cacheSet(key, payload) {
  _cache.set(key, { at: Date.now(), payload });
  // Evict the oldest inserted entry (Map preserves insertion order) so
  // repeated distinct deep-symbols can't grow the cache unboundedly.
  while (_cache.size > MAX_CACHE_KEYS) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

// v20.7.5 DEEP FRESH-RUN single-flight: a user-clicked 🔬 with ?fresh=1
// bypasses the 30s cache READ, but two concurrent fresh clicks (double
// click, modal + 15s auto-recheck racing the manual open) must never run
// the full deep compute twice for the same symbol — the second caller
// joins the first's in-flight promise (the board's _boardInflight
// pattern, scoped to the deep path).
const _deepInflight = new Map(); // cacheKey → Promise
function _deepSingleFlight(cacheKey, computeFn) {
  const running = _deepInflight.get(cacheKey);
  if (running) return running;
  const p = (async () => {
    try { return await computeFn(); }
    finally { _deepInflight.delete(cacheKey); }
  })();
  _deepInflight.set(cacheKey, p);
  return p;
}

// ---------------- Yahoo daily candles (for index/spot TA) ----------------
const YF_TICKER = {
  NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
  SENSEX: '^BSESN', INDIAVIX: '^INDIAVIX', BTC: 'BTC-USD',
};
async function fetchYahooCandles(key, range = '3mo', interval = '1d') {
  const t = YF_TICKER[key];
  if (!t) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=${interval}&range=${range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI ai-signals)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp;
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) return null;
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open?.[i] == null || q.close?.[i] == null) continue;
      out.push({
        time: ts[i] * 1000,
        open: q.open[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i],
        close: q.close[i], volume: q.volume?.[i] || 0,
      });
    }
    return out.length >= 30 ? out : null;
  } catch { return null; }
}

// ---------------- TV row → indicator context ----------------
// v6.3: derive today's candlestick patterns from the scanner's OHLC +
// change% (prevClose = close/(1+chg/100)) — India stock rows previously
// had patterns:[] so PatternNeural almost always abstained on the whole
// NSE universe (one more silent vote missing from every consensus).
export function scannerPatterns(row) {
  const { open, high, low, ltp: close, changePct } = row;
  if (![open, high, low, close].every(v => typeof v === 'number' && v > 0)) return [];
  const prevClose = Number.isFinite(changePct) && changePct > -100
    ? close / (1 + changePct / 100) : null;
  const range = high - low;
  if (range <= 0) return [];
  const body = close - open;
  const bodyAbs = Math.abs(body);
  const bodyPct = bodyAbs / range;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const out = [];
  if (bodyPct < 0.1) out.push({ name: 'Doji', bias: 0 });
  else if (bodyPct > 0.85) out.push({ name: body > 0 ? 'Bullish Marubozu' : 'Bearish Marubozu', bias: body > 0 ? 1 : -1 });
  if (lowerWick > bodyAbs * 2 && upperWick < bodyAbs * 0.8 && bodyPct < 0.4) out.push({ name: 'Hammer', bias: 1 });
  if (upperWick > bodyAbs * 2 && lowerWick < bodyAbs * 0.8 && bodyPct < 0.4) out.push({ name: 'Shooting Star', bias: -1 });
  if (prevClose != null) {
    const prevBody = close > open ? Math.max(prevClose - open, 0) : 0; // approx prior body via prevClose
    if (body > 0 && close > prevClose && open <= prevClose && bodyAbs > prevBody) out.push({ name: 'Bullish Engulfing (approx)', bias: 1 });
    if (body < 0 && close < prevClose && open >= prevClose && bodyAbs > prevBody) out.push({ name: 'Bearish Engulfing (approx)', bias: -1 });
    if (open > prevClose * 1.005) out.push({ name: 'Gap Up', bias: 1 });
    else if (open < prevClose * 0.995) out.push({ name: 'Gap Down', bias: -1 });
  }
  return out.slice(0, 3);
}

function tvToInd(row, ltp) {
  const bb = row.bbUpper != null && row.bbLower != null && ltp ? {
    upper: row.bbUpper, lower: row.bbLower, mid: (row.bbUpper + row.bbLower) / 2,
    percentB: (ltp - row.bbLower) / Math.max(1e-9, row.bbUpper - row.bbLower),
    widthPct: ((row.bbUpper - row.bbLower) / ((row.bbUpper + row.bbLower) / 2)) * 100,
  } : null;
  const macdHist = (row.macd != null && row.macdSignal != null) ? row.macd - row.macdSignal : null;
  return {
    rsi: row.rsi ?? null,
    // v21.13: histSlope null on TV snapshots — a SNAPSHOT cannot know the
    // previous bar. The old code ALIASED the slope to the hist LEVEL
    // (a disguised hist-sign vote). Consumers now treat a null slope
    // honestly (models.js v21.13: hist-sign votes at reduced weight,
    // never a fake "rising").
    macd: macdHist != null ? { macd: row.macd, signal: row.macdSignal, hist: macdHist, histSlope: null } : null,
    ema10: row.ema10 ?? null, ema20: row.ema20 ?? null, ema50: row.ema50 ?? null,
    sma20: row.sma20 ?? null, sma50: row.sma50 ?? null,
    atr: row.atr ?? null, atrPct: null,
    bollinger: bb,
    stochK: row.stochK ?? null, stochD: row.stochD ?? null,
    adx: (row.adx != null) ? { adx: row.adx, plusDI: row.adxPlus ?? null, minusDI: row.adxMinus ?? null } : null,
    obvSlope: null, mfi: null,
    vwap: row.vwap ?? null,
    supertrend: null, roc: null,
    relVolume: row.relVolume ?? null,
    patterns: scannerPatterns(row),
    high52w: row.high52w ?? null, low52w: row.low52w ?? null,
    pivot: row.pivot ?? null,
    recommend: row.recommend ?? null,
  };
}

// ---------------- v6.12: Yahoo intraday candles (LTF for MTF) ----------------
// India: <sym>.NS 15m bars (1mo ≈ 500 bars) — the intraday timing TF.
// Crypto: <base>-USD 1h bars (3mo ≈ 2000 bars, we keep the tail) —
// works even where CoinDCX public candles are blocked, so the MTF
// layer never silently dies. Cached 2 min per symbol (bounded map).
// v6.12.1 FIX (recheck M-1): a FAILED fetch is negative-cached for
// 60s in its own map — the old code cached `null` via cacheSet,
// which cacheGet treated as a MISS (so every board refresh re-hit
// Yahoo for dead symbols AND the null keys evicted live entries
// from the bounded 80-key cache).
const _ltfMiss = new Map();
// v10.18 (deep-recheck #3): the miss map is user-keyed (deep-analysis
// symbols) and was unbounded — cap it with the same hygiene as the
// positive cache (drop expired entries, then oldest).
function _capMissMap(map, cap = 200) {
  if (map.size <= cap) return;
  const now = Date.now();
  for (const [k, ts] of map) if (now - ts >= 60_000) map.delete(k);
  if (map.size > cap) {
    const entries = [...map.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, map.size - cap)) map.delete(k);
  }
}
export async function fetchYahooIntradayCandles(symbol, market) {
  const mkt = String(market || 'INDIA').toUpperCase();
  const key = `ltf:${mkt}:${symbol}`;
  const hit = cacheGet(key, 120_000);
  if (hit) return hit;
  const missAt = _ltfMiss.get(key);
  if (missAt != null && Date.now() - missAt < 60_000) return null;
  // indices (^NSEI etc.) map via YF_TICKER; stocks get .NS; crypto -USD;
  // global equity futures ARE their Yahoo ticker (AAPL, NVDA…)
  const t = YF_TICKER[symbol];
  const yh = t || (mkt === 'CRYPTO' || mkt === 'FUTURES' ? `${symbol}-USD`
    : mkt === 'GLOBALFUTURES' ? String(symbol || '').toUpperCase()
      : `${symbol}.NS`);
  const interval = mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'GLOBALFUTURES' ? '1h' : '15m';
  const range = mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'GLOBALFUTURES' ? '3mo' : '1mo';
  let out = null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yh)}?interval=${interval}&range=${range}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI probrain-mtf)' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const ts = res?.timestamp;
      const q = res?.indicators?.quote?.[0];
      if (Array.isArray(ts) && q) {
        const rows = [];
        for (let i = 0; i < ts.length; i++) {
          if (q.open?.[i] == null || q.close?.[i] == null) continue;
          rows.push({
            time: ts[i] * 1000,
            open: q.open[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i],
            close: q.close[i], volume: q.volume?.[i] || 0,
          });
        }
        // v21.23.12 [S2-PARITY — LOCAL SORT INVARIANT]: Yahoo wire-order par
        // bharosa nahi — output hamesha locally-sorted ascending (mirror-proof).
        if (rows.length >= 60) out = rows.sort((a, b) => a.time - b.time);
      }
    }
  } catch { out = null; }
  // v21.23.10 [STALE-DATA AGE GATE]: Yahoo per-IP cache HTTP 200 + day-old
  // 15m series de sakta hai (live-probe: NSE OPEN me bhi last-bar 1456 min
  // purana). Pehle fetch-time cache hi fresh tha, DATA-time nahi —
  // committee kal ki bars par "fresh" vote marti thi. Stale = null →
  // v21.23.4 ladder (dataDegraded / suppress) honestly handle karta hai.
  // NSE-closed me purani session LEGITIMATE hai (gate inert).
  if (out && mkt === 'INDIA' && isStaleIntradaySeries(out, '15m', { sessionOpen: isNseOpen() })) out = null;
  if (out) cacheSet(key, out);
  else { _ltfMiss.set(key, Date.now()); _capMissMap(_ltfMiss); }
  return out;
}

// ---------------- regime (shared by all symbols of a market) ----------------
// v6.12: daily EMA trend tie-break (btcTrend / niftyTrend) — a -1.4%
// BTC day inside a daily UPTREND is a pullback; inside a DOWNTREND it
// is continuation. The regime model + probrain gate both read it.
// v6.12.1 FIX (recheck H-3): PER-MARKET timestamps — the old single
// shared `.at` meant each market's write kept re-freshening the
// other's perceived cache age, so a trend could be served 2-3× the
// intended 15-min TTL. Each market now owns its own clock; a failed
// fetch is held as a null negative for 5 min (no Yahoo hammering).
const _regimeTrendCache = {
  crypto: { at: 0, val: null },
  india: { at: 0, val: null },
  global: { at: 0, val: null },
};
const TREND_TTL = 15 * 60_000;
const TREND_NEG_TTL = 5 * 60_000;
function _trendFresh(entry) {
  if (!entry) return false;
  const age = Date.now() - entry.at;
  return entry.val ? age < TREND_TTL : age < TREND_NEG_TTL;
}
async function dailyTrend(candles) {
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const ema = (period) => {
    const k = 2 / (period + 1);
    let e = closes[0];
    for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
  };
  const e20 = ema(20), e50 = ema(50);
  const last = closes[closes.length - 1];
  if (!(e50 > 0) || !(last > 0)) return null;
  const spread = (e20 - e50) / e50 * 100;
  if (Math.abs(spread) < 0.5) return { trend: 'FLAT', spread };
  return { trend: spread > 0 ? 'UP' : 'DOWN', spread: Math.round(spread * 100) / 100 };
}
export async function buildRegime(market) {
  const mkt = String(market || 'INDIA').toUpperCase();
  // v21.8.0: + METALS — metals desk bhi BTC-anchored crypto risk-regime
  // share karta hai (same as FUTURES desk; the 13 seats candle-driven
  // hote hain, regime sirf context modifier hai).
  if (mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'METALS') {
    const q = await fetchYahooQuotes(['BTC']).catch(() => ({}));
    const c = _regimeTrendCache.crypto;
    let btcTrend = _trendFresh(c) ? c.val : null;
    if (!btcTrend) {
      const d = await fetchYahooCandles('BTC', '6mo').catch(() => null);
      btcTrend = dailyTrend(d);
      c.val = btcTrend; c.at = Date.now();
    }
    return {
      btcChange: q?.BTC?.changePct ?? null,
      btcTrend: btcTrend?.trend ?? null,
      btcTrendSpread: btcTrend?.spread ?? null,
    };
  }
  // v10.4 GLOBAL EQUITY FUTURES — the tech-complex regime: NASDAQ-100
  // 24h move + the USVIX risk read (the global desk's equivalent of
  // the crypto desk's BTC regime). Same Yahoo feed the INDIA desk
  // uses for NIFTY — one call, cached by Yahoo's own chart TTL.
  if (mkt === 'GLOBALFUTURES') {
    const q = await fetchYahooQuotes(['NDX', 'USVIX']).catch(() => ({}));
    const c = _regimeTrendCache.global;
    let ndxTrend = _trendFresh(c) ? c.val : null;
    if (!ndxTrend) {
      const d = await fetchYahooCandles('NDX', '6mo').catch(() => (null));
      ndxTrend = dailyTrend(d);
      c.val = ndxTrend; c.at = Date.now();
    }
    return {
      ndxChange: q?.NDX?.changePct ?? null,
      usVix: q?.USVIX?.price ?? null,
      ndxTrend: ndxTrend?.trend ?? null,
      ndxTrendSpread: ndxTrend?.spread ?? null,
    };
  }
  const q = await fetchYahooQuotes(['NIFTY', 'INDIAVIX']).catch(() => ({}));
  const n = _regimeTrendCache.india;
  let niftyTrend = _trendFresh(n) ? n.val : null;
  if (!niftyTrend) {
    const d = await fetchYahooCandles('NIFTY', '6mo').catch(() => (null));
    niftyTrend = dailyTrend(d);
    n.val = niftyTrend; n.at = Date.now();
  }
  return {
    niftyChange: q?.NIFTY?.changePct ?? null,
    indiaVix: q?.INDIAVIX?.price ?? null,
    niftyTrend: niftyTrend?.trend ?? null,
    niftyTrendSpread: niftyTrend?.spread ?? null,
  };
}

// ---------------- per-symbol context builders ----------------
// v21.13.0 INDIA 1H COMMITTEE REVIVAL (the Intraday INDIA tab's core fix —
// IndiaIntradayTab polls /api/ai/signals?market=INDIA → this ctx):
// pehle ind = DAILY TV snapshot + candles:null — 15/16 seats voted on
// YESTERDAY'S trend against TODAY's tape (the live-proven "90% opposite"
// disease: RELIANCE daily RSI 41.8/SHORT while the 15m RSI was 83/rally).
// Ab every India ctx carries the Yahoo 15m series (1mo, 2-min TTL cache —
// the SAME series the pass-2 tape enrichment already fetched) and the
// committee votes the 1H VIEW — the 15m series resampled to 1h — exactly
// the crypto desks' proven architecture (1h committee reads the swing +
// the 15m tape seat w1.6 times the entry + MTF-6 veto + daily HTF veto +
// regime). "Today's 1h trend", NOT "yesterday's daily trend".
//   • ctx.ind        = 1h-resampled candle ind (>=30 1h bars; thin history
//                      → honest fallback to the daily view, tape seat still
//                      votes 15m)
//   • ctx.candles    = the 15m series (SMC/chase-guard/structure read the
//                      TRADING timeframe; pass-2 replaces the SMC vote on
//                      the same series — no double count)
//   • ctx.__ltfInd   = 15m ind (expert factors' ltf — fresher wins)
//   • ctx.__dailyInd = the DAILY TV view (qualityVerdict's htf — the
//                      MISALIGNED daily-vs-15m counter-tape wiring needs
//                      the REAL HTF, not a 15m-vs-15m self-compare)
// Daily survives inside ctx.ind for relVolume (session pace), patterns/
// 52w/pivot/recommend (HTF context) and the SESSION VWAP (row.vwap — the
// month-anchored candle VWAP is NOT a session anchor). Yahoo down →
// honest degrade to the daily snapshot (pehle jaisa).
async function buildIndiaStockCtx(row, regime, preloadedCandles = null) {
  const ltp = row.ltp;
  if (!(ltp > 0)) return null;
  let candles15 = Array.isArray(preloadedCandles) && preloadedCandles.length >= 30 ? preloadedCandles : null;
  if (!candles15) {
    candles15 = await fetchYahooIntradayCandles(row.symbol, 'INDIA').catch(() => null);
    if (!Array.isArray(candles15) || candles15.length < 30) candles15 = null;
  }
  const dailyInd = tvToInd(row, ltp); // the DAILY view — the HTF reference
  let ind = dailyInd;
  let h1Candles = null;
  // v21.23.4 WRONG-SIGNAL-REMOVAL (user: "sab ke sab opposite jaa rahe hai"):
  // 15m/1h series missing → pehle committee SILENTLY daily view pe vote karti
  // thi — in-repo documented live-proven "90% opposite" disease (RELIANCE daily
  // RSI 41.8/SHORT jabki 15m RSI 83/rally). Aise signals hi "wrong direction"
  // lagte the. Ab ctx degraded stamp hota hai → board path inhe SUPPRESS
  // karta hai (signal remove, honest reason surface) — fabricated intraday
  // direction NAHI. Daily view sirf HTF-context rahega, signal nahi.
  let __tfDegraded = null;
  let __tfDataThin = false;
  if (!candles15) {
    __tfDegraded = 'INTRADAY-TF-UNAVAILABLE (15m series missing — daily-fallback would vote yesterday\'s trend — the documented "90% opposite" disease)';
  }
  if (candles15) {
    // v21.13: the committee votes the 1H view — 15m series resampled to
    // 1h (1mo of 15m ≈ 500 bars → ~125 1h bars; a thin fixture/history
    // under 30 1h bars degrades honestly to the daily view). ctx.candles
    // = the 1h series TOO (crypto-desk mirror: sr/momentum/structure ka
    // candle-geometry 1h pe; the 15m stays the TAPE seat's series — pass-2
    // fetch + __ltfInd). A coherent pair: ind 1h + candles 1h.
    const h1 = resampleCandles(candles15, 60);
    h1Candles = (Array.isArray(h1) && h1.length >= 30) ? h1 : null;
    // v21.23.4: THIN ≠ missing. 15m series PRESENT hai — tape seat (w 1.6
    // counterweight) + SMC revival is 15m pe zinda; sirf main ind daily-view
    // pe hai. Suppress nahi — sirf DATA-DEGRADED stamp (auto-trade BLOCK,
    // reference display). Full-missing case (__tfDegraded) hi suppress hota hai.
    if (!h1Candles) __tfDataThin = true;
    const ci = h1Candles ? computeIndicatorsFromCandles(h1Candles) : null;
    if (ci) {
      ind = {
        ...ind, ...ci,
        // daily/session fields that must SURVIVE the 1h override:
        relVolume: ind.relVolume ?? (ci.avgVolume20 > 0 ? +(ci.volume / ci.avgVolume20).toFixed(2) : null),
      };
      if (row.vwap != null && row.vwap > 0) ind.vwap = row.vwap; // SESSION VWAP (not the month-anchored candle VWAP)
    }
  }
  const ctx = {
    market: 'INDIA', symbol: row.symbol, ltp, changePct: row.changePct ?? 0,
    volume: row.volume ?? 0, exchange: row.exchange || 'NSE',
    // accuracy-plan Phase 2.2: per-stock REAL option-chain ctx (PCR /
    // max-pain / IV / OI-skew) for the top-F&O turnover names — the
    // cached snapshot (10-min TTL, nse/bse chains only); absent names
    // honestly abstain exactly as before.
    ind, candles: h1Candles || candles15 || null,
    __dailyInd: dailyInd,
    __tfDegraded, __tfDataThin,
    options: _stockOptionsSnapshot(row.symbol), regime,
  };
  // v21.13: attach moved INSIDE (board + deep path both get __tv/__ltfInd
  // consistently — the deep card and the board card vote identically).
  // __ltfInd = the 15m view (expert factors' ltf — fresher wins; pass-2
  // tape/SMC read the same 15m series).
  attachSuperCtx(ctx, row, candles15 || null);
  return ctx;
}

// v21.13.x DEEP-RECHECK FIX (B3): INDEX contexts (NIFTY/BANKNIFTY — aur
// deep dives pe FINNIFTY/SENSEX) pehle SIRF daily 6mo candles pe bante
// the — ind = DAILY indicators, plan DAILY ATR geometry pe anchored, aur
// pass-1 revival kabhi fire hi nahi hota tha (ctx.__ltfInd undefined).
// Wo exactly wahi disease-class hai jo v21.13 ne stocks ke liye fix kiya
// (daily RSI SHORT-zone vs 15m rally). Ab index ctx bhi the SAME
// 15m→1h chain use karta hai: committee 1H view pe vote karti hai
// (15m series resampled), __dailyInd = the REAL daily HTF reference,
// __ltfInd = the 15m view (pass-1 revival fires — SMC/structure revival
// + pattern/sr/volume/volatility second votes, stocks ki tarah).
// Yahoo 15m down → honest daily fallback (pehle jaisa, koi penalty nahi).
// (exported for the regression suite — the v2113x index-chain locks.)
export async function buildIndiaIndexCtx(idx, regime, optionsCtx = null) {
  // contract guard: INDEX tickers only (YF_TICKER keys — NIFTY/BANKNIFTY/
  // FINNIFTY/SENSEX/INDIAVIX). An unknown STOCK symbol must NOT land here
  // (it would get isIndex:true — wrong semantics); it keeps the honest
  // "No data" answer exactly as before.
  if (!YF_TICKER[idx]) return null;
  const [candles15, daily] = await Promise.all([
    fetchYahooIntradayCandles(idx, 'INDIA').catch(() => null),
    fetchYahooCandles(idx, '6mo'),
  ]);
  const has15 = Array.isArray(candles15) && candles15.length >= 30;
  if (!has15 && !daily) return null;
  const dailyCi = Array.isArray(daily) ? computeIndicatorsFromCandles(daily) : null;
  const dailyInd = dailyCi ? {
    ...dailyCi, recommend: null,
    high52w: Math.max(...daily.map(c => c.high)),
    low52w: Math.min(...daily.map(c => c.low)),
  } : null;
  // the 1H committee view (stocks ki exact mirror)
  let ind = dailyInd;
  let h1Candles = null;
  // v21.23.4: index ctx me bhi same data-degradation stamp (stocks mirror)
  let __tfDegraded = null;
  let __tfDataThin = false;
  if (!has15) {
    __tfDegraded = 'INTRADAY-TF-UNAVAILABLE (index 15m series missing — daily-fallback would vote yesterday\'s trend — the documented "90% opposite" disease)';
  }
  if (has15) {
    const h1 = resampleCandles(candles15, 60);
    h1Candles = (Array.isArray(h1) && h1.length >= 30) ? h1 : null;
    // v21.23.4: THIN ≠ missing (stock mirror) — stamp, suppress nahi
    if (!h1Candles) __tfDataThin = true;
    const ci = h1Candles ? computeIndicatorsFromCandles(h1Candles) : null;
    if (ci) {
      ind = {
        ...(dailyInd || {}), ...ci,
        // HTF fields that must SURVIVE the 1h override (stock mirror):
        high52w: dailyInd?.high52w ?? null,
        low52w: dailyInd?.low52w ?? null,
        relVolume: dailyInd?.relVolume ?? (ci.avgVolume20 > 0 ? +(ci.volume / ci.avgVolume20).toFixed(2) : null),
        // SESSION VWAP (stock mirror: the series VWAP is NOT a session
        // anchor — indexes carry no TV row, so today's 15m bars se the
        // honest session anchor; zero-volume index bars → null abstain)
        vwap: sessionVwapFromIntraday(candles15),
      };
    }
  }
  if (!ind) return null;
  const ltp = has15 ? Number(candles15[candles15.length - 1].close) : Number(ind.ltp);
  if (!(ltp > 0)) return null;
  // honest day-change: aaj ke 15m bars ka open→last (freshest), warna
  // daily last-vs-prev close, warna 0 (pehle hamesha 0 tha)
  let changePct = 0;
  if (has15) {
    const lastDay = new Date(candles15[candles15.length - 1].time).toISOString().slice(0, 10);
    const todays = candles15.filter(c => new Date(c.time).toISOString().slice(0, 10) === lastDay);
    if (todays.length >= 2 && todays[0].open > 0) {
      changePct = +(((todays[todays.length - 1].close / todays[0].open) - 1) * 100).toFixed(2);
    }
  } else if (Array.isArray(daily) && daily.length >= 2 && daily[daily.length - 2].close > 0) {
    changePct = +(((daily[daily.length - 1].close / daily[daily.length - 2].close) - 1) * 100).toFixed(2);
  }
  const ctx = {
    market: 'INDIA', symbol: idx, ltp, changePct,
    isIndex: true, volume: 0,
    ind, candles: h1Candles || (has15 ? candles15 : daily) || null,
    __dailyInd: dailyInd, __tfDegraded, __tfDataThin, options: optionsCtx, regime,
  };
  // __tv = null (no TV scanner row for indexes — the chase guard + tape
  // VWAP already handle a null row honestly); __ltfInd = the 15m view.
  attachSuperCtx(ctx, null, has15 ? candles15 : null);
  return ctx;
}

// SESSION VWAP from today's intraday bars (UTC-date grouping is safe for
// NSE hours — no midnight crossing). Zero-volume series (Yahoo ^NSEI) →
// null (honest abstain — NEVER the month-anchored series VWAP).
function sessionVwapFromIntraday(candlesIn) {
  // v21.23.12 [L2.5]: lastDay candles[len-1] se padha jaata hai — mirrored
  // series pe galat din-group banata tha. ensureAscending entry-guard.
  const candles = ensureAscending(candlesIn);
  if (!Array.isArray(candles) || !candles.length) return null;
  const lastDay = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
  let pv = 0, vv = 0;
  for (const c of candles) {
    if (new Date(c.time).toISOString().slice(0, 10) !== lastDay) continue;
    const v = Number(c.volume) || 0;
    pv += ((c.high + c.low + c.close) / 3) * v;
    vv += v;
  }
  return vv > 0 ? +(pv / vv).toFixed(2) : null;
}

// (v6.3: the async buildCryptoCtx + buildIndexCtx duplicates were removed —
// the board uses buildCryptoCtxSync and inlines its index contexts.)

// ---------------- v9.3: the 15m TAPE READ ----------------
// Compact intraday-tape snapshot fed to the IntradayTape model (the
// trading-timeframe seat on the India desk). Built from the SAME 15m
// Yahoo candles the pass-2 enrichment already fetches + the TV row's
// TRUE session VWAP (the month-anchored candle VWAP is not a session
// anchor — the scanner row is).
function tapeFromCandles(candlesIn, li, tvRow) {
  // v21.23.12 [L2.5]: last3Pct RAW tail reads (last/bar3) karta hai — li
  // compute-layer se canonical aa chuka tha par raw reads mirrored input pe
  // ULTA momentum vote dete the (correct EMA, reversed 3-bar momentum).
  const candles = ensureAscending(candlesIn);
  if (!Array.isArray(candles) || candles.length < 35 || !li) return null;
  const last = candles[candles.length - 1];
  const bar3 = candles[candles.length - 4] || candles[0];
  if (!last || !(last.close > 0)) return null;
  const last3Pct = bar3 && bar3.close > 0 ? ((last.close - bar3.close) / bar3.close) * 100 : null;
  return {
    ltp: Number.isFinite(li.ltp) && li.ltp > 0 ? li.ltp : last.close,
    ema10: li.ema10 ?? null, ema20: li.ema20 ?? null, ema50: li.ema50 ?? null,
    rsi: li.rsi ?? null,
    macdHist: li.macd?.hist ?? null, macdSlope: li.macd?.histSlope ?? null,
    vwap: tvRow?.vwap ?? null, // session VWAP from the scanner row
    last3Pct,
  };
}

// ---------------- v12.6: CRYPTO/FUTURES 15m TAPE ----------------
// THE DIRECTION-ACCURACY FIX (live ground truth 2026-09-20: the replay
// engine measured the raw crypto ensemble at 29% win-rate / avgR −0.35
// — "long bola tho short jaa raha hai" was the board confirming moves
// 2-13% AFTER they happened). The 1h committee reads the SWING; this
// 15m tape read is the ENTRY-TIMING counterweight the tape seat now
// votes on (models.js v12.6 data-driven gate).
//   CRYPTO spot: CoinDCX public 15m (INR domain) → Binance/Bybit 15m
//   klines rescaled onto the coin's INR anchor (the board's own chain).
//   FUTURES: CoinDCX futures 15m candles (USDT domain — 1:1 with the
//   desk) → Binance 15m klines (USDT, no rescale needed).
// Candle legs ride the v12.6 TTL candle cache (5 min) — ONE upstream
// call per symbol per 5 minutes, negligible against the board budget.
async function fetchCrypto15mTape(base, ltp, tvRow, mkt) {
  try {
    let candles = null;
    // v21.8.0: + METALS — B-XAU_USDT/B-XAG_USDT bhi futures 15m candles
    // hi use karte hain; Binance SPOT fallback (fetchBinanceKlines) metals
    // ke liye bekaar hai (XAU/XAG spot pe listed nahi) → fapi klines leg.
    if (mkt === 'FUTURES' || mkt === 'GLOBALFUTURES' || mkt === 'METALS') {
      candles = await fetchFuturesCandles(futuresPairFor(base), '15', 240).catch(() => null);
      if (!Array.isArray(candles) || candles.length < 60) {
        // Binance/Bybit USDT 15m klines are ALREADY the desk's domain.
        if (isMetalsBase(base)) {
          // v21.9.0: fapi (interval FIXED) → Yahoo COMEX 15m rescaled.
          candles = await fetchMetalsCandleChain(base, '15', ltp, 240).catch(() => null);
        } else {
          candles = await fetchBinanceKlines(base, '15m').catch(() => null);
        }
      }
    } else {
      candles = await fetchCoinDcxCandles(base, '15m').catch(() => null);
      if (!Array.isArray(candles) || candles.length < 60) {
        const bk = await fetchBinanceKlines(base, '15m').catch(() => null);
        if (Array.isArray(bk) && bk.length >= 60 && ltp > 0) {
          const expected = tvRow?.usdPrice > 0 ? ltp / tvRow.usdPrice : null;
          candles = rescaleCandlesToLtp(bk, ltp, expected);
        }
      }
    }
    if (!Array.isArray(candles) || candles.length < 60) return null;
    const li = computeIndicatorsFromCandles(candles);
    if (!li) return null;
    // v20.4 VWAP DOMAIN FIX: the TV row's vwap is USD-domain while the
    // crypto-spot candles are INR — unscaled, the tape vote's VWAP leg
    // compared an INR ltp against a USD vwap (~×85 off) so EVERY crypto
    // tape paid the "far from VWAP" mean-reversion penalty on whichever
    // side the mismatch pointed. Scale the row's vwap onto the candle
    // domain (≈×1 on the USDT futures desks — no-op there; no-op when
    // the row carries no vwap).
    let tvForTape = tvRow || null;
    if (tvRow && tvRow.vwap != null && li.ltp > 0 && tvRow.usdPrice > 0) {
      const vs = (li.ltp / tvRow.usdPrice) * Number(tvRow.vwap);
      if (Number.isFinite(vs) && vs > 0) tvForTape = { ...tvRow, vwap: vs };
    }
    const tape = tapeFromCandles(candles, li, tvForTape);
    return tape ? { tape, ltfInd: li, candles } : null;
  } catch {
    return null; // honest degrade — the seat abstains, board rides on
  }
}

// ---------------- v10.5: MTF CONFLUENCE DATA LAYER ----------------
// Upgrade 1 — the 5m/15m/1h tapes from ONE extra 5m fetch:
//   • 5m tape  = the base series itself (entry-timing TF)
//   • 15m tape = the NATIVE 15m candles the pass-2 already fetched
//                (resample fallback when the native fetch failed)
//   • 1h tape  = 5m base resampled server-side (no extra API call —
//                the plan's rule: resample, don't re-fetch)
// agreement is computed the SAME way the model does it (matching
// dirs vs the 15m anchor / 3) so the badge, the vote and the
// ensemble cap can never disagree.

/** Pure time-bucketed OHLCV resampler. Buckets align to epoch
 * boundaries (15m → :00/:15/:30/:45, 1h → UTC hours) exactly like
 * Yahoo's native bars. Exported for tests. */
export function resampleCandles(candlesIn, minutes) {
  // v21.23.12 [L2.5]: mtf.js _resample ka twin — wahan L2 guard hai,
  // yahan nahi tha. Mirrored input yahan MIRRORED BUCKETS banata tha jo
  // downstream ensureAscending bhi repair nahi kar sakta (bucket.close
  // = oldest-in-bucket corruption). India committee ka 15m→1h isi se
  // banta hai (v21.23.4 core chain) — guard mandatory.
  const candles = ensureAscending(candlesIn);
  if (!Array.isArray(candles) || candles.length < 2 || !(minutes > 0)) return null;
  const bucketMs = minutes * 60_000;
  const out = [];
  let cur = null;
  let curKey = -1;
  for (const c of candles) {
    const t = Number(c.time);
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close), v = Number(c.volume) || 0;
    if (!Number.isFinite(t) || !Number.isFinite(cl)) continue;
    const key = Math.floor(t / bucketMs);
    if (key !== curKey) {
      if (cur) out.push(cur);
      curKey = key;
      cur = { time: key * bucketMs, open: o, high: h, low: l, close: cl, volume: v };
    } else if (cur) {
      cur.high = Math.max(cur.high, h);
      cur.low = Math.min(cur.low, l);
      cur.close = cl;
      cur.volume += v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 5m base bars (India desk) — cached 2 min, negative-cached 60s,
 * same pattern as fetchYahooIntradayCandles. */
const _ltf5mMiss = new Map();
export async function fetchYahoo5mCandles(symbol) {
  const key = `ltf5m:INDIA:${symbol}`;
  const hit = cacheGet(key, 120_000);
  if (hit) return hit;
  const missAt = _ltf5mMiss.get(key);
  if (missAt != null && Date.now() - missAt < 60_000) return null;
  const t = YF_TICKER[symbol];
  const yh = t || `${symbol}.NS`;
  let out = null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yh)}?interval=5m&range=1mo`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WealthAI probrain-mtf)' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const ts = res?.timestamp;
      const q = res?.indicators?.quote?.[0];
      if (Array.isArray(ts) && q) {
        const rows = [];
        for (let i = 0; i < ts.length; i++) {
          if (q.open?.[i] == null || q.close?.[i] == null) continue;
          rows.push({
            time: ts[i] * 1000,
            open: q.open[i], high: q.high?.[i] ?? q.close[i], low: q.low?.[i] ?? q.close[i],
            close: q.close[i], volume: q.volume?.[i] || 0,
          });
        }
        if (rows.length >= 60) out = rows;
      }
    }
  } catch { out = null; }
  if (out) cacheSet(key, out);
  else { _ltf5mMiss.set(key, Date.now()); _capMissMap(_ltf5mMiss); }
  return out;
}

/** The MTF tape payload: { m5, m15, h1, agreement } — each a plain
 * tape snapshot (same shape ctx.tape uses), agreement vs the 15m
 * anchor. Pure; null on insufficient data. */
export function tapeMTFFromBase(candles5mIn, candles15mNative, tvRow) {
  // v21.23.12 [L2.5]: 5m base + 15m native dono ko entry pe seedha kar
  // lete hain — mkTape/resample legs isi base se derive hote hain.
  const candles5m = ensureAscending(candles5mIn);
  const candles15mNat = ensureAscending(candles15mNative);
  const mkTape = (candles) => {
    if (!Array.isArray(candles) || candles.length < 35) return null;
    const li = computeIndicatorsFromCandles(candles);
    return tapeFromCandles(candles, li, tvRow);
  };
  if (!Array.isArray(candles5m) || candles5m.length < 60) return null;
  const m5 = mkTape(candles5m);
  const m15 = candles15mNat && candles15mNat.length >= 35 ? mkTape(candles15mNat) : mkTape(resampleCandles(candles5m, 15));
  const h1 = mkTape(resampleCandles(candles5m, 60));
  if (!m5 || !m15) return null; // anchor + entry TF required; h1 optional
  const dirOf = (t) => {
    const v = tapeVote(t, 'mtf');
    return v.dir;
  };
  const d5 = dirOf(m5), d15 = dirOf(m15), dh = h1 ? dirOf(h1) : 0;
  const agreement = d15 === 0 ? null : [d5, d15, dh].filter(d => d === d15).length / 3;
  return { m5, m15, ...(h1 ? { h1 } : {}), agreement };
}

/** Compact MTF wire payload for the signal card (dirs + conf only). */
export function mtfWirePayload(tapeMTF) {
  if (!tapeMTF || typeof tapeMTF !== 'object' || !tapeMTF.m15) return null;
  const compact = (t) => {
    if (!t) return null;
    const v = tapeVote(t, 'mtf');
    return { dir: v.dir, conf: v.conf };
  };
  return {
    m5: compact(tapeMTF.m5),
    m15: compact(tapeMTF.m15),
    h1: compact(tapeMTF.h1 || null),
    agreement: tapeMTF.agreement,
  };
}

// ---------------- AI COUNCIL (LLM chain) ----------------
// v18.8 ENGINE CHAIN UNIFICATION: the private 4-provider ladder that
// used to live here (gemini→groq→cerebras→openrouter, NO sentinel,
// NO huggingface/nvidia, NO local ollama) is DELETED — the board's AI
// Council seat now rides the ONE shared chain (sentinel health-tracked,
// 6 cloud engines + keyless local ollama, provider-aware timeouts).
// One chain, one health ledger, one place to fix.

/**
 * Normalize a council candidate to the FLAT shape the prompt builder
 * reads (symbol/side/confidence/ltp/changePct/ind/plan/votes). Both
 * call sites feed it differently:
 *   • the BOARD passes {ctx, votes, consensus, plan} — symbol/side/conf
 *     live on ctx/consensus, NOT on the candidate itself
 *   • the DEEP path passes {symbol, side, ctx, votes, ...}
 * Without this normalization the LLM was being prompted with
 * undefined symbol/side/ltp/indicators — the 9th model never actually
 * voted and its verdicts could never match a symbol key.
 */
export function toCouncilCandidate(c) {
  if (!c) return null;
  const ctx = c.ctx || {};
  const cons = c.consensus || {};
  return {
    symbol: c.symbol ?? ctx.symbol,
    side: c.side ?? cons.side,
    confidence: c.confidence ?? cons.confidence,
    ltp: c.ltp ?? ctx.ltp,
    changePct: c.changePct ?? ctx.changePct,
    ind: c.ind ?? ctx.ind,
    plan: c.plan ?? null,
    votes: c.votes || [],
  };
}

/**
 * Compact the council candidates once — shared by the legacy
 * single-shot prompt AND the v10.8 debate chain (one truth).
 */
function compactCouncilCandidates(candidates) {
  return candidates.map(toCouncilCandidate).filter(c => c && c.symbol).map(c => ({
    sym: c.symbol, side: c.side, conf: c.confidence, ltp: r2(c.ltp),
    chg: c.changePct, rsi: r2(c.ind?.rsi), adx: r2(c.ind?.adx?.adx),
    relVol: r2(c.ind?.relVolume), vwapDist: c.ind?.vwap && c.ltp ? r2(((c.ltp - c.ind.vwap) / c.ind.vwap) * 100) : null,
    atrPct: c.ltp && c.ind?.atr ? r2((c.ind.atr / c.ltp) * 100) : null,
    plan: c.plan ? { e: c.plan.entry, sl: c.plan.stopLoss, t1: c.plan.target1, t2: c.plan.target2 } : null,
    votes: (c.votes || []).filter(v => v.dir !== 0).map(v => `${v.name}:${v.dir > 0 ? '+' : '-'}${v.conf}`).join(', '),
  }));
}

// councilAsk itself now comes from ./llmChain.js (the v18.8 shared
// chain — imported at the top of this file).

// ---------------- v10.8 PRO #1: BULL/BEAR DEBATE COUNCIL ----------------
// (Vibe-Trading investment-committee port). The old single-shot prompt
// asked ONE brain to be neutral — one-sided narration slipped through.
// The debate runs THREE bounded steps on the same grounded data:
//   1. BULL ADVOCATE — builds the strongest honest LONG case per symbol
//   2. BEAR ADVOCATE — builds the strongest honest SHORT case per symbol
//   3. PM VERDICT — must cite where bull/bear DISAGREE and why it sides
//      one way, then issues the SAME verdict shape as the legacy path.
// Any step failing → honest null → the caller falls back to the legacy
// single-shot prompt (resilience first). Cost: ≤3 short LLM calls per
// board cycle, only over the top candidates (already ≤5).
export function councilDebateEnabled() {
  const v = String(process.env.AI_COUNCIL_DEBATE || '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no', 'disable', 'disabled'].includes(v)) return false;
  return true; // default ON (v10.8)
}

/**
 * The 3-step debate. PURE-ish (network only via councilAsk).
 * v21.0.6 [audit B1/G1]: opts.deep = true → teeno debate calls
 * councilAskDeep (OLLAMA_DEEP_MODEL, e.g. deepseek-r1:14b) pe jati hain.
 * Pehle sirf legacy single-shot fallback deep model use karta tha —
 * default debate=ON hone ki wajah se 🔬 deep modal ka council HAMESHA
 * scan model (qwen3:8b) pe chalta tha, jabki chip "↗R1·14B" ka
 * promise deep path ko tha. Cloud legs ke liye deep flag no-op hai
 * (sirf local ollama leg swap hota hai).
 * @returns {Promise<{verdicts:object, model:string, online:true,
 *                     debate:{bull:object, bear:object}}|null>}
 */
export async function aiCouncilDebate(candidates, deps, market, opts = {}) {
  const compact = compactCouncilCandidates(candidates);
  if (compact.length === 0) return null;
  const ask = opts.deep ? councilAskDeep : councilAsk;
  const venue = market === 'CRYPTO'
    ? 'CoinDCX spot (INR pairs, 24/7)'
    : market === 'FUTURES'
      ? 'CoinDCX GLOBAL FUTURES (USDT-margined perpetuals, 24/7, leveraged)'
      : market === 'GLOBALFUTURES'
        ? 'global equity perpetual futures SIM desk (USDC-margined, 24/7)'
        : 'NSE India (options-led desk)';
  const data = JSON.stringify(compact, null, 1);
  // v2 SentimentPulse parity (the legacy single-shot path injects the
  // same context — the debate must not silently lose the feature).
  const sentCtx = v2ModelsEnabled() ? sentimentContextFor(market) : null;
  const sentLines = sentCtx ? `\n${sentCtx}` : '';

  // ---- STEP 1: BULL ADVOCATE ----
  const bull = await ask(`You are the BULL ADVOCATE on an institutional investment committee for a ${venue} desk.
Below are pre-scored consensus candidates from a 14-model quant ensemble. Your ONE job: build the strongest HONEST LONG case for EACH symbol using ONLY the numbers given (RSI/ADX/relVol/VWAP distance/ATR%/plan levels/votes). Never invent data; if a long case is weak, say so honestly and score it low.

${data}

Respond STRICT JSON only: {"cases":{"SYMBOL":{"case":"2 sentences: the strongest long thesis grounded in the numbers","strength":0-100}}}`, deps);
  if (!bull?.json?.cases || typeof bull.json.cases !== 'object') return null;

  // ---- STEP 2: BEAR ADVOCATE ----
  const bear = await ask(`You are the BEAR ADVOCATE on an institutional investment committee for a ${venue} desk.
Below are the SAME pre-scored consensus candidates. Your ONE job: build the strongest HONEST SHORT case for EACH symbol using ONLY the numbers given (overbought RSI, exhaustion, thin volume, counter-regime, funding/crowding, stop placement risk). Never invent data; if a short case is weak, say so honestly and score it low.

${data}

Respond STRICT JSON only: {"cases":{"SYMBOL":{"case":"2 sentences: the strongest short thesis grounded in the numbers","strength":0-100}}}`, deps);
  if (!bear?.json?.cases || typeof bear.json.cases !== 'object') return null;

  // ---- STEP 3: PM VERDICT (must cite the disagreement) ----
  const pm = await ask(`You are the PORTFOLIO MANAGER — the final verification layer of a superintelligence ensemble for a ${venue} desk.
Your bull and bear advocates have argued over these candidates. For EACH symbol you MUST (a) name where the two cases DISAGREE (which numbers each side leans on), and (b) state WHY you side one way. Then issue the verdict. Be strict: an edge must be confluence-driven, not single-factor. Penalize extreme 24h moves, thin books, counter-BTC-regime calls${market === 'GLOBALFUTURES' ? ', and remember these are USDC-margined equity perps' : ''}.

CANDIDATE DATA:
${data}

BULL ADVOCATE:
${JSON.stringify(bull.json.cases, null, 1)}

BEAR ADVOCATE:
${JSON.stringify(bear.json.cases, null, 1)}${sentLines}

Respond STRICT JSON only (no markdown):
{"verdicts":{"SYMBOL":{"verdict":"LONG"|"SHORT"|"AVOID","confidence":0-100,"note":"max 12 words","analysis":"2 sentences: where bull/bear disagree + why you side one way — indicator state, timing quality, risk"}}}`, deps);
  if (!pm?.json?.verdicts || typeof pm.json.verdicts !== 'object') return null;

  // fold the council's optional sentiment read back into the cache
  // (same parity as the legacy path).
  if (pm.json.sentiment) absorbCouncilSentiment({ ...pm.json.sentiment, model: pm.model }, market);

  return {
    verdicts: pm.json.verdicts,
    model: pm.model || 'debate',
    online: true,
    debate: { bull: bull.json.cases, bear: bear.json.cases },
  };
}

/**
 * AI Council: verify top candidates via LLM (Gemini → Groq → Cerebras
 * → OpenRouter). Returns { verdicts: {symbol: {verdict, confidence,
 * note, analysis}}, model: provider | null }.
 *
 * v10.8: the 3-step bull/bear debate runs FIRST (default ON); any step
 * failing degrades to this legacy single-shot path — never offline
 * just because the debate chain hiccuped.
 */
export async function aiCouncilVerify(candidates, deps, market, opts = {}) {
  // v18.8: cloud keys OR a reachable local ollama — the council goes
  // online for a zero-cloud-key local install too (the "AI language
  // engines offline" message dies with an Ollama on the machine).
  if (!candidates?.length || !(aiKeysPresent(deps?.KEYS) || !!(await ollamaProbe().catch(() => false)))) return { verdicts: {}, model: null, online: false };
  if (councilDebateEnabled()) {
    const debated = await aiCouncilDebate(candidates, deps, market, opts).catch(() => null);
    if (debated && debated.online) return debated;
  }
  const norm = candidates.map(toCouncilCandidate).filter(c => c && c.symbol);
  if (norm.length === 0) return { verdicts: {}, model: null, online: false };
  const compact = compactCouncilCandidates(norm);
  const venue = market === 'CRYPTO'
    ? 'CoinDCX spot (INR pairs, 24/7). Penalize extreme 24h moves, thin books, counter-BTC-regime calls.'
    : market === 'FUTURES'
      ? 'CoinDCX GLOBAL FUTURES (USDT-margined perpetuals, 24/7, leveraged). Penalize extreme 24h moves, funding-fighting continuation calls, thin books, counter-BTC-regime calls.'
      : 'NSE India (options-led desk). Penalize RSI exhaustion, low ADX, thin relative volume, and VIX spikes.';
  // v2 SentimentPulse reuse (plan Phase 1): the SAME council call also
  // carries the sentiment desk's context — no extra LLM cost — and the
  // response may return an optional `sentiment` block that gets folded
  // back into the sentiment cache for the next cycle.
  const sentCtx = v2ModelsEnabled() ? sentimentContextFor(market) : null;
  const sentLines = sentCtx ? `\n${sentCtx}` : '';
  const prompt = `You are the AI COUNCIL — the final verification layer of a ${MODELS.length}-model superintelligence ensemble for a ${venue}.

Below are pre-scored consensus candidates. For EACH, analyze deeply and either CONFIRM or VETO. Be strict: an edge must be confluence-driven, not single-factor.

${JSON.stringify(compact, null, 1)}${sentLines}

Respond STRICT JSON only (no markdown):
{"verdicts":{"SYMBOL":{"verdict":"LONG"|"SHORT"|"AVOID","confidence":0-100,"note":"max 12 words","analysis":"2 sentences: your reasoning chain — indicator state, timing quality, risk"}}}`;

  // v18.8: the ONE shared chain — sentinel health-aware, HF/NVIDIA
  // capable, ends at the keyless local ollama engine (90s local budget).
  // v20.6.1: opts.deep = true → the deep path (getDeepSignal) uses
  // OLLAMA_DEEP_MODEL (deepseek-r1:14b) instead of OLLAMA_MODEL
  // (qwen3:8b) for the local-engine leg. The board path always passes
  // opts.deep=false (default) — the scan model is never swapped.
  const asked = opts.deep ? await councilAskDeep(prompt, deps) : await councilAsk(prompt, deps);
  const verdicts = asked.json;
  const model = asked.model;

  // fold the council's optional sentiment read back into the cache
  if (verdicts?.sentiment) absorbCouncilSentiment({ ...verdicts.sentiment, model }, market);

  const out = verdicts?.verdicts && typeof verdicts.verdicts === 'object' ? verdicts.verdicts : {};
  return { verdicts: out, model, online: model != null };
}

// ---------------- the signal board ----------------
// ---------------- v6.9 TOP-5 COMPOSITE RANKING ----------------
// The user's "full universe analyze karke top 5 accurate signals" —
// a transparent composite score over the FINAL board signals. Every
// factor is normalized to 0-100 so weights are honest:
//   0.40 × confidence        — the committee's conviction
//   0.20 × agreement×100     — how many voting models align
//   0.15 × min(R:R,3)/3×100  — reward:risk (capped at 3, diminishing)
//   0.10 × participation×100 — quorum: how many models actually voted
//   0.10 × regime alignment  — trade direction with the market regime
//   0.05 × momentum          — |24h change| tiebreak (capped at 3%)
// Only actionable signals (STRONG/ACTION, non-neutral side, plan present)
// are eligible. Fewer than 5 eligible → shorter list (honest, never padded).
// ---------------- v18.6.1 STALENESS & QUORUM (board integrity) -------
// Board review case (CoinDCX Global Futures CL SHORT, 4/9 votes, 1h 7m
// stale, pinned at the top of the board): the direction math was RIGHT
// (a pullback-sell design), but three structural gaps let a stale,
// under-quorum signal sit at rank #1 looking exactly as actionable as a
// fresh full-committee one. Fixed here:
//   1. QUORUM HARD GATE — fewer than MIN_QUORUM_VOTES directional votes
//      → NOT eligible for the top-5 headline ranking. The signal stays
//      on the full board with its ⚠ capped chip — it just never gets
//      presented as a top pick.
//   2. STALENESS DECAY — a signal the board hasn't re-confirmed in 30m+
//      loses ranking score (linear to ×0.15 at 60m, floored — never 0:
//      a still-voting old signal loses PRIORITY visibly, it doesn't
//      vanish).
const MIN_QUORUM_VOTES = (() => {
  const n = Number.parseInt(String(process.env.AI_MIN_TOPFIVE_QUORUM ?? ''), 10);
  if (!Number.isFinite(n)) return 5; // default 5 of ~9-10 seats — the board's own "capped" threshold
  return Math.max(0, Math.min(9, n)); // 0 = gate disabled; >9 would empty the board
})();

/** Directional (non-abstain) vote count — the honest quorum number
 *  behind the "4/9 votes" chip. Votes array preferred; falls back to
 *  the voters field; null = unknown → gate PASSES (an unknown quorum
 *  must never silently empty the board). */
function directionalVotesOf(s) {
  if (Array.isArray(s?.votes)) return s.votes.filter(v => v && v.dir !== 0).length;
  const n = Number(s?.voters);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** v18.6.1 STALENESS DECAY — how much of a signal's composite score
 *  survives given how long ago the board LAST re-confirmed this side
 *  (signalAge.lastSeenAt; firstSeenAt/generatedAt/now as fallbacks).
 *    0–30 min → 1.00 (fresh, full weight)
 *    30–60 min → linear 1.00 → 0.15
 *    60+ min → 0.15 floor (visible demotion, not deletion)
 *  Pure + exported for tests. */
export function stalenessFactor(s, now = Date.now()) {
  const age = s?.signalAge;
  const lastSeen = Number(age?.lastSeenAt) > 0 ? Number(age.lastSeenAt)
    : Number(age?.firstSeenAt) > 0 ? Number(age.firstSeenAt)
      : Number(s?.generatedAt) > 0 ? Number(s.generatedAt)
        : now;
  const ageMin = Math.max(0, (now - lastSeen) / 60000);
  if (ageMin <= 30) return 1;
  if (ageMin >= 60) return 0.15;
  return 1 - 0.85 * ((ageMin - 30) / 30);
}

export function computeTopFive(signals, regime, market = 'INDIA', limit = 5) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const mkt = String(market || 'INDIA').toUpperCase();
  // v10.4: GLOBALFUTURES regime = NDX (the tech-complex barometer)
  const rawRegime = mkt === 'INDIA' ? regime?.niftyChange : mkt === 'GLOBALFUTURES' ? regime?.ndxChange : regime?.btcChange;
  const regimeChange = rawRegime == null ? null : Number(rawRegime);
  const regimeLabel = mkt === 'INDIA' ? 'NIFTY' : mkt === 'GLOBALFUTURES' ? 'NASDAQ' : 'BTC';
  const eligible = signals.filter(s =>
    s && (s.grade === 'STRONG' || s.grade === 'ACTION')
    && (s.side === 'LONG' || s.side === 'SHORT')
    && s.plan && Number.isFinite(s.plan.entry)
    // v21.3.0 (Issue-5): AI CONFLICT signals kabhi TOP-5 nahi ban
    // sakte — provider ulta side chunta ho toh headline slot usse
    // waste nahi hoga (board card pe CONFLICT chip dikhta hai).
    && s.aiConfirm?.verdict !== 'CONFLICT'
    // v18.6.1 Fix 2 — quorum hard gate: thin/under-voted signals (the
    // 4/9 CL case) never compete for the headline top-5 slots. Unknown
    // quorum (null) passes — honest degrade, never a silent empty board.
    && (MIN_QUORUM_VOTES <= 0 || (directionalVotesOf(s) ?? MIN_QUORUM_VOTES) >= MIN_QUORUM_VOTES));
  const scored = eligible.map(s => {
    const conf = Math.max(0, Math.min(100, Number(s.confidence) || 0));
    const agree = Math.max(0, Math.min(100, (Number(s.agreement) || 0) * 100));
    const rr = Math.max(0, Math.min(3, Number(s.plan?.rewardRisk) || 0));
    const part = Math.max(0, Math.min(1, Number(s.participation ?? 1) || 0));
    const sideIsLong = s.side === 'LONG';
    const aligned = regimeChange != null && Number.isFinite(regimeChange)
      ? (regimeChange > 0.1 && sideIsLong) || (regimeChange < -0.1 && !sideIsLong)
      : null; // null = regime unknown → neutral 50 (neither reward nor penalty)
    const regScore = aligned == null ? 50 : aligned ? 100 : 0;
    const chg = Math.max(0, Math.min(3, Math.abs(Number(s.changePct) || 0)));
    const score =
      0.40 * conf +
      0.20 * agree +
      0.15 * (rr / 3) * 100 +
      0.10 * part * 100 +
      0.10 * regScore +
      0.05 * (chg / 3) * 100;
    const votesFor = (s.votes || []).filter(v => v.dir === (sideIsLong ? 1 : -1)).length;
    const totalVoted = (s.votes || []).length;
    const regTxt = aligned == null ? `${regimeLabel} regime nahi mila`
      : aligned ? `${regimeLabel} ${regimeChange >= 0 ? '+' : ''}${regimeChange.toFixed(1)}% trend se ALIGNED`
      : `${regimeLabel} ke against (counter-trend)`;
    const rrTxt = Number.isFinite(s.plan?.rewardRisk) ? `R:R 1:${s.plan.rewardRisk.toFixed(1)}` : 'plan ready';
    const reason = `${totalVoted} models me se ${votesFor} ${s.side} side pe · conf ${Math.round(conf)}% · ${rrTxt} · ${regTxt} · ${s.grade === 'STRONG' ? 'FULL committee STRONG grade' : 'ACTION grade (tradeable)'}${s.aiConfirm?.verdict === 'CONFIRMED' ? ' · AI CONFIRMED (Jev)' : s.aiConfirm?.verdict === 'CONFLICT' ? ' · AI CONFLICT' : ''}`;
    // v18.6.1 Fix 1 — staleness decay: the composite score is multiplied
    // by stalenessFactor (1.0 fresh → 0.15 at 60m+) so an un-re-confirmed
    // signal naturally drops out of the top-N instead of riding its
    // original conf/agreement forever. rankReason carries the honest why.
    const staleF = stalenessFactor(s);
    const staleTxt = staleF < 1 ? ` · staleness ×${staleF.toFixed(2)}` : '';
    // v21.0 RANK UNIFICATION (deep-check D6): TopPicks ab board grid ke
    // SAME entry-quality-adjusted rank score (__rankScore = aiScore ×
    // PULLBACK×1.10 / EXTENDED×0.93 / chase×0.85) ko respect karta hai —
    // pehle TopPicksPanel aur board grid DO alag formula se rank karte
    // the (conf·agree·RR vs aiScore·band) → ek hi screen pe #1 pick
    // alag-alag dikh sakta tha. Ab band ratio composite me multiply
    // hota hai (staleness decay + baaki topFive logic same rehte hain).
    const aiBase = Number(s.superIntel?.aiScore);
    const rankRaw = Number(s.__rankScore ?? s.superIntel?.rankScore);
    const bandRatio = (Number.isFinite(aiBase) && aiBase > 0 && Number.isFinite(rankRaw))
      ? Math.max(0.5, Math.min(1.25, rankRaw / aiBase)) : 1;
    const bandTxt = bandRatio !== 1 ? ` · entry-quality ×${bandRatio.toFixed(2)}` : '';
    const finalScore = score * staleF * bandRatio;
    return { ...s, rank: 0, score: Math.round(finalScore * 10) / 10, rankReason: reason + staleTxt + bandTxt };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map((s, i) => ({ ...s, rank: i + 1 }));
}

// v9.2.1 RESILIENCE — slow hosts (free-tier containers, cold networks,
// WAF-blocked feeds) were STACKING full board computes: every 15s
// agent-status poll + every 30s board poll started its OWN cold scan,
// multiplying latency until every request timed out and the panels
// read "Agent status unavailable" / "data feed unreachable".
//   • SINGLE-FLIGHT — concurrent callers JOIN the running compute.
//   • warmOnly — status polls NEVER compute inline: serve the cached
//     board (stale is fine) and warm the cache in the background.
const _boardInflight = new Map(); // mkt → running compute promise

/** v18.6.4 SERVE-TIME STALENESS RE-RANK — computeTopFive ranks at
 *  COMPUTE time, where signalAge.lastSeenAt was just re-stamped by the
 *  same pass → stalenessFactor was always 1.0 and the v18.6.1 decay
 *  never actually demoted anything while the 60s cache kept serving.
 *  At SERVE time the current clock re-applies the decay: stale rows
 *  visibly drop in rank + carry the honest ×0.xx tag. Cache-safe
 *  (shallow clone — the cached payload object stays pristine). */
function _serveBoard(payload) {
  try {
    if (!payload || !Array.isArray(payload.topFive) || payload.topFive.length < 2) return payload;
    const now = Date.now();
    let changed = false;
    const reRanked = payload.topFive.map((s) => {
      const staleF = stalenessFactor(s, now);
      const base = Number(s?.score);
      if (staleF >= 1 || !Number.isFinite(base)) return s;
      changed = true;
      const score = Math.round(base * staleF * 10) / 10;
      const reason = String(s?.rankReason || '').replace(/ · staleness ×[\d.]+$/, '');
      return { ...s, score, rankReason: `${reason} · staleness ×${staleF.toFixed(2)}` };
    });
    if (!changed) return payload;
    reRanked.sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
    return { ...payload, topFive: reRanked.map((s, i) => ({ ...s, rank: i + 1 })), __servedAt: now };
  } catch { return payload; }
}

// v20.7.10 FIX (board cache limit-poisoning): cache key `board:${mkt}` caller
// ka limit IGNORE karta tha — 60s expiry ke baad jab limit-5 internal caller
// (telegram sink / auto-exec, dono hamesha-on) pehle compute karta to 5-row
// board CACHE hota tha jo limit-10 readers (frontend poll + 15s recheck
// watchlist) SERVE karte the: STRONG/ACTION rows 6-10 board pe invisible +
// 15s watch se silently drop. Ab HAR compute CANONICAL limit pe chalti hai
// aur SERVE path caller ke limit pe truncate karta hai — ek cache, saare
// limits, koi poisoning nahi. CANON = 40: callers ka census — portfolio
// insights route limit:40 (holdings-map lookup), proTraderAuto/agent
// limit:20, board route ≤15 (query cap), telegram sinks limit:5, recheck
// warmOnly (no limit — full cache). 40 par compute final-loop CPU-only
// hai (network enrichment pehle se caps 24/20 pe saturated — limit badhne
// se fetch count NAHI badhta), isliye ek hi 40-row compute sabko serve
// karta hai.
const BOARD_CANON_LIMIT = 40;
function _truncateBoard(payload, limit) {
  const n = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
  const sig = Array.isArray(payload?.signals) ? payload.signals : [];
  if (!n || !payload || sig.length <= n) return payload;
  return { ...payload, signals: sig.slice(0, n) };
}

function _warmBoardInBackground(mkt, deps) {
  if (_boardInflight.has(mkt)) return _boardInflight.get(mkt);
  const p = (async () => {
    try { return await _computeBoard(mkt, deps || {}, { limit: BOARD_CANON_LIMIT }); }
    catch { return null; } // best-effort warm — next poll retries
    finally { _boardInflight.delete(mkt); }
  })();
  _boardInflight.set(mkt, p);
  return p;
}

export async function getSignals(market, deps, opts = {}) {
  const raw = String(market || 'INDIA').toUpperCase();
  // v21.8.0: METALS — the dedicated GOLD (XAU/USDT) + SILVER (XAG/USDT)
  // desk inside the CoinDCX tab (B-XAU_USDT / B-XAG_USDT commodity
  // perps, futures pipeline pe fixed 2-symbol universe).
  const mkt = raw === 'CRYPTO' ? 'CRYPTO' : raw === 'FUTURES' ? 'FUTURES' : raw === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : raw === 'METALS' ? 'METALS' : 'INDIA';
  const cacheKey = `board:${mkt}`;
  // v9: full-universe scans are heavier — desks used to hold their board
  // for 90s. v10.10 (direct-RT pass): every desk is 60s now — the visible
  // LTP is already realtime via the /api/stream overlay, but the PLANS
  // (entry/SL/targets) also deserve ≤60s-old prices, not ≤90s+20s.
  const cached = cacheGet(cacheKey, 60_000);
  if (cached && !opts.noCache) return _truncateBoard(_serveBoard(cached), opts.limit);

  // v9.2.1: status/polling callers must answer in milliseconds — never
  // run a cold compute on the request path. Serve a stale board if one
  // exists (any age — the payload carries generatedAt) and refresh in
  // the background; with nothing cached at all, answer null now.
  if (opts.warmOnly) {
    const staleHit = _cache.get(cacheKey);
    _warmBoardInBackground(mkt, deps);
    return staleHit ? _truncateBoard(_serveBoard(staleHit.payload), opts.limit) : null;
  }
  // v12.7 (recheck R3-#3): RESCAN/noCache computes now REGISTER in the
  // same single-flight map — the route comment always claimed "single-
  // flight protected" but a noCache return bypassed _boardInflight, so
  // a RESCAN could stack on the 15s warmOnly poll AND the 30s board
  // poll (three concurrent full-universe scans — the v9.2.1 latency
  // disease). A normal poll joining a running RESCAN gets that fresh
  // compute (fresher than the cache it was about to serve — fine); a
  // RESCAN joining a running normal compute gets that fresh compute
  // (it only started because the 60s cache was already expired).
  {
    const running = _boardInflight.get(mkt);
    // v20.7.10: joiner apna limit apply karta hai — running promise CANONICAL
    // (40-row) board resolve karti hai; pehle joiner ko starter ka truncated
    // view mil jata tha.
    if (running) return running.then((r) => _truncateBoard(r, opts.limit));
    // v20.7.10: compute hamesha CANONICAL (≥40) pe — cache jo banega wahi
    // sabse bada caller bhi full use kar sake (portfolio insights 40).
    const canonOpts = { ...opts, limit: Math.max(BOARD_CANON_LIMIT, Number(opts.limit) || 0) };
    const p = (async () => {
      try { return _serveBoard(await _computeBoard(mkt, deps, canonOpts)); }
      finally { _boardInflight.delete(mkt); }
    })();
    _boardInflight.set(mkt, p);
    return _truncateBoard(await p, opts.limit);
  }
}

// ---------------- v11.8: India index option-chain ctx (board path) ----------------
// OptionsFlow (PCR + max-pain + IV contrarian) was designed for exactly
// the NIFTY/BANKNIFTY underlyings but the board never attached ctx.options
// (opts.indexOptions was a deep-path-only hook) — the seat sat abstained
// on every India board while the whole optionsDesk machinery + its chain
// fetchers existed one import away. 5-min TTL (OI drifts slowly; the desk
// fetch is NOT free). REAL exchange chains only — source 'nse'/'bse'.
// The Black-Scholes synthetic chain (source 'bs-model-*') is a MODEL and
// model data never votes in the ensemble.
const _INDEX_OPTIONS_TTL = 5 * 60_000;
const _indexOptions = { at: 0, inflight: null, ctx: { NIFTY: null, BANKNIFTY: null } };
const REAL_CHAIN_RE = /^(nse|bse)(-|$)/;

// ---------------- accuracy-plan Phase 2.2: PER-STOCK option ctx ----------------
// FEASIBILITY VERDICT (checked before building): Massive/Polygon and
// AlphaVantage serve US options only — NO NSE stock chains (the plan's
// suggested mesh sources are infeasible for India stocks). The RIGHT
// source was already in the repo: getOptionsDesk(sym) fetches + analyzes
// ANY NSE F&O underlying (the v10.17 options scanner already runs it on
// 6 stock names). So OptionsFlow's per-stock granularity rides the SAME
// real-chain machinery: the board warms the TOP turnover names' chains
// (bounded slice, 10-min TTL — OI drifts slowly, chain fetches aren't
// free), REAL exchange chains only, honest absent on outage. The seat's
// structural-abstain comment ("single stocks have no option chain") was
// true for the OLD data path — the F&O universe's chains are fetchable.
const _STOCK_OPTIONS_TTL = 10 * 60_000;
const _STOCK_OPTIONS_TOP_N = Math.max(0, Math.min(10, parseInt(process.env.AI_STOCK_OPTIONS_TOP_N, 10) || 6));
const _stockOptions = { at: 0, inflight: null, ctx: new Map() };

function _stockOptionsSnapshot(sym) {
  if (Date.now() - _stockOptions.at > _STOCK_OPTIONS_TTL) return null;
  return _stockOptions.ctx.get(sym) || null;
}

/** Warm per-stock option chains for the TOP slice (fire-and-forget:
 *  this cycle attaches whatever is cached, the refresh lands for the
 *  next — the index-ctx pattern). REAL nse/bse chains only. */
async function _refreshStockOptionsCtx(symbols) {
  const list = (symbols || []).filter(s => typeof s === 'string' && s && s !== 'NIFTY' && s !== 'BANKNIFTY' && s !== 'SENSEX').slice(0, _STOCK_OPTIONS_TOP_N);
  if (list.length === 0) return _stockOptions.ctx;
  if (_stockOptions.inflight) return _stockOptions.inflight;
  _stockOptions.inflight = (async () => {
    await Promise.allSettled(list.map(async (sym) => {
      const desk = await getOptionsDesk(sym).catch(() => null);
      if (!desk?.ok || !desk.optionsCtx) { _stockOptions.ctx.delete(sym); return; }
      const src = String(desk.source || '');
      if (!REAL_CHAIN_RE.test(src)) { _stockOptions.ctx.delete(sym); return; } // model chain — never votes
      _stockOptions.ctx.set(sym, { ...desk.optionsCtx, __source: src, __at: Date.now() });
    }));
    // symbols no longer in the top slice age out on the next warm
    for (const key of [..._stockOptions.ctx.keys()]) {
      if (!list.includes(key) && Date.now() - (_stockOptions.ctx.get(key)?.__at || 0) > _STOCK_OPTIONS_TTL) {
        _stockOptions.ctx.delete(key);
      }
    }
    _stockOptions.at = Date.now();
    return _stockOptions.ctx;
  })();
  try { return await _stockOptions.inflight; } finally { _stockOptions.inflight = null; }
}

function _indexOptionsSnapshot() {
  if (Date.now() - _indexOptions.at > _INDEX_OPTIONS_TTL) return null;
  return _indexOptions.ctx;
}

async function _refreshIndexOptionsCtx() {
  if (Date.now() - _indexOptions.at < _INDEX_OPTIONS_TTL) return _indexOptions.ctx;
  if (_indexOptions.inflight) return _indexOptions.inflight;
  _indexOptions.inflight = (async () => {
    await Promise.allSettled(['NIFTY', 'BANKNIFTY'].map(async (idx) => {
      const desk = await getOptionsDesk(idx).catch(() => null);
      if (!desk?.ok || !desk.optionsCtx) return;
      const src = String(desk.source || '');
      if (!REAL_CHAIN_RE.test(src)) return; // synthetic/model chain — never votes
      _indexOptions.ctx[idx] = { ...desk.optionsCtx, __source: src, __at: Date.now() };
    }));
    _indexOptions.at = Date.now();
    return _indexOptions.ctx;
  })();
  try { return await _indexOptions.inflight; } finally { _indexOptions.inflight = null; }
}

async function _computeBoard(mkt, deps, opts = {}) {
  const cacheKey = `board:${mkt}`;
  const depsSafe = deps || {};
  // v2 (plan Phase 1-2): warm the sentiment + institutional-flow
  // caches IN PARALLEL with the board's own data phase — by the time
  // the model loop runs, votes have fresh data; a dead feed costs
  // nothing (honest abstain, never blocks the board).
  const _v2Warms = v2ModelsEnabled() ? [refreshSentiment(mkt === 'INDIA' ? 'INDIA' : 'CRYPTO').catch(() => {})] : [];
  if (v2ModelsEnabled() && mkt === 'INDIA') _v2Warms.push(refreshFiiDii().catch(() => {}));
  // v11.6 Phase 3: mesh seats warm at T3 cadence for the TOP slice
  // only (never the full universe at board cadence — free-tier
  // budgets would be gone in minutes). The warm is budget-aware
  // (per-cap re-query gaps aligned with the mesh's cache tiers) and
  // joins the bounded wait below with a 4s soft deadline — whatever
  // resolved in time votes THIS cycle; the rest keeps warming in the
  // background store for the next one (the depth-warm pattern).
  const _meshWarms = [];
  const regime = await buildRegime(mkt);
  // v9 SUPERINTELLIGENCE board meta (scanned universe + price chain).
  const superMeta = { engine: 'SUPERINTELLIGENCE PRO TRADER ENGINE v9', universeSize: 0, universeMode: 'static', priceSource: null };

  const contexts = [];
  if (mkt === 'INDIA') {
    // v11.8 OPTION-CHAIN CTX (the OptionsFlow revival): the seat was
    // built for exactly these underlyings (PCR + max-pain + IV contrarian)
    // but the board never attached ctx.options — opts.indexOptions was a
    // deep-path-only hook. Now the board refreshes a 5-min-TTL ctx for
    // NIFTY + BANKNIFTY itself. REAL exchange chains only (source nse/bse):
    // the Black-Scholes synthetic chain is a MODEL, and model data must
    // never vote in the ensemble. Fire-and-forget (depth-warm pattern):
    // this cycle attaches whatever is already cached, the refresh lands
    // for the next one.
    const _idxOpts = _indexOptionsSnapshot();
    _refreshIndexOptionsCtx().catch(() => {});
    // v11.8: the India board also warms the mesh T3 slice now — the
    // equity seats (TechConsensus / FundaProPlus) shadow-vote on the
    // India desk too (shadow = weight 0 until settled outcomes promote
    // them; the votes get JOURNALED either way). Budget-aware by design
    // (per-(cap,symbol) cadence gaps inside warmMeshModels).
    // v10.17 FULL UNIVERSE SCAN + TIERED CADENCE:
    //   T1 = base ∪ hot            → scanned EVERY cycle
    //   T2 = discovered NSE names  → rotating ~¼ slices per cycle
    // (whole-market coverage every ~4 cycles ≈ ~4 min; hot T2 names
    // ride T1 cadence for 20 min after they show heat). Flag OFF =
    // the legacy static 45-name scan, byte-identical. Discovery DOWN
    // (same scanner.tradingview.com upstream as the tickers batch
    // itself) → legacy static scan too — honest degrade, no seed
    // guessing on the board path.
    // v20.2 UNIVERSE EDITOR HONESTY: the board now honours the user's
    // UniverseEditor edits (removedBase excluded from BOTH the tiered and
    // the legacy static scan; custom symbols ride Tier-1). Same file the
    // /api/intraday-universe endpoints write, 30s TTL read.
    const _uniOv = boardUniverseOverrides();
    // v20.3 FIX: tieredScanUniverse ka `exclude` sirf DISCOVERED rows aur
    // the hot map filter karta hai — the caller's BASE array apne aap me
    // filtered hona chahiye (the locked contract in indiaUniverse tests:
    // "production wiring passes effectiveUniverse() + exclude as
    // belt-and-suspenders"). Pehle raw INDIA_UNIVERSE ja raha tha, so a
    // removed T1 name (44/45 editor names) har board cycle me scan hota
    // raha — the exact bug v20.2 claimed to fix.
    const _boardBase = INDIA_UNIVERSE.filter(s => !_uniOv.removedBase.has(s));
    const tiered = await tieredScanUniverse(_boardBase, {
      exclude: [..._uniOv.removedBase],
    });
    const _customAdds = (_uniOv.custom || []).filter(s => !(tiered.scan || []).includes(s));
    if (_customAdds.length) tiered.scan = [...(tiered.scan || []), ..._customAdds];
    if (meshModelsEnabled()) {
      _meshWarms.push(warmMeshModels('INDIA', (tiered?.scan || INDIA_UNIVERSE).slice(0, 12)).catch(() => {}));
    }
    const tieredLive = tiered.mode === 'tiered-full';
    // Stocks (TV scanner, chunked batch) — parallel with the index contexts.
    // v20.2: the legacy static fallback path also honours the overrides.
    const _legacyScan = [...new Set([
      ...INDIA_UNIVERSE.filter(s => !_uniOv.removedBase.has(s)),
      ...(_uniOv.custom || []),
    ])];
    const [tv, indexCandleJobs] = await Promise.all([
      (tieredLive
        ? fetchTVIndiaBatchChunked(tiered.scan)
        : fetchTVIndiaBatch(_legacyScan)).catch(() => ({})),
      Promise.allSettled(['NIFTY', 'BANKNIFTY'].map(async (idx) => {
        // v21.13.x recheck fix: index contexts ab the SAME 15m→1h chain
        // use karte hain as stocks (buildIndiaIndexCtx) — pehle yahan
        // SIRF daily 6mo candles se ind banta tha (the last daily-
        // resolution path feeding intraday index signals).
        return buildIndiaIndexCtx(idx, regime, opts.indexOptions?.[idx] ?? _idxOpts?.[idx] ?? null);
      })),
    ]);
    // Feed the fresh rows into the hot engine — promoted names join
    // T1 from the NEXT cycle (this cycle already has its scan set).
    if (tieredLive) absorbScanRows(Object.values(tv));
    // accuracy-plan Phase 2.2: warm the TOP-slice stock option chains
    // (the turnover-ranked T1 head). Fire-and-forget — this cycle
    // attaches the cached ctx, the refresh lands for the next board.
    _refreshStockOptionsCtx((tiered?.scan || INDIA_UNIVERSE)).catch(() => {});
    // v21.13.0: pre-fetch the 15m Yahoo candles for the WHOLE scan set in
    // bounded parallel waves (12 in flight — loadCandlesBounded, the same
    // pattern the crypto desks use), then build every ctx from the map.
    // The old sequential per-row await would have serialized 45-90 network
    // fetches inside the board cycle; the 2-min TTL cache makes repeat
    // cycles nearly free (crypto boards already run this pattern).
    const _indiaRows = Object.values(tv);
    const _candle15m = await loadCandlesBounded(
      _indiaRows.map(r => r.symbol),
      (s) => fetchYahooIntradayCandles(s, 'INDIA'),
    );
    const _built = await Promise.all(_indiaRows.map(row =>
      buildIndiaStockCtx(row, regime, _candle15m.get(row.symbol)).catch(() => null)));
    for (const ctx of _built) if (ctx) contexts.push(ctx);
    for (const r of indexCandleJobs) if (r.status === 'fulfilled' && r.value) contexts.push(r.value);
    if (tieredLive) {
      superMeta.universeSize = tiered.fullCount + 2;
      superMeta.universeMode = `tiered-full (T1 ${tiered.t1Count} + T2 slice ${tiered.sliceCount}/${tiered.t2Count} · hot ${tiered.hot.length})`;
      superMeta.tiered = {
        t1: tiered.t1Count, t2: tiered.t2Count, slice: tiered.sliceCount,
        scanned: tiered.scan.length, hot: tiered.hot, full: tiered.fullCount,
      };
    } else {
      superMeta.universeSize = INDIA_UNIVERSE.length + 2;
      superMeta.universeMode = 'tv-nse-batch';
    }
  } else if (mkt === 'FUTURES' || mkt === 'METALS') {
    // v9 SUPERINTELLIGENCE: the FULL DYNAMIC futures universe — every
    // liquid CoinDCX B-USDT perpetual by 24h turnover (live discovery,
    // delistings/listings flow in automatically; Binance futures is the
    // fallback universe+price chain). The old static ~12-coin list is
    // now only the last-resort seed.
    // v21.8.0 METALS: SAME pipeline, FIXED universe — GOLD (XAU) + SILVER
    // (XAG) commodity perps (B-XAU_USDT / B-XAG_USDT). TV scanner par
    // metals MISSING hain → indicators candles se bante hain; candle
    // chain = CoinDCX pcode=f → Binance fapi (verified live). Signals
    // FUTURES domain pe hi jaate hain (USDT perps — execute/gauntlet,
    // deep, SSE FUT_ ticks, card currency sab FUTURES-identical).
    const isMetals = mkt === 'METALS';
    const [uni, futRows] = await Promise.all([
      isMetals ? Promise.resolve([...METALS_BASES]) : discoverFuturesUniverse(SUPER_UNIVERSE_SIZE).catch(() => null),
      // v10.10: ultra-fresh RT (≤2s) — shares the single-flight round-trip
      // with the cxRtStream 2s poller, so the board rides the same fetch.
      fetchFuturesPrices({ maxAgeMs: 2000 }).catch(() => null),
    ]);
    const universe = isMetals ? [...METALS_BASES] : (Array.isArray(uni) && uni.length > 0 ? uni : [...FUTURES_UNIVERSE]);
    if (v2ModelsEnabled() && !isMetals) _v2Warms.push(warmInstFlow(universe.slice(0, 10))); // v2 InstFlow: poll the most-liquid books
    if (meshModelsEnabled() && !isMetals) _meshWarms.push(warmMeshModels('FUTURES', universe.slice(0, 12)).catch(() => {})); // v11.6 mesh seats: T3 slice (metals: equity/news agents — honest abstain, no dead warm)
    superMeta.universeSize = universe.length;
    superMeta.universeMode = isMetals ? 'metals-fixed (GOLD XAU · SILVER XAG perps)' : (Array.isArray(uni) && uni.length > 0 ? 'dynamic' : 'static-fallback');
    const futMap = new Map((Array.isArray(futRows) ? futRows : []).map(x => [x.base, x]));
    // Missing RT prices → fallback chain. Crypto: Binance futures (USDT
    // domain — same domain as the desk, no conversion needed). Metals:
    // dedicated fapi XAUUSDT/XAGUSDT tickers (binancePriceMap's discovery
    // base BINANCE_BLOCKLIST se metals ko hata deta hai — dedicated
    // fetchMetalsPrices is the right leg, same USDT 1:1 domain).
    if (isMetals) {
      if (universe.some(b => !futMap.get(b)?.last)) {
        const metRows = await fetchMetalsPrices().catch(() => null);
        for (const r of (Array.isArray(metRows) ? metRows : [])) if (!futMap.get(r.base)?.last) futMap.set(r.base, r);
      }
      // v21.13.x recheck (P1): label derived from the ACTUAL serving rows'
      // `source` fields — pehle fetchFuturesPrices ka internal Binance
      // fallback (source 'binance-fut') bhi 'coindcx-fut-usdt (metals)'
      // bol raha tha (live-verified mislabel: CoinDCX 403-dark pe bhi
      // label CoinDCX). Honest labels = jo serve ho, wahi bole.
      // Sourceless rows = the CoinDCX futures RT leg (the v11.3 contract:
      // RT rows carry NO source marker; only fallback legs do) — they
      // count as 'coindcx-fut-rt', never silently 'mixed'.
      const _srcCounts = new Map();
      for (const b of universe) {
        const row = futMap.get(b);
        if (!row) continue;
        const s = row.source || 'coindcx-fut-rt';
        _srcCounts.set(s, (_srcCounts.get(s) || 0) + 1);
      }
      const _srcs = [..._srcCounts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
      if (_srcs.length === 1) {
        superMeta.priceSource = `${_srcs[0]} (metals)`;
      } else if (_srcs.length > 1) {
        superMeta.priceSource = `${_srcs.join(' + ')} (metals)`;
      } else {
        superMeta.priceSource = futMap.size > 0 ? 'mixed (metals)' : 'unavailable';
      }
    } else if (futMap.size === 0 || universe.some(b => !futMap.has(b))) {
      const { map } = await binancePriceMap(universe, true).catch(() => ({ map: new Map() }));
      for (const [b, usd] of map) if (!futMap.has(b)) futMap.set(b, { base: b, last: usd, volume: 0 });
      if (map.size > 0) superMeta.priceSource = futMap.size > map.size ? 'coindcx-fut + binance-fut' : 'binance-fut-usdt';
    } else {
      superMeta.priceSource = 'coindcx-fut-usdt';
    }
    // TV indicators for the whole universe (chunked) + LTF candles for
    // EVERY coin — the whole board gets the pass-2 revival now.
    // Candle chain: CoinDCX 1h primary → Yahoo 1h fallback RESCALED
    // onto the desk's USDT anchor (Yahoo OHLC is USD — the linear
    // rescale keeps every ATR/EMA in the domain the plan prices use).
    // v21.8.0 metals: TV scanner par XAU/XAG missing (verified) + Yahoo
    // intraday map me metals nahi → chain = CoinDCX pcode=f → Binance
    // fapi klines (USDT 1:1, no rescale, verified live).
    const tv = await fetchTVCryptoChunked(universe);
    const candleMap = await loadCandlesBounded(universe, (b) => (async () => {
      const ltp = futMap.get(b)?.last;
      if (!(ltp > 0)) return null;
      const c = await fetchFuturesCandles(futuresPairFor(b), '60').catch(() => null);
      if (Array.isArray(c) && c.length >= 30) return c;
      if (isMetalsBase(b)) {
        // v21.9.0: fapi (FIXED interval mapping) → Yahoo COMEX rescaled —
        // chaar-leg candle chain, Binance geo-block ke against bhi zinda.
        const m = await fetchMetalsCandleChain(b, '60', ltp).catch(() => null);
        if (Array.isArray(m) && m.length >= 30) return m;
        return null; // metals: Yahoo intraday map me XAU/XAG nahi — chain last leg Yahoo COMEX hai
      }
      const y = await fetchYahooIntradayCandles(b, 'FUTURES').catch(() => null);
      // USDT ≈ USD: expected scale ≈ ltp / tv.usdPrice (≈ 1)
      const usd = tv?.[b]?.usdPrice;
      return rescaleCandlesToLtp(y, ltp, usd > 0 ? ltp / usd : 1);
    })());
    // v10.6 WICK GUARD (Pro Upgrade #3): perp LTPs validated against
    // Binance perps (1:1 USDT domain) before any card may be built.
    const _futWick = new Map();
    await Promise.all(universe.map(async (base) => {
      const p = futMap.get(base)?.last;
      if (!(p > 0)) return;
      _futWick.set(base, await validateTick({ market: 'FUTURES', base, price: p }).catch(() => null));
    }));
    superMeta.wickSuppressed = [..._futWick.entries()].filter(([, v]) => v?.action === 'SUPPRESS').map(([b]) => b);
    universe.forEach((base) => {
      if (_futWick.get(base)?.action === 'SUPPRESS') return; // bad print — no card this cycle
      const ctx = buildFuturesCtxSync(base, tv[base], futMap.get(base), candleMap.get(base) || null, regime);
      if (ctx) { attachSuperCtx(ctx, tv[base], candleMap.get(base) || null); contexts.push(ctx); }
    });
  } else if (mkt === 'GLOBALFUTURES') {
    // v10.4 GLOBAL EQUITY FUTURES — AAPL/MSFT/GOOGL/AMZN/NVDA/TSLA/META
    // (real Yahoo quotes + 1h candles) + SPACEX (deterministic synthetic
    // walk, labeled SIM). Data + context building live in globalFutures.js
    // — the SAME 10-model committee votes on these, same as every desk.
    const gf = await import('./globalFutures.js');
    const [quotes, ...candleJobs] = await Promise.all([
      // v10.10: ultra-fresh quotes (≤2s quote cache; internal USDC RT probe
      // shares the single-flight with the cxRtStream poller).
      gf.fetchGlobalQuotes({ maxAgeMs: 2000 }).catch(() => null),
      ...gf.GLOBAL_FUTURES_UNIVERSE.map(u => gf.fetchGlobalCandles(u.symbol).catch(() => null)),
    ]);
    superMeta.universeSize = gf.GLOBAL_FUTURES_UNIVERSE.length;
    superMeta.universeMode = 'global-equity-futures';
    superMeta.priceSource = quotes ? (quotes.get('SPACEX')?.sim ? 'yahoo + spacex-sim' : 'yahoo') : 'unavailable';
    for (let i = 0; i < gf.GLOBAL_FUTURES_UNIVERSE.length; i++) {
      const u = gf.GLOBAL_FUTURES_UNIVERSE[i];
      const q = quotes?.get(u.symbol) || null;
      const candles = Array.isArray(candleJobs[i]) ? candleJobs[i] : null;
      const ctx = gf.buildGlobalCtxSync(u.symbol, q, candles, regime);
      if (ctx) { attachSuperCtx(ctx, { ltp: ctx.ltp, usdPrice: ctx.ltp }, candles); contexts.push(ctx); }
    }
    // v11.6 mesh seats: the whole global universe IS the T3 slice —
    // Quiver/AlphaVantage/TradingCentral ride the mesh's own cache +
    // token buckets (honest gaps → honest abstentions).
    if (meshModelsEnabled()) {
      _meshWarms.push(warmMeshModels('GLOBALFUTURES', gf.GLOBAL_FUTURES_UNIVERSE.map(u => u.symbol)).catch(() => {}));
    }
  } else {
    // CRYPTO — v9 SUPERINTELLIGENCE: the FULL DYNAMIC spot universe.
    // Every liquid CoinDCX INR pair by 24h turnover, live discovered
    // (CoinDCX tickers primary → Binance spot × live USDINR fallback).
    // The old static 12-coin list is the last-resort seed only.
    const { fetchCoinDcxTickers } = await import('../cryptoStream.js');
    const [uni, tickers] = await Promise.all([
      discoverSpotUniverse(SUPER_UNIVERSE_SIZE).catch(() => null),
      fetchCoinDcxTickers().catch(() => null),
    ]);
    const universe = Array.isArray(uni) && uni.length > 0 ? uni : [...CRYPTO_UNIVERSE];
    if (v2ModelsEnabled()) _v2Warms.push(warmInstFlow(universe.slice(0, 10))); // v2 InstFlow: poll the most-liquid books
    if (meshModelsEnabled()) _meshWarms.push(warmMeshModels('CRYPTO', universe.slice(0, 12)).catch(() => {})); // v11.6 mesh seats: T3 slice
    superMeta.universeSize = universe.length;
    superMeta.universeMode = Array.isArray(uni) && uni.length > 0 ? 'dynamic' : 'static-fallback';
    const inrMap = new Map((Array.isArray(tickers) ? tickers : [])
      .filter(t => t && typeof t.market === 'string' && t.market.endsWith('INR'))
      .map(t => [t.market.replace('INR', ''), parseFloat(t.last_price)]));
    // Missing INR quotes → Binance spot USDT × live USDINR (INR domain,
    // exactly how the expert-picks desk prices its fallback picks).
    if (inrMap.size === 0 || universe.some(b => !inrMap.has(b))) {
      const [{ map }, fx] = await Promise.all([
        binancePriceMap(universe, false).catch(() => ({ map: new Map() })),
        fetchUsdInr(),
      ]);
      for (const [b, usd] of map) if (!inrMap.has(b)) inrMap.set(b, usd * fx);
      if (map.size > 0) superMeta.priceSource = inrMap.size > map.size ? 'coindcx-inr + binance-inr' : 'binance-usdt-x-inr';
    } else {
      superMeta.priceSource = 'coindcx-inr';
    }
    const tv = await fetchTVCryptoChunked(universe);
    // Candle chain: CoinDCX INR 1h primary → Binance/Bybit USDT 1h klines
    // → Yahoo USD 1h — every fallback RESCALED onto the coin's INR anchor
    // (the fallbacks keep the revival alive when the CoinDCX public candle
    // feed AND/OR the TV crypto scanner are IP-blocked from this server,
    // while keeping every price field in the INR trading domain).
    // v11.2 FIX (2026-09-17 live incident): the TV-blocked case used to pass
    // expectedScale=null into the rescale guard, whose no-reference sanity
    // bound (0.2–5) rejected EVERY USD→INR rescale (≈85×) → zero contexts →
    // the whole board died with a misleading "TV + CoinDCX both unavailable"
    // while CoinDCX INR prices were fine. Now the LIVE USDINR fx (one fetch
    // per board, shared by every coin) anchors the guard when the TV row is
    // missing, and Binance/Bybit USDT klines are the crypto-native fallback.
    const fxLive = await fetchUsdInr().catch(() => null);
    const fxAnchor = (fxLive > 50 && fxLive < 200) ? fxLive : null;
    superMeta.candleChain = 'coindcx-inr → binance-bybit-usdt-rescaled → yahoo-usd-rescaled';
    const candleMap = await loadCandlesBounded(universe, (b) => (async () => {
      const ltp = inrMap.get(b);
      if (!(ltp > 0)) return null;
      const c = await fetchCoinDcxCandles(b, '1h').catch(() => null);
      if (Array.isArray(c) && c.length >= 30) return c;
      // INR domain: expected scale = ltp / tv.usdPrice (coin-specific live
      // fx ratio) when TV answered; else the board's live USDINR anchor.
      const usd = tv?.[b]?.usdPrice;
      const expected = usd > 0 ? ltp / usd : fxAnchor;
      const bk = await fetchBinanceKlines(b, '1h').catch(() => null);
      if (Array.isArray(bk) && bk.length >= 30) {
        const r = rescaleCandlesToLtp(bk, ltp, expected);
        if (r) return r;
      }
      const y = await fetchYahooIntradayCandles(b, 'CRYPTO').catch(() => null);
      return rescaleCandlesToLtp(y, ltp, expected);
    })());
    // v10.6 WICK GUARD (Pro Upgrade #3): validate every base's LTP
    // against the Binance cross-venue reference BEFORE it may generate
    // a signal card (shared ref book — one fetch for the whole board).
    const _wickGuard = new Map();
    await Promise.all(universe.map(async (base) => {
      const p = inrMap.get(base);
      if (!(p > 0)) return;
      _wickGuard.set(base, await validateTick({ market: 'CRYPTO', base, price: p }).catch(() => null));
    }));
    superMeta.wickSuppressed = [..._wickGuard.entries()].filter(([, v]) => v?.action === 'SUPPRESS').map(([b]) => b);
    universe.forEach((base) => {
      if (_wickGuard.get(base)?.action === 'SUPPRESS') return; // bad print — no card this cycle
      const ctx = buildCryptoCtxSync(base, tv[base], inrMap.get(base), regime, candleMap.get(base) || null);
      if (ctx) { attachSuperCtx(ctx, tv[base], candleMap.get(base) || null); contexts.push(ctx); }
    });
  }

  if (contexts.length === 0) {
    const payload = {
      ok: false, market: mkt, reason: mkt === 'CRYPTO'
        ? 'No crypto data reachable right now (every leg of the chain is down: CoinDCX INR prices + Binance/Bybit + TV scanner + Yahoo candles)'
        : mkt === 'FUTURES'
          ? 'No futures data reachable right now (TV + CoinDCX futures RT unavailable)'
          : mkt === 'METALS'
            ? 'No metals data reachable right now (CoinDCX futures RT + Binance fapi + Yahoo COMEX + gold-api — saari legs down for XAU/XAG)'
            : mkt === 'GLOBALFUTURES'
              ? 'No global equity data reachable right now (Yahoo + global feed unavailable)'
              : 'No India market data reachable right now (TV scanner unavailable)',
      marketOpen: mkt === 'INDIA' ? isNseOpen() : true,
      topFive: [],
      signals: [], models: modelStatus(null, depsSafe), regime, generatedAt: Date.now(),
    };
    cacheSet(cacheKey, payload);
    return payload;
  }

  // Run quant models per symbol → aggregate → rank.
  // v6.7: each vote's weight is scaled by its LIVE hit-rate multiplier
  // (ledger outcomes → Beta posterior; n<8 keeps the base weight —
  // we refuse to tune on noise). Computed ONCE per board run.
  // v2: warms already ran parallel to the data fetches; the v11.6
  // mesh warm gets a 4s SOFT deadline (the mesh's own per-call
  // deadline is 8s — a cold T3 warm must never hold the board).
  await Promise.race([
    Promise.allSettled([..._v2Warms, ..._meshWarms]),
    new Promise((res) => { const t = setTimeout(() => res(null), 4000); t.unref?.(); }),
  ]);
  // v10.6 ORDER-FLOW DEPTH (Pro Upgrade #1): warm L2 ladders for the
  // top-turnover slice — the VolumeFlow seat folds the read in
  // (ctx.depth). Soft-deadline 2.5s: whatever the reader resolved in
  // time attaches NOW; the rest keeps warming in the background cache
  // for the next board cycle (honest degrade, board latency bounded).
  const _depthBases = contexts.slice(0, 8).map(c => c.symbol);
  const _depthMap = await Promise.race([
    warmDepthBatch(mkt, _depthBases, { ltpOf: (b) => contexts.find(c => c.symbol === b)?.ltp ?? null }),
    new Promise((res) => { const t = setTimeout(() => res(new Map()), 2500); t.unref?.(); }),
  ]).catch(() => new Map());
  if (_depthMap && _depthMap.size > 0) {
    for (const c of contexts) if (_depthMap.has(c.symbol)) c.depth = _depthMap.get(c.symbol);
    superMeta.depthWarmed = [..._depthMap.keys()];
  }
  const adaptiveMul = adaptiveMultipliers(_ledgerModelStats());
  // v10.6 REGIME-AWARE REWEIGHTING (Pro Upgrade #4): the board's regime
  // read (shared by all symbols) tilts the model weights ±25% max —
  // flag OFF keeps the exact static-weight board (A/B first via
  // `--strategy regime_weighted`, per the plan's own sequencing).
  const regimeLabel = regimeWeightsEnabled() ? classifyRegimeFor(regime, mkt) : null;
  if (regimeLabel) superMeta.regimeLabel = regimeLabel;
  const candidates = [];
  const breadth = { bull: 0, bear: 0, flat: 0, avgConf: 0 };
  // v21.23.4: data-degraded (daily-fallback) symbols ka honest ledger —
  // inka signal REMOVE hota hai (user demand: "wrong signals remove karo")
  // par reason board payload par surface hota hai ("kyun gayab?" ka jawab).
  const degradedSymbols = [];
  let confSum = 0;
  for (const ctx of contexts) {
    // v11.6: mesh-seat gating FIRST (shadow weight-0 + correlation
    // discount), then the live-outcome adaptive multipliers and the
    // regime tilt on top — the mesh seats are subject to the SAME
    // calibration ladder as every other seat, never exempt from it.
    // v21.0: CORE-seat correlation guard BHI yahin lagta hai (false-
    // diversity fix — trend↔tape / momentum↔tape / smc↔structure
    // redundant pairs ledger-settled correlation se discount hote
    // hain; < 20 overlap = byte-identical legacy board, honest).
    const votes = applyCoreCorrelationDiscounts(
      applyMeshModelGating(
        applyRegimeWeights(applyAdaptiveWeights(runQuantModels(ctx), adaptiveMul), regimeLabel),
      ),
    );
    // v9 UNIVERSAL PASS-2 REVIVAL: every scanned coin that carries LTF
    // candles gets the full revival treatment HERE — the SMC model
    // comes alive on intraday structure AND the pattern/sr/volume/
    // volatility abstains get their second vote from the LTF
    // indicator set. The old flow only revived the top-10 by
    // PRE-confidence — the best setup could sit at rank 11+ and read
    // NEUTRAL forever. Only abstained slots are replaced (no double
    // counting) and everything degrades honestly.
    if (Array.isArray(ctx.candles) && ctx.candles.length >= 30 && ctx.__ltfInd) {
      const li = ctx.__ltfInd;
      // SMC revival (replace the abstain with the LTF-alive vote)
      const smcV = smcVote(ctx.candles);
      if (smcV && smcV.dir !== 0 && (smcV.conf || 0) > 0) {
        const reg = MODELS.find(m => m.id === 'smc');
        const idx = votes.findIndex(v => v.id === 'smc');
        if (idx >= 0) votes.splice(idx, 1);
        votes.push({ id: 'smc', name: reg.name, role: reg.role, weight: reg.weight * (adaptiveMul?.smc?.mul ?? 1) * regimeMulFor(regimeLabel, 'smc'), ...smcV });
        ctx.__smc = { dir: smcV.dir, conf: smcV.conf };
      }
      // v20.7.4 STRUCTURE revival — BOS/CHoCH + Fib golden pocket + VP
      // POC + S/D zones ka full candle-geometry vote (pass-1 me TV-only
      // ctx pe abstain hota tha; yahan LTF candles se zinda hota hai).
      if (Array.isArray(ctx.candles) && ctx.candles.length >= 60) {
        const structV = structurePro({ ...ctx, ind: { ...li } });
        if (structV && structV.dir !== 0 && (structV.conf || 0) > 0) {
          const reg2 = MODELS.find(m => m.id === 'structure');
          const idx2 = votes.findIndex(v => v.id === 'structure');
          if (idx2 >= 0) votes.splice(idx2, 1);
          votes.push({ id: 'structure', name: reg2.name, role: reg2.role, weight: reg2.weight * (adaptiveMul?.structure?.mul ?? 1) * regimeMulFor(regimeLabel, 'structure'), ...structV });
          ctx.__structure = { dir: structV.dir, conf: structV.conf };
        }
      }
      // pattern / sr / volume / volatility second vote from the LTF set
      const relVol = li.avgVolume20 > 0 ? (li.volume || 0) / li.avgVolume20 : null;
      const ltfCtx = {
        ...ctx,
        ltp: Number.isFinite(li.ltp) && li.ltp > 0 ? li.ltp : ctx.ltp,
        ind: { ...li, relVolume: relVol },
        candles: ctx.candles,
      };
      for (const mid of ['pattern', 'sr', 'volume', 'volatility']) {
        const m = MODELS.find(x => x.id === mid);
        if (!m || typeof m.fn !== 'function') continue;
        const pIdx = votes.findIndex(v => v.id === mid);
        const pAbstained = pIdx >= 0 && votes[pIdx].dir === 0;
        if (pIdx >= 0 && !pAbstained) continue; // already voted on TV data
        const v2 = m.fn(ltfCtx);
        if (v2 && v2.dir !== 0 && (v2.conf || 0) > 0) {
          if (pIdx >= 0) votes.splice(pIdx, 1);
          votes.push({ id: mid, name: m.name, role: m.role, weight: m.weight * (adaptiveMul?.[mid]?.mul ?? 1) * regimeMulFor(regimeLabel, mid), ...v2, revived: true });
        }
      }
    }
    const consensus = aggregateVotes(_rediscountRevivedVotes(votes), gatesFor(depsSafe));
    // v21.23.4 WRONG-SIGNAL-REMOVAL (the "sab ke sab opposite" fix):
    // intraday 15m/1h series missing/thin → committee YESTERDAY's daily
    // trend pe vote karti — live-proven "90% opposite" disease. Ye signal
    // kaabhi emit hi nahi hota ab: symbol suppress + honest reason payload.
    // remember() FLAT continuity rakhta hai (pinned-card flip detection
    // intact). Ye "kuch nahi" nahi — DATA ABSENT = NO SIGNAL, by design.
    if (ctx.__tfDegraded) {
      degradedSymbols.push({ symbol: ctx.symbol, reason: ctx.__tfDegraded, market: mkt });
      remember(mkt, ctx.symbol, { side: 'FLAT', confidence: 0, grade: 'NEUTRAL', ltp: ctx.ltp });
      breadth.flat++;
      continue;
    }
    // v21.23.4 THIN stamp: 15m series present hai (tape counterweight zinda)
    // par 1h resample <30 bars — signal emit hota hai with DATA-DEGRADED mark
    // (executable false + agent skip + UI chip). Suppress sirf full-missing pe.
    if (ctx.__tfDataThin) {
      consensus.dataDegraded = 'INTRADAY-TF-THIN';
      consensus.degradedReason = '15m series present par 1h resample thin (<30 bars) — main ind daily-view hybrid. Auto-trade BLOCKED, reference only (v21.23.4).';
    }
    if (consensus.dir > 0) breadth.bull++;
    else if (consensus.dir < 0) breadth.bear++;
    else breadth.flat++;
    confSum += consensus.confidence;
    // v12.4 CONTINUITY: FLAT views are remembered too — a symbol going
    // neutral is exactly when its last directional view must stay
    // queryable (the pinned holding card's "AI abhi neutral hai" read)
    // and when a later opposite-direction view must count as a FLIP.
    if (consensus.dir === 0) {
      remember(mkt, ctx.symbol, { side: 'FLAT', confidence: consensus.confidence, grade: consensus.grade, ltp: ctx.ltp });
      continue;
    }
    const plan = buildTradePlan(consensus, ctx, mkt, { maxRiskPct: riskCapFor(depsSafe) });
    // v9: the 7-factor EXPERT score for this coin (domain-correct ltp
    // injected — spot INR / futures USDT / India INR) + the PRE-super
    // AI score that ranks the candidate pool.
    const expert = expertScoreFactors({
      // v21.13: SIDE-AWARE — grade FOR the committee's side so a coin whose
      // expert lean is the OPPOSITE setup can no longer donate its
      // opposite-side quality to this side's ranking score (the top-ranked
      // cards were enriched for committee-vs-expert CONFLICT — the exact
      // "opposite" ranking disease).
      side: consensus.side,
      tv: ctx.__tv ? { ...ctx.__tv, ltp: ctx.ltp } : { ...ctx.ind, ltp: ctx.ltp },
      ltf: ctx.__ltfInd, regime, market: mkt, smc: ctx.__smc, structure: ctx.__structure,
    });
    const pre = computeSuperScore({
      engineConf: consensus.confidence,
      expertScore: expert?.score ?? null,
      agreement: consensus.agreement,
    });
    candidates.push({ ctx, votes, consensus, plan, expert, pre });
  }
  breadth.avgConf = contexts.length > 0 ? Math.round(confSum / contexts.length) : 0;
  // v9: rank the pool by the SUPERINTELLIGENCE pre-score (committee
  // conviction × expert factors), confidence as the tie-breaker.
  candidates.sort((a, b) => ((b.pre?.aiScore ?? 0) - (a.pre?.aiScore ?? 0)) || (b.consensus.confidence - a.consensus.confidence));

  // ---------------- v6.12 PASS 2: pro-trader verification ----------------
  // INDIA-ONLY now: the crypto/futures desks carry LTF candles on every
  // context (v9 universal revival above), so the Yahoo intraday
  // enrichment remains the India stock board's LTF source (15m bars).
  //   • SMC model comes ALIVE on intraday structure (it abstained
  //     on the whole India board pre-v6.12 — no candles)
  //   • mtfAnalysis: daily HTF vs LTF alignment
  //   • structureStop: swing-aware SL for the plan
  //   • v9.3 IntradayTape: the 15m tape gets its committee seat — the
  //     daily-driven committee can no longer badge a counter-tape
  //     SHORT as STRONG while the tape is rising (the screenshot bug).
  // Yahoo intraday works even where CoinDCX candles are blocked.
  // Everything degrades HONESTLY (mtf: UNAVAILABLE, no penalty).
  // v9.3: enrichment widened to 2× the board (cap 24) so the tape vote
  // ALSO fixes the ranking — the final cut re-sorts AFTER the tape
  // weighs in (the best tape-aligned setup can no longer sit at rank
  // 11+ behind daily-only votes).
  const enrichN = mkt === 'INDIA' ? Math.min(24, Math.max(10, (opts.limit || 10) * 2)) : 0;
  const enriched = new Map();
  const _mtfOn = mkt === 'INDIA' && mtfConfluenceEnabled();
  await Promise.all(candidates.slice(0, enrichN).map(async (c) => {
    const key = `${mkt}:${c.ctx.symbol}`;
    if (enriched.has(key)) return;
    try {
      const candles = await fetchYahooIntradayCandles(c.ctx.symbol, mkt);
      if (Array.isArray(candles) && candles.length >= 60) {
        const ltfInd = computeIndicatorsFromCandles(candles);
        const tape = mkt === 'INDIA' ? tapeFromCandles(candles, ltfInd, c.ctx.__tv) : null;
        // v10.5 MTF CONFLUENCE (Upgrade 1): flag ON → also fetch the 5m
        // base (ONE extra call, cached) and build the 5m/15m/1h tape
        // payload (15m reuses these native candles; 1h resamples the 5m
        // base — no third call).
        let tapeMTF = null;
        if (_mtfOn) {
          const base5m = await fetchYahoo5mCandles(c.ctx.symbol).catch(() => null);
          tapeMTF = base5m ? tapeMTFFromBase(base5m, candles, c.ctx.__tv) : null;
        }
        enriched.set(key, { candles, ltfInd, ...(tape ? { tape } : {}), ...(tapeMTF ? { tapeMTF } : {}) });
      }
    } catch { /* honest degrade — quality layer skips MTF */ }
  }));

  // ---------------- v12.6 CRYPTO/FUTURES 15m TAPE ENRICHMENT ----------------
  // THE ENTRY-TIMING SEAT'S DATA: the top candidates (2× the board,
  // cap 20 — the same slice the India tape enrichment covers) get a
  // 15m tape read. One TTL-cached upstream call per symbol per 5 min;
  // the vote is injected in the final loop below and re-ranks the
  // board AFTER it weighs in (the India pattern). Without this data
  // the tape seat abstains and the committee stays a pure 1h trend
  // echo — the 29%-win-rate disease.
  // v21.3.0 (Issue-3): cap 20 → FULL board (bypass-via-env, default on).
  // Pehle sirf top-20 candidates ko 15m tape milta tha — board ke baaki
  // cards pure 1h-lagging committee pe chalte the (the exact wrong-
  // direction class). Tape cache (5-min TTL per symbol) isliye cost
  // nearly-free rehta hai; AI_TAPE_ENRICH_N=20 purana behaviour wapas
  // deta hai.
  const _tapeCapN = (() => {
    const n = Number.parseInt(String(process.env.AI_TAPE_ENRICH_N ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(40, n) : 40;
  })();
  const tapeEnrichN = mkt === 'INDIA' ? 0 : Math.min(_tapeCapN, Math.max(10, (opts.limit || 10) * 2));
  const tapeEnriched = new Map();
  await Promise.all(candidates.slice(0, tapeEnrichN).map(async (c) => {
    const key = c.ctx.symbol;
    if (tapeEnriched.has(key)) return;
    try {
      const t = await fetchCrypto15mTape(c.ctx.symbol, c.ctx.ltp, c.ctx.__tv, mkt);
      if (process.env.SMARTAI_TAPE_DEBUG) console.log('[tape-debug]', mkt, c.ctx.symbol, t ? 'OK tape rsi=' + t.tape?.rsi : 'NULL');
      if (t) tapeEnriched.set(key, t);
    } catch { /* honest degrade — the seat abstains */ }
  }));

  // AI Council on the top candidates (toCouncilCandidate normalizes the
  // {ctx, votes, consensus, plan} board shape into the flat candidate
  // shape — symbol/side/confidence/ltp/indicators/plan).
  const top = candidates.slice(0, 6);
  let council = { verdicts: {}, model: null, online: false };
  try { council = await aiCouncilVerify(top, depsSafe, mkt); } catch { /* offline */ }

  // Merge AI Council as the 9th vote + final signals.
  const signals = [];
  // v6.12.1 FIX (recheck M-3): pass-2 injected votes (SMC revival,
  // AI Council) must carry the SAME adaptive weight multipliers that
  // pass-1 votes get — otherwise the self-correcting ensemble
  // silently reverts a learned ×1.3 boost to 1.0 on the exact vote
  // that replaced the abstain.
  const _ad = adaptiveMultipliers(_ledgerModelStats());
  // v9.3: the India final pass runs over 2× the board (cap 24) — the
  // 15m tape vote re-ranks BEFORE the cut, so a tape-aligned setup can
  // climb into the board and a counter-tape STRONG gets demoted out of
  // the top cut by its own post-tape score. Crypto/futures boards keep
  // the plain limit (their candles already voted in pass-1).
  const boardLimit = opts.limit || 10;
  const finalN = mkt === 'INDIA' ? Math.min(24, Math.max(10, boardLimit * 2)) : boardLimit;
  for (const c of candidates.slice(0, finalN)) {
    const votes = [...c.votes];
    const enrKey = `${mkt}:${c.ctx.symbol}`;
    const enr = enriched.get(enrKey) || null;
    // v6.12: inject the LTF-alive SMC vote (replace the pass-1 abstain)
    if (enr) {
      const smcV = smcVote(enr.candles);
      if (smcV && smcV.dir !== 0 && (smcV.conf || 0) > 0) {
        const reg = MODELS.find(m => m.id === 'smc');
        const idx = votes.findIndex(v => v.id === 'smc');
        if (idx >= 0) votes.splice(idx, 1);
        votes.push({ id: 'smc', name: reg.name, role: reg.role, weight: reg.weight * (_ad?.smc?.mul ?? 1), ...smcV });
      }
      // v9.3 INTRADAY TAPE VOTE — the 15m tape's committee seat. The
      // trading timeframe finally VOTES alongside the daily readers:
      // a rising 15m tape now pulls the consensus toward LONG with real
      // weight (1.3) instead of only whispering -12 conf afterwards.
      // Replaces the pass-1 abstain (same pattern as SMC — no double
      // count) and carries the adaptive multiplier like every other
      // injected vote.
      // v10.5 MTF (Upgrade 1): flag ON → the seat is IntradayTapeMTF
      // (id 'tape-mtf', w 1.6) voting the 5m/15m/1h confluence; the
      // plain tape vote is not injected (same seat, no double-count).
      // v11.8 BOARD TAPE FALLBACK: with the MTF flag ON and the 5m base
      // fetch dead (Yahoo 5m is flakier than 15m from datacenter IPs),
      // the old condition `(_mtfOn ? enr.tapeMTF : enr.tape)` skipped
      // the injection ENTIRELY — the tape seat (base w 1.6, the heaviest
      // quant seat) sat abstained on the whole India board even though a
      // perfectly good 15m tape was in hand. The seat fn degrades
      // internally (intradayTapeMTF → plain 15m read when tapeMTF is
      // null), so passing BOTH — exactly like the deep path does — makes
      // the seat vote 15m-only with an honest label whenever MTF data
      // is missing. Same seat, no double-count, either flavour.
      if (mkt === 'INDIA' && (enr.tapeMTF || enr.tape)) {
        const tapeReg = MODELS.find(m => _mtfOn ? m.id === 'tape-mtf' : m.id === 'tape');
        const tapeV = tapeReg?.fn
          ? tapeReg.fn(_mtfOn
            ? { market: mkt, tape: enr.tape, tapeMTF: enr.tapeMTF }
            : { market: mkt, tape: enr.tape })
          : null;
        if (tapeV && tapeV.dir !== 0 && (tapeV.conf || 0) > 0) {
          const seatId = _mtfOn ? 'tape-mtf' : 'tape';
          const tIdx = votes.findIndex(v => v.id === 'tape' || v.id === 'tape-mtf');
          if (tIdx >= 0) votes.splice(tIdx, 1); // drop the pass-1 abstain
          votes.push({ id: seatId, name: tapeReg.name, role: tapeReg.role, weight: tapeReg.weight * (_ad?.tape?.mul ?? 1), ...tapeV, revived: true });
        }
      }
      // v21.7.0 (Issue-2) MACROSS REVIVAL — the 15m candles we already
      // fetched carry the SMA20/50 + EMA10/20 CROSS EVENTS (the seat's
      // event read). Same replace-the-vote pattern as SMC/tape: the
      // pass-1 state-only read (TV snapshot) gives way to the REAL 15m
      // cross event when one exists. Adaptive multiplier carried like
      // every other injected vote.
      try {
        const maReg = MODELS.find(m => m.id === 'macross');
        if (maReg?.fn) {
          const maV = maReg.fn({
            market: mkt, ltp: c.ctx.ltp, ind: enr.ltfInd || c.ctx.ind, candles: enr.candles,
          });
          if (maV && maV.dir !== 0 && (maV.conf || 0) > 0) {
            const mIdx = votes.findIndex(v => v.id === 'macross');
            if (mIdx >= 0) votes.splice(mIdx, 1);
            votes.push({ id: 'macross', name: maReg.name, role: maReg.role, weight: maReg.weight * (_ad?.macross?.mul ?? 1), ...maV, revived: true });
          }
        }
      } catch { /* honest degrade — pass-1 state vote stays */ }
      // v8.0 PASS-2 REVIVAL: the TV crypto rows used to leave pattern /
      // sr / volume abstaining on the WHOLE crypto board (patterns:[],
      // pivot:null, vwap:null) — participation ~47% crushed every
      // confidence into NEUTRAL and the desk showed zero trade signals.
      // The LTF candles we already fetched for SMC carry the full
      // indicator set (patterns, OBV, MFI, VWAP, avgVolume) — so those
      // three models get a REAL second vote here. Only abstained
      // pass-1 slots are replaced (no double counting).
      try {
        const li = enr.ltfInd;
        if (li && Array.isArray(enr.candles) && enr.candles.length >= 30) {
          const relVol = li.avgVolume20 > 0 ? (li.volume || 0) / li.avgVolume20 : null;
          const ltfCtx = {
            ...c.ctx,
            ltp: Number.isFinite(li.ltp) && li.ltp > 0 ? li.ltp : c.ctx.ltp,
            ind: { ...li, relVolume: relVol },
            candles: enr.candles,
          };
          for (const mid of ['pattern', 'sr', 'volume', 'volatility']) {
            const m = MODELS.find(x => x.id === mid);
            if (!m || typeof m.fn !== 'function') continue;
            const pIdx = votes.findIndex(v => v.id === mid);
            const pAbstained = pIdx >= 0 && votes[pIdx].dir === 0;
            if (pIdx >= 0 && !pAbstained) continue; // already voted on TV data
            const v2 = m.fn(ltfCtx);
            if (v2 && v2.dir !== 0 && (v2.conf || 0) > 0) {
              if (pIdx >= 0) votes.splice(pIdx, 1);
              votes.push({ id: mid, name: m.name, role: m.role, weight: m.weight * (_ad?.[mid]?.mul ?? 1), ...v2, revived: true });
            }
          }
        }
      } catch { /* honest degrade — keep pass-1 votes */ }
    }
    // v12.6 CRYPTO/FUTURES TAPE VOTE — the 15m entry-timing seat on the
    // crypto desks (same injection pattern as India's: replace the
    // pass-1 abstain, carry the adaptive multiplier, vote only when the
    // enrichment actually produced a tape). Deliberately OUTSIDE the
    // `if (enr)` India block — the crypto tape enrichment has its OWN
    // map. A stretched 15m tape now pulls the consensus OFF the late
    // LONG; a pullback tape confirms it with timing weight.
    if (mkt !== 'INDIA') {
      const tEnr = tapeEnriched.get(c.ctx.symbol);
      if (tEnr?.tape) {
        const tapeReg = MODELS.find(m => m.id === 'tape' || m.id === 'tape-mtf');
        const tapeV = tapeReg?.fn ? tapeReg.fn({ market: mkt, tape: tEnr.tape }) : null;
        if (tapeV && tapeV.dir !== 0 && (tapeV.conf || 0) > 0) {
          const tIdx = votes.findIndex(v => v.id === 'tape' || v.id === 'tape-mtf');
          if (tIdx >= 0) votes.splice(tIdx, 1); // drop the pass-1 abstain
          votes.push({ id: tapeReg.id, name: tapeReg.name, role: tapeReg.role, weight: tapeReg.weight * (_ad?.tape?.mul ?? 1), ...tapeV, revived: true });
        }
      }
    }
    let aiNote = null;
    let aiConf = null; // v9: the council's own confidence → the super score blend
    // (v21.0: the deterministic self-echo fallback is REMOVED — offline
    // means honest 2-source blend, not committee-confidence rebranded as
    // an "AI verdict". aiSource: null ya 'council' hi ho sakta hai ab.)
    const verdict = council.verdicts[c.ctx.symbol];
    if (verdict) {
      const av = aiCouncilVoteFromVerdict(verdict);
      if (av) {
        votes.push({
          id: 'aicouncil', name: 'AI Council (LLM)', role: MODELS.find(m => m.id === 'aicouncil').role,
          weight: MODELS.find(m => m.id === 'aicouncil').weight * (_ad?.aicouncil?.mul ?? 1), ...av,
        });
        aiNote = { verdict: verdict.verdict, note: verdict.note, analysis: verdict.analysis, model: council.model,
          // v10.8: bull/bear debate cases — the PM verdict's evidence trail
          ...(council.debate ? { debate: { bull: council.debate.bull?.[c.ctx.symbol]?.case ?? null, bear: council.debate.bear?.[c.ctx.symbol]?.case ?? null } } : {}) };
        aiConf = av.conf ?? verdict.confidence ?? null;
      } else {
        // v21.13.x recheck (C1): the 16th voting seat never SILENTLY
        // vanishes from the roster — an unparseable verdict = structural
        // abstain (options/fundamentals ki tarah na:true), roster 16
        // stable rehta hai (the user-visible committee).
        votes.push({
          id: 'aicouncil', name: 'AI Council (LLM)', role: MODELS.find(m => m.id === 'aicouncil').role,
          weight: MODELS.find(m => m.id === 'aicouncil').weight * (_ad?.aicouncil?.mul ?? 1),
          dir: 0, conf: 0, na: true,
          reasons: ['AI Council verdict unparseable — structural abstain'],
        });
      }
    } else {
      // v21.13.x recheck (C1): offline council = honest structural
      // abstain, NOT a missing seat (pehle the seat silently vanished —
      // the committee roster was environment-dependent 15/16).
      votes.push({
        id: 'aicouncil', name: 'AI Council (LLM)', role: MODELS.find(m => m.id === 'aicouncil').role,
        weight: MODELS.find(m => m.id === 'aicouncil').weight * (_ad?.aicouncil?.mul ?? 1),
        dir: 0, conf: 0, na: true,
        reasons: ['AI Council offline (no provider verdict) — structural abstain'],
      });
    }
    // v20.9.4 FIX (H2 — meta-ensemble ab PRODUCTION me wired):
    // aggregateVotesWithMeta v10.5 se defined tha par board/deep KABHI call
    // nahi karte the — AI_ENABLE_META_ENSEMBLE=true flag .env.example me
    // ship hota tha, docs trained LightGBM stacking claim karte the, par
    // har consensus hamesha plain weighted-average tha (cryptoAgent ka
    // metaEnsemble field hamesha null). Ab FINAL aggregation sites (ye
    // board site + deep final) meta-aware hain: flag ON + service UP →
    // meta recombination (side kabhi flip nahi hota, quorum/MTF caps
    // bypass nahi); flag OFF/service down/breaker open → weighted (bilkul
    // pehle jaisa). Pass-1 breadth + deep pre-council PRE-SCANS hain —
    // wahan weighted hi rahte hain (cost + council ko stable input).
    // Circuit breaker (5 min) service-down pe per-symbol timeout tax
    // rokta hai — sequential board loop safe.
    let consensus2 = await aggregateVotesWithMeta(_rediscountRevivedVotes(votes), gatesFor(depsSafe), {
      // v21.4.1 [deep-recheck A2]: FINAL board aggregation par bhi revived-vote
      // rediscount — tape/pattern/sr/volume/council votes isi final loop me
      // inject hote hain (pass-1 ke baad), aur _rediscountRevivedVotes sirf
      // pass-1 (:1650) pe lagta tha — tape seat (w 1.3/1.6, trend↔tape PRIMARY
      // dedup pair) board consensus me HAMESHA full weight pe vote karta
      // tha. Deep path pe tape injection pre-council rediscount se PEHLE hota
      // hai (covered tha); board ab bhi covered. Helper idempotent hai —
      // pass-1 wale already-discounted votes untouched rehte hain.
      // v10.5 MTF CONFLUENCE CAP: a 5m/15m/1h disagreement (< 0.67)
      // bans the STRONG badge at the consensus layer (the plan's
      // "max MODERATE" — ACTION in this ladder).
      ...(_mtfOn && enr?.tapeMTF && Number.isFinite(enr.tapeMTF.agreement)
        ? { mtfAgreement: enr.tapeMTF.agreement } : {}),
      regime,
    });
    // Rebuild the plan from the POST-council consensus: the council vote
    // can flip the final side, and a SHORT signal carrying a long-style
    // plan (SL below entry, TP2 above) would invert every alert levels.
    // v6.12: the plan also takes the swing-structure stop when the
    // probrain layer found one on the LTF candles.
    let plan2 = null, quality = null;
    if (consensus2.dir !== 0) {
      // v20.4 COUNTER-TAPE WIRING (the CoinDCX "STRONG 80+ SHORT while the
      // tape climbs" fix): the v9.3 counter-tape grade caps (MISALIGNED
      // htf-vs-15m → conf −12/−18 + WATCH/ACTION ban) were wired only to
      // the INDIA enrichment map — on CRYPTO/FUTURES `enr` is always null
      // (enrichN=0 off-India), so mtfAnalysis compared the 1h committee
      // against ITSELF (ltf also 1h) and the MISALIGNED phase could never
      // fire off India. Result: a lagging 1h bear stack printed STRONG
      // SHORT at the bottom of a V while the 15m tape was already ripping
      // up — the exact user report. The crypto desks' own 15m tape
      // enrichment (tapeEnriched — the SAME data the tape vote reads) now
      // feeds the quality verdict: counter-tape STRONGs demote exactly
      // like the India desk, a CONFIRMING tape keeps the desk's STRONGs,
      // and the structure stop lands on real 15m swings.
      const _cxTape = mkt !== 'INDIA' ? (tapeEnriched.get(c.ctx.symbol) || null) : null;
      const qv = qualityVerdict({
        market: mkt, side: consensus2.side, consensus: consensus2, votes,
        ltp: c.ctx.ltp, changePct: c.ctx.changePct,
        rsi: c.ctx.ind?.rsi, adx: c.ctx.ind?.adx,
        atr: (mkt !== 'INDIA' ? _cxTape?.ltfInd?.atr : enr?.ltfInd?.atr) ?? c.ctx.ind?.atr,
        candles: mkt !== 'INDIA' ? _cxTape?.candles : enr?.candles,
        // v21.13: INDIA htf = the DAILY TV view (ctx.__dailyInd) — the seats
        // vote 15m now, so ctx.ind is 15m; the MISALIGNED daily-vs-15m phase
        // needs the REAL HTF (crypto desks unchanged: their ctx.ind IS 1h).
        regime, htf: (mkt === 'INDIA' ? (c.ctx.__dailyInd ?? c.ctx.ind) : c.ctx.ind),
        ltf: mkt !== 'INDIA' ? _cxTape?.ltfInd : enr?.ltfInd,
        ltfLabel: '15m', now: Date.now(),
      });
      plan2 = buildTradePlan(consensus2, c.ctx, mkt, {
        maxRiskPct: riskCapFor(depsSafe),
        ...(qv.stop && !qv.stop.rejected && qv.stop.sl ? { structureStop: qv.stop } : {}),
      }) ?? c.plan;
      // v6.12 finalization: honest confidence (quorum caps already in
      // aggregateVotes) + probrain adjustments + grade cap ladder.
      const finalConf = Math.max(5, Math.min(99, consensus2.confidence + qv.confAdj));
      const gates = gatesFor(depsSafe);
      let finalGrade;
      if (finalConf >= gates.minConfidence && consensus2.agreement >= gates.minAgreement) finalGrade = 'STRONG';
      else if (finalConf >= 55) finalGrade = 'ACTION';
      else if (finalConf >= 35) finalGrade = 'WATCH';
      else finalGrade = 'NEUTRAL';
      const capRank = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };
      if (capRank[qv.gradeCap] < capRank[finalGrade]) finalGrade = qv.gradeCap;
      quality = {
        ...qv.flags,
        confAdj: qv.confAdj,
        veto: qv.flags.veto || null,
        reasons: qv.reasons,
        mtf: { phase: qv.mtf.phase, aligned: qv.mtf.aligned, available: qv.mtf.available },
        session: { phase: qv.session.phase, tradeable: qv.session.tradeable },
        stopStyle: qv.stop && !qv.stop.rejected ? (qv.stop.style || 'swing-structure') : null,
      };
      consensus2 = {
        ...consensus2,
        confidence: finalConf,
        grade: finalGrade,
        summary: `${consensus2.summary}${qv.flags.veto ? ` · ${qv.flags.veto.toUpperCase()} VETO` : ''}`,
      };
    } else {
      plan2 = c.plan;
    }
    // v12.4 SIGNAL TRUST GUARDS — the pro-trader entry discipline layer:
    //   • OVERBOUGHT (RSI ≥ 70) LONG / OVERSOLD (RSI ≤ 30) SHORT can no
    //     longer wear ACTION/STRONG (chase protection — the WLD class)
    //   • a side that JUST flipped (< 5m) is capped to WATCH (whipsaw
    //     protection) and every card now carries its true AGE
    //   • the observation is remembered for continuity (age/flips)
    // Runs on BOTH directional and FLAT finals; never throws; never
    // touches side/ltp (plan2 stays valid).
    {
      const guarded = applySignalTrustGuards({
        market: mkt, symbol: c.ctx.symbol, consensus: consensus2,
        ctx: c.ctx, ltf: enr?.ltfInd ?? c.ctx.__ltfInd ?? null,
      });
      if (guarded) consensus2 = guarded;
    }
    // -----------------------------------------------------------------
    // v18.5 SUPER INTELLIGENCE MTF-6 — the full 1m/5m/15m/1h/4h/1d
    // confluence read, for BOTH markets (the old 5m/15m/1h tape wire
    // was INDIA-only and flag-gated OFF; crypto's quality.mtf was
    // permanently UNAVAILABLE). Adjustment ladder:
    //   • side aligned with 6-TF consensus → +3 (+5 at ≥72% agreement)
    //   • side AGAINST the 6-TF consensus → −7 conf, STRONG → ACTION
    //     (counter-HTF at 1d/4h too → −10)
    //   • LTF timing POOR (1m/5m exhaustion) → STRONG → ACTION
    //   • 15m swing structure-stop feeds the plan when probrain's own
    //     stop was rejected
    //   • quality.mtf becomes the REAL 6-TF phase/consensus/agreement
    // Never throws; a degraded snapshot (missing sources) is a no-op.
    // -----------------------------------------------------------------
    let mtf6 = null;
    // v21.3.0: veto/chop stamps — computeSuperScore ko cap milta hai aur
    // buildSignal quality flags carry karta hai (UI + exec gate dono).
    let _htfVetoed = false, _chopCapped = false;
    try {
      if (consensus2.dir !== 0 && c.consensus?.confidence >= 30) {
        mtf6 = await buildMTFSnapshot(c.ctx.symbol, mkt, { side: consensus2.side, ltp: c.ctx.ltp });
        if (mtf6?.ok) {
          let confAdj6 = 0;
          if (mtf6.alignedWithSide === true) confAdj6 = mtf6.agreement >= 0.72 ? 5 : 3;
          else if (mtf6.alignedWithSide === false) confAdj6 = mtf6.counterHtf ? -10 : -7;
          if (confAdj6 !== 0) {
            const conf6 = Math.max(5, Math.min(99, consensus2.confidence + confAdj6));
            consensus2 = { ...consensus2, confidence: conf6 };
          }
          const demote = ((mtf6.alignedWithSide === false) || (mtf6.timing?.quality === 'POOR'))
            && consensus2.grade === 'STRONG';
          if (demote) {
            const why = mtf6.alignedWithSide === false ? 'MTF-6 conflict' : 'LTF timing';
            consensus2 = { ...consensus2, grade: 'ACTION', summary: `${consensus2.summary} · ${why}` };
          }
          // ---------------------------------------------------------
          // v21.3.0 (Issue-3) HARD VETOES — haircuts se aage badh ke:
          //  • COUNTER-HTF: signal side 1d/4h consensus ke SIDDA against
          //    hai → grade WATCH + aiScore cap 62. 4-5 paper trades sab
          //    SL hit is class me the (1h committee late-confirm karta
          //    hai, 1d/4h ulta hota hai, mean-reversion stop uda deti hai).
          //  • CHOP: 6-TF SPLIT (koi dominant side nahi = range) ya
          //    ADX < 15 (trend strength hi nahi) → grade cap WATCH —
          //    range me 2R targets structurally unreachable hote hain.
          //  WATCH cards board pe dikhte hain (context) par 80+ badge,
          //    LIVE execute gate aur TOP-5 eligibility teeno se bahar.
          // ---------------------------------------------------------
          const adxNow = readAdxNum(c.ctx.ind?.adx); // v21.4.1 [A1]: object-form {adx,…} bhi ab padhta hai
          const counterHtfHit = VETO_COUNTER_HTF && mtf6.counterHtf === true;
          const chopHit = VETO_CHOP && (mtf6.phase === 'SPLIT' || (adxNow != null && adxNow < 15));

          if (counterHtfHit || chopHit) {
            const why = counterHtfHit ? 'HTF VETO (1d/4h against)' : 'CHOP FILTER (range)';
            _htfVetoed = counterHtfHit;
            _chopCapped = !counterHtfHit && chopHit;
            const rankOf = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };
            if ((rankOf[consensus2.grade] ?? 0) > rankOf.WATCH) {
              consensus2 = { ...consensus2, grade: 'WATCH', summary: `${consensus2.summary} · ${why}` };
            }
            if (quality) {
              quality = {
                ...quality,
                veto: counterHtfHit ? 'counter-htf' : (chopHit ? 'chop-range' : null),
                ...(counterHtfHit ? { counterHtfVeto: true } : {}),
                ...(chopHit ? { chopRange: true } : {}),
              };
            }
          }
          if (mtf6.structureStop?.sl && !quality?.stopStyle && plan2) {
            const rebuilt = buildTradePlan(consensus2, c.ctx, mkt, {
              maxRiskPct: riskCapFor(depsSafe), structureStop: mtf6.structureStop,
            });
            if (rebuilt) plan2 = rebuilt;
          }
          if (quality) {
            quality = {
              ...quality,
              mtf: {
                phase: mtf6.phase, aligned: mtf6.alignedWithSide, available: true,
                consensus: mtf6.consensus, agreementPct: mtf6.agreementPct, engine: 'mtf6',
              },
            };
          }
        }
      }
    } catch { /* MTF-6 never breaks the board */ }
    // v21.7.0 (Issue-3) STRICT AGREEMENT CAP — Superintelligence accuracy
    // upgrade: a 55/45 SPLIT committee (actionable-looking conf par aadha
    // board against) pehle ACTION pehen ke paper entries execute karwa
    // deta tha. Split committee = NO-TRADE: agreement < 0.62 → ACTION
    // cap WATCH (AI_STRICT_AGREEMENT=0 se off). Deep path me bhi same.
    consensus2 = applyStrictAgreementCap(consensus2);
    // v21.3.0: per-signal stamp for the superIntel cap + wire payload.
    const _scoreCap = _htfVetoed || _chopCapped ? 62 : null;
    const sig = buildSignal({
      symbol: c.ctx.symbol, market: mkt, ctx: c.ctx, votes, consensus: consensus2, plan: plan2, aiNote, quality,
    });
    // v10.5 MTF CONFLUENCE (Upgrade 1): the 5m/15m/1h wire payload for
    // the signal card's MTF badge (dirs + conf + agreement %).
    if (_mtfOn && enr?.tapeMTF) {
      const mtf = mtfWirePayload(enr.tapeMTF);
      if (mtf) sig.mtf = mtf;
    }
    // v18.5: the MTF-6 badge payload (all 6 TFs + consensus + timing) —
    // supersedes the legacy wire ONLY when the engine produced a real
    // read (a degraded/offline snapshot must never clobber the legacy
    // 5m/15m/1h payload the tests + offline boards still rely on).
    if (mtf6?.ok) {
      const wire6 = mtfWire6Payload(mtf6);
      if (wire6) sig.mtf = wire6;
    }
    // v9 SUPERINTELLIGENCE final scoring + blueprint — the committee
    // verdict (post-council, post-quality) × the 7-factor expert score
    // × the AI verdict, then the COMPLETE trade ticket: entry timing,
    // leverage ladder, staged exit, exit CLOCK.
    if (consensus2.dir !== 0) {
      // expert factors re-shape when the council flipped the side
      const expert = (c.expert && c.expert.side === consensus2.side) ? c.expert : expertScoreFactors({
        // v21.13: SIDE-AWARE (same fix as pass-1) — a flipped/council-
        // adjusted consensus must be graded FOR ITS OWN SIDE, never the
        // coin's opposite-side expert lean.
        side: consensus2.side,
        tv: c.ctx.__tv ? { ...c.ctx.__tv, ltp: c.ctx.ltp } : { ...c.ctx.ind, ltp: c.ctx.ltp },
        ltf: enr?.ltfInd ?? c.ctx.__ltfInd ?? null, regime, market: mkt, smc: c.ctx.__smc, structure: c.ctx.__structure,
      });
      // ----------------------------------------------------------------
      // v21.0 SELF-ECHO REMOVED (deep-check D5): pehle LLM-offline hone
      // par `aiConf` committee-confidence se hi synthesize hota tha
      // (aiConfFinal = conf × (0.85+0.10·agreement)) — computeSuperScore
      // ka 3-source blend khud se hi blend ho raha tha (engine 45% +
      // expert 35% + "AI" 20% jahan AI = engine ka hi echo). Ab offline
      // me aiConf null rehta hai → computeSuperScore HONEST 2-source
      // redistribute karta hai (55% engine + 45% expert). "AI verdict"
      // driver sirf tab dikhta hai jab sach me koi LLM (cloud/Ollama)
      // ne verdict diya ho.
      // ----------------------------------------------------------------
      const aiConfFinal = aiConf;
      const sup = computeSuperScore({
        engineConf: consensus2.confidence,
        expertScore: expert?.score ?? null,
        aiConf: aiConfFinal,
        quality,
        agreement: consensus2.agreement,
        counterTrend: !!(quality?.regime?.counterTrend),
        // v21.3.0 (Issue-3): HTF-veto / chop-capped signals kabhi 80+ badge
        // nahi le sakte — cap 62 pe score bound hota hai (UCV-reject 64 se
        // bhi sakht, kyunki ye class documented SL-hit class hai).
        cap: _scoreCap,
      });
      const atr = enr?.ltfInd?.atr ?? c.ctx.ind?.atr ?? null;
      const blueprint = buildSuperBlueprint({
        side: consensus2.side, ltp: c.ctx.ltp, atr, aiScore: sup.aiScore, market: mkt,
        ema20: c.ctx.ind?.ema20 ?? enr?.ltfInd?.ema20 ?? null,
        stopLoss: plan2?.stopLoss, target1: plan2?.target1, target2: plan2?.target2,
        atrPctLtp: (atr != null && atr > 0 && c.ctx.ltp > 0) ? (atr / c.ctx.ltp) * 100 : null,
        now: Date.now(), sqOffBy: mkt === 'INDIA' ? '15:10 IST' : null,
        changePct: c.ctx.changePct,
      });
      sig.superIntel = {
        aiScore: sup.aiScore, tier: sup.tier, drivers: sup.drivers,
        factors: expert?.factors ?? null, blueprint,
        // v20.5: surface the deterministic fallback flag so the UI can
        // label the third source honestly ("deterministic council" vs
        // "live LLM council"). Also surfaces on the deep path below.
        aiSource: aiConf != null ? 'council' : null,
      };
    }
    signals.push(sig);
  }

  // -----------------------------------------------------------------
  // v12.0 PRO TRADER UPGRADE — WIN PROBABILITY + PERP POSITIONING
  // on every scored crypto/futures signal:
  //   • P(WIN) — the ledger-calibrated probability (trust.js settled
  //     outcomes + side split) blended with the AI score, funding,
  //     positioning and MTF confluence.
  //   • P(NEED) — the R:R breakeven. EDGE = P(WIN) − P(NEED) + EV in
  //     R-multiples → "highest win trades" becomes a number, not a vibe.
  //   • PERP intel wire payload (FUTURES only) — funding/OI/L-S/taker
  //     positioning read on the card.
  // First cycle warms the 60s perpIntel cache inside a 2.5s soft
  // deadline (honest degrade: winProb still computes without perp
  // fields); the next 30s board cycle reads it hot.
  // -----------------------------------------------------------------
  // v21.3.0 (Issue-5): confirm-layer meta — payload superIntelMeta surface
  let aiConfirmMeta = null;
  if (signals.some(s => s.superIntel)) {
    try {
      const scored = signals.filter(s => s.superIntel && (s.side === 'LONG' || s.side === 'SHORT'));
      const bases = [...new Set(scored.map(s => String(s.symbol).toUpperCase()))];
      const perpPromise = (mkt === 'FUTURES' && perpIntelEnabled() && bases.length > 0)
        ? Promise.race([
            getPerpIntelFor(bases, 6000),
            new Promise((res) => { const t = setTimeout(() => res(new Map()), 2500); t.unref?.(); }),
          ])
        : Promise.resolve(new Map());
      const [cal, perpMap] = await Promise.all([
        calibrationSnapshot().catch(() => null),
        perpPromise.catch(() => new Map()),
      ]);
      for (const s of scored) {
        const intel = perpMap.get(String(s.symbol).toUpperCase()) || null;
        s.superIntel.winProb = computeWinProb({
          side: s.side, market: mkt,
          aiScore: s.superIntel.aiScore,
          engineConf: s.confidence,
          rewardRisk: s.plan?.rewardRisk ?? null,
          agreement: s.agreement,
          mtfAligned: s.mtf?.agreement != null ? s.mtf.agreement >= 0.67 : null,
          counterRegime: !!s.quality?.regime?.counterTrend,
          fundingBps8h: intel?.fundingBps8h ?? null,
          positioningScore: intel?.read?.score ?? null,
          calibration: cal,
        });
        if (mkt === 'FUTURES' && intel?.ok) {
          const wire = perpIntelWire(intel);
          if (wire) s.superIntel.perp = wire;
        }
        // v13.1 SIGNAL VERIFICATION AGENT (SVA-v1) — the senior pro
        // trader's final LONG/SHORT/NO-TRADE verdict on every scored
        // signal (chase/RSI/quorum/MTF/edge checklist; the XRP-class
        // top-chase LONG flips or stands aside HERE, before money
        // moves). Wire-compact — the deep path + agent tool carry the
        // full checklist.
        try { s.verify = verificationWire(verifySignal(s)); } catch { /* never breaks the board */ }
        // v13.2 A2: the LLM second opinion rides ALONG when a deep dive in
        // this 15m candle already produced one (cache read only — the board
        // NEVER triggers an LLM call; borderline asks are deep-path only).
        try {
          const llmV = llmValidateCached(s.symbol, s.market);
          if (llmV) s.verify = { ...(s.verify || {}), llm: llmV };
        } catch { /* cache read only */ }
      }
    } catch { /* win-prob never breaks the board */ }

    // -----------------------------------------------------------------
    // v20.9.2 ULTRAFAST CHART VERIFICATION AGENT (UCV-A1) — the user's
    // direction-mismatch fix: "long bolne par short jaa rahe hai". The
    // committee's heavy seats lag by construction; this layer asks the
    // REALTIME ultrafast 1m chart the ONLY question that matters for
    // the 80+ tier: "ye LONG pakka long jayega? ye SHORT pakka short
    // jayega?" A REJECTED direction (signal LONG, 1m tape DOWN = the
    // exact mismatch class) loses the 80+ badge (aiScore capped 64) and
    // is demoted to WATCH — a signal fighting its own ultrafast chart
    // can never wear STRONG/ACTION. Cost-bounded: top-6 by aiScore per
    // cycle, 45s verdict cache, 1.5s deadline, honest PENDING degrade.
    // -----------------------------------------------------------------
    try {
      // v20.9.3 FIX (M): top-6 → top-12. Boards carry up to 40 rows — a
      // broad rally with 7+ signals ≥80 left the 7th+ wearing 80+/STRONG
      // with NO UC verdict at all (proTraderGate's UC lock passes
      // vacuously when uc == null). The 45s verdict cache makes widening
      // nearly free. v20.9.3 FIX (L): Promise.all — sequential stamps
      // could add up to 6-9s on a cold board when both candle legs are
      // slow; the cache keys are distinct per symbol so parallel is safe.
      const ucTargets = signals
        .filter(s => s.superIntel && (s.side === 'LONG' || s.side === 'SHORT')
          && (Number(s.superIntel.aiScore) >= 80 || s.grade === 'STRONG'))
        .sort((a, b) => (Number(b.superIntel?.aiScore) || 0) - (Number(a.superIntel?.aiScore) || 0))
        .slice(0, 12);
      await Promise.all(ucTargets.map(async (s) => {
        try {
          const uv = await verifySignalUltrafast(s, { deadlineMs: 1500 });
          if (!uv) return;
          s.ultrafast = ultrafastWire(uv);
          if (uv.verdict === 'REJECTED') {
            const patch = ultrafastGatePatch(uv, s);
            if (patch) {
              s.superIntel = patch.superIntel;
              if (patch.grade) { s.grade = patch.grade; s.executable = false; } // v21.4.1: UCV-demote ke baad kabhi executable nahi
              s.ucRejected = true; // visible flag for logs/tests
              // v20.9.3 FIX (L): winProb was computed from the PRE-CAP
              // aiScore — a REJECTED card showed "aiScore 64 · P(win)
              // EDGE" (optimism from the uncapped 85). Recompute from the
              // capped score so the card tells ONE story.
              try {
                s.superIntel.winProb = computeWinProb({
                  side: s.side, market: mkt,
                  aiScore: s.superIntel.aiScore,
                  engineConf: s.confidence,
                  rewardRisk: s.plan?.rewardRisk ?? null,
                  agreement: s.agreement,
                  mtfAligned: s.mtf?.agreement != null ? s.mtf.agreement >= 0.67 : null,
                  counterRegime: !!s.quality?.regime?.counterTrend,
                  fundingBps8h: s.superIntel.perp?.fundingBps8h ?? null,
                  positioningScore: s.superIntel.perp?.read?.score ?? null,
                  calibration: null, // bucket re-apply is best-effort below
                });
              } catch { s.superIntel.winProb = null; }
              // v20.9.4 [M]: SVA re-stamp post-cap — VerifyBadge bhi capped
              // numbers padhe (deep path ke saath parity; pure fn, cheap).
              try { s.verify = verifySignal(s); } catch { /* keep pre-patch */ }
            }
          }
        } catch { /* one symbol's UC failure never breaks the board */ }
      }));
    } catch { /* UC layer never breaks the board */ }
  }

  // -----------------------------------------------------------------
  // v21.3.0 (Issue-5) lineage — JEV AI CONFIRMATION LAYER: the board's
  // top STRONG/ACTION 75+ signals go to the AI provider (Jev cloud;
  // v21.14: Laya removed). Verdicts: AGREE → aiScore +3 (CONFIRMED);
  // provider picks the OPPOSITE side → aiScore −8 + STRONG→ACTION
  // (CONFLICT). Soft 4.5s deadline — unresolved verdicts memo-warm and
  // stamp the NEXT cycle (the council "warming" pattern). AI kabhi
  // side/size/SL nahi badalta — confirm ya demote only.
  // Unconfigured → honest no-op (sandbox / no keys).
  // -----------------------------------------------------------------
  if (_boardAiConfirmActive()) {
    try {
      aiConfirmMeta = await _confirmBoardSignals(signals, mkt);
    } catch { /* never breaks the board */ }
  }

  // v9: the board is ranked by the SUPERINTELLIGENCE AI score (the
  // 80+ bar the desk filters on), confidence as the tie-breaker.
  // v12.6 ENTRY-QUALITY-ADJUSTED RANKING: the raw aiScore crowned the
  // most-EXTENDED movers (late trend confirmation reads as maximum
  // conviction — the replay engine measured that ranking at 29%
  // win-rate). The rank key now multiplies the score by the entry
  // band: PULLBACK ×1.10, EXTENDED ×0.93, chase HARD/SOFT ×0.85.
  // The card's displayed aiScore is untouched — rankScore rides the
  // payload so the ranking is fully transparent.
  for (const s of signals) {
    const base = Number(s.superIntel?.aiScore ?? s.confidence) || 0;
    const q = s.entryQuality?.band;
    const chase = s.chasing?.severity;
    const mul = q === 'PULLBACK' ? QUALITY_PULLBACK_SCORE_MUL
      : (chase === 'HARD' || chase === 'SOFT') ? QUALITY_HARD_SCORE_MUL
        : q === 'EXTENDED' ? QUALITY_EXTENDED_SCORE_MUL
          : 1;
    s.__rankScore = base * mul;
    if (s.superIntel) s.superIntel.rankScore = Math.round(s.__rankScore * 10) / 10;
  }
  signals.sort((a, b) => ((b.__rankScore ?? b.superIntel?.aiScore ?? b.confidence) - (a.__rankScore ?? a.superIntel?.aiScore ?? a.confidence)));
  // v9.3: the India pass built 2× the board — cut to the display limit
  // AFTER the tape-aware re-rank (crypto/futures already match the cut).
  if (signals.length > boardLimit) signals.length = boardLimit;

  // -----------------------------------------------------------------
  // v12.4 SIGNAL PERSISTENCE — traded symbols NEVER vanish from the
  // board. A WLD entry at 0.4385 used to leave the board entirely the
  // moment its consensus went FLAT or it fell under the top-N cut —
  // the user was left with a live position and zero AI context. Now:
  //   • cards for symbols with OPEN positions (journal + manual
  //     tracker) carry a 🎯 HOLDING stamp (side/entry/age)
  //   • held symbols missing from the cut get a PINNED card (the AI's
  //     current view or an honest "AI abhi neutral hai") — bounded to
  //     4 pins so a full book can't flood the board
  // Never throws — pinning is context, never a blocker.
  // -----------------------------------------------------------------
  try { pinHoldingOnBoard(signals, mkt, { maxPinned: 4 }); } catch { /* pinning degrades */ }

  // v10.15 GAP 2: the EVENT CHIP — every signal carries the next
  // scheduled event for its symbol/desk (⚠ Earnings in 2h / ⚠ FOMC
  // 30m). PURE synchronous attach — the same eventGuardCheck the
  // agents' entry gauntlet uses (one truth, no drift).
  for (const s of signals) {
    try {
      const eg = eventGuardCheck({ symbol: s.symbol, desk: mkt });
      if (eg.event && Number(eg.event.minutesUntil) <= 240) {
        s.event = {
          kind: eg.event.kind, label: eg.event.label,
          inMin: Number(eg.event.minutesUntil),
          approximate: !!eg.event.approximate,
          blocked: eg.action === 'blackout',
          haircut: eg.action === 'haircut' ? eg.multiplier : null,
        };
      }
    } catch { /* the chip is cosmetic — never breaks the board */ }
  }

  // v6.9: full-universe composite TOP-5 (transparent score + Hinglish
  // rank reason — the board payload carries it so the desks get the
  // SAME ranking the server would execute against).
  const topFive = computeTopFive(signals, regime, mkt, 5);

  // v11.0 GLOBAL MARKET COUNCIL HOOK (AI_ENABLE_GLOBAL_COUNCIL, default
  // OFF). Board mode: the top-5 candidates go to the 6-seat council in
  // SIX batched persona calls (verdicts cached 90s per symbol — repeated
  // board polls never multiply LLM cost). Soft deadline 12s: unresolved
  // verdicts keep warming in the council cache and stamp the NEXT cycle
  // (the warmDepthBatch honest-degrade pattern). The council NEVER
  // touches grades/plans/execution — it ATTACHES its verdict stamp.
  let councilMeta = null;
  if (councilEnabled()) {
    try {
      // feature matrix needs the RAW ctx (ind/vwap/ema) — the wire
      // signal picks only display fields, so re-join the ctx here.
      const ctxMap = new Map(contexts.map(c => [c.symbol, c]));
      const councilCandidates = topFive.map(s => {
        const c = ctxMap.get(s.symbol);
        return c ? { ...s, ind: c.ind, __ltfInd: c.__ltfInd || null } : s;
      });
      const councilRan = await Promise.race([
        runCouncilBoard({ market: mkt, signals: councilCandidates, regime, deps: depsSafe }),
        new Promise((res) => { const t = setTimeout(() => res(null), 12_000); t.unref?.(); }),
      ]);
      if (councilRan) {
        let stamped = 0;
        for (const s of signals) {
          const v = councilRan.bySymbol[s.symbol];
          if (v) { s.council = councilStampOf(v); stamped += 1; }
        }
        councilMeta = {
          enabled: true, model: councilRan.model, stamped,
          gate: gateThresholds(),
          passed: signals.filter(s => s.council?.gate === 'PASSED').length,
          suppressed: signals.filter(s => s.council?.gate === 'SUPPRESSED').length,
        };
      } else {
        councilMeta = { enabled: true, model: 'warming', stamped: 0, note: 'council verdicts in-flight — next board cycle pe stamp honge (90s cache)' };
      }
    } catch {
      councilMeta = { enabled: true, model: 'error', stamped: 0, note: 'council degraded — board unaffected' };
    }
  } else {
    councilMeta = { enabled: false, flag: 'AI_ENABLE_GLOBAL_COUNCIL' };
  }

  // v6.12: session phase — the intraday desk must KNOW when it is
  // safe to fire (opening noise / square-off window / market closed).
  const ses = sessionPhaseOf(mkt, Date.now());
  // v21.8.0 METALS DOMAIN STAMP: XAU/XAG B-XAU_USDT/B-XAG_USDT NORMAL
  // USDT perps hain — signals + topFive FUTURES domain pe hi jaate hain
  // taaki har downstream consumer (SignalCard currency USDT + execute
  // gauntlet + deep FUTURES branch + SSE FUT_XAU ticks + TopPicks
  // priceFmt) bina kisi naye branch ke kaam kare. BOARD ka apna label
  // 'METALS' hi rehta hai (provenance + client state separation).
  if (mkt === 'METALS') {
    for (const s of signals) s.market = 'FUTURES';
    for (const p of topFive) if (p) p.market = 'FUTURES';
  }
  const payload = {
    ok: true, market: mkt,
    marketOpen: mkt === 'INDIA' ? isNseOpen() : true,
    sessionPhase: { phase: ses.phase, tradeable: ses.tradeable, note: ses.note },
    regime,
    breadth,
    // v21.23.4 WRONG-SIGNAL-REMOVAL: suppressed (data-degraded) symbols ka
    // honest ledger — intraday-TF missing symbols ka signal REMOVE hua
    // (daily-fallback "90% opposite" disease), UI banner isi se banta hai.
    degraded: {
      count: degradedSymbols.length,
      symbols: degradedSymbols.slice(0, 50),
      note: degradedSymbols.length > 0
        ? `${degradedSymbols.length} symbol${degradedSymbols.length === 1 ? '' : 's'} suppressed — intraday 15m/1h data unavailable (daily-fallback opposite-trend signals removed by design). Yahoo feed source check karo / thodi der me retry.`
        : null,
    },
    // v9 SUPERINTELLIGENCE PRO TRADER ENGINE meta — what got scanned,
    // through which price chain, and how many signals cleared the 80+
    // STRONG / 85+ ELITE bars.
    superIntelMeta: {
      ...superMeta,
      strongCount: signals.filter(s => (s.superIntel?.aiScore ?? 0) >= 80).length,
      eliteCount: signals.filter(s => (s.superIntel?.aiScore ?? 0) >= 85).length,
      scored: signals.filter(s => !!s.superIntel).length,
      // v21.3.0 (Issue-5): board-confirmation meta (null jab koi provider
      // configured nahi — sandbox / no-keys honest no-op).
      ...(aiConfirmMeta ? { aiConfirm: aiConfirmMeta } : {}),
    },
    topFive,
    // v11.0: the Global Market Council meta — enabled/model/stamped +
    // gate thresholds (suppressed counts flow to the near-miss panel).
    council: councilMeta,
    riskCap: riskCapFor(depsSafe),
    scanned: contexts.length,
    signals,
    models: modelStatus(council, depsSafe),
    generatedAt: Date.now(),
  };
  cacheSet(cacheKey, payload);
  return payload;
}

function gatesFor(deps) {
  try {
    const cfg = deps?.getTradingConfig?.();
    return { minConfidence: cfg?.minConfidence ?? 75, minAgreement: cfg?.minAgreement ?? 0.70 };
  } catch { return DEFAULT_GATES; }
}

/** v6.4: the user's configured max-stop% — board plans are BUILT inside
 *  the cap (riskClamped flag + originalRiskPct on the plan) so the cards
 *  honestly show a fitted plan instead of one the execute-gate would
 *  bounce. Paper execute additionally auto-fits server-side. */
function riskCapFor(deps) {
  try {
    const cfg = deps?.getTradingConfig?.();
    const cap = Number(cfg?.maxRiskPct);
    return Number.isFinite(cap) && cap > 0 ? cap : 5;
  } catch { return 5; }
}

function modelStatus(council, _deps) {
  return MODELS.map(m => ({
    id: m.id, name: m.name, role: m.role, weight: m.weight,
    online: m.id === 'aicouncil' ? !!council?.online : true,
    engine: m.id === 'aicouncil' ? (council?.model || 'offline') : 'quant',
  }));
}

// sync variant used in the crypto branch (buildCryptoCtx is promise-free
// apart from nothing — kept separate to avoid an await in a loop).
function buildCryptoCtxSync(base, tvRow, inrPrice, regime, candles) {
  // v20.7.12 [M-2]: `* 84` hardcode → usdInrFallback() (v20.2 ka shared
  // last-known-good store — disk-backed, Yahoo FX se hydrated). Flat-84
  // sirf tab jab ye process ne KABHI live rate nahi dekha + disk stamp bhi
  // nahi (first-ever boot, offline).
  const ltp = inrPrice ?? (tvRow?.usdPrice ? tvRow.usdPrice * usdInrFallback() : null);
  if (!(ltp > 0)) return null;
  let ind = null;
  if (tvRow) {
    const scale = tvRow.usdPrice ? ltp / tvRow.usdPrice : 1;
    ind = tvToInd({
      rsi: tvRow.rsi, macd: tvRow.macd != null ? tvRow.macd * scale : null, macdSignal: tvRow.macdSignal != null ? tvRow.macdSignal * scale : null,
      ema10: tvRow.ema10 != null ? tvRow.ema10 * scale : null,
      ema20: tvRow.ema20 != null ? tvRow.ema20 * scale : null,
      ema50: tvRow.ema50 != null ? tvRow.ema50 * scale : null,
      sma20: tvRow.sma20 != null ? tvRow.sma20 * scale : null,
      sma50: tvRow.sma50 != null ? tvRow.sma50 * scale : null,
      atr: tvRow.atr != null ? tvRow.atr * scale : null,
      adx: tvRow.adx, adxPlus: tvRow.adxPlus, adxMinus: tvRow.adxMinus,
      bbUpper: tvRow.bbUpper != null ? tvRow.bbUpper * scale : null,
      bbLower: tvRow.bbLower != null ? tvRow.bbLower * scale : null,
      stochK: tvRow.stochK, stochD: tvRow.stochD,
      relVolume: tvRow.relVolume, recommend: tvRow.recommend,
      vwap: null, pivot: null, high52w: null, low52w: null,
    }, ltp);
  }
  if (Array.isArray(candles) && candles.length >= 30) {
    const ci = computeIndicatorsFromCandles(candles);
    if (ci) ind = { ...(ind || {}), ...ci, relVolume: ind?.relVolume ?? (ci.avgVolume20 > 0 ? ci.volume / ci.avgVolume20 : null) };
  }
  if (!ind) return null;
  return {
    market: 'CRYPTO', symbol: base, ltp, changePct: tvRow?.changePct ?? 0,
    volume: tvRow?.volume ?? 0, pair: `${base}INR`,
    ind, candles: candles || null, options: null, regime,
    priceSource: inrPrice != null ? 'coindcx' : 'tv-usd-approx',
  };
}

// v6.8: futures context — the USDT twin of buildCryptoCtxSync. TV crypto
// indicators are already USD-denominated (USD ≈ USDT 1:1 on these majors)
// so NO scaling happens: entry/SL/targets land in the exact quote currency
// the futures contract trades. Candles come from the pcode=f endpoint.
function buildFuturesCtxSync(base, tvRow, futRow, candles, regime) {
  const ltp = futRow?.last ?? (tvRow?.usdPrice ?? null);
  if (!(ltp > 0)) return null;
  let ind = null;
  if (tvRow) {
    ind = tvToInd({
      rsi: tvRow.rsi, macd: tvRow.macd, macdSignal: tvRow.macdSignal,
      ema10: tvRow.ema10, ema20: tvRow.ema20, ema50: tvRow.ema50,
      sma20: tvRow.sma20, sma50: tvRow.sma50,
      atr: tvRow.atr, adx: tvRow.adx, adxPlus: tvRow.adxPlus, adxMinus: tvRow.adxMinus,
      bbUpper: tvRow.bbUpper, bbLower: tvRow.bbLower,
      stochK: tvRow.stochK, stochD: tvRow.stochD,
      relVolume: tvRow.relVolume, recommend: tvRow.recommend,
      vwap: null, pivot: null, high52w: null, low52w: null,
    }, ltp);
  }
  if (Array.isArray(candles) && candles.length >= 30) {
    const ci = computeIndicatorsFromCandles(candles);
    if (ci) ind = { ...(ind || {}), ...ci, relVolume: ind?.relVolume ?? (ci.avgVolume20 > 0 ? ci.volume / ci.avgVolume20 : null) };
  }
  if (!ind) return null;
  return {
    market: 'FUTURES', symbol: base, ltp, changePct: futRow?.changePct ?? tvRow?.changePct ?? 0,
    volume: futRow?.volume ?? 0, pair: futuresPairFor(base),
    ind, candles: candles || null, options: null, regime,
    priceSource: futRow?.last != null ? 'coindcx-futures-rt' : 'tv-usd-approx',
  };
}

// ---------------- deep single-symbol signal ----------------
export async function getDeepSignal(symbol, market, deps, opts = {}) {
  const raw = String(market || 'INDIA').toUpperCase();
  // v21.8.0: METALS deep = FUTURES branch (same B-XAU_USDT plumbing —
  // candles + fapi fallback; board cards bhi market 'FUTURES' carry
  // karte hain, so ye mapping naturally consistent hai).
  const mkt = raw === 'CRYPTO' ? 'CRYPTO' : raw === 'FUTURES' || raw === 'METALS' ? 'FUTURES' : raw === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : 'INDIA';
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!sym) return { ok: false, reason: 'symbol required' };
  // v20.7.5 FRESH-RUN SUPPORT: the user's "deep ensemble analysis galat
  // purana data dikha rahi hai" report had a real root cause — a 🔬 click
  // could serve the 30s-cached answer (prices/votes up to half a minute
  // old, computed BEFORE the board card the user is comparing against).
  // opts.fresh → the cache READ is skipped and a brand-new ensemble run
  // computes NOW (single-flight guarded so double-clicks don't double-
  // compute; the result still WRITES the cache for the 15s auto-recheck
  // that follows). The exec paths keep the cached contract (unchanged).
  const wantFresh = opts?.fresh === true;
  const cacheKey = `deep:${mkt}:${sym}${opts?.optionsCtx ? ':opt' : ''}`;
  if (!wantFresh) {
    const cached = cacheGet(cacheKey, 30_000);
    if (cached) return cached;
  }
  return _deepSingleFlight(cacheKey, () => _computeDeepSignal(sym, mkt, deps, opts, cacheKey));
}

/** v20.7.5: the deep-dive body, split out of getDeepSignal so the fresh
 * path can single-flight it independently of the cached read. */
async function _computeDeepSignal(sym, mkt, deps, opts, cacheKey) {

  const regime = await buildRegime(mkt === 'INDIA' ? 'INDIA' : mkt === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : 'CRYPTO');
  let ctx = null;
  if (mkt === 'FUTURES') {
    const [tv, futRows, candles0] = await Promise.all([
      fetchTVCryptoBatch([sym]).catch(() => ({})),
      fetchFuturesPrices().catch(() => []),
      fetchFuturesCandles(futuresPairFor(sym), '60').catch(() => null),
    ]);
    // v21.8.0 METALS DEEP: XAU/XAG par TV scanner khali aata hai (verified)
    // + CoinDCX candles dark hone par bina fallback ke deep 500 ho jata.
    // v21.9.0: candle chain ab fapi (FIXED) → Yahoo COMEX rescaled, aur
    // price anchor pehle resolve hota hai taaki rescale ltp-aware ho.
    const row = (Array.isArray(futRows) ? futRows : []).find(x => x.base === sym);
    // metals price fallback (CoinDCX RT down → fapi ticker → gold-api → Yahoo)
    const row2 = row?.last > 0 ? row : (isMetalsBase(sym) ? (await fetchMetalsPrices().catch(() => null) || []).find(x => x.base === sym) : null);
    let candles = candles0;
    if ((!Array.isArray(candles) || candles.length < 30) && isMetalsBase(sym)) {
      // v21.9.0: full chain (fapi FIXED → Yahoo COMEX rescaled onto ltp)
      candles = await fetchMetalsCandleChain(sym, '60', row2?.last || 0).catch(() => null);
    }
    ctx = buildFuturesCtxSync(sym, tv[sym], row2, candles, regime);
    // v12.7 (recheck R1-#2): attach the raw TV row on the FUTURES deep
    // ctx too — the 15m tape fetch below reads ctx.__tv for its
    // cross-domain fallback anchor (board parity: the board path always
    // passes c.ctx.__tv; the deep path used to send null).
    // v21.4.1 [A4]: ctx NULL ho sakta hai (buildFuturesCtxSync ltp/ind
    // unusable hone par null return karta hai) — India branch guard karta
    // tha, ye nahi karta tha → TypeError → /api/ai/deep 500.
    if (ctx && tv?.[sym]) ctx.__tv = tv[sym];
  } else if (mkt === 'GLOBALFUTURES') {
    // v10.4: the deep dive on a global name — quotes + candles from the
    // desk's own feed (Yahoo for the real names, synthetic for SPACEX).
    const gf = await import('./globalFutures.js');
    const [quotes, candles] = await Promise.all([
      gf.fetchGlobalQuotes().catch(() => null),
      gf.fetchGlobalCandles(sym).catch(() => null),
    ]);
    ctx = gf.buildGlobalCtxSync(sym, quotes?.get(sym) || null, candles, regime);
  } else if (mkt === 'CRYPTO') {
    const { fetchCoinDcxTickers } = await import('../cryptoStream.js');
    // v11.2: tv + INR price first, THEN the candle chain — the rescale
    // fallbacks need the INR anchor (t.last_price) to linear-scale the
    // USDT/USD-domain fallback klines. Old code fetched raw CoinDCX candles
    // with NO fallback: TV-blocked + public.coindcx-blocked (the 2026-09-17
    // Render incident) → every crypto deep dive answered "No data for X".
    const [tv, tickers] = await Promise.all([
      fetchTVCryptoBatch([sym]).catch(() => ({})),
      fetchCoinDcxTickers().catch(() => []),
    ]);
    const t = (Array.isArray(tickers) ? tickers : []).find(x => x?.market === `${sym}INR`);
    const inrLtp = t ? parseFloat(t.last_price) : null;
    const candles = await (async () => {
      const c = await fetchCoinDcxCandles(sym, '1h').catch(() => null);
      if (Array.isArray(c) && c.length >= 30) return c;
      if (!(inrLtp > 0)) return null;
      const usd = tv?.[sym]?.usdPrice;
      const fxLive = await fetchUsdInr().catch(() => null);
      const expected = usd > 0 ? inrLtp / usd : (fxLive > 50 && fxLive < 200 ? fxLive : null);
      const bk = await fetchBinanceKlines(sym, '1h').catch(() => null);
      if (Array.isArray(bk) && bk.length >= 30) {
        const r = rescaleCandlesToLtp(bk, inrLtp, expected);
        if (r) return r;
      }
      const y = await fetchYahooIntradayCandles(sym, 'CRYPTO').catch(() => null);
      return rescaleCandlesToLtp(y, inrLtp, expected);
    })();
    ctx = buildCryptoCtxSync(sym, tv[sym], inrLtp, regime, candles);
    // v12.7 (recheck R1-#2 — THE board-vs-gate asymmetry): the deep
    // CRYPTO branch never set ctx.__tv, so fetchCrypto15mTape got
    // tvRow=null → the Binance 15m fallback rescale lost its expected
    // scale anchor (INR/usdPrice) → sanity-bound rejection → the tape
    // seat ABSTAINED on the fresh exec re-run while the clicked board
    // card HAD the tape vote (board passes c.ctx.__tv). Degraded candle
    // conditions = board ≠ gate = vetoes the user reads as "direction
    // galat". The board card and the deep card now vote identically.
    // v21.4.1 [A4]: ctx null guard (bharosa India branch jaisa hi).
    if (ctx && tv?.[sym]) ctx.__tv = tv[sym];
  } else {
    const tv = await fetchTVIndiaBatch([sym]).catch(() => ({}));
    if (tv[sym]) {
      ctx = await buildIndiaStockCtx(tv[sym], regime);
      // v9.3: keep the raw scanner row on the ctx (session VWAP feeds
      // the IntradayTape read — same as the board's attachSuperCtx).
      if (ctx) ctx.__tv = tv[sym];
    } else {
      // Index fallback (NIFTY/BANKNIFTY/FINNIFTY/SENSEX or unknown symbol)
      // → v21.13.x recheck: the SAME 15m→1h chain as the board (pehle
      // yahan bhi SIRF daily candles bante the — board ≠ deep card).
      // opts.optionsCtx preference preserved (the options-desk flavor).
      ctx = await buildIndiaIndexCtx(sym, regime, opts?.optionsCtx ?? _indexOptionsSnapshot()?.[sym] ?? null).catch(() => null);
    }
    // accuracy-plan Phase 2.2: a deep dive on an F&O STOCK gets the same
    // per-stock option ctx the board attaches (cached snapshot; the deep
    // path itself never triggers a chain fetch — the board's warm owns
    // the budget). Absent → stays the honest structural abstain.
    if (ctx && !ctx.isIndex && !ctx.options) {
      const stkOpt = _stockOptionsSnapshot(ctx.symbol);
      if (stkOpt) ctx.options = stkOpt;
    }
  }
  if (!ctx) {
    const payload = { ok: false, reason: `No data for ${sym} on ${mkt}` };
    cacheSet(cacheKey, payload);
    return payload;
  }

  // v21.23.12 [v21.23.4 LADDER PARITY — DEEP PATH]: board path (1970-1982)
  // __tfDegraded (15m MISSING) ko suppress karta hai — deep path (jo
  // execution gauntlet ka signal source hai: getFresh*ForExec → getDeepSignal)
  // me ye handling KABHI nahi thi. Full-missing 15m = daily-view committee
  // = the documented "90% opposite" disease — ab deep bhi honest reject
  // karta hai (order-time par "No fresh ensemble signal" ka asli kaaran
  // surface hota hai, fabricated direction kabhi nahi).
  if (ctx.__tfDegraded) {
    const payload = {
      ok: false,
      reason: `INTRADAY-TF-UNAVAILABLE — ${sym}: ${ctx.__tfDegraded}`,
    };
    cacheSet(cacheKey, payload);
    return payload;
  }

  // v10.6 WICK GUARD (deep path): a bad print must not drive a deep
  // dive's plan either — suppressed tick → honest unavailable answer.
  if (mkt === 'CRYPTO' || mkt === 'FUTURES') {
    const wv = await validateTick({ market: mkt, base: sym, price: ctx.ltp }).catch(() => null);
    if (wv?.action === 'SUPPRESS') {
      const payload = {
        ok: false,
        reason: `Cross-venue price check flagged ${sym}'s last print (deviation ${wv.deviationPct}% vs ${wv.refSource}) — signal suppressed until the price reverts or proves itself.`,
      };
      cacheSet(cacheKey, payload);
      return payload;
    }
  }

  // v10.6 ORDER-FLOW DEPTH (deep path): the single-symbol dive always
  // gets the fresh L2 ladder (VolumeFlow reads it via ctx.depth).
  {
    const d = await readDepth(mkt, sym, { ltp: ctx.ltp }).catch(() => null);
    if (d?.ok) ctx.depth = d;
  }

  // v2 Phase 3: FundaCheck — the DEEP path is the swing desk's analysis
  // route, so fundamentals (P/E vs sector peers + earnings-growth proxy)
  // attach HERE only. The intraday board never attaches them (plan rule:
  // a 15m tape trade must never be swung by a P/E ratio).
  if (v2ModelsEnabled() && mkt === 'INDIA' && !ctx.isIndex) {
    await attachFundamentals(ctx).catch(() => {});
  }

  // v11.6 MESH SEATS (deep path): the single-symbol dive IS the T3
  // cadence — the mesh warms THIS symbol now (bounded 2.5s soft
  // deadline, the depth-warm pattern; a late result lands in the store
  // for the next deep dive). INDIA deep dives get the AlphaVantage/
  // Massive fundamental warm (the .BSE suffix is added inside);
  // crypto/global dives get their own cap sets.
  if (meshModelsEnabled()) {
    await Promise.race([
      warmMeshModels(mkt, [sym]).catch(() => {}),
      new Promise((res) => { const t = setTimeout(() => res(null), 2500); t.unref?.(); }),
    ]);
  }

  // v10.6: deep dive votes get the SAME regime tilt as the board (flag
  // OFF → static weights, byte-identical legacy deep path).
  // v21.0: core-seat correlation guard yahin bhi (deep path board se
  // same dedup rules follow kare).
  const votes = applyCoreCorrelationDiscounts(
    applyMeshModelGating(
      applyRegimeWeights(
        applyAdaptiveWeights(runQuantModels(ctx), adaptiveMultipliers(_ledgerModelStats())),
        regimeWeightsEnabled() ? classifyRegimeFor(regime, mkt) : null,
      ),
    ),
  );
  // ---------------- v6.12 pass-2 deep enrichment ----------------
  // LTF candles: 15m (India) / 1h (crypto) — SMC + MTF + structure
  // stop + edge stats. Tries the ctx candles first (crypto deep path
  // already fetched CoinDCX 1h), then the Yahoo intraday fallback.
  // v21.13.x DEEP-RECHECK FIX: post-v21.13 the INDIA ctx.candles is the
  // 1H COMMITTEE series (stocks AND indexes — buildIndiaStockCtx /
  // buildIndiaIndexCtx) — that must NEVER pass as the "15m" LTF here:
  // the tape vote, SMC/macross revival, quality verdict ka ltf
  // (ltfLabel '15m') sab 1h padh rahe the while the BOARD card's tape
  // seat reads the real 15m series → deep card ≠ board card (the exact
  // "board ne LONG bola, deep SHORT nikala" disease). INDIA deep dives
  // now ALWAYS read the real 15m series (2-min TTL cache — the board
  // already warmed it). Crypto/futures keep the ctx 1h candles (their
  // LTF convention).
  let ltfCandles = mkt !== 'INDIA' && Array.isArray(ctx.candles) && ctx.candles.length >= 60 ? ctx.candles : null;
  let ltfInd = null;
  // v10.5: the deep path's MTF agreement (caps STRONG on conflict)
  let _deepMtfAgreement = null;
  // v20.4: the crypto/futures 15m tape enrichment (deep path) — hoisted
  // so the quality verdict below can read the SAME 15m LTF the tape vote
  // read (previously the quality layer's LTF was the 1h series itself →
  // htf-vs-ltf could never disagree on these desks → the v9.3 counter-tape
  // STRONG-ban never fired off India).
  let _cxTapeEnr = null;
  if (!ltfCandles) {
    ltfCandles = await fetchYahooIntradayCandles(sym, mkt).catch(() => null) || null;
  }
  if (Array.isArray(ltfCandles) && ltfCandles.length >= 60) {
    ltfInd = computeIndicatorsFromCandles(ltfCandles);
    // v21.7.0 (Issue-2) MACROSS REVIVAL (deep) — 15m LTF candles carry the
    // SMA20/50 + EMA10/20 cross events; the seat's pass-1 state vote
    // (ya 1h/daily event read) gives way to the trading-TF cross read.
    try {
      const maReg = MODELS.find(m => m.id === 'macross');
      if (maReg?.fn) {
        const maV = maReg.fn({ market: mkt, ltp: ctx.ltp, ind: ltfInd || ctx.ind, candles: ltfCandles });
        if (maV && maV.dir !== 0 && (maV.conf || 0) > 0) {
          const mIdx = votes.findIndex(v => v.id === 'macross');
          if (mIdx >= 0) votes.splice(mIdx, 1);
          const _adM = adaptiveMultipliers(_ledgerModelStats());
          votes.push({ id: 'macross', name: maReg.name, role: maReg.role, weight: maReg.weight * (_adM?.macross?.mul ?? 1), ...maV, revived: true });
        }
      }
    } catch { /* honest degrade */ }
    // SMC revival on the LTF structure (replace the abstained vote)
    const smcV = smcVote(ltfCandles);
    if (smcV && smcV.dir !== 0 && (smcV.conf || 0) > 0) {
      const reg = MODELS.find(m => m.id === 'smc');
      const idx = votes.findIndex(v => v.id === 'smc');
      if (idx >= 0) votes.splice(idx, 1);
      // v6.12.1 (recheck M-3): adaptive multiplier on the injected vote
      const _ad = adaptiveMultipliers(_ledgerModelStats());
      votes.push({ id: 'smc', name: reg.name, role: reg.role, weight: reg.weight * (_ad?.smc?.mul ?? 1), ...smcV });
    }
    // v9.3 INTRADAY TAPE VOTE (deep) — the 15m tape gets its committee
    // seat on the single-symbol deep dive too (same model, same weight;
    // the deep card must never disagree with the board's tape read).
    // v10.5 MTF (Upgrade 1): flag ON → the 5m/15m/1h confluence seat
    // (IntradayTapeMTF, w 1.6) votes instead — deep card == board card.
    if (mkt === 'INDIA') {
      const tape = tapeFromCandles(ltfCandles, ltfInd, ctx.__tv || null);
      const _mtfOn = mtfConfluenceEnabled();
      let tapeMTF = null;
      if (_mtfOn) {
        const base5m = await fetchYahoo5mCandles(sym).catch(() => null);
        tapeMTF = base5m ? tapeMTFFromBase(base5m, ltfCandles, ctx.__tv || null) : null;
      }
      _deepMtfAgreement = tapeMTF && Number.isFinite(tapeMTF.agreement) ? tapeMTF.agreement : null;
      if (tape || tapeMTF) {
        const tapeReg = MODELS.find(m => _mtfOn ? m.id === 'tape-mtf' : m.id === 'tape');
        const tapeV = tapeReg?.fn
          ? tapeReg.fn(_mtfOn ? { market: mkt, tape, tapeMTF } : { market: mkt, tape })
          : null;
        if (tapeV && tapeV.dir !== 0 && (tapeV.conf || 0) > 0) {
          const seatId = _mtfOn ? 'tape-mtf' : 'tape';
          const tIdx = votes.findIndex(v => v.id === 'tape' || v.id === 'tape-mtf');
          if (tIdx >= 0) votes.splice(tIdx, 1);
          const _adT = adaptiveMultipliers(_ledgerModelStats());
          votes.push({ id: seatId, name: tapeReg.name, role: tapeReg.role, weight: tapeReg.weight * (_adT?.tape?.mul ?? 1), ...tapeV, revived: true });
        }
      }
    } else {
      // v12.6 CRYPTO/FUTURES TAPE VOTE (deep) — the same 15m entry-timing
      // seat the board now votes, so the deep card == the board card (a
      // deep dive disagreeing with the board's tape read was a silent
      // source of "board ne LONG bola, deep SHORT nikala"). One
      // TTL-cached 15m fetch; honest abstain when the legs are dark.
      // v20.4: kept on _cxTapeEnr for the quality verdict below.
      _cxTapeEnr = await fetchCrypto15mTape(sym, ctx.ltp, ctx.__tv || null, mkt).catch(() => null);
      const tEnr = _cxTapeEnr;
      if (tEnr?.tape) {
        const tapeReg = MODELS.find(m => m.id === 'tape' || m.id === 'tape-mtf');
        const tapeV = tapeReg?.fn ? tapeReg.fn({ market: mkt, tape: tEnr.tape }) : null;
        if (tapeV && tapeV.dir !== 0 && (tapeV.conf || 0) > 0) {
          const tIdx = votes.findIndex(v => v.id === 'tape' || v.id === 'tape-mtf');
          if (tIdx >= 0) votes.splice(tIdx, 1);
          const _adT = adaptiveMultipliers(_ledgerModelStats());
          votes.push({ id: tapeReg.id, name: tapeReg.name, role: tapeReg.role, weight: tapeReg.weight * (_adT?.tape?.mul ?? 1), ...tapeV, revived: true });
        }
      }
    }
  }
  // Pre-council consensus: the deep path feeds the council the same flat
  // candidate shape as the board path (side/confidence/ltp/ind/plan) so
  // the LLM actually sees the symbol, price and indicator state it is
  // being asked to verify — 'PENDING'/conf 0 starved the prompt.
  // v10.5: MTF agreement caps STRONG here too when the tape read conflicts.
  const preConsensus = aggregateVotes(_rediscountRevivedVotes(votes), gatesFor(deps), _deepMtfAgreement != null ? { mtfAgreement: _deepMtfAgreement } : {});
  // v20.6.1: deep path → aiCouncilVerify gets opts.deep=true → council
  // uses OLLAMA_DEEP_MODEL (deepseek-r1:14b) instead of OLLAMA_MODEL
  // (qwen3:8b). On 16GB with OLLAMA_MAX_LOADED_MODELS=1, Ollama auto-
  // swaps (cost ~30-60s). Scan path (board) never triggers this.
  const council = await aiCouncilVerify([{
    symbol: sym,
    side: preConsensus.side,
    confidence: preConsensus.confidence,
    ltp: ctx.ltp,
    changePct: ctx.changePct,
    ind: ctx.ind,
    plan: buildTradePlan(preConsensus, ctx, mkt, { maxRiskPct: riskCapFor(deps) }),
    votes,
  }], deps, mkt, { deep: true }).catch(() => ({ verdicts: {}, online: false }));
  const verdict = council?.verdicts?.[sym];
  if (verdict) {
    const av = aiCouncilVoteFromVerdict(verdict);
    if (av) {
      // v6.12.1 (recheck M-3): adaptive multiplier on the injected vote
      const _ad = adaptiveMultipliers(_ledgerModelStats());
      votes.push({
        id: 'aicouncil', name: 'AI Council (LLM)', role: MODELS.find(m => m.id === 'aicouncil').role,
        weight: MODELS.find(m => m.id === 'aicouncil').weight * (_ad?.aicouncil?.mul ?? 1), ...av,
      });
    } else {
      // v21.13.x recheck (C1): unparseable verdict → structural abstain
      const _ad = adaptiveMultipliers(_ledgerModelStats());
      votes.push({
        id: 'aicouncil', name: 'AI Council (LLM)', role: MODELS.find(m => m.id === 'aicouncil').role,
        weight: MODELS.find(m => m.id === 'aicouncil').weight * (_ad?.aicouncil?.mul ?? 1),
        dir: 0, conf: 0, na: true,
        reasons: ['AI Council verdict unparseable — structural abstain'],
      });
    }
  } else {
    // v21.13.x recheck (C1): offline council → honest structural abstain
    // (the seat never silently vanishes from the deep roster either)
    const _ad = adaptiveMultipliers(_ledgerModelStats());
    votes.push({
      id: 'aicouncil', name: 'AI Council (LLM)', role: MODELS.find(m => m.id === 'aicouncil').role,
      weight: MODELS.find(m => m.id === 'aicouncil').weight * (_ad?.aicouncil?.mul ?? 1),
      dir: 0, conf: 0, na: true,
      reasons: ['AI Council offline (no provider verdict) — structural abstain'],
    });
  }
  // v20.9.4 [H2 — meta-ensemble wiring]: deep FINAL aggregation bhi
  // meta-aware (board final jaisa hi — see the board site comment). Deep
  // pre-council consensus (upar) weighted hi rehta hai: council ko stable
  // input chahiye + per-symbol double meta cost.
  let consensus = await aggregateVotesWithMeta(votes, gatesFor(deps), {
    ...(_deepMtfAgreement != null ? { mtfAgreement: _deepMtfAgreement } : {}),
    regime,
  });
  // v21.23.12 [v21.23.4 LADDER PARITY — DEEP PATH]: THIN case (15m present,
  // 1h resample <30 bars) board pe dataDegraded='INTRADAY-TF-THIN' stamp
  // leta hai (executable:false + agent skip + UI chip) — deep path pe stamp
  // kabhi nahi lagta tha, isliye ek THIN hybrid STRONG gauntlet tak UNMARKED
  // pahunchta tha. Ab deep bhi wahi stamp deta hai; buildSignal (ensemble)
  // executable:false karta hai aur v21.23.12 ka gauntlet-side veto order
  // tak block karta hai. Signal reference-display ke liye emit hota hai.
  if (ctx.__tfDataThin && consensus) {
    consensus = {
      ...consensus,
      dataDegraded: 'INTRADAY-TF-THIN',
      degradedReason: '15m series present par 1h resample thin (<30 bars) — main ind daily-view hybrid. Auto-trade BLOCKED, reference only (v21.23.4 deep-path parity).',
    };
  }
  // ---------------- v6.12: quality verdict + EDGE stats ----------------
  let quality = null, edge = null, structureStopOpt = null;
  if (consensus.dir !== 0) {
    const qv = qualityVerdict({
      market: mkt, side: consensus.side, consensus, votes,
      ltp: ctx.ltp, changePct: ctx.changePct,
      rsi: ctx.ind?.rsi, adx: ctx.ind?.adx,
      // v20.4 COUNTER-TAPE WIRING (deep): CRYPTO/FUTURES LTF = the REAL
      // 15m tape indicators (the old 1h-vs-1h self-compare made the
      // MISALIGNED phase unreachable off India — the CoinDCX "STRONG
      // SHORT while the tape climbs" bug). India keeps its 15m Yahoo
      // LTF. The structure stop + 15m ATR now land on 15m swings.
      atr: (mkt !== 'INDIA' ? _cxTapeEnr?.ltfInd?.atr : ltfInd?.atr) ?? ctx.ind?.atr,
      candles: mkt !== 'INDIA' ? _cxTapeEnr?.candles : ltfCandles,
      // v21.13: INDIA htf = the DAILY TV view (same as the board site).
      regime, htf: (mkt === 'INDIA' ? (ctx.__dailyInd ?? ctx.ind) : ctx.ind),
      ltf: mkt !== 'INDIA' ? _cxTapeEnr?.ltfInd : ltfInd,
      ltfLabel: '15m', now: Date.now(),
    });
    quality = {
      ...qv.flags,
      confAdj: qv.confAdj,
      veto: qv.flags.veto || null,
      reasons: qv.reasons,
      mtf: { phase: qv.mtf.phase, aligned: qv.mtf.aligned, available: qv.mtf.available },
      session: { phase: qv.session.phase, tradeable: qv.session.tradeable },
      stopStyle: qv.stop && !qv.stop.rejected ? (qv.stop.style || 'swing-structure') : null,
    };
    if (qv.stop && !qv.stop.rejected && qv.stop.sl) structureStopOpt = qv.stop;
    const finalConf = Math.max(5, Math.min(99, consensus.confidence + qv.confAdj));
    const gates = gatesFor(deps);
    let finalGrade;
    if (finalConf >= gates.minConfidence && consensus.agreement >= gates.minAgreement) finalGrade = 'STRONG';
    else if (finalConf >= 55) finalGrade = 'ACTION';
    else if (finalConf >= 35) finalGrade = 'WATCH';
    else finalGrade = 'NEUTRAL';
    const capRank = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };
    if (capRank[qv.gradeCap] < capRank[finalGrade]) finalGrade = qv.gradeCap;
    consensus = {
      ...consensus,
      confidence: finalConf,
      grade: finalGrade,
      summary: `${consensus.summary}${qv.flags.veto ? ` · ${qv.flags.veto.toUpperCase()} VETO` : ''}`,
    };
    // v21.7.0 (Issue-3) STRICT AGREEMENT CAP (deep) — board path jaisa hi:
    // split committee (agreement < 0.62) ka ACTION bhi WATCH cap hota hai.
    consensus = applyStrictAgreementCap(consensus);
    // EDGE: walk-forward replay of THIS symbol through the same
    // ensemble + plan discipline (the v6.5 backtester). Honest sample
    // size + disclaimer — past ≠ future, ye context hai guarantee nahi.
    try {
      const simCandles = Array.isArray(ltfCandles) ? ltfCandles.slice(-400) : null;
      if (simCandles && simCandles.length >= 120) {
        const sim = simulateSymbol({
          symbol: sym, market: mkt, candles: simCandles,
          minGrade: 'ACTION', maxRiskPct: riskCapFor(deps),
          maxHoldBars: mkt === 'INDIA' ? 26 : 48,
        });
        if (sim?.stats && sim.stats.trades > 0) {
          edge = {
            ...sim.stats,
            timeframe: mkt === 'INDIA' ? '15m' : '1h',
            bars: simCandles.length,
            disclaimer: 'Walk-forward replay of the SAME ensemble on recent bars — past performance ≠ future results',
          };
        }
      }
    } catch { /* edge stats are optional context */ }
  }
  // v12.4 SIGNAL TRUST GUARDS (deep path) — THE LIVE ENTRY DISCIPLINE.
  // getFresh*SignalForExec feeds the execution gauntlets from THIS
  // consensus, so the guards here are what actually stop a live LONG
  // on an overbought perp or a freshly-flipped whipsaw at gate 5
  // (grade WATCH can never satisfy requireStrong). Same honesty as
  // the board path: FLAT views remembered, side/ltp untouched (the
  // plan below stays valid), never throws.
  {
    const guarded = applySignalTrustGuards({
      market: mkt, symbol: sym, consensus, ctx, ltf: ltfInd ?? ctx.__ltfInd ?? null,
    });
    if (guarded) consensus = guarded;
  }
  // v21.7.0 (Issue-1) F&O CARD PLAN FIX — options-desk flavor (opts.
  // optionsCtx set = NIFTY/SENSEX cards ke liye deep run) ka index plan
  // pehle DAILY ctx se banta tha: ltp = Yahoo daily close (ghanton
  // purana) + atr = DAILY ATR — jabki card ka Entry LIVE chain premium.
  // Result: Target/SL premium levels systematically galat (daily-move
  // geometry intraday option me). Ab LIVE desk spot (optionsDesk se
  // pass hota hai) + 15m ATR (intraday geometry) — entry/exit cards ke
  // index-levels ab real market se aligned.
  const _planCtx = (opts?.optionsCtx && mkt === 'INDIA') ? buildOptionsPlanCtx(ctx, opts, ltfInd) : ctx;
  const plan = buildTradePlan(consensus, _planCtx, mkt, {
    maxRiskPct: riskCapFor(deps),
    ...(structureStopOpt && consensus.dir !== 0 ? { structureStop: structureStopOpt } : {}),
  });
  const built = buildSignal({ symbol: sym, market: mkt, ctx, votes, consensus, plan, aiNote: verdict ? { verdict: verdict.verdict, note: verdict.note, analysis: verdict.analysis, model: council.model, ...(council.debate ? { debate: { bull: council.debate.bull?.[sym]?.case ?? null, bear: council.debate.bear?.[sym]?.case ?? null } } : {}) } : null, quality });
  // v10.5 MTF (Upgrade 1): the deep card carries the same 5m/15m/1h
  // wire payload the board badge renders (deep == board read).
  if (mkt === 'INDIA' && mtfConfluenceEnabled()) {
    try {
      const base5m2 = await fetchYahoo5mCandles(sym).catch(() => null);
      const tapeMTF2 = base5m2 ? tapeMTFFromBase(base5m2, ltfCandles, ctx.__tv || null) : null;
      const mtfWire = tapeMTF2 ? mtfWirePayload(tapeMTF2) : null;
      if (mtfWire) built.mtf = mtfWire;
    } catch { /* honest degrade — no badge */ }
  }
  // -----------------------------------------------------------------
  // v18.5 SUPER INTELLIGENCE MTF-6 (deep path) — the deep dive now gets
  // the FULL 6-TF read for BOTH markets (crypto deep used to compare
  // 1h-vs-1h — a degenerate self-comparison that almost always read
  // ALIGNED). The deep conf/grade get the same adjustment ladder as the
  // board path, and the deep modal's MTF strip carries per-TF detail.
  // -----------------------------------------------------------------
  // v21.4.1 [A5]: deep-path veto score cap (62) — computeSuperScore tak
  // thread hota hai, bilkul board ke _scoreCap jaisa.
  let _deepScoreCap = null;
  try {
    const mtf6 = await buildMTFSnapshot(sym, mkt, { side: consensus.side, ltp: ctx.ltp });
    if (mtf6?.ok) {
      let confAdj6 = 0;
      if (mtf6.alignedWithSide === true) confAdj6 = mtf6.agreement >= 0.72 ? 5 : 3;
      else if (mtf6.alignedWithSide === false) confAdj6 = mtf6.counterHtf ? -10 : -7;
      if (confAdj6 !== 0 && consensus.dir !== 0) {
        const conf6 = Math.max(5, Math.min(99, consensus.confidence + confAdj6));
        consensus = { ...consensus, confidence: conf6 };
        const demote = ((mtf6.alignedWithSide === false) || (mtf6.timing?.quality === 'POOR'))
          && consensus.grade === 'STRONG';
        if (demote) consensus = { ...consensus, grade: 'ACTION', summary: `${consensus.summary} · MTF-6` };
        // v18.5: built is already constructed — mirror the adjusted
        // confidence/grade onto the flat signal the UI reads.
        if (built && typeof built === 'object') {
          built.confidence = consensus.confidence;
          built.grade = consensus.grade;
          built.summary = consensus.summary;
        }
      }
      // -------------------------------------------------------------
      // v21.4.1 [deep-recheck A5] HARD HTF VETO + CHOP FILTER (deep path).
      // Board pe v21.3.0 se ye vetoes hain (counter-htf → WATCH + cap 62;
      // SPLIT/ADX<15 → WATCH + cap 62) par DEEP path pe sirf conf ladder
      // thi — aur deep hi LIVE exec gauntlet ka signal source hai
      // (getFreshSignalForExec → getDeepSignal). Ek board-vetoed signal
      // deep re-run pe STRONG 85 ban ke execute gauntlet pass kar sakta
      // tha — exactly the "SAB SL hit" class the veto closes. Board ==
      // deep == live ab ek hi rulebook pe chalte hain.
      // -------------------------------------------------------------
      if (consensus.dir !== 0) {
        const adxNowD = readAdxNum(ctx.ind?.adx);
        const counterHtfHitD = VETO_COUNTER_HTF && mtf6.counterHtf === true;
        const chopHitD = VETO_CHOP && (mtf6.phase === 'SPLIT' || (adxNowD != null && adxNowD < 15));
        if (counterHtfHitD || chopHitD) {
          const whyD = counterHtfHitD ? 'HTF VETO (1d/4h against)' : 'CHOP FILTER (range)';
          const rankOfD = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };
          if ((rankOfD[consensus.grade] ?? 0) > rankOfD.WATCH) {
            consensus = { ...consensus, grade: 'WATCH', summary: `${consensus.summary} · ${whyD}` };
          }
          if (quality) {
            quality = {
              ...quality,
              veto: counterHtfHitD ? 'counter-htf' : 'chop-range',
              ...(counterHtfHitD ? { counterHtfVeto: true } : {}),
              ...(chopHitD ? { chopRange: true } : {}),
            };
          }
          if (built && typeof built === 'object') {
            built.grade = consensus.grade;
            built.summary = consensus.summary;
            if (quality) built.quality = quality;
            built.executable = false; // v21.4.1: demote ke baad kabhi executable nahi
          }
          _deepScoreCap = 62; // superIntel cap — 80+ badge LIVE path pe bhi banned
        }
      }
      if (mtf6.structureStop?.sl && !structureStopOpt && consensus.dir !== 0) {
        structureStopOpt = mtf6.structureStop;
        const rebuiltPlan = buildTradePlan(consensus, ctx, mkt, {
          maxRiskPct: riskCapFor(deps), structureStop: structureStopOpt,
        });
        if (rebuiltPlan) {
          built.plan = rebuiltPlan;
        }
      }
      // v18.5: the deep modal's MtfBlock header reads quality.mtf — upgrade
      // it to the REAL 6-TF read so the header shows the engine consensus
      // + agreement instead of the legacy daily-vs-ltf label. (built is
      // already constructed at this point, so its quality is patched too.)
      if (quality) {
        quality = {
          ...quality,
          mtf: {
            phase: mtf6.phase, aligned: mtf6.alignedWithSide, available: true,
            consensus: mtf6.consensus, agreementPct: mtf6.agreementPct, engine: 'mtf6',
          },
        };
        if (built && typeof built === 'object') built.quality = quality;
      }
      const wire6 = mtfWire6Payload(mtf6);
      if (wire6) built.mtf = wire6;
    }
  } catch { /* MTF-6 never breaks the deep dive */ }
  // -----------------------------------------------------------------
  // v12.0 DEEP-PATH SUPERINTELLIGENCE — the deep dive used to carry NO
  // superIntel at all (no AI SCORE ring, no blueprint, no win-prob):
  // the deep modal's card and the crypto agent's analyze_coin answers
  // both read s.superIntel and got nulls. The deep card now gets the
  // FULL pro ticket — AI score + 7-factor breakdown + blueprint + the
  // calibrated WIN PROBABILITY + (perps) the positioning intel — the
  // same engines the board uses, same honest degrade.
  // -----------------------------------------------------------------
  if (consensus.dir !== 0) {
    try {
      const expertD = expertScoreFactors({
        // v21.13: SIDE-AWARE (deep path — same as the board).
        side: consensus.side,
        tv: ctx.__tv ? { ...ctx.__tv, ltp: ctx.ltp } : { ...ctx.ind, ltp: ctx.ltp },
        ltf: ltfInd ?? ctx.__ltfInd ?? null, regime, market: mkt, smc: ctx.__smc, structure: ctx.__structure,
      });
      // v21.0 SELF-ECHO REMOVED (deep-check D5, deep path): LLM offline
      // me aiConfD committee-confidence se synthesize HOTA tha — 3-source
      // blend apne aap se blend ho raha tha. Ab null rehta hai → honest
      // 2-source redistribute (55% engine + 45% expert).
      const aiConfD = verdict?.confidence ?? null;
      const supD = computeSuperScore({
        engineConf: consensus.confidence,
        expertScore: expertD?.score ?? null,
        aiConf: aiConfD,
        quality,
        agreement: consensus.agreement,
        counterTrend: !!(quality?.regime?.counterTrend),
        // v21.4.1 [A5]: deep-path hard-veto cap — board jaisa hi 62 bound
        // (deep hi LIVE exec ka signal source hai).
        cap: _deepScoreCap,
      });
      const atrD = ltfInd?.atr ?? ctx.ind?.atr ?? null;
      const blueprintD = buildSuperBlueprint({
        side: consensus.side, ltp: ctx.ltp, atr: atrD, aiScore: supD.aiScore, market: mkt,
        ema20: ctx.ind?.ema20 ?? ltfInd?.ema20 ?? null,
        stopLoss: plan?.stopLoss, target1: plan?.target1, target2: plan?.target2,
        atrPctLtp: (atrD != null && atrD > 0 && ctx.ltp > 0) ? (atrD / ctx.ltp) * 100 : null,
        now: Date.now(), sqOffBy: mkt === 'INDIA' ? '15:10 IST' : null,
        changePct: ctx.changePct,
      });
      built.superIntel = {
        aiScore: supD.aiScore, tier: supD.tier, drivers: supD.drivers,
        factors: expertD?.factors ?? null, blueprint: blueprintD,
        aiSource: verdict?.confidence != null ? 'council' : null,
      };
      // v12.0 win probability (+ perp positioning on the FUTURES desk)
      let intelD = null;
      if (mkt === 'FUTURES' && perpIntelEnabled()) {
        intelD = await Promise.race([
          getPerpIntel(sym).catch(() => null),
          new Promise((res) => { const t = setTimeout(() => res(null), 2500); t.unref?.(); }),
        ]);
      }
      const calD = await calibrationSnapshot().catch(() => null);
      built.superIntel.winProb = computeWinProb({
        side: consensus.side, market: mkt,
        aiScore: supD.aiScore, engineConf: consensus.confidence,
        rewardRisk: plan?.rewardRisk ?? null,
        agreement: consensus.agreement,
        mtfAligned: built.mtf?.agreement != null ? built.mtf.agreement >= 0.67 : null,
        counterRegime: !!(quality?.regime?.counterTrend),
        fundingBps8h: intelD?.fundingBps8h ?? null,
        positioningScore: intelD?.read?.score ?? null,
        calibration: calD,
      });
      if (mkt === 'FUTURES' && intelD?.ok) {
        const wireD = perpIntelWire(intelD);
        if (wireD) built.superIntel.perp = wireD;
      }
    } catch { /* superintel on the deep card is best-effort */ }
    // v13.1 SVA-v1 on the DEEP path — the full checklist verdict
    // (deep modal + crypto agent's verify_signal tool read this).
    // v13.2: moved OUT of the superintel try — a superintel failure must
    // never cost the user the FINAL verdict (verify is pure + cheap).
    try { built.verify = verifySignal(built); } catch { /* best-effort */ }
    // v20.9.2 UCV-A1 on the DEEP path — the FULL ultrafast chart
    // verification (complete 9-check micro-structure checklist + the
    // "pakka long/short jayega?" answer). The deep dive is the user's
    // explicit "advance pro trader level pe check karo" moment — the
    // realtime 1m/5m chart + live tick are read FRESH here.
    // v20.9.3 FIX (H2): apply the SAME gate patch as the board. The old
    // code only attached the payload — the deep card kept aiScore 85 /
    // grade STRONG beside a REJECTED badge, deepPinVerdict then read the
    // score drift (64→85) as DRIFTED, and CoinDcxTab routed the TRADE
    // button to this ungated deep signal → a LIVE order on the direction
    // the realtime chart just rejected. Board and deep must tell ONE
    // truth.
    try {
      const uvD = await verifySignalUltrafast(built, { deadlineMs: 2000 });
      if (uvD) {
        built.ultrafast = uvD; // FULL payload (checks ride along)
        const patchD = ultrafastGatePatch(uvD, built);
        if (patchD) {
          built.superIntel = patchD.superIntel;
          if (patchD.grade) built.grade = patchD.grade;
          built.ucRejected = true; // exec-side lock reads this
          // v20.9.4 FIX (M — board/deep parity): winProb abhi bhi PRE-CAP
          // aiScore (85) se computed tha — deep card "aiScore 64 · P(win)
          // EDGE" dikhata tha (board ka v20.9.3 recompute-fix sirf board
          // loop tak pahuncha tha). Deep path (CoinDcxTab dive modal +
          // signalRecheck deep re-vote + cryptoAgent verify_signal — the
          // user's "advance pro trader" surface) ab capped score se
          // recompute karta hai. calD inner try me tha — fresh snapshot.
          try {
            const calD2 = await calibrationSnapshot().catch(() => null);
            built.superIntel.winProb = computeWinProb({
              side: built.side, market: mkt,
              aiScore: built.superIntel.aiScore,
              engineConf: built.confidence,
              rewardRisk: built.plan?.rewardRisk ?? null,
              agreement: built.agreement,
              mtfAligned: built.mtf?.agreement != null ? built.mtf.agreement >= 0.67 : null,
              counterRegime: !!(built.quality?.regime?.counterTrend),
              fundingBps8h: built.superIntel.perp?.fundingBps8h ?? null,
              positioningScore: built.superIntel.perp?.read?.score ?? null,
              calibration: calD2,
            });
          } catch { built.superIntel.winProb = null; }
          // SVA re-stamp post-cap — VerifyBadge bhi capped numbers padhe
          // (pure fn, cheap). Board path bhi yahi karta hai neeche wale
          // block me [v20.9.4].
          try { built.verify = verifySignal(built); } catch { /* keep pre-patch verify */ }
        }
      }
    } catch { /* ultrafast never breaks the deep path */ }
    // v13.2 A2: the LLM SECOND OPINION — only when the ensemble itself is
    // unsure (borderline 45-60% confidence). One live chain ask per symbol
    // per 15m candle; the board inherits it via the passive cache read.
    try {
      if (llmValidatorEnabled() && inBorderlineBand(built.confidence)) {
        const llmV = await llmValidateSignal(built, deps || {});
        if (llmV) built.verify = { ...(built.verify || {}), llm: llmV };
      }
    } catch { /* the second opinion never breaks the first one */ }
  }
  // v6.11 (glama explain_ticker): rule-based regime narrative — the
  // indicator stack translated into a Hinglish story for the deep modal.
  const narrative = explainTicker(built, ctx.ind);
  // v11.0: DEEP council verdict (user-initiated deep-dive: 6 personas +
  // bull/bear debate + judge, ~9 LLM calls, 90s-cached). Attached to the
  // deep modal's signal — same stamp shape as the board.
  if (councilEnabled()) {
    try {
      const deepCouncil = await runCouncilDeep({
        // v11.4 recheck: this used to pass the board-scoped safe-deps ALIAS
        // (defined inside _computeBoard) — the ReferenceError was swallowed
        // by this catch, silently killing the deep-council verdict on every
        // deep dive since v11.0. The function's OWN deps param is correct.
        market: mkt, symbol: sym, sig: { ...built, ind: ctx.ind, __ltfInd: ltfInd || null },
        regime, deps: deps || {},
      });
      if (deepCouncil) built.council = councilStampOf(deepCouncil);
    } catch { /* deep council optional — modal unaffected */ }
  }
  const payload = {
    ok: true,
    signal: built,
    indicators: ctx.ind,
    narrative,
    // v20.7.5: freshness stamps — the deep modal shows exactly how old
    // this ensemble run is (fresh=1 runs compute NOW; cached answers
    // carry the compute time). The "inaccurate info" complaint is often
    // a 30s-old answer read against a live price — the stamp makes the
    // age visible instead of felt.
    recheckedAt: Date.now(),
    ltf: ltfInd ? {
      label: mkt === 'INDIA' ? '15m' : '1h',
      rsi: ltfInd.rsi ?? null, macdHist: ltfInd.macd?.hist ?? null,
      ema20: ltfInd.ema20 ?? null, ema50: ltfInd.ema50 ?? null,
      atr: ltfInd.atr ?? null,
    } : null,
    edge,
    priceSource: ctx.priceSource || null,
  };
  cacheSet(cacheKey, payload);
  return payload;
}


/**
 * The execute-gauntlet's fresh signal source — a single-symbol ensemble
 * run with a STRICT 90s freshness (no board cache reuse).
 *
 * v11.5 BOARD FALLBACK (paper/notify only): getDeepSignal() answers
 * {ok:false} (30s-cached) whenever an upstream leg is down — CoinDCX
 * futures API unreachable, TradingView blocked, the whole chain that
 * fed the 2026-09-17-style incident. The board refreshes every 60s and
 * may still hold a recent valid signal for the SAME symbol, so the
 * practice desks (paper/notify — signal is used for plan generation,
 * not live order safety) get that instead of a dead "No fresh ensemble
 * signal available" rejection. LIVE keeps the strict fresh-deep-run
 * contract: a live order NEVER executes off a board-cached signal.
 * Staleness cap 10 minutes — matching the paper gate's own 600s
 * freshness window, and the row carries its own generatedAt so the
 * execution path knows exactly how old it is.
 */
export async function getFreshSignalForExec(pairOrSymbol, deps, opts = {}) {
  // Accept "BTCINR" or "BTC".
  const sym = String(pairOrSymbol || '').toUpperCase().replace(/INR$/, '').replace(/USDT$/, '');
  const deep = await getDeepSignal(sym, 'CRYPTO', deps);
  if (deep?.ok && deep.signal) return deep.signal;
  return _boardFallbackForExec('CRYPTO', sym, opts);
}

/** v6.8: the FUTURES gauntlet's fresh signal source ("B-BTC_USDT" | "BTC"). */
export async function getFreshFuturesSignalForExec(pairOrSymbol, deps, opts = {}) {
  const sym = String(pairOrSymbol || '').toUpperCase()
    .replace(/^B-/, '').replace(/_USDT$/, '').replace(/USDT$/, '');
  const deep = await getDeepSignal(sym, 'FUTURES', deps);
  if (deep?.ok && deep.signal) return deep.signal;
  return _boardFallbackForExec('FUTURES', sym, opts);
}

/** v10.4: the GLOBAL FUTURES gauntlet's fresh signal source ("NVDA-USD" | "NVDA"). */
export async function getFreshGlobalSignalForExec(pairOrSymbol, deps, opts = {}) {
  const sym = String(pairOrSymbol || '').toUpperCase().replace(/-USD$/, '');
  const deep = await getDeepSignal(sym, 'GLOBALFUTURES', deps);
  if (deep?.ok && deep.signal) return deep.signal;
  return _boardFallbackForExec('GLOBALFUTURES', sym, opts);
}

// ---------------- v11.5: board fallback internals ----------------
/** 10-minute staleness cap for exec board fallbacks (== paper gate's 600s window). */
export const EXEC_BOARD_FALLBACK_MAX_AGE_MS = 600_000;

/** Normalise any pair/symbol spelling ("B-BTC_USDT", "BTCINR", "NVDA-USD") to the board's base key. */
function _execFallbackKey(s) {
  return String(s || '').toUpperCase()
    .replace(/^B-/, '')
    .replace(/_USDT$/, '')
    .replace(/-USD$/, '')
    .replace(/INR$/, '')
    .replace(/USDT$/, '');
}

/**
 * Look up a symbol in the 60s-refreshed board cache. Paper/notify only —
 * opts.mode 'live' (or anything unrecognized, fail-safe) gets NO fallback.
 * @returns the board signal row (with __execSource + __signalAgeMs honesty
 * markers) or null when the board has nothing fresh enough.
 */
function _boardFallbackForExec(mkt, sym, opts = {}) {
  // FAIL-SAFE default: no explicit paper/notify mode → no fallback. A live
  // order must only ever run on a fresh deep-path ensemble run.
  const mode = String(opts?.mode || '').toLowerCase();
  if (mode !== 'paper' && mode !== 'notify') return null;
  const hit = _cache.get(`board:${mkt}`);
  if (!hit || !hit.payload || hit.payload.ok === false) return null;
  const sigs = Array.isArray(hit.payload.signals) ? hit.payload.signals : null;
  if (!sigs) return null;
  const want = _execFallbackKey(sym);
  if (!want) return null;
  const row = sigs.find(s => _execFallbackKey(s?.symbol) === want);
  if (!row) return null;
  const age = Date.now() - (Number(row.generatedAt) || Number(hit.payload.generatedAt) || hit.at || 0);
  if (!(age >= 0) || age > EXEC_BOARD_FALLBACK_MAX_AGE_MS) return null;
  // Provenance is stamped on the returned copy — the journal and the UI can
  // always see this plan came from the board cache, and exactly how stale.
  return { ...row, __execSource: 'board', __signalAgeMs: age };
}

// ---------------- test hooks ----------------
export function __clearSignalCaches() {
  _cache.clear();
  _boardInflight.clear();
  // v20.7.5: in-flight fresh deep runs are part of the slate too — a
  // prior test's single-flight promise must never leak into the next
  // case's cacheKey.
  _deepInflight.clear();
  // v12.4: board tests expect a CLEAN slate between cases — the signal
  // continuity memory (age/flip history) is part of that slate now
  // (a prior test's consensus for the same symbol would otherwise
  // trip the flip-cooldown guard on the next one).
  try { __resetSignalMemoryForTests(); } catch { /* memory-only mode */ }
  // v18.5: the MTF-6 snapshot cache is part of the same slate — a prior
  // case's 6-TF read for the same symbol must not leak into the next
  // scenario (stale consensus would override fresh legacy payloads).
  try { __clearMtfCaches(); } catch { /* mtf not loaded */ }
}
/** v9.2.1: inject a board cache entry of a given age (ms) — resilience tests. */
export function __setBoardCacheForTests(mkt, payload, ageMs = 0) {
  _cache.set(`board:${mkt}`, { at: Date.now() - Math.max(0, Number(ageMs) || 0), payload });
}
/** accuracy-plan Phase 2.2 test hook: inject/inspect the per-stock
 *  option-ctx store (symbols → optionsCtx) + read the top-N knob. */
export function __stockOptionsForTests() {
  return {
    store: _stockOptions,
    snapshot: _stockOptionsSnapshot,
    topN: _STOCK_OPTIONS_TOP_N,
    setCtx: (sym, ctx) => { _stockOptions.ctx.set(sym, ctx); _stockOptions.at = Date.now(); },
    clear: () => { _stockOptions.ctx.clear(); _stockOptions.at = 0; _stockOptions.inflight = null; },
  };
}

