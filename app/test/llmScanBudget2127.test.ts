// test/llmScanBudget2127.test.ts — v21.27.1 PRO-LEVEL RECHECK LOCK
//
// Real defect found while classifying the v69 baseline failure: the board's
// Council scan shared the 240s DEEP Ollama budget. When the local daemon
// accepted /api/chat but never generated, a cold board scan could park for
// minutes (debate = up to 3 calls + legacy fallback), far beyond the UI /
// bot polling window. Fix: scan seats get a bounded 45s budget (env
// OLLAMA_SCAN_TIMEOUT_MS); the deep R1 seat keeps the CPU-realistic 240s.
//
// This lock proves the caller's explicit budget actually aborts the hung
// fetch and that the scan/deep split stays in place.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_FETCH = globalThis.fetch;
let councilAsk: any;
let councilAskDeep: any;
let aiMode: any;
let sentinel: any;

const tagsOk = () => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'deepseek-r1:14b' }] }),
});

beforeAll(async () => {
  sentinel = await import('../server/ai/llmSentinel.js');
  aiMode = await import('../server/ai/aiMode.js');
  ({ councilAsk, councilAskDeep } = await import('../server/ai/llmChain.js'));
});

beforeEach(() => {
  sentinel.__resetSentinelForTests();
  aiMode.setAiMode('local');
});

afterAll(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = REAL_FETCH;
});

describe('v21.27.1 bounded Ollama scan budget', () => {
  it('a hung /api/chat is aborted at the caller budget (never the 240s deep default)', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn((url: any, init?: any) => {
      if (String(url).includes('/api/tags')) return tagsOk();
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => { aborted = true; reject(new Error('aborted')); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }));
    const t = Date.now();
    const out = await councilAsk('hung prompt', {}, { timeoutMs: 150 });
    const elapsed = Date.now() - t;
    expect(out).toEqual({ json: null, model: null });
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    globalThis.fetch = REAL_FETCH;
  });

  it('default scan budget is 45s and deep budget stays 240s (source contract)', () => {
    const src = fs.readFileSync(path.join(APP_ROOT, 'server', 'ai', 'llmChain.js'), 'utf8');
    expect(src).toMatch(/OLLAMA_SCAN_TIMEOUT_MS\s*=\s*Number\(process\.env\.OLLAMA_SCAN_TIMEOUT_MS\)\s*\|\|\s*45_000/);
    expect(src).toMatch(/OLLAMA_TIMEOUT_MS\s*=\s*Number\(process\.env\.OLLAMA_TIMEOUT_MS\)\s*\|\|\s*240_000/);
    expect(src).toMatch(/if \(deep\) return OLLAMA_TIMEOUT_MS;/);
    expect(src).toMatch(/AbortSignal\.timeout\(budgetMs\)/);
    // councilAsk must forward an explicit per-call budget.
    expect(src).toMatch(/_askOllamaLeg\(prompt, \{ deep, timeoutMs: opts\.timeoutMs \}\)/);
  });

  it('deep scan still resolves through the deep model path (240s lane untouched)', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: any, init?: any) => {
      if (String(url).includes('/api/tags')) return tagsOk();
      const body = JSON.parse(String(init?.body || '{}'));
      seen.push(String(body.model));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ message: { content: '{"verdicts":{}}' } }),
      });
    }));
    const out = await councilAskDeep('deep prompt', {});
    expect(out.json).toEqual({ verdicts: {} });
    expect(seen[0]).toContain('deepseek-r1');
    globalThis.fetch = REAL_FETCH;
  });
});
