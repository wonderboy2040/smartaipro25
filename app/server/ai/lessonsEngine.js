// ============================================================
// server/ai/lessonsEngine.js — v19.0 SELF-IMPROVEMENT ENGINE
// ------------------------------------------------------------
// PHASE 3a — LESSONS ENGINE (long-term self-knowledge).
//
// weeklyReview narrated YOUR week — but its "lessons" evaporated:
// next week started from zero. This module makes the system KEEP
// what it learned:
//
//   generateLessons(deps)  ONE pass:
//     1. QUANT computes the evidence (zero LLM cost, zero
//        hallucination): worst loss clusters (by market/reason/
//        confidence-band), best win patterns, calibration buckets,
//        drift verdict — from the outcomeHarvester dataset.
//     2. ONE askLLM call narrates AT MOST 5 lessons in a STRICT
//        JSON schema (title/trigger/rule/severity) — the
//        "quant-computes, LLM-narrates" pattern the whole desk uses.
//     3. Schema validation + hard caps; LLM down/invalid →
//        DETERMINISTIC lessons from the quant stats (never blocks,
//        never fabricates).
//     4. Versioned persist: ai-lessons.json (current) +
//        ai-lessons-history.json (last 12 versions).
//     5. lessonsForPrompt() — a bounded context block the Council
//        deep path + agent can read, so past mistakes shape future
//        verdicts (injection is explicit, call-site opts in).
//
// Honesty rules: lessons reference REAL numbers from the dataset
// (n, winRate, avgR stamped per lesson); a lesson engine without
// numbers is an opinion engine. Rows < 20 → deterministic mode.
// ============================================================
import { rowsForLessons, datasetStatus as _datasetStatus } from './outcomeHarvester.js';
import { driftReport } from './driftMonitor.js';
import { recordChange } from './evolutionLedger.js';
import { loadJSON, saveJSON } from '../lib/store.js';

const LESSONS_FILE = 'ai-lessons.json';
const HISTORY_FILE = 'ai-lessons-history.json';
const MAX_LESSONS = 5;
const MAX_HISTORY = 12;

const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

// ---------------- quant evidence (pure) ----------------
export function quantEvidence(rows) {
  const n = rows.length;
  if (!n) return { n: 0, note: 'dataset khali — settled trades hi lessons ka fuel hain' };
  const wins = rows.filter(x => x.win);
  const losses = rows.filter(x => !x.win);
  const byMarket = {};
  for (const m of ['CRYPTO', 'FUTURES', 'GLOBALFUTURES', 'INDIA']) {
    const t = rows.filter(x => x.market === m);
    if (t.length >= 3) byMarket[m] = { n: t.length, winRate: r2((t.filter(x => x.win).length / t.length) * 100), avgR: r2(t.reduce((a, x) => a + x.r, 0) / t.length) };
  }
  // loss clusters: same close-reason ≥3 times
  const lossReasons = {};
  for (const x of losses) {
    const k = String(x.reason || 'unknown');
    lossReasons[k] = (lossReasons[k] || 0) + 1;
  }
  const worstReason = Object.entries(lossReasons).sort((a, b) => b[1] - a[1])[0] || null;
  // confidence-band honesty: high-conf band underperforming?
  const hi = rows.filter(x => (x.confidence ?? 0) >= 75);
  const lo = rows.filter(x => (x.confidence ?? 0) < 75);
  const hiStats = hi.length >= 5 ? { n: hi.length, winRate: r2((hi.filter(x => x.win).length / hi.length) * 100) } : null;
  const loStats = lo.length >= 5 ? { n: lo.length, winRate: r2((lo.filter(x => x.win).length / lo.length) * 100) } : null;
  // worst symbol
  const bySym = {};
  for (const x of rows) bySym[x.symbol] = (bySym[x.symbol] || { n: 0, r: 0 }), bySym[x.symbol].n++, bySym[x.symbol].r += x.r;
  const worstSym = Object.entries(bySym).filter(([, s]) => s.n >= 3).sort((a, b) => a[1].r - b[1].r)[0] || null;
  return {
    n, winRate: r2((wins.length / n) * 100), avgR: r2(rows.reduce((a, x) => a + x.r, 0) / n),
    wins: wins.length, losses: losses.length,
    byMarket,
    worstCloseReason: worstReason ? { reason: worstReason[0], count: worstReason[1] } : null,
    hiConfBand: hiStats, loConfBand: loStats,
    worstSymbol: worstSym ? { symbol: worstSym[0], n: worstSym[1].n, avgR: r2(worstSym[1].r / worstSym[1].n) } : null,
  };
}

