// ============================================================
// test/v2010LiveGuard.test.ts — v20.7.10 LIVE-MONEY EXECUTION GUARDS
// ------------------------------------------------------------
// Locks (behavioral + source-contract):
//   A. positionManager: fill-POLL loop (single-read bug), fill-timeout
//      honest cancel + manual-verify note, failed close/reduce/protect
//      RETRY (state preserve — pehle abandoned/phantom journal)
//   B. PaperPort: 6-decimal qty rounding (r2 micro-strand bug)
//   C. proTraderAuto: FUT_ tick domain (~84x bogus SL-close bug),
//      futures deep-stale honest flag, PLACED TTL slot-free,
//      AMBIGUOUS entry journaling + cooldown, t.mode close gating
//      (paper-restart live-abandon bug), CLOSE_FAILED re-entry block
//   D. signals.js: canonical-40 board cache + per-caller truncate
//      (source contract)
//   E. browserAgent: side-aware close script (jsdom) — hedge rows,
//      unknown-side multi-row REFUSE safety
//   F. Feed reliability: Binance spot/fut silence watchdogs, flat-price
//      heartbeat, 120s live-cap (source contracts)
// ============================================================
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- PTA harness: mocks hoisted (self-contained factories) ----
vi.mock('../server/ai/signals.js', () => ({
  getSignals: vi.fn(async (market: string) => ({ ok: true, market, signals: [] })),
}));
vi.mock('../server/ai/browserAgent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/ai/browserAgent.js')>();
  return {
    ...actual, // script builders (cxPlaceOrderScript…) + test hooks REAL
    browserConnect: vi.fn(async () => ({ connected: false, tabs: {} })),
    browserStatus: vi.fn(() => ({ connected: false, tabs: {}, lastError: null })),
    cxPairUrl: vi.fn((pair: string, product: string = 'futures') =>
      product === 'spot' ? `https://coindcx.com/trade/${pair}` : `https://coindcx.com/futures/${pair}`),
    cxEnsureTradePage: vi.fn(async () => ({})),
    cxSelectPair: vi.fn(async () => ({ ok: true })),
    cxPlaceOrder: vi.fn(async () => ({ ok: true, steps: ['qty-set'] })),
    cxClosePosition: vi.fn(async () => ({ ok: true })),
    cxReadPositions: vi.fn(async () => ({ ok: true, positions: [] })),
    dhanEnsurePage: vi.fn(async () => ({})),
    dhanSelectScrip: vi.fn(async () => ({ ok: true })),
    dhanPlaceOrder: vi.fn(async () => ({ ok: true })),
    dhanClosePosition: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => []),
}));

import { PositionManager } from '../server/exec/positionManager.js';
import { PaperPort } from '../server/exec/port.js';
import { __orderFormScriptsForTests } from '../server/ai/browserAgent.js';

const S = __orderFormScriptsForTests();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const src = (p: string) => readFileSync(path.join(APP, p), 'utf8');

