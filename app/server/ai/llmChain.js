// ============================================================
// server/ai/llmChain.js — v18.8 · THE ONE SHARED LLM PROVIDER CHAIN
// ------------------------------------------------------------
// v11.0: extracted from signals.js so the Global Market Council can
// ride the SAME chain without a circular import (signals ↔ council).
// v18.7: sentinel-aware (cooldown fast-fail + auto half-open retry),
// extended to huggingface + nvidia.
//
// v18.8 ENGINE CHAIN UNIFICATION (the "AI language engines offline"
// superintelligence patch):
//   • KEYLESS LOCAL OLLAMA joins THIS chain too — the council, the
//     LLM second-opinion validator, the weekly review and the AI
//     Council seat used to stop at 4-6 cloud engines and degrade to
//     "engines offline" while a perfectly good local Ollama sat
//     UNUSED on 127.0.0.1:11434. Now it answers with ZERO cloud keys.
//   • PROVIDER-AWARE TIMEOUT — cloud engines keep the 15s bound; the
//     local ollama engine gets 90s (a CPU-only llama3.1:8b can take
//     30-60s for a 2k-token JSON verdict — the old shared 15s bound
//     made it ALWAYS time out on CPU machines).
//   • aiKeysPresent now counts ALL SIX cloud engines (a saved HF or
//     NVIDIA key no longer reads as "offline"); the council/validator
//     combine it with a reachable local ollama probe.
//   • signals.js's private 4-provider copy is DELETED — one chain,
//     one health ledger, one place to fix (the exact drift that let
//     the desk agents get the v18.7 upgrade while the board's AI
//     Council seat silently stayed on the old ladder).
// ============================================================
import {
  engineSkip, engineTrack, engineOk, ollamaProbe, ollamaCompatCfg, ollamaVisionModel,
  OLLAMA_NUM_CTX, OLLAMA_NUM_CTX_DEEP, OLLAMA_KEEP_ALIVE,
} from './llmSentinel.js';

const CLOUD_TIMEOUT_MS = 15_000;   // GPU cloud engines — fast fail
const OLLAMA_TIMEOUT_MS = 90_000;  // CPU-local llama can be slow (first prompt esp.)

// v21.0: the local Ollama base (sentinel ke jaisa hi env resolve — ek
// hi default, dono modules me consistent).
const OLLAMA_URL = (process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/+$/, '');

// v21.0 THINK-STRIP: R1/qwen3 reasoning blocks (concat-built, tooling-safe).
// (deepseek-r1 CoT + qwen3 thinking mode — dono strip hote hain.)
// String-concat se build kiya hai (tooling/literal safety).
const THINK_OPEN = '<' + 'think>';
const THINK_CLOSE = '</' + 'think>';

/** v21.0 THINK-STRIP: JSON parse se pehle thinking blocks hatao —
 * warna tryParseJson ka first-{-to-last-} window thinking ke andar ke
 * fragments pakad leta tha (R1 case). */
function stripThinking(text) {
  let t = String(text || '');
  // closed thinking blocks (greedy non-cross removal — har pair)
  while (t.includes(THINK_OPEN)) {
    const s = t.indexOf(THINK_OPEN);
    const e = t.indexOf(THINK_CLOSE, s);
    if (e < 0) { t = t.slice(0, s); break; } // unclosed: sab kuch thinking hai
    t = t.slice(0, s) + t.slice(e + THINK_CLOSE.length);
  }
  return t.trim();
}

export function tryParseJson(text) {
  const cleaned = stripThinking(String(text || '').replace(/```json|```/gi, '')).trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const repair = (raw) => raw.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* try repaired / balanced */ }
  try { return JSON.parse(repair(cleaned.slice(start, end + 1))); } catch { /* scan balanced from end */ }
  // v21.18.0: agar reasoning text me pehle koi stray '{' aaya ho, to aakhri
  // balanced {...} JSON object ko reverse-scan se nikaalo — local Ollama
  // (deepseek-r1 / qwen3 / llama3) par 'no-json response' error zero!
  for (let i = cleaned.lastIndexOf('{'); i >= start; i = cleaned.lastIndexOf('{', i - 1)) {
    const slice = cleaned.slice(i, end + 1);
    try { return JSON.parse(repair(slice)); } catch { /* keep scanning */ }
    if (i === 0) break;
  }
  return null;
}

/**
 * v21.0 / v21.18.0 NATIVE OLLAMA CALL (/api/chat — ZERO-ERROR UPGRADE).
 *   • Supports message.content + message.thinking fallback (Ollama v0.9+ CoT)
 *   • Auto-fallback on HTTP 404 (if deepModel isn't pulled, falls back to scan model)
 *   • Auto-retry without format:'json' if a reasoning model returns empty content under grammar lock
 */
