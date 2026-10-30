// ============================================================
// test/riskArmR2V21290.test.ts — v21.29.0 R2 RISK ARM
// ------------------------------------------------------------
// Locks:
//   • required money caps: per-trade %, max leverage, wallet deploy %,
//     daily loss %. Missing caps BLOCK live arming.
//   • the SAFE preset is suggestion-only (presetOnly:true, no writes here).
//   • the typed acknowledgement phrase is the only override; a wrong phrase
//     is rejected/clamped to false, never silently accepted.
//   • liquidation must sit beyond the stop + buffer (polarity checked).
//   • consecutive-loss pause is live-only, thresholded and time-boxed.
//   • risk-based sizing carries explicit cap labels.
//   • mtfAutoTick refuses new LIVE entries when the arm is blocked and when
//     the loss-streak pause is active; paper is unaffected.
//   • flatten-all requires the typed `FLATTEN ALL` phrase and returns
//     per-position verdicts + an honest flat/non-flat/unknown state.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-arm-r2-21290-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import {
  RISK_ACK_PHRASE, RISK_SAFE_PRESET, riskCapsMissing, evaluateLiveArmRisk,
  evaluateLiveArmConfigPatch, evaluateLiquidationDistanceGuard,
  consecutiveLossState, evaluateConsecutiveLossPause, computeRiskBasedSizing,
} from '../server/ai/riskArm.js';
import {
  mtfAutoTick, updateMtfAutoConfig, __resetMtfAutoForTests, mtfAutoRiskArmState,
} from '../server/ai/mtfAutoLink.js';
import { flattenAllFuturesPositions, FLATTEN_ALL_PHRASE } from '../server/ai/futures.js';

const CAPS = {
  riskPerTradePct: 1,
  maxLeverage: 5,
  maxWalletDeployPct: 25,
  dailyLossPct: 1.5,
};

function boardFixture(symbol = 'BTCUSDT') {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol, market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      drivers: ['dual-TF confirm: context+trigger aligned (+4)'],
    }],
  };
}

function fakePaper() {
  const calls = { opened: [] };
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN' });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn(() => ({ ok: true, trade: { realizedPnl: 0 } })),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  return { paper, calls };
}

function liveExec() {
  return vi.fn(async () => ({
    ok: true, orderId: 'ord-1',
    filled: { qty: 1, price: 100, stopLoss: 99, t1: 101, t2: 102 },
    position: { id: 'pos-1' },
  }));
}

beforeEach(() => { __resetMtfAutoForTests(); });
afterEach(() => { __resetMtfAutoForTests(); });

