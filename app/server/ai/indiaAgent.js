// ============================================================
// server/ai/indiaAgent.js — NSE SUPERINTELLIGENCE AUTO-AGENT (v10.3)
// ------------------------------------------------------------
// The India twin of server/ai/agent.js — a prop-desk style
// AUTONOMOUS agent for the NSE intraday desk (Dhan venue):
//
//   • scans the LIVE India board every 30s (NSE hours only)
//   • AUTO-ENTRY: 75+ AI SCORE (quorum-aware, same bar as crypto)
//     ya the legacy STRONG-committee bar — jo pehle qualify kare
//   • exactly N trades per day (default 3), 20m entry cooldown
//   • sizing: whole shares from the configured desk capital
//     (risk % of equity → budget, capped by India Max ₹)
//   • PRO 3-TIER EXIT: T1 → book 40% + SL→breakeven, T2 → book 40%
//     + SL→T1, RUNNER (20%) trails via the venue watcher
//   • NSE CLOCK DISCIPLINE (crypto me nahi tha):
//       09:30–15:00 entry window · 15:15 EOD square-off (insured)
//   • TIME-EXIT (ATR-adaptive) + TREND-FLIP auto-exit
//   • daily loss cap → stands down · rolling win-rate self-check
//   • every decision lands in the agent log + Telegram
//
// Safety inheritance (NOT re-implemented — inherited):
//   kill switch · indiaMode LIVE arming · daily caps ·
//   one-per-symbol · concentration guard — every entry passes
//   the SAME executeIndiaSignal gauntlet a manual click passes.
//   The agent has ZERO private paths to money.
//
// CROSS-AGENT HYGIENE: journal accounting is scoped by
//   source === 'india-agent' && market === 'INDIA'
// so the crypto agent's source==='agent' filters (its quota,
//   loss-cap, open-positions) can never see this agent's trades
//   — and vice versa. Two agents, one journal, zero contamination.
//
// Loop cadence: 30s (unref'd). PAPER is the default; LIVE needs
//   (1) typed LIVE in Risk settings (indiaMode), (2) typed LIVE
//   when starting the agent, (3) Dhan connected. The same
//   2-week paper-first validation the crypto agent shipped with.
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';
import { isNseOpen, fetchTVIndiaBatch } from './data.js';
import { dhanConnected, dhanPlaceOrder, dhanCancelOrder } from './dhan.js';
import { loadConfig, loadJournal, saveJournal, withJournalLock, pushEntry, todayIST } from './coindcxOrders.js';
import { executeIndiaSignal, closeIndiaPosition, istHM, IST_SQUAREOFF, IST_ENTRY_LAST, IST_ENTRY_FIRST } from './indiaOrders.js';
import { acquireDirectionLock, checkDirectionLock } from './directionLock.js';
// v10.15 GAP 3: the Dhan L2 read for the patient pullback level.
import { readDepth } from './orderFlowDepth.js';
// v10.2 parity: V2 model flag exposure in the status view
import { v2ModelsEnabled } from './models.js';
// v21.12.0: committee snapshot — AgentPanel chip isi se dynamic
// voting/shadow counts dikhata hai (hardcoded 16/13 strings ka end).
import { committeeInfo } from './committee.js';
// v10.15 GAP 1: Live Conviction Tracker (crypto-agent parity) — the
// ensemble re-votes open India positions; FLIPPED exits at
// thesis-invalidation, WEAKENING ratchets the SL toward breakeven.
import {
  convictionEnabled, convictionOfPosition, weakeningShouldTighten as _weakeningShouldTighten,
} from './positionConviction.js';
// v11.1 GAP 2 — circuit-limit risk for open India positions (pure
// classification + the Groww quote that carries the day's price band).
import { adverseCircuitRisk } from './circuitGuard.js';
import { fetchGrowwNseQuote } from './growwQuote.js';
// v10.15 GAP 2: Event Guard — earnings/RBI/CPI/IIP awareness on the
// India entry gauntlet (T-30m blackout · T-2h sizing haircut).
import { eventGuardCheck } from './eventGuard.js';
// v10.15 GAP 4: Global Risk Brain (crypto-agent parity) — the ONE
// cross-desk heat cap + risk-off detector BOTH gauntlets consult.
import { globalRiskGate } from './globalRisk.js';
// v10.16 S3 parity: the proportional quorum penalty (ONE truth — the
// same effectiveScoreBar the crypto agent uses)
import { effectiveScoreBar } from './agent.js';
// v10.15 GAP 3: Patient Entry (crypto-agent parity, 10m NSE window).
import {
  patientEntryEnabled, patientWindowMin, classifyEntry, pullbackLevelFor, patientPendingAction,
} from './patientEntry.js';

const AGENT_CONFIG_FILE = 'india-agent-config.json';
const AGENT_STATE_FILE = 'india-agent-state.json';
const LOG_RING = 120;

// v10.3: same 30s cadence as the crypto agent — NSE hours only, so
// the after-hours tick is a cheap no-op (clock gate first).
export const INDIA_AGENT_TICK_SEC = 30;

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ---------------- config (durable) ----------------
// Same risk philosophy as the crypto agent (user spec), NSE-specific:
//   • no leverage knob (cash equities)
//   • no desks toggle (single desk)
//   • equityINR replaces the exchange wallet (no wallet API on the
//     India desk — the sizing capital is explicit, honest, tunable)
export const INDIA_AGENT_DEFAULTS = {
  enabled: false,             // agent ON/OFF
  mode: 'paper',              // 'paper' | 'notify' | 'live'
  maxTradesPerDay: 3,         // USER SPEC: daily ke 3 trades
  minAiScore: 75,             // v9.6 USER SPEC: 75+ AI score → auto entry
  // v10.16 S3 parity (user spec conf=60): Path B (STRONG + conf +
  // agreement) becomes a realistic second route; proportional quorum
  // penalty replaces the flat +10 cliff (crypto-agent parity).
  minConfidence: 60,
  minAgreement: 0.65,
  quorumPenalty: 5,           // v10.16: CAP of the proportional penalty (was flat 10)
  riskPerTradePct: 1.5,       // % of desk capital risked per trade (SL-based)
  equityINR: 10_000,          // desk sizing capital (paper default ₹10k)
  minEquityINR: 300,          // below this the agent refuses to trade (honest)
  cooldownMin: 20,            // minutes between agent entries
  maxHoldMin: 90,             // agent time-exit (auto square-off)
  dailyLossCapPct: 3,         // −3% of desk capital → agent stands down today
  // ---- PRO TRADER: 3-tier partial take-profit ----
  partialTpEnabled: true,     // T1/T2/runner tiered exits on agent positions
  tp1ClosePct: 40,            // % of ORIGINAL qty closed at T1
  tp2ClosePct: 40,            // % of ORIGINAL qty closed at T2
  runnerPct: 20,              // % riding as the trailing runner (derived)
  breakEvenAfterTp1: true,    // SL → entry once T1 books (risk-free runner)
  // ---- accuracy upgrade knobs (crypto-agent parity) ----
  dynamicTimeExit: true,      // ATR-adaptive time-exit windows
  minRollingWinRate: 35,     // last-N win-rate floor (LIVE self-downgrade)
  rollingWindow: 10,
  // ---- v10.15 GAP 1: LIVE CONVICTION TRACKER (crypto-agent parity) ----
  // OFF by default — AI_ENABLE_CONVICTION_EXIT=true ya ye knob. India has
  // no winner-extension system yet, so here the tracker only EXITS
  // (FLIPPED) and TIGHTENS (WEAKENING+profit → SL breakeven ratchet).
  convictionExit: false,
  convictionThreshold: 8,     // aiScore points for STRENGTHENING/WEAKENING
  // ---- v10.15 GAP 3: PATIENT ENTRY (10m NSE window) ----
  patientEntry: false,
};

// v18.1: persist-once-per-process guard — same as agent.js: the migration
// stamp must LAND on disk, but load must not become a write-per-load.
let _indiaConfigMigrationsPersisted = false;

export function loadIndiaAgentConfig() {
  const saved = loadJSON(AGENT_CONFIG_FILE, {}) || {};
  // v18.1 FIX (one-time migration stamps): this migration ran on EVERY load.
  // A user-chosen minConfidence of exactly 80 (legal, clamp 55-95) was
  // silently reset to 60 on every load whenever thresholdProfile was missing
  // — and the first unrelated knob-save persisted the reset. The migration
  // now runs AT MOST ONCE per saved file (stamped in __migrationsIndia).
  const _stamps = (saved.__migrationsIndia && typeof saved.__migrationsIndia === 'object')
    ? { ...saved.__migrationsIndia } : {};
  let _migrated = false;
  // v10.16 S3 migration (crypto-agent parity): untouched OLD defaults
  // (80 / 0.75 / 10) migrate to the new bar (60 / 0.65 / 5);
  // user-customized values are preserved verbatim.
  if (!_stamps.v10_16 && saved.thresholdProfile == null) {
    if (saved.minConfidence == null || Number(saved.minConfidence) === 80) saved.minConfidence = INDIA_AGENT_DEFAULTS.minConfidence;
    if (saved.minAgreement == null || Number(saved.minAgreement) === 0.75) saved.minAgreement = INDIA_AGENT_DEFAULTS.minAgreement;
    if (saved.quorumPenalty == null || Number(saved.quorumPenalty) === 10) saved.quorumPenalty = INDIA_AGENT_DEFAULTS.quorumPenalty;
    saved.thresholdProfile = 'proportional';
    _migrated = true;
  }
  if (_migrated || !_stamps.v10_16) {
    saved.__migrationsIndia = { ..._stamps, v10_16: true };
    if (!_indiaConfigMigrationsPersisted) {
      _indiaConfigMigrationsPersisted = true;
      try {
        saveJSON(AGENT_CONFIG_FILE, saved);
        try { durablePut(AGENT_CONFIG_FILE, saved); } catch { /* best-effort */ }
      } catch { /* read-only fs / test env */ }
    }
  }
  return { ...INDIA_AGENT_DEFAULTS, ...saved };
}
export function saveIndiaAgentConfig(cfg) {
  saveJSON(AGENT_CONFIG_FILE, cfg);
  try { durablePut(AGENT_CONFIG_FILE, cfg); } catch { /* best-effort */ }
  return cfg;
}

