// ============================================================
//  v20.8.5 — AUTO TRADE TP EXITS + ENTRY-GATE UNBLOCK + WALLET
//  LATENCY fixes (user report: "auto trade me lag nahi raha hai,
//  auto entry aur auto profit TP 1 or TP 2 pe profit book karke
//  exit nhi ho raha hai, already tick hai bta raha hai, futures
//  wallet bhi bahut late read kar raha hai")
//
//  Covers:
//   A. proTraderTpCheck pure fn — TP1 tiered / TP2 full / single-
//      target / gap-past-both / disabled / no-tp guards
//   B. proTraderLockBreakeven — favorable-direction ratchet only
//   C. PAPER E2E: entry → TP1 partial book + BE-lock → TP2 FULL
//      exit with honest total PnL (booked + final leg)
//   D. Gate migration: saved 90 (old unreachable default) → 70
//   E. proTraderStart alreadyRunning honesty ("already tick")
//   F. walletSnapshot 10s mini-cache + force bypass
//   G. Source contracts — watcher 30s + fresh 5s prices, agent
//      read-fail last-known margin fallback, useWalletPoll 25s,
//      reconnect force-bypass
// ============================================================
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// isolate the data dir BEFORE any server import (store.js resolves at import)
process.env.SMARTAI_DATA_DIR = path.join(os.tmpdir(), `v2085-tp-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.SMARTAI_DATA_DIR, { recursive: true });

// ---- mocks (hoisted; factories self-contained) ----
vi.mock('../server/ai/signals.js', () => ({
  getSignals: vi.fn(async (market: string) => ({
    ok: true, market, marketOpen: true,
    signals: [{
      symbol: 'BTC', market, side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 101, executable: true,
      plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
      superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
    }],
  })),
}));
vi.mock('../server/ai/browserAgent.js', () => ({
  browserConnect: vi.fn(async () => ({ connected: false, tabs: {} })),
  browserStatus: vi.fn(() => ({ connected: false, tabs: {}, lastError: null })),
  cxPairUrl: vi.fn((pair: string, product: string = 'futures') =>
    product === 'spot' ? `https://coindcx.com/trade/${pair}` : `https://coindcx.com/futures/${pair}`),
  cxEnsureTradePage: vi.fn(async () => { throw new Error('no browser'); }),
  cxSelectPair: vi.fn(async () => ({ ok: false })),
  cxPlaceOrder: vi.fn(async () => ({ ok: false })),
  cxClosePosition: vi.fn(async () => ({ ok: false })),
  cxReadPositions: vi.fn(async () => ({ ok: true, positions: [] })),
  dhanEnsurePage: vi.fn(async () => { throw new Error('no browser'); }),
  dhanSelectScrip: vi.fn(async () => ({ ok: false })),
  dhanPlaceOrder: vi.fn(async () => ({ ok: false })),
  dhanClosePosition: vi.fn(async () => ({ ok: false })),
}));

const {
  PROTRADER_DEFAULTS, proTraderTpCheck, proTraderLockBreakeven,
  loadProTraderConfig, updateProTraderConfig, proTraderStart, proTraderStop,
  proTraderStatusView, proTraderTick,
} = await import('../server/ai/proTraderAuto.js');
const { saveJSON } = await import('../server/lib/store.js');

