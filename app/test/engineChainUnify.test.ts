// ============================================================
// test/engineChainUnify.test.ts — v18.8 ENGINE CHAIN UNIFICATION
// ------------------------------------------------------------
// THE GAP THIS LOCKS: v18.7 upgraded the DESK AGENTS (crypto/intraday)
// to the sentinel chain with the keyless local ollama engine, but the
// board's OWN LLM paths silently stayed on the OLD 4-provider ladder:
//   • llmChain.councilAsk (council + validator + weekly review) — no
//     ollama, so a zero-cloud-key install still got "AI language
//     engines offline" while a WORKING local Ollama sat unused.
//   • signals.js's private councilAsk — gemini/groq/cerebras/openrouter
//     ONLY: no huggingface, no nvidia, no ollama, NO sentinel tracking.
//
// THE v18.8 CONTRACT:
//   1. councilAsk answers via LOCAL OLLAMA with zero cloud keys
//      (probe + /v1/chat/completions, long local timeout budget).
//   2. councilAsk's ollama ask is sentinel-tracked (success → ready).
//   3. aiKeysPresent counts huggingface + nvidia keys (6 engines).
//   4. signals.js aiCouncilVerify goes ONLINE with ZERO cloud keys
//      when ollama is reachable (the "engines offline" killer).
//   5. signals.js has NO private chain left — it rides llmChain
//      (gemini no-json → huggingface answers on the BOARD seat too).
//   6. council.js runs its persona batch with zero cloud keys when
//      ollama is reachable (board + deep gates).
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same contract as engineChain.test.ts)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-engine-unify');

vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => false,
  coindcxPrivate: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
}));

import { councilAsk, aiKeysPresent } from '../server/ai/llmChain.js';
import { engineSnapshot, __resetSentinelForTests } from '../server/ai/llmSentinel.js';
import { aiCouncilVerify } from '../server/ai/signals.js';
import { runCouncilBoard } from '../server/ai/council.js';

// ---------------- fetch router mock ----------------
const fetchCalls: string[] = [];
let routes: Record<string, () => Promise<{ ok: boolean; status: number; json: any }>> = {};

vi.stubGlobal('fetch', vi.fn(async (url: any, _init?: any) => {
  const u = String(url);
  fetchCalls.push(u);
  for (const [frag, fn] of Object.entries(routes)) {
    if (u.includes(frag)) return fn();
  }
  return { ok: false, status: 500, json: async () => ({}) }; // default: refuse
}));

const okChat = (content: string) => async () => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { role: 'assistant', content, tool_calls: [] } }] }),
});
const ollamaTags = () => async () => ({
  ok: true, status: 200,
  json: async () => ({ models: [{ name: 'llama3.1:8b' }] }),
});
// v21.0: native /api/chat response shape ({message:{content}}) — the
// compat-endpoint mock tha, ab llmChain native endpoint use karta hai.
const okOllamaNative = (content: string) => async () => ({
  ok: true, status: 200,
  json: async () => ({ message: { role: 'assistant', content } }),
});
const COMPAT = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', defModel: 'gpt-oss-120b' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', defModel: 'z-ai/glm-5.2:free' },
  huggingface: { url: 'https://router.huggingface.co/v1/chat/completions', defModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
};

beforeEach(() => {
  __resetSentinelForTests();
  fetchCalls.length = 0;
  routes = {};
});

describe('v18.8 — councilAsk rides the KEYLESS LOCAL ollama engine', () => {
  it('CONTRACT 1 — zero cloud keys + reachable ollama → the chain ANSWERS from ollama', async () => {
    routes = {
      '127.0.0.1:11434/api/tags': ollamaTags(),
      '127.0.0.1:11434/api/chat': okOllamaNative('{"verdict":"CONFIRM","confidence":81,"reason":"local brain"}'),
    };
    const { json, model } = await councilAsk('prompt', { KEYS: {}, OPENAI_COMPAT: COMPAT });
    // v21.0.3: honest model attribution — 'ollama' provider-name ke
    // bajaye ab real model jata hai (installed llama3.1:8b here →
    // 'ollama:llama3.1:8b').
    expect(model).toBe('ollama:llama3.1:8b');
    expect(json?.verdict).toBe('CONFIRM');
    expect(fetchCalls.some(u => u.includes('127.0.0.1:11434/api/chat'))).toBe(true);
    // ZERO cloud provider calls — the local engine carried the whole ask
    const providerFrags = ['generativelanguage', 'api.groq.com', 'api.cerebras.ai', 'openrouter.ai', 'router.huggingface.co', 'integrate.api.nvidia.com'];
    expect(fetchCalls.some(u => providerFrags.some(f => u.includes(f)))).toBe(false);
  });

  it('CONTRACT 2 — the ollama success is sentinel-tracked (state ready)', async () => {
    routes = {
      '127.0.0.1:11434/api/tags': ollamaTags(),
      '127.0.0.1:11434/api/chat': okOllamaNative('{"verdict":"CONFIRM","confidence":70,"reason":"x"}'),
    };
    await councilAsk('prompt', { KEYS: {}, OPENAI_COMPAT: COMPAT });
    const snap = engineSnapshot({});
    const ol = snap.find(e => e.provider === 'ollama');
    expect(ol?.state).toBe('ready');
  });

  it('CONTRACT 2b — ollama unreachable (no tags route) → honest null, no /v1 call', async () => {
    const { json, model } = await councilAsk('prompt', { KEYS: {}, OPENAI_COMPAT: COMPAT });
    expect(json).toBeNull();
    expect(model).toBeNull();
    expect(fetchCalls.some(u => u.includes('127.0.0.1:11434/api/chat'))).toBe(false);
  });

  it('CONTRACT 3 — aiKeysPresent counts ALL SIX cloud engines', () => {
    expect(aiKeysPresent({})).toBe(false);
    expect(aiKeysPresent({ huggingface: 'hf' })).toBe(true);
    expect(aiKeysPresent({ nvidia: 'nv' })).toBe(true);
    expect(aiKeysPresent({ openrouter: 'or' })).toBe(true);
    expect(aiKeysPresent({ groq: 'g' })).toBe(true);
    expect(aiKeysPresent({ cerebras: 'c' })).toBe(true);
    expect(aiKeysPresent({ gemini: 'gm' })).toBe(true);
  });
});

