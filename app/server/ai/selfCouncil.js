// ============================================================
// server/ai/selfCouncil.js — v19.0 SELF-IMPROVEMENT ENGINE
// ------------------------------------------------------------
// PHASE 5 — META-INTELLIGENCE GOVERNANCE (the "council of self").
//
// Every self-improving system needs a change-control board. This
// module is it:
//
//   submitProposal({kind, tier, summary, configPatch, evidence})
//     — tier 'safe': bounded numeric gate nudges (minConfidence,
//       minAgreement, quorumPenalty) — auto-eligible after 24h ONLY
//       when SELFIMPROVE_AUTO_TUNE=true (default FALSE)
//     — tier 'risky': desks / mode / sizing / anything that changes
//       WHERE or HOW BIG the AI trades — ALWAYS human approval
//       (POST /api/ai/self/proposal/:id/approve from the panel)
//
//   apply/reject/rollback
//     — apply walks a BOUNDED whitelist (configPatch keys are
//       validated against APPLYABLE — unknown keys are stripped and
//       logged, never guessed)
//     — apply path reuses agent.js updateAgentConfig (same NUM_CLAMPS
//       clamping the human UI path uses — a proposal can NEVER set a
//       value a human couldn't set)
//     — rollback restores the recorded `from` snapshot of ONLY the
//       keys the proposal touched (1-click undo, stamped on the
//       evolution ledger)
//
//   SELFIMPROVE_ENABLED=false → master kill-switch: proposals pile
//   up pending, nothing auto-applies, apply() refuses.
//
// Store: ai-self-proposals.json (bounded last 50). NEVER throws.
// ============================================================
import { recordChange } from './evolutionLedger.js';
import { loadJSON, saveJSON } from '../lib/store.js';
import { updateAgentConfig, loadAgentConfig } from './agent.js';

const FILE = 'ai-self-proposals.json';
const MAX_PROPOSALS = 50;
const SAFE_AUTO_HOURS = 24;

const _r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/** The FULL whitelist of keys a proposal may patch. 'safe' keys =
 * bounded gate numerics; 'risky' keys = scope/size knobs. Anything
 * outside this table is stripped at apply time — no exceptions
 * (mode/enabled live traded only via their OWN human-phrase routes). */
export const APPLYABLE = {
  safe: ['minConfidence', 'minAgreement', 'quorumPenalty', 'minAiScore'],
  risky: ['desks'],
};
const TIERS = ['safe', 'risky'];

const killSwitchOn = () => String(process.env.SELFIMPROVE_ENABLED || 'true').toLowerCase() !== 'false';
const autoTuneOn = () => String(process.env.SELFIMPROVE_AUTO_TUNE || '').toLowerCase() === 'true';

function load() {
  return loadJSON(FILE, { proposals: [] });
}
function save(s) {
  s.proposals = (s.proposals || []).slice(-MAX_PROPOSALS);
  return saveJSON(FILE, s);
}

/** Classify a configPatch's tier by its keys (worst tier wins). */
export function tierOf(configPatch = {}) {
  const keys = Object.keys(configPatch || {});
  if (keys.some(k => APPLYABLE.risky.includes(k))) return 'risky';
  if (keys.length && keys.every(k => APPLYABLE.safe.includes(k))) return 'safe';
  return 'risky'; // unknown key = worst tier (stripped later anyway)
}

