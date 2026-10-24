// ============================================================
// test/directionGateReadiness.test.ts — v21.23.17 GATE PROMOTION
// Hermetic: seeds its own SMARTAI_DATA_DIR before importing trackRecord.
// Locks the two honest outcomes:
//   • margin gate → PROMOTE_READY (blocked cohort materially worse)
//   • stale gate  → KEEP_SHADOW   (blocked cohort actually wins)
// and that enforce mode reports ENFORCED instead of re-recommending.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { getDirectionReport as GetDirectionReport } from '../server/intraday/trackRecord.js';

const DATA = path.join(os.tmpdir(), `smartai-gate-readiness-${process.pid}-${Date.now()}`);
const PREV_DATA = process.env.SMARTAI_DATA_DIR;
process.env.SMARTAI_DATA_DIR = DATA;
delete process.env.INTRADAY_MARGIN_GATE;
delete process.env.INTRADAY_STALE_GUARD;
delete process.env.INTRADAY_MIN_MARGIN;
delete process.env.INTRADAY_STALE_MAX_PCT;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
let report: typeof GetDirectionReport;

const row = (id: string, { margin, stale, win }: { margin: number; stale: boolean; win: boolean }) => ({
  id, symbol: id, market: 'INDIA', direction: 'LONG',
  entry: 100, stopLoss: 99, target1: 101, target2: 102,
  qtyPerLakh: 100, risk: 1,
  confidence: 75, quantConfidence: 75,
  dayKey: '2026-10-23', openedAt: NOW - DAY,
  lastPrice: 100, status: win ? 'T2_HIT' : 'SL_HIT', t1Hit: false,
  exitPrice: win ? 101 : 99, closedAt: NOW - DAY / 2,
  disciplinedPnlPerLakh: win ? 100 : -100, rMultiple: win ? 1 : -1,
  dirScore: 30, qualityScore: 20, edgeMargin: margin,
  marginGateMode: 'shadow', marginPass: margin >= 12, directionalTie: false,
  staleGuardMode: 'shadow', staleDetected: stale, ltpTvDivPct: stale ? 2.5 : 0.1,
});

beforeAll(async () => {
  // A = 10 sub-margin losers (both gates see them as blocked margin / clean stale)
  // B = 10 wide-margin winners that are ALSO stale-detected
  // C = 10 wide-margin winners, clean stale
  // D = 10 wide-margin losers, clean stale
  const signals = [
    ...Array.from({ length: 10 }, (_, i) => row(`A${i}`, { margin: 5, stale: false, win: false })),
    ...Array.from({ length: 10 }, (_, i) => row(`B${i}`, { margin: 20, stale: true, win: true })),
    ...Array.from({ length: 10 }, (_, i) => row(`C${i}`, { margin: 20, stale: false, win: true })),
    ...Array.from({ length: 10 }, (_, i) => row(`D${i}`, { margin: 20, stale: false, win: false })),
  ];
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'tracked-signals.json'), JSON.stringify({ signals }));
  const mod = await import('../server/intraday/trackRecord.js');
  report = mod.getDirectionReport;
});

afterAll(() => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (PREV_DATA === undefined) delete process.env.SMARTAI_DATA_DIR;
  else process.env.SMARTAI_DATA_DIR = PREV_DATA;
});

describe('v21.23.17 gate promotion readiness', () => {
  it('recommends enforce only when the blocked margin cohort underperforms', () => {
    const r = report(30, 'ALL');
    const m = r.gateReadiness.margin;
    expect(m.mode).toBe('shadow');
    expect(m.blocked.resolved).toBe(10);
    expect(m.blocked.winRate).toBe(0);       // A: all sub-margin rows lost
    expect(m.kept.resolved).toBe(30);        // B + C + D
    expect(m.kept.winRate).toBe(66.7);       // 20 wins / 30
    expect(m.winRateGapPp).toBe(66.7);
    expect(m.status).toBe('PROMOTE_READY');
    expect(m.recommended).toBe(true);
    expect(m.nextStep).toContain('INTRADAY_MARGIN_GATE=enforce');
  });

  it('keeps the stale guard in shadow when the stale cohort actually wins', () => {
    const r = report(30, 'ALL');
    const s = r.gateReadiness.stale;
    expect(s.blocked.resolved).toBe(10);     // B: stale-detected winners
    expect(s.blocked.winRate).toBe(100);
    expect(s.kept.resolved).toBe(30);        // A + C + D
    expect(s.kept.winRate).toBe(33.3);       // 10 wins / 30
    expect(s.winRateGapPp).toBe(-66.7);
    expect(s.status).toBe('KEEP_SHADOW');
    expect(s.recommended).toBe(false);
    expect(s.nextStep).toContain('INTRADAY_STALE_GUARD=shadow');
  });

  it('marks an explicitly enforced gate as ENFORCED (no stale recommendation)', () => {
    process.env.INTRADAY_MARGIN_GATE = 'enforce';
    try {
      const r = report(30, 'ALL');
      expect(r.gateReadiness.config.marginGate).toBe('enforce');
      expect(r.gateReadiness.margin.status).toBe('ENFORCED');
      expect(r.gateReadiness.margin.recommended).toBe(false);
      expect(r.gateReadiness.margin.nextStep).toContain('is enforced');
    } finally {
      delete process.env.INTRADAY_MARGIN_GATE;
    }
  });
});