describe('v18.8 — the BOARD seat (signals.js aiCouncilVerify) is unified', () => {
  const CAND = [{
    symbol: 'SOL', side: 'LONG', confidence: 78, ltp: 9000, changePct: 2.1,
    ind: { rsi: 55, adx: { adx: 24 }, relVolume: 1.8, vwap: 8950, atr: 90 },
    plan: { entry: 9000, stopLoss: 8600, target1: 9400, target2: 9800 },
    votes: [{ name: 'TrendMatrix', dir: 1, conf: 80 }],
  }];

  it('CONTRACT 4 — ZERO cloud keys + ollama reachable → the council goes ONLINE (model ollama)', async () => {
    routes = {
      '127.0.0.1:11434/api/tags': ollamaTags(),
      '127.0.0.1:11434/api/chat': okOllamaNative('{"verdicts":{"SOL":{"verdict":"LONG","confidence":80,"note":"local","analysis":"ok"}}}'),
    };
    const out = await aiCouncilVerify(CAND, { KEYS: {}, OPENAI_COMPAT: COMPAT }, 'CRYPTO');
    expect(out.online).toBe(true);
    expect(out.model).toContain('ollama');
    expect(out.verdicts?.SOL?.verdict).toBe('LONG');
  });

  it('CONTRACT 5 — NO private chain left: gemini no-json falls through to HUGGINGFACE on the board seat', async () => {
    routes = {
      'generativelanguage': async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) }),
      'router.huggingface.co': okChat('{"verdicts":{"SOL":{"verdict":"SHORT","confidence":64,"note":"hf","analysis":"ok"}}}'),
    };
    const out = await aiCouncilVerify(CAND, { KEYS: { gemini: 'g', huggingface: 'h' }, OPENAI_COMPAT: COMPAT }, 'CRYPTO');
    // huggingface answered — the OLD private ladder (4 providers, no HF)
    // could never do this
    expect(out.online).toBe(true);
    expect(out.model).toBe('huggingface');
    expect(out.verdicts?.SOL?.verdict).toBe('SHORT');
    const snap = engineSnapshot({ gemini: 'g', huggingface: 'h' });
    expect(snap.find(e => e.provider === 'gemini')?.consecFails).toBeGreaterThanOrEqual(1);
    expect(snap.find(e => e.provider === 'huggingface')?.state).toBe('ready');
  });

  it('CONTRACT 5b — no engines at all → honest offline (no crash)', async () => {
    const out = await aiCouncilVerify(CAND, { KEYS: {}, OPENAI_COMPAT: COMPAT }, 'CRYPTO');
    expect(out.online).toBe(false);
    expect(out.model).toBeNull();
  });
});

describe('v18.8 — the GLOBAL COUNCIL gate is ollama-aware', () => {
  it('CONTRACT 6 — zero cloud keys + ollama reachable → council runs personas (not deterministic)', async () => {
    routes = {
      '127.0.0.1:11434/api/tags': ollamaTags(),
      '127.0.0.1:11434/api/chat': okOllamaNative('{"verdicts":{"SOL":{"bull":60,"bear":20,"note":"n","analysis":"a"}}}'),
      'api.binance.com': async () => ({ ok: false, status: 500, json: async () => ({}) }),
    };
    const out = await runCouncilBoard({
      market: 'CRYPTO',
      signals: [{ symbol: 'SOL', side: 'LONG', confidence: 78, ltp: 9000 }],
      regime: {},
      deps: { KEYS: {}, OPENAI_COMPAT: COMPAT },
    });
    expect(out).toBeTruthy();
    // the LLM path ran (persona asks hit the local engine) — the board
    // did NOT collapse to the deterministic-only quant path
    expect(fetchCalls.some(u => u.includes('127.0.0.1:11434/api/chat'))).toBe(true);
  });
});
