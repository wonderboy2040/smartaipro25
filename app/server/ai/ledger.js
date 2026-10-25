// ============================================================
// server/ai/ledger.js — TAMPER-EVIDENT SIGNAL LEDGER (v6.7)
// ------------------------------------------------------------
// Glama-inspired (oneqaz "Trust Layer"): every EXECUTED signal is
// stamped into an append-only SHA-256 hash chain. Each entry:
//
//   hash = SHA256(prevHash + canonical JSON of the entry body)
//
// Tampering with ANY historical field breaks every hash after it —
// the track record becomes mathematically provable ("yeh signal
// us waqt aisa hi tha" is now verifiable, not a promise).
//
// Lifecycle:
//   recordExecution(signal, meta)  → called by BOTH gauntlets
//                                    (paper + live) under the same
//                                    journal lock section
//   markPartialOutcome(entryId, p)  → v7.0 PRO TRADER — every partial
//                                    take-profit leg is stamped onto
//                                    its execution entry (qty/price/
//                                    pnl/stage) BEFORE the final close
//   markOutcome(entryId, outcome)  → called when the position CLOSES
//                                    ({ r, pnlINR, reason, exit })
//   modelStats()                   → per-model win/loss attribution
//                                    from recorded votes × outcomes —
//                                    feeds adaptiveWeights.js
//   verifyLedger()                 → walk the chain, recompute hashes
//
// Storage: ai-signal-ledger.json (store + durablePut, like the
// journal). Pruned to the last 1200 entries (hash chain survives
// pruning: the head's prevHash simply references the new oldest).
// v21.11.0 (Superintelligence accuracy upgrade): 400 → 1200. Adaptive
// weights (MIN_SAMPLE 8), trust.js calibration aur gateTuner sab isi
// ledger se seekhte hain — 400 entries ka rolling window ek active
// futures desk pe ~2 hafte me purge ho jata tha, isliye learned
// multipliers baar-baar reset hote the. 1200 = tracked-signals.json
// ke 1200-row window ke saath aligned, file ab bhi <1MB.
// ============================================================
import crypto from 'node:crypto';
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';
import { normalizeSide } from './directionCertificate.js'; // v21.25.0: strict side

const LEDGER_FILE = 'ai-signal-ledger.json';
// v21.11.0: 400 → 1200 — 3× learning window (see header). Env-tunable.
const MAX_ENTRIES = (() => {
  const n = Number.parseInt(String(process.env.AI_LEDGER_MAX_ENTRIES ?? ''), 10);
  return Number.isFinite(n) && n >= 100 ? Math.min(5000, n) : 1200;
})();

// v21.12.0: committee info banner/panel isko surface karta hai (ops ko
// dikhna chahiye learning window kitna bada hai).
export function ledgerWindowEntries() { return MAX_ENTRIES; }

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Canonical body — everything EXCEPT id/prevHash/hash/outcome/
 *  partials (v7.0: the partial legs mutate in place exactly like the
 *  outcome does, without breaking the chain links after them). */
function bodyOf(e) {
  const { id: _id, prevHash: _prevHash, hash: _hash, outcome: _outcome, partials: _partials, ...body } = e || {};
  return body;
}
function hashEntry(e) {
  return sha256(JSON.stringify({
    prev: e?.prevHash || null,
    body: bodyOf(e),
  }));
}

function load() {
  return loadJSON(LEDGER_FILE, { entries: [] });
}
/**
 * v21.1.1 [audit A4]: boot-restore hook — durable.js ledger restore ke baad
 * call karta hai. Ledger har read pe disk se load() karta hai (module cache
 * nahi), isliye ye hook sirf ek warm-read + chain-verify hai: restore hui
 * chain corrupt ho to boot pe hi dikh jaye (silent wrong stats nahi).
 */
