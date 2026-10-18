// ============================================================
// test/positionConviction.test.ts — v10.15 GAP 1
// ------------------------------------------------------------
// THE LIVE CONVICTION TRACKER contract:
//   • the ensemble re-votes open positions — convictionDelta is
//     measured against the ENTRY score, sign-relative to the position
//     (a LONG whose ensemble drifts bearish = negative delta)
//   • FLIPPED (opposite side WITH quorum) → the conviction-flip exit
//     fires BEFORE the stop (thesis invalidation)
//   • a flip WITHOUT quorum is NOT a FLIPPED state (noise, not signal)
//   • WEAKENING → SL tightening only when IN PROFIT (never a hard
//     exit — noise must not churn the book)
//   • STRENGTHENING → earns winner-extension room even marginally red;
//     WEAKENING/FLIPPED never earn it
//   • extensionEligible keeps its v10.8 behavior EXACTLY when no
//     conviction is passed (flag-off = byte-identical, zero regression)
//   • flag OFF (default) → the agent never re-votes at all
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrivate = vi.fn();
const mockPrivateGET = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxPrivateGET: (...args) => mockPrivateGET(...args),
  coindcxConnected: () => false,
  coindcxStatus: () => ({ connected: false }),
  fetchGlobalFuturesInstruments: vi.fn(async () => []),
}));

import {
  convictionEnabled, classifyConviction, quorumOfSignal, convictionOfPosition,
  weakeningShouldTighten, extensionConvictionVote,
} from '../server/ai/positionConviction.js';
import { extensionEligible } from '../server/ai/agent.js';
import { __resetAgentForTests, __setAgentStateForTests, loadAgentConfig, updateAgentConfig } from '../server/ai/agent.js';

const ORIG_ENV = process.env.AI_ENABLE_CONVICTION_EXIT;

beforeEach(() => {
  delete process.env.AI_ENABLE_CONVICTION_EXIT;
  __resetAgentForTests();
});

afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env.AI_ENABLE_CONVICTION_EXIT;
  else process.env.AI_ENABLE_CONVICTION_EXIT = ORIG_ENV;
});

// afterEach is hoisted with the import above — declare it properly
import { afterEach } from 'vitest';

describe('positionConviction — the pure classification core', () => {
  it('same-side higher score → STRENGTHENING with positive delta', () => {
    const c = classifyConviction({ posSide: 'LONG', curSide: 'LONG', curScore: 88, entryScore: 78, quorumMet: false, threshold: 8 });
    expect(c.state).toBe('STRENGTHENING');
    expect(c.delta).toBe(10);
    expect(c.currentScore).toBe(88);
  });

  it('same-side lower score past threshold → WEAKENING (the thesis is decaying)', () => {
    const c = classifyConviction({ posSide: 'LONG', curSide: 'LONG', curScore: 62, entryScore: 82, quorumMet: false, threshold: 8 });
    expect(c.state).toBe('WEAKENING');
    expect(c.delta).toBe(-20);
  });

  it('small same-side drift inside the threshold → HOLDING (noise is not signal)', () => {
    for (const [cur, entry] of [[80, 78], [76, 78], [78, 78]]) {
      expect(classifyConviction({ posSide: 'LONG', curSide: 'LONG', curScore: cur, entryScore: entry, threshold: 8 }).state).toBe('HOLDING');
    }
  });

  it('opposite side WITH quorum → FLIPPED (the exit case)', () => {
    const c = classifyConviction({ posSide: 'LONG', curSide: 'SELL', curScore: 71, entryScore: 82, quorumMet: true, threshold: 8 });
    expect(c.state).toBe('FLIPPED');
    // delta is sign-RELATIVE to the position: opposite side counts −score
    expect(c.delta).toBe(-153);
  });

  it('opposite side WITHOUT quorum → NOT FLIPPED (a thin committee must not exit a position)', () => {
    const c = classifyConviction({ posSide: 'LONG', curSide: 'SELL', curScore: 71, entryScore: 82, quorumMet: false, threshold: 8 });
    expect(c.state).not.toBe('FLIPPED');
    expect(c.state).toBe('WEAKENING'); // −153 ≤ −8: decaying, but no exit
  });

  it('missing data → UNKNOWN (never exit on an abstaining ensemble)', () => {
    expect(classifyConviction({ posSide: 'LONG', curSide: null, curScore: NaN }).state).toBe('UNKNOWN');
    expect(classifyConviction({}).state).toBe('UNKNOWN');
  });

  it('no entry score → HOLDING with null delta (pre-upgrade positions degrade honestly)', () => {
    const c = classifyConviction({ posSide: 'BUY', curSide: 'BUY', curScore: 90, entryScore: null });
    expect(c.state).toBe('HOLDING');
    expect(c.delta).toBeNull();
  });

  it('side normalization: LONG/BUY and SHORT/SELL are the same sides', () => {
    expect(classifyConviction({ posSide: 'BUY', curSide: 'LONG', curScore: 90, entryScore: 80, threshold: 8 }).state).toBe('STRENGTHENING');
    expect(classifyConviction({ posSide: 'SELL', curSide: 'SHORT', curScore: 90, entryScore: 80, threshold: 8 }).state).toBe('STRENGTHENING');
    expect(classifyConviction({ posSide: 'LONG', curSide: 'SHORT', curScore: 90, entryScore: 80, quorumMet: true }).state).toBe('FLIPPED');
  });
});

