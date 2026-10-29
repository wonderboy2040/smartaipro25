// ============================================================
// test/llmChainEnv.test.ts — v21.27 LOCAL/CLOUD mode + chain
// ------------------------------------------------------------
// Locks the approved v1 switch:
//   1. AI_MODE / LLM_LOCAL_ONLY only SEED the first-boot mode.
//   2. A runtime switch > persisted file > env seed.
//   3. LOCAL → Ollama only; paid keys are never touched.
//   4. CLOUD → OpenCode free model first (GLM fast / DeepSeek deep),
//      then Ollama fallback. A failure never reaches a paid API.
//   5. aiEngineOnline() is the honest availability gate for each mode.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// Shared hermetic dir from src/test/setup.ts (module imports above already
// resolved store.js against it). ai-mode.json is wiped around every test.
const DATA = process.env.SMARTAI_DATA_DIR || path.join(process.cwd(), '.test-data-llm-chain-env');
const MODE_FILE = path.join(DATA, 'ai-mode.json');

const _env = vi.hoisted(() => ({
  ollamaUp: false,
  ocFail: false,
  ocAvailable: true,
  ocLoggedIn: true as boolean | null,
  ocCalls: [] as Array<{ prompt: string; opts: any }>,
}));

vi.stubGlobal('fetch', vi.fn(async (url: any) => {
  const u = String(url);
  if (u.includes('/api/chat')) {
    return {
      ok: true, status: 200,
      json: async () => ({ message: { role: 'assistant', content: '{"verdict":"CONFIRM","via":"ollama"}' } }),
    };
  }
  return { ok: false, status: 503, json: async () => null, text: async () => '' };
}));

vi.mock('../server/ai/llmSentinel.js', () => ({
  engineSkip: () => false,
  engineTrack: () => {},
  engineOk: () => {},
  ollamaProbe: async () => _env.ollamaUp,
  ollamaCompatCfg: (opts: any = {}) => ({
    url: 'http://localhost:11434/v1/chat/completions',
    defModel: opts.deep ? 'deepseek-r1:14b' : 'qwen3:8b',
    deepModel: 'deepseek-r1:14b',
  }),
  OLLAMA_NUM_CTX: 8192,
  OLLAMA_NUM_CTX_DEEP: 8192,
  OLLAMA_KEEP_ALIVE: '5m',
  ollamaVisionModel: () => null,
}));

vi.mock('../server/ai/opencodeBridge.js', () => ({
  askOpenCode: async (prompt: string, opts: any = {}) => {
    _env.ocCalls.push({ prompt, opts });
    if (_env.ocFail) {
      const err: any = new Error('opencode free-limit: daily quota');
      err.code = 'free-limit';
      throw err;
    }
    return { json: { verdict: 'CONFIRM', via: 'opencode' }, model: `opencode/${opts.model}` };
  },
  resolveSeatModel: (seat: string) => seat === 'deep' ? 'deepseek-v4.1-flash-free' : 'glm-5.3-flash-free',
  opencodeProbe: async () => ({
    available: _env.ocAvailable,
    loggedIn: _env.ocLoggedIn,
    models: ['opencode/glm-5.3-flash-free', 'opencode/deepseek-v4.1-flash-free'],
  }),
  opencodeStatus: () => ({}),
}));

import {
  getAiMode, getAiModeStatus, setAiMode, normalizeAiMode, __resetAiModeForTests,
} from '../server/ai/aiMode.js';
import { councilAsk, councilAskDeep, aiEngineOnline } from '../server/ai/llmChain.js';

const PAID_KEYS = { gemini: 'g', groq: 'q', cerebras: 'c', openrouter: 'o', huggingface: 'h', nvidia: 'n' };

function removeModeFile() {
  try { fs.rmSync(MODE_FILE, { force: true }); } catch { /* no file */ }
}

beforeEach(() => {
  __resetAiModeForTests();
  delete process.env.AI_MODE;
  delete process.env.LLM_LOCAL_ONLY;
  removeModeFile();
  _env.ollamaUp = false;
  _env.ocFail = false;
  _env.ocAvailable = true;
  _env.ocLoggedIn = true;
  _env.ocCalls.length = 0;
});

afterEach(() => {
  // never leak a CLOUD file into the next suite
  __resetAiModeForTests();
  removeModeFile();
});