export function __reloadLedgerForBoot() {
  try {
    const l = load();
    if (Array.isArray(l?.entries) && l.entries.length > 0) {
       
      console.log(`[ledger] boot-restore: ${l.entries.length} entries hydrated (durable)`);
    }
    return true;
  } catch { /* best-effort */ }
  return false;
}
function save(l) {
  if (l.entries.length > MAX_ENTRIES) {
    l.entries = l.entries.slice(-MAX_ENTRIES);
    // v7.0.2 FIX: re-anchor the pruned chain as a fresh checkpoint — the
    // new head gets prevHash null and every later link is recomputed. The
    // old code left the head's prevHash dangling on the pruned entry, so
    // verifyLedger() reported brokenAt:0 FOREVER after the first prune
    // past 400 entries (false alarm on the tamper evidence). Tampering
    // detection itself is unchanged: a spliced entry WITHOUT re-anchoring
    // still fails the strict head check.
    if (l.entries.length > 0) {
      let prev = null;
      for (const e of l.entries) {
        e.prevHash = prev;
        e.hash = hashEntry(e);
        prev = e.hash;
      }
    }
  }
  saveJSON(LEDGER_FILE, l);
  try { durablePut(LEDGER_FILE, l); } catch { /* best-effort */ }
  return l;
}

// ---------------- record ----------------
/**
 * Stamp an executed signal into the chain.
 * @param {*} signal  the full ensemble signal (needs symbol/market/
 *                    side/grade/confidence/agreement/plan/votes)
 * @param {{mode, source, market?}} meta execution metadata
 * @returns the recorded entry (with hash) or null on unusable input
 */
export function recordExecution(signal, meta = {}) {
  if (!signal || !signal.symbol || !signal.side) return null;
  const l = load();
  const prevHash = l.entries.length ? l.entries[l.entries.length - 1].hash : null;
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    market: signal.market || meta.market || 'CRYPTO',
    symbol: signal.symbol,
    side: signal.side,
    grade: signal.grade || null,
    confidence: signal.confidence ?? null,
    agreement: signal.agreement ?? null,
    mode: meta.mode || 'paper',
    source: meta.source || 'manual',
    // v20.2: relaxed = practice entry against a flipped/sub-floor fresh
    // consensus (synthNote/floorNote in coindcxOrders). Stamped so the
    // trust/calibration corpus can exclude entries the ENGINE never
    // endorsed — practice fills must not calibrate claimed-vs-actual.
    ...(meta.relaxed ? { relaxed: true } : {}),
    plan: signal.plan ? {
      entry: signal.plan.entry, stopLoss: signal.plan.stopLoss,
      target1: signal.plan.target1, target2: signal.plan.target2,
      riskPct: signal.plan.riskPct, rewardRisk: signal.plan.rewardRisk,
    } : null,
    // per-model dir map (the attribution input for modelStats)
    // accuracy-plan Phase 2.1: a vote carrying __abShadow (the MTF
    // seat's plain-15m A/B arm) journals BOTH — settled outcomes then
    // attribute each arm separately and trust.js mtfABReport() can
    // say whether the MTF confidence layer is genuinely sharper.
    votes: Object.fromEntries((signal.votes || [])
      .filter(v => v && v.id)
      .flatMap(v => {
        const rows = [[v.id, { dir: v.dir || 0, conf: v.conf || 0 }]];
        const ab = v.__abShadow;
        if (ab && ab.id && Number(ab.dir) !== 0) {
          rows.push([ab.id, { dir: Number(ab.dir), conf: Number(ab.conf) || 0, shadow: true }]);
        }
        return rows;
      })),
    // v11.0: the Global Market Council stamp — per-AGENT attribution
    // rides the SAME tamper-evident chain (trust.js councilAgentStats
    // reads exactly this shape). Abstaining seats are absent keys.
    ...(signal.council && Array.isArray(signal.council.agents) ? {
      council: {
        confidence: signal.council.confidence ?? null,
        agreement: signal.council.agreement ?? null,
        gate: signal.council.gate ?? null,
        agents: Object.fromEntries(signal.council.agents
          .filter(a => a && a.role)
          .map(a => [a.role, {
            dir: a.direction === 'LONG' ? 1 : a.direction === 'SHORT' ? -1 : 0,
            conf: a.confidence ?? 0,
          }])),
      },
    } : {}),
    summary: signal.summary || null,
    outcome: null,
    prevHash,
  };
  entry.hash = hashEntry(entry);
  l.entries.push(entry);
  save(l);
  return entry;
}

