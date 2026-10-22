// ============================================================
// test/directionLock.test.ts — v21.24.0 Phase 2 regression
// (audit/direction-guards: cross-engine direction lock + resolveDirection
// SSOT)
// ------------------------------------------------------------
// Guards:
//   • directionLock: ek hi coin par cross-engine OPPOSITE-side entries
//     blocked (one-coin-one-direction), expiry ke baad allowed
//   • resolveDirection: board/SVA/council conflicts ka single source
// v21.23.2 PORT FIX: 72ad0a3 port ne directionLock.js ka API badal diya
// (acquire/check/release/get — v21.23.1 lineage) par ye test file purane
// API (lockDirection/directionLockGate/...) pe thi → 4 tests remote par
// hi failing the. New API ke against rewrite — semantics same.
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ledger + auto-link state test isolation (imports se PEhle set — vitest
// me statement order preserve hota hai, mtfAutoLink.test.ts wala pattern)
process.env.SMARTAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-ledger-test-'));
process.env.MTF_AUTO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-auto-dl-'));

import {
  acquireDirectionLock, checkDirectionLock, getDirectionLocks, releaseDirectionLock,
  resolveDirection, __resetDirectionLocksForTests,
} from '../server/ai/directionLock.js';

describe('directionLock — cross-engine one-coin-one-direction', () => {
  beforeEach(() => __resetDirectionLocksForTests());

  it('locks the symbol on trade-open; same side allowed, OPPOSITE blocked', () => {
    acquireDirectionLock({ symbol: 'BTCUSDT', side: 'LONG', source: 'mtf-auto' });
    expect(checkDirectionLock('BTC', 'LONG').allowed).toBe(true);
    const g = checkDirectionLock('B-BTC_USDT', 'SHORT');
    expect(g.allowed).toBe(false);
    expect(g.conflict).toBe(true);
    expect(g.reason).toMatch(/direction lock/i);
    expect(g.lockedSide).toBe('LONG');
  });

  it('opposite side allowed again after the 4h cooldown expires (released lock)', () => {
    const now = Date.now();
    // v21.23.1 semantics: ACTIVE lock kabhi expire nahi hota (release-on-close
    // hook se active=false hota hai) — cooldown released lock par chalta hai.
    acquireDirectionLock({ symbol: 'RELIANCE', side: 'SHORT', source: 'auto-agent', now: now - (245) * 60_000 });
    releaseDirectionLock('RELIANCE', { now: now - (245) * 60_000 }); // position closed 4h+ pehle
    expect(checkDirectionLock('RELIANCE', 'LONG', { now }).allowed).toBe(true);
  });

  it('symbol normalization: BTCUSDT / B-BTC_USDT / btc → same lock domain', () => {
    acquireDirectionLock({ symbol: 'SOL-USDT', side: 'LONG', source: 'test' });
    expect(checkDirectionLock('SOLUSDT', 'SHORT').allowed).toBe(false);
    expect(checkDirectionLock('sol', 'SHORT').allowed).toBe(false);
    // unlocked symbol par koi spurious block nahi
    expect(checkDirectionLock('RELIANCE', 'LONG').allowed).toBe(true);
  });

  it('snapshot lists active locks; release unlocks', () => {
    acquireDirectionLock({ symbol: 'ETH', side: 'SHORT', source: 'protrader-auto' });
    const snap = getDirectionLocks();
    expect(snap.length).toBe(1);
    expect(snap[0].side).toBe('SHORT');
    expect(releaseDirectionLock('ETH', { clearCooldown: true })).toBe(true);
    expect(checkDirectionLock('ETH', 'LONG').allowed).toBe(true);
  });
});

describe('resolveDirection — cross-engine SSOT', () => {
  const plan = (side: string, extra: Record<string, unknown> = {}) => ({
    side, alignedWithContext: true, worldIndicators: { aligned8Count: 7 }, ...extra,
  });

  it('board ensemble opposite side → conflict, verified=false, label CONFLICT', () => {
    const r = resolveDirection({ plan: plan('LONG'), boardSig: { side: 'SHORT' } });
    expect(r.boardOpposes).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.label).toBe('CONFLICT-LONG');
    expect(r.conflicts.join(' ')).toMatch(/direction conflict/);
  });

  it('SVA FLIP verdict → conflict', () => {
    const r = resolveDirection({
      plan: plan('SHORT'), boardSig: { side: 'SHORT' },
      sva: { action: 'FLIP', finalCall: 'LONG' },
    });
    expect(r.svaOpposes).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.label).toBe('CONFLICT-SHORT');
    expect(r.conflicts.join(' ')).toMatch(/SVA/);
  });

  it('AI council hard-disagree (AVOID/DISAGREE/SKIP) → conflict', () => {
    for (const v of ['AVOID', 'DISAGREE', 'SKIP']) {
      const r = resolveDirection({ plan: plan('LONG'), boardSig: { side: 'LONG' }, council: v });
      expect(r.councilHardNo).toBe(true);
      expect(r.verified).toBe(false);
    }
  });

  it('all engines aligned → PAKKA verified', () => {
    const r = resolveDirection({
      plan: plan('LONG'), boardSig: { side: 'LONG' },
      sva: { action: 'CONFIRM', finalCall: 'LONG' }, council: 'AGREE',
    });
    expect(r.verified).toBe(true);
    expect(r.label).toBe('PAKKA LONG');
    expect(r.conflicts).toEqual([]);
  });

  it('no side → NEUTRAL, never verified', () => {
    const r = resolveDirection({ plan: null, boardSig: { side: 'LONG' } });
    expect(r.side).toBe(null);
    expect(r.label).toBe('NEUTRAL');
    expect(r.verified).toBe(false);
  });
});
