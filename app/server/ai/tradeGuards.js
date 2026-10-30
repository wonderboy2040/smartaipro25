// ============================================================
// server/ai/tradeGuards.js — v21.29.0 R3–R9 TRADE GUARDS
// ------------------------------------------------------------
// Pure, deterministic helpers for the audit cycle's remaining risk
// filters. Nothing here performs IO or mutates config:
//
//   R3 reversal guard v2   — tiered, closed-bar-aware reversal exit
//                             (1 class → tighten, 2 → reduce request,
//                              3+ → exit). Shadow default.
//   R4 event/session filter — macro-event blackout + open/close windows.
//   R5 regime filter        — no counter-regime entries in a trend; chop.
//   R6 perp veto            — funding / long-short ratio / basis extremes.
//   R7 score calibration    — per-bucket settled win-rate; only sufficient
//                             buckets may gate entries.
//   R8 runner / stall exit  — runner after TP2 + no-progress timeout.
//   R9 cluster guard        — correlation-cluster concentration cap.
//
// EVERY filter returns both `wouldBlock` (what it observed) and
// `blocked` (what it is allowed to DO in the current mode). `shadow`
// means: observe + report, never block. Callers persist the evidence
// through shadowHarness.js so a later enforce flip is an operator
// decision backed by data, not a guess.
// ============================================================
import { normalizeSide } from './directionCertificate.js';

export const GUARD_MODES = Object.freeze(['off', 'shadow', 'enforce']);

/** Accept booleans/legacy aliases; unknown values fall back safely. */
export function normalizeGuardMode(raw, fallback = 'shadow') {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce' || v === 'on' || v === '1' || v === 'true' || v === 'active') return 'enforce';
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled' || v === 'none') return 'off';
  if (v === 'shadow' || v === 'dry-run' || v === 'dryrun' || v === 'observe') return 'shadow';
  return fallback === 'enforce' || fallback === 'off' ? fallback : 'shadow';
}

export function guardActive(mode) { return normalizeGuardMode(mode) !== 'off'; }
export function guardShadow(mode) { return normalizeGuardMode(mode) === 'shadow'; }
export function guardEnforce(mode) { return normalizeGuardMode(mode) === 'enforce'; }

// ------------------------------------------------------------
// R9 — correlation clusters (deterministic, exchange-agnostic)
// ------------------------------------------------------------
const CLUSTER_MAP = Object.freeze({
  BTC: 'MAJORS',
  ETH: 'ETH',
  SOL: 'ALT_L1', AVAX: 'ALT_L1', DOT: 'ALT_L1', ADA: 'ALT_L1', NEAR: 'ALT_L1',
  SUI: 'ALT_L1', APT: 'ALT_L1', SEI: 'ALT_L1', TIA: 'ALT_L1', INJ: 'ALT_L1',
  LINK: 'ALT_L1', ATOM: 'ALT_L1', POL: 'ALT_L1', MATIC: 'ALT_L1',
  DOGE: 'MEME', SHIB: 'MEME', PEPE: 'MEME', WIF: 'MEME', BONK: 'MEME', FLOKI: 'MEME',
  XAU: 'METALS', XAG: 'METALS', GOLD: 'METALS', SILVER: 'METALS',
  NIFTY: 'INDIA_INDEX', BANKNIFTY: 'INDIA_INDEX', SENSEX: 'INDIA_INDEX',
  NVDA: 'US_EQ', TSLA: 'US_EQ', AAPL: 'US_EQ', MSFT: 'US_EQ', AMZN: 'US_EQ',
  META: 'US_EQ', GOOGL: 'US_EQ', AMD: 'US_EQ', NFLX: 'US_EQ',
});

/** Strip common ticket suffixes: BTCUSDT → BTC, B-BTC_USDT → BTC, XAU/USD → XAU. */
export function normalizeClusterSymbol(symbol) {
  let s = String(symbol || '').toUpperCase().trim();
  if (!s) return '';
  s = s.replace(/^B-/, '').replace(/[-/_].*$/, '');
  s = s.replace(/(USDT|USDC|INR|USD|PERP|FUT)$/g, '');
  return s;
}

