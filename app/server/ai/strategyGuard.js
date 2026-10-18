// ============================================================
// server/ai/strategyGuard.js — v21.1.0 (Phase-4: signal accuracy)
// ------------------------------------------------------------
// User-spec Phase-4 rules ka engine-side implementation:
//
//   1. PER-STRATEGY KILL RULE — har strategy (source×market) ka ROLLING
//      30-trade expectancy ledger se compute hota hai. n >= 30 AUR
//      rolling expectancy < 0 → wo strategy AUTO-PAUSE (naye entries
//      reject, honest reason ke saath). Expectancy wapas >= 0 hone par
//      strategy khud resume ho jaati hai (rolling window recompute).
//
//   2. GO-LIVE GATE — LIVE executions tabhi fire hongi jab PAPER
//      track-record qualify kare:
//        • settled paper trades >= GO_LIVE_MIN_TRADES (default 100)
//        • paper expectancy > GO_LIVE_MIN_EXPECTANCY_R (default 0 —
//          R already fees+slippage ke BAAD ka hai: partial legs fees
//          subtract karti hain, settlePositionOutcome net P&L use
//          karta hai)
//        • paper max-drawdown (R) <= GO_LIVE_MAX_DD_R (default 8)
//      Fail → LIVE reject with honest counters ("42/100 trades,
//      expectancy -0.12R — paper pe kaam karo"). Bot Lab ka apna
//      OOS-pWin LIVE gate (botRisk.validatedPWin) alag chalta rehta hai.
//
// Data source: ai-signal-ledger.json (tamper-evident, 400 entries) —
// relaxed entries (practice fills the engine never endorsed) EXCLUDED.
//
// TEST MODE HONESTY: vitest (process.env.VITEST) ke under go-live gate
// ENFORCE nahi karta — existing LIVE-path unit tests ledger seed na
// karke bhi apne contract test kar sakte hain. Dedicated gate tests
// __setGoLiveEnforceForTests(true) se enforce karke assert karte hain.
// Strategy kill rule data-driven hai (empty ledger → kuch paused nahi)
// isliye usko test mode me bhi ON hi rehne dete hain.
// ============================================================
import { __ledgerRaw } from './ledger.js';

// ---- tunables (env-mappable) ----
function _numEnv(name, def) {
  // v21.1.1 [audit A12]: empty string Number('')===0 footgun — stray
  // `STRATEGY_KILL_WINDOW=` export window 0 kar deta tha (rule silently
  // disabled). Ab sirf non-empty, finite, POSITIVE values override karte
  // hain; warna default.
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}
export const KILL_RULE = {
  window: _numEnv('STRATEGY_KILL_WINDOW', 30),          // rolling trades
  minTrades: _numEnv('STRATEGY_KILL_MIN_TRADES', 30),   // itne settled hone hi chahiye
  maxExpectancy: _numEnv('STRATEGY_KILL_EXPECTANCY', 0), // < ye → paused
};
// v21.1.1 [audit A12]: mismatch guard — window < minTrades ho to rule kabhi
  // trigger hi nahi hota (winR.length >= minTrades unreachable). Clamp karo
  // aur ek warning line do taaki silent-disable na ho.
if (KILL_RULE.minTrades > KILL_RULE.window) {
   
  console.warn(`[strategyGuard] STRATEGY_KILL_MIN_TRADES (${KILL_RULE.minTrades}) > STRATEGY_KILL_WINDOW (${KILL_RULE.window}) — window ko minTrades tak clamp kiya (warna rule silently disabled rehta)`);
  KILL_RULE.window = KILL_RULE.minTrades;
}
export const GO_LIVE = {
  minTrades: _numEnv('GO_LIVE_MIN_TRADES', 100),
  minExpectancyR: _numEnv('GO_LIVE_MIN_EXPECTANCY_R', 0),
  maxDrawdownR: _numEnv('GO_LIVE_MAX_DD_R', 8),
};

// ---- go-live enforcement flag (test honesty) ----
let _goLiveEnforce = process.env.VITEST
  ? false
  : String(process.env.GO_LIVE_ENFORCE || '1') === '1';
export function goLiveEnforced() { return _goLiveEnforce; }
export function __setGoLiveEnforceForTests(v) { _goLiveEnforce = !!v; }

// ---- telegram notify (pause transitions) ----
const _pauseNotifiedAt = {}; // strategyKey -> epoch (1h throttle)
async function _notifyPause(key, reason) {
  try {
    const now = Date.now();
    if (now - (_pauseNotifiedAt[key] || 0) < 3600_000) return;
    _pauseNotifiedAt[key] = now;
    const { sendTelegramMessage, telegramConfig } = await import('./secrets.js');
    const tg = typeof telegramConfig === 'function' ? (telegramConfig() || {}) : {};
    await sendTelegramMessage(`🛑 STRATEGY PAUSED: ${key} — rolling ${KILL_RULE.window}-trade expectancy negative (${reason}). LIVE entries reject ho rahe hain (paper continue — window refresh hota rahega); expectancy recover hone par auto-resume.`, { token: tg.token || process.env.TG_TOKEN || '', chatId: tg.chatId || process.env.TG_CHAT_ID || '' });
  } catch { /* best-effort */ }
}

// ---- core stats ----
/** Settled (non-relaxed) ledger entries, newest last. */
function _settled() {
  const l = __ledgerRaw();
  return (l.entries || []).filter(e => e && e.outcome && e.outcome.r != null && !e.relaxed);
}

