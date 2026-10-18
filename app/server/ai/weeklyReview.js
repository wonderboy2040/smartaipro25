// ============================================================
// server/ai/weeklyReview.js — v10.9 WEEKLY TRADE-PERFORMANCE DIGEST
// ------------------------------------------------------------
// /digest is a MARKET report (intel + prices + bond yields). This is
// the missing TRADE-PERFORMANCE review — YOUR week, not the market's:
//
//   • quant computes the numbers (zero LLM cost, zero hallucination):
//       - AI desk journal (crypto spot / futures / global / India
//         agent + manual executions) — CLOSE + PARTIAL_TP entries of
//         the rolling last 7 IST days
//       - calibration (trust.js — claimed confidence vs realized
//         win-rate, Brier, monthly drift)
//       - NSE intraday paper desk week (journal.js stats)
//   • ONE LLM call narrates the numbers (the "quant-computes,
//     LLM-narrates" pattern every other desk report here uses).
//
// Served at POST /api/ai/weekly-review, pushed by the Sunday 19:00
// IST cron (AI_WEEKLY_REVIEW_PUSH=off disables), and shown by the
// Telegram bot's /weeklyreview command.
// ============================================================
import { loadJournal } from './coindcxOrders.js';
import { trustReport, councilAgentStats, councilCalibrationMultipliers, mtfABReport } from './trust.js';
import { askLLM } from '../intraday/agent.js';
import { getJournal, getWeekKey } from '../intraday/journal.js';
import { sendTelegramMessage, telegramConfig } from './secrets.js';
// v11.0 Phase 4 — the COUNCIL calibration section: per-agent week
// stats, weight deltas, near-miss analysis + the auto-tighten loop.
import { nearMissList, nearMissStats, gateOverrideView, autoTightenGate, resetGateTighten } from './consensus.js';
import { __ledgerRaw } from './ledger.js';
import { fetchYahooQuotes } from './data.js';
import { meshQuery } from '../mcp/mesh.js';
// v11.6 Phase 4: the mesh-backed seats' contribution report — the
// number that answers "did adding Quiver/TradingCentral/etc. actually
// help?" with settled outcomes, not hope.
import { meshModelWeek } from './meshModels.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function istDayKey(date = new Date()) {
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

// ---------------- quant layer (pure, testable) ----------------
/**
 * Aggregate the AI trading journal's closed trades for the rolling
 * last `days` IST days. CLOSE entries carry the realized P&L;
 * PARTIAL_TP entries are the staged profit bookings.
 * v10.15 (deep-recheck #2 S3): adds the DIRECTION + ENTRY-HOUR split —
 * a systematic "shorts are consistently wrong" or "first-15-min entries
 * lose" pattern hides inside a blended overall win-rate; the split
 * comes from closed POSITIONS (they carry side + openedAt; CLOSE
 * entries don't) — labeled honestly in the payload.
 */
