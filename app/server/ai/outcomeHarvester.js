// ============================================================
// server/ai/outcomeHarvester.js — v19.0 SELF-IMPROVEMENT ENGINE
// ------------------------------------------------------------
// PHASE 1 — DATA FOUNDATION. The signal ledger (v6.7) already
// records every EXECUTED signal with its full vote map + settled
// outcome — but that fuel was never harvested into a LEARNING
// dataset. The ml-service meta-learner's store was EMPTY (infra
// existed, data never flowed). This module closes that gap:
//
//   harvestOutcomes()
//     reads ledger settled entries → appends rows to
//     selfimprove-outcomes.json (dedup by ledger entry id):
//
//     row = { id, ts, market, symbol, side, grade, confidence,
//             agreement, aiScore?, r, pnlINR, reason, exit,
//             votes: {modelId: {dir, conf}}, plan risk/reward,
//             council confidence/agreement }
//
//   datasetStats()   honest stats (n, winRate, avgR, byMarket,
//                    freshness) — "NOT ENOUGH DATA" verdicts below
//                    MIN_ROWS, exactly like adaptive.js refuses to
//                    tune on noise.
//   rowsForGateTuning() / rowsForLessons() bounded consumers.
//
// HONESTY: no synthetic rows, no fabricated cold-start data. Empty
// ledger → 0 rows + honest verdict. The dataset grows ONLY from
// real (paper or live) executed-and-settled signals.
//
// Storage: selfimprove-outcomes.json via lib/store (atomic, RO-fs
// safe). Idempotent: re-running harvest adds ONLY new settled ids.
// ============================================================
import { __ledgerRaw } from './ledger.js';
import { loadJSON, saveJSON } from '../lib/store.js';
import { recordChange } from './evolutionLedger.js';

const DATASET_FILE = 'selfimprove-outcomes.json';
export const MIN_ROWS = 40;         // below this every consumer says NOT ENOUGH DATA
export const MAX_ROWS = 2000;       // bounded memory/disk
const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

function load() {
  return loadJSON(DATASET_FILE, { rows: [], harvestedIds: [], lastHarvestAt: null, stats: null });
}
function save(d) {
  if (d.rows.length > MAX_ROWS) d.rows = d.rows.slice(-MAX_ROWS);
  return saveJSON(DATASET_FILE, d);
}

/** Ledger settled entry → one dataset row (null when not settled).
 *  v19.0.1 FIX: reads the RAW ledger (__ledgerRaw, same source trust.js
 *  uses) — recentEntries() returns a reduced projection WITHOUT
 *  agreement/votes/council/plan.riskPct, which quietly killed the whole
 *  Phase 1→2 pipeline (gate rows always empty, PSI always no-data).
 *  r != null gate: settlePositionOutcome stamps r:null when riskINR
 *  can't be computed — Number(null)===0 is FINITE, so those would
 *  otherwise become fake 0R losses (trust.js excludes them too). */
function rowOf(e) {
  const out = e?.outcome;
  if (!out || out.r == null || !Number.isFinite(Number(out.r))) return null;
  const plan = e.plan || {};
  return {
    id: e.id,
    ts: e.ts,
    market: e.market || 'CRYPTO',
    symbol: e.symbol,
    side: e.side,
    grade: e.grade || null,
    confidence: Number.isFinite(Number(e.confidence)) ? Number(e.confidence) : null,
    agreement: Number.isFinite(Number(e.agreement)) ? Number(e.agreement) : null,
    r: r2(out.r),
    pnlINR: r2(out.pnlINR),
    reason: out.reason || null,
    exit: out.exit || null,
    win: Number(out.r) > 0,
    riskPct: r2(plan.riskPct),
    rewardRisk: r2(plan.rewardRisk),
    votes: (e.votes && typeof e.votes === 'object') ? e.votes : {},
    councilConfidence: e.council ? r2(e.council.confidence) : null,
    councilAgreement: e.council ? r2(e.council.agreement) : null,
    mode: e.mode || 'paper',
  };
}

/**
 * One harvest pass — idempotent, never throws. Reads the LAST 400 RAW
 * ledger entries (chronological — push order), appends settled rows not
 * already harvested.
 * @returns {{added:number,total:number,lastTs:number|null,ok:boolean}}
 */
