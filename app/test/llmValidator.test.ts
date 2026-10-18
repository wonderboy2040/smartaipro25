// ============================================================
// test/llmValidator.test.ts — v13.2 A2 LLM SECOND-OPINION VALIDATOR
// ------------------------------------------------------------
// LOCKED HERE (plan A2: "Use an LLM as a second-opinion validator
// only when ensemble confidence is borderline (45-60%) — checks
// recent price action + news before firing"):
//   • The borderline band: 45-60 inclusive; 44 / 61 OUT
//   • Custom band via AI_LLM_VALIDATOR_BAND
//   • Out-of-band / disabled / no-keys → null, ZERO chain calls
//   • The chain answer maps to CONFIRM / REJECT / FLIP, clamped
//     confidence, reason truncated
//   • Unknown verdict JSON → null (never surfaces garbage)
//   • ONE live call per symbol per 15m candle (candle-close cache);
//     a second ask in the same bucket is served from cache
//   • llmValidateCached: current OR previous bucket only (a 30m-old
//     opinion is better than none; 2-bucket-old is not)
//   • Prompt carries the SVA verdict + side + plan, never throws
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  llmValidatorEnabled, borderlineBand, inBorderlineBand,
  llmValidateSignal, llmValidateCached, llmValidatorStatus,
  __resetLlmValidatorForTests, __testables,
} from '../server/ai/llmValidator.js';

// mock the provider chain BEFORE the module under test imports it
vi.mock('../server/ai/llmChain.js', () => ({
  councilAsk: vi.fn(),
  aiKeysPresent: (KEYS) => !!(KEYS && (KEYS.gemini || KEYS.groq || KEYS.cerebras || KEYS.openrouter)),
}));
import { councilAsk } from '../server/ai/llmChain.js';

const KEYS = { gemini: 'k' };
const DEPS = { KEYS, OPENAI_COMPAT: {} };
const baseSig = {
  symbol: 'XRP', market: 'FUTURES', side: 'LONG',
  confidence: 52, grade: 'WATCH', voters: 6, totalModels: 14,
  summary: 'PULLBACK 0.02×ATR below EMA20 · edge +23.7pt',
  verify: { agent: 'SVA-v1', action: 'CAUTION', finalCall: 'LONG', score: 55 },
  plan: { entry: 1.62, stopLoss: 1.56, targets: [1.72, 1.84], rr: 2.1 },
  superIntel: { aiScore: 71 },
};

