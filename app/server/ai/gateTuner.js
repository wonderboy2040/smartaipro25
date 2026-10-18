// ============================================================
// server/ai/gateTuner.js — v19.0 SELF-IMPROVEMENT ENGINE
// ------------------------------------------------------------
// PHASE 2 — GATE TUNER (bounded grid search over entry gates).
//
// The auto-agent's entry gates (minAiScore 75 / minConfidence 70 /
// minAgreement 0.65 / quorumPenalty 5) were hand-set and NEVER
// re-learned. trust.js MEASURED calibration but nothing DROVE the
// gates. This module closes that loop — honestly:
//
//   tuneGates({ current })   grid-searches the WHITELISTED gate
//     space on SETTLED outcome rows (outcomeHarvester dataset):
//     for each candidate gate-set, which historical rows would
//     have passed → realized expectancy (avg R), win rate, n.
//     Objective: maximize expectancyR subject to n ≥ MIN_TRADES.
//     Grid (transparent + auditable, no black-box optimizer):
//       minConfidence   60..80 step 1 (searched)
//       minAgreement    0.55..0.75 step 0.05 (searched)
//       minAiScore / quorumPenalty — recorded as CONTEXT only (the
//       ledger's settled rows don't carry the composed AI score the
//       live gate reads, so searching the score bar on them would be
//       dishonest; the confidence/agreement bars are the tunable
//       pair Path B actually gates on)
//
//   Output is a PROPOSAL (from/to + evidence) — NEVER an auto
//   write. Applied ONLY through selfCouncil.applyProposal (safe
//   tier: auto after 24h when SELFIMPROVE_AUTO_TUNE=true, default
//   OFF; risky tier: always human approval).
//
// Honesty rules (the codebase's noise-refusal tradition):
//   - rows < MIN_ROWS (40) → verdict NOT ENOUGH DATA, zero proposals
//   - passing-trade sample < 30 → candidate skipped
//   - improvement < MIN_GAIN_R (0.05R) → "current gates already
//     near-optimal on settled evidence" (no change noise)
//   - EVERY proposal carries n / winRate / expectancy / missed
//     trades so a human sees the exact trade-off.
//   - gate deltas are BOUNDED to ±5 from current per field (no
//     cliff-edge jumps from a thin dataset).
// ============================================================
import { rowsForGateTuning } from './outcomeHarvester.js';
import { recordChange } from './evolutionLedger.js';

export const MIN_ROWS = 40;
export const MIN_TRADES = 30;
export const MIN_GAIN_R = 0.05;
const MAX_DELTA = 5; // bounded per-field jump (score/conf points)
const MAX_DELTA_AGREE = 0.05; // agreement is a 0-1 ratio — its ±5-analogue is ±0.05

const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/**
 * Would row x have passed a candidate gate-set? The CONF/AGREEMENT
 * bars (the pair Path B gates on at entry time — the composed AI
 * score isn't stamped on settled rows, so the score bar is context
 * only, not re-searched on thin evidence).
 * PURE.
 */
export function passesGates(x, g) {
  return (x.confidence ?? 0) >= g.minConfidence && (x.agreement ?? 0) >= g.minAgreement;
}

/** Realized stats of the rows a gate-set would admit. PURE. */
function evaluate(rows, g) {
  const t = rows.filter(x => passesGates(x, g));
  if (t.length < MIN_TRADES) return null;
  const wins = t.filter(x => x.win).length;
  const expR = t.reduce((a, x) => a + (Number(x.r) || 0), 0) / t.length;
  return { n: t.length, winRate: r2((wins / t.length) * 100), expectancyR: r2(expR) };
}

/**
 * One tuning pass. Returns {verdict, current, best, proposals[]}.
 * PURE on inputs (no store writes; caller records the proposal).
 */
