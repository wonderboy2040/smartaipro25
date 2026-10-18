// ============================================================
// intraday/journal — AUTO TRADE JOURNAL (Phase 2)
// ------------------------------------------------------------
// • recordTradeClose() — synchronous hook from paperTrading's
//   _closePart: every closed virtual trade becomes a journal
//   entry (no AI — pure data capture, zero cost).
// • runEodReview() — ONE batched AI review of the day's closed
//   trades (cron 15:45 IST) — what worked, what leaked, one fix.
// • runWeeklyReport() — aggregated improvement report (cron Fri
//   16:30 IST) with week-over-week stats + discipline scoring.
// • getJournal() — API read for the frontend journal panel.
// ============================================================
import { askLLM } from './agent.js';
import { istDayKey } from './time.js';
import { loadJSON, saveJSON } from './store.js';
// v10.3.1: encrypted durable mirror — the AI trade journal (EOD reviews,
// weekly reports, closed-trade entries) survives Render spin-downs now.
import { durablePut } from '../mcp/durable.js';

const FILE = 'trade-journal.json';
const MAX_ENTRIES = 800;

let _state = loadJSON(FILE, { entries: [], reviews: {}, weekly: {} });
let _saveTimer = null;

/** v10.3.1: durable boot-restore hook — _state was loaded at module-eval
 * time (before the pre-listen durable restore rehydrated the disk file).
 * Re-read so the EOD reviews + weekly reports survive restarts. */
export function __reloadJournalForBoot() { _state = loadJSON(FILE, { entries: [], reviews: {}, weekly: {} }); }

function _persist() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveJSON(FILE, _state);
    try { durablePut(FILE, _state); } catch { /* durable optional */ }
  }, 1500);
  if (typeof _saveTimer.unref === 'function') _saveTimer.unref();
}

/** v9.1: synchronous flush for graceful shutdown (see flushPaperState). */
export function flushJournalState() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  saveJSON(FILE, _state);
}

// ------------------------------------------------------------
// 1. Data capture — called by paperTrading on EVERY close path
//    (SL/T1/T2/trail/EOD/manual/stale). Synchronous, no AI.
// ------------------------------------------------------------
export function recordTradeClose(trade) {
  if (!trade || trade.status !== 'CLOSED') return;
  // De-dupe by trade id.
  if (_state.entries.some(e => e.tradeId === trade.id)) return;

  const holdMin = trade.openedAt && trade.closedAt
    ? Math.max(0, Math.round((trade.closedAt - trade.openedAt) / 60000)) : null;

  _state.entries.push({
    tradeId: trade.id,
    dayKey: trade.dayKey || istDayKey(),
    symbol: trade.symbol,
    direction: trade.direction,
    entry: trade.entry,
    qty: trade.qty,
    stopLoss: trade.stopLoss,
    target1: trade.target1,
    target2: trade.target2,
    closeReason: trade.closeReason || 'UNKNOWN',
    realizedPnl: +(trade.realizedPnl || 0).toFixed(2),
    // v11.1 GAP 3: the net-of-costs pair — present only when the cost
    // model ran (legacy entries honestly lack it; stats fall back gross).
    ...(Number.isFinite(Number(trade.costs)) ? { costs: +(Number(trade.costs)).toFixed(2) } : {}),
    ...(Number.isFinite(Number(trade.netPnl)) ? { netPnl: +(Number(trade.netPnl)).toFixed(2) } : {}),
    ...(trade.costsBreakdown?.instrumentType ? { costInstrument: trade.costsBreakdown.instrumentType } : {}),
    rMultiple: trade.stopLoss != null && Math.abs(trade.entry - trade.stopLoss) > 0
      ? +((trade.realizedPnl || 0) / (trade.qty * Math.abs(trade.entry - trade.stopLoss))).toFixed(2)
      : null,
    holdMinutes: holdMin,
    t1Hit: !!trade.t1Hit,
    parts: (trade.parts || []).length,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    reviewed: false,
  });
  // Cap: keep latest MAX_ENTRIES.
  if (_state.entries.length > MAX_ENTRIES) {
    _state.entries = _state.entries.slice(-MAX_ENTRIES);
  }
  _persist();
}

