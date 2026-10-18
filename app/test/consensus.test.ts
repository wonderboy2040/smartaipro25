// ============================================================
// test/consensus.test.ts — v11.0 PHASE 2 · CONSENSUS + PRECISION GATE
// ------------------------------------------------------------
// Locks the weighted-voting math (NEUTRAL abstain semantics), quorum
// boundaries (4/6 never publishes), the gate's no-cliff edges, the
// weak-side bar raise, veto/blackout/risk-off suppression, the
// near-miss journal, and the Phase-4 auto-tighten override.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f, d) => (_disk.has(f) ? _disk.get(f) : d),
  saveJSON: (f, v) => { _disk.set(f, v); },
}));
vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(),
  durableStatus: () => ({}),
}));

import {
  COUNCIL_ROLES, ROLE_IDS, weightedConsensus, precisionGate, evaluateCouncil,
  councilWeights, recordNearMiss, nearMissList, nearMissStats,
  gateThresholds, autoTightenGate, resetGateTighten, gateOverrideView,
  __resetConsensusForTests,
} from '../server/ai/consensus.js';

// A clean 6-seat verdict factory.
const V = (over = {}) => ({
  technical: { direction: 'LONG', confidence: 85 },
  macro: { direction: 'LONG', confidence: 80 },
  sentiment: { direction: 'NEUTRAL', confidence: 40 },
  optionsflow: { direction: 'LONG', confidence: 80 },
  onchain: { direction: 'LONG', confidence: 80 },
  risk: { direction: 'NEUTRAL', confidence: 70, veto: null },
  ...over,
});

beforeEach(() => {
  __resetConsensusForTests();
  delete process.env.AI_PRECISION_GATE_CONF;
  delete process.env.AI_PRECISION_GATE_AGREEMENT;
  delete process.env.AI_PRECISION_GATE_AUTO_TIGHTEN;
});

describe('v11.0 weighted consensus — the math', () => {
  it('all-aligned 85s → confidence 85, direction LONG (weights normalize)', () => {
    const v = V({
      technical: { direction: 'LONG', confidence: 85 },
      macro: { direction: 'LONG', confidence: 85 },
      sentiment: { direction: 'LONG', confidence: 85 },
      optionsflow: { direction: 'LONG', confidence: 85 },
      onchain: { direction: 'LONG', confidence: 85 },
      risk: { direction: 'LONG', confidence: 85 },
    });
    const c = weightedConsensus(v);
    expect(c.direction).toBe('LONG');
    expect(c.confidence).toBe(85);
    expect(c.agreement).toBe(1);
    expect(c.quorum).toBe(6);
  });

  it('NEUTRAL seats ABSTAIN from the score denominator but count in quorum + agreement', () => {
    // risk NEUTRAL(70) + sentiment NEUTRAL(40): only 4 direction voters
    // (85×1.0 + 80×0.9 + 80×0.9 + 80×0.8) / (1.0+0.9+0.9+0.8) = 293/3.6 = 81.4
    const c = weightedConsensus(V());
    expect(c.confidence).toBeCloseTo(81.4, 1);
    expect(c.quorum).toBe(6);            // all 6 seats present
    expect(c.agreement).toBeCloseTo(0.67, 2); // 4 aligned / 6 present
  });

  it('calibrated weights shift the score (a heavy seat pulls harder)', () => {
    const v = V({
      sentiment: { direction: 'SHORT', confidence: 90 },
      risk: { direction: 'LONG', confidence: 90 },
    });
    const flat = weightedConsensus(v, { weights: { technical: 1, macro: 1, sentiment: 1, optionsflow: 1, onchain: 1, risk: 1 } });
    const tilted = weightedConsensus(v, { weights: { technical: 1, macro: 1, sentiment: 2.5, optionsflow: 1, onchain: 1, risk: 1 } });
    expect(flat.confidence).toBeGreaterThan(tilted.confidence); // heavy bear seat drags LONG conf down
    expect(tilted.confidence).toBeGreaterThan(0);
  });

  it('empty/all-NEUTRAL councils return an honest neutral (no division by zero)', () => {
    const c = weightedConsensus({});
    expect(c.neutral).toBe(true);
    expect(c.confidence).toBe(0);
    expect(c.quorum).toBe(0);
    const c2 = weightedConsensus({ technical: { direction: 'NEUTRAL', confidence: 50 }, risk: { direction: 'NEUTRAL', confidence: 50 } });
    expect(c2.neutral).toBe(true);
  });

  it('SHORT majority flips the direction and the agreement denominator holds', () => {
    const c = weightedConsensus(V({
      technical: { direction: 'SHORT', confidence: 85 },
      macro: { direction: 'SHORT', confidence: 80 },
      optionsflow: { direction: 'SHORT', confidence: 80 },
      onchain: { direction: 'SHORT', confidence: 80 },
    }));
    expect(c.direction).toBe('SHORT');
    expect(c.score).toBeLessThan(0);
    expect(c.agreement).toBeCloseTo(0.67, 2);
  });
});

