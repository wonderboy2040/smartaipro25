// ============================================================
// test/mtfAutoPhase0.test.ts — v21.24.0 PHASE 0 CONTRACTS
// ------------------------------------------------------------
// Locks the production-hardening promises:
//   • liveEntryPaused only PAUSES new live/flip entries — existing
//     positions ka deep monitor + SL management chalta rehta hai
//   • effective risk caps (1% target / 2% hard, 5x max, 25% deploy,
//     daily-loss stop) are the SAME contract in entry sizing + status
//   • daily-loss circuit breaker desk ke apne day bucket par
//   • canonical audit namespaces board/paper/journal separately and
//     reports stop-integrity + LIVE/paper reconciliation honestly
//
// Hermetic: apna TMP data dir, koi real server/data IO nahi.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-phase0-test-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

import {
  mtfAutoTick,
  mtfAutoStatus,
  computeEffectiveRiskCaps,
  computeWallet95Deployment,
  markAutoTradeSlSynced,
  __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import { buildPhase0Audit, __resetPhase0AuditCacheForTests } from '../server/ai/phase0Audit.js';
import { dayKeyFor } from '../server/intraday/time.js';

// ------------------------------------------------------------
// fixtures
// ------------------------------------------------------------
function fakePaper(open = []) {
  const calls = { opened: [], closed: [] };
  const paper = {
    open: [...open],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 500 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id) => {
      calls.closed.push(id);
      paper.open = paper.open.filter(t => t.id !== id);
      return { ok: true, trade: { id, realizedPnl: -10 } };
    }),
    voidPaperTrade: vi.fn(),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  return { paper, calls };
}

function boardFixture(symbol = 'BTCUSDT', over = {}) {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      drivers: ['dual-TF confirm: context+trigger aligned (+4)'],
      ...over,
    }],
  };
}

function liveExec() {
  return vi.fn(async (o) => ({
    ok: true,
    orderId: 'ord-1',
    position: { id: 'pos-1' },
    filled: { qty: o.qty, price: o.entry, stopLoss: o.stopLoss, t1: o.target1, t2: o.target2 },
  }));
}

const CRYPTO_LIVE = { siteLiveByDesk: { crypto: true, india: false } };

function phase0Config(over = {}) {
  return {
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
    ...over,
  };
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(TMP_DATA, name), JSON.stringify(value, null, 2));
}

function openRow(symbol) {
  const st = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'mtf-auto-state.json'), 'utf8'));
  return (st.book || []).find(b => String(b.symbol).toUpperCase() === symbol && b.status === 'OPEN');
}

