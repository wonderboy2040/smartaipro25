// ============================================================
// test/selfImproveEngine.test.ts — v19.0 SELF-IMPROVEMENT ENGINE
// ------------------------------------------------------------
// Locks the full Phase 1-5 loop contract:
//   1. EVOLUTION LEDGER — SHA-256 chain, tamper detection, kind
//      whitelist rejection, prune bound, never-throws.
//   2. OUTCOME HARVESTER — ledger settled rows → dataset (idempotent,
//      dedup by id), honest NOT-ENOUGH-DATA verdicts, by-market stats.
//   3. DRIFT MONITOR — PSI math, vote-drift old/new halves with
//      per-model floors, refuse-on-noise.
//   4. GATE TUNER — noise refusal (<40 rows), grid bounded to ±5
//      deltas, min-trades floor, proposal-only (config untouched).
//   5. SELF COUNCIL — tier classification, whitelist sanitization,
//      approve applies through updateAgentConfig (clamped), rollback
//      restores, kill-switch refuses, auto-24h only when opted in.
//   6. AGENT DESK SCOPE (user spec) — desks.spot default FALSE + the
//      one-time v19_0 migration (true→false once, user re-enable
//      survives after stamp) + exits independent of desk flags.
//   7. WIRING — routes.js endpoints + index.js scheduler markers +
//      council lessons injection (light-touch) + SelfImprovementPanel
//      exists and is mounted in CoinDcxTab.
// Hermetic: SMARTAI_DATA_DIR temp isolation (repo convention).
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../.test-data-v19si-${Date.now().toString(36)}-${process.pid}`);
mkdirSync(process.env.SMARTAI_DATA_DIR, { recursive: true });
delete process.env.SELFIMPROVE_ENABLED;
delete process.env.SELFIMPROVE_AUTO_TUNE;
delete process.env.SELFIMPROVE_AUTO_RETRAIN;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storePath = (f: string) => path.join(process.env.SMARTAI_DATA_DIR!, f);

// Dynamic imports AFTER env isolation (repo convention).
const evo = await import('../server/ai/evolutionLedger.js');
const harvester = await import('../server/ai/outcomeHarvester.js');
const drift = await import('../server/ai/driftMonitor.js');
const gateTuner = await import('../server/ai/gateTuner.js');
const councilMod = await import('../server/ai/selfCouncil.js');
const ledger = await import('../server/ai/ledger.js');
const agentMod = await import('../server/ai/agent.js');
const lessons = await import('../server/ai/lessonsEngine.js');

const agentSrc = readFileSync(path.join(repoRoot, 'server/ai/agent.js'), 'utf8');
const routesSrc = readFileSync(path.join(repoRoot, 'server/ai/routes.js'), 'utf8');
const indexSrc = readFileSync(path.join(repoRoot, 'server/index.js'), 'utf8');
const councilSrc = readFileSync(path.join(repoRoot, 'server/ai/council.js'), 'utf8');

// ---------------- helpers ----------------
function seedLedger(rows: Array<Record<string, unknown>>) {
  ledger.__setLedgerForTests({ entries: rows.map((r, i) => ({
    id: r.id || `e${i}`,
    ts: r.ts ?? Date.now() - (rows.length - i) * 3600000,
    market: r.market || 'CRYPTO',
    symbol: r.symbol || 'BTC',
    side: r.side || 'LONG',
    grade: r.grade || 'ACTION',
    confidence: r.confidence ?? 70,
    agreement: r.agreement ?? 0.7,
    mode: 'paper',
    source: 'agent',
    plan: { entry: 100, stopLoss: 95, target1: 110, target2: 120, riskPct: 1, rewardRisk: 2 },
    votes: r.votes || {},
    outcome: r.outcome,
    prevHash: null,
    hash: 'x',
  })) });
}

function seedDataset(rows: Array<Record<string, unknown>>) {
  harvester.__setDatasetForTests({ rows, harvestedIds: rows.map(x => x.id), lastHarvestAt: Date.now(), stats: null });
}

const mkRow = (over: Record<string, unknown> = {}) => ({
  id: `r${Math.random().toString(36).slice(2, 8)}`,
  ts: Date.now() - Math.random() * 86400000,
  market: 'CRYPTO', symbol: 'BTC', side: 'LONG', grade: 'ACTION',
  confidence: 65 + Math.floor(Math.random() * 20), agreement: 0.6 + Math.random() * 0.15,
  r: Math.random() > 0.5 ? 1.8 : -1, pnlINR: 100, reason: 'SL', exit: 95,
  win: Math.random() > 0.5, riskPct: 1, rewardRisk: 2,
  votes: { trend: { dir: 1, conf: 70 }, momentum: { dir: 1, conf: 65 }, rsiModel: { dir: -1, conf: 60 } },
  councilConfidence: null, councilAgreement: null, mode: 'paper',
  ...over,
});

beforeEach(() => {
  evo.__setEvolutionLedgerForTests({ entries: [] });
  seedDataset([]);
  process.env.SELFIMPROVE_ENABLED = undefined as unknown as string;
  delete process.env.SELFIMPROVE_ENABLED;
  delete process.env.SELFIMPROVE_AUTO_TUNE;
});

// ============ 1. EVOLUTION LEDGER ============
describe('v19.0 Phase 4 — evolution ledger (tamper-evident)', () => {
  it('chains entries with SHA-256 and verifies', () => {
    evo.recordChange('harvest', 'test one', { n: 1 });
    evo.recordChange('lesson', 'test two', { v: 2 });
    const st = evo.evolutionStatus();
    expect(st.total).toBe(2);
    expect(st.verified).toBe(true);
    expect(st.byKind.harvest).toBe(1);
    expect(st.byKind.lesson).toBe(1);
    expect(evo.verifyEvolutionLedger().ok).toBe(true);
  });

  it('detects tampering (chain breaks)', () => {
    evo.recordChange('retrain', 'entry', {});
    const raw = evo.__evolutionRaw();
    raw.entries[0].summary = 'HACKED';
    evo.__setEvolutionLedgerForTests(raw);
    const v = evo.verifyEvolutionLedger();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(0);
  });

  it('rejects unknown kinds (whitelist, never guessed)', () => {
    expect(evo.recordChange('delete-ledger' as never, 'hax', {})).toBeNull();
    expect(evo.evolutionStatus().total).toBe(0);
  });

  it('never throws + records recent changes', () => {
    evo.recordChange('self-repair', 'a', {});
    const rec = evo.recentChanges(10);
    expect(rec.length).toBe(1);
    expect(rec[0].kind).toBe('self-repair');
    expect(() => evo.recentChanges(-1)).not.toThrow();
  });

  it('v19.0.1: pruning re-anchors the chain (no eternal false tamper alarm past 600)', () => {
    for (let i = 0; i < 605; i++) evo.recordChange('harvest', `bulk ${i}`, { i });
    const v = evo.verifyEvolutionLedger();
    expect(v.ok).toBe(true); // re-anchored head — chain verifies after prune
    expect(evo.evolutionStatus().total).toBeLessThanOrEqual(600);
    expect(evo.evolutionStatus().verified).toBe(true);
  });
});

// ============ 2. OUTCOME HARVESTER ============
describe('v19.0 Phase 1 — outcome harvester', () => {
  it('harvests settled ledger rows into the dataset (idempotent, dedup)', () => {
    seedLedger([
      { id: 'a1', outcome: { r: 2.1, pnlINR: 500, reason: 'T2', exit: 120 } },
      { id: 'a2', outcome: { r: -1, pnlINR: -200, reason: 'SL', exit: 95 } },
      { id: 'a3', outcome: null }, // not settled yet — no row, retried later
    ]);
    const h1 = harvester.harvestOutcomes();
    expect(h1.ok).toBe(true);
    expect(h1.added).toBe(2);
    const h2 = harvester.harvestOutcomes(); // idempotent
    expect(h2.added).toBe(0);
    expect(h2.total).toBe(2);
    const rows = harvester.__datasetRaw().rows;
    expect(rows.find(x => x.id === 'a1')?.win).toBe(true);
    expect(rows.find(x => x.id === 'a2')?.win).toBe(false);
  });

  it('v19.0.1: harvests from the RAW ledger (votes + agreement flow — recentEntries projection would starve the pipeline)', () => {
    seedLedger([{
      id: 'raw1',
      agreement: 0.72,
      votes: { trend: { dir: 1, conf: 70 }, momentum: { dir: -1, conf: 60 } },
      outcome: { r: 1.5, pnlINR: 300, reason: 'T1', exit: 110 },
    }]);
    harvester.harvestOutcomes();
    const row = harvester.__datasetRaw().rows.find(x => x.id === 'raw1');
    expect(row?.agreement).toBeCloseTo(0.72, 2); // the field gate-tuning filters on
    expect(row?.votes?.trend?.dir).toBe(1);      // the field PSI drift reads
    expect(row?.votes?.momentum?.dir).toBe(-1);
  });

  it('v19.0.1: r:null outcomes (unsettled risk) are EXCLUDED, never fake 0R losses', () => {
    seedLedger([
      { id: 'n1', outcome: { r: null, pnlINR: 0, reason: 'CLOSED', exit: 100 } }, // settlePositionOutcome's no-risk path
      { id: 'n2', outcome: { r: 1, pnlINR: 50, reason: 'SL', exit: 105 } },
    ]);
    const h = harvester.harvestOutcomes();
    expect(h.added).toBe(1); // only the finite-R row
    expect(harvester.__datasetRaw().rows.find(x => x.id === 'n1')).toBeUndefined();
  });

  it('honest NOT ENOUGH DATA below MIN_ROWS + LEARNING READY above', () => {
    seedDataset(Array.from({ length: 39 }, (_, i) => mkRow({ id: `s${i}` })));
    expect(harvester.datasetStatus().verdict).toBe('NOT ENOUGH DATA');
    expect(harvester.datasetStatus().ready).toBe(false);
    seedDataset(Array.from({ length: 42 }, (_, i) => mkRow({ id: `s${i}` })));
    const st = harvester.datasetStatus();
    expect(st.verdict).toBe('LEARNING READY');
    expect(st.ready).toBe(true);
    expect(st.winRate).toBeGreaterThanOrEqual(0);
    expect(st.expectancyR).toBeTypeOf('number');
  });

  it('stamps a harvest change on the evolution ledger only when rows added', () => {
    seedLedger([{ id: 'x1', outcome: { r: 1, pnlINR: 10, reason: 'SL', exit: 1 } }]);
    harvester.harvestOutcomes();
    expect(evo.evolutionStatus().byKind.harvest).toBe(1);
    harvester.harvestOutcomes(); // no new rows → no spam entry
    expect(evo.evolutionStatus().byKind.harvest).toBe(1);
  });
});

// ============ 3. DRIFT MONITOR ============
describe('v19.0 Phase 1 — drift monitor', () => {
  it('PSI: identical distributions = 0, shifted = large', () => {
    expect(drift.psi([0.2, 0.2, 0.6], [0.2, 0.2, 0.6])).toBeCloseTo(0, 5);
    const p = drift.psi([0.5, 0, 0.5], [0.05, 0, 0.95]);
    expect(p).toBeGreaterThan(0.25); // alarm-grade shift
  });

  it('vote drift refuses on noise (<24 vote rows)', () => {
    const r = drift.voteDrift([mkRow(), mkRow()]);
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('NOT ENOUGH DATA');
  });

  it('vote drift detects a model whose direction flipped (ALARM)', () => {
    const old = Array.from({ length: 20 }, () => mkRow({ votes: { trend: { dir: 1, conf: 70 } } }));
    const recent = Array.from({ length: 20 }, () => mkRow({ votes: { trend: { dir: -1, conf: 70 } } }));
    const r = drift.voteDrift([...old, ...recent]);
    expect(r.ok).toBe(true);
    expect(r.models.trend.drift).toBe('ALARM');
    expect(r.verdict).toBe('ALARM');
  });

  it('stable voting → STABLE verdict', () => {
    const rows = Array.from({ length: 30 }, (_, i) => mkRow({ votes: { trend: { dir: i % 5 === 0 ? 1 : 1, conf: 70 } } }));
    const r = drift.voteDrift(rows);
    expect(r.ok).toBe(true);
    expect(r.models.trend.drift).toBe('STABLE');
    expect(r.verdict).toBe('STABLE');
  });

  it('driftReport composes verdicts without throwing (trust absent-safe)', () => {
    expect(() => drift.driftReport()).not.toThrow();
    const r = drift.driftReport();
    expect(['STABLE', 'DRIFTING', 'ALARM', 'NOT ENOUGH DATA']).toContain(r.verdict);
  });
});

// ============ 4. GATE TUNER ============
describe('v19.0 Phase 2 — gate tuner (proposal-only, bounded)', () => {
  it('refuses to tune on thin data (<40 rows)', () => {
    seedDataset(Array.from({ length: 25 }, (_, i) => mkRow({ id: `g${i}` })));
    const r = gateTuner.tuneGates({ current: { minAiScore: 75, minConfidence: 70, minAgreement: 0.65, quorumPenalty: 5 } });
    expect(r.verdict).toBe('NOT ENOUGH DATA');
    expect(r.proposals).toHaveLength(0);
  });

  it('grid search stays within ±5 of current gates (bounded deltas)', () => {
    // winning trades sit at conf 72+ so a lower conf gate would admit losers
    const rows = Array.from({ length: 60 }, (_, i) => mkRow({
      id: `g${i}`,
      confidence: i < 30 ? 62 : 76, // old half loose, new half tight
      agreement: 0.7,
      r: i < 30 ? -1 : 2,
      win: i >= 30,
    }));
    seedDataset(rows);
    const cur = { minAiScore: 75, minConfidence: 70, minAgreement: 0.65, quorumPenalty: 5 };
    const r = gateTuner.tuneGates({ current: cur });
    if (r.best) {
      expect(Math.abs(r.best.gates.minConfidence - cur.minConfidence)).toBeLessThanOrEqual(5);
      expect(Math.abs(r.best.gates.minAgreement - cur.minAgreement)).toBeLessThanOrEqual(0.06);
      expect(r.best.gates.minConfidence).toBeGreaterThanOrEqual(60);
      expect(r.best.gates.minConfidence).toBeLessThanOrEqual(80);
    }
    // proposal-only: config file NEVER written by the tuner itself
    expect(existsSync(storePath('ai-agent-config.json'))).toBe(false);
  });

  it('runs through runGateTune without throwing (council lazy-import guarded)', async () => {
    seedDataset(Array.from({ length: 45 }, (_, i) => mkRow({ id: `t${i}` })));
    expect(() => gateTuner.runGateTune({ current: { minAiScore: 75, minConfidence: 70, minAgreement: 0.65, quorumPenalty: 5 } })).not.toThrow();
    await new Promise(r => setTimeout(r, 50)); // lazy import settles
  });
});

// ============ 5. SELF COUNCIL ============
describe('v19.0 Phase 5 — self council governance', () => {
  it('classifies tiers: gate numerics safe, desks risky, unknown worst-tier', () => {
    expect(councilMod.tierOf({ minConfidence: 72 })).toBe('safe');
    expect(councilMod.tierOf({ desks: { spot: true } })).toBe('risky');
    expect(councilMod.tierOf({ maxLeverage: 10 })).toBe('risky');
  });

  it('sanitizes patches to the whitelist (unknown keys stripped)', () => {
    const s = councilMod.__testables.sanitize({ minConfidence: '72', mode: 'live', enabled: true, maxLeverage: 9 });
    expect(s).toEqual({ minConfidence: 72 });
  });

  it('submit → approve applies through updateAgentConfig clamps + rollback restores', () => {
    const p = councilMod.submitProposal({
      kind: 'gate-tune', tier: 'safe', summary: 'test gate nudge',
      configPatch: { minConfidence: 999, minAgreement: 0.7 }, // 999 clamps to config bounds
      evidence: { n: 50 },
    });
    expect(p).toBeTruthy();
    expect(p!.configPatch.minConfidence).toBe(999); // stored raw; applied clamped
    const before = agentMod.loadAgentConfig().minConfidence;
    const a = councilMod.approveProposal(p!.id, { by: 'test' });
    expect(a.ok).toBe(true);
    const after = agentMod.loadAgentConfig();
    expect(after.minConfidence).not.toBe(before);
    expect(after.minConfidence).toBeLessThanOrEqual(95); // NUM_CLAMPS bound respected
    const rb = councilMod.rollbackProposal(p!.id, { by: 'test' });
    expect(rb.ok).toBe(true);
    expect(agentMod.loadAgentConfig().minConfidence).toBe(before);
    // governance trail on the evolution ledger
    const kinds = evo.evolutionStatus().byKind;
    expect(kinds.proposal).toBe(1);
    expect(kinds.approval).toBe(1);
    expect(kinds.rollback).toBe(1);
  });

  it('kill-switch refuses apply (SELFIMPROVE_ENABLED=false)', () => {
    process.env.SELFIMPROVE_ENABLED = 'false';
    try {
      const p = councilMod.submitProposal({ kind: 'gate-tune', tier: 'safe', summary: 'x', configPatch: { minConfidence: 72 } });
      const a = councilMod.approveProposal(p!.id, { by: 'test' });
      expect(a.ok).toBe(false);
      // status lives on the STORED proposal (the returned p is a snapshot)
      const stored = councilMod.__proposalsRaw().proposals.find(x => x.id === p!.id)!;
      expect(stored.status).toBe('failed');
      expect(stored.applyNote).toContain('kill-switch');
    } finally {
      delete process.env.SELFIMPROVE_ENABLED;
    }
  });

  it('auto-approvals: OFF by default (manual culture), ON only with the env', () => {
    const p = councilMod.submitProposal({ kind: 'gate-tune', tier: 'safe', summary: 'old', configPatch: { minConfidence: 72 } });
    // age the proposal past 24h
    const raw = councilMod.__proposalsRaw();
    raw.proposals[raw.proposals.length - 1].ts = Date.now() - 25 * 3600000;
    councilMod.__setProposalsForTests(raw);
    const r1 = councilMod.processAutoApprovals();
    expect(r1.autoApplied).toBe(0); // default OFF
    expect(p!.status === 'pending' || councilMod.__proposalsRaw().proposals.find(x => x.id === p!.id)!.status === 'pending').toBe(true);
    process.env.SELFIMPROVE_AUTO_TUNE = 'true';
    try {
      const r2 = councilMod.processAutoApprovals();
      expect(r2.autoApplied).toBe(1);
      expect(councilMod.__proposalsRaw().proposals.find(x => x.id === p!.id)!.status).toBe('applied');
    } finally {
      delete process.env.SELFIMPROVE_AUTO_TUNE;
    }
  });

  it('risky tier NEVER auto-applies even with the env on', () => {
    process.env.SELFIMPROVE_AUTO_TUNE = 'true';
    try {
      const p = councilMod.submitProposal({ kind: 'scope', tier: 'risky', summary: 'desk change', configPatch: { desks: { spot: true } } });
      const raw = councilMod.__proposalsRaw();
      raw.proposals[raw.proposals.length - 1].ts = Date.now() - 30 * 3600000;
      councilMod.__setProposalsForTests(raw);
      const r = councilMod.processAutoApprovals();
      expect(r.autoApplied).toBe(0);
      expect(councilMod.__proposalsRaw().proposals.find(x => x.id === p!.id)!.status).toBe('pending');
    } finally {
      delete process.env.SELFIMPROVE_AUTO_TUNE;
    }
  });
});

// (agent config assertions read via agentMod.loadAgentConfig above)

// ============ 6. LESSONS ENGINE ============
describe('v19.0 Phase 3 — lessons engine', () => {
  it('deterministic lessons from quant evidence (LLM never required)', () => {
    const ev = lessons.quantEvidence([
      mkRow({ win: true, r: 2 }), mkRow({ win: false, r: -1, reason: 'SL' }),
      mkRow({ win: false, r: -1, reason: 'SL' }), mkRow({ win: false, r: -1, reason: 'SL' }),
    ]);
    expect(ev.n).toBe(4);
    const det = lessons.deterministicLessons(ev);
    expect(det.length).toBeGreaterThan(0);
    expect(det[0].title).toBeTruthy();
  });

  it('validateLLMLessons rejects junk + caps at 5', () => {
    const bad = lessons.__testables.validateLLMLessons({ lessons: 'nope' });
    expect(bad).toBeNull();
    const good = lessons.__testables.validateLLMLessons({
      lessons: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, rule: 'r', severity: 'warn' })),
    });
    expect(good!.length).toBe(5);
  });

  it('parseJsonLoose extracts JSON from wrapped text', () => {
    const j = lessons.__testables.parseJsonLoose('```json\n{"lessons":[]}\n```');
    expect(j).toEqual({ lessons: [] });
  });

  it('lessonsForPrompt: empty when no lessons (byte-identical prompts)', () => {
    expect(lessons.lessonsForPrompt()).toBe('');
  });

  it('generateLessons never throws without LLM deps (deterministic path)', async () => {
    lessons.__clearLessonsCache();
    seedDataset(Array.from({ length: 30 }, (_, i) => mkRow({ id: `l${i}` })));
    const r = await lessons.generateLessons({});
    expect(r.ok).toBe(true);
    expect(r.mode).toContain('deterministic');
    expect(Array.isArray(r.lessons)).toBe(true);
    expect(evo.evolutionStatus().byKind.lesson).toBe(1);
  });
});

// ============ 7. AGENT DESK SCOPE (USER SPEC) ============
describe('v19.0 user spec — CoinDCX auto-trading scope (spot OFF)', () => {
  it('AGENT_DEFAULTS: spot OFF, futures + global ON', () => {
    expect(agentSrc).toMatch(/desks:\s*\{\s*futures:\s*true,\s*spot:\s*false,\s*india:\s*true,\s*global:\s*true\s*\}/);
  });

  it('one-time v19_0 migration stamps + flips saved spot:true → false', () => {
    expect(agentSrc).toMatch(/_stamps\.v19_0/);
    expect(agentSrc).toMatch(/v19_0:\s*true/);
  });

  it('board gating honors desks (entry scope only)', () => {
    expect(agentSrc).toMatch(/if \(cfg\.desks\.futures\) boards\.push\('FUTURES'\)/);
    expect(agentSrc).toMatch(/if \(cfg\.desks\.spot\) boards\.push\('CRYPTO'\)/);
    expect(agentSrc).toMatch(/if \(cfg\.desks\.global\) boards\.push\('GLOBALFUTURES'\)/);
  });

  it('exits/management run over open positions regardless of desk flags (no spot close regression)', () => {
    // the conviction loop iterates openAgent and closes by p.market — no desks check
    expect(agentSrc).toMatch(/for \(const p of openAgent\)/);
    const convictionBlock = agentSrc.slice(agentSrc.indexOf('for (const p of openAgent)'), agentSrc.indexOf('for (const p of openAgent)') + 4000);
    expect(convictionBlock).not.toMatch(/cfg\.desks\.spot/);
  });
});

// ============ 8. WIRING CONTRACTS ============
describe('v19.0 wiring — routes + scheduler + council + frontend', () => {
  // v20.6.3: the user explicitly asked to "completely remove" the self-
  // improvement loop. The 14 /api/ai/self/* routes are GONE from
  // routes.js. The handlers' comment block in routes.js mentions the
  // removal for traceability (so a future dev knows where to look in
  // git history if they need to re-mount them).
  it('v20.6.3: routes.js no longer exposes the self/* control surface (loop REMOVED)', () => {
    for (const route of [
      '/api/ai/self/status', '/api/ai/self/repair', '/api/ai/self/harvest', '/api/ai/self/drift',
      '/api/ai/self/retrain', '/api/ai/self/lessons', '/api/ai/self/lessons/run', '/api/ai/self/gate-tune',
      '/api/ai/self/evolve', '/api/ai/self/proposals',
      '/api/ai/self/proposal/:id/approve', '/api/ai/self/proposal/:id/reject', '/api/ai/self/proposal/:id/rollback',
    ]) {
      // the route MOUNT line (e.g. `app.get('/api/ai/self/status', ...)`)
      // must be gone; the comment block mentioning the route name for
      // traceability may still exist (that's intentional — explains
      // where to find them in git history). Assert no `app.<method>(
      // '/api/ai/self/...'` mount pattern remains.
      expect(routesSrc).not.toContain(`app.get('${route}'`);
      expect(routesSrc).not.toContain(`app.post('${route}'`);
    }
    // sanity: the v20.6.3 removal comment block IS present
    expect(routesSrc).toMatch(/v20\.6\.3.*SELF-IMPROVEMENT.*REMOVED/s);
  });

  it('index.js arms the heartbeat (harvest 6h, drift 1h, weekly, kill-switch)', () => {
    expect(indexSrc).toMatch(/\[selfimprove\]/);
    expect(indexSrc).toMatch(/harvestOutcomes/);
    expect(indexSrc).toMatch(/runDriftCheck/);
    expect(indexSrc).toMatch(/processAutoApprovals/);
    expect(indexSrc).toMatch(/SELFIMPROVE_ENABLED/);
  });

  it('council debates carry the lessons context (light-touch, guarded)', () => {
    expect(councilSrc).toMatch(/lessonsForPrompt/);
    expect(councilSrc).toMatch(/lessonsBlock/);
  });

  // v20.6.3: the user explicitly asked to "completely remove" the self-
  // improvement loop. The SelfImprovementPanel.tsx file is GONE; CoinDcxTab
  // no longer mounts it. The "cx-selfimprove" section id is gone.
  // (AgentPanel scope chips — AUTO SCOPE / EQUITY SIM / SPOT AUTO OFF —
  // are independent of the loop and stay; they describe the agent's
  // auto-trade scope, not the self-improvement engine.)
  it('v20.6.3: frontend SelfImprovementPanel REMOVED (file gone + not mounted in CoinDcxTab)', () => {
    const panelPath = path.join(repoRoot, 'src/components/aitrading/SelfImprovementPanel.tsx');
    expect(existsSync(panelPath)).toBe(false);
    const tabSrc = readFileSync(path.join(repoRoot, 'src/components/tabs/CoinDcxTab.tsx'), 'utf8');
    // CoinDcxTab may still contain the OLD comment block explaining the
    // removal (intentional for traceability) — but must NOT contain the
    // actual JSX mount (`<SelfImprovementPanel />`) or the import line.
    expect(tabSrc).not.toMatch(/^import\s+\{[^}]*SelfImprovementPanel/m);
    expect(tabSrc).not.toMatch(/<SelfImprovementPanel\s*\/?>/);
    expect(tabSrc).not.toMatch(/id=["']cx-selfimprove["']/);
    // AgentPanel scope chips are INDEPENDENT of the loop — they survive.
    const agentPanelSrc = readFileSync(path.join(repoRoot, 'src/components/aitrading/AgentPanel.tsx'), 'utf8');
    expect(agentPanelSrc).toMatch(/AUTO SCOPE:/);
    expect(agentPanelSrc).toMatch(/EQUITY SIM · USDC/);
    // v21.0.5: the SPOT desk is REMOVED from the CoinDCX tab — the old
    // "SPOT AUTO OFF" chip is gone; an honest disclosure chip appears
    // only when a legacy saved config had spot explicitly enabled.
    expect(agentPanelSrc).toMatch(/SPOT DESK REMOVED \(v21\.0\.5\)/);
    expect(agentPanelSrc).not.toMatch(/SPOT AUTO OFF/);
  });

  it('SAPTA (browser auto-trader) crypto scope is FUTURES by default (spot = explicit opt-in)', () => {
    const ptaSrc = readFileSync(path.join(repoRoot, 'server/ai/proTraderAuto.js'), 'utf8');
    expect(ptaSrc).toMatch(/cryptoProduct:\s*'futures'/);
    expect(ptaSrc).toMatch(/B-\$\{String\(symbol\)\.toUpperCase\(\)\}_USDT/);
    // board source follows cryptoProduct; spot flow survives as legacy opt-in
    expect(ptaSrc).toMatch(/cfg\.cryptoProduct === 'spot' \? 'CRYPTO' : 'FUTURES'/);
    // futures sizing converts stake via fx + stamps fxAtEntry (close math consistency)
    expect(ptaSrc).toMatch(/fxAtEntry/);
    expect(ptaSrc).toMatch(/_usdInr/);
    // futures trades monitor from the FUTURES feed, never a spot INR ticker
    expect(ptaSrc).toMatch(/fetchFuturesPrices/);
    // futures PnL multiplies the fx stamp (legacy rows: fx 1, zero regression)
    expect(ptaSrc).toMatch(/t\.market === 'FUTURES' \? \(Number\(t\.fxAtEntry\) > 50/);
  });
});
