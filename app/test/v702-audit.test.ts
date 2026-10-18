// ============================================================
// test/v702-audit.test.ts — v7.0.2 DEEP AUDIT REGRESSIONS
// ------------------------------------------------------------
// Covers the fixes from the full-codebase deep audit:
//   1. CLOSE journal entries now carry `source` — the agent's daily
//      loss cap (agentRealizedToday) finally sees agent closes
//   2. Manual close with NO live price → honest reject (never a
//      fake ₹0-P&L close that understates the daily loss cap)
//   3. LIVE close blocked when creds are gone → honest error /
//      WATCH_ERROR + retry (never a paper-simulated close that
//      orphans the real exchange position)
//   4. Ledger prune re-stamps the head → verifyLedger survives
//      pruning past 400 entries (was permanently "broken at 0")
//   5. FUTURES ledger R uses the INR risk denominator (was ₹/USDT
//      — a 1R win logged as 84R)
//   6. loadProTraderConfig enforces the T1+T2 ≤ 90 split invariant
//   7. UNKNOWN live spot position with no order id surfaces a
//      WATCH_ERROR (was a silent permanent dead zone)
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v20.3: paper-fill slippage OFF for this suite — its subject is the
// v18.9 FEE honesty math, not fill realism (the exit-side slip is
// locked in aiOrders.test.ts + v203DeepAudit).
process.env.AI_COINDCX_SLIP_BPS = '0';

// ---- mocks (same boundary pattern as v70-pro-trader.test.ts) ----
const mockPrivate = vi.fn();
let _connected = true;
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => _connected,
  coindcxStatus: () => ({ connected: _connected }),
}));

let _tickers: Array<{ market: string; last_price: string }> = [];
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => _tickers),
}));

let _tvIndia: Record<string, { ltp: number }> = {};
let _tvCrypto: Record<string, { usdPrice: number }> = {};
vi.mock('../server/ai/data.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchTVIndiaBatch: vi.fn(async () => _tvIndia),
    fetchTVCryptoBatch: vi.fn(async () => _tvCrypto),
  };
});

let _futRows: Array<{ pair: string; last: number }> = [];
let _usdInr = 84;
vi.mock('../server/ai/futures.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    walletSnapshot: vi.fn(async () => null),
    executeFuturesSignal: vi.fn(async () => ({ ok: false, error: 'mocked' })),
    // closeFuturesPosition NOT overridden — the v7.0.2 test exercises the
    // REAL manual-close path (honest reject on no live price).
    fetchFuturesPrices: vi.fn(async () => _futRows),
    fetchUsdInr: vi.fn(async () => _usdInr),
  };
});

vi.mock('../server/ai/signals.js', () => ({
  getSignals: vi.fn(async () => ({ ok: true, market: 'CRYPTO', signals: [] })),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
  getFreshSignalForExec: vi.fn(async () => null),
}));

import {
  watchPositions, closePosition, loadJournal, __resetForTests,
  __setJournalForTests, loadProTraderConfig,
} from '../server/ai/coindcxOrders.js';
import { closeFuturesPosition, __resetFuturesForTests } from '../server/ai/futures.js';
import { recordExecution, verifyLedger, settlePositionOutcome, __setLedgerForTests, __ledgerRaw } from '../server/ai/ledger.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// ---------------- fixtures ----------------
function agentPaperPosition(overrides = {}) {
  return {
    id: 'pos-a702', pair: 'BTCINR', symbol: 'BTC', side: 'LONG', mode: 'paper',
    market: 'CRYPTO', source: 'agent',
    qty: 10, entryPrice: 100, notionalINR: 1000,
    sl: 96.8, tp: 103.2, tp2: 106.4,
    initialRisk: 3.2, peakPrice: 100,
    openedAt: Date.now() - 5 * 60_000, status: 'OPEN',
    ...overrides,
  };
}
function livePosition(overrides = {}) {
  return agentPaperPosition({
    id: 'pos-live', mode: 'live', exchangeOrderId: 'ex-1',
    ...overrides,
  });
}
function futuresPaperPosition(overrides = {}) {
  return {
    id: 'pos-f702', pair: 'B-BTC_USDT', symbol: 'BTC', side: 'LONG', mode: 'paper',
    market: 'FUTURES', source: 'agent',
    qty: 0.5, entryPrice: 80_000, notionalUSDT: 40_000, notionalINR: 3_360_000,
    marginUSDT: 13_333, marginINR: 1_119_972, leverage: 3,
    sl: 77_600, tp: 83_000, tp2: 86_000,
    initialRisk: 2_400, peakPrice: 80_000,
    openedAt: Date.now() - 5 * 60_000, status: 'OPEN',
    ...overrides,
  };
}

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockPrivate.mockResolvedValue({ orders: [{ id: 'order-123' }] });
  _tickers = [];
  _tvIndia = {};
  _tvCrypto = {};
  _futRows = [];
  _usdInr = 84;
  _connected = true;
});