describe('v21.29.0 R2 — pure risk-arm helpers', () => {
  it('missing caps list is empty only when all four money caps are set', () => {
    const missing = riskCapsMissing({});
    expect(missing.map(m => m.key).sort()).toEqual(
      ['dailyLossPct', 'maxLeverage', 'maxWalletDeployPct', 'riskPerTradePct'].sort(),
    );
    expect(riskCapsMissing(CAPS)).toEqual([]);
    expect(riskCapsMissing({ ...CAPS, maxLeverage: 0 }).map(m => m.key)).toContain('maxLeverage');
  });

  it('blocks live arm, returns the SAFE preset as suggestion only', () => {
    const arm = evaluateLiveArmRisk({});
    expect(arm.ok).toBe(false);
    expect(arm.armable).toBe(false);
    expect(arm.ackRequired).toBe(true);
    expect(arm.blockers[0]).toMatch(/missing risk caps/);
    expect(arm.preset).toMatchObject(RISK_SAFE_PRESET);
    expect(arm.presetOnly).toBe(true);
    // The helper must not mutate the config it was given.
    const cfg: Record<string, any> = {};
    evaluateLiveArmRisk(cfg);
    expect(cfg).toEqual({});
  });

  it('the typed phrase (case/space tolerant) is the only override', () => {
    const blocked = evaluateLiveArmRisk({}, { acknowledged: true, phrase: 'i accept' });
    expect(blocked.ok).toBe(false);

    const typed = evaluateLiveArmRisk({}, { acknowledged: true, phrase: `  ${RISK_ACK_PHRASE.toLowerCase()} ` });
    expect(typed.ok).toBe(true);
    expect(typed.overrideActive).toBe(true);

    const persisted = evaluateLiveArmRisk({ riskCapsAcknowledged: true, riskCapsAckPhrase: RISK_ACK_PHRASE });
    expect(persisted.ok).toBe(true);
    expect(persisted.ackOk).toBe(true);
  });

  it('config patch validator: malformed ack 400, non-arming edits allowed, arming gated', () => {
    const badAck = evaluateLiveArmConfigPatch({
      currentCfg: {}, patch: { riskCapsAcknowledged: true, riskCapsAckPhrase: 'yes' },
    });
    expect(badAck.ok).toBe(false);
    expect(badAck.reason).toBe('risk-ack-phrase');

    const unrelated = evaluateLiveArmConfigPatch({
      currentCfg: { executionMode: 'live', ...CAPS }, patch: { minScore: 82 },
    });
    expect(unrelated.ok).toBe(true);
    expect(unrelated.gated).toBe(false);

    const armBlocked = evaluateLiveArmConfigPatch({
      currentCfg: {}, patch: { executionMode: 'live' }, armingLive: true,
    });
    expect(armBlocked.ok).toBe(false);
    expect(armBlocked.reason).toBe('live-arm-risk');
    expect(armBlocked.arm.presetOnly).toBe(true);

    const armAck = evaluateLiveArmConfigPatch({
      currentCfg: {},
      patch: { executionMode: 'live', riskCapsAcknowledged: true, riskCapsAckPhrase: RISK_ACK_PHRASE },
      armingLive: true,
    });
    expect(armAck.ok).toBe(true);
    expect(armAck.typedAck).toBe(true);
    expect(armAck.arm.overrideActive).toBe(true);
  });

  it('liquidation guard requires stop + buffer distance and correct polarity', () => {
    const ok = evaluateLiquidationDistanceGuard({ side: 'LONG', entry: 100, stopLoss: 98, liqPrice: 97 });
    expect(ok.ok).toBe(true);
    expect(ok.requiredPct).toBe(2.5);

    const close = evaluateLiquidationDistanceGuard({ side: 'LONG', entry: 100, stopLoss: 98, liqPrice: 98.5 });
    expect(close.ok).toBe(false);
    expect(close.reason).toBe('too-close');

    const polarity = evaluateLiquidationDistanceGuard({ side: 'LONG', entry: 100, stopLoss: 98, liqPrice: 101 });
    expect(polarity.ok).toBe(false);
    expect(polarity.reason).toBe('liq-polarity');

    const short = evaluateLiquidationDistanceGuard({ side: 'SHORT', entry: 100, stopLoss: 102, liqPrice: 103 });
    expect(short.ok).toBe(true);
  });

  it('consecutive-loss state counts only losses, newest-first, live-only when asked', () => {
    const rows = [
      { status: 'CLOSED', executionMode: 'LIVE', pnl: -10, closedAt: 1000 },
      { status: 'CLOSED', executionMode: 'PAPER', pnl: -99, closedAt: 1500 },
      { status: 'CLOSED', executionMode: 'LIVE', pnl: -20, closedAt: 2000 },
      { status: 'CLOSED', executionMode: 'LIVE', pnl: -30, closedAt: 3000 },
    ];
    expect(consecutiveLossState(rows).streak).toBe(4); // paper loss included by default
    expect(consecutiveLossState(rows, { liveOnly: true }).streak).toBe(3);
    expect(consecutiveLossState([...rows, { status: 'CLOSED', executionMode: 'LIVE', pnl: 5, closedAt: 4000 }], { liveOnly: true }).streak).toBe(0);
  });

  it('consecutive-loss pause is time-boxed and can be disabled', () => {
    const rows = [
      { status: 'CLOSED', executionMode: 'LIVE', pnl: -10, closedAt: 1_000 },
      { status: 'CLOSED', executionMode: 'LIVE', pnl: -20, closedAt: 2_000 },
      { status: 'CLOSED', executionMode: 'LIVE', pnl: -30, closedAt: 3_000 },
    ];
    const paused = evaluateConsecutiveLossPause({
      closedRows: rows, liveOnly: true, pauseAfter: 3, pauseMin: 60, now: 10_000,
    });
    expect(paused.blocked).toBe(true);
    expect(paused.pausedUntil).toBe(3_000 + 60 * 60_000);

    const expired = evaluateConsecutiveLossPause({
      closedRows: rows, liveOnly: true, pauseAfter: 3, pauseMin: 60, now: 4_000_000,
    });
    expect(expired.blocked).toBe(false);

    const off = evaluateConsecutiveLossPause({
      closedRows: rows, liveOnly: true, pauseAfter: 0, pauseMin: 60, now: 10_000,
    });
    expect(off.blocked).toBe(false);
  });

  it('risk-based sizing labels the binding cap and converts USD notional with fx', () => {
    const risk = computeRiskBasedSizing({
      walletINR: 100_000, riskPerTradeINR: 1_000, riskPerTradePct: 1,
      entry: 100, stopLoss: 99, leverage: 5, fxRate: 1,
    });
    expect(risk.ok).toBe(true);
    expect(risk.qty).toBe(1000);
    expect(risk.capApplied).toBe('risk-budget');
    expect(risk.labels.join(' ')).toMatch(/risk-based qty/);

    const capped = computeRiskBasedSizing({
      walletINR: 100_000, riskPerTradeINR: 1_000, riskPerTradePct: 1,
      entry: 100, stopLoss: 99, maxNotionalINR: 50_000, leverage: 5, fxRate: 1,
    });
    expect(capped.capApplied).toBe('notional-cap');
    expect(capped.qty).toBe(500);
    expect(capped.labels[0]).toMatch(/notional cap/);

    const fx = computeRiskBasedSizing({
      walletINR: 100_000, riskPerTradeINR: 10_000, entry: 100, stopLoss: 99,
      leverage: 5, fxRate: 100,
    });
    expect(fx.qty).toBe(100); // risk 10,000 INR ÷ (1 USDT stop × 100 INR/USDT)

    expect(computeRiskBasedSizing({ entry: 100, stopLoss: 100, riskPerTradeINR: 1000 }).ok).toBe(false);
  });
});

