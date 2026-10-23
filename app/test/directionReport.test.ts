// ============================================================
// test/directionReport.test.ts — v21.23.15 DIRECTION-ACCURACY REPORT
// Hermetic: seeds tracked-signals.json in the suite's SMARTAI_DATA_DIR
// BEFORE the module is imported (store captures DATA_DIR at eval time).
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { getDirectionReport as GetDirectionReport } from '../server/intraday/trackRecord.js';

const DATA = process.env.SMARTAI_DATA_DIR!;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let report: typeof GetDirectionReport;

const row = (over: Record<string, unknown>) => ({
  id: `r-${Math.random()}`,
  symbol: 'X', market: 'INDIA', direction: 'LONG',
  entry: 100, stopLoss: 99, target1: 101, target2: 102,
  qtyPerLakh: 100, risk: 1,
  confidence: 75, quantConfidence: 75,
  dayKey: '2026-10-23', openedAt: NOW - DAY,
  lastPrice: 100, status: 'T2_HIT', t1Hit: true,
  exitPrice: 102, closedAt: NOW - DAY / 2,
  disciplinedPnlPerLakh: 200, rMultiple: 2,
  ...over,
});

beforeAll(async () => {
  const signals = [
    // INDIA LONG win — engine-tagged, wide margin, high confidence
    row({
      symbol: 'AAA', market: 'INDIA', direction: 'LONG', confidence: 85,
      dirScore: 42, qualityScore: 38, edgeMargin: 25,
      marginGateMode: 'shadow', marginPass: true, directionalTie: false,
    }),
    // INDIA SHORT loss — sub-minimum margin
    row({
      symbol: 'BBB', market: 'INDIA', direction: 'SHORT', confidence: 66,
      status: 'SL_HIT', exitPrice: 101, disciplinedPnlPerLakh: -100, rMultiple: -1,
      dirScore: 22, qualityScore: 20, edgeMargin: 8,
      marginGateMode: 'shadow', marginPass: false, marginWouldBlock: true, directionalTie: false,
    }),
    // CRYPTO LONG win — margin bucket 12-19
    row({
      symbol: 'BTC', market: 'CRYPTO', direction: 'LONG', confidence: 75,
      dayKey: '2026-10-23', dirScore: 30, qualityScore: 22, edgeMargin: 14,
      marginGateMode: 'shadow', marginPass: true, directionalTie: false,
    }),
    // FUTURES still OPEN — no outcome, counts in n/open only
    row({
      symbol: 'ETH', market: 'FUTURES', direction: 'LONG', confidence: 72,
      status: 'OPEN', t1Hit: false, exitPrice: null, closedAt: null,
      disciplinedPnlPerLakh: null, rMultiple: null,
      dirScore: 28, qualityScore: 18, edgeMargin: 12,
      marginGateMode: 'shadow', marginPass: true, directionalTie: false,
    }),
    // Legacy/board row without engine telemetry — must survive as n/a.
    // Whitespace confidence must stay missing (Number('   ') === 0 trap).
    row({
      symbol: 'CCC', market: 'INDIA', direction: 'SHORT', confidence: '   ',
      quantConfidence: '   ',
      status: 'BE_TRAIL_EXIT', exitPrice: 100, disciplinedPnlPerLakh: 0, rMultiple: 0,
      dirScore: null, directionScore: null, qualityScore: null, edgeMargin: null,
      directionalTie: true,
    }),
    // Excluded and FLIP rows must never enter the report
    row({ symbol: 'EXCLUDED', market: 'INDIA', excluded: true }),
    row({ symbol: 'FLIP', market: 'INDIA', status: 'FLIP' }),
    // Outside the lookback window
    row({ symbol: 'OLD', market: 'INDIA', openedAt: NOW - 90 * DAY }),
  ];
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'tracked-signals.json'), JSON.stringify({ signals }));
  const mod = await import('../server/intraday/trackRecord.js');
  report = mod.getDirectionReport;
});

