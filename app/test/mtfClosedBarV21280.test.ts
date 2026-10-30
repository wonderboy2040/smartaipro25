// ============================================================
// test/mtfClosedBarV21280.test.ts — F1 CLOSED-BAR CONFIRMATION
// ------------------------------------------------------------
// Audit finding F1: entry signals were confirmed on the FORMING candle
// (patched by the live tick), so a signal could repaint/flip when that bar
// closed. This suite locks:
//   • stable vs unstable snapshots (side + trigger, forming vs last closed)
//   • honest `null` whenever stability cannot be proven
//   • shadow telemetry on every row (closedBarConfirm / signalStability)
//   • default OFF gates; `cfg.closedBarConfirm=true` / requireClosedBarConfirm
//     hard-blocks unconfirmed rows
//   • closed trigger candles cached for F4 TP1 close-confirmation
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';

import {
  buildDualRow, buildBarConfirmation, dualAutoCandidates, mtfProEntryGate,
  rememberClosedCandles, closedCandlesFor, __clearDualBoardCaches,
} from '../server/ai/mtfDualBoard.js';
import { __resetDirectionLocksForTests } from '../server/ai/directionLock.js';

const mkCandles = (n = 180, base = 100, step = 0.35) => Array.from({ length: n }, (_, i) => ({
  time: 1_700_000_000_000 + i * 300_000,
  open: base + i * step,
  high: base + i * step + 0.25,
  low: base + i * step - 0.15,
  close: base + (i + 1) * step,
  volume: 1000 + i * 5,
}));

const planLong = {
  side: 'LONG', triggerFired: true, directionVerified: true,
  grade: 'A', confidence: 82,
  plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
};
const closedLong = {
  side: 'LONG', triggerFired: true, directionVerified: true,
  grade: 'A', confidence: 82,
  entry: 100, stopLoss: 99, t1: 101, t2: 102, lastClosedBarTime: 111,
};

describe('v21.28.0 F1 buildBarConfirmation — stable vs unstable snapshots', () => {
  it('forming and last closed bar aligned → stable', () => {
    const bc = buildBarConfirmation({ plan: planLong, closedSnap: closedLong, liveTickOverlay: false });
    expect(bc.stable).toBe(true);
    expect(bc.sideStable).toBe(true);
    expect(bc.triggerStable).toBe(true);
    expect(bc.verifiedStable).toBe(true);
    expect(bc.reasons).toEqual([]);
    expect(bc.mode).toBe('shadow');
    expect(bc.note).toContain('aligned');
  });

  it('side flip on the closed bar → unstable with an honest reason', () => {
    const bc = buildBarConfirmation({
      plan: planLong,
      closedSnap: { ...closedLong, side: 'SHORT', entry: 100, stopLoss: 101, t1: 99, t2: 98 },
      liveTickOverlay: true,
    });
    expect(bc.stable).toBe(false);
    expect(bc.sideStable).toBe(false);
    expect(bc.liveTickOverlay).toBe(true);
    expect(bc.reasons[0]).toContain('side flipped');
  });

  it('trigger fires on forming bar but not on the closed bar → unstable', () => {
    const bc = buildBarConfirmation({
      plan: planLong,
      closedSnap: { ...closedLong, triggerFired: false },
      liveTickOverlay: false,
    });
    expect(bc.stable).toBe(false);
    expect(bc.triggerStable).toBe(false);
    expect(bc.reasons.some(r => r.includes('trigger'))).toBe(true);
  });

  it('verification mismatch alone is reported but side+trigger stability decides', () => {
    const bc = buildBarConfirmation({
      plan: planLong,
      closedSnap: { ...closedLong, directionVerified: false },
      liveTickOverlay: false,
    });
    expect(bc.stable).toBe(true);
    expect(bc.verifiedStable).toBe(false);
    expect(bc.reasons.some(r => r.includes('verification'))).toBe(true);
  });

  it('missing closed-bar plan → null (never a fabricated pass)', () => {
    const bc = buildBarConfirmation({ plan: planLong, closedSnap: null, liveTickOverlay: false });
    expect(bc.stable).toBeNull();
    expect(bc.sideStable).toBeNull();
    expect(bc.closeBar).toBeNull();
    expect(bc.reasons[0]).toContain('closed-bar plan unavailable');
  });

  it('missing side on either snapshot → null', () => {
    const bc = buildBarConfirmation({
      plan: { ...planLong, side: null },
      closedSnap: closedLong,
    });
    expect(bc.stable).toBeNull();
    expect(bc.reasons[0]).toContain('stability unproven');
  });
});

describe('v21.28.0 F1 buildDualRow — shadow telemetry wiring', () => {
  beforeEach(() => {
    __clearDualBoardCaches();
    __resetDirectionLocksForTests();
  });

  it('stamps closedBarConfirm + signalStability on the row', async () => {
    const candles = mkCandles();
    const r = await buildDualRow({
      symbol: 'F1SHADOW', market: 'CRYPTO', modeId: 'INTRADAY', holdMin: 45,
      candlesFor: async () => candles.map(c => ({ ...c })),
    });
    expect(r.ok).toBe(true);
    expect(r.signalStability.mode).toBe('shadow');
    expect(r.signalStability.liveTickOverlay).toBe(false);
    expect(r.barConfirmation?.openBar?.side).toBe(r.side);
    expect(r.barConfirmation?.closeBar).toBeTruthy();
    expect(r.closedBarConfirm).toBe(r.signalStability.stable === true);
    expect(Array.isArray(r.signalStability.reasons)).toBe(true);
    // The candle chain excludes the still-forming bar.
    expect(r.barConfirmation.closeBar.lastClosedBarTime).not.toBe(candles.at(-1)!.time);
  });
});