describe('v21.29.0 R2 — config persistence + tick gates', () => {
  it('clamps pause fields and refuses a half-typed acknowledgement', () => {
    const clamped = updateMtfAutoConfig({ consecutiveLossPauseAfter: 999, consecutiveLossPauseMin: -5 });
    expect(clamped.consecutiveLossPauseAfter).toBe(20);
    expect(clamped.consecutiveLossPauseMin).toBe(0);

    const bad = updateMtfAutoConfig({ riskCapsAcknowledged: true, riskCapsAckPhrase: 'not the phrase' });
    expect(bad.riskCapsAcknowledged).toBe(false);
    expect(bad.riskCapsAckPhrase).toBeNull();

    const good = updateMtfAutoConfig({
      riskCapsAcknowledged: true, riskCapsAckPhrase: RISK_ACK_PHRASE, riskCapsAckAt: Date.now(),
    });
    expect(good.riskCapsAcknowledged).toBe(true);
    expect(good.riskCapsAckPhrase).toBe(RISK_ACK_PHRASE);
    expect(good.riskCapsAckAt).toBeGreaterThan(0);
  });

  it('blocks new LIVE entries when the arm is missing caps, then opens after the caps are set', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', desks: { india: false, crypto: true },
        riskCapsAcknowledged: false, // explicit opt-out of the fixture ack
      },
    });
    const { paper } = fakePaper();
    const execute = liveExec();
    const blocked = await mtfAutoTick({
      boards: { CRYPTO: boardFixture() }, paper, liveExecute: execute,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(blocked.opened).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(blocked.skipped.join(' ')).toMatch(/LIVE arm blocked/);

    updateMtfAutoConfig({ ...CAPS, riskCapsAcknowledged: false });
    const { paper: paper2 } = fakePaper();
    const execute2 = liveExec();
    const ok = await mtfAutoTick({
      boards: { CRYPTO: boardFixture() }, paper: paper2, liveExecute: execute2,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(ok.opened).toHaveLength(1);
    expect(execute2).toHaveBeenCalledTimes(1);
    const rec: any = ok.opened[0];
    expect(rec.riskSizing).toBeTruthy();
    expect(rec.riskSizing.finalQty).toBe(1);
    expect(rec.riskSizing.labels.join(' ')).toMatch(/risk-based qty|notional cap/);
  });

  it('pauses new LIVE entries after the configured consecutive-loss streak', async () => {
    const now = Date.now();
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'live', desks: { india: false, crypto: true },
        ...CAPS, consecutiveLossPauseAfter: 1, consecutiveLossPauseMin: 60,
      },
      state: {
        book: [{
          paperId: 1, symbol: 'ETH', market: 'CRYPTO', execMarket: 'FUTURES',
          side: 'LONG', entry: 50, stopLoss: 49, t1: 51, t2: 52, qty: 1,
          openedAt: now - 600_000, status: 'CLOSED', closeReason: 'SL_HIT',
          closedAt: now - 60_000, pnl: -100, executionMode: 'LIVE', traded: true,
        }],
      },
    });
    const { paper } = fakePaper();
    const execute = liveExec();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture() }, paper, liveExecute: execute,
      siteLiveByDesk: { crypto: true, india: false },
    });
    expect(out.opened).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(out.skipped.join(' ')).toMatch(/consecutive-loss pause/i);

    const state = mtfAutoRiskArmState();
    expect(state.consecutiveLoss.blocked).toBe(true);
    expect(state.liveArm.ok).toBe(true);
  });
});

