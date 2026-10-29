// ============================================================
// test/engineChainUnify.test.ts — v21.27 MODE-AWARE CHAIN
// ------------------------------------------------------------
// The v18.8 contract (board/council/validator share ONE chain that
// answers via keyless local Ollama) still holds in LOCAL mode. v21.27
// adds the site-wide LOCAL/CLOUD switch and REMOVES the paid provider
// ladder from these lanes:
//   1. councilAsk answers via LOCAL OLLAMA with zero cloud keys.
//   2. councilAsk's ollama ask is sentinel-tracked (success → ready).
//   3. paid keys alone do NOT make the lane online (no paid fallback).
//   4. signals.js aiCouncilVerify goes ONLINE with ZERO cloud keys
//      when ollama is reachable (the "engines offline" killer).
//   5. signals.js has NO private chain left — it rides llmChain.
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

import { councilAsk, aiEngineOnline } from '../server/ai/llmChain.js';
import { setAiMode, __resetAiModeForTests } from '../server/ai/aiMode.js';
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
  __resetAiModeForTests();
  setAiMode('local'); // v21.27: this suite pins the LOCAL contract
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

  it('CONTRACT 3 — paid keys alone do NOT make the lane online (no paid fallback)', async () => {
    // Ollama unreachable; paid keys present. The v1 Council must stay
    // offline instead of silently spending on Gemini/Groq/etc.
    const online = await aiEngineOnline({ KEYS: { gemini: 'gm', groq: 'g', nvidia: 'nv' } });
    expect(online).toBe(false);
    const providerFrags = ['generativelanguage', 'api.groq.com', 'api.cerebras.ai', 'openrouter.ai', 'router.huggingface.co', 'integrate.api.nvidia.com'];
    expect(fetchCalls.some(u => providerFrags.some(f => u.includes(f)))).toBe(false);
  });

  it('CONTRACT 3b — LOCAL mode + reachable ollama → aiEngineOnline true', async () => {
    routes = { '127.0.0.1:11434/api/tags': ollamaTags() };
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
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

  it('CONTRACT 5 — paid keys + no Ollama → honest offline, ZERO paid provider calls', async () => {
    const out = await aiCouncilVerify(CAND, { KEYS: { gemini: 'g', huggingface: 'h', groq: 'q' }, OPENAI_COMPAT: COMPAT }, 'CRYPTO');
    expect(out.online).toBe(false);
    expect(out.model).toBeNull();
    const providerFrags = ['generativelanguage', 'api.groq.com', 'router.huggingface.co'];
    expect(fetchCalls.some(u => providerFrags.some(f => u.includes(f)))).toBe(false);
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
