// ============================================================
// test/topFive.test.ts — v18.6.1 STALENESS & QUORUM (board integrity)
// ------------------------------------------------------------
// The CoinDCX Global Futures CL case: a 4/9-vote, 1h 7m stale SHORT sat
// at the top of the board looking as actionable as a fresh full-quorum
// signal. This suite locks the three structural fixes:
//   Fix 1 — staleness decay in computeTopFive ranking score
//           (1.0 fresh → linear → ×0.15 floor at 60m+)
//   Fix 2 — quorum hard gate (<5 directional votes never eligible
//           for the top-5 headline ranking; boundary 5 passes)
//   Fix 4 — liveInvalidationCheck (server canonical copy): SL already
//           through → invalidated; >0.5×ATR past the far entry-zone
//           edge → weakening; parity with the frontend mirror.
// ============================================================
// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same trick as the other suites)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-topfive');

const { computeTopFive, stalenessFactor } = await import('../server/ai/signals.js');
const { liveInvalidationCheck } = await import('../server/ai/superIntel.js');
const { liveInvalidationCheck: clientCheck } = await import('../src/components/aitrading/liveInvalidation');

const NOW = Date.now();
const minutes = (m) => m * 60_000;

const SIG = (over = {}) => ({
  symbol: 'RELIANCE', market: 'INDIA', side: 'LONG', grade: 'STRONG',
  confidence: 80, agreement: 0.75, participation: 0.9, participating: 9, totalModels: 10,
  ltp: 2400, changePct: 1.2,
  plan: { entry: 2400, stopLoss: 2320, target1: 2480, target2: 2560, riskPct: 3.33, rewardRisk: 2 },
  votes: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, dir: i < 7 ? 1 : -1, conf: 70 })),
  summary: 'test', aiNote: null, executable: true, generatedAt: NOW,
  ...over,
});

// signalAge with a last board-confirm `minsAgo` minutes ago
const AGED = (minsAgo, over = {}) => SIG({
  signalAge: { firstSeenAt: NOW - minutes(Math.max(minsAgo, 90)), lastSeenAt: NOW - minutes(minsAgo), ageMs: minutes(Math.max(minsAgo, 90)), flips24h: 0 },
  ...over,
});

// ---------------- Fix 1: stalenessFactor ----------------
describe('v18.6.1 stalenessFactor — the decay curve', () => {
  it('0-30 min since last board confirm → full weight (1.0)', () => {
    expect(stalenessFactor(AGED(0), NOW)).toBe(1);
    expect(stalenessFactor(AGED(10), NOW)).toBe(1);
    expect(stalenessFactor(AGED(30), NOW)).toBe(1);
  });
  it('30-60 min → linear decay 1.0 → 0.15 (continuous, monotonic)', () => {
    const f45 = stalenessFactor(AGED(45), NOW);
    expect(f45).toBeLessThan(1);
    expect(f45).toBeGreaterThan(0.15);
    // exactly the plan's linear form: 1 − 0.85 × (45−30)/30 = 0.575
    expect(f45).toBeCloseTo(1 - 0.85 * 0.5, 6);
    expect(stalenessFactor(AGED(35), NOW)).toBeGreaterThan(f45);
    expect(stalenessFactor(AGED(55), NOW)).toBeLessThan(f45);
  });
  it('60 min+ → 0.15 floor (visible demotion, never zero)', () => {
    expect(stalenessFactor(AGED(60), NOW)).toBe(0.15);
    expect(stalenessFactor(AGED(90), NOW)).toBe(0.15);
    expect(stalenessFactor(AGED(600), NOW)).toBe(0.15);
  });
  it('fallbacks: firstSeenAt when lastSeenAt absent; generatedAt when no signalAge; missing everything → fresh', () => {
    expect(stalenessFactor({ signalAge: { firstSeenAt: NOW - minutes(90) } }, NOW)).toBe(0.15);
    expect(stalenessFactor({ generatedAt: NOW - minutes(50) }, NOW)).toBeLessThan(1);
    expect(stalenessFactor({}, NOW)).toBe(1);
    expect(stalenessFactor(null, NOW)).toBe(1);
  });
});

