// ============================================================
// test/reversalEngine.test.ts — v12.8 SUPERINTELLIGENCE
// REVERSAL RECOVERY ENGINE
// ------------------------------------------------------------
// LOCKED HERE (the user's XRP story, end to end):
//   • config clamps + coherence (cycle-stop ≥ loss cap, target
//     ≥ loss cap — a cycle-stop below one bad leg or a target
//     below the cap is a losing lottery by construction)
//   • pure leg math: ₹ P&L (direction + fx + booked partials),
//     ₹-threshold triggers, ₹→price levels (LONG/SHORT mirrors)
//   • the DECISION BRAIN: loss-cap CUT is unconditional, the FLIP
//     is guarded (maxLegs · cooldown · cycle-stop · ensemble
//     still-strongly-original veto; missing ensemble NEVER blocks
//     capital protection); target → BOOK, re-entry only via the
//     confirmed WAITING window
//   • the full paper cycle: LONG −₹168 CUT → SHORT flip (sl/tp
//     stamped from ₹ thresholds) → +₹504 BOOKED → WAITING →
//     ensemble LONG confirm → leg-3 LONG re-entry
//   • cycle END: window expiry stamps cycleEnd + journals net
//   • LIVE honesty (v7.0.2): no exchange id/creds → NO paper
//     close — WATCH_ERROR + retry (position stays OPEN)
//   • journal self-heal: reviveWaitingFromJournal rebuilds a
//     mid-window cycle after a restart
//   • the manual-trade advisory: LOSS_CAP banner state + priority
//     (TARGET_HIT > LOSS_CAP > EXIT_NOW)
// Same hermetic scaffolding as the manualTrades suite.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- hermetic store (no disk) ----
const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f, d) => (_disk.has(f) ? _disk.get(f) : d),
  saveJSON: (f, v) => { _disk.set(f, v); },
}));
// ---- journal/entry machinery (reversalEngine's only heavy imports) ----
vi.mock('../server/ai/coindcxOrders.js', () => ({
  pushEntry: vi.fn((j, e) => { (j.entries = j.entries || []).push(e); return e; }),
  todayIST: vi.fn(() => '2026-09-23'),
  dailyStats: vi.fn(() => ({ tradesCount: 0, realizedPnlINR: 0 })),
  loadConfig: vi.fn(() => ({ killSwitch: false, dailyMaxTrades: 5, dailyMaxLossINR: 2000, maxOpenPositions: 5 })),
}));
vi.mock('../server/ai/ledger.js', () => ({
  settlePositionOutcome: vi.fn(),
  recordExecution: vi.fn(() => ({ id: 'led-1' })),
  markPartialOutcome: vi.fn(),
}));
// ---- manualTrades' transitive boundary (same mocks as its suite) ----
vi.mock('../server/intraday/backup.js', () => ({
  scheduleBackup: vi.fn(),
  restoreBackup: vi.fn(async () => null),
  backupConfigured: vi.fn(() => false),
  flushBackupNow: vi.fn(),
}));
vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(() => false),
  decryptJSON: vi.fn(() => null),
  durableConfigured: vi.fn(() => false),
}));
vi.mock('../server/liveFeed.js', () => ({
  getTick: vi.fn(() => null),
}));

import {
  loadReversalConfig, reversalLegPnlINR, reversalTriggerOf, priceLevelsForLeg,
  cycleSummary, reversalDecision, reentryDecision, reviveWaitingFromJournal,
  evaluateReversalForPosition, processReversalWaiting, reversalCyclesView,
  __resetReversalForTests, __waitingStateForTests,
} from '../server/ai/reversalEngine.js';
import { stateOfManualTrade } from '../server/ai/manualTrades.js';

const CFG = (over = {}) => ({
  enabled: true, lossCapINR: 150, profitTargetINR: 500, maxLegs: 3,
  cooldownMs: 180_000, cooldownMin: 3, cycleStopINR: 300,
  reentryWindowMs: 45 * 60_000, reentryWindowMin: 45, minReentryConf: 60,
  requireEnsembleConfirm: true, ...over,
});