export function correlationClusterOf(symbol) {
  const s = normalizeClusterSymbol(symbol);
  if (!s) return 'UNKNOWN';
  if (CLUSTER_MAP[s]) return CLUSTER_MAP[s];
  // Family prefixes: 1000PEPE, 1000SHIB, 1INCH, etc.
  if (s.startsWith('1000')) {
    const base = s.slice(4);
    if (CLUSTER_MAP[base]) return CLUSTER_MAP[base];
  }
  for (const key of Object.keys(CLUSTER_MAP)) {
    if (s.startsWith(key)) return CLUSTER_MAP[key];
  }
  return `OTHER:${s.slice(0, 3) || 'UNK'}`;
}

/**
 * R9 — block a new entry when its cluster already holds `maxPerCluster`
 * open positions. `openRows` may be the book or a paper summary; rows are
 * counted only when OPEN (status/open flag) and not explicitly untraded.
 */
export function evaluateClusterGuard({
  openRows = [], candidate = {}, maxPerCluster = 2, mode = 'shadow',
  clusterOf = correlationClusterOf, sameMarketOnly = true,
} = {}) {
  const m = normalizeGuardMode(mode);
  const sym = normalizeClusterSymbol(candidate.symbol);
  const market = String(candidate.execMarket || candidate.market || '').toUpperCase();
  const cluster = clusterOf(candidate.symbol);
  if (!sym) {
    return { filter: 'clusterGuard', mode: m, active: m !== 'off', cluster, count: 0, maxPerCluster, wouldBlock: false, blocked: false, shadow: m === 'shadow', reason: null, openSymbols: [] };
  }
  const sameCluster = (Array.isArray(openRows) ? openRows : []).filter((r) => {
    if (!r || r.traded === false) return false;
    const st = String(r.status || (r.open === true ? 'OPEN' : '')).toUpperCase();
    if (st && st !== 'OPEN') return false;
    if (!st && r.open !== true) return false;
    const rMkt = String(r.execMarket || r.market || '').toUpperCase();
    if (sameMarketOnly && market && rMkt && rMkt !== market) return false;
    return clusterOf(r.symbol) === cluster;
  });
  const count = sameCluster.length;
  const wouldBlock = count >= Math.max(1, Number(maxPerCluster) || 1);
  return {
    filter: 'clusterGuard', mode: m, active: m !== 'off', cluster, count,
    maxPerCluster: Math.max(1, Number(maxPerCluster) || 1),
    firstCount: sameCluster.length + 1,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    openSymbols: sameCluster.map(r => r.symbol).filter(Boolean).slice(0, 8),
    reason: wouldBlock
      ? `${cluster} cluster already has ${count}/${maxPerCluster} open (${sameCluster.map(r => r.symbol).filter(Boolean).slice(0, 4).join(', ') || '—'})`
      : null,
  };
}

// ------------------------------------------------------------
// R5 — regime filter
// ------------------------------------------------------------
export const REGIMES = Object.freeze(['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL', 'UNKNOWN']);

export function regimeOf(row = {}) {
  const explicit = String(row.regime?.label ?? row.regime ?? row.context?.regime ?? '').trim().toUpperCase();
  const aliases = {
    BULL: 'TREND_UP', BULLISH: 'TREND_UP', UPTREND: 'TREND_UP', TREND_UP: 'TREND_UP',
    BEAR: 'TREND_DOWN', BEARISH: 'TREND_DOWN', DOWNTREND: 'TREND_DOWN', TREND_DOWN: 'TREND_DOWN',
    RANGE: 'CHOP', RANGING: 'CHOP', SIDEWAYS: 'CHOP', CHOP: 'CHOP', CHOPPY: 'CHOP',
    VOLATILE: 'HIGH_VOL', HIGH_VOL: 'HIGH_VOL', HIGHVOL: 'HIGH_VOL', EXPANSION: 'HIGH_VOL',
  };
  if (aliases[explicit]) return aliases[explicit];
  const dir = Number(row.context?.dir ?? row.dir ?? row.triggerDir);
  if (Number.isFinite(dir) && dir !== 0) return dir > 0 ? 'TREND_UP' : 'TREND_DOWN';
  const atrPct = Number(row.context?.atrPct ?? row.atrPct);
  if (Number.isFinite(atrPct) && atrPct >= 2.5) return 'HIGH_VOL';
  return 'UNKNOWN';
}

