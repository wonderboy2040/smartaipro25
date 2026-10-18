// ============================================================
// server/ai/consensus.js — v11.0 PHASE 2 · CONSENSUS + PRECISION GATE
// ------------------------------------------------------------
// Layer 4 of the Global Market Council. PURE synchronous math
// (<5ms) over the 6 specialist verdicts:
//
//   score       = Σ(w_i × conf_i × dir_i) / Σ(w_i)     ∈ [-100, +100]
//   confidence  = |score|
//   direction   = LONG | SHORT | NEUTRAL (sign of score)
//   agreement   = aligned votes / total votes (count-based)
//   quorum      = roles that returned a verdict (abstain ≠ NEUTRAL)
//
// Then the PRECISION GATE decides publish vs suppress:
//   conf ≥ 78 (AI_PRECISION_GATE_CONF)
//   agreement ≥ 0.70 (AI_PRECISION_GATE_AGREEMENT)
//   quorum ≥ 5/6 (Risk Guardian may vote NEUTRAL, never absent)
//   regime aligned · eventGuard not blackout · globalRisk not off
//   risk veto null
//   direction-split check: the weak side's bar rises +5
//
// Suppressed verdicts go to the NEAR-MISS JOURNAL (bounded, durable)
// — the weekly review's learning input: "gate sahi tha ya over-strict?"
//
// 95% is a PRECISION TARGET engineered by publishing FEWER tickets,
// never a claimed win-rate. Quality over quantity, by design.
// ============================================================
import crypto from 'node:crypto';
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';

// ---------------- roles + base weights ----------------
export const COUNCIL_ROLES = {
  technical: { id: 'technical', name: 'Technical Analyst', baseWeight: 1.0 },
  macro: { id: 'macro', name: 'Macro Economist', baseWeight: 0.9 },
  sentiment: { id: 'sentiment', name: 'Sentiment Analyst', baseWeight: 0.8 },
  optionsflow: { id: 'optionsflow', name: 'Options Flow Desk', baseWeight: 0.9 },
  onchain: { id: 'onchain', name: 'On-Chain Analyst', baseWeight: 0.8 },
  risk: { id: 'risk', name: 'Risk Guardian', baseWeight: 1.1 },
};
export const ROLE_IDS = Object.keys(COUNCIL_ROLES);

// ---------------- gate thresholds (env-tunable, A/B arms) ----------------
// v11.0 Phase 4: the AUTO-TIGHTEN override — when published precision
// runs < 75% for 3 consecutive weeks, the weekly review raises the
// confidence bar (+5, cumulative cap +10) via a durable override so the
// gate tightens itself until precision recovers (≥85% resets it).
// AI_PRECISION_GATE_AUTO_TIGHTEN=off disables the mechanism entirely.
const GATE_OVERRIDE_FILE = 'council-gate-override.json';
const GATE_TIGHTEN_MAX = 10;

function loadGateOverride() {
  try {
    const o = loadJSON(GATE_OVERRIDE_FILE, {});
    if (o && Number.isFinite(Number(o.confAdd)) && Number(o.confAdd) > 0) {
      return { confAdd: Math.min(GATE_TIGHTEN_MAX, Math.round(Number(o.confAdd))), setAt: o.setAt || null, reason: o.reason || null };
    }
  } catch { /* fresh default */ }
  return { confAdd: 0, setAt: null, reason: null };
}

function autoTightenEnabled() {
  return String(process.env.AI_PRECISION_GATE_AUTO_TIGHTEN || '').toLowerCase() !== 'off';
}