const mkDeps = (over = {}) => ({
  exitFuturesPosition: vi.fn(async () => ({ ok: true })),
  createFuturesOrder: vi.fn(async () => ({ orderId: 'ord-1' })),
  createFuturesTpsl: vi.fn(async () => ({ ok: true })),
  roundFuturesQty: vi.fn((_pair, q) => Math.round(Number(q) * 1000) / 1000),
  coindcxConnected: vi.fn(() => false),
  ...over,
});

const mkPos = (over = {}) => ({
  id: 'root-1', pair: 'B-XRP_USDT', symbol: 'XRP', market: 'FUTURES', side: 'LONG',
  mode: 'paper', source: 'manual', qty: 1000, entryPrice: 0.5, leverage: 2,
  sl: null, tp: null, openedAt: Date.now() - 3_600_000, status: 'OPEN', ...over,
});

// direct references (no clone) — the engine mutates positions in place,
// and the tests assert on the very objects inside the journal
const mkJournal = (positions: any[]) => ({ positions, entries: [] });

beforeEach(() => {
  __resetReversalForTests();
  _disk.clear();
});

describe('loadReversalConfig — v12.9 NO-CAPS (user values verbatim)', () => {
  it('defaults: OFF, ₹150 cap, ₹500 target, 3 legs, cycle-stop 2×cap', () => {
    const c = loadReversalConfig({});
    expect(c.enabled).toBe(false);
    expect(c.lossCapINR).toBe(150);
    expect(c.profitTargetINR).toBe(500);
    expect(c.maxLegs).toBe(3);
    expect(c.cycleStopINR).toBe(300);
    expect(c.requireEnsembleConfirm).toBe(true);
  });

  it('v12.9 USER SPEC: NO clamps — the user\'s numbers pass through VERBATIM', () => {
    // "koi threshold tweak cap nahi — editable manually hamare hisaab se"
    const c = loadReversalConfig({ reversalEnabled: true, reversalLossCapINR: 500, reversalCycleStopINR: 100 });
    expect(c.cycleStopINR).toBe(100); // NOT lifted to 2×cap anymore
    const c2 = loadReversalConfig({ reversalProfitTargetINR: 100, reversalLossCapINR: 300 });
    expect(c2.profitTargetINR).toBe(100); // NOT lifted anymore — user's call
  });

  it('v12.9: values outside the OLD clamp ranges pass verbatim; only sanity (positive) applies', () => {
    const c = loadReversalConfig({ reversalLossCapINR: 12000, reversalMaxLegs: 10, reversalCooldownMin: 0.5, reversalMinReentryConf: 20, reversalReentryWindowMin: 600, reversalProfitTargetINR: 75000 });
    expect(c.lossCapINR).toBe(12000);
    expect(c.maxLegs).toBe(10);
    expect(c.cooldownMin).toBe(0.5);
    expect(c.minReentryConf).toBe(20);
    expect(c.reentryWindowMin).toBe(600);
    expect(c.profitTargetINR).toBe(75000);
  });

  it('sanity: non-positive / garbage values fall back to defaults (never crash)', () => {
    const c = loadReversalConfig({ reversalLossCapINR: -5, reversalMaxLegs: 0, reversalCooldownMin: 'abc', reversalProfitTargetINR: null });
    expect(c.lossCapINR).toBe(150);
    expect(c.maxLegs).toBe(3); // 0 not > 0 → default (not 1 — the floor is for rounding only)
    expect(c.cooldownMin).toBe(3);
    expect(c.profitTargetINR).toBe(500);
  });
});

