// ============================================================
// test/perpIntel.test.ts — v12.0 PERP POSITIONING INTELLIGENCE
// ------------------------------------------------------------
// LOCKED HERE:
//   • the OI×price 2×2 matrix: LONGS_BUILDING / SHORTS_BUILDING /
//     SHORT_SQUEEZE / LONG_UNWIND / FLAT — the classic positioning grid
//   • taker flow / top-trader L-S / funding adjustments + the crowd
//     flags (crowdedLongs / crowdedShorts)
//   • NULL FIELDS NEVER READ AS ZERO (no OI history ≠ "flat OI" —
//     the read degrades to thin honestly)
//   • the bias ladder + confidence levels (full/partial/thin)
//   • getPerpIntel fetch assembly: 5 fapi calls, premiumIndex is the
//     anchor (dead anchor = honest ok:false), per-field degrade
//   • the 60s cache + single-flight + bounded map
//   • perpIntelWire: the compact card-facing payload
//   • the kill-switch (AI_DISABLE_PERP_INTEL)
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readPerpPositioning, getPerpIntel, getPerpIntelFor, perpIntelWire,
  perpIntelEnabled, perpIntelBoardView,
  __resetPerpIntelForTests, __seedPerpIntelForTests,
} from '../server/ai/perpIntel.js';

// ---- fetch mock (per-URL responses; default = network failure) ----
const _routes = new Map();
global.fetch = vi.fn(async (url) => {
  const u = String(url);
  for (const [frag, payload] of _routes) {
    if (u.includes(frag)) return { ok: true, status: 200, json: async () => payload };
  }
  throw new Error('network blocked');
}) as unknown as typeof fetch;

beforeEach(() => { _routes.clear(); __resetPerpIntelForTests(); delete process.env.AI_DISABLE_PERP_INTEL; });
afterEach(() => { delete process.env.AI_DISABLE_PERP_INTEL; });

const intel = (o = {}) => ({
  ok: true, base: 'BTC', pair: 'BTCUSDT', at: Date.now(),
  markPrice: 60000, fundingRate8h: 0.0001, fundingBps8h: 1,
  nextFundingTs: null, openInterest: 80000, oiValueUSDT: 4.8e9,
  oi24hAgo: 79000, oiChangePct24h: 1.3, price24hAgo: 59200, change24hPct: 1.35,
  topLongShortRatio: 1.8, topLongShortDelta24h: 2, takerRatio24h: 1.0, takerNow: 1.01,
  sources: {}, ...o,
});

describe('readPerpPositioning — the OI×price 2×2 matrix', () => {
  it('OI↑ + P↑ → LONGS_BUILDING (trend fuel, +14)', () => {
    const r = readPerpPositioning(intel({ oiChangePct24h: 6, change24hPct: 4.2, fundingBps8h: 1, takerRatio24h: null, topLongShortRatio: null }));
    expect(r.matrix).toBe('LONGS_BUILDING');
    expect(r.score).toBe(64);
    expect(r.bias).toBe('BULLISH');
  });
  it('OI↑ + P↓ → SHORTS_BUILDING (fresh shorts pressing)', () => {
    const r = readPerpPositioning(intel({ oiChangePct24h: 8, change24hPct: -5.1, fundingBps8h: null, takerRatio24h: null, topLongShortRatio: null }));
    expect(r.matrix).toBe('SHORTS_BUILDING');
    expect(r.bias).toBe('BEARISH');
    expect(r.score).toBe(36);
  });
  it('OI↓ + P↑ → SHORT_SQUEEZE (covering rally, fuel burns out — only +4)', () => {
    const r = readPerpPositioning(intel({ oiChangePct24h: -4, change24hPct: 6, fundingBps8h: null, takerRatio24h: null, topLongShortRatio: null }));
    expect(r.matrix).toBe('SHORT_SQUEEZE');
    expect(r.score).toBe(54);
  });
  it('OI↓ + P↓ → LONG_UNWIND (pressure exhausting — only −4)', () => {
    const r = readPerpPositioning(intel({ oiChangePct24h: -5, change24hPct: -3.2, fundingBps8h: null, takerRatio24h: null, topLongShortRatio: null }));
    expect(r.matrix).toBe('LONG_UNWIND');
    expect(r.score).toBe(46);
  });
  it('small moves on both axes → FLAT (no clear positioning)', () => {
    const r = readPerpPositioning(intel({ oiChangePct24h: 0.5, change24hPct: 0.2, fundingBps8h: null, takerRatio24h: null, topLongShortRatio: null }));
    expect(r.matrix).toBe('FLAT');
  });
});

