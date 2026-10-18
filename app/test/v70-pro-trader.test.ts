// ============================================================
// test/v70-pro-trader.test.ts — v7.0 ADVANCE PRO TRADER
// ------------------------------------------------------------
// Covers the full 3-tier partial take-profit upgrade:
//   • Partial TP at T1 (40% of ORIGINAL qty close, SL → breakeven)
//   • Partial TP at T2 (40% of ORIGINAL qty close, SL → T1 lock)
//   • Runner (20%) survives TP2 and exits via time-exit/manual close
//   • PARTIAL_TP journal entries + tamper-evident ledger legs
//   • Agent config: partial TP toggles + split normalization
//   • agentSizingPreview wallet-sizing accuracy (futures + spot)
//   • Edge cases: qty rounds to 0 (partials disabled honestly),
//     manual positions keep the classic full-exit, partial TP OFF
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// v20.3: paper-fill slippage OFF for this suite — its subject is the
// 3-tier partial-TP + fee-honesty math, not fill realism (the exit-side
// slip is locked in v203DeepAudit).
process.env.AI_COINDCX_SLIP_BPS = '0';

// ---- mocks (same boundary pattern as agent.test.ts / aiOrders.test.ts) ----
const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
}));

let _tickers: Array<{ market: string; last_price: string }> = [];
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => _tickers),
}));

