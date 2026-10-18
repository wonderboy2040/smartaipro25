// ============================================================
// test/telegramPush.test.ts — v10.9 INSTANT PUSH + #7 BUNDLING
// ------------------------------------------------------------
// Pins: level-touch detection (SL/TP1/TP2/LIQ, long + short),
// cooldown gating, message formats, correlation bundling
// (union-find, unknown-r honesty, rMax), the shared STRONG scan
// (bundled CRYPTO pushes + per-signal INDIA + dedupe between the
// sink and the backup alerter), and the status heartbeat.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPositions = vi.fn(async () => ({ positions: [] }));
const mockConfig = vi.fn(() => ({ killSwitch: false }));
const mockSend = vi.fn(async () => ({ ok: true }));
const mockPaperSummary = vi.fn(() => ({ open: [] }));
const mockManualList = vi.fn(() => []);
let pairRCalls = [];

vi.mock('../server/ai/coindcxOrders.js', () => ({
  getPositionsWithPnl: () => mockPositions(),
  loadConfig: () => mockConfig(),
}));

// v10.14 (deep-recheck S4): the India Intraday paper desk is mocked at the
// store boundary — the adapter + detection + push path stays real.
vi.mock('../server/intraday/paperTrading.js', () => ({
  getPaperSummary: () => mockPaperSummary(),
}));

const mockTgCfg = vi.fn(() => ({ token: 'T', chatId: 'C', source: 'env' }));
vi.mock('../server/ai/secrets.js', () => ({
  // v20.3: mockable resolver — env-only deployments (no app secrets)
  // resolve keys ONLY when the env is passed through, mirroring the real
  // telegramConfig contract.
  telegramConfig: (env) => mockTgCfg(env),
  sendTelegramMessage: (...a) => mockSend(...a),
  // v21.0: delivery-health counters (24h sent/failed view)
  telegramDeliveryHealth: () => ({ sent24h: 0, failed24h: 0, lastError: null, lastErrorAt: null, healthy: true }),
}));

vi.mock('../server/ai/correlation.js', () => ({
  pairCorrelation: (a, b) => {
    pairRCalls.push([a, b]);
    const table = { 'BTC|ETH': 0.86, 'ETH|SOL': 0.78, 'BTC|SOL': null };
    const key = [a, b].sort().join('|');
    return Promise.resolve(table[key] ?? null);
  },
}));

// v10.16 (S2): the manual-trade desk is mocked at the SAME boundary
// (listManualTrades = the store) — the adapter + detection + push path
// stays REAL. manualTrades' own imports (store/backup/liveFeed) are
// mocked so importing the real module does zero disk IO here.
vi.mock('../server/lib/store.js', () => ({
  loadJSON: (f, d) => d,
  saveJSON: vi.fn(),
}));
// v12.7: manualTrades (imported via importOriginal below) now reads
// restoreBackup + backupConfigured at module eval (the encrypted durable
// boot restore) and durablePut/decryptJSON — the mock factory must
// provide them or the real module body throws on import.
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
vi.mock('../server/liveFeed.js', () => ({ getTick: () => null }));
vi.mock('../server/ai/manualTrades.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listManualTrades: (o) => mockManualList(o) };
});

import {
  detectLevelTouches, cooldownOk, formatLevelTouch, formatStrongSignal, formatStrongBundle,
  groupCorrelatedSignals, scanStrongSignalsBackup, instaPushStatus, instantPushEnabled,
  paperTradesToPositionRows,
  __mapsForTests, __resetInstaPushForTests, __tickForTests, __statusForTests, __setFastWatchForTests,
} from '../server/ai/telegramPush.js';

const P = (o) => ({
  id: 'p1', pair: 'BTCUSDT', market: 'CRYPTO', side: 'LONG', status: 'OPEN',
  ltp: 100, sl: null, tp: null, tp2: null, tp1Hit: false, tp2Hit: false,
  liquidation: null, leverage: 1, unrealizedPnlINR: 0, ...o,
});

beforeEach(() => {
  __resetInstaPushForTests();
  mockSend.mockClear();
  mockPositions.mockClear();
  mockConfig.mockClear();
  mockPaperSummary.mockClear();
  mockPaperSummary.mockImplementation(() => ({ open: [] }));
  mockManualList.mockClear();
  mockManualList.mockImplementation(() => []);
  pairRCalls = [];
});

