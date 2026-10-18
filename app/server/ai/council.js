// ============================================================
// server/ai/council.js — v11.0 PHASE 2 · GLOBAL MARKET COUNCIL
// ------------------------------------------------------------
// Layer 3 of the superintelligence pipeline: SIX specialist LLM
// personas debate one symbol set and return structured verdicts:
//
//   TECHNICAL ANALYST   price action, SMC, multi-timeframe
//   MACRO ECONOMIST     global macro, rates, correlations, FII flows
//   SENTIMENT ANALYST   news + social + Fear/Greed synthesis
//   OPTIONS FLOW DESK   dealer positioning, OI build-up, gamma walls
//   ON-CHAIN ANALYST    crypto funding, exchange reserves, flows
//   RISK GUARDIAN       veto power — exposure/events/drawdown
//
// Two modes:
//   runCouncilBoard()  6 BATCH persona calls over the top-N board
//                      candidates (one prompt per persona — the
//                      aiCouncilVerify batching pattern), verdicts
//                      cached 90s per symbol
//   runCouncilDeep()   single symbol + bull/bear debate + judge
//                      synthesis (~9 LLM calls — the plan's cost math)
//
// Degradation ladder (superIntelFallback pattern):
//   LLM chain down → DETERMINISTIC verdicts from the quant feature
//   matrix (tagged model:'deterministic', honestly never 'gemini').
//
// The council is an ANALYSIS layer only — execution authority stays
// with the v10.18 gauntlets (safety-critical design decision).
// ============================================================
import { meshQuery, crossValidatePrices } from '../mcp/mesh.js';
import { councilAsk, aiKeysPresent } from './llmChain.js';
// v18.8: keyless local engine awareness — imported from llmSentinel
// (NOT llmChain) so existing llmChain mocks in tests stay untouched.
import { ollamaProbe } from './llmSentinel.js';
import {
  COUNCIL_ROLES, ROLE_IDS, evaluateCouncil, councilWeights, gateThresholds,
} from './consensus.js';
export { gateThresholds };
import { councilCalibration } from './trust.js';
import { sentimentContextFor } from './sentiment.js';
import { eventGuardCheck } from './eventGuard.js';
import { globalRiskView } from './globalRisk.js';
import { loadJSON } from '../lib/store.js';

// ---------------- flag ----------------
export function councilEnabled() {
  const v = String(process.env.AI_ENABLE_GLOBAL_COUNCIL || '').trim().toLowerCase();
  return ['1', 'on', 'true', 'yes', 'enable', 'enabled'].includes(v);
}
function councilDebateRounds() {
  return Math.max(0, Math.min(2, Number(process.env.AI_COUNCIL_DEBATE_ROUNDS) || 1));
}

// ---------------- role availability per market ----------------
/** On-chain abstains on India equities; options-flow abstains where
 *  no options data feeds the features. Abstain ≠ NEUTRAL: the seat
 *  is structurally absent (quorum counts only returned verdicts). */
export function availableRoles(market) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  return ROLE_IDS.filter(r => {
    if (r === 'onchain') return mkt !== 'INDIA';
    if (r === 'optionsflow') return mkt === 'INDIA' || mkt === 'FUTURES';
    return true;
  });
}

// ---------------- verdict cache (90s, LRU 200) ----------------
const VERDICT_TTL = 90_000;
const VERDICT_MAX = 200;
const _verdicts = new Map(); // `mkt:SYM` → { at, result }
const _deepInflight = new Map(); // `mkt:SYM` → running deep promise (single-flight)

function cacheKey(market, symbol) {
  return `${String(market || '').toUpperCase()}:${String(symbol || '').toUpperCase()}`;
}
function verdictCacheGet(market, symbol) {
  const hit = _verdicts.get(cacheKey(market, symbol));
  if (!hit) return null;
  if (Date.now() - hit.at > VERDICT_TTL) return null;
  return hit.result;
}
function verdictCacheSet(market, symbol, result) {
  _verdicts.set(cacheKey(market, symbol), { at: Date.now(), result });
  if (_verdicts.size > VERDICT_MAX) {
    const oldest = _verdicts.keys().next().value;
    _verdicts.delete(oldest);
  }
}

// ---------------- feature matrix (Layer 2, deterministic) ----------------
/**
 * Build ONE symbol's feature matrix from the ensemble signal ctx +
 * mesh data + repo's own sentiment/regime/risk context. PURE.
 * Only finite values in — every missing field is null (never guessed).
 */
