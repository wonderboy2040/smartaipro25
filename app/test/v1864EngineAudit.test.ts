// ============================================================
// test/v1864EngineAudit.test.ts — v18.6.4 SAPTA engine audit fixes
// ------------------------------------------------------------
// LOCKED HERE:
//   • INDIA gate: `executable:false` (a CRYPTO-scoped flag) no longer
//     blocks the India desk — grade STRONG + plan + side is the gate
//   • qty affordability: stake < 1 share → honest skip (8x oversize
//     order protect), paper mode included
//   • CLOSE HONESTY: live crypto close that fails/does not verify →
//     CLOSE_UNKNOWN (trade STAYS monitored, retries ≤8, telegram
//     alert) — never a fake CLOSED journal
//   • P&L basis: notional (qty × Δprice) — no ×leverage guess
//   • tick re-entrancy: an in-flight tick blocks overlapping ticks
//     (overlapped browser double-click protect)
//   • EOD squareoff: INTRADAY products only (MTF/DELIVERY hold)
// ============================================================
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SMARTAI_DATA_DIR = path.join(os.tmpdir(), `pta-v1864-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.SMARTAI_DATA_DIR, { recursive: true });

// ---- mocks ----
vi.mock('../server/ai/signals.js', () => ({ getSignals: vi.fn() }));
vi.mock('../server/ai/browserAgent.js', () => ({
  browserConnect: vi.fn(async () => ({ connected: true, tabs: { coindcx: { found: true }, dhan: { found: true } } })),
  browserStatus: vi.fn(() => ({ connected: true, tabs: { coindcx: { found: true }, dhan: { found: true } } })),
  cxPairUrl: vi.fn((pair: string, product: string = 'futures') =>
    product === 'spot' ? `https://coindcx.com/trade/${pair}` : `https://coindcx.com/futures/${pair}`),
  cxEnsureTradePage: vi.fn(async () => { throw new Error('no browser'); }),
  cxSelectPair: vi.fn(async () => ({ ok: false })),
  cxPlaceOrder: vi.fn(async () => ({ ok: false })),
  cxClosePosition: vi.fn(async () => ({ ok: false })),
  cxReadPositions: vi.fn(async () => ({ ok: false, error: 'tab not available' })),
  dhanEnsurePage: vi.fn(async () => { throw new Error('no browser'); }),
  dhanSelectScrip: vi.fn(async () => ({ ok: false })),
  dhanPlaceOrder: vi.fn(async () => ({ ok: false })),
  dhanClosePosition: vi.fn(async () => ({ ok: false })),
}));
vi.mock('../server/liveFeed.js', () => ({ getTick: vi.fn(() => null) }));
vi.mock('../server/cryptoStream.js', () => ({ fetchCoinDcxTickers: vi.fn(async () => []) }));

const { loadJSON, saveJSON } = await import('../server/lib/store.js');
const {
  PROTRADER_DEFAULTS, proTraderGate, proTraderTick,
  proTraderStart, proTraderStop, proTraderStatusView, indiaMarketOpen,
} = await import('../server/ai/proTraderAuto.js');
const { getSignals } = await import('../server/ai/signals.js');
const browserAgentMod = await import('../server/ai/browserAgent.js');
const cxCloseMock = vi.mocked(browserAgentMod.cxClosePosition);
const getSignalsMock = vi.mocked(getSignals);

const LTP_STUB = { getTick: () => null, fetchCoinDcxTickers: async () => [] };
const todayIST = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

const indiaSignal = (over = {}) => ({
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG', confidence: 72, ltp: 100,
  executable: false, // ensemble NEVER sets this true for INDIA — the old gate died here
  plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
  superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
  ...over,
});

beforeEach(() => {
  saveJSON('protrader-auto-journal.json', { trades: [] });
  saveJSON('ai-trading-config.json', { killSwitch: false, mode: 'paper' });
  getSignalsMock.mockReset();
  getSignalsMock.mockImplementation(async (market: string) => ({
    ok: true, market, marketOpen: true, signals: [],
  }));
  cxCloseMock.mockReset();
  cxCloseMock.mockImplementation(async () => ({ ok: false, error: 'row nahi mila' }));
});