export function computeAiDeskWeek(journal, { days = 7, now = Date.now() } = {}) {
  const cutoff = istDayKey(new Date(now - (days - 1) * DAY_MS));
  const cutoffMs = Date.parse(`${cutoff}T00:00:00+05:30`) || (now - days * DAY_MS);
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  const closes = entries.filter(e => e?.kind === 'CLOSE' && typeof e.day === 'string' && e.day >= cutoff);
  const partials = entries.filter(e => e?.kind === 'PARTIAL_TP' && typeof e.day === 'string' && e.day >= cutoff);

  const wins = closes.filter(e => (Number(e.pnlINR) || 0) > 0);
  const losses = closes.filter(e => (Number(e.pnlINR) || 0) < 0);
  const netPnlINR = +closes.reduce((s, e) => s + (Number(e.pnlINR) || 0), 0).toFixed(2);
  const sorted = [...closes].sort((a, b) => (Number(b.pnlINR) || 0) - (Number(a.pnlINR) || 0));
  const best = sorted[0] ? { pair: sorted[0].pair, pnlINR: sorted[0].pnlINR, reason: sorted[0].reason } : null;
  const worst = sorted.length ? { pair: sorted[sorted.length - 1].pair, pnlINR: sorted[sorted.length - 1].pnlINR, reason: sorted[sorted.length - 1].reason } : null;

  const byMode = {};
  for (const e of closes) {
    const m = String(e.mode || 'paper').toLowerCase();
    byMode[m] = (byMode[m] || 0) + 1;
  }
  const pairCount = new Map();
  for (const e of closes) pairCount.set(e.pair, (pairCount.get(e.pair) || 0) + 1);
  const topPairs = [...pairCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([pair, n]) => ({ pair, n }));

  // ---- v10.15 S3: the direction-accuracy breakdown (closed positions —
  // the only journal rows that carry side + openedAt) ----
  const closedPositions = (journal?.positions || []).filter(p =>
    p && String(p.status || '').toUpperCase() === 'CLOSED'
    && Number(p.closedAt || 0) >= cutoffMs);
  const totalPnlOf = (p) => (Number(p.pnlINR) || 0) + (Number(p.bookedPnlINR) || 0);
  const dirBucket = (list) => {
    if (!list.length) return { trades: 0, wins: 0, losses: 0, winRate: null, netPnlINR: 0 };
    const w = list.filter(p => totalPnlOf(p) > 0).length;
    return {
      trades: list.length, wins: w, losses: list.length - w,
      winRate: Math.round((w / list.length) * 1000) / 10,
      netPnlINR: +list.reduce((s, p) => s + totalPnlOf(p), 0).toFixed(2),
    };
  };
  const byDirection = {
    LONG: dirBucket(closedPositions.filter(p => /^(L|B)/i.test(String(p.side || '')))),
    SHORT: dirBucket(closedPositions.filter(p => /^(S|SELL)/i.test(String(p.side || '')) || String(p.side || '').toUpperCase() === 'SELL')),
  };
  // entry-hour buckets (IST hour of openedAt): 09-10, 10-11, … — the
  // "first-15-min entries lose" / "post-lunch chop" pattern detector
  const hourBuckets = new Map();
  for (const p of closedPositions) {
    if (!Number(p.openedAt || 0)) continue;
    const istHour = new Date(p.openedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    const h = parseInt(istHour, 10) % 24;
    const key = `${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`;
    if (!hourBuckets.has(key)) hourBuckets.set(key, []);
    hourBuckets.get(key).push(p);
  }
  const byEntryHour = [...hourBuckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, list]) => ({ hour, ...dirBucket(list) }))
    .filter(b => b.trades > 0);

  // ---- v10.15 GAP 3: the PATIENCE A/B — ENTRY_MODE markers (immediate
  // vs patient, joined to closed positions by positionId) answer "did
  // patient entries beat immediate entries?" with numbers. ----
  const modeMarkers = new Map(); // positionId → 'patient' | 'immediate'
  for (const e of entries) {
    if (e?.kind === 'ENTRY_MODE' && e.positionId && (e.mode === 'patient' || e.mode === 'immediate')) {
      modeMarkers.set(e.positionId, e.mode);
    }
  }
  const modeLists = { immediate: [], patient: [] };
  for (const p of closedPositions) {
    const m = modeMarkers.get(p.id);
    if (m) modeLists[m].push(p);
  }
  const missedPullbacks = entries.filter(e => e?.kind === 'MISSED_PULLBACK' && typeof e.day === 'string' && e.day >= cutoff).length;
  const byEntryMode = {
    immediate: dirBucket(modeLists.immediate),
    patient: dirBucket(modeLists.patient),
    missedPullbacks,
    note: 'immediate vs patient closed-position win-rates + the unfilled-window count (a discipline win, not a loss)',
  };

  return {
    days,
    cutoff,
    trades: closes.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closes.length ? Math.round((wins.length / closes.length) * 1000) / 10 : null,
    netPnlINR,
    avgPnlINR: closes.length ? +(netPnlINR / closes.length).toFixed(2) : null,
    best, worst, byMode, topPairs,
    partialBookings: partials.length,
    hadActivity: closes.length > 0 || partials.length > 0,
    // v10.15 S3: the standing answer to "kya sab trades ka direction sahi
    // de raha hai?" — computed from closed positions (n may differ from
    // `trades`: entries vs positions — both are honest counts).
    direction: {
      byDirection,
      byEntryHour,
      note: 'split computed from closed journal positions (side + entry hour); overall numbers above use CLOSE entries',
    },
    byEntryMode,
  };
}

