// ============================================================
// test/monitorTelemetryV21280.test.ts — F9 DEEP-MONITOR HONESTY
// ------------------------------------------------------------
// Audit finding F9: the UI could show "full control / monitoring" while the
// decision lane was dead, the exchange stop was missing/diverged, or the exit
// ladder was misrepresented. Locks:
//   • heartbeat stamps ONLY on real monitor lanes (status poll cannot mask)
//   • stale after 10s, never-stamped = null (unknown, not healthy)
//   • protection badges: PAPER / BROKER / PROTECTED / SYNC_PENDING /
//     UNVERIFIED / DIVERGED
//   • ladder rung + next-action preview never invent a stop move
//   • adoption arms protection from exchange truth, marks unknown pending
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-telemetry-21280-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  __resetMtfAutoForTests, getActiveAutoTradesDeepMonitor, mtfAutoStatus,
  syncCoinDcxActivePositionsToDeepMonitor,
  _stampDeepMonitorHeartbeat, _deepMonitorHeartbeat,
  _deepMonitorProtection, _ladderTracker, _nextActionPreview,
  DEEP_MONITOR_STALE_MS,
} from '../server/ai/mtfAutoLink.js';

const NOW = 1_765_000_000_000;

function paperRow(over: Record<string, any> = {}) {
  return {
    paperId: 111, executionMode: 'PAPER', traded: true, openedBy: 'AUTO', autoTrade: true,
    symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT',
    side: 'LONG', entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99,
    t1: 101, t2: 102, qty: 1, peakPrice: 100,
    openedAt: NOW - 5 * 60_000, status: 'OPEN', directionVerified: true,
    ...over,
  };
}

function liveRow(over: Record<string, any> = {}) {
  return paperRow({
    paperId: null, executionMode: 'LIVE', fullControl: true, openedInLiveMode: true,
    liveOrderId: 'ord-1', livePositionId: 'pos-1', lastExchangeSl: 99,
    ...over,
  });
}

function seed(book: any[], cfgOver: Record<string, any> = {}) {
  __resetMtfAutoForTests({
    config: {
      enabled: true, executionMode: 'paper', minScore: 75,
      desks: { india: false, crypto: true },
      ...cfgOver,
    },
    state: { book },
  });
}

function mon(over: Record<string, any> = {}) {
  return {
    entry: 100, ltp: 100.5, initialStopLoss: 99, previousStopLoss: 99, trailedStopLoss: 99,
    t1: 101, t2: 102, tp1Hit: false, tp1LadderActive: false, tp2Hit: false,
    tp2Approach: false, tp2ProgressPct: 35, distToTp1Pct: 0.5, distToTp2Pct: 1.5,
    stageCode: 'STAGE_0_INITIAL_GUARD', shouldClose: false, directionBlocked: false,
    exitPolicyV3: { applied: false, mode: 'shadow' },
    ...over,
  };
}

beforeEach(() => {
  __resetMtfAutoForTests();
});

