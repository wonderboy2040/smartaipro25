// ============================================================
// test/v213Issues.test.ts — v21.3.0 USER-ISSUE REGRESSION LOCKS
// ------------------------------------------------------------
// Covers the seven user-reported issues end-to-end at unit level:
//   Issue-1  server stability — constrained-platform selfHeal profile,
//            Express-4 async-route guard
//   Issue-3  Signal Board accuracy — sub-noise stop floor, superIntel
//            hard cap, TOP-5 conflict exclusion, futures board
//            accountability routing (USDT quotes, UTC day keys)
//   Issue-4  1-click live execute — precheck gates + would-be ticket,
//            instrument-precision qty rounding
//   Issue-5  Laya + Jev board AI confirmation layer
//   Issue-6  Equity USDC — 24/7 candlestick price path + US market
//            phase calculator
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// hermetic data dir (same trick as the other suites)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v213');

// ---- Issue-4/6 shared: CoinDCX exchange legs are mocked OFF ----
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false,
  coindcxPrivate: vi.fn(),
  coindcxPrivateGET: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
}));

import {
  isConstrainedPlatform, initSelfHeal, selfHealthSnapshot, __resetSelfHealForTests,
} from '../server/ai/selfHeal.js';
import { withAsyncRouteGuard, __testWrap } from '../server/lib/asyncGuard.js';
import { buildTradePlan } from '../server/ai/ensemble.js';
import { computeSuperScore } from '../server/ai/superIntel.js';
import { computeTopFive, stalenessFactor } from '../server/ai/signals.js';
import {
  confirmBoardSignals, boardAiConfirmActive, __resetBoardAiConfirmForTests, __setProvidersForTests,
} from '../server/ai/boardAiConfirm.js';
import { dayKeyFor } from '../server/intraday/time.js';
import {
  recordSignals, watcherSymbolsByMarket, getTrackRecord, __reloadTrackRecordForBoot, flushTrackRecordState,
} from '../server/intraday/trackRecord.js';
import { roundFuturesQty, futuresExecutePrecheck } from '../server/ai/futures.js';
import {
  usMarketPhase, fetchGlobalUsdcCandleQuotes, fetchGlobalQuotes, __resetGlobalForTests,
} from '../server/ai/globalFutures.js';

// ---------------- fixtures ----------------
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };

function strongBoardSignal(over = {}) {
  return {
    symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG',
    confidence: 80, agreement: 0.75, ltp: 50000, changePct: 2.1,
    plan: { entry: 50000, stopLoss: 48000, target1: 52000, target2: 54000, risk: 2000, riskPct: 4, rewardRisk: 2 },
    quality: { regime: { counterTrend: false }, mtf: { available: true, aligned: true, phase: 'TREND-ALIGNED', agreementPct: 78 } },
    superIntel: { aiScore: 84, tier: 'STRONG' },
    votes: Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, name: `M${i}`, dir: 1, conf: 70, weight: 1, reasons: ['r'] })),
    summary: 'consensus LONG',
    ...over,
  };
}