const NUM_CLAMPS = {
  maxTradesPerDay: [1, 20],
  minAiScore: [55, 95],
  minConfidence: [55, 95],
  minAgreement: [0.5, 0.95],
  riskPerTradePct: [0.25, 10],
  equityINR: [100, 100_000_000],
  minEquityINR: [0, 100_000],
  cooldownMin: [1, 240],
  maxHoldMin: [5, 330],        // NSE session is 375m — a 330m ceiling keeps it intraday
  dailyLossCapPct: [0.5, 50],
  tp1ClosePct: [10, 80],
  tp2ClosePct: [10, 80],
  quorumPenalty: [0, 15],
  convictionThreshold: [3, 25],
};
export function updateIndiaAgentConfig(patch = {}) {
  const cfg = loadIndiaAgentConfig();
  const next = { ...cfg };
  for (const [key, [lo, hi]] of Object.entries(NUM_CLAMPS)) {
    if (patch[key] != null) {
      const n = Number(patch[key]);
      if (Number.isFinite(n)) next[key] = Math.round(Math.max(lo, Math.min(hi, n)) * 100) / 100;
    }
  }
  if (patch.partialTpEnabled != null) next.partialTpEnabled = !!patch.partialTpEnabled;
  if (patch.breakEvenAfterTp1 != null) next.breakEvenAfterTp1 = !!patch.breakEvenAfterTp1;
  if (patch.dynamicTimeExit != null) next.dynamicTimeExit = !!patch.dynamicTimeExit;
  // v10.15 conviction toggle
  if (patch.convictionExit != null) next.convictionExit = !!patch.convictionExit;
  // v10.15 patient-entry toggle
  if (patch.patientEntry != null) next.patientEntry = !!patch.patientEntry;
  // v18.1 FIX: thresholdProfile was silently DROPPED from patches — the UI
  // could send 'flat' (legacy A/B arm) or 'proportional' and it never landed.
  // Now accepted verbatim (both legal values).
  if (patch.thresholdProfile === 'flat' || patch.thresholdProfile === 'proportional') {
    next.thresholdProfile = patch.thresholdProfile;
  }
  // keep the split honest — T1+T2 ≤ 90, runner ≥ 10
  if (next.tp1ClosePct + next.tp2ClosePct > 90) {
    const scale = 90 / (next.tp1ClosePct + next.tp2ClosePct);
    next.tp1ClosePct = Math.round(next.tp1ClosePct * scale);
    next.tp2ClosePct = 90 - next.tp1ClosePct;
  }
  next.runnerPct = Math.max(10, Math.round(100 - next.tp1ClosePct - next.tp2ClosePct));
  if (patch.mode === 'paper' || patch.mode === 'notify') next.mode = patch.mode;
  return saveIndiaAgentConfig(next);
}

// ---------------- state (durable) ----------------
function freshState() {
  return {
    runningSince: null, lastScanAt: null, scans: 0,
    lastEntryAt: null, lastEntrySymbol: null,
    pausedToday: null, // { day, reason }
    lastSkip: null,   // { key, text, at } — the CURRENT wait/blocker reason
    alerted: {},      // stand-down telegram alerts already sent today
    entryMeta: {},    // symbol → { atrPct, at, convictionScore } — entry volatility + conviction anchor
    winRateDowngraded: null, // LIVE→paper soft-downgrade latch
    lastNearMisses: [], // v10.2 parity: top-3 closest signals that ALMOST qualified
    // v10.15 GAP 1: the LATEST conviction re-vote per open symbol (panel bar)
    conviction: {},
    // v10.15 GAP 3: the ONE resting patient order (null = none)
    patient: null,
    log: [],
  };
}
function loadState() {
  const saved = loadJSON(AGENT_STATE_FILE, null);
  return saved && typeof saved === 'object' ? { ...freshState(), ...saved } : freshState();
}
let _state = loadState();
/** v10.3.1: durable boot-restore hook — _state was loaded at module-eval
 * time (BEFORE the pre-listen durable restore rehydrated the disk file
 * on a fresh Render boot). Re-read so a restart resumes with the real
 * quota/log/exposure state instead of a blank one. */
export function __reloadStateForBoot() { _state = loadState(); }
function persistState() {
  saveJSON(AGENT_STATE_FILE, _state);
  try { durablePut(AGENT_STATE_FILE, _state); } catch { /* best-effort */ }
}

function log(level, text) {
  _state.log.push({ ts: Date.now(), level, text: String(text).slice(0, 240) });
  if (_state.log.length > LOG_RING) _state.log = _state.log.slice(-LOG_RING);
  const tag = level === 'entry' ? '🟢' : level === 'exit' ? '🔴' : level === 'error' ? '⚠️' : level === 'skip' ? '⋯' : 'ℹ️';
  console.log(`[india-agent] ${tag} ${text}`);
}

// ---------------- agent trade accounting (journal is truth) ----------------
// CROSS-AGENT HYGIENE: market INDIA + source 'india-agent' — never the
// crypto agent's 'agent' marker, never manual India trades.
function indiaAgentTradesToday(j) {
  const day = todayIST();
  return (j?.entries || []).filter(e => e.day === day && e.kind === 'ORDER'
    && e.market === 'INDIA' && e.source === 'india-agent'
    && e.status !== 'REJECTED' && e.status !== 'NOTIFIED');
}
function indiaAgentRealizedToday(j) {
  const day = todayIST();
  return (j?.entries || [])
    .filter(e => e.day === day && (e.kind === 'CLOSE' || e.kind === 'PARTIAL_TP')
      && e.market === 'INDIA' && e.source === 'india-agent')
    .reduce((a, e) => a + (e.pnlINR || 0), 0);
}
function openIndiaAgentPositions(j) {
  return (j?.positions || []).filter(p => p.market === 'INDIA'
    && p.source === 'india-agent' && (p.status === 'OPEN' || p.status === 'UNKNOWN'));
}
/** Rolling win-rate over the last N closed india-agent trades (total pnl
 *  per trade = final leg + booked T1/T2 legs). null until N exist. */
export function rollingIndiaAgentWinRate(j, n = 10) {
  const closed = (j?.positions || [])
    .filter(p => p.market === 'INDIA' && p.source === 'india-agent' && String(p.status || '').toUpperCase() === 'CLOSED')
    .sort((a, b) => (b.closedAt || b.updatedAt || 0) - (a.closedAt || a.updatedAt || 0))
    .slice(0, Math.max(1, Number(n) || 10))
    .map(p => ({ symbol: p.symbol, pnlINR: (p.pnlINR ?? 0) + (p.bookedPnlINR ?? 0) }));
  if (closed.length < n) return null;
  const wins = closed.filter(t => t.pnlINR > 0).length;
  return Math.round((wins / closed.length) * 1000) / 10;
}

// ---------------- start / stop ----------------
export async function indiaAgentStart({ mode, liveConfirmPhrase } = {}) {
  const cfg = loadIndiaAgentConfig();
  const trading = loadConfig();
  const wantMode = mode === 'live' ? 'live' : mode === 'paper' ? 'paper' : mode === 'notify' ? 'notify' : cfg.mode;
  if (wantMode === 'live') {
    if (String(liveConfirmPhrase || '').trim().toUpperCase() !== 'LIVE') {
      const e = new Error('Starting the India agent in LIVE requires liveConfirmPhrase="LIVE" (typed confirmation)');
      e.status = 400; throw e;
    }
    if (!dhanConnected()) { const e = new Error('Dhan not connected — Client ID + Access Token first (Execution Console)'); e.status = 400; throw e; }
    if (trading.indiaMode !== 'live') {
      const e = new Error('India LIVE arming missing — type LIVE in Risk settings (India arming is separate from crypto)');
      e.status = 400; throw e;
    }
  }
  const next = { ...cfg, enabled: true, mode: wantMode };
  saveIndiaAgentConfig(next);
  _state.runningSince = Date.now();
  _state.pausedToday = null;
  log('info', `INDIA AGENT STARTED (${wantMode.toUpperCase()}) — max ${next.maxTradesPerDay} trades/day · risk ${next.riskPerTradePct}% of ₹${r2(next.equityINR)} · entries 09:30–15:00 · EOD square-off 15:15 · PRO exits: T1 ${next.partialTpEnabled ? `${next.tp1ClosePct}%+BE-lock` : 'off'} · T2 ${next.tp2ClosePct}% · runner ${next.runnerPct}% trailing`);
  persistState();
  return { ok: true, config: next };
}
export function indiaAgentStop({ reason = 'user' } = {}) {
  const cfg = loadIndiaAgentConfig();
  saveIndiaAgentConfig({ ...cfg, enabled: false });
  log('info', `INDIA AGENT STOPPED (${reason})`);
  persistState();
  return { ok: true, config: { ...cfg, enabled: false } };
}