/** The full quant payload both the route and the cron narrate. */
export function weeklyQuantView({ now = Date.now() } = {}) {
  const ai = computeAiDeskWeek(loadJournal(), { now });
  const calibration = trustReport();
  let intraday = null;
  try {
    const j = getJournal(7);
    intraday = j?.stats || null;
  } catch { /* intraday journal optional */ }
  // v11.0: the council week — per-agent accountability + gate state.
  const council = computeCouncilWeek({ now });
  // v11.6: the mesh-model week — shadow/voting seats' contribution.
  const mesh = meshModelWeek({ now });
  // accuracy-plan Phase 2.1: the MTF-vs-plain-15m A/B verdict — both
  // arms journaled per settled execution; the weekly review narrates
  // the measured calibration delta (never a guess).
  const mtfAB = mtfABReport();
  return { ai, calibration, intraday, council, mesh, mtfAB, weekKey: getWeekKey(new Date(now)), asOf: now };
}

// ---------------- v11.0: COUNCIL calibration week ----------------
/**
 * The 6 seats' week: per-agent win/loss attribution over settled
 * council-stamped ledger entries, the CURRENT calibrated weights (the
 * Bayesian multipliers ARE the re-learning — recomputed from settled
 * outcomes on every read, so Render restarts can't lose them), the
 * week's proposed DIRECTION of drift (reporting, bounded ±15% framing),
 * the near-miss counts, and the precision-streak auto-tighten state.
 * PURE (except autoTightenGate's durable write, which fires only on a
 * genuine 3-week breach streak — idempotent, capped +10).
 */
export function computeCouncilWeek({ now = Date.now() } = {}) {
  const since = now - 7 * DAY_MS;
  const entries = (__ledgerRaw()?.entries || []).filter(e => e.council && e.outcome);
  const weekEntries = entries.filter(e => (e.outcome.ts || e.ts || 0) >= since);

  // ---- per-agent week attribution (the modelStats() rule, seat-over) ----
  const agents = {};
  for (const e of weekEntries) {
    const win = (e.outcome.r ?? 0) > 0;
    const tradeLong = !/^(S|SELL)/i.test(String(e.side || ''));
    for (const [role, v] of Object.entries(e.council.agents || {})) {
      if (!v || v.dir === 0) continue;
      const s = agents[role] = agents[role] || { role, wins: 0, losses: 0 };
      const calledItRight = ((v.dir > 0) === tradeLong) === win;
      if (calledItRight) s.wins++; else s.losses++;
    }
  }
  for (const s of Object.values(agents)) {
    s.n = s.wins + s.losses;
    s.hitRate = s.n > 0 ? Math.round((s.wins / s.n) * 1000) / 10 : null;
  }

  // ---- published-precision by ISO week (the 3-week streak ladder) ----
  const byWeek = new Map();
  for (const e of entries) {
    const wk = getWeekKey(new Date(e.outcome.ts || e.ts || now));
    const b = byWeek.get(wk) || { week: wk, n: 0, wins: 0 };
    b.n += 1;
    if ((e.outcome.r ?? 0) > 0) b.wins += 1;
    byWeek.set(wk, b);
  }
  const weeks = [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).slice(-4);
  for (const w of weeks) w.precision = w.n > 0 ? Math.round((w.wins / w.n) * 1000) / 10 : null;
  // the streak: last 3 weeks, each with n≥3 settled, each precision < 75%
  const last3 = weeks.slice(-3);
  const breachStreak = last3.length === 3 && last3.every(w => w.n >= 3 && (w.precision ?? 100) < 75);
  const recovered = last3.length > 0 && (last3[last3.length - 1].n ?? 0) >= 3 && (last3[last3.length - 1].precision ?? 0) >= 85;
  let gateAction = null;
  if (breachStreak) gateAction = autoTightenGate(`3-week precision breach (${last3.map(w => `${w.precision}%`).join(', ')})`);
  else if (recovered) gateAction = resetGateTighten(`precision recovered to ${last3[last3.length - 1].precision}%`);

  // ---- weights: current calibrated multipliers + all-time seat stats ----
  const weights = councilCalibrationMultipliers();
  const seatStats = councilAgentStats();

  // ---- near-miss analysis (counts + reasons; outcomes are the
  //      approximate scan below — reported, never claimed exact) ----
  const nm = nearMissStats();
  const nearMissWeek = nearMissList(60, { sinceMs: since });

  return {
    ok: true,
    settledCouncilTrades: weekEntries.length,
    agents: Object.values(agents).sort((a, b) => b.n - a.n),
    seatStats,
    weights,
    precisionByWeek: weeks,
    gate: gateOverrideView(),
    ...(gateAction ? { gateAction } : {}),
    nearMiss: {
      total: nm.total,
      last24h: nm.last24h,
      thisWeek: nearMissWeek.length,
      byReason: nm.byReason,
    },
    note: 'Council seats earn calibrated weight ONLY on settled outcomes (Bayesian, ±30% bound, n≥8). 95% = precision TARGET (publish kam, quality zyada) — guarantee nahi. Auto-tighten: 3-week <75% streak → conf bar +5 (cap +10); ≥85% recovery → reset.',
  };
}