describe('pure leg math', () => {
  it('₹ P&L: direction-aware, fx-converted, booked partials included', () => {
    const long = { side: 'LONG', entryPrice: 0.5, qty: 1000, bookedPnlUSDT: 2 };
    expect(reversalLegPnlINR({ p: long, price: 0.52, usdInr: 84 })).toBeCloseTo((20 + 2) * 84, 1);
    const short = { side: 'SHORT', entryPrice: 0.5, qty: 1000 };
    expect(reversalLegPnlINR({ p: short, price: 0.52, usdInr: 84 })).toBeCloseTo(-1680, 1);
    expect(reversalLegPnlINR({ p: short, price: 0, usdInr: 84 })).toBeNull();
    expect(reversalLegPnlINR({ p: null, price: 1, usdInr: 84 })).toBeNull();
  });

  it('triggers: exactly-at-cap fires, one paisa above does not', () => {
    const cfg = CFG();
    expect(reversalTriggerOf({ pnlINR: -150, cfg })).toBe('LOSS_CAP');
    expect(reversalTriggerOf({ pnlINR: -149.9, cfg })).toBeNull();
    expect(reversalTriggerOf({ pnlINR: 500, cfg })).toBe('PROFIT_TARGET');
    expect(reversalTriggerOf({ pnlINR: 499.9, cfg })).toBeNull();
    expect(reversalTriggerOf({ pnlINR: null, cfg })).toBeNull();
  });

  it('₹ thresholds → price levels: LONG mirror and SHORT mirror', () => {
    const long = priceLevelsForLeg({ side: 'LONG', entry: 0.5, qty: 1000, lossCapINR: 150, profitTargetINR: 500, usdInr: 84 });
    expect(long.sl!).toBeLessThan(0.5);
    expect(long.tp!).toBeGreaterThan(0.5);
    expect(0.5 - long.sl!).toBeCloseTo(150 / 84 / 1000, 4); // pRound adaptive precision — 4dp honest
    expect(long.tp! - 0.5).toBeCloseTo(500 / 84 / 1000, 4);
    const short = priceLevelsForLeg({ side: 'SHORT', entry: 0.5, qty: 1000, lossCapINR: 150, profitTargetINR: 500, usdInr: 84 });
    expect(short.sl!).toBeGreaterThan(0.5);
    expect(short.tp!).toBeLessThan(0.5);
    expect(priceLevelsForLeg({ side: 'LONG', entry: 0.5, qty: 0, lossCapINR: 150, profitTargetINR: 500, usdInr: 84 })).toEqual({ sl: null, tp: null });
  });
});

describe('reversalDecision — the brain', () => {
  it('HOLD between the thresholds', () => {
    const p = mkPos();
    const d = reversalDecision({ p, price: 0.499, usdInr: 84, cfg: CFG(), cycle: null });
    expect(d.action).toBe('HOLD');
  });

  it('LOSS_CAP: cut + flip to the opposite side; missing ensemble never blocks', () => {
    const p = mkPos(); // LONG
    const d = reversalDecision({ p, price: 0.498, usdInr: 84, cfg: CFG(), cycle: { legCount: 1, netINR: 0, lastLegOpenedAt: p.openedAt } });
    expect(d.action).toBe('CLOSE_LOSS_CAP');
    expect(d.flipSide).toBe('SHORT');
    expect(d.blocked).toBeNull();
  });

  it('ensemble still STRONGLY on the original side vetoes the flip (pullback ≠ reversal) — the cut still happens', () => {
    const p = mkPos();
    const d = reversalDecision({ p, price: 0.498, usdInr: 84, cfg: CFG(), cycle: { legCount: 1, netINR: 0, lastLegOpenedAt: p.openedAt }, ensemble: { side: 'LONG', confidence: 72 } });
    expect(d.action).toBe('CLOSE_LOSS_CAP');
    expect(d.flipSide).toBeNull();
    expect(d.blocked).toBe('ensemble-still-original');
  });

  it('weak original-side ensemble (conf < 65) does NOT veto', () => {
    const p = mkPos();
    const d = reversalDecision({ p, price: 0.498, usdInr: 84, cfg: CFG(), cycle: { legCount: 1, netINR: 0, lastLegOpenedAt: p.openedAt }, ensemble: { side: 'LONG', confidence: 60 } });
    expect(d.flipSide).toBe('SHORT');
  });

  it('guards: maxLegs, cooldown, cycle-stop each end the flip (cut unconditional)', () => {
    const p = mkPos();
    const base = { p, price: 0.498, usdInr: 84, cfg: CFG() };
    expect(reversalDecision({ ...base, cycle: { legCount: 3, netINR: 0, lastLegOpenedAt: p.openedAt } }).blocked).toBe('maxLegs');
    expect(reversalDecision({ ...base, cycle: { legCount: 1, netINR: 0, lastLegOpenedAt: Date.now() - 10_000 } }).blocked).toBe('cooldown');
    expect(reversalDecision({ ...base, cycle: { legCount: 1, netINR: -200, lastLegOpenedAt: p.openedAt } }).blocked).toBe('cycle-stop');
  });

  it('PROFIT_TARGET: book, never an instant flip', () => {
    const p = mkPos();
    const d = reversalDecision({ p, price: 0.506, usdInr: 84, cfg: CFG(), cycle: { legCount: 1, netINR: 0, lastLegOpenedAt: p.openedAt }, ensemble: { side: 'SHORT', confidence: 80 } });
    expect(d.action).toBe('CLOSE_TARGET');
    expect(d.flipSide).toBeNull();
  });
});