// ---------------- sizing preview (pure — the panel's "what would it invest") ----------------
export function indiaSizingPreview({ cfg, plan, trading }) {
  const c = cfg || loadIndiaAgentConfig();
  const t = trading || loadConfig();
  const eq = Number(c.equityINR) > 0 ? Number(c.equityINR) : 10_000;
  const riskINR = r2(eq * (c.riskPerTradePct / 100));
  const p = plan || null;
  const entry = Number(p?.entry);
  if (!(entry > 0)) {
    return {
      desk: null, riskINR, riskPct: c.riskPerTradePct, equityINR: r2(eq),
      note: `₹${r2(riskINR)} risk budget ready (${c.riskPerTradePct}% of ₹${r2(eq)}) — plan ka intezaar next qualifying signal se`,
    };
  }
  const riskPct = Number(p.riskPct) > 0 ? Number(p.riskPct) : 5;
  const venueCap = Number(t.indiaMaxOrderINR) > 0 ? Number(t.indiaMaxOrderINR) : 5000;
  const budgetINR = Math.min(venueCap, Math.max(100, (riskINR / riskPct) * 100), Math.max(100, eq * 0.6));
  const qty = Math.max(1, Math.floor(budgetINR / entry));
  return {
    desk: 'INDIA', riskINR, riskPct: c.riskPerTradePct, equityINR: r2(eq),
    entry: r2(entry), stopLoss: r2(Number(p.stopLoss)), riskPctOfPlan: riskPct,
    budgetINR: r2(budgetINR), venueCapINR: r2(venueCap),
    qty, // whole shares (1-share practice floor inside the gauntlet)
    note: `₹${r2(riskINR)} risk (${c.riskPerTradePct}% of ₹${r2(eq)}) → ₹${r2(budgetINR)} order → ${qty} shares @ ₹${r2(entry)}`,
  };
}

// ---------------- the agent loop ----------------
let _ticking = false;
/**
 * One agent cycle. routes.js calls this every INDIA_AGENT_TICK_SEC (unref'd).
 * `deps` = the same depsForSignals() the boards use; `sendTelegram` best-effort.
 */
export async function indiaAgentTick(deps, sendTelegram) {
  if (_ticking) return; // never overlap cycles
  _ticking = true;
  try {
    await _tick(deps, sendTelegram);
  } catch (e) {
    log('error', `cycle error: ${String(e?.message || e).slice(0, 160)}`);
    persistState();
  } finally {
    _ticking = false;
  }
}

