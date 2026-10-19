// ============================================================
// test/aiOrders.test.ts — the EXECUTION GAUNTLET
// ------------------------------------------------------------
// Full-path tests of coindcxOrders.executeSignal with an injected
// fresh-signal source (never trusting the client) + mocked
// CoinDCX private API. Every gate must reject exactly as designed.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the CoinDCX module BEFORE importing the order engine.
const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
  loadJSON: undefined, saveJSON: undefined,
}));
// Mock cryptoStream's ticker fetch (watcher pricing).
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => [
    { market: 'BTCINR', last_price: '100' },
    { market: 'ETHINR', last_price: '50' },
  ]),
}));

import {
  executeSignal, __resetForTests, __setConfigForTests, __setJournalForTests,
  loadJournal, updateConfig, getRiskState, watchPositions, loadConfig, closePosition,
} from '../server/ai/coindcxOrders.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

const STRONG = {
  symbol: 'BTC', market: 'CRYPTO', side: 'LONG', grade: 'STRONG',
  confidence: 82, agreement: 0.78, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4,
    risk: 3.2, riskPct: 3.2, rewardRisk: 2, atrUsed: 2, planStyle: 'atr-based',
  },
  votes: [], summary: 'x',
};
const freshSignal = async () => ({ ...STRONG });

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  // The order engine reads CoinDCX creds from the real server-side store
  // (never from the client) — seed a pair so LIVE paths can sign. The
  // ORIGINAL file is restored afterwards so file-order-dependent suites
  // (portfolioSync / coindcx) never see our test creds.
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockPrivate.mockResolvedValue({ orders: [{ id: 'order-123' }] });
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

describe('paper execution — the happy path', () => {
  it('opens a paper position with plan SL/TP attached and journal entries', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('paper');
    expect(out.filled!.qty).toBeGreaterThan(0);
    expect(out.position!.sl).toBeCloseTo(96.8, 1);
    expect(out.position!.tp2).toBeCloseTo(106.4, 1);
    const j = loadJournal();
    expect(j.positions).toHaveLength(1);
    expect(j.entries.at(-1)!.status).toBe('FILLED');
    expect(j.entries.at(-1)!.signal?.grade).toBe('STRONG');
  });

  it('caps order value at maxOrderINR (₹1000 default → qty = 10 at ₹100)', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.filled!.qty).toBeCloseTo(10, 4);
    // v20.2: paper fills take +7bps adverse slippage (practice realism) —
    // qty stays 10; notional = 10 × (100 × 1.0007) ≈ 1000.7
    expect(out.filled!.notionalINR).toBeCloseTo(1000.7, 1);
  });

  it('honors a custom qtyINR below the cap', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', qtyINR: 250, getFreshSignal: freshSignal });
    expect(out.filled!.qty).toBeCloseTo(2.5, 4);
  });

  it('LIVE rejects when the ensemble is only ACTION grade', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() }); // armed (mode gate)
    const out = await executeSignal({
      symbol: 'BTC', mode: 'live',
      getFreshSignal: async () => ({ ...STRONG, grade: 'ACTION', confidence: 60 }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/grade ACTION/);
    const j = loadJournal();
    expect(j.entries.at(-1)!.status).toBe('REJECTED');
  });

  it('PAPER (practice money) accepts ACTION-grade signals — STRONG gate is for LIVE', async () => {
    const out = await executeSignal({
      symbol: 'BTC', mode: 'paper',
      getFreshSignal: async () => ({ ...STRONG, grade: 'ACTION', confidence: 60 }),
    });
    expect(out.ok).toBe(true);
    expect(out.position!.mode).toBe('paper');
  });

  it('rejects stale ensemble runs for LIVE (> 90s) — paper gets 10 min', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() }); // armed (mode gate)
    const stale = { ...STRONG, generatedAt: Date.now() - 200_000 };
    const live = await executeSignal({ symbol: 'BTC', mode: 'live', getFreshSignal: async () => stale });
    expect(live.ok).toBe(false);
    expect(live.error).toMatch(/stale/i);
    __setConfigForTests({}); // back to paper default for the paper assertion
    const paper = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: async () => stale });
    expect(paper.ok).toBe(true); // 200s < 10min practice window
  });

  it('LIVE rejects when agreement is below the gate (paper still allows practice)', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() }); // armed (mode gate)
    const live = await executeSignal({
      symbol: 'BTC', mode: 'live',
      getFreshSignal: async () => ({ ...STRONG, agreement: 0.55 }),
    });
    expect(live.ok).toBe(false);
    expect(live.error).toMatch(/agreement/i);
  });

  it('MODE GATE: mode:"live" while the account is in PAPER is rejected server-side', async () => {
    // The request body's mode field alone must NEVER move real money —
    // arming requires the typed "LIVE" confirmation in Risk settings.
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', getFreshSignal: freshSignal });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/LIVE mode is not enabled/);
    expect(mockPrivate).not.toHaveBeenCalled(); // no exchange call even attempted
    const j = loadJournal();
    expect(j.entries.at(-1)!.status).toBe('REJECTED');
    expect(j.positions).toHaveLength(0);
  });
});