// ---- jsdom vis() mock (browserOrderForm pattern) ----
beforeAll(() => {
  (window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    if (el.hasAttribute('hidden') || el.closest('[hidden]')) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return { width: 120, height: 28, top: 0, left: 0, right: 120, bottom: 28, x: 0, y: 28, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(() => { document.body.innerHTML = ''; });

// ---- shared helpers ----
function _signal(over: Record<string, unknown> = {}) {
  return {
    pair: 'B-BTC_USDT', symbol: 'BTC', side: 'LONG', ltp: 100,
    superIntel: { tier: 'STRONG', aiScore: 85 }, grade: 'STRONG',
    __riskPct: 1,
    ...over,
  };
}
function _plan(over: Record<string, unknown> = {}) {
  return { entry: 100, stopLoss: 98.5, target1: 101.5, target2: 103, ...over };
}

// ============================================================
// A. positionManager — fill-poll + failed-action retry ladder
// ============================================================
class SlowFillPort extends PaperPort {
  polls = 0;
  emptyFirst = 2;
  async getPositions() { this.polls++; if (this.polls <= this.emptyFirst) return []; return super.getPositions(); }
}
class NeverFillPort extends PaperPort {
  cancelCalls = 0;
  async getPositions() { return []; }
  async cancelOpenOrders() { this.cancelCalls++; return { ok: true }; }
}

describe('v20.7.10 PositionManager — fill-POLL + retry ladder', () => {
  it('fill-POLL: 2 khaali reads ke baad fill dikhta hai → entry OK (pehle SINGLE re-read thi — resting limit hamesha fail + cancel hota tha)', async () => {
    const port = new SlowFillPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port, cfg: { entryLimitTtlSec: 30, fillPollMs: 2 } });
    const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    expect(r.ok).toBe(true);
    expect(r.positionId).toBeTruthy();
    expect(port.polls).toBeGreaterThanOrEqual(3); // polled until fill — not one shot
  });

  it('fill-TIMEOUT: TTL nikal gaya → honest fail + cancel attempted + manual-verify note (10s TTL floor pe fast clock-jump)', async () => {
    const port = new NeverFillPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port, cfg: { entryLimitTtlSec: 1, fillPollMs: 0 } });
    // clock-jump: pehli 4 Date.now calls real, uske baad +60s (deadline ke past)
    const realNow = Date.now.bind(Date);
    let calls = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => { calls++; return calls <= 4 ? realNow() : realNow() + 60_000; });
    try {
      const r = await pm.protectionFirstEntry({ signal: _signal(), plan: _plan(), now: realNow() });
      expect(r.ok).toBe(false);
      expect(r.stage).toBe('fill-confirm');
      expect(String(r.error)).toMatch(/manually verify|fill nahi hua/i);
      expect(port.cancelCalls).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('time-stop close FAIL → state RETAINED + alert (pehle failed close = position abandoned), next candle retry pe close', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    let alerts = 0;
    const pm = new PositionManager({ port, cfg: { timeStopCandles: 1 }, alertSink: () => { alerts++; } });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const origClose = port.close.bind(port);
    let failedOnce = false;
    port.close = async (...a: unknown[]) => {
      if (!failedOnce) { failedOnce = true; return { ok: false, error: 'simulated close fail' }; }
      return origClose(...(a as []));
    };
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 100 } }); // candlesSeen 1 — abhi nahi
    const a2 = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 100 } }); // 2 > 1 → time-stop → FAIL
    expect(a2.find((x) => x.kind === 'time-stop:failed')).toBeTruthy();
    expect(pm._stateForTests().length).toBe(1); // RETAINED — abandoned nahi
    expect(alerts).toBeGreaterThanOrEqual(1);
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 100 } }); // retry → close ok
    expect(pm._stateForTests().length).toBe(0);
  });

  it('T1 reduce FAIL → phantom advance NAHI (stage ENTRY, koi jhootha t1 action nahi), retry pe T1 hota hai', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port, alertSink: () => {} });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    const origReduce = port.reduce.bind(port);
    let failedOnce = false;
    port.reduce = async (...a: unknown[]) => {
      if (!failedOnce) { failedOnce = true; return { ok: false, error: 'simulated reduce fail' }; }
      return origReduce(...(a as []));
    };
    const a1 = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101.5 } }); // T1 hit — reduce FAIL
    expect(a1.find((x) => x.kind === 't1:reduce-failed')).toBeTruthy();
    expect(a1.find((x) => x.kind === 't1')).toBeUndefined();
    expect(pm._stateForTests()[0].stage).toBe('ENTRY');
    const a2 = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101.6 } }); // retry → T1 ok
    expect(a2.find((x) => x.kind === 't1')).toBeTruthy();
    expect(pm._stateForTests()[0].stage).toBe('T1_HIT');
  });

  it('SL-hit close FAIL → 🚨 alert + state retained; retry next tick pe close', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    let alerts = 0;
    const pm = new PositionManager({ port, alertSink: () => { alerts++; } });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    port.setMarkPrice('B-BTC_USDT', 98.0);
    const origClose = port.close.bind(port);
    let failedOnce = false;
    port.close = async (...a: unknown[]) => {
      if (!failedOnce) { failedOnce = true; return { ok: false, error: 'simulated close fail' }; }
      return origClose(...(a as []));
    };
    const a1 = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 98.0 } });
    expect(a1.find((x) => x.kind === 'sl-hit:failed')).toBeTruthy();
    expect(pm._stateForTests().length).toBe(1);
    expect(alerts).toBeGreaterThanOrEqual(1);
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 98.0 } });
    expect(pm._stateForTests().length).toBe(0);
  });

  it('T2 SL→T1 move FAIL → stage RUNNER advance (original SL backstop) + protect-failed action journal', async () => {
    const port = new PaperPort({ startingEquityUSDT: 1000 });
    const pm = new PositionManager({ port, alertSink: () => {} });
    await pm.protectionFirstEntry({ signal: _signal(), plan: _plan() });
    await pm.tick({ pricesByPair: { 'B-BTC_USDT': 101.5 } }); // T1 ok
    port.setProtection = async () => ({ ok: false, error: 'simulated protect fail' });
    const a2 = await pm.tick({ pricesByPair: { 'B-BTC_USDT': 103.0 } }); // T2 — protect FAIL
    expect(a2.find((x) => x.kind === 't2:protect-failed')).toBeTruthy();
    const st = pm._stateForTests()[0];
    expect(st.stage).toBe('RUNNER'); // advance — position purane SL pe protected
  });
});