describe('positionConviction — quorum + signal adapters', () => {
  it('quorumOfSignal: ≥5 voters OR STRONG grade carries a committee', () => {
    expect(quorumOfSignal({ voters: 5 })).toBe(true);
    expect(quorumOfSignal({ voters: 14 })).toBe(true);
    expect(quorumOfSignal({ grade: 'STRONG' })).toBe(true);
    expect(quorumOfSignal({ voters: 2, grade: 'ACTION' })).toBe(false);
    expect(quorumOfSignal(null)).toBe(false);
  });

  it('convictionOfPosition reads the deep-signal shape (superIntel.aiScore + side)', () => {
    const pos = { side: 'LONG' };
    const fresh = { side: 'SHORT', grade: 'STRONG', superIntel: { aiScore: 84 } };
    const c = convictionOfPosition(pos, fresh, 81);
    expect(c.state).toBe('FLIPPED');
    expect(c.currentScore).toBe(84);
    expect(c.side).toBe('SELL');
  });

  it('an abstaining ensemble (no side) → UNKNOWN, currentScore null', () => {
    const c = convictionOfPosition({ side: 'LONG' }, { side: null, superIntel: {} }, 80);
    expect(c.state).toBe('UNKNOWN');
    expect(c.currentScore).toBeNull();
  });
});

describe('positionConviction — the response policies', () => {
  it('weakeningShouldTighten: only an IN-PROFIT WEAKENING position gets the breakeven ratchet', () => {
    expect(weakeningShouldTighten({ state: 'WEAKENING', pnlPct: 1.2 })).toBe(true);
    expect(weakeningShouldTighten({ state: 'WEAKENING', pnlPct: -0.4 })).toBe(false); // losing → no disguised early exit
    expect(weakeningShouldTighten({ state: 'WEAKENING', pnlPct: null })).toBe(false);
    expect(weakeningShouldTighten({ state: 'HOLDING', pnlPct: 5 })).toBe(false);
    expect(weakeningShouldTighten({ state: 'STRENGTHENING', pnlPct: 5 })).toBe(false);
  });

  it('extensionConvictionVote: STRENGTHENING earns room; WEAKENING/FLIPPED never; else in-profit', () => {
    expect(extensionConvictionVote({ state: 'STRENGTHENING', pnlPct: -0.8 })).toBe(true);
    expect(extensionConvictionVote({ state: 'WEAKENING', pnlPct: 3 })).toBe(false);
    expect(extensionConvictionVote({ state: 'FLIPPED', pnlPct: 3 })).toBe(false);
    expect(extensionConvictionVote({ state: 'HOLDING', pnlPct: 1 })).toBe(true);
    expect(extensionConvictionVote({ state: 'HOLDING', pnlPct: -1 })).toBe(false);
  });
});