// ============================================================
// level-touch detection (pure)
// ============================================================
describe('detectLevelTouches', () => {
  it('LONG: SL touched when ltp <= sl, TP when ltp >= tp', () => {
    const t = detectLevelTouches([P({ ltp: 90, sl: 92 })]);
    expect(t.map(x => x.kind)).toEqual(['SL']);
    const t2 = detectLevelTouches([P({ ltp: 112, tp: 110, tp2: 120 })]);
    expect(t2.map(x => x.kind)).toEqual(['TP1']);
  });
  it('SHORT: sides invert (sl above, tp below)', () => {
    const t = detectLevelTouches([P({ side: 'SHORT', ltp: 108, sl: 105 })]);
    expect(t.map(x => x.kind)).toEqual(['SL']);
    const t2 = detectLevelTouches([P({ side: 'SHORT', ltp: 88, tp: 92 })]);
    expect(t2.map(x => x.kind)).toEqual(['TP1']);
  });
  it('LIQ only when leverage > 1', () => {
    expect(detectLevelTouches([P({ leverage: 1, liquidation: 50, ltp: 40 })])).toEqual([]);
    const t = detectLevelTouches([P({ leverage: 5, liquidation: 50, ltp: 40 })]);
    expect(t.map(x => x.kind)).toEqual(['LIQ']);
  });
  it('TP1 skipped once already hit; TP2 reported separately', () => {
    const t = detectLevelTouches([P({ ltp: 125, tp: 110, tp2: 120, tp1Hit: true })]);
    expect(t.map(x => x.kind)).toEqual(['TP2']);
  });
  it('ignores non-OPEN positions, bad numbers, and empty input', () => {
    expect(detectLevelTouches([P({ status: 'CLOSED', ltp: 50, sl: 90 })])).toEqual([]);
    expect(detectLevelTouches([P({ ltp: 0, sl: 90 })])).toEqual([]);
    expect(detectLevelTouches(null)).toEqual([]);
  });
});

// ============================================================
// cooldown + formats (pure)
// ============================================================
describe('cooldown + formats', () => {
  it('cooldownOk honours the window', () => {
    const m = new Map([['k', Date.now() - 29 * 60_000]]);
    expect(cooldownOk(m, 'k')).toBe(false);
    expect(cooldownOk(m, 'other')).toBe(true);
    const old = new Map([['k', Date.now() - 31 * 60_000]]);
    expect(cooldownOk(old, 'k')).toBe(true);
  });
  it('level-touch message names the level + pair + early-warning contract', () => {
    const txt = formatLevelTouch({ id: 1, pair: 'BTCUSDT', market: 'FUTURES', side: 'LONG', kind: 'SL', level: 90000, ltp: 89950, unrealizedPnlINR: -120, leverage: 3 });
    expect(txt).toMatch(/INSTANT — STOP-LOSS TOUCHED/);
    expect(txt).toMatch(/BTCUSDT/);
    expect(txt).toMatch(/3x/);
    expect(txt).toMatch(/early warning/);
  });
  it('STRONG message keeps the LEGACY format (one format, both paths)', () => {
    const txt = formatStrongSignal({ symbol: 'BTC', side: 'LONG', confidence: 84, agreement: 0.8, participating: 9, totalModels: 14, plan: { entry: 100, stopLoss: 95, target2: 115, rewardRisk: 3 } }, 'CRYPTO');
    expect(txt).toMatch(/STRONG SIGNAL/);
    expect(txt).toMatch(/Confidence 84%/);
    expect(txt).toMatch(/9\/14 models/);
  });
  it('bundle message names every symbol + the diversify warning', () => {
    const txt = formatStrongBundle([
      { symbol: 'BTC', side: 'LONG', confidence: 84, participating: 9, totalModels: 14, plan: { entry: 1, stopLoss: 1, target2: 2 } },
      { symbol: 'ETH', side: 'LONG', confidence: 81, participating: 8, totalModels: 14 },
    ], 'CRYPTO', 0.86);
    expect(txt).toMatch(/2 correlated moves/);
    expect(txt).toMatch(/<b>BTC<\/b>/);
    expect(txt).toMatch(/<b>ETH<\/b>/);
    expect(txt).toMatch(/ek hi trade hai/);
  });
  it('feature flag reverts cleanly', () => {
    expect(instantPushEnabled()).toBe(true); // default ON
    const prev = process.env.AI_INSTANT_PUSH;
    process.env.AI_INSTANT_PUSH = 'off';
    expect(instantPushEnabled()).toBe(false);
    process.env.AI_INSTANT_PUSH = prev;
  });
});