// ============================================================
// B. PaperPort — micro-qty rounding
// ============================================================
describe('v20.7.10 PaperPort — 6-decimal qty (r2 strand bug)', () => {
  it('0.0045 − 0.0044 = 0.0001 bachta hai (pehle r2 → 0 → position delete + margin strand)', async () => {
    const port = new PaperPort({ startingEquityUSDT: 10_000 });
    const o = await port.open({ pair: 'B-DOT_USDT', side: 'LONG', qty: 0.0045, leverage: 5, type: 'market', price: 7, clientId: 'tiny1' });
    const r = await port.reduce({ positionId: o.orderId, qty: 0.0044 });
    expect(r.ok).toBe(true);
    const positions = await port.getPositions();
    expect(positions.length).toBe(1);
    expect(positions[0].qty).toBeCloseTo(0.0001, 6);
  });
  it('residual ≤ 1e-6 pe position delete — zombie strand nahi', async () => {
    const port = new PaperPort({ startingEquityUSDT: 10_000 });
    const o = await port.open({ pair: 'B-DOT_USDT', side: 'LONG', qty: 0.0000015, leverage: 5, type: 'market', price: 7, clientId: 'tiny2' });
    const r = await port.reduce({ positionId: o.orderId, qty: 0.0000015 });
    expect(r.ok).toBe(true);
    expect((await port.getPositions()).length).toBe(0);
  });
});

// ============================================================
// C. proTraderAuto — live-money guards (mocked harness)
// ============================================================
const {
  proTraderTick, proTraderStart, proTraderStop, proTraderStatusView,
} = await import('../server/ai/proTraderAuto.js');
const { getSignals } = await import('../server/ai/signals.js');
const ba = await import('../server/ai/browserAgent.js');
const { saveJSON, loadJSON } = await import('../server/lib/store.js');

const futSignal = {
  symbol: 'BTC', market: 'FUTURES', side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 101, executable: true,
  plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
  superIntel: { aiScore: 80, tier: 'STRONG' }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
};
const nullDeps = { getTick: () => null, fetchCoinDcxTickers: async () => [], fetchFuturesPrices: async () => [] };

