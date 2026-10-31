// ============================================================
// test/mtfEntryTimingV21300.test.ts — v21.30.0 SIGNAL TIMING + DIRECTION
// ------------------------------------------------------------
// Locks:
//   • a LONG never fires against a bearish deep/trigger context (and mirror);
//   • certificate side / order side mismatches block;
//   • a fresh closed-bar reversal (sideStable:false) blocks;
//   • late chase >35% of risk and adverse move >15% of risk block;
//   • stale rows block; missing data fails OPEN (no fabricated block);
//   • the auto tick wires the guard and the tightened quote thresholds.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateEntryTiming, ENTRY_TIMING_DEFAULTS } from '../server/ai/mtfEntryTiming.js';

const row = (extra: any = {}) => ({
  symbol: 'BTC', ok: true, side: 'LONG', directionVerified: true,
  plan: { entry: 100, stopLoss: 99, t1: 102, t2: 103 },
  context: { dir: 1 }, trigger: { dir: 1 },
  ...extra,
});

describe('v21.30.0 — entry timing + direction agreement', () => {
  it('accepts a clean aligned row with no live quote (fail-open on missing quote)', () => {
    const out = evaluateEntryTiming({ row: row(), now: Date.now() });
    expect(out.ok).toBe(true);
    expect(out.side).toBe('LONG');
    expect(out.metrics.chaseRatio).toBeNull();
  });

  it('blocks row-side vs execution-side disagreement', () => {
    const out = evaluateEntryTiming({ row: row(), side: 'SHORT' });
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' | ')).toMatch(/direction disagreement: row side LONG/i);
  });

  it('blocks LONG against bearish context/trigger dir and SHORT against bullish', () => {
    const longBad = evaluateEntryTiming({ row: row({ context: { dir: -1 } }) });
    expect(longBad.ok).toBe(false);
    expect(longBad.blockers.join(' | ')).toMatch(/deep-TF context dir -1/i);

    const shortBad = evaluateEntryTiming({
      row: row({ side: 'SHORT', context: { dir: 1 }, trigger: { dir: 1 } }),
    });
    expect(shortBad.ok).toBe(false);
    expect(shortBad.blockers.join(' | ')).toMatch(/deep-TF context dir 1/i);

    const triggerBad = evaluateEntryTiming({ row: row({ trigger: { dir: -1 } }) });
    expect(triggerBad.ok).toBe(false);
    expect(triggerBad.blockers.join(' | ')).toMatch(/trigger dir -1/i);
  });

  it('blocks certificate block / side mismatch / wrong order side', () => {
    const blocked = evaluateEntryTiming({
      row: row({ directionCertificate: { ok: false, verdict: 'ORDER_SIDE_MISMATCH', reasons: ['bad map'] } }),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.join(' | ')).toMatch(/direction certificate blocked/i);

    const wrongSide = evaluateEntryTiming({
      row: row({ directionCertificate: { ok: true, side: 'SHORT', orderSide: 'sell' } }),
    });
    expect(wrongSide.ok).toBe(false);
    expect(wrongSide.blockers.join(' | ')).toMatch(/certificate side SHORT/i);

    const wrongOrder = evaluateEntryTiming({
      row: row({ directionCertificate: { ok: true, side: 'LONG', orderSide: 'sell' } }),
    });
    expect(wrongOrder.ok).toBe(false);
    expect(wrongOrder.blockers.join(' | ')).toMatch(/order side SELL.*BUY/i);
  });

  it('blocks a fresh closed-bar reversal (sideStable false)', () => {
    const out = evaluateEntryTiming({ row: row({ sideStable: false }) });
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' | ')).toMatch(/closed-bar reversal/i);
  });

  it('does not block an eligible row just because the closed bar had not fired yet', () => {
    // triggerStable:false on a trigger-fired row is the normal fresh intra-bar
    // entry (forming bar fires, last closed bar did not). Only a side flip or
    // a moved quote is a reversal.
    const out = evaluateEntryTiming({ row: row({ triggerStable: false, closedBarConfirm: false }) });
    expect(out.ok).toBe(true);
  });

  it('blocks an explicitly overextended trigger', () => {
    const out = evaluateEntryTiming({ row: row({ trigger: { dir: 1, overextended: true } }) });
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' | ')).toMatch(/overextended/i);
  });

  it('blocks late chase beyond 35% of risk and allows 20%', () => {
    const late = evaluateEntryTiming({ row: row(), livePrice: 100.4 });
    expect(late.ok).toBe(false);
    expect(late.metrics.chaseRatio).toBeCloseTo(0.4, 3);
    expect(late.blockers.join(' | ')).toMatch(/late chase/i);

    const ok = evaluateEntryTiming({ row: row(), livePrice: 100.2 });
    expect(ok.ok).toBe(true);
    expect(ok.metrics.chaseRatio).toBeCloseTo(0.2, 3);
  });

  it('blocks adverse reversal beyond 15% of risk and mirrors for SHORT', () => {
    const badLong = evaluateEntryTiming({ row: row(), livePrice: 99.8 });
    expect(badLong.ok).toBe(false);
    expect(badLong.metrics.adverseRatio).toBeCloseTo(0.2, 3);
    expect(badLong.blockers.join(' | ')).toMatch(/reversal: live already 20%/i);

    const shortRow = row({ side: 'SHORT', plan: { entry: 100, stopLoss: 101, t1: 98, t2: 97 }, context: { dir: -1 }, trigger: { dir: -1 } });
    expect(evaluateEntryTiming({ row: shortRow, livePrice: 100.2 }).ok).toBe(false); // moving against SHORT
    expect(evaluateEntryTiming({ row: shortRow, livePrice: 99.8 }).ok).toBe(true);  // moving for SHORT
  });

  it('blocks stale rows by builtAt age', () => {
    const now = 1_000_000;
    const out = evaluateEntryTiming({
      row: row({ builtAt: now - 120_000 }), now, maxRowAgeMs: 90_000,
    });
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' | ')).toMatch(/120s old/i);
  });

  it('exports conservative thresholds', () => {
    expect(ENTRY_TIMING_DEFAULTS.maxChaseRiskRatio).toBeLessThanOrEqual(0.35);
    expect(ENTRY_TIMING_DEFAULTS.maxAdverseRiskRatio).toBeLessThanOrEqual(0.15);
    expect(ENTRY_TIMING_DEFAULTS.maxRowAgeMs).toBeLessThanOrEqual(90_000);
  });
});