describe('v21.29.0 R2 — flatten-all', () => {
  function pos(id: string, activePos = 2) {
    return { id, pair: 'B-BTC_USDT', activePos, leverage: 5 };
  }

  it('requires the typed FLATTEN ALL phrase before reading positions', async () => {
    const listPositions = vi.fn(async () => [pos('p1')]);
    const missing = await flattenAllFuturesPositions({ confirm: '', deps: { listPositions } });
    expect(missing.ok).toBe(false);
    expect(missing.blocked).toBe(true);
    expect(missing.reason).toBe('confirm-required');
    expect(listPositions).not.toHaveBeenCalled();

    const wrong = await flattenAllFuturesPositions({ confirm: 'flatten', deps: { listPositions } });
    expect(wrong.blocked).toBe(true);
    expect(listPositions).not.toHaveBeenCalled();
  });

  it('closes every open position and verifies flat with a post-close re-read', async () => {
    let listed = 0;
    const listPositions = vi.fn(async () => (++listed === 1 ? [pos('p1'), pos('p2', -3)] : []));
    const closePosition = vi.fn(async ({ positionId }) => ({ ok: true, orderHygiene: { ok: true, cancelled: [] } }));
    const out = await flattenAllFuturesPositions({
      confirm: FLATTEN_ALL_PHRASE.toLowerCase(),
      deps: { listPositions, closePosition },
    });
    expect(out.ok).toBe(true);
    expect(out.requested).toBe(2);
    expect(out.closed.map(c => c.positionId)).toEqual(['p1', 'p2']);
    expect(out.closed[1].side).toBe('SHORT');
    expect(out.failed).toEqual([]);
    expect(out.flat).toBe(true);
    expect(out.tpSlCleanup).toMatch(/VERIFY-LIVE/);
    expect(closePosition).toHaveBeenCalledTimes(2);
  });

  it('returns per-position failures and a non-flat verdict (never a blanket ok)', async () => {
    let listed = 0;
    const listPositions = vi.fn(async () => (++listed === 1 ? [pos('p1'), pos('p2')] : [pos('p2')]));
    const closePosition = vi.fn(async ({ positionId }) => (
      positionId === 'p2' ? { ok: false, error: 'exchange rejected' } : { ok: true }
    ));
    const out = await flattenAllFuturesPositions({
      confirm: FLATTEN_ALL_PHRASE,
      deps: { listPositions, closePosition },
    });
    expect(out.ok).toBe(false);
    expect(out.closed.map(c => c.positionId)).toEqual(['p1']);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toMatchObject({ positionId: 'p2', error: 'exchange rejected' });
    expect(out.remaining).toBe(1);
    expect(out.flat).toBe(false);
  });

  it('a failed post-close re-read leaves flat unknown (ok:false)', async () => {
    let listed = 0;
    const listPositions = vi.fn(async () => {
      listed += 1;
      if (listed === 1) return [pos('p1')];
      throw new Error('transport down');
    });
    const out = await flattenAllFuturesPositions({
      confirm: FLATTEN_ALL_PHRASE,
      deps: { listPositions, closePosition: async () => ({ ok: true }) },
    });
    expect(out.closed).toHaveLength(1);
    expect(out.flat).toBeNull();
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/verify flat manually/i);
  });

  it('no open positions is an idempotent ok:true', async () => {
    const out = await flattenAllFuturesPositions({
      confirm: FLATTEN_ALL_PHRASE,
      deps: { listPositions: async () => [] },
    });
    expect(out.ok).toBe(true);
    expect(out.requested).toBe(0);
    expect(out.flat).toBe(true);
  });
});

describe('v21.29.0 R2 — route wiring pins', () => {
  const routes = fs.readFileSync(path.join(process.cwd(), 'server/ai/routes.js'), 'utf8');

  it('config route gates live arming through the pure validator BEFORE persisting', () => {
    const start = routes.indexOf("app.post('/api/ai/mtf-auto/config'");
    expect(start).toBeGreaterThan(0);
    const gate = routes.indexOf('evaluateLiveArmConfigPatch', start);
    const save = routes.indexOf('const cfg = updateMtfAutoConfig(body)', start);
    expect(gate).toBeGreaterThan(start);
    expect(gate).toBeLessThan(save);
  });

  it('exposes risk-arm telemetry and the typed flatten-all endpoint', () => {
    expect(routes).toContain("app.get('/api/ai/mtf-auto/risk-arm'");
    expect(routes).toContain('mtfAutoRiskArmState');
    expect(routes).toContain("app.post('/api/ai/futures/flatten-all'");
    expect(routes).toContain('flattenAllFuturesPositions({ confirm })');
    expect(routes).toContain('presetOnly: true');
  });
});
