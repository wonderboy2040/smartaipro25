// ============================================================
// test/manualReversal.test.ts — v12.9 REVERSAL ENGINE CONNECTION
// ------------------------------------------------------------
// LOCKED HERE (user spec: "manual trades ko Reversal AI Engine se
// connect karo — reversal pe ACTIVATE hona chahiye · no-caps
// thresholds · realtime prices"):
//   • activateReversalOnManualTrade: LOSS_CAP crossing stamps the
//     MANUAL cycle + the exact FLIP plan (₹ thresholds → SL/TP price
//     levels at the live price); PROFIT_TARGET crossing stamps BOOK;
//     in-band degrades to ACTIVE; repeat crossings stay quiet
//   • reversalActivationText: the native-currency P&L ($ for USDT
//     perps — NO ₹-converted price amount per user spec) + the ₹ cap
//   • closeManualTrade: the cycle advances (closeReason carries the
//     REVERSAL leg CUT/BOOK tag; followUp stamped)
//   • recordManualTrade AUTO-LINK: a new trade on a symbol with a
//     recently-closed cycle (inside the re-entry window, legs left)
//     becomes the NEXT LEG of the same cycle
//   • manualReversalCycles: the board view — legs, net ₹, live P&L,
//     WAITING window state, the FLIP plan carried on the cycle
//   • stateOfManualTrade: REVERSAL_BOOK banner at/above the ₹ target
//   • manualLiveMerge (client realtime): the SSE tick merge — fresh
//     tick overrides LTP + recomputes P&L in the native currency with
//     the server's own fx; a stale (>30s) tick never masquerades
// Same hermetic scaffolding as manualTrades.test.ts.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- hermetic store (no disk) ----
const _disk = vi.hoisted(() => new Map());
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f, d) => (_disk.has(f) ? _disk.get(f) : d),
  saveJSON: (f, v) => { _disk.set(f, v); },
}));
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
const _ticks = vi.hoisted(() => new Map());
vi.mock('../server/liveFeed.js', () => ({
  getTick: (k) => _ticks.get(k) || null,
}));
vi.mock('../server/ai/coindcxOrders.js', () => ({
  getPositionsWithPnl: vi.fn(async () => ({ positions: [] })),
  loadConfig: vi.fn(() => ({ killSwitch: false })),
}));
vi.mock('../server/intraday/paperTrading.js', () => ({
  getPaperSummary: vi.fn(() => ({ open: [] })),
}));
vi.mock('../server/ai/secrets.js', () => ({
  telegramConfig: vi.fn(() => ({ token: 'T', chatId: 'C', source: 'env' })),
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
}));

import {
  activateReversalOnManualTrade, reversalActivationText,
  manualReversalCycles, recordManualTrade, closeManualTrade,
  listManualTrades, stateOfManualTrade,
  __resetManualStoreForTests, __setManualStateForTests,
} from '../server/ai/manualTrades.js';

// the engine config rides the same agent-config file (mocked disk)
import { loadReversalConfig } from '../server/ai/reversalEngine.js';

// client-side pure helpers (real — no mocks needed)
import { liveKeyFor, livePnlOf, mergeLiveTicks } from '../src/components/aitrading/manualLiveMerge';

const CFG_ON = { enabled: true, lossCapINR: 150, profitTargetINR: 500, maxLegs: 3, reentryWindowMs: 45 * 60_000, reentryWindowMin: 45, cooldownMin: 3, cycleStopINR: 300, minReentryConf: 60, requireEnsembleConfirm: true };

const XRP_USDT = { market: 'FUTURES', symbol: 'XRP', side: 'BUY', entryPrice: 0.5, qty: 1000 };

beforeEach(() => {
  _disk.clear();
  _ticks.clear();
  __resetManualStoreForTests();
});