describe('readPerpPositioning — flow, crowd and honesty', () => {
  it('aggressive taker buying adds to the LONG read', () => {
    const calm = readPerpPositioning(intel({ oiChangePct24h: null, change24hPct: null, fundingBps8h: null, takerRatio24h: 1.0, topLongShortRatio: null }));
    const buy = readPerpPositioning(intel({ oiChangePct24h: null, change24hPct: null, fundingBps8h: null, takerRatio24h: 1.16, topLongShortRatio: null }));
    expect(buy.score - calm.score).toBe(10);
    expect(buy.reasons.some(x => /buyers aggressively/i.test(x))).toBe(true);
  });
  it('crowded longs: funding > 15bps AND top-trader L/S ≥ 2.5 → flag', () => {
    const r = readPerpPositioning(intel({ oiChangePct24h: null, change24hPct: null, fundingBps8h: 18, takerRatio24h: null, topLongShortRatio: 2.8 }));
    expect(r.crowdedLongs).toBe(true);
    expect(r.reasons.some(x => /LONGS CROWDED/.test(x))).toBe(true);
  });
  it('crowded shorts: funding < −5bps AND L/S ≤ 0.6 → flag', () => {
    const r = readPerpPositioning(intel({ oiChangePct24h: null, change24hPct: null, fundingBps8h: -8, takerRatio24h: null, topLongShortRatio: 0.5 }));
    expect(r.crowdedShorts).toBe(true);
  });
  it('NULL fields never read as zero — a thin record degrades honestly', () => {
    const r = readPerpPositioning({ fundingBps8h: 3 });
    expect(r.matrix).toBeNull();          // no OI history ≠ "flat OI"
    expect(r.confidence).toBe('thin');
    expect(r.reasons).toHaveLength(1);    // only the funding read fired
    expect(r.bias).toBe('NEUTRAL');
  });
  it('confidence: full needs the matrix + taker + funding; partial otherwise', () => {
    const full = readPerpPositioning(intel({ oiChangePct24h: 2, change24hPct: 1, fundingBps8h: 2, takerRatio24h: 1.0 }));
    expect(full.confidence).toBe('full');
    const partial = readPerpPositioning(intel({ oiChangePct24h: 2, change24hPct: 1, takerRatio24h: null }));
    expect(partial.confidence).toBe('partial');
  });
  it('the score is bounded 1..99 and the bias ladder is 62/38', () => {
    const hi = readPerpPositioning(intel({ oiChangePct24h: 30, change24hPct: 25, fundingBps8h: -20, takerRatio24h: 1.4, topLongShortRatio: 2.6 }));
    expect(hi.score).toBeLessThanOrEqual(99);
    expect(hi.bias).toBe('BULLISH');
    const lo = readPerpPositioning(intel({ oiChangePct24h: 30, change24hPct: -25, fundingBps8h: 25, takerRatio24h: 0.8, topLongShortRatio: 0.4 }));
    expect(lo.score).toBeGreaterThanOrEqual(1);
    expect(lo.bias).toBe('BEARISH');
  });
});