/**
 * The near-miss APPROXIMATE outcome scan: for suppressed verdicts older
 * than 24h that carried levels, check where price sits NOW vs the
 * side/entry/stop/t1. Honest labels: price-at-review-time, no exit
 * assumptions, no slippage — a rough "gate sahi tha ya over-strict?"
 * signal, not a backtest. Caps at 15 symbols (Yahoo for India, mesh
 * crypto.price for crypto desks).
 */
export async function nearMissOutcomeScan({ now = Date.now() } = {}) {
  const cutoff = now - 24 * 60 * 60_000;
  const rows = nearMissList(40).filter(e => Number(e.ts) < cutoff && e.plan?.entry && (e.side === 'LONG' || e.side === 'SHORT')).slice(0, 15);
  if (rows.length === 0) return { checked: 0, wouldWin: 0, wouldLose: 0, inFlight: 0, unknown: 0 };
  const prices = new Map();
  const india = rows.filter(r => r.market === 'INDIA').map(r => r.symbol);
  const crypto = [...new Set(rows.filter(r => r.market !== 'INDIA').map(r => String(r.symbol).toUpperCase()))];
  try {
    if (india.length > 0) {
      const q = await fetchYahooQuotes(india);
      for (const [k, v] of Object.entries(q || {})) prices.set(String(k).toUpperCase(), Number(v.price) || null);
    }
    if (crypto.length > 0) {
      const m = await meshQuery({ capabilities: ['crypto.price'], symbols: crypto });
      const px = m?.results?.['crypto.price']?.data?.prices || {};
      for (const [k, v] of Object.entries(px || {})) if (v?.usd) prices.set(String(k).toUpperCase(), Number(v.usd));
    }
  } catch { /* prices are best-effort */ }
  let wouldWin = 0, wouldLose = 0, inFlight = 0, unknown = 0;
  for (const r of rows) {
    const base = String(r.symbol).toUpperCase().replace(/USDT$|INR$/, '');
    const p = prices.get(r.symbol.toUpperCase()) ?? prices.get(base) ?? null;
    if (p == null) { unknown += 1; continue; }
    const entry = Number(r.plan.entry), stop = Number(r.plan.stopLoss), t1 = Number(r.plan.target1);
    if (!Number.isFinite(entry)) { unknown += 1; continue; }
    const long = r.side === 'LONG';
    if (Number.isFinite(stop) && (long ? p <= stop : p >= stop)) wouldLose += 1;
    else if (Number.isFinite(t1) && (long ? p >= t1 : p <= t1)) wouldWin += 1;
    else inFlight += 1;
  }
  return {
    checked: rows.length,
    wouldWin, wouldLose, inFlight, unknown,
    method: 'approximate — price at review time vs recorded entry/stop/T1; no exit/slippage assumptions. Rough gate-honesty signal, not a backtest.',
  };
}

const WEEKLY_SYSTEM = `You are the DESK PERFORMANCE COACH writing the WEEKLY trade-performance digest for a multi-desk retail trader (crypto spot/futures + NSE intraday paper + global desks). Use ONLY the numbers below — never invent trades. Be brutally specific, name pairs, credit repeatable wins.

Output (STRICT, Hinglish, max 280 words):
**Week Scorecard** — trades, win-rate, net P&L across the AI desk
**Direction Read** — LONG vs SHORT win-rate split + entry-hour buckets (agar ek side systematically galat hai, naam lo)
**Council Read** — the 6 seats' hit-rates, calibrated weights, near-miss count, precision ladder (kaun seat earn kar raha hai apna vote)
**Mesh Seats Read** — the v11.6 mesh-backed seats (InstFlowPro/TechConsensus/FundaProPlus/CryptoOnChainPro): shadow ya voting, when-voted vs when-abstained win-rates, correlation guard (kya naya data asal mein help kar raha hai — numbers se batao)
**Calibration Read** — claimed confidence vs realized win-rate, Brier verdict, monthly drift (kya keh raha hai)
**Best & Worst** — name the trades and why
**Discipline Audit** — SL discipline, booking behaviour, overtrading check
**Next Week Ka Plan** — 3 concrete, measurable rules
End with: "Week Verdict: GREEN/AMBER/RED" (green = profitable + disciplined).`;