// ============================================================
// A. proTraderTpCheck — the PURE TP verdict
// ============================================================
describe('A. proTraderTpCheck (v20.8.5 TP profit-booking verdict)', () => {
  const trade = { side: 'LONG', tp: 112, tp2: 120, entryPrice: 100 };

  it('TP1 hit (tiered plan) → tp1 leg, NOT full exit', () => {
    const r = proTraderTpCheck({ trade, ltp: 112.5, cfg: PROTRADER_DEFAULTS });
    expect(r.tp1).toBe(true);
    expect(r.tpFull).toBe(false);
    expect(r.tp1Price).toBe(112);
    expect(r.tp2Price).toBe(120);
  });
  it('TP2 hit → FULL exit (profit booked)', () => {
    const r = proTraderTpCheck({ trade, ltp: 120, cfg: PROTRADER_DEFAULTS });
    expect(r.tpFull).toBe(true);
    expect(r.fullWhy).toContain('TP2 TARGET');
    expect(r.tp1).toBe(false);
  });
  it('gap past BOTH in one pass → TP2 wins (full book at the better price)', () => {
    const r = proTraderTpCheck({ trade, ltp: 131, cfg: PROTRADER_DEFAULTS });
    expect(r.tpFull).toBe(true);
    expect(r.fullWhy).toContain('TP2 TARGET');
  });
  it('tp1Hit already stamped → TP1 re-fire nahi hota (runner TP2 tak)', () => {
    const r = proTraderTpCheck({ trade: { ...trade, tp1Hit: true }, ltp: 113, cfg: PROTRADER_DEFAULTS });
    expect(r.tp1).toBe(false);
    expect(r.tpFull).toBe(false);
  });
  it('SHORT mirror: price <= tp hit hota hai', () => {
    const short = { side: 'SHORT', tp: 88, tp2: 84, entryPrice: 95 };
    expect(proTraderTpCheck({ trade: short, ltp: 88, cfg: PROTRADER_DEFAULTS }).tp1).toBe(true);
    expect(proTraderTpCheck({ trade: short, ltp: 90, cfg: PROTRADER_DEFAULTS }).tp1).toBe(false);
    expect(proTraderTpCheck({ trade: short, ltp: 84, cfg: PROTRADER_DEFAULTS }).tpFull).toBe(true);
  });
  it('single-target plan (tp1 only) → TP1 = FULL exit', () => {
    const r = proTraderTpCheck({ trade: { side: 'LONG', tp: 112, tp2: 0, entryPrice: 100 }, ltp: 112, cfg: PROTRADER_DEFAULTS });
    expect(r.tpFull).toBe(true);
    expect(r.fullWhy).toContain('single-target');
  });
  it('tpExitsEnabled OFF → kuch nahi hota (reversal/SL hi exits rahenge)', () => {
    const r = proTraderTpCheck({ trade, ltp: 125, cfg: { ...PROTRADER_DEFAULTS, tpExitsEnabled: false } });
    expect(r.enabled).toBe(false);
    expect(r.tp1).toBe(false);
    expect(r.tpFull).toBe(false);
  });
  it('no targets / bad ltp / FLAT side → no-op (guards)', () => {
    expect(proTraderTpCheck({ trade: { side: 'LONG', tp: 0, tp2: 0 }, ltp: 999, cfg: PROTRADER_DEFAULTS }).tpFull).toBe(false);
    expect(proTraderTpCheck({ trade, ltp: 0, cfg: PROTRADER_DEFAULTS }).tp1).toBe(false);
    expect(proTraderTpCheck({ trade, ltp: NaN, cfg: PROTRADER_DEFAULTS }).tp1).toBe(false);
    expect(proTraderTpCheck({ trade: { side: 'FLAT', tp: 112, tp2: 120 }, ltp: 130, cfg: PROTRADER_DEFAULTS }).tpFull).toBe(false);
  });
});

// ============================================================
// B. proTraderLockBreakeven — ratchet-only
// ============================================================
describe('B. proTraderLockBreakeven (favorable-direction ratchet)', () => {
  it('LONG: sl entry ke NEECHE hai → entry pe uthta hai', () => {
    const t = { side: 'LONG', entryPrice: 100, sl: 95 };
    expect(proTraderLockBreakeven(t)).toBe(true);
    expect(t.sl).toBe(100);
  });
  it('LONG: sl pehle se entry ke upar → NAHI girta (ratchet one-way)', () => {
    const t = { side: 'LONG', entryPrice: 100, sl: 106 };
    expect(proTraderLockBreakeven(t)).toBe(false);
    expect(t.sl).toBe(106);
  });
  it('SHORT: sl entry ke UPAR hai → entry pe girta hai; missing sl bhi set hota hai', () => {
    const t = { side: 'SHORT', entryPrice: 100, sl: 105 };
    expect(proTraderLockBreakeven(t)).toBe(true);
    expect(t.sl).toBe(100);
    const t2 = { side: 'SHORT', entryPrice: 100, sl: 0 };
    expect(proTraderLockBreakeven(t2)).toBe(true);
    expect(t2.sl).toBe(100);
  });
  it('SHORT: sl pehle se entry ke neeche → badalta nahi', () => {
    const t = { side: 'SHORT', entryPrice: 100, sl: 94 };
    expect(proTraderLockBreakeven(t)).toBe(false);
    expect(t.sl).toBe(94);
  });
});