export function gateThresholds() {
  const base = Math.max(50, Math.min(95, Number(process.env.AI_PRECISION_GATE_CONF) || 78));
  const o = loadGateOverride();
  const confAdd = autoTightenEnabled() ? o.confAdd : 0;
  return {
    minConfidence: Math.min(97, base + confAdd),
    minAgreement: Math.max(0.5, Math.min(1, Number(process.env.AI_PRECISION_GATE_AGREEMENT) || 0.70)),
    quorumVotes: Math.max(3, Math.min(6, Number(process.env.AI_PRECISION_GATE_QUORUM) || 5)),
    // the statistically-weak direction's bar rises by this many points
    weakSidePenalty: 5,
    ...(confAdd > 0 ? { autoTightened: confAdd, autoTightenReason: o.reason } : {}),
  };
}

/** Phase 4: raise the gate after a precision breach streak (weekly review
 *  calls this). Bounded +10 cumulative. Returns the new override. */
export function autoTightenGate(reason) {
  if (!autoTightenEnabled()) return { confAdd: 0, disabled: true };
  const cur = loadGateOverride();
  const next = {
    confAdd: Math.min(GATE_TIGHTEN_MAX, (cur.confAdd || 0) + 5),
    setAt: Date.now(),
    reason: String(reason || 'precision-breach-streak').slice(0, 120),
  };
  try {
    saveJSON(GATE_OVERRIDE_FILE, next);
    try { durablePut(GATE_OVERRIDE_FILE, next); } catch { /* best-effort */ }
  } catch { /* read-only fs — in-memory effect lost, honest */ }
  return next;
}

/** Phase 4: precision recovered (≥85%) → reset the override. */
export function resetGateTighten(reason) {
  try {
    const next = { confAdd: 0, setAt: Date.now(), reason: String(reason || 'precision-recovered').slice(0, 120) };
    saveJSON(GATE_OVERRIDE_FILE, next);
    try { durablePut(GATE_OVERRIDE_FILE, next); } catch { /* best-effort */ }
  } catch { /* best-effort */ }
  return { confAdd: 0, setAt: Date.now(), reason };
}

export function gateOverrideView() { return { ...loadGateOverride(), cap: GATE_TIGHTEN_MAX, enabled: autoTightenEnabled() }; }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const dirSign = (d) => {
  const s = String(d || '').toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 1;
  if (s === 'SHORT' || s === 'SELL') return -1;
  return 0;
};

// ---------------- weighted consensus ----------------
/**
 * Weighted voting over the 6 verdicts.
 * NEUTRAL = direction-ABSTAIN: the seat still counts in quorum + the
 * agreement denominator, but its weight leaves the SCORE denominator
 * (otherwise the Risk Guardian — designed to vote NEUTRAL — would cap
 * the council ceiling at ~80 forever, making the 78 gate a 2-point
 * sliver). Honest semantics: NEUTRAL seats abstain from direction.
 * @param {Record<string, {direction: string, confidence: number, veto?: string|null}>} verdicts
 * @param {{weights?: Record<string, number>, thresholds?: object}} opts
 *   weights: role → final weight (base × calibration — caller computes)
 */
export function weightedConsensus(verdicts, opts = {}) {
  const weights = opts.weights || {};
  const present = ROLE_IDS.filter(r => verdicts?.[r] && verdicts[r].direction != null);
  let wSum = 0, sSum = 0;
  for (const r of present) {
    const w = Number.isFinite(Number(weights[r])) && Number(weights[r]) > 0
      ? Number(weights[r])
      : COUNCIL_ROLES[r].baseWeight;
    const conf = clamp(Number(verdicts[r].confidence) || 0, 0, 100);
    const dir = dirSign(verdicts[r].direction);
    if (dir !== 0) {
      wSum += w;
      sSum += w * conf * dir;
    }
  }
  if (wSum <= 0) {
    return { score: 0, confidence: 0, direction: 'NEUTRAL', agreement: 0, quorum: present.length, voters: [], weightsUsed: {}, neutral: true };
  }
  const score = Math.round((sSum / wSum) * 10) / 10; // [-100, +100]
  const direction = score > 0 ? 'LONG' : score < 0 ? 'SHORT' : 'NEUTRAL';
  // agreement: count-based over ALL present seats (abstains count as
  // not-aligned — 5/6 aligned = 0.83, the honest ceiling with the Risk
  // Guardian structurally NEUTRAL)
  const aligned = present.filter(r => dirSign(verdicts[r].direction) === dirSign(direction)).length;
  const agreement = present.length > 0 ? Math.round((aligned / present.length) * 100) / 100 : 0;
  const weightsUsed = {};
  for (const r of present) {
    weightsUsed[r] = Number.isFinite(Number(weights[r])) && Number(weights[r]) > 0
      ? r2(Number(weights[r])) : COUNCIL_ROLES[r].baseWeight;
  }
  return {
    score,
    confidence: Math.round(Math.abs(score) * 10) / 10,
    direction,
    agreement,
    quorum: present.length,
    voters: present.map(r => ({
      role: r, name: COUNCIL_ROLES[r].name,
      direction: String(verdicts[r].direction).toUpperCase(),
      confidence: clamp(Number(verdicts[r].confidence) || 0, 0, 100),
    })),
    weightsUsed,
    neutral: direction === 'NEUTRAL',
  };
}

