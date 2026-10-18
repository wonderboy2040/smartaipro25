// ============================================================
// test/engineChain.test.ts — v18.7 ENGINE SENTINEL CHAIN
// ------------------------------------------------------------
// End-to-end pins for the desk-agent provider chain upgrade (the
// "AI language engines offline" fix):
//   1. EXTENDED chain — openrouter / huggingface / nvidia ride
//      after cerebras and actually answer.
//   2. FAST-FAIL — a provider in cooldown is skipped with ZERO
//      network calls (no repeated 30s hangs per message).
//   3. HALF-OPEN — cooldown expiry auto-retries the engine (no
//      restart, no RECHECK needed).
//   4. KEYLESS LOCAL — a reachable Ollama joins the chain as a
//      real language engine with zero cloud keys.
//   5. HONEST DEGRADED MODE — the deterministic answer now ends
//      with an ENGINE STATUS line (why offline + how to fix).
//   6. councilAsk (signals/council path) is sentinel-aware too.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// hermetic data dir (same contract as cryptoAgent.test.ts)
process.env.SMARTAI_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.test-data-engine-chain');

const cxConnected = vi.hoisted(() => ({ on: false }));
vi.mock('../server/mcp/coindcx.js', () => ({
  coindcxConnected: () => cxConnected.on,
  coindcxPrivate: vi.fn(),
  coindcxStatus: () => ({ connected: false }),
}));

const mockGetSignals = vi.fn();
const mockGetDeepSignal = vi.fn();
vi.mock('../server/ai/signals.js', () => ({
  getSignals: (...a: any[]) => mockGetSignals(...a),
  getDeepSignal: (...a: any[]) => mockGetDeepSignal(...a),
  buildRegime: vi.fn(async () => ({ btcChange: 1.2, btcTrend: 'UP' })),
  getFreshSignalForExec: vi.fn(async () => null),
  getFreshFuturesSignalForExec: vi.fn(async () => null),
}));

vi.mock('../server/ai/futures.js', async (importOriginal: any) => {
  const actual = await importOriginal();
  return {
    ...actual,
    walletSnapshot: vi.fn(),
    fetchUsdInr: vi.fn(async () => 84),
    executeFuturesSignal: vi.fn(),
    closeFuturesPosition: vi.fn(),
  };
});

vi.mock('../server/ai/agent.js', () => ({
  loadAgentConfig: () => ({ enabled: true, mode: 'paper', minAiScore: 75, rollingWindow: 10, minRollingWinRate: 35, correlationGuard: true, dynamicTimeExit: true, maxHoldMin: 90 }),
  agentStatus: vi.fn(),
}));

import { runCryptoAgent } from '../server/ai/cryptoAgent.js';
import { councilAsk } from '../server/ai/llmChain.js';
import { engineTrack, engineSnapshot, __resetSentinelForTests } from '../server/ai/llmSentinel.js';

// ---------------- fetch router mock ----------------
const fetchCalls: string[] = [];
let routes: Record<string, () => Promise<{ ok: boolean; status: number; json: any }>> = {};

vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
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
const badStatus = (code: number) => async () => ({ ok: false, status: code, json: async () => ({}) });
const ollamaTags = () => async () => ({
  ok: true, status: 200,
  json: async () => ({ models: [{ name: 'llama3.1:8b' }] }),
});

const COMPAT = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', defModel: 'gpt-oss-120b' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', defModel: 'z-ai/glm-5.2:free' },
  huggingface: { url: 'https://router.huggingface.co/v1/chat/completions', defModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', defModel: 'openai/gpt-oss-120b' },
};

