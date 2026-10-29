// ============================================================
// server/ai/llmJson.js — shared LLM JSON extraction
// ------------------------------------------------------------
// Moved out of llmChain.js (v21.27) so opencodeBridge.js can use
// tryParseJson() without importing llmChain.js. llmChain.js now
// imports the OpenCode bridge for the CLOUD mode; keeping the
// parser here breaks that import cycle instead of recreating it.
// ============================================================

// v21.0 THINK-STRIP: R1/qwen3 reasoning blocks (concat-built, tooling-safe).
// (deepseek-r1 CoT + qwen3 thinking mode — dono strip hote hain.)
// String-concat se build kiya hai (tooling/literal safety).
const THINK_OPEN = '<' + 'think>';
const THINK_CLOSE = '</' + 'think>';

/** v21.0 THINK-STRIP: JSON parse se pehle thinking blocks hatao —
 * warna tryParseJson ka first-{-to-last-} window thinking ke andar ke
 * fragments pakad leta tha (R1 case). */
export function stripThinking(text) {
  let t = String(text || '');
  // closed thinking blocks (greedy non-cross removal — har pair)
  while (t.includes(THINK_OPEN)) {
    const s = t.indexOf(THINK_OPEN);
    const e = t.indexOf(THINK_CLOSE, s);
    if (e < 0) { t = t.slice(0, s); break; } // unclosed: sab kuch thinking hai
    t = t.slice(0, s) + t.slice(e + THINK_CLOSE.length);
  }
  return t.trim();
}

export function tryParseJson(text) {
  const cleaned = stripThinking(String(text || '').replace(/```json|```/gi, '')).trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const repair = (raw) => raw.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* try repaired / balanced */ }
  try { return JSON.parse(repair(cleaned.slice(start, end + 1))); } catch { /* scan balanced from end */ }
  // v21.18.0: agar reasoning text me pehle koi stray '{' aaya ho, to aakhri
  // balanced {...} JSON object ko reverse-scan se nikaalo — local Ollama
  // (deepseek-r1 / qwen3 / llama3) par 'no-json response' error zero!
  for (let i = cleaned.lastIndexOf('{'); i >= start; i = cleaned.lastIndexOf('{', i - 1)) {
    const slice = cleaned.slice(i, end + 1);
    try { return JSON.parse(repair(slice)); } catch { /* keep scanning */ }
    if (i === 0) break;
  }
  return null;
}