async function _tick(deps, sendTelegram) {
  const cfg = loadIndiaAgentConfig();
  const trading = loadConfig();
  _state.scans++;
  _state.lastScanAt = Date.now();
  if (_state.runningSince == null) _state.runningSince = _state.lastScanAt;

  // ---- hard stops (each records its blocker for the panel strip) ----
  if (!cfg.enabled) return;
  if (trading.killSwitch) {
    maybeLogSkip('kill_switch', 'kill switch ON — agent idle');
    await alertOnce(sendTelegram, 'kill_switch', '🇮🇳 <b>INDIA AGENT idle</b> — kill switch ON hai (Risk settings).');
    persistState(); return;
  }
  if (cfg.mode === 'live' && (!dhanConnected() || trading.indiaMode !== 'live')) {
    maybeLogSkip('live_preconditions', 'LIVE preconditions lost (Dhan connect / India arming) — agent idle');
    await alertOnce(sendTelegram, 'live_preconditions', '🇮🇳 <b>INDIA AGENT idle</b> — LIVE preconditions toot gayi (Dhan connect + India Risk mode LIVE check karo).');
    persistState(); return;
  }

  // ---- day rollover ----
  const day = todayIST();
  if (_state.pausedToday && _state.pausedToday.day !== day) _state.pausedToday = null;

  // ---- NSE CLOCK (the India-specific gate) ----
  const mins = istHM();
  const nseOpen = isNseOpen();
  const inEntryWindow = nseOpen && mins >= IST_ENTRY_FIRST && mins <= IST_ENTRY_LAST;
  const squareOffNow = mins >= IST_SQUAREOFF; // 15:15

  // ---- journal state ----
  const j = loadJournal();
  const tradesToday = indiaAgentTradesToday(j);
  const openAgent = openIndiaAgentPositions(j);

  // ---- desk capital (no exchange wallet on this desk — explicit config) ----
  const equityINR = Number(cfg.equityINR) > 0 ? Number(cfg.equityINR) : 10_000;

  // ---- daily loss cap (agent's own, on top of the venue ₹ cap) ----
  if (_state.pausedToday) { persistState(); return; }
  const agentPnl = indiaAgentRealizedToday(j);
  const lossCapINR = equityINR * (cfg.dailyLossCapPct / 100);
  if (tradesToday.length > 0 && agentPnl <= -lossCapINR) {
    _state.pausedToday = { day, reason: `daily loss cap hit: ₹${r2(agentPnl)} ≤ −₹${r2(lossCapINR)} (${cfg.dailyLossCapPct}% of desk capital)` };
    log('skip', `STANDING DOWN for today — ${_state.pausedToday.reason}`);
    await notify(sendTelegram, `🇮🇳 <b>INDIA AGENT stood down</b> — ${_state.pausedToday.reason}\nKal phir se ${cfg.maxTradesPerDay} fresh trades.`);
    persistState(); return;
  }

  // ---- rolling win-rate self-check (LIVE only — paper bleeds nothing) ----
  if (cfg.mode === 'live') {
    const wr = rollingIndiaAgentWinRate(j, cfg.rollingWindow);
    if (wr != null && wr < cfg.minRollingWinRate) {
      const next = { ...cfg, mode: 'paper' };
      saveIndiaAgentConfig(next);
      _state.winRateDowngraded = { at: Date.now(), winRate: wr, trades: cfg.rollingWindow };
      log('skip', `SELF-DOWNGRADE LIVE→PAPER — rolling win-rate ${wr}% (last ${cfg.rollingWindow}) < floor ${cfg.minRollingWinRate}%`);
      await notify(sendTelegram,
        `🇮🇳 <b>INDIA AGENT self-downgrade: LIVE → PAPER</b>\nLast ${cfg.rollingWindow} trades ka win-rate ${wr}% (floor ${cfg.minRollingWinRate}%).\nLIVE re-arm karne se pehle signals review karo (agent log + trust layer).`);
      cfg.mode = 'paper'; // this tick continues safely in paper
    } else if (wr != null) {
      _state.winRateDowngraded = null;
    }
  }

  // ---- equity floor ----
  if (equityINR < cfg.minEquityINR) {
    maybeLogSkip('equity_floor', `desk capital ₹${r2(equityINR)} < floor ₹${r2(cfg.minEquityINR)} — not trading (capital config raise karo)`);
    await alertOnce(sendTelegram, 'equity_floor',
      `🇮🇳 <b>INDIA AGENT entry paused</b> — desk capital ₹${r2(equityINR)} floor ₹${r2(cfg.minEquityINR)} se neeche hai.\nAGENT panel me capital config raise karo — scans turant resume honge.`);
    persistState(); return;
  }

  // ---- v10.15 GAP 4: GLOBAL RISK BRAIN (India side) — the India desk
  // consults the SAME combined-heat view the crypto desk does: over the
  // shared ceiling → veto here too; global risk-off → size-down here
  // too. "Max-long NIFTY IT + max-long crypto" is ONE bet — now the
  // system finally sees it. ----
  let grGate = null;
  try {
    const { agentLastWalletEquityINR } = await import('./agent.js');
    // v21.23.14 [CROSS-DESK CAPITAL]: use the crypto agent's last refreshed
    // wallet equity when available; the old hardcoded ?10k understated a
    // connected account and made the combined-heat cap fire late. Practice
    // ?10k remains only the honest cold-start fallback.
    const cxEq = Number(agentLastWalletEquityINR?.());
    const cxEquityINR = cxEq > 0 ? cxEq : 10_000;
    grGate = await globalRiskGate({
      cryptoEquityINR: cxEquityINR,
      indiaCapitalINR: equityINR,
    });
    if (grGate.veto) {
      maybeLogSkip('global_heat', `GLOBAL RISK BRAIN — entry vetoed: ${grGate.reason}; dono desks ka combined heat cap cross ho gaya hai`);
      persistState(); return;
    }
    if (grGate.riskOff) {
      log('info', `GLOBAL RISK BRAIN — risk-off regime (VIX spike + BTC breakdown): new-entry sizing ×${grGate.sizeMul} across BOTH desks`);
    }
  } catch (e) {
    log('error', `global-risk gate error (entry continues on desk-local rules): ${String(e?.message || e).slice(0, 100)}`);
  }

  // ---- EOD SQUARE-OFF INSURANCE (15:15+): the venue watcher square-offs
  // at 15:15 on its own timer; this sweep catches anything it missed
  // (a watcher tick that landed before 15:15, a live order retry, a
  // crash-recovered position) and hard-stops the day. No entries after. ----
  if (squareOffNow) {
    let closed = 0;
    for (const p of openAgent) {
      const out = await closeIndiaPosition(p.id, { reason: 'EOD-SQUARE-OFF 15:15 IST (agent)' })
        .catch(e => ({ ok: false, error: String(e?.message || e) }));
      if (out?.ok) {
        closed++;
        const totalPnl = (out.position?.pnlINR ?? 0) + (out.position?.bookedPnlINR ?? 0);
        log('exit', `EOD-SQUARE-OFF ${p.symbol} — intraday discipline: position ₹${r2(totalPnl)} pe cut (booked legs included)`);
        if (_state.entryMeta) delete _state.entryMeta[p.symbol];
      } else if (!/not found|already closed/.test(String(out?.error || ''))) {
        log('error', `EOD square-off failed for ${p.symbol}: ${String(out?.error || '').slice(0, 100)}`);
      }
    }
    if (closed > 0) {
      await notify(sendTelegram, `🇮🇳 <b>INDIA AGENT EOD square-off</b> — ${closed} position(s) force-closed at 15:15 IST. Kal 09:30 se fresh session.`);
    }
    maybeLogSkip('eod', 'EOD square-off window (15:15+) — koi fresh entry nahi, session band');
    persistState(); return;
  }

  // ---- outside NSE hours entirely: nothing can move ----
  if (!nseOpen) {
    maybeLogSkip('nse_closed', 'NSE band hai (M–F 09:15–15:30 IST) — agent idle');
    persistState(); return;
  }

  // ---- scan the India board ONCE (cached server-side; cheap) ----
  const { getSignals } = await import('./signals.js');
  const board = await getSignals('INDIA', deps, { limit: 20 }).catch(() => null);
  const signalOf = (s) => Number(s?.superIntel?.aiScore ?? 0);
  const voterCount = (s) => Number(s?.voters ?? s?.participating ?? 0);
  // v10.2 parity — QUORUM-AWARE threshold: thin committees (<5 voters)
  // need MORE conviction to touch money, not less.
  const qualifies = (s) => !!(s && s.plan && s.side && (
    signalOf(s) >= effectiveScoreBar(cfg, s) || (
      s.grade === 'STRONG' && s.executable
      && (s.confidence ?? 0) >= cfg.minConfidence
      && (s.agreement ?? 0) >= cfg.minAgreement
    )
  ));

  // ---- v10.15 GAP 1: LIVE CONVICTION SWEEP (India parity) — the
  // ensemble re-votes every open India position via the SAME cached
  // deep path the board uses. FLIPPED (opposite-side quorum) →
  // conviction-flip exit BEFORE the stop; WEAKENING while in profit →
  // SL ratcheted toward breakeven via the existing ratchet helper.
  // Runs inside this tick's gauntlet (kill-switch/NSE-clock gates
  // above) — an exit can never bypass the caps. ----
  const convictionBySymbol = new Map();
  const convictionExited = new Set(); // ids closed by the conviction sweep this tick
  if (convictionEnabled(cfg) && openAgent.length > 0) {
    const { getDeepSignal } = await import('./signals.js');
    const convictionClosures = [];
    const convictionTightened = [];
    const rows = await fetchTVIndiaBatch([...new Set(openAgent.map(p => p.symbol))]).catch(() => ({}));
    for (const p of openAgent) {
      const deep = await getDeepSignal(p.symbol, 'INDIA', deps).catch(() => null);
      const entryScore = Number(_state.entryMeta?.[p.symbol]?.convictionScore);
      const c = deep?.ok ? convictionOfPosition({ side: p.side }, deep.signal, Number.isFinite(entryScore) ? entryScore : null, { threshold: cfg.convictionThreshold })
        : { state: 'UNKNOWN', delta: null, currentScore: null, side: null };
      convictionBySymbol.set(p.symbol, { ...c, entryScore: Number.isFinite(entryScore) ? entryScore : null });
      _state.conviction = _state.conviction || {};
      _state.conviction[p.symbol] = { ...c, entryScore: Number.isFinite(entryScore) ? entryScore : null, at: Date.now() };
      if (c.state === 'FLIPPED') {
        const out = await closeIndiaPosition(p.id, { reason: `CONVICTION-FLIP: ensemble flipped ${c.side} (score ${c.currentScore}, entry ${Number.isFinite(entryScore) ? entryScore : '?'}) — thesis invalidated, stop se PEHLE bahar` })
          .catch(e => ({ ok: false, error: String(e?.message || e) }));
        if (out?.ok) {
          const totalPnl = (out.position?.pnlINR ?? 0) + (out.position?.bookedPnlINR ?? 0);
          convictionClosures.push({ symbol: p.symbol, pnlINR: totalPnl, score: c.currentScore });
          convictionExited.add(p.id);
          log('exit', `CONVICTION-FLIP EXIT ${p.symbol} — ensemble flipped ${c.side} (score ${c.currentScore}, entry ${Number.isFinite(entryScore) ? entryScore : '?'}) → cut at ₹${r2(totalPnl)} BEFORE the stop`);
          if (_state.entryMeta) delete _state.entryMeta[p.symbol];
          if (_state.conviction) delete _state.conviction[p.symbol];
        } else if (!/not found|already closed/.test(String(out?.error || ''))) {
          log('error', `conviction-flip close failed for ${p.symbol}: ${String(out?.error || '').slice(0, 100)}`);
        }
      } else if (c.state === 'WEAKENING') {
        // in-profit check from the live LTP (the watcher's own source)
        const ltp = Number(rows[p.symbol]?.ltp);
        const inProfit = Number.isFinite(ltp) && ltp > 0 && Number(p.entryPrice) > 0
          ? (p.side === 'LONG' ? ltp > p.entryPrice : ltp < p.entryPrice) : false;
        if (inProfit) {
          const moved = await adjustAgentPositionSl(p.id, p.entryPrice, `CONVICTION WEAKENING (delta ${c.delta}) + in profit → SL → ₹${r2(p.entryPrice)} breakeven ratchet`, p);
          if (moved?.ok) convictionTightened.push({ symbol: p.symbol, delta: c.delta });
        }
      }
    }
    if (convictionClosures.length > 0) {
      await notify(sendTelegram, `🇮🇳 <b>INDIA AGENT conviction-flip exit</b> — thesis invalidated\n${convictionClosures.map(c => `• ${c.symbol} — ensemble ab OPPOSITE side (${c.score}%) → cut at ₹${r2(c.pnlINR)} (stop se PEHLE bahar)`).join('\n')}`);
    }
    if (convictionTightened.length > 0) {
      log('exit', `CONVICTION WEAKENING ×${convictionTightened.length} — ${convictionTightened.map(c => `${c.symbol} (delta ${c.delta})`).join(', ')} → SL ratcheted to breakeven (positions kept)`);
    }
  }

  // ---- v11.1 GAP 2: CIRCUIT-LIMIT SWEEP (open India positions) ----
  // A position drifting toward an ADVERSE circuit gets an URGENT,
  // distinct alert — different from a normal SL-approach warning,
  // because the usual "tighten the stop" playbook is useless when the
  // stock is about to stop trading entirely. Groww's quote carries the
  // day's band; 10-min per-symbol cooldown; ANALYSIS-ONLY (never an
  // auto-exit — exits stay inside the gauntlet below).
  if (openAgent.length > 0 && nseOpen) {
    const circuitAlerts = [];
    _state.circuitAlerts = _state.circuitAlerts || {};
    for (const p of openAgent) {
      try {
        const q = await fetchGrowwNseQuote(p.symbol);
        const risk = adverseCircuitRisk({ side: p.side }, q);
        if (!risk || !risk.adverse) continue;
        const key = `circuit:${p.symbol}`;
        if (Date.now() - Number(_state.circuitAlerts[key] || 0) < 10 * 60 * 1000) continue;
        _state.circuitAlerts[key] = Date.now();
        circuitAlerts.push({ symbol: p.symbol, side: p.side, note: risk.note });
        log('exit', `CIRCUIT RISK ${p.symbol} (${p.side}) — ${risk.frozen ? 'FROZEN at' : 'approaching'} ${risk.band} circuit, ${risk.distPct.toFixed(1)}% door — exit liquidity danger`);
      } catch { /* quote optional — skip this symbol this tick */ }
    }
    if (circuitAlerts.length > 0) {
      await notify(sendTelegram, `🚨 <b>INDIA AGENT circuit-limit risk</b> — exit liquidity danger\n${circuitAlerts.map(a => `• <b>${a.symbol}</b> (${a.side}): ${a.note}`).join('\n')}\nUsual SL playbook yahan kaam nahi karta — jo nikal sakte ho abhi nikalo.`);
    }
  }

  // ---- time-exit sweep (ATR-adaptive windows) ----
  const timeExited = new Set();
  for (const p of openAgent) {
    if (convictionExited.has(p.id)) continue; // v10.15: conviction-flip already closed it
    const holdMin = holdWindowFor(cfg, p.symbol);
    const ageMin = (Date.now() - (p.openedAt || 0)) / 60000;
    if (ageMin >= holdMin) {
      const out = await closeIndiaPosition(p.id, { reason: `TIME-EXIT after ${Math.round(ageMin)}m${holdMin !== cfg.maxHoldMin ? ` (dynamic window ${holdMin}m — ATR-adaptive)` : ''}` })
        .catch(e => ({ ok: false, error: String(e?.message || e) }));
      if (out?.ok) {
        timeExited.add(p.id);
        const totalPnl = (out.position?.pnlINR ?? 0) + (out.position?.bookedPnlINR ?? 0);
        log('exit', `TIME-EXIT ${p.symbol} after ${Math.round(ageMin)}m (window ${holdMin}m) — pnl ₹${r2(totalPnl)}`);
        if (_state.entryMeta) delete _state.entryMeta[p.symbol];
      } else {
        log('error', `time-exit failed for ${p.symbol}: ${String(out?.error || '').slice(0, 100)}`);
      }
    }
  }

  // ---- PRO 3-TIER PARTIAL-TP manager (T1/T2 legs + BE-lock + runner) ----
  if (cfg.partialTpEnabled !== false) {
    try { await managePartialTp(openAgent, cfg, sendTelegram); }
    catch (e) { log('error', `partial-TP manager error: ${String(e?.message || e).slice(0, 120)}`); }
  }

  // ---- TREND-FLIP auto-exit ("auto exit as per market trend"): the
  // board prints a QUALIFYING signal on the OPPOSITE side of a held
  // symbol → the position is cut immediately. A cooldown is stamped so
  // the flip side can only re-enter after cooldownMin. ----
  for (const p of openAgent) {
    if (timeExited.has(p.id)) continue;
    if (convictionExited.has(p.id)) continue; // v10.15: conviction-flip already closed it
    const posSide = String(p.side || '').toUpperCase().startsWith('L') || /^(L|B)/i.test(String(p.side || '')) ? 'BUY' : 'SELL';
    let flipped = null;
    if (board?.ok) {
      for (const s of (board.signals || [])) {
        if (String(s.symbol || '').toUpperCase() !== String(p.symbol || '').toUpperCase()) continue;
        const raw = String(s.side || '').toUpperCase();
        const sSide = raw === 'SHORT' || raw === 'SELL' ? 'SELL' : 'BUY';
        if (sSide !== posSide && qualifies(s)) { flipped = s; break; }
      }
    }
    if (!flipped) continue;
    const out = await closeIndiaPosition(p.id, { reason: `TREND-FLIP: board flipped ${flipped.side} (AI ${signalOf(flipped) || flipped.confidence}%)` })
      .catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (out?.ok) {
      _state.lastEntryAt = Date.now(); // the flip side re-enters only after cooldown
      const totalPnl = (out.position?.pnlINR ?? 0) + (out.position?.bookedPnlINR ?? 0);
      log('exit', `TREND-FLIP EXIT ${p.symbol} — board flipped ${flipped.side} (AI ${signalOf(flipped) || flipped.confidence}%) → cut at ₹${r2(totalPnl)} total`);
      await notify(sendTelegram, `🇮🇳 <b>INDIA AGENT trend-flip exit</b> — ${p.symbol}\nBoard ab ${flipped.side} side pe ${signalOf(flipped) || flipped.confidence}% conviction: position ₹${r2(totalPnl)} pe cut. Re-entry cooldown (${cfg.cooldownMin}m) ke baad.`);
    } else if (!/not found|already closed/.test(String(out?.error || ''))) {
      log('error', `trend-flip close failed for ${p.symbol}: ${String(out?.error || '').slice(0, 100)}`);
    }
  }

  // ---- entry gates ----
  // The NSE entry window applies to PAPER too: an intraday agent that
  // fills paper trades at stale after-hours prices would journal a
  // fake track record (the venue gate is LIVE-only; the agent is not).
  if (!inEntryWindow) {
    const why = !nseOpen ? 'NSE band' : (mins < IST_ENTRY_FIRST ? `before 09:30 (opening chop window, ${Math.round(IST_ENTRY_FIRST - mins)}m baaki)` : `after 15:00 (late-entry gate, square-off 15:15)`);
    maybeLogSkip('entry_window', `entry window ke bahar — ${why}`);
    persistState(); return;
  }

  // ---- 3-trade daily cap ----
  if (tradesToday.length >= cfg.maxTradesPerDay) {
    maybeLogSkip('quota', `quota ${tradesToday.length}/${cfg.maxTradesPerDay} used — waiting for IST midnight`);
    persistState(); return;
  }

  // ---- cooldown between entries ----
  if (_state.lastEntryAt && (Date.now() - _state.lastEntryAt) / 60000 < cfg.cooldownMin) {
    const left = Math.max(1, Math.ceil(cfg.cooldownMin - (Date.now() - _state.lastEntryAt) / 60000));
    maybeLogSkip('cooldown', `entry cooldown — ${left}m baaki (flip-side re-entry guard)`);
    persistState(); return;
  }

  // ---- candidates ----
  const candidates = [];
  // v21.0.2 INDEX-POLLUTION FIX: NIFTY/BANKNIFTY jaise index contexts INDIA
  // board me bhi chalte hain (signals.js board seeding), par indiaAgent
  // EQUITY desk hai — index qualify hone par LIVE dhanPlaceOrder "not
  // NSE-equity" se reject hota tha aur PAPER 1-share NIFTY (~₹24k ka
  // pseudo-equity practice position) khol deta tha, track-record ganda
  // karta tha. Index symbols ko yahin filter kar do — options desk hi
  // index ka sahi rakam hai (getOptionSignalsView).
  const _INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'INDIAVIX']);
  if (board?.ok) {
    for (const s of (board.signals || [])) {
      // v18.10 defensive: qualifies() already requires s.plan, but the
      // crypto twin's cycle-crash (plan-null row → riskPct TypeError)
      // taught us the guard belongs HERE too — ordering can silently
      // change in future refactors.
      if (!s?.plan || !s.side) continue;
      // v21.23.4 WRONG-SIGNAL-REMOVAL: data-degraded signal (15m tape
      // absent / TF-thin) kabhi auto-enter nahi hota — daily-fallback
      // "90% opposite" disease class, remove karo (v21.23.4).
      if (s.dataDegraded) continue;
      if (_INDEX_SYMBOLS.has(String(s.symbol || '').toUpperCase())) continue; // v21.0.2
      if (!qualifies(s)) continue;
      if ((s.plan.riskPct ?? 0) > (trading.maxRiskPct || 5)) continue;
      // already positioned on this symbol? skip (one-per-symbol anyway)
      if ((j.positions || []).some(p => p.market === 'INDIA' && p.symbol === String(s.symbol || '').toUpperCase()
        && (p.status === 'OPEN' || p.status === 'UNKNOWN'))) continue;
      candidates.push(s);
    }
  }
  if (candidates.length === 0) {
    // v10.2 parity: NEAR-MISS DIAGNOSTICS — top-3 closest signals
    const nearMisses = [];
    if (board?.ok) {
      for (const s of (board.signals || [])) {
        if (!s?.plan || !s.side) continue;
        const ai = signalOf(s);
        const vc = voterCount(s);
        const quorumCapped = vc < 5;
        const needScore = effectiveScoreBar(cfg, s); // v10.16 S3: ONE truth (proportional)
        nearMisses.push({
          symbol: s.symbol, aiScore: ai, needScore, voters: vc, quorumCapped,
          confidence: Math.round(s.confidence ?? 0), agreement: Math.round((s.agreement ?? 0) * 100),
          ...(Array.isArray(s.abstentions) && s.abstentions.length > 0
            ? { abstained: s.abstentions.map(a => a.name || a.id) } : {}),
        });
      }
    }
    nearMisses.sort((a, b) => (b.aiScore - a.aiScore) || (b.confidence - a.confidence));
    _state.lastNearMisses = nearMisses.slice(0, 3);
    maybeLogSkip('no_candidates', `scan: 0 candidates ≥ ${cfg.minAiScore} AI score / ${cfg.minConfidence}% conf + ${Math.round(cfg.minAgreement * 100)}% agreement`);
    persistState(); return;
  }
  candidates.sort((a, b) => (signalOf(b) - signalOf(a)) || (b.confidence - a.confidence));
  let best = candidates[0];

  // ---- v10.15 GAP 3: PATIENT ENTRY — the resting order comes FIRST
  // (10m NSE window). Touched level → execute the PLANNED entry (if the
  // board still backs the side); expired → journal missed-pullback (the
  // discipline win); waiting → the fresh candidate flow continues. ----
  let patientFill = null;
  if (patientEntryEnabled(cfg) && _state.patient) {
    const pd = _state.patient;
    const boardLtp = (sym) => {
      const s = (board?.signals || []).find(x => String(x.symbol || '').toUpperCase() === String(sym || '').toUpperCase());
      return Number(s?.ltp) || null;
    };
    const act = patientPendingAction({ pending: pd, ltp: boardLtp(pd.symbol), now: Date.now() });
    if (act.action === 'fill') {
      const freshSig = (board?.signals || []).find(x =>
        String(x.symbol || '').toUpperCase() === String(pd.symbol || '').toUpperCase()
        && String(x.side || '').toUpperCase() === String(pd.side || '').toUpperCase() && qualifies(x));
      if (freshSig) {
        best = freshSig;
        patientFill = { ...pd };
        _state.patient = null;
        log('info', `PATIENT FILL — ${pd.symbol} pullback level ₹${pd.level} (${pd.basis}) touched → executing (the planned entry)`);
      } else {
        _state.patient = null;
        log('skip', `PATIENT ENTRY invalidated — ${pd.symbol} ka same-side signal board se gayab; resting order cancelled`);
        await withJournalLock(async () => {
          const jj = loadJournal();
          pushEntry(jj, { kind: 'MISSED_PULLBACK', day: todayIST(), market: 'INDIA', source: 'india-agent', symbol: pd.symbol, text: `PATIENT ENTRY invalidated — signal gone before fill (level ₹${pd.level})` });
          saveJournal(jj);
        }).catch(() => { /* best-effort marker */ });
      }
    } else if (act.action === 'expire') {
      _state.patient = null;
      log('skip', `MISSED-PULLBACK ${pd.symbol} — 10m window expired, level ₹${pd.level} (${pd.basis}) never touched. GOOD outcome: chase nahi kiya.`);
      await withJournalLock(async () => {
        const jj = loadJournal();
        pushEntry(jj, { kind: 'MISSED_PULLBACK', day: todayIST(), market: 'INDIA', source: 'india-agent', symbol: pd.symbol, text: `PATIENT ENTRY expired unfilled — level ₹${pd.level} (${pd.basis}) not touched in 10m; chase nahi kiya (discipline win)` });
        saveJournal(jj);
      }).catch(() => { /* best-effort marker */ });
    }
  }

  // ---- record the entry's volatility for its dynamic time-exit window ----
  const atrPctOf = (s) => {
    const p = s?.plan || {};
    const ltp = Number(s?.ltp || p.entry);
    const atr = Number(p.atrUsed);
    if (Number.isFinite(atr) && atr > 0 && ltp > 0) return (atr / ltp) * 100;
    const rp = Number(p.riskPct);
    return Number.isFinite(rp) && rp > 0 ? rp : null;
  };
  const entryAtrPct = atrPctOf(best);
  _state.entryMeta = _state.entryMeta || {};
  // v10.15 GAP 1: record the ENTRY conviction score (the delta anchor)
  _state.entryMeta[best.symbol] = {
    atrPct: entryAtrPct, at: Date.now(),
    convictionScore: Number(best?.superIntel?.aiScore ?? best?.confidence ?? null),
  };
  if (entryAtrPct != null && cfg.dynamicTimeExit !== false) {
    log('info', `ENTRY VOLATILITY ${best.symbol}: ATR ${r2(entryAtrPct)}% → dynamic time-exit window ${dynamicMaxHoldMin(cfg, entryAtrPct)}m (base ${cfg.maxHoldMin}m)`);
  }

  // ---- v10.15 GAP 2: EVENT GUARD — the India gauntlet asks "kuch
  // scheduled hai kya?" before entry: T-30min before earnings/RBI/
  // CPI/IIP → veto with a reason; T-2h → the budget is haircut. ----
  const eg = eventGuardCheck({ symbol: best.symbol, desk: 'INDIA' });
  if (eg.action === 'blackout') {
    maybeLogSkip('event_guard', `EVENT GUARD — ${best.symbol} ${best.side} entry blocked: ${eg.reason}`);
    persistState(); return;
  }
  const eventSizeMul = eg.action === 'haircut' ? eg.multiplier : 1;
  if (eg.action === 'haircut') log('info', `EVENT GUARD — ${best.symbol}: ${eg.reason}`);

  // ---- v10.15 GAP 3: PATIENT ENTRY classification — EXTENDED signal
  // (>1.5 ATR beyond its anchor) rests at a depth-derived pullback level
  // for the 10m window instead of chasing; at-anchor → immediate as today. ----
  if (patientEntryEnabled(cfg) && !patientFill && !_state.patient) {
    const ltpNow = Number(best.ltp || best.plan.entry);
    const entryAnchor = Number(best.plan.entry);
    const atrUnits = Number(best.plan.atrUsed);
    if (classifyEntry({ ltp: ltpNow, entry: entryAnchor, atr: atrUnits }) === 'extended') {
      const depth = await readDepth('INDIA', best.symbol, { ltp: ltpNow }).catch(() => null);
      const { level, basis } = pullbackLevelFor({ side: best.side, ltp: ltpNow, entry: entryAnchor, depth: depth?.ok ? depth : null });
      _state.patient = {
        symbol: best.symbol, market: 'INDIA', pair: best.symbol, side: best.side,
        level, basis, createdAt: Date.now(),
        expiresAt: Date.now() + patientWindowMin('INDIA') * 60_000,
      };
      log('info', `PATIENT ENTRY placed — ${best.symbol} ${best.side} extended: resting limit @ ₹${level} (${basis}) for ${patientWindowMin('INDIA')}m instead of chasing ₹${r2(ltpNow)}`);
      await notify(sendTelegram, `🇮🇳 <b>INDIA AGENT patient entry</b> — ${best.symbol} ${best.side}\nAnchor se extended (chase risk) → resting limit @ <b>₹${level}</b> (${basis}) · window ${patientWindowMin('INDIA')}m`);
      await withJournalLock(async () => {
        const jj = loadJournal();
        pushEntry(jj, { kind: 'PATIENT', day: todayIST(), market: 'INDIA', source: 'india-agent', symbol: best.symbol, text: `PATIENT ENTRY resting — ${best.symbol} ${best.side} extended; limit @ ₹${level} (${basis}), window ${patientWindowMin('INDIA')}m`, level, basis });
        saveJournal(jj);
      }).catch(() => { /* best-effort marker */ });
      persistState(); return; // resting now — no chase this cycle
    }
  }

  // ---- sizing (transparent log before execution — auditable) ----
  // v10.15 GAP 4: a global risk-off regime down-weights this desk too.
  const grMul = grGate?.riskOff ? grGate.sizeMul : 1;
  const riskINR = equityINR * (cfg.riskPerTradePct / 100) * eventSizeMul * grMul;
  if (eventSizeMul < 1) log('info', `EVENT GUARD SIZING ${best.symbol}: risk ×${eventSizeMul} → ₹${r2(riskINR)} (${eg.reason})`);
  if (grMul < 1) log('info', `GLOBAL RISK-OFF SIZING ${best.symbol}: risk ×${grMul} → ₹${r2(riskINR)} (VIX spike + BTC breakdown regime)`);
  const budgetINR = Math.min(
    Number(trading.indiaMaxOrderINR) > 0 ? Number(trading.indiaMaxOrderINR) : 5000,
    Math.max(100, (riskINR / (best.plan.riskPct || 5)) * 100),
    Math.max(100, equityINR * 0.6),
  );
  log('info', `SIZING ${best.symbol}: ₹${r2(riskINR)} risk (${cfg.riskPerTradePct}% of ₹${r2(equityINR)}) → ₹${r2(budgetINR)} order @ ₹${r2(Number(best.plan.entry))}`);

  const crossLock = checkDirectionLock(best.symbol, best.side);
  if (crossLock && !crossLock.allowed) {
    log('info', `SKIP ${best.symbol}: ${crossLock.reason}`);
    persistState(); return;
  }

  // ---- entry via the SAME gauntlet a manual click passes ----
  const { getDeepSignal } = await import('./signals.js');
  const out = await executeIndiaSignal({
    symbol: best.symbol, side: best.side,
    mode: cfg.mode === 'live' ? 'live' : cfg.mode === 'notify' ? 'notify' : 'paper',
    qtyINR: budgetINR,
    getFreshIndiaSignal: async (sym) => {
      const deep = await getDeepSignal(sym, 'INDIA', deps).catch(() => null);
      return deep?.ok ? deep.signal : null;
    },
    source: 'india-agent',
    sendTelegram,
  });

  if (out?.ok) {
    _state.lastEntryAt = Date.now();
    _state.lastEntrySymbol = best.symbol;
    acquireDirectionLock({ symbol: best.symbol, side: best.side, source: 'india-agent', cooldownMin: cfg.flipReentryBlockMin || 240 });
    const f = out.filled || {};
    // v10.15 GAP 3: journal the ENTRY MODE — the weekly review's
    // "did patience pay?" join key (immediate vs patient).
    await withJournalLock(async () => {
      const jj = loadJournal();
      pushEntry(jj, {
        kind: 'ENTRY_MODE', day: todayIST(), market: 'INDIA', source: 'india-agent',
        symbol: best.symbol, positionId: out?.position?.id ?? null,
        mode: patientFill ? 'patient' : 'immediate',
        text: `ENTRY MODE ${patientFill ? 'PATIENT' : 'IMMEDIATE'} — ${best.symbol} ${best.side}${patientFill ? ` (pullback level ₹${patientFill.level}, ${patientFill.basis})` : ''}`,
      });
      saveJournal(jj);
    }).catch(() => { /* best-effort marker */ });
    if (out.mode === 'notify') {
      log('entry', `NOTIFY ${best.symbol} ${best.side} (${best.confidence}% conf) — alert-only, koi order nahi`);
    } else {
      log('entry', `AUTO-ENTRY ${best.symbol} ${best.side} (${best.confidence}% conf) — ${f.qty ?? '?'} shares @ ₹${f.price ?? best.plan.entry} · SL ₹${r2(Number(best.plan.stopLoss))} · T1 ₹${r2(Number(best.plan.target1))} · T2 ₹${r2(Number(best.plan.target2))} · EOD 15:15`);
      await notify(sendTelegram,
        `🇮🇳 <b>INDIA AGENT AUTO-ENTRY</b> — ${best.symbol} ${best.side}\n` +
        `Confidence ${best.confidence}% · agreement ${Math.round((best.agreement || 0) * 100)}% · trade ${tradesToday.length + 1}/${cfg.maxTradesPerDay} today\n` +
        `${f.qty ?? '?'} shares @ ₹${f.price ?? best.plan.entry} (₹${r2(f.notionalINR ?? budgetINR)})\n` +
        `SL ₹${r2(Number(best.plan.stopLoss))} · T2 ₹${r2(Number(best.plan.target2))} · EOD square-off 15:15 IST`);
    }
  } else {
    log('skip', `entry rejected — ${best.symbol} ${best.side}: ${String(out?.error || '').slice(0, 120)}`);
  }
  persistState();
}