export function evaluateRegimeFilter({
  row = {}, side = null, mode = 'shadow', blockChop = true, blockHighVol = false,
} = {}) {
  const m = normalizeGuardMode(mode);
  const regime = regimeOf(row);
  const s = normalizeSide(side ?? row.side);
  const reasons = [];
  if (s === 'LONG' && regime === 'TREND_DOWN') reasons.push(`LONG against ${regime}`);
  if (s === 'SHORT' && regime === 'TREND_UP') reasons.push(`SHORT against ${regime}`);
  if (regime === 'CHOP' && blockChop) reasons.push('CHOP regime — no directional follow-through');
  if (regime === 'HIGH_VOL' && blockHighVol) reasons.push('HIGH_VOL regime — entry veto enabled');
  const wouldBlock = reasons.length > 0;
  return {
    filter: 'regimeFilter', mode: m, active: m !== 'off', regime, side: s,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock ? reasons[0] : null, reasons,
  };
}

// ------------------------------------------------------------
// R6 — perp derivatives veto
// ------------------------------------------------------------
export function evaluatePerpVeto({
  side = null, market = 'FUTURES', fundingBps8h = null, longShortRatio = null,
  basisPct = null, mode = 'shadow', fundingVetoBps = 30, ratioVeto = 3, basisVetoPct = 1,
} = {}) {
  const m = normalizeGuardMode(mode);
  const s = normalizeSide(side);
  const mkt = String(market || '').toUpperCase();
  const applicable = mkt === 'FUTURES' || mkt === 'CRYPTO' || mkt === 'PERP' || mkt === 'PERPS';
  const reasons = [];
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const funding = num(fundingBps8h);
  const ratio = num(longShortRatio);
  const basis = num(basisPct);
  if (applicable && s) {
    if (funding != null) {
      if (s === 'LONG' && funding >= fundingVetoBps) reasons.push(`funding +${funding}bps ≥ ${fundingVetoBps}bps — longs overcrowded`);
      if (s === 'SHORT' && funding <= -fundingVetoBps) reasons.push(`funding ${funding}bps ≤ -${fundingVetoBps}bps — shorts overcrowded`);
    }
    if (ratio != null && ratio > 0) {
      if (s === 'LONG' && ratio >= ratioVeto) reasons.push(`long/short ${ratio} ≥ ${ratioVeto} — crowded long`);
      if (s === 'SHORT' && ratio <= 1 / ratioVeto) reasons.push(`long/short ${ratio} ≤ ${(1 / ratioVeto).toFixed(3)} — crowded short`);
    }
    if (basis != null) {
      if (s === 'LONG' && basis >= basisVetoPct) reasons.push(`basis +${basis}% ≥ ${basisVetoPct}% — perp premium`);
      if (s === 'SHORT' && basis <= -basisVetoPct) reasons.push(`basis ${basis}% ≤ -${basisVetoPct}% — perp discount`);
    }
  }
  const wouldBlock = reasons.length > 0;
  return {
    filter: 'perpVeto', mode: m, active: m !== 'off', applicable, side: s,
    fundingBps8h: funding, longShortRatio: ratio, basisPct: basis,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock ? reasons[0] : null, reasons,
  };
}

// ------------------------------------------------------------
// R4 — event + session filter
// ------------------------------------------------------------
const IST_OFFSET_MIN = 330;
const MINUTE_MS = 60_000;

