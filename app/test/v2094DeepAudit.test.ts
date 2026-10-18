// ============================================================
// test/v2094DeepAudit.test.ts — v20.9.4 AUTO-TRADE / BOTS /
// SIGNALS DEEP WORKING-FLOW RECHECK — regression locks
// ------------------------------------------------------------
// Focused 3-module recheck (auto-trade exec chain, bots desk,
// signals/ensemble chain). This file locks every fix:
//   A. H1 — reversalEngine LIVE legs: ORDER id ≠ POSITION id.
//      openReversalLeg now resolves the REAL position row (poll,
//      3×1.2s) so exits/TPSL arm on the right id; unresolved →
//      null + watcher adopt (never a wrong-id arm). Native TP/SL
//      {ok:false} no longer silently drops (WATCH_ERROR).
//   B. H2 — meta-ensemble PRODUCTION wiring: aggregateVotesWithMeta
//      existed since v10.5 but was NEVER called — board + deep FINAL
//      aggregation now meta-aware; side can never flip, quorum AND
//      MTF honesty caps can never be bypassed by meta confidence.
//   C. H2 — botRunner telegram: sendTelegramMessage wants a
//      {token,chatId} OPTIONS object, raw process.env was passed →
//      TG_TOKEN/TG_CHAT_ID deployments had alerts silently dead.
//      tgEnv chain + risk-alert verdict check (3-strike retry, no
//      quota burn on failed sends).
//   D. H2 — dead cross-denomination guard revived: store-shape hist
//      bars are {t,o,h,l,c,v} — the guard read `.close` (undefined)
//      so it could NEVER fire; now reads `.c`.
//   E. H3 — exec/enter journal risk caps BEFORE protectionFirstEntry
//      (daily trades/loss, one-per-pair, max-open): an authenticated
//      caller can no longer buy unlimited naked exposure with
//      REJECTED journal rows for audit.
//   F. H3 — leader lease on BOTH auto-trade loops (agent + SAPTA):
//      non-leader nodes skip NEW entries (monitoring continues);
//      reconciler cold default = leader (unset node semantics).
//   G. H3 — regimeRouter triple-counted slope fixed (emaFastSlope
//      already IS the 3-bar move; norm = |slope|/atr).
//   H. M — deep-path winProb post-cap recompute + SVA re-stamp
//      parity (board path already did; deep card showed "aiScore 64
//      · P(win) EDGE"); futures-margin blocker now combined legs.
//   I. L — signalRecheck prevGrade captured BEFORE Object.assign
//      mutation (tautological "STRONG → STRONG" reasons gone) +
//      calibrate SAPTA DATA_DIR independent resolution.
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRegime } from '../server/bots/regimeRouter.js';
import { aggregateVotesWithMeta, DEFAULT_GATES } from '../server/ai/ensemble.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const src = {
  rev: S('server/ai/reversalEngine.js'),
  fut: S('server/ai/futures.js'),
  ens: S('server/ai/ensemble.js'),
  sig: S('server/ai/signals.js'),
  agt: S('server/ai/agent.js'),
  pta: S('server/ai/proTraderAuto.js'),
  rt: S('server/ai/routes.js'),
  sre: S('server/ai/signalRecheck.js'),
  run: S('server/bots/botRunner.js'),
  brt: S('server/bots/routes.js'),
  idx: S('server/index.js'),
  rec: S('server/exec/reconciler.js'),
  cal: S('scripts/botlab-calibrate.mjs'),
};

// ============================================================
// A. H1 — reversal LIVE legs: position-id resolution + honest TPSL
// ============================================================
describe('A. reversalEngine — LIVE leg position-id + native SL honesty [v20.9.4 H1]', () => {
  it('openReversalLeg resolves the REAL position row id (not the order id)', () => {
    // the poll: listFuturesPositions → row with activePos !== 0 → row.id
    expect(src.rev).toMatch(/listFuturesPositions[\s\S]{0,400}activePos[\s\S]{0,120}row\.id/);
    // futures.js must INJECT listFuturesPositions into revDeps
    expect(src.fut).toMatch(/revDeps = \{ exitFuturesPosition, createFuturesOrder, createFuturesTpsl, roundFuturesQty, coindcxConnected, listFuturesPositions \}/);
  });
  it('unresolved position id → null + watcher adopt (never a wrong-id arm)', () => {
    expect(src.rev).toMatch(/position id pending — watcher adopt karega/);
    expect(src.rev).toMatch(/exchangePositionId null hi rehne do/);
  });
  it('native TP/SL arm failure is VERDICT-checked and journaled (no silent drop)', () => {
    expect(src.rev).toMatch(/tpslR && tpslR\.ok === false/);
    expect(src.rev).toMatch(/REVERSAL leg native TP\/SL arm FAIL/);
    expect(src.rev).toMatch(/REVERSAL leg native TP\/SL arm THREW/);
  });
});

