// ============================================================
// server/ai/shadowHarness.js — v21.29.0 R11 VALIDATION HARNESS
// ------------------------------------------------------------
// Shadow mode is only useful if its evidence is counted. This module:
//   • accumulates per-filter observations (decisions / would-block rate)
//   • exposes acceptance gates an operator must clear BEFORE flipping a
//     shadow flag to enforce
//   • replays deterministic rows through an evaluator and compares the
//     proposed action with a baseline action
//
// It NEVER flips a flag, writes config, or trades. `readyForReview` is a
// data threshold, not permission: the final rollout stays manual.
// ============================================================
export const SHADOW_HARNESS_VERSION = 'r11-v1';
export const SHADOW_MIN_DECISIONS = 50;
export const SHADOW_MAX_WOULD_BLOCK_PCT = 40;
export const SHADOW_MIN_WOULD_BLOCK_PCT = 1;

const MAX_SAMPLES = 10;

export function emptyShadowStats() { return {}; }

export function emptyShadowStat(filter = null) {
  return {
    filter: filter || null, decisions: 0, wouldBlock: 0,
    firstAt: null, lastAt: null, samples: [],
  };
}

/**
 * Append one observation. Only SHADOW observations are recorded — off
 * filters make no claims and enforce filters are no longer predictions.
 * The stats object is mutated (callers own persistence).
 */
export function recordShadowDecision(stats, {
  filter = null, mode = 'shadow', wouldBlock = false, reason = null,
  symbol = null, market = null, at = Date.now(),
} = {}) {
  const target = stats && typeof stats === 'object' ? stats : null;
  if (!target || !filter) return target;
  if (String(mode || '').trim().toLowerCase() !== 'shadow') return target;
  const s = target[filter] || emptyShadowStat(filter);
  s.decisions += 1;
  if (wouldBlock) s.wouldBlock += 1;
  const ts = Number(at) > 0 ? Number(at) : Date.now();
  if (!(s.firstAt > 0)) s.firstAt = ts;
  s.lastAt = Math.max(Number(s.lastAt) || 0, ts);
  s.samples.push({
    at: ts, symbol: symbol ? String(symbol).slice(0, 24) : null,
    market: market ? String(market).toUpperCase().slice(0, 16) : null,
    wouldBlock: wouldBlock === true,
    reason: reason ? String(reason).slice(0, 160) : null,
  });
  if (s.samples.length > MAX_SAMPLES) s.samples = s.samples.slice(-MAX_SAMPLES);
  target[filter] = s;
  return target;
}

/** Per-filter summary + acceptance-gate verdict. */
export function summarizeShadowStats(stats = {}, {
  minDecisions = SHADOW_MIN_DECISIONS,
  minWouldBlockPct = SHADOW_MIN_WOULD_BLOCK_PCT,
  maxWouldBlockPct = SHADOW_MAX_WOULD_BLOCK_PCT,
  now = Date.now(),
} = {}) {
  const filters = [];
  const all = stats && typeof stats === 'object' ? stats : {};
  for (const key of Object.keys(all)) {
    const s = all[key] || {};
    const decisions = Math.max(0, Number(s.decisions) || 0);
    const wouldBlock = Math.max(0, Number(s.wouldBlock) || 0);
    const wouldBlockPct = decisions > 0 ? Math.round((wouldBlock / decisions) * 1000) / 10 : 0;
    const lastAt = Number(s.lastAt) > 0 ? Number(s.lastAt) : null;
    filters.push({
      filter: key,
      decisions,
      wouldBlock,
      wouldBlockPct,
      firstAt: Number(s.firstAt) > 0 ? Number(s.firstAt) : null,
      lastAt,
      ageMin: lastAt ? Math.max(0, Math.round((Number(now) - lastAt) / 60_000)) : null,
      samples: Array.isArray(s.samples) ? s.samples.slice(-MAX_SAMPLES) : [],
    });
  }
  filters.sort((a, b) => b.decisions - a.decisions);
  const decisions = filters.reduce((n, f) => n + f.decisions, 0);
  const wouldBlock = filters.reduce((n, f) => n + f.wouldBlock, 0);
  const gates = filters.map((f) => {
    const reasons = [];
    if (f.decisions < minDecisions) reasons.push(`decisions ${f.decisions}/${minDecisions}`);
    if (f.wouldBlockPct < minWouldBlockPct && f.decisions >= minDecisions) reasons.push(`would-block ${f.wouldBlockPct}% < ${minWouldBlockPct}% — filter never/rarely fires`);
    if (f.wouldBlockPct > maxWouldBlockPct) reasons.push(`would-block ${f.wouldBlockPct}% > ${maxWouldBlockPct}% — too aggressive`);
    return {
      filter: f.filter,
      readyForReview: reasons.length === 0,
      reasons,
    };
  });
  return {
    version: SHADOW_HARNESS_VERSION,
    generatedAt: Number(now),
    totals: {
      filters: filters.length,
      decisions,
      wouldBlock,
      wouldBlockPct: decisions > 0 ? Math.round((wouldBlock / decisions) * 1000) / 10 : 0,
    },
    thresholds: { minDecisions, minWouldBlockPct, maxWouldBlockPct },
    filters,
    gates,
    // Explicit: evidence is not consent. A human still flips the flag.
    note: 'Shadow evidence only — no flag is auto-flipped. Review gates, then change one flag at a time (paper first).',
  };
}

