// ============================================================
// server/ai/evolutionLedger.js — v19.0 SELF-IMPROVEMENT ENGINE
// ------------------------------------------------------------
// Phase 4 foundation: the EVOLUTION LEDGER — a tamper-evident,
// append-only SHA-256 hash chain (same honesty model as the signal
// ledger v6.7) that records EVERY self-modification the AI makes:
//
//   drift alarms · retrains · gate tunes · lessons learned ·
//   strategy evolutions · self-repairs · council proposals ·
//   approvals · rollbacks · shadow promotions
//
// Why this exists: a self-improving AI without an untampered audit
// trail is un-auditable. hash = SHA256(prevHash + canonical body),
// so ANY historical edit breaks every link after it. "Yeh change
// us waqt aise hi hua tha" becomes mathematically provable.
//
// Kinds (whitelist — unknown kinds are rejected, not guessed):
//   drift-alarm, retrain, gate-tune, lesson, strategy-evolve,
//   self-repair, proposal, approval, rejection, rollback,
//   shadow-promote, harvest
//
// Storage: ai-evolution-ledger.json (lib/store — atomic writes,
// read-only-fs degrades to memory). Pruned to last 600 entries
// (chain survives pruning, head links to new oldest).
//
// Pure module — no network, no timers. Consumers: selfCouncil,
// gateTuner, driftMonitor, retrainBridge, lessonsEngine,
// strategyEvolution, selfStatus, routes.
// ============================================================
import crypto from 'node:crypto';
import { loadJSON, saveJSON } from '../lib/store.js';

const LEDGER_FILE = 'ai-evolution-ledger.json';
const MAX_ENTRIES = 600;

const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Every kind this ledger accepts. Unknown kind → record rejected
 * (return null) — the caller logs honestly instead of us guessing. */
export const CHANGE_KINDS = [
  'harvest',        // Phase 1: outcome dataset grew (stats stamped)
  'drift-alarm',    // Phase 1: drift monitor tripped
  'retrain',        // Phase 2: ml-service retrain triggered (+ result)
  'gate-tune',      // Phase 2: entry gates changed (from → to)
  'lesson',         // Phase 3: lessons regenerated (version stamped)
  'strategy-evolve',// Phase 3: strategy evolution run (best candidates)
  'self-repair',    // Phase 4: a self-repair action fired
  'proposal',       // Phase 5: a change proposal was submitted
  'approval',       // Phase 5: a proposal was approved
  'rejection',      // Phase 5: a proposal was rejected
  'rollback',       // Phase 5: a change was rolled back
  'shadow-promote', // Phase 2: challenger beat champion in shadow
];

/** Canonical body — everything EXCEPT id/prevHash/hash (the chain
 * links stay frozen even though `details` is rich). */
function bodyOf(e) {
  const { id: _id, prevHash: _prevHash, hash: _hash, ...body } = e || {};
  return body;
}
function hashEntry(e) {
  return sha256(JSON.stringify({ prev: e?.prevHash || null, body: bodyOf(e) }));
}

function load() {
  return loadJSON(LEDGER_FILE, { entries: [] });
}
function save(l) {
  if (l.entries.length > MAX_ENTRIES) {
    l.entries = l.entries.slice(-MAX_ENTRIES);
    // v19.0.1 FIX (the ledger.js v7.0.2 lesson): re-anchor the pruned
    // chain as a fresh checkpoint — the new head gets prevHash null and
    // every later link is recomputed. Without this, verifyEvolutionLedger()
    // reports brokenAt:0 FOREVER after the 601st entry (false tamper
    // alarm on the exact evidence this ledger exists to protect).
    // Tampering detection itself is unchanged: a spliced entry WITHOUT
    // re-anchoring still fails the strict head check.
    if (l.entries.length > 0) {
      let prev = null;
      for (const e of l.entries) {
        e.prevHash = prev;
        e.hash = hashEntry(e);
        prev = e.hash;
      }
    }
  }
  return saveJSON(LEDGER_FILE, l);
}

/**
 * Record one self-modification. NEVER throws (the tick loop and
 * schedulers call this — a ledger write must never trade-crash the
 * app). Returns the stamped entry or null when rejected.
 * @param {string} kind    whitelisted kind
 * @param {string} summary one human line (Hinglish ok, ASCII-safe preferred)
 * @param {object} details structured evidence ({from,to,evidence,...})
 */
export function recordChange(kind, summary, details = {}) {
  try {
    if (!CHANGE_KINDS.includes(kind)) return null;
    const l = load();
    const prevHash = l.entries.length ? l.entries[l.entries.length - 1].hash : null;
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind,
      summary: String(summary || '').slice(0, 300),
      details: (details && typeof details === 'object') ? details : {},
      prevHash,
    };
    entry.hash = hashEntry(entry);
    l.entries.push(entry);
    save(l);
    return entry;
  } catch {
    return null; // read-only fs / disk full — degrade silently, never crash
  }
}

/** Walk the chain and recompute every hash. {ok, entries, brokenAt} */
export function verifyEvolutionLedger() {
  try {
    const l = load();
    let prev = null;
    for (let i = 0; i < l.entries.length; i++) {
      const e = l.entries[i];
      if (e.prevHash !== prev) return { ok: false, entries: l.entries.length, brokenAt: i };
      if (hashEntry(e) !== e.hash) return { ok: false, entries: l.entries.length, brokenAt: i };
      prev = e.hash;
    }
    return { ok: true, entries: l.entries.length, brokenAt: null };
  } catch {
    return { ok: false, entries: 0, brokenAt: null };
  }
}

/** Ops-view status for /api/ai/self/status + the panel. */
export function evolutionStatus() {
  try {
    const l = load();
    const v = verifyEvolutionLedger();
    const byKind = {};
    for (const e of l.entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const last = l.entries[l.entries.length - 1] || null;
    const last24h = l.entries.filter(e => Date.now() - e.ts < 86400000).length;
    return {
      verified: v.ok,
      chainBroken: !v.ok ? v : null,
      total: l.entries.length,
      last24h,
      byKind,
      last: last ? { ts: last.ts, kind: last.kind, summary: last.summary } : null,
    };
  } catch {
    return { verified: false, chainBroken: null, total: 0, last24h: 0, byKind: {}, last: null };
  }
}

/** Last N entries (newest last) — the panel timeline. */
export function recentChanges(n = 25) {
  try {
    const l = load();
    return l.entries.slice(-Math.max(1, Math.min(200, n))).map(({ id, ts, kind, summary }) => ({ id, ts, kind, summary }));
  } catch {
    return [];
  }
}

// ---------------- tests ----------------
export function __setEvolutionLedgerForTests(l) { save(l || { entries: [] }); }
export function __evolutionRaw() { return load(); }
export const __testables = { hashEntry, bodyOf, r2 };
