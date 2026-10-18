// ============================================================
// server/bots/aiProviders.js — v21.14.0 (Laya removal)
// ------------------------------------------------------------
// AI provider REGISTRY: sirf Jev (TypeSafe cloud) — createJev
// engine se banta hai (providerConfig('jev')).
//
//   buildProviders(env, { stateDir }) -> { jev }
//     jev : createJev instance | null   (TYPESAFE_API_KEY na ho to null)
//
// v21.14.0: Laya (local open-weight provider) PERMANENTLY REMOVED.
// Purane LAYA_* env vars ab padhe hi nahi jate; laya_cache.jsonl /
// laya_autolink.json runtime artifacts ignore ho jaate hain. Null
// jev kabhi silent nahi rehta — botRunner availability-resolve
// arm_fallback event file me daalta hai, routes 409 dete hain.
//
// Ground rules (dual-provider plan §3.1) jo YE layer enforce karta hai:
//   • AI sirf ENTRY decisions pe (flat position), side flip / sizing /
//     SL/TP kabhi nahi — createJev ke andar code-enforced hai
//   • provider ka apna threshold (confidence formula engine me hai)
//   • provider cache file (jev_cache.jsonl) — replays free
// ============================================================
import path from 'node:path';
import { createJev, providerConfig } from './jevEngine.js';

/**
 * Build the provider registry from env.
 * @param {object} env process.env (ya test env object)
 * @param {object} opts { stateDir } — cache files yahan banti hain
 */
export function buildProviders(env = process.env, { stateDir } = {}) {
  const out = { jev: null };
  const dir = stateDir || '.';
  const jcfg = providerConfig('jev', env);
  if (jcfg.apiKey) {
    out.jev = createJev({ ...jcfg, cachePath: path.join(dir, 'jev_cache.jsonl') });
  }
  return out;
}

/**
 * AI mode config: AI_PRIMARY / AI_SHADOW / AI_CONSENSUS_ON_DOWN.
 * Invalid values safe defaults pe girti hain. v21.14: sirf jev hi
 * provider hai, isliye primary/shadow dono 'jev' ya 'off' hote hain.
 */
export function aiModeConfig(env = process.env) {
  const primary = 'jev';
  const shadowRaw = String(env.AI_SHADOW || 'off').toLowerCase();
  const shadow = shadowRaw === 'jev' ? 'jev' : 'off';
  const onDown = String(env.AI_CONSENSUS_ON_DOWN || 'wait').toLowerCase() === 'single' ? 'single' : 'wait';
  return { primary, shadow, onDown };
}

/** One provider's health block (for GET /api/bots/ai/health + healthMonitor). */
function _oneHealth(p) {
  if (!p || typeof p !== 'function' || typeof p.stats !== 'function') {
    return { configured: false, reachable: false, breakerOpen: false, rejects: 0 };
  }
  const s = p.stats();
  const breakerOpen = s.breakerOpen === true;
  return {
    configured: true,
    // honest definition: instance hai + breaker open nahi. (Live ping nahi —
    // health endpoint har request pe paid call jala dega; breaker hi
    // "real failures" ka accumulated signal hai.)
    reachable: !breakerOpen,
    breakerOpen,
    p50: s.p50 ?? null,
    p95: s.p95 ?? null,
    calls: s.calls ?? 0,
    cacheHits: s.cacheHits ?? 0,
    errors: s.errors ?? 0,
    rejects: s.rejects ?? 0,
    model: s.model ?? '',
    urlHost: s.url ?? '',
    threshold: s.threshold ?? null,
    name: s.name ?? null,
    // FIFO gate telemetry (agar concurrency configured ho) —
    // OpsHealthStrip AI chip me dikhta hai.
    queueWaits: s.queueWaits ?? 0,
    concurrency: s.concurrency ?? 0,
  };
}

/**
 * Per-provider health snapshot.
 * @param {object} providers { jev } (instance ya null)
 */
export function providerHealth(providers = {}) {
  return {
    jev: _oneHealth(providers?.jev),
    at: new Date().toISOString(),
  };
}