describe('reentryDecision — the WAITING window', () => {
  const w = () => ({ cycleId: 'c1', pair: 'B-XRP_USDT', closedSide: 'SHORT', lastCloseAt: Date.now() - 600_000, until: Date.now() + 39 * 60_000, legCount: 2, netINR: 336, qty: 1000, leverage: 2, mode: 'paper' });

  it('ENTER on a confirmed opposite-side ensemble above the conf bar', () => {
    const d = reentryDecision({ waiting: w(), cycle: { legCount: 2, netINR: 336 }, cfg: CFG(), ensemble: { side: 'LONG', confidence: 75 } });
    expect(d.action).toBe('ENTER');
    expect(d.side).toBe('LONG');
  });

  it('WAIT: same side as the closed leg (trend continues — already banked)', () => {
    expect(reentryDecision({ waiting: w(), cycle: { legCount: 2, netINR: 336 }, cfg: CFG(), ensemble: { side: 'SHORT', confidence: 75 } }).action).toBe('WAIT');
  });

  it('WAIT: below the confidence bar', () => {
    expect(reentryDecision({ waiting: w(), cycle: { legCount: 2, netINR: 336 }, cfg: CFG(), ensemble: { side: 'LONG', confidence: 55 } }).action).toBe('WAIT');
  });

  it('WAIT: FLAT/missing ensemble + cooldown', () => {
    expect(reentryDecision({ waiting: w(), cycle: { legCount: 2, netINR: 336 }, cfg: CFG(), ensemble: null }).action).toBe('WAIT');
    expect(reentryDecision({ waiting: { ...w(), lastCloseAt: Date.now() - 10_000 }, cycle: { legCount: 2, netINR: 336 }, cfg: CFG(), ensemble: { side: 'LONG', confidence: 75 } }).action).toBe('WAIT');
  });

  it('END: window expiry, maxLegs, cycle-stop', () => {
    expect(reentryDecision({ waiting: { ...w(), until: Date.now() - 1000 }, cycle: { legCount: 2, netINR: 336 }, cfg: CFG(), ensemble: { side: 'LONG', confidence: 75 } }).action).toBe('END');
    expect(reentryDecision({ waiting: w(), cycle: { legCount: 3, netINR: 336 }, cfg: CFG(), ensemble: { side: 'LONG', confidence: 75 } }).action).toBe('END');
    expect(reentryDecision({ waiting: w(), cycle: { legCount: 2, netINR: -350 }, cfg: CFG(), ensemble: { side: 'LONG', confidence: 75 } }).action).toBe('END');
  });
});

