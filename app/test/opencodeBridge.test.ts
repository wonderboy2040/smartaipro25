// ============================================================
// test/opencodeBridge.test.ts — v21.24.0 AI TRIO PHASE 1
// ------------------------------------------------------------
// Locks the bridge contract before any signal wiring:
//   • JSONL parser joins text parts, ignores reasoning, fails honestly
//   • model IDs are allowlisted (no shell injection)
//   • prompt goes through stdin, never through cmd.exe
//   • child env has no exchange/AI/Telegram secrets
//   • timeout kills the process tree and rejects `timeout`
//   • semaphore never exceeds OPENCODE_MAX_CONCURRENCY
//   • minute/day rate limiter fails fast
//   • invalid JSON retries once, then arms the per-model breaker
//   • cached health probe calls --version/models/auth, never a model
//   • per-seat probe validates the exact JSON shape
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  askOpenCode, parseOpenCodeJsonl, opencodeProbe, opencodeStatus,
  probeOpenCodeSeat, resolveSeatModel,
  __resetOpenCodeForTests, __setSpawnForTests, __setKillTreeForTests,
  __testables, OPENCODE_SEATS,
} from '../server/ai/opencodeBridge.js';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  writes: string[];
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.writes = [];
  child.stdin.on('data', (chunk: Buffer | string) => child.writes.push(String(chunk)));
  child.pid = 9000;
  child.kill = vi.fn();
  return child;
}

function respond(child: FakeChild, stdout = '', opts: { code?: number; stderr?: string } = {}) {
  if (stdout) child.stdout.write(stdout);
  if (opts.stderr) child.stderr.write(opts.stderr);
  setTimeout(() => {
    try { child.stdout.end(); child.stderr.end(); } catch { /* already closed */ }
    child.emit('close', opts.code ?? 0, null);
  }, 0);
}

function validJsonl(obj: unknown): string {
  return JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify(obj) } }) + '\n';
}

function fakeSpawn(handler: (ctx: { child: FakeChild; args: string[]; bin: string; opts: any }) => void) {
  const calls: Array<{ child: FakeChild; args: string[]; bin: string; opts: any }> = [];
  const spawnFn = vi.fn((bin: string, args: string[], opts: any) => {
    const child = fakeChild();
    calls.push({ child, args, bin, opts });
    queueMicrotask(() => handler({ child, args, bin, opts }));
    return child;
  });
  return { spawnFn, calls };
}

beforeEach(() => {
  __resetOpenCodeForTests();
  __setSpawnForTests(null);
  __setKillTreeForTests(null);
  vi.stubEnv('OPENCODE_BIN', 'opencode');
  vi.stubEnv('OPENCODE_MAX_CALLS_PER_MIN', '100');
  vi.stubEnv('OPENCODE_MAX_CALLS_PER_DAY', '1000');
  vi.stubEnv('OPENCODE_MAX_CONCURRENCY', '2');
  vi.stubEnv('OPENCODE_TIMEOUT_MS', '1000');
  vi.stubEnv('OPENCODE_DEEP_TIMEOUT_MS', '1000');
  vi.stubEnv('OPENCODE_MAX_BUFFER_MB', '1');
  vi.stubEnv('OPENCODE_STANDALONE', '0');
  vi.stubEnv('AI_TRIO_FAST_CHAIN', '');
  vi.stubEnv('AI_TRIO_DEEP_CHAIN', '');
  vi.stubEnv('AI_TRIO_SENTINEL_CHAIN', '');
});

