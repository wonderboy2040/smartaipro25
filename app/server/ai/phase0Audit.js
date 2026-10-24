// ============================================================
// server/ai/phase0Audit.js — v21.24.0 PHASE 0 CANONICAL OUTCOME AUDIT
// ------------------------------------------------------------
// WHY THIS EXISTS
//   Site par teen alag ledger chal rahe the (tracked board signals, paper
//   engine, live journal) aur MTF row-ledger 420/420 unresolved tha. Isliye
//   "kitna profit/loss" ka jawab source ke hisaab se badal jata tha. Ye module
//   ek READ-ONLY canonical view deta hai:
//
//     • har closed outcome ko namespaced canonical ID milta hai
//       (board:… / paper:… / journal:…), isliye duplicate counting invisible
//       nahi rehti.
//     • stop-integrity: SL_HIT rows ka excess R (|R|-1) — plan se zyada loss.
//     • duplicate symbol/day signals (churn evidence).
//     • manual-exit count (strategy performance ko manual trades se alag).
//     • paper mirror vs LIVE deep-monitor book reconciliation (qty/SL/risk).
//     • MTF row-ledger + learning-loop outcome coverage.
//
// SAFETY: kuch bhi mutate nahi karta; sirf server/data/*.json padhta hai.
// 30s cache because /status is polled every 2s.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMtfAutoConfig, computeEffectiveRiskCaps } from './mtfAutoLink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const _dataDir = () => process.env.MTF_AUTO_DATA_DIR || DATA_DIR;

const CACHE_MS = 30_000;
let _cache = null;
let _cacheAt = 0;
let _cacheDir = null;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (v) => +(Number(v) || 0).toFixed(2);
const round4 = (v) => +(Number(v) || 0).toFixed(4);

function _readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(_dataDir(), name), 'utf8'));
  } catch {
    return fallback;
  }
}
function _readList(name, key) {
  const raw = _readJson(name, null);
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.[key]) ? raw[key] : [];
}

const CLOSED_SIGNAL_STATUSES = new Set(['EOD_EXIT', 'T2_HIT', 'BE_TRAIL_EXIT', 'SL_HIT', 'FLIP']);
const OPEN_SIGNAL_STATUSES = new Set(['OPEN', 'PARTIAL']);

function _isBoardClosed(s) {
  const st = String(s?.status || '').toUpperCase();
  if (CLOSED_SIGNAL_STATUSES.has(st)) return true;
  return Boolean(s?.closedAt) && !OPEN_SIGNAL_STATUSES.has(st);
}
function _isSlHit(s) {
  return /SL/i.test(String(s?.status || '')) || /SL/i.test(String(s?.closeReason || s?.exitReason || ''));
}
function _riskQuote(trade) {
  const entry = num(trade?.entry);
  const sl = num(trade?.initialStopLoss ?? trade?.stopLoss);
  const qty = num(trade?.qty);
  if (!(entry > 0) || !(sl > 0) || !(qty > 0)) return null;
  return Math.abs(entry - sl) * qty;
}
function _rMultipleForTrade(trade) {
  const risk = _riskQuote(trade);
  const pnl = num(trade?.netPnl ?? trade?.realizedPnl);
  if (!(risk > 0) || pnl == null) return null;
  return round4(pnl / risk);
}

/**
 * Build the canonical audit. `fresh:true` bypasses the 30s cache (detail
 * endpoint / tests); status polls ride the cache.
 */