describe('v11.0 precision gate — boundaries + no-cliff edges', () => {
  it('a strong aligned council PASSES (conf 85 · agree 0.83 · quorum 6)', () => {
    const c = weightedConsensus(V({ sentiment: { direction: 'LONG', confidence: 75 } }));
    const g = precisionGate(c, { regimeAligned: true });
    expect(g.gate).toBe('PASSED');
    expect(g.reasons).toHaveLength(0);
  });

  it('quorum 4 NEVER publishes — even at confidence 99', () => {
    const four = {
      technical: { direction: 'LONG', confidence: 99 },
      macro: { direction: 'LONG', confidence: 99 },
      sentiment: { direction: 'LONG', confidence: 99 },
      risk: { direction: 'LONG', confidence: 99 },
    };
    const c = weightedConsensus(four);
    const g = precisionGate(c, { regimeAligned: true });
    expect(g.gate).toBe('SUPPRESSED');
    expect(g.reasons.join(' ')).toContain('quorum 4');
  });

  it('confidence boundary: exactly at the bar passes, one decimal under fails', () => {
    const ALL78 = {
      technical: { direction: 'LONG', confidence: 78 },
      macro: { direction: 'LONG', confidence: 78 },
      sentiment: { direction: 'LONG', confidence: 78 },
      optionsflow: { direction: 'LONG', confidence: 78 },
      onchain: { direction: 'LONG', confidence: 78 },
      risk: { direction: 'LONG', confidence: 78 },
    };
    const at = weightedConsensus(ALL78);
    expect(at.confidence).toBe(78);
    expect(precisionGate(at, { regimeAligned: true }).gate).toBe('PASSED');
    const under = weightedConsensus(V({
      technical: { direction: 'LONG', confidence: 77 },
      macro: { direction: 'LONG', confidence: 78 },
      sentiment: { direction: 'LONG', confidence: 78 },
      optionsflow: { direction: 'LONG', confidence: 78 },
      onchain: { direction: 'LONG', confidence: 78 },
      risk: { direction: 'LONG', confidence: 78 },
    }));
    expect(under.confidence).toBeLessThan(78);
    expect(precisionGate(under, { regimeAligned: true }).gate).toBe('SUPPRESSED');
  });

  it('agreement boundary: 0.67 fails, 0.83 passes (with conf above bar)', () => {
    const mixed = weightedConsensus(V({
      sentiment: { direction: 'SHORT', confidence: 88 },
    }));
    expect(mixed.agreement).toBeCloseTo(0.67, 2);
    expect(precisionGate(mixed, { regimeAligned: true }).gate).toBe('SUPPRESSED');
    const aligned = weightedConsensus(V({ sentiment: { direction: 'LONG', confidence: 88 } }));
    expect(precisionGate(aligned, { regimeAligned: true }).gate).toBe('PASSED');
  });

  it('counter-regime + event blackout + risk-off + veto each suppress independently', () => {
    const c = weightedConsensus(V({ sentiment: { direction: 'LONG', confidence: 85 } }));
    expect(precisionGate(c, { regimeAligned: false }).gate).toBe('SUPPRESSED');
    expect(precisionGate(c, { regimeAligned: true, event: { blocked: true } }).gate).toBe('SUPPRESSED');
    expect(precisionGate(c, { regimeAligned: true, riskOff: true }).gate).toBe('SUPPRESSED');
    expect(precisionGate(c, { regimeAligned: true, riskVeto: 'event_blackout' }).gate).toBe('SUPPRESSED');
    // haircut alone does NOT suppress (sizing happens in the gauntlet)
    const g = precisionGate(c, { regimeAligned: true, event: { haircut: 0.5 } });
    expect(g.gate).toBe('PASSED');
    expect(g.eventHaircut).toBe(0.5);
  });

  it('weak-side direction split raises the bar +5 (statistically weak side must clear more)', () => {
    // 5 direction voters SHORT at 80 (risk NEUTRAL abstains):
    // (80×(1.0+0.9+0.8+0.9+0.8)) / 4.4 = 80 — above the flat 78 bar
    const v = V({
      technical: { direction: 'SHORT', confidence: 80 },
      macro: { direction: 'SHORT', confidence: 80 },
      sentiment: { direction: 'SHORT', confidence: 80 },
      optionsflow: { direction: 'SHORT', confidence: 80 },
      onchain: { direction: 'SHORT', confidence: 80 },
    });
    const c = weightedConsensus(v);
    expect(c.direction).toBe('SHORT');
    expect(c.confidence).toBe(80);
    // control: no split → PASSES at 80
    expect(precisionGate(c, { regimeAligned: true }).gate).toBe('PASSED');
    // SHORT is the statistically weak side → bar 83 > 80 → suppressed
    const split = {
      LONG: { n: 30, winRate: 72 },
      SHORT: { n: 30, winRate: 50 },
    };
    const g = precisionGate(c, { regimeAligned: true, directionSplit: split });
    expect(g.gate).toBe('SUPPRESSED');
    expect(g.reasons.join(' ')).toContain('weak-side');
  });
});