// ---------------- PRO 3-tier partial-TP manager ----------------
/**
 * The agent's T1/T2 legs (crypto agent's v7.0 PRO exits, ported to the
 * India venue contract):
 *   T1 (p.tp)  → book tp1ClosePct% of ORIGINAL qty → SL → entry (BE)
 *   T2 (p.tp2) → book tp2ClosePct% of ORIGINAL qty → SL → T1, then the
 *                tp2 reference is CLEARED so the venue watcher's TP2
 *                full-close can't kill the runner — only trail-SL /
 *                EOD / time-exit / trend-flip close the remainder.
 * Positions too small to split (1-2 shares) take an honest FULL exit.
 */
async function managePartialTp(openAgent, cfg, sendTelegram) {
  if (!openAgent.length) return;
  const syms = [...new Set(openAgent.map(p => p.symbol))];
  const rows = await fetchTVIndiaBatch(syms).catch(() => ({}));
  for (const p of openAgent) {
    const ltp = Number(rows[p.symbol]?.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0) continue;
    const long = p.side === 'LONG';
    const orig = Number(p.originalQty ?? p.qty) || p.qty;
    const t1 = Number(p.tp);
    const t2 = Number(p.tp2);

    // ---- T1 leg ----
    if (!p.tp1Hit && t1 > 0 && (long ? ltp >= t1 : ltp <= t1)) {
      const legQty = Math.max(1, Math.floor(orig * (cfg.tp1ClosePct / 100)));
      if (legQty >= p.qty) {
        // too small to split — honest full exit at T1
        const out = await closeIndiaPosition(p.id, { reason: `T1 FULL-exit (${p.qty} share — split possible nahi)` }).catch(e => ({ ok: false, error: String(e?.message || e) }));
        if (out?.ok) {
          log('exit', `T1 FULL-EXIT ${p.symbol} — position ${p.qty} share thi, split ke liye chhoti; runner nahi bacha`);
          if (_state.entryMeta) delete _state.entryMeta[p.symbol];
        }
        continue;
      }
      const out = await closeIndiaPosition(p.id, { qty: legQty, reason: `T1 PARTIAL ${cfg.tp1ClosePct}% @ ₹${r2(ltp)}` }).catch(e => ({ ok: false, error: String(e?.message || e) }));
      if (out?.ok) {
        if (cfg.breakEvenAfterTp1) {
          await adjustAgentPositionSl(p.id, p.entryPrice, `BE-lock after T1: SL → ₹${r2(p.entryPrice)} (risk-free runner)`, p);
        }
        await stampAgentPosition(p.id, { tp1Hit: true, exitStage: 'T1_HIT' });
        log('exit', `T1 BOOKED ${p.symbol} — ${legQty}/${orig} shares @ ₹${r2(ltp)} · leg ₹${r2(out.leg?.pnlINR ?? 0)}${cfg.breakEvenAfterTp1 ? ` · SL → breakeven` : ''}`);
        await notify(sendTelegram, `🇮🇳 <b>INDIA AGENT T1 booked</b> — ${p.symbol}: ${legQty} shares @ ₹${r2(ltp)} (+₹${r2(out.leg?.pnlINR ?? 0)}).${cfg.breakEvenAfterTp1 ? ' SL → breakeven — runner risk-free.' : ''}`);
      } else if (!/not found|already closed/.test(String(out?.error || ''))) {
        log('error', `T1 partial failed for ${p.symbol}: ${String(out?.error || '').slice(0, 100)}`);
      }
      continue;
    }

    // ---- T2 leg (only after T1 booked) ----
    if (p.tp1Hit && !p.tp2Hit && t2 > 0 && (long ? ltp >= t2 : ltp <= t2)) {
      const legQty = Math.max(1, Math.floor(orig * (cfg.tp2ClosePct / 100)));
      if (legQty >= p.qty) {
        const out = await closeIndiaPosition(p.id, { reason: `T2 FULL-exit (${p.qty} share — runner ke liye kuch nahi bacha)` }).catch(e => ({ ok: false, error: String(e?.message || e) }));
        if (out?.ok) {
          log('exit', `T2 FULL-EXIT ${p.symbol} — runner ${p.qty} share hi bacha tha`);
          if (_state.entryMeta) delete _state.entryMeta[p.symbol];
        }
        continue;
      }
      const out = await closeIndiaPosition(p.id, { qty: legQty, reason: `T2 PARTIAL ${cfg.tp2ClosePct}% @ ₹${r2(ltp)}` }).catch(e => ({ ok: false, error: String(e?.message || e) }));
      if (out?.ok) {
        // SL → T1 (profit lock) + clear the tp2 reference so the venue
        // watcher's TP2 full-close leaves the RUNNER alone
        await adjustAgentPositionSl(p.id, t1 > 0 ? t1 : p.entryPrice, `SL→T1 lock after T2: SL → ₹${r2(t1 > 0 ? t1 : p.entryPrice)}`, p);
        await stampAgentPosition(p.id, { tp2Hit: true, tp2: null, exitStage: 'RUNNER' });
        log('exit', `T2 BOOKED ${p.symbol} — ${legQty} shares @ ₹${r2(ltp)} · leg ₹${r2(out.leg?.pnlINR ?? 0)} · runner ${p.qty - legQty} shares trailing (SL @ T1)`);
        await notify(sendTelegram, `🇮🇳 <b>INDIA AGENT T2 booked</b> — ${p.symbol}: ${legQty} shares @ ₹${r2(ltp)} (+₹${r2(out.leg?.pnlINR ?? 0)}). Runner ${p.qty - legQty} shares ab trail pe (SL @ T1).`);
      } else if (!/not found|already closed/.test(String(out?.error || ''))) {
        log('error', `T2 partial failed for ${p.symbol}: ${String(out?.error || '').slice(0, 100)}`);
      }
    }
  }
}

