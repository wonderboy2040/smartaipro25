// ============================================================
// test/voiceNotes.test.ts — v10.9 #5 (server-side STT)
// ------------------------------------------------------------
// Pins: engine resolution from the secrets store + env fallback,
// Groq Whisper happy path, Gemini inline-audio fallback, honest
// failure listing, empty-payload refusal.
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSecrets = vi.fn(() => ({}));

vi.mock('../server/ai/secrets.js', () => ({
  getSecrets: () => mockSecrets(),
}));

import { sttEngines, transcribeVoiceNote, voiceMimeOf } from '../server/ai/voiceNotes.js';

const origFetch = globalThis.fetch;

beforeEach(() => {
  mockSecrets.mockReturnValue({});
  vi.restoreAllMocks?.();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('sttEngines', () => {
  it('none configured → empty list', () => {
    expect(sttEngines()).toEqual([]);
  });
  it('secrets store wins; groq first, gemini second', () => {
    mockSecrets.mockReturnValue({ groqApiKey: 'gsk_test123456789012345', geminiApiKey: 'AIza_test123456789012345' });
    const e = sttEngines();
    expect(e.map(x => x.id)).toEqual(['groq-whisper-large-v3', 'gemini-inline-audio']);
  });
  it('env fallback when the store is empty', () => {
    const prev = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk_env123456789012345';
    expect(sttEngines().map(x => x.id)).toEqual(['groq-whisper-large-v3']);
    process.env.GROQ_API_KEY = prev;
  });
});

describe('transcribeVoiceNote', () => {
  it('empty payload → error, no engine call', async () => {
    const r = await transcribeVoiceNote('');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('no engine → honest config error', async () => {
    const r = await transcribeVoiceNote('QUJD');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no transcription engine/i);
  });

  it('Groq happy path (multipart transcription)', async () => {
    mockSecrets.mockReturnValue({ groqApiKey: 'gsk_test123456789012345' });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ text: 'BTC ka setup batao' }) }));
    const r = await transcribeVoiceNote('QUJD', { mimeType: 'audio/ogg' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('BTC ka setup batao');
    expect(r.engine).toBe('groq-whisper-large-v3');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toMatch(/groq\.com\/openai\/v1\/audio\/transcriptions/);
    expect(init.headers.Authorization).toBe('Bearer gsk_test123456789012345');
  });

  it('Groq fails → Gemini inline-audio fallback', async () => {
    mockSecrets.mockReturnValue({ groqApiKey: 'gsk_test123456789012345', geminiApiKey: 'AIza_test123456789012345' });
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini heard this' }] } }] }),
      };
    });
    const r = await transcribeVoiceNote('QUJD');
    expect(r.ok).toBe(true);
    expect(r.engine).toBe('gemini-inline-audio');
    expect(r.text).toBe('gemini heard this');
  });

  it('all engines fail → error names every failure', async () => {
    mockSecrets.mockReturnValue({ groqApiKey: 'gsk_test123456789012345', geminiApiKey: 'AIza_test123456789012345' });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const r = await transcribeVoiceNote('QUJD');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/groq-whisper-large-v3: HTTP 503/);
    expect(r.error).toMatch(/gemini-inline-audio: HTTP 503/);
  });

  it('voiceMimeOf defaults to audio/ogg', () => {
    expect(voiceMimeOf(undefined)).toBe('audio/ogg');
    expect(voiceMimeOf({ mime_type: 'audio/mpeg' })).toBe('audio/mpeg');
  });
});