function minutesOfDayUtc(now) {
  const d = new Date(now);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Session micro-windows where impulse/liquidity is abnormal. */
export function sessionWindowsFor(desk, now = Date.now()) {
  const d = String(desk || '').toUpperCase();
  if (d === 'INDIA') {
    const ist = (minutesOfDayUtc(now) + IST_OFFSET_MIN) % (24 * 60);
    return [
      { key: 'NSE_OPEN', label: 'NSE open 09:15–09:30 IST', from: 9 * 60 + 15, to: 9 * 60 + 30, minutes: ist },
      { key: 'NSE_CLOSE', label: 'NSE close 15:15–15:30 IST', from: 15 * 60 + 15, to: 15 * 60 + 30, minutes: ist },
    ];
  }
  if (d === 'CRYPTO' || d === 'FUTURES' || !d) {
    const utc = minutesOfDayUtc(now);
    return [0, 8, 16].map(h => ({
      key: `FUNDING_${h}`, label: `${String(h).padStart(2, '0')}:00 UTC funding ±5m`,
      from: h * 60 - 5, to: h * 60 + 5, minutes: utc,
    }));
  }
  return [];
}

export function evaluateEventSessionFilter({
  now = Date.now(), desk = 'CRYPTO', mode = 'shadow',
  eventCheck = null, sessions = true,
} = {}) {
  const m = normalizeGuardMode(mode);
  const reasons = [];
  let event = null;
  if (eventCheck && String(eventCheck.action || '').toLowerCase() === 'blackout') {
    event = eventCheck.event || null;
    reasons.push(eventCheck.reason || 'event blackout');
  } else if (eventCheck?.event) {
    event = eventCheck.event;
  }
  const windows = sessions ? sessionWindowsFor(desk, now) : [];
  const hit = windows.find(w => w.minutes >= w.from && w.minutes < w.to);
  if (hit) reasons.push(`${hit.label} — session micro-window`);
  const wouldBlock = reasons.length > 0;
  return {
    filter: 'eventSessionFilter', mode: m, active: m !== 'off',
    desk: String(desk || '').toUpperCase(), event, session: hit ? hit.key : null,
    haircutMultiplier: eventCheck?.action === 'haircut' ? Number(eventCheck.multiplier) || null : null,
    wouldBlock, blocked: m === 'enforce' && wouldBlock, shadow: m === 'shadow',
    reason: wouldBlock ? reasons[0] : null, reasons,
  };
}

// ------------------------------------------------------------
// R7 — score calibration from settled rows
// ------------------------------------------------------------
export const DEFAULT_CALIBRATION_EDGES = Object.freeze([75, 80, 85, 90, 95, 101]);

export function buildScoreCalibration(rows = [], {
  minN = 30, edges = DEFAULT_CALIBRATION_EDGES,
} = {}) {
  const cleanEdges = (Array.isArray(edges) ? edges : DEFAULT_CALIBRATION_EDGES)
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const useEdges = cleanEdges.length >= 2 ? cleanEdges : [...DEFAULT_CALIBRATION_EDGES];
  const buckets = [];
  for (let i = 0; i < useEdges.length - 1; i += 1) {
    buckets.push({
      lo: useEdges[i], hi: useEdges[i + 1],
      label: `${useEdges[i]}–${useEdges[i + 1] - 1}`,
      n: 0, wins: 0, losses: 0, pnlSum: 0, rSum: 0, rN: 0,
    });
  }
  let settled = 0;
  let wins = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const st = String(r.status || '').toUpperCase();
    if (st !== 'CLOSED') continue;
    const score = Number(r.score ?? r.superScore ?? r.aiScore);
    if (!(score >= 0 && score <= 100)) continue;
    const pnl = Number(r.pnl);
    const hasPnl = Number.isFinite(pnl);
    const explicitWin = typeof r.win === 'boolean' ? r.win : null;
    if (!hasPnl && explicitWin == null) continue;
    const win = explicitWin != null ? explicitWin : pnl > 0;
    settled += 1;
    if (win) wins += 1;
    const b = buckets.find(x => score >= x.lo && score < x.hi);
    if (!b) continue;
    b.n += 1;
    if (win) b.wins += 1; else b.losses += 1;
    if (hasPnl) b.pnlSum += pnl;
    const risk = Number(r.riskINR ?? r.riskAmount ?? r.risk);
    if (hasPnl && Number.isFinite(risk) && risk > 0) { b.rSum += pnl / risk; b.rN += 1; }
  }
  const min = Math.max(1, Number(minN) || 30);
  const finalized = buckets.map(b => ({
    ...b,
    winRate: b.n > 0 ? Math.round((b.wins / b.n) * 1000) / 10 : null,
    avgPnl: b.n > 0 ? Math.round((b.pnlSum / b.n) * 100) / 100 : null,
    expectancyR: b.rN > 0 ? Math.round((b.rSum / b.rN) * 100) / 100 : null,
    sufficient: b.n >= min,
  }));
  return {
    ok: true, minN: min, settled,
    overall: {
      n: settled, wins,
      winRate: settled > 0 ? Math.round((wins / settled) * 1000) / 10 : null,
      sufficient: settled >= min,
    },
    buckets: finalized,
    sufficient: finalized.some(b => b.sufficient),
  };
}