// ------------------------------------------------------------
describe('activateReversalOnManualTrade — the engine connection', () => {
  it('LOSS_CAP crossing ACTIVATES the manual cycle with the exact FLIP plan', () => {
    // 0.5 → 0.498: (0.498-0.5)*1000 = -2 USDT ×84 = -₹168 ≤ -₹150
    const t = { ...XRP_USDT, status: 'OPEN', id: 7 };
    const tr = activateReversalOnManualTrade(t, 0.498, { usdInr: 84, cfg: CFG_ON });
    expect(tr).toBeTruthy();
    expect(tr.from).toBeNull();
    expect(tr.to).toBe('LOSS_CAP');
    expect(tr.cycleId).toBe('mrv-XRP-7');
    expect(t.reversal.state).toBe('LOSS_CAP');
    expect(t.reversal.leg).toBe(1);
    expect(t.reversal.flip.side).toBe('SHORT');
    expect(t.reversal.flip.qty).toBe(1000);
    expect(t.reversal.flip.sl).toBeGreaterThan(0.498); // SHORT SL above
    expect(t.reversal.flip.tp).toBeLessThan(0.498);    // SHORT TP below
    // ₹-distance math: SL distance ≈ ₹150/(84×1000) = 0.00179
    expect(t.reversal.flip.sl - 0.498).toBeCloseTo(150 / 84 / 1000, 4);
    expect(0.498 - t.reversal.flip.tp).toBeCloseTo(500 / 84 / 1000, 4);
  });

  it('PROFIT_TARGET crossing stamps BOOK (no flip plan)', () => {
    // SHORT 0.5 → 0.492: (0.5-0.492)*1000 = +8 USDT ×84 = +₹672 ≥ ₹500
    const t = { ...XRP_USDT, side: 'SELL', status: 'OPEN', id: 8 };
    const tr = activateReversalOnManualTrade(t, 0.492, { usdInr: 84, cfg: CFG_ON });
    expect(tr.to).toBe('PROFIT_TARGET');
    expect(t.reversal.state).toBe('PROFIT_TARGET');
    expect(t.reversal.flip).toBeUndefined();
  });

  it('in-band price: no stamp before any crossing; ACTIVE after recovery', () => {
    const t = { ...XRP_USDT, status: 'OPEN', id: 9 };
    // in-band: 0.4990 → (0.4990-0.5)*1000×84 = −₹84 (above the −₹150 cap)
    expect(activateReversalOnManualTrade(t, 0.4990, { usdInr: 84, cfg: CFG_ON })).toBeNull();
    expect(t.reversal).toBeUndefined();
    // cross into LOSS_CAP (0.498 → −₹168), then recover in-band (0.4985 → −₹126) → ACTIVE
    activateReversalOnManualTrade(t, 0.498, { usdInr: 84, cfg: CFG_ON });
    const tr2 = activateReversalOnManualTrade(t, 0.4985, { usdInr: 84, cfg: CFG_ON });
    expect(tr2.to).toBe('ACTIVE');
    expect(t.reversal.state).toBe('ACTIVE');
    expect(t.reversal.flip).toBeTruthy(); // the plan from the crossing survives
  });

  it('repeat crossings are quiet (no transition object)', () => {
    const t = { ...XRP_USDT, status: 'OPEN', id: 10 };
    activateReversalOnManualTrade(t, 0.498, { usdInr: 84, cfg: CFG_ON });
    expect(activateReversalOnManualTrade(t, 0.4975, { usdInr: 84, cfg: CFG_ON })).toBeNull();
  });

  it('engine OFF / closed trade / OPTION / bad price → null (honest no-ops)', () => {
    const t = { ...XRP_USDT, status: 'OPEN', id: 11 };
    expect(activateReversalOnManualTrade(t, 0.498, { usdInr: 84, cfg: { ...CFG_ON, enabled: false } })).toBeNull();
    expect(activateReversalOnManualTrade({ ...t, status: 'CLOSED' }, 0.498, { usdInr: 84, cfg: CFG_ON })).toBeNull();
    expect(activateReversalOnManualTrade({ ...t, assetKind: 'OPTION' }, 0.498, { usdInr: 84, cfg: CFG_ON })).toBeNull();
    expect(activateReversalOnManualTrade(t, 0, { usdInr: 84, cfg: CFG_ON })).toBeNull();
  });
});

