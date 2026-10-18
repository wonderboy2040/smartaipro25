// ============================================================
// server/ai/mtfLedger.js — v21.24.0 MTF ROW LEDGER + DIRECTION
// SCORECARD (audit/direction-guards Phase 3)
// ------------------------------------------------------------
// AUDIT PROBLEM: "95% accurate" jaise claims ke piche KOI measured
// direction-accuracy number nahi tha. Board rows outcomes me resolve hi
// nahi hote the. Ye module Phase-3 harness deta hai:
//
//   1. logMtfRows({ market, mode, rows }) — har board scan ke top rows
//      ledger me append (dedupe per symbol+mode+30m). Caller: routes.js
//      /api/ai/mtf-dual/board. Storage: mtf-row-ledger.json (lib/store,
//      atomic + SMARTAI_DATA_DIR test override).
//
//   2. resolvePendingMtfRows({ candlesFor }) — har unresolved row ko
//      5m candles se walk karke resolve karta hai:
//        T1-hit / SL-hit / TIMEOUT + MFE/MAE (R) + directionHit
//        (side ki taraf 0.5R pehle aaya ya SL-side 0.5R pehle).
//      candlesFor(symbol, tf, market) caller deta hai (routes loop
//      rawTfCandles pass karta hai).
//
//   3. computeDirectionScorecard(rows) — PURE stats: tier × side ke
//      liye directionHitRate, T1 hit %, avgR, SL-first %, WRONG-WAY
//      rate (SL pehle + price opposite ≥1R), conflict bucket.
//
//   4. getCachedDirectionScorecard() — board payload me embed hone
//      wala 5-min cached snapshot.
//
// HONESTY: n<30 par "insufficient data" — chhote sample pe koi % claim
// nahi. Ye win-rate PROOF nahi, MEASUREMENT hai.
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';

const LEDGER_FILE = 'mtf-row-ledger.json';
export const MTF_LEDGER_MAX_ROWS = 3000;
export const MTF_LEDGER_DEDUPE_MS = 30 * 60_000; // same symbol+mode → 30m
export const SCORECARD_MIN_N = 30;
const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

function _load() {
  return loadJSON(LEDGER_FILE, { rows: [], lastLogAt: null, lastResolveAt: null });
}
function _save(d) {
  if ((d.rows || []).length > MTF_LEDGER_MAX_ROWS) d.rows = d.rows.slice(-MTF_LEDGER_MAX_ROWS);
  return saveJSON(LEDGER_FILE, d);
}

// ------------------------------------------------------------
// 1) LOG — board scan rows → ledger (dedupe + bounded)
// ------------------------------------------------------------
/** @param {{market?: string, mode?: string, rows?: Array}} p */
export function logMtfRows({ market = 'CRYPTO', mode = 'INTRADAY', rows = [] } = {}) {
  try {
    const d = _load();
    const list = d.rows || [];
    const lastBy = new Map(); // `${market}:${mode}:${symbol}` → ts
    for (const r of list) {
      const k = `${r.market}:${r.mode}:${r.symbol}`;
      if (!lastBy.has(k) || r.ts > lastBy.get(k)) lastBy.set(k, r.ts);
    }
    const now = Date.now();
    let added = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || row.ok === false) continue;
      const sym = String(row.symbol || '').toUpperCase();
      if (!sym) continue;
      const k = `${String(market).toUpperCase()}:${String(mode).toUpperCase()}:${sym}`;
      const last = lastBy.get(k) || 0;
      if (now - last < MTF_LEDGER_DEDUPE_MS) continue; // dedupe
      const rec = {
        id: `${k}:${now}`,
        ts: now,
        market: String(market).toUpperCase(),
        mode: String(mode).toUpperCase(),
        symbol: sym,
        side: row.side ?? null,
        superScore: Number.isFinite(Number(row.superScore)) ? Number(row.superScore) : null,
        tier: row.tier ?? row.scoreBand ?? null,
        directionVerified: !!row.directionVerified,
        boardSide: row.boardSide ?? row.signals?.board?.side ?? null,
        boardSideConflict: !!row.boardSideConflict,
        svaAction: row.aiAgents?.svaAction ?? null,
        holdMin: Number.isFinite(Number(row.holdMin)) ? Number(row.holdMin) : null,
        entry: Number(row.plan?.entry) || null,
        stopLoss: Number(row.plan?.stopLoss) || null,
        t1: Number(row.plan?.t1) || null,
        t2: Number(row.plan?.t2) || null,
        netRR: row.plan?.netRR ?? null,
        pWinCalibrated: Number.isFinite(Number(row.pWinCalibrated)) ? Number(row.pWinCalibrated) : null,
        autoEligible: !!row.autoEligible,
        outcome: null, // resolvePendingMtfRows bharega
      };
      list.push(rec);
      lastBy.set(k, now);
      added++;
    }
    d.rows = list;
    d.lastLogAt = now;
    _save(d);
    return { added, total: d.rows.length, ok: true };
  } catch {
    return { added: 0, total: 0, ok: false };
  }
}