export function applyScoreCalibration({
  score = null, calibration = null, minN = 30, minWinRate = 55,
} = {}) {
  if (score == null || score === '') {
    return { applied: false, sufficient: false, bucket: null, n: 0, winRate: null, calibratedWinProb: null, wouldBlock: false, reason: 'no-score' };
  }
  const s = Number(score);
  if (!(s >= 0 && s <= 100)) {
    return { applied: false, sufficient: false, bucket: null, n: 0, winRate: null, calibratedWinProb: null, wouldBlock: false, reason: 'no-score' };
  }
  const min = Math.max(1, Number(minN) || 30);
  const buckets = Array.isArray(calibration?.buckets) ? calibration.buckets : [];
  const bucket = buckets.find(b => s >= Number(b.lo) && s < Number(b.hi)) || null;
  const n = Number(bucket?.n) || 0;
  const wr = bucket?.winRate == null ? null : Number(bucket.winRate);
  const sufficient = Boolean(bucket && n >= min && wr != null);
  const wouldBlock = sufficient && wr < Number(minWinRate);
  return {
    applied: sufficient,
    sufficient,
    bucket: bucket ? bucket.label : null,
    n,
    winRate: wr,
    calibratedWinProb: sufficient ? wr : null,
    minN: min,
    minWinRate: Number(minWinRate),
    wouldBlock,
    reason: !bucket ? 'no-bucket'
      : !sufficient ? `insufficient bucket n=${n}/${min}`
        : wouldBlock ? `calibrated win-rate ${wr}% < ${minWinRate}% (n=${n})`
          : null,
  };
}

export function evaluateScoreCalibrationGate({
  row = {}, closedRows = [], mode = 'off', minN = 30, minWinRate = 55,
  calibration = null,
} = {}) {
  const m = normalizeGuardMode(mode, 'off');
  const cal = calibration || buildScoreCalibration(closedRows, { minN });
  const score = Number(row.superScore ?? row.score ?? row.aiScore);
  const applied = applyScoreCalibration({ score, calibration: cal, minN, minWinRate });
  return {
    filter: 'scoreCalibration', mode: m, active: m !== 'off', score: Number.isFinite(score) ? score : null,
    ...applied,
    blocked: m === 'enforce' && applied.wouldBlock,
    shadow: m === 'shadow',
    note: m === 'off'
      ? 'calibration OFF — raw score decides'
      : (applied.sufficient ? 'calibrated bucket available' : 'insufficient per-bucket n — raw score decides'),
  };
}

// ------------------------------------------------------------
// R3 — reversal guard v2 (exit side)
// ------------------------------------------------------------
function candleDirectionClass(closedCandles, isLong) {
  if (!Array.isArray(closedCandles) || closedCandles.length < 2) return null;
  const bars = closedCandles.filter(c => Number(c?.close) > 0);
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const o = Number(last.open);
  const c = Number(last.close);
  const pc = Number(prev.close);
  if (!(Number.isFinite(o) && Number.isFinite(c) && Number.isFinite(pc))) return null;
  const against = isLong ? (c < o && c < pc) : (c > o && c > pc);
  return {
    key: 'closed-bar-against',
    detail: `${isLong ? 'bearish' : 'bullish'} closed bar ${c} ${isLong ? '<' : '>'} ${isLong ? 'open' : 'open'} + prev close`,
    against,
  };
}

function structureBreakClass(closedCandles, ltp, isLong) {
  if (!Array.isArray(closedCandles) || closedCandles.length < 5 || !(ltp > 0)) return null;
  const bars = closedCandles.filter(c => Number(c?.high) > 0 && Number(c?.low) > 0).slice(-10);
  if (bars.length < 5) return null;
  const low = Math.min(...bars.map(c => Number(c.low)));
  const high = Math.max(...bars.map(c => Number(c.high)));
  const against = isLong ? ltp < low : ltp > high;
  return {
    key: 'structure-break',
    detail: isLong ? `price ${ltp} < ${bars.length}-bar swing low ${low}` : `price ${ltp} > ${bars.length}-bar swing high ${high}`,
    against,
  };
}

