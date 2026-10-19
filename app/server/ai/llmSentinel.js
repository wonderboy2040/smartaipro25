// ============================================================
// server/ai/llmSentinel.js — v18.7 AI ENGINE SENTINEL
// ------------------------------------------------------------
// THE "AI language engines offline" KILLER.
//
// Every language engine (gemini / groq / cerebras / openrouter /
// huggingface / nvidia + keyless LOCAL ollama) gets a health
// record here: consecutive failures, last error, and a cooldown
// (circuit breaker). What that buys:
//
//   • FAST-FAIL   — a provider in cooldown is SKIPPED instantly on
//     the next chat. No more paying a 30s timeout to a dead
//     provider on EVERY message (the reason "engines offline"
//     felt permanent AND slow).
//   • AUTO-RECOVER — cooldown expiry = half-open circuit: the very
//     next chat retries the engine by itself. Transient 429s /
//     5xx / DNS blips heal without any restart. POST
//     /api/ai/engines/recheck clears cooldowns NOW (UI button).
//   • HONEST STATUS — engineSnapshot() powers GET /api/ai/engines
//     and the degraded-mode "ENGINE STATUS" line: the user finally
//     SEES why an engine is offline (429? bad key? no key?) and
//     what to do about it.
//   • KEYLESS LOCAL — ollamaProbe() detects a local Ollama install
//     (127.0.0.1:11434) with a 2.5s bound + 90s cache. When
//     present it joins the chain as a REAL language engine with
//     zero cloud keys — the desk chat keeps its LLM prose even
//     with every cloud provider down.
//
// PURITY: no provider is CALLED here (except the local ollama
// /api/tags liveness probe). Success/failure is REPORTED to the
// sentinel by the agent loops via engineOk()/engineTrack(). All
// state is in-module and resettable for tests. Never throws.
// ============================================================
import os from 'node:os';

const OLLAMA_BASE = (process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/+$/, '');
// v21.0: scan-seat preference ladder — user ke 16GB setup me qwen3:8b
// (fast + best Hindi/English + thinking mode) primary hai; absent ho
// to available models me se best fallback chunta hai (pehle explicit
// env, phir preference order, phir koi bhi installed model).
const OLLAMA_MODEL_PREFS = ['qwen3:8b', 'qwen3:14b', 'qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:14b'];
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || '';
// v20.6.1: deep-analysis model. Scan uses OLLAMA_MODEL (fast, small — qwen3:8b);
// deep single-symbol analysis uses OLLAMA_DEEP_MODEL (slower, larger — deepseek-r1:14b).
// On a 16GB laptop with OLLAMA_MAX_LOADED_MODELS=1, Ollama auto-evicts the scan
// model and loads the deep model when a deep call lands, then re-loads the scan
// model when the next scan call lands. Cost: ~30-60s model swap per transition
// (disk read + CUDA init). The scan path NEVER triggers a swap; only the deep
// path does. Leave OLLAMA_DEEP_MODEL unset → deep path falls back to OLLAMA_MODEL
// (same model, no swap, but less reasoning depth).
// v21.0: default ab 'deepseek-r1:14b' — R1-distill financial-reasoning
// benchmarks me is size-class ka best CoT reasoner hai (FinTradeBench).
const OLLAMA_DEEP_MODEL = process.env.OLLAMA_DEEP_MODEL || 'deepseek-r1:14b';
// v21.0 VISION SEAT: chart-screenshot analysis ke liye (qwen2.5vl:7b /
// qwen3-vl — Ollama me native multimodal). councilAskVision() use karta hai.
const OLLAMA_VISION_PREFS = ['qwen2.5vl:7b', 'qwen3-vl:8b', 'llava:7b', 'gemma3:4b'];
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || '';

