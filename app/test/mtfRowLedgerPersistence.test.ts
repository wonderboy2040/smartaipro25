// ============================================================
// test/mtfRowLedgerPersistence.test.ts — v21.25.2 MTF ROW-LEDGER LOCKS
// ------------------------------------------------------------
// Regression guards for the Phase 3 audit fixes:
//   • legacy-shape rows are ARCHIVED (not deleted) and the active file
//     keeps only current-format rows
//   • save/load roundtrip preserves rows + lastLogAt/lastResolveAt, and
//     non-forced saves respect the 30s throttle
//   • hydrateMtfLedger dedups per MARKET+symbol+mode+30m bucket (CRYPTO
//     BTC and FUTURES BTC are different scans) and rebuilds the dedup map
//   • phase-0 audit treats outcome:'PENDING' as UNRESOLVED
//   • buildPhase0Audit({walletINR}) sizes risk caps + over-risk checks
//     from the actual live wallet, not the configured ₹10,000 fallback
//
// Hermetic: apna TMP data dir, koi real server/data IO nahi.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-row-ledger-test-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

import {
  loadMtfRowLedger,
  saveMtfRowLedger,
  __resetMtfRowLedgerStoreForTests,
  MTF_ROW_LEDGER_FILE,
  MTF_ROW_LEDGER_LEGACY_FILE,
} from '../server/ai/mtfRowLedgerStore.js';
import {
  hydrateMtfLedger,
  getMtfLedgerSnapshot,
  recordMtfBoardScanRow,
  __resetMtfLedgerForTests,
} from '../server/ai/signalLedger.js';
import { buildPhase0Audit, __resetPhase0AuditCacheForTests } from '../server/ai/phase0Audit.js';
import { __resetMtfAutoForTests } from '../server/ai/mtfAutoLink.js';

const writeJson = (name, value) => fs.writeFileSync(path.join(TMP_DATA, name), JSON.stringify(value, null, 2));
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(TMP_DATA, name), 'utf8'));

const BUCKET_MS = 30 * 60_000;
const BUCKET_START = Math.floor(1_700_000_000_000 / BUCKET_MS) * BUCKET_MS;

function currentRow(over = {}) {
  return {
    id: 'mtf-BTC-INTRADAY-1700000000000-abcde',
    symbol: 'BTC',
    market: 'CRYPTO',
    mode: 'INTRADAY',
    side: 'LONG',
    entry: 100,
    stopLoss: 99,
    t1: 101,
    t2: 102,
    risk: 1,
    ts: BUCKET_START + 1_000,
    peakFavPrice: 100,
    peakAdvPrice: 100,
    mfeR: 0,
    maeR: 0,
    resolved: false,
    resolvedAt: null,
    outcome: 'PENDING',
    outcomeR: null,
    directionHit: null,
    ...over,
  };
}

function legacyRow(over = {}) {
  return {
    id: 'legacy-BTC-1',
    ts: 1_690_000_000_000,
    market: 'CRYPTO',
    mode: 'INTRADAY',
    symbol: 'BTC',
    side: 'LONG',
    entry: 100,
    stopLoss: 99,
    t1: 101,
    t2: 102,
    outcome: null,
    ...over,
  };
}

beforeEach(() => {
  __resetMtfRowLedgerStoreForTests();
  __resetMtfLedgerForTests();
  __resetPhase0AuditCacheForTests();
  for (const name of [MTF_ROW_LEDGER_FILE, MTF_ROW_LEDGER_LEGACY_FILE]) {
    try { fs.unlinkSync(path.join(TMP_DATA, name)); } catch { /* absent */ }
  }
});