// ---------------- Fix 1: ranking effect ----------------
describe('v18.6.1 computeTopFive — staleness decay moves the ranking', () => {
  it('age 10 min, high conf → ranks normally, NO staleness text', () => {
    const [p] = computeTopFive([AGED(10)], { niftyChange: 1 }, 'INDIA');
    expect(p).toBeTruthy();
    expect(p.rank).toBe(1);
    expect(p.rankReason).not.toContain('staleness');
  });
  it('same signal at 45 min → score visibly reduced + honest staleness reason', () => {
    const fresh = computeTopFive([AGED(10)], { niftyChange: 1 }, 'INDIA')[0];
    const aged = computeTopFive([AGED(45)], { niftyChange: 1 }, 'INDIA')[0];
    expect(aged.score).toBeLessThan(fresh.score);
    // 1 − 0.85×0.5 = 0.575 → toFixed(2) = '0.57' (IEEE repr)
    expect(aged.rankReason).toContain('staleness ×0.57');
  });
  it('age 90 min → near-floor score, loses rank #1 to a fresh mid signal', () => {
    const out = computeTopFive([
      AGED(90, { symbol: 'OLDHI', confidence: 95, agreement: 1, participation: 1 }),
      AGED(1, { symbol: 'NEWLO', confidence: 55, agreement: 0.55, participation: 0.6 }),
    ], { niftyChange: 1 }, 'INDIA');
    // OLDHI raw composite is far higher, but ×0.15 floors it below NEWLO
    expect(out[0].symbol).toBe('NEWLO');
    expect(out[1].symbol).toBe('OLDHI');
    expect(out[1].score).toBeLessThanOrEqual(Math.round(100 * 0.15 * 10) / 10 + 0.5);
  });
  it('stale signal still ranks when nothing else is eligible (floor ≠ deletion)', () => {
    const out = computeTopFive([AGED(120)], { niftyChange: 1 }, 'INDIA');
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeGreaterThan(0);
  });
});

// ---------------- Fix 2: quorum hard gate ----------------
describe('v18.6.1 computeTopFive — quorum hard gate (MIN_QUORUM_VOTES default 5)', () => {
  const votes = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, dir: i < n - 1 ? 1 : -1, conf: 70 }));
  it('4/9-vote ACTION signal (the CL case) → EXCLUDED from top-5 regardless of score', () => {
    const out = computeTopFive([
      SIG({ symbol: 'THIN', grade: 'ACTION', confidence: 95, votes: votes(4) }),
      SIG({ symbol: 'FULL', confidence: 60, votes: votes(9) }),
    ], { niftyChange: 1 }, 'INDIA');
    expect(out.map(p => p.symbol)).toEqual(['FULL']);
  });
  it('boundary: 5/9 votes → INCLUDED (>= not >)', () => {
    const out = computeTopFive([SIG({ symbol: 'EDGE', votes: votes(5) })], { niftyChange: 1 }, 'INDIA');
    expect(out.map(p => p.symbol)).toEqual(['EDGE']);
  });
  it('abstains do not count: 4 directional of 9 cast → excluded', () => {
    const withAbstains = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, dir: i < 4 ? 1 : 0, conf: 70 }));
    const out = computeTopFive([SIG({ symbol: 'ABS', votes: withAbstains })], { niftyChange: 1 }, 'INDIA');
    expect(out).toEqual([]);
  });
  it('unknown quorum (no votes, no voters) → passes (honest degrade, never silent empty board)', () => {
    const out = computeTopFive([SIG({ symbol: 'UNK', votes: undefined })], { niftyChange: 1 }, 'INDIA');
    expect(out.map(p => p.symbol)).toEqual(['UNK']);
  });
  it('voters field fallback: votes array absent but voters=4 → excluded', () => {
    const out = computeTopFive([SIG({ symbol: 'VFLD', votes: undefined, voters: 4 })], { niftyChange: 1 }, 'INDIA');
    expect(out).toEqual([]);
  });
});