export function buildFeatureMatrix({ market, symbol, sig, regime, mesh, sentCtx, eventCtx, riskCtx }) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const votes = Array.isArray(sig?.votes) ? sig.votes : [];
  const voteLine = votes.filter(v => v && v.dir !== 0)
    .map(v => `${v.name}:${v.dir > 0 ? '+' : '-'}${Math.round(v.conf || 0)}`).join(', ');
  const consensus = {
    side: sig?.side || null,
    grade: sig?.grade || null,
    confidence: sig?.confidence ?? null,
    agreement: sig?.agreement ?? null,
    voters: sig?.voters ?? sig?.participating ?? null,
  };
  return {
    symbol: String(symbol || '').toUpperCase(),
    market: mkt,
    ltp: sig?.ltp ?? null,
    changePct: sig?.changePct ?? null,
    ta: {
      rsi: sig?.ind?.rsi ?? null,
      adx: sig?.ind?.adx?.adx ?? sig?.ind?.adx ?? null,
      atrPct: (sig?.ind?.atr && sig?.ltp) ? Math.round((sig.ind.atr / sig.ltp) * 10000) / 100 : null,
      relVolume: sig?.ind?.relVolume ?? null,
      vwapDistPct: (sig?.ind?.vwap && sig?.ltp) ? Math.round(((sig.ltp - sig.ind.vwap) / sig.ind.vwap) * 10000) / 100 : null,
      ema20: sig?.ind?.ema20 ?? null,
      ema50: sig?.ind?.ema50 ?? null,
    },
    mtf: sig?.mtf ? { agreement: sig.mtf.agreement ?? null, dirs: sig.mtf.dirs ?? null } : null,
    ensemble: { consensus, voteLine, superIntel: sig?.superIntel ? { aiScore: sig.superIntel.aiScore, tier: sig.superIntel.tier } : null },
    plan: sig?.plan ? {
      entry: sig.plan.entry ?? null, stopLoss: sig.plan.stopLoss ?? null,
      target1: sig.plan.target1 ?? null, target2: sig.plan.target2 ?? null,
      rewardRisk: sig.plan.rewardRisk ?? null,
    } : null,
    macro: {
      regimeLabel: regime?.label ?? null,
      regimeChangePct: mkt === 'INDIA' ? regime?.niftyChange ?? null
        : mkt === 'GLOBALFUTURES' ? regime?.ndxChange ?? null
        : regime?.btcChange ?? null,
      vix: regime?.vix ?? null,
    },
    sentiment: sentCtx ? { context: sentCtx } : null,
    // The mesh bundle per symbol (councilMeshBundle) is FLAT:
    //   { fundingRate, price } (crypto) · { price } (global futures)
    // — mapped into the onchain view here; nested { onchain } shapes
    // stay honoured for forward-compat. Every absent field is null.
    onchain: (mesh && (mesh.fundingRate != null || mesh.onchain != null)) ? {
      fundingRate: mesh.fundingRate ?? mesh.onchain?.fundingRate ?? null,
      exchange: mesh.exchange ?? mesh.onchain?.exchange ?? null,
      changePct24h: mesh.changePct24h ?? mesh.onchain?.changePct24h ?? null,
      mcapRank: mesh.mcapRank ?? mesh.onchain?.mcapRank ?? null,
    } : null,
    options: mesh?.options || null,       // { oiLean, pcr, maxPain } when available
    meshPrice: mesh?.price || null,       // cross-source validation anchor
    risk: {
      event: eventCtx ? {
        kind: eventCtx.event?.kind || null,
        inMin: eventCtx.event?.minutesUntil ?? null,
        action: eventCtx.action || null,
      } : null,
      heatPct: riskCtx?.heatPct ?? null,
      riskOff: riskCtx?.riskOff ?? false,
    },
  };
}

/** Cross-source sanity: mesh price vs the desk's own ltp (1.5% band). */
export function priceDivergence(features) {
  if (!features?.meshPrice?.price || !features?.ltp) return null;
  const d = crossValidatePrices({
    [features.symbol]: [
      { agent: 'desk', price: Number(features.ltp) },
      { agent: features.meshPrice.agent || 'mesh', price: Number(features.meshPrice.price) },
    ],
  });
  return d.length > 0 ? d[0] : null;
}

// ---------------- personas ----------------
const SCHEMA_HINT = 'Respond STRICT JSON only: {"verdicts":{"SYMBOL":{"direction":"LONG"|"SHORT"|"NEUTRAL","confidence":0-100,"reasons":["max 3 short reasons"],"levels":{"entry":number|null,"stop":number|null,"t1":number|null}}}}';
const NO_GUESS = 'Anti-hallucination rule: use ONLY the numbers given. Missing data = say so via a LOW confidence, never invent prices, levels or events.';