describe('MTF row-ledger persistence', () => {
  it('archives legacy-shape rows and keeps current rows in the active file', () => {
    writeJson(MTF_ROW_LEDGER_FILE, {
      rows: [
        legacyRow(),
        legacyRow({ id: 'legacy-ETH-1', symbol: 'ETH', outcome: 'WIN' }),
        currentRow(),
        currentRow({ id: 'mtf-ETH-INTRADAY-1', symbol: 'ETH', side: 'SHORT', entry: 50, stopLoss: 51, t1: 49, t2: 48 }),
      ],
      lastLogAt: 111,
      lastResolveAt: 222,
    });

    const out = loadMtfRowLedger();
    expect(out.legacyArchived).toBe(2);
    expect(out.rows.map((r) => r.id)).toEqual(['mtf-BTC-INTRADAY-1700000000000-abcde', 'mtf-ETH-INTRADAY-1']);
    expect(out.lastLogAt).toBe(111);
    expect(out.lastResolveAt).toBe(222);

    // legacy rows preserved in the archive with their original metadata
    const archive = readJson(MTF_ROW_LEDGER_LEGACY_FILE);
    expect(archive.count).toBe(2);
    expect(archive.source).toBe(MTF_ROW_LEDGER_FILE);
    expect(archive.sourceLastLogAt).toBe(111);
    expect(archive.sourceLastResolveAt).toBe(222);
    expect(archive.rows.map((r) => r.id).sort()).toEqual(['legacy-BTC-1', 'legacy-ETH-1']);

    // active file no longer carries the legacy rows
    const active = readJson(MTF_ROW_LEDGER_FILE);
    expect(active.rows.map((r) => r.id)).toEqual(['mtf-BTC-INTRADAY-1700000000000-abcde', 'mtf-ETH-INTRADAY-1']);
    expect(active.legacyArchivedAt).toBeTypeOf('number');

    // second load is a no-op — archive is not duplicated/rewritten
    const again = loadMtfRowLedger();
    expect(again.legacyArchived).toBe(0);
    expect(again.rows).toHaveLength(2);
  });

  it('roundtrips rows + metadata and throttles non-forced writes', () => {
    const snapshot = {
      rows: [currentRow()],
      lastLogAt: 123,
      lastResolveAt: 456,
    };
    expect(saveMtfRowLedger(snapshot, { force: true, now: 1_000 })).toBe(true);

    const loaded = loadMtfRowLedger();
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.rows[0].id).toBe(snapshot.rows[0].id);
    expect(loaded.lastLogAt).toBe(123);
    expect(loaded.lastResolveAt).toBe(456);
    expect(loaded.legacyArchived).toBe(0);

    // inside the 30s window: reported success, but disk is untouched
    const changed = { rows: [currentRow({ id: 'mtf-BTC-INTRADAY-2' })], lastLogAt: 999, lastResolveAt: null };
    expect(saveMtfRowLedger(changed, { now: 2_000 })).toBe(true);
    expect(loadMtfRowLedger().rows[0].id).toBe(snapshot.rows[0].id);
    expect(loadMtfRowLedger().lastLogAt).toBe(123);

    // after the throttle window the new snapshot is written
    expect(saveMtfRowLedger(changed, { now: 40_000 })).toBe(true);
    const after = loadMtfRowLedger();
    expect(after.rows[0].id).toBe('mtf-BTC-INTRADAY-2');
    expect(after.lastLogAt).toBe(999);
    expect(after.lastResolveAt).toBeNull();
  });
});

describe('MTF ledger hydration + dedup', () => {
  it('keeps CRYPTO and FUTURES rows for the same symbol/bucket, latest per market wins', () => {
    const out = hydrateMtfLedger([
      currentRow({ id: 'crypto-old', ts: BUCKET_START + 1_000 }),
      currentRow({ id: 'crypto-new', ts: BUCKET_START + 120_000 }),
      currentRow({ id: 'futures-btc', market: 'FUTURES', ts: BUCKET_START + 60_000, side: 'SHORT', entry: 100, stopLoss: 101, t1: 99, t2: 98 }),
      // invalid side is dropped entirely
      currentRow({ id: 'invalid-side', side: 'BUY' }),
    ], { lastLogAt: 777, lastResolveAt: 888 });

    expect(out.total).toBe(2);
    expect(out.lastLogAt).toBe(777);
    expect(out.lastResolveAt).toBe(888);
    const ids = getMtfLedgerSnapshot().rows.map((r) => r.id);
    expect(ids).toEqual(['futures-btc', 'crypto-new']);

    // dedup map was rebuilt: recording in the same market bucket returns
    // the hydrated row instead of a duplicate
    const rec = recordMtfBoardScanRow({
      symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY', side: 'LONG',
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    }, { now: BUCKET_START + 300_000 });
    expect(rec.id).toBe('crypto-new');
    expect(getMtfLedgerSnapshot().rows).toHaveLength(2);

    // a different market is NOT deduped against CRYPTO — each market's own
    // hydrated row is returned and both coexist
    const futuresRec = recordMtfBoardScanRow({
      symbol: 'BTC', market: 'FUTURES', mode: 'INTRADAY', side: 'SHORT',
      plan: { entry: 100, stopLoss: 101, t1: 99, t2: 98 },
    }, { now: BUCKET_START + 300_000 });
    expect(futuresRec.id).toBe('futures-btc');
    expect(getMtfLedgerSnapshot().rows.map((r) => r.id).sort()).toEqual(['crypto-new', 'futures-btc']);
  });
});