describe('risk-limit gates', () => {
  it('kill switch rejects everything and updateConfig forces paper+no-auto', async () => {
    __setConfigForTests({ killSwitch: true });
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Kill switch/i);
  });

  it('daily trade cap blocks the Nth trade', async () => {
    __setConfigForTests({ dailyMaxTrades: 1 });
    const first = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(first.ok).toBe(true);
    const second = await executeSignal({ symbol: 'ETH', mode: 'paper', getFreshSignal: freshSignal });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/Daily trade cap/);
  });

  it('v12.1: FAILED orders never consume the daily trade cap (live 2026-09-18 incident)', async () => {
    // Journal-proven: three [422] "market is required" FAILED entries ate
    // the whole day's budget → agent stood down on trades that never
    // executed. An exchange-refused order is not a trade.
    __setConfigForTests({ dailyMaxTrades: 1 });
    const j = loadJournal();
    const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    j.entries.push({
      id: 'f1', ts: Date.now(), kind: 'ORDER', day: istDay, pair: 'BNBINR',
      status: 'FAILED', reason: '[422] market is required',
    });
    __setJournalForTests(j);
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(true); // the failed attempt left the budget untouched
  });

  it('daily loss cap blocks trading after the realized-loss breach', async () => {
    const j = loadJournal();
    const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    j.entries.push({
      id: 'e1', ts: Date.now(), kind: 'CLOSE', day: istDay,
      pair: 'BTCINR', status: 'CLOSED', pnlINR: -700,
    });
    __setJournalForTests(j);
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Daily loss cap/);
  });

  it('one-position-per-pair blocks a duplicate', async () => {
    await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/one-per-pair|already exists/i);
  });

  it('tiny budgets below ₹100 are refused', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', qtyINR: 50, getFreshSignal: freshSignal });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/₹100 minimum/);
  });
});

describe('LIVE execution — signed order path', () => {
  // All LIVE-path tests arm the account first: the server-side MODE GATE
  // rejects mode:'live' while the config is in PAPER regardless of what
  // the request claims.
  it('submits a market order to CoinDCX with the exact body shape', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('live');
    expect(out.orderId).toBe('order-123');
    expect(mockPrivate).toHaveBeenCalledTimes(1);
    const [path, apiKey, secret, body] = mockPrivate.mock.calls[0];
    expect(path).toBe('/exchange/v1/orders/create');
    expect(body.side).toBe('buy');
    // v12.1 LIVE-FIX contract: the SPOT pair travels in `market` (the
    // journal-proven [422] "market is required" bug — `pair` is the
    // margin/futures vocabulary) and the order_type vocabulary is
    // `market_order`, not bare `market`.
    expect(body.market).toBe('BTCINR');
    expect(body.pair).toBeUndefined();
    expect(body.order_type).toBe('market_order');
    expect(Number(body.total_quantity)).toBeCloseTo(10, 4);
    // NOTE: `timestamp` is injected INSIDE the real coindcxPrivate signer —
    // the caller body carries only the order fields.
    const j = loadJournal();
    expect(j.entries.at(-1)!.status).toBe('SUBMITTED');
    expect(j.entries.at(-1)!.exchangeOrderId).toBe('order-123');
    expect(j.positions[0].source).toBe('manual'); // auto-executor guard reads this
  });

  it('SHORT signal sends a sell order', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({
      symbol: 'BTC', mode: 'live',
      getFreshSignal: async () => ({ ...STRONG, side: 'SHORT', plan: { ...STRONG.plan, riskPct: 3 } }),
    });
    expect(out.ok).toBe(true);
    expect(mockPrivate.mock.calls[0][3].side).toBe('sell');
  });

  it('API failure → FAILED journal entry, no position created', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() });
    mockPrivate.mockRejectedValueOnce(new Error('[401] invalid key'));
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', getFreshSignal: freshSignal });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/CoinDCX order failed/);
    const j = loadJournal();
    expect(j.entries.at(-1)!.status).toBe('FAILED');
    expect(j.positions.filter(p => p.mode === 'live')).toHaveLength(0);
  });
});