// ---------------- v7.0 partial take-profit legs ----------------
/**
 * Stamp a PARTIAL_TP leg onto the execution entry (append-only array
 * on the entry — the hash body deliberately excludes `partials`, the
 * same honesty model `outcome` uses: history links never break, but
 * the legs are persisted and reviewable). Multiple legs per position
 * are the NORM for the pro trader (T1 40% → T2 40% → runner).
 * @param {string} entryId  the ledgerEntryId on the position
 * @param {{stage: string, qty: number, price: number, pnlINR: number}} leg
 * @returns {boolean} true when the leg was stamped
 */
export function markPartialOutcome(entryId, leg) {
  try {
    if (!entryId || !leg) return false;
    const l = load();
    const e = l.entries.find(x => x.id === entryId);
    if (!e) return false;
    if (!Array.isArray(e.partials)) e.partials = [];
    e.partials.push({
      ts: Date.now(),
      stage: String(leg.stage || 'T1'),
      qty: Number.isFinite(Number(leg.qty)) ? Number(leg.qty) : null,
      price: Number.isFinite(Number(leg.price)) ? Number(leg.price) : null,
      pnlINR: Number.isFinite(Number(leg.pnlINR)) ? Math.round(Number(leg.pnlINR) * 100) / 100 : null,
    });
    // same in-place re-assign pattern as markOutcome — body excludes
    // partials, so the chain links before/after stay verifiable
    e.hash = hashEntry(e);
    save(l);
    return true;
  } catch { return false; }
}

// ---------------- outcome ----------------
/**
 * Link a close to its ledger entry. Idempotent (first close wins —
 * a re-close overwrites NOTHING, which is exactly what tamper-
 * evidence means for outcomes too).
 * @returns true when the outcome was stamped
 */
export function markOutcome(entryId, outcome) {
  if (!entryId || !outcome) return false;
  const l = load();
  const e = l.entries.find(x => x.id === entryId);
  if (!e || e.outcome) return false;
  e.outcome = {
    ts: Date.now(),
    r: Number.isFinite(Number(outcome.r)) ? Math.round(Number(outcome.r) * 100) / 100 : null,
    pnlINR: Number.isFinite(Number(outcome.pnlINR)) ? Math.round(Number(outcome.pnlINR) * 100) / 100 : null,
    reason: outcome.reason || null,
    exit: outcome.exit ?? null,
  };
  // the hash covers the FULL entry (outcome included) — so the close
  // is part of the tamper-evidence too
  e.hash = hashEntry(e);
  save(l);
  return true;
}

// ---------------- verification ----------------
/**
 * Walk the chain front-to-back recomputing every hash.
 * @returns {{ok, entries, brokenAt: number|null, headHash}}
 */
export function verifyLedger() {
  const l = load();
  let prev = null;
  for (let i = 0; i < l.entries.length; i++) {
    const e = l.entries[i];
    if ((e.prevHash || null) !== prev) return { ok: false, entries: l.entries.length, brokenAt: i, headHash: null };
    if (hashEntry(e) !== e.hash) return { ok: false, entries: l.entries.length, brokenAt: i, headHash: null };
    prev = e.hash;
  }
  return { ok: true, entries: l.entries.length, brokenAt: null, headHash: prev };
}

export function ledgerStatus() {
  const l = load();
  const withOutcome = l.entries.filter(e => e.outcome);
  const wins = withOutcome.filter(e => (e.outcome.r ?? 0) > 0).length;
  const losses = withOutcome.filter(e => (e.outcome.r ?? 0) <= 0).length;
  const v = verifyLedger();
  return {
    ok: true,
    entries: l.entries.length,
    settled: withOutcome.length,
    open: l.entries.length - withOutcome.length,
    wins, losses,
    winRate: withOutcome.length > 0 ? Math.round((wins / withOutcome.length) * 1000) / 10 : null,
    headHash: v.headHash ? v.headHash.slice(0, 16) : null,
    verified: v.ok,
    brokenAt: v.brokenAt,
  };
}

