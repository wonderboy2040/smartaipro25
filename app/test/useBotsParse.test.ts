// ============================================================
// test/useBotsParse.test.ts — v21.2.0 (dual-provider plan Step-6)
// ------------------------------------------------------------
// useBots coerceStatus ka numeric-safety contract (v20.8.2 FIX L ka
// dual-provider extension): server shape drift (string numbers, null
// breaker, missing blocks) kabhi per-desk ErrorBoundary nahi girata.
//   • status.ai.jev num-safe coerce (v21.14: laya removed)
//   • naye arms arm union me pass-through
//   • purana jev-only frame bina crash ke coerce hota hai
// ============================================================
import { describe, it, expect } from 'vitest';
import { coerceStatus, type BotsStatus } from '../src/components/bots/useBots';

const baseFrame = (over: Record<string, unknown>): BotsStatus => ({
  mode: 'PAPER',
  globalPause: false,
  scheduler: 'running',
  jev: null,
  ai: null,
  bots: [],
  at: '2026-10-12T12:00:00.000Z',
  ...over,
}) as BotsStatus;

describe('v21.14 useBots.coerceStatus — provider shape safety (legacy laya fields dropped)', () => {
  it('status.ai.jev string-numerics → numbers; breakerOpen boolean-fied', () => {
    const s = coerceStatus(baseFrame({
      ai: {
        jev: { calls: '12', cacheHits: '8', errors: '0', rejects: '2', p50: '910.5', p95: '1810.9', breakerOpen: 'false', threshold: '0.30', model: 'jev-latest', hasKey: 'true', name: 'jev', url: 'api.typesafe.ai' },
        laya: { calls: '30', cacheHits: '25', errors: '1', rejects: '0', p50: '210', p95: '420', breakerOpen: 'true', threshold: '0.25', model: '', hasKey: 'true', name: 'laya', url: '127.0.0.1:8000' },
      },
      aiMode: { primary: 'jev', shadow: 'off', onDown: 'wait' },
    }));
    expect(s?.ai?.jev?.calls).toBe(12);
    expect(s?.ai?.jev?.p50).toBeCloseTo(910.5);
    expect(s?.ai?.jev?.rejects).toBe(2);
    expect(s?.ai?.jev?.breakerOpen).toBe(false);
    expect(s?.aiMode).toEqual({ primary: 'jev', shadow: 'off', onDown: 'wait' });
    expect('laya' in (s?.ai || {})).toBe(false);
  });

  it('null providers / missing ai block → null passthrough (no crash)', () => {
    const s = coerceStatus(baseFrame({ ai: { jev: null }, jev: null }));
    expect(s?.ai?.jev).toBeNull();
    expect('laya' in (s?.ai || {})).toBe(false);
    const s2 = coerceStatus(baseFrame({}));
    expect(s2?.ai).toBeNull();
  });

  it('arms (jev/auto + legacy persisted laya/consensus) bot cards me pass-through', () => {
    const s = coerceStatus(baseFrame({
      bots: [
        { bot: 'orb_crypto_utc', arm: 'jev', mode: 'PAPER', killSwitch: 0, heartbeat: null, account: null, backtest: null },
        { bot: 'orb_in', arm: 'auto', mode: 'PAPER', killSwitch: 1, heartbeat: null, account: null, backtest: null },
        { bot: 'lvl', arm: 'auto', mode: 'PAPER', killSwitch: false, heartbeat: null, account: null, backtest: null },
      ] as any,
    }));
    expect(s?.bots.map((b) => b.arm)).toEqual(['jev', 'auto', 'auto']);
    expect(s?.bots[1].killSwitch).toBe(true); // boolean-fied
  });

  it('purana jev-only frame (v21.1.x server) bina loss ke coerce hota hai — compat', () => {
    const s = coerceStatus(baseFrame({
      jev: { calls: '5', cacheHits: '4', errors: '0', p50: '800', p95: '1500', breakerOpen: false, threshold: '0.30', model: 'jev-latest', hasKey: true },
    }));
    expect(s?.jev?.calls).toBe(5);
    expect(s?.jev?.p95).toBe(1500);
    expect(s?.jev?.breakerOpen).toBe(false);
  });

  it('null/undefined/malformed frames → as-is (never throws)', () => {
    expect(coerceStatus(null)).toBeNull();
    expect(coerceStatus(undefined as any)).toBeUndefined();
    expect(() => coerceStatus('nope' as any)).not.toThrow();
  });
});
