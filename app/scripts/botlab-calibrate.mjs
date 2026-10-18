#!/usr/bin/env node
// ============================================================
// scripts/botlab-calibrate.mjs — v20.9.0 SIGNAL CALIBRATION (B2/B4)
// ------------------------------------------------------------
// AUDIT: "Har SAPTA/ensemble signal ka ledger... Weekly job: buckets
// ke hisaab se win-rate, avg R, n, Wilson lower bound. Threshold wahi
// jahan bucket ka net avg R > 0 aur n >= 30."
//
// REPORT ONLY — ye script koi config overwrite NAHI karta (audit:
// "user-saved values ko silently overwrite mat karo"). Output:
//   1. SAPTA journal → verified-score / confidence / aiScore buckets
//   2. Data-driven threshold RECOMMENDATION (walk-forward OOS apply
//      manual rahega)
//   3. Bot Lab settle events → per-bot calibration table
//   4. Purged walk-forward folds (C2) jab tak trades >= 40
//
// Usage: node scripts/botlab-calibrate.mjs [--state-dir <dir>] [--json]
// ============================================================
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const stateDirIdx = args.indexOf('--state-dir');
// v20.9.3 FIX (L): default pe dono runtime layouts probe karo — Docker/
// SMARTAI_DATA_DIR deployments `server/data` me rakhte hain, local Windows
// default `app/data/bots` hai (botRunner ka DEFAULT_STATE_DIR). Pehle sirf
// pehla check hota tha → local default pe Bot Lab table khali rehta tha.
const _probeDefaultStateDir = () => {
  const dockerish = join(ROOT, 'server', 'data');
  const localish = join(ROOT, 'data', 'bots');
  if (existsSync(localish) && !existsSync(join(dockerish, 'bots'))) return join(ROOT, 'data'); // caller appends 'bots'
  return dockerish;
};
const STATE_DIR = stateDirIdx >= 0 ? args[stateDirIdx + 1] : _probeDefaultStateDir();
// v20.9.4 FIX (H3 — SAPTA section silently empty on local layout): DATA_DIR
// ko STATE_DIR probe se derive karna galat tha — local layout me STATE_DIR
// app/data (bots ka parent) aata tha isliye DATA_DIR bhi app/data ban jata
// tha, jabki server SAPTA journal app/server/data/protrader-auto-journal.json
// (lib/store.js DATA_DIR) pe likhta hai. Calibrate har local run pe
// app/data/protrader-auto-journal.json dhoondhta tha (kabhi nahi banta) →
// SAPTA calibration table hamesha khali. Ab DATA_DIR apna independent
// resolution: SMARTAI_DATA_DIR override ya server/data (store.js jaisa).
const DATA_DIR = process.env.SMARTAI_DATA_DIR
  ? resolve(process.env.SMARTAI_DATA_DIR)
  : join(ROOT, 'server', 'data');

// --- load SAPTA journal ---
function loadSaptaLedger() {
  const p = join(DATA_DIR, 'protrader-auto-journal.json');
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return (j.trades || []).filter((t) => t?.status === 'CLOSED' && t?.signal);
  } catch { return []; }
}

// --- load Bot Lab settle events ---
function loadBotLabLedger() {
  // v20.9.3 FIX (L): `--state-dir $BOT_STATE_DIR` passthrough support —
  // BOT_STATE_DIR khud `.../bots` pe khatam hota hai; pehla version hamesha
  // `<dir>/bots` jodta tha → `.../bots/bots` (kabhi exist nahi karti) →
  // silently empty calibration (v20.9.1 flat-layout bug ka hi cousin).
  const nested = join(STATE_DIR, 'bots');
  const botsDir = existsSync(nested) ? nested : STATE_DIR;
  if (!existsSync(botsDir)) return [];
  const out = [];
  // v20.9.1 [H2]: botState.js FLAT layout me events likhta hai —
  // <stateDir>/bots/<bot>.events.jsonl (per-bot SUBDIRECTORY nahi).
  // Pehla version <bot>/events/*.jsonl dhoondhta tha jo KABHI exist
  // nahi karti → v20.9.0 ka "Bot Lab per-bot calibration table"
  // hamesha EMPTY tha.
  for (const f of readdirSync(botsDir).filter((x) => x.endsWith('.events.jsonl'))) {
    const bot = f.replace(/\.events\.jsonl$/, '');
    try {
      const lines = readFileSync(join(botsDir, f), 'utf8').split('\n').filter(Boolean);
      for (const ln of lines) {
        try {
          const e = JSON.parse(ln);
          if (e?.kind === 'settle') out.push({ bot, ...e });
        } catch { /* line skip */ }
      }
    } catch { /* file skip */ }
  }
  return out;
}