afterEach(() => {
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ============================================================
// 1 + 3 + 7 — spot watcher honesty
// ============================================================
describe('v7.0.2 spot watcher honesty', () => {
  it('CLOSE entries carry source — agent loss cap sees agent closes', async () => {
    // SL 96.8 hit → paper close; the CLOSE entry must say source:'agent'
    __setJournalForTests({ entries: [], positions: [agentPaperPosition()] });
    _tickers = [{ market: 'BTCINR', last_price: '95' }];
    await watchPositions({});
    const j = loadJournal();
    const close = j.entries.find(e => e.kind === 'CLOSE');
    expect(close).toBeTruthy();
    expect(close.source).toBe('agent');
    // v18.9: net of both-side fees (100+95)×10×0.10% = 1.95 → −₹51.95
    expect(close.pnlINR).toBeCloseTo((95 - 100) * 10 - 1.95, 1);
  });

  it('LIVE position + creds revoked → SL hit does NOT paper-close (WATCH_ERROR + retry)', async () => {
    __setJournalForTests({ entries: [], positions: [livePosition()] });
    _tickers = [{ market: 'BTCINR', last_price: '95' }]; // SL breached
    _connected = false; // keys revoked mid-trade
    await watchPositions({});
    const j = loadJournal();
    const p = j.positions[0];
    expect(p.status).toBe('OPEN'); // NOT paper-closed — real coins still on the exchange
    expect(j.entries.some(e => e.kind === 'CLOSE')).toBe(false);
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /BLOCKED/.test(String(e.reason)))).toBe(true);
  });

  it('UNKNOWN live position with no order id surfaces a WATCH_ERROR (no silent dead zone)', async () => {
    __setJournalForTests({
      entries: [],
      positions: [livePosition({ id: 'pos-unk', status: 'UNKNOWN', exchangeOrderId: null, unknownSince: Date.now() - 4 * 60_000 })],
    });
    await watchPositions({});
    const j = loadJournal();
    expect(j.positions[0].status).toBe('UNKNOWN'); // still unresolved, still counted
    expect(j.positions[0].unknownAlerted).toBe(true);
    expect(j.entries.some(e => e.kind === 'WATCH_ERROR' && /UNKNOWN live position/.test(String(e.reason)))).toBe(true);
  });
});

