// ============================================================
// server/ai/voiceNotes.js — v10.9 #5 VOICE NOTES (server side)
// ------------------------------------------------------------
// The webhook bot receives voice notes this side of the fence —
// transcribe them with the SAME two-engine discipline the legacy
// bot uses (Groq Whisper large-v3 primary, Gemini inline-audio
// fallback), reading keys from the site's own secrets store
// (groqApiKey / geminiApiKey) with env fallback:
//
//   voice → text → the SAME desk agent a text question would hit
//
// Honesty contract: no engine available → an explicit error the
// caller surfaces ("type it instead") — never a fake transcript.
// ============================================================
import { getSecrets } from './secrets.js';

/** Resolve the transcription engines in priority order. */
export function sttEngines(env = {}) {
  const s = getSecrets();
  const out = [];
  const groq = s.groqApiKey || String(env?.groqApiKey || process.env.GROQ_API_KEY || '').trim();
  const gemini = s.geminiApiKey || String(env?.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (groq && groq.length >= 20) out.push({ id: 'groq-whisper-large-v3', key: groq });
  if (gemini && gemini.length >= 20) out.push({ id: 'gemini-inline-audio', key: gemini });
  return out;
}

/**
 * Transcribe a Telegram voice note (base64 payload).
 * @returns {Promise<{ok:true,text,engine}|{ok:false,error}>}
 */
export async function transcribeVoiceNote(base64Audio, { mimeType = 'audio/ogg', env = {} } = {}) {
  const b64 = String(base64Audio || '').replace(/^data:[^,]+,/, '');
  if (!b64) return { ok: false, error: 'empty voice payload' };
  const engines = sttEngines(env);
  if (!engines.length) {
    return { ok: false, error: 'no transcription engine configured (secrets me groqApiKey / geminiApiKey ya env GROQ_API_KEY / GEMINI_API_KEY daalo)' };
  }
  const errors = [];
  for (const eng of engines) {
    try {
      let text = '';
      if (eng.id === 'groq-whisper-large-v3') {
        const buf = Buffer.from(b64, 'base64');
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: mimeType || 'audio/ogg' }), 'voice.ogg');
        fd.append('model', 'whisper-large-v3');
        fd.append('response_format', 'json');
        const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${eng.key}` },
          body: fd,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          errors.push(`${eng.id}: HTTP ${res.status}`);
          continue;
        }
        const j = await res.json().catch(() => ({}));
        text = String(j?.text || '').trim();
      } else {
        // Gemini inline-audio — same multimodal generateContent path the
        // site's vision analysis uses, just with audio parts.
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${eng.key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: 'Transcribe this voice note exactly. Reply with ONLY the spoken text — no labels, no commentary. Hinglish stays Hinglish.' },
                { inlineData: { mimeType: mimeType || 'audio/ogg', data: b64 } },
              ],
            }],
          }),
          signal: AbortSignal.timeout(45_000),
        });
        if (!res.ok) {
          errors.push(`${eng.id}: HTTP ${res.status}`);
          continue;
        }
        const j = await res.json().catch(() => ({}));
        text = String(j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      }
      if (text) return { ok: true, text, engine: eng.id };
      errors.push(`${eng.id}: empty transcript`);
    } catch (e) {
      errors.push(`${eng.id}: ${String(e?.message || e).slice(0, 80)}`);
    }
  }
  return { ok: false, error: `transcription failed (${errors.join('; ')})` };
}

/** Download helper callers use BEFORE transcribing. */
export function voiceMimeOf(voice) {
  return String(voice?.mime_type || 'audio/ogg');
}