// ---------------- Fix 4: liveInvalidationCheck (server + client parity) -------------
describe('v18.6.1 liveInvalidationCheck — between-cycle sanity', () => {
  it('LONG: live price at/below SL → invalidated', () => {
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: 100, stopLoss: 100, entryZoneLow: 105, entryZoneHigh: 110, atr: 2 })).toEqual({ status: 'invalidated', reason: expect.any(String) });
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: 99, stopLoss: 100, atr: 2 }).status).toBe('invalidated');
  });
  it('SHORT: live price at/above SL → invalidated', () => {
    expect(liveInvalidationCheck({ side: 'SHORT', liveLtp: 93.47, stopLoss: 93.47, atr: 0.3 }).status).toBe('invalidated');
    expect(liveInvalidationCheck({ side: 'SHORT', liveLtp: 94, stopLoss: 93.47, atr: 0.3 }).status).toBe('invalidated');
  });
  it('the CL trigger case: SHORT pullback zone 92.38-92.67, live 92.76, ATR 0.3 → still ok (0.09 < 0.5×ATR)', () => {
    const r = liveInvalidationCheck({ side: 'SHORT', liveLtp: 92.76, stopLoss: 93.47, entryZoneLow: 92.38, entryZoneHigh: 92.67, atr: 0.3 });
    expect(r.status).toBe('ok');
  });
  it('price 0.5×ATR+ beyond the FAR (adverse) zone edge → weakening', () => {
    // SHORT far edge = zone high (rally ran past the sell zone)
    expect(liveInvalidationCheck({ side: 'SHORT', liveLtp: 94, stopLoss: 96, entryZoneLow: 92.38, entryZoneHigh: 92.67, atr: 0.3 }).status).toBe('weakening');
    // LONG far edge = zone low (dip ran below the buy zone)
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: 100, stopLoss: 95, entryZoneLow: 108, entryZoneHigh: 110, atr: 2 }).status).toBe('weakening');
  });
  it('no entry zone → only the SL check applies (weakening skipped)', () => {
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: 999, stopLoss: 95, atr: 2 }).status).toBe('ok');
  });
  it('missing live price / SL → ok (never throws on partial data)', () => {
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: null, stopLoss: 95 }).status).toBe('ok');
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: 90, stopLoss: null }).status).toBe('ok');
    expect(liveInvalidationCheck({}).status).toBe('ok');
  });
  it('ATR fallback 1.2% when atr unknown/zero — ADVERSE direction only (v20.7.12 directional)', () => {
    // v20.7.12 [L-3]: FAVOURABLE move (LONG live 113 vs far edge 110 — price
    // zone se UPAR bhaga) ab 'ok' hai — pehle ye bhi weakening flag hota tha
    // (moon-ta hua LONG card pe jhootha amber). ADVERSE dip flag hota hai:
    // live 106.5 vs far edge 110, no atr → 0.5×1.2%×106.5 ≈ 0.64 < 3.5 → weakening
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: 113, stopLoss: 100, entryZoneLow: 110, entryZoneHigh: 111 }).status).toBe('ok');
    expect(liveInvalidationCheck({ side: 'LONG', liveLtp: 106.5, stopLoss: 100, entryZoneLow: 110, entryZoneHigh: 111 }).status).toBe('weakening');
  });
  it('frontend mirror is behaviour-identical to the server canonical copy', () => {
    const cases = [
      { side: 'LONG', liveLtp: 99, stopLoss: 100, entryZoneLow: 105, entryZoneHigh: 110, atr: 2 },
      { side: 'SHORT', liveLtp: 94, stopLoss: 93.47, entryZoneLow: 92.38, entryZoneHigh: 92.67, atr: 0.3 },
      { side: 'SHORT', liveLtp: 92.76, stopLoss: 93.47, entryZoneLow: 92.38, entryZoneHigh: 92.67, atr: 0.3 },
      { side: 'LONG', liveLtp: 113, stopLoss: 100, entryZoneLow: 110, entryZoneHigh: 111, atr: null },
      { side: 'LONG', liveLtp: null, stopLoss: 95 },
    ];
    for (const c of cases) {
      expect(clientCheck(c)).toEqual(liveInvalidationCheck(c));
    }
  });
});
