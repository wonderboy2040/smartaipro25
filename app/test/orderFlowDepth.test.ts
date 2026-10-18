// ============================================================
// test/orderFlowDepth.test.ts — v10.6 ORDER-FLOW / LEVEL-2 DEPTH
// (Pro Upgrade #1) + SLIPPAGE-AWARE EXECUTION (Pro Upgrade #6)
// regression suite.
//
// LOCKED HERE:
//   • level normalization across CoinDCX response shapes
//   • two-band imbalance (top-5 shallow vs top-20 deep)
//   • wall detection: a level ≥4× the side's median = a wall
//   • velocity: a wall that VANISHES between snapshots = spoof flag
//   • Dhan India L2 parse (best-5 bids/asks, tolerant shapes)
//   • honest degrade: no book → ok:false, never a throw
//   • VolumeFlow fold-in: with ctx.depth the vote changes; without
//     it the vote is byte-identical to the legacy behavior
//   • slippage walk-the-book (VWAP vs touch) + book-exhaustion flag
//   • TWAP-lite splitter: ≤threshold → 1 child, over → 2-4,
//     exhausted book → 4, no depth → 1
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../server/ai/dhan.js', () => ({
  dhanConnected: vi.fn(() => false), // India L2 tests inject snapshots directly
  dhanPrivate: vi.fn(),
  resolveDhanSymbol: vi.fn(async () => 12345),
}));

import {
  normalizeLevels, findWalls, analyzeDepth, parseDhanDepth,
  estimateSlippagePct, splitOrderForSlippage, readDepth, __testables,
} from '../server/ai/orderFlowDepth.js';
import { runQuantModels } from '../server/ai/models.js';

const volumeVote = (ctx: unknown) => (runQuantModels as any)(ctx).find((v: any) => v.id === 'volume');

beforeEach(() => { __testables.__resetDepthForTests(); });

// ladder builders (price-agnostic helpers)
const bids = (n = 20, base = 100) => Array.from({ length: n }, (_, i) => ({ price: base - i * 0.1, qty: 10 + i }));
const asks = (n = 20, base = 100.05) => Array.from({ length: n }, (_, i) => ({ price: base + i * 0.1, qty: 12 + i }));

describe('normalizeLevels (CoinDCX shape tolerance)', () => {
  it('parses array-of-arrays AND object shapes', () => {
    const a = normalizeLevels([['100.5', '2'], [101, 3]]);
    expect(a).toEqual([{ price: 100.5, qty: 2 }, { price: 101, qty: 3 }]);
    const b = normalizeLevels([{ price: 99, quantity: 5 }, { p: 98, q: 6 }]);
    expect(b).toEqual([{ price: 99, qty: 5 }, { price: 98, qty: 6 }]);
  });
  it('drops non-positive garbage rows', () => {
    expect(normalizeLevels([[0, 5], [100, -1], [100, 5]])).toEqual([{ price: 100, qty: 5 }]);
  });
});

describe('findWalls (large-order / iceberg detection)', () => {
  it('flags any level ≥ 4× the side median', () => {
    const b = bids(20);
    b[3] = { price: 99.7, qty: 500 }; // median ≈ 19-20 → 500 ≫ 4×
    const walls = findWalls(b);
    expect(walls.length).toBeGreaterThan(0);
    expect(walls[0].price).toBeCloseTo(99.7, 6);
    expect(walls[0].x).toBeGreaterThanOrEqual(4);
  });
  it('a flat ladder has no walls', () => {
    expect(findWalls(bids(20).map(l => ({ ...l, qty: 10 })))).toHaveLength(0);
  });
});

