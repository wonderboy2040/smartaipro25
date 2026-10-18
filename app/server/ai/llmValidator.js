// ============================================================
// server/ai/llmValidator.js — A2 LLM SECOND-OPINION VALIDATOR
// ------------------------------------------------------------
// v13.2 (accuracy plan A2). The SVA (signalVerifier.js) is a PURE
// rule engine — 10-point pro-trader checklist, deterministic, free.
// This module adds the layer the plan asks for on TOP of it:
//
//   "Use an LLM as a second-opinion validator ONLY when ensemble
//    confidence is borderline (45–60%) — checks recent price action
//    + news before firing."
//
// Division of labour (the plan is explicit: LLMs VALIDATE and EXPLAIN,
// they never replace the quant ensemble):
//   • The ensemble still owns the signal.
//   • SVA still owns the deterministic final call.
//   • THIS layer only fires in the borderline band, asks the provider
//     chain (Gemini → Groq → Cerebras → OpenRouter, same councilAsk)
//     one STRICT-JSON question, and attaches its tiebreak to
//     s.verify.llm — CONFIRM / REJECT / FLIP + one-line reason.
//
// Cost guardrails (the plan's caching rule, applied harder):
//   • Candle-close keyed cache: at most ONE live call per symbol per
//     15-minute bucket (crypto/futures/global) — a board refresh,
//     deep dive, agent chat and Telegram /crypto within the same
//     bucket share the SAME answer. Board cards read the cache
//     passively (they never trigger a call).
//   • No keys configured → module reports unavailable, zero calls.
//   • Env kill-switch: AI_ENABLE_LLM_VALIDATOR=false.
//   • Band tunable: AI_LLM_VALIDATOR_BAND="45,60".
// NEVER THROWS — every failure path degrades to null.
// ============================================================
import { councilAsk, aiKeysPresent } from './llmChain.js';
// v18.8: keyless local engine awareness — from llmSentinel (NOT
// llmChain) so existing llmChain mocks in tests stay untouched.
import { ollamaProbe } from './llmSentinel.js';

const CANDLE_BUCKET_MS = 15 * 60 * 1000; // one ask per symbol per 15m close
const CACHE_MAX = 80;
const _cache = new Map(); // `${market}|${symbol}|${bucket}` → { verdict, confidence, reason, model, ts }

export function llmValidatorEnabled(env = process.env) {
  if (String(env?.AI_ENABLE_LLM_VALIDATOR || '').toLowerCase() === 'false') return false;
  return true;
}

/** The borderline confidence band [lo, hi] (inclusive). */
export function borderlineBand(env = process.env) {
  const raw = String(env?.AI_LLM_VALIDATOR_BAND || '45,60');
  const [a, b] = raw.split(',').map((x) => Number(x));
  const lo = Number.isFinite(a) && a >= 0 && a <= 100 ? a : 45;
  const hi = Number.isFinite(b) && b > lo && b <= 100 ? b : 60;
  return [lo, hi];
}

export function inBorderlineBand(confidence, env = process.env) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return false;
  const [lo, hi] = borderlineBand(env);
  return c >= lo && c <= hi;
}

const VERDICTS = new Set(['CONFIRM', 'REJECT', 'FLIP']);

function _bucket(now = Date.now()) { return Math.floor(now / CANDLE_BUCKET_MS); }

function _cacheKey(market, symbol, bucket) {
  return `${String(market || '').toUpperCase()}|${String(symbol || '').toUpperCase()}|${bucket}`;
}

function _cacheSet(key, val) {
  _cache.set(key, val);
  if (_cache.size > CACHE_MAX) {
    // evict oldest bucket keys first (the stale ask of a dead candle)
    const sorted = [..._cache.entries()].sort((x, y) => (x[1].ts || 0) - (y[1].ts || 0));
    for (let i = 0; i < Math.ceil(CACHE_MAX / 4); i++) _cache.delete(sorted[i][0]);
  }
}

/** Cache-only read — the board path uses this (never triggers a call). */
export function llmValidateCached(symbol, market, { now = Date.now() } = {}) {
  const b = _bucket(now);
  // current bucket, else the previous one is still informative (a 15m-old
  // second opinion beats none) — never anything older.
  return _cache.get(_cacheKey(market, symbol, b)) || _cache.get(_cacheKey(market, symbol, b - 1)) || null;
}