// ============================================================
// B. H2 — meta-ensemble production wiring + honesty caps
// ============================================================
describe('B. meta-ensemble — wired in production, capped in honesty [v20.9.4 H2]', () => {
  it('board FINAL aggregation site is meta-aware (aggregateVotesWithMeta)', () => {
    const boardSite = src.sig.slice(src.sig.indexOf('_computeBoard'));
    // v21.4.1 [A2]: votes ab _rediscountRevivedVotes() se wrapped hain —
    // final-loop me injected tape/pattern/sr seats bhi correlation
    // discount pay karte hain (deep-path parity). Meta-awareness intact.
    expect(boardSite).toMatch(/aggregateVotesWithMeta\(_rediscountRevivedVotes\(votes\), gatesFor\(depsSafe\)/);
  });
  it('deep FINAL aggregation site is meta-aware too', () => {
    const deepSite = src.sig.slice(src.sig.indexOf('_computeDeepSignal'));
    expect(deepSite).toMatch(/aggregateVotesWithMeta\(votes, gatesFor\(deps\)/);
  });
  it('MTF cap is an honesty cap meta may not undo (mtfCapped guard)', () => {
    expect(src.ens).toMatch(/weighted\.mtfCapped && conf > weighted\.confidence/);
    expect(src.ens).toMatch(/'meta-capped'/);
  });
  it('buildSignal stamps the meta source for downstream audit fields', () => {
    expect(src.ens).toMatch(/consensus\.source === 'meta' \|\| consensus\.source === 'meta-capped'/);
  });
  it('functional: disabled flag → source "weighted" (zero behavior change, honest)', async () => {
    const votes = [{ id: 'a', dir: 1, weight: 1, confidence: 80, model: 't' }];
    const out = await aggregateVotesWithMeta(votes, DEFAULT_GATES, {});
    expect(out.source === 'weighted' || out.source === 'meta-capped' || out.source === 'meta').toBe(true);
    // flag OFF by default in test env → weighted
    expect(out.source).toBe('weighted');
  });
});

// ============================================================
// C. H2 — botRunner telegram env-shape + risk-alert retry
// ============================================================
describe('C. botRunner — TG options-shape + verdict-aware risk alert [v20.9.4 H2]', () => {
  it('tgEnv chain: TG-shaped env wins, raw env is the fallback', () => {
    expect(src.run).toMatch(/this\.tgEnv = \(telegram\?\.env && \(telegram\.env\.token \|\| telegram\.env\.chatId\)\)/);
  });
  it('every sendTelegramMessage call passes tgEnv (never raw this.env)', () => {
    // strip comments: 6 real calls (3 inline `..., this.tgEnv).catch` + 1
    // multiline risk-alert `..., this.tgEnv,\n ).then(...` + 2 v21.1.0
    // protection-fail flatten/NAKED alerts `..., this.tgEnv).catch`)
    const active = src.run.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    const callCount = (active.match(/sendTelegramMessage\(/g) || []).length;
    expect(callCount).toBe(6);
    // no call passes raw this.env as the options arg (the dead-TG bug)
    expect(active).not.toMatch(/sendTelegramMessage\([^)]{0,800}?this\.env\)/);
    expect((active.match(/this\.tgEnv\)/g) || []).length).toBe(5);
    expect(active).toMatch(/this\.tgEnv,\s*\n\s*\)\.then\(\(r\) =>/);
  });
  it('risk-alert: verdict check — quota burns ONLY on ok, 3-strike retry otherwise', () => {
    expect(src.run).toMatch(/\.then\(\(r\) => \{\s*\n\s*if \(r\?\.ok\) \{/);
    expect(src.run).toMatch(/_riskAlertFail\[botId\] >= 3/);
  });
  it('bots/routes.js ships telegram.env through to the runner', () => {
    expect(src.brt).toMatch(/telegram: \{ enabled: false, env: null, \.\.\.opts\.telegram \}/);
  });
  it('index.js injects the TG-shaped env at registerBotRoutes', () => {
    expect(src.idx).toMatch(/telegram: \{ enabled: Boolean\(TG\.token && TG\.chatId\), env: \{ token: TG\.token, chatId: TG\.chatId \} \},/);
  });
});

// ============================================================
// D. H2 — cross-denomination guard revived (store-shape .c field)
// ============================================================
describe('D. index.js — hist-bar denomination guard reads the STORE shape [v20.9.4 H2]', () => {
  it('guard compares hist .c (not the API-shape .close that never existed)', () => {
    expect(src.idx).toMatch(/sameDenomination\(hist\[hist\.length - 1\]\.c, fresh\[fresh\.length - 1\]\.close\)/);
    expect(src.idx).not.toMatch(/sameDenomination\(hist\[hist\.length - 1\]\.close/);
  });
});

// ============================================================
// E. H3 — exec/enter journal risk caps (pre-entry, in-lock)
// ============================================================
describe('E. exec/enter — journal risk caps BEFORE the entry [v20.9.4 H3]', () => {
  const site = src.rt.slice(src.rt.indexOf("app.post('/api/exec/enter'"));
  it('daily trade cap + daily loss cap + one-per-pair + max-open all enforced in-lock', () => {
    expect(site).toMatch(/stats\.tradesCount\) >= \(Number\(capsCfg\.dailyMaxTrades\)/);
    expect(site).toMatch(/stats\.realizedPnlINR\) <= -\(Number\(capsCfg\.dailyMaxLossINR\)/);
    expect(site).toMatch(/one-per-pair rule — double exposure guard/);
    expect(site).toMatch(/Concentration guard/);
  });
  it('cap rejection is JOURNALED (REJECTED row, auditable) + HTTP 429', () => {
    expect(site).toMatch(/status: 'REJECTED', reason: `\[risk-gate\] \$\{capErr\}`/);
    expect(site).toMatch(/res\.status\(429\)\.json\(\{ ok: false, error: capErr \}\)/);
  });
  it('caps run BEFORE protectionFirstEntry (order in source)', () => {
    const capIdx = site.indexOf('[risk-gate]');
    const entryIdx = site.indexOf('pm.protectionFirstEntry'); // the CALL (comment mentions bare name)
    expect(capIdx).toBeGreaterThan(-1);
    expect(entryIdx).toBeGreaterThan(capIdx);
  });
});

// ============================================================
// F. H3 — leader lease on both auto-trade loops + cold default
// ============================================================
describe('F. leader lease — agent + SAPTA loops skip entries on non-leader [v20.9.4 H3]', () => {
  it('agent loop: isLeader check before candidates, monitoring sweeps already done', () => {
    expect(src.agt).toMatch(/maybeLogSkip\('non_leader'/);
    expect(src.agt).toMatch(/!isLeader\(\)\)\s*\{/);
    // the gate sits BEFORE the candidates scan (futures-margin skip block)
    const gateIdx = src.agt.indexOf("maybeLogSkip('non_leader'");
    const candIdx = src.agt.indexOf('---- candidates');
    expect(candIdx).toBeGreaterThan(gateIdx);
  });
  it('SAPTA loop: same lease, monitoring continues', () => {
    expect(src.pta).toMatch(/leader lease — ye node non-leader hai, SAPTA naye entries skip/);
    expect(src.pta).toMatch(/nonLeader: true/);
  });
  it('reconciler cold default = leader (unset-node semantics; init still re-evaluates env)', () => {
    // documented: "Unset NODE → treated as the leader (single-node setups keep working)"
    const m = src.rec.match(/_iAmLeader: (true|false),/);
    expect(m?.[1]).toBe('true');
    expect(src.rec).toMatch(/_state\._iAmLeader = !env\.SMARTAI_EXEC_NODE \|\| String\(env\.SMARTAI_EXEC_NODE\) === _state\._leaderNode;/);
  });
});

// ============================================================
// G. H3 — regimeRouter slope semantics
// ============================================================
describe('G. regimeRouter — no triple-counted slope [v20.9.4 H3]', () => {
  it('functional: slope is ALREADY the 3-bar move — norm = |slope|/atr', () => {
    // slope 0.5 over atr 2 → 0.25 ≥ 0.08 → TREND (old ×3 math made 3× more sensitive)
    expect(classifyRegime({ atr: 2, emaFast: 100, emaFastSlope: 0.5 }).regime).toBe('TREND');
    expect(classifyRegime({ atr: 5, emaFast: 100, emaFastSlope: 0.01 }).regime).toBe('CHOP');
    // boundary: old code would call this TREND (0.09×3=0.27 ≥ 0.08); honest math says CHOP
    expect(classifyRegime({ atr: 10, emaFast: 100, emaFastSlope: 0.09 }).regime).toBe('CHOP');
    expect(classifyRegime({ atr: 10, emaFast: 100, emaFastSlope: 0.09 }).normalizedSlope).toBe(0.009);
  });
  it('source: no slope×3 double-count remains in ACTIVE code', () => {
    expect(S('server/bots/regimeRouter.js')).toMatch(/const norm = Math\.abs\(slope\) \/ atr;/);
    // the only allowed `slope * 3` mention is the fix's own explanatory comment
    const active = S('server/bots/regimeRouter.js').split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(active.join('\n')).not.toMatch(/slope \* 3/);
  });
});

// ============================================================
// H. M — deep-path parity + combined futures margin
// ============================================================
describe('H. deep path parity + combined margin blocker [v20.9.4 M]', () => {
  it('deep UC-capped signals recompute winProb from the CAPPED aiScore', () => {
    expect(src.sig).toMatch(/built\.superIntel\.winProb = computeWinProb\(\{\s*\n\s*side: built\.side, market: mkt,\s*\n\s*aiScore: built\.superIntel\.aiScore,/);
  });
  it('both paths re-stamp SVA verify post-cap (board + deep)', () => {
    expect(src.sig).toMatch(/s\.verify = verifySignal\(s\)/);
    expect(src.sig).toMatch(/built\.verify = verifySignal\(built\)/);
  });
  it('futures-margin status blocker uses combined legs (USDT + INR/fx)', () => {
    expect(src.agt).toMatch(/combinedFutDeployableUSDT\(_state\.lastWallet \|\| \{\}\) < 2/);
  });
});

// ============================================================
// I. L — signalRecheck prev-grade capture + calibrate DATA_DIR
// ============================================================
describe('I. recheck reasons + calibrate DATA_DIR [v20.9.4 L]', () => {
  it('prevGrade/prevSide captured BEFORE the row mutation (mergeWatchlist)', () => {
    expect(src.sre).toMatch(/const prevGrade = prev\.grade;/);
    expect(src.sre).toMatch(/const prevSideR = prev\.side;/);
    expect(src.sre).toMatch(/board refresh: \$\{prevSideR\} \$\{prevGrade\} → /);
  });
  it('re-vote reason carries the true prevGrade too (assign-before-capture bug)', () => {
    expect(src.sre).toMatch(/const prevGrade2 = row\.grade; \/\/ v20\.9\.4 \[L\]: assign se PEHLE capture/);
    expect(src.sre).toMatch(/ensemble re-vote: \$\{prevSide\} \$\{prevGrade2\} → /);
  });
  it('calibrate resolves SAPTA DATA_DIR independently (SMARTAI_DATA_DIR / server/data)', () => {
    expect(src.cal).toMatch(/SMARTAI_DATA_DIR/);
    expect(src.cal).toMatch(/join\(ROOT, 'server', 'data'\)/);
  });
});

// ============================================================
// J. release hygiene — version gate is now DYNAMIC (no stale pins)
// ============================================================
describe('J. release gate — dynamic version consistency [v20.9.4]', () => {
  it('package.json version === version.ts APP_VERSION (cross-check, not hard-pin)', () => {
    const pkg = JSON.parse(S('package.json'));
    const m = S('src/version.ts').match(/APP_VERSION = '([^']+)'/);
    expect(m?.[1]).toBe(pkg.version);
  });
});