describe('analyzeDepth (two bands + spoof velocity)', () => {
  it('computes top-5 and top-20 imbalance separately', () => {
    const a = analyzeDepth({ bids: bids(20), asks: asks(20), ltp: 100 });
    expect(a.ok).toBe(true);
    expect(a.imbalanceTop5).not.toBeNull();
    expect(a.imbalanceTop20).not.toBeNull();
    expect(a.spreadPct).toBeGreaterThan(0);
  });

  it('near-wall distance is measured from price', () => {
    const b = bids(20);
    b[2] = { price: 99.85, qty: 900 };
    const a = analyzeDepth({ bids: b, asks: asks(20), ltp: 100 });
    expect(a.nearBidWall?.price).toBeCloseTo(99.85, 6);
    expect(a.nearBidWall?.distPct).toBeCloseTo(0.15, 3);
  });

  it('a wall that VANISHES between snapshots = spoof risk', () => {
    __testables.__pushRingForTests('BTC', [{ price: 99.85, qty: 900, x: 45 }], Date.now() - 1000);
    // next snapshot: the 99.85 level is GONE entirely (not merely smaller)
    const b = bids(20).filter(l => l.price !== 99.85);
    const a = analyzeDepth({ bids: b, asks: asks(20), ring: __testables._rings.get('BTC') || [], ltp: 100, now: Date.now() });
    expect(a.spoofRisk).toBe(true);
    expect(a.vanishedWalls.length).toBeGreaterThan(0);
  });

  it('a wall that merely SHRANK (level still there) is not spoof', () => {
    __testables.__pushRingForTests('BTC', [{ price: 99.8, qty: 900, x: 45 }], Date.now() - 1000);
    const b = bids(20); // 99.8 still present at ~16 qty
    const a = analyzeDepth({ bids: b, asks: asks(20), ring: __testables._rings.get('BTC') || [], ltp: 100, now: Date.now() });
    expect(a.spoofRisk).toBe(false);
  });

  it('empty book → ok:false (honest degrade)', () => {
    expect(analyzeDepth({ bids: [], asks: [] }).ok).toBe(false);
  });
});

describe('parseDhanDepth (India best-5 L2)', () => {
  it('parses the marketfeed/quote depth shape', () => {
    const raw = { data: { 12345: { depth: {
      buy_price: [100, 99.9, 99.8, 99.7, 99.6],
      buy_quantity: [10, 20, 30, 40, 50],
      sell_price: [100.1, 100.2, 100.3, 100.4, 100.5],
      sell_quantity: [11, 21, 31, 41, 51],
    } } } };
    const snap = parseDhanDepth(raw, 12345);
    expect(snap.bids).toHaveLength(5);
    expect(snap.asks).toHaveLength(5);
    expect(snap.bids[0]).toEqual({ price: 100, qty: 10 });
    expect(snap.asks[4]).toEqual({ price: 100.5, qty: 51 });
  });
  it('missing depth → null (honest degrade)', () => {
    expect(parseDhanDepth({ data: {} }, 12345)).toBeNull();
    expect(parseDhanDepth({ data: { 12345: { depth: { buy_price: [0, 0], buy_quantity: [0, 0], sell_price: [0, 0], sell_quantity: [0, 0] } } } }, 12345)).toBeNull();
  });
});

describe('readDepth (unified reader, injected snapshots)', () => {
  it('serves a cached crypto snapshot with ladder + analysis + ring push', async () => {
    const b = bids(20); b[1] = { price: 99.9, qty: 800 };
    __testables.__setCryptoDepthForTests('BTC', b, asks(20));
    const r = await readDepth('CRYPTO', 'BTC', { ltp: 100 });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('coindcx-spot-inr');
    expect(r.ladder.bids).toHaveLength(5);
    expect(r.bidWalls.length).toBeGreaterThan(0);
    expect(__testables._rings.get('BTC')?.length).toBe(1);
  });
  it('FUTURES is flagged as the spot-book proxy (perp depth not public)', async () => {
    __testables.__setCryptoDepthForTests('BTC', bids(20), asks(20));
    const r = await readDepth('FUTURES', 'BTC', {});
    expect(r.ok).toBe(true);
    expect(r.proxy).toBe(true);
    expect(r.source).toContain('proxy');
  });
  it('India: Dhan disconnected → ok:false with a reason (never throws)', async () => {
    const r = await readDepth('INDIA', 'RELIANCE', {});
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Dhan');
  });
});

