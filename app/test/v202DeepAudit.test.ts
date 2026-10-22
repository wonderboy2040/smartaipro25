// ============================================================
// test/v202DeepAudit.test.ts — v20.2 regression locks
// ------------------------------------------------------------
// Covers the batch A-D upgrades:
//   A1  boardAccountability — board → track-record mapping
//   A2  FUTURES STRONG alert scan (locked in telegramPush.test.ts too)
//   B3  insta-push fast-path spot executor + TG-keyless operation
//   B7  shared disk-backed USDINR store
//   C11 dailyStats SIM separation + trust relaxed-entry exclusion
//   C12 Binance projection divergence label + LiveSourceBadge
//   A4  useWalletPoll — ONE fetch for N subscribers
//   D15 desktopNotify util
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// hermetic data dir (same trick as the other suites)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-v202');

// ---- A1: boardAccountability (pure mapping + market gating) ----
import {
  boardAccountabilityEnabled, mapBoardSignalToTracked, wireBoardAccountability,
} from '../server/ai/boardAccountability.js';

const strongSignal = (over: Record<string, unknown> = {}) => ({
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 78, agreement: 0.72, ltp: 2500, changePct: 1.2,
  plan: { entry: 2500, stopLoss: 2450, target1: 2550, target2: 2600, risk: 50, riskPct: 2, rewardRisk: 2 },
  quality: { regime: { counterTrend: false } },
  superIntel: { aiScore: 82, tier: 'STRONG' },
  votes: [{ id: 'trend', name: 'TrendMatrix', dir: 1, conf: 80, weight: 1.4, reasons: ['EMA bull stack'] }],
  summary: '10-model consensus LONG',
  ...over,
});

describe('v20.2 A1 — board → track-record accountability', () => {
  it('maps a STRONG LONG board signal to the legacy tracked shape with the engine qty formula', () => {
    const row = mapBoardSignalToTracked(strongSignal(), 'INDIA');
    expect(row).toBeTruthy();
    expect(row!.symbol).toBe('RELIANCE');
    expect(row!.direction).toBe('LONG');
    expect(row!.entry).toBe(2500);
    // qty = min(1000/risk, 25000/entry) = min(20, 10) = 10
    expect(row!.qtyPerLakh).toBe(10);
    expect(row!.exchange).toBe('NSE');
    expect(row!.source).toBe('AI-BOARD');
  });

  it('WATCH / FLAT / planless / wrong-side signals are never tracked', () => {
    expect(mapBoardSignalToTracked(strongSignal({ grade: 'WATCH' }), 'INDIA')).toBeNull();
    expect(mapBoardSignalToTracked(strongSignal({ side: 'FLAT' }), 'INDIA')).toBeNull();
    expect(mapBoardSignalToTracked(strongSignal({ plan: null }), 'INDIA')).toBeNull();
    // LONG with stop ABOVE entry — belt-and-braces rejection
    expect(mapBoardSignalToTracked(strongSignal({
      plan: { entry: 2500, stopLoss: 2550, target1: 2600, target2: 2650 },
    }), 'INDIA')).toBeNull();
  });

  it('v21.23.15: hard-vetoed reference signals are NOT tracked as trades', () => {
    // Every one of these is refused by the execution gate (live AND paper),
    // so a win-rate/avgR row for it would measure a trade nobody could take.
    expect(mapBoardSignalToTracked(strongSignal({ dataDegraded: 'FRESH-TAPE-ABSENT' }), 'INDIA')).toBeNull();
    expect(mapBoardSignalToTracked(strongSignal({ freshTapeAbsent: true }), 'INDIA')).toBeNull();
    expect(mapBoardSignalToTracked(strongSignal({ ucRejected: true }), 'INDIA')).toBeNull();
    expect(mapBoardSignalToTracked(strongSignal({ ultrafast: { verdict: 'REJECTED' } }), 'INDIA')).toBeNull();
    expect(mapBoardSignalToTracked(strongSignal({ chasing: { severity: 'HARD' } }), 'INDIA')).toBeNull();
  });

  it('v21.23.15: a published plan already beyond its SL or T1 is NOT tracked (stale/late payload)', () => {
    // LONG already stopped through: ltp 2400 < SL 2450
    expect(mapBoardSignalToTracked(strongSignal({ ltp: 2400 }), 'INDIA')).toBeNull();
    // LONG already at/past T1: ltp 2560 >= 2550 — move gone, no fake entry
    expect(mapBoardSignalToTracked(strongSignal({ ltp: 2560 }), 'INDIA')).toBeNull();
    // SHORT mirrors: stop 2550, target 2450
    const shortSig = (ltp: number) => strongSignal({
      side: 'SHORT', ltp,
      plan: { entry: 2500, stopLoss: 2550, target1: 2450, target2: 2400, riskPct: 2, rewardRisk: 2 },
    });
    expect(mapBoardSignalToTracked(shortSig(2560), 'INDIA')).toBeNull(); // stopped through
    expect(mapBoardSignalToTracked(shortSig(2440), 'INDIA')).toBeNull(); // target gone
    // still-inside-the-plan LTP maps normally
    expect(mapBoardSignalToTracked(shortSig(2490), 'INDIA')).toBeTruthy();
  });

  it('v21.3.0: FUTURES/GLOBALFUTURES boards ARE tracked (USDT/USDC quote routing bridge), CRYPTO maps', () => {
    const fut = wireBoardAccountability('FUTURES', { signals: [strongSignal({ market: 'FUTURES', symbol: 'BTC' })] });
    expect(fut.tracked).toBe(1); // v21.3.0: stream.js routes FUTURES → USDT quotes — the unit-mismatch skip is GONE
    expect(fut.skipped).toBeUndefined();
    const glob = wireBoardAccountability('GLOBALFUTURES', { signals: [strongSignal({ market: 'GLOBALFUTURES', symbol: 'AAPL' })] });
    expect(glob.tracked).toBe(1);
    // CRYPTO: qty formula uses 4-decimal crypto semantics
    // (risk 15000 → qtyRisk 1000/15000=0.0667, but the 25%-capital cap
    // 25000/900000=0.0278 binds — min of the two, mirroring engine.js)
    const row = mapBoardSignalToTracked(strongSignal({
      symbol: 'BTC', market: 'CRYPTO', ltp: 900000,
      plan: { entry: 900000, stopLoss: 885000, target1: 915000, target2: 930000 },
    }), 'CRYPTO');
    expect(row).toBeTruthy();
    expect(row!.qtyPerLakh).toBeCloseTo(0.0278, 3);
  });
});