// ------------------------------------------------------------
// A) effective risk caps — single sizing/status contract
// ------------------------------------------------------------
describe('Phase 0 — effective risk caps', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetPhase0AuditCacheForTests(); });

  it('1% target + 2% hard cap + 5x max + 25% deploy + 1.5% daily loss', () => {
    const caps = computeEffectiveRiskCaps({
      walletAmountINR: 10000,
      riskPerTradeINR: 2000,
      riskPerTradePct: 1,
      maxRiskPerTradePct: 2,
      maxLeverage: 5,
      maxWalletDeployPct: 25,
      dailyLossPct: 1.5,
      walletDeployPct: 100,
      belowTenKLeverage: 10,
      aboveTenKLeverage: 5,
    }, 10000);

    expect(caps.activeRiskPct).toBe(1);
    expect(caps.riskCapINR).toBe(100);
    expect(caps.effectiveRiskINR).toBe(100);   // min(configured ₹2000, 1% cap)
    expect(caps.tierLeverage).toBe(5);
    expect(caps.effectiveLeverage).toBe(5);
    expect(caps.effectiveWalletDeployPct).toBe(25);
    expect(caps.dailyLossCapINR).toBe(150);
  });

  it('hard ceiling never exceeded even if target is hostile/above 2%', () => {
    const caps = computeEffectiveRiskCaps({
      walletAmountINR: 10000,
      riskPerTradeINR: 2000,
      riskPerTradePct: 9,          // clamped to 2
      maxRiskPerTradePct: 1,       // hard ceiling wins
      maxLeverage: 50,             // clamped to 20
      maxWalletDeployPct: 200,     // clamped to 100
      dailyLossPct: 99,            // clamped to 10
      belowTenKLeverage: 10,
      aboveTenKLeverage: 5,
    }, 10000);

    expect(caps.activeRiskPct).toBe(1);
    expect(caps.riskCapINR).toBe(100);
    expect(caps.effectiveRiskINR).toBe(100);
    expect(caps.maxLeverage).toBe(20);
    expect(caps.effectiveLeverage).toBe(5); // tier leverage is stricter
    expect(caps.effectiveWalletDeployPct).toBe(100);
    expect(caps.dailyLossPct).toBe(10);
  });

  it('legacy defaults (all 0/off) preserve the old behaviour', () => {
    const caps = computeEffectiveRiskCaps({
      walletAmountINR: 5000,
      riskPerTradeINR: 2000,
      riskPerTradePct: 0,
      maxRiskPerTradePct: 2,
      maxLeverage: 0,
      maxWalletDeployPct: 0,
      dailyLossPct: 0,
      walletDeployPct: 100,
      belowTenKLeverage: 10,
      aboveTenKLeverage: 5,
    }, 5000);

    expect(caps.riskCapINR).toBeNull();
    expect(caps.effectiveRiskINR).toBe(2000);
    expect(caps.effectiveLeverage).toBe(10);   // tier leverage as-is
    expect(caps.effectiveWalletDeployPct).toBe(100);
    expect(caps.dailyLossCapINR).toBeNull();
  });

  it('status exposes the same effective caps the entry path uses', () => {
    __resetMtfAutoForTests({ config: phase0Config({ liveEntryPaused: true }) });
    const st = mtfAutoStatus();
    expect(st.liveEntryPaused).toBe(true);
    expect(st.entryPauseReason).toMatch(/Phase 0/);
    expect(st.riskCaps.effectiveRiskINR).toBe(100);
    expect(st.riskCaps.effectiveLeverage).toBe(5);
    expect(st.effectiveWalletDeployPct).toBe(25);
    // legacy fields stay the CONFIGURED values (100) for older consumers;
    // only effective* / riskCaps carry the Phase 0 cap.
    expect(st.walletDeployPct).toBe(100);
    expect(st.wallet95Deployment.walletDeployPct).toBe(100);
    // effective deployment object must match the capped values
    expect(st.effectiveWallet95Deployment.walletDeployPct).toBe(25);
    expect(st.effectiveWallet95Deployment.leverage).toBe(5);
    expect(st.effectiveWallet95Deployment.deployedWalletINR).toBe(2500);
    expect(st.effectiveWallet95Deployment.buyingPowerINR).toBe(12500);
  });

  it('wallet-honest caps: status uses the real live wallet, not configured ₹10,000', () => {
    __resetMtfAutoForTests({ config: phase0Config({ liveEntryPaused: true }) });
    // Real live wallet snapshot at the time of the Phase 0 rollout.
    const st = mtfAutoStatus({}, { walletINR: 1385 });
    expect(st.effectiveWalletINR).toBe(1385);
    expect(st.riskCaps.walletINR).toBe(1385);
    expect(st.riskCaps.riskCapINR).toBe(13.85);      // 1%
    expect(st.riskCaps.effectiveRiskINR).toBe(13.85);
    expect(st.riskCaps.maxRiskPerTradePct).toBe(2);  // hard ceiling still 2%
    expect(st.riskCaps.dailyLossCapINR).toBe(20.78); // 1.5%
    expect(st.riskCaps.effectiveLeverage).toBe(5);
    expect(st.effectiveWallet95Deployment.walletTotalINR).toBe(1385);
    expect(st.effectiveWallet95Deployment.deployedWalletINR).toBe(346.25); // 25%
    // Configured value stays exposed for backward compatibility.
    expect(st.walletAmountINR).toBe(10000);
    // No wallet passed → configured fallback preserved (paper/offline status).
    const fallback = mtfAutoStatus();
    expect(fallback.effectiveWalletINR).toBe(10000);
    expect(fallback.riskCaps.effectiveRiskINR).toBe(100);
  });

  it('live entry sizes from the capped risk budget, leverage and deploy %', async () => {
    __resetMtfAutoForTests({ config: phase0Config() });
    const { paper } = fakePaper();
    const exec = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') },
      paper, liveExecute: exec, fx: 84, ...CRYPTO_LIVE,
    });

    expect(out.opened).toHaveLength(1);
    const rec = out.opened[0];
    expect(rec.executionMode).toBe('LIVE');
    // ₹100 risk / 84 fx = $1.1904 risk budget; |100−99| = 1 → qty 1.1904
    expect(rec.qty).toBeCloseTo(1.1904, 4);
    expect(rec.riskINR).toBeCloseTo(100, 1);       // 1% of ₹10k, NOT configured ₹2000
    expect(rec.leverage).toBe(5);                  // 10x tier capped to 5x
    expect(rec.walletDeployPct).toBe(25);          // 100% configured capped to 25%
    expect(rec.deployedWalletINR).toBe(2500);
    expect(rec.buyingPowerINR).toBe(12500);
    expect(rec.walletINR).toBe(10000);

    // exchange order carried the same effective numbers
    const order = exec.mock.calls[0][0];
    expect(order.qty).toBeCloseTo(1.1904, 4);
    expect(order.leverage).toBe(5);
    expect(order.walletDeployPct).toBe(25);
    expect(order.deployedWalletINR).toBe(2500);
    expect(order.marginUSDT).toBeCloseTo((1.1904 * 100) / 5, 4);
  });

  it('deploy cap math stays consistent with computeWallet95Deployment', () => {
    const w = computeWallet95Deployment({ walletINR: 10000, leverage: 5, deployPct: 25 });
    expect(w.deployedWalletINR).toBe(2500);
    expect(w.buyingPowerINR).toBe(12500);
  });
});