describe('v21.27 aiMode — first-boot seeds + precedence', () => {
  it('default → LOCAL (safe)', () => {
    const s = getAiModeStatus();
    expect(s.mode).toBe('local');
    expect(s.source).toBe('default');
    expect(s.persisted).toBe(false);
  });

  it('AI_MODE=cloud seeds CLOUD', () => {
    process.env.AI_MODE = 'cloud';
    const s = getAiModeStatus();
    expect(s.mode).toBe('cloud');
    expect(s.source).toBe('env');
  });

  it('LLM_LOCAL_ONLY=1 seeds LOCAL when AI_MODE is absent', () => {
    process.env.LLM_LOCAL_ONLY = '1';
    const s = getAiModeStatus();
    expect(s.mode).toBe('local');
    expect(s.source).toBe('env-local-only');
  });

  it('runtime switch beats env + is persisted for restart safety', () => {
    process.env.AI_MODE = 'cloud';
    const out = setAiMode('local');
    expect(out).toMatchObject({ ok: true, mode: 'local', persisted: true });
    expect(getAiMode()).toBe('local');
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    expect(saved.mode).toBe('local');
    expect(Number.isFinite(saved.updatedAt)).toBe(true);
  });

  it('persisted file wins over the env seed after a runtime reset', () => {
    setAiMode('cloud');
    __resetAiModeForTests();
    process.env.AI_MODE = 'local';
    const s = getAiModeStatus();
    expect(s.mode).toBe('cloud');
    expect(s.source).toBe('file');
  });

  it('invalid values are rejected (no silent fallback)', () => {
    const out = setAiMode('paid');
    expect(out.ok).toBe(false);
    expect(normalizeAiMode('LOCAL')).toBe('local');
    expect(normalizeAiMode('nope')).toBeNull();
    expect(getAiMode()).toBe('local');
  });
});

describe('v21.27 councilAsk — LOCAL mode', () => {
  it('LOCAL answers via Ollama and never calls OpenCode or paid providers', async () => {
    _env.ollamaUp = true;
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('ollama:qwen3:8b');
    expect(json?.via).toBe('ollama');
    expect(_env.ocCalls.length).toBe(0);
  });

  it('LOCAL deep path uses the Ollama deep model', async () => {
    _env.ollamaUp = true;
    const { model } = await councilAskDeep('deep prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('ollama:deepseek-r1:14b');
  });

  it('LOCAL with Ollama down → honest null (paid keys ignored)', async () => {
    _env.ollamaUp = false;
    const out = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(out).toEqual({ json: null, model: null });
    expect(_env.ocCalls.length).toBe(0);
  });
});

describe('v21.27 councilAsk — CLOUD mode', () => {
  beforeEach(() => {
    setAiMode('cloud');
  });

  it('CLOUD uses the OpenCode FAST seat (GLM) first', async () => {
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('opencode/glm-5.3-flash-free');
    expect(json?.via).toBe('opencode');
    expect(_env.ocCalls[0]?.opts).toMatchObject({ model: 'glm-5.3-flash-free', deep: false });
  });

  it('CLOUD deep path uses the OpenCode DEEP seat (DeepSeek)', async () => {
    const { model } = await councilAskDeep('deep prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('opencode/deepseek-v4.1-flash-free');
    expect(_env.ocCalls[0]?.opts).toMatchObject({ model: 'deepseek-v4.1-flash-free', deep: true });
  });

  it('OpenCode failure falls back to Ollama (never to a paid API)', async () => {
    _env.ocFail = true;
    _env.ollamaUp = true;
    const { json, model } = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(model).toBe('ollama:qwen3:8b');
    expect(json?.via).toBe('ollama');
    expect(_env.ocCalls.length).toBe(1);
  });

  it('OpenCode failure + Ollama down → honest null, zero paid calls', async () => {
    _env.ocFail = true;
    _env.ollamaUp = false;
    const out = await councilAsk('prompt', { KEYS: PAID_KEYS });
    expect(out).toEqual({ json: null, model: null });
  });
});

describe('v21.27 aiEngineOnline — mode-aware gate', () => {
  it('LOCAL ignores paid keys; needs Ollama', async () => {
    expect(await aiEngineOnline({ KEYS: PAID_KEYS })).toBe(false);
    _env.ollamaUp = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });

  it('CLOUD is online via OpenCode even when Ollama is down', async () => {
    setAiMode('cloud');
    _env.ollamaUp = false;
    _env.ocAvailable = true;
    _env.ocLoggedIn = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });

  it('CLOUD with OpenCode logged out falls back to Ollama availability', async () => {
    setAiMode('cloud');
    _env.ocAvailable = true;
    _env.ocLoggedIn = false;
    _env.ollamaUp = false;
    expect(await aiEngineOnline({ KEYS: PAID_KEYS })).toBe(false);
    _env.ollamaUp = true;
    expect(await aiEngineOnline({ KEYS: {} })).toBe(true);
  });
});