/**
 * R3 — tiered reversal detection. A class only counts when its evidence is
 * present (no fabricated classes from missing feeds):
 *   1. board flipped opposite + fired/score>=65
 *   2. last CLOSED bar closed against the position
 *   3. price broke the recent swing (10 closed bars)
 *   4. exhaustion hint + deep giveback (>= 0.5R from peak)
 * Tier: 1 → tighten, 2 → reduce request, 3+ → exit.
 *
 * LIVE enforce is gated: without `liveEnabled` the guard stays shadow (the
 * existing fee-safe reversal exit keeps running). Paper can enforce after
 * an explicit operator flip.
 */
export function evaluateReversalGuardV2({
  side = null, entry = 0, stopLoss = 0, ltp = 0, peakPrice = 0, risk = 0,
  tp1Hit = false, tp2Hit = false, boardFlipped = false, reversalRiskHint = false,
  closedCandles = null, mode = 'shadow', executionMode = 'PAPER', liveEnabled = false,
  feeCovered = true, givebackR = 0.5, lockR = 0.75, reducePct = 50,
} = {}) {
  const m = normalizeGuardMode(mode);
  const s = normalizeSide(side);
  const isLong = s === 'LONG';
  const riskV = Math.max(1e-8, Number(risk) || Math.abs(Number(entry) - Number(stopLoss)) || 0);
  const peak = Number(peakPrice) > 0 ? Number(peakPrice) : Number(entry) || 0;
  const price = Number(ltp) > 0 ? Number(ltp) : peak;
  const peakR = riskV > 0 ? (isLong ? peak - Number(entry) : Number(entry) - peak) / riskV : 0;
  const giveback = riskV > 0 ? (isLong ? peak - price : price - peak) / riskV : 0;
  const classes = [];
  if (s) {
    if (boardFlipped) classes.push({ key: 'board-flip', detail: 'board flipped opposite side and fired' });
    const bar = candleDirectionClass(closedCandles, isLong);
    if (bar?.against) classes.push(bar);
    const structure = structureBreakClass(closedCandles, price, isLong);
    if (structure?.against) classes.push(structure);
    if (reversalRiskHint && peakR >= 0.75 && giveback >= givebackR) {
      classes.push({ key: 'exhaustion-giveback', detail: `exhaustion hint + ${giveback.toFixed(2)}R giveback from peak` });
    }
  }
  const classCount = classes.length;
  const tier = classCount >= 3 ? 3 : classCount === 2 ? 2 : classCount === 1 ? 1 : 0;
  const tierLabel = ['NONE', 'TIGHTEN', 'REDUCE', 'CLOSE'][tier];
  const liveGated = m === 'enforce' && String(executionMode).toUpperCase() === 'LIVE' && liveEnabled !== true;
  const applied = m === 'enforce' && tier > 0 && !liveGated;
  const floor = Number(stopLoss) > 0 ? Number(stopLoss) : 0;
  const lockPrice = peakR >= 0.15
    ? (isLong ? peak - lockR * riskV : peak + lockR * riskV)
    : 0;
  const proposed = lockPrice > 0
    ? (isLong ? Math.max(floor || lockPrice, lockPrice) : Math.min(floor || lockPrice, lockPrice))
    : floor;
  const tightenSl = proposed > 0 ? +proposed.toFixed(6) : null;
  const wouldExit = tier >= 3;
  const shouldExit = applied && wouldExit && (!(String(executionMode).toUpperCase() === 'LIVE') || feeCovered);
  return {
    filter: 'reversalGuardV2', mode: m, active: m !== 'off', side: s,
    tp1Hit: tp1Hit === true, tp2Hit: tp2Hit === true,
    classCount, classes, tier, tierLabel,
    peakR: +peakR.toFixed(2), givebackR: +giveback.toFixed(2),
    wouldTighten: tier >= 1, wouldReduce: tier >= 2, wouldExit,
    shouldTighten: applied && tier >= 1,
    shouldReduce: applied && tier >= 2,
    reducePct: applied && tier >= 2 ? reducePct : 0,
    shouldExit,
    tightenSl,
    liveGated,
    applied,
    shadow: m === 'shadow',
    reason: classCount === 0 ? null : classes.map(c => c.key).join(' + '),
    note: m === 'off'
      ? 'RV2 OFF — legacy reversal logic decides'
      : liveGated
        ? 'RV2 ENFORCE requested but LIVE gate is closed (liveEnabled=false) — shadow only'
        : m === 'shadow'
          ? 'RV2 SHADOW — telemetry only; legacy reversal logic decides'
          : `RV2 ENFORCE — tier ${tier} (${tierLabel})`,
  };
}