function personaPrompt(role, market, featuresList) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const venue = mkt === 'INDIA' ? 'NSE India (options-led desk)'
    : mkt === 'FUTURES' ? 'CoinDCX GLOBAL FUTURES (USDT perpetuals, leveraged)'
    : mkt === 'GLOBALFUTURES' ? 'global equity perpetual futures SIM desk (USDC-margined)'
    : 'CoinDCX crypto spot (INR pairs, 24/7)';
  const data = JSON.stringify(featuresList, null, 1);
  switch (role) {
    case 'technical':
      return `You are the TECHNICAL ANALYST seat of a superintelligence trading council for a ${venue}.
Your lens: price action, momentum, multi-timeframe alignment, volume, SMC structure. Read the ensemble's own indicator votes as INPUT, then give YOUR independent read of the chart state.\n${NO_GUESS}\n\nCANDIDATES (feature matrices):\n${data}\n\n${SCHEMA_HINT}`;
    case 'macro':
      return `You are the MACRO ECONOMIST seat of a superintelligence trading council for a ${venue}.
Your lens: index/regime direction (NIFTY/NASDAQ/BTC as the desk's barometer), volatility regime, cross-asset correlation, rate-cycle context. A counter-regime trade needs a STRONG reason or a NEUTRAL vote.\n${NO_GUESS}\n\nCANDIDATES:\n${data}\n\n${SCHEMA_HINT}`;
    case 'sentiment':
      return `You are the SENTIMENT ANALYST seat of a superintelligence trading council for a ${venue}.
Your lens: news mood, crowding, Fear/Greed extremes. Sentiment is a CONTRARIAN at extremes and a CONFIRMER in mid-range. If the sentiment context is missing, vote NEUTRAL with low confidence — never guess the mood.\n${NO_GUESS}\n\nCANDIDATES:\n${data}\n\n${SCHEMA_HINT}`;
    case 'optionsflow':
      return `You are the OPTIONS FLOW DESK seat of a superintelligence trading council for a ${venue}.
Your lens: dealer positioning, OI build-up, put-call positioning, funding/basis crowding. Positive funding with crowded longs = fragility; defensive put writing = supportive.\n${NO_GUESS}\n\nCANDIDATES:\n${data}\n\n${SCHEMA_HINT}`;
    case 'onchain':
      return `You are the ON-CHAIN ANALYST seat of a superintelligence trading council for a ${venue}.
Your lens: funding rates, spot-vs-perp flows, exchange reserve trends, 24h momentum vs market-cap rank. High positive funding = crowded longs (bearish tilt); deeply negative = capitulation (contrarian bullish).\n${NO_GUESS}\n\nCANDIDATES:\n${data}\n\n${SCHEMA_HINT}`;
    case 'risk':
      return `You are the RISK GUARDIAN seat of a superintelligence trading council for a ${venue}. You hold VETO power.
Your lens: scheduled events (blackout windows), global risk heat, drawdown/exposure state, plan riskiness (stop distance, R:R floor). You are NOT a direction caller — vote NEUTRAL with high confidence when risk is normal, and set "veto" ONLY for: event blackout ("event_blackout"), risk-off regime ("heat_cap"|"risk_off"), or an unusable plan ("bad_plan").\n${NO_GUESS}\n\nCANDIDATES:\n${data}\n\nRespond STRICT JSON only: {"verdicts":{"SYMBOL":{"direction":"NEUTRAL","confidence":0-100,"reasons":["max 2"],"veto":"event_blackout"|"heat_cap"|"risk_off"|"bad_plan"|null}}}`;
    default:
      throw new Error(`unknown persona ${role}`);
  }
}

// ---------------- verdict parsing + validation ----------------
const VETO_SET = new Set(['event_blackout', 'heat_cap', 'risk_off', 'bad_plan']);
const dirOf = (d) => {
  const s = String(d || '').toUpperCase();
  return ['LONG', 'BUY'].includes(s) ? 'LONG' : ['SHORT', 'SELL'].includes(s) ? 'SHORT' : 'NEUTRAL';
};
const fin = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function parseVerdict(role, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const direction = dirOf(raw.direction);
  const confidence = Math.max(0, Math.min(100, Math.round(Number(raw.confidence) || 0)));
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.map(r => String(r || '').slice(0, 120)).filter(Boolean).slice(0, 3)
    : [];
  const levels = raw.levels && typeof raw.levels === 'object' ? {
    entry: fin(raw.levels.entry), stop: fin(raw.levels.stop ?? raw.levels.stopLoss), t1: fin(raw.levels.t1 ?? raw.levels.target1),
  } : null;
  const veto = role === 'risk' && VETO_SET.has(String(raw.veto)) ? String(raw.veto) : null;
  return { agent: role, direction, confidence, reasons, levels, veto };
}

// ---------------- deterministic fallback (quant-only) ----------------
/**
 * LLM-chain-down verdicts derived PURELY from the feature matrix.
 * Tagged model:'deterministic' — the UI honesty badge says MODEL,
 * never a provider name. Confidence floors at honest numbers.
 */
