// ============================================================
// test/llmChainDeepModel.test.ts — v20.6.1 OLLAMA_DEEP_MODEL support
// ------------------------------------------------------------
// Locks the dual-model flow:
//   • scan path → councilAsk → OLLAMA_MODEL (qwen3:8b)
//   • deep path → councilAskDeep → OLLAMA_DEEP_MODEL (deepseek-r1:14b)
// On 16GB with OLLAMA_MAX_LOADED_MODELS=1, Ollama auto-evicts +
// re-loads on the model swap.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// stub fetch — capture the model field in the request body
const _calls = vi.hoisted(() => []);
vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
  _calls.push({ url, body: opts?.body });
  return { ok: false, status: 503, json: async () => null, text: async () => '' };
}));

// stub sentinel — ollamaProbe returns true so the ollama leg runs
vi.mock('../server/ai/llmSentinel.js', () => ({
  engineSkip: () => false,
  engineTrack: () => {},
  engineOk: () => {},
  ollamaProbe: async () => true, // ollama reachable in tests
  ollamaCompatCfg: (opts = {}) => ({
    url: 'http://localhost:11434/v1/chat/completions',
    defModel: opts.deep ? 'deepseek-r1:14b' : 'qwen3:8b',
    deepModel: 'deepseek-r1:14b',
  }),
  // v21.0: llmChain ab in exports ko bhi padhta hai (native /api/chat
  // path) — mock me define karna zaroori hai warna access pe vitest
  // "no export defined" throw karta hai jo councilAsk ke catch me
  // silently swallow ho jata tha (ollama leg dead — exactly wahi bug
  // jo ye test pakadta hai).
  OLLAMA_NUM_CTX: 8192,
  OLLAMA_NUM_CTX_DEEP: 8192,
  OLLAMA_KEEP_ALIVE: '5m',
  ollamaVisionModel: () => null,
}));

import { councilAsk, councilAskDeep } from '../server/ai/llmChain.js';

beforeEach(() => {
  delete process.env.LLM_LOCAL_ONLY;
  delete process.env.LLM_PRIORITY;
  delete process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_DEEP_MODEL;
  _calls.length = 0;
});

describe('v20.6.1 OLLAMA_DEEP_MODEL dual-model flow', () => {
  it('councilAskDeep is exported', () => {
    expect(typeof councilAskDeep).toBe('function');
  });

  it('scan path (councilAsk with LLM_LOCAL_ONLY=1) uses OLLAMA_MODEL', async () => {
    process.env.LLM_LOCAL_ONLY = '1';
    process.env.LLM_PRIORITY = 'ollama';
    await councilAsk('test prompt', { KEYS: {}, OPENAI_COMPAT: {} });
    // find the ollama fetch call (the only one since LLM_LOCAL_ONLY=1)
    const ollamaCall = _calls.find(c => String(c.url).includes('localhost:11434'));
    expect(ollamaCall).toBeTruthy();
    const body = JSON.parse(ollamaCall.body);
    expect(body.model).toBe('qwen3:8b');  // from ollamaCompatCfg() default (no deep)
  });

  it('deep path (councilAskDeep with LLM_LOCAL_ONLY=1) uses OLLAMA_DEEP_MODEL', async () => {
    process.env.LLM_LOCAL_ONLY = '1';
    process.env.LLM_PRIORITY = 'ollama';
    await councilAskDeep('deep prompt', { KEYS: {}, OPENAI_COMPAT: {} });
    const ollamaCall = _calls.find(c => String(c.url).includes('localhost:11434'));
    expect(ollamaCall).toBeTruthy();
    const body = JSON.parse(ollamaCall.body);
    expect(body.model).toBe('deepseek-r1:14b');  // deep cfg override
  });

  it('scan path uses scan model even after deep path ran (no cross-contamination)', async () => {
    process.env.LLM_LOCAL_ONLY = '1';
    process.env.LLM_PRIORITY = 'ollama';
    // run deep first
    await councilAskDeep('deep1', { KEYS: {}, OPENAI_COMPAT: {} });
    // then run a scan — must use scan model, not deep
    await councilAsk('scan1', { KEYS: {}, OPENAI_COMPAT: {} });
    const ollamaCalls = _calls.filter(c => String(c.url).includes('localhost:11434'));
    expect(ollamaCalls.length).toBe(2);
    const deepBody = JSON.parse(ollamaCalls[0].body);
    const scanBody = JSON.parse(ollamaCalls[1].body);
    expect(deepBody.model).toBe('deepseek-r1:14b');
    expect(scanBody.model).toBe('qwen3:8b');
  });

  it('councilAskDeep is just a thin wrapper around councilAsk(opts.deep=true)', async () => {
    // call councilAsk with opts.deep=true directly → same result as councilAskDeep
    process.env.LLM_LOCAL_ONLY = '1';
    process.env.LLM_PRIORITY = 'ollama';
    await councilAsk('wrapper test', { KEYS: {}, OPENAI_COMPAT: {} }, { deep: true });
    const ollamaCall = _calls.find(c => String(c.url).includes('localhost:11434'));
    const body = JSON.parse(ollamaCall.body);
    expect(body.model).toBe('deepseek-r1:14b');
  });
});