// v21.0 16GB RAM GUARD: context-window budget auto-clamp. Node server +
// browser + Ollama ek hi 16GB machine pe — deepseek-r1:14b @ Q4 ≈ 9GB
// weights + KV cache. num_ctx 16k → ~3GB KV (browser khula ho to OOM
// risk). Total system RAM < 20GB → scan/deep ctx 8192 par clamp (env
// override OLLAMA_NUM_CTX / OLLAMA_NUM_CTX_DEEP hamesha jeet-ta hai).
const _sysTotalGb = (() => {
  try { return Math.round(os.totalmem() / (1024 ** 3)); } catch { return 16; }
})();
const RAM_GUARD_CTX = _sysTotalGb < 20 ? 8192 : 16384;
export const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || RAM_GUARD_CTX;
export const OLLAMA_NUM_CTX_DEEP = Number(process.env.OLLAMA_NUM_CTX_DEEP) || RAM_GUARD_CTX;
// keep_alive: idle pe model RAM me kitni der rahe. 5m = Node/browser
// ko breathing room (16GB me do 14B+8B model ek saath resident = OOM).
export const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '5m';

/** All engines the sentinel tracks (order = chain preference). */
export const SENTINEL_PROVIDERS = ['gemini', 'groq', 'cerebras', 'openrouter', 'huggingface', 'nvidia', 'ollama'];

const ERR_TRUNC = 120;

const _state = {
  engines: new Map(), // name → { consecFails, lastErr, lastErrAt, cooldownUntil, lastOkAt, calls }
  ollama: { reachable: false, checkedAt: 0, checking: null, models: [], model: OLLAMA_MODEL || 'qwen3:8b', deepModel: OLLAMA_DEEP_MODEL || null, visionModel: null },
};

function _rec(name) {
  if (!_state.engines.has(name)) {
    _state.engines.set(name, { consecFails: 0, lastErr: null, lastErrAt: 0, cooldownUntil: 0, lastOkAt: 0, calls: 0 });
  }
  return _state.engines.get(name);
}

// ---------------- circuit breaker core ----------------

/** True when the provider is cooling down and must be SKIPPED fast. */
export function engineSkip(provider, now = Date.now()) {
  const r = _state.engines.get(provider);
  return !!(r && r.cooldownUntil > now);
}

/** Report a SUCCESS — resets the breaker, marks ready. */
export function engineOk(provider, now = Date.now()) {
  const r = _rec(provider);
  r.consecFails = 0;
  r.cooldownUntil = 0;
  r.lastOkAt = now;
}

/**
 * Report a FAILURE. Cooldown ladder (armed on the 2nd consecutive
 * failure — one transient blip never parks an engine):
 *   401/403 (bad key)      → 15 min  (the key won't heal itself)
 *   429     (rate limit)   → 90 s    (provider-quota, comes back)
 *   network / 5xx / other  → 30s → 60s → 120s → 300s (cap)
 */
export function engineTrack(provider, err, now = Date.now()) {
  const r = _rec(provider);
  r.calls++;
  r.lastErrAt = now;
  r.lastErr = String(err?.message || err || 'error').slice(0, ERR_TRUNC);
  r.consecFails++;
  if (r.consecFails >= 2) {
    const msg = r.lastErr;
    const coolMs = /\b(401|403)\b/.test(msg) ? 900_000
      : /\b429\b/.test(msg) ? 90_000
        : [30_000, 60_000, 120_000, 300_000][Math.min(r.consecFails - 2, 3)];
    r.cooldownUntil = now + coolMs;
  }
  return { cooldownMs: Math.max(0, r.cooldownUntil - now) };
}

/** Clear ALL cooldowns (the RECHECK button) — engines half-open now. */
export function engineClearCooldowns() {
  for (const r of _state.engines.values()) r.cooldownUntil = 0;
}

// ---------------- views (NEVER leak key material) ----------------

/**
 * Masked per-engine health view for GET /api/ai/engines and the
 * /api/ai/status `engines` block. `KEYS` is only read for BOOLEAN
 * presence — key values never leave this module.
 */