describe('evaluateReversalForPosition — the user\'s XRP cycle (paper)', () => {
  it('LEG-1: −₹168 loss-cap CUT → ensemble SHORT 72% → leg-2 SHORT flip with ₹-stamped levels', async () => {
    const j = mkJournal([mkPos()]);
    const p = j.positions[0];
    const sendTelegram = vi.fn(async () => ({ ok: true }));
    const deps = mkDeps();
    const out = await evaluateReversalForPosition(j, p, 0.498, {
      cfg: CFG(), usdInr: 84,
      getDeepSignal: vi.fn(async () => ({ ok: true, signal: { side: 'SHORT', confidence: 72 } })),
      deps, sendTelegram,
    });
    expect(out.dirty).toBe(true);
    expect(out.closed).toBeTruthy();
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toContain('loss-cap');
    expect(p.pnlINR).toBeLessThanOrEqual(-150);
    // the flip leg
    expect(out.opened).toBeTruthy();
    const leg2 = j.positions.find(x => x.source === 'reversal')!;
    expect(leg2.side).toBe('SHORT');
    expect(leg2.reversal.leg).toBe(2);
    expect(leg2.reversal.cycleId).toBe(p.reversal.cycleId);
    expect(leg2.qty).toBeCloseTo(1000, 3);
    expect(leg2.entryPrice).toBeCloseTo(0.498, 6);
    expect(leg2.sl!).toBeGreaterThan(leg2.entryPrice);   // SHORT: SL above
    expect(leg2.tp!).toBeLessThan(leg2.entryPrice);      // SHORT: TP below
    expect(leg2.sl! - leg2.entryPrice).toBeCloseTo(150 / 84 / 1000, 4);
    // journal audit + telegram + no waiting window (cycle ACTIVE again)
    expect(j.entries.some(e => e.kind === 'CLOSE' && /loss-cap/.test(e.reason))).toBe(true);
    expect(j.entries.some(e => e.kind === 'ORDER' && e.status === 'FILLED' && e.source === 'reversal')).toBe(true);
    expect(sendTelegram).toHaveBeenCalled();
    expect(__waitingStateForTests().has('B-XRP_USDT')).toBe(false);
    // paper close → exchange untouched
    expect(deps.exitFuturesPosition).not.toHaveBeenCalled();
  });

  it('LEG-2: +₹504 target BOOKED → no instant flip → WAITING window armed', async () => {
    const root = mkPos({ status: 'CLOSED', closedAt: Date.now() - 600_000, closePrice: 0.498, pnlINR: -168, closeReason: 'REVERSAL loss-cap' });
    root.reversal = { cycleId: 'rv-x', leg: 1, rootId: root.id };
    const leg2 = mkPos({ id: 'leg-2', side: 'SHORT', source: 'reversal', entryPrice: 0.498, openedAt: Date.now() - 300_000, reversal: { cycleId: 'rv-x', leg: 2, rootId: root.id } });
    const j = mkJournal([root, leg2]);
    const sendTelegram = vi.fn(async () => ({ ok: true }));
    const deps = mkDeps();
    const out = await evaluateReversalForPosition(j, j.positions[1], 0.492, {
      cfg: CFG(), usdInr: 84,
      getDeepSignal: vi.fn(async () => ({ ok: true, signal: { side: 'SHORT', confidence: 70 } })),
      deps, sendTelegram,
    });
    expect(out.closed).toBeTruthy();
    expect(leg2.status).toBe('CLOSED');
    expect(leg2.closeReason).toContain('BOOKED');
    expect(leg2.pnlINR).toBeGreaterThanOrEqual(500);
    expect(out.opened).toBeNull(); // profit → never an instant flip
    const w = __waitingStateForTests().get('B-XRP_USDT');
    expect(w).toBeTruthy();
    expect(w.closedSide).toBe('SHORT');
    expect(j.entries.some(e => e.kind === 'CLOSE' && /BOOKED/.test(e.reason))).toBe(true);
  });

  it('WAITING → ensemble LONG 75% confirm → LEG-3 LONG re-entry', async () => {
    const root = mkPos({ status: 'CLOSED', closedAt: Date.now() - 1200_000, closePrice: 0.498, pnlINR: -168 });
    root.reversal = { cycleId: 'rv-y', leg: 1, rootId: root.id };
    const leg2 = mkPos({ id: 'leg-2', side: 'SHORT', source: 'reversal', entryPrice: 0.498, closedAt: Date.now() - 600_000, closePrice: 0.492, pnlINR: 504, status: 'CLOSED', closeReason: 'REVERSAL target BOOKED' });
    leg2.reversal = { cycleId: 'rv-y', leg: 2, rootId: root.id };
    const j = mkJournal([root, leg2]);
    const sendTelegram = vi.fn(async () => ({ ok: true }));
    const deps = mkDeps();
    // revive from the journal (restart-safe), then the confirmed entry
    const cfg = CFG();
    expect(reviveWaitingFromJournal(j, cfg)).toBe(1);
    const byPair = new Map([['B-XRP_USDT', 0.492]]);
    const out = await processReversalWaiting(j, byPair, {
      cfg, getDeepSignal: vi.fn(async () => ({ ok: true, signal: { side: 'LONG', confidence: 75 } })),
      deps, sendTelegram,
    });
    expect(out.dirty).toBe(true);
    const leg3 = j.positions.find(x => x.status === 'OPEN' && x.reversal?.leg === 3);
    expect(leg3).toBeTruthy();
    expect(leg3!.side).toBe('LONG');
    expect(leg3!.entryPrice).toBeCloseTo(0.492, 6);
    expect(leg3!.sl!).toBeLessThan(0.492);
    expect(__waitingStateForTests().has('B-XRP_USDT')).toBe(false);
    expect(sendTelegram).toHaveBeenCalled();
  });

  it('window expiry → CYCLE END stamped + journaled with the net', async () => {
    const root = mkPos({ status: 'CLOSED', closedAt: Date.now() - 4 * 3_600_000, closePrice: 0.498, pnlINR: -168 });
    root.reversal = { cycleId: 'rv-z', leg: 1, rootId: root.id };
    const leg2 = mkPos({ id: 'leg-2', side: 'SHORT', source: 'reversal', entryPrice: 0.498, closedAt: Date.now() - 2 * 3_600_000, closePrice: 0.492, pnlINR: 504, status: 'CLOSED', closeReason: 'REVERSAL target BOOKED' });
    leg2.reversal = { cycleId: 'rv-z', leg: 2, rootId: root.id };
    const j = mkJournal([root, leg2]);
    const sendTelegram = vi.fn(async () => ({ ok: true }));
    const cfg = CFG();
    reviveWaitingFromJournal(j, cfg);
    // nothing revives — the window is long expired; force a window to test END
    __waitingStateForTests().set('B-XRP_USDT', { cycleId: 'rv-z', pair: 'B-XRP_USDT', closedSide: 'SHORT', lastCloseAt: Date.now() - 2 * 3_600_000, until: Date.now() - 1000, legCount: 2, netINR: 336, qty: 1000, leverage: 2, mode: 'paper', rootId: root.id });
    const out = await processReversalWaiting(j, new Map(), { cfg, getDeepSignal: vi.fn(async () => ({ ok: true, signal: { side: 'LONG', confidence: 75 } })), deps: mkDeps(), sendTelegram });
    expect(out.dirty).toBe(true);
    expect(leg2.reversal.cycleEnd).toBeTruthy();
    expect(leg2.reversal.cycleEnd.netINR).toBeCloseTo(336, 1);
    expect(j.entries.some(e => e.kind === 'REVERSAL' && /CYCLE END/.test(e.reason))).toBe(true);
    expect(__waitingStateForTests().has('B-XRP_USDT')).toBe(false);
  });

  it('LIVE honesty: no exchange id → NO paper close (WATCH_ERROR, position stays OPEN)', async () => {
    const j = mkJournal([mkPos({ mode: 'live', exchangePositionId: null })]);
    const p = j.positions[0];
    const deps = mkDeps({ coindcxConnected: vi.fn(() => true) });
    const out = await evaluateReversalForPosition(j, p, 0.498, {
      cfg: CFG(), usdInr: 84, getDeepSignal: null, deps, sendTelegram: vi.fn(async () => ({ ok: true })),
    });
    expect(out.dirty).toBe(true);
    expect(out.closed).toBeFalsy();
    expect(p.status).toBe('OPEN'); // retry next pass — never a fake close
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /REVERSAL close BLOCKED/.test(e.reason))).toBe(true);
  });

  it('disabled config → no-op (the v12.7 discipline: opt-in only)', async () => {
    const j = mkJournal([mkPos()]);
    const p = j.positions[0];
    const out = await evaluateReversalForPosition(j, p, 0.498, { cfg: CFG({ enabled: false }), usdInr: 84, deps: mkDeps(), sendTelegram: vi.fn() });
    expect(out.dirty).toBe(false);
    expect(p.status).toBe('OPEN');
    expect(p.reversal).toBeUndefined();
  });
});