describe('A2 LLM second-opinion validator', () => {
  beforeEach(() => {
    __resetLlmValidatorForTests();
    vi.mocked(councilAsk).mockReset();
  });

  it('borderline band is 45-60 inclusive by default', () => {
    expect(borderlineBand()).toEqual([45, 60]);
    expect(inBorderlineBand(44)).toBe(false);
    expect(inBorderlineBand(45)).toBe(true);
    expect(inBorderlineBand(60)).toBe(true);
    expect(inBorderlineBand(61)).toBe(false);
  });

  it('custom band via AI_LLM_VALIDATOR_BAND', () => {
    expect(borderlineBand({ AI_LLM_VALIDATOR_BAND: '40,55' })).toEqual([40, 55]);
    expect(inBorderlineBand(42, { AI_LLM_VALIDATOR_BAND: '40,55' })).toBe(true);
    expect(inBorderlineBand(58, { AI_LLM_VALIDATOR_BAND: '40,55' })).toBe(false);
  });

  it('out-of-band confidence → null with ZERO chain calls', async () => {
    const out = await llmValidateSignal({ ...baseSig, confidence: 75 }, DEPS);
    expect(out).toBeNull();
    expect(councilAsk).not.toHaveBeenCalled();
    const out2 = await llmValidateSignal({ ...baseSig, confidence: 30 }, DEPS);
    expect(out2).toBeNull();
    expect(councilAsk).not.toHaveBeenCalled();
  });

  it('disabled via AI_ENABLE_LLM_VALIDATOR=false → null, zero calls', async () => {
    const out = await llmValidateSignal(baseSig, DEPS, { env: { AI_ENABLE_LLM_VALIDATOR: 'false' } });
    expect(out).toBeNull();
    expect(councilAsk).not.toHaveBeenCalled();
    expect(llmValidatorEnabled({ AI_ENABLE_LLM_VALIDATOR: 'false' })).toBe(false);
  });

  it('no keys → null, zero calls', async () => {
    const out = await llmValidateSignal(baseSig, { KEYS: {}, OPENAI_COMPAT: {} });
    expect(out).toBeNull();
    expect(councilAsk).not.toHaveBeenCalled();
  });

  it('maps a CONFIRM verdict with clamped confidence + truncated reason', async () => {
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'CONFIRM', confidence: 250, reason: 'x'.repeat(400) }, model: 'gemini' });
    const out = await llmValidateSignal(baseSig, DEPS);
    expect(out).toEqual({
      verdict: 'CONFIRM', confidence: 100, reason: 'x'.repeat(200), model: 'gemini', ts: expect.any(Number),
    });
  });

  it('REJECT and FLIP verdicts pass through', async () => {
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'REJECT', confidence: 70, reason: 'news-driven invalidation' }, model: 'groq' });
    const out = await llmValidateSignal(baseSig, DEPS);
    expect(out?.verdict).toBe('REJECT');
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'FLIP', confidence: 65, reason: 'clear reversal structure' }, model: 'cerebras' });
    const out2 = await llmValidateSignal({ ...baseSig, symbol: 'BTC' }, DEPS);
    expect(out2?.verdict).toBe('FLIP');
  });

  it('unknown verdict / chain failure → null (never garbage)', async () => {
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'MAYBE', confidence: 50, reason: '??' }, model: 'gemini' });
    expect(await llmValidateSignal(baseSig, DEPS)).toBeNull();
    vi.mocked(councilAsk).mockResolvedValue({ json: null, model: null });
    expect(await llmValidateSignal(baseSig, DEPS)).toBeNull();
    vi.mocked(councilAsk).mockRejectedValue(new Error('boom'));
    expect(await llmValidateSignal(baseSig, DEPS)).toBeNull();
  });

  it('ONE live call per symbol per 15m candle — same-bucket asks are cached', async () => {
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'CONFIRM', confidence: 80, reason: 'clean' }, model: 'gemini' });
    const now = 1700000000000;
    const a = await llmValidateSignal(baseSig, DEPS, { now });
    const b = await llmValidateSignal(baseSig, DEPS, { now: now + 60_000 }); // same 15m bucket
    expect(a).toEqual(b);
    expect(councilAsk).toHaveBeenCalledTimes(1);
    // different market = different cache key → second call
    const c = await llmValidateSignal({ ...baseSig, market: 'CRYPTO' }, DEPS, { now: now + 60_000 });
    expect(c).not.toBeNull();
    expect(councilAsk).toHaveBeenCalledTimes(2);
  });

  it('next candle bucket → fresh live call', async () => {
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'CONFIRM', confidence: 80, reason: 'a' }, model: 'gemini' });
    const now = 1700000000000;
    await llmValidateSignal(baseSig, DEPS, { now });
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'FLIP', confidence: 60, reason: 'b' }, model: 'groq' });
    const next = await llmValidateSignal(baseSig, DEPS, { now: now + 16 * 60_000 });
    expect(next?.verdict).toBe('FLIP');
    expect(councilAsk).toHaveBeenCalledTimes(2);
  });

  it('llmValidateCached reads current OR previous bucket only', async () => {
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'CONFIRM', confidence: 80, reason: 'c' }, model: 'gemini' });
    const now = 1700000000000;
    await llmValidateSignal(baseSig, DEPS, { now });
    // same bucket
    expect(llmValidateCached('XRP', 'FUTURES', { now: now + 60_000 })?.verdict).toBe('CONFIRM');
    // previous bucket (opinion is 15-30m old — still informative)
    expect(llmValidateCached('XRP', 'FUTURES', { now: now + 16 * 60_000 })?.verdict).toBe('CONFIRM');
    // two buckets later → stale, honest null
    expect(llmValidateCached('XRP', 'FUTURES', { now: now + 31 * 60_000 })).toBeNull();
    // never a call from the cached read
    expect(councilAsk).toHaveBeenCalledTimes(1);
  });

  it('prompt carries the ensemble call, SVA verdict and plan', () => {
    const p = __testables.buildPrompt(baseSig);
    expect(p).toContain('XRP');
    expect(p).toContain('LONG');
    expect(p).toContain('SVA checklist score: 55');
    expect(p).toContain('CONFIRM|REJECT|FLIP');
    expect(p).toContain('borderline');
  });

  it('status view exposes band + cache size', async () => {
    vi.mocked(councilAsk).mockResolvedValue({ json: { verdict: 'CONFIRM', confidence: 80, reason: 's' }, model: 'gemini' });
    await llmValidateSignal(baseSig, DEPS);
    const st = llmValidatorStatus();
    expect(st.enabled).toBe(true);
    expect(st.band).toEqual([45, 60]);
    expect(st.candleBucketMin).toBe(15);
    expect(st.cached).toBe(1);
  });
});