// ------------------------------------------------------------
// 2) RESOLVE — outcome walk on 5m candles (T1 / SL / TIMEOUT + MFE/MAE)
// ------------------------------------------------------------
/**
 * Ek row ka outcome candles se compute karta hai. PURE.
 * @param {object} rec ledger row (entry/sl/t1/side/ts/holdMin ke saath)
 * @param {Array}  candles 5m candles AFTER rec.ts (time/high/low/close)
 */
export function resolveRowOutcome(rec, candles) {
  const side = String(rec.side || '').toUpperCase();
  const entry = Number(rec.entry), sl = Number(rec.stopLoss), t1 = Number(rec.t1);
  const risk = Math.abs(entry - sl);
  if (!(entry > 0) || !(sl > 0) || !(risk > 0) || (side !== 'LONG' && side !== 'SHORT')) return null;
  const bars = Array.isArray(candles) ? candles : [];
  if (!bars.length) return null;
  const holdMs = Math.max(5, Number(rec.holdMin) || 45) * 60_000;
  const endTs = rec.ts + holdMs;
  let mfe = 0, mae = 0, hit = null, hitAt = null;
  for (const c of bars) {
    const t = Number(c?.time ?? c?.t ?? 0);
    if (t < rec.ts) continue;
    if (t > endTs) break;
    const hi = Number(c?.high), lo = Number(c?.low);
    const favPx = side === 'LONG' ? (Number.isFinite(hi) ? hi : null) : (Number.isFinite(lo) ? lo : null);
    const advPx = side === 'LONG' ? (Number.isFinite(lo) ? lo : null) : (Number.isFinite(hi) ? hi : null);
    if (favPx != null) mfe = Math.max(mfe, (side === 'LONG' ? favPx - entry : entry - favPx) / risk);
    if (advPx != null) mae = Math.max(mae, (side === 'LONG' ? entry - advPx : advPx - entry) / risk);
    if (hit == null) {
      const t1Hit = t1 > 0 && (side === 'LONG' ? hi >= t1 : lo <= t1);
      const slHit = side === 'LONG' ? lo <= sl : hi >= sl;
      if (slHit) { hit = 'SL'; hitAt = t; break; } // conservative: SL pehle (gap-through honesty)
      if (t1Hit) { hit = 'T1'; hitAt = t; break; }
    }
  }
  if (hit == null && mfe === 0 && mae === 0) return null; // window me data hi nahi
  const timeout = hit == null;
  // directionHit: side ki taraf 0.5R move, SL-side 0.5R se PEHLE aaya kya?
  // Candle-order conservative: dono same candle me ho to adverse-first mana jata hai.
  const directionHit = mfe >= 0.5 && mae < 0.5;
  const wrongWay = hit === 'SL' && mae >= 1; // SL hit + price opposite ≥1R gaya
  const rEst = hit === 'T1'
    ? (Number(rec.netRR?.t1) > 0 ? Number(rec.netRR.t1) : Math.abs(t1 - entry) / risk)
    : hit === 'SL' ? -1
      : timeout ? r2(mfe * 0.5) : 0;
  return {
    hit: hit || 'TIMEOUT',
    hitAt, timeout,
    mfeR: r2(mfe), maeR: r2(mae),
    directionHit, wrongWay,
    r: r2(rEst),
    resolvedAt: Date.now(),
  };
}

/**
 * Pending rows resolve karta hai (caller candlesFor deta hai —
 * routes loop rawTfCandles/rawTfCandlesUsdt bind karke deta hai).
 * @param {{candlesFor?: Function, max?: number, now?: number}} p
 */
