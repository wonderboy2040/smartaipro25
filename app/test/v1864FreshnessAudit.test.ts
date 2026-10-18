// ============================================================
// test/v1864FreshnessAudit.test.ts — v18.6.4 freshness + option-domain
// ------------------------------------------------------------
// LOCKED HERE:
//   • SERVE-TIME staleness re-rank: a 60s-cached board's topFive
//     re-decays at SERVE time (the v18.6.1 decay was inert — computed
//     with a just-re-stamped lastSeenAt)
//   • MTF-6 breaker PER-SYMBOL: 6 fresh degraded computes → that
//     symbol's own 10m blackout; thin coins never blackout the board;
//     a WIDESPREAD outage (8+ distinct symbols × ≥2 fails) opens the
//     global breaker
//   • OPTION-domain gating: premium LTP never compared against
//     underlying plan levels (banner/distances/risk/alerts/rows)
//   • close-at-live staleness gate: days-old __ltp rejected; fresh
//     __ltpAt accepted
//   • _persist strips dunder runtime state (__ltp/__conviction/…)
//   • alerts cooldown: per-entry windows (a 5m 'sl' pass can no longer
//     delete a 6h 't1' entry)
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- MTF data mocks (all candle sources dark → degraded snapshots) ----
vi.mock('../server/ai/data.js', () => ({
  fetchCoinDcxCandles: vi.fn(async () => null),
  fetchBinanceKlines: vi.fn(async () => null),
}));
// ---- manualTrades hermetic scaffolding (same as manualTrades.test.ts) ----
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
  setTick: (k, d) => { _ticks.set(k, d); },
  snapshot: () => ({}),
  subscribe: () => () => {},
  feedStatus: () => ({}),
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

const { buildMTFSnapshot, __clearMtfCaches, _mtfBreakerState } = await import('../server/ai/mtf.js');
const { __clearSignalCaches, __setBoardCacheForTests, getSignals, stalenessFactor } = await import('../server/ai/signals.js');
const {
  stateOfManualTrade, manualLevelDistances, manualRiskPct, manualTradesToPositionRows,
  recordManualTrade, closeManualTrade, manualTradeView, evaluateManualTradeAlerts,
  flushManualState, __resetManualStoreForTests,
} = await import('../server/ai/manualTrades.js');

const NOW = Date.now();
const mins = (m: number) => m * 60_000;

// ============================================================
describe('v18.6.4 — SERVE-TIME staleness re-rank (the inert decay fix)', () => {
  beforeEach(() => { __clearSignalCaches(); });

  it('stalenessFactor itself decays with lastSeenAt age (30m → 1.0, 60m → 0.15)', () => {
    expect(stalenessFactor({ signalAge: { lastSeenAt: NOW - mins(5) } })).toBe(1);
    expect(stalenessFactor({ signalAge: { lastSeenAt: NOW - mins(60) } })).toBeCloseTo(0.15, 2);
  });

  it('a cached board served >30m later re-ranks: stale row drops below fresh row + carries ×tag', async () => {
    const board = {
      ok: true, market: 'CRYPTO', marketOpen: true, generatedAt: NOW - mins(40),
      signals: [],
      topFive: [
        { symbol: 'STALECOIN', side: 'LONG', score: 90, rank: 1, rankReason: 'fresh reason', signalAge: { lastSeenAt: NOW - mins(45) } },
        { symbol: 'FRESHCOIN', side: 'LONG', score: 60, rank: 2, rankReason: 'fresh reason', signalAge: { lastSeenAt: NOW - mins(2) } },
      ],
    };
    __setBoardCacheForTests('CRYPTO', board, 0);
    const served = await getSignals('CRYPTO', {}, {});
    // STALECOIN 90 × ~0.62 decay ≈ 56 < FRESHCOIN 60 × 1.0 → ranks SWAP
    expect(served.topFive[0].symbol).toBe('FRESHCOIN');
    expect(served.topFive[1].symbol).toBe('STALECOIN');
    expect(served.topFive[1].rankReason).toMatch(/staleness ×0\.\d+/);
    // the CACHED payload object is pristine (cache-safe clone)
    expect(board.topFive[0].symbol).toBe('STALECOIN');
    expect(board.topFive[0].score).toBe(90);
  });

  it('a fully-fresh board passes through untouched (no re-rank cost/keys)', async () => {
    const board = {
      ok: true, market: 'CRYPTO', marketOpen: true, generatedAt: NOW, signals: [],
      topFive: [
        { symbol: 'A', side: 'LONG', score: 90, rank: 1, rankReason: 'r', signalAge: { lastSeenAt: NOW } },
        { symbol: 'B', side: 'LONG', score: 60, rank: 2, rankReason: 'r', signalAge: { lastSeenAt: NOW } },
      ],
    };
    __setBoardCacheForTests('CRYPTO', board, 0);
    const served = await getSignals('CRYPTO', {}, {});
    expect(served.topFive[0].symbol).toBe('A');
    expect((served as Record<string, unknown>).__servedAt).toBeUndefined();
  });
});