vi.mock('../server/ai/futures.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    walletSnapshot: vi.fn(async () => null),
    executeFuturesSignal: vi.fn(async () => ({ ok: false, error: 'mocked' })),
    closeFuturesPosition: vi.fn(async () => ({ ok: true })),
    fetchUsdInr: vi.fn(async () => 84),
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
import {
  loadAgentConfig, updateAgentConfig, agentSizingPreview, __resetAgentForTests,
} from '../server/ai/agent.js';
import { recordExecution, verifyLedger, markPartialOutcome, __ledgerRaw } from '../server/ai/ledger.js';
import { saveJSON, loadJSON as loadJSONOrig } from '../server/lib/store.js';

// ---------------- fixtures ----------------
/** An AGENT-sourced paper spot position (the partial TP scope). */
function agentSpotPosition(overrides = {}) {
  return {
    id: 'pos-test-1', pair: 'BTCINR', symbol: 'BTC', side: 'LONG', mode: 'paper',
    market: 'CRYPTO', source: 'agent',
    qty: 10, entryPrice: 100, notionalINR: 1000,
    sl: 96.8, tp: 103.2, tp2: 106.4,
    initialRisk: 3.2, peakPrice: 100,
    ledgerEntryId: null,
    openedAt: Date.now() - 5 * 60_000, status: 'OPEN',
    ...overrides,
  };
}

let _origCreds = null;

beforeEach(() => {
  __resetForTests();
  __resetAgentForTests(); // saves AGENT_DEFAULTS → partial TP ON, 40/40/20
  _origCreds = JSON.parse(JSON.stringify(loadJSONOrig('mcp-coindcx.json') || {}));
  saveJSON('mcp-coindcx.json', { apiKey: 'test-key', secret: 'test-secret', connectedAt: Date.now() });
  mockPrivate.mockReset();
  mockPrivate.mockResolvedValue({ orders: [{ id: 'order-123' }] });
  _tickers = [];
});

afterEach(() => {
  // restore the ORIGINAL creds file — later suites (portfolioSync etc.)
  // depend on the real connected/not-connected state of the shared store
  saveJSON('mcp-coindcx.json', _origCreds && _origCreds.apiKey != null ? _origCreds : { apiKey: null, secret: null });
});

// ============================================================
// agent config — v7.0 PRO defaults + toggles + split normalization
// ============================================================
describe('v7.0 agent config (PRO TRADER)', () => {
  it('defaults: partial TP ON, 40/40/20 split, breakeven lock ON, v19.0 desk scope (spot OFF)', () => {
    const cfg = loadAgentConfig();
    expect(cfg.partialTpEnabled).toBe(true);
    expect(cfg.tp1ClosePct).toBe(40);
    expect(cfg.tp2ClosePct).toBe(40);
    expect(cfg.runnerPct).toBe(20);
    expect(cfg.breakEvenAfterTp1).toBe(true);
    // v19.0 USER SPEC (2026-09-29): "auto trading sirf Global Futures
    // USDT & Equity SIM USDC me — Spot me nahi" — spot auto-entry
    // default OFF (v7.0 tha ON); futures + global (equity SIM USDC) ON.
    // Manual spot trading + existing spot position management unaffected.
    expect(cfg.desks.spot).toBe(false);
    expect(cfg.desks.futures).toBe(true);
    expect(cfg.desks.global).toBe(true);
  });

  it('toggles accept booleans (partialTpEnabled / breakEvenAfterTp1)', () => {
    const cfg = updateAgentConfig({ partialTpEnabled: false, breakEvenAfterTp1: false });
    expect(cfg.partialTpEnabled).toBe(false);
    expect(cfg.breakEvenAfterTp1).toBe(false);
    const back = updateAgentConfig({ partialTpEnabled: true, breakEvenAfterTp1: true });
    expect(back.partialTpEnabled).toBe(true);
    expect(back.breakEvenAfterTp1).toBe(true);
  });

  it('split normalization: T1+T2 clamped so the runner stays ≥ 10%', () => {
    const cfg = updateAgentConfig({ tp1ClosePct: 80, tp2ClosePct: 80 });
    expect(cfg.tp1ClosePct + cfg.tp2ClosePct).toBeLessThanOrEqual(90);
    expect(cfg.runnerPct).toBeGreaterThanOrEqual(10);
  });

  it('loadProTraderConfig (watcher side) reads the same durable file', () => {
    const pro = loadProTraderConfig();
    expect(pro.partialTpEnabled).toBe(true);
    expect(pro.tp1ClosePct).toBe(40);
    expect(pro.tp2ClosePct).toBe(40);
    expect(pro.breakEvenAfterTp1).toBe(true);
    saveJSON('ai-agent-config.json', { partialTpEnabled: false, tp1ClosePct: 50, tp2ClosePct: 30, breakEvenAfterTp1: false });
    const pro2 = loadProTraderConfig();
    expect(pro2.partialTpEnabled).toBe(false);
    expect(pro2.tp1ClosePct).toBe(50);
    expect(pro2.tp2ClosePct).toBe(30);
    expect(pro2.breakEvenAfterTp1).toBe(false);
  });
});

// ============================================================
// sizing preview — wallet-proportional sizing accuracy
// ============================================================
describe('v7.0 agentSizingPreview (wallet-based sizing)', () => {
  const cfg = { riskPerTradePct: 1.5, maxLeverage: 3 };

  it('FUTURES: ₹X risk → Y qty → Z USDT margin at Lx (60% deployable cap)', () => {
    // equity ₹26,000 · 1.5% = ₹390 risk · stop 1600 · entry 50000 · fx 84
    const p = agentSizingPreview({
      cfg, equityINR: 26_000, usdInr: 84,
      plan: { entry: 50_000, stopLoss: 48_400, riskPct: 3.2 },
      wallet: { deployableFuturesUSDT: 200 },
    });
    expect(p.desk).toBe('FUTURES');
    expect(p.riskINR).toBe(390);
    const riskUSDT = 390 / 84;               // ≈ 4.643 USDT
    const stopDist = 50_000 - 48_400;        // 1600
    const lev = Math.max(1, Math.min(3, Math.floor(95 / 3.2))); // 3x
    expect(p.qty).toBeCloseTo(riskUSDT / stopDist, 3);
    const rawMargin = ((riskUSDT / stopDist) * 50_000) / lev;   // ≈ 48.4 USDT
    const cap = 200 * 0.6;                   // 120 — not binding here
    expect(p.marginUSDT).toBeCloseTo(Math.min(rawMargin, cap), 2);
    expect(p.leverage).toBe(lev);
    expect(p.capped).toBe(false);
  });

  it('FUTURES: margin capped at 60% of deployable when sizing exceeds it', () => {
    const p = agentSizingPreview({
      cfg: { riskPerTradePct: 10, maxLeverage: 3 }, equityINR: 26_000, usdInr: 84,
      plan: { entry: 50_000, stopLoss: 49_800, riskPct: 0.5 }, // tiny stop → huge qty
      wallet: { deployableFuturesUSDT: 10 },
    });
    expect(p.capped).toBe(true);
    expect(p.marginUSDT).toBeCloseTo(10 * 0.6, 2);
  });

  it('SPOT: budget = min(maxOrderINR, risk/riskPct, 60% deployable INR)', () => {
    const p = agentSizingPreview({
      cfg, equityINR: 26_000, usdInr: 84,
      plan: { entry: 100, stopLoss: 96.8, riskPct: 3.2 },
      market: 'CRYPTO',
      wallet: { deployableSpotINR: 5_000 },
      trading: { maxOrderINR: 1000 },
    });
    expect(p.desk).toBe('SPOT');
    expect(p.riskINR).toBe(390);
    // (390 / 3.2) * 100 = 12,187.5 → maxOrderINR 1000 binds → 60% of 5000 = 3000 → min = 1000
    expect(p.budgetINR).toBe(1000);
  });

  it('no plan yet → risk budget preview with the honest note', () => {
    const p = agentSizingPreview({ cfg, equityINR: 26_000, usdInr: 84, plan: null });
    expect(p.desk).toBeNull();
    expect(p.riskINR).toBe(390);
    expect(p.note).toMatch(/390/);
  });
});

// ============================================================
// spot watcher — 3-tier partial take-profit
// ============================================================
describe('v7.0 spot watcher partial TP (agent positions)', () => {
  it('T1 hit → closes 40% of ORIGINAL qty, SL → breakeven, journals PARTIAL_TP', async () => {
    const pos = agentSpotPosition();
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'BTCINR', last_price: '104' }]; // T1 103.2 hit, T2 106.4 not

    await watchPositions({});

    const j = loadJournal();
    const p = j.positions[0];
    const partials = j.entries.filter(e => e.kind === 'PARTIAL_TP');
    expect(partials).toHaveLength(1);
    expect(p.status).toBe('OPEN');           // runner alive
    expect(p.tp1Hit).toBe(true);
    expect(p.originalQty).toBe(10);          // frozen at the first leg
    expect(p.qty).toBe(6);                   // 10 − 40%
    expect(p.exitStage).toBe('T1_HIT');
    // v18.9 FEE HONESTY: 4 × (104−100) = 16 gross − (100+104)×4×0.10% = 0.82 fees → 15.18 net
    expect(p.bookedPnlINR).toBeCloseTo(15.18, 1);
    // breakeven lock: SL ≥ entry (trail already armed BE at 100)
    expect(p.sl).toBeGreaterThanOrEqual(100);
    expect(partials[0].stage).toBe('T1');
    expect(partials[0].qty).toBe(4);
    expect(partials[0].pnlINR).toBeCloseTo(15.18, 1);
  });

  it('T2 hit (after T1) → closes 40% more, SL → T1 (profit lock), runner 20%', async () => {
    const pos = agentSpotPosition({ tp1Hit: true, originalQty: 10, qty: 6, bookedPnlINR: 16, exitStage: 'T1_HIT' });
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'BTCINR', last_price: '107' }]; // T2 106.4 hit

    await watchPositions({});

    const j = loadJournal();
    const p = j.positions[0];
    const partials = j.entries.filter(e => e.kind === 'PARTIAL_TP');
    expect(partials).toHaveLength(1);
    expect(partials[0].stage).toBe('T2');
    expect(p.tp2Hit).toBe(true);
    expect(p.status).toBe('OPEN');           // RUNNER alive — NOT fully closed at TP2
    expect(p.qty).toBe(2);                   // 6 − 4 = 20% runner
    expect(p.originalQty).toBe(10);
    // v18.9: T1 booked pre-set 16 + T2 net 4×7 − (100+107)×4×0.10% = 28 − 0.83 = 27.17 → 43.17
    expect(p.bookedPnlINR).toBeCloseTo(43.17, 1);
    expect(p.exitStage).toBe('RUNNER');
    // profit lock: SL at/above T1 (103.2) — trail ratchet keeps it ≥
    expect(p.sl).toBeGreaterThanOrEqual(103.2);
    // NO CLOSE entry — the runner rides
    expect(j.entries.filter(e => e.kind === 'CLOSE')).toHaveLength(0);
  });

  it('price gaps past BOTH tiers in one pass → 80% booked, 20% runner, no full close', async () => {
    const pos = agentSpotPosition();
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'BTCINR', last_price: '110' }];

    await watchPositions({});

    const j = loadJournal();
    const p = j.positions[0];
    const partials = j.entries.filter(e => e.kind === 'PARTIAL_TP');
    expect(partials.map(x => x.stage)).toEqual(['T1', 'T2']);
    expect(p.qty).toBe(2);
    expect(p.tp1Hit).toBe(true);
    expect(p.tp2Hit).toBe(true);
    expect(p.exitStage).toBe('RUNNER');
    expect(p.status).toBe('OPEN');
    // v18.9: both legs at 110 → gross 80 − 2×((100+110)×4×0.10%) = 80 − 1.68 = 78.32
    expect(p.bookedPnlINR).toBeCloseTo(78.32, 1);
    expect(j.entries.filter(e => e.kind === 'CLOSE')).toHaveLength(0);
  });

  it('runner exits on time-exit/manual close: final-leg P&L + booked = the honest total', async () => {
    const signal = { symbol: 'BTCINR', market: 'CRYPTO', side: 'LONG', grade: 'STRONG', confidence: 86, agreement: 0.8, plan: { entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4, riskPct: 3.2 }, votes: [], summary: 'x' };
    const ledgerEntry = recordExecution(signal, { mode: 'paper', source: 'agent' });
    const pos = agentSpotPosition({
      id: 'pos-runner', ledgerEntryId: ledgerEntry.id,
      tp1Hit: true, tp2Hit: true, originalQty: 10, qty: 2,
      bookedPnlINR: 44, exitStage: 'RUNNER', sl: 103.8, peakPrice: 107,
    });
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'BTCINR', last_price: '108' }];

    const out = await closePosition('pos-runner'); // agent time-exit calls the same path
    expect(out.ok).toBe(true);

    const j = loadJournal();
    const p = j.positions[0];
    expect(p.status).toBe('CLOSED');
    // v18.9: final leg 2 × 8 = 16 − (100+108)×2×0.10% = 0.42 fees → 15.58
    expect(p.pnlINR).toBeCloseTo(15.58, 1);
    expect(p.bookedPnlINR).toBeCloseTo(44, 1);
    const closes = j.entries.filter(e => e.kind === 'CLOSE');
    expect(closes).toHaveLength(1);
    expect(closes[0].qty).toBe(2);           // only the runner leg books a CLOSE
    // ledger outcome = TOTAL (booked + final) vs the ORIGINAL risk:
    // v18.9: total = booked 44 + final 15.58 = 59.58 → r = 59.58 / 32 = 1.862
    const led = __ledgerRaw().entries.find(x => x.id === ledgerEntry.id);
    expect(led.outcome).toBeTruthy();
    expect(led.outcome.pnlINR).toBeCloseTo(59.58, 1);
    expect(led.outcome.r).toBeCloseTo(1.862, 2);
    // chain still verifiable after partial legs + outcome
    expect(verifyLedger().ok).toBe(true);
  });

  it('PARTIAL_TP legs count toward the daily loss cap (realized the moment they fill)', async () => {
    const pos = agentSpotPosition({ side: 'SHORT', sl: 103.2, tp: 96.8, tp2: 93.6, entryPrice: 100 });
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'BTCINR', last_price: '95' }]; // SHORT T1 96.8 hit
    await watchPositions({});
    const j = loadJournal();
    expect(j.entries.filter(e => e.kind === 'PARTIAL_TP')).toHaveLength(1);
    const { dailyStatsExport } = await import('../server/ai/coindcxOrders.js');
    const stats = dailyStatsExport(j);
    // v18.9: 4 × (100−95) = 20 gross − (100+95)×4×0.10% = 0.78 fees → 19.22 net
    expect(stats.realizedPnlINR).toBeCloseTo(19.22, 1);
  });

  it('edge: qty rounds to 0 → partials disabled honestly, legacy TP2 exit applies', async () => {
    // XRPINR fallback precision = 1dp → 40% of 0.2 XRP = 0.08 → floors to 0
    const pos = agentSpotPosition({ pair: 'XRPINR', symbol: 'XRP', qty: 0.2, notionalINR: 10, sl: 9.68, tp: 10.32, tp2: 10.64, entryPrice: 10, initialRisk: 0.32, peakPrice: 10 });
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'XRPINR', last_price: '11' }]; // past BOTH tiers

    await watchPositions({});

    const j = loadJournal();
    const p = j.positions[0];
    expect(p.partialTpOff).toBe(true);       // tiered exits disabled for this position
    expect(j.entries.filter(e => e.kind === 'PARTIAL_TP')).toHaveLength(0);
    // legacy behavior: T2 full close (position CLOSED, one CLOSE entry)
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toBe('TARGET-2 hit');
    expect(j.entries.filter(e => e.kind === 'CLOSE')).toHaveLength(1);
  });

  it('manual (non-agent) positions keep the classic full-exit at T1→T2 — no partials', async () => {
    const pos = agentSpotPosition({ source: 'manual' });
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'BTCINR', last_price: '104' }]; // T1 hit — but manual desk

    await watchPositions({});

    const j = loadJournal();
    const p = j.positions[0];
    expect(p.tp1Hit).toBeUndefined();
    expect(p.qty).toBe(10);
    expect(j.entries.filter(e => e.kind === 'PARTIAL_TP')).toHaveLength(0);
    expect(p.status).toBe('OPEN');           // classic: TP1 alert-only, runs to T2
  });

  it('partialTpEnabled=false (agent config) → classic full TP2 close, no legs', async () => {
    saveJSON('ai-agent-config.json', { ...loadAgentConfig(), partialTpEnabled: false });
    const pos = agentSpotPosition();
    __setJournalForTests({ entries: [], positions: [pos] });
    _tickers = [{ market: 'BTCINR', last_price: '110' }]; // past both tiers

    await watchPositions({});

    const j = loadJournal();
    const p = j.positions[0];
    expect(j.entries.filter(e => e.kind === 'PARTIAL_TP')).toHaveLength(0);
    expect(p.status).toBe('CLOSED');
    expect(p.closeReason).toBe('TARGET-2 hit');
  });
});