// ------------------------------------------------------------
// Heartbeat
// ------------------------------------------------------------
describe('v21.28.0 F9 heartbeat — fresh, stale, unknown', () => {
  it('never-stamped heartbeat is honestly unknown (not healthy)', () => {
    const hb = _deepMonitorHeartbeat({ now: NOW });
    expect(DEEP_MONITOR_STALE_MS).toBe(10_000);
    expect(hb.lastDecisionAt).toBeNull();
    expect(hb.ageMs).toBeNull();
    expect(hb.stale).toBeNull();
    expect(hb.decisions).toBe(0);
    expect(hb.lastSource).toBeNull();
  });

  it('stamps source/count and goes stale only after 10s', () => {
    _stampDeepMonitorHeartbeat({ source: 'fast-3s', now: NOW, count: 2 });
    const fresh = _deepMonitorHeartbeat({ now: NOW + 5_000 });
    expect(fresh.lastDecisionAt).toBe(NOW);
    expect(fresh.ageMs).toBe(5_000);
    expect(fresh.stale).toBe(false);
    expect(fresh.decisions).toBe(1);
    expect(fresh.lastSource).toBe('fast-3s');
    expect(fresh.lastCount).toBe(2);
    expect(fresh.sources[0]).toMatchObject({ source: 'fast-3s', count: 1, lastCount: 2 });

    const stale = _deepMonitorHeartbeat({ now: NOW + 10_001 });
    expect(stale.stale).toBe(true);
    expect(stale.ageMs).toBe(10_001);
  });

  it('counts each lane separately', () => {
    _stampDeepMonitorHeartbeat({ source: 'fast-3s', now: NOW, count: 1 });
    _stampDeepMonitorHeartbeat({ source: 'super-agent', now: NOW + 100, count: 1 });
    _stampDeepMonitorHeartbeat({ source: 'fast-3s', now: NOW + 200, count: 2 });
    const hb = _deepMonitorHeartbeat({ now: NOW + 300 });
    expect(hb.decisions).toBe(3);
    expect(hb.lastSource).toBe('fast-3s');
    const bySource = Object.fromEntries(hb.sources.map(s => [s.source, s]));
    expect(bySource['fast-3s'].count).toBe(2);
    expect(bySource['super-agent'].count).toBe(1);
  });

  it('deep-monitor view stamps only when the genuine lane opts in', () => {
    seed([paperRow()]);
    const poll = getActiveAutoTradesDeepMonitor({ BTC: 100.5 }, { now: NOW });
    expect(poll.heartbeat.lastDecisionAt).toBeNull();
    expect(poll.trades[0].decisionAt).toBe(NOW);

    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', desks: { india: false, crypto: true } },
      state: { book: [paperRow()] },
    });
    const lane = getActiveAutoTradesDeepMonitor({ BTC: 100.5 }, {
      now: NOW, stampHeartbeat: true, source: 'fast-3s',
    });
    expect(lane.heartbeat.lastDecisionAt).toBe(NOW);
    expect(lane.heartbeat.lastSource).toBe('fast-3s');
    expect(lane.heartbeat.decisions).toBe(1);
  });

  it('status polling never masks a dead monitor lane', () => {
    seed([paperRow()]);
    const st = mtfAutoStatus({ BTC: 100.5 });
    expect(st.deepMonitor.heartbeat.lastDecisionAt).toBeNull();
    expect(st.deepMonitor.heartbeat.stale).toBeNull();
  });
});