// ============================================================
describe('v18.6.4 — MTF-6 breaker is PER-SYMBOL (thin coins ≠ blackout)', () => {
  beforeEach(() => { __clearMtfCaches(); vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('6 fresh degraded computes (≥90s apart) → THAT symbol blacklists, others still fetch', async () => {
    for (let i = 0; i < 6; i++) {
      await buildMTFSnapshot('THIN', 'CRYPTO');
      vi.advanceTimersByTime(91_000); // bust the 90s degraded-snapshot cache
    }
    const st = _mtfBreakerState();
    expect(st.symSkip['CRYPTO:THIN']).toBeGreaterThan(Date.now());
    expect(st.globalSkipUntil).toBeLessThanOrEqual(Date.now()); // no global
    // a DIFFERENT symbol still tries (not globally blacked out)
    const before = vi.mocked((await import('../server/ai/data.js')).fetchCoinDcxCandles).mock.calls.length;
    await buildMTFSnapshot('HEALTHY', 'CRYPTO');
    const after = vi.mocked((await import('../server/ai/data.js')).fetchCoinDcxCandles).mock.calls.length;
    expect(after).toBeGreaterThan(before);
  });

  it('widespread outage (8+ distinct symbols × ≥2 fresh fails) → global breaker opens', async () => {
    // real-world shape: ek board pass me SAARE candidates seconds me
    // fail hote hain; streak sirf 90s+ TTL expiry par fresh compute pe
    // badhta hai (pass 2).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 8; i++) {
        await buildMTFSnapshot(`SYM${i}`, 'CRYPTO');
      }
      vi.advanceTimersByTime(91_000); // ONE cache-bust between passes
    }
    const st = _mtfBreakerState();
    expect(st.globalSkipUntil).toBeGreaterThan(Date.now());
    // global open → further builds return null WITHOUT fetching
    const dataMod = await import('../server/ai/data.js');
    const before = vi.mocked(dataMod.fetchCoinDcxCandles).mock.calls.length;
    const snap = await buildMTFSnapshot('SYMX', 'CRYPTO');
    expect(snap).toBeNull();
    const after = vi.mocked(dataMod.fetchCoinDcxCandles).mock.calls.length;
    expect(after).toBe(before);
  });
});

