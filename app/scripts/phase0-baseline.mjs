#!/usr/bin/env node
// ============================================================
// scripts/phase0-baseline.mjs — v21.28.0 PHASE 0 BASELINE FREEZE
// ------------------------------------------------------------
// WHY: Audit plan ka rule — indicator/exit behaviour badalne se pehle
// current real-data performance ka frozen snapshot lo. Har baad ka change
// isi baseline se compare hoga (regression evidence, gut-feel nahi).
//
// SAFETY: READ-ONLY. Koi config/state/ledger file mutate nahi hoti, koi
// exchange call nahi, koi server boot nahi. Sirf server/data/*.json padhkar
// canonical Phase 0 audit + MTF direction scorecard + per-tier stats likhta
// hai.
//
// USAGE (repo app/ folder se):
//   node scripts/phase0-baseline.mjs
//   node scripts/phase0-baseline.mjs --data-dir <dir> --out docs/BASELINE-X.json
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = path.resolve(arg('data-dir', path.join(APP_ROOT, 'server', 'data')));
// phase0Audit/signalLedger/hydration env se data dir resolve karte hain.
process.env.MTF_AUTO_DATA_DIR = dataDir;

const { buildPhase0Audit } = await import('../server/ai/phase0Audit.js');
const { hydrateMtfLedger, computeMtfDirectionScorecard } = await import('../server/ai/signalLedger.js');

const round2 = (v) => (Number.isFinite(Number(v)) ? +Number(v).toFixed(2) : null);
const round4 = (v) => (Number.isFinite(Number(v)) ? +Number(v).toFixed(4) : null);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  } catch {
    return null;
  }
}