// ============================================================
// C. PAPER E2E — entry → TP1 partial + BE-lock → TP2 full exit
// ============================================================
describe('C. SAPTA paper E2E — TP1 partial book + TP2 full exit', () => {
  const _LTP_STUB = { getTick: () => null, fetchCoinDcxTickers: async () => [], fetchFuturesPrices: async () => [] };

  beforeEach(() => {
    updateProTraderConfig({ minAiScore: 75, minConfidence: 65, minVerifiedScore: 70, stakeINR: 500, maxConcurrent: 3, maxTradesPerDay: 6, tpExitsEnabled: true, tp1ClosePct: 50 });
    proTraderStop();
  });

  it('entry → TP1 hit → 50% partial booked + SL breakeven → TP2 hit → FULL exit (total PnL = booked + final leg)', async () => {
    const { getSignals } = await import('../server/ai/signals.js');
    const mockGet = vi.mocked(getSignals);

    // 1) entry @ 101 (plan entry 100, TP1 112, TP2 120)
    mockGet.mockImplementation(async (market: string) => ({
      ok: true, market, marketOpen: true,
      signals: [{
        symbol: 'BTC', market, side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 101, executable: true,
        plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
        superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
      }],
    }));
    proTraderStart({ mode: 'paper' });
    await proTraderTick(_LTP_STUB, null);
    let view = proTraderStatusView();
    expect(view.positions.length).toBe(1);
    const pos = view.positions[0];
    expect(pos.tp).toBe(112);
    expect(pos.tp2).toBe(120);
    const qty0 = Number(pos.qtyEstimate);
    expect(qty0).toBeGreaterThan(0);

    // 2) TP1 hit — ltp 113
    mockGet.mockImplementation(async (market: string) => ({
      ok: true, market, marketOpen: true,
      signals: [{
        symbol: 'BTC', market, side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 113, executable: true,
        plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
        superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
      }],
    }));
    await proTraderTick(_LTP_STUB, null);
    view = proTraderStatusView();
    expect(view.positions.length).toBe(1); // runner abhi OPEN
    const p1 = view.positions[0];
    expect(p1.tp1Hit).toBe(true);
    expect(Number(p1.qtyEstimate)).toBeCloseTo(qty0 / 2, 4); // 50% booked
    expect(Number(p1.bookedPnlINR)).toBeGreaterThan(0); // profit booked in ₹
    expect(Number(p1.sl)).toBe(100); // breakeven lock

    // 3) TP2 hit — ltp 121 → FULL exit
    mockGet.mockImplementation(async (market: string) => ({
      ok: true, market, marketOpen: true,
      signals: [{
        symbol: 'BTC', market, side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 121, executable: true,
        plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
        superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
      }],
    }));
    await proTraderTick(_LTP_STUB, null);
    view = proTraderStatusView();
    expect(view.positions.length).toBe(0); // closed — profit booked, exit
    const closeLine = view.log.find((l) => l.level === 'exit' && l.text.includes('CLOSE BTC'));
    expect(closeLine).toBeTruthy();
    expect(closeLine?.text).toContain('TP2 TARGET');
    // today pnl me booked + final dono ginte hain (honest total)
    expect(view.today.pnlINR).toBeGreaterThan(0);
    proTraderStop();
  });

  it('TP-exits OFF → TP2 cross hone par bhi position OPEN rehti hai (reversal/SL hi exits)', async () => {
    const { getSignals } = await import('../server/ai/signals.js');
    const mockGet = vi.mocked(getSignals);
    mockGet.mockImplementation(async (market: string) => ({
      ok: true, market, marketOpen: true,
      signals: [{
        symbol: 'ETH', market, side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 101, executable: true,
        plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
        superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
      }],
    }));
    updateProTraderConfig({ tpExitsEnabled: false });
    proTraderStart({ mode: 'paper' });
    await proTraderTick(_LTP_STUB, null);
    mockGet.mockImplementation(async (market: string) => ({
      ok: true, market, marketOpen: true,
      signals: [{
        symbol: 'ETH', market, side: 'LONG', grade: 'STRONG', confidence: 70, ltp: 125, executable: true,
        plan: { entry: 100, stopLoss: 95, target1: 112, target2: 120 },
        superIntel: { aiScore: 80 }, verify: { score: 92, action: 'CONFIRM', finalCall: 'LONG' },
      }],
    }));
    await proTraderTick(_LTP_STUB, null);
    const view = proTraderStatusView();
    expect(view.positions.length).toBe(1); // TP OFF → no book, no exit
    expect(view.positions[0].tp1Hit).toBe(false);
    proTraderStop();
    updateProTraderConfig({ tpExitsEnabled: true });
  });
});