/**
 * SL ratchet on an agent position (BE-lock / T1-lock) — journal-locked,
 * LIVE broker SL cancel+replaced (same discipline as the venue watcher).
 * v11.4: exposed for the ratchet regression suite only — production
 * callers use the internal name.
 */
export const __adjustAgentPositionSlForTest = (positionId, newSl, note, cachedPos) =>
  adjustAgentPositionSl(positionId, newSl, note, cachedPos);
async function adjustAgentPositionSl(positionId, newSl, note, cachedPos) {
  if (!(Number(newSl) > 0)) return { ok: false, error: 'invalid SL' };
  return withJournalLock(async () => {
    const j = loadJournal();
    const p = j.positions.find(x => x.id === positionId || (cachedPos && x.id === cachedPos.id));
    if (!p || p.market !== 'INDIA' || (p.status !== 'OPEN' && p.status !== 'UNKNOWN')) return { ok: false, error: 'not open' };
    const long = p.side === 'LONG';
    // ratchet only tightens (same discipline as computeTrailSl users).
    // v11.4 recheck: this guard's body was EMPTY and `p.sl = r2(newSl)` ran
    // unconditionally — a conviction-weakening sweep (or a T1 BE-lock after
    // the venue watcher had trailed higher) could drag the stop back DOWN,
    // and in LIVE mode cancel+re-place the broker SL at the WORSE level.
    // Now a looser SL is rejected outright; equal is a no-op.
    if (p.sl > 0) {
      if (long ? newSl < p.sl : newSl > p.sl) {
        return { ok: false, error: `ratchet: new SL ${r2(newSl)} is looser than current ${p.sl}`, position: p };
      }
      if (r2(newSl) === p.sl) return { ok: true, position: p, unchanged: true };
    }
    p.sl = r2(newSl);
    // LIVE: broker SL follows (cancel + replace at the remainder qty)
    if (p.mode === 'live' && dhanConnected()) {
      if (p.slOrderId) { await dhanCancelOrder(p.slOrderId).catch(() => { /* best-effort */ }); p.slOrderId = null; }
      try {
        const o = await dhanPlaceOrder({ symbol: p.symbol, side: p.side, quantity: p.qty, kind: 'SL', triggerPrice: newSl });
        if (o?.orderId) p.slOrderId = o.orderId;
      } catch { /* watcher still guards */ }
    }
    pushEntry(j, {
      kind: 'TRAIL', day: todayIST(), pair: p.pair, symbol: p.symbol, market: 'INDIA',
      reason: note, from: cachedPos?.sl ?? null, to: r2(newSl),
    });
    saveJournal(j);
    return { ok: true, position: p };
  });
}