export function harvestOutcomes() {
  try {
    const d = load();
    const known = new Set(d.harvestedIds || []);
    let added = 0;
    let lastTs = d.rows.length ? d.rows[d.rows.length - 1].ts : null;
    const rawEntries = (__ledgerRaw()?.entries || []).slice(-400); // chronological, newest-last
    for (const e of rawEntries) {
      if (!e?.id || known.has(e.id)) continue;
      const row = rowOf(e);
      if (!row) { known.add(e.id); continue; } // settled-not-yet rows retry next pass
      d.rows.push(row);
      known.add(e.id);
      added++;
      lastTs = row.ts;
    }
    // bounded id set (rows pruned → ids pruned with them)
    const keepIds = new Set(d.rows.map(x => x.id));
    d.harvestedIds = [...known].filter(id => keepIds.has(id)).slice(-MAX_ROWS);
    d.lastHarvestAt = Date.now();
    d.stats = computeStats(d.rows);
    save(d);
    if (added > 0) {
      recordChange('harvest', `outcome dataset +${added} rows (total ${d.rows.length})`, {
        added, total: d.rows.length, winRate: d.stats?.winRate, avgR: d.stats?.avgR,
      });
    }
    return { added, total: d.rows.length, lastTs, ok: true };
  } catch {
    return { added: 0, total: 0, lastTs: null, ok: false };
  }
}

/** Honest stats over rows — the single source every consumer reads. */
export function computeStats(rows) {
  const n = rows.length;
  if (!n) return { n: 0, verdict: 'NO DATA', winRate: null, avgR: null, note: 'outcome dataset khali — settled trades aane hi self-improvement fuel banega' };
  const wins = rows.filter(x => x.win).length;
  const avgR = rows.reduce((a, x) => a + (Number(x.r) || 0), 0) / n;
  const byMarket = {};
  for (const m of ['CRYPTO', 'FUTURES', 'GLOBALFUTURES', 'INDIA']) {
    const t = rows.filter(x => x.market === m);
    if (t.length) byMarket[m] = { n: t.length, winRate: r2((t.filter(x => x.win).length / t.length) * 100), avgR: r2(t.reduce((a, x) => a + (Number(x.r) || 0), 0) / t.length) };
  }
  const newest = rows[rows.length - 1]?.ts || null;
  return {
    n,
    verdict: n < MIN_ROWS ? 'NOT ENOUGH DATA' : 'LEARNING READY',
    winRate: r2((wins / n) * 100),
    avgR: r2(avgR),
    expectancyR: r2(avgR), // rows are R-multiples → avg R IS the expectancy
    byMarket,
    newestTs: newest,
    freshnessHours: newest ? r2((Date.now() - newest) / 3600000) : null,
    note: n < MIN_ROWS ? `sirf ${n} settled rows (min ${MIN_ROWS}) — accumulating, tune/lesson engines in noise-refuse mode` : `${n} settled rows — enough fuel to learn`,
  };
}

/** Ops view (selfStatus + routes). */
export function datasetStatus() {
  try {
    const d = load();
    return {
      ...computeStats(d.rows),
      lastHarvestAt: d.lastHarvestAt,
      minRows: MIN_ROWS,
      ready: d.rows.length >= MIN_ROWS,
    };
  } catch {
    return { n: 0, verdict: 'NO DATA', ready: false };
  }
}

/** Gate-tuner input — bounded to rows carrying the gate fields. */
export function rowsForGateTuning(limit = 400) {
  try {
    return load().rows
      .filter(x => x.confidence != null && x.agreement != null)
      .slice(-Math.max(50, Math.min(MAX_ROWS, limit)));
  } catch { return []; }
}

/** Lessons input — settled rows, newest first, bounded. */
export function rowsForLessons(limit = 120) {
  try {
    return load().rows.slice(-Math.max(20, Math.min(MAX_ROWS, limit))).slice().reverse();
  } catch { return []; }
}

// ---------------- tests ----------------
export function __setDatasetForTests(d) { save(d || { rows: [], harvestedIds: [], lastHarvestAt: null, stats: null }); }
export function __datasetRaw() { return load(); }
export const __testables = { rowOf };