function fileStats(name) {
  try {
    const st = fs.statSync(path.join(dataDir, name));
    return { bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

const now = Date.now();
const ledgerRaw = readJson('mtf-row-ledger.json');
const rows = Array.isArray(ledgerRaw) ? ledgerRaw : (Array.isArray(ledgerRaw?.rows) ? ledgerRaw.rows : []);
hydrateMtfLedger(rows, {
  lastLogAt: num(ledgerRaw?.lastLogAt),
  lastResolveAt: num(ledgerRaw?.lastResolveAt),
});
const scorecard = computeMtfDirectionScorecard({ windowDays: 30, now });

// Per-tier stats — baseline harness deliberately replicates the future
// scorecard fields so the pre/post comparison is apples-to-apples even
// before signalLedger exposes them.
function tierStats(list) {
  const resolved = list.filter((r) => r?.resolved === true);
  const n = resolved.length;
  if (!n) {
    return {
      scans: list.length, resolved: 0, tp1Hits: 0, tp2Hits: 0, stopOuts: 0,
      tp1HitPct: null, tp2HitPct: null, stopOutPct: null,
      expectancyR: null, avgR: null, avgMfeR: null, avgMaeR: null,
      avgTimeToTp1Min: null, directionHitPct: null,
    };
  }
  const tp1 = resolved.filter((r) => r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT');
  const tp2 = resolved.filter((r) => r.outcome === 'T2_HIT');
  const sl = resolved.filter((r) => r.outcome === 'SL_HIT');
  const rs = resolved.map((r) => num(r.outcomeR)).filter((v) => v != null);
  const mfe = resolved.map((r) => num(r.mfeR)).filter((v) => v != null);
  const mae = resolved.map((r) => num(r.maeR)).filter((v) => v != null);
  const hitLags = tp1
    .map((r) => {
      const ts = num(r.ts);
      if (!ts) return null;
      // v21.28.0: prefer the exact TP1 touch stamp when the ledger has it;
      // fall back to the sweep timestamp for pre-upgrade rows.
      const exact = num(r.t1HitAt) ?? num(r.tp1HitAt);
      if (exact) return (exact - ts) / 60_000;
      const resolved = num(r.resolvedAt);
      return resolved ? (resolved - ts) / 60_000 : null;
    })
    .filter((v) => v != null && v >= 0);
  const exactHitLags = tp1
    .map((r) => {
      const ts = num(r.ts);
      const exact = num(r.t1HitAt) ?? num(r.tp1HitAt);
      return ts && exact ? (exact - ts) / 60_000 : null;
    })
    .filter((v) => v != null && v >= 0);
  const dirHits = resolved.filter((r) => r.directionHit === true).length;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  return {
    scans: list.length,
    resolved: n,
    tp1Hits: tp1.length,
    tp2Hits: tp2.length,
    stopOuts: sl.length,
    tp1HitPct: round2((tp1.length / n) * 100),
    tp2HitPct: round2((tp2.length / n) * 100),
    stopOutPct: round2((sl.length / n) * 100),
    expectancyR: rs.length ? round4(avg(rs)) : null,
    avgR: rs.length ? round4(avg(rs)) : null,
    avgMfeR: mfe.length ? round4(avg(mfe)) : null,
    avgMaeR: mae.length ? round4(avg(mae)) : null,
    // v21.28.0: exact touch time (t1HitAt) when present; older rows keep the
    // sweep timestamp fallback labelled "Approx".
    avgTimeToTp1Min: exactHitLags.length ? round2(avg(exactHitLags)) : null,
    avgTimeToTp1MinApprox: hitLags.length ? round2(avg(hitLags)) : null,
    directionHitPct: round2((dirHits / n) * 100),
  };
}

const cutoff = now - 30 * 86_400_000;
const windowRows = rows.filter((r) => Number(r?.ts) >= cutoff);
const tierNames = [...new Set(rows.map((r) => String(r?.tier || 'UNKNOWN').toUpperCase()))].sort();
const byTier = {};
for (const t of tierNames) {
  const inTier = (r) => String(r?.tier || 'UNKNOWN').toUpperCase() === t;
  byTier[t] = {
    allTime: tierStats(rows.filter(inTier)),
    window30d: tierStats(windowRows.filter(inTier)),
  };
}

const audit = buildPhase0Audit({ fresh: true, now });

const baseline = {
  schema: 'smartaipg-phase0-baseline-v1',
  generatedAt: now,
  generatedAtISO: new Date(now).toISOString(),
  frozenFor: '2026-10-29 audit plan — pre-F1..F9 comparison',
  dataDir,
  readOnly: true,
  dataFiles: Object.fromEntries(
    ['tracked-signals.json', 'paper-trades.json', 'ai-trading-journal.json',
      'mtf-row-ledger.json', 'selfimprove-outcomes.json', 'mtf-auto-state.json',
      'mtf-auto-config.json'].map((f) => [f, fileStats(f)]),
  ),
  phase0Audit: {
    version: audit.version,
    scope: audit.scope,
    riskCaps: audit.riskCaps,
    sources: audit.sources,
    unresolved: audit.unresolved,
    stopIntegrity: audit.stopIntegrity,
    duplicates: audit.duplicates,
    manualExits: audit.manualExits,
    reconciliation: audit.reconciliation,
    warnings: audit.warnings,
    verdict: audit.verdict,
  },
  directionScorecard: {
    ...scorecard,
    // recentScans poore row objects hain — baseline me sirf summary chahiye.
    recentScans: undefined,
    recentScansCount: Array.isArray(scorecard.recentScans) ? scorecard.recentScans.length : 0,
  },
  mtfRowLedger: {
    total: rows.length,
    lastLogAt: num(ledgerRaw?.lastLogAt),
    lastResolveAt: num(ledgerRaw?.lastResolveAt),
    byTier,
  },
  baselineNotes: [
    'Ye snapshot sirf comparison ke liye hai — koi PnL guarantee nahi.',
    'Tracked-signals / paper / journal alag namespaces hain; inhe jodkar ek PnL nahi banaya gaya.',
    'avgTimeToTp1MinApprox resolution-sweep lag hai, exact candle touch time nahi.',
    'Per-tier stats future signalLedger.scorecard fields ka pre-change reference hain.',
  ],
};

const outArg = arg('out', path.join('docs', 'BASELINE-2026-10-29.json'));
const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(APP_ROOT, outArg);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  out: outPath,
  verdict: audit.verdict,
  warnings: audit.warnings.length,
  ledgerRows: rows.length,
  resolved: scorecard.resolvedCount,
  tiers: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, {
    allTimeN: v.allTime.resolved, win30dN: v.window30d.resolved,
    tp1Pct30d: v.window30d.tp1HitPct, expR30d: v.window30d.expectancyR,
  }])),
}, null, 2));