// ------------------------------------------------------------
// Protection badge
// ------------------------------------------------------------
describe('v21.28.0 F9 protection badge — exchange truth only', () => {
  it('PAPER row is never labelled exchange-protected', () => {
    const p = _deepMonitorProtection({ executionMode: 'PAPER', market: 'CRYPTO' }, mon());
    expect(p.state).toBe('PAPER');
    expect(p.label).toContain('PAPER');
  });

  it('India LIVE row is BROKER (not verifiable via CoinDCX)', () => {
    const p = _deepMonitorProtection({ executionMode: 'LIVE', market: 'INDIA', lastExchangeSl: 99 }, mon());
    expect(p.state).toBe('BROKER');
    expect(p.venue).toBe('broker');
  });

  it('LIVE row with verified matching exchange SL is PROTECTED', () => {
    const p = _deepMonitorProtection({ executionMode: 'LIVE', market: 'CRYPTO', lastExchangeSl: 99 }, mon());
    expect(p.state).toBe('PROTECTED');
    expect(p.exchangeSl).toBe(99);
    expect(p.diffPct).toBe(0);
  });

  it('pending SL push is SYNC_PENDING even when an old SL exists', () => {
    const p = _deepMonitorProtection({
      executionMode: 'LIVE', market: 'CRYPTO', lastExchangeSl: 99,
      slSyncPending: true, slLastSyncError: 'read-back unverified',
    }, mon({ trailedStopLoss: 99.5 }));
    expect(p.state).toBe('SYNC_PENDING');
    expect(p.reason).toContain('read-back');
  });

  it('LIVE row with no exchange read-back is UNVERIFIED', () => {
    const p = _deepMonitorProtection({ executionMode: 'LIVE', market: 'CRYPTO', lastExchangeSl: null }, mon());
    expect(p.state).toBe('UNVERIFIED');
    expect(p.exchangeSl).toBeNull();
  });

  it('book-vs-exchange stop drift is DIVERGED', () => {
    const p = _deepMonitorProtection({
      executionMode: 'LIVE', market: 'CRYPTO', lastExchangeSl: 99,
    }, mon({ trailedStopLoss: 99.5 }));
    expect(p.state).toBe('DIVERGED');
    expect(p.diffPct).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------
// Ladder tracker
// ------------------------------------------------------------
describe('v21.28.0 F9 ladder tracker — honest rungs', () => {
  it('pre-TP1: initial SL is the only active stop', () => {
    const l = _ladderTracker({}, mon());
    expect(l.rung).toBe('INITIAL_SL');
    expect(l.steps[0]).toMatchObject({ key: 'INITIAL_SL', state: 'ACTIVE', price: 99 });
    expect(l.steps[1].state).toBe('PENDING');
    expect(l.steps[1].stop).toBeNull();
  });

  it('TP1 locked: fee-BE rung is active with the live stop', () => {
    const l = _ladderTracker({}, mon({
      tp1Hit: true, tp1LadderActive: true, trailedStopLoss: 100.2, tp2ProgressPct: 45,
    }));
    expect(l.rung).toBe('FEE_BE');
    expect(l.steps[0].state).toBe('DONE');
    expect(l.steps[1]).toMatchObject({ key: 'FEE_BE', state: 'ACTIVE', stop: 100.2 });
    expect(l.progressPct).toBe(45);
  });

  it('TP2 approach: stop-at-TP1 rung is active', () => {
    const l = _ladderTracker({}, mon({
      tp1Hit: true, tp1LadderActive: true, tp2Approach: true,
      trailedStopLoss: 101, tp2ProgressPct: 84,
    }));
    expect(l.rung).toBe('TP1_LOCK');
    expect(l.steps[2]).toMatchObject({ key: 'TP1_LOCK', state: 'ACTIVE', stop: 101 });
  });

  it('TP2 hit: exit rung + 100% progress', () => {
    const l = _ladderTracker({}, mon({ tp2Hit: true, tp2ProgressPct: 120 }));
    expect(l.rung).toBe('TP2_EXIT');
    expect(l.progressPct).toBe(100);
    expect(l.steps[3].state).toBe('ACTIVE');
  });

  it('V3 enforce wick TP1 is WAITING, not a locked ladder', () => {
    const l = _ladderTracker({}, mon({
      tp1Hit: true, tp1LadderActive: false,
      exitPolicyV3: { applied: true, mode: 'enforce' },
    }));
    expect(l.rung).toBe('TP1_CONFIRM');
    expect(l.awaitingTp1Confirm).toBe(true);
    expect(l.note).toContain('closed bar');
    expect(l.steps.some(s => s.key === 'TP1_CONFIRM' && s.state === 'WAITING')).toBe(true);
  });
});

// ------------------------------------------------------------
// Next-action preview
// ------------------------------------------------------------
describe('v21.28.0 F9 next-action preview — no invented actions', () => {
  it('direction blocked is critical', () => {
    const n = _nextActionPreview({}, mon({ directionBlocked: true, directionCertificate: { reasons: ['side missing'] } }));
    expect(n.code).toBe('DIRECTION_BLOCKED');
    expect(n.detail).toContain('side missing');
  });

  it('TP2 hit previews a full close', () => {
    const n = _nextActionPreview({}, mon({ tp2Hit: true }));
    expect(n.code).toBe('TP2_EXIT');
    expect(n.urgency).toBe('critical');
  });

  it('V3 wick TP1 previews await-close (no stop move)', () => {
    const n = _nextActionPreview({}, mon({
      tp1Hit: true, tp1LadderActive: false,
      exitPolicyV3: { applied: true },
    }));
    expect(n.code).toBe('AWAIT_TP1_CLOSE');
    expect(n.detail).toContain('initial SL');
  });

  it('TP1 locked previews the fee-BE stop', () => {
    const n = _nextActionPreview({}, mon({
      tp1Hit: true, tp1LadderActive: true, trailedStopLoss: 100.2,
    }), { state: 'PROTECTED', venue: 'coindcx' });
    expect(n.code).toBe('SL_AT_FEE_BE');
    expect(n.label).toContain('100.2');
  });

  it('pre-TP1 hold warns when protection is unverified', () => {
    const n = _nextActionPreview({}, mon(), { state: 'UNVERIFIED', venue: 'coindcx' });
    expect(n.code).toBe('HOLD_INITIAL_SL');
    expect(n.urgency).toBe('warn');
    expect(n.detail).toContain('TP1');
  });
});

// ------------------------------------------------------------
// Adoption / reconciler protection arming
// ------------------------------------------------------------
describe('v21.28.0 F9 adoption — protection arming', () => {
  const pos = (over: Record<string, any> = {}) => ({
    id: 'cdx-1', positionId: 'cdx-1', pair: 'B-BTC_USDT', symbol: 'BTC',
    activePos: 2, entry: 100, ltp: 101, leverage: 5, openedAt: NOW - 60_000,
    stopLoss: 98, exchangeSl: 98, ...over,
  });

  it('new adoption with exchange SL records the verified anchor', () => {
    seed([]);
    syncCoinDcxActivePositionsToDeepMonitor([pos()], { now: NOW });
    const row = (mtfAutoStatus().book || []).find(b => b.symbol === 'BTC' && b.status === 'OPEN');
    expect(row).toBeTruthy();
    expect(row!.side).toBe('LONG');
    expect(row!.lastExchangeSl).toBe(98);
    expect(row!.slSyncPending).toBe(false);
    expect(row!.originalQty).toBe(2);
    expect(row!.qty).toBe(2);
  });

  it('new adoption without exchange SL stays sync-pending', () => {
    seed([]);
    syncCoinDcxActivePositionsToDeepMonitor([pos({ exchangeSl: null })], { now: NOW });
    const row = (mtfAutoStatus().book || []).find(b => b.symbol === 'BTC' && b.status === 'OPEN');
    expect(row).toBeTruthy();
    expect(row!.lastExchangeSl).toBeNull();
    expect(row!.slSyncPending).toBe(true);
    expect(row!.originalQty).toBe(2);
  });

  it('a side re-sync invalidates the old protection and re-arms SL + TP', () => {
    seed([liveRow()]);
    syncCoinDcxActivePositionsToDeepMonitor([
      pos({ activePos: -2, side: 'SHORT', stopLoss: 102, exchangeSl: 102 }),
    ], { now: NOW });
    const row = (mtfAutoStatus().book || []).find(b => b.symbol === 'BTC' && b.status === 'OPEN');
    expect(row!.side).toBe('SHORT');
    expect(row!.lastExchangeSl).toBeNull();
    expect(row!.slSyncPending).toBe(true);
    expect(row!.tpSyncPending).toBe(true);
  });

  it('an existing row with a verified exchange SL is anchored (no false pending)', () => {
    seed([liveRow({ lastExchangeSl: null, slSyncPending: true })]);
    syncCoinDcxActivePositionsToDeepMonitor([pos()], { now: NOW });
    const row = (mtfAutoStatus().book || []).find(b => b.symbol === 'BTC' && b.status === 'OPEN');
    expect(row!.lastExchangeSl).toBe(98);
    expect(row!.slSyncPending).toBe(false);
  });

  it('an exchange list without SL never erases a previously verified anchor', () => {
    seed([liveRow({ lastExchangeSl: 99 })]);
    syncCoinDcxActivePositionsToDeepMonitor([pos({ exchangeSl: null })], { now: NOW });
    const row = (mtfAutoStatus().book || []).find(b => b.symbol === 'BTC' && b.status === 'OPEN');
    expect(row!.lastExchangeSl).toBe(99);
    expect(row!.slSyncPending).not.toBe(true);
  });

  it('legacy callers without an exchangeSl field keep their fixture contract', () => {
    seed([]);
    const legacy = pos();
    delete (legacy as any).exchangeSl;
    syncCoinDcxActivePositionsToDeepMonitor([legacy], { now: NOW });
    const row = (mtfAutoStatus().book || []).find(b => b.symbol === 'BTC' && b.status === 'OPEN');
    expect(row!.lastExchangeSl).toBe(98);
    expect(row!.slSyncPending).toBe(false);
  });
});
