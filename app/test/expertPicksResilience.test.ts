// ============================================================
// test/expertPicksResilience.test.ts — v9.2.1 EXPERT PICKS RESILIENCE
// ------------------------------------------------------------
// The CoinDCX TAB's "Expert engine unavailable — data feed
// unreachable" hard-error came from a cold full-universe scan that
// could not finish inside the client's 45s timeout on slow hosts —
// and every 60s retry started ANOTHER cold scan (plus the 65+ red-day
// fallback re-scanning from zero). These tests lock the three fixes:
//   1. STALE-SERVE (SWR) — a ≤10-min-old scan is served INSTANTLY
//      (flagged stale) while a refresh runs in the background.
//   2. MARKET-KEYED SCAN CACHE — minScore/limit are view filters;
//      the 65+ fallback reuses the SAME scan instead of re-scanning.
//   3. SCAN BUDGET — a cold scan that blows its time budget answers
//      with whatever was scored, honestly flagged partial.
//   4. FEED-DEAD FALLBACK — when discovery fails but a ≤45-min-old
//      scan exists, the old scan is served (flagged) instead of the
//      error screen.
// Hermetic: every network leg is mocked OFFLINE.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-xp-res');

vi.mock('../server/ai/signals.js', () => ({
  buildRegime: async () => ({}),
  fetchYahooIntradayCandles: async () => null,
}));
vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE', 'TCS'],
  CRYPTO_UNIVERSE: ['BTC', 'ETH'],
  fetchTVIndiaBatch: async () => ({}),
  // TV rows exist so the per-coin mapper survives to the candle leg
  fetchTVCryptoBatch: async (syms) => Object.fromEntries((syms || []).map((s) => [s, { usdPrice: 100, changePct: 1 }])),
  // the candle leg sleeps 25ms — this is what makes the budget test's
  // deadline observable (batches take longer than the tiny budget)
  fetchCoinDcxCandles: async () => { await new Promise((r) => setTimeout(r, 25)); return null; },
  isNseOpen: () => false,
}));
vi.mock('../server/ai/futures.js', () => ({
  futuresPairFor: (b) => `B-${b}_USDT`,
  fetchFuturesPrices: async () => { throw new Error('offline (test)'); },
  fetchFuturesCandles: async () => null,
  // v21.8.0: expertPicks imports the metals carve-out set
  METALS_BASES: ['XAU', 'XAG'],
}));
vi.mock('../server/cryptoStream.js', () => ({
  fetchCoinDcxTickers: async () => { throw new Error('WAF-blocked (test)'); },
}));

// Binance/USDINR legs → OFFLINE
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test)'); }));

const {
  getExpertPicks, __clearExpertPicksCaches, __setScanCacheForTests, __setUniverseForTests,
} = await import('../server/ai/expertPicks.js');

const PICK = (symbol, score) => ({
  symbol, market: 'CRYPTO', side: 'LONG', score,
  grade: score >= 80 ? 'STRONG' : 'ACTION', ltp: 100, changePct: 1,
  factors: [], smcReasons: [], priceSource: 'test', candleSource: null,
  plan: { side: 'LONG', entry: 100, stopLoss: 95, targets: { t1: 110, t2: 120, t3: 130 } },
  generatedAt: Date.now(),
});
const SCAN = (picks) => ({
  market: 'CRYPTO', scanned: picks.length, universeSize: picks.length,
  priceSource: 'test', marketOpen: true, regime: {}, picks, partial: false,
  partialNote: null, generatedAt: Date.now(),
});

// v9.2.2: await the drain — a background refresh from the previous test
// must fully settle before the next one starts (single-flight join guard).
beforeEach(async () => { await __clearExpertPicksCaches(); });