// ============================================================
// 2 — manual close honesty (no fake ₹0 P&L)
// ============================================================
describe('v7.0.2 manual close — live price required', () => {
  it('spot: ticker feed dead → honest reject, position stays OPEN', async () => {
    __setJournalForTests({ entries: [], positions: [agentPaperPosition()] });
    _tickers = []; // feed outage
    const out = await closePosition('pos-a702');
    expect(out.ok).toBe(false);
    expect(/No (?:official )?live price/.test(String(out.error))).toBe(true); // v18.9: official-price gate wording
    expect(loadJournal().positions[0].status).toBe('OPEN');
  });

  it('futures: RT feed dead → honest reject', async () => {
    __setJournalForTests({ entries: [], positions: [futuresPaperPosition()] });
    _futRows = [];
    // v11.3: fetchFuturesPrices now has fallback legs (WS book →
    // Binance/Bybit → deep-stale) — closeFuturesPosition exercises the
    // REAL chain. Stub the network DEAD so this stays hermetic: every
    // leg fails → "No live futures price" → the honest reject. (Without
    // the stub the sandbox's REACHABLE Binance would rescue the close —
    // exactly what production SHOULD do during a CoinDCX outage.)
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })) as any;
    try {
      __resetFuturesForTests();
      const out = await closeFuturesPosition('pos-f702');
      expect(out.ok).toBe(false);
      expect(/No live futures price/.test(String(out.error))).toBe(true);
      expect(loadJournal().positions[0].status).toBe('OPEN');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('spot LIVE + creds revoked → honest error (no paper close for real coins)', async () => {
    __setJournalForTests({ entries: [], positions: [livePosition()] });
    _tickers = [{ market: 'BTCINR', last_price: '104' }];
    _connected = false;
    const out = await closePosition('pos-live');
    expect(out.ok).toBe(false);
    expect(/CoinDCX keys missing\/revoked/.test(String(out.error))).toBe(true);
    expect(loadJournal().positions[0].status).toBe('OPEN');
  });
});

// ============================================================
// 4 — ledger prune keeps the chain verifiable
// ============================================================
describe('v7.0.2 ledger prune re-stamp', () => {
  it('verifyLedger stays ok after pruning past the cap (v21.11: 400 → 1200 window)', () => {
    __setLedgerForTests({ entries: [] });
    const sig = { symbol: 'BTC', side: 'LONG', market: 'CRYPTO', votes: [] };
    // v21.11: ledger learning window 400 → 1200 (adaptive/trust/gateTuner
    // 3× data) — prune test naye cap pe: 1202 record karo, 1200 rahna chahiye
    for (let i = 0; i < 1202; i++) recordExecution(sig, { mode: 'paper', source: 'agent' });
    const v = verifyLedger();
    expect(v.entries).toBe(1200); // pruned to the cap
    expect(v.ok).toBe(true);    // head re-stamped — chain still verifies
    expect(v.brokenAt).toBeNull();
    __setLedgerForTests({ entries: [] });
  }, 20_000);
});

// ============================================================
// 5 — futures R denominator (INR, not USDT)
// ============================================================
describe('v7.0.2 futures ledger R metric', () => {
  it('a 1R futures win logs r = 1.0 (INR risk denominator)', () => {
    __setLedgerForTests({ entries: [] });
    const rec = recordExecution({ symbol: 'BTC', side: 'LONG', market: 'FUTURES', votes: [] }, { mode: 'paper', source: 'agent' });
    // 1R win in the USDT domain: risk = 2400×0.5 = 1200 USDT → ₹100,800 @ 84
    const p = futuresPaperPosition({
      ledgerEntryId: rec.id, status: 'CLOSED', closedAt: Date.now(),
      closePrice: 82_400, pnlINR: 100_800, // (82400−80000)×0.5×84
    });
    settlePositionOutcome(p, 'TARGET-2 hit');
    const settled = __ledgerRaw().entries.find(x => x.id === rec.id);
    expect(settled.outcome).toBeTruthy();
    expect(settled.outcome.r).toBeCloseTo(1.0, 1); // old code: 84 (₹ ÷ USDT)
    __setLedgerForTests({ entries: [] });
  });
});

// ============================================================
// 6 — pro-trader config split invariant (defense in depth)
// ============================================================
describe('v7.0.2 loadProTraderConfig split clamp', () => {
  it('hand-edited tp1+tp2 > 90 config is clamped (no over-100% close)', () => {
    saveJSON('ai-agent-config.json', { tp1ClosePct: 60, tp2ClosePct: 60 });
    const pro = loadProTraderConfig();
    expect(pro.tp1ClosePct + pro.tp2ClosePct).toBeLessThanOrEqual(90);
    expect(pro.tp1ClosePct).toBe(60);
    expect(pro.tp2ClosePct).toBe(30);
    saveJSON('ai-agent-config.json', {});
  });
});
