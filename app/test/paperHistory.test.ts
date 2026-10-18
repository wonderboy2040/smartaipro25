// ============================================================
// Paper-trade durable-history tests
//   • getPaperHistory — day grouping + accuracy stats
//   • restorePaperTrades — mirror merge / sanitize / stale-sqoff
//   • backup.js — GitHub Contents API push/restore (fetch mocked)
// Store + journal are mocked so tests never touch server/data/.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { istDayKey } from '../server/intraday/time.js';

vi.mock('../server/intraday/store.js', () => ({
  loadJSON: () => ({ trades: [], nextId: 1, dayKey: '' }),
  saveJSON: vi.fn(() => true),
  DATA_DIR: '/tmp/unused',
}));
vi.mock('../server/intraday/journal.js', () => ({
  recordTradeClose: vi.fn(),
}));

import {
  getPaperHistory, restorePaperTrades, getPaperSummary,
  openPaperTrade, _resetForTests,
} from '../server/intraday/paperTrading.js';
import { backupConfigured, scheduleBackup, restoreBackup } from '../server/intraday/backup.js';

const today = istDayKey();
const oldDay = '2000-01-01';

const trade = (id, over = {}) => ({
  id,
  symbol: 'SBIN',
  direction: 'LONG',
  entry: 800,
  qty: 10,
  stopLoss: 780,
  target1: 820,
  target2: 850,
  remainingQty: 0,
  t1Hit: false,
  status: 'CLOSED',
  openedAt: Date.now() - 3600_000,
  closedAt: Date.now() - 1800_000,
  closeReason: 'T2_HIT',
  realizedPnl: 500,
  unrealizedPnl: 0,
  lastPrice: 850,
  parts: [{ qty: 10, exitPrice: 850, ts: Date.now(), reason: 'T2_HIT' }],
  dayKey: today,
  capital: 8000,
  ...over,
});