afterEach(() => {
  __setSpawnForTests(null);
  __setKillTreeForTests(null);
  __resetOpenCodeForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseOpenCodeJsonl', () => {
  it('joins multiple text events, ignores reasoning/step events, and parses the last JSON object', () => {
    const stdout = [
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Here is the JSON:\n' } }),
      JSON.stringify({ type: 'reasoning', part: { type: 'text', text: 'ignore me' } }),
      JSON.stringify({ type: 'text', text: '{"verdict":"CONFIRM","confidence":72}' }),
      JSON.stringify({ type: 'step_finish' }),
    ].join('\n');
    expect(parseOpenCodeJsonl(stdout).json).toEqual({ verdict: 'CONFIRM', confidence: 72 });
  });

  it('accepts code-fenced JSON from GLM-style responses', () => {
    const stdout = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: '```json\n{"action":"CONFIRM","confidence":70}\n```' },
    });
    expect(parseOpenCodeJsonl(stdout).json).toEqual({ action: 'CONFIRM', confidence: 70 });
  });

  it('throws no-text when the CLI produced no text event', () => {
    expect(() => parseOpenCodeJsonl('{"type":"step_start"}\n')).toThrow(/no-text/);
    try { parseOpenCodeJsonl(''); } catch (e: any) { expect(e.code).toBe('no-text'); }
  });

  it('throws bad-json for prose-only output', () => {
    const stdout = JSON.stringify({ type: 'text', part: { type: 'text', text: 'not json at all' } });
    try { parseOpenCodeJsonl(stdout); } catch (e: any) {
      expect(e.code).toBe('bad-json');
      expect(e.message).toBe('opencode bad-json');
    }
  });

  it('throws a sanitized error for a type:error event (no prompt/token leak)', () => {
    const stdout = JSON.stringify({
      type: 'error',
      error: { message: 'provider failed\nAuthorization: Bearer sk-1234567890abcdef' },
    });
    try { parseOpenCodeJsonl(stdout); } catch (e: any) {
      expect(e.code).toBe('opencode-error');
      expect(e.message).toContain('opencode error');
      expect(e.message).not.toContain('sk-1234567890abcdef');
      expect(e.message).not.toContain('\n');
    }
  });
});