// ---------------- the precision gate ----------------
/**
 * The publish/suppress decision. EVERY check must pass for PASSED.
 * @param {object} consensus  weightedConsensus output
 * @param {{regimeAligned?: boolean|null, event?: {blocked?: boolean, haircut?: number|null},
 *          riskOff?: boolean, riskVeto?: string|null,
 *          directionSplit?: {LONG?: {n:number,winRate:number|null}, SHORT?: {n:number,winRate:number|null}},
 *          thresholds?: object}} ctx gate context
 */
export function precisionGate(consensus, ctx = {}) {
  const t = { ...gateThresholds(), ...(ctx.thresholds || {}) };
  const reasons = [];
  if (consensus.quorum < t.quorumVotes) reasons.push(`quorum ${consensus.quorum}/${ROLE_IDS.length} < ${t.quorumVotes}`);
  if (consensus.neutral) { reasons.push('council direction NEUTRAL'); }
  else {
    let bar = t.minConfidence;
    // direction-split honesty: the statistically weak side must clear a
    // HIGHER bar (the "SHORT side systematically galat" guard)
    const split = ctx.directionSplit?.[consensus.direction];
    if (split && Number(split.n) >= 10 && Number.isFinite(Number(split.winRate))) {
      const other = ctx.directionSplit?.[consensus.direction === 'LONG' ? 'SHORT' : 'LONG'];
      if (other && Number(other.n) >= 10 && Number.isFinite(Number(other.winRate))
        && Number(split.winRate) < Number(other.winRate) - 5) {
        bar += t.weakSidePenalty;
        reasons.push(`weak-side bar raised to ${bar} (${consensus.direction} split ${split.winRate}% vs ${other.winRate}%)`);
      }
    }
    if (consensus.confidence < bar) reasons.push(`confidence ${consensus.confidence} < ${bar}`);
    if (consensus.agreement < t.minAgreement) reasons.push(`agreement ${consensus.agreement} < ${t.minAgreement}`);
    // regime alignment: null (unknown) = neutral — neither block nor bonus
    if (ctx.regimeAligned === false) reasons.push('counter-regime');
  }
  if (ctx.riskVeto) reasons.push(`risk veto: ${ctx.riskVeto}`);
  if (ctx.event?.blocked) reasons.push('event blackout');
  if (ctx.riskOff) reasons.push('global risk-off');
  return {
    gate: reasons.length === 0 ? 'PASSED' : 'SUPPRESSED',
    reasons,
    thresholds: t,
    eventHaircut: ctx.event?.haircut ?? null,
  };
}

// ---------------- near-miss journal ----------------
const NEARMISS_FILE = 'council-nearmiss.json';
const NEARMISS_MAX = 200;

function loadNearMiss() { return loadJSON(NEARMISS_FILE, { entries: [] }); }
function saveNearMiss(n) {
  if (n.entries.length > NEARMISS_MAX) n.entries = n.entries.slice(-NEARMISS_MAX);
  saveJSON(NEARMISS_FILE, n);
  try { durablePut(NEARMISS_FILE, n); } catch { /* best-effort */ }
}

