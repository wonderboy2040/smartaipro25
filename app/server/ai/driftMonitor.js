// ============================================================
// server/ai/driftMonitor.js — v19.0 SELF-IMPROVEMENT ENGINE
// ------------------------------------------------------------
// PHASE 1 — DRIFT MONITOR. A self-improving AI must first NOTICE
// that it is degrading before it can fix itself. Three honest
// instruments (all computed, zero LLM cost):
//
//   1. VOTE DRIFT — PSI (Population Stability Index) per model:
//      vote-direction distribution over the OLDER half of the
//      outcome dataset vs the NEWER half. PSI > 0.25 = major shift
//      (industry-standard buckets: <0.1 stable, 0.1–0.25 moderate,
//      >0.25 alarm). A model whose voting pattern drifted is the
//      earliest degradation signal available.
//   2. CALIBRATION DRIFT — from trust.js: claimed confidence vs
//      realized win-rate + Brier score. Overconfidence gap ≥ 15
//      points or Brier > 0.30 = drifting.
//   3. PERFORMANCE DRIFT — trust.js modelPerformanceWindows:
//      30-day vs 90-day win-rate; a model losing ≥ 12 points of
//      hit-rate = drifting.
//
// Verdict ladder (honest, never dramatic):
//   STABLE / DRIFTING / ALARM — plus per-model PSI table.
//
// Alarm path: recordChange('drift-alarm') lands on the evolution
// ledger + the retrain bridge CONSUMES the verdict (Phase 2 wiring
// decides whether a retrain actually fires — never automatic
// without SELFIMPROVE_AUTO_RETRAIN).
//
// Pure compute. No timers. Consumers: selfStatus, routes, index
// scheduler (1h), retrainBridge.
// ============================================================
import { rowsForGateTuning } from './outcomeHarvester.js';
import { trustReport, modelPerformanceWindows } from './trust.js';
import { recordChange } from './evolutionLedger.js';

const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

// ---------------- PSI core ----------------
/** PSI between two discrete distributions over the same buckets.
 * Buckets: {-1, 0, +1} vote dirs (+ tiny epsilon — PSI is
 * undefined on zero expected mass). PURE. */
export function psi(expected, actual) {
  const EPS = 1e-4;
  let psi = 0;
  for (let i = 0; i < 3; i++) {
    const e = Math.max(EPS, expected[i] || 0);
    const a = Math.max(EPS, actual[i] || 0);
    psi += (a - e) * Math.log(a / e);
  }
  return psi;
}

function voteBuckets(rows) {
  // returns Map modelId → [short, flat, long] counts
  const m = new Map();
  for (const row of rows) {
    const votes = row.votes || {};
    for (const [id, v] of Object.entries(votes)) {
      if (!m.has(id)) m.set(id, [0, 0, 0]);
      const dir = Number(v?.dir) || 0;
      const idx = dir < 0 ? 0 : dir > 0 ? 2 : 1;
      m.get(id)[idx]++;
    }
  }
  return m;
}

/** Per-model PSI old-half vs new-half of the dataset. PURE. */
export function voteDrift(rows) {
  const usable = rows.filter(x => x.votes && Object.keys(x.votes).length);
  if (usable.length < 24) {
    return { ok: false, n: usable.length, minRows: 24, models: {}, verdict: 'NOT ENOUGH DATA', note: `sirf ${usable.length} vote-carrying rows — PSI refuse-on-noise (min 24)` };
  }
  const half = Math.floor(usable.length / 2);
  const oldB = voteBuckets(usable.slice(0, half));
  const newB = voteBuckets(usable.slice(half));
  const models = {};
  let worst = null;
  for (const [id, newCounts] of newB) {
    const oldCounts = oldB.get(id);
    if (!oldCounts) continue; // model born recently — no baseline
    const oldTotal = oldCounts.reduce((a, b) => a + b, 0);
    const newTotal = newCounts.reduce((a, b) => a + b, 0);
    if (oldTotal < 8 || newTotal < 8) continue; // per-model sample floor
    const exp = oldCounts.map(x => x / oldTotal);
    const act = newCounts.map(x => x / newTotal);
    const p = psi(exp, act);
    models[id] = { psi: r2(p), oldN: oldTotal, newN: newTotal, drift: p > 0.25 ? 'ALARM' : p > 0.1 ? 'MODERATE' : 'STABLE' };
    if (!worst || p > worst.psi) worst = models[id];
  }
  const names = Object.keys(models);
  if (!names.length) {
    return { ok: false, n: usable.length, models: {}, verdict: 'NOT ENOUGH DATA', note: 'no model has ≥8 votes in both halves' };
  }
  const alarmCount = names.filter(k => models[k].drift === 'ALARM').length;
  return {
    ok: true,
    n: usable.length,
    models,
    worst: worst ? { psi: worst.psi } : null,
    alarmCount,
    verdict: alarmCount > 0 ? 'ALARM' : names.some(k => models[k].drift === 'MODERATE') ? 'DRIFTING' : 'STABLE',
  };
}

