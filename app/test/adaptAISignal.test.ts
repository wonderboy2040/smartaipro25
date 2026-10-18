// ============================================================
// test/adaptAISignal.test.ts — the new-board → Paper Desk bridge
// ------------------------------------------------------------
// v9.1: AISignal (server/ai engine shape) → IntradaySignal
// (server/intraday Paper Desk shape). The adapter must be honest:
// FLAT / planless / broken-level signals NEVER reach the simulator
// (the server would reject them anyway — we pre-reject for feedback).
// ============================================================
import { describe, it, expect } from 'vitest';
import { adaptAISignal } from '../src/components/intraday/adaptAISignal';
import type { AISignal } from '../src/components/aitrading/types';

function sig(over: Partial<AISignal> = {}): AISignal {
  return {
    symbol: 'RELIANCE',
    market: 'INDIA',
    side: 'LONG',
    grade: 'ACTION',
    confidence: 72,
    agreement: 0.8,
    participating: 7,
    totalModels: 10,
    ltp: 1400,
    changePct: 1.2,
    plan: {
      entry: 1400, stopLoss: 1370, target1: 1430, target2: 1470,
      risk: 30, riskPct: 2.14, rewardRisk: 2.33, atrUsed: 12.5, planStyle: 'ATR',
    },
    votes: [],
    summary: 'Momentum breakout with volume',
    aiNote: null,
    executable: true,
    generatedAt: Date.now(),
    ...over,
  } as AISignal;
}

describe('adaptAISignal — happy paths', () => {
  it('adapts a LONG plan into an INDIA IntradaySignal', () => {
    const out = adaptAISignal(sig());
    expect(out).not.toBeNull();
    expect(out!.symbol).toBe('RELIANCE');
    expect(out!.direction).toBe('LONG');
    expect(out!.market).toBe('INDIA');
    expect(out!.entry).toBe(1400);
    expect(out!.stopLoss).toBe(1370);
    expect(out!.target1).toBe(1430);
    expect(out!.target2).toBe(1470);
    expect(out!.confidence).toBe(72);
    expect(out!.aiModel).toBe('AI Council');
    expect(out!.reasons).toContain('Momentum breakout with volume');
  });

  it('adapts a SHORT plan with inverted levels intact', () => {
    const out = adaptAISignal(sig({
      side: 'SHORT',
      plan: {
        entry: 100, stopLoss: 104, target1: 96, target2: 92,
        risk: 4, riskPct: 4, rewardRisk: 2, atrUsed: 1.5, planStyle: 'ATR',
      },
    }));
    expect(out!.direction).toBe('SHORT');
    expect(out!.stopLoss).toBe(104);
    expect(out!.target2).toBe(92);
  });

  it('carries the honest plan numbers (rr from rewardRisk, atr from atrUsed)', () => {
    const out = adaptAISignal(sig());
    expect(out!.rr).toBe(2.33);
    expect(out!.atr).toBe(12.5);
    expect(out!.ltp).toBe(1400);
    expect(out!.changePct).toBe(1.2);
  });

  it('falls back to plan.entry as ltp when ltp is null', () => {
    const out = adaptAISignal(sig({ ltp: null }));
    expect(out!.ltp).toBe(1400);
  });
});

describe('adaptAISignal — honest rejections', () => {
  it('rejects FLAT consensus (nothing to simulate)', () => {
    expect(adaptAISignal(sig({ side: 'FLAT' }))).toBeNull();
  });

  it('rejects planless signals', () => {
    expect(adaptAISignal(sig({ plan: null }))).toBeNull();
  });

  it('rejects LONG levels violating SL < entry < T1 < T2 (server rule mirrored)', () => {
    expect(adaptAISignal(sig({
      plan: { entry: 100, stopLoss: 102, target1: 110, target2: 120, risk: 2, riskPct: 2, rewardRisk: 9, atrUsed: 1, planStyle: 'ATR' },
    }))).toBeNull();
    // SL below entry but T1 not above entry:
    expect(adaptAISignal(sig({
      plan: { entry: 100, stopLoss: 98, target1: 99.5, target2: 120, risk: 2, riskPct: 2, rewardRisk: 9, atrUsed: 1, planStyle: 'ATR' },
    }))).toBeNull();
  });

  it('rejects SHORT levels violating SL > entry > T1 > T2', () => {
    expect(adaptAISignal(sig({
      side: 'SHORT',
      plan: { entry: 100, stopLoss: 98, target1: 96, target2: 92, risk: 2, riskPct: 2, rewardRisk: 9, atrUsed: 1, planStyle: 'ATR' },
    }))).toBeNull();
  });

  it('rejects non-finite / non-positive levels', () => {
    expect(adaptAISignal(sig({
      plan: { entry: 0, stopLoss: 98, target1: 96, target2: 92, risk: 2, riskPct: 2, rewardRisk: 9, atrUsed: 1, planStyle: 'ATR' },
    }))).toBeNull();
    expect(adaptAISignal(sig({
      plan: { entry: NaN, stopLoss: 98, target1: 96, target2: 92, risk: 2, riskPct: 2, rewardRisk: 9, atrUsed: 1, planStyle: 'ATR' },
    }))).toBeNull();
  });
});