/** Stage flags on an agent position (tp1Hit/tp2Hit/exitStage/tp2-clear). */
async function stampAgentPosition(positionId, patch) {
  return withJournalLock(() => {
    const j = loadJournal();
    const p = j.positions.find(x => x.id === positionId);
    if (!p || p.market !== 'INDIA' || (p.status !== 'OPEN' && p.status !== 'UNKNOWN')) return { ok: false, error: 'not open' };
    Object.assign(p, patch);
    saveJournal(j);
    return { ok: true, position: p };
  });
}

// small helpers ------------------------------------------------
let _lastSkip = { key: '', at: 0 };
function maybeLogSkip(key, text) {
  _state.lastSkip = { key, text: String(text).slice(0, 200), at: Date.now() };
  if (_lastSkip.key === key && Date.now() - _lastSkip.at < 10 * 60_000) return;
  _lastSkip = { key, at: Date.now() };
  log('skip', text);
}
async function alertOnce(sendTelegram, key, text) {
  try {
    const day = todayIST();
    _state.alerted = _state.alerted || {};
    if (_state.alerted[key] === day) return;
    _state.alerted[key] = day;
    await notify(sendTelegram, text);
  } catch { /* best-effort */ }
}
async function notify(sendTelegram, text) {
  try { if (typeof sendTelegram === 'function') await sendTelegram(text); } catch { /* best-effort */ }
}

// ---- ATR-adaptive time-exit window (crypto-agent B2, NSE-tuned) ----
export function dynamicMaxHoldMin(cfg, atrPct) {
  const base = Number(cfg?.maxHoldMin) > 0 ? Number(cfg.maxHoldMin) : 90;
  const a = Number(atrPct);
  if (!Number.isFinite(a) || a <= 0) return base;
  let out = base;
  if (a >= 2.5) out = Math.round(base * 0.5);       // fast mover — stale fast
  else if (a <= 0.8) out = Math.round(base * 4 / 3); // slow mover — needs time
  return Math.max(15, Math.min(240, out));
}
function holdWindowFor(cfg, symbol) {
  if (cfg.dynamicTimeExit === false) return Number(cfg.maxHoldMin) > 0 ? Number(cfg.maxHoldMin) : 90;
  const meta = _state.entryMeta?.[symbol];
  return dynamicMaxHoldMin(cfg, meta?.atrPct);
}

// ---------------- status view (the panel's single call) ----------------
/**
 * Everything the India Agent panel needs in ONE payload (crypto
 * agentStatus parity): config + live state + NSE clock + today's
 * trades + top picks + open agent positions + blockers + sizing
 * preview. Never throws; the board degrades to null.
 */