describe('getPerpIntel — the fetch assembly', () => {
  it('premiumIndex is the anchor: dead anchor → honest ok:false', async () => {
    // every route EXCEPT the anchor answers — record still refuses
    _routes.set('openInterest', { openInterest: '1' });
    _routes.set('openInterestHist', [{ sumOpenInterest: '1', sumOpenInterestValue: '1' }]);
    const r = await getPerpIntel('BTC');
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/premiumIndex unreachable/);
  });
  it('full assembly: funding + OI + 24h deltas + implied price change', async () => {
    _routes.set('premiumIndex?symbol=BTCUSDT', { markPrice: '60000', lastFundingRate: '0.0001', nextFundingTime: 1700000000000 });
    _routes.set('openInterest?symbol=BTCUSDT', { openInterest: '80000' });
    // implied price = value/OI per bucket: 24h ago 58000 → now 60000 (+3.45%)
    // and OI 78000 → 80000 (+2.56%) → the LONGS_BUILDING quadrant
    _routes.set('openInterestHist', [
      { sumOpenInterest: '78000', sumOpenInterestValue: '4524000000' },
      { sumOpenInterest: '80000', sumOpenInterestValue: '4800000000' },
    ]);
    _routes.set('topLongShortAccountRatio', [
      { longShortRatio: '1.75' }, { longShortRatio: '1.80' },
    ]);
    _routes.set('takerlongshortRatio', [
      { buySellRatio: '1.02' }, { buySellRatio: '1.06' },
    ]);
    const r = await getPerpIntel('BTC');
    expect(r.ok).toBe(true);
    expect(r.fundingBps8h).toBe(1);
    expect(r.openInterest).toBe(80000);
    expect(r.oiChangePct24h).toBeCloseTo(2.56, 1);
    expect(r.change24hPct).toBeCloseTo(3.45, 1);
    expect(r.topLongShortRatio).toBe(1.8);
    expect(r.takerRatio24h).toBeCloseTo(1.04, 2);
    expect(r.read.matrix).toBe('LONGS_BUILDING'); // OI↑ + implied P↑
    expect(r.sources.funding).toContain('premiumIndex');
  });
  it('per-field degrade: dead OI-history leaves the rest alive', async () => {
    _routes.set('premiumIndex?symbol=BTCUSDT', { markPrice: '60000', lastFundingRate: '0.0002' });
    const r = await getPerpIntel('BTC');
    expect(r.ok).toBe(true);
    expect(r.oiChangePct24h).toBeNull();
    expect(r.read.matrix).toBeNull();
    expect(r.read.confidence).toBe('thin');
  });
  it('60s cache: a second call never refetches', async () => {
    _routes.set('premiumIndex?symbol=BTCUSDT', { markPrice: '1', lastFundingRate: '0.0001' });
    await getPerpIntel('BTC');
    const calls1 = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await getPerpIntel('BTC');
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls1);
  });
  it('invalid symbols are refused before any fetch', async () => {
    const r = await getPerpIntel('x');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid symbol/);
  });
});

describe('getPerpIntelFor — the batch', () => {
  it('allSettled: one dead symbol never blocks the others', async () => {
    _routes.set('premiumIndex?symbol=BTCUSDT', { markPrice: '1', lastFundingRate: '0.0001' });
    _routes.set('premiumIndex?symbol=ETHUSDT', { markPrice: '1', lastFundingRate: '0.0001' });
    const map = await getPerpIntelFor(['BTC', 'ETH']);
    expect(map.size).toBe(2);
    expect(map.get('BTC')?.ok).toBe(true);
    expect(map.get('ETH')?.ok).toBe(true);
  });
  it('empty input → empty map', async () => {
    expect((await getPerpIntelFor([])).size).toBe(0);
  });
});

describe('perpIntelWire — the card-facing payload', () => {
  it('carries the positioning-relevant slice with bounded reasons', () => {
    const rec = intel({ fundingBps8h: 12, oiChangePct24h: 5, change24hPct: 3, takerRatio24h: 1.1 });
    rec.read = readPerpPositioning(rec);
    const w = perpIntelWire(rec);
    expect(w).not.toBeNull();
    expect(w!.pair).toBe('BTCUSDT');
    expect(w!.fundingBps8h).toBe(12);
    expect(w!.read.matrix).toBe('LONGS_BUILDING');
    expect(w!.read.reasons.length).toBeLessThanOrEqual(3);
  });
  it('refuses non-records', () => {
    expect(perpIntelWire(null)).toBeNull();
    expect(perpIntelWire({ ok: false })).toBeNull();
  });
});

describe('the kill-switch + board view', () => {
  it('AI_DISABLE_PERP_INTEL=1 disables the engine', () => {
    process.env.AI_DISABLE_PERP_INTEL = '1';
    expect(perpIntelEnabled()).toBe(false);
    delete process.env.AI_DISABLE_PERP_INTEL;
    expect(perpIntelEnabled()).toBe(true);
  });
  it('board view: unreachable universe → honest ok:false (no fake rows)', async () => {
    // futures.js is dynamically imported — its fetchFuturesPrices hits
    // the mocked fetch and throws (no route) → honest degrade.
    const v = await perpIntelBoardView(12);
    expect(v.ok).toBe(false);
    expect(v.symbols).toEqual([]);
  });
});