// ------------------------------------------------------------
// 2. EOD AI review — one batched call for the day's trades.
// ------------------------------------------------------------
const EOD_SYSTEM = `You are the DESK PERFORMANCE COACH of an elite NSE intraday prop firm. Review today's virtual trades (journal data below) with surgical honesty. Traders want IMPROVEMENT, not comfort.

Output (STRICT, Hinglish, max 180 words):
**Aaj Ka Scorecard** — 2 lines: wins/losses, total P&L, best & worst trade
**Kya Sahi Tha** — 1-2 bullets (repeatable behaviour)
**Kya Leak Tha** — 2-3 bullets with SPECIFIC trades (symbol + mistake: late entry? SL too tight? counter-regime? overtrading?)
**Kal Ka Ek Fix** — ONE concrete rule for tomorrow
End with a one-line discipline verdict: "Discipline: STRONG/MODERATE/WEAK".`;

export function _todayEntries(dayKey) {
  return _state.entries.filter(e => e.dayKey === (dayKey || istDayKey()));
}

export async function runEodReview(deps, dayKeyOverride) {
  const dayKey = dayKeyOverride || istDayKey();
  if (_state.reviews[dayKey]) return { ok: true, review: _state.reviews[dayKey], cached: true };
  // In-flight dedup: 15:45 cron + manual POST can fire at the same second —
  // without this both spend an LLM call on the identical review.
  if (_eodInflight) return _eodInflight;
  _eodInflight = _runEodReview(deps, dayKey).finally(() => { _eodInflight = null; });
  return _eodInflight;
}

let _eodInflight = null;

async function _runEodReview(deps, dayKey) {
  const { KEYS, OPENAI_COMPAT } = deps || {};
  const trades = _state.entries.filter(e => e.dayKey === dayKey);
  if (trades.length === 0) {
    return { ok: false, error: 'Aaj koi trade close nahi hua — journal review ke liye kuch nahi.' };
  }

  const lines = trades.map(t =>
    `${t.symbol} ${t.direction} | entry ${t.entry} qty ${t.qty} | SL ${t.stopLoss} T1 ${t.target1} | closed: ${t.closeReason} | P&L ₹${t.realizedPnl} (${t.rMultiple != null ? t.rMultiple + 'R' : 'n/a'}) | hold ${t.holdMinutes ?? '?'}min | T1-hit ${t.t1Hit ? 'yes' : 'no'}`
  ).join('\n');

  const stats = _dayStats(trades);
  const r = await askLLM(
    EOD_SYSTEM,
    `DATE: ${dayKey}\nSTATS: ${stats.wins}W/${stats.losses}L | net ₹${stats.netPnl} | avg ${stats.avgR}R\nTRADES:\n${lines}`,
    { KEYS, OPENAI_COMPAT },
    { temperature: 0.4, maxTokens: 1200 },
  );
  if (!r) return { ok: false, error: 'AI engines unavailable — EOD review skip.' };

  const review = { text: r.text, engine: r.engine, ts: Date.now(), stats };
  _state.reviews[dayKey] = review;
  // Keep only last 60 daily reviews.
  const reviewKeys = Object.keys(_state.reviews);
  if (reviewKeys.length > 60) {
    for (const k of reviewKeys.sort().slice(0, reviewKeys.length - 60)) delete _state.reviews[k];
  }
  _persist();

  // Mark entries reviewed.
  for (const t of _state.entries) if (t.dayKey === dayKey) t.reviewed = true;
  _persist();
  return { ok: true, review, cached: false };
}