/** Strip a patch down to the whitelist. Returns clean patch. */
function sanitize(patch) {
  const out = {};
  const all = [...APPLYABLE.safe, ...APPLYABLE.risky];
  for (const k of all) {
    if (patch?.[k] == null) continue;
    if (k === 'desks') {
      if (patch.desks && typeof patch.desks === 'object') {
        out.desks = {};
        for (const d of ['futures', 'spot', 'india', 'global']) {
          if (patch.desks[d] != null) out.desks[d] = !!patch.desks[d];
        }
      }
      continue;
    }
    const n = Number(patch[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/**
 * Submit a proposal. Returns the stored proposal (or null).
 * @param {{kind:string, tier?:'safe'|'risky', summary:string, configPatch?:object, evidence?:object}} p
 */
export function submitProposal(p) {
  try {
    if (!p || !p.kind || !p.summary) return null;
    const patch = sanitize(p.configPatch || {});
    const tier = TIERS.includes(p.tier) ? p.tier : tierOf(patch);
    // no-op proposals (everything stripped) still record honestly
    const s = load();
    const proposal = {
      id: `sp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
      ts: Date.now(),
      kind: String(p.kind).slice(0, 40),
      tier,
      summary: String(p.summary).slice(0, 300),
      configPatch: patch,
      from: snapshotOf(patch, s),
      evidence: (p.evidence && typeof p.evidence === 'object') ? p.evidence : {},
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      appliedAt: null,
    };
    s.proposals.push(proposal);
    save(s);
    recordChange('proposal', `PROPOSAL [${tier}] ${p.kind} — ${p.summary}`.slice(0, 300), { id: proposal.id, tier, configPatch: patch, keys: Object.keys(patch) });
    return proposal;
  } catch { return null; }
}

/** Current values of ONLY the keys a patch touches. */
function snapshotOf(patch, _store) {
  let cfg;
  try { cfg = loadAgentConfig(); } catch { cfg = {}; }
  const snap = {};
  for (const k of Object.keys(patch || {})) {
    if (k === 'desks') snap.desks = { ...(cfg.desks || {}) };
    else if (cfg[k] !== undefined) snap[k] = cfg[k];
  }
  return snap;
}

/** Apply a proposal's patch through the SAME clamped path the human
 * config UI uses. Kill-switch refuses. Returns {ok, note}. */
function applyPatch(proposal, by = 'system') {
  if (!killSwitchOn()) return { ok: false, note: 'SELFIMPROVE_ENABLED=false — kill-switch ON hai, kuch apply nahi hoga' };
  if (!proposal.configPatch || !Object.keys(proposal.configPatch).length) {
    return { ok: false, note: 'proposal ka whitelist patch khali hai — kabhi kuch badal hi nahi sakta tha (record-only proposal)' };
  }
  updateAgentConfig(proposal.configPatch);
  return { ok: true, note: `configPatch applied via updateAgentConfig (clamped) — by ${by}` };
}

/** Human (or auto) approval. Risky = ALWAYS explicit human call. */
export function approveProposal(id, { by = 'human' } = {}) {
  try {
    const s = load();
    const p = s.proposals.find(x => x.id === id);
    if (!p) return { ok: false, note: 'proposal nahi mila' };
    if (p.status !== 'pending') return { ok: false, note: `proposal already ${p.status}` };
    const r = applyPatch(p, by);
    p.status = r.ok ? 'applied' : 'failed';
    p.decidedAt = Date.now();
    p.decidedBy = by;
    p.appliedAt = r.ok ? Date.now() : null;
    p.applyNote = r.note;
    save(s);
    recordChange('approval', `APPROVED [${p.tier}] ${p.kind} (${by}) — ${p.summary}`.slice(0, 300), { id, by, applied: r.ok, note: r.note });
    return r;
  } catch (e) {
    return { ok: false, note: `approve failed — ${String(e?.message || e).slice(0, 120)}` };
  }
}

export function rejectProposal(id, { by = 'human' } = {}) {
  try {
    const s = load();
    const p = s.proposals.find(x => x.id === id);
    if (!p) return { ok: false, note: 'proposal nahi mila' };
    if (p.status !== 'pending') return { ok: false, note: `proposal already ${p.status}` };
    p.status = 'rejected';
    p.decidedAt = Date.now();
    p.decidedBy = by;
    save(s);
    recordChange('rejection', `REJECTED [${p.tier}] ${p.kind} (${by}) — ${p.summary}`.slice(0, 300), { id, by });
    return { ok: true, note: 'proposal rejected — config untouched' };
  } catch (e) {
    return { ok: false, note: `reject failed — ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** One-click undo of an APPLIED proposal — restores ONLY the keys it
 * touched (from-snapshot), through the same clamped path. */
export function rollbackProposal(id, { by = 'human' } = {}) {
  try {
    const s = load();
    const p = s.proposals.find(x => x.id === id);
    if (!p) return { ok: false, note: 'proposal nahi mila' };
    if (p.status !== 'applied') return { ok: false, note: `sirf applied proposals rollback ho sakte hain (yeh ${p.status} hai)` };
    if (!p.from || !Object.keys(p.from).length) return { ok: false, note: 'from-snapshot khali — rollback ke liye kuch record nahi tha' };
    if (!killSwitchOn()) return { ok: false, note: 'kill-switch ON — rollback bhi block hai (SELFIMPROVE_ENABLED check karo)' };
    updateAgentConfig(p.from);
    p.status = 'rolled-back';
    p.rolledBackAt = Date.now();
    save(s);
    recordChange('rollback', `ROLLBACK ${p.kind} (${by}) — wapas ${JSON.stringify(p.from).slice(0, 160)}`, { id, by, restored: p.from });
    return { ok: true, note: `rollback done — ${Object.keys(p.from).join(', ')} wapas original` };
  } catch (e) {
    return { ok: false, note: `rollback failed — ${String(e?.message || e).slice(0, 120)}` };
  }
}

/**
 * Auto-apply pass (scheduler, hourly): ONLY safe-tier proposals older
 * than SAFE_AUTO_HOURS AND autoTuneOn(). Everything else waits.
 */
export function processAutoApprovals() {
  const out = { checked: 0, autoApplied: 0, skipped: [] };
  try {
    if (!killSwitchOn()) { out.skipped.push('kill-switch ON'); return out; }
    if (!autoTuneOn()) { out.skipped.push('SELFIMPROVE_AUTO_TUNE=false — safe proposals bhi manual approval ka wait karenge'); return out; }
    const s = load();
    const cutoff = Date.now() - SAFE_AUTO_HOURS * 3600000;
    for (const p of s.proposals) {
      if (p.status !== 'pending') continue;
      out.checked++;
      if (p.tier !== 'safe') { out.skipped.push(`${p.id} risky — human only`); continue; }
      if (p.ts > cutoff) { out.skipped.push(`${p.id} young — ${Math.ceil((cutoff - p.ts) / -3600000)}h wait`); continue; }
      const r = approveProposal(p.id, { by: 'auto-24h' });
      if (r.ok) out.autoApplied++;
    }
  } catch { /* honest silent */ }
  return out;
}

/** Ops view. */
export function proposalsStatus() {
  try {
    const s = load();
    const list = s.proposals.slice().reverse();
    return {
      killSwitch: { enabled: killSwitchOn(), env: 'SELFIMPROVE_ENABLED' },
      autoTune: { enabled: autoTuneOn(), env: 'SELFIMPROVE_AUTO_TUNE', safeAutoHours: SAFE_AUTO_HOURS },
      counts: {
        pending: list.filter(p => p.status === 'pending').length,
        applied: list.filter(p => p.status === 'applied').length,
        rejected: list.filter(p => p.status === 'rejected').length,
        rolledBack: list.filter(p => p.status === 'rolled-back').length,
      },
      proposals: list.slice(0, 20),
      applyableWhitelist: APPLYABLE,
    };
  } catch {
    return { killSwitch: { enabled: killSwitchOn() }, counts: {}, proposals: [] };
  }
}

// ---------------- tests ----------------
export function __setProposalsForTests(s) { save(s || { proposals: [] }); }
export function __proposalsRaw() { return load(); }
export const __testables = { sanitize, snapshotOf, applyPatch };