// ============================================================
// D. Gate migration — old unreachable 90 default → 70
// ============================================================
describe('D. v20.8.5 gate migration (90 → 70)', () => {
  it('saved config with the OLD 90 default migrates to 70 once', () => {
    saveJSON('protrader-auto-config.json', { config: { enabled: false, mode: 'paper', minVerifiedScore: 90 }, savedAt: 1 });
    const cfg = loadProTraderConfig();
    expect(cfg.minVerifiedScore).toBe(70);
    expect(cfg.__migrations?.v20_8_5).toBe(true);
  });
  it('a deliberately-set non-90 value is NEVER touched', () => {
    saveJSON('protrader-auto-config.json', { config: { enabled: false, mode: 'paper', minVerifiedScore: 78 }, savedAt: 1 });
    const cfg = loadProTraderConfig();
    expect(cfg.minVerifiedScore).toBe(78);
  });
  it('re-set 90 AFTER the migration stamp stays 90 (user choice respected)', () => {
    saveJSON('protrader-auto-config.json', { config: { enabled: false, mode: 'paper', minVerifiedScore: 70, __migrations: { v20_8_5: true } }, savedAt: 1 });
    const cfg = updateProTraderConfig({ minVerifiedScore: 90 });
    expect(cfg.minVerifiedScore).toBe(90);
    // reload me bhi 90 hi (stamp laga hua)
    expect(loadProTraderConfig().minVerifiedScore).toBe(90);
    // cleanup for baaki tests
    updateProTraderConfig({ minVerifiedScore: 70 });
  });
});

// ============================================================
// E. alreadyRunning honesty ("already tick hai bta raha hai")
// ============================================================
describe('E. proTraderStart alreadyRunning honesty', () => {
  it('pehla start fresh; doosra START same-mode pe alreadyRunning=true + startedAt preserved', () => {
    proTraderStop();
    const r1 = proTraderStart({ mode: 'paper' });
    expect(r1.ok).toBe(true);
    expect(r1.alreadyRunning).toBe(false);
    const t1 = r1.startedAt;
    const r2 = proTraderStart({ mode: 'paper' });
    expect(r2.ok).toBe(true);
    expect(r2.alreadyRunning).toBe(true);
    expect(r2.startedAt).toBe(t1); // restart nahi hua — since wahi hai
    // mode switch (paper → live phrase ke saath) ek REAL restart hai
    const r3 = proTraderStart({ mode: 'live', liveConfirmPhrase: 'LIVE' });
    expect(r3.alreadyRunning).toBe(false);
    proTraderStop();
  });
});

