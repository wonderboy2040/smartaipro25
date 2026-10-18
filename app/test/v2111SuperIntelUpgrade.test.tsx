// ============================================================
// test/v2111SuperIntelUpgrade.test.ts(x) — v21.11.0 regression suite
// ------------------------------------------------------------
// TWO user-facing fixes locked here:
//
// A) LAYA DECISION TRANSPARENCY (the "🤖 AI ○ (Laya ○)" mystery):
//    boardAiConfirm used to collapse the provider's FULL verdict
//    (action/probs/confidence/note) into a 3-valued string — Laya ka
//    directional read kabhi UI tak nahi pahunchta tha. Ab:
//      • aiConfirm.detail.jev = decision object (picked side,
//        pLong/pShort/pWait, confidence, latencyMs, honest reason)
//      • badge: "Laya ✗ SHORT 68%" / "Laya ○ SHORT-lean 29%" /
//        "Laya ○ slow" — direction + conviction visible
//      • CONFLICT summary + precheck warning me kaunsi side pe ulta
//      • legacy string fields UNCHANGED (backward compat locked)
//
// B) SUPERINTELLIGENCE ACCURACY SUITE DEFAULT ON:
//      • AI_ENABLE_V2_MODELS / AI_ENABLE_MTF_CONFLUENCE / MESH ab
//        unset hone par ON (13 → 16 voting seats + 4 mesh shadow,
//        tape seat w1.3 → tape-mtf w1.6) — explicit false jeet-ta hai
//      • ML-service port 8000 → 8100 (8000 LAYA ka home hai — the
//        meta-learner was probing Laya!)
//      • ledger learning window 400 → 1200
//
// Subprocess pattern (env-sanitized) v2Models.test.ts se aaya hai —
// setup.ts in flags ko 'false' pin karta hai isliye in-process
// import se naya default test NAHI ho sakta.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const {
  confirmBoardSignals,
  __setProvidersForTests,
  __resetBoardAiConfirmForTests,
  __toDecisionForTests,
} = await import('../server/ai/boardAiConfirm.js');

// ---------------- A) decision transparency (node side) ----------------

const agreeJev = async () => ({
  action: 'enter_long', probs: { enter_long: 0.71, enter_short: 0.18, wait: 0.11 },
  confidence: 0.74, latencyMs: 210, cached: false,
});
const oppositeJev = async () => ({
  action: 'wait', picked: 'enter_short', note: 'disagreed_side',
  probs: { enter_long: 0.2, enter_short: 0.68, wait: 0.12 },
  confidence: 0.71, latencyMs: 240, cached: false,
});
const leanJev = async () => ({
  action: 'wait', picked: 'enter_short', note: 'below_threshold(0.29)',
  probs: { enter_long: 0.24, enter_short: 0.29, wait: 0.47 },
  confidence: 0.31, latencyMs: 190, cached: false,
});
const slowJev = async () => ({ action: 'wait', note: 'timeout', cached: false, latencyMs: 1500 });

const strongBoardSignal = (over = {}) => ({
  symbol: 'B-SOL_USDT', market: 'FUTURES', side: 'LONG', grade: 'STRONG',
  confidence: 82, ltp: 148.2, score: 82, superIntel: { aiScore: 82 },
  plan: { entry: 148.2, stopLoss: 145, target1: 152, target2: 155, rewardRisk: 2.1 },
  votes: [], summary: 'committee LONG', executable: true,
  ...over,
});

