// ============================================================
// test/topFiveQuorumEnv.test.ts — v18.6.1 Fix 2 env tunability
// ------------------------------------------------------------
// AI_MIN_TOPFIVE_QUORUM must be set BEFORE signals.js is imported
// (the constant is parsed at module load). Vitest runs each test FILE
// in its own module graph → this file pins the env knob cleanly:
//   • default 5 (pinned in topFive.test.ts)
//   • 0 → gate disabled (escape hatch)
//   • 3 → a 3-vote signal becomes eligible
//   • >9 clamps to 9 (never an accidentally empty board)
// ============================================================
// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-topfive-env');
process.env.AI_MIN_TOPFIVE_QUORUM = '3';

const { computeTopFive } = await import('../server/ai/signals.js');

const NOW = Date.now();
const votes = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, dir: 1, conf: 70 }));
const SIG = (over = {}) => ({
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'ACTION',
  confidence: 80, agreement: 0.75, participating: 9, totalModels: 10,
  ltp: 2400, changePct: 1.2,
  plan: { entry: 2400, stopLoss: 2320, target1: 2480, target2: 2560, riskPct: 3.33, rewardRisk: 2 },
  votes: votes(9),
  summary: 'test', aiNote: null, executable: true, generatedAt: NOW,
  ...over,
});

describe('AI_MIN_TOPFIVE_QUORUM env knob (default 5, this file: 3)', () => {
  it('quorum=3: a 3-vote ACTION signal becomes top-5 eligible', () => {
    const out = computeTopFive([SIG({ symbol: 'Q3', votes: votes(3) })], { niftyChange: 1 }, 'INDIA');
    expect(out.map(p => p.symbol)).toEqual(['Q3']);
  });
  it('quorum=3: a 2-vote signal still excluded', () => {
    const out = computeTopFive([SIG({ symbol: 'Q2', votes: votes(2) })], { niftyChange: 1 }, 'INDIA');
    expect(out).toEqual([]);
  });
});