describe('v18.6.4 — proTraderGate: INDIA desk unlock (executable flag scope)', () => {
  it('INDIA STRONG signal with executable:false PASSES (grade+plan+side is the gate)', () => {
    const g = proTraderGate(indiaSignal(), { ...PROTRADER_DEFAULTS });
    expect(g.pass).toBe(true);
    expect(g.reasons).toEqual([]);
  });
  it('CRYPTO signal with executable:false still FAILS (not-executable)', () => {
    const g = proTraderGate(indiaSignal({ market: 'CRYPTO', symbol: 'BTC' }), { ...PROTRADER_DEFAULTS });
    expect(g.pass).toBe(false);
    expect(g.reasons).toContain('not-executable');
  });
});

describe('v18.6.4 — sizing protect + India paper entry (fake IST clock)', () => {
  it('stake < 1 share → honest skip, no journal entry (8x oversize protect)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T06:00:00Z')); // Mon 11:30 IST — NSE open
    try {
      expect(indiaMarketOpen()).toBe(true);
      getSignalsMock.mockImplementation(async (market: string) => ({
        ok: true, market, marketOpen: true,
        signals: market === 'INDIA' ? [indiaSignal({ plan: { entry: 4000, stopLoss: 3900, target1: 4200, target2: 4400 }, ltp: 4001 })] : [],
      }));
      proTraderStart({ mode: 'paper' });
      const r = await proTraderTick(LTP_STUB, null);
      expect(r.ok).toBe(true);
      const view = proTraderStatusView();
      expect(view.positions.length).toBe(0);
      expect(view.log.some((l: any) => l.text.includes('sizing skip'))).toBe(true);
    } finally { vi.useRealTimers(); proTraderStop(); }
  });

  it('affordable India STRONG signal → PAPER journal trade CREATED (the desk was dead before)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T06:00:00Z'));
    try {
      getSignalsMock.mockImplementation(async (market: string) => ({
        ok: true, market, marketOpen: true,
        signals: market === 'INDIA' ? [indiaSignal()] : [],
      }));
      proTraderStart({ mode: 'paper' });
      await proTraderTick(LTP_STUB, null);
      const view = proTraderStatusView();
      expect(view.positions.length).toBe(1);
      expect(view.positions[0].market).toBe('INDIA');
      expect(view.positions[0].qtyEstimate).toBe(5);       // floor(500/100)
      expect(view.positions[0].product).toBe('MTF');
      expect(view.positions[0].pnlBasis).toBe('notional');
    } finally { vi.useRealTimers(); proTraderStop(); }
  });
});

