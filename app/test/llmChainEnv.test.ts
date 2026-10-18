// ============================================================
// test/llmChainEnv.test.ts — v20.6 LLM_PRIORITY + LLM_LOCAL_ONLY
// ------------------------------------------------------------
// Locks the env-driven chain order + local-only short-circuit:
//   1. LLM_PRIORITY env flips the chain order (cloud providers not
//      in the list are SKIPPED entirely — no fetch, no key probe).
//   2. LLM_LOCAL_ONLY=1 → cloud providers skipped EVEN IF listed.
//   3. default (env unset) → historical order (gemini→groq→...→ollama).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

const _env = vi.hoisted(() => ({}));

// stub fetch so we don't actually hit cloud APIs
const _fetchCalls = vi.hoisted(() => []);
vi.stubGlobal('fetch', vi.fn(async (...args) => {
  _fetchCalls.push(args[0]);
  // return a non-JSON body so tryParseJson returns null and the chain continues
  return { ok: false, status: 503, json: async () => null, text: async () => '' };
}));

// stub the sentinel so no cooldowns are armed in tests
vi.mock('../server/ai/llmSentinel.js', () => ({
  engineSkip: () => false,
  engineTrack: () => {},
  engineOk: () => {},
  ollamaProbe: async () => false, // never reachable in tests
  ollamaCompatCfg: () => ({ url: 'http://localhost:11434', defModel: 'qwen3:8b' }),
}));

import { __testables, councilAsk } from '../server/ai/llmChain.js';

beforeEach(() => {
  // reset env — explicitly clear every env var the tests set (process.env
  // is global, leftover values from previous tests would bleed in).
  delete process.env.LLM_PRIORITY;
  delete process.env.LLM_LOCAL_ONLY;
  delete process.env.OLLAMA_MODEL;
  _fetchCalls.length = 0;
});

describe('v20.6 llmChain env-driven order', () => {
  it('_chainOrder: default (env unset) → historical gemini→groq→...→ollama', () => {
    const order = __testables._chainOrder();
    expect(order).toEqual(['gemini', 'groq', 'cerebras', 'openrouter', 'huggingface', 'nvidia', 'ollama']);
  });

  it('_chainOrder: LLM_PRIORITY flips order, providers not in list skipped', () => {
    process.env.LLM_PRIORITY = 'groq,gemini,ollama';
    const order = __testables._chainOrder();
    expect(order).toEqual(['groq', 'gemini', 'ollama']);
    // cerebras/openrouter/huggingface/nvidia are NOT in the list → skipped
  });

  it('_localOnly: LLM_LOCAL_ONLY=1 → true', () => {
    process.env.LLM_LOCAL_ONLY = '1';
    expect(__testables._localOnly()).toBe(true);
  });

  it('_localOnly: LLM_LOCAL_ONLY=true (case-insensitive) → true', () => {
    process.env.LLM_LOCAL_ONLY = 'TRUE';
    expect(__testables._localOnly()).toBe(true);
  });

  it('_localOnly: default (env unset) → false', () => {
    expect(__testables._localOnly()).toBe(false);
  });

  it('LLM_LOCAL_ONLY=1 → cloud providers skipped entirely (no fetch)', async () => {
    process.env.LLM_LOCAL_ONLY = '1';
    process.env.LLM_PRIORITY = 'gemini,groq,ollama';
    const KEYS = { gemini: 'gk', groq: 'gq' };
    await councilAsk('prompt', { KEYS, OPENAI_COMPAT: {} });
    // No cloud fetch should have fired (ollama probe is stubbed false → no ollama fetch either)
    expect(_fetchCalls.length).toBe(0);
  });

  it('LLM_PRIORITY without LLM_LOCAL_ONLY → only listed providers are probed', async () => {
    process.env.LLM_PRIORITY = 'groq,gemini'; // cerebras NOT in list
    const KEYS = { gemini: 'gk', groq: 'gq', cerebras: 'ck' };
    await councilAsk('prompt', { KEYS, OPENAI_COMPAT: {
      groq: { url: 'https://groq', defModel: 'g' },
      cerebras: { url: 'https://cb', defModel: 'c' },
    } });
    // Only groq + gemini fetches should have fired (cerebras not in priority list)
    const urls = _fetchCalls.map(u => String(u));
    const groqHit = urls.some(u => u.includes('groq'));
    const geminiHit = urls.some(u => u.includes('generativelanguage'));
    const cerebrasHit = urls.some(u => u.includes('cb'));
    expect(groqHit).toBe(true);
    expect(geminiHit).toBe(true);
    expect(cerebrasHit).toBe(false);
  });
});