describe('v11.0 near-miss journal + evaluateCouncil pipeline', () => {
  it('evaluateCouncil PASSED → consensus + gate wired, no near-miss record', () => {
    const { consensus, gate, nearMissRecorded } = evaluateCouncil(V({ sentiment: { direction: 'LONG', confidence: 85 } }), {
      market: 'CRYPTO', symbol: 'BTC', regimeAligned: true,
    });
    expect(consensus.direction).toBe('LONG');
    expect(gate.gate).toBe('PASSED');
    expect(nearMissRecorded).toBe(false);
    expect(nearMissList(10)).toHaveLength(0);
  });

  it('SUPPRESSED → durable near-miss entry with reasons + voters + levels', () => {
    const { gate, nearMissRecorded } = evaluateCouncil(V(), { market: 'CRYPTO', symbol: 'ETH', regimeAligned: true });
    expect(gate.gate).toBe('SUPPRESSED');
    expect(nearMissRecorded).toBe(true);
    const entries = nearMissList(10);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.symbol).toBe('ETH');
    expect(e.market).toBe('CRYPTO');
    expect(e.gateReasons.length).toBeGreaterThan(0);
    expect(e.voters.length).toBe(6);
    expect(e.confidence).toBeGreaterThan(0);
    expect(nearMissStats().total).toBe(1);
  });

  it('councilWeights: base weights by default; calibration engages only at n≥8, bounded 0.6-1.4', () => {
    const base = councilWeights({});
    expect(base.technical).toBe(COUNCIL_ROLES.technical.baseWeight);
    const calibrated = councilWeights({
      technical: { mul: 1.9, n: 50 },   // out-of-bound mul clamps to 1.4
      macro: { mul: 0.8, n: 8 },       // engages
      sentiment: { mul: 1.3, n: 3 },   // n<8 → base
    });
    expect(calibrated.technical).toBeCloseTo(1.4, 2);
    expect(calibrated.macro).toBeCloseTo(0.9 * 0.8, 2);
    expect(calibrated.sentiment).toBe(COUNCIL_ROLES.sentiment.baseWeight);
  });
});

describe('v11.0 Phase-4 auto-tighten override', () => {
  it('gate bar honors the env config (strict A/B arm 84)', () => {
    process.env.AI_PRECISION_GATE_CONF = '84';
    expect(gateThresholds().minConfidence).toBe(84);
  });

  it('autoTightenGate raises the effective bar (+5, cap +10) and reset clears it', () => {
    const before = gateThresholds().minConfidence;
    autoTightenGate('test-streak');
    expect(gateThresholds().minConfidence).toBe(before + 5);
    expect(gateThresholds().autoTightened).toBe(5);
    autoTightenGate('test-streak-2');
    expect(gateThresholds().minConfidence).toBe(before + 10); // capped
    autoTightenGate('test-streak-3');
    expect(gateThresholds().minConfidence).toBe(before + 10); // still capped
    resetGateTighten();
    expect(gateThresholds().minConfidence).toBe(before);
    expect(gateOverrideView().confAdd).toBe(0);
  });

  it('AI_PRECISION_GATE_AUTO_TIGHTEN=off disables the mechanism (reporting only)', () => {
    process.env.AI_PRECISION_GATE_AUTO_TIGHTEN = 'off';
    const before = gateThresholds().minConfidence;
    const out = autoTightenGate('should-not-apply');
    expect(out.disabled).toBe(true);
    expect(gateThresholds().minConfidence).toBe(before);
  });
});