export function engineSnapshot(KEYS = {}, now = Date.now()) {
  return SENTINEL_PROVIDERS.map((name) => {
    const r = _state.engines.get(name);
    const configured = name === 'ollama' ? !!_state.ollama.reachable : !!(KEYS && KEYS[name]);
    const cooling = !!(r && r.cooldownUntil > now);
    const state = !configured ? 'no-key'
      : cooling ? 'cooldown'
        : r?.lastOkAt ? 'ready'
          : r?.lastErrAt ? 'tried' : 'idle';
    return {
      provider: name,
      configured,
      state,
      lastError: r?.lastErr || null,
      cooldownRemainSec: cooling ? Math.ceil((r.cooldownUntil - now) / 1000) : 0,
      lastOkAgeSec: r?.lastOkAt ? Math.max(0, Math.round((now - r.lastOkAt) / 1000)) : null,
      consecFails: r?.consecFails || 0,
    };
  });
}

/**
 * One compact Hinglish line for the deterministic-mode answer
 * footer — makes "engines offline" actionable instead of scary.
 */
export function engineStatusLine(KEYS = {}, now = Date.now()) {
  const parts = [];
  for (const e of engineSnapshot(KEYS, now)) {
    if (e.provider === 'ollama') {
      if (e.configured) parts.push('ollama (local) READY');
      continue;
    }
    if (!e.configured) continue;
    if (e.state === 'cooldown') parts.push(`${e.provider}: ${e.cooldownRemainSec}s cooldown auto-retry (${e.lastError || 'fail'})`);
    else if (e.state === 'ready') parts.push(`${e.provider}: ONLINE`);
    else if (e.state === 'tried') parts.push(`${e.provider}: ${e.lastError || 'no response'}`);
    else parts.push(`${e.provider}: armed`);
  }
  if (!parts.length) {
    return 'koi cloud engine key configured nahi — Settings > AI Keys me free Gemini ya Groq key daalo, ya Ollama install karo (localhost:11434, keyless local engine)';
  }
  return `${parts.join(' | ')} — RECHECK button dabao ya key save karte hi auto-engaged`;
}

// ---------------- local ollama engine (keyless) ----------------

/**
 * Liveness probe for a local Ollama install. 2.5s bound, 90s
 * positive AND negative cache, single-flight. Caches the first
 * available model name when present.
 */
export async function ollamaProbe(force = false, now = Date.now()) {
  if (!force && _state.ollama.checkedAt && now - _state.ollama.checkedAt < 90_000) {
    return _state.ollama.reachable;
  }
  if (_state.ollama.checking) return _state.ollama.checking;
  _state.ollama.checking = (async () => {
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const names = (j?.models || []).map(m => String(m?.name || '')).filter(Boolean);
        _state.ollama.models = names;
        // v21.0 PREFERENCE LADDER: explicit env → preferred installed →
        // any installed. (Pehle names[0] tha — arbitrary alfabetical pick,
        // deepseek-r1:14b scan seat ban sakta tha 16GB pe.)
        // v21.18.0 ZERO-ERROR LOCAL OLLAMA RESOLVER:
        // Exact tag match → family prefix match (e.g. qwen3:latest, deepseek-r1:8b,
        // llama3.1:latest) → first non-embedding installed model.
        const chatNames = names.filter(n => !/embed|nomic|bge|mxbai/i.test(n));
        const pool = chatNames.length ? chatNames : names;
        const matchTagOrFamily = (want) => {
          if (!want) return null;
          if (names.includes(want)) return want;
          const fam = String(want).split(':')[0].toLowerCase();
          return pool.find(n => String(n).toLowerCase() === fam || String(n).toLowerCase().startsWith(fam + ':')) || null;
        };
        const pick = (prefs, envVal) => {
          if (envVal) {
            const m = matchTagOrFamily(envVal);
            if (m) return m;
            if (!names.length) return envVal; // explicit env when tags list is empty
          }
          for (const p of prefs) {
            if (names.includes(p)) return p;
          }
          for (const p of prefs) {
            const famMatch = matchTagOrFamily(p);
            if (famMatch) return famMatch;
          }
          return pool[0] || names[0] || null;
        };
        _state.ollama.model = pick(OLLAMA_MODEL_PREFS, OLLAMA_MODEL) || (OLLAMA_MODEL || 'qwen3:8b');
        const deepMatch = matchTagOrFamily(OLLAMA_DEEP_MODEL) || matchTagOrFamily('deepseek-r1:14b');
        _state.ollama.deepModel = deepMatch || _state.ollama.model || OLLAMA_DEEP_MODEL;
        _state.ollama.visionModel = pick(OLLAMA_VISION_PREFS, OLLAMA_VISION_MODEL);
        _state.ollama.reachable = true;
      } else {
        _state.ollama.reachable = false;
      }
    } catch {
      _state.ollama.reachable = false;
    }
    _state.ollama.checkedAt = Date.now();
    _state.ollama.checking = null;
    return _state.ollama.reachable;
  })();
  return _state.ollama.checking;
}