describe('VolumeFlow fold-in (Pro #1 — zero weight-tuning route)', () => {
  const mkCtx = (depth: unknown) => ({
    market: 'CRYPTO', symbol: 'BTC', ltp: 100, changePct: 0.5,
    ind: { relVolume: 1.3 }, depth,
  });
  it('without ctx.depth the vote is byte-identical to the legacy behavior', () => {
    const legacy = volumeVote(mkCtx(undefined));
    expect(legacy.dir).toBe(1); // relVolume 1.3 + chg 0.5 → volume-backed upmove
    expect(legacy.reasons).toEqual(['Relative volume 1.3x', 'Volume-backed upmove']);
  });
  it('a stacked bid book with a near wall lifts the score with visible reasons', () => {
    const b = bids(20); b[0] = { price: 99.95, qty: 900 };
    const a = analyzeDepth({ bids: b, asks: asks(20), ltp: 100 });
    const v = volumeVote(mkCtx(a));
    expect(v.reasons.some((r: string) => r.includes('L2 top-5 bids'))).toBe(true);
    expect(v.reasons.some((r: string) => r.includes('bid wall'))).toBe(true);
  });
  it('a stacked ASK book pushes the vote the other way', () => {
    const ak = asks(20); ak[0] = { price: 100.06, qty: 900 };
    const a = analyzeDepth({ bids: bids(20), asks: ak, ltp: 100 });
    const v = volumeVote(mkCtx(a));
    expect(v.reasons.some((r: string) => r.includes('L2 top-5 asks'))).toBe(true);
  });
  it('spoof risk cuts conviction, not direction', () => {
    __testables.__pushRingForTests('BTC', [{ price: 99.85, qty: 900, x: 45 }], Date.now() - 500);
    const b = bids(20).filter(l => l.price !== 99.85);
    const a = analyzeDepth({ bids: b, asks: asks(20), ring: __testables._rings.get('BTC') || [], ltp: 100, now: Date.now() });
    const v = volumeVote(mkCtx(a));
    expect(v.reasons.some((r: string) => r.includes('spoof'))).toBe(true);
  });
});

describe('v10.6.1 — raw-precision walls + deeper book for the slippage walk', () => {
  it('sub-₹0.01 token books (SHIB-class) keep exact wall prices — r2() used to collapse them to 0', () => {
    // SHIBINR-style ladder: prices at 0.0007x, one huge level
    const shibBids = Array.from({ length: 12 }, (_, i) => ({ price: 0.00070 - i * 0.00001, qty: 1e6 + i }));
    shibBids[3] = { price: 0.00067, qty: 9e6 };
    const walls = findWalls(shibBids);
    expect(walls.length).toBeGreaterThan(0);
    expect(walls[0].price).toBeCloseTo(0.00067, 8); // NOT 0
    const a = analyzeDepth({ bids: shibBids, asks: shibBids.map(l => ({ ...l, price: l.price + 0.00001 })), ltp: 0.00070 });
    expect(a.nearBidWall?.distPct).not.toBe(-100); // the old r2 bug produced garbage distances
    expect(a.nearBidWall?.distPct).toBeGreaterThan(0);
  });

  it('estimateSlippagePct walks the deeper `book`, not just the 5-level `ladder`', () => {
    // thin top-5 ladder + deep book: the walk must span the book
    const thinLadder = {
      ladder: {
        bids: [{ price: 99.9, qty: 1 }, { price: 99.8, qty: 1 }],
        asks: [{ price: 100, qty: 1 }, { price: 100.5, qty: 1 }],
      },
    };
    const withBook = {
      ...thinLadder,
      book: {
        bids: [{ price: 99.9, qty: 1 }, { price: 99.8, qty: 1 }, { price: 99.7, qty: 400 }],
        asks: [{ price: 100, qty: 1 }, { price: 100.5, qty: 1 }, { price: 101, qty: 500 }],
      },
    };
    // ladder-only: a ₹40k BUY exhausts the 2-level ask ladder (a LOWER
    // bound — only ₹200.5 of ₹40k fillable)
    const estLadder = estimateSlippagePct({ side: 'BUY', notional: 40_000, depth: thinLadder });
    expect(estLadder.bookExhausted).toBe(true);
    expect(estLadder.filledPct).toBeLessThan(1);
    // with the book attached: the deep 101-level absorbs the whole
    // notional — no false exhaustion, an honest full-book walk
    const estBook = estimateSlippagePct({ side: 'BUY', notional: 40_000, depth: withBook });
    expect(estBook.bookExhausted).toBe(false);
    expect(estBook.filledPct).toBe(100);
    expect(estBook.pct).not.toBeNull();
  });

  it('readDepth returns both the 5-level UI ladder and the 20-level walk book', async () => {
    __testables.__setCryptoDepthForTests('BTC', bids(20), asks(20));
    const r = await readDepth('CRYPTO', 'BTC', { ltp: 100 });
    expect(r.ok).toBe(true);
    expect(r.ladder.bids).toHaveLength(5);
    expect(r.book.bids).toHaveLength(20);
    expect(r.book.bids[0]).toEqual(r.ladder.bids[0]); // same best level
  });
});