export function resolvePendingMtfRows({ candlesFor, max = 60, now = Date.now() } = {}) {
  if (typeof candlesFor !== 'function') return { resolved: 0, ok: false, error: 'candlesFor missing' };
  try {
    const d = _load();
    const pending = (d.rows || []).filter(r => !r.outcome && r.side && r.ts && now - r.ts > (Number(r.holdMin) || 45) * 60_000);
    let resolved = 0;
    for (const rec of pending.slice(-max)) {
      try {
        const candles = candlesFor(rec.symbol, '5m', rec.market);
        const out = resolveRowOutcome(rec, candles);
        if (out) { rec.outcome = out; resolved++; }
      } catch { /* individual row failure non-fatal */ }
    }
    d.lastResolveAt = now;
    if (resolved > 0) _save(d);
    return { resolved, ok: true };
  } catch {
    return { resolved: 0, ok: false };
  }
}

// ------------------------------------------------------------
// 3) SCORECARD — PURE stats
// ------------------------------------------------------------
/** rows (ledger) se direction scorecard. PURE. */
export function computeDirectionScorecard(rows, { windowDays = 30, now = Date.now() } = {}) {
  const cutoff = now - windowDays * 86_400_000;
  const inWin = (Array.isArray(rows) ? rows : []).filter(r => r && r.ts >= cutoff);
  const settled = inWin.filter(r => r.outcome);
  const group = (list) => {
    const n = list.length;
    if (!n) return { n: 0, directionHitRate: null, t1HitPct: null, slFirstPct: null, wrongWayPct: null, avgR: null, verdict: 'INSUFFICIENT DATA' };
    const dirHits = list.filter(r => r.outcome.directionHit).length;
    const t1 = list.filter(r => r.outcome.hit === 'T1').length;
    const sl = list.filter(r => r.outcome.hit === 'SL').length;
    const ww = list.filter(r => r.outcome.wrongWay).length;
    const rs = list.map(r => Number(r.outcome.r) || 0);
    const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    return {
      n,
      directionHitRate: Math.round((dirHits / n) * 100),
      t1HitPct: Math.round((t1 / n) * 100),
      slFirstPct: Math.round((sl / n) * 100),
      wrongWayPct: Math.round((ww / n) * 100),
      avgR: r2(avgR),
      verdict: n < SCORECARD_MIN_N ? 'INSUFFICIENT DATA' : 'MEASURED',
    };
  };
  const eliteStrong = settled.filter(r => r.tier === 'ELITE' || r.tier === 'STRONG' || (Number(r.superScore) || 0) >= 80);
  const conflictRows = settled.filter(r => r.boardSideConflict || (r.boardSide && r.side && r.boardSide !== r.side));
  return {
    ok: true,
    windowDays,
    generatedAt: now,
    overall: group(settled),
    eliteStrong: group(eliteStrong),
    conflictBucket: group(conflictRows),
    loggedRows: inWin.length,
    settledRows: settled.length,
    note: settled.length < SCORECARD_MIN_N
      ? `n=${settled.length} settled rows (min ${SCORECARD_MIN_N}) — accuracy claim ke liye insufficient data, accumulate hota rahega`
      : `${settled.length} settled rows window me — ELITE+STRONG direction hit ${group(eliteStrong).directionHitRate}%`,
  };
}

/** IO wrapper — ledger se scorecard. */
export function mtfDirectionScorecard({ windowDays = 30 } = {}) {
  try {
    const d = _load();
    return computeDirectionScorecard(d.rows || [], { windowDays });
  } catch {
    return { ok: false, windowDays, overall: { n: 0, verdict: 'NO DATA' }, note: 'ledger unavailable' };
  }
}

// ------------------------------------------------------------
// 4) CACHED snapshot — board payload embed (5-min TTL)
// ------------------------------------------------------------
let _scCache = { at: 0, val: null };
export function getCachedDirectionScorecard(windowDays = 30) {
  if (_scCache.val && Date.now() - _scCache.at < 5 * 60_000 && _scCache.val.windowDays === windowDays) return _scCache.val;
  const val = mtfDirectionScorecard({ windowDays });
  _scCache = { at: Date.now(), val };
  return val;
}

/** Ops view. */
export function mtfRowLedgerStatus() {
  try {
    const d = _load();
    const rows = d.rows || [];
    return {
      ok: true, total: rows.length,
      settled: rows.filter(r => r.outcome).length,
      pending: rows.filter(r => !r.outcome).length,
      lastLogAt: d.lastLogAt, lastResolveAt: d.lastResolveAt,
    };
  } catch { return { ok: false, total: 0 }; }
}

// ---------------- test hooks ----------------
export function __mtfLedgerRaw() { return _load(); }
export function __setMtfLedgerForTests(d) { _save(d || { rows: [], lastLogAt: null, lastResolveAt: null }); _scCache = { at: 0, val: null }; }
export function __resetScorecardCacheForTests() { _scCache = { at: 0, val: null }; }