export async function indiaAgentStatus(deps) {
  const cfg = loadIndiaAgentConfig();
  const trading = loadConfig();
  const j = loadJournal();
  const tradesToday = indiaAgentTradesToday(j);
  const openAgent = openIndiaAgentPositions(j);
  const agentPnl = r2(indiaAgentRealizedToday(j));

  const mins = istHM();
  const nseOpen = isNseOpen();
  const inEntryWindow = nseOpen && mins >= IST_ENTRY_FIRST && mins <= IST_ENTRY_LAST;
  const squareOffNow = mins >= IST_SQUAREOFF;

  // top picks — warmOnly: read the cached board only (latency contract)
  const picks = [];
  if (deps) {
    const { getSignals } = await import('./signals.js').catch(() => ({ getSignals: null }));
    if (getSignals) {
      const b = await getSignals('INDIA', deps, { limit: 6, warmOnly: true }).catch(() => null);
      if (b?.ok) {
        for (const s of (b.signals || []).filter(s => s.grade === 'STRONG' || s.grade === 'ACTION').slice(0, 3)) {
          picks.push({
            symbol: s.symbol, side: s.side, grade: s.grade, confidence: s.confidence,
            aiScore: s.superIntel?.aiScore ?? null, ltp: s.ltp,
            voters: s.voters ?? s.participating ?? null, totalModels: s.totalModels ?? null,
            plan: s.plan ? { entry: s.plan.entry, stopLoss: s.plan.stopLoss, target2: s.plan.target2, riskPct: s.plan.riskPct } : null,
          });
        }
      }
    }
  }

  // sizing preview against the top pick
  let preview = null;
  try {
    const top = picks.find(x => x?.plan) || null;
    preview = indiaSizingPreview({
      cfg, plan: top?.plan ? { ...top.plan, entry: top.ltp ?? top.plan.entry } : null, trading,
    });
    if (top) preview.symbol = top.symbol;
  } catch { preview = null; }

  const day = todayIST();
  const equityINR = Number(cfg.equityINR) > 0 ? Number(cfg.equityINR) : 10_000;
  const lossCapINR = equityINR * (cfg.dailyLossCapPct / 100);
  const paused = _state.pausedToday && _state.pausedToday.day === day ? _state.pausedToday : null;

  // ---- AGENT BLOCKERS — the "entry kyun nahi ho raha" strip ----
  const blockers = [];
  if (!cfg.enabled) {
    blockers.push({ key: 'disabled', text: 'Agent STOPPED hai — START button dabao' });
  } else {
    if (trading.killSwitch) blockers.push({ key: 'kill_switch', text: '🛑 Kill switch ON (Risk settings) — agent idle' });
    if (cfg.mode === 'live' && (!dhanConnected() || trading.indiaMode !== 'live')) {
      blockers.push({ key: 'live_preconditions', text: '🔴 LIVE preconditions missing — Dhan connect + India Risk mode LIVE (typed)' });
    }
    if (paused) blockers.push({ key: 'loss_cap', text: `🩹 Stood down — ${paused.reason}` });
    if (!nseOpen) {
      blockers.push({ key: 'nse_closed', text: '🕰️ NSE band hai (M–F 09:15–15:30 IST) — market khulte hi scan resume' });
    } else if (squareOffNow) {
      blockers.push({ key: 'eod', text: '🌇 EOD square-off window (15:15+) — session band, kal 09:30 se fresh entries' });
    } else if (!inEntryWindow) {
      blockers.push(mins < IST_ENTRY_FIRST
        ? { key: 'entry_window', text: `⏰ Entry window 09:30 se — opening chop avoid ho raha hai (${Math.max(1, Math.ceil(IST_ENTRY_FIRST - mins))}m baaki)` }
        : { key: 'entry_window', text: '⏰ 15:00 ke baad fresh intraday entry nahi (square-off 15:15)' });
    }
    if (equityINR < cfg.minEquityINR) {
      blockers.push({ key: 'equity_floor', text: `💰 Desk capital ₹${r2(equityINR)} < floor ₹${r2(cfg.minEquityINR)} — capital config raise karo` });
    }
    if (tradesToday.length >= cfg.maxTradesPerDay) {
      blockers.push({ key: 'quota', text: `🎯 Daily quota done ${tradesToday.length}/${cfg.maxTradesPerDay} — IST midnight reset` });
    } else if (_state.lastEntryAt && (Date.now() - _state.lastEntryAt) / 60000 < cfg.cooldownMin) {
      const left = Math.max(1, Math.ceil(cfg.cooldownMin - (Date.now() - _state.lastEntryAt) / 60000));
      blockers.push({ key: 'cooldown', text: `⏳ Cooldown — ${left}m baad next entry try` });
    }
    const ls = _state.lastSkip;
    if (ls && Date.now() - (ls.at || 0) < 10 * 60_000 && !blockers.some(b => b.key === ls.key)) {
      blockers.push({ key: ls.key, soft: true, text: `ℹ️ ${ls.text}` });
    }
  }

  const rollingWR = rollingIndiaAgentWinRate(j, cfg.rollingWindow);
  if (_state.winRateDowngraded) {
    blockers.push({ key: 'win_rate_downgrade', soft: true, text: `📉 Rolling win-rate ${_state.winRateDowngraded.winRate}% (last ${_state.winRateDowngraded.trades}) — agent paper mode me self-downgrade ho chuka hai. LIVE re-arm karne se pehle review karo.` });
  }

  const nextScanInSec = _state.lastScanAt
    ? Math.max(0, INDIA_AGENT_TICK_SEC - (Math.floor((Date.now() - _state.lastScanAt) / 1000) % INDIA_AGENT_TICK_SEC))
    : null;

  return {
    ok: true,
    engine: 'NSE SUPERINTELLIGENCE AGENT v10.3',
    config: cfg,
    trading: { mode: trading.indiaMode, killSwitch: trading.killSwitch, connected: dhanConnected() },
    market: { nseOpen, istMin: mins, entryWindowOpen: inEntryWindow, squareOffNow, entryFrom: '09:30', entryUntil: '15:00', squareOffAt: '15:15' },
    state: {
      running: cfg.enabled,
      runningSince: _state.runningSince,
      lastScanAt: _state.lastScanAt,
      scans: _state.scans,
      lastEntryAt: _state.lastEntryAt,
      lastEntrySymbol: _state.lastEntrySymbol,
      pausedToday: paused,
      tickSec: INDIA_AGENT_TICK_SEC,
      nextScanInSec,
      lastSkip: _state.lastSkip,
      log: (_state.log || []).slice(-40).reverse(),
    },
    today: {
      day,
      trades: tradesToday.map(e => ({
        ts: e.ts, symbol: e.symbol || e.pair, side: e.side, mode: e.mode, status: e.status,
        qty: e.qty ?? null, price: e.price ?? null, reason: e.reason ?? null,
      })),
      tradesCount: tradesToday.length,
      maxTrades: cfg.maxTradesPerDay,
      realizedPnlINR: agentPnl,
      lossCapINR: r2(lossCapINR),
      paused,
    },
    openPositions: openAgent.map(p => ({
      id: p.id, symbol: p.symbol, side: p.side, mode: p.mode, qty: p.qty,
      entryPrice: p.entryPrice, sl: p.sl, tp: p.tp ?? null, tp2: p.tp2 ?? null,
      openedAt: p.openedAt,
      ageMin: p.openedAt ? Math.round((Date.now() - p.openedAt) / 60000) : null,
      maxHoldMin: holdWindowFor(cfg, p.symbol),
      tp1Hit: !!p.tp1Hit, tp2Hit: !!p.tp2Hit,
      bookedPnlINR: p.bookedPnlINR ?? null,
      remainingQty: p.qty ?? null,
      originalQty: p.originalQty ?? null,
      exitStage: p.exitStage || 'ENTRY',
      // v10.15 GAP 1: the live conviction bar (null when OFF / no re-vote yet)
      conviction: _state.conviction?.[p.symbol] ?? null,
    })),
    picks,
    sizingPreview: preview,
    blockers,
    accuracy: {
      quorumAwareEntry: true,
      quorumPenalty: cfg.quorumPenalty,
      effectiveMinAiScore: cfg.minAiScore,
      // v18.1 FIX (honest display): this previously showed
      // minAiScore + quorumPenalty — but the REAL thin-committee bar is
      // effectiveScoreBar() (proportional, capped at +5, profile-aware).
      // The status now reports what the code actually enforces for the
      // thinnest possible committee (0 voters).
      thinCommitteeMinAiScore: effectiveScoreBar(cfg, { voters: 0 }),
      thresholdProfile: cfg.thresholdProfile || 'proportional',
      dynamicTimeExit: cfg.dynamicTimeExit !== false,
      rollingWinRate: rollingWR,
      rollingWindow: cfg.rollingWindow,
      minRollingWinRate: cfg.minRollingWinRate,
      winRateDowngraded: _state.winRateDowngraded || null,
      lastNearMisses: _state.lastNearMisses || [],
      v2ModelsEnabled: typeof v2ModelsEnabled === 'function' ? v2ModelsEnabled() : false,
      // v21.12.0: full committee composition — UI ab hardcoded 16/13 ke
      // bajaye ASLI seat counts dikhata hai.
      committee: (() => { try { return committeeInfo(); } catch { return null; } })(),
    },
  };
}

// ---------------- test hooks ----------------
export function __resetIndiaAgentForTests() {
  _state = freshState();
  persistState();
  saveIndiaAgentConfig({ ...INDIA_AGENT_DEFAULTS });
  _lastSkip = { key: '', at: 0 };
}
export function __indiaAgentLogForTests() { return _state.log; }
export function __setIndiaAgentStateForTests(s) { _state = { ...freshState(), ...s }; }

// v18.1: lightweight liveness for the enriched GET /health — no async deps.
export function indiaAgentLiveness() {
  const cfg = loadIndiaAgentConfig();
  return {
    running: !!cfg.enabled,
    runningSince: _state.runningSince || null,
    lastScanAt: _state.lastScanAt || null,
    scans: _state.scans || 0,
  };
}
