// ============================================================
// test/councilDebate.test.ts — v10.8 PRO #1 BULL/BEAR DEBATE
// COUNCIL (Vibe-Trading investment-committee port).
//
// LOCKED HERE:
//   • the 3-step chain: bull advocate → bear advocate → PM verdict
//     (3 LLM calls, same grounded data each step)
//   • the PM verdict is returned in the SAME shape the legacy
//     single-shot path produced (verdicts map + model + online)
//   • any step failing → null → aiCouncilVerify falls back to the
//     LEGACY single-shot prompt (resilience first)
//   • AI_COUNCIL_DEBATE=off → the debate is skipped entirely
//   • no engines → honest offline (both paths)
// v21.27: the shared chain is LOCAL/CLOUD mode-aware; this suite pins
// the default LOCAL path with Ollama-native fetch mocks (the old
// Gemini-only mocks no longer exercise the production chain).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ollamaPayload = (obj) => ({
  ok: true,
  json: async () => ({ message: { role: 'assistant', content: JSON.stringify(obj) } }),
});

// role dispatch: read the PROMPT from the request body
let _roleResponses = {}; // { bull: obj|null, bear: obj|null, pm: obj|null, legacy: obj|null }
let _calls = [];         // { role, prompt }
let _ollamaUp = true;

beforeEach(() => {
  __resetSentinelForTests();
  _roleResponses = {};
  _calls = [];
  _ollamaUp = true;
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/tags')) {
      return _ollamaUp
        ? { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) }
        : { ok: false, json: async () => ({}) };
    }
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { body = {}; }
    const prompt = String(
      body?.messages?.map(m => m?.content).filter(Boolean).join('\n')
      || body.contents?.[0]?.parts?.[0]?.text
      || '',
    );
    // PM first — its prompt QUOTES both advocates ("BULL ADVOCATE:" as a
    // section header), so the bull/bear checks must come after.
    const role = prompt.includes('PORTFOLIO MANAGER') ? 'pm'
      : prompt.includes('BULL ADVOCATE') ? 'bull'
        : prompt.includes('BEAR ADVOCATE') ? 'bear'
          : prompt.includes('AI COUNCIL') ? 'legacy'
            : 'other';
    _calls.push({ role, prompt });
    const resp = _roleResponses[role];
    if (resp == null) return { ok: false, json: async () => ({}) };
    return ollamaPayload(resp);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { aiCouncilDebate, aiCouncilVerify, councilDebateEnabled } from '../server/ai/signals.js';
import { __resetSentinelForTests } from '../server/ai/llmSentinel.js';

const DEPS = { KEYS: {}, OPENAI_COMPAT: {} };

const CAND = [{
  ctx: { symbol: 'SOL', ltp: 142, changePct: 2.1, ind: { rsi: 58, adx: { adx: 24 }, atr: 4, vwap: 140 } },
  consensus: { side: 'LONG', confidence: 76 },
  votes: [{ name: 'Trend', dir: 1, conf: 80 }],
  plan: { entry: 142, stopLoss: 138, target1: 146, target2: 150 },
}];

const BULL = { cases: { SOL: { case: 'RSI 58 with ADX 24 trend — momentum room', strength: 72 } } };
const BEAR = { cases: { SOL: { case: 'RSI near 60 ceiling, ATR 2.8% — exhaustion risk', strength: 55 } } };
const PM = { verdicts: { SOL: { verdict: 'LONG', confidence: 71, note: 'trend wins over exhaustion', analysis: 'Bull leans on ADX trend; bear on RSI ceiling — trend + VWAP side wins.' } } };

describe('councilDebateEnabled — the flag', () => {
  it('default ON', () => {
    delete process.env.AI_COUNCIL_DEBATE;
    expect(councilDebateEnabled()).toBe(true);
  });
  it('explicit off words seal it', () => {
    for (const v of ['0', 'off', 'false', 'no', 'disabled']) {
      process.env.AI_COUNCIL_DEBATE = v;
      expect(councilDebateEnabled()).toBe(false);
    }
    delete process.env.AI_COUNCIL_DEBATE;
  });
});

describe('aiCouncilDebate — the 3-step chain', () => {
  it('bull → bear → PM: exactly 3 LLM calls, PM verdicts returned in the legacy shape', async () => {
    __resetSentinelForTests();
    _roleResponses = { bull: BULL, bear: BEAR, pm: PM };
    const out = await aiCouncilDebate(CAND, DEPS, 'CRYPTO');
    expect(out).toBeTruthy();
    expect(out.online).toBe(true);
    expect(out.model).toBe('ollama:qwen3:8b');
    expect(out.verdicts.SOL.verdict).toBe('LONG');
    expect(out.verdicts.SOL.confidence).toBe(71);
    expect(out.debate.bull.SOL.case).toMatch(/momentum room/);
    expect(out.debate.bear.SOL.case).toMatch(/exhaustion risk/);
    // the three prompts are role-staged and grounded in the SAME data
    expect(_calls.length).toBe(3);
    expect(_calls.map(c => c.role)).toEqual(['bull', 'bear', 'pm']);
    expect(_calls[0].prompt).toMatch(/SOL/);
    expect(_calls[0].prompt).toMatch(/strongest HONEST LONG case/);
    expect(_calls[1].prompt).toMatch(/strongest HONEST SHORT case/);
    expect(_calls[2].prompt).toMatch(/PORTFOLIO MANAGER/);
    expect(_calls[2].prompt).toMatch(/DISAGREE/i);
    expect(_calls[2].prompt).toMatch(/exhaustion risk/); // the PM sees BOTH cases
    expect(_calls[2].prompt).toMatch(/momentum room/);
  });

  it('bull step fails → null (caller falls back to legacy)', async () => {
    _roleResponses = { bull: null, bear: BEAR, pm: PM };
    expect(await aiCouncilDebate(CAND, DEPS, 'CRYPTO')).toBeNull();
  });

  it('bear step fails → null', async () => {
    _roleResponses = { bull: BULL, bear: null, pm: PM };
    expect(await aiCouncilDebate(CAND, DEPS, 'CRYPTO')).toBeNull();
  });

  it('PM returns garbage (no verdicts) → null', async () => {
    _roleResponses = { bull: BULL, bear: BEAR, pm: { somethingElse: true } };
    expect(await aiCouncilDebate(CAND, DEPS, 'CRYPTO')).toBeNull();
  });

  it('empty candidate set → null without any LLM call', async () => {
    expect(await aiCouncilDebate([], DEPS, 'CRYPTO')).toBeNull();
    expect(_calls.length).toBe(0);
  });
});