describe('Phase 0 audit — ledger resolution + wallet honesty', () => {
  it('counts outcome:PENDING as unresolved; resolved flag/resolvedAt/real outcome win', () => {
    __resetMtfAutoForTests(); // no config → riskCaps null, empty sources
    writeJson(MTF_ROW_LEDGER_FILE, {
      lastResolveAt: 987_654,
      rows: [
        currentRow({ id: 'pending', outcome: 'PENDING', resolved: false }),
        currentRow({ id: 'outcome-only', outcome: 'T1_HIT', resolved: false, resolvedAt: null }),
        currentRow({ id: 'resolved-at', outcome: null, resolved: false, resolvedAt: 123 }),
        currentRow({ id: 'flag', outcome: null, resolved: true }),
        currentRow({ id: 'unresolved', outcome: null, resolved: false }),
      ],
    });

    const a = buildPhase0Audit({ fresh: true });
    expect(a.sources.rowLedger.total).toBe(5);
    expect(a.sources.rowLedger.resolved).toBe(3);
    expect(a.sources.rowLedger.unresolved).toBe(2);
    expect(a.sources.rowLedger.resolvedPct).toBe(60);
    expect(a.sources.rowLedger.lastResolveAt).toBe(987_654);
    expect(a.unresolved.rowLedger).toBe(2);
    expect(a.warnings.join(' ')).toMatch(/MTF row-ledger 2\/5 unresolved/);
  });

  it('sizes risk caps + over-risk from the actual live wallet', () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true,
        executionMode: 'live',
        desks: { india: false, crypto: true },
        walletAmountINR: 10000,
        riskPerTradeINR: 2000,
        riskPerTradePct: 1,
        maxRiskPerTradePct: 2,
        maxLeverage: 5,
        maxWalletDeployPct: 25,
        dailyLossPct: 1.5,
        maxTradesPerDay: 3,
        maxOpenPositions: 2,
      },
      state: {
        book: [{
          paperId: 501, liveOrderId: 'ord-live', livePositionId: 'pos-live',
          executionMode: 'LIVE', traded: true, fullControl: true,
          symbol: 'XRP', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
          entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 100,
          t1: 101, t2: 102, qty: 2, leverage: 5,
          walletINR: 10000, riskINR: 30, // entry wallet was ₹10k
          openedAt: 4000, status: 'OPEN',
        }],
      },
    });

    // live equity is now ₹1,385 → ₹30 risk = 2.17% > 2% cap
    const live = buildPhase0Audit({ fresh: true, walletINR: 1385 });
    expect(live.riskCaps.walletINR).toBe(1385);
    expect(live.riskCaps.riskCapINR).toBe(13.85);
    expect(live.riskCaps.effectiveRiskINR).toBe(13.85);
    expect(live.riskCaps.dailyLossCapINR).toBe(20.78);
    expect(live.reconciliation.overRiskPositions).toBe(1);
    expect(live.reconciliation.examples.overRiskPositions[0]).toMatchObject({
      symbol: 'XRP', riskINR: 30, walletINR: 1385, positionWalletINR: 10000, riskPct: 2.17, capPct: 2,
    });
    expect(live.warnings.join(' ')).toMatch(/risk > 2% cap/);

    // same position against ₹10k is only 0.3% → not over-risk
    const configured = buildPhase0Audit({ fresh: true, walletINR: 10000 });
    expect(configured.riskCaps.walletINR).toBe(10000);
    expect(configured.riskCaps.riskCapINR).toBe(100);
    expect(configured.reconciliation.overRiskPositions).toBe(0);
  });
});