export function deterministicVerdicts(market, features) {
  const out = {};
  const roles = availableRoles(market);
  const ta = features?.ta || {};
  const ens = features?.ensemble?.consensus || {};
  const macro = features?.macro || {};

  if (roles.includes('technical')) {
    const rsi = Number(ta.rsi);
    const adx = Number(ta.adx);
    const bull = (ens.side === 'LONG') || (Number.isFinite(rsi) && rsi > 55 && rsi < 75);
    const bear = (ens.side === 'SHORT') || (Number.isFinite(rsi) && rsi < 45 && rsi > 25);
    const dir = bull && !bear ? 'LONG' : bear && !bull ? 'SHORT' : 'NEUTRAL';
    let conf = 45;
    if (Number.isFinite(adx)) conf += Math.min(20, (adx - 15) * 0.8);
    if (Number.isFinite(Number(ens.confidence))) conf = Math.max(conf, Math.min(85, Number(ens.confidence) * 0.9));
    out.technical = { agent: 'technical', direction: dir, confidence: Math.round(Math.max(20, Math.min(80, conf))), reasons: ['quant fallback: ensemble consensus + RSI/ADX state'], levels: null, veto: null };
  }
  if (roles.includes('macro')) {
    const chg = Number(macro.regimeChangePct);
    const dir = Number.isFinite(chg) ? (chg > 0.1 ? 'LONG' : chg < -0.1 ? 'SHORT' : 'NEUTRAL') : 'NEUTRAL';
    const conf = Number.isFinite(chg) ? Math.round(Math.min(75, 40 + Math.abs(chg) * 12)) : 25;
    out.macro = { agent: 'macro', direction: dir, confidence: conf, reasons: [`quant fallback: regime ${macro.regimeLabel || ''} ${Number.isFinite(chg) ? chg.toFixed(2) + '%' : 'unknown'}`], levels: null, veto: null };
  }
  if (roles.includes('sentiment')) {
    out.sentiment = { agent: 'sentiment', direction: 'NEUTRAL', confidence: 20, reasons: ['quant fallback: sentiment context unavailable — honest abstain'], levels: null, veto: null };
  }
  if (roles.includes('optionsflow')) {
    const oc = features?.options;
    if (oc && Number.isFinite(Number(oc.oiLean))) {
      const dir = Number(oc.oiLean) > 0.05 ? 'LONG' : Number(oc.oiLean) < -0.05 ? 'SHORT' : 'NEUTRAL';
      out.optionsflow = { agent: 'optionsflow', direction: dir, confidence: Math.round(Math.min(70, 40 + Math.abs(Number(oc.oiLean)) * 60)), reasons: [`quant fallback: OI lean ${Number(oc.oiLean).toFixed(2)}`], levels: null, veto: null };
    } else {
      out.optionsflow = { agent: 'optionsflow', direction: 'NEUTRAL', confidence: 20, reasons: ['quant fallback: options data absent'], levels: null, veto: null };
    }
  }
  if (roles.includes('onchain')) {
    const oc = features?.onchain;
    if (oc && Number.isFinite(Number(oc.fundingRate))) {
      const fr = Number(oc.fundingRate);
      const dir = fr > 0.0004 ? 'SHORT' : fr < -0.0002 ? 'LONG' : 'NEUTRAL'; // crowded longs = fragile
      out.onchain = { agent: 'onchain', direction: dir, confidence: Math.round(Math.min(70, 35 + Math.abs(fr) * 30000)), reasons: [`quant fallback: funding ${(fr * 100).toFixed(3)}%/8h`], levels: null, veto: null };
    } else {
      out.onchain = { agent: 'onchain', direction: 'NEUTRAL', confidence: 20, reasons: ['quant fallback: on-chain data absent'], levels: null, veto: null };
    }
  }
  if (roles.includes('risk')) {
    const ev = features?.risk?.event;
    const veto = ev?.action === 'blackout' ? 'event_blackout'
      : features?.risk?.riskOff ? 'risk_off'
        : features?.plan && Number(features.plan.rewardRisk) < 1.5 ? 'bad_plan' : null;
    out.risk = { agent: 'risk', direction: 'NEUTRAL', confidence: veto ? 90 : 70, reasons: [veto ? `quant fallback: ${veto}` : 'quant fallback: guards nominal'], levels: null, veto };
  }
  return out;
}

// ---------------- gate context assembly ----------------
function gateContextFor({ market, symbol, features, calibration }) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const ens = features?.ensemble?.consensus || {};
  const macroChg = Number(features?.macro?.regimeChangePct);
  const side = String(ens.side || '').toUpperCase();
  const regimeAligned = !Number.isFinite(macroChg) || !side ? null
    : (macroChg > 0.1 && side === 'LONG') || (macroChg < -0.1 && side === 'SHORT');
  const ev = features?.risk?.event;
  // direction split from calibration (weak-side bar raise). v11.0.1
  // FIX: aggregate ACROSS seats into ONE {LONG,SHORT} view — the
  // original code keyed `split` by seat ROLE and then read
  // `split.LONG`/`split.SHORT` (always undefined), so the +5 weak-side
  // bar could never fire (dead feature, test-locked now). winRates
  // are n-weighted so a 2-trade seat can't outvote a 30-trade one.
  let longN = 0, longWins = 0, shortN = 0, shortWins = 0;
  for (const s of calibration?.agents || []) {
    const ds = s?.directionSplit;
    if (!ds) continue;
    const ln = Number(ds.LONG?.n) || 0;
    const sn = Number(ds.SHORT?.n) || 0;
    longN += ln;
    shortN += sn;
    longWins += Math.round(ln * ((Number(ds.LONG?.winRate) || 0) / 100));
    shortWins += Math.round(sn * ((Number(ds.SHORT?.winRate) || 0) / 100));
  }
  const split = (longN + shortN) > 0 ? {
    LONG: { n: longN, winRate: longN > 0 ? Math.round((longWins / longN) * 1000) / 10 : null },
    SHORT: { n: shortN, winRate: shortN > 0 ? Math.round((shortWins / shortN) * 1000) / 10 : null },
  } : null;
  return {
    market: mkt,
    symbol,
    regimeAligned,
    event: { blocked: ev?.action === 'blackout', haircut: ev?.action === 'haircut' ? 0.5 : null },
    riskOff: !!features?.risk?.riskOff,
    riskVeto: null, // filled from the risk persona's verdict in evaluate
    directionSplit: split,
    levels: features?.ta ? { entry: features.ltp, stop: features.plan?.stopLoss ?? null, t1: features.plan?.target1 ?? null } : null,
    plan: features?.plan || null,
    regime: features?.macro?.regimeLabel || null,
  };
}

/** Evaluate verdicts → consensus + gate (risk veto folded in). */
function evaluateWithRisk({ market, symbol, verdicts, features, calibration, model, recordNearMiss }) {
  const ctx = gateContextFor({ market, symbol, features, calibration });
  ctx.riskVeto = verdicts?.risk?.veto || null;
  ctx.model = model;
  ctx.recordNearMiss = recordNearMiss !== false;
  const weights = councilWeights(calibration?.weights || {});
  const { consensus, gate, nearMissRecorded } = evaluateCouncil(verdicts, { ...ctx, weights });
  return { consensus, gate, weightsUsed: consensus.weightsUsed, nearMissRecorded };
}