// minimal harvest (mirror of server/ai/signalLedger.js — inlined so the
// script runs standalone without importing server ESM graph)
function wilsonLB(wins, n, z = 1.96) {
  if (!n || n <= 0) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, Math.min(1, (center - margin) / denom));
}
const BUCKETS = [
  { label: '<60', min: -Infinity, max: 60 },
  { label: '60-70', min: 60, max: 70 },
  { label: '70-80', min: 70, max: 80 },
  { label: '80+', min: 80, max: Infinity },
];
function bucketize(rows, field) {
  const clean = rows.filter((r) => Number.isFinite(Number(r[field])));
  return BUCKETS.map((b) => {
    const inB = clean.filter((r) => Number(r[field]) >= b.min && Number(r[field]) < b.max);
    const n = inB.length;
    const wins = inB.filter((r) => Number(r.pnl) > 0).length;
    const rs = inB.map((r) => Number(r.rNet)).filter((x) => Number.isFinite(x));
    return {
      bucket: b.label, n,
      winRate: n ? +(wins / n).toFixed(3) : null,
      wilsonLB: n ? +wilsonLB(wins, n).toFixed(3) : null,
      avgR: rs.length ? +(rs.reduce((a, b2) => a + b2, 0) / rs.length).toFixed(3) : null,
      netPnl: Math.round(inB.reduce((a, r) => a + (Number(r.pnl) || 0), 0)),
    };
  });
}
function recommend(cal) {
  let best = null;
  for (const b of cal) {
    if (b.n < 30) continue;
    if (b.wilsonLB == null || b.wilsonLB <= 0.5) continue;
    if (b.avgR == null || b.avgR <= 0) continue;
    const floor = b.bucket === '<60' ? 0 : b.bucket === '80+' ? 80 : Number(String(b.bucket).split('-')[0]);
    if (!best || floor > best.threshold) best = { threshold: floor, ...b };
  }
  return best;
}

// v20.9.1 [H2]: promised-then-missing purged walk-forward folds (C2)
// ab implemented — signalLedger.purgedWalkForwardSplit ka inline mirror
// (tsIn/tsOut synthesize: settle events me tsIn=tsOut=at; sapta trades
// me tsIn=t.ts, tsOut=t.closed.ts). Report-only.
function purgedWalkForwardSplit(trades, { folds = 4, embargoMs = 5 * 60000 } = {}) {
  const list = (Array.isArray(trades) ? trades : [])
    .filter((t) => Number.isFinite(Number(t.tsIn)))
    .sort((a, b) => Number(a.tsIn) - Number(b.tsIn));
  if (list.length < folds * 10) return [];
  const out = [];
  for (let k = 1; k <= folds; k++) {
    const cutStart = list[Math.floor((list.length * (k - 1)) / folds)].tsIn;
    const cutEnd = list[Math.min(list.length - 1, Math.floor((list.length * k) / folds))].tsIn;
    const test = list.filter((t) => t.tsIn >= cutStart && t.tsIn < cutEnd);
    const train = list.filter((t) => {
      const tsOut = Number.isFinite(Number(t.tsOut)) ? Number(t.tsOut) : Number(t.tsIn);
      return tsOut < cutStart - embargoMs || t.tsIn >= cutEnd + embargoMs;
    });
    out.push({ fold: k, train: train.length, test: test.length });
  }
  return out;
}

// --- run ---
const saptaRaw = loadSaptaLedger();
const sapta = saptaRaw.map((t) => ({
  verifiedScore: Number(t.signal?.verified),
  confidence: Number(t.signal?.conf),
  aiScore: Number(t.signal?.aiScore),
  pnl: Number(t.closed?.pnlINR),
  rNet: null,
  ts: Number(t.closed?.ts) || 0,
}));
const botlabRaw = loadBotLabLedger();
const botlab = botlabRaw.map((e) => ({
  bot: e.bot, pnl: Number(e.netPnl), rNet: Number(e.rNet),
  ts: Date.parse(e.at) || 0,
}));

// v20.9.1 [H2]: purged walk-forward folds — dono ledgers ke liye.
const saptaFolds = purgedWalkForwardSplit(saptaRaw.map((t) => ({
  tsIn: Number(t.ts) || Number(t.closed?.ts) || 0, tsOut: Number(t.closed?.ts) || Number(t.ts) || 0,
})));
const botlabFolds = purgedWalkForwardSplit(botlabRaw.map((e) => ({
  tsIn: Date.parse(e.at) || 0, tsOut: Date.parse(e.at) || 0,
})));

const report = {
  generatedAt: new Date().toISOString(),
  sapta: {
    closedTrades: sapta.length,
    verifiedScoreBuckets: bucketize(sapta, 'verifiedScore'),
    confidenceBuckets: bucketize(sapta, 'confidence'),
    aiScoreBuckets: bucketize(sapta, 'aiScore'),
    recommendedVerifiedThreshold: recommend(bucketize(sapta, 'verifiedScore')),
  },
  botLab: {
    settledTrades: botlab.length,
    perBot: {},
  },
  // v20.9.1 [H2]: C2 folds (dono ledgers) — report-only.
  purgedWalkForwardFolds: { sapta: saptaFolds, botLab: botlabFolds },
};
for (const bot of [...new Set(botlab.map((r) => r.bot))]) {
  const rows = botlab.filter((r) => r.bot === bot);
  const wins = rows.filter((r) => r.pnl > 0).length;
  const rs = rows.map((r) => r.rNet).filter((x) => Number.isFinite(x));
  report.botLab.perBot[bot] = {
    n: rows.length,
    winRate: rows.length ? +(wins / rows.length).toFixed(3) : null,
    wilsonLB: rows.length ? +wilsonLB(wins, rows.length).toFixed(3) : null,
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : null,
    netPnl: Math.round(rows.reduce((a, r) => a + (r.pnl || 0), 0)),
  };
}