// ------------------------------------------------------------
// B) live entry pause — no new entries, management survives
// ------------------------------------------------------------
describe('Phase 0 — live entry pause', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  it('blocks a new LIVE entry while the site is live', async () => {
    __resetMtfAutoForTests({ config: phase0Config({ liveEntryPaused: true }) });
    const { paper, calls } = fakePaper();
    const exec = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') },
      paper, liveExecute: exec, ...CRYPTO_LIVE,
    });

    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
    expect(out.skipped.join(' ')).toMatch(/LIVE entries paused \(Phase 0/);
  });

  it('keeps deep-monitor SL management for an existing LIVE position', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: phase0Config({ liveEntryPaused: true }),
      state: {
        book: [{
          paperId: 777, liveOrderId: 'ord-old', livePositionId: 'pos-old',
          executionMode: 'LIVE', traded: true, fullControl: true, openedInLiveMode: true,
          symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT', side: 'LONG',
          entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99,
          t1: 101, t2: 102, qty: 1, leverage: 5, walletINR: 10000, riskINR: 100,
          openedAt: now - 120_000, status: 'OPEN',
        }],
      },
    });
    const { paper, calls } = fakePaper([
      { id: 777, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', stopLoss: 99, qty: 1 },
    ]);
    const liveClose = vi.fn(async () => ({ ok: true, realizedPnl: -100 }));
    const exec = liveExec();

    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('ETHUSDT') },
      paper,
      quotes: { 'FUTURES|BTC': 98 },
      liveClose, liveExecute: exec,
      now,
      ...CRYPTO_LIVE,
    });

    // existing position WAS managed/closed on its stop
    expect(liveClose).toHaveBeenCalledTimes(1);
    expect(calls.closed).toContain(777);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].symbol).toBe('BTC');
    // but no NEW entry was opened
    expect(out.opened).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
    expect(out.skipped.join(' ')).toMatch(/LIVE entries paused \(Phase 0/);
  });

  it('paper forward-testing still works when pause is ON (paper-only session)', async () => {
    __resetMtfAutoForTests({
      config: phase0Config({
        executionMode: 'paper',
        autoSyncSiteLive: false,
        liveEntryPaused: true,
      }),
    });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') },
      paper,
      siteLiveByDesk: { crypto: false, india: false },
    });
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0].executionMode).toBe('PAPER');
    expect(calls.opened).toHaveLength(1);
  });
});