// ---------------- mesh bundle (Layer 1 input) ----------------
/** Fan the mesh out for the symbol set (bounded, cached, honest). */
export async function councilMeshBundle(market, symbols) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const syms = (symbols || []).map(s => String(s || '').toUpperCase()).filter(Boolean).slice(0, 6);
  if (syms.length === 0) return {};
  try {
    if (mkt === 'CRYPTO' || mkt === 'FUTURES') {
      // v11.0.1 FIX: crypto.funding serves ONE symbol per mesh call
      // (the ccxt cap contract), but the bundle used to fetch it ONCE
      // for the whole symbol set — so only symbols[0] ever got funding
      // and the on-chain seat was BLIND for the other board candidates
      // (honest-null, never a crash — exactly the blind-seat defect
      // class the validation pass fixed in buildFeatureMatrix). Now:
      // one price query (coingecko serves ALL symbols per call) + one
      // funding query PER SYMBOL, all riding the mesh's own single-
      // flight + warm 5-min cache — steady-state cost stays ~1 upstream
      // call per symbol per 5 minutes.
      const [priceQ, ...fundQs] = await Promise.all([
        meshQuery({ capabilities: ['crypto.price'], symbols: syms }),
        ...syms.map(s => meshQuery({ capabilities: ['crypto.funding'], symbols: [s] })),
      ]);
      const bundle = {};
      for (let i = 0; i < syms.length; i++) {
        const s = syms[i];
        const fund = fundQs[i]?.results?.['crypto.funding']?.data;
        const base = String(s).replace(/USDT$|INR$/, '');
        const prices = priceQ.results?.['crypto.price']?.data?.prices?.[base];
        bundle[s] = {
          fundingRate: fund && String(fund.symbol || '').startsWith(base) ? Number(fund.fundingRate) || null : null,
          price: prices ? { price: prices.usd, agent: 'coingecko' } : null,
        };
      }
      return bundle;
    }
    if (mkt === 'GLOBALFUTURES') {
      const q = await meshQuery({ capabilities: ['quotes.yahoo'], keys: syms });
      const bundle = {};
      for (const s of syms) {
        const rows = q.results?.['quotes.yahoo']?.data?.rows || {};
        const row = rows[s] || rows[s.replace(/PERP$/, '')];
        if (row) bundle[s] = { price: { price: Number(row.ltp ?? row.close ?? row.price) || null, agent: 'yahoo' } };
      }
      return bundle;
    }
    return {}; // INDIA board rides the desk's own live feeds (plan: "India desk apne feeds par hi kahega")
  } catch { return {}; }
}

// ---------------- risk context (shared across symbols) ----------------
/** v11.0.1 FIX: the capital base is now HONEST — the crypto desk's
 *  last persisted wallet equity (ai-agent-state.json lastWallet, the
 *  agent.js persistState() snapshot) and the India desk's configured
 *  equityINR (dynamic import — cycle-safe, the agent.js pattern).
 *  Both fall back to the ₹10k paper default, exactly like both
 *  desks' own gauntlets do; heatPct feeds the risk guardian's prompt
 *  + deterministic veto context, so a nominal-10k read used to
 *  understate real heat whenever actual capital differed. */
async function riskContextFor(_market) {
  try {
    let cryptoEquityINR = 10_000;
    let indiaCapitalINR = 10_000;
    try {
      const st = loadJSON('ai-agent-state.json', null);
      if (st && Number(st.lastWallet?.equityINR) > 0) cryptoEquityINR = Number(st.lastWallet.equityINR);
    } catch { /* paper default */ }
    try {
      const { loadIndiaAgentConfig } = await import('./indiaAgent.js');
      const c = loadIndiaAgentConfig?.() || {};
      if (Number(c.equityINR) > 0) indiaCapitalINR = Number(c.equityINR);
    } catch { /* paper default */ }
    const v = await globalRiskView({ cryptoEquityINR, indiaCapitalINR });
    return { heatPct: v.heatPct ?? null, riskOff: !!v.riskOff?.riskOff };
  } catch { return { heatPct: null, riskOff: false }; }
}

// ---------------- BOARD mode ----------------
/**
 * Run the council over the top-N board candidates: 6 BATCH persona
 * calls (one prompt each, all symbols inside — the batching keeps
 * board cost at ~6 LLM calls / 90s, NOT 6×N). Verdicts cached 90s.
 * @param {{market: string, signals: object[], regime: object, deps: object}} opts
 * @returns {Promise<{bySymbol: object, model: string|null, cached: string[]}>}
 */
