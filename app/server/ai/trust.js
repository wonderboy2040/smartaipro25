// ============================================================
// server/ai/trust.js — TRUST LAYER v2 (v6.11)
// ------------------------------------------------------------
// Glama-inspired (oneqaz-trading-mcp "Trust Layer"): the ledger
// already proves the track record is untampered (SHA-256 chain,
// v6.7). This module answers the NEXT question — "kitna bharosa
// kare us numbers par?" — with three honest instruments:
//
//   1. CALIBRATION — bucket the settled signals by the confidence
//      the engine CLAIMED (40-50, 50-60, … 80+) and compare with
//      the win-rate that actually happened. A 70% claim that wins
//      68% of the time = well calibrated. 70% claim winning 45%
//      = overconfident → the UI shows it.
//   2. BRIER SCORE — mean squared error between claimed
//      confidence and binary outcome. 0 = perfect, 0.25 = coin.
//      Computed on R>0 wins (direction-only honesty).
//   3. MONTHLY TREND — last 6 calendar months of settled signals:
//      n, win rate, avg R. Accuracy drifting DOWN is a red flag
//      the desk should see before it costs money.
//   4. GOVERNANCE (p-values) — per-model: is this model's vote
//      hit-rate distinguishable from the desk's base rate, or is
//      it noise? One-sided binomial survival function with a
//      normal approximation (honest: labeled approximation).
//      verdicts: SIGNIFICANT / NEEDS DATA / NOISE.
//
// Everything refuses to lie: < 10 settled entries → "insufficient
// data" fields, no invented percentages. Read-only — it never
// writes to the ledger.
// ============================================================
import { __ledgerRaw, modelStats } from './ledger.js';
import { MODELS } from './models.js'; // names only — no cycle (models never imports trust)

const MONTHS_BACK = 6;
const MIN_SETTLED = 10;
const BUCKETS = [
  { label: '40-55%', lo: 40, hi: 55 },
  { label: '55-65%', lo: 55, hi: 65 },
  { label: '65-75%', lo: 65, hi: 75 },
  { label: '75-85%', lo: 75, hi: 85 },
  { label: '85%+', lo: 85, hi: 101 },
];

// ---------------- normal CDF (governance p-values) ----------------
/** Abramowitz & Stegun 7.1.26 approximation — plenty for a verdict label. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

/** One-sided binomial p-value: P(X >= wins | n, base) via normal approx. */
function binomPValueAtLeast(wins, n, baseRate) {
  if (!(n > 0) || !(baseRate > 0) || !(baseRate < 1)) return 1;
  const mean = n * baseRate;
  const sd = Math.sqrt(n * baseRate * (1 - baseRate));
  if (sd <= 0) return 1;
  // +0.5 continuity correction
  const z = (wins - 0.5 - mean) / sd;
  return Math.max(0, Math.min(1, 1 - normalCdf(z)));
}

// ---------------- calibration + Brier + monthly ----------------
function settledEntries() {
  const raw = __ledgerRaw();
  // v20.2 CALIBRATION CORPUS HYGIENE: `relaxed: true` entries are practice
  // fills the ENGINE never endorsed (paper entry against a flipped or
  // sub-floor fresh consensus — synthNote/floorNote in coindcxOrders).
  // Their outcomes measure nothing about confidence honesty, so they are
  // excluded from the whole trust report (calibration buckets, Brier,
  // monthly trend). modelStats() attribution keeps everything — votes
  // are still real signal-level data.
  return (raw?.entries || []).filter(e => e?.outcome && e.outcome.r != null && !e?.relaxed);
}

