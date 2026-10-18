// ============================================================
// server/ai/adaptive.js — SELF-CORRECTING MODEL WEIGHTS (v6.7)
// ------------------------------------------------------------
// Glama-inspired (oneqaz "Thompson Sampling on live outcomes"):
// the ensemble's STATIC model weights get a Bayesian multiplier
// learned from the ledger's settled outcomes:
//
//   posterior = Beta(α, β) mean,  α = wins + 1, β = losses + 1
//              (Laplace-smoothed — no data = 0.5, honest neutral)
//   multiplier = clamp(2 × posterior, 0.7, 1.3)
//              (posterior 0.5 → 1.0 exactly)
//
//   n < MIN_SAMPLE (8) → multiplier = 1.0 — NOT ENOUGH DATA, we
//   refuse to tune on noise. Honest by construction.
//
// Pure module — no storage, no network. Consumers:
//   signals.js  applies applyAdaptiveWeights(votes) before
//               aggregation so the whole board self-corrects
//   routes.js   /api/ai/status exposes the stats
// ============================================================
import { modelStats } from './ledger.js';

export const MIN_SAMPLE = 8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * Per-model multiplier map from live ledger outcomes.
 * @param {{model,wins,losses}[]} stats (ledger modelStats shape)
 * @returns {Record<string, {mul: number, n: number, posterior: number|null, hitRate: number|null}>}
 */
export function adaptiveMultipliers(stats) {
  const out = {};
  for (const s of stats || []) {
    const n = (s.wins || 0) + (s.losses || 0);
    if (n < MIN_SAMPLE) {
      out[s.model] = { mul: 1.0, n, posterior: null, hitRate: s.hitRate ?? null };
      continue;
    }
    const alpha = (s.wins || 0) + 1, beta = (s.losses || 0) + 1;
    const posterior = alpha / (alpha + beta);
    out[s.model] = {
      mul: clamp(2 * posterior, 0.7, 1.3),
      n,
      posterior: r2(posterior),
      hitRate: s.hitRate ?? null,
    };
  }
  return out;
}

/**
 * Apply the multipliers to a vote list (mutates nothing).
 * Adjusted votes carry `adaptiveMul` so the UI can show the
 * self-correction transparently ("×1.2 learned from 23 settled
 * trades"). dir=0 / weight≤0 votes pass through untouched.
 * @returns new votes array
 */
export function applyAdaptiveWeights(votes, multipliers) {
  const mul = multipliers || {};
  return (votes || []).map(v => {
    const m = v?.id ? mul[v.id] : null;
    if (!m || !v || v.dir === 0 || !(v.weight > 0)) return v;
    const w = v.weight * m.mul;
    return {
      ...v,
      weight: Math.round(w * 100) / 100,
      adaptiveMul: m.mul,
      adaptiveN: m.n,
    };
  });
}

/** Status block for /api/ai/status — transparent + honest. */
export function adaptiveStatus() {
  try {
    const stats = modelStats();
    const mul = adaptiveMultipliers(stats);
    const learning = Object.entries(mul).filter(([, m]) => m.posterior != null);
    return {
      enabled: learning.length > 0,
      minSample: MIN_SAMPLE,
      learning: learning.map(([model, m]) => ({ model, ...m })),
      stats: stats.map(s => ({ model: s.model, n: s.n, hitRate: s.hitRate })),
    };
  } catch {
    return { enabled: false, minSample: MIN_SAMPLE, learning: [], stats: [] };
  }
}