export async function runCouncilBoard({ market, signals, regime, deps }) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const cands = (signals || []).filter(s => s && s.symbol).slice(0, 5);
  if (cands.length === 0) return { bySymbol: {}, model: null, cached: [] };

  // cache-aside: instant for fresh, compute for stale
  const fresh = {};
  const stale = [];
  for (const s of cands) {
    const hit = verdictCacheGet(mkt, s.symbol);
    if (hit) fresh[s.symbol] = hit; else stale.push(s);
  }
  if (stale.length === 0) return { bySymbol: fresh, model: 'cached', cached: cands.map(s => s.symbol) };

  const [meshBundle, riskCtx, calibration] = await Promise.all([
    councilMeshBundle(mkt, stale.map(s => s.symbol)),
    riskContextFor(mkt),
    Promise.resolve().then(() => councilCalibration()).catch(() => ({ weights: {}, agents: [] })),
  ]);
  const sentCtx = sentimentContextFor(mkt === 'INDIA' ? 'INDIA' : 'CRYPTO');
  const featuresList = stale.map(s => buildFeatureMatrix({
    market: mkt, symbol: s.symbol, sig: s, regime,
    mesh: meshBundle[s.symbol] || null, sentCtx, eventCtx: null, riskCtx,
  }));
  // per-symbol event guard (cheap, synchronous)
  const eventBySymbol = {};
  for (const s of stale) {
    try { eventBySymbol[s.symbol] = eventGuardCheck({ symbol: s.symbol, desk: mkt }); } catch { eventBySymbol[s.symbol] = null; }
  }
  for (let i = 0; i < featuresList.length; i++) {
    const ev = eventBySymbol[stale[i].symbol];
    featuresList[i].risk.event = ev ? { kind: ev.event?.kind || null, inMin: ev.event?.minutesUntil ?? null, action: ev.action || 'allow' } : null;
  }

  // ---- 6 persona batch calls (parallel) ----
  const roles = availableRoles(mkt);
  // v18.8: cloud keys OR a reachable local ollama — the council runs
  // for a zero-cloud-key local install too (probed, 90s-cached).
  const llmOnline = aiKeysPresent(deps?.KEYS) || !!(await ollamaProbe().catch(() => false));
  const verdictsBySymbol = {}; // sym → {role: verdict}
  let model = 'deterministic';
  if (llmOnline) {
    const answers = await Promise.all(roles.map(async (role) => {
      const { json, model: m } = await councilAsk(personaPrompt(role, mkt, featuresList), deps);
      return { role, json, model: m };
    }));
    const parsed = answers.filter(a => a.json?.verdicts && typeof a.json.verdicts === 'object');
    if (parsed.length > 0) {
      // at least ONE persona returned usable JSON → the LLM council
      // stands; every seat that failed JSON degrades to its
      // deterministic vote below (the deep-mode pattern — partial
      // failure must not collapse the whole council to quant-only)
      model = parsed[0]?.model || 'llm-chain';
      for (const s of stale) verdictsBySymbol[s.symbol] = {};
      for (const a of parsed) {
        for (const s of stale) {
          const raw = a.json.verdicts[s.symbol] || a.json.verdicts[String(s.symbol).toUpperCase()];
          const v = parseVerdict(a.role, raw);
          if (v) verdictsBySymbol[s.symbol][a.role] = v;
        }
      }
      // any seat that failed JSON — or answered but SKIPPED this
      // symbol (a batched persona may cover some candidates and not
      // others) — degrades to its deterministic vote, PER SYMBOL
      for (const s of stale) {
        const symKey = String(s.symbol);
        const det = deterministicVerdicts(mkt, featuresList.find(f => f.symbol === symKey.toUpperCase()));
        for (const a of answers) {
          if (verdictsBySymbol[symKey][a.role]) continue; // LLM seated this symbol
          if (!det[a.role]) continue;
          const seatDown = !a.json?.verdicts || typeof a.json.verdicts !== 'object';
          const tag = seatDown ? 'LLM seat failed' : `seat skipped ${symKey}`;
          verdictsBySymbol[symKey][a.role] = { ...det[a.role], reasons: [`${tag} → quant fallback: ${(det[a.role].reasons || [])[0] || ''}`] };
        }
      }
    } else {
      // chain answered nothing usable → fully deterministic
      for (const s of stale) verdictsBySymbol[s.symbol] = deterministicVerdicts(mkt, featuresList.find(f => f.symbol === String(s.symbol).toUpperCase()));
    }
  } else {
    for (const s of stale) verdictsBySymbol[s.symbol] = deterministicVerdicts(mkt, featuresList.find(f => f.symbol === String(s.symbol).toUpperCase()));
  }

  // ---- consensus + gate per symbol ----
  const out = {};
  for (const s of stale) {
    const features = featuresList.find(f => f.symbol === String(s.symbol).toUpperCase());
    const verdicts = verdictsBySymbol[s.symbol] || {};
    const evaluated = evaluateWithRisk({ market: mkt, symbol: s.symbol, verdicts, features, calibration, model, recordNearMiss: true });
    const divergence = priceDivergence(features);
    const result = {
      market: mkt, symbol: s.symbol, model,
      verdicts,
      consensus: evaluated.consensus,
      gate: evaluated.gate,
      weightsUsed: evaluated.weightsUsed,
      nearMissRecorded: evaluated.nearMissRecorded,
      featureDivergence: divergence,
      generatedAt: Date.now(),
      freshness: model === 'deterministic' ? 'model' : 'live',
    };
    verdictCacheSet(mkt, s.symbol, result);
    out[s.symbol] = result;
  }
  return { bySymbol: { ...fresh, ...out }, model, cached: Object.keys(fresh) };
}

// ---------------- DEEP mode (debate + judge) ----------------
/**
 * Single-symbol deep-dive: 6 personas + bull/bear debate + judge
 * synthesis (~9 LLM calls). Debate rounds from AI_COUNCIL_DEBATE_ROUNDS.
 */