describe('reversalActivationText — native currency, no INR price conversion', () => {
  it('USDT perp: $ P&L (NEVER a ₹-converted amount) + the ₹ cap', () => {
    const t = { ...XRP_USDT, status: 'OPEN', id: 12, reversal: { cycleId: 'mrv-XRP-12', leg: 1, state: 'LOSS_CAP', lossCapINR: 150, profitTargetINR: 500, flip: { side: 'SHORT', qty: 1000, entry: 0.498, sl: 0.49979, tp: 0.49205 } } };
    const tr = { from: null, to: 'LOSS_CAP', trade: t, cycleId: 'mrv-XRP-12', leg: 1, pnlINR: -168, price: 0.498, flip: t.reversal.flip };
    const text = reversalActivationText(tr, { usdInr: 84 });
    expect(text).toContain('−$2');
    expect(text).toContain('cap ₹150');
    expect(text).not.toContain('−₹168'); // no INR-converted P&L on the USDT desk
    expect(text).toContain('FLIP <b>SHORT</b> qty 1000');
    expect(text).toContain('SL $0.4998'); // 4dp precision — sub-$1 levels stay readable
  });

  it('India trade: ₹ P&L native', () => {
    const t = { market: 'INDIA', symbol: 'RELIANCE', side: 'BUY', entryPrice: 1000, qty: 10, status: 'OPEN', id: 13, reversal: { cycleId: 'mrv-RELIANCE-13', leg: 1, state: 'LOSS_CAP', lossCapINR: 150, profitTargetINR: 500, flip: { side: 'SHORT', qty: 10, entry: 985, sl: 1000, tp: 935 } } };
    const tr = { from: null, to: 'LOSS_CAP', trade: t, cycleId: 'mrv-RELIANCE-13', leg: 1, pnlINR: -160, price: 985, flip: t.reversal.flip };
    const text = reversalActivationText(tr, { usdInr: 84 });
    expect(text).toContain('−₹160');
    expect(text).toContain('cap ₹150');
  });

  it('PROFIT_TARGET text: BOOK call + re-entry window note', () => {
    const t = { ...XRP_USDT, side: 'SELL', status: 'OPEN', id: 14, reversal: { cycleId: 'mrv-XRP-14', leg: 1, state: 'PROFIT_TARGET', lossCapINR: 150, profitTargetINR: 500 } };
    const tr = { from: null, to: 'PROFIT_TARGET', trade: t, cycleId: 'mrv-XRP-14', leg: 1, pnlINR: 672, price: 0.492, flip: null };
    const text = reversalActivationText(tr, { usdInr: 84 });
    expect(text).toContain('₹ TARGET hit');
    expect(text).toContain('BOOK karo');
    expect(text).toContain('+$8');
  });
});

describe('closeManualTrade — the cycle advances', () => {
  it('a LOSS_CAP-active close carries the REVERSAL CUT tag + followUp FLIP', () => {
    _disk.set('ai-agent-config.json', { reversalEnabled: true, reversalLossCapINR: 150, reversalProfitTargetINR: 500, reversalMaxLegs: 3, reversalReentryWindowMin: 45 });
    const out = recordManualTrade({ ...XRP_USDT, ltp: 0.5 });
    expect(out.ok).toBe(true);
    const t = out.trade;
    const tr = activateReversalOnManualTrade(t, 0.498, { usdInr: 84, cfg: loadReversalConfig(null, { force: true }) });
    expect(tr.to).toBe('LOSS_CAP');
    const c = closeManualTrade(t.id, { exitPrice: 0.4975, reason: 'user exit' });
    expect(c.ok).toBe(true);
    expect(c.trade.closeReason).toContain('REVERSAL leg-1 CUT');
    expect(c.trade.reversal.closedState).toBe('LOSS_CAP');
    expect(c.trade.reversal.followUp).toBe('FLIP');
    expect(c.trade.exitPnlINR).toBeCloseTo((0.4975 - 0.5) * 1000 * 84, 0);
  });
});