function _dayStats(trades) {
  const wins = trades.filter(t => t.realizedPnl > 0).length;
  const losses = trades.filter(t => t.realizedPnl < 0).length;
  const netPnl = +trades.reduce((s, t) => s + t.realizedPnl, 0).toFixed(2);
  const rs = trades.filter(t => t.rMultiple != null).map(t => t.rMultiple);
  const avgR = rs.length ? +(rs.reduce((s, r) => s + r, 0) / rs.length).toFixed(2) : null;
  // v11.1 GAP 3: cost aggregation — only entries that CARRY the cost
  // pair contribute (legacy entries stay gross, counted honestly).
  const withCosts = trades.filter(t => Number.isFinite(Number(t.costs)));
  const costs = +withCosts.reduce((s, t) => s + Number(t.costs), 0).toFixed(2);
  const netPnlAfterCosts = +trades.reduce((s, t) =>
    s + (Number.isFinite(Number(t.netPnl)) ? Number(t.netPnl) : Number(t.realizedPnl) || 0), 0).toFixed(2);
  const grossWin = +trades.filter(t => t.realizedPnl > 0).reduce((s, t) => s + t.realizedPnl, 0).toFixed(2);
  return {
    wins, losses, netPnl, avgR, count: trades.length,
    costs, netPnlAfterCosts, grossWin, tradesWithCosts: withCosts.length,
  };
}

// ------------------------------------------------------------
// 3. Weekly improvement report — cron Fri 16:30 IST.
// ------------------------------------------------------------
const WEEKLY_SYSTEM = `You are the DESK PERFORMANCE COACH writing the WEEKLY improvement report for an NSE intraday trader. Use ONLY the journal data below. Be brutally specific — name symbols, name mistakes, credit repeatable wins.

Output (STRICT, Hinglish, max 250 words):
**Week Scorecard** — trades, win-rate, total P&L, avg R
**Best Trade** — symbol + why it worked (1-2 lines)
**Worst Leak** — the ONE pattern that cost the most (symbol evidence)
**Discipline Audit** — SL discipline %, T1-booking %, overtrading check
**Next Week Ka Plan** — 3 concrete rules (specific, measurable)
End with: "Week Verdict: GREEN/AMBER/RED" (green = profitable + disciplined).`;

export function getWeekKey(date = new Date()) {
  // v11.4 recheck: the old body re-parsed the IST wall clock in the HOST's
  // timezone (`new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))`)
  // and then re-converted to UTC — on any non-UTC host (an IST VPS, the
  // repo's own local start script) timestamps in the 00:00–05:29 IST window
  // mapped to the previous UTC day, landing weekly buckets on the WRONG
  // (previous) week. IST has a fixed +5:30 offset (no DST): shift the epoch
  // and read UTC parts — host-timezone-proof by construction.
  const shifted = new Date(new Date(date).getTime() + 5.5 * 60 * 60 * 1000);
  const day = (shifted.getUTCDay() + 6) % 7; // Mon=0
  shifted.setUTCDate(shifted.getUTCDate() - day);
  return shifted.toISOString().slice(0, 10); // Monday date = week key
}

export async function runWeeklyReport(deps, weekKeyOverride) {
  const weekKey = weekKeyOverride || getWeekKey();
  if (_state.weekly[weekKey]) return { ok: true, report: _state.weekly[weekKey], cached: true };
  // In-flight dedup (same pattern as EOD): Fri 16:30 cron + manual POST race.
  if (_weeklyInflight) return _weeklyInflight;
  _weeklyInflight = _runWeeklyReport(deps, weekKey).finally(() => { _weeklyInflight = null; });
  return _weeklyInflight;
}

let _weeklyInflight = null;