// ---------------- deterministic lessons (LLM down path) ----------------
export function deterministicLessons(ev) {
  const out = [];
  if (!ev || !ev.n) return out;
  out.push({ title: 'Sample honesty', trigger: `dataset ${ev.n} settled trades`, rule: `decisions ${ev.n} rows par bhi — win ${ev.winRate}%, avg ${ev.avgR}R. Sample badhne tak sirf direction-level conclusions trust karo`, severity: 'info', evidence: { n: ev.n, winRate: ev.winRate, avgR: ev.avgR } });
  if (ev.worstCloseReason && ev.worstCloseReason.count >= 3) {
    out.push({ title: `Repeat exit pattern: ${ev.worstCloseReason.reason}`, trigger: `${ev.worstCloseReason.count} losses closed by "${ev.worstCloseReason.reason}"`, rule: `is close-reason ke entries me SL placement / hold window dobara check karo — pattern 3+ baar repeat ho chuka hai`, severity: 'warn', evidence: ev.worstCloseReason });
  }
  if (ev.hiConfBand && ev.loConfBand && ev.hiConfBand.winRate != null && ev.loConfBand.winRate != null && ev.hiConfBand.winRate < ev.loConfBand.winRate) {
    out.push({ title: 'High-confidence band underperforming', trigger: `conf≥75% wins ${ev.hiConfBand.winRate}% vs conf<75% wins ${ev.loConfBand.winRate}%`, rule: 'confidence labels calibrated nahi hain — high-conf par size BADHANE se pehle calibration theek karo', severity: 'warn', evidence: { hi: ev.hiConfBand, lo: ev.loConfBand } });
  }
  if (ev.worstSymbol && ev.worstSymbol.avgR < 0) {
    out.push({ title: `Worst symbol: ${ev.worstSymbol.symbol}`, trigger: `${ev.worstSymbol.n} trades, avg ${ev.worstSymbol.avgR}R`, rule: `${ev.worstSymbol.symbol} par setup quality review karo — edge negative hai`, severity: 'info', evidence: ev.worstSymbol });
  }
  return out.slice(0, MAX_LESSONS);
}

// ---------------- LLM lessons (one call, strict schema) ----------------
const SYSTEM = `You are the Lessons Engine of a self-improving trading desk. You receive QUANT-COMPUTED evidence (real settled-trade numbers). Derive AT MOST ${MAX_LESSONS} concise lessons.
RULES:
- Every lesson MUST cite the numbers you were given (n / winRate / avgR) — never invent numbers.
- Output STRICT JSON only, no markdown: {"lessons":[{"title":string(<=60 chars),"trigger":string,"rule":string(<=160 chars),"severity":"info"|"warn"|"critical","evidence":object}]}
- "rule" is an actionable trading-desk rule, not advice to the user.
- English or Hinglish ok. If evidence is thin, FEWER lessons (honest).`;

function validateLLMLessons(j) {
  try {
    const arr = Array.isArray(j?.lessons) ? j.lessons : null;
    if (!arr) return null;
    const out = arr.slice(0, MAX_LESSONS).filter(x => x && typeof x === 'object' && x.title && x.rule).map(x => ({
      title: String(x.title).slice(0, 60),
      trigger: String(x.trigger || '').slice(0, 120),
      rule: String(x.rule).slice(0, 160),
      severity: ['info', 'warn', 'critical'].includes(x.severity) ? x.severity : 'info',
      evidence: (x.evidence && typeof x.evidence === 'object') ? x.evidence : {},
    }));
    return out.length ? out : null;
  } catch { return null; }
}