// ============================================================
// #7 correlation bundling (pure, injected lookup)
// ============================================================
describe('groupCorrelatedSignals', () => {
  const S = (sym) => ({ symbol: sym, side: 'LONG' });
  it('chains A-B + B-C into ONE cluster with rMax = the strongest link', async () => {
    const clusters = await groupCorrelatedSignals([S('BTC'), S('ETH'), S('SOL')], {
      lookup: async (a, b) => ({ 'BTC|ETH': 0.86, 'ETH|SOL': 0.78 }[[a, b].sort().join('|')] ?? null),
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].signals.map(s => s.symbol).sort()).toEqual(['BTC', 'ETH', 'SOL']);
    expect(clusters[0].rMax).toBe(0.86);
  });
  it('UNKNOWN correlation never fakes a 0 — pair stays separate', async () => {
    const clusters = await groupCorrelatedSignals([S('BTC'), S('DOGE')], { lookup: async () => null });
    expect(clusters).toHaveLength(2);
  });
  it('below-threshold pairs stay separate', async () => {
    const clusters = await groupCorrelatedSignals([S('BTC'), S('ETH')], { lookup: async () => 0.6, threshold: 0.75 });
    expect(clusters).toHaveLength(2);
  });
  it('lookup throwing is contained (separate)', async () => {
    const clusters = await groupCorrelatedSignals([S('A'), S('B')], { lookup: async () => { throw new Error('x'); } });
    expect(clusters).toHaveLength(2);
  });
  it('empty input → no clusters, no lookup calls', async () => {
    expect(await groupCorrelatedSignals([], { lookup: async () => 0.9 })).toEqual([]);
  });
});