describe('v21.23.15 getDirectionReport', () => {
  it('aggregates the FULL tracked state (not the trimmed 40-row history)', () => {
    const r = report(30, 'ALL');
    expect(r.ok).toBe(true);
    expect(r.tab).toBe('ALL');
    expect(r.totals.n).toBe(5);              // 4 closed + 1 open; excluded/FLIP/old removed
    expect(r.totals.open).toBe(1);
    expect(r.totals.resolved).toBe(3);       // 0-pnl breakeven is not a win or loss
    expect(r.totals.wins).toBe(2);
    expect(r.totals.losses).toBe(1);
    expect(r.totals.winRate).toBe(66.7);
    expect(r.totals.breakeven).toBe(1);
    expect(r.totals.avgR).toBe(0.75); // (2 - 1 + 2 + 0) / 4 settled R rows
    expect(r.totals.avgConfidence).toBe(74.5); // (85 + 66 + 75 + 72) / 4 — CCC blank
    expect(r.totals.mfe).toBeNull();
    expect(r.totals.mae).toBeNull();
    expect(r.totals.trackedAllTime).toBe(6);
    expect(r.totals.outsideWindow).toBe(1);
    expect(r.totals.excludedCount).toBe(1);
    expect(r.byStatus.OPEN).toBe(1);
    expect(r.byStatus.SL_HIT).toBe(1);
  });

  it('splits INDIA vs CRYPTO/FUTURES and LONG vs SHORT honestly', () => {
    const r = report(30, 'ALL');
    const india = r.byMarket.find(m => m.market === 'INDIA')!;
    const crypto = r.byMarket.find(m => m.market === 'CRYPTO')!;
    const futures = r.byMarket.find(m => m.market === 'FUTURES')!;
    expect(india.n).toBe(3);
    expect(india.winRate).toBe(50);          // 1 win (AAA), 1 loss (BBB), 1 breakeven
    expect(crypto.n).toBe(1);
    expect(crypto.winRate).toBe(100);
    expect(futures.n).toBe(1);
    expect(futures.resolved).toBe(0);
    expect(r.bySide.LONG.n).toBe(3);
    expect(r.bySide.LONG.winRate).toBe(100);  // AAA + BTC wins, ETH open
    expect(r.bySide.SHORT.n).toBe(2);
    expect(r.bySide.SHORT.winRate).toBe(0);   // BBB loss, CCC breakeven
  });

  it('buckets hit-rate by confidence and edge margin', () => {
    const r = report(30, 'ALL');
    const b = (arr: Array<{ bucket: string }>, k: string) => arr.find(x => x.bucket === k)! as never;
    expect(b(r.confidenceBuckets, '60-69').n).toBe(1);
    expect(b(r.confidenceBuckets, '80-89').winRate).toBe(100);
    expect(b(r.confidenceBuckets, 'missing').n).toBe(1);
    expect(b(r.marginBuckets, '<12').n).toBe(1);
    expect(b(r.marginBuckets, '<12').winRate).toBe(0);
    expect(b(r.marginBuckets, '12-19').n).toBe(2);
    expect(b(r.marginBuckets, '20-29').n).toBe(1);
    expect(b(r.marginBuckets, 'n/a').n).toBe(1);
  });

  it('reports telemetry coverage and gate evidence without inventing scores', () => {
    const r = report(30, 'ALL');
    expect(r.telemetry.withDirScore).toBe(4);
    expect(r.telemetry.missingDirScore).toBe(1);
    expect(r.telemetry.withEdgeMargin).toBe(4);
    expect(r.telemetry.directionalTies).toBe(1);
    expect(r.telemetry.marginWouldBlock).toBe(1);
    expect(r.telemetry.marginGateModes.shadow).toBe(4);
    expect(r.telemetry.marginGateModes.missing).toBe(1);
  });

  it('tab filter narrows to one desk and clamps the window', () => {
    const india = report(30, 'INDIA');
    expect(india.tab).toBe('INDIA');
    expect(india.totals.n).toBe(3);
    expect(india.byMarket.map(m => m.market)).toEqual(['INDIA']);
    // Provenance counters are tab-scoped, not global.
    expect(india.totals.trackedAllTime).toBe(4); // AAA/BBB/CCC/OLD
    expect(india.totals.outsideWindow).toBe(1);
    expect(india.totals.excludedCount).toBe(1);
    const crypto = report(30, 'CRYPTO');
    expect(crypto.totals.trackedAllTime).toBe(1);
    expect(crypto.totals.outsideWindow).toBe(0);
    expect(crypto.totals.excludedCount).toBe(0);
    expect(report(30, 'NOPE').tab).toBe('ALL'); // unknown tab = honest ALL
    expect(report(0, 'ALL').days).toBe(1);
  });
});