/** Convenience wrapper used by status/telemetry callers. */
export function shadowHarnessView(stats = {}, opts = {}) {
  const summary = summarizeShadowStats(stats, opts);
  const ready = summary.gates.filter(g => g.readyForReview).map(g => g.filter);
  return {
    ok: true,
    ...summary,
    readyForReview: ready,
    manualReviewRequired: true,
  };
}

// ------------------------------------------------------------
// Replay: deterministic rows → proposed vs baseline action
// ------------------------------------------------------------
function normalizeAction(decision) {
  if (typeof decision === 'boolean') return decision ? 'block' : 'allow';
  if (decision && typeof decision === 'object') {
    const action = decision.action ?? decision.verdict ?? decision.recommendation;
    if (action != null) return String(action).toLowerCase();
    if (typeof decision.wouldBlock === 'boolean') return decision.wouldBlock ? 'block' : 'allow';
    if (typeof decision.blocked === 'boolean') return decision.blocked ? 'block' : 'allow';
  }
  return 'allow';
}

/**
 * Replay rows through a proposed evaluator and a baseline action/evaluator.
 * Pure: no IO, no clock dependence beyond `now` stamps.
 *
 * @returns {{n:number, proposedTally:object, baselineTally:object, blocks:number,
 *   agree:number, disagreement:number, agreementPct:number, blockRatePct:number,
 *   examples:Array, disagreements:Array, readyForReview:boolean}}
 */
export function replayShadowSeries(rows = [], {
  evaluate, baseline = 'allow', minDecisions = SHADOW_MIN_DECISIONS, now = Date.now(),
  minWouldBlockPct = SHADOW_MIN_WOULD_BLOCK_PCT, maxWouldBlockPct = SHADOW_MAX_WOULD_BLOCK_PCT,
} = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const proposedTally = {};
  const baselineTally = {};
  const examples = [];
  const disagreements = [];
  let agree = 0;
  let blocks = 0;
  let baselineBlocks = 0;
  for (const row of source) {
    let proposed = 'allow';
    let base = 'allow';
    let reason = null;
    try {
      const d = typeof evaluate === 'function' ? evaluate(row) : evaluate;
      proposed = normalizeAction(d);
      reason = d && typeof d === 'object' ? (d.reason ?? null) : null;
    } catch (e) {
      proposed = 'error';
      reason = String(e?.message || e);
    }
    try {
      const b = typeof baseline === 'function' ? baseline(row) : baseline;
      base = normalizeAction(b);
    } catch { base = 'error'; }
    proposedTally[proposed] = (proposedTally[proposed] || 0) + 1;
    baselineTally[base] = (baselineTally[base] || 0) + 1;
    if (proposed === 'block') {
      blocks += 1;
      if (examples.length < 10) examples.push({ at: Number(now), row: row?.symbol ?? null, action: proposed, reason });
    }
    if (base === 'block') baselineBlocks += 1;
    if (proposed === base) agree += 1;
    else if (disagreements.length < 10) {
      disagreements.push({ at: Number(now), row: row?.symbol ?? null, proposed, baseline: base, reason });
    }
  }
  const n = source.length;
  const blockRatePct = n > 0 ? Math.round((blocks / n) * 1000) / 10 : 0;
  return {
    n,
    proposedTally,
    baselineTally,
    blocks,
    baselineBlocks,
    agree,
    disagreement: n - agree,
    agreementPct: n > 0 ? Math.round((agree / n) * 1000) / 10 : 0,
    blockRatePct,
    examples,
    disagreements,
    readyForReview: n >= minDecisions
      && blockRatePct >= minWouldBlockPct
      && blockRatePct <= maxWouldBlockPct,
    note: n >= minDecisions
      ? 'replay sample large enough for review — inspect examples before enforce'
      : `need ${Math.max(0, minDecisions - n)} more rows before review`,
  };
}