beforeEach(() => {
  _resetForTests();
  delete process.env.GITHUB_BACKUP_TOKEN;
  delete process.env.GITHUB_BACKUP_REPO;
  delete process.env.GITHUB_BACKUP_BRANCH;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------- getPaperHistory ----------------
describe('getPaperHistory — accuracy audit stats', () => {
  it('groups closed trades by day (newest first) with per-day win/loss stats', () => {
    const yesterday = istDayKey(new Date(Date.now() - 2 * 24 * 3600_000));
    _resetForTests({
      trades: [
        trade(1, { dayKey: yesterday, realizedPnl: 500 }),
        trade(2, { dayKey: yesterday, symbol: 'TCS', realizedPnl: -200 }),
        trade(3, { dayKey: today, symbol: 'INFY', realizedPnl: 300 }),
      ],
      nextId: 4,
      dayKey: today,
    });
    const h = getPaperHistory(90);
    expect(h.totalClosed).toBe(3);
    expect(h.groups).toHaveLength(2);
    expect(h.groups[0].dayKey).toBe(today);
    expect(h.groups[1].dayKey).toBe(yesterday);
    expect(h.groups[1]).toMatchObject({ trades: 2, wins: 1, losses: 1, winRate: 50, realizedPnl: 300 });
  });

  it('computes overall stats: win-rate, avg W/L, profit factor, best/worst day', () => {
    _resetForTests({
      trades: [
        trade(1, { realizedPnl: 400, dayKey: today }),
        trade(2, { symbol: 'TCS', realizedPnl: -100, dayKey: today }),
        trade(3, { symbol: 'INFY', realizedPnl: -100, dayKey: today }),
      ],
      nextId: 4,
      dayKey: today,
    });
    const o = getPaperHistory(90).overall;
    expect(o.totalTrades).toBe(3);
    expect(o.wins).toBe(1);
    expect(o.losses).toBe(2);
    expect(o.winRate).toBeCloseTo(33.3, 1);
    expect(o.avgWin).toBe(400);
    expect(o.avgLoss).toBe(-100);
    expect(o.profitFactor).toBe(2);
    expect(o.totalPnl).toBe(200);
    expect(o.bestDay).toEqual({ dayKey: today, pnl: 200 });
    expect(o.worstDay).toEqual({ dayKey: today, pnl: 200 });
  });

  it('ignores OPEN trades and respects the days window', () => {
    _resetForTests({
      trades: [
        trade(1, { openedAt: Date.now() - 90 * 24 * 3600_000 - 3600_000, closedAt: Date.now() - 90 * 24 * 3600_000 }),
        trade(2, { status: 'OPEN', remainingQty: 10, closedAt: null, closeReason: null, realizedPnl: 0 }),
      ],
      nextId: 3,
      dayKey: today,
    });
    const h = getPaperHistory(30);
    expect(h.totalClosed).toBe(0);
    expect(h.groups).toHaveLength(0);
    expect(h.trades).toHaveLength(0);
  });

  it('empty state → zero stats without crashing', () => {
    const h = getPaperHistory(90);
    expect(h.overall).toMatchObject({ totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 });
    expect(h.overall.bestDay).toBeNull();
  });
});

// ---------------- restorePaperTrades ----------------
describe('restorePaperTrades — device mirror merge', () => {
  it('rebuilds wiped history from the mirror and bumps nextId', () => {
    _resetForTests({ trades: [], nextId: 1, dayKey: today });
    const r = restorePaperTrades({ trades: [trade(4), trade(7, { symbol: 'ITC' })] });
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(2);
    expect(r.summary.stats.totalRealizedPnl).toBe(1000);
    // next trade gets a fresh non-colliding id
    const opened = openPaperTrade({ symbol: 'HDFCBANK', direction: 'LONG', entry: 1500, stopLoss: 1480, target1: 1530, target2: 1560, qty: 5 });
    expect(opened.ok).toBe(true);
    expect(opened.trade.id).toBe(8);
  });

  it('server copy wins on id collision (merge-by-id, no duplicates)', () => {
    _resetForTests({ trades: [trade(1, { realizedPnl: 111 })], nextId: 2, dayKey: today });
    const r = restorePaperTrades({ trades: [trade(1, { realizedPnl: 999 }), trade(2, { symbol: 'ITC' })] });
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(1);
    const s = getPaperSummary();
    expect(s.stats.wins + s.stats.losses).toBe(2);
    expect(s.closedToday.find(t => t.id === 1)?.realizedPnl).toBe(111);
  });

  it('idempotent when the server already knows every mirror trade', () => {
    _resetForTests({ trades: [trade(1), trade(2, { symbol: 'ITC' })], nextId: 3, dayKey: today });
    const r = restorePaperTrades({ trades: [trade(1), trade(2, { symbol: 'ITC' })] });
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(0);
    expect(r.alreadyKnown).toBe(2);
  });

  it('sanitizes garbage: bad symbols/ids/qty skipped, valid ones kept', () => {
    _resetForTests({ trades: [], nextId: 1, dayKey: today });
    const r = restorePaperTrades({
      trades: [
        trade(1),
        { id: 'abc', symbol: 'SBIN', entry: 800, qty: 10 },
        trade(2, { symbol: 'BAD SYM X!', entry: 800, qty: 10 }),
        trade(3, { entry: 0, qty: 10 }),
        trade(4, { qty: 0 }),
        'not-an-object',
        null,
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(1);
  });

  it('stale OPEN trades from a previous day are squared off (STALE_SQOFF)', () => {
    _resetForTests({ trades: [], nextId: 1, dayKey: today });
    const r = restorePaperTrades({
      trades: [trade(5, {
        dayKey: oldDay, status: 'OPEN', remainingQty: 10,
        closedAt: null, closeReason: null, realizedPnl: 0,
        lastPrice: 812, closeReasonX: undefined,
      })],
    });
    expect(r.ok).toBe(true);
    const s = getPaperSummary();
    expect(s.open).toHaveLength(0);
    const t = getPaperHistory(365).trades[0];
    expect(t.closeReason).toBe('STALE_SQOFF');
    expect(t.realizedPnl).toBeCloseTo(120, 1); // (812-800)*10
  });

  it('rejects an empty/invalid payload with a 400-style error', () => {
    expect(restorePaperTrades({}).error).toBeTruthy();
    expect(restorePaperTrades({ trades: [] }).error).toBeTruthy();
    expect(restorePaperTrades(null).error).toBeTruthy();
  });
});

// ---------------- backup.js ----------------
describe('backup.js — GitHub durable storage', () => {
  it('is a silent no-op when unconfigured', async () => {
    expect(backupConfigured()).toBe(false);
    expect(() => scheduleBackup('paper-trades.json', { trades: [] })).not.toThrow();
    expect(await restoreBackup('paper-trades.json')).toBeNull();
  });

  it('validates repo shape before activating', () => {
    process.env.GITHUB_BACKUP_TOKEN = 't';
    process.env.GITHUB_BACKUP_REPO = 'not-a-repo-slash';
    expect(backupConfigured()).toBe(false);
    process.env.GITHUB_BACKUP_REPO = 'user/repo';
    expect(backupConfigured()).toBe(true);
  });

  it('restoreBackup parses the base64 blob from the data-backup branch', async () => {
    process.env.GITHUB_BACKUP_TOKEN = 'tok';
    process.env.GITHUB_BACKUP_REPO = 'user/repo';
    const payload = { trades: [{ id: 1, symbol: 'SBIN' }], nextId: 2 };
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await restoreBackup('paper-trades.json');
    expect(out).toEqual(payload);
    expect(String(fetchMock.mock.calls[0][0])).toContain('contents/backups%2Fpaper-trades.json');
  });

  it('restoreBackup returns null on 404 (nothing backed up yet)', async () => {
    process.env.GITHUB_BACKUP_TOKEN = 'tok';
    process.env.GITHUB_BACKUP_REPO = 'user/repo';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await restoreBackup('paper-trades.json')).toBeNull();
  });
});