describe('reversalCyclesView + manual-trade LOSS_CAP advisory', () => {
  it('the board: cycle summary state/net/legs', () => {
    const root = mkPos({ status: 'CLOSED', closePrice: 0.498, pnlINR: -168, closeReason: 'REVERSAL loss-cap CUT' });
    root.reversal = { cycleId: 'rv-v', leg: 1, rootId: root.id };
    const leg2 = mkPos({ id: 'l2', side: 'SHORT', source: 'reversal', entryPrice: 0.498, status: 'CLOSED', closedAt: Date.now(), closePrice: 0.492, pnlINR: 504, closeReason: 'REVERSAL target BOOKED' });
    leg2.reversal = { cycleId: 'rv-v', leg: 2, rootId: root.id };
    const j = mkJournal([root, leg2]);
    const v = reversalCyclesView(j, { usdInr: 84, byPair: new Map() });
    expect(v.ok).toBe(true);
    expect(v.cycles.length).toBe(1);
    const c = v.cycles[0];
    expect(c.state).toBe('WAITING');
    expect(c.legCount).toBe(2);
    expect(c.netINR).toBeCloseTo(336, 1);
    expect(c.legs.length).toBe(2);
  });

  it('manual banner: LOSS_CAP fires at/below the cap, priority TARGET_HIT > LOSS_CAP > EXIT_NOW', () => {
    const t = { side: 'BUY', entryPrice: 100, origin: { plan: {} } };
    const rev = { enabled: true, lossCapINR: 150, pnlINR: -160 };
    expect(stateOfManualTrade({ convictionState: 'FLIPPED', ltp: 98, trade: t, reversal: rev })).toBe('LOSS_CAP');
    expect(stateOfManualTrade({ convictionState: null, ltp: 98, trade: t, reversal: rev })).toBe('LOSS_CAP');
    expect(stateOfManualTrade({ convictionState: null, ltp: 98, trade: t, reversal: { ...rev, pnlINR: -140 } })).toBe('STALE');
    expect(stateOfManualTrade({ convictionState: null, ltp: 98, trade: t, reversal: null })).toBe('STALE');
    // TARGET_HIT outranks the loss-cap (good news first)
    const withTarget = { side: 'BUY', entryPrice: 100, origin: { plan: { target1: 102 } } };
    expect(stateOfManualTrade({ convictionState: 'FLIPPED', ltp: 103, trade: withTarget, reversal: rev })).toBe('TARGET_HIT');
  });
});
