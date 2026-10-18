// ============================================================
// test/metaEnsemble.test.ts — v10.5 META-ENSEMBLE STACKING (Upgrade 4)
// ------------------------------------------------------------
// Locks the Node consume side of the trained meta-learner:
//   1. AI_ENABLE_META_ENSEMBLE flag (default OFF)
//   2. flag OFF → aggregateVotesWithMeta = weighted, ZERO service calls
//   3. flag ON + service DOWN → graceful weighted fallback, breaker opens
//   4. flag ON + meta AGREES → meta confidence/grade used (source: meta)
//   5. flag ON + meta DISAGREES → weighted verdict kept, metaRead noted
//   6. flag ON + malformed response → weighted fallback
//   7. circuit breaker — no second call within the 5-min window
//   8. quorum honesty caps survive the meta layer (no bypass)
// The Python training/inference side has its own suite:
// ml-service/tests/test_meta_ensemble.py (feature contract 29,
// pkl-missing fallback, train→predict roundtrip).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-meta');

const {
  aggregateVotes, aggregateVotesWithMeta, metaEnsembleEnabled, __resetMetaBreakerForTests,
} = await import('../server/ai/ensemble.js');

const STRONG_VOTES = [
  { id: 'trend', weight: 1.4, dir: -1, conf: 95, reasons: [] },
  { id: 'momentum', weight: 1.3, dir: -1, conf: 88, reasons: [] },
  { id: 'volume', weight: 1.2, dir: -1, conf: 80, reasons: [] },
  { id: 'sr', weight: 1.1, dir: -1, conf: 78, reasons: [] },
  { id: 'smc', weight: 1.1, dir: -1, conf: 74, reasons: [] },
];
// 2 agreeing high-conviction voters — enough raw score to hit the 2-voter
// quorum cap (54), the honesty cap the meta layer must NOT bypass.
const WEAK_VOTES = [
  { id: 'trend', weight: 1.4, dir: -1, conf: 95, reasons: [] },
  { id: 'momentum', weight: 1.3, dir: -1, conf: 90, reasons: [] },
];

let fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetMetaBreakerForTests();
  fetchCalls = [];
  delete process.env.AI_ENABLE_META_ENSEMBLE;
  delete process.env.ML_SERVICE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.fetch = undefined;
  globalThis.fetch = originalFetch;
});

describe('v10.5 meta-ensemble — flag + defaults', () => {
  it('AI_ENABLE_META_ENSEMBLE defaults ON (v21.12 — ml-service deploy ke baad user ask)', () => {
    expect(metaEnsembleEnabled()).toBe(true);
  });

  it('accepts truthy spellings', () => {
    for (const v of ['true', '1', 'on', 'yes', 'TRUE']) {
      process.env.AI_ENABLE_META_ENSEMBLE = v;
      expect(metaEnsembleEnabled()).toBe(true);
    }
    process.env.AI_ENABLE_META_ENSEMBLE = 'false';
    expect(metaEnsembleEnabled()).toBe(false);
  });

  it('flag OFF → weighted verdict, source "weighted", zero service calls', async () => {
    process.env.AI_ENABLE_META_ENSEMBLE = 'false'; // v21.12: default ON — explicit OFF pin
    vi.stubGlobal('fetch', vi.fn(async (...args) => {
      fetchCalls.push(String(args[0]));
      throw new Error('should not be called');
    }));
    const c = await aggregateVotesWithMeta(STRONG_VOTES);
    expect(c.source).toBe('weighted');
    expect(c.grade).toBe('STRONG');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('v10.5 meta-ensemble — service fallbacks (flag ON)', () => {
  beforeEach(() => { process.env.AI_ENABLE_META_ENSEMBLE = 'true'; });

  it('service DOWN → weighted fallback, no crash, breaker opens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const c = await aggregateVotesWithMeta(STRONG_VOTES);
    expect(c.source).toBe('weighted');
    expect(c.grade).toBe('STRONG');
    expect(c.confidence).toBe(aggregateVotes(STRONG_VOTES).confidence);
  });

  it('malformed response → weighted fallback (contract enforcement)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, side: 'SIDEWAYS', confidence: 'high' }), // garbage
    })));
    const c = await aggregateVotesWithMeta(STRONG_VOTES);
    expect(c.source).toBe('weighted');
    expect(c.grade).toBe('STRONG');
  });

  it('meta AGREES with the weighted side → meta confidence/grade used', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, side: 'SHORT', confidence: 82, agreement: 0.9, grade: 'STRONG', source: 'meta', label: 'DOWN' }),
    })));
    const c = await aggregateVotesWithMeta(STRONG_VOTES);
    expect(c.source).toBe('meta');
    expect(c.side).toBe('SHORT');
    expect(c.confidence).toBe(82);
    expect(c.grade).toBe('STRONG');
    expect(c.summary).toContain('meta-ensemble');
  });

  it('meta DISAGREES → weighted verdict kept + metaRead noted (no side flip)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, side: 'LONG', confidence: 91, agreement: 0.8, grade: 'STRONG', source: 'meta', label: 'UP' }),
    })));
    const c = await aggregateVotesWithMeta(STRONG_VOTES);
    expect(c.source).toBe('weighted');
    expect(c.side).toBe('SHORT'); // the committee's own side survives
    expect(c.metaRead).toEqual({ side: 'LONG', confidence: 91 });
  });

  it('meta responds source:"weighted" (pkl missing server-side) → pass-through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, side: 'SHORT', confidence: 76, agreement: 0.9, grade: 'STRONG', source: 'weighted' }),
    })));
    const c = await aggregateVotesWithMeta(STRONG_VOTES);
    expect(c.source).toBe('weighted');
  });

  it('quorum honesty caps survive (a 2-voter signal cannot meta-boost past its cap)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, side: 'SHORT', confidence: 95, agreement: 0.9, grade: 'STRONG', source: 'meta', label: 'DOWN' }),
    })));
    const c = await aggregateVotesWithMeta(WEAK_VOTES);
    // 2 voters → quorumCapped, and the meta layer must not bypass it
    expect(aggregateVotes(WEAK_VOTES).quorumCapped).toBe(true);
    expect(c.confidence).toBeLessThanOrEqual(54);
    expect(c.source).toBe('meta-capped');
  });

  it('circuit breaker: one failure skips calls for the next 5 minutes', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; throw new Error('down'); }));
    await aggregateVotesWithMeta(STRONG_VOTES);
    await aggregateVotesWithMeta(STRONG_VOTES);
    await aggregateVotesWithMeta(STRONG_VOTES);
    expect(calls).toBe(1); // breaker opened after the first failure
    // breaker reset → next call goes through again
    __resetMetaBreakerForTests();
    await aggregateVotesWithMeta(STRONG_VOTES);
    expect(calls).toBe(2);
  });

  it('mtfAgreement rides along (the MTF cap still applies on the weighted base)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const c = await aggregateVotesWithMeta(STRONG_VOTES, undefined, { mtfAgreement: 1 / 3 });
    expect(c.grade).toBe('ACTION'); // capped, even via the meta-aware path
    expect(c.mtfCapped).toBe(true);
  });
});