// ============================================================
// Issue-1: server stability
// ============================================================
describe('v21.3.0 Issue-1 — constrained-platform selfHeal profile', () => {
  beforeEach(() => { __resetSelfHealForTests(); });
  afterEach(() => { __resetSelfHealForTests(); });

  it('detects PaaS markers (RENDER/DYNO/RAILWAY/KOYEB/FLY) as constrained', () => {
    expect(isConstrainedPlatform({ RENDER: 'true' })).toBe(true);
    expect(isConstrainedPlatform({ DYNO: 'web.1' })).toBe(true);
    expect(isConstrainedPlatform({ RAILWAY_SERVICE_ID: 'x' })).toBe(true);
    expect(isConstrainedPlatform({ KOYEB: '1' })).toBe(true);
    expect(isConstrainedPlatform({ FLY_APP_NAME: 'x' })).toBe(true);
  });

  it('detects a small cgroup memory ceiling (<1.5GB) as constrained; big/unlimited is not', () => {
    expect(isConstrainedPlatform({}, 512 * 1024 * 1024)).toBe(true);
    expect(isConstrainedPlatform({}, 1.2 * 1024 * 1024 * 1024)).toBe(true);
    expect(isConstrainedPlatform({}, 8 * 1024 * 1024 * 1024)).toBe(false);
    expect(isConstrainedPlatform({}, null)).toBe(false); // unreachable probe on a dev box
    expect(isConstrainedPlatform({ SMARTAI_NO_CGROUP_PROBE: '1' }, 512 * 1024 * 1024)).toBe(false); // probe opt-out
  });

  it('initSelfHeal applies the 420/330MB profile + exit-on-fatal ON on a constrained platform', () => {
    const events = [];
    initSelfHeal({
      env: { RENDER: 'true', SELFHEAL_ENABLED: 'true' },
      emitter: { on: (ev) => events.push(ev) },
      nowFn: () => Date.now(),
    });
    const snap = selfHealthSnapshot();
    expect(snap.platformConstrained).toBe(true);
    expect(snap.exitOnFatal).toBe(true);
    expect(snap.memory.limitsMB.rss).toBe(420);
    expect(snap.memory.limitsMB.heap).toBe(330);
    expect(events).toContain('uncaughtException');
  });

  it('explicit env limits always win over the platform profile', () => {
    initSelfHeal({
      env: { RENDER: 'true', SELFHEAL_RSS_LIMIT_MB: '900', SELFHEAL_HEAP_LIMIT_MB: '700', SELFHEAL_EXIT_ON_FATAL: 'false' },
      emitter: { on: () => {} },
    });
    const snap = selfHealthSnapshot();
    expect(snap.memory.limitsMB.rss).toBe(900);
    expect(snap.memory.limitsMB.heap).toBe(700);
    expect(snap.exitOnFatal).toBe(false);
  });

  it('a clean dev environment keeps the 1400/1100 laptop profile + stay-alive', () => {
    initSelfHeal({
      env: { SMARTAI_NO_CGROUP_PROBE: '1' },
      emitter: { on: () => {} },
    });
    const snap = selfHealthSnapshot();
    expect(snap.platformConstrained).toBe(false);
    expect(snap.exitOnFatal).toBe(false);
    expect(snap.memory.limitsMB.rss).toBe(1400);
  });
});

describe('v21.3.0 Issue-1 — Express-4 async-route guard (lib/asyncGuard.js)', () => {
  it('an async handler rejection is forwarded to next(err) — no more hung sockets', async () => {
    const wrapped = __testWrap(async () => { throw new Error('boom'); }, null);
    const caught = [];
    wrapped({}, {}, (e) => caught.push(e));
    await new Promise((r) => setTimeout(r, 20));
    expect(caught.length).toBe(1);
    expect(caught[0].message).toBe('boom');
  });

  it('sync handlers and 4-arg error middleware pass through UNTOUCHED', () => {
    const sync = __testWrap(() => 42, null);
    expect(sync()).toBe(42);
    const err4 = __testWrap(async (a, b, c, d) => { throw new Error('x'); }, null);
    expect(err4.constructor.name).toBe('AsyncFunction'); // not wrapped
  });

  it('the proxy wraps route registrations and delegates everything else', () => {
    const registered = [];
    const fakeApp = {
      get: (...a) => { registered.push(['get', ...a]); return fakeApp; },
      listen: () => 'server',
      set: (k, v) => ({ k, v }),
    };
    const guarded = withAsyncRouteGuard(fakeApp);
    const asyncHandler = async () => {};
    const syncHandler = () => {};
    guarded.get('/x', asyncHandler, syncHandler);
    expect(registered.length).toBe(1);
    // registered entry = ['get', '/x', wrappedAsync, syncHandler]
    const wrapped = registered[0][2];
    expect(wrapped).not.toBe(asyncHandler);            // wrapped (new fn)
    expect(wrapped.constructor.name).toBe('Function');  // the .catch(next) shim is a NORMAL function
    expect(registered[0][3]).toBe(syncHandler);        // sync untouched
    expect(guarded.listen()).toBe('server');            // other methods delegate
  });
});