describe('recordManualTrade — AUTO-LINK to the live cycle', () => {
  it('a new trade on the same symbol inside the window becomes the NEXT LEG', () => {
    _disk.set('ai-agent-config.json', { reversalEnabled: true, reversalLossCapINR: 150, reversalProfitTargetINR: 500, reversalMaxLegs: 3, reversalReentryWindowMin: 45 });
    const first = recordManualTrade({ ...XRP_USDT, ltp: 0.5 });
    activateReversalOnManualTrade(first.trade, 0.498, { usdInr: 84, cfg: loadReversalConfig(null, { force: true }) });
    closeManualTrade(first.trade.id, { exitPrice: 0.4975 });
    // the user follows the plan: flips SHORT on XRP within the window
    const flip = recordManualTrade({ market: 'FUTURES', symbol: 'XRP', side: 'SELL', entryPrice: 0.497, qty: 1000, ltp: 0.497 });
    expect(flip.ok).toBe(true);
    expect(flip.trade.reversal.cycleId).toBe(first.trade.reversal.cycleId);
    expect(flip.trade.reversal.leg).toBe(2);
    // outside the window (or legs exhausted) → NO link
    _disk.set('ai-agent-config.json', { reversalEnabled: true, reversalLossCapINR: 150, reversalProfitTargetINR: 500, reversalMaxLegs: 3, reversalReentryWindowMin: 45 });
    const staleClosed = { ...first.trade, id: 99, closedAt: Date.now() - 46 * 60_000, status: 'CLOSED' };
    __setManualStateForTests([staleClosed, flip.trade], 100);
    const late = recordManualTrade({ market: 'FUTURES', symbol: 'XRP', side: 'BUY', entryPrice: 0.5, qty: 1000, ltp: 0.5 });
    expect(late.ok).toBe(true);
    expect(late.trade.reversal).toBeUndefined(); // window expired — fresh cycle
  });
});

describe('manualReversalCycles — the board view', () => {
  it('groups by cycleId, ranks ACTIVE > WAITING > ENDED, carries the plan + live ₹', () => {
    const now = Date.now();
    const leg1 = {
      id: 1, symbol: 'XRP', market: 'FUTURES', side: 'BUY', entryPrice: 0.5, qty: 1000,
      status: 'CLOSED', openedAt: now - 3600_000, closedAt: now - 600_000, exitPrice: 0.4975,
      exitPnlINR: -210, closeReason: 'REVERSAL leg-1 CUT',
      reversal: { cycleId: 'mrv-XRP-1', leg: 1, state: 'LOSS_CAP', flip: { side: 'SHORT', qty: 1000, entry: 0.498, sl: 0.49979, tp: 0.49205 } },
    };
    const leg2 = {
      id: 2, symbol: 'XRP', market: 'FUTURES', side: 'SELL', entryPrice: 0.497, qty: 1000,
      status: 'OPEN', openedAt: now - 300_000, __ltp: 0.493,
      reversal: { cycleId: 'mrv-XRP-1', leg: 2, state: 'ACTIVE' },
    };
    _disk.set('ai-agent-config.json', { reversalEnabled: true, reversalReentryWindowMin: 45, reversalMaxLegs: 3 });
    const cycles = manualReversalCycles([leg1, leg2], { usdInr: 84, now });
    expect(cycles).toHaveLength(1);
    const c = cycles[0];
    expect(c.mode).toBe('manual');
    expect(c.state).toBe('ACTIVE');
    expect(c.legCount).toBe(2);
    expect(c.legs[0].pnlINR).toBe(-210);
    expect(c.live.price).toBe(0.493);
    expect(c.live.pnlINR).toBeCloseTo((0.497 - 0.493) * 1000 * 84, 0); // SHORT +₹336
    expect(c.netINR).toBe(-210);
    expect(c.plan.side).toBe('SHORT'); // the flip plan rides the cycle
  });

  it('all-closed inside the window → WAITING; outside → ENDED', () => {
    const now = Date.now();
    const closed = {
      id: 1, symbol: 'XRP', market: 'FUTURES', side: 'BUY', entryPrice: 0.5, qty: 1000,
      status: 'CLOSED', openedAt: now - 3600_000, closedAt: now - 600_000, exitPrice: 0.4975,
      exitPnlINR: -210,
      reversal: { cycleId: 'mrv-XRP-1', leg: 1, state: 'LOSS_CAP' },
    };
    _disk.set('ai-agent-config.json', { reversalEnabled: true, reversalReentryWindowMin: 45, reversalMaxLegs: 3 });
    expect(manualReversalCycles([closed], { usdInr: 84, now }).state ?? manualReversalCycles([closed], { usdInr: 84, now })[0].state).toBe('WAITING');
    const stale = { ...closed, closedAt: now - 50 * 60_000 };
    expect(manualReversalCycles([stale], { usdInr: 84, now })[0].state).toBe('ENDED');
  });
});