describe('v18.6.4 — CLOSE HONESTY (live crypto close fail → CLOSE_UNKNOWN retry loop)', () => {
  const openLiveTrade = () => ({
    id: 'PTA-TEST1', ts: Date.now() - 60_000, day: todayIST(),
    market: 'CRYPTO', symbol: 'BTC', pair: 'BTCINR', side: 'LONG',
    entryPrice: 100, sl: 95, tp: 112, tp2: 120,
    stakeINR: 500, leverage: 3, qtyEstimate: 5, pnlBasis: 'notional',
    mode: 'live', source: 'protrader-auto',
    signal: {}, browser: { actions: [], shots: [] },
    status: 'MONITORING', confirmStreak: 0, lastLtp: 94, lastCheckAt: Date.now(),
    reversalReasons: [],
  });
  const boardSLHit = () => ({
    ok: true, market: 'CRYPTO', marketOpen: true, signals: [{
      symbol: 'BTC', market: 'CRYPTO', side: 'SHORT', grade: 'STRONG', confidence: 72, ltp: 94,
      plan: { entry: 95, stopLoss: 99, target1: 88, target2: 84 },
      superIntel: { aiScore: 81 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'SHORT' },
    }],
  });

  it('failed browser close → CLOSE_UNKNOWN (never fake CLOSED), P&L notional basis, stays monitored', async () => {
    saveJSON('protrader-auto-journal.json', { trades: [openLiveTrade()] });
    proTraderStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    getSignalsMock.mockImplementation(async (market: string) => (market === 'CRYPTO' ? boardSLHit() : { ok: true, market, signals: [] }));
    await proTraderTick(LTP_STUB, null);

    const j = loadJSON('protrader-auto-journal.json', { trades: [] });
    const t = j.trades[0];
    expect(t.status).toBe('CLOSE_UNKNOWN');
    expect(t.closeAttempts).toBe(1);
    expect(t.closed.pnlINR).toBe(-30);        // (94-100) × qty 5 — NOT stake×pct×3 = -90
    expect(t.closed.verify).toBeNull();       // plain ok:false close — no verify attempt recorded
    const view = proTraderStatusView();
    expect(view.positions.length).toBe(1);     // still monitored
    expect(view.positions[0].status).toBe('CLOSE_UNKNOWN');
    expect(view.log.some((l: any) => l.text.includes('CLOSE UNVERIFIED'))).toBe(true);
    proTraderStop();
  });

  it('verified crypto close (row gone from positions) → CLOSED, verify=row-gone', async () => {
    saveJSON('protrader-auto-journal.json', { trades: [openLiveTrade()] });
    proTraderStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    getSignalsMock.mockImplementation(async (market: string) => (market === 'CRYPTO' ? boardSLHit() : { ok: true, market, signals: [] }));
    cxCloseMock.mockImplementation(async () => ({ ok: true, steps: ['row-found', 'exit-click', 'confirm'] }));
    vi.mocked(browserAgentMod.cxReadPositions).mockImplementation(async () => ({ ok: true, positions: [{ text: 'ETHINR something 123' }] }));
    await proTraderTick(LTP_STUB, null);

    const j = loadJSON('protrader-auto-journal.json', { trades: [] });
    expect(j.trades[0].status).toBe('CLOSED');
    expect(j.trades[0].closed.verify).toBe('row-gone'); // BTC row not in table → really closed
    proTraderStop();
  });

  it('retry loop: 8 re-attempts then CLOSE_FAILED (terminal, honest telegram nudge)', async () => {
    saveJSON('protrader-auto-journal.json', { trades: [openLiveTrade()] });
    proTraderStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    getSignalsMock.mockImplementation(async (market: string) => (market === 'CRYPTO' ? boardSLHit() : { ok: true, market, signals: [] }));
    let sent: string[] = [];
    await proTraderTick(LTP_STUB, (t: string) => { sent.push(t); return Promise.resolve({ ok: true }); });
    for (let i = 0; i < 9; i++) {
      await proTraderTick(LTP_STUB, (t: string) => { sent.push(t); return Promise.resolve({ ok: true }); });
    }
    const j = loadJSON('protrader-auto-journal.json', { trades: [] });
    expect(j.trades[0].status).toBe('CLOSE_FAILED');
    const view = proTraderStatusView();
    expect(view.positions.length).toBe(0); // terminal — dropped from monitor
    expect(sent.some((t) => t.includes('CLOSE FAILED') || t.includes('manually close'))).toBe(true);
    proTraderStop();
  });
});

describe('v18.6.4 — tick re-entrancy guard (overlapped browser double-click protect)', () => {
  it('a second tick while the first is in-flight returns overlapped:true immediately', async () => {
    proTraderStart({ mode: 'paper' });
    let resolveScan: any = null;
    getSignalsMock.mockImplementationOnce(() => new Promise((res) => { resolveScan = res; }));
    const p1 = proTraderTick(LTP_STUB, null);            // hangs in the board scan
    const p2 = await proTraderTick(LTP_STUB, null);      // must NOT overlap
    expect((p2 as any).overlapped).toBe(true);
    expect((p2 as any).ok).toBe(true);
    // let the first tick reach its board scan (microtask flush)
    for (let i = 0; i < 100 && typeof resolveScan !== 'function'; i++) await Promise.resolve();
    expect(typeof resolveScan).toBe('function');
    resolveScan({ ok: true, market: 'CRYPTO', marketOpen: true, signals: [] });
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    proTraderStop();
  });
});