function _quantPromptBlock(q) {
  const { ai, calibration, intraday } = q;
  const lines = [];
  lines.push(`AI DESK (rolling ${ai.days}d, since ${ai.cutoff}):`);
  lines.push(`closed trades ${ai.trades} (${ai.wins}W/${ai.losses}L${ai.winRate != null ? `, win-rate ${ai.winRate}%` : ''}), net ₹${ai.netPnlINR}, avg ₹${ai.avgPnlINR ?? '—'}, partial bookings ${ai.partialBookings}`);
  lines.push(`by mode: ${Object.entries(ai.byMode).map(([m, n]) => `${m} ${n}`).join(', ') || 'none'}`);
  if (ai.best) lines.push(`best: ${ai.best.pair} ₹${ai.best.pnlINR} (${ai.best.reason || '?'})`);
  if (ai.worst) lines.push(`worst: ${ai.worst.pair} ₹${ai.worst.pnlINR} (${ai.worst.reason || '?'})`);
  if (ai.topPairs.length) lines.push(`most traded: ${ai.topPairs.map(p => `${p.pair} x${p.n}`).join(', ')}`);
  // v10.15 S3: the direction-accuracy read — "kya SHORT side systematically
  // galat hai?" gets a number, not a vibe.
  const d = ai.direction?.byDirection || {};
  if ((d.LONG?.trades || 0) + (d.SHORT?.trades || 0) > 0) {
    lines.push(`direction split: LONG ${d.LONG.trades} trades ${d.LONG.winRate != null ? `${d.LONG.winRate}% WR` : ''} net ₹${d.LONG.netPnlINR} · SHORT ${d.SHORT.trades} trades ${d.SHORT.winRate != null ? `${d.SHORT.winRate}% WR` : ''} net ₹${d.SHORT.netPnlINR}`);
  }
  const hours = (ai.direction?.byEntryHour || []).filter(b => b.trades >= 2).slice(0, 4);
  for (const b of hours) {
    lines.push(`entry-hour ${b.hour}: ${b.trades} trades ${b.winRate != null ? `${b.winRate}% WR` : ''} net ₹${b.netPnlINR}`);
  }
  // v10.15 GAP 3: the patience A/B — did resting at pullbacks beat chasing?
  const em = ai.byEntryMode;
  if (em && ((em.immediate?.trades || 0) + (em.patient?.trades || 0)) > 0) {
    lines.push(`patience A/B: immediate ${em.immediate.trades} trades ${em.immediate.winRate != null ? `${em.immediate.winRate}% WR` : ''} · patient ${em.patient.trades} trades ${em.patient.winRate != null ? `${em.patient.winRate}% WR` : ''} · missed-pullback windows ${em.missedPullbacks}`);
  }
  lines.push('');
  lines.push(`CALIBRATION (ledger, all-time settled ${calibration.settled}):`);
  if (calibration.sufficient) {
    lines.push(`overall win-rate ${calibration.overall?.winRate}% vs avg claimed confidence ${calibration.overall?.avgConfidence}%; Brier ${calibration.brier} (${calibration.brierVerdict}); monthly drift ${calibration.drift ?? 'n/a'}`);
    const buckets = (calibration.calibration || []).slice(0, 5)
      .map(b => `${b.bucket}: claimed ${Math.round(b.claimed)}% → real ${b.winRate}% (n=${b.n})`).join('; ');
    if (buckets) lines.push(`buckets: ${buckets}`);
  } else {
    lines.push(calibration.note || 'insufficient settled signals for calibration');
  }
  lines.push('');
  lines.push('NSE INTRADAY PAPER DESK (this week):');
  if (intraday && intraday.count > 0) {
    lines.push(`${intraday.count} trades, ${intraday.wins}W/${intraday.losses}L, net ₹${intraday.netPnl}, avg ${intraday.avgR ?? 'n/a'}R`);
    // v11.1 GAP 3: the gross-vs-net gap — "costs ate ₹X this week, Y% of
    // gross profit" is the number that reveals whether a strategy is
    // real-money viable or only paper-viable.
    const costs = Number(intraday.costs) || 0;
    if ((intraday.tradesWithCosts || 0) > 0 && costs > 0) {
      const grossWin = Number(intraday.grossWin) || 0;
      const pct = grossWin > 0 ? ` (${Math.round((costs / grossWin) * 1000) / 10}% of gross profit)` : '';
      lines.push(`costs ate ₹${costs.toFixed(2)} this week${pct} — net ₹${intraday.netPnlAfterCosts} vs gross ₹${intraday.netPnl} (brokerage + STT + exchange txn + SEBI + GST + stamp)`);
    }
  } else {
    lines.push('no closed paper trades this week');
  }
  // v11.0: the COUNCIL read — per-seat accountability + precision ladder.
  const c = q.council;
  if (c) {
    lines.push('');
    lines.push(`GLOBAL MARKET COUNCIL (settled council-stamped this week: ${c.settledCouncilTrades}):`);
    if ((c.agents || []).length > 0) {
      lines.push(`seats: ${c.agents.map(a => `${a.role} ${a.wins}W/${a.losses}L${a.hitRate != null ? ` (${a.hitRate}%)` : ''}`).join(' · ')}`);
    } else {
      lines.push('no settled council-stamped trades this week — seats apna record EXECUTED trades se banate hain');
    }
    if ((c.precisionByWeek || []).length > 0) {
      lines.push(`published precision by week: ${c.precisionByWeek.map(w => `${w.week} ${w.precision != null ? w.precision + '%' : 'n/a'} (n=${w.n})`).join(' · ')}`);
    }
    if (c.gate?.confAdd > 0) lines.push(`⚠️ GATE AUTO-TIGHTENED +${c.gate.confAdd} (reason: ${c.gate.reason || 'precision streak'}) — publish bar ab aur upar`);
    if (c.gateAction && c.gateAction.confAdd > 0) lines.push(`this week: auto-tighten FIRED → conf bar +${c.gateAction.confAdd}`);
    if (c.gateAction && c.gateAction.confAdd === 0 && c.gateAction.reason === 'precision-recovered') lines.push('this week: auto-tighten RESET (precision recovered ≥85%)');
    if (c.nearMiss?.thisWeek > 0 || c.nearMiss?.total > 0) {
      lines.push(`near-miss (suppressed): ${c.nearMiss.thisWeek} this week · ${c.nearMiss.total} total${(c.nearMiss.byReason || []).slice(0, 3).map(([k, n]) => `, ${k} x${n}`).join('')}`);
    }
    const w = c.weights || {};
    const learned = Object.entries(w).filter(([, m]) => m && m.mul != null && m.mul !== 1 && (m.n || 0) >= 8);
    if (learned.length > 0) lines.push(`calibrated weights engaged: ${learned.map(([role, m]) => `${role} ×${m.mul}`).join(' · ')} (Bayesian, settled outcomes se)`);
  }
  // v11.6 Phase 4: the MESH-MODEL CONTRIBUTION report — each seat's own
  // win-rate when it voted vs the baseline when it abstained. This is
  // the honest answer to "did more MCP data raise real accuracy?".
  const mm = q.mesh;
  if (mm) {
    lines.push('');
    lines.push(`MESH-BACKED SEATS (v11.6, meshModelWeek):`);
    const rows = (mm.allTime?.models || []).map(m => {
      const wk = mm.week?.[m.id];
      const wkBit = wk && wk.n > 0 ? `, this week ${wk.n} attributed (${wk.hitRate}%)` : ', no attributed outcomes this week';
      const edgeBit = m.edge != null ? `edge ${m.edge > 0 ? '+' : ''}${m.edge}pts (voted ${m.whenVotedWR}% vs abstained ${m.whenAbstainedWR}%)` : 'insufficient paired data';
      const corrBit = m.corr != null ? `, corr ${m.corr} vs ${m.vs}` : '';
      return `${m.name} [${m.mode}] n=${m.n}${wkBit} · ${edgeBit}${corrBit}`;
    });
    if (rows.length > 0) lines.push(rows.join('\n'));
    lines.push('seats earn voting weight ONLY on settled outcomes — shadow = journaled but weight 0 (honest proving period)');
  }
  return lines.join('\n');
}

