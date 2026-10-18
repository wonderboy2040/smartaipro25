// ============================================================
// test/boardResilience.test.ts — v9.2.1 SIGNAL BOARD RESILIENCE
// ------------------------------------------------------------
// The CoinDCX TAB's "Agent status unavailable — API/proxy issue
// (har 15s me retry)" death-spiral had a mechanical root cause:
// every 15s status poll + every 30s board poll started its OWN cold
// full-universe scan on slow hosts, stacking computes until every
// request timed out. These tests lock the two fixes:
//   1. SINGLE-FLIGHT — concurrent cold getSignals callers JOIN one
//      compute (the underlying TV fetch runs exactly ONCE).
//   2. warmOnly — a status-style poll NEVER computes inline: serves
//      the cached (possibly stale) board instantly, warms in the
//      background, answers null only when nothing exists at all.
// Hermetic: data.js + network are mocked OFFLINE.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same trick as the other suites)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-board-res');

let tvIndiaCalls = 0;
vi.mock('../server/ai/data.js', () => ({
  INDIA_UNIVERSE: ['RELIANCE', 'TCS', 'INFY'],
  CRYPTO_UNIVERSE: ['BTC', 'ETH'],
  FUTURES_UNIVERSE: ['B-BTC_USDT', 'B-ETH_USDT'],
  fetchTVIndiaBatch: async () => { tvIndiaCalls++; return {}; },
  fetchTVCryptoBatch: async () => ({}),
  fetchCoinDcxCandles: async () => null,
  fetchYahooQuotes: async () => ({}),
  isNseOpen: () => false,
}));

// every raw network call in signals.js itself (Yahoo candle fetches
// inside the module, expertPicks' Binance/USDINR legs) → OFFLINE
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test)'); }));

const { getSignals, __clearSignalCaches, __setBoardCacheForTests } = await import('../server/ai/signals.js');

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

beforeEach(() => {
  __clearSignalCaches();
  tvIndiaCalls = 0;
});

describe('v9.2.1 single-flight — concurrent cold board computes JOIN one scan', () => {
  it('two concurrent cold getSignals share ONE compute (same payload object, TV fetched once)', async () => {
    const [a, b] = await Promise.all([
      getSignals('INDIA', {}, { limit: 10 }),
      getSignals('INDIA', {}, { limit: 10 }),
    ]);
    // ONE TV batch fetch — the second caller joined the first's compute
    expect(tvIndiaCalls).toBe(1);
    // both callers received the SAME resolved payload (same promise)
    expect(a).toBe(b);
  }, 20_000);

  it('a THIRD caller arriving after completion hits the WARM cache (still one TV fetch)', async () => {
    await getSignals('INDIA', {}, { limit: 10 });
    const second = await getSignals('INDIA', {}, { limit: 10 });
    expect(tvIndiaCalls).toBe(1); // warm board served from cache
    expect(second).toBeTruthy();
  }, 20_000);

  it('after the TTL the next cold poll runs exactly ONE fresh compute', async () => {
    await getSignals('INDIA', {}, { limit: 10 });
    // age the cached board past the 60s India TTL
    __setBoardCacheForTests('INDIA', { ok: false, market: 'INDIA', reason: 'aged', signals: [], topFive: [] }, 120_000);
    const [a, b] = await Promise.all([
      getSignals('INDIA', {}, { limit: 10 }),
      getSignals('INDIA', {}, { limit: 10 }),
    ]);
    // 1 (initial) + 1 (the single refresh both joined)
    expect(tvIndiaCalls).toBe(2);
    expect(a).toBe(b);
  }, 20_000);
});

describe('v9.2.1 warmOnly — status polls never compute inline', () => {
  it('COLD + nothing cached → answers null in milliseconds and warms in the background', async () => {
    const t0 = Date.now();
    const v = await getSignals('INDIA', {}, { limit: 6, warmOnly: true });
    const ms = Date.now() - t0;
    expect(v).toBeNull();       // no inline compute on the poll path
    expect(ms).toBeLessThan(1500); // effectively instant
    // the background warm DID run (exactly one compute kicked)
    expect(await waitFor(() => tvIndiaCalls === 1)).toBe(true);
    // and a follow-up status poll now serves the warmed board
    const v2 = await getSignals('INDIA', {}, { limit: 6, warmOnly: true });
    expect(v2?.ok).toBe(false); // offline hermetic board → honest degrade payload, but SERVED
    expect(v2?.reason).toContain('No India market data');
  }, 20_000);

  it('STALE cached board → warmOnly serves it instantly (no error screen)', async () => {
    const board = { ok: true, market: 'INDIA', signals: [], topFive: [], generatedAt: Date.now() };
    __setBoardCacheForTests('INDIA', board, 5 * 60_000); // 5 min old
    const t0 = Date.now();
    const v = await getSignals('INDIA', {}, { limit: 6, warmOnly: true });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(v).toBe(board); // the stale payload object served as-is
  }, 20_000);

  it('repeated warmOnly polls never stack computes (background warm deduped)', async () => {
    __setBoardCacheForTests('INDIA', { ok: true, market: 'INDIA', signals: [], topFive: [] }, 5 * 60_000);
    const results = await Promise.all([
      getSignals('INDIA', {}, { limit: 6, warmOnly: true }),
      getSignals('INDIA', {}, { limit: 6, warmOnly: true }),
      getSignals('INDIA', {}, { limit: 6, warmOnly: true }),
    ]);
    expect(results.every(Boolean)).toBe(true);
    // single background refresh for the aged board — never 3
    expect(await waitFor(() => tvIndiaCalls === 1)).toBe(true);
  }, 20_000);
});