describe('estimateSlippagePct + splitOrderForSlippage (Pro #6)', () => {
  const book = { ladder: { bids: [{ price: 99.9, qty: 5 }, { price: 99.8, qty: 10 }], asks: [{ price: 100, qty: 2 }, { price: 100.5, qty: 3 }, { price: 101, qty: 10 }] } };
  it('walks the asks for a BUY and reports VWAP-vs-touch drift', () => {
    const est = estimateSlippagePct({ side: 'BUY', notional: 300, depth: book });
    // fill 2@100 (200) + 1@100.5 (100) → vwap ≈ 100.166 → +0.166%
    expect(est.pct).toBeGreaterThan(0.1);
    expect(est.pct).toBeLessThan(0.25);
    expect(est.bookExhausted).toBe(false);
  });
  it('walks the bids for a SELL (adverse drift reported as ≥ 0)', () => {
    const est = estimateSlippagePct({ side: 'SELL', notional: 600, depth: book });
    // 5@99.9 (499.5) + ~1@99.8 → vwap below the touch → adverse slip > 0
    expect(est.pct).toBeGreaterThan(0);
    expect(est.pct).toBeLessThan(0.15);
  });
  it('notional beyond the visible book → bookExhausted (a LOWER bound)', () => {
    const est = estimateSlippagePct({ side: 'BUY', notional: 50_000, depth: book });
    expect(est.bookExhausted).toBe(true);
    expect(est.filledPct).toBeLessThan(100);
  });
  it('no depth → null slip, single order (honest degrade)', () => {
    expect(estimateSlippagePct({ side: 'BUY', notional: 100, depth: null }).pct).toBeNull();
    const s = splitOrderForSlippage({ side: 'BUY', notional: 100, depth: null, thresholdPct: 0.35 });
    expect(s.children).toBe(1);
  });
  it('slip under the threshold → single order', () => {
    const s = splitOrderForSlippage({ side: 'BUY', notional: 150, depth: book, thresholdPct: 0.35 });
    expect(s.children).toBe(1);
  });
  it('slip over the threshold → 2-4 TWAP children scaled by severity', () => {
    const s2 = splitOrderForSlippage({ side: 'BUY', notional: 300, depth: book, thresholdPct: 0.1 });
    expect(s2.children).toBe(2); // 0.166/0.1 → 2
    const s4 = splitOrderForSlippage({ side: 'BUY', notional: 50_000, depth: book, thresholdPct: 0.1 });
    expect(s4.children).toBe(4); // book exhausted → max split
  });
});