beforeEach(() => {
  saveJSON('protrader-auto-journal.json', { trades: [] }); // shape: { trades: [...] } (plain array likha to j.trades undefined → entry throw)
  saveJSON('protrader-auto-config.json', { minAiScore: 75, minConfidence: 65, minVerifiedScore: 90, stakeINR: 500, maxConcurrent: 3, maxTradesPerDay: 6, cooldownMin: 30 });
  saveJSON('ai-trading-config.json', { killSwitch: false });
  proTraderStop();
  vi.mocked(getSignals).mockImplementation(async (market: string) => ({ ok: true, market, signals: [] }));
  vi.mocked(ba.browserStatus).mockImplementation(() => ({ connected: false, tabs: {}, lastError: null }) as never);
  vi.mocked(ba.cxEnsureTradePage).mockImplementation(async () => ({}) as never);
  vi.mocked(ba.cxSelectPair).mockImplementation(async () => ({ ok: true }) as never);
  vi.mocked(ba.cxPlaceOrder).mockImplementation(async () => ({ ok: true, steps: ['qty-set'] }) as never);
  vi.mocked(ba.cxClosePosition).mockImplementation(async () => ({ ok: true }) as never);
  vi.mocked(ba.cxReadPositions).mockImplementation(async () => ({ ok: true, positions: [] }) as never);
});

