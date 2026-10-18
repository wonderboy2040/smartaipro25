// ============================================================
// test/directionLock.test.ts — v21.24.0 Phase 2 + Phase 3 regression
// (audit/direction-guards: cross-engine direction lock, resolveDirection
// SSOT, aur MTF direction scorecard)
// ------------------------------------------------------------
// Guards:
//   • directionLock: ek hi coin par cross-engine OPPOSITE-side entries
//     blocked (one-coin-one-direction), expiry ke baad allowed
//   • resolveDirection: board/SVA/council conflicts ka single source
//   • mtfLedger: T1/SL outcome walk + scorecard honest verdicts
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
  lockDirection, directionLockGate, directionLockSnapshot, clearDirectionLock,
  __resetDirectionLockForTests, DIRECTION_LOCK_DEFAULT_BLOCK_MIN,
} from '../server/ai/directionLock.js';
import { resolveDirection } from '../server/ai/resolveDirection.js';
import {
  computeDirectionScorecard, resolveRowOutcome, logMtfRows,
  __setMtfLedgerForTests, __mtfLedgerRaw, __resetScorecardCacheForTests,
} from '../server/ai/mtfLedger.js';

describe('directionLock — cross-engine one-coin-one-direction', () => {
  beforeEach(() => __resetDirectionLockForTests());

  it('locks the symbol on trade-open; same side allowed, OPPOSITE blocked', () => {
    lockDirection({ symbol: 'BTCUSDT', market: 'CRYPTO', side: 'LONG', source: 'mtf-auto' });
    expect(directionLockGate({ symbol: 'BTC', market: 'CRYPTO', side: 'LONG' }).allowed).toBe(true);
    const g = directionLockGate({ symbol: 'B-BTC_USDT', market: 'FUTURES', side: 'SHORT' });
    expect(g.allowed).toBe(false);
    expect(g.remainingMin).toBeGreaterThan(0);
    expect(g.reason).toMatch(/direction lock/i);
    expect(g.lockSide).toBe('LONG');
  });

  it('opposite side allowed again after the 4h window expires', () => {
    const now = Date.now();
    lockDirection({ symbol: 'RELIANCE', market: 'INDIA', side: 'SHORT', source: 'auto-agent', now: now - (DIRECTION_LOCK_DEFAULT_BLOCK_MIN + 5) * 60_000 });
    expect(directionLockGate({ symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', now }).allowed).toBe(true);
  });

  it('symbol normalization: BTCUSDT / B-BTC_USDT / btc → same lock domain', () => {
    lockDirection({ symbol: 'SOL-USDT', market: 'CRYPTO', side: 'LONG', source: 'test' });
    expect(directionLockGate({ symbol: 'SOLUSDT', market: 'METALS'.replace('METALS', 'FUTURES'), side: 'SHORT' }).allowed).toBe(false);
    expect(directionLockGate({ symbol: 'sol', market: 'CRYPTO', side: 'SHORT' }).allowed).toBe(false);
    // INDIA domain alag hai — NSE RELIANCE perp-domain lock se collide nahi
    expect(directionLockGate({ symbol: 'RELIANCE', market: 'INDIA', side: 'LONG' }).allowed).toBe(true);
  });

  it('snapshot lists active locks; clearDirectionLock unlocks', () => {
    lockDirection({ symbol: 'ETH', market: 'CRYPTO', side: 'SHORT', source: 'protrader-auto' });
    const snap = directionLockSnapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].side).toBe('SHORT');
    expect(clearDirectionLock('ETH', 'CRYPTO')).toBe(true);
    expect(directionLockGate({ symbol: 'ETH', market: 'CRYPTO', side: 'LONG' }).allowed).toBe(true);
  });
});

describe('resolveDirection — cross-engine SSOT', () => {
  it('board ensemble opposite side → conflict, verified=false, label CONFLICT', () => {
    const r = resolveDirection({ side: 'LONG', boardSide: 'SHORT', candleVerified: true });
    expect(r.boardOpposes).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.label).toBe('CONFLICT-LONG');
    expect(r.conflicts.join(' ')).toMatch(/direction conflict/);
  });

  it('SVA FLIP verdict → conflict', () => {
    const r = resolveDirection({ side: 'SHORT', boardSide: 'SHORT', sva: { action: 'FLIP', finalCall: 'LONG' }, candleVerified: true });
    expect(r.svaOpposes).toBe(true);
    expect(r.verified).toBe(false);
    // P0 patch semantics: label me CONFLICT-* sirf board conflict ke liye;
    // SVA/council conflicts conflicts[] list me aate hain (label WAIT-*)
    expect(r.label).toBe('WAIT-SHORT');
    expect(r.conflicts.join(' ')).toMatch(/SVA/);
  });

  it('AI council hard-disagree (AVOID/DISAGREE/SKIP) → conflict', () => {
    for (const v of ['AVOID', 'DISAGREE', 'SKIP']) {
      const r = resolveDirection({ side: 'LONG', boardSide: 'LONG', councilVerdict: v, candleVerified: true });
      expect(r.councilHardNo).toBe(true);
      expect(r.verified).toBe(false);
    }
  });

  it('all engines aligned → PAKKA verified', () => {
    const r = resolveDirection({ side: 'LONG', boardSide: 'LONG', sva: { action: 'CONFIRM', finalCall: 'LONG' }, councilVerdict: 'AGREE', candleVerified: true });
    expect(r.verified).toBe(true);
    expect(r.label).toBe('PAKKA LONG');
    expect(r.conflicts).toEqual([]);
  });

  it('no side → NEUTRAL, never verified', () => {
    const r = resolveDirection({ side: null, boardSide: 'LONG', candleVerified: true });
    expect(r.side).toBe(null);
    expect(r.label).toBe('NEUTRAL');
    expect(r.verified).toBe(false);
  });
});