const SOL_DEEP = [{ role: 'user', content: 'SOL ka deep analysis karo — entry, SL, leverage sab exact numbers me' }];
const SOL_SIGNAL = {
  ok: true, signal: {
    symbol: 'SOL', side: 'LONG', grade: 'STRONG', confidence: 82, agreement: 0.85,
    voters: 9, totalModels: 11, ltp: 9000, changePct: 2.1,
    superIntel: { aiScore: 83, tier: 'STRONG', blueprint: { entryZone: [8900, 9100], leverage: 3, maxSaneLeverage: 7, liquidation: 6200 } },
    plan: { entry: 9000, stopLoss: 8600, target1: 9400, target2: 9800, riskPct: 4.4, rewardRisk: 2 },
    quality: { veto: null, mtf: '2/3', session: 'open' },
    votes: [{ name: 'TrendMatrix', dir: 1, conf: 80, reasons: ['stack up'] }],
  },
};

beforeEach(() => {
  __resetSentinelForTests();
  fetchCalls.length = 0;
  routes = {};
  mockGetDeepSignal.mockReset().mockResolvedValue(SOL_SIGNAL);
  mockGetSignals.mockReset().mockResolvedValue({ ok: true, market: 'CRYPTO', signals: [] });
});
afterEach(() => {
  // NOTE: deliberately NO vi.unstubAllGlobals() here — the module-level
  // fetch stub must survive across tests (routes/fetchCalls are reset
  // manually in beforeEach). Unstubbing here would hand the 2nd test a
  // REAL network fetch (the exact bug that broke the first run).
  vi.restoreAllMocks();
});

describe('v18.7 engine chain — the desk agent', () => {
  it('EXTENDED: groq 429 + cerebras 500 fall through to openrouter which ANSWERS', async () => {
    routes = {
      'api.groq.com': badStatus(429),
      'api.cerebras.ai': badStatus(500),
      'openrouter.ai': okChat('SOL LONG ticket — entry zone 8900-9100'),
    };
    const out = await runCryptoAgent(SOL_DEEP, {
      KEYS: { groq: 'g', cerebras: 'c', openrouter: 'o' },
      OPENAI_COMPAT: COMPAT,
    });
    expect(out.ok).toBe(true);
    expect(out.engine).toContain('openrouter');
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(true);
    expect(fetchCalls.some(u => u.includes('api.cerebras.ai'))).toBe(true);
    expect(fetchCalls.some(u => u.includes('openrouter.ai'))).toBe(true);
    // sentinel recorded the failures honestly
    const snap = engineSnapshot({ groq: 'g', cerebras: 'c', openrouter: 'o' });
    expect(snap.find(e => e.provider === 'groq')?.lastError).toContain('429');
    expect(snap.find(e => e.provider === 'openrouter')?.state).toBe('ready');
  });

  it('FAST-FAIL: a provider in cooldown is skipped with ZERO network calls to it', async () => {
    engineTrack('groq', new Error('groq 500'));
    engineTrack('groq', new Error('groq 500')); // 2nd → 30s cooldown
    routes = { 'api.groq.com': badStatus(500) };
    const out = await runCryptoAgent(SOL_DEEP, {
      KEYS: { groq: 'g' },
      OPENAI_COMPAT: COMPAT,
    });
    // groq never hit — only the local ollama liveness probe ran
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(false);
    // deterministic answer still served
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('super-intel-deterministic');
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('FULL TICKET');
  });

  it('HALF-OPEN: cooldown expiry auto-retries the engine (no restart needed)', async () => {
    const past = Date.now() - 400_000;
    engineTrack('groq', new Error('groq 500'), past);
    engineTrack('groq', new Error('groq 500'), past); // cooldown already expired NOW
    routes = { 'api.groq.com': okChat('recovered engine answer') };
    const out = await runCryptoAgent(SOL_DEEP, {
      KEYS: { groq: 'g' },
      OPENAI_COMPAT: COMPAT,
    });
    expect(out.ok).toBe(true);
    expect(out.engine).toContain('groq');
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(true);
  });

  it('LOCAL: a reachable Ollama joins the chain with ZERO cloud keys', async () => {
    routes = {
      '127.0.0.1:11434/api/tags': ollamaTags(),
      '127.0.0.1:11434/v1/chat/completions': okChat('local llama ticket'),
    };
    const out = await runCryptoAgent(SOL_DEEP, { KEYS: {}, OPENAI_COMPAT: COMPAT });
    expect(out.ok).toBe(true);
    expect(out.engine).toContain('ollama');
    expect(out.degraded).toBeUndefined();
    expect(fetchCalls.some(u => u.includes('127.0.0.1:11434/v1/chat/completions'))).toBe(true);
  });

  it('DEGRADED honesty: no keys → deterministic ticket + ENGINE STATUS guidance line', async () => {
    const out = await runCryptoAgent(SOL_DEEP, { KEYS: {}, OPENAI_COMPAT: {} });
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('super-intel-deterministic');
    expect(out.text).toContain('FULL TICKET');
    expect(out.text).toContain('ENGINE STATUS');
    expect(out.text).toContain('Settings > AI Keys');
    // zero PROVIDER chat calls — only the ollama liveness probe + honest
    // desk-tool compute (funding etc.) may touch the network
    const providerFrags = ['generativelanguage', 'api.groq.com', 'api.cerebras.ai', 'openrouter.ai', 'router.huggingface.co', 'integrate.api.nvidia.com'];
    expect(fetchCalls.some(u => providerFrags.some(f => u.includes(f)))).toBe(false);
  });

  it('DEGRADED honesty: failed engines are named with reason + auto-retry in the status line', async () => {
    // 2 consecutive 429s arm the cooldown — the status line must name the
    // engine, the reason AND the auto-retry (the actionable fix).
    engineTrack('groq', new Error('groq 429'));
    engineTrack('groq', new Error('groq 429'));
    routes = { 'api.groq.com': badStatus(429) };
    const out = await runCryptoAgent(SOL_DEEP, { KEYS: { groq: 'g' }, OPENAI_COMPAT: COMPAT });
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('ENGINE STATUS');
    expect(out.text).toContain('groq');
    expect(out.text).toContain('cooldown');
    expect(out.text).toContain('429');
    // cooled provider was fast-skipped — no groq network call this run
    expect(fetchCalls.some(u => u.includes('api.groq.com'))).toBe(false);
  });
});