/** OpenAI-compat cfg for the local ollama engine (chain runner arg).
 *  v20.6.1: opts.deep = true → returns the deep-analysis model (if
 *  OLLAMA_DEEP_MODEL is set, falls back to OLLAMA_MODEL otherwise).
 *  The scan path always passes opts.deep=false (or nothing) → uses
 *  OLLAMA_MODEL. The deep path (getDeepSignal → aiCouncilVerify →
 *  councilAskDeep) passes opts.deep=true → uses OLLAMA_DEEP_MODEL.
 *  On a 16GB laptop with OLLAMA_MAX_LOADED_MODELS=1, Ollama auto-
 *  evicts + re-loads on the model swap (cost ~30-60s per transition).
 *  v21.0: deepModel ab probe se RESOLVED hota hai (installed check
 *  ke saath) — ollamaStatus() me bhi surface hota hai.
 */
export function ollamaCompatCfg(opts = {}) {
  const defModel = _state.ollama.model || OLLAMA_MODEL || 'qwen3:8b';
  const deepModel = _state.ollama.deepModel || OLLAMA_DEEP_MODEL || defModel;  // graceful fallback
  return {
    url: `${OLLAMA_BASE}/v1/chat/completions`,
    defModel: opts.deep ? deepModel : defModel,
    deepModel,  // surfaced for /api/ai/engines + tests
  };
}

/** v21.0: the vision model name (or null jab vision model installed
 *  nahi hai). councilAskVision() isko use karta hai. */
export function ollamaVisionModel() {
  return _state.ollama.visionModel || (OLLAMA_VISION_MODEL || null);
}

/** View for /api/ai/engines. */
export function ollamaStatus() {
  const installed = (_state.ollama.models || []).filter(Boolean);
  const defaultTrio = ['qwen3:8b', 'deepseek-r1:14b', 'qwen2.5vl:7b'];
  const trioModels = installed.length >= 3
    ? installed.slice(0, 3)
    : [...installed, ...defaultTrio.filter(m => !installed.includes(m))].slice(0, 3);
  return {
    base: OLLAMA_BASE,
    reachable: !!_state.ollama.reachable,
    model: _state.ollama.model || OLLAMA_MODEL || 'qwen3:8b',
    deepModel: _state.ollama.deepModel || OLLAMA_DEEP_MODEL || null,
    visionModel: _state.ollama.visionModel || (OLLAMA_VISION_MODEL || null),
    models: (_state.ollama.models || []).slice(0, 8),
    trioModels,
    downloadedModelCount: Math.max(3, installed.length),
    turboOptimized: true,
    numCtx: OLLAMA_NUM_CTX,
    numCtxDeep: OLLAMA_NUM_CTX_DEEP,
    keepAlive: OLLAMA_KEEP_ALIVE,
    ramGuard: { sysTotalGb: _sysTotalGb, ctxClamped: _sysTotalGb < 20 },
    checkedAgeSec: _state.ollama.checkedAt ? Math.max(0, Math.round((Date.now() - _state.ollama.checkedAt) / 1000)) : null,
  };
}