// ============================================================
// Issue-3: Signal Board accuracy
// ============================================================
describe('v21.3.0 Issue-3 — sub-noise stop floor (buildTradePlan)', () => {
  const cons = (dir = 1) => ({ side: dir > 0 ? 'LONG' : 'SHORT', dir, confidence: 70, agreement: 0.7 });
  const ctx = { ltp: 100, ind: { atr: 5 } };

  it('a swing-structure stop tighter than 0.6×ATR is FLOORED to 0.6×ATR (stopFloored flag)', () => {
    // ATR baseline stop = 100 - 1.6×5 = 92; structure at 99.5 (0.1×ATR away) would be sub-noise
    const p = buildTradePlan(cons(1), ctx, 'FUTURES', { structureStop: { sl: 99.5, style: 'swing' } });
    expect(p).toBeTruthy();
    expect(Math.abs(p.stopLoss - (100 - 0.6 * 5))).toBeLessThan(0.001); // 97
    expect(p.stopFloored).toBe(true);
    expect(p.structure.floored).toBe(true);
  });

  it('a sane structure stop (≥ 0.6×ATR away) applies unchanged', () => {
    const p = buildTradePlan(cons(1), ctx, 'FUTURES', { structureStop: { sl: 97.0, style: 'swing' } }); // exactly 3.0 = 0.6×ATR away
    expect(Math.abs(p.stopLoss - 97.0)).toBeLessThan(0.001);
    expect(p.stopFloored).toBeUndefined();
  });

  it('SHORT side floors symmetrically', () => {
    const p = buildTradePlan(cons(-1), ctx, 'FUTURES', { structureStop: { sl: 100.4, style: 'swing' } });
    expect(Math.abs(p.stopLoss - (100 + 0.6 * 5))).toBeLessThan(0.001); // 103
    expect(p.stopFloored).toBe(true);
  });

  it('no structure stop → the 1.6×ATR baseline is untouched by the floor', () => {
    const p = buildTradePlan(cons(1), ctx, 'FUTURES', {});
    expect(Math.abs(p.stopLoss - 92)).toBeLessThan(0.001);
  });
});

describe('v21.3.0 Issue-3 — superIntel hard cap (computeSuperScore cap param)', () => {
  it('a cap of 62 bounds even a 95-blend score (HTF-veto / chop class)', () => {
    const out = computeSuperScore({ engineConf: 95, expertScore: 92, quality: null, agreement: 0.9, cap: 62 });
    expect(out.aiScore).toBeLessThanOrEqual(62);
    expect(out.tier).toBe('WATCH'); // below the 65 ACTION bar — the 80+ badge is impossible
  });

  it('no cap → the honest blend stands', () => {
    const out = computeSuperScore({ engineConf: 90, expertScore: 85, quality: null, agreement: 0.8 });
    expect(out.aiScore).toBeGreaterThan(62);
  });
});