describe('v21.11 A — decision transparency (boardAiConfirm; v21.14 jev-only)', () => {
  beforeEach(() => {
    __resetBoardAiConfirmForTests();
  });

  it('__toDecision: raw jevEngine verdicts classify with direction preserved', () => {
    // AGREE — picked side preserved
    const ag = __toDecisionForTests({
      action: 'enter_long', probs: { enter_long: 0.71, enter_short: 0.18, wait: 0.11 },
    }, 'enter_long');
    expect(ag.v).toBe('AGREE');
    expect(ag.picked).toBe('enter_long');
    expect(ag.pLong).toBeCloseTo(0.71, 5);

    // DISAGREE — ULTA side + conviction preserved
    const dis = __toDecisionForTests({
      action: 'wait', picked: 'enter_short', note: 'disagreed_side',
      probs: { enter_long: 0.2, enter_short: 0.68, wait: 0.12 },
    }, 'enter_long');
    expect(dis.v).toBe('DISAGREE');
    expect(dis.picked).toBe('enter_short');
    expect(dis.pShort).toBeCloseTo(0.68, 5);
    expect(dis.reason).toBe('ulta');

    // NEUTRAL below-threshold — LEAN side preserved (the ○ mystery fix)
    const lean = __toDecisionForTests({
      action: 'wait', picked: 'enter_short', note: 'below_threshold(0.29)',
      probs: { enter_long: 0.24, enter_short: 0.29, wait: 0.47 },
    }, 'enter_long');
    expect(lean.v).toBe('NEUTRAL');
    expect(lean.picked).toBe('enter_short');
    expect(lean.reason).toBe('below-thr');

    // NEUTRAL timeout — honest reason, no fake direction
    const slow = __toDecisionForTests({ action: 'wait', note: 'timeout' }, 'enter_long');
    expect(slow.v).toBe('NEUTRAL');
    expect(slow.picked).toBeNull();
    expect(slow.reason).toBe('timeout');

    // deadline race — 'slow'
    const dl = __toDecisionForTests({ v: 'NEUTRAL', note: 'deadline' }, 'enter_long');
    expect(dl.reason).toBe('slow');

    // legacy plain-string shape (old memo) — no crash, direction unknown
    expect(__toDecisionForTests('AGREE', 'enter_long').v).toBe('AGREE');
    expect(__toDecisionForTests('NEUTRAL', 'enter_long').v).toBe('NEUTRAL');
    expect(__toDecisionForTests(null, 'enter_long').v).toBe('NEUTRAL');
  });

  it('wire shape: legacy string + detail objects stamped (jev-only, v21.14)', async () => {
    __setProvidersForTests({ jev: oppositeJev });
    const s = strongBoardSignal();
    const meta = await confirmBoardSignals([s], 'FUTURES');
    expect(meta?.conflicted).toBe(1);
    // legacy contract
    expect(s.aiConfirm.jev).toBe('DISAGREE');
    expect(s.aiConfirm.verdict).toBe('CONFLICT');
    expect('laya' in s.aiConfirm).toBe(false);
    // v21.11 detail — direction + conviction on the wire
    expect(s.aiConfirm.detail?.jev?.v).toBe('DISAGREE');
    expect(s.aiConfirm.detail?.jev?.picked).toBe('enter_short');
    expect(s.aiConfirm.detail?.jev?.pShort).toBeCloseTo(0.68, 5);
    expect(s.aiConfirm.detail?.jev?.confidence).toBeCloseTo(0.71, 5);
  });

  it('CONFLICT: STRONG demote + summary me provider-side direction (flipBits)', async () => {
    __setProvidersForTests({ jev: oppositeJev });
    const s = strongBoardSignal();
    await confirmBoardSignals([s], 'FUTURES');
    expect(s.grade).toBe('ACTION');
    expect(s.executable).toBe(false);
    expect(s.summary).toContain('AI-CONFLICT');
    expect(s.summary).toContain('Jev SHORT 68%');
  });

  it('NEUTRAL lean + slow reasons survive the wire (the ○ explanation)', async () => {
    __setProvidersForTests({ jev: leanJev });
    const s = strongBoardSignal();
    await confirmBoardSignals([s], 'FUTURES');
    expect(s.aiConfirm.verdict).toBe('NEUTRAL');
    expect(s.aiConfirm.jev).toBe('NEUTRAL');
    expect(s.aiConfirm.detail?.jev?.picked).toBe('enter_short');
    expect(s.aiConfirm.detail?.jev?.reason).toBe('below-thr');
    // score untouched on NEUTRAL (v21.3 contract)
    expect(s.superIntel.aiScore).toBe(82);
  });
});

// ---------------- B) accuracy suite defaults (subprocess) ----------------

const SANITIZE = (env: NodeJS.ProcessEnv) => {
  const e = { ...env };
  delete e.AI_ENABLE_V2_MODELS;
  delete e.AI_ENABLE_MESH_MODELS;
  delete e.AI_ENABLE_MTF_CONFLUENCE;
  // v21.12: master switch — delete karna zaroori hai warna setup.ts ka
  // legacy pin ('false') naye default-ON semantics ko override karega.
  delete e.AI_ACCURACY_SUITE;
  return e;
};