// ------------------------------------------------------------
// R8 — runner after TP2 + stall exit
// ------------------------------------------------------------
export function evaluateRunnerAfterTp2({
  mode = 'off', executionMode = 'PAPER', liveRunner = false, liveTp1Partial = false,
  liveSafeReduce = false, liveOrderIdempotency = false,
  tp2Hit = false, side = null, entry = 0, tp1 = 0, risk = 0, peakPrice = 0, ltp = 0,
  trailR = 0.75, runnerQtyPct = 25, remainingQtyPct = null,
} = {}) {
  const m = normalizeGuardMode(mode, 'off');
  const s = normalizeSide(side);
  const isLong = s === 'LONG';
  const riskV = Math.max(1e-8, Number(risk) || 0);
  const peak = Number(peakPrice) > 0 ? Number(peakPrice) : Number(entry) || 0;
  const price = Number(ltp) > 0 ? Number(ltp) : peak;
  const floor = Number(tp1) > 0 ? Number(tp1) : Number(entry) || 0;
  const rawTrail = peak > 0 && riskV > 0
    ? (isLong ? peak - trailR * riskV : peak + trailR * riskV)
    : 0;
  const trailSl = rawTrail > 0
    ? +(isLong ? Math.max(floor || rawTrail, rawTrail) : Math.min(floor || rawTrail, rawTrail)).toFixed(6)
    : null;
  // LIVE is reported gated until EVERY prerequisite is proven: the operator's
  // liveRunner + liveTp1Partial flags, R0 safe-reduce wiring, and R1 order
  // idempotency. The native exchange TP closes the full position, so a live
  // runner must stay shadow until those `[VERIFY-LIVE]` items are signed off.
  const liveReady = liveRunner === true && liveTp1Partial === true
    && liveSafeReduce === true && liveOrderIdempotency === true;
  const liveGated = String(executionMode).toUpperCase() === 'LIVE' && !liveReady;
  const applied = m === 'enforce' && tp2Hit && Boolean(s) && !liveGated;
  const trailHit = Boolean(applied && trailSl > 0 && (isLong ? price <= trailSl : price >= trailSl));
  const active = Boolean(applied && !trailHit);
  const remPct = Number(remainingQtyPct);
  const remaining = Number.isFinite(remPct) && remPct >= 0 ? Math.round(remPct * 10) / 10 : null;
  const rider = remaining != null ? `remaining ${remaining}%` : 'remaining position';
  return {
    filter: 'runnerAfterTp2', mode: m, active, applied, shadow: m === 'shadow',
    liveGated, tp2Hit: tp2Hit === true, trailR, runnerQtyPct,
    remainingQtyPct: remaining,
    trailSl: active ? trailSl : null,
    shouldClose: trailHit,
    reason: trailHit ? `runner trail ${trailSl} hit at ${price}` : null,
    note: m === 'off'
      ? 'runner OFF — TP2 closes the full position'
      : liveGated
        ? 'runner LIVE gated (needs liveRunner + liveTp1Partial + R0 safe reduce + R1 idempotency) — TP2 still closes full'
        : m === 'shadow'
          ? `runner SHADOW — would hold the ${rider} with trail ${trailSl ?? '—'}`
          : (active ? `runner ACTIVE — ${rider} rides, trail ${trailSl}` : (trailHit ? 'runner TRAIL EXIT' : 'runner armed — waiting for TP2')),
  };
}