describe('v21.28.0 F1 closed-candle cache for F4 TP1 confirmation', () => {
  beforeEach(() => __clearDualBoardCaches());

  it('drops the newest (forming) bar and honours the TTL', () => {
    const candles = mkCandles(6);
    const n = rememberClosedCandles({ symbol: 'F1CACHE', market: 'CRYPTO', candles, now: 5_000 });
    expect(n).toBe(5);
    const got = closedCandlesFor('F1CACHE', 'CRYPTO', { now: 10_000, maxAgeMs: 60_000 });
    expect(got).toHaveLength(5);
    expect(got!.at(-1)!.close).toBe(candles[4].close); // last CLOSED bar
    expect(closedCandlesFor('F1CACHE', 'CRYPTO', { now: 66_000, maxAgeMs: 60_000 })).toBeNull();
  });

  it('requires at least one closed bar and a known symbol/market', () => {
    expect(rememberClosedCandles({ symbol: 'X', market: 'CRYPTO', candles: [mkCandles(1)[0]] })).toBeNull();
    expect(rememberClosedCandles({ symbol: '', market: 'CRYPTO', candles: mkCandles(3) })).toBeNull();
    expect(closedCandlesFor('MISSING', 'CRYPTO')).toBeNull();
  });

  it('buildDualRow automatically retains the closed trigger series', async () => {
    const candles = mkCandles();
    await buildDualRow({
      symbol: 'F1FEED', market: 'CRYPTO', modeId: 'INTRADAY', holdMin: 45,
      candlesFor: async () => candles.map(c => ({ ...c })),
    });
    const got = closedCandlesFor('F1FEED', 'CRYPTO', { now: Date.now() });
    expect(got).toHaveLength(candles.length - 1);
    expect(got!.at(-1)!.close).toBe(candles[candles.length - 2].close);
  });
});

describe('v21.28.0 F1 entry gates — default OFF, opt-in hard block', () => {
  const row = (over: Record<string, any> = {}) => ({
    ok: true, symbol: 'AAA', market: 'INDIA', mode: 'INTRADAY', superScore: 82, tier: 'STRONG',
    side: 'LONG', directionVerified: true, triggerFired: true, counterHtf: false, counterTrend: false,
    autoEligible: true, autoBlockers: [], ensembleSignalAvailable: true,
    plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    ...over,
  });
  const mainLong = (over: Record<string, any> = {}) => ({
    side: 'LONG', grade: 'STRONG', confidence: 84,
    mtf: { htfBias: 'BULLISH' }, signalAge: { ageMs: 60 * 60_000 },
    verify: { veto: false, action: 'BUY' },
    ...over,
  });

  it('pro gate ignores stability by default (shadow)', () => {
    const g = mtfProEntryGate(row({ closedBarConfirm: false }), { mainSignal: mainLong() });
    expect(g.ok).toBe(true);
    expect(g.blockers).toEqual([]);
  });

  it('pro gate requireClosedBarConfirm blocks an unstable row with its reason', () => {
    const g = mtfProEntryGate(row({
      closedBarConfirm: false,
      signalStability: { reasons: ['side flipped LONG (forming) vs SHORT (closed)'] },
    }), { mainSignal: mainLong(), requireClosedBarConfirm: true });
    expect(g.ok).toBe(false);
    expect(g.blockers[0]).toContain('closed-bar confirm pending');
    expect(g.blockers[0]).toContain('side flipped');
  });

  it('pro gate allows a stable row when the requirement is on', () => {
    const g = mtfProEntryGate(row({ closedBarConfirm: true }), {
      mainSignal: mainLong(), requireClosedBarConfirm: true,
    });
    expect(g.ok).toBe(true);
  });

  it('auto sift ignores stability unless cfg.closedBarConfirm is true', () => {
    const shadow = dualAutoCandidates([row({ closedBarConfirm: false })], { minScore: 75 }, {
      openSymbols: new Set(), lastEntryAt: {},
    });
    expect(shadow[0].autoPickBlockers).toEqual([]);

    const enforced = dualAutoCandidates([row({ closedBarConfirm: false })], {
      minScore: 75, closedBarConfirm: true,
    }, { openSymbols: new Set(), lastEntryAt: {} });
    expect(enforced[0].autoPickBlockers.some(b => b.includes('closed-bar confirm pending'))).toBe(true);
  });

  it('auto sift leaves a stable row pickable in enforce mode', () => {
    const out = dualAutoCandidates([row({ closedBarConfirm: true })], {
      minScore: 75, closedBarConfirm: true,
    }, { openSymbols: new Set(), lastEntryAt: {} });
    expect(out[0].autoPickBlockers).toEqual([]);
  });
});