// ------------------------------------------------------------
// B2) STOP INTEGRITY — exchange SL must converge to book trail
// ------------------------------------------------------------
describe('Phase 0 — exchange SL reconciliation', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  function liveRow(over = {}) {
    const now = Date.now();
    return {
      paperId: 888, liveOrderId: 'ord-live', livePositionId: 'pos-live',
      executionMode: 'LIVE', traded: true, fullControl: true, openedInLiveMode: true,
      symbol: 'BTC', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT', side: 'LONG',
      entry: 100, stopLoss: 100, initialStopLoss: 99, trailedStopLoss: 100,
      t1: 101, t2: 102, qty: 1, leverage: 5, walletINR: 10000, riskINR: 100,
      openedAt: now - 120_000, status: 'OPEN',
      ...over,
    };
  }

  it('retries a pending exchange SL sync and clears the flag on {ok:true}', async () => {
    __resetMtfAutoForTests({
      config: phase0Config({ liveEntryPaused: true }),
      state: { book: [liveRow({ slSyncPending: true, lastExchangeSl: null })] },
    });
    const { paper } = fakePaper([
      { id: 888, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', stopLoss: 100, qty: 1 },
    ]);
    const liveUpdateSl = vi.fn(async () => ({ ok: true }));

    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('ETHUSDT') },
      paper,
      quotes: { 'FUTURES|BTC': 100.5 },
      liveUpdateSl,
      siteLiveByDesk: { crypto: true, india: false },
    });

    expect(out.opened).toHaveLength(0); // pause still on
    expect(liveUpdateSl).toHaveBeenCalledTimes(1);
    const row = openRow('BTC');
    // Exchange ko hamesha BOOK ka current trail milta hai (tick ke dauraan
    // trail aage badh sakta hai — dono converge hone chahiye).
    expect(liveUpdateSl.mock.calls[0][0].stopLoss).toBe(row.trailedStopLoss);
    expect(row.slSyncPending).toBe(false);
    expect(row.lastExchangeSl).toBe(row.trailedStopLoss);
  });

  it('a failed sync keeps slSyncPending ON so the next tick retries', async () => {
    __resetMtfAutoForTests({
      config: phase0Config({ liveEntryPaused: true }),
      state: { book: [liveRow({ slSyncPending: true, lastExchangeSl: null })] },
    });
    const { paper } = fakePaper([
      { id: 888, symbol: 'BTC', market: 'FUTURES', status: 'OPEN', direction: 'LONG', stopLoss: 100, qty: 1 },
    ]);
    const liveUpdateSl = vi.fn(async () => ({ ok: false, error: 'exchange rejected SL' }));

    await mtfAutoTick({
      boards: { CRYPTO: boardFixture('ETHUSDT') },
      paper,
      quotes: { 'FUTURES|BTC': 100.5 },
      liveUpdateSl,
      siteLiveByDesk: { crypto: true, india: false },
    });

    const row = openRow('BTC');
    expect(row.slSyncPending).toBe(true);
    expect(row.lastExchangeSl).toBeNull(); // never stamped on a failed call
  });

  it('markAutoTradeSlSynced stamps only when the book SL has not moved', () => {
    __resetMtfAutoForTests({
      config: phase0Config({ liveEntryPaused: true }),
      state: { book: [liveRow({ slSyncPending: true, lastExchangeSl: null })] },
    });
    const stale = markAutoTradeSlSynced({ paperId: 888, stopLoss: 99.5, exchange: true });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/stop moved/);

    const ok = markAutoTradeSlSynced({ paperId: 888, stopLoss: 100, exchange: true });
    expect(ok.ok).toBe(true);
    expect(openRow('BTC').lastExchangeSl).toBe(100);
    expect(openRow('BTC').slSyncPending).toBe(false);
  });
});