// ---------------- calibration + performance drift ----------------
function calibrationDrift() {
  try {
    const t = trustReport();
    // trustReport shape: {calibration:[{bucket,claimed,n,winRate,gap}], brier, ...}
    // — defensive: fields absent (young ledger) → NOT ENOUGH DATA
    const buckets = (Array.isArray(t?.calibration) ? t.calibration : []).filter(b => (b.n || 0) >= 10);
    if (!buckets.length || !Number.isFinite(Number(t?.brier))) {
      return { ok: false, verdict: 'NOT ENOUGH DATA', note: 'trust.js calibration abhi settle ho rahi hai' };
    }
    let worstGap = 0;
    let worstBucket = null;
    for (const b of buckets) {
      const gap = Math.abs(Number(b.gap ?? (Number(b.winRate) - Number(b.claimed))) || 0);
      if (gap > worstGap) { worstGap = gap; worstBucket = b.bucket; }
    }
    const brier = Number(t.brier);
    const over = worstGap >= 15 || brier > 0.30;
    return {
      ok: true,
      brier: r2(brier),
      brierVerdict: t.brierVerdict || null,
      worstGapPoints: r2(worstGap),
      worstBucket,
      buckets: buckets.length,
      verdict: over ? 'ALARM' : worstGap >= 8 || brier > 0.25 ? 'DRIFTING' : 'STABLE',
      note: over
        ? `claimed-vs-realized gap ${Math.round(worstGap)}pts (worst bucket ${worstBucket}) / Brier ${r2(brier)} — confidence claims drift ho gayi hain`
        : `calibration healthy (worst gap ${Math.round(worstGap)}pts, Brier ${r2(brier)})`,
    };
  } catch {
    return { ok: false, verdict: 'NOT ENOUGH DATA', note: 'trust report unavailable' };
  }
}

function performanceDrift() {
  try {
    // modelPerformanceWindows shape: {d30:[{model,n,hitRate}], d90:[...]} — arrays keyed d{days}
    const w = modelPerformanceWindows({ windows: [30, 90] });
    const m30 = new Map((w?.d30 || []).map(x => [x.model, x]));
    const m90 = new Map((w?.d90 || []).map(x => [x.model, x]));
    const out = {};
    let anyDrop = 0;
    for (const [id, s90] of m90) {
      const s30 = m30.get(id);
      if (!s30 || (s90.n || 0) < 15 || (s30.n || 0) < 5) continue;
      const h30 = Number(s30.hitRate);
      const h90 = Number(s90.hitRate);
      if (!Number.isFinite(h30) || !Number.isFinite(h90)) continue;
      const drop = h90 - h30; // negative = recent window worse
      out[id] = { hitRate30: r2(h30), hitRate90: r2(h90), dropPoints: r2(drop), drift: drop <= -12 ? 'ALARM' : drop <= -6 ? 'DRIFTING' : 'STABLE' };
      if (drop <= -12) anyDrop++;
    }
    if (!Object.keys(out).length) return { ok: false, verdict: 'NOT ENOUGH DATA', note: 'model windows abhi build ho rahe hain (90d n<15 ya 30d n<5)' };
    return { ok: true, models: out, alarmCount: anyDrop, verdict: anyDrop > 0 ? 'ALARM' : Object.values(out).some(x => x.drift === 'DRIFTING') ? 'DRIFTING' : 'STABLE' };
  } catch {
    return { ok: false, verdict: 'NOT ENOUGH DATA', note: 'performance windows unavailable' };
  }
}

// ---------------- the monitor ----------------
/** One full drift pass. PURE-ish (reads stores; records a ledger
 * change ONLY on a new ALARM verdict, throttled 6h). */
export function driftReport({ now = Date.now() } = {}) {
  const vote = voteDrift(rowsForGateTuning());
  const cal = calibrationDrift();
  const perf = performanceDrift();
  const verdicts = [vote.verdict, cal.verdict, perf.verdict];
  const verdict = verdicts.includes('ALARM') ? 'ALARM' : verdicts.includes('DRIFTING') ? 'DRIFTING' : 'STABLE';
  return {
    ts: now,
    verdict,
    voteDrift: vote,
    calibrationDrift: cal,
    performanceDrift: perf,
    summary: verdict === 'STABLE'
      ? 'sab instruments stable — model behavior, calibration aur performance drift nahi'
      : verdict === 'DRIFTING'
        ? 'moderate drift detect hua — watch mode, retrain proposal eligible'
        : 'ALARM: significant drift — retrain proposal strongly justified',
  };
}

let _lastAlarmAt = 0;
/** Scheduler entry — alarm → evolution ledger (6h throttle) + verdict
 * for the retrain bridge. NEVER throws. */
export function runDriftCheck() {
  try {
    const r = driftReport();
    if (r.verdict === 'ALARM' && Date.now() - _lastAlarmAt > 6 * 3600000) {
      _lastAlarmAt = Date.now();
      recordChange('drift-alarm', `DRIFT ALARM — vote:${r.voteDrift.verdict} cal:${r.calibrationDrift.verdict} perf:${r.performanceDrift.verdict}`, {
        vote: r.voteDrift.verdict, calibration: r.calibrationDrift.verdict, performance: r.performanceDrift.verdict,
        alarmModels: r.voteDrift.alarmCount || 0,
      });
    }
    return r;
  } catch {
    return { verdict: 'UNKNOWN', summary: 'drift check failed — honest unknown' };
  }
}

// ---------------- tests ----------------
export const __testables = { voteBuckets, _lastAlarmAtRef: () => _lastAlarmAt, _setLastAlarmAt: (v) => { _lastAlarmAt = v; } };