describe('mtfLedger — outcome walk + direction scorecard', () => {
  beforeEach(() => { __setMtfLedgerForTests(null); __resetScorecardCacheForTests(); });

  it('resolveRowOutcome: LONG T1-hit with favourable excursion', () => {
    const rec = { side: 'LONG', entry: 100, stopLoss: 99, t1: 101, ts: 1_000, holdMin: 45, netRR: { t1: 1 } };
    const out = resolveRowOutcome(rec, [
      { time: 2_000, high: 101.6, low: 99.8, close: 101.2 },
    ]);
    expect(out).not.toBeNull();
    expect(out.hit).toBe('T1');
    expect(out.directionHit).toBe(true);
    expect(out.wrongWay).toBe(false);
    expect(out.mfeR).toBeGreaterThanOrEqual(1.5);
    expect(out.r).toBe(1);
  });

  it('resolveRowOutcome: SL hit first (conservative) + wrong-way when price dumps ≥1R', () => {
    const rec = { side: 'LONG', entry: 100, stopLoss: 99, t1: 101, ts: 1_000, holdMin: 45 };
    const out = resolveRowOutcome(rec, [
      { time: 2_000, high: 100.2, low: 98.4, close: 98.5 },
    ]);
    expect(out.hit).toBe('SL');
    expect(out.r).toBe(-1);
    expect(out.wrongWay).toBe(true); // mae ≥ 1R
    expect(out.directionHit).toBe(false);
  });

  it('computeDirectionScorecard: honest INSUFFICIENT DATA below 30 rows', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      ts: Date.now() - i * 3_600_000, symbol: `S${i}`, side: 'LONG', tier: 'ELITE', superScore: 86,
      outcome: { hit: 'T1', directionHit: true, wrongWay: false, r: 1.1 },
    }));
    const sc = computeDirectionScorecard(rows);
    expect(sc.eliteStrong.n).toBe(12);
    expect(sc.eliteStrong.verdict).toBe('INSUFFICIENT DATA');
    expect(sc.note).toMatch(/insufficient/i);
  });

  it('computeDirectionScorecard: measured stats at n ≥ 30 (T1%, wrong-way, avgR)', () => {
    const mk = (i: number, hit: 'T1' | 'SL', dirHit: boolean, wrong: boolean, r: number) => ({
      ts: Date.now() - i * 600_000, symbol: `S${i % 7}`, side: i % 2 ? 'LONG' : 'SHORT',
      tier: i % 3 === 0 ? 'STRONG' : 'ELITE', superScore: 88,
      boardSideConflict: i % 5 === 0,
      outcome: { hit, directionHit: dirHit, wrongWay: wrong, r },
    });
    const rows = [
      ...Array.from({ length: 22 }, (_, i) => mk(i, 'T1', true, false, 1.2)),
      ...Array.from({ length: 10 }, (_, i) => mk(100 + i, 'SL', false, true, -1)),
    ];
    const sc = computeDirectionScorecard(rows);
    expect(sc.eliteStrong.n).toBe(32);
    expect(sc.eliteStrong.verdict).toBe('MEASURED');
    expect(sc.eliteStrong.directionHitRate).toBe(Math.round((22 / 32) * 100));
    expect(sc.eliteStrong.t1HitPct).toBe(Math.round((22 / 32) * 100));
    expect(sc.eliteStrong.wrongWayPct).toBe(Math.round((10 / 32) * 100));
    expect(sc.eliteStrong.avgR).toBeCloseTo((22 * 1.2 - 10) / 32, 2);
    // conflict bucket rows bhi settle hote hain (Phase-0 se PEHLE ka data
    // bucket — kitna nuksan hua tha, wo isi se napega jayega)
    expect(sc.conflictBucket.n).toBeGreaterThan(0);
  });

  it('logMtfRows: 30m dedupe + row shape (P0 conflict fields captured)', () => {
    const row = {
      ok: true, symbol: 'BTC', side: 'LONG', superScore: 88, tier: 'ELITE',
      directionVerified: false, boardSide: 'SHORT', boardSideConflict: true,
      aiAgents: { svaAction: 'FLIP' }, holdMin: 45,
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102, netRR: { t1: 1, t2: 2 } },
      pWinCalibrated: null,
    };
    const r1 = logMtfRows({ market: 'CRYPTO', mode: 'INTRADAY', rows: [row] });
    expect(r1.added).toBe(1);
    const r2 = logMtfRows({ market: 'CRYPTO', mode: 'INTRADAY', rows: [row] });
    expect(r2.added).toBe(0); // dedupe
    const raw = __mtfLedgerRaw();
    expect(raw.rows).toHaveLength(1);
    const rec = raw.rows[0];
    expect(rec.boardSideConflict).toBe(true);
    expect(rec.boardSide).toBe('SHORT');
    expect(rec.svaAction).toBe('FLIP');
    expect(rec.outcome).toBeNull();
  });
});