// ------------------------------------------------------------
// C) daily-loss circuit breaker (desk's own day bucket)
// ------------------------------------------------------------
describe('Phase 0 — daily loss stop', () => {
  beforeEach(() => { __resetMtfAutoForTests(); });

  function closedLiveRow(now, pnl) {
    return {
      liveOrderId: 'ord-old', livePositionId: 'pos-old',
      executionMode: 'LIVE', traded: true,
      symbol: 'OLD', market: 'CRYPTO', execMarket: 'FUTURES', ccy: 'USDT', side: 'LONG',
      entry: 100, stopLoss: 99, initialStopLoss: 99, trailedStopLoss: 99,
      t1: 101, t2: 102, qty: 1, leverage: 5, walletINR: 10000,
      openedAt: now - 600_000, dayKey: dayKeyFor('CRYPTO', new Date(now)),
      status: 'CLOSED', closeReason: 'SL_HIT', closedAt: now - 300_000, pnl,
    };
  }

  it('blocks new entries after realized day loss crosses the cap', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: phase0Config(),  // dailyLossPct 1.5 → ₹150 cap on ₹10k
      state: { book: [closedLiveRow(now, -160)] },
    });
    const { paper, calls } = fakePaper();
    const exec = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') },
      paper, liveExecute: exec, now, ...CRYPTO_LIVE,
    });

    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
    expect(out.skipped.join(' ')).toMatch(/daily loss stop hit \(-160\.00 <= -150\)/);
  });

  it('still allows entries while the day loss is under the cap', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: phase0Config(),
      state: { book: [closedLiveRow(now, -50)] },
    });
    const { paper } = fakePaper();
    const exec = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture('BTCUSDT') },
      paper, liveExecute: exec, now, ...CRYPTO_LIVE,
    });
    expect(out.opened).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------