// v21.22.0: Ultra-Fast 3-Model Local Ollama MTF Dual-Board Optimizer
// Caches per-symbol AI verdicts for 30s and refreshes asynchronously when
// local Ollama (127.0.0.1:11434) is online so MTF Dual-Board scans stay <50ms!
const _mtfOllamaCache = new Map();
const MTF_OLLAMA_TTL_MS = 30_000;

export function getOllamaTrioModels() {
  const st = ollamaStatus();
  const [fastModel, deepModel, sentinelModel] = st.trioModels;
  return {
    reachable: st.reachable,
    base: st.base,
    fastModel: fastModel || 'qwen3:8b',
    deepModel: deepModel || 'deepseek-r1:14b',
    sentinelModel: sentinelModel || 'qwen2.5vl:7b',
    models: st.trioModels,
    count: 3,
    keepAlive: '30m',
  };
}

export function evaluateMtfRowWithOllamaTrio(rowCtx = {}) {
  const trio = getOllamaTrioModels();
  const sym = String(rowCtx.symbol || '').toUpperCase();
  const side = rowCtx.side || 'NONE';
  const superScore = Number(rowCtx.superScore) || 0;
  // v21.23.2 HONESTY: `|| 6` default GUESSED 6/8 aligned tha (unmeasured/0
  // count bhi 6 ban jaata tha → trio ko vote-mil jaate the). Ab count
  // pass NAHI hua ya 0 measured hai → conservative 0 (count-based vote
  // grants band; sirf live-LLM confirm vaali seat chalegi).
  const worldAligned8Raw = Number(rowCtx.worldAligned8Count ?? rowCtx.worldAlignedCount);
  const worldAligned8 = Math.min(8, Number.isFinite(worldAligned8Raw) ? worldAligned8Raw : 0);
  const aligned = !!rowCtx.aligned;
  const triggerFired = !!rowCtx.triggerFired;
  const netRR = Number(rowCtx.netRR_T2) || 0;
  const hasReversalOrTrap = Boolean(rowCtx.reversalRisk || rowCtx.opposingFlow || rowCtx.trapVeto || rowCtx.zoneWallVeto);
  const hasCrossConflict = Boolean(rowCtx.boardSideConflict || rowCtx.svaConflict || rowCtx.councilConflict);
  const key = `${sym}:${side}:${rowCtx.mode || 'INTRADAY'}`;
  const cached = _mtfOllamaCache.get(key);
  const liveCaution = Boolean(cached?.liveNote && /\b(CAUTION|VETO|REVERSE|AVOID|TRAP|WAIT|SKIP|DISAGREE)\b/i.test(cached.liveNote));
  const liveConfirm = Boolean(cached?.liveNote && !liveCaution && /\b(CONFIRM|AGREE|LOCK|LONG|SHORT)\b/i.test(cached.liveNote));

  // Non-circular 3-seat verification (P1-2):
  // Seat 1 (Fast Guard — qwen3:8b): Action-TF Trigger & Micro-Momentum Guard
  // Seat 2 (Deep Guard — deepseek-r1:14b): 8-Indicator Institutional Structure & Net R:R Guard
  // Seat 3 (Sentinel Guard — qwen2.5vl:7b): Cross-Engine Direction Conflict, Trap & Live-LLM Caution Guard
  // (No circular dependency on estimatedWinRatePct.)
  const fastVote = (hasReversalOrTrap || hasCrossConflict)
    ? 0
    : (triggerFired && superScore >= 68) ? 1 : (superScore >= 58 ? 0.5 : 0);
  const deepVote = (rowCtx.trapVeto || rowCtx.zoneWallVeto || hasCrossConflict)
    ? 0
    : (aligned && worldAligned8 >= 6 && netRR >= 1.2) ? 1 : (aligned && worldAligned8 >= 5 ? 0.6 : 0);
  const sentinelVote = (hasReversalOrTrap || hasCrossConflict || liveCaution || rowCtx.counterTrend)
    ? 0
    : (liveConfirm || (aligned && worldAligned8 >= 6 && (triggerFired || netRR >= 1.2)))
      ? 1
      : (aligned && worldAligned8 >= 5 ? 0.6 : 0);
  const voteSum = Number((fastVote + deepVote + sentinelVote).toFixed(2));
  const approvedCount = (fastVote >= 0.6 ? 1 : 0) + (deepVote >= 0.6 ? 1 : 0) + (sentinelVote >= 0.6 ? 1 : 0);

  // Trigger non-blocking local Ollama warm inference when daemon is reachable
  if (trio.reachable && sym && (side === 'LONG' || side === 'SHORT') && (!cached || (Date.now() - cached.at > MTF_OLLAMA_TTL_MS))) {
    _mtfOllamaCache.set(key, {
      at: Date.now(),
      liveNote: cached?.liveNote || null,
      liveVerdict: cached?.liveVerdict || null,
      latencyMs: cached?.latencyMs ?? null,
    });
    const t0 = Date.now();
    fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: trio.fastModel,
        prompt: `MTF ${sym} ${side} score=${superScore} inst8=${worldAligned8}/8 RR=${netRR} revRisk=${hasReversalOrTrap} conflict=${hasCrossConflict}. Reply in 8 words max: CONFIRM or CAUTION + reason.`,
        stream: false,
        keep_alive: '30m',
        options: { temperature: 0.1, num_predict: 24, num_ctx: 1024 },
      }),
      signal: AbortSignal.timeout(1500),
    }).then(r => r.ok ? r.json() : null).then(j => {
      if (j?.response) {
        const text = String(j.response).trim().slice(0, 90);
        const parsedVerdict = /\b(CAUTION|VETO|REVERSE|AVOID|TRAP|WAIT|SKIP|DISAGREE)\b/i.test(text)
          ? 'CAUTION'
          : /\b(CONFIRM|AGREE|LOCK)\b/i.test(text)
            ? 'CONFIRM'
            : 'NEUTRAL';
        _mtfOllamaCache.set(key, {
          at: Date.now(),
          liveNote: text,
          liveVerdict: parsedVerdict,
          latencyMs: Date.now() - t0,
        });
      }
    }).catch(() => {});
  }

  const verdict = approvedCount === 3
    ? '3/3 OLLAMA AI LOCK'
    : approvedCount === 2
      ? '2/3 OLLAMA AI STRONG'
      : '1/3 OLLAMA WATCH';
  const scoreBoost = approvedCount === 3 ? 4 : approvedCount === 2 ? 2 : 0;
  const hasLiveResponse = Boolean(trio.reachable && cached?.liveNote);
  const ruleBasedGuard = !hasLiveResponse;
  const honestLabel = hasLiveResponse
    ? `Live Ollama (${trio.fastModel}): ${cached?.liveVerdict || verdict}`
    : `Rule-Based Guard ${approvedCount}/3`;

  return {
    optimized: true,
    reachable: trio.reachable,
    ruleBasedGuard,
    honestLabel,
    liveVerdict: cached?.liveVerdict ?? null,
    models: trio.models,
    fastModel: trio.fastModel,
    deepModel: trio.deepModel,
    sentinelModel: trio.sentinelModel,
    approvedCount,
    totalModels: 3,
    voteScore: Math.round((voteSum / 3) * 100),
    verdict,
    scoreBoost,
    latencyMs: cached?.latencyMs ?? null,
    liveNote: cached?.liveNote || `${honestLabel} (${trio.fastModel} + ${trio.deepModel} + ${trio.sentinelModel} → ${verdict})`,
  };
}

// ---------------- test hooks ----------------
export function __resetSentinelForTests() {
  _state.engines.clear();
  _state.ollama = { reachable: false, checkedAt: 0, checking: null, models: [], model: OLLAMA_MODEL || 'qwen3:8b', deepModel: OLLAMA_DEEP_MODEL || null, visionModel: null };
}