// ============================================================
// F. walletSnapshot 10s mini-cache (futures.js)
// ============================================================
describe('F. walletSnapshot mini-cache (v20.8.5 — "futures wallet late read")', () => {
  it('10s window me overlapping consumers EK hi round-trip share karte hain; force bypass', async () => {
    // hermetic: mock the transport layer via the module's own test hooks —
    // source-level lock yahan (behavior futures.test.ts me bhi covered),
    // cache semantics directly: 2 snapshot → 1 underlying build
    const fut = await import('../server/ai/futures.js');
    const internals = (fut as unknown as { __resetWalletSnapshotCacheForTests: () => void, __resetFuturesForTests: () => void });
    internals.__resetWalletSnapshotCacheForTests();
    internals.__resetFuturesForTests();
    // snapshot without creds → still ok:true (never throws), legs degrade
    const s1 = await fut.walletSnapshot();
    expect(s1.ok).toBe(true);
    // cached: same reference within 10s
    const s2 = await fut.walletSnapshot();
    expect(s2).toBe(s1);
    // force bypass → fresh build
    const s3 = await fut.walletSnapshot({ force: true });
    expect(s3.ok).toBe(true);
    internals.__resetWalletSnapshotCacheForTests();
  });
});

// ============================================================
// G. Source contracts — latency + fallback wiring
// ============================================================
describe('G. v20.8.5 source contracts', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');

  it('futures watcher: 30s cadence + ≤5s-fresh prices (TP latency aadha)', () => {
    const routes = read('../server/ai/routes.js');
    expect(routes).toContain('}, 30_000);');
    expect(routes).toContain('v20.8.5: 60s → 30s');
    const fut = read('../server/ai/futures.js');
    expect(fut).toContain('maxAgeMs: 5_000');
  });
  it('wallet reconnect: force-bypass the mini-cache (fresh verify after reset)', () => {
    const routes = read('../server/ai/routes.js');
    expect(routes).toContain('walletSnapshot({ force: true })');
  });
  it('agent: futures wallet READ-FAIL ≠ margin-zero — last-known (≤10 min) margin pe desk chalta hai', () => {
    const agent = read('../server/ai/agent.js');
    expect(agent).toContain('_futReadFailed');
    expect(agent).toContain('_lastKnownFutMargin');
    expect(agent).toContain('fut_wallet_lastknown');
  });
  it('SAPTA monitor: TP check REVERSAL se pehle wired hai', () => {
    const src = read('../server/ai/proTraderAuto.js');
    const tpIdx = src.indexOf('proTraderTpCheck({ trade: t, ltp, cfg })');
    const revIdx = src.indexOf('proTraderReversalCheck({ trade: t, ltp');
    expect(tpIdx).toBeGreaterThan(-1);
    expect(revIdx).toBeGreaterThan(-1);
    expect(tpIdx).toBeLessThan(revIdx);
  });
  it('useWalletPoll: 25s cadence + 20s guards (wallet card freshness)', () => {
    const src = read('../src/components/aitrading/useWalletPoll.ts');
    expect(src).toContain('}, 25_000);');
    expect(src).toContain('20_000) return;');
    expect(src).toContain('> 20_000) {');
  });
  it('panel: TP EXITS chip + alreadyRunning toast + new EXIT footer', () => {
    const src = read('../src/components/aitrading/ProTraderAutoPanel.tsx');
    expect(src).toContain('TP EXITS');
    expect(src).toContain('alreadyRunning');
    expect(src).toContain('TP1 partial book + SL→breakeven / TP2 FULL exit (profit booked)');
    expect(src).toContain('tp1ClosePct');
  });
  it('close P&L: booked TP1 legs total me count hote hain', () => {
    const src = read('../server/ai/proTraderAuto.js');
    expect(src).toContain('finalLegPnlINR');
    expect(src).toContain('bookedPnlINR: booked');
  });
});