// ============================================================
// ledger — PARTIAL_TP tamper-evidence
// ============================================================
describe('v7.0 ledger partial legs (tamper-evident chain)', () => {
  it('markPartialOutcome stamps legs without breaking the hash chain', () => {
    const signal = { symbol: 'BTCINR', market: 'CRYPTO', side: 'LONG', grade: 'STRONG', confidence: 86, agreement: 0.8, plan: { entry: 100, stopLoss: 96.8 }, votes: [], summary: 'x' };
    const a = recordExecution(signal, { mode: 'paper', source: 'agent' });
    const b = recordExecution({ ...signal, symbol: 'ETHINR' }, { mode: 'paper', source: 'agent' });

    expect(markPartialOutcome(a.id, { stage: 'T1', qty: 4, price: 104, pnlINR: 16 })).toBe(true);
    expect(markPartialOutcome(a.id, { stage: 'T2', qty: 4, price: 107, pnlINR: 28 })).toBe(true);
    expect(markPartialOutcome('does-not-exist', { stage: 'T1', qty: 1, price: 1, pnlINR: 1 })).toBe(false);

    const raw = __ledgerRaw();
    const entryA = raw.entries.find(x => x.id === a.id);
    expect(entryA.partials).toHaveLength(2);
    expect(entryA.partials[0].stage).toBe('T1');
    expect(entryA.partials[0].pnlINR).toBe(16);
    // the chain STILL verifies (links before/after untouched)
    expect(verifyLedger().ok).toBe(true);
    // and the second entry links to the first's unchanged hash
    const entryB = raw.entries.find(x => x.id === b.id);
    expect(entryB.prevHash).toBe(entryA.hash);
  });
});
