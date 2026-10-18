// ============================================================
// test/kellySizing.test.ts — v10.6 EDGE-ADAPTIVE KELLY-LITE
// SIZING (Pro Upgrade #2) regression suite.
//
// LOCKED HERE:
//   • the Kelly math: f* = winProb − (1−winProb)/payoff → HALF-Kelly
//   • riskPerTradePct is the CEILING — Kelly only ever sizes DOWN
//   • thin buckets (< MIN_SETTLED settled) → flat fallback
//   • f* ≤ 0 → mode 'refused' (no honest edge → no trade)
//   • flag OFF (env + config) → effectiveRiskPctFor returns null
//     and the agent keeps the exact flat sizing that shipped
//   • bucket label parsing ('40-55%' / '85%+')
//   • the agent config knob round-trips through updateAgentConfig
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  todayIST: vi.fn(() => '2026-09-14'),
  // v10.8: agent.js now imports these (near-miss/mandate/extension paths)
  getPositionsWithPnl: vi.fn(async () => ({ positions: [] })),
  withJournalLock: vi.fn(async (fn) => fn()),
  saveJournal: vi.fn(),
  pushEntry: vi.fn(),
}));
vi.mock('../server/ai/correlation.js', () => ({ pairCorrelation: vi.fn(async () => null) }));
vi.mock('../server/ai/models.js', () => ({ v2ModelsEnabled: vi.fn(() => false), MODELS: [] }));
vi.mock('../server/ai/trust.js', () => ({
  trustReport: vi.fn(() => ({ sufficient: true, calibration: [{ bucket: '75-85%', n: 25, winRate: 58 }] })),
  __testables: { MIN_SETTLED: 10 },
}));

import {
  kellySizingEnabled, parseCalBucket, kellyRiskPct, effectiveRiskPctFor,
  AGENT_DEFAULTS, loadAgentConfig, updateAgentConfig,
  __resetAgentForTests,
} from '../server/ai/agent.js';

const CAL = [
  { bucket: '40-55%', n: 30, winRate: 52 },
  { bucket: '55-65%', n: 3, winRate: 60 },   // thin → flat
  { bucket: '65-75%', n: 25, winRate: 48 },  // f* = .22 → half .11 → 11% → ceiling 2 → 2
  { bucket: '75-85%', n: 40, winRate: 45 },  // f* = .175 → half 8.75 → ceiling 2 → 2; with ceiling 1.5 → 1.5
  { bucket: '85%+', n: 20, winRate: 30 },    // f* = .3 − .35 = −0.05 → refused
];

beforeEach(() => {
  __resetAgentForTests();
  delete process.env.AI_ENABLE_KELLY_SIZING;
});
afterEach(() => { delete process.env.AI_ENABLE_KELLY_SIZING; });

describe('parseCalBucket', () => {
  it('parses range labels and the open-ended top bucket', () => {
    expect(parseCalBucket('40-55%')).toEqual({ lo: 40, hi: 55 });
    expect(parseCalBucket('85%+')).toEqual({ lo: 85, hi: 101 });
    expect(parseCalBucket('nonsense')).toBeNull();
  });
});