describe('v9.2.1 SWR — a stale scan is served INSTANTLY, never an error', () => {
  it('a 5-min-old scan serves immediately with stale+refreshing flags and minScore-filtered picks', async () => {
    __setScanCacheForTests('CRYPTO', SCAN([PICK('AAA', 85), PICK('BBB', 72), PICK('CCC', 60)]), 5 * 60_000);
    const t0 = Date.now();
    const v = await getExpertPicks('CRYPTO', { minScore: 80, limit: 12 });
    expect(Date.now() - t0).toBeLessThan(1500); // instant — no cold scan on the path
    expect(v.ok).toBe(true);
    expect(v.stale).toBe(true);
    expect(v.refreshing).toBe(true); // background refresh announced
    expect(v.staleAgeSec).toBeGreaterThanOrEqual(290);
    expect(v.picks.map((p) => p.symbol)).toEqual(['AAA']); // 80+ filter held
  }, 20_000);

  it('MARKET-KEYED cache: the 65+ fallback reuses the SAME scan (no second universe pass)', async () => {
    __setScanCacheForTests('CRYPTO', SCAN([PICK('AAA', 85), PICK('BBB', 72), PICK('CCC', 60)]), 5 * 60_000);
    const v80 = await getExpertPicks('CRYPTO', { minScore: 80, limit: 12 });
    const v65 = await getExpertPicks('CRYPTO', { minScore: 65, limit: 12 });
    expect(v80.picks.map((p) => p.symbol)).toEqual(['AAA']);
    expect(v65.picks.map((p) => p.symbol)).toEqual(['AAA', 'BBB']); // same scan, wider view
    expect(v65.stale).toBe(true); // still the same cached scan, no re-scan
  }, 20_000);

  it('limit is a pure view cut — the underlying scan is untouched', async () => {
    __setScanCacheForTests('CRYPTO', SCAN([PICK('A1', 90), PICK('A2', 88), PICK('A3', 86), PICK('A4', 84)]), 30_000);
    const v = await getExpertPicks('CRYPTO', { minScore: 80, limit: 2 });
    expect(v.picks.map((p) => p.symbol)).toEqual(['A1', 'A2']);
    expect(v.scanned).toBe(4); // scan-level stats, not the view cut
    expect(v.universeSize).toBe(4);
  }, 20_000);
});

describe('v9.2.1 scan budget — a slow cold scan still ANSWERS (partial, honest)', () => {
  it('budget exceeded → returns what was scored with partial flag and universe stats', async () => {
    __setUniverseForTests('spot-inr', Array.from({ length: 30 }, (_, i) => `C${i}`));
    const v = await getExpertPicks('CRYPTO', { minScore: 80, limit: 12, budgetMs: 5 });
    expect(v.ok).toBe(true);            // ANSWERED — not a timeout, not an error
    expect(v.partial).toBe(true);       // honest flag
    expect(v.partialNote).toBeTruthy();
    expect(v.universeSize).toBe(30);    // universe discovered fully
    expect(v.scanned).toBeLessThan(30); // coverage honestly partial
  }, 30_000);

  it('single-flight: concurrent cold requests share ONE scan', async () => {
    __setUniverseForTests('spot-inr', Array.from({ length: 24 }, (_, i) => `D${i}`));
    const [a, b] = await Promise.all([
      getExpertPicks('CRYPTO', { minScore: 80, limit: 12, budgetMs: 5 }),
      getExpertPicks('CRYPTO', { minScore: 65, limit: 12, budgetMs: 5 }),
    ]);
    // both ANSWERED from the one shared scan (same market-level stats)
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.universeSize).toBe(24);
    expect(b.universeSize).toBe(24);
    expect(a.generatedAt).toBe(b.generatedAt); // same scan → same timestamp
  }, 30_000);
});

describe('v9.2.1 feed-dead fallback — an old scan beats an error screen', () => {
  it('discovery fails + a 20-min-old scan exists → the old scan is served, flagged', async () => {
    // 20 min: past the SWR window, inside the 45-min fail-fallback window
    __setScanCacheForTests('CRYPTO', SCAN([PICK('OLD', 88)]), 20 * 60_000);
    __setUniverseForTests('spot-inr', []);
    const v = await getExpertPicks('CRYPTO', { minScore: 80, limit: 12 });
    expect(v.ok).toBe(true);
    expect(v.stale).toBe(true);
    expect(v.staleReason).toBeTruthy();
    expect(v.staleAgeSec).toBeGreaterThanOrEqual(1190);
    expect(v.picks.map((p) => p.symbol)).toEqual(['OLD']);
  }, 20_000);

  it('discovery fails + scan older than the fail window → honest ok:false payload', async () => {
    __setScanCacheForTests('CRYPTO', SCAN([PICK('ANCIENT', 88)]), 50 * 60_000);
    __setUniverseForTests('spot-inr', []);
    const v = await getExpertPicks('CRYPTO', { minScore: 80, limit: 12 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('universe discovery failed');
    expect(v.picks).toEqual([]);
    expect(v.universeSize).toBe(0);
  }, 20_000);
});