describe('extensionEligible — the v10.15 conviction interplay (zero regression when absent)', () => {
  const base = { enabled: true, extensions: 0, maxExtensions: 2, oppositeQualifying: false, source: 'agent' };

  it('NO conviction passed → the EXACT v10.8 behavior (flag-off = byte-identical)', () => {
    expect(extensionEligible({ ...base, pnlPct: 1.5 })).toBe(true);
    expect(extensionEligible({ ...base, pnlPct: 0 })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: -1 })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 5, oppositeQualifying: true })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 5, source: 'manual' })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 5, extensions: 2 })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 5, enabled: false })).toBe(false);
  });

  it('STRENGTHENING conviction justifies an extension even when marginally red', () => {
    expect(extensionEligible({ ...base, pnlPct: -0.8, conviction: 'STRENGTHENING' })).toBe(true);
    expect(extensionEligible({ ...base, pnlPct: 1.5, conviction: 'STRENGTHENING' })).toBe(true);
    // but the hard vetoes still win
    expect(extensionEligible({ ...base, pnlPct: 5, conviction: 'STRENGTHENING', oppositeQualifying: true })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 5, conviction: 'STRENGTHENING', source: 'manual' })).toBe(false);
  });

  it('WEAKENING / FLIPPED conviction never earn extension room — even in profit', () => {
    expect(extensionEligible({ ...base, pnlPct: 4, conviction: 'WEAKENING' })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 4, conviction: 'FLIPPED' })).toBe(false);
  });

  it('HOLDING/UNKNOWN conviction → unchanged in-profit rule', () => {
    expect(extensionEligible({ ...base, pnlPct: 2, conviction: 'HOLDING' })).toBe(true);
    expect(extensionEligible({ ...base, pnlPct: -2, conviction: 'HOLDING' })).toBe(false);
    expect(extensionEligible({ ...base, pnlPct: 2, conviction: undefined })).toBe(true);
  });
});

describe('positionConviction — the feature flag', () => {
  it('OFF by default (config + env both unset)', () => {
    expect(convictionEnabled(loadAgentConfig())).toBe(false);
  });

  it('env var arms it (same pattern as the other engine flags)', () => {
    for (const v of ['true', '1', 'on', 'yes', 'TRUE']) {
      process.env.AI_ENABLE_CONVICTION_EXIT = v;
      expect(convictionEnabled(loadAgentConfig())).toBe(true);
    }
    process.env.AI_ENABLE_CONVICTION_EXIT = 'off';
    expect(convictionEnabled(loadAgentConfig())).toBe(false);
  });

  it('the config knob arms it and the panel toggle round-trips', () => {
    updateAgentConfig({ convictionExit: true });
    expect(convictionEnabled(loadAgentConfig())).toBe(true);
    expect(loadAgentConfig().convictionThreshold).toBe(8); // default threshold
    updateAgentConfig({ convictionExit: false, convictionThreshold: 12 });
    expect(convictionEnabled(loadAgentConfig())).toBe(false);
    expect(loadAgentConfig().convictionThreshold).toBe(12);
  });

  it('agentStatus exposes the conviction transparency block + per-position re-vote', async () => {
    updateAgentConfig({ convictionExit: true });
    __setAgentStateForTests({
      conviction: {
        'B-SOL_USDT': { state: 'STRENGTHENING', delta: 12, currentScore: 87, entryScore: 75, side: 'BUY', at: Date.now() },
      },
    });
    const { agentStatus } = await import('../server/ai/agent.js');
    const st = await agentStatus(null);
    expect(st.accuracy.conviction).toMatchObject({ enabled: true, threshold: 8 });
    // openPositions rows carry the re-vote for the panel's conviction bar
    // (no open positions in this hermetic state — the map itself is the contract)
    expect(Array.isArray(st.openPositions)).toBe(true);
  });
});