export async function runCouncilDeep({ market, symbol, sig, regime, deps, force = false }) {
  const mkt = String(market || 'CRYPTO').toUpperCase();
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  if (!force) {
    const hit = verdictCacheGet(mkt, sym);
    if (hit) return hit;
  }
  // v11.0.1 FIX (honesty): without a signal ctx the feature matrix has
  // no ta/ensemble/plan — a verdict built on that is all-NEUTRAL noise
  // wearing a council badge. The route treats null as an honest 502
  // ("no signal context") — that is the truthful answer.
  if (!sig) return null;
  // v11.0.1 FIX (double-spend): single-flight per market:symbol — a
  // user double-click / panel remount + poll overlap used to fire TWO
  // full deep runs (~18 LLM calls) for the same symbol inside the 90s
  // cache window; concurrent callers now JOIN the in-flight run.
  const inflightKey = `${mkt}:${sym}`;
  const running = _deepInflight.get(inflightKey);
  if (running) return running;
  const p = (async () => {
  const [meshBundle, riskCtx, calibration] = await Promise.all([
    councilMeshBundle(mkt, [sym]),
    riskContextFor(mkt),
    Promise.resolve().then(() => councilCalibration()).catch(() => ({ weights: {}, agents: [] })),
  ]);
  const sentCtx = sentimentContextFor(mkt === 'INDIA' ? 'INDIA' : 'CRYPTO');
  let eventCtx = null;
  try { eventCtx = eventGuardCheck({ symbol: sym, desk: mkt }); } catch { /* allow */ }
  const features = buildFeatureMatrix({
    market: mkt, symbol: sym, sig, regime,
    mesh: meshBundle[sym] || null, sentCtx, eventCtx, riskCtx,
  });
  const featuresList = [features];
  const roles = availableRoles(mkt);
  // v18.8: cloud keys OR a reachable local ollama (deep mode too).
  const llmOnline = aiKeysPresent(deps?.KEYS) || !!(await ollamaProbe().catch(() => false));

  let verdicts = {};
  let model = 'deterministic';
  let debate = null;
  if (llmOnline) {
    const answers = await Promise.all(roles.map(async (role) => {
      const { json, model: m } = await councilAsk(personaPrompt(role, mkt, featuresList), deps);
      return { role, json, model: m };
    }));
    const parsed = answers.filter(a => a.json?.verdicts && typeof a.json.verdicts === 'object');
    if (parsed.length > 0) {
      model = parsed[0]?.model || 'llm-chain';
      for (const a of parsed) {
        const raw = a.json.verdicts[sym];
        const v = parseVerdict(a.role, raw);
        if (v) verdicts[a.role] = v;
      }
      const det = deterministicVerdicts(mkt, features);
      for (const a of answers) {
        if (verdicts[a.role]) continue; // LLM seated this seat
        if (!det[a.role]) continue;
        const seatDown = !a.json?.verdicts || typeof a.json.verdicts !== 'object';
        const tag = seatDown ? 'LLM seat failed' : `seat skipped ${sym}`;
        verdicts[a.role] = { ...det[a.role], reasons: [`${tag} → quant fallback: ${(det[a.role].reasons || [])[0] || ''}`] };
      }
      // ---- debate (bull vs bear) + judge synthesis ----
      if (councilDebateRounds() > 0) {
        debate = await runDebateAndJudge({ market: mkt, symbol: sym, features, verdicts, deps });
        if (debate?.judgeShift && Number.isFinite(Number(debate.judgeShift))) {
          // the judge's bounded confidence shift rides the technical seat
          const t = verdicts.technical;
          if (t) {
            t.confidence = Math.max(0, Math.min(100, Math.round(t.confidence + Math.max(-8, Math.min(8, Number(debate.judgeShift))))));
            t.reasons = [...(t.reasons || []), `judge shift ${Number(debate.judgeShift) > 0 ? '+' : ''}${Math.round(Number(debate.judgeShift))}`];
          }
        }
      }
    } else {
      verdicts = deterministicVerdicts(mkt, features);
    }
  } else {
    verdicts = deterministicVerdicts(mkt, features);
  }

  const evaluated = evaluateWithRisk({ market: mkt, symbol: sym, verdicts, features, calibration, model, recordNearMiss: true });
  const result = {
    market: mkt, symbol: sym, model, debate,
    verdicts,
    consensus: evaluated.consensus,
    gate: evaluated.gate,
    weightsUsed: evaluated.weightsUsed,
    nearMissRecorded: evaluated.nearMissRecorded,
    featureDivergence: priceDivergence(features),
    features,
    generatedAt: Date.now(),
    freshness: model === 'deterministic' ? 'model' : 'live',
  };
  verdictCacheSet(mkt, sym, result);
  return result;
  })();
  _deepInflight.set(inflightKey, p);
  try { return await p; } finally { _deepInflight.delete(inflightKey); }
}