/** The quant header Telegram gets ABOVE the narration — the numbers
 *  themselves are always visible, LLM or not. */
export function quantHeaderBlock(q) {
  const { ai, calibration } = q;
  const lines = [
    `📊 <b>WEEKLY TRADE-PERFORMANCE REVIEW</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    `🤖 <b>AI desk (${ai.days}d)</b>: ${ai.trades} closed (${ai.wins}W/${ai.losses}L${ai.winRate != null ? ` · ${ai.winRate}%` : ''}) · net <b>₹${ai.netPnlINR.toLocaleString('en-IN')}</b>${ai.partialBookings ? ` · ${ai.partialBookings} partial bookings` : ''}`,
  ];
  const d = ai.direction?.byDirection || null;
  if (d && (d.LONG?.trades || 0) + (d.SHORT?.trades || 0) > 0) {
    lines.push(`🧭 <b>Direction split</b>: LONG ${d.LONG.trades}${d.LONG.winRate != null ? ` · ${d.LONG.winRate}% WR` : ''} · SHORT ${d.SHORT.trades}${d.SHORT.winRate != null ? ` · ${d.SHORT.winRate}% WR` : ''}`);
  }
  if (calibration.sufficient) {
    lines.push(`🎯 <b>Calibration</b>: claimed ${calibration.overall?.avgConfidence}% → realized ${calibration.overall?.winRate}% · Brier ${calibration.brier}`);
  }
  // v11.1 GAP 3: the intraday paper desk's gross-vs-net cost drag — the
  // "costs ate ₹X this week" line (visible with or without the LLM).
  const inr = q.intraday;
  if (inr && (inr.tradesWithCosts || 0) > 0 && Number(inr.costs) > 0) {
    const gw = Number(inr.grossWin) || 0;
    const pctTxt = gw > 0 ? ` · ${Math.round((Number(inr.costs) / gw) * 1000) / 10}% of gross profit` : '';
    lines.push(`💸 <b>Costs ate ₹${Number(inr.costs).toLocaleString('en-IN')}</b> this week${pctTxt} — paper net ₹${Number(inr.netPnl).toLocaleString('en-IN')} → post-cost ₹${Number(inr.netPnlAfterCosts).toLocaleString('en-IN')}`);
  }
  // v11.0: the council header line — seats + precision + auto-tighten.
  const c = q.council;
  if (c) {
    const seats = (c.agents || []).slice(0, 3).map(a => `${a.role} ${a.hitRate != null ? a.hitRate + '%' : '—'}`).join(' · ');
    if (seats) lines.push(`🏛️ <b>Council</b>: ${c.settledCouncilTrades} settled · ${seats}${(c.agents || []).length > 3 ? ' …' : ''}`);
    if (c.gate?.confAdd > 0) lines.push(`⚠️ <b>Gate auto-tightened +${c.gate.confAdd}</b> — ${c.gate.reason || 'precision streak'}`);
    if (c.nearMiss?.thisWeek > 0) lines.push(`⊘ Near-miss: ${c.nearMiss.thisWeek} suppressed this week (${c.nearMiss.total} total)`);
  }
  // v11.6: the mesh-backed seats header — shadow/voting + edges, one line.
  const mm = q.mesh;
  if (mm && (mm.allTime?.models || []).length > 0) {
    const voting = mm.allTime.models.filter(m => m.mode === 'voting');
    const shadow = mm.allTime.models.filter(m => m.mode !== 'voting');
    const bit = (m) => `${m.name} ${m.mode === 'voting' && m.edge != null ? (m.edge > 0 ? '+' : '') + m.edge + 'pts' : m.mode}`;
    lines.push(`🕸️ <b>Mesh seats</b>: ${voting.length}/${voting.length + shadow.length} voting · ${[...voting, ...shadow].slice(0, 4).map(bit).join(' · ')}`);
  }
  // accuracy-plan Phase 2.1: the MTF A/B header — one honest line.
  const ab = q.mtfAB;
  if (ab && (ab.pairs || 0) > 0) {
    const sepBit = ab.mtf.separation != null && ab.plain.separation != null
      ? `separation ${ab.mtf.separation} vs ${ab.plain.separation}` : 'separation —';
    const brierBit = ab.mtf.brier != null && ab.plain.brier != null
      ? `Brier ${ab.mtf.brier} vs ${ab.plain.brier}` : 'Brier —';
    lines.push(`📊 <b>MTF A/B</b> (${ab.pairs} paired): ${ab.verdict} · ${sepBit} · ${brierBit} · <i>${ab.pairs < 10 ? 'pairs chhote hain — sakhti se mat padho' : 'calibration-grade verdict'}</i>`);
  }
  return lines.join('\n');
}

// ---------------- orchestration ----------------
const _cache = new Map(); // weekKey → result
let _inflight = null;

export async function runWeeklyPerformanceReview(deps = {}, { now = Date.now(), force = false } = {}) {
  const weekKey = getWeekKey(new Date(now));
  if (!force && _cache.has(weekKey)) return { ok: true, ..._cache.get(weekKey), cached: true };
  if (_inflight) return _inflight;
  _inflight = _runWeekly(deps, weekKey, now).finally(() => { _inflight = null; });
  return _inflight;
}

async function _runWeekly(deps, weekKey, now) {
  const { KEYS, OPENAI_COMPAT } = deps || {};
  const q = weeklyQuantView({ now });
  // v11.0: the near-miss approximate outcome scan rides the SAME run
  // (bounded 15 symbols, best-effort prices, honest method label).
  try { q.councilNearMissScan = await nearMissOutcomeScan({ now }); } catch { /* optional */ }

  if (!q.ai.hadActivity && !(q.intraday?.count > 0) && !((q.council?.settledCouncilTrades || 0) > 0)) {
    return { ok: false, error: 'Is hafte koi settled trade nahi — AI desk bhi, intraday paper desk bhi, council bhi. Review ke liye data hi nahi. Trades hone do, phir /weeklyreview.' };
  }

  const r = await askLLM(WEEKLY_SYSTEM, `WEEK OF: ${weekKey}\n\n${_quantPromptBlock(q)}`, { KEYS, OPENAI_COMPAT }, { temperature: 0.4, maxTokens: 1600, timeout: 45000 });
  if (!r) {
    // No LLM → still return the QUANT view (numbers need no engine).
    const out = {
      ok: true, weekKey, engine: null, ts: Date.now(),
      quant: q, text: `${quantHeaderBlock(q)}\n\n<i>LLM narration unavailable — quant numbers upar hain (engine keys check karo).</i>`,
    };
    _cache.set(weekKey, out);
    return { ...out, cached: false };
  }

  const out = {
    ok: true, weekKey, engine: r.engine, ts: Date.now(),
    quant: q, text: `${quantHeaderBlock(q)}\n\n${r.text}`,
  };
  _cache.set(weekKey, out);
  // keep the last 8 weeks
  if (_cache.size > 8) {
    for (const k of [..._cache.keys()].sort().slice(0, _cache.size - 8)) _cache.delete(k);
  }
  return { ...out, cached: false };
}

/** Telegram push (the Sunday cron + the bot's /weeklyreview use it). */
export async function pushWeeklyReview(deps = {}) {
  const cfgTG = telegramConfig({});
  if (!cfgTG) return { ok: false, error: 'telegram not configured' };
  const out = await runWeeklyPerformanceReview(deps);
  if (!out.ok) return out;
  const r = await sendTelegramMessage(out.text, { token: cfgTG.token, chatId: cfgTG.chatId });
  return { ...out, pushed: !!r?.ok, pushError: r?.ok ? null : r?.error };
}

/** Sunday 19:00 IST auto-push (AI_WEEKLY_REVIEW_PUSH=off disables). */
export function weeklyAutoPushEnabled() {
  return String(process.env.AI_WEEKLY_REVIEW_PUSH || '').toLowerCase() !== 'off';
}

export function scheduleWeeklyReviewPush(deps) {
  if (!weeklyAutoPushEnabled()) return false;
  try {
    // lazy import pattern would be cleaner, but node-cron is already a
    // hard dependency of the intraday routes on the same server.
    import('node-cron').then(({ default: cron }) => {
      cron.schedule('0 19 * * 0', async () => {
        try {
          const out = await pushWeeklyReview(deps());
          console.log(`[weekly-review] Sunday push: ${out.ok ? (out.pushed ? 'sent' : (out.error || 'computed')) : (out.error || 'skip')}`);
        } catch (e) { console.warn('[weekly-review] Sunday push failed:', e?.message); }
      }, { timezone: 'Asia/Kolkata' });
      console.log('[weekly-review] Sunday 19:00 IST auto-push scheduled');
    }).catch(() => { /* cron unavailable — manual /weeklyreview still works */ });
    return true;
  } catch { return false; }
}

export function weeklyReviewStatus() {
  return {
    ok: true,
    autoPush: weeklyAutoPushEnabled(),
    cachedWeeks: [..._cache.keys()].sort().slice(-4),
    last: _cache.size ? _cache.get([..._cache.keys()].sort().slice(-1)[0])?.ts ?? null : null,
    note: 'Quant-computed numbers + one LLM narration. POST /api/ai/weekly-review computes; Sunday 19:00 IST pushes.',
  };
}

// ---------------- test hooks ----------------
export function __weeklyCacheForTests() { return _cache; }
export function __resetWeeklyReviewForTests() { _cache.clear(); _inflight = null; }