export function evaluateStallExit({
  mode = 'off', executionMode = 'PAPER', allowLive = false,
  openedAt = 0, now = Date.now(), stallMin = 45, peakR = 0, currentR = 0,
  t1Hit = false, tp2Hit = false, minPeakR = 0.25,
} = {}) {
  const m = normalizeGuardMode(mode, 'off');
  const ageMin = openedAt > 0 ? Math.max(0, (Number(now) - Number(openedAt)) / MINUTE_MS) : 0;
  const isLive = String(executionMode).toUpperCase() === 'LIVE';
  const liveGated = isLive && allowLive !== true;
  const stalled = ageMin >= Math.max(0, Number(stallMin) || 0)
    && !t1Hit && !tp2Hit && Number(peakR) < Number(minPeakR);
  const applied = m === 'enforce' && stalled && !liveGated && Number(stallMin) > 0;
  return {
    filter: 'stallExit', mode: m, active: applied, applied, shadow: m === 'shadow',
    liveGated, stalled, ageMin: Math.round(ageMin), currentR: Number(currentR) || 0,
    stallMin: Number(stallMin) || 0, minPeakR: Number(minPeakR),
    shouldExit: applied,
    reason: stalled ? `no progress: ${Math.round(ageMin)}m elapsed, peak ${Number(peakR).toFixed(2)}R < ${minPeakR}R, T1 not hit` : null,
    note: m === 'off'
      ? 'stall exit OFF'
      : liveGated
        ? 'stall exit LIVE gated (allowLive=false) — shadow/off'
        : m === 'shadow'
          ? (stalled ? 'stall exit SHADOW — would close' : 'stall exit SHADOW — trade progressing')
          : (applied ? 'stall exit ENFORCE — closing' : 'stall exit armed'),
  };
}

// ------------------------------------------------------------
// Entry-guard aggregator (R4/R5/R6/R7/R9)
// ------------------------------------------------------------
/**
 * Evaluate every entry-side guard for one candidate row. `blocked` is true
 * only when at least one filter is in ENFORCE and fired. Shadow observations
 * are returned separately so the caller can persist them as evidence.
 */
export function evaluateEntryGuards({
  cfg = {}, row = {}, openRows = [], closedRows = [], now = Date.now(),
  desk = null, eventCheck = null, calibration = null,
  clusterOf = correlationClusterOf,
} = {}) {
  const deskN = String(desk || row.execMarket || row.market || 'CRYPTO').toUpperCase();
  const eventSessionFilter = evaluateEventSessionFilter({
    now, desk: deskN, mode: cfg.eventSessionFilter, eventCheck,
    sessions: cfg.eventSessionFilterSessions !== false,
  });
  const regimeFilter = evaluateRegimeFilter({
    row, side: row.side, mode: cfg.regimeFilter,
    blockChop: cfg.regimeBlockChop !== false,
    blockHighVol: cfg.regimeBlockHighVol === true,
  });
  const perpVeto = evaluatePerpVeto({
    side: row.side,
    market: row.execMarket || row.market || (deskN === 'INDIA' ? 'INDIA' : 'FUTURES'),
    fundingBps8h: row.fundingBps8h ?? row.context?.fundingBps8h ?? row.funding?.bps8h ?? null,
    longShortRatio: row.longShortRatio ?? row.context?.longShortRatio ?? row.positioning?.longShortRatio ?? null,
    basisPct: row.basisPct ?? row.context?.basisPct ?? null,
    mode: cfg.perpVeto,
    fundingVetoBps: cfg.perpFundingVetoBps,
    ratioVeto: cfg.perpRatioVeto,
    basisVetoPct: cfg.perpBasisVetoPct,
  });
  const clusterGuard = evaluateClusterGuard({
    openRows, candidate: { symbol: row.symbol, market: row.market, execMarket: row.execMarket },
    maxPerCluster: cfg.clusterGuardMax, mode: cfg.clusterGuard, clusterOf,
    sameMarketOnly: cfg.clusterGuardSameMarketOnly !== false,
  });
  const scoreCalibration = evaluateScoreCalibrationGate({
    row, closedRows, mode: cfg.scoreCalibration,
    minN: cfg.calibrationMinN, minWinRate: cfg.calibrationMinWinProb,
    calibration,
  });
  const filters = { eventSessionFilter, regimeFilter, perpVeto, clusterGuard, scoreCalibration };
  const blockers = Object.values(filters)
    .filter(f => f.mode === 'enforce' && f.wouldBlock)
    .map(f => ({ filter: f.filter, reason: f.reason }));
  const shadowWarnings = Object.values(filters)
    .filter(f => f.mode === 'shadow' && f.wouldBlock)
    .map(f => ({ filter: f.filter, reason: f.reason }));
  return {
    ok: blockers.length === 0,
    blocked: blockers.length > 0,
    blockers,
    shadowWarnings,
    filters,
  };
}