describe('askOpenCode — security + stdin contract', () => {
  it('rejects shell-injection model IDs before spawning', async () => {
    const { spawnFn } = fakeSpawn(({ child }) => respond(child, validJsonl({ ok: true })));
    __setSpawnForTests(spawnFn);
    for (const bad of ['../../evil', 'bad model', 'bad;model', '`bad`', '', 'UPPER']) {
      await expect(askOpenCode('x', { model: bad })).rejects.toMatchObject({ code: 'bad-model' });
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('sends the prompt on stdin, not as a command argument, and strips secrets from the child env', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'gemini-secret');
    vi.stubEnv('GROQ_API_KEY', 'groq-secret');
    vi.stubEnv('TG_TOKEN', 'telegram-secret');
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-secret');
    const { spawnFn, calls } = fakeSpawn(({ child }) => respond(child, validJsonl({ ok: true })));
    __setSpawnForTests(spawnFn);

    const out = await askOpenCode('VERIFY THIS SIGNAL', { model: 'opencode/glm-5.3-flash-free' });
    expect(out.json).toEqual({ ok: true });
    expect(out.model).toBe('opencode/glm-5.3-flash-free');
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call.args.join(' ')).not.toContain('VERIFY THIS SIGNAL');
    expect(call.child.writes.join('')).toBe('VERIFY THIS SIGNAL');
    expect(call.opts.env.GEMINI_API_KEY).toBeUndefined();
    expect(call.opts.env.GROQ_API_KEY).toBeUndefined();
    expect(call.opts.env.TG_TOKEN).toBeUndefined();
    expect(call.opts.env.OPENCODE_API_KEY).toBeUndefined();
    expect(call.opts.env.PATH).toBe(process.env.PATH);
    expect(call.opts.cwd).toContain('opencode-sandbox');
  });

  it('kills the process tree and rejects timeout', async () => {
    const { spawnFn } = fakeSpawn(() => { /* never responds */ });
    const killTree = vi.fn();
    __setSpawnForTests(spawnFn);
    __setKillTreeForTests(killTree);

    await expect(askOpenCode('x', { model: 'glm-5.3-flash-free', timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledTimes(1);
  });

  it('never exceeds OPENCODE_MAX_CONCURRENCY', async () => {
    let active = 0;
    let maxActive = 0;
    const { spawnFn } = fakeSpawn(({ child }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active--;
        respond(child, validJsonl({ ok: true }));
      }, 15);
    });
    __setSpawnForTests(spawnFn);

    await Promise.all(Array.from({ length: 5 }, () => askOpenCode('x', { model: 'glm-5.3-flash-free' })));
    expect(maxActive).toBe(2);
  });

  it('fails fast after the per-minute call budget is exhausted', async () => {
    vi.stubEnv('OPENCODE_MAX_CALLS_PER_MIN', '1');
    const { spawnFn } = fakeSpawn(({ child }) => respond(child, validJsonl({ ok: true })));
    __setSpawnForTests(spawnFn);

    await askOpenCode('first', { model: 'glm-5.3-flash-free' });
    await expect(askOpenCode('second', { model: 'glm-5.3-flash-free' }))
      .rejects.toMatchObject({ code: 'rate-limited' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('retries invalid JSON once, then arms the per-model breaker', async () => {
    const { spawnFn } = fakeSpawn(({ child }) => {
      respond(child, JSON.stringify({ type: 'text', part: { type: 'text', text: 'not json' } }));
    });
    __setSpawnForTests(spawnFn);

    await expect(askOpenCode('x', { model: 'glm-5.3-flash-free' }))
      .rejects.toMatchObject({ code: 'bad-json' });
    expect(spawnFn).toHaveBeenCalledTimes(2);

    const breaker = opencodeStatus().breaker['glm-5.3-flash-free'];
    expect(breaker.cooldownRemainSec).toBeGreaterThan(0);
    expect(breaker.lastError).toContain('bad-json');

    await expect(askOpenCode('x', { model: 'glm-5.3-flash-free' }))
      .rejects.toMatchObject({ code: 'cooldown' });
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
});

describe('opencodeProbe — cached CLI health', () => {
  it('parses version/models/auth, caches the result, and never calls a model', async () => {
    const { spawnFn, calls } = fakeSpawn(({ child, args }) => {
      const cmd = args.join(' ');
      if (cmd.includes('--version')) respond(child, 'opencode v2.1.4\n');
      else if (cmd.includes('models')) respond(child, 'opencode/glm-5.3-flash-free\nopencode/deepseek-v4.1-flash-free\n');
      else if (cmd.includes('auth')) respond(child, 'luna API key stored\n');
      else respond(child, '');
    });
    __setSpawnForTests(spawnFn);

    const first = await opencodeProbe(true);
    expect(first.available).toBe(true);
    expect(first.probed).toBe(true);
    expect(first.version).toBe('2.1.4');
    expect(first.loggedIn).toBe(true);
    expect(first.models).toEqual([
      'opencode/glm-5.3-flash-free',
      'opencode/deepseek-v4.1-flash-free',
    ]);
    expect(spawnFn).toHaveBeenCalledTimes(3);
    expect(calls.some(c => c.args.join(' ').includes('--model'))).toBe(false);

    const cached = await opencodeProbe(false);
    expect(cached.available).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it('reports an honest negative result when the CLI is missing', async () => {
    const { spawnFn } = fakeSpawn(({ child }) => {
      child.emit('error', Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }));
    });
    __setSpawnForTests(spawnFn);

    const st = await opencodeProbe(true);
    expect(st.available).toBe(false);
    expect(st.probed).toBe(true);
    expect(st.lastError).toContain('opencode missing');
    expect(st.models).toEqual([]);
  });
});

describe('per-seat probe', () => {
  it('resolves the configured opencode link and validates the exact seat shape', async () => {
    expect(OPENCODE_SEATS).toEqual(['fast', 'deep', 'sentinel']);
    expect(resolveSeatModel('fast')).toBe('glm-5.3-flash-free');
    expect(resolveSeatModel('deep')).toBe('deepseek-v4.1-flash-free');
    expect(resolveSeatModel('sentinel')).toBe('glm-5.3-flash-free');

    const { spawnFn } = fakeSpawn(({ child }) => {
      respond(child, validJsonl({ action: 'CONFIRM', confidence: 75, note: 'probe ok' }));
    });
    __setSpawnForTests(spawnFn);

    const out = await probeOpenCodeSeat('fast', {
      knownModels: ['opencode/glm-5.3-flash-free'],
    });
    expect(out.ok).toBe(true);
    expect(out.model).toBe('opencode/glm-5.3-flash-free');
    expect(out.verdict).toEqual({ action: 'CONFIRM', confidence: 75 });
  });

  it('returns no-model when the seat chain has no opencode link', async () => {
    vi.stubEnv('AI_TRIO_FAST_CHAIN', 'ollama:qwen3:8b,rule');
    const out = await probeOpenCodeSeat('fast');
    expect(out.ok).toBe(false);
    expect(out.code).toBe('no-model');
  });

  it('rejects an unknown seat without spawning', async () => {
    const { spawnFn } = fakeSpawn(({ child }) => respond(child, validJsonl({})));
    __setSpawnForTests(spawnFn);
    const out = await probeOpenCodeSeat('bogus');
    expect(out.ok).toBe(false);
    expect(out.code).toBe('bad-seat');
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('child env allowlist', () => {
  it('keeps safe runtime vars and drops every secret', () => {
    vi.stubEnv('GEMINI_API_KEY', 'g');
    vi.stubEnv('COINDCX_API_KEY', 'c');
    vi.stubEnv('TG_TOKEN', 't');
    vi.stubEnv('OPENCODE_API_KEY', 'o');
    const env = __testables._childEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.NO_COLOR).toBe('1');
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.COINDCX_API_KEY).toBeUndefined();
    expect(env.TG_TOKEN).toBeUndefined();
    expect(env.OPENCODE_API_KEY).toBeUndefined();
  });
});
