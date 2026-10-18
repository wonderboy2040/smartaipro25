// ============================================================
// test/botlabJev.test.ts — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// The Jev contract, code-enforced and test-locked (plan §8.2):
//   1. gate on probabilities[chosen], NEVER on `confidence`
//   2. no side flips — disagreement = WAIT
//   3. every error/timeout/parse failure = WAIT (fallback)
//   4. cache: identical payloads never hit the wire twice
//   5. breaker: consecutive failures open a cooldown window
//   6. 4xx not retried; 429/5xx retried with backoff
//   7. usage tokens + latency percentiles recorded
// v21.2.0 dual-provider additions:
//   8. URL override (JEV_URL / provider url) reaches the wire
//   9. falsy model = field OMIT (Laya T2 compat)
//  10. 4xx ≠ breaker (rejects counter only); 5xx/network = breaker
//  11. cache key provider-aware (jev vs laya alag)
//  12. Laya-shaped contract fixture parse
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createJev, jevPing, buildPayload, providerConfig, resolveProviderEndpoint } from '../server/bots/jevEngine.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mkResp = (choice, probs, confidence = 0.5) => ({
  ok: true, status: 200,
  json: async () => ({
    answers: { action: { choice, probabilities: probs, confidence } },
    usage: { input_tokens: 120, output_tokens: 12 },
  }),
});

const snap = (proposed = 'enter_long') => ({
  proposed,
  contextLines: ['Instrument: X', 'Proposed trade: LONG entry 100 stop 90 target 110'],
  features: {},
});
const prompt = {
  instructions: 'take or wait?',
  criteria: { enter_long: 'Take the long', enter_short: 'Take the short', wait: 'Stand aside' },
  extra: {},
};

let tmpDir = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-'));
});