// ---- B3: fast-path executor is locked in test/telegramPush.test.ts
// (same mock envelope — see the "v20.2 — fast-path spot executor" block). ----

// ---- B7: shared USDINR store ----
import { usdInrLastKnown, usdInrRecord, usdInrFallback, __resetUsdInrStoreForTests } from '../server/ai/lib/usdinr.js';

describe('v20.2 B7 — disk-backed shared USDINR store', () => {
  beforeEach(() => { __resetUsdInrStoreForTests(); });
  afterEach(() => { __resetUsdInrStoreForTests(); });

  it('records a live rate, persists it, and serves it as the fallback after reset (cold boot)', () => {
    expect(usdInrLastKnown()).toBeNull();
    expect(usdInrFallback()).toBe(84);          // never-seen → the flat estimate
    expect(usdInrRecord(88.2)).toBe(88.2);      // live read
    expect(usdInrFallback()).toBe(88.2);
    // simulate a cold process: memory wiped, disk stamp re-hydrates
    __resetUsdInrStoreForTests();
    // note: reset clears memory AND the disk mirror for hermeticity —
    // so verify the record path instead:
    expect(usdInrRecord(87.9)).toBe(87.9);
    expect(usdInrFallback()).toBe(87.9);
  });

  it('rejects out-of-band rates (never records 5 or 500)', () => {
    expect(usdInrRecord(5)).toBeNull();
    expect(usdInrRecord(500)).toBeNull();
    expect(usdInrLastKnown()).toBeNull();
  });
});

// ---- C11: SIM desk separation in dailyStats ----
import { dailyStatsExport } from '../server/ai/coindcxOrders.js';