// ============================================================
describe('v18.6.4 — OPTION-domain gating (premium vs underlying levels)', () => {
  beforeEach(() => { __resetManualStoreForTests(); });

  const optTrade = () => ({
    market: 'INDIA', symbol: 'NIFTY', side: 'BUY', entryPrice: 150, qty: 2,
    assetKind: 'OPTION', strike: 24500, expiry: '2026-10-29', optType: 'CE',
    iv: 13, lotSize: 75, underlying: 'NIFTY', status: 'OPEN',
    origin: { plan: { entry: 24650, stopLoss: 24400, target1: 24900, target2: 25100, atr: 120 } },
  });

  it('stateOfManualTrade: premium LTP vs underlying targets → NO false TARGET_HIT', () => {
    // premium 150 vs plan target1 24900 — the old code instantly said TARGET_HIT
    const banner = stateOfManualTrade({ convictionState: 'HOLDING', ltp: 150, trade: optTrade() as any });
    expect(banner).toBe('THESIS_INTACT');
  });
  it('manualLevelDistances: OPTION → {} (distances are meaningless)', () => {
    expect(manualLevelDistances(optTrade() as any, 150)).toEqual({});
  });
  it('manualRiskPct: OPTION → null (no 16,133% 1R nonsense)', () => {
    expect(manualRiskPct(optTrade() as any)).toBeNull();
  });
  it('manualTradesToPositionRows: OPTION rows EXCLUDED (no false SL/TP telegram pushes)', () => {
    const rows = manualTradesToPositionRows([optTrade() as any, { market: 'CRYPTO', symbol: 'BTC', side: 'BUY', entryPrice: 100, qty: 1, status: 'OPEN', origin: { plan: { stopLoss: 95, target1: 110 } } } as any]);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('BTC');
  });
  it('evaluateManualTradeAlerts: OPTION → no sl/t1/t2 pushes (conviction tracking only)', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const pushed = await evaluateManualTradeAlerts(optTrade() as any, { send, conviction: { state: 'HOLDING' }, usdInr: 84 });
    expect(pushed).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('v18.6.4 — close-at-live staleness + persist hygiene', () => {
  beforeEach(() => { __resetManualStoreForTests(); });

  it('stale __ltp (no fresh __ltpAt) is REJECTED — never a days-old exit price', () => {
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    trade.__ltp = 103;
    trade.__ltpAt = Date.now() - 10 * 60_000; // 10 min old
    const out = closeManualTrade(trade.id, {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain('purana');
  });
  it('fresh __ltpAt (<60s) closes at the live stamp', () => {
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    trade.__ltp = 103;
    trade.__ltpAt = Date.now() - 5_000;
    const out = closeManualTrade(trade.id, {});
    expect(out.ok).toBe(true);
    expect(out.trade.exitPrice).toBe(103);
  });
  it('manualTradeView stamps __ltpAt alongside __ltp', () => {
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    const v = manualTradeView(trade, { ltp: 104 });
    expect(v.__ltp).toBe(104);
    expect(v.__ltpAt).toBeGreaterThan(Date.now() - 2000);
  });
  it('flushManualState strips dunder runtime state (restores never serve stale __ltp)', () => {
    const { trade } = recordManualTrade({ market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1 });
    trade.__ltp = 104;
    trade.__ltpAt = Date.now();
    trade.__conviction = { state: 'HOLDING', at: Date.now() };
    (trade as any).__mfePct = 1.5;
    flushManualState();
    const disk = _disk.get('manual-trades.json') as { trades: Record<string, unknown>[] };
    const row = disk.trades.find((t) => (t as any).id === trade.id) as Record<string, unknown>;
    expect(Object.keys(row).some((k) => k.startsWith('__'))).toBe(false);
    expect(row.entryPrice).toBe(100); // real fields intact
  });
});

// ============================================================
describe('v18.6.4 — per-entry alert cooldowns', () => {
  beforeEach(() => { __resetManualStoreForTests(); });

  it('a 5m "sl" pass does not delete a 6h "t1" entry — both cooldowns honored', async () => {
    const { __monitorStateForTests } = await import('../server/ai/manualTrades.js');
    const send = vi.fn(async () => ({ ok: true }));
    const t = {
      market: 'INDIA', symbol: 'TCS', side: 'BUY', entryPrice: 100, qty: 1, status: 'OPEN', id: 1,
      openedAt: Date.now() - mins(1),
      origin: { plan: { entry: 100, stopLoss: 99.5, target1: 110, target2: 115, atr: 1 } },
    };
    const alerts = __monitorStateForTests().alerts as Map<string, unknown>;
    // a 't1' push went out 10 min ago (6h cooldown) + an 'sl' pass 4 min ago (5m cooldown)
    alerts.set('t1:1', { ts: Date.now() - mins(10), cool: 6 * 60 * 60_000 });
    alerts.set('sl:1', { ts: Date.now() - mins(4), cool: 5 * 60_000 });
    // LTP 110 → target1 zone AND within 0.3×ATR of SL (adverse frame) — both alert kinds eligible
    await evaluateManualTradeAlerts(t as any, { send, conviction: { state: 'HOLDING' }, usdInr: 84 });
    expect(send).not.toHaveBeenCalled();           // BOTH still inside their own windows
    expect(alerts.has('t1:1')).toBe(true);          // the t1 entry SURVIVED the sl-era prune
  });
});