describe('journal write serialization — the mutex (double-sell guard)', () => {
  it('a manual close racing the SL watcher closes the position EXACTLY once', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    const j = loadJournal();
    j.positions[0].sl = 101; // breached at mocked ticker price 100
    __setJournalForTests(j);
    const id = j.positions[0].id;
    // Both writers start together; pre-mutex both held stale OPEN copies
    // and sent TWO market sells for the same tracked position.
    const [, manual] = await Promise.all([
      watchPositions({}),
      closePosition(id),
    ]);
    const after = loadJournal();
    const closes = after.entries.filter(e => e.kind === 'CLOSE');
    expect(closes).toHaveLength(1);          // exactly one close, one P&L booking
    expect(after.positions[0].status).toBe('CLOSED');
    expect([true, false]).toContain(manual.ok); // loser no-ops gracefully
  });

  it('concurrent duplicate executions cannot stack on a full journal (fresh re-check under lock)', async () => {
    __setConfigForTests({ dailyMaxTrades: 1 });
    const [a, b] = await Promise.all([
      executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal }),
      executeSignal({ symbol: 'ETH', mode: 'paper', getFreshSignal: freshSignal }),
    ]);
    const after = loadJournal();
    // Both passed the pre-signal gates; the locked final section must
    // re-check the daily cap on the FRESH journal and reject the second.
    expect((a.ok ? 1 : 0) + (b.ok ? 1 : 0)).toBe(1);
    expect(after.positions).toHaveLength(1);
    expect(after.entries.filter(e => e.kind === 'ORDER' && e.status === 'REJECTED')).toHaveLength(1);
  });
});

describe('LIVE mode arming — typed confirmation required', () => {
  it('rejects LIVE without the phrase', () => {
    expect(() => updateConfig({ mode: 'live' })).toThrow(/liveConfirmPhrase/i);
  });
  it('arms with the phrase and stamps liveConfirmedAt', () => {
    const cfg = updateConfig({ mode: 'live', liveConfirmPhrase: 'live' });
    expect(cfg.mode).toBe('live');
    expect(cfg.liveConfirmedAt).toBeGreaterThan(0);
  });
  it('kill switch ON forces paper + auto OFF', () => {
    updateConfig({ mode: 'live', liveConfirmPhrase: 'live', allowAuto: true });
    const cfg = updateConfig({ killSwitch: true });
    expect(cfg.mode).toBe('paper');
    expect(cfg.allowAuto).toBe(false);
    expect(cfg.killSwitch).toBe(true);
  });
});