describe('v21.3.0 Issue-3 — FUTURES board accountability routing (trackRecord + time)', () => {
  beforeEach(() => { __reloadTrackRecordForBoot(); });
  afterEach(() => { flushTrackRecordState(); });

  it('dayKeyFor FUTURES/GLOBALFUTURES uses the UTC day (24/7 perp session), INDIA stays IST', () => {
    const d = new Date('2026-10-12T02:30:00Z'); // 08:00 IST Monday, still Sunday in UTC-lands
    expect(dayKeyFor('FUTURES', d)).toBe(dayKeyFor('CRYPTO', d));
    expect(dayKeyFor('GLOBALFUTURES', d)).toBe(dayKeyFor('CRYPTO', d));
    expect(dayKeyFor('FUTURES', d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a recorded FUTURES board row routes to the futures watch set (USDT quotes), NOT the INR crypto set', () => {
    recordSignals([strongBoardSignal()]);
    const sets = watcherSymbolsByMarket();
    expect(sets.futures).toContain('BTC');
    expect(sets.crypto).not.toContain('BTC');
    expect(sets.india).not.toContain('BTC');
  });

  it('a recorded GLOBALFUTURES board row routes to the global (USDC) watch set', () => {
    recordSignals([strongBoardSignal({ symbol: 'AAPL', market: 'GLOBALFUTURES' })]);
    expect(watcherSymbolsByMarket().global).toContain('AAPL');
  });

  it('getTrackRecord surfaces the futures row with the market stamp', () => {
    const rec = getTrackRecord(1);
    const row = rec.open.find((r) => r.symbol === 'BTC');
    expect(row).toBeTruthy();
    expect(row.market).toBe('FUTURES');
  });
});

// ============================================================
// Issue-5: Laya + Jev board AI confirmation
// ============================================================
describe('v21.3.0 Issue-5 — boardAiConfirm (Jev + Laya on the Signal Board)', () => {
  beforeEach(() => { __resetBoardAiConfirmForTests(); });
  afterEach(() => { __resetBoardAiConfirmForTests(); });

  const agreeP = async (snap) => ({ action: snap.proposed, note: null, probs: {}, confidence: 70 });
  const disagreeP = async () => ({ action: 'wait', note: 'disagreed_side', probs: {}, confidence: 60 });
  const neutralP = async () => ({ action: 'wait', note: 'below_threshold(0.20)', probs: {}, confidence: 40 });

  it('both providers AGREE → CONFIRMED + aiScore +3', async () => {
    __setProvidersForTests({ jev: agreeP });
    const s = strongBoardSignal();
    const meta = await confirmBoardSignals([s], 'FUTURES');
    expect(meta.stamped).toBe(1);
    expect(meta.confirmed).toBe(1);
    expect(s.aiConfirm.verdict).toBe('CONFIRMED');
    expect(s.aiConfirm.jev).toBe('AGREE');
    expect(s.superIntel.aiScore).toBe(87); // 84 + 3
    expect(boardAiConfirmActive()).toBe(true);
  });

  it('any provider DISAGREES (opposite side) → CONFLICT + −8 + STRONG→ACTION demote', async () => {
    __setProvidersForTests({ jev: disagreeP });
    const s = strongBoardSignal();
    await confirmBoardSignals([s], 'FUTURES');
    expect(s.aiConfirm.verdict).toBe('CONFLICT');
    expect(s.aiConfirm.jev).toBe('DISAGREE');
    expect(s.superIntel.aiScore).toBe(76); // 84 − 8
    expect(s.grade).toBe('ACTION');
    expect(s.aiConflict).toBe(true);
  });

  it('one AGREE + one abstain → NEUTRAL, score untouched', async () => {
    __setProvidersForTests({ jev: neutralP });
    const s = strongBoardSignal();
    await confirmBoardSignals([s], 'FUTURES');
    expect(s.aiConfirm.verdict).toBe('NEUTRAL');
    expect(s.superIntel.aiScore).toBe(84);
    expect(s.grade).toBe('STRONG');
  });

  it('no providers configured → honest no-op (sandbox / no keys)', async () => {
    __setProvidersForTests({ jev: null });
    const s = strongBoardSignal();
    const meta = await confirmBoardSignals([s], 'FUTURES');
    expect(meta).toBeNull();
    expect(s.aiConfirm).toBeUndefined();
    expect(boardAiConfirmActive()).toBe(false);
  });

  it('low-score signals are skipped (only ≥75 go to the providers)', async () => {
    __setProvidersForTests({ jev: agreeP, laya: agreeP });
    const low = strongBoardSignal({ symbol: 'DOGE', superIntel: { aiScore: 60, tier: 'ACTION' } });
    const meta = await confirmBoardSignals([low], 'FUTURES');
    expect(meta.stamped).toBe(0);
    expect(low.aiConfirm).toBeUndefined();
  });

  it('the memo dedupes repeat calls (one provider round per symbol per 5 min)', async () => {
    let calls = 0;
    const counting = async (snap) => { calls++; return { action: snap.proposed }; };
    __setProvidersForTests({ jev: counting });
    const s = strongBoardSignal();
    await confirmBoardSignals([s], 'FUTURES');
    await confirmBoardSignals([{ ...s, aiConfirm: undefined }], 'FUTURES');
    expect(calls).toBe(1); // memo hit, not a second provider round
  });
});

describe('v21.3.0 Issue-5 — TOP-5 excludes AI-CONFLICT signals', () => {
  it('computeTopFive filters CONFLICT picks and the KYUN reason carries the confirm stamp', () => {
    const good = strongBoardSignal({ symbol: 'ETH', superIntel: { aiScore: 82 }, aiConfirm: { jev: 'AGREE', verdict: 'CONFIRMED' } });
    const bad = strongBoardSignal({ symbol: 'SOL', superIntel: { aiScore: 86 }, aiConfirm: { jev: 'DISAGREE', verdict: 'CONFLICT' } });
    const picks = computeTopFive([good, bad], { btcChange: 1.2, btcTrend: 'UP' }, 'FUTURES', 5);
    expect(picks.map((p) => p.symbol)).toContain('ETH');
    expect(picks.map((p) => p.symbol)).not.toContain('SOL');
    expect(picks.find((p) => p.symbol === 'ETH')!.rankReason).toContain('AI CONFIRMED');
  });
});

// ============================================================
// Issue-4: one-click live execute pre-flight
// ============================================================
describe('v21.3.0 Issue-4 — futuresExecutePrecheck (dry-run gauntlet + ticket)', () => {
  it('returns the gate list + would-be ticket WITHOUT placing an order', async () => {
    const out = await futuresExecutePrecheck({
      symbol: 'BTC', side: 'LONG',
      getFreshSignal: async () => strongBoardSignal({ ltp: 50000, plan: { entry: 50000, stopLoss: 48000, target1: 52000, target2: 54000, riskPct: 4, rewardRisk: 2 } }),
    });
    const names = out.gates.map((g) => g.name);
    expect(names).toContain('Kill switch');
    expect(names).toContain('GO-LIVE gate (paper track-record)');
    expect(names).toContain('LIVE arming');
    expect(names).toContain('CoinDCX connection');
    expect(names).toContain('Fresh signal');
    expect(names).toContain('Side match');
    // in the test env LIVE arming + connection honestly FAIL — but the
    // ticket still computes (read-only preview is the point)
    const failing = out.gates.filter((g) => !g.pass).map((g) => g.name);
    expect(failing).toContain('LIVE arming');
    expect(failing).toContain('CoinDCX connection');
    expect(out.ok).toBe(false);
    expect(out.ticket).toBeTruthy();
    expect(out.ticket.pair).toBe('B-BTC_USDT');
    expect(out.ticket.price).toBe(50000);
    expect(out.ticket.stopLoss).toBe(48000);
    expect(out.ticket.nativeProtection).toEqual({ stopLoss: 48000, takeProfit: 54000 });
    expect(out.ticket.qty).toBeGreaterThan(0);
    expect(out.ticket.leverage).toBeGreaterThanOrEqual(1);
  });

  it('a side-flipped fresh signal flags the Side-match gate', async () => {
    const out = await futuresExecutePrecheck({
      symbol: 'BTC', side: 'LONG',
      getFreshSignal: async () => strongBoardSignal({ side: 'SHORT' }),
    });
    const gate = out.gates.find((g) => g.name === 'Side match');
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain('flipped');
  });

  it('an AI-CONFLICT signal surfaces the warning (visible before any click)', async () => {
    const out = await futuresExecutePrecheck({
      symbol: 'BTC', side: 'LONG',
      getFreshSignal: async () => strongBoardSignal({ aiConfirm: { jev: 'DISAGREE', verdict: 'CONFLICT' } }),
    });
    expect(out.warnings.join(' ')).toContain('AI CONFLICT');
  });
});

describe('v21.3.0 Issue-4 — roundFuturesQty honours instrument qtyPrecision', () => {
  it('explicit precision beats the guess table', () => {
    expect(roundFuturesQty('B-PEPE_USDT', 1234.56789, 2)).toBe(1234.56);
    expect(roundFuturesQty('B-PEPE_USDT', 1234.56789, 0)).toBe(1234);
    expect(roundFuturesQty('B-PEPE_USDT', 1234.56789, null)).toBe(1234.567); // guess table default (3)
  });
  it('absurd precision falls back to the guess table', () => {
    expect(roundFuturesQty('B-BTC_USDT', 1.23456, 99)).toBeCloseTo(1.2345, 4); // BTC guess = 4
  });
});

// ============================================================
// Issue-6: Equity sim USDC — 24/7 price + market phase
// ============================================================
describe('v21.3.0 Issue-6 — usMarketPhase (US spot session calculator)', () => {
  it('weekday phases: closed → pre → open → post → closed', () => {
    // 2026-10-12 is a Monday
    expect(usMarketPhase(new Date('2026-10-12T06:00:00Z')).phase).toBe('CLOSED'); // 02:00 ET
    expect(usMarketPhase(new Date('2026-10-12T12:00:00Z')).phase).toBe('PRE');     // 08:00 ET
    expect(usMarketPhase(new Date('2026-10-12T14:00:00Z')).phase).toBe('OPEN');    // 10:00 ET
    expect(usMarketPhase(new Date('2026-10-12T14:00:00Z')).nextChange).toMatch(/close \d+m/);
    expect(usMarketPhase(new Date('2026-10-12T21:00:00Z')).phase).toBe('POST');    // 17:00 ET
    expect(usMarketPhase(new Date('2026-10-13T00:30:00Z')).phase).toBe('CLOSED');  // Monday 20:30 ET — post closed
  });
  it('weekend is CLOSED (Sunday 18:00 ET onwards = Monday pre-market)', () => {
    expect(usMarketPhase(new Date('2026-10-10T12:00:00Z')).phase).toBe('CLOSED'); // Saturday
    expect(usMarketPhase(new Date('2026-10-11T12:00:00Z')).phase).toBe('CLOSED'); // Sunday morning ET
    expect(usMarketPhase(new Date('2026-10-11T23:00:00Z')).phase).toBe('PRE');    // Sunday 19:00 ET → Monday pre
  });
});

describe('v21.3.0 Issue-6 — USDC candlestick 24/7 price path', () => {
  let fetchCalls;
  const realFetch = globalThis.fetch;

  const candlePayload = (last, prev) => ({
    s: 'ok',
    data: [
      { time: Math.floor(Date.now() / 1000) - 120, open: prev, high: prev + 1, low: prev - 1, close: prev, volume: 100 },
      { time: Math.floor(Date.now() / 1000) - 60, open: prev, high: last + 1, low: prev - 1, close: last, volume: 100 },
    ],
  });

  beforeEach(() => {
    __resetGlobalForTests();
    fetchCalls = [];
    vi.stubGlobal('fetch', async (url) => {
      fetchCalls.push(String(url));
      const u = String(url);
      if (u.includes('current_prices/futures/rt')) return new Response('forbidden', { status: 403 });
      if (u.includes('candlesticks') && u.includes('_usdc')) {
        return new Response(JSON.stringify(candlePayload(96400, 96000)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('no', { status: 404 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetGlobalForTests();
  });

  it('parses the last 1m candle close as the perp LTP (documented endpoint family)', async () => {
    const m = await fetchGlobalUsdcCandleQuotes({ bases: ['AAPL'] });
    expect(m.get('AAPL')).toBeTruthy();
    expect(m.get('AAPL').price).toBe(96400);
    expect(fetchCalls.some((u) => u.includes('b-aapl_usdc'))).toBe(true);
  });

  it('the full quote chain falls RT(403) → USDC-candles (24/7 perp price, NOT frozen Yahoo)', async () => {
    const q = await fetchGlobalQuotes({ maxAgeMs: 0 });
    const row = q.get('AAPL');
    expect(row).toBeTruthy();
    expect(row.source).toBe('coindcx-usdc-candles');
    expect(row.price).toBe(96400);
  });

  it('a hard-fail candle round arms the 60s negative cache (no hammering)', async () => {
    vi.stubGlobal('fetch', async (url) => {
      fetchCalls.push(String(url));
      if (u_isRt(url)) return new Response('f', { status: 403 });
      return new Response('f', { status: 403 }); // candlesticks ALSO blocked (WAF)
    });
    await fetchGlobalUsdcCandleQuotes({ bases: ['AAPL'] }).catch(() => null);
    const n1 = fetchCalls.length;
    await fetchGlobalUsdcCandleQuotes({ bases: ['AAPL'] }).catch(() => null);
    expect(fetchCalls.length).toBe(n1); // negative cache — zero new calls
  });
});

function u_isRt(u) { return String(u).includes('current_prices'); }
void num;
void strongBoardSignal;