export function buildPhase0Audit({ fresh = false, now = Date.now() } = {}) {
  const dir = _dataDir();
  if (!fresh && _cache && _cacheDir === dir && now - _cacheAt < CACHE_MS) return _cache;

  const signals = _readList('tracked-signals.json', 'signals');
  const paperTrades = _readList('paper-trades.json', 'trades');
  const journal = _readList('ai-trading-journal.json', 'entries');
  const rowLedger = _readList('mtf-row-ledger.json', 'rows');
  const learning = _readList('selfimprove-outcomes.json', 'rows');
  const autoState = _readJson('mtf-auto-state.json', {});
  const cfg = (() => { try { return loadMtfAutoConfig(); } catch { return null; } })();
  const riskCaps = cfg
    ? computeEffectiveRiskCaps(cfg, cfg.walletAmountINR)
    : null;

  // ---------------- board signals ----------------
  const boardClosed = signals.filter(_isBoardClosed);
  const boardOpen = signals.filter(s => OPEN_SIGNAL_STATUSES.has(String(s?.status || '').toUpperCase()));
  const boardWithR = boardClosed.map(s => ({ s, r: num(s?.rMultiple) })).filter(x => x.r != null);
  const boardSl = boardWithR.filter(x => _isSlHit(x.s));
  const boardWins = boardClosed.filter(s => {
    const r = num(s?.rMultiple);
    if (r != null) return r > 0;
    const p = num(s?.realizedPnlPerLakh);
    return p != null && p > 0;
  }).length;
  const boardNet = boardClosed.reduce((a, s) => a + (num(s?.realizedPnlPerLakh) || 0), 0);
  const boardRSum = boardWithR.reduce((a, x) => a + x.r, 0);
  const excessStopR = boardSl.reduce((a, x) => a + Math.max(0, Math.abs(x.r) - 1), 0);
  const worstR = boardWithR.length ? Math.min(...boardWithR.map(x => x.r)) : null;
  const beyond2R = boardWithR.filter(x => x.r <= -2).length;

  const boardOutcomes = boardClosed.map(s => ({
    canonicalId: `board:${s.id || `${s.market || '?'}:${s.symbol || '?'}:${s.dayKey || s.openedAt || '?'}`}`,
    system: 'tracked-signals',
    source: 'board-signal',
    market: s.market || null,
    symbol: s.symbol || null,
    side: s.direction || null,
    entry: num(s.entry),
    exit: num(s.exitPrice),
    stopLoss: num(s.stopLoss),
    status: s.status || null,
    openedAt: num(s.openedAt),
    closedAt: num(s.closedAt),
    rMultiple: num(s.rMultiple),
    pnlPerLakh: num(s.realizedPnlPerLakh),
    pnlINR: null,
    win: (() => { const r = num(s.rMultiple); return r != null ? r > 0 : (num(s.realizedPnlPerLakh) || 0) > 0; })(),
  }));

  // ---------------- paper engine ----------------
  const paperClosed = paperTrades.filter(t => String(t?.status || '').toUpperCase() === 'CLOSED');
  const paperOpen = paperTrades.filter(t => ['OPEN', 'PARTIAL'].includes(String(t?.status || '').toUpperCase()));
  const paperBySource = {};
  for (const t of paperTrades) {
    const src = String(t?.source || 'unknown');
    const bucket = paperBySource[src] || (paperBySource[src] = {
      total: 0, closed: 0, open: 0, pnl: 0, wins: 0, withR: 0, rSum: 0, manual: 0,
    });
    bucket.total += 1;
    const st = String(t?.status || '').toUpperCase();
    if (st === 'CLOSED') {
      bucket.closed += 1;
      const pnl = num(t?.netPnl ?? t?.realizedPnl) || 0;
      bucket.pnl += pnl;
      if (pnl > 0) bucket.wins += 1;
      const r = _rMultipleForTrade(t);
      if (r != null) { bucket.withR += 1; bucket.rSum += r; }
      if (/manual/i.test(String(t?.closeReason || ''))) bucket.manual += 1;
    } else {
      bucket.open += 1;
    }
  }
  for (const b of Object.values(paperBySource)) {
    b.pnl = round2(b.pnl);
    b.avgR = b.withR ? round4(b.rSum / b.withR) : null;
    delete b.rSum;
  }
  const paperNet = paperClosed.reduce((a, t) => a + (num(t?.netPnl ?? t?.realizedPnl) || 0), 0);
  const paperManual = paperClosed.filter(t => /manual/i.test(String(t?.closeReason || ''))).length;
  const paperOutcomes = paperClosed.map(t => ({
    canonicalId: `paper:${t.id ?? `${t.symbol || '?'}:${t.openedAt || '?'}`}`,
    system: 'paper-trades',
    source: `paper:${t.source || 'unknown'}`,
    market: t.market || null,
    symbol: t.symbol || null,
    side: t.direction || null,
    entry: num(t.entry),
    exit: null,
    stopLoss: num(t.initialStopLoss ?? t.stopLoss),
    status: t.closeReason || t.status || null,
    openedAt: num(t.openedAt),
    closedAt: num(t.closedAt),
    rMultiple: _rMultipleForTrade(t),
    pnlPerLakh: null,
    pnlINR: num(t.netPnl ?? t.realizedPnl),
    win: (num(t.netPnl ?? t.realizedPnl) || 0) > 0,
  }));

  // ---------------- live/paper journal ----------------
  const journalCloses = journal.filter(e => String(e?.kind || '').toUpperCase() === 'CLOSE');
  const journalManual = journalCloses.filter(e => /manual|app\/manual/i.test(String(e?.reason || ''))).length;
  const journalByMode = {};
  for (const e of journalCloses) {
    const mode = String(e?.mode || 'unknown');
    const b = journalByMode[mode] || (journalByMode[mode] = { closes: 0, pnlINR: 0, wins: 0 });
    b.closes += 1;
    b.pnlINR += num(e?.pnlINR) || 0;
    if ((num(e?.pnlINR) || 0) > 0) b.wins += 1;
  }
  for (const b of Object.values(journalByMode)) b.pnlINR = round2(b.pnlINR);
  const journalNet = journalCloses.reduce((a, e) => a + (num(e?.pnlINR) || 0), 0);
  const journalOutcomes = journalCloses.map(e => ({
    canonicalId: `journal:${e.id || `${e.pair || '?'}:${e.ts || '?'}`}`,
    system: 'ai-trading-journal',
    source: `journal:${e.source || 'unknown'}`,
    market: e.market || null,
    symbol: e.symbol || e.pair || null,
    side: e.side || null,
    entry: num(e.entryPrice),
    exit: num(e.closePrice),
    stopLoss: null,
    status: e.reason || null,
    openedAt: null,
    closedAt: num(e.ts),
    rMultiple: null,
    pnlPerLakh: null,
    pnlINR: num(e.pnlINR),
    win: (num(e.pnlINR) || 0) > 0,
  }));

  // ---------------- duplicate symbol/day signals ----------------
  const dupMap = new Map();
  for (const s of signals) {
    const sym = String(s?.symbol || '').toUpperCase();
    const day = String(s?.dayKey || (s?.openedAt ? new Date(Number(s.openedAt)).toISOString().slice(0, 10) : ''));
    if (!sym || !day) continue;
    const key = `${sym}|${day}`;
    const cur = dupMap.get(key) || { symbol: sym, dayKey: day, count: 0, sides: new Set(), statuses: [] };
    cur.count += 1;
    if (s.direction) cur.sides.add(String(s.direction).toUpperCase());
    cur.statuses.push(String(s.status || '?'));
    dupMap.set(key, cur);
  }
  const dupGroups = [...dupMap.values()].filter(g => g.count > 1);
  const duplicateSignals = {
    groups: dupGroups.length,
    extraSignals: dupGroups.reduce((a, g) => a + g.count - 1, 0),
    oppositeSideGroups: dupGroups.filter(g => g.sides.size > 1).length,
    examples: dupGroups
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(g => ({ symbol: g.symbol, dayKey: g.dayKey, count: g.count, sides: [...g.sides], statuses: g.statuses.slice(0, 6) })),
  };

  // ---------------- row-ledger / learning-loop coverage ----------------
  const ledgerResolved = rowLedger.filter(r => r?.outcome != null || r?.resolvedAt != null);
  const ledgerUnresolved = rowLedger.length - ledgerResolved.length;
  const learningWins = learning.filter(r => r?.win === true || (num(r?.r) || 0) > 0).length;
  const learningR = learning.map(r => num(r?.r)).filter(v => v != null);
  const learningStats = {
    total: learning.length,
    wins: learningWins,
    avgR: learningR.length ? round4(learningR.reduce((a, b) => a + b, 0) / learningR.length) : null,
    manual: learning.filter(r => /manual/i.test(String(r?.reason || ''))).length,
    lastAt: learning.reduce((a, r) => Math.max(a, num(r?.ts) || 0), 0) || null,
  };

  // ---------------- LIVE book vs paper mirror reconciliation ----------------
  const book = Array.isArray(autoState?.book) ? autoState.book : [];
  const openBook = book.filter(b => String(b?.status || '') === 'OPEN' && b?.traded !== false && b?.untradedFallback !== true);
  const paperOpenById = new Map();
  for (const t of paperOpen) paperOpenById.set(String(t.id), t);
  const qtyMismatches = [];
  const slMismatches = [];
  const missingMirrors = [];
  const stopViolations = [];
  const overRiskPositions = [];
  let liveOpen = 0;
  let mirrored = 0;
  for (const b of openBook) {
    const isLive = String(b?.executionMode || '').toUpperCase() === 'LIVE' || Boolean(b?.liveOrderId || b?.livePositionId);
    if (isLive) liveOpen += 1;
    const entry = num(b.entry) || 0;
    const initialSl = num(b.initialStopLoss ?? b.stopLoss) || 0;
    const currentSl = num(b.trailedStopLoss ?? b.stopLoss) || 0;
    const side = String(b.side || 'LONG').toUpperCase();
    if (!(currentSl > 0)) {
      stopViolations.push({ symbol: b.symbol, reason: 'missing stopLoss' });
    } else if (initialSl > 0) {
      const eps = Math.max(1e-9, entry * 1e-6);
      if (side === 'LONG' && currentSl < initialSl - eps) {
        stopViolations.push({ symbol: b.symbol, reason: 'LONG stop trailed BELOW initial SL', initialSl, currentSl });
      }
      if (side === 'SHORT' && currentSl > initialSl + eps) {
        stopViolations.push({ symbol: b.symbol, reason: 'SHORT stop trailed ABOVE initial SL', initialSl, currentSl });
      }
    }
    const wallet = num(b.walletINR);
    const risk = num(b.riskINR);
    const hardPct = riskCaps?.maxRiskPerTradePct || 2;
    if (wallet > 0 && risk != null && (risk / wallet) * 100 > hardPct + 1e-9) {
      overRiskPositions.push({
        symbol: b.symbol,
        riskINR: round2(risk),
        walletINR: round2(wallet),
        riskPct: round2((risk / wallet) * 100),
        capPct: hardPct,
      });
    }
    if (isLive && b.paperId != null) {
      const mirror = paperOpenById.get(String(b.paperId));
      if (!mirror) {
        missingMirrors.push({ symbol: b.symbol, paperId: b.paperId });
      } else {
        mirrored += 1;
        const liveQty = num(b.qty) || 0;
        const paperQty = num(mirror.qty) || 0;
        const base = Math.max(Math.abs(liveQty), Math.abs(paperQty), 1e-9);
        const diffPct = (Math.abs(liveQty - paperQty) / base) * 100;
        if (diffPct > 0.5) {
          qtyMismatches.push({
            symbol: b.symbol, liveQty, paperQty, diffPct: round2(diffPct), paperId: b.paperId,
          });
        }
        const paperSl = num(mirror.initialStopLoss ?? mirror.stopLoss) || 0;
        const stopDiffPct = entry > 0 ? (Math.abs(currentSl - paperSl) / entry) * 100 : 0;
        if (paperSl > 0 && stopDiffPct > 0.5) {
          slMismatches.push({
            symbol: b.symbol, liveSl: currentSl, paperSl, diffPct: round2(stopDiffPct), paperId: b.paperId,
          });
        }
      }
    } else if (isLive) {
      missingMirrors.push({ symbol: b.symbol, paperId: null });
    }
  }

  // ---------------- canonical outcomes ----------------
  const outcomes = [...boardOutcomes, ...paperOutcomes, ...journalOutcomes]
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

  // ---------------- warnings / verdict ----------------
  const warnings = [];
  // 0.5R se zyada overshoot bhi real stop-integrity defect hai — 5R threshold
  // chhote overshoots ko chhupa deta tha.
  if (excessStopR > 0.5) warnings.push(`SL exits ka excess ${round2(excessStopR)}R (plan -1R se zyada loss)`);
  if (duplicateSignals.extraSignals > 0) warnings.push(`${duplicateSignals.extraSignals} duplicate symbol/day signals (${duplicateSignals.groups} groups)`);
  if (qtyMismatches.length > 0) warnings.push(`${qtyMismatches.length} LIVE/paper qty mismatch(es)`);
  if (slMismatches.length > 0) warnings.push(`${slMismatches.length} LIVE/paper SL mismatch(es)`);
  if (missingMirrors.length > 0) warnings.push(`${missingMirrors.length} LIVE position(s) without an open paper mirror`);
  if (overRiskPositions.length > 0) warnings.push(`${overRiskPositions.length} open position(s) risk > ${riskCaps?.maxRiskPerTradePct ?? 2}% cap`);
  if (paperManual + journalManual > 0) warnings.push(`${paperManual + journalManual} manual exit(s) strategy stats me mix hain`);
  if (ledgerUnresolved > 0) warnings.push(`MTF row-ledger ${ledgerUnresolved}/${rowLedger.length} unresolved`);
  if (learning.length < 30) warnings.push(`learning loop sirf ${learning.length} settled outcome(s)`);
  if (stopViolations.length > 0) warnings.push(`${stopViolations.length} stop-integrity violation(s)`);

  const out = {
    ok: true,
    version: 1,
    generatedAt: now,
    scope: {
      dataDir: 'server/data (ya MTF_AUTO_DATA_DIR override)',
      sources: ['tracked-signals.json', 'paper-trades.json', 'ai-trading-journal.json', 'mtf-row-ledger.json', 'selfimprove-outcomes.json', 'mtf-auto-state.json'],
      doublesCountingNote: 'Har source apne namespace me report hota hai — board/paper/journal ko jodkar ek PnL nahi banaya jata.',
    },
    riskCaps,
    sources: {
      boardSignals: {
        total: signals.length,
        closed: boardClosed.length,
        open: boardOpen.length,
        wins: boardWins,
        winRatePct: boardClosed.length ? round2((boardWins / boardClosed.length) * 100) : null,
        netPnlPerLakh: round2(boardNet),
        withR: boardWithR.length,
        avgR: boardWithR.length ? round4(boardRSum / boardWithR.length) : null,
        slHits: boardSl.length,
        worstR: worstR == null ? null : round2(worstR),
        beyond2R,
      },
      paperTrades: {
        total: paperTrades.length,
        closed: paperClosed.length,
        open: paperOpen.length,
        netPnl: round2(paperNet),
        manualExits: paperManual,
        bySource: paperBySource,
      },
      journal: {
        closes: journalCloses.length,
        netPnlINR: round2(journalNet),
        manualExits: journalManual,
        byMode: journalByMode,
      },
      rowLedger: {
        total: rowLedger.length,
        resolved: ledgerResolved.length,
        unresolved: ledgerUnresolved,
        resolvedPct: rowLedger.length ? round2((ledgerResolved.length / rowLedger.length) * 100) : null,
      },
      learning: learningStats,
    },
    unresolved: {
      boardSignals: boardOpen.length,
      paperTrades: paperOpen.length,
      rowLedger: ledgerUnresolved,
      operationalOpen: boardOpen.length + paperOpen.length,
    },
    stopIntegrity: {
      boardSlHits: boardSl.length,
      excessStopR: round2(excessStopR),
      worstR: worstR == null ? null : round2(worstR),
      beyond2R,
      liveStopViolations: stopViolations.length,
      overRiskPositions: overRiskPositions.length,
    },
    duplicates: duplicateSignals,
    manualExits: {
      paper: paperManual,
      journal: journalManual,
      total: paperManual + journalManual,
    },
    reconciliation: {
      bookOpen: openBook.length,
      liveOpen,
      paperOpen: paperOpen.length,
      mirrored,
      qtyMismatches: qtyMismatches.length,
      slMismatches: slMismatches.length,
      missingMirrors: missingMirrors.length,
      stopViolations: stopViolations.length,
      overRiskPositions: overRiskPositions.length,
      examples: {
        qtyMismatches: qtyMismatches.slice(0, 3),
        slMismatches: slMismatches.slice(0, 3),
        missingMirrors: missingMirrors.slice(0, 3),
        stopViolations: stopViolations.slice(0, 3),
        overRiskPositions: overRiskPositions.slice(0, 3),
      },
    },
    outcomes,
    warnings,
    verdict: warnings.length ? 'ATTENTION' : 'OK',
  };

  _cache = out;
  _cacheAt = now;
  _cacheDir = dir;
  return out;
}