const spawnModels = (env: NodeJS.ProcessEnv) => {
  let out = '';
  try {
    out = execFileSync('node', ['-e',
      `import('./server/ai/models.js').then(m => {
        const tape = m.MODELS.find(x => x.id === 'tape' || x.id === 'tape-mtf');
        console.log(JSON.stringify({
          n: m.MODELS.length,
          ids: m.MODELS.map(x => x.id),
          tapeId: tape?.id, tapeW: tape?.weight,
          v2: m.v2ModelsEnabled(), mtf: m.mtfConfluenceEnabled(),
        }));
      })`], { env, encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    out = (e as { stdout?: string }).stdout || '';
  }
  return JSON.parse(out.trim().split('\n').pop());
};

describe('v21.11 B — Superintelligence accuracy suite default ON', () => {
  it('flags UNSET → 20-seat registry: 16 voting + 4 mesh shadow, tape-MTF w1.6', () => {
    const r = spawnModels(SANITIZE(process.env));
    expect(r.v2).toBe(true);
    expect(r.mtf).toBe(true);
    expect(r.n).toBe(20);
    expect(r.tapeId).toBe('tape-mtf');
    expect(r.tapeW).toBe(1.6);
    for (const id of ['sentiment', 'instflow', 'fundamentals', 'instflowpro', 'techconsensus', 'fundaproplus', 'cryptoonchain']) {
      expect(r.ids).toContain(id);
    }
  });

  it('v21.12 MASTER: stale legacy false + master UNSET → ab bhi 20-seat (stale-.env disease fix)', () => {
    // USER BUG: "sirf 13 models hi bata raha hai" — v21.11.0 tak explicit
    // legacy `false` override jeet-ta tha; purane .env wale boxes isi se
    // 13-seat pe pin the. v21.12 me master (default ON) legacy ko ignore
    // karta hai.
    const r = spawnModels({ ...SANITIZE(process.env), AI_ENABLE_V2_MODELS: 'false', AI_ENABLE_MESH_MODELS: 'false', AI_ENABLE_MTF_CONFLUENCE: 'false' });
    expect(r.v2).toBe(true);
    expect(r.mtf).toBe(true);
    expect(r.n).toBe(20);
    expect(r.tapeId).toBe('tape-mtf');
    expect(r.ids).toContain('sentiment');
    expect(r.ids).toContain('cryptoonchain');
  });

  it('v21.12 ROLLBACK: AI_ACCURACY_SUITE=false + per-flag false → legacy 13-seat board', () => {
    const r = spawnModels({ ...SANITIZE(process.env), AI_ACCURACY_SUITE: 'false', AI_ENABLE_V2_MODELS: 'false', AI_ENABLE_MESH_MODELS: 'false', AI_ENABLE_MTF_CONFLUENCE: 'false' });
    expect(r.v2).toBe(false);
    expect(r.mtf).toBe(false);
    expect(r.n).toBe(13);
    expect(r.tapeId).toBe('tape');
    expect(r.tapeW).toBe(1.3);
    expect(r.ids).not.toContain('sentiment');
  });

  it('v21.12 ROLLBACK: AI_ACCURACY_SUITE=false + per-flag unset → v21.11-era legacy defaults (13)', () => {
    const r = spawnModels({ ...SANITIZE(process.env), AI_ACCURACY_SUITE: 'false' });
    expect(r.v2).toBe(false);
    expect(r.n).toBe(13);
    expect(r.tapeId).toBe('tape');
  });

  it('mesh default ON (unset) + mesh shadow gating stays weight-0 (consensus untouched)', async () => {
    const mesh = await import('../server/ai/meshModels.js');
    const ledger = await import('../server/ai/ledger.js');
    const orig = process.env.AI_ENABLE_MESH_MODELS;
    const origSuite = process.env.AI_ACCURACY_SUITE;
    try {
      process.env.AI_ENABLE_MESH_MODELS = ''; // unset-equivalent → new default ON
      delete process.env.AI_ACCURACY_SUITE; // v21.12: master bhi unset → default ON
      (ledger as unknown as { __setLedgerForTests: (x: unknown) => void }).__setLedgerForTests(null);
      (mesh as unknown as { __resetMeshModelsForTests: () => void }).__resetMeshModelsForTests();
      expect(mesh.meshModelsEnabled()).toBe(true);
      const votes = [{ id: 'cryptoonchain', name: 'CryptoOnChainPro', dir: 1, conf: 70, weight: 0.6, reasons: [] }];
      const gated = mesh.applyMeshModelGating(votes);
      expect(gated[0].weight).toBe(0); // shadow — zero consensus impact
      expect(gated[0].shadow).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.AI_ENABLE_MESH_MODELS;
      else process.env.AI_ENABLE_MESH_MODELS = orig;
      if (origSuite === undefined) delete process.env.AI_ACCURACY_SUITE;
      else process.env.AI_ACCURACY_SUITE = origSuite;
      (mesh as unknown as { __resetMeshModelsForTests: () => void }).__resetMeshModelsForTests();
    }
  });

  it('ML-service port collision FIXED — sab defaults 8100 (8000 = Laya home)', () => {
    const ens = readFileSync('server/ai/ensemble.js', 'utf8');
    expect(ens).toContain("ML_SERVICE_URL || 'http://127.0.0.1:8100'");
    expect(ens).not.toContain("ML_SERVICE_URL || 'http://127.0.0.1:8000'");
    const health = readFileSync('server/ai/mlHealth.js', 'utf8');
    expect(health).toContain("ML_SERVICE_URL || 'http://127.0.0.1:8100'");
    const idx = readFileSync('server/index.js', 'utf8');
    expect(idx).toContain("ML_SERVICE_URL || 'http://127.0.0.1:8100'");
    const py = readFileSync('ml-service/app/main.py', 'utf8');
    expect(py).toContain('"ML_PORT", "8100"');
    expect(py).not.toContain('port=8000)');
    const docker = readFileSync('ml-service/Dockerfile', 'utf8');
    expect(docker).toContain('--port", "8100"');
    expect(docker).toContain('EXPOSE 8100');
  });

  it('ledger learning window 400 → 1200 (env-tunable)', () => {
    const src = readFileSync('server/ai/ledger.js', 'utf8');
    expect(src).toContain('Math.min(5000, n) : 1200');
    expect(src).not.toContain('const MAX_ENTRIES = 400;');
  });
});

// ---------------- A2) badge rendering (jsdom) ----------------

describe('v21.11 A2 — AiConfirmBadge direction rendering', () => {
  it('aiConfirmText helpers: AGREE / ULTA / lean / reason lines', async () => {
    const { aiDecisionText, aiDirSummary } = await import('../src/components/aitrading/aiConfirmText');
    expect(aiDecisionText('Jev', {
      v: 'DISAGREE', picked: 'enter_short', pLong: 0.2, pShort: 0.68, pWait: 0.12,
      confidence: 0.71, note: 'disagreed_side', latencyMs: 240, cached: false, reason: 'ulta',
    })).toContain('ULTA — SHORT chuna (p 68%)');
    expect(aiDecisionText('Jev', {
      v: 'AGREE', picked: 'enter_long', pLong: 0.71, pShort: 0.18, pWait: 0.11,
      confidence: 0.74, note: null, latencyMs: 210, cached: false, reason: 'wait',
    })).toContain('LONG APPROVE (p 71%)');
    expect(aiDecisionText('Jev', {
      v: 'NEUTRAL', picked: 'enter_short', pLong: 0.24, pShort: 0.29, pWait: 0.47,
      confidence: 0.31, note: 'below_threshold(0.29)', latencyMs: 190, cached: false, reason: 'below-thr',
    })).toContain('SHORT ki taraf LEAN (p 29%)');
    expect(aiDecisionText('Jev', {
      v: 'NEUTRAL', picked: null, pLong: null, pShort: null, pWait: null,
      confidence: null, note: 'timeout', latencyMs: 1500, cached: false, reason: 'timeout',
    })).toContain('entry nahi li (reason: timeout)');
    // legacy payload — no detail → empty suffix (old text untouched)
    expect(aiDirSummary({ jev: 'AGREE', laya: 'NEUTRAL', verdict: 'NEUTRAL' })).toBe('');
  });

  it('SignalCard badge: "Laya ✗ SHORT 68%" dikhta hai — direction visible', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { SignalCard } = await import('../src/components/aitrading/SignalCard');
    const mk = (aiConfirm: unknown) => ({
      symbol: 'B-SOL_USDT', market: 'FUTURES' as const, side: 'LONG' as const, grade: 'STRONG' as const,
      confidence: 82, agreement: 0.78, participating: 9, voters: 9, totalModels: 16,
      ltp: 148.2, changePct: 1.2,
      plan: { entry: 148.2, stopLoss: 145, target1: 152, target2: 155, risk: 3.2, riskPct: 2.1, rewardRisk: 2.1, atrUsed: 2.2, planStyle: 'atr-based' as const },
      superIntel: { aiScore: 83, tier: 'STRONG', drivers: ['momentum'] },
      votes: [{ id: 'm1', name: 'Trend Model', role: 'trend', dir: 1, conf: 80, weight: 1.2, reasons: ['ema aligned'] }],
      summary: 'test', aiNote: null, executable: true, generatedAt: Date.now(),
      aiConfirm: aiConfirm as never,
    });
    // CONFLICT with direction detail (v21.14: jev-only)
    render(<SignalCard signal={mk({
      jev: 'DISAGREE', verdict: 'CONFLICT',
      detail: {
        jev: { v: 'DISAGREE', picked: 'enter_short', pLong: 0.2, pShort: 0.68, pWait: 0.12, confidence: 0.71, note: 'disagreed_side', latencyMs: 240, cached: false, reason: 'ulta' },
      },
    })} />);
    const chip = screen.getByText(/🤖 AI ✗/);
    expect(chip.textContent).toContain('Jev ✗ SHORT 68%');
    // tooltip me full directional story
    expect(chip.getAttribute('title')).toContain('ULTA — SHORT chuna');
    expect(chip.getAttribute('title')).toContain('probs LONG 20% / SHORT 68% / wait 12%');
  });
});