describe('v18.7 councilAsk (signals/council chain) is sentinel-aware', () => {
  it('falls through gemini (no-json) to huggingface and records both', async () => {
    routes = {
      'generativelanguage': async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) }),
      'router.huggingface.co': okChat('{"verdict":"CONFIRM","confidence":80,"reason":"clean"}'),
    };
    const { json, model } = await councilAsk('prompt', {
      KEYS: { gemini: 'g', huggingface: 'h' },
      OPENAI_COMPAT: COMPAT,
    });
    expect(model).toBe('huggingface');
    expect(json?.verdict).toBe('CONFIRM');
    const snap = engineSnapshot({ gemini: 'g', huggingface: 'h' });
    expect(snap.find(e => e.provider === 'gemini')?.consecFails).toBeGreaterThanOrEqual(1);
    expect(snap.find(e => e.provider === 'huggingface')?.state).toBe('ready');
  });

  it('skips a cooled provider with ZERO calls to it', async () => {
    engineTrack('gemini', new Error('gemini 429'));
    engineTrack('gemini', new Error('gemini 429'));
    routes = {
      'generativelanguage': okChat('should never be reached'),
      'api.groq.com': okChat('{"verdict":"CONFIRM","confidence":70,"reason":"x"}'),
    };
    const { model } = await councilAsk('prompt', {
      KEYS: { gemini: 'g', groq: 'k' },
      OPENAI_COMPAT: COMPAT,
    });
    expect(model).toBe('groq');
    expect(fetchCalls.some(u => u.includes('generativelanguage'))).toBe(false);
  });
});