function parseJsonLoose(text) {
  try {
    const t = String(text || '').trim();
    const s = t.indexOf('{'); const e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    return JSON.parse(t.slice(s, e + 1));
  } catch { return null; }
}

// ---------------- the engine ----------------
/**
 * One lessons pass. deps = { KEYS, OPENAI_COMPAT } (same wiring as
 * weeklyReview). Result cached 6h. NEVER throws.
 */
let _cache = null; // {at, result}
export async function generateLessons(deps = {}) {
  if (_cache && Date.now() - _cache.at < 6 * 3600000) return { ..._cache.result, cached: true };
  const rows = rowsForLessons();
  const ev = quantEvidence(rows);
  const dr = driftReport();
  let lessons = null;
  let engine = null;
  if (rows.length >= 20 && typeof deps?.KEYS === 'object') {
    try {
      const { askLLM } = await import('../intraday/agent.js');
      const r = await askLLM(SYSTEM, `SETTLED OUTCOME EVIDENCE:\n${JSON.stringify({ evidence: ev, drift: dr.verdict }, null, 1)}`, deps, { temperature: 0.3, maxTokens: 900, timeout: 40000 });
      if (r?.text || r?.content) {
        lessons = validateLLMLessons(parseJsonLoose(r.text || r.content));
        engine = lessons ? (r.engine || 'llm') : null;
      }
    } catch { /* deterministic path */ }
  }
  if (!lessons) lessons = deterministicLessons(ev);
  const result = {
    ok: true, ts: Date.now(), engine, mode: rows.length >= 20 ? (engine ? 'llm' : 'deterministic') : 'deterministic-thin-data',
    datasetRows: rows.length, evidence: ev, driftVerdict: dr.verdict,
    lessons,
    note: rows.length < 20 ? `sirf ${rows.length} settled rows — deterministic lessons (LLM ko opinion-engine nahi banate thin data par)` : (engine ? 'LLM narrated the quant numbers' : 'LLM unavailable — deterministic lessons from quant stats'),
  };
  // persist versioned
  try {
    const prev = loadJSON(LESSONS_FILE, null);
    const version = (prev?.version || 0) + 1;
    const payload = { ...result, version };
    saveJSON(LESSONS_FILE, payload);
    if (prev?.version) {
      const h = loadJSON(HISTORY_FILE, { versions: [] });
      h.versions.unshift({ version: prev.version, ts: prev.ts, lessons: (prev.lessons || []).map(l => l.title) });
      h.versions = h.versions.slice(0, MAX_HISTORY);
      saveJSON(HISTORY_FILE, h);
    }
    recordChange('lesson', `lessons v${version} generated (${lessons.length} lessons, mode ${result.mode}, drift ${dr.verdict})`, { version, mode: result.mode, lessons: lessons.length, drift: dr.verdict });
  } catch { /* read-only fs — memory result still returned */ }
  _cache = { at: Date.now(), result };
  return { ...result, cached: false };
}

/** Current lessons (persisted file first — survives restarts). */
export function currentLessons() {
  try {
    const l = loadJSON(LESSONS_FILE, null);
    if (l && Array.isArray(l.lessons)) return l;
    return { version: 0, lessons: [], ts: null, note: 'lessons abhi generate nahi hue — /api/ai/self/lessons/run' };
  } catch {
    return { version: 0, lessons: [], ts: null, note: 'lessons unavailable' };
  }
}

/**
 * Bounded prompt context block — the INJECTION point. Callers
 * (council deep, agent skip context) opt in explicitly.
 */
export function lessonsForPrompt(max = MAX_LESSONS) {
  const l = currentLessons();
  if (!l.lessons?.length) return '';
  const lines = l.lessons.slice(0, Math.max(1, Math.min(MAX_LESSONS, max)))
    .map((x, i) => `${i + 1}. [${x.severity}] ${x.title}: ${x.rule}`);
  return `DESK LESSONS LEARNED (v${l.version}, settled-outcome evidence):\n${lines.join('\n')}\n`;
}

// ---------------- tests ----------------
export function __clearLessonsCache() { _cache = null; }
export const __testables = { validateLLMLessons, parseJsonLoose };