/**
 * Record a SUPPRESSED verdict (bounded, durable). The learning input
 * for the weekly review: "kitne suppressed signals sahi hote?"
 */
export function recordNearMiss({ market, symbol, consensus, gate, levels, plan, regime, model }) {
  try {
    if (!symbol || !consensus) return null;
    const n = loadNearMiss();
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      market: String(market || 'CRYPTO'),
      symbol: String(symbol),
      side: consensus.direction,
      score: consensus.score,
      confidence: consensus.confidence,
      agreement: consensus.agreement,
      quorum: consensus.quorum,
      gateReasons: gate?.reasons || [],
      voters: consensus.voters || [],
      levels: levels || null,
      plan: plan ? { entry: plan.entry ?? null, stopLoss: plan.stopLoss ?? null, target1: plan.target1 ?? null } : null,
      regime: regime || null,
      model: model || null,
    };
    n.entries.push(entry);
    saveNearMiss(n);
    return entry;
  } catch { return null; }
}

export function nearMissList(limit = 30, { sinceMs } = {}) {
  const n = loadNearMiss();
  let entries = n.entries || [];
  if (Number.isFinite(sinceMs)) entries = entries.filter(e => Number(e.ts) >= sinceMs);
  return entries.slice(-Math.min(Math.max(limit, 1), 100)).reverse();
}

export function nearMissStats() {
  const n = loadNearMiss();
  const entries = n.entries || [];
  const byReason = {};
  for (const e of entries) {
    for (const r of e.gateReasons || []) {
      const k = String(r).split(' ')[0].split('<')[0].slice(0, 24);
      byReason[k] = (byReason[k] || 0) + 1;
    }
  }
  return {
    total: entries.length,
    last24h: entries.filter(e => Date.now() - Number(e.ts) < 86_400_000).length,
    byReason: Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

// ---------------- full pipeline (consensus + gate in one) ----------------
/**
 * computeConsensus + precisionGate + near-miss recording.
 * @returns {{ consensus, gate, nearMissRecorded: boolean }}
 */
export function evaluateCouncil(verdicts, ctx = {}) {
  const consensus = weightedConsensus(verdicts, { weights: ctx.weights });
  const gate = precisionGate(consensus, ctx);
  let nearMissRecorded = false;
  if (gate.gate === 'SUPPRESSED' && ctx.recordNearMiss !== false && consensus.quorum > 0) {
    const rec = recordNearMiss({
      market: ctx.market, symbol: ctx.symbol, consensus, gate,
      levels: ctx.levels, plan: ctx.plan, regime: ctx.regime, model: ctx.model,
    });
    nearMissRecorded = !!rec;
  }
  return { consensus, gate, nearMissRecorded };
}

// ---------------- council weights (base × calibration) ----------------
/**
 * Merge base weights with per-agent calibration multipliers
 * (trust.js council stats, Bayesian-clamped like adaptive.js).
 * Bounded [0.6, 1.4] per agent — no single bad week destroys a seat.
 */
export function councilWeights(calibration) {
  const out = {};
  for (const r of ROLE_IDS) {
    const base = COUNCIL_ROLES[r].baseWeight;
    const cal = calibration?.[r];
    if (cal && Number.isFinite(Number(cal.mul)) && Number(cal.n) >= 8) {
      out[r] = Math.round(base * clamp(Number(cal.mul), 0.6, 1.4) * 100) / 100;
    } else {
      out[r] = base;
    }
  }
  return out;
}

// ---------------- test hooks ----------------
export function __setNearMissForTests(n) { saveNearMiss(n || { entries: [] }); }
export function __resetConsensusForTests() { saveNearMiss({ entries: [] }); }
export const __testables = { NEARMISS_FILE, NEARMISS_MAX, dirSign };