describe('position watcher — SL/TP enforcement', () => {
  it('closes a LONG paper position when price falls to/below SL', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    // Ticker mock says BTC = ₹100; entry 100. LONG closes when price <= SL,
    // so SL 101 (above price) = breached.
    const j = loadJournal();
    j.positions[0].sl = 101;
    __setJournalForTests(j);
    const closures = await watchPositions({});
    expect(closures).toHaveLength(1);
    const after = loadJournal();
    expect(after.positions[0].status).toBe('CLOSED');
    expect(after.positions[0].closeReason).toMatch(/STOP-LOSS/);
    expect(after.entries.at(-1)!.kind).toBe('CLOSE');
  });

  it('v20.3: a paper CLOSE fills ADVERSELY (exit-side slippage) — mid no longer flatters the exit leg', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    const j = loadJournal();
    j.positions[0].sl = 101;   // breached at the mocked ticker price of 100
    __setJournalForTests(j);
    await watchPositions({});
    const after = loadJournal();
    const p = after.positions[0];
    expect(p.status).toBe('CLOSED');
    // LONG exit = selling into the bid: 100 x (1 - 7bps) = 99.93
    expect(p.closePrice).toBeCloseTo(99.93, 2);
    // the journal row stamps the honesty note
    expect(after.entries.at(-1)!.slipNote).toMatch(/exit -7bps/);
    // entry already slipped +7bps (v20.2); the realized P&L is now net of
    // BOTH adverse fills (fees are separate — v18.9)
    expect(p.closePrice).toBeLessThan(100);
  });

  it('leaves positions alone above SL and below TP2', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: freshSignal });
    expect(out.ok).toBe(true);
    const closures = await watchPositions({});
    expect(closures).toHaveLength(0); // price 100, SL 96.8, TP2 106.4 → inside
    expect(loadJournal().positions[0].status).toBe('OPEN');
  });
});

describe('getRiskState', () => {
  it('reports blocked reasons honestly', () => {
    const rs = getRiskState();
    expect(rs.config.mode).toBe('paper');
    expect(rs.blocked.killSwitch).toBe(false);
    expect(rs.stats.tradesCount).toBe(0);
  });
});

describe('PAPER practice-plan synthesis (v9.0.2 — paper always starts)', () => {
  it('v9.0.2: paper on FLAT consensus SYNTHESIZES a practice plan (was a dead end since v6.12)', async () => {
    // v6.12 killed noise rehearsal with the ACTION floor, but it also
    // dead-ended every FLAT/planless fresh re-run — "paper trading
    // start hi nhi ho raha". Practice now always opens with an honest
    // disclosure; the journal keeps the real fresh grade.
    const out = await executeSignal({
      symbol: 'BTC', mode: 'paper', side: 'LONG',
      getFreshSignal: async () => ({ ...STRONG, side: 'FLAT', grade: 'NEUTRAL', confidence: 20, plan: null, dir: 0 }),
    });
    expect(out.ok).toBe(true);
    expect(out.position!.side).toBe('LONG');
    expect(out.fitted).toMatch(/practice plan @ live price/i);
    const j = loadJournal();
    expect(j.entries.at(-1)!.signal!.grade).toBe('NEUTRAL'); // honesty journaled
  });

  it('v21.23.2: paper on a SIDE-FLIP (fresh SHORT, clicked LONG) BLOCKS — silent inversion kabhi nahi', async () => {
    // v21.13 me fresh consensus ka flipped side silently khul jaata tha
    // (user ne LONG card dekha, trade SHORT khula — "long trade signal ka
    // short jaa raha hai" complaint). v21.23.2: direction conflict =
    // honest REJECT. Opposite-side entry 0, journal me flip documented.
    const out = await executeSignal({
      symbol: 'BTC', mode: 'paper', side: 'LONG',
      getFreshSignal: async () => ({ ...STRONG, side: 'SHORT' }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fresh consensus SHORT/i);
    expect(out.error).toMatch(/blocked \(no auto-flip\)/i);
    const j = loadJournal();
    expect(j.positions.length).toBe(0); // koi opposite-side trade NAHI khula
    const rej = j.entries.find(e => e.status === 'REJECTED');
    expect(rej).toBeDefined();
    expect(rej!.flippedFrom).toBe('LONG');
    expect(rej!.flippedTo).toBe('SHORT');
  });

  it('v9.0.2: paper below the ACTION floor (WATCH grade, matching side) opens with a floor-relaxed note', async () => {
    const out = await executeSignal({
      symbol: 'BTC', mode: 'paper', side: 'LONG',
      getFreshSignal: async () => ({ ...STRONG, grade: 'WATCH', confidence: 48 }),
    });
    expect(out.ok).toBe(true);
    expect(out.fitted).toMatch(/practice floor relaxed/i);
  });

  it('LIVE never synthesizes — FLAT consensus is a hard reject', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() }); // armed (mode gate)
    const out = await executeSignal({
      symbol: 'BTC', mode: 'live', side: 'LONG',
      getFreshSignal: async () => ({ ...STRONG, side: 'FLAT', grade: 'NEUTRAL', confidence: 20, plan: null, dir: 0 }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no tradeable side\/plan/i);
  });

  it('LIVE on a side-flip still rejects (strict gauntlet untouched)', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({
      symbol: 'BTC', mode: 'live', side: 'LONG',
      getFreshSignal: async () => ({ ...STRONG, side: 'SHORT' }),
    });
    expect(out.ok).toBe(false);
    // v21.23.2: ab early direction-conflict reject (message naya) — LIVE ka
    // no-auto-flip invariant pehle se tha, ab paper/notify me bhi hai.
    expect(out.error).toMatch(/fresh consensus SHORT/i);
    expect(out.error).toMatch(/blocked \(no auto-flip\)/i);
  });
});