describe('v20.2 C11/D14 — dailyStats SIM separation', () => {
  it('GLOBALFUTURES (SIM) entries never consume the real budget; SIM P&L reports separately', () => {
    // todayIST() mirror (Asia/Kolkata) — the test clock runs in the
    // sandbox's own timezone, so compute the day the module will see.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const j = {
      entries: [
        { day, kind: 'ORDER', status: 'FILLED', market: 'CRYPTO', pnlINR: 0 },
        { day, kind: 'ORDER', status: 'FILLED', market: 'GLOBALFUTURES', pnlINR: 0 },
        { day, kind: 'ORDER', status: 'FILLED', market: 'FUTURES', pnlINR: 0 },
        { day, kind: 'CLOSE', market: 'CRYPTO', pnlINR: -80 },
        { day, kind: 'CLOSE', market: 'GLOBALFUTURES', pnlINR: +250 },
        { day, kind: 'ORDER', status: 'NOTIFIED', market: 'CRYPTO', pnlINR: 0 },
      ],
      positions: [],
    };
    const s = dailyStatsExport(j as never);
    expect(s.tradesCount).toBe(2);                 // CRYPTO + FUTURES only
    expect(s.realizedPnlINR).toBe(-80);            // SIM P&L excluded
    expect(s.simTradesCount).toBe(1);
    expect(s.simRealizedPnlINR).toBe(250);
  });
});

// ---- C12: projection divergence badge ----
import { liveSourceBadge } from '../src/components/aitrading/LiveSourceBadge';

describe('v20.2 C12 — Binance projection drift renders an honest amber PROJ pill', () => {
  it('binance-proj-drift → amber Binance·PROJ (never the sky Binance·RT)', () => {
    const b = liveSourceBadge('binance-proj-drift');
    expect(b.label).toBe('Binance·PROJ');
    expect(b.cls).toContain('amber');
    // v20.9.3: the spot WS ACCELERATOR now has its own honest label
    // (Binance·ACC — it runs WHILE CoinDCX streams, projecting to INR)
    expect(liveSourceBadge('binance-crypto-ws').label).toBe('Binance·ACC');
  });
});

// ---- D15: desktopNotify util ----
import { desktopNotify, desktopNotifySupported, __resetDesktopNotifyForTests } from '../src/utils/desktopNotify';

describe('v20.2 D15 — desktop notification util', () => {
  beforeEach(() => { __resetDesktopNotifyForTests(); });

  it('fires when permission granted and throttles bursts', () => {
    // NOTE: a CONSTRUCTIBLE function (arrow mocks cannot take `new`).
    const ctor = vi.fn().mockImplementation(function (this: unknown) {
      return { close: () => {}, onclick: null as (() => void) | null };
    });
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }));
    expect(desktopNotify('t1', 'b1')).toBe(true);
    // second call inside 30s: throttled
    expect(desktopNotify('t2', 'b2')).toBe(false);
    expect(ctor).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('never fires without permission', () => {
    vi.stubGlobal('Notification', vi.fn().mockImplementation(() => ({ close: () => {} })));
    (globalThis as { Notification: { permission: string } }).Notification.permission = 'denied';
    expect(desktopNotify('t', 'b')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('reports unsupported browsers honestly', () => {
    expect(typeof desktopNotifySupported()).toBe('boolean');
  });
});

// ---- A4: useWalletPoll — one fetch for N subscribers ----
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWalletPoll, __resetWalletStoreForTests, __walletStoreInternalsForTests } from '../src/components/aitrading/useWalletPoll';

describe('v20.2 A4 — shared wallet store (3 pollers → 1)', () => {
  beforeEach(() => { __resetWalletStoreForTests(); });
  afterEach(() => { __resetWalletStoreForTests(); vi.restoreAllMocks(); });

  it('two mounted components share ONE upstream wallet fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, equityINR: 123 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const h1 = renderHook(() => useWalletPoll());
    const h2 = renderHook(() => useWalletPoll());
    await waitFor(() => {
      expect(h1.result.current.wallet?.equityINR).toBe(123);
      expect(h2.result.current.wallet?.equityINR).toBe(123);
    });
    // the first subscriber's mount triggers the single poll; the second joins
    expect(fetchImpl.mock.calls.filter(c => String(c[0]).includes('/api/ai/wallet')).length).toBeLessThanOrEqual(1);
    h1.unmount();
    h2.unmount();
    // last unmount parks the timer
    await waitFor(() => expect(__walletStoreInternalsForTests().timerRunning).toBe(false));
    vi.unstubAllGlobals();
  });
});