describe('v21.30.0 — timing guard wiring pins', () => {
  const root = process.cwd();
  const autoSrc = fs.readFileSync(path.join(root, 'server/ai/mtfAutoLink.js'), 'utf8');
  const boardSrc = fs.readFileSync(path.join(root, 'server/ai/mtfDualBoard.js'), 'utf8');

  it('auto tick enforces the guard before the R3-R9 gates', () => {
    expect(autoSrc).toContain("import { evaluateEntryTiming } from './mtfEntryTiming.js';");
    expect(autoSrc).toContain('const timingEval = evaluateEntryTiming({');
    expect(autoSrc).toContain('out.skipped.push(`${sym}: entry timing blocked');
    expect(autoSrc).toContain('entryTimingGuard: entryTimingGuardMode()');
    expect(autoSrc).toContain('entryTimingGuard: \'enforce\'');
    expect(autoSrc.indexOf('const timingEval')).toBeLessThan(autoSrc.indexOf('const guardEval'));
  });

  it('tightened live quote ratios and row freshness stamps are present', () => {
    expect(autoSrc).toContain('0.15 * riskPerUnit');
    expect(autoSrc).toContain('0.35 * riskPerUnit');
    expect(autoSrc).not.toContain('0.55 * riskPerUnit');
    expect(boardSrc).toContain('builtAt: Date.now()');
  });
});