const num1 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);

function buildPrompt(sig) {
  const side = String(sig?.side || '').toUpperCase();
  const v = sig?.verify || {};
  const plan = sig?.plan || {};
  const si = sig?.superIntel || {};
  const ctx = [
    `symbol: ${sig?.symbol} (${sig?.market} desk)`,
    `ensemble call: ${side} · confidence ${num1(sig?.confidence)}% · grade ${sig?.grade || 'n/a'}`,
    `quorum: ${v.voters ?? sig?.voters ?? 'n/a'} voters agree`,
    `SVA checklist score: ${num1(v.score)} → ${v.action || 'n/a'} (${v.finalCall || 'n/a'})${v.veto ? ' · HARD VETO' : ''}`,
    sig?.summary ? `summary: ${String(sig.summary).slice(0, 220)}` : '',
    plan?.entry ? `plan: entry ${plan.entry} · SL ${plan.stopLoss ?? 'n/a'} · T1 ${plan?.targets?.[0] ?? 'n/a'} · R:R ${num1(plan?.rr ?? plan?.riskReward)}` : '',
    num1(si?.aiScore) != null ? `AI score: ${num1(si.aiScore)}` : '',
  ].filter(Boolean).join('\n');
  return [
    'You are a senior discretionary trader giving a SECOND OPINION on a borderline quant ensemble signal (confidence 45-60%).',
    'The quant committee and a rule-based checklist have already voted — you exist to catch what they CANNOT see: news-driven invalidation, obvious reversal structure, trap entries, crowded positioning.',
    'Rules: do NOT re-derive the technicals (they are already priced in). Default CONFIRM only if nothing smells wrong. REJECT when the setup contradicts itself or timing is bad. FLIP only on a CLEAR opposite case.',
    '',
    ctx,
    '',
    'Reply with STRICT JSON only: {"verdict":"CONFIRM|REJECT|FLIP","confidence":0-100,"reason":"one line, <=160 chars"}',
  ].join('\n');
}

/**
 * The borderline second opinion. ONE live LLM call per symbol per 15m
 * bucket; every later caller in the bucket gets the cached answer.
 * @returns {Promise<{verdict,confidence,reason,model,ts}|null>} null =
 *   unavailable (no keys / disabled / chain failed / out of band).
 */
export async function llmValidateSignal(sig, deps = {}, { now = Date.now(), env = process.env } = {}) {
  try {
    if (!llmValidatorEnabled(env)) return null;
    const symbol = String(sig?.symbol || '').toUpperCase();
    const market = String(sig?.market || '').toUpperCase();
    if (!symbol || !market) return null;
    // Out-of-band signals never ask the LLM (the plan's scoping rule).
    if (!inBorderlineBand(sig?.confidence, env)) return null;
    const { KEYS, OPENAI_COMPAT } = deps || {};
    // v18.8: cloud keys OR a reachable local ollama — the second
    // opinion stays armed for zero-cloud-key local installs too.
    if (!aiKeysPresent(KEYS) && !(await ollamaProbe().catch(() => false))) return null;

    const bucket = _bucket(now);
    const key = _cacheKey(market, symbol, bucket);
    const hit = _cache.get(key);
    if (hit) return hit;

    const { json, model } = await councilAsk(buildPrompt(sig), { KEYS, OPENAI_COMPAT });
    if (!json) return null;
    const verdict = String(json.verdict || '').toUpperCase();
    if (!VERDICTS.has(verdict)) return null;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(json.confidence) || 50)));
    const out = {
      verdict,
      confidence,
      reason: String(json.reason || '').slice(0, 200),
      model: model || null,
      ts: now,
    };
    _cacheSet(key, out);
    return out;
  } catch {
    return null; // the second opinion must never break the first one
  }
}

export function llmValidatorStatus(env = process.env) {
  const [lo, hi] = borderlineBand(env);
  return {
    enabled: llmValidatorEnabled(env),
    band: [lo, hi],
    candleBucketMin: CANDLE_BUCKET_MS / 60000,
    cached: _cache.size,
  };
}

export function __resetLlmValidatorForTests() { _cache.clear(); }

export const __testables = { buildPrompt, _bucket, _cacheKey, VERDICTS };