// ============================================================
// v6.4 — RISK AUTO-FIT through the full gauntlet
// (the user bug: strong-signal PAPER click bounced with
//  "Signal gate: plan risk 5.04% > 5% max")
// ============================================================
describe('v6.4 risk auto-fit — a 5.04% ATR stop no longer dead-ends', () => {
  const WIDE = {
    ...STRONG,
    ltp: 100,
    plan: {
      entry: 100, stopLoss: 94.96, target1: 105.04, target2: 110.08,
      risk: 5.04, riskPct: 5.04, rewardRisk: 2, atrUsed: 3.15, planStyle: 'atr-based',
    },
  };

  it('PAPER: 5.04% plan → FILLED with the SL auto-fitted to the 5% cap + fitted note', async () => {
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: async () => ({ ...WIDE }) });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('paper');
    expect(out.fitted).toMatch(/auto-fitted 5\.04% → 5%/);
    expect(out.position!.sl).toBeCloseTo(95, 1);      // 100 × 5%
    expect(out.position!.tp).toBeCloseTo(105, 1);      // 1R of fitted risk
    expect(out.position!.tp2).toBeCloseTo(110, 1);     // 2R of fitted risk
    const e = loadJournal().entries.at(-1)!;
    expect(e.status).toBe('FILLED');
    expect(e.reason).toMatch(/auto-fitted/);
  });

  it('LIVE: mild overshoot (5.04% vs 5) also fits — SL clamped, order placed', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() });
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', getFreshSignal: async () => ({ ...WIDE }) });
    expect(out.ok).toBe(true);
    expect(out.fitted).toMatch(/auto-fitted/);
    expect(out.position!.sl).toBeCloseTo(95, 1);
    expect(out.orderId).toBe('order-123');
  });

  it('LIVE: a wildly-wide 10% stop still REJECTS honestly (with the settings hint)', async () => {
    __setConfigForTests({ mode: 'live', liveConfirmedAt: Date.now() });
    const WILD = {
      ...STRONG, ltp: 100,
      plan: {
        entry: 100, stopLoss: 90, target1: 110, target2: 120,
        risk: 10, riskPct: 10, rewardRisk: 2, atrUsed: 6.25, planStyle: 'atr-based',
      },
    };
    const out = await executeSignal({ symbol: 'BTC', mode: 'live', getFreshSignal: async () => ({ ...WILD }) });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/plan risk 10% > 5% max/);
    expect(out.error).toMatch(/Max stop %/);
  });

  it('PAPER: even the wildly-wide 10% stop fits (practice never dead-ends)', async () => {
    const WILD = {
      ...STRONG, ltp: 100,
      plan: {
        entry: 100, stopLoss: 90, target1: 110, target2: 120,
        risk: 10, riskPct: 10, rewardRisk: 2, atrUsed: 6.25, planStyle: 'atr-based',
      },
    };
    const out = await executeSignal({ symbol: 'BTC', mode: 'paper', getFreshSignal: async () => ({ ...WILD }) });
    expect(out.ok).toBe(true);
    expect(out.position!.sl).toBeCloseTo(95, 1);
  });
});
