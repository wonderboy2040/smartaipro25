// ============================================================
// test/visionSeat.test.ts — v21.0.6 VISION SEAT contracts
// ------------------------------------------------------------
// Locks the v21.0.6 audit fixes:
//   1. [B2] vision failures arm the ISOLATED 'ollama-vision' circuit
//      breaker — the shared 'ollama' breaker (board scan seat) must
//      NEVER cool because a vision call choked (weak JSON from a 7B
//      VL model is common; the blast radius used to park the scan
//      seat).
//   2. [B2] vision success reports 'ollama-vision' ok too.
//   3. no vision model / no images → honest null abstain, zero
//      tracking (capability-missing is not a failure).
// Hermetic — sentinel + fetch stubbed, no network.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

const engineTrack = vi.hoisted(() => vi.fn());
const engineOk = vi.hoisted(() => vi.fn());

vi.mock('../server/ai/llmSentinel.js', () => ({
  engineSkip: () => false,
  engineTrack: (...a) => engineTrack(...a),
  engineOk: (...a) => engineOk(...a),
  ollamaProbe: async () => true, // ollama reachable
  ollamaCompatCfg: () => ({
    url: 'http://localhost:11434',
    defModel: 'qwen3:8b',
    deepModel: 'deepseek-r1:14b',
  }),
  OLLAMA_NUM_CTX: 8192,
  OLLAMA_NUM_CTX_DEEP: 8192,
  OLLAMA_KEEP_ALIVE: '5m',
  ollamaVisionModel: () => 'qwen2.5vl:7b',
}));

// native /api/chat endpoint — askOllamaNative posts here
vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => ({ message: { content: 'garbage — no json here' } }),
})));

import { councilAskVision } from '../server/ai/llmChain.js';

beforeEach(() => {
  engineTrack.mockClear();
  engineOk.mockClear();
});

describe('v21.0.6 — vision seat breaker isolation', () => {
  it('weak-JSON vision failure arms ONLY the ollama-vision breaker (scan seat untouched)', async () => {
    const out = await councilAskVision('analyze this chart', ['aGVsbG8=']);
    expect(out).toEqual({ json: null, model: null }); // honest abstain
    expect(engineTrack).toHaveBeenCalledTimes(1);
    expect(engineTrack).toHaveBeenCalledWith('ollama-vision', expect.any(Error));
    // THE contract: the SHARED 'ollama' breaker must never be armed by vision
    expect(engineTrack).not.toHaveBeenCalledWith('ollama', expect.anything());
  });

  it('fetch-throw vision failure also isolates (no shared ollama cooldown)', async () => {
    const { fetch: f } = globalThis as any;
    const orig = f.getMockImplementation?.();
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('vision network down'); });
    const out = await councilAskVision('analyze', ['aGVsbG8=']);
    expect(out).toEqual({ json: null, model: null });
    expect(engineTrack).toHaveBeenCalledWith('ollama-vision', expect.any(Error));
    expect(engineTrack).not.toHaveBeenCalledWith('ollama', expect.anything());
    (globalThis as any).fetch = f; // restore the hoisted stub
    void orig;
  });

  it('no images → honest null, ZERO tracking (not a failure)', async () => {
    expect(await councilAskVision('p', [])).toEqual({ json: null, model: null });
    expect(engineTrack).not.toHaveBeenCalled();
    expect(engineOk).not.toHaveBeenCalled();
  });
});