/** Lightweight payload for the 2s /status poll; heavy audit rides 30s cache. */
export function getPhase0Summary(opts = {}) {
  const a = buildPhase0Audit(opts);
  return {
    generatedAt: a.generatedAt,
    verdict: a.verdict,
    warnings: a.warnings,
    unresolved: a.unresolved,
    stopIntegrity: a.stopIntegrity,
    duplicates: {
      groups: a.duplicates.groups,
      extraSignals: a.duplicates.extraSignals,
      oppositeSideGroups: a.duplicates.oppositeSideGroups,
    },
    manualExits: a.manualExits,
    reconciliation: {
      bookOpen: a.reconciliation.bookOpen,
      liveOpen: a.reconciliation.liveOpen,
      paperOpen: a.reconciliation.paperOpen,
      mirrored: a.reconciliation.mirrored,
      qtyMismatches: a.reconciliation.qtyMismatches,
      slMismatches: a.reconciliation.slMismatches,
      missingMirrors: a.reconciliation.missingMirrors,
      stopViolations: a.reconciliation.stopViolations,
      overRiskPositions: a.reconciliation.overRiskPositions,
    },
    sources: a.sources,
    riskCaps: a.riskCaps,
  };
}

export function __resetPhase0AuditCacheForTests() {
  _cache = null;
  _cacheAt = 0;
  _cacheDir = null;
}