// ---------------- debate + judge ----------------
async function runDebateAndJudge({ market, symbol, features, verdicts, deps }) {
  try {
    const data = JSON.stringify({ features, council: verdicts }, null, 1);
    // v19.0 SELF-IMPROVEMENT: the Lessons Engine's context block rides
    // the debate + judge prompts (light-touch, opt-in by presence —
    // no lessons yet → empty string, prompt byte-identical to before).
    // Past settled-outcome mistakes now SHAPE the synthesis steps.
    let lessonsBlock = '';
    try {
      const { lessonsForPrompt } = await import('./lessonsEngine.js');
      lessonsBlock = lessonsForPrompt(3) || '';
    } catch { /* lessons module guarded — debate runs without */ }
    const bull = await councilAsk(`You are the BULL ADVOCATE in a superintelligence council debate over ${symbol} (${market} desk).
Below is the feature matrix + the 6 seats' current verdicts. Build the strongest HONEST LONG case using ONLY these numbers. If the long case is weak, say so and score low.\n\n${data}\n${lessonsBlock}\nRespond STRICT JSON only: {"case":"2 sentences","strength":0-100}`, deps);
    const bear = await councilAsk(`You are the BEAR ADVOCATE in a superintelligence council debate over ${symbol} (${market} desk).
Below is the feature matrix + the 6 seats' current verdicts. Build the strongest HONEST SHORT case using ONLY these numbers. If the short case is weak, say so and score low.\n\n${data}\n${lessonsBlock}\nRespond STRICT JSON only: {"case":"2 sentences","strength":0-100}`, deps);
    if (!bull?.json?.case || !bear?.json?.case) return null;
    const judge = await councilAsk(`You are the JUDGE of a superintelligence council debate over ${symbol} (${market} desk).
The bull and bear advocates have argued. Name where they DISAGREE, state which side the EVIDENCE favors, and issue a bounded confidence shift for the technical seat (-8 to +8; positive = evidence favors the bull case).\n\nFEATURES+COUNCIL:\n${data}\n${lessonsBlock}\nBULL: ${JSON.stringify(bull.json)}\nBEAR: ${JSON.stringify(bear.json)}\n\nRespond STRICT JSON only: {"disagreement":"1 sentence","favours":"bull"|"bear"|"neither","judgeShift":-8..8,"note":"max 20 words"}`, deps);
    return {
      bull: { case: bull.json.case, strength: Math.max(0, Math.min(100, Number(bull.json.strength) || 0)) },
      bear: { case: bear.json.case, strength: Math.max(0, Math.min(100, Number(bear.json.strength) || 0)) },
      judge: judge?.json ? {
        disagreement: judge.json.disagreement || null,
        favours: judge.json.favours || null,
        note: judge.json.note || null,
      } : null,
      judgeShift: judge?.json?.judgeShift != null ? Math.max(-8, Math.min(8, Number(judge.json.judgeShift) || 0)) : null,
    };
  } catch { return null; }
}

// ---------------- wire stamp (the compact per-signal payload) ----------------
/**
 * Compact a council result into the shape the SignalCards render
 * (and ledger.js stamps onto executed entries). Keeps the payload
 * bounded: voter grid + top reasons + gate diagnostics.
 */
export function councilStampOf(v) {
  if (!v || !v.consensus) return null;
  const voters = (v.consensus.voters || []).map(x => ({
    role: x.role, name: x.name, direction: x.direction, confidence: x.confidence,
  }));
  const agentReasons = Object.values(v.verdicts || {}).slice(0, 8).map(x => ({
    role: x.agent, reasons: (x.reasons || []).slice(0, 2),
    veto: x.veto || null,
  }));
  const techLevels = v.verdicts?.technical?.levels || null;
  return {
    model: v.model || null,
    freshness: v.freshness || 'live',
    direction: v.consensus.direction,
    confidence: v.consensus.confidence,
    agreement: v.consensus.agreement,
    quorum: v.consensus.quorum,
    gate: v.gate?.gate || null,
    gateBar: Number.isFinite(Number(v.gate?.thresholds?.minConfidence)) ? Number(v.gate.thresholds.minConfidence) : null,
    gateReasons: (v.gate?.reasons || []).slice(0, 4),
    eventHaircut: v.gate?.eventHaircut ?? null,
    agents: voters,
    agentReasons,
    levels: techLevels && Number.isFinite(Number(techLevels.entry)) ? techLevels : null,
    weightsUsed: v.weightsUsed || null,
    divergence: v.featureDivergence || null,
    debate: v.debate ? {
      bull: v.debate.bull?.case || null,
      bear: v.debate.bear?.case || null,
      judge: v.debate.judge?.note || null,
      favours: v.debate.judge?.favours || null,
    } : null,
    nearMiss: !!v.nearMissRecorded,
    generatedAt: v.generatedAt || Date.now(),
  };
}

// ---------------- status ----------------
export function councilStatus() {
  return {
    ok: true,
    enabled: councilEnabled(),
    flag: 'AI_ENABLE_GLOBAL_COUNCIL',
    debateRounds: councilDebateRounds(),
    roles: ROLE_IDS.map(r => ({ id: r, name: COUNCIL_ROLES[r].name, baseWeight: COUNCIL_ROLES[r].baseWeight })),
    gate: gateThresholds(),
    verdictCache: { entries: _verdicts.size, ttl: VERDICT_TTL, cap: VERDICT_MAX },
    note: 'Global Market Council — 6 specialist seats, calibrated weighted consensus, precision gate. Analysis layer only; execution gauntlets untouched.',
  };
}

// ---------------- test hooks ----------------
export function __resetCouncilForTests() { _verdicts.clear(); _deepInflight.clear(); }
export function __councilCacheForTests() { return { size: _verdicts.size, ttl: VERDICT_TTL, inflight: _deepInflight.size }; }
export const __testables = { personaPrompt, verdictCacheGet, verdictCacheSet, cacheKey, gateContextFor, riskContextFor };