describe('stateOfManualTrade — REVERSAL_BOOK banner', () => {
  it('PROFIT_TARGET state → REVERSAL_BOOK (beats conviction states)', () => {
    const t = { ...XRP_USDT, origin: { plan: { target1: 0.9, target2: 1.1 } } };
    const b = stateOfManualTrade({ convictionState: 'HOLDING', ltp: 0.51, trade: t, reversal: { enabled: true, state: 'PROFIT_TARGET', pnlINR: 672, lossCapINR: 150 } });
    expect(b).toBe('REVERSAL_BOOK');
  });
  it('live LOSS_CAP still fires below the cap', () => {
    const t = { ...XRP_USDT, origin: {} };
    const b = stateOfManualTrade({ convictionState: 'HOLDING', ltp: 0.498, trade: t, reversal: { enabled: true, pnlINR: -168, lossCapINR: 150 } });
    expect(b).toBe('LOSS_CAP');
  });
});

// ------------------------------------------------------------
describe('manualLiveMerge — the CLIENT realtime merge (pure)', () => {
  it('liveKeyFor: market → SSE namespace', () => {
    expect(liveKeyFor('FUTURES', 'xrp')).toBe('FUT_XRP');
    expect(liveKeyFor('GLOBALFUTURES', 'AAPL')).toBe('GLOB_AAPL');
    expect(liveKeyFor('CRYPTO', 'btc')).toBe('IN_BTC');
    expect(liveKeyFor('INDIA', 'reliance')).toBe('IN_RELIANCE');
    expect(liveKeyFor('', '')).toBeNull();
  });

  it('livePnlOf: native currency math (USDT for perps, ₹ for India, lotSize aware)', () => {
    const usd = livePnlOf({ market: 'FUTURES', side: 'BUY', entryPrice: 0.5, qty: 1000 }, 0.52, 84);
    expect(usd.currency).toBe('USDT');
    expect(usd.pnlUSDT).toBeCloseTo(20, 1);
    expect(usd.pnlINR).toBeCloseTo(1680, 0);
    const inr = livePnlOf({ market: 'INDIA', side: 'SELL', entryPrice: 1000, qty: 2, lotSize: 75 }, 990, 84);
    expect(inr.currency).toBe('INR');
    expect(inr.pnlINR).toBeCloseTo(1500, 0); // (1000-990)*2*75
    expect(livePnlOf({ market: 'FUTURES', side: 'BUY', entryPrice: 0, qty: 1 }, 1, 84)).toBeNull();
  });

  it('a FRESH tick overrides LTP + P&L; a STALE tick never does', () => {
    const now = Date.now();
    const trades = [{
      id: 1, status: 'OPEN', market: 'FUTURES', symbol: 'XRP', side: 'BUY',
      entryPrice: 0.5, qty: 1000,
      __view: { ltp: 0.5, pnl: { pnlINR: 0, pnlPct: 0, pnlUSDT: 0, currency: 'USDT' } },
    }];
    const fresh = mergeLiveTicks(trades as never, { FUT_XRP: { price: 0.52, time: now - 1000 } }, 84, now);
    expect((fresh[0] as { __view: { ltp: number } }).__view.ltp).toBe(0.52);
    expect((fresh[0] as { __view: { pnl: { pnlUSDT: number } } }).__view.pnl.pnlUSDT).toBeCloseTo(20, 1);
    const stale = mergeLiveTicks(trades as never, { FUT_XRP: { price: 0.52, time: now - 40_000 } }, 84, now);
    expect((stale[0] as { __view: { ltp: number } }).__view.ltp).toBe(0.5); // server LTP stands
    // CLOSED trades never merge
    const closed = mergeLiveTicks([{ ...trades[0], status: 'CLOSED' } as never], { FUT_XRP: { price: 0.52, time: now - 1000 } }, 84, now);
    expect((closed[0] as { __view: { ltp: number } }).__view.ltp).toBe(0.5);
  });
});