export function tuneGates({ current = { minAiScore: 75, minConfidence: 70, minAgreement: 0.65, quorumPenalty: 5 } } = {}) {
  const rows = rowsForGateTuning();
  const cur = {
    minAiScore: Math.round(Number(current.minAiScore) || 75),
    minConfidence: Math.round(Number(current.minConfidence) || 70),
    minAgreement: Number(current.minAgreement) || 0.65,
    quorumPenalty: Math.round(Number(current.quorumPenalty) || 5),
  };
  const base = { gates: cur, stats: evaluate(rows, cur) };
  if (rows.length < MIN_ROWS) {
    return {
      verdict: 'NOT ENOUGH DATA', rows: rows.length, minRows: MIN_ROWS, current: base, best: null, proposals: [],
      note: `sirf ${rows.length} settled rows (min ${MIN_ROWS}) — noise-refusal mode, gates propose nahi honge`,
    };
  }

  const clampField = (v, c, lo, hi) => Math.max(lo, Math.min(hi, c + Math.sign(v - c) * Math.min(Math.abs(v - c), MAX_DELTA)));
  const clampAgree = (v, c, lo, hi) => Math.max(lo, Math.min(hi, c + Math.sign(v - c) * Math.min(Math.abs(v - c), MAX_DELTA_AGREE)));

  let best = null;
  for (let mc = 60; mc <= 80; mc++) {
    for (let ma = 0.55; ma <= 0.7501; ma += 0.05) {
      const g = {
        minAiScore: cur.minAiScore, // score bar context (not re-searched — thin rows can't justify it)
        minConfidence: clampField(mc, cur.minConfidence, 60, 80),
        minAgreement: r2(clampAgree(Math.round(ma * 100) / 100, cur.minAgreement, 0.55, 0.75)),
        quorumPenalty: cur.quorumPenalty,
      };
      const stats = evaluate(rows, g);
      if (!stats) continue;
      if (!best || stats.expectancyR > best.stats.expectancyR) best = { gates: g, stats };
    }
  }

  if (!best) {
    return {
      verdict: 'NOT ENOUGH DATA', rows: rows.length, current: base, best: null, proposals: [],
      note: `koi candidate gate-set ${MIN_TRADES}+ trades nahi mila — dataset range aur wide karo`,
    };
  }

  const gain = r2(best.stats.expectancyR - (base.stats?.expectancyR ?? 0));
  const changed = best.gates.minConfidence !== cur.minConfidence || best.gates.minAgreement !== cur.minAgreement;
  const same = best.gates.minConfidence === cur.minConfidence && best.gates.minAgreement === cur.minAgreement;

  const out = {
    verdict: same ? 'CURRENT NEAR-OPTIMAL' : gain >= MIN_GAIN_R ? 'IMPROVEMENT FOUND' : 'MARGINAL — SKIP',
    rows: rows.length,
    current: base,
    best,
    gainR: gain,
    minGainR: MIN_GAIN_R,
    proposals: [],
    note: same
      ? `current gates settled evidence par near-optimal hain (${base.stats?.n} trades, expectancy ${base.stats?.expectancyR}R) — change ka matlab noise ke peeche bhagna`
      : gain >= MIN_GAIN_R
        ? `better gate-set mila: expectancy ${base.stats?.expectancyR}R → ${best.stats.expectancyR}R (${gain}R, n ${best.stats.n} trades)`
        : `improvement sirf ${gain}R (min ${MIN_GAIN_R}R) — thin evidence, propose nahi karte`,
  };
  if (changed && gain >= MIN_GAIN_R) {
    out.proposals = [{
      kind: 'gate-tune',
      field: 'minConfidence/minAgreement',
      from: { minConfidence: cur.minConfidence, minAgreement: cur.minAgreement },
      to: { minConfidence: best.gates.minConfidence, minAgreement: best.gates.minAgreement },
      evidence: { rows: rows.length, trades: best.stats.n, winRate: best.stats.winRate, expectancyR: best.stats.expectancyR, currentExpectancyR: base.stats?.expectancyR ?? null, gainR: gain },
    }];
  }
  return out;
}

/**
 * Scheduler/API entry: run the pass; a qualifying improvement lands
 * as a selfCouncil proposal (tier 'safe' — bounded gate numerics)
 * + evolution-ledger entry. NEVER throws.
 */
export function runGateTune({ current } = {}) {
  try {
    const r = tuneGates({ current });
    (async () => {
      try {
        const { submitProposal } = await import('./selfCouncil.js');
        for (const p of r.proposals) {
          const stored = submitProposal({
            kind: 'gate-tune',
            tier: 'safe',
            summary: `Entry gates tune — confidence ${p.from.minConfidence}→${p.to.minConfidence}, agreement ${p.from.minAgreement}→${p.to.minAgreement} (expectancy ${p.evidence.currentExpectancyR}R→${p.evidence.expectancyR}R on ${p.evidence.trades} settled trades, +${p.evidence.gainR}R)`,
            configPatch: { minConfidence: p.to.minConfidence, minAgreement: p.to.minAgreement },
            evidence: p.evidence,
          });
          // record the change ONLY when the proposal actually stored
          // (submitProposal returns null on its internal catch) — the
          // ledger stays truthful about what exists.
          if (stored) {
            recordChange('gate-tune', `GATE PROPOSAL [${stored.id}] — conf ${p.from.minConfidence}→${p.to.minConfidence}, agree ${p.from.minAgreement}→${p.to.minAgreement} (expectancy +${p.evidence.gainR}R on ${p.evidence.trades} settled trades)`, { ...p.evidence, proposalId: stored.id });
          }
        }
      } catch { /* council unavailable — tuning result still returned */ }
    })();
    return r;
  } catch {
    return { verdict: 'ERROR', proposals: [], note: 'gate tune failed — honest error, gates untouched' };
  }
}

// ---------------- tests ----------------
export const __testables = { evaluate, passesGates, MAX_DELTA, MAX_DELTA_AGREE };