// D) canonical audit — namespaces, stop integrity, reconciliation
// ------------------------------------------------------------
describe('Phase 0 — canonical audit', () => {
  const TODAY = '2026-10-24';

  beforeEach(() => {
    __resetMtfAutoForTests({ config: phase0Config({ liveEntryPaused: true }) });
    __resetPhase0AuditCacheForTests();

    writeJson('tracked-signals.json', {
      dayKey: TODAY,
      signals: [
        {
          id: 'BTC:FUTURES:2026-10-24', symbol: 'BTC', exchange: 'COINDCX', market: 'CRYPTO',
          direction: 'LONG', entry: 100, stopLoss: 99, target1: 101, target2: 102,
          dayKey: TODAY, openedAt: 1000, status: 'SL_HIT', exitPrice: 96, closedAt: 2000,
          rMultiple: -3.5, realizedPnlPerLakh: -3500,
        },
        {
          id: 'BTC:FUTURES:2026-10-24#2', symbol: 'BTC', exchange: 'COINDCX', market: 'CRYPTO',
          direction: 'SHORT', entry: 100, stopLoss: 101, target1: 99, target2: 98,
          dayKey: TODAY, openedAt: 1100, status: 'T2_HIT', exitPrice: 98, closedAt: 2100,
          rMultiple: 2, realizedPnlPerLakh: 2000,
        },
        {
          id: 'ETH:FUTURES:2026-10-24', symbol: 'ETH', exchange: 'COINDCX', market: 'CRYPTO',
          direction: 'LONG', entry: 50, stopLoss: 49, target1: 51, target2: 52,
          dayKey: TODAY, openedAt: 1200, status: 'OPEN', exitPrice: null, closedAt: null,
          rMultiple: null, realizedPnlPerLakh: null,
        },
      ],
    });

    writeJson('paper-trades.json', {
      dayKey: TODAY,
      nextId: 502,
      trades: [
        {
          id: 401, symbol: 'SOL', market: 'FUTURES', direction: 'LONG', source: 'mtf-auto',
          entry: 100, stopLoss: 99, initialStopLoss: 99, qty: 1, status: 'CLOSED',
          netPnl: -0.5, closeReason: 'SL_HIT', openedAt: 1000, closedAt: 3000,
        },
        {
          // OPEN mirror of the LIVE book row below (qty 2 vs 1 → mismatch)
          id: 501, symbol: 'XRP', market: 'FUTURES', direction: 'LONG', source: 'mtf-auto',
          entry: 100, stopLoss: 98, initialStopLoss: 98, qty: 1, status: 'OPEN',
          openedAt: 4000, closedAt: null,
        },
      ],
    });

    writeJson('ai-trading-journal.json', {
      entries: [
        {
          id: 'j-1', kind: 'CLOSE', mode: 'live', source: 'mtf-auto-live', market: 'FUTURES',
          symbol: 'SUI', side: 'SHORT', entryPrice: 1, closePrice: 0.98,
          reason: 'Exchange closed (app/manual)', pnlINR: -20, ts: 5000,
        },
      ],
    });

    writeJson('mtf-row-ledger.json', {
      rows: [
        { id: 'r1', symbol: 'BTC', outcome: 'WIN', resolvedAt: 1 },
        { id: 'r2', symbol: 'ETH', outcome: null },
        { id: 'r3', symbol: 'SOL', outcome: null },
      ],
    });

    writeJson('selfimprove-outcomes.json', {
      rows: [
        { id: 'l1', symbol: 'BTC', r: 1.5, win: true, reason: 'T2', ts: 10 },
        { id: 'l2', symbol: 'ETH', r: -1, win: false, reason: 'SL', ts: 20 },
      ],
    });

    writeJson('mtf-auto-state.json', {
      updatedAt: 123,
      book: [{
        paperId: 501, liveOrderId: 'ord-live', livePositionId: 'pos-live',
        executionMode: 'LIVE', traded: true, fullControl: true,
        symbol: 'XRP', market: 'CRYPTO', execMarket: 'FUTURES', side: 'LONG',
        entry: 100, stopLoss: 100, initialStopLoss: 99, trailedStopLoss: 100,
        t1: 101, t2: 102, qty: 2, leverage: 5,
        walletINR: 10000, riskINR: 500,
        openedAt: 4000, status: 'OPEN',
      }],
    });
  });

  it('separates board/paper/journal namespaces (no fake aggregate PnL)', () => {
    const a = buildPhase0Audit({ fresh: true });
    expect(a.sources.boardSignals.total).toBe(3);
    expect(a.sources.boardSignals.closed).toBe(2);
    expect(a.sources.boardSignals.open).toBe(1);
    expect(a.sources.boardSignals.netPnlPerLakh).toBe(-1500);
    expect(a.sources.paperTrades.closed).toBe(1);
    expect(a.sources.paperTrades.open).toBe(1);
    expect(a.sources.paperTrades.netPnl).toBe(-0.5);
    expect(a.sources.journal.closes).toBe(1);
    expect(a.sources.journal.netPnlINR).toBe(-20);
    // every canonical outcome is namespaced and unique
    expect(a.outcomes).toHaveLength(4);
    expect(new Set(a.outcomes.map(o => o.canonicalId)).size).toBe(4);
    expect(a.outcomes.every(o => /^(board|paper|journal):/.test(o.canonicalId))).toBe(true);
    // sources are not merged into one fabricated total
    expect(a.sources.boardSignals.netPnlPerLakh).not.toBe(a.sources.paperTrades.netPnl);
  });

  it('reports stop-integrity, duplicates and unresolved ledger honestly', () => {
    const a = buildPhase0Audit({ fresh: true });
    expect(a.stopIntegrity.boardSlHits).toBe(1);
    expect(a.stopIntegrity.excessStopR).toBe(2.5);   // |-3.5| − 1
    expect(a.stopIntegrity.worstR).toBe(-3.5);
    expect(a.stopIntegrity.beyond2R).toBe(1);

    expect(a.duplicates.groups).toBe(1);             // BTC same day, both sides
    expect(a.duplicates.extraSignals).toBe(1);
    expect(a.duplicates.oppositeSideGroups).toBe(1);

    expect(a.sources.rowLedger.total).toBe(3);
    expect(a.sources.rowLedger.resolved).toBe(1);
    expect(a.sources.rowLedger.unresolved).toBe(2);
    expect(a.unresolved.rowLedger).toBe(2);

    expect(a.sources.learning.total).toBe(2);
    expect(a.sources.learning.avgR).toBe(0.25);
    expect(a.manualExits.journal).toBe(1);
  });

  it('reconciles LIVE book vs paper mirror (qty/SL) and flags over-risk', () => {
    const a = buildPhase0Audit({ fresh: true });
    expect(a.reconciliation.bookOpen).toBe(1);
    expect(a.reconciliation.liveOpen).toBe(1);
    expect(a.reconciliation.mirrored).toBe(1);
    expect(a.reconciliation.qtyMismatches).toBe(1);       // live 2 vs paper 1
    expect(a.reconciliation.slMismatches).toBe(1);        // 100 vs 98 (2% of entry)
    expect(a.reconciliation.overRiskPositions).toBe(1);   // ₹500 / ₹10k = 5% > 2%
    expect(a.stopIntegrity.overRiskPositions).toBe(1);
    expect(a.reconciliation.stopViolations).toBe(0);      // trail 100 ≥ initial 99 (LONG)
    expect(a.verdict).toBe('ATTENTION');
    expect(a.warnings.join(' ')).toMatch(/excess 2\.5R/);
    expect(a.warnings.join(' ')).toMatch(/qty mismatch/);
    expect(a.warnings.join(' ')).toMatch(/SL mismatch/);
    expect(a.warnings.join(' ')).toMatch(/risk > 2% cap/);
  });

  it('summary payload is lightweight but carries the same verdict/caps', () => {
    const a = buildPhase0Audit({ fresh: true });
    expect(a.riskCaps.effectiveRiskINR).toBe(100);
    expect(a.riskCaps.effectiveLeverage).toBe(5);
    expect(a.riskCaps.effectiveWalletDeployPct).toBe(25);
    expect(a.riskCaps.dailyLossCapINR).toBe(150);
  });
});