/** Per-strategy (source×market) rolling stats + paused verdict. */
export function strategyHealth() {
  const settled = _settled();
  const byKey = new Map();
  for (const e of settled) {
    const key = `${e.source || 'manual'}:${e.market || 'CRYPTO'}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const strategies = [];
  for (const [key, rows] of byKey) {
    // newest-first for the rolling window
    const sorted = rows.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const allR = sorted.map(e => Number(e.outcome.r) || 0);
    const winRateAll = allR.length ? allR.filter(r => r > 0).length / allR.length : null;
    const expectancyAll = allR.length ? allR.reduce((s, r) => s + r, 0) / allR.length : null;

    const winR = allR.slice(0, KILL_RULE.window);
    const winRate = winR.length ? winR.filter(r => r > 0).length / winR.length : null;
    const expectancy = winR.length ? winR.reduce((s, r) => s + r, 0) / winR.length : null;

    const paused = winR.length >= KILL_RULE.minTrades && expectancy != null && expectancy < KILL_RULE.maxExpectancy;
    if (paused) _notifyPause(key, `expectancy ${expectancy.toFixed(2)}R over last ${winR.length}`).catch(() => {});
    strategies.push({
      strategy: key,
      n: allR.length,
      winRate: winRateAll != null ? Math.round(winRateAll * 1000) / 10 : null,
      expectancyR: expectancyAll != null ? Math.round(expectancyAll * 1000) / 1000 : null,
      rolling: {
        window: KILL_RULE.window,
        n: winR.length,
        winRate: winRate != null ? Math.round(winRate * 1000) / 10 : null,
        expectancyR: expectancy != null ? Math.round(expectancy * 1000) / 1000 : null,
      },
      paused,
    });
  }
  return { strategies: strategies.sort((a, b) => b.n - a.n), killRule: KILL_RULE };
}

/** Is this strategy currently paused? (rolling negative expectancy) */
export function strategyGuardBlocked(source, market) {
  try {
    const key = `${source || 'manual'}:${market || 'CRYPTO'}`;
    const h = strategyHealth();
    const row = h.strategies.find(s => s.strategy === key);
    if (!row || !row.paused) return { blocked: false };
    return {
      blocked: true,
      reason: `Strategy ${key} AUTO-PAUSED — rolling ${KILL_RULE.window}-trade expectancy ${row.rolling.expectancyR}R negative (winRate ${row.rolling.winRate}%, n=${row.rolling.n}/${KILL_RULE.minTrades}). LIVE entries blocked; paper chalta rahega. Expectancy recover hone par auto-resume.`,
    };
  } catch { return { blocked: false }; } // guard must never break trading flow
}

/** Go-live readiness from PAPER track record (settled, non-relaxed). */
export function paperReadiness() {
  const paper = _settled().filter(e => String(e.mode || 'paper') === 'paper');
  // ts-sorted R sequence (drawdown walk ke liye order matters)
  const rows = paper.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(e => Number(e.outcome.r) || 0);
  const n = rows.length;
  const wins = rows.filter(r => r > 0).length;
  const winRate = n > 0 ? Math.round((wins / n) * 1000) / 10 : null;
  const expectancy = n > 0 ? Math.round((rows.reduce((s, r) => s + r, 0) / n) * 1000) / 1000 : null;

  // max drawdown in R-units (running-equity walk)
  let equity = 0, peak = 0, maxDD = 0;
  for (const r of rows) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const reasons = [];
  if (n < GO_LIVE.minTrades) reasons.push(`settled paper trades ${n}/${GO_LIVE.minTrades} (GO_LIVE_MIN_TRADES)`);
  if (expectancy == null || expectancy <= GO_LIVE.minExpectancyR) reasons.push(`paper expectancy ${expectancy ?? 'n/a'}R <= ${GO_LIVE.minExpectancyR}R (GO_LIVE_MIN_EXPECTANCY_R)`);
  if (maxDD > GO_LIVE.maxDrawdownR) reasons.push(`paper max drawdown ${maxDD.toFixed(1)}R > ${GO_LIVE.maxDrawdownR}R (GO_LIVE_MAX_DD_R)`);

  return {
    ready: reasons.length === 0,
    reasons,
    stats: {
      settledPaperTrades: n,
      winRate,
      expectancyR: expectancy,
      maxDrawdownR: Math.round(maxDD * 100) / 100,
      netR: Math.round(rows.reduce((s, r) => s + r, 0) * 100) / 100,
    },
    thresholds: GO_LIVE,
    enforced: goLiveEnforced(),
  };
}

/** LIVE execution gate — reject when paper track-record doesn't qualify. */
export function goLiveGateBlocked() {
  if (!goLiveEnforced()) return { blocked: false };
  try {
    const p = paperReadiness();
    if (p.ready) return { blocked: false };
    return {
      blocked: true,
      reason: `GO-LIVE GATE: paper track-record qualify nahi kar raha — ${p.reasons.join(' · ')}. LIVE locked hai jab tak ye criteria clear nahi hote (env: GO_LIVE_MIN_TRADES/GO_LIVE_MIN_EXPECTANCY_R/GO_LIVE_MAX_DD_R).`,
      readiness: p,
    };
  } catch { return { blocked: false }; } // never break the trading flow itself
}

/** Combined view for /api/ai/strategy-health. */
export function strategyHealthView() {
  return { ...strategyHealth(), goLive: paperReadiness(), enforced: goLiveEnforced() };
}