async function _runWeeklyReport(deps, weekKey) {
  const { KEYS, OPENAI_COMPAT } = deps || {};

  // Trades from this week's dayKeys (Mon..now).
  const trades = _state.entries.filter(e => e.dayKey >= weekKey);
  if (trades.length === 0) {
    return { ok: false, error: 'Is week koi trade nahi hua — report ke liye data nahi.' };
  }

  const byDay = {};
  for (const t of trades) {
    byDay[t.dayKey] = byDay[t.dayKey] || [];
    byDay[t.dayKey].push(t);
  }
  const dayLines = Object.entries(byDay).map(([dk, ts]) => {
    const st = _dayStats(ts);
    return `${dk}: ${st.count} trades, ${st.wins}W/${st.losses}L, net ₹${st.netPnl}, avg ${st.avgR ?? 'n/a'}R`;
  }).join('\n');

  const stats = _dayStats(trades);
  const _closes = trades.map(t => t.closeReason);
  const slDiscipline = trades.length
    ? Math.round(trades.filter(t => ['SL_HIT', 'SL_TRAIL_HIT', 'MANUAL'].includes(t.closeReason)).length / trades.length * 100) : null;
  const t1BookingRate = trades.filter(t => t.target1).length
    ? Math.round(trades.filter(t => t.t1Hit).length / trades.filter(t => t.target1).length * 100) : null;

  const worst = [...trades].sort((a, b) => a.realizedPnl - b.realizedPnl)[0];
  const best = [...trades].sort((a, b) => b.realizedPnl - a.realizedPnl)[0];
  const tradeLines = trades.slice(-25).map(t =>
    `${t.dayKey} ${t.symbol} ${t.direction} ${t.closeReason} ₹${t.realizedPnl} (${t.rMultiple ?? '?'}R) hold ${t.holdMinutes ?? '?'}m`
  ).join('\n');

  const r = await askLLM(
    WEEKLY_SYSTEM,
    `WEEK OF: ${weekKey}\nDAILY SUMMARY:\n${dayLines}\n\nWEEK TOTALS: ${stats.count} trades, ${stats.wins}W/${stats.losses}L, net ₹${stats.netPnl}, avg ${stats.avgR ?? 'n/a'}R\nSL-discipline: ${slDiscipline ?? 'n/a'}% | T1-booking: ${t1BookingRate ?? 'n/a'}%\nBEST: ${best ? `${best.symbol} ₹${best.realizedPnl}` : 'n/a'} | WORST: ${worst ? `${worst.symbol} ₹${worst.realizedPnl}` : 'n/a'}\n\nRECENT TRADE LOG:\n${tradeLines}`,
    { KEYS, OPENAI_COMPAT },
    { temperature: 0.4, maxTokens: 1600 },
  );
  if (!r) return { ok: false, error: 'AI engines unavailable — weekly report skip.' };

  const report = {
    text: r.text, engine: r.engine, ts: Date.now(),
    stats: { ...stats, slDiscipline, t1BookingRate },
  };
  _state.weekly[weekKey] = report;
  // Keep only last 26 weeks.
  const weekKeys = Object.keys(_state.weekly);
  if (weekKeys.length > 26) {
    for (const k of weekKeys.sort().slice(0, weekKeys.length - 26)) delete _state.weekly[k];
  }
  _persist();
  return { ok: true, report, cached: false };
}

// ------------------------------------------------------------
// 4. API read — frontend journal panel.
// ------------------------------------------------------------
export function getJournal(days = 14) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
  const entries = _state.entries.filter(e => e.dayKey >= cutoff).slice(-120).reverse();
  const allRecent = _state.entries.filter(e => e.dayKey >= cutoff);
  return {
    entries,
    stats: _dayStats(allRecent),
    todayReview: _state.reviews[istDayKey()] || null,
    reviews: Object.entries(_state.reviews)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7)
      .map(([dayKey, r]) => ({ dayKey, ...r })),
    weekly: Object.entries(_state.weekly)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 4)
      .map(([weekKey, r]) => ({ weekKey, ...r })),
  };
}

export function initJournal() {
  // Persist any in-memory state on boot (read-only FS → no-op).
  _persist();
}