describe('aiCouncilVerify — debate-first with legacy fallback', () => {
  it('debate success → the debated verdicts are returned (no legacy retry)', async () => {
    _roleResponses = { bull: BULL, bear: BEAR, pm: PM, legacy: { verdicts: { SOL: { verdict: 'AVOID', confidence: 55 } } } };
    const out = await aiCouncilVerify(CAND, DEPS, 'CRYPTO');
    expect(out.online).toBe(true);
    expect(out.verdicts.SOL.verdict).toBe('LONG'); // the PM's debated verdict, not legacy's
    expect(out.debate).toBeTruthy();
    expect(_calls.map(c => c.role)).toEqual(['bull', 'bear', 'pm']); // no legacy call
  });

  it('debate step fails → the legacy single-shot runs (resilience)', async () => {
    _roleResponses = { bull: null, bear: BEAR, pm: PM, legacy: { verdicts: { SOL: { verdict: 'SHORT', confidence: 66, note: 'x', analysis: 'y' } } } };
    const out = await aiCouncilVerify(CAND, DEPS, 'CRYPTO');
    expect(out.online).toBe(true);
    expect(out.verdicts.SOL.verdict).toBe('SHORT');
    expect(_calls.some(c => c.role === 'legacy')).toBe(true); // legacy took over
  });

  it('AI_COUNCIL_DEBATE=off → debate skipped, legacy runs alone', async () => {
    process.env.AI_COUNCIL_DEBATE = 'off';
    try {
      _roleResponses = { legacy: { verdicts: { SOL: { verdict: 'LONG', confidence: 70, note: 'x', analysis: 'y' } } } };
      const out = await aiCouncilVerify(CAND, DEPS, 'CRYPTO');
      expect(out.online).toBe(true);
      expect(out.verdicts.SOL.verdict).toBe('LONG');
      expect(_calls.map(c => c.role)).toEqual(['legacy']); // exactly the legacy prompt
      expect(_calls[0].prompt).toMatch(/AI COUNCIL/);
      expect(_calls[0].prompt).not.toMatch(/BULL ADVOCATE/);
    } finally {
      delete process.env.AI_COUNCIL_DEBATE;
    }
  });

  it('no engines → honest offline, zero calls', async () => {
    __resetSentinelForTests();
    _ollamaUp = false;
    const out = await aiCouncilVerify(CAND, { KEYS: {}, OPENAI_COMPAT: {} }, 'CRYPTO');
    expect(out).toEqual({ verdicts: {}, model: null, online: false });
    expect(_calls.length).toBe(0);
  });
});

// ============================================================
// v21.0.6 [audit B1/G1] — DEEP-path debate model swap contract.
// The 🔬 deep path (getDeepSignal, opts.deep=true) ab teeno debate
// calls councilAskDeep (OLLAMA_DEEP_MODEL, e.g. deepseek-r1:14b) pe
// route karta hai — pehle sirf legacy single-shot deep honor karta
// tha, isliye default debate=ON config me deep modal ka council
// HAMESHA scan model (qwen3:8b) pe chalta tha jabki chip "↗R1·14B"
// promise karta tha. Cloud legs ke liye deep flag no-op hai —
// yahan source-contract lock kiya gaya hai (cloud path behavior
// councilAskDeep == councilAsk, sirf local ollama leg swap hota hai).
// ============================================================
describe('v21.0.6 — deep-path debate model swap (source contract)', () => {
  it('aiCouncilDebate routes its 3 calls via councilAskDeep when opts.deep', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/ai/signals.js'),
      'utf8',
    );
    // the debate picks its asker by the deep flag…
    expect(src).toMatch(/const ask = opts\.deep \? councilAskDeep : councilAsk;/);
    // …and all three steps use it
    const debateBody = src.slice(src.indexOf('export async function aiCouncilDebate'), src.indexOf('export async function aiCouncilVerify'));
    expect((debateBody.match(/await ask\(/g) || []).length).toBe(3);
    expect(debateBody).not.toMatch(/await councilAsk\(/); // no un-routed direct calls
    // the caller threads opts through
    expect(src).toMatch(/aiCouncilDebate\(candidates, deps, market, opts\)/);
  });
});