describe('v20.8 jevEngine — decision rules', () => {
  it('1. gates on probabilities[chosen]: below threshold = wait', async () => {
    const jev = createJev({ apiKey: 'k', threshold: 0.30, cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => mkResp('enter_long', { enter_long: 0.2, wait: 0.8 }) });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait');
    expect(v.note).toContain('below_threshold');
    expect(v.note).toContain('0.20');
  });

  it('1b. confidence is IGNORED when probabilities disagree (the repo bug)', async () => {
    const jev = createJev({ apiKey: 'k', threshold: 0.30, cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => mkResp('enter_long', { enter_long: 0.1, wait: 0.9 }, /*confidence=*/0.99) });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait'); // confidence 0.99 must NOT override p=0.10
  });

  it('2. no side flip: choice != proposed = WAIT, never the other side', async () => {
    const jev = createJev({ apiKey: 'k', cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => mkResp('enter_short', { enter_short: 0.9, wait: 0.1 }) });
    const v = await jev(snap('enter_long'), prompt);
    expect(v.action).toBe('wait');
    expect(v.note).toBe('disagreed_side');
  });

  it('3a. network error = wait (default fallback)', async () => {
    const jev = createJev({ apiKey: 'k', retries: 0, cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => { throw new Error('boom'); } });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait');
    expect(v.note).toBe('network_error');
  });

  it('3b. 4xx = wait immediately, NO retry', async () => {
    let calls = 0;
    const jev = createJev({ apiKey: 'k', retries: 3, cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => { calls++; return { ok: false, status: 401, json: async () => ({}) }; } });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait');
    expect(v.note).toBe('http_401');
    expect(calls).toBe(1); // 4xx does not heal — no retry loop
  });

  it('3c. no api key = wait, zero network', async () => {
    let calls = 0;
    const jev = createJev({ cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => { calls++; return mkResp('enter_long', { enter_long: 0.9 }); } });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait');
    expect(v.note).toBe('no_api_key');
    expect(calls).toBe(0);
  });

  it('3d. fallback=rule is a conscious config (not a default)', async () => {
    const jev = createJev({ apiKey: 'k', retries: 0, fallback: 'rule', cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => { throw new Error('down'); } });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('enter_long'); // rule fallback passes the proposal through
  });

  it('4. take: p >= threshold, matching side', async () => {
    const jev = createJev({ apiKey: 'k', threshold: 0.30, cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => mkResp('enter_long', { enter_long: 0.55, wait: 0.45 }) });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('enter_long');
    expect(v.probs.enter_long).toBeCloseTo(0.55);
    expect(v.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('5. cache: identical payload = single wire call + cached flag', async () => {
    let calls = 0;
    const jev = createJev({ apiKey: 'k', cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => { calls++; return mkResp('enter_long', { enter_long: 0.55, wait: 0.45 }); } });
    const v1 = await jev(snap(), prompt);
    const v2 = await jev(snap(), prompt);
    expect(v1.cached).toBe(false);
    expect(v2.cached).toBe(true);
    expect(calls).toBe(1);
    expect(jev.stats().cacheHits).toBe(1);
  });

  it('6. 429 retries with backoff, then succeeds', async () => {
    let calls = 0;
    const jev = createJev({ apiKey: 'k', retries: 3, cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => {
      calls++;
      if (calls <= 2) return { ok: false, status: 429, json: async () => ({}) };
      return mkResp('enter_long', { enter_long: 0.6, wait: 0.4 });
    } });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('enter_long');
    expect(calls).toBe(3);
  });

  it('7. breaker: N consecutive failures => open, zero further wire calls', async () => {
    let calls = 0;
    const jev = createJev({
      apiKey: 'k', retries: 0, breakerThreshold: 2, breakerCooldownMs: 60_000,
      cachePath: path.join(tmpDir, 'c.jsonl'),
      fetchImpl: async () => { calls++; throw new Error('down'); },
    });
    await jev(snap(), prompt); // fail 1
    await jev(snap('enter_short'), prompt); // fail 2 -> breaker opens
    expect(jev.stats().breakerOpen).toBe(true);
    const before = calls;
    const v = await jev(snap(), prompt); // fail-fast, no wire
    expect(v.action).toBe('wait');
    expect(v.note).toBe('breaker_open');
    expect(calls).toBe(before); // no new HTTP
    expect(jev.stats().breaker.trips).toBe(1);
  });

  it('8. usage tokens accumulate in stats', async () => {
    const jev = createJev({ apiKey: 'k', cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => mkResp('enter_long', { enter_long: 0.55, wait: 0.45 }) });
    await jev(snap(), prompt);
    const s = jev.stats();
    expect(s.usage.inputTokens).toBe(120);
    expect(s.usage.outputTokens).toBe(12);
    expect(s.calls).toBe(1);
    expect(s.hasKey).toBe(true);
  });

  it('9. payload shape matches the TypeSafe contract', () => {
    const p = buildPayload({ model: 'jev-latest', snap: snap(), prompt });
    expect(p.model).toBe('jev-latest');
    expect(p.state).toContain('Instrument: X');
    expect(p.questions.action.type).toBe('choice');
    expect(p.questions.action.criteria.enter_long).toBeTruthy();
  });

  it('10. wait choice passes through as wait (no threshold math)', async () => {
    const jev = createJev({ apiKey: 'k', cachePath: path.join(tmpDir, 'c.jsonl'), fetchImpl: async () => mkResp('wait', { enter_long: 0.05, wait: 0.95 }) });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait');
  });
});

describe('v20.8 jevPing — Phase 0 smoke', () => {
  it('skips honestly without a key', async () => {
    const r = await jevPing({ apiKey: '' });
    expect(r.status).toBe('SKIPPED');
  });
  it('PASS on a well-formed answer', async () => {
    const r = await jevPing({ apiKey: 'k', fetchImpl: async () => mkResp('enter_long', { enter_long: 0.7, wait: 0.3 }) });
    expect(r.status).toBe('PASS');
    expect(r.choice).toBe('enter_long');
    expect(r.usage.input_tokens).toBe(120);
  });
  it('FAIL on HTTP error', async () => {
    const r = await jevPing({ apiKey: 'k', fetchImpl: async () => { throw new Error('no route'); } });
    expect(r.status).toBe('FAIL');
  });
});

describe('v21.2.0 dual-provider — provider-aware engine', () => {
  it('8. URL override: createJev({url}) hits THAT endpoint, not the hardcoded default', async () => {
    const seen = [];
    const jev = createJev({
      apiKey: 'k', url: 'http://127.0.0.1:9999/v1/systemone',
      cachePath: path.join(tmpDir, 'c.jsonl'),
      fetchImpl: async (u) => { seen.push(String(u)); return mkResp('enter_long', { enter_long: 0.55, wait: 0.45 }); },
    });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('enter_long');
    expect(seen[0]).toBe('http://127.0.0.1:9999/v1/systemone');
    expect(jev.stats().url).toBe('127.0.0.1:9999'); // host only
  });

  it('8b. providerConfig: JEV_URL > JEV_BASE_URL > default chain', () => {
    expect(providerConfig('jev', { JEV_URL: 'https://x.example/one' }).url).toBe('https://x.example/one');
    expect(providerConfig('jev', { JEV_BASE_URL: 'https://x.example' }).url).toBe('https://x.example/v1/systemone');
    expect(providerConfig('jev', {}).url).toBe('https://api.typesafe.ai/v1/systemone');
    // full-endpoint base accepted as-is
    expect(resolveProviderEndpoint('https://x.example/v1/systemone/')).toBe('https://x.example/v1/systemone');
  });

  it('8c. v21.14: providerConfig("laya", ...) is now just jev defaults (Laya branch removed)', () => {
    const c = providerConfig('laya', {});
    expect(c.url).toBe('https://api.typesafe.ai/v1/systemone'); // jev default — LAYA_* vars never read
    expect(c.timeoutMs).toBe(4000);
    expect(c.retries).toBe(3);
    // legacy LAYA_* env vars have NO effect (ignored)
    expect(providerConfig('laya', { LAYA_BASE_URL: 'http://localhost:9000', LAYA_MODEL: 'english' }).url).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('9. falsy model = field OMIT; truthy model = present', () => {
    const noModel = buildPayload({ model: '', snap: snap(), prompt });
    expect('model' in noModel).toBe(false);
    const withModel = buildPayload({ model: 'english', snap: snap(), prompt });
    expect(withModel.model).toBe('english');
  });

  it('10a. HTTP 422 does NOT trip the breaker — rejects counter + honest note, provider usable on next call', async () => {
    let calls = 0;
    const jev = createJev({
      apiKey: 'k', retries: 0, breakerThreshold: 1, breakerCooldownMs: 60_000,
      cachePath: path.join(tmpDir, 'c.jsonl'),
      fetchImpl: async () => { calls++; return { ok: false, status: 422, json: async () => ({}) }; },
    });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait');
    expect(v.note).toBe('http_422');
    expect(jev.stats().rejects).toBe(1);
    // THE fix: breaker OPEN NAHI hua — agli call wire pe jaati hai (4xx
    // provider-down nahi hai; pehle ek 422 poore provider ko 10 min band karti thi)
    expect(jev.stats().breakerOpen).toBe(false);
    await jev(snap('enter_short'), prompt);
    expect(calls).toBe(2); // no fail-fast — wire hit again
  });

  it('10b. HTTP 500 (retry-exhausted) DOES trip the breaker — note http_5xx', async () => {
    const jev = createJev({
      apiKey: 'k', retries: 0, breakerThreshold: 1, breakerCooldownMs: 60_000,
      cachePath: path.join(tmpDir, 'c.jsonl'),
      fetchImpl: async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); },
    });
    const v = await jev(snap(), prompt);
    expect(v.action).toBe('wait');
    expect(v.note).toBe('http_503');   // failover-triggerable note (auto arm)
    expect(jev.stats().breakerOpen).toBe(true);
  });

  it('11. cache key is provider-aware: same payload, do alag-named instances = 2 wire calls; same instance = 1', async () => {
    let calls = 0;
    const mk = (name) => createJev({
      apiKey: 'k', name,
      cachePath: path.join(tmpDir, `${name}.jsonl`),
      fetchImpl: async () => { calls++; return mkResp('enter_long', { enter_long: 0.55, wait: 0.45 }); },
    });
    const jev = mk('jev');
    const alt = mk('alt');
    await jev(snap(), prompt);
    await alt(snap(), prompt); // SAME payload — alag named instance, wire chahiye
    expect(calls).toBe(2);
    await jev(snap(), prompt);  // cache hit
    await alt(snap(), prompt); // cache hit
    expect(calls).toBe(2);
    expect(jev.stats().cacheHits).toBe(1);
    expect(alt.stats().cacheHits).toBe(1);
    expect(jev.stats().name).toBe('jev');
    expect(alt.stats().name).toBe('alt');
  });

  it('12. custom-endpoint instance fixture: answers.action.{choice,confidence,probabilities} + usage parse hota hai', async () => {
    // systemone-compatible response — usage field names same, choice
    // field same. Provider name se koi fark nahi padta — createJev engine
    // contract-faithful hai (v21.14: laya tha, ab generic custom endpoint).
    const altResp = {
      ok: true, status: 200,
      json: async () => ({
        answers: {
          action: { choice: 'enter_long', confidence: 0.71, probabilities: { enter_long: 0.62, wait: 0.38 } },
        },
        usage: { input_tokens: 300, output_tokens: 20 },
      }),
    };
    const alt = createJev({
      apiKey: 'lk', name: 'alt', model: '', url: 'http://127.0.0.1:9000/v1/systemone',
      threshold: 0.30, cachePath: path.join(tmpDir, 'alt.jsonl'),
      fetchImpl: async () => altResp,
    });
    const v = await alt(snap(), prompt);
    expect(v.action).toBe('enter_long');
    expect(v.probs.enter_long).toBeCloseTo(0.62);
    expect(v.confidence).toBeCloseTo(0.71);
    const s = alt.stats();
    expect(s.name).toBe('alt');
    expect(s.usage.inputTokens).toBe(300);
    expect(s.hasKey).toBe(true);
  });
});