async function askOllamaNative(prompt, { deep = false, images = null, system = null, model = null, timeoutMs = OLLAMA_TIMEOUT_MS } = {}) {
  const cfg = ollamaCompatCfg({ deep });
  const useModel = model || cfg.defModel;
  const ollamaBase = String(cfg.url || '').replace(/\/v1\/chat\/completions$/, '') || OLLAMA_URL;
  const buildBody = (m, useJsonFormat = true) => ({
    model: m,
    stream: false,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : [{ role: 'system', content: 'You are a superintelligence quantitative trading analyst. Respond with STRICT valid JSON only.' }]),
      { role: 'user', content: prompt, ...(Array.isArray(images) && images.length ? { images } : {}) },
    ],
    ...(useJsonFormat ? { format: 'json' } : {}),
    options: {
      temperature: 0.2,
      num_ctx: deep ? OLLAMA_NUM_CTX_DEEP : OLLAMA_NUM_CTX,
      num_predict: 2048,
    },
    keep_alive: OLLAMA_KEEP_ALIVE,
  });
  let r = await fetch(`${ollamaBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(useModel, true)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // v21.18.0: agar deep model locally pull nahi hai (HTTP 404), turant
  // scan model pe fallback karo — zero error!
  if (r.status === 404 && deep) {
    const scanModel = ollamaCompatCfg({ deep: false })?.defModel;
    if (scanModel && scanModel !== useModel) {
      r = await fetch(`${ollamaBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(scanModel, true)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
  }
  if (!r.ok) throw new Error(`ollama http ${r.status}`);
  const j = await r.json();
  const text = (j?.message?.content || '') + (j?.message?.thinking ? '\n' + j.message.thinking : '') + (j?.response ? '\n' + j.response : '');
  const parsed = tryParseJson(text);
  if (parsed) return parsed;
  // v21.18.0: reasoning models (deepseek-r1 / qwen3) kabhi-kabhi format:'json'
  // grammar lock me empty content dete hain — ek baar bina format:'json' retry!
  const r2 = await fetch(`${ollamaBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(useModel, false)),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (r2?.ok) {
    const j2 = await r2.json().catch(() => null);
    const t2 = (j2?.message?.content || '') + (j2?.message?.thinking ? '\n' + j2.message.thinking : '') + (j2?.response ? '\n' + j2.response : '');
    return tryParseJson(t2);
  }
  return null;
}

/** Sync gate: ANY of the six cloud engine keys present? */
export function aiKeysPresent(KEYS) {
  return !!(KEYS && (
    KEYS.gemini || KEYS.groq || KEYS.cerebras
    || KEYS.openrouter || KEYS.huggingface || KEYS.nvidia
  ));
}

async function askGemini(prompt, KEYS) {
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  // v20.9.1 [M]: HTTP failures ab STATUS-CODED throw ke roop me upar jaate
  // hain — pehle null return hota tha aur councilAsk usse 'no-json response'
  // treat karta tha (llmSentinel ka 401/403→15min park aur 429→90s ladder
  // KABHI fire nahi hota tha; har failure generic 30→300s ladder pe girta
  // tha aur ek permanently-bad key har cycle me re-probe hoti thi).
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEYS.gemini}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
        }),
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
      });
      if (!r.ok) { lastErr = new Error(`gemini http ${r.status}`); continue; }
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      const parsed = tryParseJson(text);
      if (parsed) return parsed;
    } catch (e) { lastErr = e; /* next model */ }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function askOpenAICompat(prompt, KEYS, OPENAI_COMPAT, provider, opts = {}) {
  // v18.8: opts.cfgOverride lets the keyless local ollama engine ride
  // this exact path (auth header inert for it); opts.timeoutMs makes
  // the local engine's longer budget explicit.
  const cfg = opts.cfgOverride || OPENAI_COMPAT?.[provider];
  const key = String(KEYS?.[provider] || 'local');
  const timeoutMs = opts.timeoutMs || CLOUD_TIMEOUT_MS;
  if (!cfg) return null;
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg.defModel,
      messages: [
        { role: 'system', content: 'You are an elite trading desk analyst. Respond with STRICT JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // v20.9.1 [M]: non-2xx pe STATUS-CODED throw (gemini wale comment
  // dekho) — sentinel ka status-aware cooldown ladder ab live hai.
  // (fetch/timeout throws bhi naturally propagate hote hain.)
  if (!r.ok) throw new Error(`${provider} http ${r.status}`);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content || '';
  return tryParseJson(text);
}

/**
 * v20.6: env-driven chain order + local-only short-circuit.
 *   LLM_PRIORITY=ollama,groq,gemini,...  → comma-separated provider
 *     list in desired order. Cloud providers not in this list are
 *     skipped entirely (no key probe, no fetch).
 *   LLM_LOCAL_ONLY=1  → cloud providers are SKIPPED EVEN IF listed in
 *     LLM_PRIORITY; only the local ollama engine is tried. Designed
 *     for the user's 16GB laptop setup (Chrome + Node + Ollama all
 *     running locally; cloud calls add latency + cost + bandwidth).
 *   default LLM_PRIORITY (env unset): 'gemini,groq,cerebras,openrouter,
 *     huggingface,nvidia,ollama' (the historical order — backward
 *     compatible). To flip the priority to local-first, set
 *     LLM_PRIORITY=ollama,groq,gemini,... or just LLM_LOCAL_ONLY=1.
 */
function _chainOrder() {
  const envOrder = String(process.env.LLM_PRIORITY || '').split(',')
    .map(s => s.trim().toLowerCase()).filter(Boolean);
  if (envOrder.length) return envOrder;
  return ['gemini', 'groq', 'cerebras', 'openrouter', 'huggingface', 'nvidia', 'ollama'];
}
function _localOnly() {
  return String(process.env.LLM_LOCAL_ONLY || '').toLowerCase() === '1'
    || String(process.env.LLM_LOCAL_ONLY || '').toLowerCase() === 'true';
}

/**
 * One ask through the provider chain. Returns { json, model } or
 * { json: null, model: null } — never throws.
 * v18.7: sentinel-aware — cooled providers are skipped, results are
 * tracked (success resets the breaker, failure arms it).
 * v18.8: the chain ENDS at the keyless local ollama engine — with
 * every cloud engine down/unkeyed, an installed Ollama still answers
 * (long timeout, sentinel-tracked like any other engine).
 * v20.6: the chain order is now env-driven (LLM_PRIORITY) and the
 * cloud half can be short-circuited entirely (LLM_LOCAL_ONLY=1).
 */
export async function councilAsk(prompt, deps, opts = {}) {
  const { KEYS, OPENAI_COMPAT } = deps || {};
  let json = null, model = null;

  // v20.6.1: opts.deep = true → the ollama leg uses OLLAMA_DEEP_MODEL
  // (deepseek-r1:14b) instead of OLLAMA_MODEL (qwen3:8b). The scan
  // path always passes opts.deep=false (default); only the deep
  // single-symbol analysis path (getDeepSignal → councilAskDeep)
  // passes opts.deep=true. See ollamaCompatCfg({deep:true}).
  const deep = !!opts.deep;

  // v20.6: build the cloud-half attempts list from env order + skip
  // cloud entries entirely under LLM_LOCAL_ONLY=1.
  const localOnly = _localOnly();
  const order = _chainOrder();
  const cloudProviderAsk = {
    gemini: () => askGemini(prompt, KEYS),
    groq: () => askOpenAICompat(prompt, KEYS, OPENAI_COMPAT, 'groq'),
    cerebras: () => askOpenAICompat(prompt, KEYS, OPENAI_COMPAT, 'cerebras'),
    openrouter: () => askOpenAICompat(prompt, KEYS, OPENAI_COMPAT, 'openrouter'),
    huggingface: () => askOpenAICompat(prompt, KEYS, OPENAI_COMPAT, 'huggingface'),
    nvidia: () => askOpenAICompat(prompt, KEYS, OPENAI_COMPAT, 'nvidia'),
  };
  const attempts = localOnly
    ? []  // skip cloud entirely
    : order.filter(p => p !== 'ollama').map(p => [p, cloudProviderAsk[p]]).filter(([, fn]) => typeof fn === 'function');

  for (const [provider, ask] of attempts) {
    if (json) break;
    if (!KEYS?.[provider]) continue;
    if (engineSkip(provider)) continue; // cooldown — fast-fail, auto-retry on expiry
    try {
      json = await ask();
    } catch (e) {
      engineTrack(provider, e);
      continue;
    }
    if (json) { engineOk(provider); model = provider; }
    else { engineTrack(provider, new Error(`${provider} no-json response`)); model = null; }
  }

  // ---- v18.8 KEYLESS LOCAL ENGINE (last in the chain, or FIRST under LLM_LOCAL_ONLY=1) ----
  // v20.6: 'ollama' is now part of the LLM_PRIORITY list (defaults to
  // last); under LLM_LOCAL_ONLY=1 it's the ONLY engine tried.
  // v21.0: ab NATIVE /api/chat path (num_ctx + keep_alive + format:json
  // + think-strip) — OpenAI-compat layer ka 4k silent-truncation fix.
  const tryOllama = !json && !engineSkip('ollama') && order.includes('ollama');
  if (tryOllama) {
    const reachable = await ollamaProbe().catch(() => false);
    if (reachable) {
      let threw = false;
      try {
        json = await askOllamaNative(prompt, { deep });
      } catch (e) {
        threw = true;
        engineTrack('ollama', e);
      }
      if (json) {
        engineOk('ollama');
        // v21.0.3 HONEST MODEL ATTRIBUTION: sirf 'ollama' provider-name
        // ke bajaye ab REAL model naam jata hai — scan path
        // ollama:qwen3:8b, deep path ollama:deepseek-r1:14b (🔬 modal
        // ka "AI COUNCIL · ollama" ab sach me kaunsa model bola wo
        // dikhata hai; user request: "konsa local ollama model use ho
        // raha hai accurately show hona chahiye").
        model = `ollama:${ollamaCompatCfg({ deep }).defModel}`;
      }
      else if (!threw) { engineTrack('ollama', new Error('ollama no-json response')); }
    }
  }
  return { json, model };
}

/**
 * v20.6.1: deep-analysis variant of councilAsk. Identical to councilAsk
 * EXCEPT it uses OLLAMA_DEEP_MODEL (e.g. deepseek-r1:14b) instead of
 * OLLAMA_MODEL (e.g. qwen3:8b) for the local-engine leg. Designed for
 * the user's 16GB laptop setup:
 *   • scan path (signals.js board compute) → councilAsk → qwen3:8b
 *   • deep single-symbol analysis (getDeepSignal → /api/ai/deep/:sym)
 *     → councilAskDeep → deepseek-r1:14b (auto-swap on Ollama's side
 *     when OLLAMA_MAX_LOADED_MODELS=1; cost ~30-60s per transition).
 *
 * Cloud providers are tried FIRST (same chain as councilAsk) when
 * LLM_LOCAL_ONLY is unset. The deep-model swap only applies to the
 * local Ollama leg. The scan path NEVER triggers a swap → no perf hit.
 */
export async function councilAskDeep(prompt, deps) {
  return councilAsk(prompt, deps, { deep: true });
}

/**
 * v21.0 VISION SEAT — chart-screenshot analysis. Ollama me native
 * multimodal models (qwen2.5vl:7b / qwen3-vl:8b) ko chart image
 * + structured prompt milta hai; verdict STRICT JSON me aata hai
 * (format:'json' + think-strip native path se).
 * Cloud engines ke paas vision nahi hai (ye seat LOCAL-ONLY hai) —
 * model installed nahi → { json: null, model: null } (honest abstain,
 * sentinel-track nahi kyunki capability-missing failure nahi hai).
 * images: [base64, ...] (data-URL prefix ke BINA — Ollama format).
 */
export async function councilAskVision(prompt, images, _deps = null, opts = {}) {
  if (!Array.isArray(images) || images.length === 0) return { json: null, model: null };
  const visionModel = ollamaVisionModel();
  if (!visionModel) return { json: null, model: null };
  // v21.1.1 [audit C3]: isolated breaker ko FAST-FAIL me consult karo —
  // breaker arm tha par call se PEHLE check nahi hota tha, isliye cooldown
  // ke dauraan har vision request full 90s timeout tak jalati thi. Ab
  // cooldown = instant skip (expiry par auto-retry).
  if (engineSkip('ollama-vision')) return { json: null, model: null };
  const reachable = await ollamaProbe().catch(() => false);
  if (!reachable) return { json: null, model: null };
  // v21.0.6 [audit B2]: vision failures apna ALAG circuit breaker
  // ('ollama-vision') arm karte hain — pehle shared 'ollama' breaker
  // arm hota tha, isliye 2 weak-JSON vision calls board ke scan seat
  // (councilAsk ollama leg) ko 30s+ ke liye park kar deti thi.
  // engineSnapshot sirf SENTINEL_PROVIDERS dikhata hai, isliye
  // 'ollama-vision' breaker UI me nahi aata (sirf isolation ka kaam).
  try {
    const json = await askOllamaNative(prompt, {
      model: visionModel,
      images,
      system: 'You are an elite technical analyst reading a trading chart screenshot. Respond with STRICT JSON only.',
      timeoutMs: opts.timeoutMs || OLLAMA_TIMEOUT_MS,
    });
    if (json) { engineOk('ollama-vision'); return { json, model: `ollama:${visionModel}` }; }
    engineTrack('ollama-vision', new Error('ollama-vision no-json response'));
    return { json: null, model: null };
  } catch (e) {
    engineTrack('ollama-vision', e);
    return { json: null, model: null };
  }
}

export const __testables = { tryParseJson, _chainOrder, _localOnly, askOllamaNative, stripThinking };
