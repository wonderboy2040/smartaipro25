// ============================================================
// test/botlabAiDeciders.test.ts — v21.14.0 (Laya removal)
// ------------------------------------------------------------
// aiDecider contract (makeDecider arms: jev / auto):
//   • single-provider mode (jev): approve/wait/side-flip-banned
//   • AUTO (v21.14 jev-only): healthy → take; provider down
//     (breaker_open / http_5xx) → honest WAIT (failover retired);
//     http_4xx → plain wait (not a provider-down)
//   • provider exception → WAIT (kabhi crash nahi)
//   • makeDecider guards: missing provider → throw; legacy
//     laya/consensus arms → unknown arm (botRunner resolve
//     pehle hi unhe jev/gated pe map kar deta hai)
// Provider mocks = createJev-shaped raw verdicts {action, probs,
// note, cached, latencyMs} — the REAL engine layer ke upar.
// ============================================================
import { describe, it, expect } from 'vitest';
import { makeDecider, aiDecider } from '../server/bots/deciders.js';

// ---- strategy mock (aiDecider ko snapshot/jevPrompt/desk chahiye) ----
const strat = {
  desk: 'crypto',
  snapshot: (_sym, _ts, _row, cand) => ({
    proposed: cand?.side === 'LONG' ? 'enter_long' : 'enter_short',
    contextLines: ['Instrument: BTC', 'Proposed trade'],
    features: {},
  }),
  jevPrompt: () => ({ instructions: 'take or wait?', criteria: { enter_long: 'L', enter_short: 'S', wait: 'W' } }),
};
const cand = { symbol: 'BTC', side: 'LONG', features: {} };
const row = { bar: { time: Date.UTC(2026, 9, 12, 3, 30, 0) } };

// provider mock factory — createJev ke raw verdict shape me
const prov = (fn) => fn;
const P = (action, extra = {}) => prov(async () => ({ action, probs: { [action]: 0.6 }, cached: false, latencyMs: 5, ...extra }));
const DOWNP = () => P('wait', { note: 'breaker_open' });
const H503 = () => P('wait', { note: 'http_503' });
const H422 = () => P('wait', { note: 'http_422' });

const withJev = (j, extra = {}) => ({ providers: { jev: j }, strategy: strat, ...extra });

describe('v21.14 aiDecider — single-provider mode (jev)', () => {
  it('jev arm: approve on proposed side → take; verdict.ai.jev populated, arm identity preserved', async () => {
    const d = makeDecider({ arm: 'jev', ...withJev(P('enter_long')) });
    const v = await d(cand, row);
    expect(v.action).toBe('take');
    expect(v.arm).toBe('jev');
    expect(v.ai.jev.choice).toBe('enter_long');
    // compat field: deciding provider ka telemetry `jev` key pe
    expect(v.jev.choice).toBe('enter_long');
  });

  it('jev arm: provider wait → wait with honest reason', async () => {
    const d = makeDecider({ arm: 'jev', ...withJev(P('wait', { note: 'below_threshold(0.20)' })) });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
    expect(v.reason).toContain('below_threshold');
  });

  it('side flip is BANNED in the decider layer too (defense in depth): provider picks the other side → wait', async () => {
    const d = makeDecider({ arm: 'jev', ...withJev(P('enter_short')) });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
  });

  it('jev arm via providers registry (no `jev` param) works', async () => {
    const d = makeDecider({ arm: 'jev', providers: { jev: P('enter_long') }, strategy: strat });
    const v = await d(cand, row);
    expect(v.action).toBe('take');
    expect(v.arm).toBe('jev');
  });
});

describe('v21.14 aiDecider — auto (jev-only; failover retired)', () => {
  it('jev healthy → take (primary decides)', async () => {
    const d = makeDecider({ arm: 'auto', ...withJev(P('enter_long')) });
    const v = await d(cand, row);
    expect(v.action).toBe('take');
    expect(v.ai.jev.choice).toBe('enter_long');
  });

  it('jev breaker_open → honest WAIT + provider_down reason (no failover target exists)', async () => {
    const d = makeDecider({ arm: 'auto', ...withJev(DOWNP()) });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
    expect(v.reason).toContain('provider_down(jev)');
    expect(v.reason).toContain('breaker_open');
    expect(v.ai.jev.note).toBe('breaker_open');
  });

  it('jev http_503 → honest WAIT (5xx counts as provider-down)', async () => {
    const d = makeDecider({ arm: 'auto', ...withJev(H503()) });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
    expect(v.reason).toContain('provider_down(jev)');
  });

  it('jev http_422 → plain wait (bad request ≠ provider-down; no failover-intent stamp)', async () => {
    const d = makeDecider({ arm: 'auto', ...withJev(H422()) });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
    expect(v.reason).toBe('http_422');
    expect(v.reason).not.toContain('provider_down');
  });

  it('jev picks the other side → wait (side-flip ban holds in auto too)', async () => {
    const d = makeDecider({ arm: 'auto', ...withJev(P('enter_short')) });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
  });
});

describe('v21.14 aiDecider — failure discipline', () => {
  it('provider exception (deciding) → WAIT, kabhi crash nahi', async () => {
    const boom = async () => { throw new Error('ECONNRESET'); };
    const d = makeDecider({ arm: 'jev', ...withJev(boom) });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
    expect(v.reason).toContain('provider_exception');
  });

  it('snapshot building exception → WAIT (whole decider fail-closed)', async () => {
    const badStrat = { ...strat, snapshot: () => { throw new Error('bad snapshot'); } };
    const d = aiDecider({ providers: { jev: P('enter_long') }, mode: 'jev', strategy: badStrat });
    const v = await d(cand, row);
    expect(v.action).toBe('wait');
    expect(v.reason).toContain('ai_decider_error');
  });
});

describe('v21.14 makeDecider — guards (backstop; botRunner pehle resolve karta hai)', () => {
  it('jev arm without a jev instance → throw', () => {
    expect(() => makeDecider({ arm: 'jev', ...withJev(null) })).toThrow(/jev/);
  });

  it('auto with NO jev provider → throw', () => {
    expect(() => makeDecider({ arm: 'auto', ...withJev(null) })).toThrow(/auto/);
  });

  it('v21.14: legacy laya arm → unknown arm (botRunner availability-resolve maps it upstream)', () => {
    expect(() => makeDecider({ arm: 'laya', providers: { jev: P('enter_long') }, strategy: strat })).toThrow(/unknown arm/);
  });

  it('v21.14: legacy consensus arm → unknown arm (single-provider world)', () => {
    expect(() => makeDecider({ arm: 'consensus', providers: { jev: P('enter_long') }, strategy: strat })).toThrow(/unknown arm/);
  });

  it('unknown arm still throws honestly', () => {
    expect(() => makeDecider({ arm: 'psychic', ...withJev(P('wait')) })).toThrow(/unknown arm/);
  });
});