export function recentEntries(n = 20) {
  const l = load();
  return l.entries.slice(-Math.min(Math.max(n, 1), 100)).reverse().map(e => ({
    id: e.id, ts: e.ts, market: e.market, symbol: e.symbol, side: e.side,
    grade: e.grade, confidence: e.confidence, mode: e.mode,
    plan: e.plan ? { entry: e.plan.entry, stopLoss: e.plan.stopLoss, target2: e.plan.target2 } : null,
    outcome: e.outcome, hash: String(e.hash || '').slice(0, 16), prevHash: e.prevHash ? String(e.prevHash).slice(0, 16) : null,
  }));
}

// ---------------- per-model attribution ----------------
/**
 * For every SETTLED entry: a model whose recorded dir matched the
 * trade side gets win/loss credit from the outcome (r > 0 = win).
 * Opposite-dir models get the mirror credit. dir=0 abstains.
 * Feeds adaptiveWeights.js (Bayesian multipliers).
 */
export function modelStats() {
  const l = load();
  const stats = {};
  for (const e of l.entries) {
    if (!e.outcome || !e.votes) continue;
    // v21.25.0 [NO SILENT LONG]: unknown trade side = skip attribution
    // (pehle `e.side !== 'SHORT'` har garbage ko LONG maan leta tha).
    const tradeSide = normalizeSide(e.side);
    if (!tradeSide) continue;
    const win = (e.outcome.r ?? 0) > 0;
    for (const [modelId, v] of Object.entries(e.votes)) {
      if (!v || v.dir === 0) continue;
      stats[modelId] = stats[modelId] || { model: modelId, aligned: 0, wins: 0, losses: 0 };
      const s = stats[modelId];
      const alignedWithSide = (v.dir > 0) === (tradeSide === 'LONG');
      s.aligned++;
      // credit: model said what the trade did AND trade won → win;
      // model opposed the trade and it lost → also a win (it was right);
      // model aligned but trade lost → loss; opposed but trade won → loss.
      const calledItRight = alignedWithSide === win;
      if (calledItRight) s.wins++; else s.losses++;
    }
  }
  for (const s of Object.values(stats)) {
    s.n = s.wins + s.losses;
    s.hitRate = s.n > 0 ? Math.round((s.wins / s.n) * 1000) / 10 : null;
  }
  return Object.values(stats).sort((a, b) => b.n - a.n);
}

// ---------------- close hookup (both desks) ----------------
/**
 * Position-close bridge: computes R (pnl / initial-risk-in-₹) and
 * stamps the outcome onto the entry that recorded the execution.
 * Call from EVERY close path (watcher SL/TP, liquidation, manual,
 * square-off). Idempotent + never throws.
 */
export function settlePositionOutcome(p, reason) {
  try {
    if (!p?.ledgerEntryId || p.status !== 'CLOSED') return false;
    // v7.0: partial closes reduce p.qty long before the final close —
    // the honest R denominator is the risk taken at ENTRY (original
    // qty × initial per-unit risk), and the honest numerator is the
    // TOTAL P&L (booked partial legs + the final leg).
    const qtyAtEntry = Number(p.originalQty) > 0 ? Number(p.originalQty) : (Number(p.qty) || 0);
    const riskPerUnit = Number(p.initialRisk) || 0;
    // v7.0.2 FIX: FUTURES positions store initialRisk in the USDT domain
    // but totalPnlINR is ₹ — dividing ₹ by USDT understated every futures
    // R by ~84x (a +1R win logged as +0.012R). Recover the entry-time FX
    // from the position's own notionalINR/notionalUSDT twin (exact).
    const fx = Number(p.notionalUSDT) > 0 && Number(p.notionalINR) > 0
      ? Number(p.notionalINR) / Number(p.notionalUSDT) : 1;
    const riskINR = riskPerUnit > 0 && qtyAtEntry > 0 ? riskPerUnit * qtyAtEntry * fx : null;
    const totalPnlINR = (Number(p.pnlINR) || 0) + (Number(p.bookedPnlINR) || 0);
    const r = riskINR > 0 ? totalPnlINR / riskINR : null;
    return markOutcome(p.ledgerEntryId, {
      r, pnlINR: r2(totalPnlINR), reason: reason || p.closeReason || null, exit: p.closePrice ?? null,
    });
  } catch { return false; }
}

// ---------------- test hooks ----------------
export function __setLedgerForTests(l) { save(l || { entries: [] }); }
export function __ledgerRaw() { return load(); }
