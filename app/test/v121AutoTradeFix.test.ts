// ============================================================
// test/v121AutoTradeFix.test.ts — v12.1 LIVE AUTO-TRADE FIXES
// ------------------------------------------------------------
// The 2026-09-19 live diagnosis (smartai1.onrender.com) found the auto
// pipeline firing into three separate walls. This suite locks the
// threshold + accounting side of the fix (the transport-side locks live
// in futures.test.ts / coindcxGet.test.ts, the spot-order body locks in
// aiOrders.test.ts / leverage.test.ts):
//
//   • USER SPEC "min trade score 75+ aur conf 70+": AGENT_DEFAULTS
//     minAiScore=75 (already the v9.6 spec) + minConfidence 60→70
//   • the saved-config migration: an old-default 60 rises to 70; a
//     user-customized value (≠60) is PRESERVED
//   • nearMissEntryGate honors the 70 floor (a 69-conf near-miss is noise)
//   • effectiveScoreBar keeps Path A at exactly 75 for a full quorum
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../server/ai/ledger.js', () => ({
  __ledgerRaw: vi.fn(() => ({ entries: [] })),
  modelStats: vi.fn(() => []),
}));
vi.mock('../server/ai/orderFlowDepth.js', () => ({
  readDepth: vi.fn(async () => null),
  estimateSlippagePct: vi.fn(() => ({ pct: null, bookExhausted: false, filledPct: 0 })),
  splitOrderForSlippage: vi.fn(() => ({ children: 1, slippagePct: null, reason: '' })),
}));
vi.mock('../server/ai/futures.js', () => ({
  walletSnapshot: vi.fn(async () => null),
  executeFuturesSignal: vi.fn(),
  closeFuturesPosition: vi.fn(),
  fetchUsdInr: vi.fn(async () => 84),
  inrOfUsdt: vi.fn(() => 84),
}));
vi.mock('../server/ai/coindcxOrders.js', () => ({
  loadConfig: vi.fn(() => ({})),
  loadJournal: vi.fn(() => ({ entries: [], positions: [] })),
  dailyStats: vi.fn(() => ({ trades: 0 })),
  todayIST: vi.fn(() => '2026-09-19'),
  getPositionsWithPnl: vi.fn(async () => ({ positions: [] })),
  withJournalLock: vi.fn(async (fn) => fn()),
  saveJournal: vi.fn(),
  pushEntry: vi.fn(),
}));
vi.mock('../server/ai/correlation.js', () => ({ pairCorrelation: vi.fn(async () => null) }));
vi.mock('../server/ai/models.js', () => ({ v2ModelsEnabled: vi.fn(() => false), MODELS: [] }));
vi.mock('../server/ai/trust.js', () => ({
  trustReport: vi.fn(() => ({ sufficient: false, calibration: [] })),
  __testables: { MIN_SETTLED: 10 },
}));

import {
  AGENT_DEFAULTS, loadAgentConfig, effectiveScoreBar, nearMissEntryGate,
  __resetAgentForTests,
} from '../server/ai/agent.js';
import { saveJSON } from '../server/lib/store.js';

beforeEach(() => {
  __resetAgentForTests(); // writes a clean AGENT_DEFAULTS config
});

describe('v12.1 USER SPEC thresholds — score 75+ / conf 70+', () => {
  it('AGENT_DEFAULTS carries the exact bars the user asked for', () => {
    expect(AGENT_DEFAULTS.minAiScore).toBe(75);
    expect(AGENT_DEFAULTS.minConfidence).toBe(70);
  });

  it('the saved v10.16 default of 60 migrates UP to 70', () => {
    saveJSON('ai-agent-config.json', { minConfidence: 60, thresholdProfile: 'proportional' });
    expect(loadAgentConfig().minConfidence).toBe(70);
  });

  it('a user-customized confidence (≠60) is PRESERVED — the migration never overrides a choice', () => {
    saveJSON('ai-agent-config.json', { minConfidence: 80, thresholdProfile: 'proportional' });
    expect(loadAgentConfig().minConfidence).toBe(80);
    saveJSON('ai-agent-config.json', { minConfidence: 65, thresholdProfile: 'proportional' });
    expect(loadAgentConfig().minConfidence).toBe(65);
  });

  it('a fresh config (no saved minConfidence) starts at 70', () => {
    saveJSON('ai-agent-config.json', { thresholdProfile: 'proportional' });
    expect(loadAgentConfig().minConfidence).toBe(70);
  });
});

describe('effectiveScoreBar — Path A stays 75 for a full quorum', () => {
  const cfg = { minAiScore: 75, quorumPenalty: 5, thresholdProfile: 'proportional' };
  it('5+ voters pay the base bar exactly', () => {
    expect(effectiveScoreBar(cfg, { voters: 5 })).toBe(75);
    expect(effectiveScoreBar(cfg, { voters: 11 })).toBe(75);
  });
  it('thin committees pay the proportional raise (≤ +5)', () => {
    expect(effectiveScoreBar(cfg, { voters: 4 })).toBeGreaterThan(75);
    expect(effectiveScoreBar(cfg, { voters: 1 })).toBe(80);
    expect(effectiveScoreBar(cfg, { voters: 1 })).toBeLessThanOrEqual(75 + 5);
  });
});

describe('nearMissEntryGate — the 70 confidence floor', () => {
  const cfg = {
    nearMissAutoTrade: true, nearMissMaxPerDay: 1, nearMissScoreGap: 10,
    nearMissMinConfidence: 70, minAiScore: 75, quorumPenalty: 5, thresholdProfile: 'proportional',
  };
  const sig = (over) => ({
    plan: { entry: 100, stopLoss: 96 }, side: 'LONG', executable: true,
    grade: 'ACTION', voters: 6, confidence: over.conf, superIntel: { aiScore: over.ai },
  });
  it('conf 69 within the gap window is STILL noise (floor 70)', () => {
    expect(nearMissEntryGate(cfg, sig({ conf: 69, ai: 70 }))).toBeNull();
  });
  it('conf 70 + AI within 10 of the bar qualifies with the gap recorded', () => {
    const nm = nearMissEntryGate(cfg, sig({ conf: 70, ai: 70 }));
    expect(nm).toBeTruthy();
    expect(nm.confidence).toBe(70);
    expect(nm.gap).toBe(10);
    expect(nm.needScore).toBe(75);
  });
  it('an already-qualifying signal is not a near-miss', () => {
    expect(nearMissEntryGate(cfg, sig({ conf: 78, ai: 76 }))).toBeNull();
  });
});
