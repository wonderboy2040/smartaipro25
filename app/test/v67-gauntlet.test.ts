// ============================================================
// test/v67-gauntlet.test.ts — CONCENTRATION GUARD + LEDGER WIRING
// ------------------------------------------------------------
// The execute-time v6.7 additions on the crypto desk:
//   1. maxOpenPositions gate: 6th open position → honest reject
//   2. paper execution stamps the ledger (hash chain grows)
//   3. watcher SL close settles the ledger outcome (R + attribution)
//   4. manual close settles the ledger outcome
//   5. config round-trips maxOpenPositions (clamp 1-20)
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v67g');

const mockPrivate = vi.fn();
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxPrivate: (...args) => mockPrivate(...args),
  coindcxConnected: () => true,
  coindcxStatus: () => ({ connected: true }),
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: vi.fn(async () => [{ market: 'BTCINR', last_price: '100' }]),
}));

const {
  executeSignal, watchPositions, closePosition, updateConfig, loadConfig,
  loadJournal, __resetForTests, __setJournalForTests, __setConfigForTests,
} = await import('../server/ai/coindcxOrders.js');
const { __ledgerRaw, __setLedgerForTests, verifyLedger, modelStats } = await import('../server/ai/ledger.js');
const { fetchCoinDcxTickers } = await import('../server/cryptoStream.js');

const STRONG = (symbol = 'BTC', side = 'LONG') => ({
  symbol, market: 'CRYPTO', side, grade: 'STRONG',
  confidence: 82, agreement: 0.78, generatedAt: Date.now(),
  ltp: 100, plan: {
    entry: 100, stopLoss: 96.8, target1: 103.2, target2: 106.4,
    risk: 3.2, riskPct: 3.2, rewardRisk: 2, atrUsed: 2, planStyle: 'atr-based',
  },
  votes: [
    { id: 'trend', name: 'TrendMatrix', weight: 1.4, dir: 1, conf: 80, reasons: [] },
    { id: 'smc', name: 'SmartMoneyICT', weight: 1.1, dir: 1, conf: 60, reasons: [] },
  ],
  summary: 'x',
});
const fresh = async (sym) => STRONG(sym);

beforeEach(() => {
  __resetForTests();
  __setLedgerForTests(null);
  mockPrivate.mockReset();
  mockPrivate.mockResolvedValue({ orders: [{ id: 'oid-1' }] });
  (fetchCoinDcxTickers as any).mockResolvedValue([{ market: 'BTCINR', last_price: '100' }]);
});

describe('v6.7 concentration guard (crypto desk)', () => {
  it('rejects the 6th position when maxOpenPositions = 5 (shared book)', async () => {
    __setConfigForTests({ mode: 'paper', dailyMaxTrades: 50, maxOpenPositions: 5, cryptoLeverage: 1 });
    __setJournalForTests({
      entries: [],
      positions: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'].map(b => ({
        id: `pos-${b}`, pair: `${b}INR`, side: 'LONG', mode: 'paper', market: 'CRYPTO', source: 'manual',
        qty: 1, entryPrice: 100, notionalINR: 100, sl: 95, tp: 105, tp2: 110, initialRisk: 5,
        openedAt: Date.now(), status: 'OPEN',
      })),
    });
    const out = await executeSignal({ symbol: 'DOGE', side: 'LONG', mode: 'paper', getFreshSignal: fresh, source: 'test' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('Concentration guard');
    // rejected with an audit entry
    const j = loadJournal();
    expect(j.entries.some(e => e.status === 'REJECTED' && String(e.reason || '').includes('Max open positions'))).toBe(true);
  });

  it('config round-trips maxOpenPositions with clamps', () => {
    updateConfig({ maxOpenPositions: 12 });
    expect(loadConfig().maxOpenPositions).toBe(12);
    updateConfig({ maxOpenPositions: 99 });  // clamped to 20
    expect(loadConfig().maxOpenPositions).toBe(20);
    updateConfig({ maxOpenPositions: 0 });   // clamped to 1
    expect(loadConfig().maxOpenPositions).toBe(1);
  });
});

describe('v6.7 ledger wiring (crypto desk)', () => {
  it('paper execution stamps the hash chain with per-model votes', async () => {
    __setConfigForTests({ mode: 'paper', dailyMaxTrades: 50 });
    const out = await executeSignal({ symbol: 'BTC', side: 'LONG', mode: 'paper', getFreshSignal: fresh, source: 'test' });
    expect(out.ok).toBe(true);
    const raw = __ledgerRaw();
    expect(raw.entries.length).toBe(1);
    const e = raw.entries[0];
    expect(e.symbol).toBe('BTCINR'); // executeSignal runs the pair symbol
    expect(e.mode).toBe('paper');
    expect(e.votes.trend.dir).toBe(1);
    expect(e.votes.smc.dir).toBe(1);
    expect(verifyLedger().ok).toBe(true);
    expect(out.position.ledgerEntryId).toBe(e.id);
  });

  it('watcher SL close settles the ledger outcome (R ≈ -1, model credits flip)', async () => {
    __setConfigForTests({ mode: 'paper', dailyMaxTrades: 50, trailEnabled: false });
    const open = await executeSignal({ symbol: 'BTC', side: 'LONG', mode: 'paper', getFreshSignal: fresh, source: 'test' });
    expect(open.ok).toBe(true);
    // price crashes to 95 (below the 96.8 SL) on the next watcher pass
    (fetchCoinDcxTickers as any).mockResolvedValue([{ market: 'BTCINR', last_price: '95' }]);
    const closures = await watchPositions({});
    expect(closures.length).toBe(1);
    expect(closures[0].reason).toContain('STOP-LOSS');
    const raw = __ledgerRaw();
    expect(raw.entries[0].outcome).not.toBeNull();
    // R = pnl / (riskPerUnit × qty): entry 100, SL planned 96.8 → risk 3.2;
    // the watcher closes at MARKET 95 (gap through the stop) → R = -5/3.2
    // v18.9: close pnl is NET of fees (−51.95 vs gross −50) → r = −51.95 / (3.2×10)
    expect(raw.entries[0].outcome.r).toBeCloseTo(-1.62, 1);
    // attribution: both models voted WITH the trade and it LOST → losses
    const stats = Object.fromEntries(modelStats().map(s => [s.model, s]));
    expect(stats.trend.losses).toBe(1);
    expect(stats.smc.losses).toBe(1);
    // the outcome stamp keeps the chain intact (hash covers the outcome)
    expect(verifyLedger().ok).toBe(true);
  });

  it('manual close settles the ledger too', async () => {
    __setConfigForTests({ mode: 'paper', dailyMaxTrades: 50 });
    const open = await executeSignal({ symbol: 'BTC', side: 'LONG', mode: 'paper', getFreshSignal: fresh, source: 'test' });
    expect(open.ok).toBe(true);
    const out = await closePosition(open.position.id);
    expect(out.ok).toBe(true);
    const raw = __ledgerRaw();
    expect(raw.entries[0].outcome).not.toBeNull();
    expect(raw.entries[0].outcome.reason).toBe('Manual close');
  });
});