// ------------------------------------------------------------
// E) manual LIVE pause honesty — auto engine pause manual click
//    ko bhi cover karta hai (v21.25.3)
// ------------------------------------------------------------
describe('Phase 0 — manual LIVE pause honesty', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('/api/ai/mtf-dual/live blocks the manual click BEFORE any order work', () => {
    const src = read('server/ai/routes.js');
    const start = src.indexOf("app.post('/api/ai/mtf-dual/live'");
    expect(start).toBeGreaterThan(-1);
    const nextRoute = src.indexOf('app.post(', start + 10);
    const route = src.slice(start, nextRoute === -1 ? undefined : nextRoute);

    const pauseAt = route.indexOf('cfg.liveEntryPaused === true');
    expect(pauseAt).toBeGreaterThan(-1);
    // guard is the first decision: before symbol/market parsing and the
    // actual exchange call, so a paused desk can never fire a real order.
    expect(pauseAt).toBeLessThan(route.indexOf('normMarket(body.market'));
    expect(route.slice(0, pauseAt)).not.toContain('openMtfBoardLive');
    expect(route).toContain('res.status(409).json({ ok: false, blocked: true, paused: true');
    // pause is honest to the caller (reason surfaced, not a silent 500)
    expect(route).toContain('Phase 0 me PAUSED');
  });

  it('manual PAPER clicks stay usable while LIVE is paused (separate endpoint)', () => {
    const src = read('server/ai/routes.js');
    const paperStart = src.indexOf("app.post('/api/ai/mtf-dual/paper'");
    const liveStart = src.indexOf("app.post('/api/ai/mtf-dual/live'");
    expect(paperStart).toBeGreaterThan(-1);
    expect(liveStart).toBeGreaterThan(paperStart);
    expect(src.slice(paperStart, liveStart)).not.toContain('liveEntryPaused');
  });

  it('UI LIVE click aborts locally and the row LIVE button is disabled', () => {
    const ui = read('src/components/aitrading/MTFDualBoardPanel.tsx');
    expect(ui).toContain('const liveEntriesPaused = auto?.liveEntryPaused === true;');

    const fnStart = ui.indexOf('const onLiveOrder = useCallback');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = ui.indexOf('}, [market, mode, holdMin', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = ui.slice(fnStart, fnEnd);
    const guardAt = fn.indexOf('if (liveEntriesPaused)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(fn.indexOf('openMtfBoardLive'));

    expect(ui).toContain('disabled={liveOrdering === r.symbol || busy || liveEntriesPaused}');
    expect(ui).toContain('if (status?.liveEntryPaused)');
  });
});