describe('v20.7.10 proTraderAuto — tick domain + slot lifecycle + close gating', () => {
  it('FUTURES trade ka LTP FUT_<base> (USDT domain) se — IN_<base> spot INR ~84x off tha (B-ETH_USDT SHORT ka bogus instant SL-close root cause)', async () => {
    vi.mocked(getSignals).mockImplementation(async (market: string) => ({ ok: true, market, signals: market === 'FUTURES' ? [futSignal] : [] }));
    proTraderStart({ mode: 'paper' });
    const keys: string[] = [];
    const deps = {
      getTick: (k: string) => { keys.push(k); return { price: 101, time: Date.now() }; },
      fetchCoinDcxTickers: async () => [], fetchFuturesPrices: async () => [],
    };
    const r = await proTraderTick(deps, null);
    expect(r.ok).toBe(true);
    const view = proTraderStatusView();
    expect(view.positions.length).toBe(1);
    expect(view.positions[0].symbol).toBe('BTC');
    expect(keys).toContain('FUT_BTC');
    expect(keys).not.toContain('IN_BTC'); // spot INR domain kabhi nahi
  });

  it('futures deep-stale row (>45s) ab honest stale:true — SL/reversal 3-min-purane price pe nahi chalega', async () => {
    vi.mocked(getSignals).mockImplementation(async (market: string) => ({ ok: true, market, signals: market === 'FUTURES' ? [futSignal] : [] }));
    proTraderStart({ mode: 'paper' });
    await proTraderTick(nullDeps, null); // entry (monitor: board ltp fallback)
    const staleDeps = {
      getTick: () => null, fetchCoinDcxTickers: async () => [],
      fetchFuturesPrices: async () => [{ base: 'BTC', last: 100, ts: Date.now() - 120_000 }],
    };
    await proTraderTick(staleDeps, null);
    const j = (loadJSON('protrader-auto-journal.json', { trades: [] }) as { trades: Array<Record<string, unknown>> }).trades;
    const row = j.find((t) => t.symbol === 'BTC');
    expect(row).toBeTruthy();
    expect(row.lastLtp).toBe(100);
    expect(row.ltpStale).toBe(true); // honest flag
  });

  it('PLACED TTL: 15+ min unfilled limit order slot FREE (pehle maxConcurrent permanently block = engine band)', async () => {
    saveJSON('protrader-auto-journal.json', { trades: [{
      id: 'PTA-TTL1', ts: Date.now() - 16 * 60_000, day: '2000-1-1', market: 'CRYPTO', symbol: 'BTC', pair: 'BTCINR', side: 'LONG',
      entryPrice: 100, sl: 95, tp: 112, stakeINR: 500, mode: 'paper', status: 'PLACED', lastLtp: 100,
      confirmStreak: 0, reversalReasons: [], browser: { actions: [], shots: [] },
    }] });
    proTraderStart({ mode: 'paper' });
    const r = await proTraderTick(nullDeps, null);
    expect(r.ok).toBe(true);
    const j = (loadJSON('protrader-auto-journal.json', { trades: [] }) as { trades: Array<Record<string, unknown>> }).trades;
    const row = j.find((t) => t.id === 'PTA-TTL1') as Record<string, { reason?: string }>;
    expect(row.status).toBe('UNFILLED');
    expect(String(row.closed?.reason)).toMatch(/PLACED TTL/);
    expect(proTraderStatusView().positions.length).toBe(0); // slot free
  });

  it('ENTRY AMBIGUOUS: CDP throw ke baad bhi order lag sakta hai — FAILED row + telegram warn + cooldown (pehle NO row → duplicate entry)', async () => {
    vi.mocked(getSignals).mockImplementation(async (market: string) => ({ ok: true, market, signals: market === 'FUTURES' ? [futSignal] : [] }));
    vi.mocked(ba.browserStatus).mockImplementation(() => ({ connected: true, tabs: { coindcx: { found: true } }, lastError: null }) as never);
    vi.mocked(ba.cxPlaceOrder).mockImplementation(async () => { throw new Error('place-order: wait timeout: price input'); });
    proTraderStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    const tg = vi.fn();
    const r = await proTraderTick(nullDeps, tg);
    expect(r.ok).toBe(true);
    const j = (loadJSON('protrader-auto-journal.json', { trades: [] }) as { trades: Array<Record<string, unknown>> }).trades;
    expect(j.length).toBe(1);
    expect(j[0].status).toBe('FAILED');
    expect(String(j[0].error)).toMatch(/AMBIGUOUS/);
    expect(tg).toHaveBeenCalled(); // telegram warn gaya
    // next tick: cooldown → koi DUPLICATE entry nahi
    await proTraderTick(nullDeps, null);
    const j2 = (loadJSON('protrader-auto-journal.json', { trades: [] }) as { trades: unknown[] }).trades;
    expect(j2.length).toBe(1);
    expect(proTraderStatusView().positions.length).toBe(0);
  });

  it('live-stamped trade engine PAPER restart ke baad bhi BROKER se close hota hai (pehle cfg.mode dekhte the — live position abandoned with green journal)', async () => {
    saveJSON('protrader-auto-journal.json', { trades: [{
      id: 'PTA-LIVE1', ts: Date.now() - 5 * 60_000, day: '2000-1-1', market: 'CRYPTO', symbol: 'BTC', pair: 'BTCINR', side: 'LONG',
      entryPrice: 100, sl: 95, tp: 112, stakeINR: 500, mode: 'live', status: 'MONITORING', lastLtp: 100,
      confirmStreak: 0, reversalReasons: [], browser: { actions: [], shots: [] },
    }] });
    proTraderStart({ mode: 'paper' }); // ENGINE paper — par trade live-stamped
    const deps = {
      getTick: (k: string) => (k === 'IN_BTC' ? { price: 90, time: Date.now() } : null), // crash below SL
      fetchCoinDcxTickers: async () => [], fetchFuturesPrices: async () => [],
    };
    const r = await proTraderTick(deps, null);
    expect(r.ok).toBe(true);
    expect(ba.cxClosePosition).toHaveBeenCalledWith('BTCINR', 'LONG'); // broker close HUA
    const j = (loadJSON('protrader-auto-journal.json', { trades: [] }) as { trades: Array<Record<string, unknown>> }).trades;
    const row = j.find((t) => t.id === 'PTA-LIVE1');
    expect(row.status).toBe('CLOSED');
  });

  it('CLOSE_FAILED symbol pe RE-ENTRY BLOCK (broker pe position zinda ho sakti hai — double exposure guard)', async () => {
    vi.mocked(getSignals).mockImplementation(async (market: string) => ({ ok: true, market, signals: market === 'FUTURES' ? [futSignal] : [] }));
    saveJSON('protrader-auto-journal.json', { trades: [{
      id: 'PTA-CF1', ts: Date.now() - 60_000, day: '2000-1-1', market: 'CRYPTO', symbol: 'BTC', pair: 'BTCINR', side: 'LONG',
      entryPrice: 100, sl: 95, tp: 112, stakeINR: 500, mode: 'live', status: 'CLOSE_FAILED', lastLtp: 100,
      confirmStreak: 0, reversalReasons: [], browser: { actions: [], shots: [] },
    }] });
    proTraderStart({ mode: 'paper' });
    const r = await proTraderTick(nullDeps, null);
    expect(r.ok).toBe(true);
    expect(proTraderStatusView().positions.length).toBe(0); // naya entry NAHI
    const j = (loadJSON('protrader-auto-journal.json', { trades: [] }) as { trades: unknown[] }).trades;
    expect(j.length).toBe(1); // sirf wahi CLOSE_FAILED row
  });
});