export function trustReport() {
  const settled = settledEntries();
  const base = {
    ok: true,
    settled: settled.length,
    asOf: Date.now(),
  };
  if (settled.length < MIN_SETTLED) {
    return {
      ...base,
      sufficient: false,
      note: `Insufficient data — ${settled.length}/${MIN_SETTLED} settled signals. Track record gather hone do; tab hi calibration meaningful hai (chhoti sample par percentage dhokha de sakti hai).`,
      calibration: [], brier: null, brierVerdict: null, monthly: [],
    };
  }

  // --- calibration buckets ---
  const calibration = BUCKETS.map(b => {
    const rows = settled.filter(e => {
      const c = Number(e.confidence);
      return Number.isFinite(c) && c >= b.lo && c < b.hi;
    });
    const n = rows.length;
    const wins = rows.filter(e => (e.outcome.r ?? 0) > 0).length;
    return {
      bucket: b.label,
      claimed: (b.lo + Math.min(b.hi, 100)) / 2, // bucket midpoint as the claim
      n,
      winRate: n > 0 ? Math.round((wins / n) * 1000) / 10 : null,
      gap: n > 0 ? Math.round((((wins / n) * 100) - (b.lo + Math.min(b.hi, 100)) / 2) * 10) / 10 : null,
    };
  }).filter(b => b.n > 0);

  // --- Brier score (direction-only: win = 1, loss = 0) ---
  let brierSum = 0;
  for (const e of settled) {
    const p = Math.min(1, Math.max(0, (Number(e.confidence) || 50) / 100));
    const y = (e.outcome.r ?? 0) > 0 ? 1 : 0;
    brierSum += (p - y) ** 2;
  }
  const brier = Math.round((brierSum / settled.length) * 10000) / 10000;
  const brierVerdict = brier <= 0.15 ? 'sharp — confidence ko meaningfully trust kar sakte ho'
    : brier <= 0.20 ? 'theek — mild over/under-confidence'
    : brier <= 0.25 ? 'weak — confidence aur outcome ka gap bada hai'
    : 'coin-flip se bhi worse — confidence labels par bharosa mat karo';

  // --- monthly accuracy trend (IST month keys) ---
  const istMonthKey = (ts) => {
    const ist = new Date(ts + (330 + new Date(ts).getTimezoneOffset()) * 60000);
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}`;
  };
  const byMonth = new Map();
  for (const e of settled) {
    const k = istMonthKey(e.outcome.ts || e.ts);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(e);
  }
  const monthly = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-MONTHS_BACK)
    .map(([month, rows]) => {
      const wins = rows.filter(e => (e.outcome.r ?? 0) > 0).length;
      const avgR = rows.reduce((s, e) => s + (e.outcome.r ?? 0), 0) / rows.length;
      return {
        month,
        n: rows.length,
        winRate: Math.round((wins / rows.length) * 1000) / 10,
        avgR: Math.round(avgR * 100) / 100,
      };
    });
  // drift: last month vs the average of the prior months (needs both sides)
  let drift = null;
  if (monthly.length >= 2) {
    const last = monthly[monthly.length - 1];
    const prior = monthly.slice(0, -1);
    const priorWR = prior.reduce((s, m) => s + m.winRate * m.n, 0) / prior.reduce((s, m) => s + m.n, 0);
    drift = Math.round((last.winRate - priorWR) * 10) / 10;
  }

  // v10.15 (deep-recheck #2 S3): the DIRECTION split — settled entries
  // carry `side`; "kya SHORT side systematically galat hai?" becomes a
  // standing dashboard number instead of a code re-audit every time.
  const dirSplit = (rows) => {
    if (!rows.length) return { n: 0, winRate: null, avgR: null };
    const wins = rows.filter(e => (e.outcome.r ?? 0) > 0).length;
    const avgR = rows.reduce((s, e) => s + (e.outcome.r ?? 0), 0) / rows.length;
    return {
      n: rows.length,
      winRate: Math.round((wins / rows.length) * 1000) / 10,
      avgR: Math.round(avgR * 100) / 100,
    };
  };
  const direction = {
    LONG: dirSplit(settled.filter(e => /^(L|B)/i.test(String(e.side || '')))),
    SHORT: dirSplit(settled.filter(e => String(e.side || '').toUpperCase() === 'SHORT' || /^S/i.test(String(e.side || '')))),
  };

  return {
    ...base,
    sufficient: true,
    overall: {
      winRate: Math.round((settled.filter(e => (e.outcome.r ?? 0) > 0).length / settled.length) * 1000) / 10,
      avgConfidence: Math.round((settled.reduce((s, e) => s + (Number(e.confidence) || 0), 0) / settled.length) * 10) / 10,
    },
    calibration,
    brier,
    brierVerdict,
    monthly,
    drift,
    direction,
    note: 'Calibration = claimed confidence vs realized win-rate. Brier = 0 perfect, 0.25 coin. Monthly = direction-only (R>0). Direction = LONG vs SHORT settled split. Read-only.',
  };
}

// ---------------- governance (per-model p-values) ----------------
export function governance() {
  const settled = settledEntries();
  const baseRate = settled.length > 0
    ? settled.filter(e => (e.outcome.r ?? 0) > 0).length / settled.length
    : 0.5;
  const models = modelStats().map(m => {
    const p = binomPValueAtLeast(m.wins, m.n, baseRate);
    let verdict = 'NEEDS DATA';
    if (m.n >= MIN_SETTLED) verdict = p < 0.05 ? 'SIGNIFICANT' : p < 0.20 ? 'BORDERLINE' : 'NOISE';
    return {
      model: m.model,
      n: m.n,
      hitRate: m.hitRate,
      baseRate: Math.round(baseRate * 1000) / 10,
      pValue: Math.round(p * 1000) / 1000,
      verdict,
      edge: m.hitRate != null ? Math.round((m.hitRate - baseRate * 100) * 10) / 10 : null,
    };
  });
  return {
    ok: true,
    settled: settled.length,
    baseRate: Math.round(baseRate * 1000) / 10,
    method: 'one-sided binomial survival (normal approx, +0.5 continuity) — labelled approximation, verdict-grade only',
    minN: MIN_SETTLED,
    models: models.sort((a, b) => (a.pValue ?? 1) - (b.pValue ?? 1)),
    note: 'p < 0.05 = model ka edge base-rate se alag lagta hai (upward). NEEDS DATA = sample chhota hai — koi conclusion nahi. NOISE = edge base-rate se distinguishable nahi.',
  };
}

// ---------------- accuracy-plan Phase 2.1: the MTF A/B verdict ----------------
/**
 * IntradayTapeMTF (w1.6, 5m/15m/1h confluence) vs the plain 15m tape
 * (w1.3) — measured on the SAME settled executions. Both arms share the
 * vote DIRECTION (the 15m anchor carries it), so hit-rate is identical
 * BY DESIGN; the honest A/B metric is CONFIDENCE QUALITY on the votes
 * that aligned with the taken trade:
 *   · separation = avg conf on wins − avg conf on losses (higher = the
 *     conf number actually separates winners from losers)
 *   · brier = mean (conf/100 − win)^2 over aligned votes (lower = sharper)
 * The ledger journals both arms since Phase 2.1 (ledger 'ab_tape15m'
 * shadow key, stamped by models.js only when the MTF payload ran —
 * degraded fallbacks ARE the plain seat, no double-count).
 * @returns the A/B report block for /api/ai/trust + weekly review.
 */
export function mtfABReport() {
  const settled = settledEntries();
  const MTF_KEY = 'tape-mtf';
  const AB_KEY = 'ab_tape15m';
  const armOf = (key) => {
    // aligned rows: the arm's dir matched the trade actually taken
    const rows = settled.filter(e => {
      const v = e.votes?.[key];
      return v && Number(v.dir) !== 0 && (Number(v.dir) > 0) === (e.side !== 'SHORT');
    });
    const wins = rows.filter(e => (e.outcome.r ?? 0) > 0);
    const losses = rows.filter(e => (e.outcome.r ?? 0) <= 0);
    const confs = (list) => list.map(e => Number(e.votes[key].conf)).filter(Number.isFinite);
    const avg = (a) => a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null;
    const confW = avg(confs(wins));
    const confL = avg(confs(losses));
    const brierRows = rows.map(e => {
      const p = Math.min(1, Math.max(0, (Number(e.votes[key].conf) || 50) / 100));
      const y = (e.outcome.r ?? 0) > 0 ? 1 : 0;
      return (p - y) ** 2;
    });
    return {
      n: rows.length,
      wins: wins.length,
      hitRate: rows.length ? Math.round((wins.length / rows.length) * 1000) / 10 : null,
      avgConfWins: confW,
      avgConfLosses: confL,
      separation: confW != null && confL != null ? Math.round((confW - confL) * 10) / 10 : null,
      brier: brierRows.length ? Math.round((brierRows.reduce((s, x) => s + x, 0) / brierRows.length) * 10000) / 10000 : null,
    };
  };
  const mtf = armOf(MTF_KEY);
  const plain = armOf(AB_KEY);
  const pairs = Math.min(mtf.n, plain.n); // settled entries carrying BOTH arms
  let verdict = 'NEEDS DATA';
  let delta = null;
  if (pairs >= MIN_SETTLED && mtf.brier != null && plain.brier != null) {
    delta = Math.round((plain.brier - mtf.brier) * 10000) / 10000; // >0 → MTF sharper
    const sepDelta = mtf.separation != null && plain.separation != null
      ? Math.round((mtf.separation - plain.separation) * 10) / 10 : null;
    verdict = delta > 0.005 ? 'MTF SHARPER'
      : delta < -0.005 ? 'PLAIN 15m SHARPER'
        : 'NO MEASURABLE DIFFERENCE';
    if (sepDelta != null && Math.abs(delta) <= 0.005) {
      verdict = sepDelta >= 3 ? 'MTF SHARPER (separation)' : sepDelta <= -3 ? 'PLAIN 15m SHARPER (separation)' : verdict;
    }
  }
  return {
    ok: true,
    question: 'Is the IntradayTapeMTF w1.6 upgrade genuinely better than the plain 15m tape w1.3?',
    method: 'Same settled executions, both arms journaled per entry (ledger ab_tape15m shadow). Directions are identical by design (15m anchor) — the honest metric is confidence quality on aligned votes: separation (avg conf wins − losses) and Brier (lower = sharper).',
    pairs,
    mtf: { seat: 'IntradayTapeMTF (w1.6)', ...mtf },
    plain: { seat: 'IntradayTape plain 15m (w1.3, A/B shadow)', ...plain },
    brierDeltaPlainMinusMtf: delta,
    verdict,
    note: pairs < MIN_SETTLED
      ? `Insufficient paired data — ${pairs}/${MIN_SETTLED} settled executions carry both arms. Track record gather hone do.`
      : 'Verdict is calibration-grade (confidence quality), not direction-grade — directions are identical by design.',
  };
}

// ---------------- v10.6: windowed per-model performance (Pro Upgrade #5) ----------------
/**
 * Per-model win/loss attribution over ROLLING windows (30d + 90d) —
 * the dashboard's "which of the 14 models is actually pulling its
 * weight THIS MONTH" view. Same attribution rule as ledger.modelStats
 * (a model whose recorded dir matched the trade's outcome gets win
 * credit), but time-boxed by the entry's SETTLE time.
 */
export function modelPerformanceWindows({ windows = [30, 90], now = Date.now() } = {}) {
  const settled = settledEntries();
  const names = {};
  for (const m of MODELS || []) names[m.id] = m.name;
  const out = {};
  for (const days of windows) {
    const since = now - days * 86400_000;
    const stats = {};
    for (const e of settled) {
      const ts = e.outcome?.ts || e.ts || 0;
      if (ts < since) continue;
      const win = (e.outcome.r ?? 0) > 0;
      for (const [modelId, v] of Object.entries(e.votes || {})) {
        if (!v || v.dir === 0) continue;
        const s = stats[modelId] = stats[modelId] || { model: modelId, aligned: 0, wins: 0, losses: 0 };
        s.aligned++;
        const alignedWithSide = (v.dir > 0) === (e.side !== 'SHORT');
        const calledItRight = alignedWithSide === win;
        if (calledItRight) s.wins++; else s.losses++;
      }
    }
    out[`d${days}`] = Object.values(stats).map(s => ({
      model: s.model,
      name: names[s.model] || s.model,
      n: s.wins + s.losses,
      hitRate: (s.wins + s.losses) > 0 ? Math.round((s.wins / (s.wins + s.losses)) * 1000) / 10 : null,
    })).filter(s => s.n > 0).sort((a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1) || b.n - a.n);
  }
  return {
    ok: true,
    windows: windows.map(d => `d${d}`),
    settledTotal: settled.length,
    ...out,
    note: 'Per-model attribution over rolling windows (a model wins when its recorded dir matched the settled outcome). 30d/90d — small n means noise, not edge.',
  };
}

// ---------------- v11.0: per-COUNCIL-AGENT accountability ----------------
/**
 * Per-agent attribution from ledger entries that carry a `council`
 * stamp (v11.0 recordExecution stamps it whenever the Global Market
 * Council attached a verdict to the executed signal). An agent whose
 * recorded direction matched the trade side gets win/loss credit from
 * the settled outcome — EXACTLY the modelStats() rule, one seat over.
 * NEUTRAL votes abstain; absent seats don't count.
 */
export function councilAgentStats() {
  const settled = settledEntries().filter(e => e.council && e.council.agents);
  const stats = {};
  for (const e of settled) {
    const win = (e.outcome.r ?? 0) > 0;
    const tradeLong = !/^(S|SELL)/i.test(String(e.side || ''));
    for (const [role, v] of Object.entries(e.council.agents || {})) {
      if (!v || v.dir === 0) continue;
      const s = stats[role] = stats[role] || { role, aligned: 0, wins: 0, losses: 0, longWins: 0, longN: 0, shortWins: 0, shortN: 0 };
      const alignedWithSide = (v.dir > 0) === tradeLong;
      s.aligned++;
      if ((v.dir > 0) === tradeLong) {
        if (tradeLong) { s.longN++; if (win) s.longWins++; } else { s.shortN++; if (win) s.shortWins++; }
      }
      const calledItRight = alignedWithSide === win;
      if (calledItRight) s.wins++; else s.losses++;
    }
  }
  for (const s of Object.values(stats)) {
    s.n = s.wins + s.losses;
    s.hitRate = s.n > 0 ? Math.round((s.wins / s.n) * 1000) / 10 : null;
    // direction split (the "kuch agents LONG me acche, SHORT me average" lens)
    s.directionSplit = {
      LONG: { n: s.longN, winRate: s.longN > 0 ? Math.round((s.longWins / s.longN) * 1000) / 10 : null },
      SHORT: { n: s.shortN, winRate: s.shortN > 0 ? Math.round((s.shortWins / s.shortN) * 1000) / 10 : null },
    };
  }
  return Object.values(stats).sort((a, b) => b.n - a.n);
}

/**
 * Calibration MULTIPLIERS for council weights (the adaptive.js
 * Bayesian rule, one seat over): posterior = Beta(wins+1, losses+1),
 * mul = clamp(2×posterior, 0.7, 1.3), n < 8 → 1.0 (refuse to tune
 * on noise). A NEW agent starts at 0.5× for its 30-day paper
 * probation (weeklyReview promotes/demotes) — probation flag rides
 * on the record, not here.
 */
export function councilCalibrationMultipliers() {
  const out = {};
  for (const s of councilAgentStats()) {
    if (s.n < 8) { out[s.role] = { mul: 1.0, n: s.n, posterior: null, hitRate: s.hitRate ?? null }; continue; }
    const alpha = (s.wins || 0) + 1, beta = (s.losses || 0) + 1;
    const posterior = alpha / (alpha + beta);
    out[s.role] = {
      mul: Math.max(0.7, Math.min(1.3, 2 * posterior)),
      n: s.n,
      posterior: Math.round(posterior * 100) / 100,
      hitRate: s.hitRate ?? null,
    };
  }
  return out;
}

/** The dashboard COUNCIL block: per-agent track records + Brier +
 *  published-precision funnel over council-stamped settled entries. */
export function councilCalibration() {
  const settled = settledEntries().filter(e => e.council && e.council.agents);
  const base = { ok: true, settled: settled.length, asOf: Date.now() };
  if (settled.length < MIN_SETTLED) {
    return {
      ...base,
      sufficient: false,
      note: `Insufficient data — ${settled.length}/${MIN_SETTLED} council-stamped settled signals. Agents earn their calibrated weight ONLY on settled outcomes (chhoti sample par tuning = noise).`,
      agents: councilAgentStats(),
      weights: councilCalibrationMultipliers(),
      brier: null, precision: null,
    };
  }
  // published-precision (wins / published) + per-agent Brier
  const wins = settled.filter(e => (e.outcome.r ?? 0) > 0).length;
  const precision = Math.round((wins / settled.length) * 1000) / 10;
  let brierSum = 0;
  for (const e of settled) {
    const p = Math.min(1, Math.max(0, (Number(e.council?.confidence) || 50) / 100));
    const y = (e.outcome.r ?? 0) > 0 ? 1 : 0;
    brierSum += (p - y) ** 2;
  }
  const brier = Math.round((brierSum / settled.length) * 10000) / 10000;
  // 90-day rolling precision (the honest window — 30-day n is noise)
  const since90 = Date.now() - 90 * 86400_000;
  const recent = settled.filter(e => (e.outcome.ts || e.ts || 0) >= since90);
  const recentWins = recent.filter(e => (e.outcome.r ?? 0) > 0).length;
  return {
    ...base,
    sufficient: true,
    precision,
    precision90d: recent.length > 0 ? Math.round((recentWins / recent.length) * 1000) / 10 : null,
    n90d: recent.length,
    brier,
    brierVerdict: brier <= 0.15 ? 'sharp — council confidence trustable'
      : brier <= 0.20 ? 'theek — mild miscalibration'
      : brier <= 0.25 ? 'weak — confidence/outcome gap bada'
      : 'coin-flip worse — confidence labels par bharosa mat karo',
    agents: councilAgentStats(),
    weights: councilCalibrationMultipliers(),
    note: 'Per-COUNCIL-agent accountability: hit-rate, direction split, Brier, calibrated weight — sirf settled outcomes se. 95% is a precision TARGET (publish kam, quality zyada), guarantee nahi.',
  };
}

// ---------------- test hooks ----------------
export const __testables = { normalCdf, binomPValueAtLeast, BUCKETS, MIN_SETTLED };