describe('kellyRiskPct — the math (PURE)', () => {
  it('f* = winProb − (1−winProb)/payoff, used at HALF, capped at the ceiling', () => {
    // 48% WR at 2:1 → f* = 0.48 − 0.52/2 = 0.22 → half-Kelly 11% → ceiling 2%
    const v = kellyRiskPct({ confidence: 70, calibration: CAL, baseRiskPct: 2, payoffRatio: 2 });
    expect(v.mode).toBe('kelly');
    expect(v.pct).toBe(2); // half-Kelly (11%) above the ceiling → capped
    expect(v.halfKelly).toBeCloseTo(0.11, 4);
  });
  it('Kelly sizes DOWN below the ceiling when the edge is thin', () => {
    // 40% WR at 3:1 → f* = 0.4 − 0.6/3 = 0.2 → half 0.1 → 10% → cap 2 → 2.
    // Use a LOW ceiling to prove the down-size: ceiling 0.5 → 0.5.
    // For a genuine below-ceiling case: 36% WR at 2:1 → f* = 0.36 − 0.32 = 0.04 → half 0.02 → 2% → ceiling 5% → 2%.
    const cal = [{ bucket: '65-75%', n: 25, winRate: 36 }];
    const v = kellyRiskPct({ confidence: 70, calibration: cal, baseRiskPct: 5, payoffRatio: 2 });
    expect(v.pct).toBe(2);
    // same edge with a 1% ceiling → 1% (Kelly never exceeds the ceiling)
    const capped = kellyRiskPct({ confidence: 70, calibration: cal, baseRiskPct: 1, payoffRatio: 2 });
    expect(capped.pct).toBe(1);
  });
  it('thin bucket (< MIN_SETTLED) → flat fallback, we refuse to size on noise', () => {
    const v = kellyRiskPct({ confidence: 60, calibration: CAL, baseRiskPct: 1.5, payoffRatio: 2 });
    expect(v.mode).toBe('flat');
    expect(v.pct).toBe(1.5);
    expect(v.reason).toContain('noise');
  });
  it('f* ≤ 0 → refused (no honest edge, no trade)', () => {
    const v = kellyRiskPct({ confidence: 90, calibration: CAL, baseRiskPct: 1.5, payoffRatio: 2 });
    expect(v.mode).toBe('refused');
    expect(v.pct).toBe(0);
    expect(v.reason).toContain('no honest edge');
  });
  it('unknown confidence bucket / no calibration → null (caller stays flat)', () => {
    expect(kellyRiskPct({ confidence: 30, calibration: CAL, baseRiskPct: 1.5 })).toBeNull();
    expect(kellyRiskPct({ confidence: 70, calibration: [], baseRiskPct: 1.5 })).toBeNull();
    expect(kellyRiskPct({ confidence: null, calibration: CAL, baseRiskPct: 1.5 })).toBeNull();
  });
});

describe('kellySizingEnabled (flag discipline)', () => {
  it('default OFF — the agent keeps the exact flat sizing that shipped', () => {
    expect(AGENT_DEFAULTS.kellySizing).toBe(false);
    expect(kellySizingEnabled(loadAgentConfig())).toBe(false);
    expect(effectiveRiskPctFor(loadAgentConfig(), { confidence: 80, plan: { rewardRisk: 2 } })).toBeNull();
  });
  it('env flag turns it on regardless of the config knob', () => {
    process.env.AI_ENABLE_KELLY_SIZING = 'true';
    expect(kellySizingEnabled({ kellySizing: false })).toBe(true);
  });
  it('the config knob turns it on (panel toggle path)', () => {
    expect(kellySizingEnabled({ kellySizing: true })).toBe(true);
  });
  it('the knob round-trips through updateAgentConfig', () => {
    updateAgentConfig({ kellySizing: true });
    expect(loadAgentConfig().kellySizing).toBe(true);
    updateAgentConfig({ kellySizing: false });
    expect(loadAgentConfig().kellySizing).toBe(false);
  });
});

describe('effectiveRiskPctFor (live wrapper — mocked trust calibration)', () => {
  it('env ON + calibration → the bucket math runs', () => {
    process.env.AI_ENABLE_KELLY_SIZING = '1';
    const v = effectiveRiskPctFor({ riskPerTradePct: 2 }, { confidence: 80, plan: { rewardRisk: 2 } });
    // mocked bucket 75-85%: 58% WR → f* = .58 − .21 = .37 → half .185 → 18.5% → ceiling 2%
    expect(v.mode).toBe('kelly');
    expect(v.pct).toBe(2);
  });
  it('uses the plan\'s actual rewardRisk as the payoff', () => {
    process.env.AI_ENABLE_KELLY_SIZING = '1';
    const cal = [{ bucket: '75-85%', n: 20, winRate: 50 }];
    // payoff 3 → f* = .5 − .1667 = .3333 → half 16.7% → ceiling 2 → 2
    const hi = kellyRiskPct({ confidence: 80, calibration: cal, baseRiskPct: 2, payoffRatio: 3 });
    expect(hi.pct).toBe(2);
    // payoff 1.05 (tight plan) → f* = .5 − .4762 = .0238 → half 1.19% → below ceiling → 1.19
    const lo = kellyRiskPct({ confidence: 80, calibration: cal, baseRiskPct: 2, payoffRatio: 1.05 });
    expect(lo.pct).toBeCloseTo(1.19, 2);
  });
});