// ============================================================
// the shared STRONG scan (sink + backup, one code path)
// ============================================================
describe('scanStrongSignalsBackup (the shared scan)', () => {
  const strong = (symbol, side = 'LONG') => ({
    symbol, side, grade: 'STRONG', confidence: 80, agreement: 0.7, participating: 8, totalModels: 14,
    plan: { entry: 1, stopLoss: 0.9, target2: 1.3, rewardRisk: 3 },
  });
  const mkDeps = (crypto, india) => ({
    getSignals: async (mkt) => ({ signals: mkt === 'CRYPTO' ? crypto : india }),
    depsForSignals: () => ({}),
  });

  it('two correlated CRYPTO strongs → ONE bundled push, both symbols marked in dedupe', async () => {
    const deps = mkDeps([strong('BTC'), strong('ETH')], []);
    const out = await scanStrongSignalsBackup(deps);
    expect(out.pushed).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatch(/2 correlated moves/);
    const { _strongAlerts } = __mapsForTests();
    expect(_strongAlerts.get('CRYPTO:BTC:LONG')).toBeTruthy();
    expect(_strongAlerts.get('CRYPTO:ETH:LONG')).toBeTruthy();
  });

  it('correlated + uncorrelated → one bundle + one single', async () => {
    const deps = mkDeps([strong('BTC'), strong('ETH'), strong('DOGE')], []);
    const out = await scanStrongSignalsBackup(deps);
    expect(out.pushed).toBe(2);
    const texts = mockSend.mock.calls.map(c => c[0]);
    expect(texts.some(t => /2 correlated moves/.test(t))).toBe(true);
    expect(texts.some(t => /STRONG SIGNAL.*DOGE/s.test(t))).toBe(true);
  });

  it('INDIA strongs stay per-signal (no bundling without an honest r)', async () => {
    const deps = mkDeps([], [strong('RELIANCE'), strong('TCS')]);
    // v20.2: default markets now include FUTURES; this test pins the
    // per-signal INDIA behaviour, so it passes the markets explicitly.
    const out = await scanStrongSignalsBackup({ ...deps, markets: ['INDIA'] });
    expect(out.pushed).toBe(2);
    expect(mockSend.mock.calls.every(c => /NSE/.test(c[0]))).toBe(true);
  });

  it('v20.2 — FUTURES strongs push too (the desk was missing from the alert loop)', async () => {
    const deps = {
      getSignals: async (mkt) => ({ signals: mkt === 'FUTURES' ? [strong('BTC')] : [] }),
      depsForSignals: () => ({}),
    };
    const out = await scanStrongSignalsBackup(deps);
    expect(out.pushed).toBe(1);
    expect(__mapsForTests()._strongAlerts.get('FUTURES:BTC:LONG')).toBeTruthy();
  });

  it('the DEDUPE makes the second scan silent (whichever path fired first wins)', async () => {
    const deps = mkDeps([strong('BTC'), strong('ETH')], []);
    await scanStrongSignalsBackup(deps);
    mockSend.mockClear();
    const out2 = await scanStrongSignalsBackup(deps); // the 60s alerter following the 30s sink
    expect(out2.pushed).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('kill switch ON → scan skipped entirely', async () => {
    mockConfig.mockReturnValueOnce({ killSwitch: true });
    const out = await scanStrongSignalsBackup(mkDeps([strong('BTC')], []));
    expect(out.pushed).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('v10.18: a FAILED send does not arm the full cooldown — the alert retries after the failure window', async () => {
    // One transient Telegram blip at the moment a STRONG fires used to
    // suppress that push for the whole STRONG_COOLDOWN window. Now the
    // full cooldown arms ONLY on success; a failure reserves a short
    // 30s retry hold instead.
    mockSend.mockImplementationOnce(async () => ({ ok: false, error: 'telegram blip' }));
    const deps = mkDeps([strong('ADA')], []);
    const out1 = await scanStrongSignalsBackup(deps);
    expect(out1.pushed).toBe(0);             // send failed — honestly not pushed
    expect(mockSend).toHaveBeenCalledTimes(1);
    const { _strongAlerts } = __mapsForTests();
    const reserved = _strongAlerts.get('CRYPTO:ADA:LONG');
    expect(reserved).toBeTruthy();           // reserved (no concurrent double-send)
    // immediate retry is held back by the reservation
    const out2 = await scanStrongSignalsBackup(deps);
    expect(out2.pushed).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
    // after the 30s failure window the scan re-attempts — and now succeeds
    const nowSpy = vi.spyOn(Date, 'now');
    const base = Date.now();
    nowSpy.mockReturnValue(base + 31_000);
    const out3 = await scanStrongSignalsBackup(deps);
    expect(out3.pushed).toBe(1);             // the alert was never lost
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(_strongAlerts.get('CRYPTO:ADA:LONG')).toBeGreaterThanOrEqual(base + 31_000); // FULL cooldown armed by the success
    nowSpy.mockRestore();
  });
});

// ============================================================
// v10.14 (deep-recheck S4) — India Intraday paper desk push parity
// ============================================================
describe('India Intraday paper desk — instant push parity', () => {
  const PT = (o = {}) => ({
    id: 7, symbol: 'RELIANCE', market: 'INDIA', direction: 'LONG',
    entry: 2500, stopLoss: 2450, target1: 2550, target2: 2600, status: 'OPEN',
    t1Hit: false, lastPrice: 2440, unrealizedPnl: -600, ...o,
  });

  it('paperTradesToPositionRows maps INDIA open rows onto the detector shape (crypto/closed skipped)', () => {
    const rows = paperTradesToPositionRows({
      open: [
        PT(),
        PT({ market: 'CRYPTO', symbol: 'BTC', lastPrice: 60000 }), // not the India desk
        PT({ status: 'CLOSED' }),
        PT({ status: 'PARTIAL', t1Hit: true }), // partial still watched
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'paper:7', pair: 'RELIANCE', side: 'LONG', sl: 2450, tp: 2550, paper: true });
    expect(rows[1].tp1Hit).toBe(true);
  });

  it('an SL touch on an India paper trade fires the SAME push path (PAPER tagged)', async () => {
    mockPaperSummary.mockImplementationOnce(() => ({ open: [PT()] })); // lastPrice 2440 <= sl 2450
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const txt = mockSend.mock.calls[0][0];
    expect(txt).toMatch(/STOP-LOSS TOUCHED/);
    expect(txt).toMatch(/RELIANCE/);
    expect(txt).toMatch(/PAPER/);
    expect(txt).toMatch(/India Intraday desk/);
    expect(__statusForTests().paperPushes).toBe(1);
    // dedupe: the 30-min cooldown makes the next tick silent
    mockPaperSummary.mockImplementationOnce(() => ({ open: [PT()] }));
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('TP1 on the India desk pushes too (target1 mapping, option label as pair)', async () => {
    mockPaperSummary.mockImplementationOnce(() => ({
      open: [PT({ lastPrice: 2560, label: 'Nifty50 16Sep 23400 CE' })],
    }));
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const txt = mockSend.mock.calls[0][0];
    expect(txt).toMatch(/TARGET-1 TOUCHED/);
    expect(txt).toMatch(/23400 CE/);
  });

  it('a broken paper store NEVER breaks the CoinDCX push path', async () => {
    mockPaperSummary.mockImplementationOnce(() => { throw new Error('paper store gone'); });
    mockPositions.mockImplementationOnce(async () => ({
      positions: [P({ ltp: 90, sl: 92 })], // CoinDCX SL touch — must still push
    }));
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatch(/BTCUSDT/);
    expect(__statusForTests().slTpPushes).toBe(1);
    expect(__statusForTests().lastError).toBeNull(); // contained — not a tick-level error
  });
});

// ============================================================
// v10.16 (S2) — the user's OWN manual trades: 5s level-touch parity
// ============================================================
describe('Manual trade desk — instant push parity', () => {
  const MT = (o = {}) => ({
    id: 3, symbol: 'RELIANCE', market: 'INDIA', side: 'BUY', status: 'OPEN',
    entryPrice: 2500, qty: 10,
    origin: { plan: { stopLoss: 2450, target1: 2550, target2: 2600 } },
    __ltp: 2440, ...o,
  });

  it('an SL touch on a manual trade fires the SAME push path (MANUAL tagged, honest footer)', async () => {
    mockManualList.mockImplementationOnce(() => [MT()]); // __ltp 2440 <= sl 2450
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const txt = mockSend.mock.calls[0][0];
    expect(txt).toMatch(/STOP-LOSS TOUCHED/);
    expect(txt).toMatch(/RELIANCE/);
    expect(txt).toMatch(/MANUAL/);
    expect(txt).toMatch(/aapka trade/);
    expect(txt).not.toMatch(/executor watcher/); // no executor watches a manual trade
    expect(__statusForTests().manualPushes).toBe(1);
    // dedupe: the 30-min cooldown makes the next tick silent
    mockManualList.mockImplementationOnce(() => [MT()]);
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('T2 touch pushes with the native ₹ uP&L for India rows (INR domain)', async () => {
    mockManualList.mockImplementationOnce(() => [MT({ __ltp: 2605 })]); // T1 2550 AND T2 2600 both touched
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(2); // TP1 + TP2 — both levels crossed
    const txt = mockSend.mock.calls[1][0];
    expect(txt).toMatch(/TARGET-2 TOUCHED/);
    expect(txt).toMatch(/unrealized ₹/); // (2605−2500)×10 = +1050
    expect(mockSend.mock.calls[0][0]).toMatch(/TARGET-1 TOUCHED/);
  });

  it('USDT-domain manual rows push WITHOUT a guessed ₹ conversion (honest omission)', async () => {
    mockManualList.mockImplementationOnce(() => [MT({ market: 'FUTURES', symbol: 'SOL', __ltp: 19.5 })]);
    // plan sl 2450 → SOL at 19.5 is below it → SL fires for the LONG
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const txt = mockSend.mock.calls[0][0];
    expect(txt).toMatch(/STOP-LOSS TOUCHED/);
    expect(txt).not.toMatch(/unrealized ₹/);
  });

  it('a broken manual store NEVER breaks the CoinDCX + paper push paths', async () => {
    mockManualList.mockImplementationOnce(() => { throw new Error('manual store gone'); });
    mockPositions.mockImplementationOnce(async () => ({ positions: [P({ ltp: 90, sl: 92 })] }));
    await __tickForTests();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatch(/BTCUSDT/);
    expect(__statusForTests().slTpPushes).toBe(1);
    expect(__statusForTests().lastError).toBeNull(); // contained — not a tick-level error
  });
});

// ============================================================
// status heartbeat (the legacy bot consults this)
// ============================================================
describe('instaPushStatus', () => {
  it('reports the pipeline contract', () => {
    const st = instaPushStatus();
    expect(st.ok).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.healthy).toBe(false); // never polled — honest
    expect(typeof st.note).toBe('string');
  });
});

// ============================================================
// v20.2 — FAST-PATH SPOT EXECUTOR (B3): a level touch on a live
// SPOT (CRYPTO-market) position fires the injected watcher NOW —
// the 60s watcher stays the backstop. INDIA-market touches must
// NOT fire it (the India desks keep their own monitors).
// ============================================================
describe('v20.2 — fast-path spot executor', () => {
  it('a CRYPTO SL touch fires the injected fast watcher immediately', async () => {
    const fastWatch = vi.fn(async () => ([{ pair: 'BTCINR', pnlINR: -12 }]));
    __setFastWatchForTests(fastWatch);
    mockPositions.mockImplementation(async () => ({
      positions: [P({ pair: 'BTCINR', market: 'CRYPTO', ltp: 90, sl: 95, unrealizedPnlINR: -25 })],
    }));
    await __tickForTests();
    expect(fastWatch).toHaveBeenCalledTimes(1);
  });

  it('an INDIA-market touch does NOT fire the spot fast-watcher', async () => {
    const fastWatch = vi.fn(async () => ([]));
    __setFastWatchForTests(fastWatch);
    mockPositions.mockImplementation(async () => ({
      positions: [P({ pair: 'RELIANCE', market: 'INDIA', ltp: 2440, sl: 2450, unrealizedPnlINR: -100 })],
    }));
    await __tickForTests();
    expect(fastWatch).not.toHaveBeenCalled();
  });

  it('the 10s min-gap guard collapses a touch burst into ONE watcher call', async () => {
    const fastWatch = vi.fn(async () => ([{ pair: 'BTCINR' }]));
    __setFastWatchForTests(fastWatch);
    mockPositions.mockImplementation(async () => ({
      positions: [P({ pair: 'BTCINR', market: 'CRYPTO', ltp: 89, sl: 95 })],
    }));
    await __tickForTests();
    await __tickForTests();
    await __tickForTests();
    expect(fastWatch).toHaveBeenCalledTimes(1);
  });
});


// ============================================================
// v20.3 — ENV-ONLY TG KEYS (the silent "keyless" outage fix)
// ------------------------------------------------------------
// telegramConfig({}) resolves SECRETS only. The sink + backup alerter
// used to call it with an empty env, so a deployment configured via
// TG_TOKEN/TG_CHAT_ID (no app secrets) silently ran the keyless path:
// zero 5s level pushes, zero STRONG scans — while watcher close
// messages (which pass the env through) kept arriving.
// ============================================================
describe('v20.3 — env-only TG keys reach the instant-push paths', () => {
  afterEach(() => {
    // restore the permissive default (secrets-configured deployments)
    mockTgCfg.mockImplementation(() => ({ token: 'T', chatId: 'C', source: 'env' }));
  });

  it('without tgEnv and without secrets → the backup scan honestly no-ops (keyless)', async () => {
    mockTgCfg.mockImplementation((env = {}) => (env?.token && env?.chatId ? { token: env.token, chatId: env.chatId, source: 'env' } : null));
    const strong = (symbol: string) => ({
      symbol, side: 'LONG', grade: 'STRONG', confidence: 80, agreement: 0.7,
      participating: 8, totalModels: 14, plan: { entry: 1, stopLoss: 0.9, target2: 1.3, rewardRisk: 3 },
    });
    const deps = {
      getSignals: async (mkt: string) => ({ signals: mkt === 'CRYPTO' ? [strong('BTC')] : [] }),
      depsForSignals: () => ({}),
    };
    const out = await scanStrongSignalsBackup(deps);
    expect(out.ok).toBe(false);
    expect(out.pushed).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('with tgEnv (TG_TOKEN/TG_CHAT_ID) → the SAME scan pushes (no keyless outage)', async () => {
    mockTgCfg.mockImplementation((env = {}) => (env?.token && env?.chatId ? { token: env.token, chatId: env.chatId, source: 'env' } : null));
    const strong = (symbol: string) => ({
      symbol, side: 'LONG', grade: 'STRONG', confidence: 80, agreement: 0.7,
      participating: 8, totalModels: 14, plan: { entry: 1, stopLoss: 0.9, target2: 1.3, rewardRisk: 3 },
    });
    const deps = {
      getSignals: async (mkt: string) => ({ signals: mkt === 'CRYPTO' ? [strong('BTC')] : [] }),
      depsForSignals: () => ({}),
    };
    const out = await scanStrongSignalsBackup({ ...deps, tgEnv: { token: 'T', chatId: 'C' } });
    expect(out.ok).toBe(true);
    expect(out.pushed).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatch(/STRONG SIGNAL.*BTC/s);
  });
});