// ============================================================
// D. signals.js — canonical board cache (source contract)
// ============================================================
describe('v20.7.10 signals.js — canonical-40 board cache (limit-poisoning fix)', () => {
  it('BOARD_CANON_LIMIT = 40 (sabse bada caller portfolio-insights limit:40 — 20 use HOTA to wo starve hota)', () => {
    expect(src('server/ai/signals.js')).toMatch(/const BOARD_CANON_LIMIT = 40;/);
  });
  it('warm path CANONICAL compute pe (pehle { limit: 10 } tha — 60s cache 10-row poison hota tha)', () => {
    expect(src('server/ai/signals.js')).toMatch(/_computeBoard\(mkt, deps \|\| \{\}, \{ limit: BOARD_CANON_LIMIT \}\)/);
  });
  it('direct compute path caller-agnostic canonical floor (Math.max)', () => {
    expect(src('server/ai/signals.js')).toMatch(/Math\.max\(BOARD_CANON_LIMIT, Number\(opts\.limit\) \|\| 0\)/);
  });
  it('saare serve paths caller-limit pe truncate (cached + warmOnly + joiner + direct = ≥4 call sites)', () => {
    const n = (src('server/ai/signals.js').match(/_truncateBoard\(/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// E. cxClosePositionScript — side-aware row match (jsdom)
// ============================================================
async function run(script: string): Promise<Record<string, unknown>> {
  const fn = new Function(`return (async () => { ${script} })();`);
  const raw = await fn();
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
}
function positionsTable(rows: string[][]) {
  document.body.innerHTML = `
    <div class="positions-panel">
      <h3>Open Positions</h3>
      <table><tbody>
        ${rows.map((r, i) => `<tr id="row${i}">${r.map((c) => `<td>${c}</td>`).join('')}<td><button class="exit-btn">Exit</button></td></tr>`).join('')}
      </tbody></table>
      <button id="modalConfirm">Confirm</button>
    </div>`;
  const clicked: string[] = [];
  document.querySelectorAll('button.exit-btn').forEach((b) => {
    b.addEventListener('click', () => { clicked.push((b.closest('tr') as HTMLElement).id); });
  });
  return clicked;
}

describe('v20.7.10 cxClosePositionScript — side-aware close (jsdom)', () => {
  it('hedge (LONG+SHORT dono rows) + side SHORT → sirf SHORT row ka exit click', async () => {
    const clicked = positionsTable([
      ['B-DOT_USDT', 'LONG', '31.74'],
      ['B-DOT_USDT', 'SHORT', '20.00'],
    ]);
    const r = await run(S.cxClosePositionScript('B-DOT_USDT', 'SHORT'));
    expect(r.ok).toBe(true);
    expect((r.steps as string[]).join(',')).toContain('row-found:side-match');
    expect(clicked).toEqual(['row1']); // SHORT wali row hi
  });

  it('unknown side + 2 rows → REFUSE (koi exit click nahi — galat row close ka risk zero)', async () => {
    const clicked = positionsTable([
      ['B-DOT_USDT', 'LONG', '31.74'],
      ['B-DOT_USDT', 'SHORT', '20.00'],
    ]);
    const r = await run(S.cxClosePositionScript('B-DOT_USDT', undefined));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('UNKNOWN');
    expect(clicked).toEqual([]);
  });

  it('unknown side + SINGLE row → close (side-unknown honest note ke saath)', async () => {
    const clicked = positionsTable([['B-DOT_USDT', 'LONG', '31.74']]);
    const r = await run(S.cxClosePositionScript('B-DOT_USDT', undefined));
    expect(r.ok).toBe(true);
    expect((r.steps as string[]).join(',')).toContain('row-found:side-unknown');
    expect(clicked).toEqual(['row0']);
  });

  it('side LONG manga par sirf SHORT row hai → REFUSE (wrong-side close kabhi nahi — chahe single row ho)', async () => {
    const clicked = positionsTable([['B-DOT_USDT', 'SHORT', '20.00']]);
    const r = await run(S.cxClosePositionScript('B-DOT_USDT', 'LONG'));
    expect(r.ok).toBe(false);
    expect((r.steps as string[]).join(',')).toContain('opposite-side-only');
    expect(clicked).toEqual([]);
  });
});

// ============================================================
// F. Feed reliability — source contracts
// ============================================================
describe('v20.7.10 feed reliability — silence watchdogs + heartbeat (source contracts)', () => {
  it('binanceFutWs: 45s silence watchdog wired (NAT half-open socket kill — pehle readyState-OPEN check kabhi recover nahi karta tha)', () => {
    const s = src('server/ai/binanceFutWs.js');
    expect(s).toMatch(/BINANCE_FUT_SILENT_KILL_MS = 45_000/);
    expect(s).toMatch(/_lastMsgAt = Date\.now\(\)/);
    expect(s).toMatch(/terminate \? ws\.terminate\(\) : ws\.close\(\)/);
  });
  it('cryptoStream: Binance spot silence watchdog bhi wired (wahi NAT disease)', () => {
    const s = src('server/cryptoStream.js');
    expect(s).toMatch(/BINANCE_SILENT_KILL_MS = 45_000/);
    expect(s).toMatch(/_lastMsgAt = Date\.now\(\)/);
  });
  it('index.js: flat-price heartbeat — suppressed tick ke 45s baad force-send (flat price wale symbols pe bhi wire pe tick jata hai)', () => {
    const s = src('server/index.js');
    expect(s).toMatch(/lastSentAt\[key\] = now/);
    expect(s).toMatch(/45_000/);
  });
  it('useCxLivePrices: live-tick hard cap 10min → 120s (heartbeat ke saath dead-leg ab jaldi honest null)', () => {
    const s = src('src/components/aitrading/useCxLivePrices.ts');
    expect(s).toMatch(/age > 120_000/);
    expect(s).not.toMatch(/age > 600_000/);
  });
  it('proTraderAuto: reconciler kill-switch + RAM RED gates SAPTA entries pe (monitoring kabhi block nahi)', () => {
    const s = src('server/ai/proTraderAuto.js');
    expect(s).toMatch(/isKilled\?\.\(\)/);
    expect(s).toMatch(/ramCanEnter/);
  });
  it('proTraderAuto: UNFILLED daily-cap me count NAHI (slot free + cap honest)', () => {
    const s = src('server/ai/proTraderAuto.js');
    const n = (s.match(/\['FAILED', 'UNFILLED'\]\.includes\(t\.status\)/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(2); // tick + statusView dono
  });
});