// v21.2.0 (dual-provider plan Step-7 / R4-analysis): PER-ARM table —
// settle events ab `arm` field rakhte hain (position meta se, restart-safe).
// Purane settle events (pre-v21.2.0) me arm null hai — wo 'unknown'
// bucket me jaate hain, drop nahi hote (sample size honest rehta hai).
// Yehi table R5 ("winner arm paper me trade le") ka input hai: net
// expectancy / win-rate / Wilson LB per arm, sab settle ledger se.
report.botLab.perArm = {};
for (const arm of [...new Set(botlab.map((r) => (r.arm ? String(r.arm) : 'unknown')))]) {
  const rows = botlab.filter((r) => (r.arm ? String(r.arm) : 'unknown') === arm);
  const wins = rows.filter((r) => r.pnl > 0).length;
  const rs = rows.map((r) => r.rNet).filter((x) => Number.isFinite(x));
  report.botLab.perArm[arm] = {
    n: rows.length,
    winRate: rows.length ? +(wins / rows.length).toFixed(3) : null,
    wilsonLB: rows.length ? +wilsonLB(wins, rows.length).toFixed(3) : null,
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : null,
    netPnl: Math.round(rows.reduce((a, r) => a + (r.pnl || 0), 0)),
  };
}

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  console.log('═'.repeat(72));
  console.log('SIGNAL CALIBRATION REPORT (report-only — no config changes)');
  console.log('═'.repeat(72));
  console.log(`SAPTA closed trades : ${report.sapta.closedTrades}`);
  if (report.sapta.closedTrades) {
    for (const [field, cal] of [['verifiedScore', report.sapta.verifiedScoreBuckets], ['confidence', report.sapta.confidenceBuckets], ['aiScore', report.sapta.aiScoreBuckets]]) {
      console.log(`\n— SAPTA ${field} buckets —`);
      console.log('  bucket    n     winRate   wilsonLB   avgR     netPnl');
      for (const b of cal) console.log(`  ${b.bucket.padEnd(8)} ${String(b.n).padEnd(6)} ${pct(b.winRate).padEnd(9)} ${pct(b.wilsonLB).padEnd(10)} ${String(b.avgR ?? '—').padEnd(8)} ${b.netPnl}`);
    }
    const rec = report.sapta.recommendedVerifiedThreshold;
    console.log(`\n  recommended minVerifiedScore (wilsonLB>50% & avgR>0 & n>=30): ${rec ? rec.threshold : 'INSUFFICIENT DATA — keep provisional 70'}`);
    console.log('  NOTE: threshold change walk-forward OOS validate hone ke baad hi karo (manual).');
  }
  console.log(`\nBot Lab settled trades: ${report.botLab.settledTrades}`);
  for (const [bot, s] of Object.entries(report.botLab.perBot)) {
    console.log(`  ${bot.padEnd(16)} n=${String(s.n).padEnd(5)} win=${pct(s.winRate).padEnd(7)} LB=${pct(s.wilsonLB).padEnd(7)} avgR=${s.avgR ?? '—'} net=${s.netPnl}`);
  }
  // v21.2.0 (dual-provider): per-arm table — winner-arm selection (R5)
  // isi se hota hai. 'unknown' = pre-v21.2.0 settle events (arm field
  // tab nahi tha) — inko padhna ho to naye trades chahiye.
  const armEntries = Object.entries(report.botLab.perArm || {});
  if (armEntries.length > 1 || (armEntries[0] && armEntries[0][0] !== 'unknown')) {
    console.log('\n  per-ARM (dual-provider R4/R5 input — winner arm yahi se chunta hai):');
    for (const [arm, s] of armEntries) {
      console.log(`    ${arm.padEnd(14)} n=${String(s.n).padEnd(5)} win=${pct(s.winRate).padEnd(7)} LB=${pct(s.wilsonLB).padEnd(7)} avgR=${s.avgR ?? '—'} net=${s.netPnl}`);
    }
  } else {
    console.log('\n  per-ARM: sab settle events pre-v21.2.0 hain (arm field nahi) — naye trades aane ke baad yahan arm-wise table aayegi');
  }
  const foldsOf = (label, folds) => {
    if (!folds.length) { console.log(`\n${label} purged WFF: INSUFFICIENT DATA (n < folds×10)`); return; }
    console.log(`\n${label} purged walk-forward folds (train/test counts, 5-min embargo dono sides):`);
    for (const f of folds) console.log(`  fold ${f.fold}: train=${f.train} test=${f.test}`);
  };
  foldsOf('SAPTA', report.purgedWalkForwardFolds.sapta);
  foldsOf('Bot Lab', report.purgedWalkForwardFolds.botLab);
  console.log('═'.repeat(72));
}
