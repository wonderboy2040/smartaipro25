// ============================================================
// server/ai/mtfAutoLink.js — v21.16.0 MTF AUTO-LINK (paper/auto)
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "75+ score wale ACTION/STRONG signals
// ko paper trade aur auto trade se link kardo."
//
// YE MODULE WAHI KARTA HAI — aur sirf wahi:
//
//   1. Dual-TF board (mtfDualBoard.js) ke rows mein se wo rows uthata
//      hai jo FULL confirm karte hain:
//        • superScore ≥ minScore (default 75 — SQL user bar)
//        • tier ACTION/STRONG/ELITE (superIntel tiers)
//        • side LONG/SHORT · trigger FIRED · TF-fit GOOD/OK
//        • not counter-trend · dual-TF aligned · grade A/B
//   2. Unhe REAL paper engine (server/intraday/paperTrading.js) mein
//      kholta hai — WAHI engine jo manual paper button + options
//      auto-entry use karta hai (T1 50% book + BE-lock, T2 full close,
//      SL watcher, EOD square-off — sab pehle se battle-tested).
//   3. Risk-based qty: riskPerTradeINR ÷ |entry − SL| (India int qty,
//      crypto 4dp), + notional budget (maxPositionsINR) + per-trade
//      notional cap — leverage blow-up impossible.
//   4. TIME-STOP (v21.15.0 planner ka rule live): jo trade apne plan
//      hold window ke andar T1 touch nahi karta, use close kar deta
//      hai — "capital idle rakhna bhi cost hai".
//   5. Har action ek append-only event log + telegram notify (agar
//      configured) — auto kuch bhi chupke nahi karta.
//
// SAFETY (deliberate, non-negotiable):
//   • PAPER ONLY. Ye module broker/exec gauntlet ko kabhi touch nahi
//     karta — live orders ke raaste (executeSignal / Dhan / CoinDCX)
//     yahan se bilkul disconnected hain.
//   • Default OFF. User toggle (UI/API) ke bina kuch nahi khulta.
//   • Market gates: INDIA → NSE open + 15:00 fresh-entry cutoff;
//     CRYPTO → 24×7. Trades/day quota + per-symbol cooldown + max
//     concurrent + INR budget — sab hard caps.
//   • Kill-switch aware: caller (routes loop) global killSwitch pass
//     karta hai → tick turant no-op.
//
// STATE: server/data/mtf-auto-config.json (user config)
//        server/data/mtf-auto-state.json  (day counters + linked book + events)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNseMarketOpen, freshEntriesAllowedFor, dayKeyFor, istDayKey } from '../intraday/time.js';
import { dualAutoCandidates, closedCandlesFor } from './mtfDualBoard.js';
import { SUPER_TIERS } from './superIntel.js';
import { walletLeverageForEquityINR, feeBreakevenFloor, evaluateFeeAwareReversalExit } from '../exec/sizing.js';
// v21.23.15 [PHASE-3 PERSISTENCE]: config + state ab encrypted durable
// mirror par bhi jaate hain — Render spin-down se auto-config (enabled /
// desk scope / live mode) aur day counters reset nahi hote.
import { durablePut } from '../mcp/durable.js';
// v21.23.1: release ab DO authoritative jagah se hota hai: (1) paperTrading.js
// `_closePart` central close hook (har paper trade close pe immediate, symbol-flat
// check ke saath), (2) routes.js 60s watcher `reconcileDirectionLocks()` sweep.
// v21.23.8 UC FLIP-REVERSE: confirmed board-flip par trade close + IMMEDIATE
// reverse entry ek hi atomic transaction hai — isliye flip path purana lock
// yahin release karke naya opposite-side lock acquire karta hai (LIVE adopted
// positions jinka koi paper _closePart hook nahi hota us case ke liye zaroori;
// paper close ke baad dobara release idempotent hai).
import {
  acquireDirectionLock, checkDirectionLock, releaseDirectionLock, __resetDirectionLocksForTests,
} from './directionLock.js';
// v21.23.7 VOLATILITY-ADAPTIVE SUPER SMART SL TRAIL: stage thresholds /
// chandelier / giveback tolerance / reversal-hint lock / TP1 partial pct —
// sab ATR% volatility class (LOW/NORMAL/HIGH/EXTREME) + live momentum
// (SURGING/STEADY/FADING) se derive hote hain (user: "trade volatile me
// sl trail ko improvement karo — TP1/TP2 tak reach nahi ho raha").
import {
  trailProfileResolved, tp1ClosePctFor, classifyVolatility,
  VOL_CLASS, MOMENTUM,
} from './volTrail.js';
// v21.24.0 SMART TRAIL v2: noise-aware ratchet + rolling TP2 (shadow default; SMART_TRAIL_V2=enforce to act).
import { smartTrailMode, smartTrailConfig, smartTrailPlan, smartExtendTarget } from './smartTrail.js';
// v21.25.0 DIRECTION CERTIFICATE — strict side vocabulary + explicit
// LONG→buy / SHORT→sell certificate shared with board/live routes/UI.
import {
  normalizeSide, oppositeSideOf, resolveActivePosSide,
  buildDirectionCertificate, summarizeBoardDirectionIntegrity,
} from './directionCertificate.js';
// v21.29.0 [R2 RISK ARM] — live-arm blockers, typed override, consecutive-loss
// pause, and risk-sizing labels. Pure helpers; this module owns persistence and
// the tick-time gate.
import {
  RISK_ACK_PHRASE, evaluateLiveArmRisk, evaluateConsecutiveLossPause,
  computeRiskBasedSizing,
} from './riskArm.js';
// v21.29.0 [R3–R9 TRADE GUARDS] — pure filters/exit helpers. Modes default
// shadow/off; nothing here can block or close until an operator flips a flag.
import {
  normalizeGuardMode, evaluateEntryGuards, evaluateReversalGuardV2,
  evaluateRunnerAfterTp2, evaluateStallExit, buildScoreCalibration,
} from './tradeGuards.js';
// v21.29.0 [R11 VALIDATION HARNESS] — shadow evidence + acceptance gates.
import { recordShadowDecision, shadowHarnessView } from './shadowHarness.js';
import { evaluateEntryTiming } from './mtfEntryTiming.js';
import { getPerpIntelFor, perpIntelEnabled } from './perpIntel.js';
import { eventGuardCheck } from './eventGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// v21.16.0 FIX (pro-level recheck): paths LAZY resolve hote hain + test ke
// liye env override (MTF_AUTO_DATA_DIR). Pehle module-scope constant paths
// the — vitest suite REAL server/data/ me config/state likh deti thi aur
// boot ke waqt user ka saved auto-config uda sakti thi. Ab: runtime data
// kabhi test se touch nahi hota; suite apna tmp dir set karti hai.
// v21.27.1 FIX (pro-level recheck): SMARTAI_DATA_DIR bhi honor karo. Pehle
// sirf MTF_AUTO_DATA_DIR dekha jata tha, isliye hermetic boot jo sirf
// SMARTAI_DATA_DIR set karta hai REAL server/data/mtf-auto-config.json +
// state ko likh deta tha (live auto-trade toggle pollution).
const _dataDir = () =>
  process.env.MTF_AUTO_DATA_DIR ||
  (process.env.SMARTAI_DATA_DIR ? path.resolve(process.env.SMARTAI_DATA_DIR) : DATA_DIR);
const CFG_FILE = () => path.join(_dataDir(), 'mtf-auto-config.json');
const STATE_FILE = () => path.join(_dataDir(), 'mtf-auto-state.json');

export const MTF_AUTO_TICK_SEC = 60;
const MAX_EVENTS = 200;
const TIME_STOP_GRACE_MS = 4 * 60_000; // watcher ko SL/T1/T2 ka mauka do

export const MTF_AUTO_DEFAULTS = {
  enabled: false,                  // opt-in — default OFF (paper only)
  // v21.24.0 PHASE 0 [LIVE ENTRY PAUSE]: existing LIVE positions ka deep
  // monitor / exchange SL sync CHALTA rehta hai — sirf NAYE live entries aur
  // UC flip-reverse entries rukte hain. `executionMode` ko chhedne ki zaroorat
  // nahi (paper kar dene se open LIVE position ka management bhi badal jata).
  liveEntryPaused: false,
  // v21.24.0 PHASE 0 [RISK CAPS]: 0 = legacy behaviour (backward compatible);
  // production config me 1% target / 2% hard cap / 5x max leverage /
  // 25% max wallet deploy / 1.5% daily loss stop explicitly set hote hain.
  riskPerTradePct: 0,              // target % of live wallet per trade (0 = off)
  maxRiskPerTradePct: 2,           // HARD ceiling jab pct-based risk active ho
  maxLeverage: 0,                  // 0 = wallet-tier leverage as-is; >0 = hard cap
  maxWalletDeployPct: 0,           // 0 = config walletDeployPct as-is; >0 = hard cap
  dailyLossPct: 0,                 // 0 = off; >0 = new-entry stop after -X% day
  mode: 'INTRADAY',                // dual-TF mode: INTRADAY (15m→5m) | SWING (1h→15m) | SCALP (5m→1m)
  holdMin: null,                   // null → mode ka default (INTRADAY 45 / SWING 120 / SCALP 20)
  minScore: 75,                    // user spec: 75+ ACTION/STRONG
  riskPerTradeINR: 2000,           // per-trade risk budget (qty = risk ÷ |entry−SL|)
  maxPositionsINR: 100000,         // total OPEN notional budget (linked trades)
  maxNotionalPerTradeINR: 50000,   // single trade notional cap
  maxTradesPerDay: 5,
  maxOpenPositions: 1,             // v21.22.0: 1 session = strictly 1 active trade at a time (next trade only after current trade finishes)
  cooldownMin: 30,                 // per symbol
  desks: { india: true, crypto: true },
  timeStopEnabled: true,
  // v21.17.0: crypto rows ab USDT domain me hain (MTF board fix) — risk ₹
  // budget ko USDT qty me convert karne ke liye USDINR rate. Caller
  // (routes loop) live CoinDCX rate (102) deta hai; ye paper fallback/clamp hai.
  inrPerUsdt: 84,
  // v21.18.0 LIVE MODE + WALLET-TIER LEVERAGE + FEE-AWARE REVERSAL EXIT:
  //   • executionMode: 'paper' (default) | 'live' (ELITE/STRONG auto-order)
  //   • walletAmountINR < ₹10,000 → 10x leverage · ≥ ₹10,000 → 5x leverage
  //   • feeAwareReversalExit: confirmed reversal exits ONLY when round-trip fees are covered
  executionMode: 'paper',
  autoSyncSiteLive: true,
  walletAmountINR: 10000,
  walletDeployPct: 100,            // v21.22.0: 100% of CoinDCX Wallet deployed into trade with Leverage
  belowTenKLeverage: 10,
  aboveTenKLeverage: 5,
  feeAwareReversalExit: true,
  deepMonitorEnabled: true,        // v21.22.0: Realtime Active-Trade Deep Monitor + Trailing SL + Reversal Profit Book
  // v21.26.1 PRO TRADER EXIT POLICY (user spec): "TP1 reach hone se pehle SL
  // trail bilkul nahi hona chahiye - normal pullback ko reversal mat samjho.
  // TP1 ke baad SL entry/fee-breakeven par, TP2 ke karib SL TP1 par, TP2 hit
  // par full close. TP1 se pehle pakka reversal ho to fees cover hone par
  // no-loss scratch." true = pro ladder; false = legacy v1/v2 stage trail
  // (kept only as an explicit diagnostic escape hatch).
  proExitPolicy: true,
  // v21.28.0 F1: closed-bar stability auto/manual gate (default OFF = shadow).
  closedBarConfirm: false,
  // v21.30.0 [SIGNAL TIMING + DIRECTION]: fail-open entry-timing guard.
  // `enforce` (default) blocks clear late/reversal/direction-disagreement
  // entries; `shadow` records only; `off` disables. Env: ENTRY_TIMING_GUARD.
  entryTimingGuard: 'enforce',
  // v21.28.0 F2: LIVE TP1 partial parity with the paper engine. Default OFF
  // until CoinDCX reduce-only/partial behavior is verified on a small position.
  liveTp1Partial: false,
  // 0 = UNLIMITED daily trades (user spec). Finite values keep the old hard
  // cap. The 1-session/1-open-trade lock still applies regardless.
  // (maxTradesPerDay default 5 below stays the conservative default.)
  // v21.23.6 USER SPEC: "jab trade successful close hone LIVE Auto trade 5 min ka
  // cooldown lagake then phir auto trade signals me ELITE top trade verify karke
  // trade lagna chahiye" — successful close ke baad LIVE re-entry sirf
  // 5-minute cooldown ke BAAD, elite-verified signal pe.
  postSuccessCooldownMin: 5,
  // v21.23.8 USER SPEC (UC FLIP-AND-REVERSE): "jab UC ne LONG se SHORT pakka hone
  // pe status update karta hai tab minimal loss ke sath vo long trade close karke
  // IMMEDIATELY wahi trade short me lagna chahiye" — confirmed board-flip par
  // trade minimal-loss/protective close + same-symbol IMMEDIATE reverse entry.
  // "Thoda pullback" kabhi flip nahi hota (board row same-side hi rehta hai) —
  // flip SIRF pakka opposite-side confirmation (triggerFired || score>=65) pe.
  ucFlipReverse: true,
  // v21.26.0 AI SUPER INTELLIGENCE PER-TRADE AGENT:
  // AUTO entry hote hi ek dedicated tick-driven agent us trade ka full control
  // leta hai — WebSocket liveFeed tick par (koi 3s/15s polling wait nahi)
  // TP1/TP2 monitor, SL ratchet, minimal-loss protective exit, confirmed
  // opposite-direction flip-reverse, aur TP2 ke baad IDLE.
  superAgentEnabled: true,
  // Confirmed adverse move par full -1R SL se PEHLE minimal-loss exit.
  // -0.35R = risk ka sirf 35% (very low loss) — board flip ya tick-velocity
  // confirmation ke bina ye kabhi fire nahi hota (whipsaw guard).
  superAgentMinimalLossExit: true,
  superAgentMinLossR: -0.35,
  // v21.29.0 [R2 RISK ARM] — default ON:
  //   • consecutiveLossPauseAfter: 3 losing LIVE trades in a row → new LIVE
  //     entries pause for `consecutiveLossPauseMin` (0 disables).
  //   • riskCapsAcknowledged/AckPhrase: persisted typed override for a config
  //     that intentionally runs without the required caps. Never auto-set.
  consecutiveLossPauseAfter: 3,
  consecutiveLossPauseMin: 120,
  riskCapsAcknowledged: false,
  riskCapsAckPhrase: null,
  riskCapsAckAt: null,
  // v21.29.0 [R3–R9] — ALL new behaviour defaults to observe-only. Enforce is
  // an explicit operator decision after the R11 shadow gates are reviewed.
  //   REVERSAL_GUARD_V2=shadow   tiered closed-bar reversal exit
  //   EVENT_SESSION_FILTER=shadow macro-event blackout + session micro-windows
  //   REGIME_FILTER=shadow       no counter-regime / chop entries
  //   PERP_VETO=shadow           funding / long-short / basis extremes
  //   CLUSTER_GUARD=shadow       correlated-cluster concentration cap
  //   SCORE_CALIBRATION=off      per-bucket settled win-rate gate
  //   RUNNER_AFTER_TP2=off       keep a runner after TP2 (paper first)
  //   STALL_EXIT=off             no-progress time stop
  reversalGuardV2: 'shadow',
  eventSessionFilter: 'shadow',
  eventSessionFilterSessions: true,
  regimeFilter: 'shadow',
  regimeBlockChop: true,
  regimeBlockHighVol: false,
  perpVeto: 'shadow',
  perpFundingVetoBps: 30,
  perpRatioVeto: 3,
  perpBasisVetoPct: 1,
  clusterGuard: 'shadow',
  clusterGuardMax: 2,
  clusterGuardSameMarketOnly: true,
  scoreCalibration: 'off',
  calibrationMinN: 30,
  calibrationMinWinProb: 55,
  runnerAfterTp2: 'off',
  runnerTrailR: 0.75,
  runnerQtyPct: 25,
  stallExit: 'off',
  stallExitMin: 45,
  stallExitMinPeakR: 0.25,
};
// v21.23.8 flip churn guards — ek symbol ke liye din me sirf itni flip-reverse
// entries (whipsaw market me zyada flip = fees + churn; protective minimal-loss
// EXIT hamesha allowed hai, sirf REVERSE-ENTRY pe cap lagta hai).
const UC_FLIP_MAX_PER_SYMBOL_PER_DAY = 4;
const UC_FLIP_MIN_AGE_MS_LIVE = 60_000;   // LIVE: order-fill latency + instant noise guard
const UC_FLIP_MIN_AGE_MS_PAPER = 30_000;  // paper: thoda kam strict
const CLAMPS = {
  minScore: [Number(SUPER_TIERS.ACTION), 95],
  riskPerTradeINR: [100, 25000],
  riskPerTradePct: [0, 2],
  maxRiskPerTradePct: [0.1, 2],
  maxLeverage: [0, 20],
  maxWalletDeployPct: [0, 100],
  dailyLossPct: [0, 10],
  maxPositionsINR: [1000, 1000000],
  maxNotionalPerTradeINR: [1000, 500000],
  maxTradesPerDay: [0, 25],         // 0 = unlimited (user spec)
  maxOpenPositions: [1, 10],        // paper engine ka apna 10-open guard bhi hai
  cooldownMin: [5, 720],
  inrPerUsdt: [40, 150],
  walletAmountINR: [500, 10000000],
  walletDeployPct: [10, 100],
  belowTenKLeverage: [1, 20],
  aboveTenKLeverage: [1, 20],
  postSuccessCooldownMin: [0, 120],   // v21.23.6: 0 = cooldown OFF; max 2h
  superAgentMinLossR: [-0.90, -0.10], // v21.26.0: confirmed adverse par minimal-loss line
  consecutiveLossPauseAfter: [0, 20],   // v21.29.0 R2: 0 = pause OFF
  consecutiveLossPauseMin: [0, 1440],   // max 24h
  // v21.29.0 R3–R9 numeric thresholds
  perpFundingVetoBps: [5, 200],
  perpRatioVeto: [1.2, 10],
  perpBasisVetoPct: [0.1, 10],
  clusterGuardMax: [1, 10],
  calibrationMinN: [10, 500],
  calibrationMinWinProb: [10, 95],
  runnerTrailR: [0.25, 3],
  runnerQtyPct: [5, 50],
  stallExitMin: [5, 1440],
  stallExitMinPeakR: [0, 2],
};
const MODES = new Set(['INTRADAY', 'SWING', 'SCALP']);

let _cfg = null;
let _state = null;
let _mtfAutoTickInFlight = false;
// v21.23.15 boot provenance — shown honestly in the UI status so "auto is
// enabled" never silently means "defaults after a wiped disk".
let _bootedAt = Date.now();
let _restoredFromDurable = false;
let _restoredConfigFromDurable = false;
let _restoredStateFromDurable = false;
let _cfgSavedAt = null;
// Durable restore runs BEFORE the port opens, but it is bounded by an 8s
// race. Any pre-restore writer (or a status poll during a slow restore) must
// not stamp a newer default config/state over the backup. Direct module
// consumers/tests start unblocked; server/index calls __beginMtfAutoBoot().
let _bootPersistenceReady = true;
let _bootPersistenceTimer = null;

/** Called by server/index immediately before durableBootRestoreAll(). */
export function __beginMtfAutoBoot() {
  _bootPersistenceReady = false;
  if (_bootPersistenceTimer) clearTimeout(_bootPersistenceTimer);
  _bootPersistenceTimer = setTimeout(() => {
    _bootPersistenceReady = true;
    _bootPersistenceTimer = null;
  }, 15_000);
  _bootPersistenceTimer.unref?.();
}

const clampN = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function _save(file, obj) {
  // Boot window: local+durable writes are suppressed until the durable
  // restore has had its chance. Skipping only local persistence is not
  // enough — durablePut would itself make this process the newest writer.
  if (!_bootPersistenceReady) return;
  try {
    fs.mkdirSync(_dataDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch { /* non-fatal — state stays in memory */ }
  // v21.23.15: durable mirror is best-effort; basename keeps the backup
  // namespace identical to the boot-restore file names. Tests that point
  // MTF_AUTO_DATA_DIR at a tmp dir still write local state only (durable is
  // disabled unless a backup repo + encryption key are configured).
  try { durablePut(path.basename(file), obj); } catch { /* durable optional */ }
}

export function loadMtfAutoConfig() {
  if (_cfg) return _cfg;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')); } catch { raw = {}; }
  _cfgSavedAt = Number(raw.updatedAt) || null;
  _cfg = _sanitizeCfg({ ...MTF_AUTO_DEFAULTS, ...raw, desks: { ...MTF_AUTO_DEFAULTS.desks, ...(raw.desks || {}) } });
  return _cfg;
}

/** v21.23.15 boot hook — durableBootRestoreAll writes the disk files AFTER
 * this module captured `_cfg`/`_state` at module-eval; drop both caches so
 * the next status/tick reads the hydrated files. */
export function __reloadMtfAutoForBoot(meta = {}) {
  _cfg = null;
  _state = null;
  _bootedAt = Date.now();
  _deepMonitorHb = _freshDeepMonitorHb(); // v21.28.0 F9: no pre-restore heartbeat survives
  _restoredFromDurable = meta?.restored === true
    || meta?.configRestored === true || meta?.stateRestored === true;
  _restoredConfigFromDurable = meta?.configRestored === true;
  _restoredStateFromDurable = meta?.stateRestored === true;
  // Restore attempt is over (success, no-op or not configured) — allow
  // persistence again even when the 8s boot race timed out and the restore
  // itself is still finishing in the background.
  _bootPersistenceReady = true;
  if (_bootPersistenceTimer) { clearTimeout(_bootPersistenceTimer); _bootPersistenceTimer = null; }
  const cfg = loadMtfAutoConfig();
  const state = _loadState();
  return {
    config: cfg,
    stateLoaded: !!state,
    bootedAt: _bootedAt,
    restoredFromDurable: _restoredFromDurable,
    restoredConfigFromDurable: _restoredConfigFromDurable,
    restoredStateFromDurable: _restoredStateFromDurable,
  };
}

/**
 * v21.23.14 [SITE-LIVE DESK SCOPE]: one global `siteLiveActive` boolean let an
 * India-only live session arm CRYPTO live auto (and vice-versa). Routes supply
 * `siteLiveByDesk`; the boolean stays as a backwards-compatible fallback.
 * SIM books are never live.
 */
function siteLiveForDesk(p = {}, market = 'CRYPTO') {
  const m = String(market || '').toUpperCase();
  if (m === 'GLOBALFUTURES' || m === 'EQUITY_SIM') return false;
  if (p.siteLiveByDesk && typeof p.siteLiveByDesk === 'object') {
    return m === 'INDIA' ? p.siteLiveByDesk.india === true : p.siteLiveByDesk.crypto === true;
  }
  return Boolean(p.siteLiveActive);
}

function _sanitizeCfg(cfg) {
  // v21.23.10 [F10-DEAD-KEYS]: pehle `{ ...cfg }` passthrough spread config ke
  // HAR dead key ko persist karta tha — `markets` (['CRYPTO']) aur
  // `liveExecution` dono repo me KAHIN bhi read nahi hote (grep-verified),
  // jabki user 'markets:[CRYPTO]' dekh kar samajhta tha sirf crypto hi
  // chalega (real switch `desks` hai). Allowlist = MTF_AUTO_DEFAULTS keys —
  // legacy keys ab sanitize par drop ho kar save me se bhi gayab ho jayenge.
  const out = {};
  for (const k of Object.keys(MTF_AUTO_DEFAULTS)) out[k] = cfg[k];
  out.enabled = Boolean(cfg.enabled);
  out.mode = MODES.has(String(cfg.mode).toUpperCase()) ? String(cfg.mode).toUpperCase() : 'INTRADAY';
  out.holdMin = (() => {
    const n = Number(cfg.holdMin);
    return Number.isFinite(n) && n > 0 ? Math.max(5, Math.min(600, Math.round(n))) : null;
  })();
  for (const [k, [lo, hi]] of Object.entries(CLAMPS)) out[k] = clampN(cfg[k], lo, hi, MTF_AUTO_DEFAULTS[k]);
  out.desks = { india: cfg.desks?.india !== false, crypto: cfg.desks?.crypto !== false };
  out.timeStopEnabled = cfg.timeStopEnabled !== false;
  out.executionMode = String(cfg.executionMode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  out.autoSyncSiteLive = cfg.autoSyncSiteLive !== false;
  out.liveEntryPaused = cfg.liveEntryPaused === true;
  out.feeAwareReversalExit = cfg.feeAwareReversalExit !== false;
  out.deepMonitorEnabled = cfg.deepMonitorEnabled !== false;
  // v21.26.1 PRO TRADER EXIT POLICY - default ON; explicit opt-out only.
  out.proExitPolicy = cfg.proExitPolicy !== false;
  // v21.28.0 [F1/F2 NEW FLAGS — SAFE DEFAULTS]:
  //   closedBarConfirm = false → shadow telemetry only (forming-bar signal
  //     still trades). true → auto/manual entry requires last closed bar par
  //     side+trigger stable.
  //   liveTp1Partial = false → LIVE TP1 par full position manage hoti hai
  //     (legacy). true → volatility-sized partial reduce (CoinDCX verify ke
  //     baad hi enable karna — [VERIFY-LIVE]).
  out.closedBarConfirm = cfg.closedBarConfirm === true;
  out.liveTp1Partial = cfg.liveTp1Partial === true;
  // v21.30.0: timing guard default enforce (this is the late-reversal fix).
  out.entryTimingGuard = normalizeGuardMode(cfg.entryTimingGuard, 'enforce');
  // v21.29.0 [R3–R9] mode allowlist. Unknown/legacy values never silently
  // become enforce — each falls back to its documented default.
  out.reversalGuardV2 = normalizeGuardMode(cfg.reversalGuardV2, 'shadow');
  out.eventSessionFilter = normalizeGuardMode(cfg.eventSessionFilter, 'shadow');
  out.regimeFilter = normalizeGuardMode(cfg.regimeFilter, 'shadow');
  out.perpVeto = normalizeGuardMode(cfg.perpVeto, 'shadow');
  out.clusterGuard = normalizeGuardMode(cfg.clusterGuard, 'shadow');
  out.scoreCalibration = normalizeGuardMode(cfg.scoreCalibration, 'off');
  out.runnerAfterTp2 = normalizeGuardMode(cfg.runnerAfterTp2, 'off');
  out.stallExit = normalizeGuardMode(cfg.stallExit, 'off');
  out.eventSessionFilterSessions = cfg.eventSessionFilterSessions !== false;
  out.regimeBlockChop = cfg.regimeBlockChop !== false;
  out.regimeBlockHighVol = cfg.regimeBlockHighVol === true;
  out.clusterGuardSameMarketOnly = cfg.clusterGuardSameMarketOnly !== false;
  // v21.23.8: UC FLIP-AND-REVERSE — default ON; config se OFF ho sakta hai
  // (ucFlipReverse:false → confirmed flip par sirf protective close, reverse
  // entry nahi — user ka explicit opt-out).
  out.ucFlipReverse = cfg.ucFlipReverse !== false;
  // v21.26.0 per-trade AI SUPER AGENT — default ON, explicit opt-out possible.
  out.superAgentEnabled = cfg.superAgentEnabled !== false;
  out.superAgentMinimalLossExit = cfg.superAgentMinimalLossExit !== false;
  // v21.29.0 [R2 RISK ARM] — typed acknowledgement is a one-way persisted
  // fact. It is accepted ONLY as the exact phrase; a half-typed/wrong phrase
  // is stored as NOT acknowledged (never silently normalised to true).
  const ackPhrase = String(cfg.riskCapsAckPhrase || '').trim();
  out.riskCapsAcknowledged = cfg.riskCapsAcknowledged === true
    && ackPhrase.toUpperCase() === RISK_ACK_PHRASE;
  out.riskCapsAckPhrase = out.riskCapsAcknowledged ? RISK_ACK_PHRASE : null;
  out.riskCapsAckAt = out.riskCapsAcknowledged && Number(cfg.riskCapsAckAt) > 0
    ? Number(cfg.riskCapsAckAt)
    : null;
  return out;
}

/**
 * v21.18.0 USER SPEC:
 *   • Wallet amount < ₹10,000 → 10x Leverage
 *   • Wallet amount ≥ ₹10,000 → 5x Leverage
 */
export function computeMtfWalletLeverage(walletINR, cfg = MTF_AUTO_DEFAULTS) {
  return walletLeverageForEquityINR(walletINR, {
    thresholdINR: 10000,
    belowLev: cfg?.belowTenKLeverage ?? 10,
    aboveLev: cfg?.aboveTenKLeverage ?? 5,
  });
}

/**
 * v21.24.0 PHASE 0 — single source of truth for EFFECTIVE risk caps.
 * Sab entry paths (normal + UC flip-reverse) aur status isi se sizing karte
 * hain, taaki UI/config/audit me ek hi number dikhe.
 *
 *   riskPerTradePct 0  → pct cap OFF, legacy riskPerTradeINR budget
 *   maxRiskPerTradePct → hard ceiling (default 2%) jab pct cap active ho
 *   maxLeverage 0      → wallet-tier leverage as-is
 *   maxWalletDeployPct 0 → configured walletDeployPct as-is
 *   dailyLossPct 0     → daily loss stop OFF
 */
export function computeEffectiveRiskCaps(cfg = MTF_AUTO_DEFAULTS, walletINR = null) {
  const wallet = Number(walletINR) > 0
    ? Number(walletINR)
    : (Number(cfg?.walletAmountINR) > 0 ? Number(cfg.walletAmountINR) : 10000);
  const targetPct = clampN(cfg?.riskPerTradePct, 0, 2, 0);
  const hardPct = clampN(cfg?.maxRiskPerTradePct, 0.1, 2, 2);
  const activePct = targetPct > 0 ? Math.min(targetPct, hardPct) : 0;
  // Half-up paisa rounding: `(wallet * pct/100).toFixed(2)` can round DOWN on
  // binary-FP artefacts (₹1385 × 1.5% = 20.775 → "20.77"). Money caps must
  // never under-round, so multiply first and round at the paisa level.
  const riskCapINR = activePct > 0 ? Math.round(wallet * activePct) / 100 : null;
  const configuredRisk = clampN(cfg?.riskPerTradeINR, 100, 25000, 2000);
  const effectiveRiskINR = riskCapINR != null
    ? Math.min(configuredRisk, riskCapINR)
    : configuredRisk;

  const tierLeverage = computeMtfWalletLeverage(wallet, cfg);
  const levCap = clampN(cfg?.maxLeverage, 0, 20, 0);
  const effectiveLeverage = levCap > 0 ? Math.min(tierLeverage, levCap) : tierLeverage;

  const configuredDeploy = clampN(cfg?.walletDeployPct ?? 100, 10, 100, 100);
  const deployCap = clampN(cfg?.maxWalletDeployPct, 0, 100, 0);
  const effectiveWalletDeployPct = deployCap > 0
    ? Math.min(configuredDeploy, deployCap)
    : configuredDeploy;

  const dailyLossPct = clampN(cfg?.dailyLossPct, 0, 10, 0);
  const dailyLossCapINR = dailyLossPct > 0 ? Math.round(wallet * dailyLossPct) / 100 : null;

  return {
    walletINR: +wallet.toFixed(2),
    riskPerTradePct: targetPct,
    maxRiskPerTradePct: hardPct,
    activeRiskPct: activePct,
    riskCapINR,
    riskPerTradeINR: configuredRisk,
    effectiveRiskINR: +effectiveRiskINR.toFixed(2),
    tierLeverage,
    maxLeverage: levCap,
    effectiveLeverage,
    walletDeployPctConfigured: configuredDeploy,
    maxWalletDeployPct: deployCap,
    effectiveWalletDeployPct,
    dailyLossPct,
    dailyLossCapINR,
  };
}

/**
 * v21.29.0 [R2] — single read-only risk-arm telemetry bundle shared by the
 * status route and GET /api/ai/mtf-auto/risk-arm. The SAFE preset is returned
 * as a suggestion only; nothing here writes config.
 */
export function mtfAutoRiskArmState(cfg = loadMtfAutoConfig()) {
  const st = _loadState();
  const liveArm = evaluateLiveArmRisk(cfg);
  const consecutiveLoss = evaluateConsecutiveLossPause({
    closedRows: st.book,
    liveOnly: true,
    pauseAfter: cfg?.consecutiveLossPauseAfter,
    pauseMin: cfg?.consecutiveLossPauseMin,
  });
  return {
    liveArm,
    liveArmBlocked: !liveArm.ok,
    liveArmBlockers: liveArm.blockers,
    consecutiveLoss,
    consecutiveLossPauseAfter: Number(cfg?.consecutiveLossPauseAfter) || 0,
    consecutiveLossPauseMin: Number(cfg?.consecutiveLossPauseMin) || 0,
    ackPhrase: RISK_ACK_PHRASE,
    presetOnly: true,
  };
}

/**
 * v21.29.0 [R10/R11] — read-only guard telemetry shared by status + the
 * deep-monitor payload. This is the UI's single source for:
 *   • which guards are off/shadow/enforce
 *   • shadow would-block evidence + acceptance gates
 *   • per-bucket score calibration from settled book rows
 * Nothing here writes config or blocks anything.
 */
export function mtfAutoGuardTelemetry(cfg = loadMtfAutoConfig()) {
  const st = _loadState();
  const calibration = buildScoreCalibration(st.book, { minN: cfg?.calibrationMinN });
  const harness = shadowHarnessView(st.shadowStats || {});
  return {
    ok: true,
    modes: {
      reversalGuardV2: reversalGuardV2Mode(),
      eventSessionFilter: eventSessionFilterMode(),
      regimeFilter: regimeFilterMode(),
      perpVeto: perpVetoMode(),
      clusterGuard: clusterGuardMode(),
      scoreCalibration: scoreCalibrationMode(),
      runnerAfterTp2: runnerAfterTp2Mode(),
      stallExit: stallExitMode(),
      entryTimingGuard: entryTimingGuardMode(),
      exitPolicyV3: exitPolicyV3Mode(),
      tp1ConfirmFallback: tp1ConfirmFallbackMode(),
    },
    thresholds: {
      clusterGuardMax: Number(cfg?.clusterGuardMax) || 2,
      calibrationMinN: Number(cfg?.calibrationMinN) || 30,
      calibrationMinWinProb: Number(cfg?.calibrationMinWinProb) || 55,
      runnerTrailR: Number(cfg?.runnerTrailR) || 0.75,
      runnerQtyPct: Number(cfg?.runnerQtyPct) || 25,
      stallExitMin: Number(cfg?.stallExitMin) || 45,
      stallExitMinPeakR: Number(cfg?.stallExitMinPeakR) || 0.25,
    },
    calibration,
    shadowHarness: harness,
    note: 'Shadow modes never block/close. Enforce requires the R11 gates + manual review (paper first).',
  };
}

/**
 * v21.22.0 USER SPEC #1:
 * "MTF Dual-Timeframe Signal Board se Jab Auto Trade lagta hai tho Coindcx ka Wallet
 *  Fetch hotye hi 100% wallet amount Trade me Lagna chahiye as per Wallet amount and Leverage ke sath."
 *
 * Calculates the exact 100% wallet deployment (INR & USDT), leveraged buying power,
 * and the exchange-safe initial margin so CoinDCX's total lock (initial + safety + fee)
 * utilizes 100% of the fetched wallet without triggering `[400] Insufficient funds`.
 */
export function computeWallet95Deployment({
  walletINR = 10000,
  freeUsdt = null,
  leverage = null,
  fxRate = 102,
  safetyPct = 2.0,
  deployPct = null,
  cfg = MTF_AUTO_DEFAULTS,
} = {}) {
  const fx = clampN(fxRate, 40, 150, 102);
  const wINR = Number(walletINR) > 0
    ? Number(walletINR)
    : (Number(freeUsdt) > 0 ? Number(freeUsdt) * fx : (Number(cfg?.walletAmountINR) || 10000));
  const wUSDT = Number(freeUsdt) > 0 ? Number(freeUsdt) : +(wINR / fx).toFixed(4);
  const pct = clampN(deployPct ?? cfg?.walletDeployPct ?? 100, 10, 100, 100);
  const lev = Number(leverage) > 0 ? Number(leverage) : computeMtfWalletLeverage(wINR, cfg);
  const deployedWalletINR = +(wINR * (pct / 100)).toFixed(2);
  const deployedWalletUSDT = +(wUSDT * (pct / 100)).toFixed(4);
  const buyingPowerINR = +(deployedWalletINR * lev).toFixed(2);
  const buyingPowerUSDT = +(deployedWalletUSDT * lev).toFixed(4);

  // CoinDCX locks `(1/lev + safetyPct/100 + 2*takerFee) * notional` from the futures wallet.
  // `deployedWalletINR` & `deployedWalletUSDT` represent 100% wallet deployment (executed by `executeMtfDualLiveOrder`),
  // while `exchangeSafeInitialMarginUSDT` keeps a conservative initial-margin floor (`<= 72%` of wallet).
  const totalRatePerNotional = (1 / lev) + (Math.max(0, Number(safetyPct) || 2.0) / 100) + 0.003;
  const maxSafeNotionalUSDT = (deployedWalletUSDT * 0.992) / totalRatePerNotional;
  const exchangeSafeInitialMarginUSDT = +Math.min(wUSDT * 0.72, maxSafeNotionalUSDT / lev).toFixed(4);
  const exchangeSafeInitialMarginINR = +(exchangeSafeInitialMarginUSDT * fx).toFixed(2);

  return {
    walletDeployPct: pct,
    walletTotalINR: +wINR.toFixed(2),
    walletTotalUSDT: +wUSDT.toFixed(4),
    deployedWalletINR,
    deployedWalletUSDT,
    leverage: lev,
    buyingPowerINR,
    buyingPowerUSDT,
    exchangeSafeInitialMarginUSDT,
    exchangeSafeInitialMarginINR,
    fxRate: fx,
  };
}
export const computeWallet100Deployment = computeWallet95Deployment;

/**
 * v21.22.0 USER SPEC #3 & #4:
 * Dedicated Realtime Active-Trade Deep Monitor + Dynamic Multi-Stage SL Trailing +
 * Bullish/Bearish Reversal Profit-Booking Superintelligence.
 *
 * v21.23.7 VOLATILITY-ADAPTIVE SUPER SMART UPGRADE (user: "trade volatile me
 * sl trail ko improvement karo — TP1/TP2 tak reach nahi ho raha, bahut kam
 * profit book karke trade exit ho raha hai"): har stage threshold, chandelier
 * width, giveback tolerance, reversal-hint lock aur TP1 partial pct ab
 * LIVE ATR% volatility class (LOW/NORMAL/HIGH/EXTREME) + momentum state
 * (SURGING widens / FADING tightens) se derive hote hain — volTrail.js.
 *   • LOW (ATR<0.8%)     → v21.23.6-identical ya TIGHTER (no regression)
 *   • NORMAL (0.8–1.8%)   → standard (default jab ATR data nahi)
 *   • HIGH (1.8–3.5%)     → WIDE — noise-level pullbacks trail trigger nahi karte
 *   • EXTREME (≥3.5%)     → ULTRA-WIDE — max room, TP1 partial bhi 35% (bada runner)
 * Vol source: boardRow.context.atrPct (LIVE) → trade.atrPct (open-stamp)
 *   → trade.volClass (15s-tick stamp) → NORMAL.
 *
 * Monitors any active auto-trade from Entry until TP1 or TP2 hits:
 *   • Stage 0: Initial Guard (SL at initial stopLoss)
 *   • Stage 1 Early (profile.stage1EarlyR): Ultra-Fast Micro-Shield — SL −0.65R
 *   • Stage 1 (profile.stage1R): Risk Halved — SL −0.45R / fee-cover pe BE shield
 *   • Stage 2 (profile.stage2R): Fee-Free Breakeven Lock (ZERO LOSS)
 *   • Stage 3 (profile.stage3R): Pre-TP1 Profit Ratchet (peak − stage3GivebackR)
 *   • Stage 4 (>= +1.00R / TP1 Hit): TP1 partial (profile.tp1ClosePct) Booked +
 *     Runner SL trailed to +0.65R floor (peak − stage4GivebackR ratchet) → TP2
 *   • Stage 5 (>= +1.40R -> TP2): Runner SL = TP1 floor + profile.stage5ChandelierR
 *     chandelier until TP2 (2.0R) full exit
 *   • Reversal Guard v21.23.6: book ONLY on a CONFIRMED flip (board side actually
 *     flipped + trigger fired / superScore >= 65) or a DEEP giveback
 *     (>=profile.givebackRatioPct% of peak AND >= profile.givebackAbsFloorR absolute).
 *     Risk hints (reversalRisk / context.exhausted / opposingFlow) ab SIRF SL
 *     profit-lock tighten karte hain (peak − profile.hintGivebackR), book NAHI.
 */

// v21.23.10 [BOARD-ROTATION CACHE]: live boards har 6-15s re-rank hoti hain
// (top-6 trim) — ek OPEN trade ka symbol mid-trade top-6 se BAHAR chala
// jaye to boardRow null ho jata tha → UC-flip / reversal detection SILENT
// dead (trade poora −1R ride karta tha — exact wahi scenario jiske liye
// flip banaya gaya tha). Last-seen row ka halka snapshot (120s TTL, memory
// only — persisted book me nahi jata) detection zinda rakhta hai.
const _lastBoardRowSeenMap = new Map();
const BOARD_ROW_SNAPSHOT_TTL_MS = 120_000;
// v21.26.0 AI SUPER AGENT runtime (memory only — never persisted):
//   • exit locks stop the 15s/60s deep-monitor sweep from double-closing a
//     position while the tick agent is already mid-close;
//   • per-trade throttle book keeps disk writes / exchange calls bounded even
//     when a Binance WS symbol ticks 20×/second.
const _superAgentExitLocks = new Set();
const _superAgentRuntime = new Map();
let _superAgentLastPersistAt = 0;
function _rememberBoardRow(symbol, row, now) {
  const key = String(symbol || '').toUpperCase();
  if (!key || !row) return;
  _lastBoardRowSeenMap.set(key, {
    at: now,
    side: String(row.side || '').toUpperCase(),
    triggerFired: Boolean(row.triggerFired),
    superScore: Number(row.superScore) || 0,
    triggerDir: Number(row.triggerDir) || 0,
    contextDir: Number(row.context?.dir) || 0,
    atrPct: Number(row.context?.atrPct) > 0 ? Number(row.context.atrPct) : null,
    directionVerified: row.directionVerified === true,
    ensembleSignalAvailable: row.ensembleSignalAvailable !== false,
    autoEligible: row.autoEligible === true,
    // v21.26.0 AI SUPER AGENT: reverse-entry readiness ab tick handler ke paas
    // bhi chahiye (15s board rebuild ka wait nahi). Same fields jo
    // _tryOpenUcFlipReverse ka reverseReady gate padhta hai.
    trapVeto: row.trapVeto === true,
    zoneWallVeto: row.zoneWallVeto === true,
    counterTrend: row.counterTrend === true,
    counterHtf: row.counterHtf === true,
    reversalRisk: row.reversalRisk === true,
    opposingFlow: row.trigger?.opposingFlow === true,
    exhausted: row.context?.exhausted === true,
    tier: row.tier || null,
    plan: row.plan && typeof row.plan === 'object' ? { ...row.plan } : null,
  });
  if (_lastBoardRowSeenMap.size > 64) {
    const firstKey = _lastBoardRowSeenMap.keys().next().value;
    if (firstKey !== undefined) _lastBoardRowSeenMap.delete(firstKey);
  }
}
function _snapshotRowFor(symbol, now) {
  const key = String(symbol || '').toUpperCase();
  const s = _lastBoardRowSeenMap.get(key);
  if (!s || now - Number(s.at || 0) > BOARD_ROW_SNAPSHOT_TTL_MS) return null;
  return {
    symbol: key,
    side: s.side,
    triggerFired: s.triggerFired,
    superScore: s.superScore,
    triggerDir: s.triggerDir,
    directionVerified: s.directionVerified === true,
    ensembleSignalAvailable: s.ensembleSignalAvailable !== false,
    autoEligible: s.autoEligible === true,
    // v21.26.0 AI SUPER AGENT: reverse-entry readiness fields (see
    // _rememberBoardRow) so a tick can drive the flip-reverse gate without
    // waiting for the next 15s/60s board rebuild.
    trapVeto: s.trapVeto === true,
    zoneWallVeto: s.zoneWallVeto === true,
    counterTrend: s.counterTrend === true,
    counterHtf: s.counterHtf === true,
    reversalRisk: s.reversalRisk === true,
    opposingFlow: s.opposingFlow === true,
    exhausted: s.exhausted === true,
    tier: s.tier || null,
    plan: s.plan && typeof s.plan === 'object' ? { ...s.plan } : null,
    trigger: { opposingFlow: s.opposingFlow === true },
    context: {
      dir: s.contextDir,
      ...(s.atrPct != null ? { atrPct: s.atrPct } : {}),
      ...(s.exhausted ? { exhausted: true } : {}),
    },
    __snapshot: true,
  };
}

// ------------------------------------------------------------
// v21.28.0 [F4 EXIT_POLICY_V3] — shadow-first upgrade of the PRO ladder.
// ------------------------------------------------------------
// Defect F4: TP1 was latched from the FAVOURABLE EXTREME (a wick/peak above
// T1), then the SL jumped to raw fee-breakeven. A wick that never closes above
// T1 therefore moved the stop into the noise band and the runner was scratched
// before TP2. V3:
//   • TP1 counts for the ladder only when a CLOSED bar closes beyond T1
//     (or the caller stamps tp1CloseConfirmed).
//   • post-TP1 stop = fee-breakeven + a volatility-classed buffer (not raw BE).
//   • mode `shadow` (default) computes/report everything, decisions unchanged;
//     `enforce` makes V3 the decider. Rollout = shadow → paper → live-small.
//   • `off` restores pre-V3 behaviour exactly.
export function exitPolicyV3Mode() {
  const raw = String(process.env.EXIT_POLICY_V3 ?? 'shadow').trim().toLowerCase();
  if (raw === 'enforce' || raw === 'on' || raw === '1' || raw === 'true') return 'enforce';
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled') return 'off';
  return 'shadow';
}

// v21.29.0 [R0b TP1 MISSING-CANDLE FALLBACK]
// When the closed-candle feed is unavailable (cache expired, new listing, feed
// outage), enforce-mode TP1 confirmation previously stayed unknown forever and
// the runner never locked. Fallback = a price-hold proxy ONLY while candles are
// missing: the favourable extreme must stay beyond T1 for >= 2 evaluations and
// >= 5 seconds. If ANY closed candle series exists, this fallback is disabled —
// a wick must never confirm TP1. `off` restores strict candle-only behaviour.
export function tp1ConfirmFallbackMode() {
  const raw = String(process.env.TP1_CONFIRM_FALLBACK ?? 'tick-hold').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled') return 'off';
  return 'tick-hold';
}

export const TP1_FALLBACK_MIN_MS = 5_000;
export const TP1_FALLBACK_MIN_TICKS = 2;

// v21.29.0 [R3–R9 MODE RESOLUTION] — env wins over the persisted config so a
// rollout can be rehearsed without rewriting the operator's config file.
function _guardMode(key, envName, fallback) {
  const env = process.env[envName];
  if (env != null && String(env).trim() !== '') return normalizeGuardMode(env, fallback);
  return normalizeGuardMode(loadMtfAutoConfig()?.[key], fallback);
}
export function reversalGuardV2Mode() { return _guardMode('reversalGuardV2', 'REVERSAL_GUARD_V2', 'shadow'); }
export function eventSessionFilterMode() { return _guardMode('eventSessionFilter', 'EVENT_SESSION_FILTER', 'shadow'); }
export function regimeFilterMode() { return _guardMode('regimeFilter', 'REGIME_FILTER', 'shadow'); }
export function perpVetoMode() { return _guardMode('perpVeto', 'PERP_VETO', 'shadow'); }
export function clusterGuardMode() { return _guardMode('clusterGuard', 'CLUSTER_GUARD', 'shadow'); }
export function scoreCalibrationMode() { return _guardMode('scoreCalibration', 'SCORE_CALIBRATION', 'off'); }
export function runnerAfterTp2Mode() { return _guardMode('runnerAfterTp2', 'RUNNER_AFTER_TP2', 'off'); }
export function stallExitMode() { return _guardMode('stallExit', 'STALL_EXIT', 'off'); }
export function entryTimingGuardMode() { return _guardMode('entryTimingGuard', 'ENTRY_TIMING_GUARD', 'enforce'); }

/** Pure TP1 close-confirmation check. `closedCandles` MUST contain only closed
 *  bars (caller drops the forming bar). Returns null when there is no usable
 *  series (honest "unknown" — never a fabricated confirm). When `sinceTs` is
 *  supplied, a bar without a timestamp cannot prove post-entry confirmation
 *  and is ignored. */
export function confirmTp1OnClosedBars({ closedCandles = null, side, t1, sinceTs = 0 } = {}) {
  const s = normalizeSide(side);
  const target = Number(t1);
  if (!Array.isArray(closedCandles) || closedCandles.length === 0 || !s || !(target > 0)) return null;
  const isLong = s === 'LONG';
  const since = Number(sinceTs) > 0 ? Number(sinceTs) : 0;
  let confirmedAt = null;
  let timestamped = 0;
  for (const c of closedCandles) {
    const close = Number(c?.close);
    if (!(close > 0)) continue;
    const rawTs = Number(c?.ts ?? c?.time ?? c?.t ?? c?.timestamp);
    const tsMs = rawTs > 0 ? (rawTs < 1e11 ? rawTs * 1000 : rawTs) : null;
    if (tsMs != null) timestamped++;
    if (since > 0) {
      if (tsMs == null || tsMs < since) continue;
    }
    const hit = isLong ? close >= target : close <= target;
    if (hit && (confirmedAt == null || (tsMs != null && tsMs < confirmedAt))) {
      confirmedAt = tsMs != null ? tsMs : 0;
    }
  }
  return {
    confirmed: confirmedAt != null,
    confirmedAt,
    bars: closedCandles.length,
    timestamped,
  };
}

// v21.28.0 [F2 LIVE TP1 PARTIAL — SAFE REDUCE, FLAG-GATED]
// Paper engine TP1 = partial book + BE runner. LIVE previously had no partial
// (exchange native TP closed the whole position at T2), so a TP1 touch could
// not bank anything. This helper books the SAME volatility-sized fraction on
// CoinDCX through the route-injected `livePartial` adapter (which must use
// safeReduceFuturesPosition). Rules:
//   • only LIVE futures rows, only when cfg.liveTp1Partial === true
//   • only after TP1 touch; V3 enforce additionally requires close-confirm
//   • one-shot latch on the book row (`t1PartialBooked`) — persisted
//   • in-flight lock prevents the 3s + 15s lanes double-reducing
//   • ambiguous exchange outcome → 5 min cooldown (never blind retry)
//   • paper mirror books T1 ONLY after the exchange accepts the reduce
//   • [VERIFY-LIVE] CoinDCX partial reduce + native TP/SL interaction must be
//     validated on a small position before enabling on real money.
const _livePartialInFlight = new Set();

async function _tryLiveTp1Partial({ b, deepEval, cfg, p, livePaper = null, paper = null, now = Date.now() } = {}) {
  const isLiveTpRow = b?.executionMode === 'LIVE' && !(b.market === 'INDIA' || b.execMarket === 'INDIA');
  if (!isLiveTpRow) return { attempted: false, booked: false, reason: 'not-live-futures' };
  if (cfg?.liveTp1Partial !== true) return { attempted: false, booked: false, reason: 'flag-off' };
  if (b.t1PartialBooked === true) return { attempted: true, booked: false, reason: 'already-booked' };
  const retryAt = Number(b.t1PartialNextRetryAt) || 0;
  if (retryAt > now) return { attempted: true, booked: false, reason: 'retry-cooldown', retryAt };
  if (deepEval?.tp1Hit !== true) return { attempted: true, booked: false, reason: 'tp1-not-touched' };
  if (exitPolicyV3Mode() === 'enforce' && deepEval?.tp1Confirmed !== true) {
    return { attempted: true, booked: false, reason: 'awaiting-close-confirm' };
  }
  if (typeof p?.livePartial !== 'function') {
    b.t1PartialNextRetryAt = now + 60_000;
    b.t1PartialLastError = 'livePartial adapter unavailable';
    return { attempted: true, booked: false, error: b.t1PartialLastError };
  }
  const lockKey = `${String(b.execMarket || b.market)}:${String(b.symbol)}`;
  if (_livePartialInFlight.has(lockKey)) return { attempted: true, booked: false, reason: 'in-flight' };
  const originalQty = Number(b.originalQty) > 0 ? Number(b.originalQty) : Number(b.qty);
  const pct = Number(deepEval?.t1ClosePct) > 0
    ? Math.max(0.05, Math.min(0.90, Number(deepEval.t1ClosePct)))
    : 0.5;
  const requestedQty = originalQty * pct;
  if (!(requestedQty > 0)) {
    b.t1PartialNextRetryAt = now + 60_000;
    b.t1PartialLastError = 'qty unavailable for TP1 partial';
    return { attempted: true, booked: false, error: b.t1PartialLastError };
  }
  _livePartialInFlight.add(lockKey);
  b.t1PartialLastAttemptAt = now;
  let res = null;
  try {
    res = await p.livePartial({
      ...b,
      qty: requestedQty,
      side: b.side,
      pair: b.pair,
      livePositionId: b.livePositionId,
      leverage: b.leverage,
      reason: `TP1 partial ${Math.round(pct * 100)}%`,
    });
  } catch (e) {
    res = { ok: false, error: String(e?.message || e) };
  } finally {
    _livePartialInFlight.delete(lockKey);
  }
  if (!res?.ok) {
    const ambiguous = res?.ambiguous === true;
    b.t1PartialNextRetryAt = now + (ambiguous ? 5 * 60_000 : 60_000);
    b.t1PartialLastError = String(res?.error || res?.reason || 'TP1 reduce failed').slice(0, 180);
    if (ambiguous) b.t1PartialAmbiguous = true;
    return { attempted: true, booked: false, ambiguous, error: b.t1PartialLastError };
  }

  // ---- exchange accepted: latch + stamp BEFORE any mirror write ----
  b.t1PartialBooked = true;
  b.t1PartialBookedAt = now;
  b.t1PartialQty = Number(res?.requestedQty) > 0 ? Number(res.requestedQty) : +requestedQty.toFixed(8);
  b.t1PartialOrderId = res?.orderId || null;
  b.t1PartialVerified = res?.verified === true;
  b.t1PartialVerifyPending = res?.verified !== true;
  b.t1PartialNextRetryAt = 0;
  b.qtyAfterTp1 = Number.isFinite(Number(res?.postQty)) ? Number(res.postQty) : null;
  if (b.qtyAfterTp1 != null && b.qtyAfterTp1 >= 0) b.qty = b.qtyAfterTp1;
  delete b.t1PartialLastError;
  delete b.t1PartialAmbiguous;

  // Paper mirror booking ONLY after the exchange accepted the reduce.
  let mirror = { booked: false, skipped: 'no-mirror' };
  if (livePaper && livePaper.t1Hit !== true && typeof paper?.bookPaperT1Partial === 'function') {
    const t1 = Number(deepEval?.t1) > 0 ? Number(deepEval.t1) : Number(b.t1);
    const ltp = Number(deepEval?.ltp) > 0 ? Number(deepEval.ltp) : Number(b.ltp);
    const isLong = b.side === 'LONG';
    const px = t1 > 0
      ? (isLong ? Math.max(ltp || 0, t1) : Math.min(ltp || t1, t1))
      : ltp;
    try {
      const r = paper.bookPaperT1Partial(livePaper.id, px);
      mirror = { booked: r?.ok === true, error: r?.ok ? null : String(r?.error || 'mirror book failed') };
    } catch (e) {
      mirror = { booked: false, error: String(e?.message || e) };
    }
  }
  return { attempted: true, booked: true, res, mirror };
}

function _blockedDirectionDeepEval({ trade, cert, entry, initialSl, currentSl, t1, t2, ltp, market, ccy }) {
  const reason = cert.reasons[0] || cert.verdict || 'invalid direction';
  const peak = Number(trade.peakPrice) > 0 ? Number(trade.peakPrice) : entry;
  return {
    symbol: trade.symbol || null,
    market,
    ccy,
    side: cert.side,
    orderSide: cert.orderSide,
    entry,
    ltp,
    initialStopLoss: initialSl,
    previousStopLoss: currentSl,
    // NEVER trail a blocked row — a wrong-side SL would otherwise be pushed
    // to the exchange and instantly stop the position out.
    trailedStopLoss: currentSl,
    slTrailed: false,
    t1,
    t2,
    tp1Hit: Boolean(trade.t1Hit || trade.tp1Hit),
    tp2Hit: false,
    peakPrice: +peak.toFixed(6),
    currentR: 0,
    peakR: 0,
    movePctFromEntry: 0,
    mfePct: 0,
    roePct: 0,
    directionFollowing: false,
    followThroughVerdict: `⛔ DIRECTION BLOCKED — ${reason}`,
    peakGivebackPct: 0,
    feeBreakevenPrice: null,
    feeCovered: false,
    peakCoveredFee: false,
    grossPnl: 0,
    distToTp1Pct: null,
    distToTp2Pct: null,
    stageCode: 'STAGE_DIRECTION_BLOCKED',
    stageLabel: '⛔ Direction Certificate Blocked — no trail / no auto-exit',
    trendStatus: `⛔ DIRECTION BLOCKED (${cert.verdict}): ${reason}`,
    reversalDetected: false,
    shouldBookProfitNow: false,
    shouldExitDefensiveSl: false,
    shouldClose: false,
    exitReason: null,
    directionBlocked: true,
    directionCertificate: cert,
    volClass: null,
    momentumState: MOMENTUM.UNKNOWN,
    atrPct: Number(trade.atrPct) > 0 ? Number(trade.atrPct) : null,
    t1ClosePct: Number(trade.t1ClosePct) > 0 ? Number(trade.t1ClosePct) : 0.5,
    trailEngine: 'blocked',
    // v21.28.0 F4: blocked rows never latch TP1 (and never move a stop).
    tp1Confirmed: false,
    tp1ConfirmSource: 'blocked',
    tp1LadderActive: false,
    exitPolicyV3: {
      mode: exitPolicyV3Mode(),
      applied: false,
      shadow: false,
      tp1CloseConfirmed: false,
      note: 'direction certificate blocked — no TP1/ladder action',
    },
    t2Extended: false,
    t2Extensions: Number(trade.t2Extensions) || 0,
    smartTrail: null,
    checkedAt: Date.now(),
  };
}

export function evaluateActiveTradeDeepMonitor(trade = {}, liveCtx = {}) {
  const entry = Number(trade.entry ?? trade.entryPrice) || 0;
  const initialSl = Number(trade.initialStopLoss ?? trade.stopLoss ?? trade.sl) || 0;
  const currentSl = Number(trade.trailedStopLoss ?? trade.stopLoss ?? trade.sl) || initialSl;
  const t1 = Number(trade.t1 ?? trade.target1 ?? trade.tp) || 0;
  const t2Base = Number(trade.t2 ?? trade.target2 ?? trade.tp2) || 0;
  const ltp = Number(liveCtx.ltp ?? trade.ltp ?? entry) || entry;
  const qty = Number(trade.qty) || 1;
  const market = String(trade.execMarket || trade.market || 'FUTURES').toUpperCase();
  const ccy = trade.ccy || (market === 'INDIA' ? 'INR' : 'USDT');
  // v21.25.0 [NO SILENT LONG]: pehle missing/unknown side `|| 'LONG'` se LONG
  // ban jaata tha aur ek SHORT position ko ULTA manage karta tha (SL/target
  // polarity inverted). Ab certificate hard-block deta hai — koi action nahi.
  const directionCertificate = buildDirectionCertificate({
    symbol: trade.symbol,
    market,
    side: trade.side ?? trade.direction,
    activePos: trade.activePos ?? trade.positionAmt,
    entry,
    stopLoss: initialSl,
    t1,
    t2: t2Base,
    // Deep-monitor rows may legitimately run without a native TP (manual live
    // position). SL polarity + side integrity are still mandatory.
    requireTargets: false,
    directionVerified: trade.directionVerified === true,
    source: 'deep-monitor',
  });
  if (!directionCertificate.ok) {
    return _blockedDirectionDeepEval({
      trade, cert: directionCertificate, entry, initialSl, currentSl, t1, t2: t2Base, ltp, market, ccy,
    });
  }
  const side = directionCertificate.side;
  const isLong = side === 'LONG';
  const risk = Math.max(1e-8, Math.abs(entry - initialSl) || Math.abs(t1 - entry) || entry * 0.008);

  const prevPeak = Number(trade.peakPrice) > 0 ? Number(trade.peakPrice) : entry;
  const peakPrice = isLong ? Math.max(prevPeak, entry, ltp) : Math.min(prevPeak, entry, ltp);
  const favorableMove = isLong ? (ltp - entry) : (entry - ltp);
  const peakMove = isLong ? (peakPrice - entry) : (entry - peakPrice);
  const currentR = +(favorableMove / risk).toFixed(2);
  const peakR = +(peakMove / risk).toFixed(2);

  const feeFloor = Number(trade.feeBreakevenPrice) > 0
    ? Number(trade.feeBreakevenPrice)
    : feeBreakevenFloor({ entry, side, market });
  const feeCovered = isLong ? ltp > feeFloor : ltp < feeFloor;
  const peakCoveredFee = isLong ? peakPrice > feeFloor : peakPrice < feeFloor;

  const tp1Touched = Boolean(trade.t1Hit || trade.tp1Hit || (t1 > 0 && (isLong ? peakPrice >= t1 : peakPrice <= t1)));

  // v21.26.1 PRO TRADER EXIT LADDER ---------------------------------------
  // Pre-TP1: initial SL is LOCKED. No stage trail, no defensive tighten, no
  // reversal-hint lock. A routine pullback is NOT a reversal and must never
  // move the stop. TP1 -> SL at fee-breakeven; TP2 progress >= 80% -> SL at
  // TP1; TP2 touched -> full close. Pre-TP1 confirmed reversal -> fee-safe
  // scratch ONLY once round-trip fees are covered (otherwise initial SL is
  // the backstop - "no loss" is mathematically impossible below fee floor).
  // Explicitly passing proExitPolicy:false keeps the legacy v1/v2 stage
  // engine available for diagnostics/tests.
  const proExitPolicy = (liveCtx.proExitPolicy ?? trade.proExitPolicy ?? true) !== false;
  const tp2Span = t2Base > 0 ? (isLong ? (t2Base - entry) : (entry - t2Base)) : 0;
  // v21.26.2: "TP2 ke karib aate hi SL TP1 par" — approach is measured on the
  // FAVOURABLE EXTREME, not the current tick. A spike to >=80% followed by a
  // pullback must still lock the TP1 stop (the exchange TP order would have
  // been armed there); only TP2 TOUCH itself closes the position.
  const tp2ProgressPct = tp2Span > 0 ? +((peakMove / tp2Span) * 100).toFixed(2) : 0;
  const tp2Approach = tp2Span > 0 && tp2ProgressPct >= 80;

  // v21.23.7 VOLATILITY-ADAPTIVE TRAIL PROFILE — LIVE ATR% (board context)
  // > entry-stamp (trade.atrPct) > 15s-tick stamp (trade.volClass) > NORMAL.
  // Momentum (trigger roc1/roc3/volRatio) SURGING pe trail WIDEN karta hai
  // (fast move ko room do — user: "trend ultra fast se capture hona chahiye"),
  // FADING pe TIGHTEN (profit lock karo).
  const profile = trailProfileResolved({
    side,
    boardRow: liveCtx.boardRow || null,
    liveAtrPct: liveCtx.boardRow?.context?.atrPct ?? null,
    tradeAtrPct: trade.atrPct ?? null,
    tradeVolClass: trade.volClass ?? null,
    tradeMomentumState: trade.momentumState ?? null,
  });
  const volClass = profile.volClass;
  const momentumState = profile.momentumState || MOMENTUM.UNKNOWN;

  // v21.28.0 [F4 EXIT_POLICY_V3 — SHADOW FIRST] -------------------------
  // Raw TP1 touch telemetry stays as-is (UI/paper parity). The V3 ladder
  // checkpoint below uses `tp1Ladder`, which in enforce mode requires a
  // CLOSED bar to close beyond T1. In shadow mode decisions remain legacy.
  const exitV3Mode = exitPolicyV3Mode();
  const exitV3Available = proExitPolicy && exitV3Mode !== 'off';
  const exitV3Enforce = exitV3Available && exitV3Mode === 'enforce';
  const _v3SinceTs = Number(trade.openedAt ?? trade.openedAtMs) > 0
    ? Number(trade.openedAt ?? trade.openedAtMs)
    : 0;
  const _v3Candles = Array.isArray(liveCtx.closedCandles) ? liveCtx.closedCandles : null;
  const closedCandlesMissing = !Array.isArray(_v3Candles) || _v3Candles.length === 0;
  const _v3CandleCheck = confirmTp1OnClosedBars({
    closedCandles: _v3Candles,
    side,
    t1,
    sinceTs: _v3SinceTs,
  });
  const _v3Stamp = typeof trade.tp1CloseConfirmed === 'boolean'
    ? trade.tp1CloseConfirmed
    : (typeof trade.t1CloseConfirmed === 'boolean' ? trade.t1CloseConfirmed : null);
  // v21.29.0 [R0b] one-way latch: once a caller persisted the confirmation
  // timestamp, a later missing/rotated candle series must not un-confirm it.
  const _v3LatchAt = Number(trade.tp1CloseConfirmedAt ?? trade.t1CloseConfirmedAt) > 0
    ? Number(trade.tp1CloseConfirmedAt ?? trade.t1CloseConfirmedAt)
    : null;
  const tp1FallbackMode = tp1ConfirmFallbackMode();
  const _v3Now = Number(liveCtx.now) > 0 ? Number(liveCtx.now) : Date.now();
  const _v3HoldSince = Number(liveCtx.t1BeyondSince ?? trade.t1BeyondSince) > 0
    ? Number(liveCtx.t1BeyondSince ?? trade.t1BeyondSince)
    : 0;
  const _v3HoldTicks = Number(liveCtx.t1BeyondTicks ?? trade.t1BeyondTicks) || 0;
  const _v3HoldEligible = Boolean(
    exitV3Enforce
    && tp1FallbackMode === 'tick-hold'
    && closedCandlesMissing
    && tp1Touched
    && _v3HoldSince > 0
    && (_v3Now - _v3HoldSince) >= TP1_FALLBACK_MIN_MS
    && _v3HoldTicks >= TP1_FALLBACK_MIN_TICKS,
  );
  let tp1CloseConfirmed = null;
  let tp1ConfirmSource = 'none';
  if (_v3Stamp !== null) {
    tp1CloseConfirmed = _v3Stamp;
    tp1ConfirmSource = 'trade-stamp';
  } else if (_v3LatchAt != null) {
    // One-way confirmation latch (survives candle-cache rotation).
    tp1CloseConfirmed = true;
    tp1ConfirmSource = 'persisted-latch';
  } else if (_v3CandleCheck) {
    // Candle evidence ALWAYS wins over the fallback. A wick-only series is a
    // definitive "not confirmed" — the tick-hold proxy must not override it.
    tp1CloseConfirmed = _v3CandleCheck.confirmed;
    tp1ConfirmSource = 'closed-candles';
  } else if (_v3HoldEligible) {
    tp1CloseConfirmed = true;
    tp1ConfirmSource = 'tick-hold-fallback';
  } else if (!tp1Touched) {
    tp1CloseConfirmed = false; // no touch at all → definitely not confirmed
    tp1ConfirmSource = 'no-touch';
  }
  const _v3ConfirmAt = _v3CandleCheck?.confirmedAt
    ?? (_v3LatchAt != null ? _v3LatchAt : null)
    ?? (tp1ConfirmSource === 'tick-hold-fallback' ? _v3HoldSince : null)
    ?? (Number(trade.tp1CloseConfirmedAt) > 0 ? Number(trade.tp1CloseConfirmedAt) : null);
  const tp1Ladder = exitV3Enforce ? (tp1CloseConfirmed === true) : tp1Touched;
  // BE+buffer: volatility-classed (LOW 0.05R … EXTREME 0.15R), momentum-scaled.
  const _v3BufBase = { LOW: 0.05, NORMAL: 0.08, HIGH: 0.12, EXTREME: 0.15 }[volClass] ?? 0.08;
  const v3BeBufferR = +(_v3BufBase
    * (momentumState === MOMENTUM.SURGING ? 1 : (momentumState === MOMENTUM.FADING ? 0.75 : 1))).toFixed(3);
  const v3BeBufferPrice = +(v3BeBufferR * risk).toFixed(6);
  const _v3BeBase = feeFloor > 0 ? feeFloor : entry;
  const v3BePlusBufferSl = +(isLong ? _v3BeBase + v3BeBufferPrice : _v3BeBase - v3BeBufferPrice).toFixed(6);
  const _v3LegacyBeSl = feeFloor > 0 ? feeFloor : entry;

  // v21.24.0 SMART TRAIL v2 (SMART_TRAIL_V2 = off | shadow(default) | enforce).
  // shadow: computed + exposed as telemetry, v1 decides. enforce: v2 decides.
  const _row0 = liveCtx.boardRow || null;
  const _hint0 = Boolean(_row0 && (
    _row0.reversalRisk === true || _row0.trigger?.reversalRisk === true
    || _row0.context?.exhausted === true || _row0.trigger?.opposingFlow === true
  ));
  const smartMode = smartTrailMode();
  const smartCfg = smartMode === 'off' ? null : smartTrailConfig();
  const smartEnforce = smartMode === 'enforce';
  // A caller that only has a stale book LTP (toggle/preview/lock checks) must
  // never move a live target. They can still read the would-extend telemetry.
  const allowTpExtension = liveCtx.allowTpExtension !== false;
  const smartExt = smartCfg
    ? smartExtendTarget({
      isLong, entry, risk, ltp, t1, t2: t2Base, t2Extensions: Number(trade.t2Extensions) || 0,
      momentum: momentumState, reversalRiskHint: _hint0, tp1Touched, peakR,
    }, smartCfg)
    : null;
  // Rolling TP2: only ENFORCE moves the target; shadow just reports "wouldExtend".
  // Never extend once price has already reached/passed the OLD target — in LIVE
  // the exchange-native TP is filling there; moving it now would be too late.
  const smartExtBeforeTarget = Boolean(
    smartExt && t2Base > 0 && (isLong ? ltp < t2Base : ltp > t2Base),
  );
  // Rolling TP2 belongs to the legacy smart-trail engine. PRO policy must keep
  // the ORIGINAL TP2: "TP2 hit hote hi trade close" (a moving target would
  // silently postpone the full-profit exit). Shadow telemetry is still exposed.
  const t2 = (!proExitPolicy && smartEnforce && allowTpExtension && smartExtBeforeTarget) ? smartExt.newT2 : t2Base;
  const t2Extended = Boolean(!proExitPolicy && smartEnforce && allowTpExtension && smartExtBeforeTarget);
  const tp2Touched = Boolean(trade.t2Hit || trade.tp2Hit || (t2 > 0 && (isLong ? ltp >= t2 : ltp <= t2)));
  const smartPlan = smartCfg
    ? smartTrailPlan({
      isLong, entry, risk, peakPrice, ltp, atrPct: profile.atrPct, momentum: momentumState,
      feeFloor, peakCoveredFee, tp1Touched, t1, reversalRiskHint: _hint0,
    }, smartCfg)
    : null;
  // v2 takes over the profit-locking stages (3/4/5) only when enforced AND active.
  // PRO policy owns the whole ladder - never let an enforce-mode env override it.
  const smartTakesOver = Boolean(!proExitPolicy && smartEnforce && smartPlan?.active);

  // Multi-Stage Dynamic Trailing SL computation
  let stageCode = 'STAGE_0_INITIAL_GUARD';
  let stageLabel = 'Stage 0 · Initial SL Guard';
  let candidateSl = currentSl;

  const priceAtR = (rMult) => +(isLong ? entry + rMult * risk : entry - rMult * risk).toFixed(6);
  const tightenSl = (current, proposed) => {
    if (!(proposed > 0)) return current;
    if (!(current > 0)) return proposed;
    return isLong ? Math.max(current, proposed) : Math.min(current, proposed);
  };

  if (tp2Touched) {
    stageCode = 'STAGE_5_TP2_HIT';
    stageLabel = 'Stage 5 · TP2 Target Hit (Full Profit Book)';
    candidateSl = tightenSl(candidateSl, t1 > 0 ? t1 : priceAtR(1.2));
  } else if (proExitPolicy) {
    // PRO LADDER: exactly two profit checkpoints after TP1. No chandelier,
    // no giveback ratchet, no smart-trail override. V3 enforce gates the TP1
    // checkpoint on a CLOSED-bar confirmation and adds a BE buffer.
    if (tp1Ladder && tp2Approach) {
      stageCode = 'STAGE_5_RUNNER_TO_TP2';
      stageLabel = 'Stage 5 - TP2 Approach | SL Locked at TP1';
      candidateSl = tightenSl(candidateSl, t1 > 0 ? t1 : (feeFloor > 0 ? feeFloor : entry));
    } else if (tp1Ladder) {
      stageCode = 'STAGE_4_TP1_LOCKED';
      stageLabel = exitV3Enforce
        ? 'Stage 4 - TP1 Close-Confirmed | SL Locked at Fee-Breakeven + Buffer'
        : 'Stage 4 - TP1 Secured | SL Locked at Fee-Breakeven';
      candidateSl = tightenSl(candidateSl, exitV3Enforce ? v3BePlusBufferSl : (feeFloor > 0 ? feeFloor : entry));
    } else {
      stageCode = 'STAGE_0_INITIAL_GUARD';
      stageLabel = 'Stage 0 - Initial SL Guard (PRO: no trail before TP1)';
      if (exitV3Enforce && tp1Touched && tp1CloseConfirmed !== true) {
        stageLabel += ' · TP1 touch awaiting closed-bar confirm';
      }
      // candidateSl stays at the carried stop - initial SL is the backstop.
    }
  } else if (peakR >= 1.4 || (tp1Touched && peakR >= 1.25)) {
    stageCode = 'STAGE_5_RUNNER_TO_TP2';
    stageLabel = 'Stage 5 · TP1 Locked + Structure Trail → TP2';
    // v21.23.7: chandelier width ab vol-adaptive (LOW 0.45 / NORMAL 0.50 /
    // HIGH 0.65 / EXTREME 0.80; SURGING ×1.15 / FADING ×0.85) — high-vol me
    // 0.50R pullback ROUTINE noise hai tha (TP2 se theek pehle SL hit).
    // Floor TP1 (>= +1.0R) pe hai hi.
    const chandelierTrail = isLong ? peakPrice - profile.stage5ChandelierR * risk : peakPrice + profile.stage5ChandelierR * risk;
    if (smartTakesOver) {
      candidateSl = tightenSl(candidateSl, smartPlan.slPrice);
      stageLabel = `Stage 5 · ${smartPlan.label}`;
    } else {
      candidateSl = tightenSl(candidateSl, tightenSl(t1 > 0 ? t1 : priceAtR(1.0), chandelierTrail));
    }
  } else if (tp1Touched || peakR >= 1.0) {
    stageCode = 'STAGE_4_TP1_LOCKED';
    // v21.23.7: giveback room ab vol-adaptive (LOW 0.40 / NORMAL 0.45 /
    // HIGH 0.55 / EXTREME 0.65) — floor +0.65R as-is.
    const lockR = Math.max(0.65, +(peakR - profile.stage4GivebackR).toFixed(2));
    // v21.24.0 LABEL HONESTY: the old text always said "TP1 Hit (50% Booked)" even
    // when only peakR>=1.0 triggered the stage; on LIVE the exchange TP/SL closes the
    // FULL position (no partial exists), so "% Booked" was never true there.
    const _isLiveRow = String(trade.executionMode || '').toUpperCase() === 'LIVE';
    const _tp1Txt = tp1Touched
      ? (_isLiveRow ? 'TP1 Hit (live: full position, no partial)' : `TP1 Hit (${Math.round(profile.tp1ClosePct * 100)}% Booked)`)
      : 'TP1 pending';
    if (smartTakesOver) {
      stageLabel = `Stage 4 · ${_tp1Txt} · ${smartPlan.label}`;
      candidateSl = tightenSl(candidateSl, smartPlan.slPrice);
    } else {
      stageLabel = `Stage 4 · ${_tp1Txt} · SL Auto-Trailed +${lockR}R`;
      candidateSl = tightenSl(candidateSl, priceAtR(lockR));
    }
  } else if (peakR >= profile.stage3R) {
    stageCode = 'STAGE_3_PROFIT_RATCHET';
    // v21.23.7: pre-TP1 ratchet giveback bhi vol-scaled (stage3 ≤ stage4 har class me).
    // v21.24.0: ENFORCE -> pre-activation ratchet keeps the stage-2 fee-protected curve
    // (v1 jumped to >= +0.45R at only +0.85R peak = inside one ATR of noise).
    const lockR = smartEnforce
      ? Math.max(0.15, +((peakR - 0.35) * 0.65).toFixed(2))
      : Math.max(0.45, +(peakR - profile.stage3GivebackR).toFixed(2));
    stageLabel = smartEnforce
      ? `Stage 3 · Pre-activation Fee-Protected Trail (+${lockR}R)`
      : `Stage 3 · Pre-TP1 Profit Ratchet (+${lockR}R Locked)`;
    candidateSl = tightenSl(candidateSl, priceAtR(lockR));
  } else if (peakR >= profile.stage2R) {
    stageCode = 'STAGE_2_BREAKEVEN_PLUS';
    const lockR = Math.max(0.15, +((peakR - 0.35) * 0.65).toFixed(2));
    stageLabel = `Stage 2 · Fee-Protected Breakeven + Auto-Trail (+${lockR}R Zero-Loss)`;
    const bePlus = isLong ? Math.max(feeFloor, priceAtR(lockR)) : Math.min(feeFloor, priceAtR(lockR));
    candidateSl = tightenSl(candidateSl, bePlus);
  } else if (peakR >= profile.stage1R) {
    stageCode = 'STAGE_1_RISK_HALVED';
    // v21.23.7: early-BE shield bar bhi vol-scaled (stage1R + 0.12) — HIGH/EXTREME
    // vol me BE-lock jaldi lagana whipsaw invite karta tha.
    const beShieldBarR = +(profile.stage1R + 0.12).toFixed(2);
    const lockR = peakR >= beShieldBarR && peakCoveredFee ? 0.05 : Math.max(-0.45, +(peakR - 0.80).toFixed(2));
    stageLabel = peakR >= beShieldBarR && peakCoveredFee
      ? 'Stage 1 · Early Breakeven Shield (Zero-Loss Lock)'
      : 'Stage 1 · Early Profit Shield (Risk Cut 50%+)';
    const shieldPx = peakR >= beShieldBarR && peakCoveredFee
      ? (isLong ? Math.max(feeFloor, priceAtR(0.05)) : Math.min(feeFloor, priceAtR(0.05)))
      : priceAtR(lockR);
    candidateSl = tightenSl(candidateSl, shieldPx);
  } else if (peakR >= profile.stage1EarlyR) {
    stageCode = 'STAGE_1_EARLY_SHIELD';
    stageLabel = 'Stage 1 · Ultra-Fast Micro-Shield (Risk Cut 35%)';
    candidateSl = tightenSl(candidateSl, priceAtR(-0.65));
  }

  // Realtime Trend & Reversal Detection (Bullish <-> Bearish)
  const boardRow = liveCtx.boardRow || null;
  const oppSide = isLong ? 'SHORT' : 'LONG';
  const boardFlipped = Boolean(
    boardRow && (
      (normalizeSide(boardRow.side) === oppSide && (boardRow.triggerFired || Number(boardRow.superScore) >= 65))
      || (boardRow.context?.dir != null && ((isLong && boardRow.context.dir < 0 && boardRow.triggerDir < 0) || (!isLong && boardRow.context.dir > 0 && boardRow.triggerDir > 0)))
    )
  );
  // v21.23.6: reversalRisk (trigger.reversalRisk / context.exhausted / opposingFlow) ek
  // RISK HINT hai — CONFIRMED flip NAHI. Strong uptrends me exhaustion flags routine
  // fire karte the; boardFlipped inhe count karke +0.12R pe profit-book kar deta tha
  // jabki price upar hi jata rehta tha (user: "price upar jata rehta hai tab auto close
  // ho raha hai"). Ab ye flags SIRF SL profit-lock tighten karte hain — book NAHI.
  const reversalRiskHint = Boolean(boardRow && (
    boardRow.reversalRisk === true
    || boardRow.trigger?.reversalRisk === true
    || boardRow.context?.exhausted === true
    || boardRow.trigger?.opposingFlow === true
  ));
  // Only evaluate peakGivebackRatio after meaningful favorable excursion (peakR >= 0.45)
  // so microscopic +0.01R entry ticks never trigger a false giveback tighten on newly opened trades.
  const peakGivebackRatio = (peakR >= 0.45 && peakMove > 0)
    ? Math.max(0, (peakMove - favorableMove) / peakMove)
    : 0;
  const givebackR = +(peakR - currentR).toFixed(2); // absolute giveback in R units
  // v21.23.7 VOL-ADAPTIVE PULLBACK TOLERANCE (user: "ek ek baar thoda pull
  // back bhi hota hai" — high-vol me to pullback hi NORMAL hai): book sirf
  // DEEP giveback pe — ratio >= profile.givebackRatioPct% (LOW 42 / NORMAL 45
  // / HIGH 55 / EXTREME 65) AND absolute >= profile.givebackAbsFloorR
  // (LOW 0.25 / NORMAL 0.28 / HIGH 0.38 / EXTREME 0.50R) DONO chahiye.
  // HIGH/EXTREME me ek-candle 45% noise-giveback ab book NAHI karta.
  // v21.24.0: when v2 owns the trail, the noise-aware trailed SL handles pullbacks;
  // the ratio-based "book on 45% giveback" exit was inside the noise band.
  const peakPullbackReversal = !smartTakesOver && !proExitPolicy && peakR >= 0.50 && peakGivebackRatio >= (profile.givebackRatioPct / 100) && givebackR >= profile.givebackAbsFloorR && feeCovered;
  const trailedSlHit = candidateSl > 0 && (isLong ? ltp <= candidateSl : ltp >= candidateSl);
  const slImproved = candidateSl > 0 && currentSl > 0 && Math.abs(candidateSl - currentSl) > 1e-7 && (isLong ? candidateSl > currentSl : candidateSl < currentSl);

  // If mild reversal signal appears before feeCovered (either explicit boardFlipped, or giveback after peakR >= 0.45),
  // defensively tighten SL to -0.35R to prevent full SL hit
  if (!proExitPolicy && (boardFlipped || reversalRiskHint || peakGivebackRatio >= 0.45) && !feeCovered && currentR > -0.30) {
    candidateSl = tightenSl(candidateSl, priceAtR(-0.35));
    stageLabel = `${stageLabel} · Defensive Reversal Tighten`;
  }
  // v21.23.6 REVERSAL-RISK PROFIT-LOCK (tighten ONLY — trade band NAHI hota):
  // exhaustion/opposing-flow hint ke saath profit me ho to SL ko
  // peak − profile.hintGivebackR (LOW/NORMAL 0.50 / HIGH/EXTREME 0.65 —
  // volatile regimes me routine exhaustion flags zyada fire hote hain,
  // isliye lock ko wide rakhna padta hai) pe lock karo (min +0.15R) —
  // giveback protection WITHOUT closing a potentially-still-strong trend.
  // tightenSl monotonic hai — stage locks isse loose nahi hote.
  if (!smartTakesOver && !proExitPolicy && reversalRiskHint && feeCovered && peakR >= 0.45) {
    const hintLockR = Math.max(0.15, +(peakR - profile.hintGivebackR).toFixed(2));
    candidateSl = tightenSl(candidateSl, priceAtR(hintLockR));
    stageLabel = `${stageLabel} · Reversal-Risk Profit-Lock`;
  }

  const reversalConfirmed = Boolean(boardFlipped || peakPullbackReversal || liveCtx.reversalConfirmed);

  // ---------- v21.29.0 [R3 REVERSAL GUARD V2] ----------
  // Tiered, closed-bar-aware. Shadow (default) = telemetry only; enforce on
  // PAPER tightens/exits; LIVE enforce additionally requires liveEnabled.
  const _guardCfg = loadMtfAutoConfig();
  const reversalGuardV2 = evaluateReversalGuardV2({
    side, entry, stopLoss: initialSl, ltp, peakPrice, risk,
    tp1Hit: tp1Touched, tp2Hit: tp2Touched,
    boardFlipped, reversalRiskHint,
    closedCandles: liveCtx.closedCandles || null,
    mode: reversalGuardV2Mode(),
    executionMode: trade.executionMode || 'PAPER',
    liveEnabled: liveCtx.liveReversalEnforce === true,
    feeCovered,
    lockR: 0.75,
  });
  if (reversalGuardV2.shouldTighten && reversalGuardV2.tightenSl > 0) {
    candidateSl = tightenSl(candidateSl, reversalGuardV2.tightenSl);
    stageLabel = `${stageLabel} · RV2 ${reversalGuardV2.tierLabel}`;
  }

  // ---------- v21.29.0 [R8 RUNNER AFTER TP2] ----------
  // Default OFF (TP2 closes 100%). PAPER-only enforce; LIVE stays gated
  // behind liveRunner + liveTp1Partial + R0/R1 safety and is reported as
  // shadow, never acted on silently.
  const runnerAfterTp2 = evaluateRunnerAfterTp2({
    mode: runnerAfterTp2Mode(),
    executionMode: trade.executionMode || 'PAPER',
    liveRunner: trade.liveRunner === true,
    liveTp1Partial: _guardCfg?.liveTp1Partial === true,
    liveSafeReduce: liveCtx.liveSafeReduce === true || liveCtx.liveRunnerSafety?.safeReduce === true,
    liveOrderIdempotency: liveCtx.liveOrderIdempotency === true || liveCtx.liveRunnerSafety?.orderIdempotency === true,
    tp2Hit: tp2Touched,
    side, entry, tp1: t1, risk, peakPrice, ltp,
    trailR: clampN(_guardCfg?.runnerTrailR, 0.25, 3, 0.75),
    runnerQtyPct: clampN(_guardCfg?.runnerQtyPct, 5, 50, 25),
    remainingQtyPct: Number(trade.qty) > 0 && trade.remainingQty != null
      ? (Number(trade.remainingQty) / Number(trade.qty)) * 100
      : null,
  });
  const runnerHold = Boolean(runnerAfterTp2.active && !runnerAfterTp2.shouldClose);
  if (runnerHold && runnerAfterTp2.trailSl > 0) {
    candidateSl = tightenSl(candidateSl, runnerAfterTp2.trailSl);
    stageCode = 'STAGE_5_RUNNER_ACTIVE';
    const rider = runnerAfterTp2.remainingQtyPct != null
      ? `Runner ${runnerAfterTp2.remainingQtyPct}% riding`
      : 'Runner riding';
    stageLabel = `Stage 5 · TP2 Hit · ${rider} (trail ${runnerAfterTp2.trailSl})`;
  }

  // ---------- v21.29.0 [R8 STALL EXIT] ----------
  const stallExit = evaluateStallExit({
    mode: stallExitMode(),
    executionMode: trade.executionMode || 'PAPER',
    allowLive: liveCtx.allowLiveStallExit === true,
    openedAt: Number(trade.openedAt ?? trade.openedAtMs) || 0,
    now: Number(liveCtx.now) > 0 ? Number(liveCtx.now) : Date.now(),
    stallMin: clampN(_guardCfg?.stallExitMin, 5, 1440, 45),
    peakR, currentR, t1Hit: tp1Touched, tp2Hit: tp2Touched,
    minPeakR: clampN(_guardCfg?.stallExitMinPeakR, 0, 2, 0.25),
  });

  const effectiveTp2Close = Boolean(tp2Touched && !runnerHold);
  const shouldRunnerExit = Boolean(runnerAfterTp2.shouldClose);
  const shouldReversalGuardClose = Boolean(reversalGuardV2.shouldExit);
  const shouldStallExit = Boolean(stallExit.shouldExit);

  // PRO: pre-TP1 only a CONFIRMED reversal (board flip / explicit confirmation)
  // can scratch the trade, and only AFTER round-trip fees are covered. A
  // normal pullback never qualifies. Post-TP1 a confirmed reversal exits at
  // the locked fee-BE/TP1 stop - never at a fee loss.
  const proPreTp1Scratch = proExitPolicy && !tp1Ladder && reversalConfirmed && feeCovered;
  const proPostTp1Reversal = proExitPolicy && tp1Ladder && !tp2Touched && reversalConfirmed && feeCovered;
  const legacyReversalProfit = !proExitPolicy && reversalConfirmed && feeCovered && currentR >= 0.12;
  const shouldBookProfitNow = Boolean(
    effectiveTp2Close
    || shouldRunnerExit
    || shouldReversalGuardClose
    || shouldStallExit
    || proPreTp1Scratch
    || proPostTp1Reversal
    || legacyReversalProfit
    || (trailedSlHit && feeCovered && peakR >= 0.50)
  );
  const shouldExitDefensiveSl = Boolean(trailedSlHit && !shouldBookProfitNow);

  const exitReason = shouldRunnerExit
    ? 'TP2_RUNNER_TRAIL_EXIT'
    : shouldReversalGuardClose
      ? 'REVERSAL_GUARD_V2_EXIT'
      : shouldStallExit
        ? 'STALL_EXIT_NO_PROGRESS'
        : effectiveTp2Close
          ? 'TP2_TARGET_HIT_FULL_PROFIT'
          : proPreTp1Scratch
            ? 'PRE_T1_REVERSAL_FEE_SAFE_SCRATCH'
            : proPostTp1Reversal
              ? 'T1_SECURED_REVERSAL_PROFIT_EXIT'
              : legacyReversalProfit
                ? (tp1Touched ? 'T1_BOOKED_REVERSAL_PROFIT_LOCK' : 'PRE_T1_REVERSAL_PROFIT_BOOKED')
                : (trailedSlHit && feeCovered)
                  ? 'TRAILED_SL_PROFIT_BOOKED'
                  : shouldExitDefensiveSl
                    ? (proExitPolicy ? 'INITIAL_SL_PROTECTIVE_EXIT' : 'TRAILED_SL_PROTECTIVE_EXIT')
                    : null;

  const grossPnl = +(favorableMove * qty).toFixed(4);
  const movePctFromEntry = entry > 0 ? +(((favorableMove / entry) * 100)).toFixed(3) : 0;
  const mfePct = entry > 0 ? +(((peakMove / entry) * 100)).toFixed(3) : 0;
  const roePct = +(movePctFromEntry * (Number(trade.leverage) || 10)).toFixed(2);
  const directionFollowing = currentR >= 0;
  const followThroughVerdict = currentR >= 0.25
    ? `✅ PAKKA ${side} FOLLOWING (+${currentR}R · ${roePct >= 0 ? '+' : ''}${roePct}% ROE)`
    : currentR >= 0
      ? `🟢 ${side} DIRECTION HOLDING (+${currentR}R)`
      : currentR > -0.35
        ? `🟡 NORMAL PULLBACK (${currentR}R · SL Guard Active)`
        : `⚠️ AGAINST ${side} (${currentR}R · SL Watch)`;
  const distToTp1Pct = t1 > 0 && ltp > 0 ? +(((isLong ? (t1 - ltp) : (ltp - t1)) / ltp) * 100).toFixed(2) : null;
  const distToTp2Pct = t2 > 0 && ltp > 0 ? +(((isLong ? (t2 - ltp) : (ltp - t2)) / ltp) * 100).toFixed(2) : null;
  const trendStatus = reversalConfirmed
    ? `⚠️ ${oppSide} REVERSAL DETECTED — ${feeCovered ? 'BOOKING PROFIT NOW' : 'SL TIGHTENED'}`
    : currentR >= 0.25
      ? `✅ ${isLong ? 'BULLISH' : 'BEARISH'} TREND STRONG (${currentR >= 0 ? '+' : ''}${currentR}R)`
      : `📡 ${isLong ? 'BULLISH' : 'BEARISH'} LIVE WATCH (${currentR >= 0 ? '+' : ''}${currentR}R)`;

  return {
    symbol: trade.symbol || null,
    market,
    ccy,
    side,
    orderSide: directionCertificate.orderSide,
    directionCertificate,
    directionBlocked: false,
    entry,
    ltp,
    initialStopLoss: initialSl,
    previousStopLoss: currentSl,
    trailedStopLoss: +candidateSl.toFixed(6),
    slTrailed: slImproved,
    t1,
    t2,
    tp1Hit: tp1Touched,
    tp2Hit: tp2Touched,
    // v21.28.0 [F4]: raw touch vs close-confirmed; ladder uses `tp1LadderActive`.
    tp1Confirmed: tp1CloseConfirmed === true,
    tp1CloseConfirmedKnown: tp1CloseConfirmed !== null,
    tp1ConfirmSource,
    tp1ConfirmedAt: _v3ConfirmAt,
    tp1LadderActive: Boolean(tp1Ladder),
    // v21.29.0 [R0b] missing-candle fallback telemetry (UI + shadow-diff).
    closedCandlesMissing,
    tp1FallbackMode,
    tp1Hold: {
      since: _v3HoldSince || null,
      ticks: _v3HoldTicks,
      eligible: _v3HoldEligible,
      minMs: TP1_FALLBACK_MIN_MS,
      minTicks: TP1_FALLBACK_MIN_TICKS,
    },
    exitPolicyV3: {
      mode: exitV3Mode,
      applied: exitV3Enforce,
      shadow: exitV3Available && !exitV3Enforce,
      tp1Touch: tp1Touched,
      tp1CloseConfirmed,
      tp1ConfirmSource,
      tp1ConfirmedAt: _v3ConfirmAt,
      barsSeen: _v3CandleCheck?.bars ?? 0,
      closedCandlesMissing,
      fallbackMode: tp1FallbackMode,
      fallbackEligible: _v3HoldEligible,
      beBufferR: v3BeBufferR,
      beBufferPrice: v3BeBufferPrice,
      bePlusBufferSl: v3BePlusBufferSl,
      legacyBeSl: _v3LegacyBeSl,
      note: !exitV3Available
        ? 'V3 inactive (proExitPolicy off or EXIT_POLICY_V3=off) — legacy ladder'
        : exitV3Enforce
          ? (tp1CloseConfirmed === true
            ? 'V3 ENFORCE: TP1 close-confirmed → BE+buffer locked'
            : 'V3 ENFORCE: TP1 not close-confirmed → initial SL stands')
          : 'V3 SHADOW: telemetry only — legacy ladder still decides',
    },
    peakPrice: +peakPrice.toFixed(6),
    currentR,
    peakR,
    movePctFromEntry,
    mfePct,
    roePct,
    directionFollowing,
    followThroughVerdict,
    peakGivebackPct: Math.round(peakGivebackRatio * 100),
    feeBreakevenPrice: feeFloor,
    feeCovered,
    peakCoveredFee,
    grossPnl,
    distToTp1Pct,
    distToTp2Pct,
    stageCode,
    stageLabel,
    // v21.26.1 PRO ladder telemetry (UI + logs): pre-TP1 = initial SL only,
    // post-TP1 = fee-BE, >=80% to TP2 = TP1 lock, TP2 = full close.
    proExitPolicy,
    tp2ProgressPct,
    tp2Approach,
    trendStatus,
    reversalDetected: reversalConfirmed,
    shouldBookProfitNow,
    shouldExitDefensiveSl,
    shouldClose: shouldBookProfitNow || shouldExitDefensiveSl,
    exitReason,
    // v21.29.0 [R3/R8] — explicit action flags (callers include these in the
    // close decision without changing legacy `shouldBookProfitNow` semantics).
    shouldReversalGuardClose,
    shouldRunnerExit,
    shouldStallExit,
    reversalGuardV2,
    runnerAfterTp2,
    stallExit,
    // v21.23.7 VOL-ADAPTIVE TELEMETRY — UI + 3s fast loop (b.* stamp) +
    // paper-engine TP1-partial live-sync isii se chalti hain.
    volClass,
    momentumState,
    atrPct: profile.atrPct ?? (Number(trade.atrPct) > 0 ? Number(trade.atrPct) : null),
    t1ClosePct: profile.tp1ClosePct,
    // v21.24.0 SMART TRAIL v2 telemetry (shadow = report only, enforce = acted on)
    trailEngine: smartTakesOver ? 'v2' : 'v1',
    t2Extended,
    t2Extensions: (Number(trade.t2Extensions) || 0) + (t2Extended ? 1 : 0),
    smartTrail: smartCfg ? {
      mode: smartMode,
      active: Boolean(smartPlan?.active),
      slPrice: smartPlan?.slPrice ?? null,
      lockR: smartPlan?.lockR ?? null,
      noiseR: smartPlan?.noiseR ?? null,
      tierFrac: smartPlan?.tierFrac ?? null,
      engineSl: +candidateSl.toFixed(6),
      // Honest comparison field: only meaningful when v1 actually decided
      // (off/shadow). In enforce the engine SL is the v2 SL — never label it v1.
      v1Sl: smartEnforce ? null : +candidateSl.toFixed(6),
      wouldExtendT2: smartExt ? smartExt.newT2 : null,
      wouldExtendBeforeTarget: smartExtBeforeTarget,
    } : null,
    checkedAt: Date.now(),
  };
}

/**
 * v21.29.0 [R0b] caller-side hold bookkeeping. Called by every deep-monitor
 * caller right after evaluateActiveTradeDeepMonitor():
 *   • while the favourable extreme is beyond T1, increment the hold window
 *     (`t1BeyondSince` / `t1BeyondTicks`) — but ONLY when closed candles are
 *     missing and the fallback is enabled;
 *   • once confirmed (candles, stamp, or fallback), persist a one-way
 *     `tp1CloseConfirmedAt` latch so a later candle-cache eviction cannot
 *     silently un-confirm a secured runner.
 * Pure-ish: mutates only the book row (the same object callers persist).
 */
export function stampTp1ConfirmHold(row = {}, deepEval = null, { now = Date.now(), closedCandles = null } = {}) {
  const b = row || {};
  const ev = deepEval || {};
  const mode = tp1ConfirmFallbackMode();
  const missing = !Array.isArray(closedCandles) || closedCandles.length === 0;
  const t1 = Number(ev.t1 ?? b.t1 ?? b.target1 ?? b.tp) || 0;
  const side = normalizeSide(ev.side ?? b.side ?? b.direction);
  const peak = Number(ev.peakPrice) > 0 ? Number(ev.peakPrice) : (Number(b.peakPrice) || 0);
  const touched = Boolean(t1 > 0 && side && peak > 0 && (side === 'LONG' ? peak >= t1 : peak <= t1));
  const confirmed = ev.tp1Confirmed === true;
  const latchAt = Number(b.tp1CloseConfirmedAt) > 0 ? Number(b.tp1CloseConfirmedAt) : null;

  if (touched && !confirmed && latchAt == null && mode === 'tick-hold' && missing) {
    if (!(Number(b.t1BeyondSince) > 0)) {
      b.t1BeyondSince = now;
      b.t1BeyondTicks = 1;
    } else {
      b.t1BeyondTicks = Math.max(0, Number(b.t1BeyondTicks) || 0) + 1;
    }
  } else if (!touched && latchAt == null) {
    // Pulled back before confirmation: the hold window restarts from scratch.
    b.t1BeyondSince = 0;
    b.t1BeyondTicks = 0;
  }

  if (confirmed && latchAt == null) {
    const at = Number(ev.tp1ConfirmedAt) > 0 ? Number(ev.tp1ConfirmedAt) : now;
    b.tp1CloseConfirmedAt = at;
  }
  b.closedCandlesMissing = missing;
  return {
    closedCandlesMissing: missing,
    confirmed: confirmed || Number(b.tp1CloseConfirmedAt) > 0,
    confirmSource: ev.tp1ConfirmSource || (Number(b.tp1CloseConfirmedAt) > 0 ? 'persisted-latch' : 'none'),
    holdSince: Number(b.t1BeyondSince) > 0 ? Number(b.t1BeyondSince) : null,
    holdTicks: Number(b.t1BeyondTicks) || 0,
  };
}

export function updateMtfAutoConfig(patch = {}) {
  const next = _sanitizeCfg({ ...loadMtfAutoConfig(), ...patch, desks: { ...loadMtfAutoConfig().desks, ...(patch.desks || {}) } });
  _cfg = next;
  _cfgSavedAt = Date.now();
  _save(CFG_FILE(), { ...next, updatedAt: _cfgSavedAt });
  _logEvent('config', `config updated — ${JSON.stringify({ enabled: next.enabled, liveEntryPaused: next.liveEntryPaused, mode: next.mode, minScore: next.minScore, riskPerTradeINR: next.riskPerTradeINR, riskPerTradePct: next.riskPerTradePct, maxLeverage: next.maxLeverage, maxWalletDeployPct: next.maxWalletDeployPct, dailyLossPct: next.dailyLossPct, maxPositionsINR: next.maxPositionsINR, maxTradesPerDay: next.maxTradesPerDay, consecutiveLossPauseAfter: next.consecutiveLossPauseAfter, consecutiveLossPauseMin: next.consecutiveLossPauseMin, riskCapsAcknowledged: next.riskCapsAcknowledged })}`);
  return next;
}

export function setMtfAutoEnabled(enabled) {
  const on = Boolean(enabled);
  const next = updateMtfAutoConfig({ enabled: on });
  // v21.23.18 [EXPLICIT RE-ARM = FRESH RETRY]: creds/arming fix karne ke baad
  // user jab LIVE dobara ON karta hai, purana failed-LIVE per-symbol backoff
  // (5m→4h) ELITE entry ko ghanton tak block nahi karega. Fail hua to naya
  // escalating backoff phir lagega (thrash protection intact).
  if (on) {
    const st = _loadState();
    if (st.failedLiveAttempts && Object.keys(st.failedLiveAttempts).length > 0) {
      st.failedLiveAttempts = {};
      _persistState();
    }
  }
  return next;
}
export function mtfAutoEnabled() { return !!loadMtfAutoConfig().enabled; }

// ---------------- state ----------------
function _loadState() {
  if (_state) return _state;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { raw = {}; }
  _state = {
    day: raw.day || null,
    dayCount: Number(raw.dayCount) || 0,
    perSymbolLast: raw.perSymbolLast && typeof raw.perSymbolLast === 'object' ? raw.perSymbolLast : {},
    // v21.23.10 [THRASH-CURE]: failed-LIVE-attempt per-symbol backoff map
    // { SYM: { at, count, reason } } — pehle reject hone par KOI bhi
    // cooldown/backoff stamp nahi hota tha (perSymbolLast sirf SUCCESS par
    // likha jata tha + live+flat bypass use wipe bhi kar deta tha) → teen
    // loops (10s probe / 15s recheck / 60s sweep) same symbol ko har ~10s
    // retry karte the (live-probe: 44 reject events + 46 phantom paper
    // trades minutes me). Ab escalating backoff: 5m → 10m → 20m → cap 240m.
    failedLiveAttempts: raw.failedLiveAttempts && typeof raw.failedLiveAttempts === 'object' ? raw.failedLiveAttempts : {},
    // v21.29.0 [R11] — per-filter shadow observations (bounded samples inside).
    // Persisted so a restart does not erase the evidence trail.
    shadowStats: raw.shadowStats && typeof raw.shadowStats === 'object' ? raw.shadowStats : {},
    book: Array.isArray(raw.book) ? raw.book.slice(-100) : [],
    events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
    lastTick: raw.lastTick || null,
    updatedAt: Number(raw.updatedAt) || null,
  };
  return _state;
}
function _persistState() {
  const st = _loadState();
  st.updatedAt = Date.now();
  _save(STATE_FILE(), st);
}

function _logEvent(kind, text, extra = null) {
  const st = _loadState();
  st.events.push({ at: Date.now(), kind, text, ...(extra ? { extra } : {}) });
  if (st.events.length > MAX_EVENTS) st.events = st.events.slice(-MAX_EVENTS);
  _persistState();
}

/**
 * Day rollover. GLOBAL quota ka canonical day = IST day (India desk primary;
 * crypto 24×7 hai magar daily-quota discipline IST din par hi rakhna saaf hai).
 * Per-DESK counting book rows ke apne market dayKey (INDIA=IST / CRYPTO=UTC)
 * se hoti hai — isliye ek desk ka midnight doosre ka counter nahi udaata.
 */
function _rollDayIfNeeded() {
  const st = _loadState();
  const key = istDayKey();
  if (st.day !== key) {
    // If there was no previous day stamp we are likely pre-restore/first run.
    // Do not write a default empty state before durable restore gets a chance
    // to hydrate the real one; the caller's entry persist will store the day.
    const hadDay = st.day != null;
    st.day = key;
    st.dayCount = 0;
    st.perSymbolLast = {};
    st.failedLiveAttempts = {}; // v21.23.10: naya din = naya backoff episode
    if (hadDay) _persistState();
  }
  return st;
}

// ---------------- v21.23.10 [THRASH-CURE] failed-LIVE-attempt backoff ----------------
// User symptom: "live mode pe not working" — engine LIVE order attempt karta
// hai, reject hota hai (creds absent / India not armed / exchange error), KUCH
// bhi stamp nahi hota, aur 10s/15s/60s teen loops phir wahi attempt dohrate
// hain. Fix: har failed live-attempt par per-symbol ESCALATING backoff
// (5m→10m→20m→40m… cap 4h). SUCCESS kabhi backoff nahi lagata. In-flight
// transient lock backoff nahi lagata. Map persisted (restart-safe) + day
// rollover par reset. Probe loop isLiveAttemptBackoffActive() consult karta
// hai, candidates pool blocker ke roop me padhta hai.
const LIVE_FAIL_BACKOFF_BASE_MS = 5 * 60_000;
const LIVE_FAIL_BACKOFF_MAX_MS = 240 * 60_000;
const LIVE_FAIL_EPISODE_RESET_MS = 6 * 3600_000;
function _liveFailBackoffMs(count) {
  const n = Math.max(1, Number(count) || 1);
  return Math.min(LIVE_FAIL_BACKOFF_MAX_MS, LIVE_FAIL_BACKOFF_BASE_MS * Math.pow(2, n - 1));
}
export function isLiveAttemptBackoffActive(symbol, now = Date.now()) {
  const f = _loadState().failedLiveAttempts?.[String(symbol || '').toUpperCase()];
  if (!f) return false;
  return _liveFailBackoffMs(f.count) - (now - Number(f.at || 0)) > 0;
}
function _stampLiveAttemptFailure(sym, reason, now = Date.now()) {
  const st = _loadState();
  if (!st.failedLiveAttempts || typeof st.failedLiveAttempts !== 'object') st.failedLiveAttempts = {};
  const key = String(sym || '').toUpperCase();
  if (!key) return;
  const prev = st.failedLiveAttempts[key];
  const prevAt = Number(prev?.at || 0);
  // 6h se purani failure = naya episode (count reset) — transient glitch
  // purane din ka count carry nahi karta.
  const count = (prev && now - prevAt < LIVE_FAIL_EPISODE_RESET_MS) ? (Number(prev.count) || 0) + 1 : 1;
  st.failedLiveAttempts[key] = { at: now, count, reason: String(reason || '').slice(0, 160) };
  const keys = Object.keys(st.failedLiveAttempts);
  if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete st.failedLiveAttempts[k];
  _persistState();
  _logEvent('live-backoff', `LIVE attempt failed on ${key} → backoff ${Math.round(_liveFailBackoffMs(count) / 60000)}m (attempt #${count}: ${String(reason || '').slice(0, 120)})`);
}
// v21.23.10 [PHANTOM-TRADE-CURE]: failed live-attempt ka paper-mirror rollback
// ab CLOSE nahi — VOID hai. Pehle har reject ek 2ms-lived paper trade mint
// karta tha (openPaperTrade → closePaperTrade rollback) jo round-trip COSTS
// book karta tha (live-probe: 46 fake MANUAL closes, net −₹2,206 poison in
// paper track-record + stats). voidPaperTrade row ko bina cost/journal ke
// hata deta hai; legacy fallback close sirf tab jab void available na ho.
function _voidRollbackPaperTrade(paper, res, quotes) {
  if (res?.trade?.id == null) return;
  if (typeof paper.voidPaperTrade === 'function') {
    try { paper.voidPaperTrade(res.trade.id); } catch { /* ignore */ }
    return;
  }
  if (typeof paper.closePaperTrade === 'function') {
    try { paper.closePaperTrade(res.trade.id, quotes); } catch { /* ignore */ }
  }
}

// ---------------- symbol normalization ----------------
/** Board symbols come as base tickers (BTC) or namespaced (FUT_BTC) —
 *  paper engine ko plain base chahiye. INDIA symbols pass untouched. */
export function normalizeLinkSymbol(symbol, market) {
  let s = String(symbol || '').toUpperCase().trim();
  if (String(market || '').toUpperCase() === 'INDIA') return s;
  s = s.replace(/^(FUT_|GLOB_)/, '');
  // v21.16.0 FIX (test-caught): CoinDCX/Binance spot symbols separator ke
  // BINA bhi aate hain (BTCUSDT) — pehla regex sirf '-USDT' pakadta tha,
  // isliye paper engine ko 'BTCUSDT' jaata jo quote-map me nahi milta.
  const m = s.match(/^([A-Z0-9]{2,10}?)(USDT|USDC|INR|USD)$/);
  if (m && m[1].length >= 2) return m[1];
  return s.replace(/[-_](USDT|USDC|INR|USD)$/, '');
}

// ---------------- open book helpers ----------------
export function isGenuinelyTradedEntry(b, cfg = loadMtfAutoConfig()) {
  if (!b || b.status !== 'OPEN') return false;
  if (b.untradedFallback === true || b.traded === false || b.liveSkipped === true) return false;
  if (b.openedInLiveMode === true && b.executionMode !== 'LIVE' && !b.liveOrderId && !b.livePositionId) return false;
  if (String(cfg?.executionMode || 'paper').toLowerCase() === 'live') {
    // When Auto-Trade is in LIVE mode, untraded fallback rows without a real order/position id or explicit paper test id are excluded
    if (b.executionMode === 'LIVE' || b.liveOrderId || b.livePositionId || b.fullControl === true) return true;
    // Allow explicit paper entries opened during paper mode in tests only if they weren't failed live fallbacks
    if (b.paperId != null && !b.openedInLiveMode) return true;
    return false;
  }
  return Boolean(b.executionMode === 'LIVE' || b.liveOrderId || b.livePositionId || b.paperId != null || b.traded === true);
}

/**
 * v21.23.18 [PAPER != LIVE SESSION]: ek book me PAPER test rows aur LIVE
 * exchange rows dono rehte hain. LIVE session ke hard gates (1-session lock,
 * day quota, notional budget, open-symbol lock, post-success cooldown) sirf
 * LIVE rows count karne chahiye — warna ek open PAPER test trade REAL ELITE
 * live entry ko indefinitely block kar deta hai ("LIVE ON par trade nahi
 * lagta"). PAPER rows monitoring ke liye book me rehte hain (SL/TP deep
 * monitor unhe pehle ki tarah manage karta hai), bas live gates nahi khaate.
 */
export function isLiveSessionEntry(b) {
  if (!b) return false;
  if (String(b.executionMode || '').toUpperCase() === 'LIVE') return true;
  if (b.liveOrderId || b.livePositionId) return true;
  return false;
}

/**
 * v21.25.1 [MANUAL PAPER != AUTO QUOTA]: sirf AUTO engine ki entries daily
 * trades quota consume karti hain. Manual board ke 🧪 PAPER clicks practice
 * hain (real-money budget nahi) — unhe quota me ginne se 3 paper tests poora
 * din auto engine ko block kar dete the, chahe ek bhi auto trade na hua ho.
 *
 * LIVE rows hamesha quota count karte hain (real exchange execution). PAPER
 * rows sirf tab jab unhe auto engine ne khola ho (`openedBy:'AUTO'`/autoTrade)
 * — manual paper rows monitoring me rehte hain, par quota nahi khaate.
 */
export function isAutoQuotaEntry(b) {
  if (!b) return false;
  if (isLiveSessionEntry(b)) return true;
  return b.openedBy === 'AUTO' || b.autoTrade === true || b.autoEngine === true;
}

/** Session-aware quota row filter shared by the tick and UC flip-reverse. */
export function isSessionQuotaEntry(b, isLiveSession = false) {
  return isLiveSession ? isLiveSessionEntry(b) : isAutoQuotaEntry(b);
}

export function purgeUntradedBookEntries() {
  const st = _loadState();
  let purged = 0;
  const now = Date.now();
  for (const b of st.book) {
    if (b.status !== 'OPEN') continue;
    const isUntraded = b.untradedFallback === true
      || b.traded === false
      || b.liveSkipped === true
      || (b.openedInLiveMode === true && b.executionMode !== 'LIVE' && !b.liveOrderId && !b.livePositionId)
      || (!b.liveOrderId && !b.livePositionId && b.paperId == null && b.traded !== true);
    if (isUntraded) {
      b.status = 'CLOSED';
      b.closeReason = 'PURGED_UNTRADED_ENTRY';
      b.closedAt = now;
      purged += 1;
    }
  }
  if (purged > 0) _persistState();
  return purged;
}

function _openLinked() {
  purgeUntradedBookEntries();
  const cfg = loadMtfAutoConfig();
  return _loadState().book.filter(b => isGenuinelyTradedEntry(b, cfg));
}
/**
 * Lightweight open-count used by background loops. Deliberately does NOT run
 * the deep monitor: the old `mtfAutoStatus()?.openCount` call evaluated every
 * position with a stale book LTP and could persist a rolling-TP2 extension
 * before the fresh-quote pass had a chance to act on it.
 */
export function mtfAutoOpenCount(market = null) {
  const open = _openLinked();
  if (market == null) return open.length;
  const m = String(market).toUpperCase();
  return open.filter(b => String(b.market || b.execMarket || '').toUpperCase() === m).length;
}

/**
 * Lightweight open-book projection for background loops that only need
 * symbol/market (direction-lock sweep, fast entry probe). Runs the same
 * genuine-entry filter as mtfAutoOpenCount, but never the deep monitor.
 */
export function mtfAutoOpenRows() {
  return _openLinked().map(b => ({
    symbol: b.symbol,
    market: b.market,
    execMarket: b.execMarket,
    side: b.side,
    status: b.status,
  }));
}

/**
 * Acknowledge that the current target2 is now live on the exchange. Only
 * clears `tpSyncPending`; a stale acknowledgement (target moved meanwhile)
 * is refused so a failed exchange call can never mask a newer target.
 */
export function markAutoTradeTpSynced({ symbol = null, paperId = null, t2 = null, exchange = false } = {}) {
  const st = _loadState();
  const wantT2 = Number(t2);
  const sym = String(symbol || '').toUpperCase();
  const b = st.book.find((x) => {
    if (x.status !== 'OPEN') return false;
    if (paperId != null && x.paperId != null && String(x.paperId) === String(paperId)) return true;
    return Boolean(sym) && String(x.symbol || '').toUpperCase() === sym;
  });
  if (!b) return { ok: false, error: 'open trade not found' };
  const currentT2 = Number(b.t2);
  if (wantT2 > 0 && currentT2 > 0 && Math.abs(currentT2 - wantT2) > 1e-9) {
    return { ok: false, error: 'target moved since sync request', target2: currentT2 };
  }
  if (exchange) b.lastExchangeTp = wantT2 > 0 ? wantT2 : (currentT2 > 0 ? currentT2 : null);
  b.tpSyncPending = false;
  b.lastTpSyncAt = Date.now();
  _persistState();
  return { ok: true, trade: b };
}

/**
 * v21.24.0 STOP-INTEGRITY: acknowledge that the book's trailed SL is now
 * armed on the exchange. A stale ack (book SL moved meanwhile) is refused, so
 * a slow exchange response can never mask a newer, tighter trail.
 */
export function markAutoTradeSlSynced({ symbol = null, paperId = null, stopLoss = null, exchange = false } = {}) {
  const st = _loadState();
  const sym = String(symbol || '').toUpperCase();
  const b = st.book.find((x) => {
    if (x.status !== 'OPEN') return false;
    if (paperId != null && x.paperId != null && String(x.paperId) === String(paperId)) return true;
    return Boolean(sym) && String(x.symbol || '').toUpperCase() === sym;
  });
  if (!b) return { ok: false, error: 'open trade not found' };
  const wantSl = Number(stopLoss);
  const bookSl = Number(b.trailedStopLoss ?? b.stopLoss);
  if (wantSl > 0 && bookSl > 0 && Math.abs(bookSl - wantSl) / bookSl > 0.0005) {
    return { ok: false, error: 'stop moved since sync request', trailedStopLoss: bookSl };
  }
  if (exchange) b.lastExchangeSl = wantSl > 0 ? wantSl : (bookSl > 0 ? bookSl : null);
  b.slSyncPending = false;
  b.slNextRetryAt = 0;
  b.lastSlSyncAt = Date.now();
  _persistState();
  return { ok: true, trade: b };
}

/**
 * v21.28.0 [F5 RETRY SPACING]: a create_tpsl push can be ACCEPTED while the
 * read-back is still unverified. Retrying on the next 3s/60s pass would stack
 * duplicate TP/SL orders on CoinDCX (replace-vs-stack behaviour is still
 * [VERIFY-LIVE]). This keeps the retry pending but spaces it out.
 */
export function markAutoTradeSlRetry({ symbol = null, paperId = null, retryAfterMs = 60_000, reason = null, now = Date.now() } = {}) {
  const st = _loadState();
  const sym = String(symbol || '').toUpperCase();
  const b = st.book.find((x) => {
    if (x.status !== 'OPEN') return false;
    if (paperId != null && x.paperId != null && String(x.paperId) === String(paperId)) return true;
    return Boolean(sym) && String(x.symbol || '').toUpperCase() === sym;
  });
  if (!b) return { ok: false, error: 'open trade not found' };
  const waitMs = Math.max(4_500, Number(retryAfterMs) || 60_000);
  b.slSyncPending = true;
  b.slNextRetryAt = Number(now) + waitMs;
  b.slLastSyncError = reason ? String(reason).slice(0, 180) : null;
  _persistState();
  return { ok: true, trade: b, retryAt: b.slNextRetryAt };
}

function _openNotionalINR(liveOnly = false) {
  const open = _openLinked();
  const rows = liveOnly ? open.filter(isLiveSessionEntry) : open;
  return rows.reduce((a, b) => a + (Number(b.notional) || 0), 0);
}

/**
 * v21.24.0 PHASE 0 — realized PnL for a desk's OWN current trade-day.
 * Book rows already carry `dayKey` (INDIA=IST / CRYPTO=UTC), so a quota reset
 * can never mix yesterday's loss into today's cap (or vice versa).
 */
function _dailyRealizedPnlForMarket(market, liveOnly = false, now = Date.now()) {
  const m = String(market || '').toUpperCase();
  if (!m) return 0;
  const dk = dayKeyFor(m, new Date(now));
  return _loadState().book.reduce((sum, b) => {
    if (String(b.status || '').toUpperCase() !== 'CLOSED') return sum;
    if (String(b.market || '').toUpperCase() !== m) return sum;
    if (b.dayKey !== dk) return sum;
    if (liveOnly && !isLiveSessionEntry(b)) return sum;
    const pnl = Number(b.pnl);
    return Number.isFinite(pnl) ? sum + pnl : sum;
  }, 0);
}

/**
 * v21.23.6: last SUCCESSFUL close epoch (persisted book se — restart-safe).
 * Successful = net pnl > 0 YA exchange ne position band ki jab wo >=0.5R
 * profit stage me thi (native TP/trailed-SL fills jahan row pnl null rehta
 * hai — EXCHANGE_POSITION_CLOSED). PURGED rows kabhi count nahi hote.
 */
function _lastProfitCloseAt(liveOnly = false) {
  const st = _loadState();
  let at = 0;
  for (const b of st.book) {
    if (b.status !== 'CLOSED' || !Number(b.closedAt)) continue;
    // v21.23.18: LIVE post-success cooldown sirf LIVE closes se — paper test
    // ka profit-mirror real live re-entry ko 5 min block nahi karega.
    if (liveOnly && !isLiveSessionEntry(b)) continue;
    const reason = String(b.closeReason || '');
    const success = Number(b.pnl) > 0
      || reason.includes('PROFIT')
      || (reason === 'EXCHANGE_POSITION_CLOSED' && Number(b.peakR) >= 0.5);
    if (success) at = Math.max(at, Number(b.closedAt));
  }
  return at;
}
/**
 * v21.22.0 FULL CONTROL OF COINDCX ACTIVE POSITIONS:
 * Adopts and syncs real active CoinDCX Futures positions into the Auto-Trade Deep Monitor
 * (`_state.book`) so the 15s Deep Monitor takes 100% control of SL trailing (Stage 0 -> Stage 5),
 * TP1/TP2 profit booking, and Bullish/Bearish Reversal profit-booking on the exchange.
 * Also closes any stale crypto LIVE book rows that are no longer open on CoinDCX.
 */
export function syncCoinDcxActivePositionsToDeepMonitor(activePositions = [], opts = {}) {
  const cfg = loadMtfAutoConfig();
  _rollDayIfNeeded();
  purgeUntradedBookEntries();
  const st = _loadState();
  const now = Number(opts.now) || Date.now();
  const fxRate = clampN(opts.fx ?? cfg.inrPerUsdt, 40, 150, 94.95);
  const activeSymSet = new Set();
  const synced = [];
  let changed = false;

  for (const pos of (Array.isArray(activePositions) ? activePositions : [])) {
    const rawSym = pos.symbol || String(pos.pair || '').replace(/^B-/, '').replace(/_USDT$/i, '');
    const sym = normalizeLinkSymbol(rawSym, 'CRYPTO');
    const qty = Math.abs(Number(pos.qty ?? pos.activePos) || 0);
    const entry = Number(pos.entry ?? pos. entryPrice ?? pos.avgPrice) || 0;
    if (!sym || !(qty > 0) || !(entry > 0)) continue;

    activeSymSet.add(sym);
    // v21.25.0 [ACTIVEPOS AUTHORITY]: exchange position sign is the truth.
    // Declared `pos.side` is secondary; a conflict is logged and the sign
    // wins. Unknown/missing side is NEVER coerced to LONG — adoption skips.
    const posSide = resolveActivePosSide({
      activePos: pos.activePos ?? pos.positionAmt,
      side: pos.side,
    });
    if (!posSide.side) {
      _logEvent('direction-block', `⛔ COINDCX ADOPTION SKIP ${sym}: ${posSide.reason} — position exchange par hai par side certify nahi ho sakti (no silent LONG)`);
      continue;
    }
    if (posSide.conflict) {
      _logEvent('direction-mismatch', `⚠️ COINDCX SIDE MISMATCH ${sym}: ${posSide.reason} — activePos sign authoritative, declared side discarded`);
    }
    const side = posSide.side;
    const isLong = side === 'LONG';
    const leverage = Math.max(1, Number(pos.leverage) || computeMtfWalletLeverage(cfg.walletAmountINR, cfg));
    const ltp = Number(pos.ltp ?? pos.markPrice ?? entry) || entry;
    const defaultRiskPct = 0.012; // 1.2% protective stop if position had no SL set
    const rawPosSl = Number(pos.stopLoss ?? pos.sl) > 0 ? Number(pos.stopLoss ?? pos.sl) : null;
    // v21.25.0: exchange-supplied levels must obey the authoritative side;
    // a wrong-side SL/TP is ignored (synthesized protective level instead).
    const posSlValid = rawPosSl != null && (isLong ? rawPosSl < entry : rawPosSl > entry);
    // v21.28.0 [F9 PROTECTION ARMING]: only an exchange-reported SL proves
    // native protection. `pos.stopLoss` may be journal/synthesized upstream.
    // Legacy callers/tests without the `exchangeSl` field keep the old contract.
    const hasExchangeSlField = Object.prototype.hasOwnProperty.call(pos, 'exchangeSl');
    const exchangeSlKnown = hasExchangeSlField
      ? (Number(pos.exchangeSl) > 0 ? Number(pos.exchangeSl) : null)
      : (posSlValid ? rawPosSl : null);
    const initialSl = posSlValid
      ? rawPosSl
      : +(isLong ? entry * (1 - defaultRiskPct) : entry * (1 + defaultRiskPct)).toFixed(6);
    const riskUnit = Math.max(entry * 0.004, Math.abs(entry - initialSl));
    const rawPosT1 = Number(pos.t1 ?? pos.tp1 ?? pos.tp) > 0 ? Number(pos.t1 ?? pos.tp1 ?? pos.tp) : null;
    const t1 = rawPosT1 != null && (isLong ? rawPosT1 > entry : rawPosT1 < entry)
      ? rawPosT1
      : +(isLong ? entry + 1.25 * riskUnit : entry - 1.25 * riskUnit).toFixed(6);
    const rawPosT2 = Number(pos.t2 ?? pos.tp2 ?? pos.tp) > 0 ? Number(pos.t2 ?? pos.tp2 ?? pos.tp) : null;
    const t2 = rawPosT2 != null && (isLong ? rawPosT2 > t1 : rawPosT2 < t1)
      ? rawPosT2
      : +(isLong ? entry + 2.4 * riskUnit : entry - 2.4 * riskUnit).toFixed(6);

    const existing = st.book.find(b => b.status === 'OPEN' && b.symbol === sym && b.market === 'CRYPTO');
    if (existing) {
      existing.executionMode = 'LIVE';
      existing.traded = true;
      existing.fullControl = true;
      existing.untradedFallback = false;
      if (pos.positionId || pos.exchangePositionId || pos.id) {
        existing.livePositionId = String(pos.positionId || pos.exchangePositionId || pos.id);
      }
      if (pos.orderId || pos.exchangeOrderId) {
        existing.liveOrderId = String(pos.orderId || pos.exchangeOrderId);
      }
      if (pos.pair) existing.pair = String(pos.pair);
      existing.qty = qty;
      // v21.28.0 [F2]: TP1 partial size is a fraction of the qty at adoption;
      // never overwrite it on later re-syncs.
      if (!(Number(existing.originalQty) > 0)) existing.originalQty = qty;
      existing.entry = entry;
      existing.leverage = leverage;
      if (ltp > 0) existing.ltp = ltp;
      // v21.25.0 [SIDE-SYNC CORRECTION]: agar book row ka stored side exchange
      // ke activePos sign se ulta hai to row ko correct karo — warna SHORT
      // position LONG ki tarah trail hoti hai (SL-hit logic inverted).
      let sideResynced = false;
      if (existing.side !== side) {
        sideResynced = true;
        _logEvent('direction-mismatch', `⚠️ BOOK SIDE CORRECTED ${sym}: ${existing.side || 'unknown'} → ${side} (activePos ${posSide.rawActivePos ?? '—'} authoritative)`);
        existing.side = side;
        existing.peakPrice = isLong ? Math.max(entry, ltp) : Math.min(entry, ltp);
        existing.deepMonitorStage = 'STAGE_0_INITIAL_GUARD';
        existing.deepMonitorLabel = 'Stage 0 · Initial SL Guard (side re-synced)';
        existing.trendStatus = `📡 ${isLong ? 'BULLISH' : 'BEARISH'} SIDE RE-SYNCED (${side})`;
        existing.t1Hit = false;
        existing.trailedStopLoss = initialSl;
        existing.lastExchangeSl = null;
        // v21.28.0 [F9]: a corrected side invalidates any previously armed
        // stop/target polarity — both must be re-armed before being trusted.
        existing.slSyncPending = true;
        existing.tpSyncPending = true;
        existing.slNextRetryAt = 0;
        existing.t1PartialBooked = false;
        existing.t1PartialBookedAt = null;
        existing.t1PartialNextRetryAt = 0;
        existing.t1PartialLastError = null;
        existing.t1PartialAmbiguous = false;
      }
      // Polarity repair: a level on the wrong side of entry can never be a
      // valid SL/target — replace with the exchange-derived protective levels.
      const slWrong = !(existing.stopLoss > 0) || (isLong ? existing.stopLoss >= entry : existing.stopLoss <= entry);
      if (slWrong) {
        existing.stopLoss = initialSl;
        existing.initialStopLoss = initialSl;
        existing.trailedStopLoss = initialSl;
      }
      if (!(existing.initialStopLoss > 0)) existing.initialStopLoss = initialSl;
      const initSlWrong = isLong ? existing.initialStopLoss >= entry : existing.initialStopLoss <= entry;
      if (initSlWrong) existing.initialStopLoss = existing.stopLoss;
      if (!(existing.trailedStopLoss > 0)) existing.trailedStopLoss = existing.stopLoss;
      const t1Wrong = !(existing.t1 > 0) || (isLong ? existing.t1 <= entry : existing.t1 >= entry);
      if (t1Wrong) existing.t1 = t1;
      const t2Wrong = !(existing.t2 > 0) || (isLong ? existing.t2 <= existing.t1 : existing.t2 >= existing.t1);
      if (t2Wrong) existing.t2 = t2;
      // v21.28.0 [F9 PROTECTION ARMING]: exchange read-back is authoritative.
      // When CoinDCX reports a valid SL, adopt it as the protection anchor;
      // when no exchange SL is known and we never verified one, mark the row
      // sync-pending so the 3s/15s lane arms it through the F5 read-back path
      // (never claim PROTECTED on a synthesized/journal level).
      if (sideResynced) {
        // Old anchor had the opposite polarity — never trust it after a flip.
        existing.lastExchangeSl = null;
        existing.slSyncPending = true;
        existing.tpSyncPending = true;
      } else if (exchangeSlKnown > 0) {
        existing.lastExchangeSl = exchangeSlKnown;
        existing.slSyncPending = false;
      } else if (!(Number(existing.lastExchangeSl) > 0)) {
        existing.lastExchangeSl = null;
        existing.slSyncPending = true;
      }
      existing.activePos = posSide.rawActivePos;
      existing.directionCertificate = buildDirectionCertificate({
        symbol: sym,
        market: 'CRYPTO',
        side,
        activePos: posSide.rawActivePos,
        entry,
        stopLoss: existing.initialStopLoss ?? existing.stopLoss,
        t1: existing.t1,
        t2: existing.t2,
        requireTargets: true,
        source: 'coindcx-adoption',
      });
      // v21.23.10 [ADOPTED-VOL-STAMP]: paper/manual row LIVE adopt hote waqt
      // vol stamps missing the → NORMAL-tight trail; SL-distance proxy se stamp.
      if (!(existing.atrPct > 0) && entry > 0 && initialSl > 0) {
        const slPct = Math.abs(entry - initialSl) / entry * 100;
        existing.atrPct = +(slPct * 0.8).toFixed(3);
        existing.volClass = existing.volClass || classifyVolatility(existing.atrPct);
        if (!(existing.t1ClosePct > 0)) existing.t1ClosePct = tp1ClosePctFor(existing.volClass);
      }
      changed = true;
      synced.push(existing);
      continue;
    }

    const walletINR = Number(opts.walletINR || cfg.walletAmountINR) || 10000;
    const wDeploy = computeWallet95Deployment({
      walletINR,
      leverage,
      fxRate,
      deployPct: cfg.walletDeployPct ?? 100,
      cfg,
    });
    const feeBePrice = feeBreakevenFloor({ entry, side, market: 'FUTURES' });
    // v21.23.10 [ADOPTED-VOL-STAMP]: adopted/manual CoinDCX positions par
    // pehle KOI atrPct/volClass entry-stamp nahi tha → resolveVolClass har
    // tick NORMAL par bottom-out (tight v21.23.6 trail) — "kam profit book"
    // symptom specifically in positions par. Exchange SL-distance (% of
    // entry) ko ATR% proxy ke roop me stamp karo (SL ≈ 1.25×ATR typical →
    // atrPct ≈ 0.8 × slPct) — honest estimate, LIVE 15s tick board-row
    // milne par asli atrPct se refresh ho jata hai.
    const adoptedSlPct = entry > 0 && initialSl > 0 ? Math.abs(entry - initialSl) / entry * 100 : 0;
    const adoptedAtrPct = adoptedSlPct > 0 ? +(adoptedSlPct * 0.8).toFixed(3) : null;
    const adoptedVolClass = adoptedAtrPct != null ? classifyVolatility(adoptedAtrPct) : null;
    const rec = {
      paperId: null,
      liveOrderId: pos.orderId || pos.exchangeOrderId || pos.id || `cdx-pos-${sym}`,
      livePositionId: pos.positionId || pos.exchangePositionId || pos.id || null,
      pair: pos.pair || `B-${sym}_USDT`,
      executionMode: 'LIVE',
      traded: true,
      fullControl: true,
      openedInLiveMode: true,
      symbol: sym,
      market: 'CRYPTO',
      execMarket: 'FUTURES',
      ccy: 'USDT',
      fxUsed: fxRate,
      side,
      orderSide: side === 'LONG' ? 'buy' : 'sell',
      activePos: posSide.rawActivePos,
      directionCertificate: buildDirectionCertificate({
        symbol: sym,
        market: 'CRYPTO',
        side,
        activePos: posSide.rawActivePos,
        entry,
        stopLoss: initialSl,
        t1,
        t2,
        requireTargets: true,
        source: 'coindcx-adoption',
      }),
      score: Number(pos.superScore ?? pos.score) || 86,
      tier: pos.tier || 'ELITE',
      mode: pos.mode || cfg.mode || 'INTRADAY',
      holdMin: Number(pos.holdMin) || cfg.holdMin || 45,
      entry,
      ltp,
      stopLoss: initialSl,
      initialStopLoss: initialSl,
      trailedStopLoss: initialSl,
      peakPrice: isLong ? Math.max(entry, ltp) : Math.min(entry, ltp),
      t1,
      t2,
      lastExchangeTp: null,   // adopted position: exchange TP not verified
      tpSyncPending: false,
      // v21.28.0 [F9]: no exchange SL read-back = unverified → arm via retry.
      lastExchangeSl: exchangeSlKnown,
      slSyncPending: !(exchangeSlKnown > 0),
      qty,
      originalQty: qty,
      leverage,
      walletINR: Math.round(wDeploy.walletTotalINR),
      walletDeployPct: wDeploy.walletDeployPct,
      deployedWalletINR: wDeploy.deployedWalletINR,
      deployedWalletUSDT: wDeploy.deployedWalletUSDT,
      buyingPowerINR: wDeploy.buyingPowerINR,
      buyingPowerUSDT: wDeploy.buyingPowerUSDT,
      feeBreakevenPrice: feeBePrice,
      deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
      deepMonitorLabel: 'Stage 0 · Initial SL Guard (CoinDCX Full Control)',
      // v21.23.10 [ADOPTED-VOL-STAMP]: adopted positions ab vol-aware trail
      // chalati hain (pehle hamesha NORMAL tight profile).
      atrPct: adoptedAtrPct,
      volClass: adoptedVolClass || null,
      momentumState: null,
      t1ClosePct: adoptedVolClass ? tp1ClosePctFor(adoptedVolClass) : 0.5,
      trendStatus: `📡 ${side === 'SHORT' ? 'BEARISH' : 'BULLISH'} COINDCX ACTIVE POSITION CONTROL`,
      marginINR: +(qty * entry * fxRate / leverage).toFixed(2),
      marginUsdt: +(qty * entry / leverage).toFixed(4),
      riskINR: +(qty * riskUnit * fxRate).toFixed(2),
      riskUsdt: +(qty * riskUnit).toFixed(4),
      notional: +(qty * entry * fxRate).toFixed(2),
      notionalUsdt: +(qty * entry).toFixed(4),
      openedAt: Number(pos.openedAt) || now,
      dayKey: dayKeyFor('FUTURES'),
      status: 'OPEN',
      closeReason: null,
      closedAt: null,
      pnl: null,
      drivers: ['CoinDCX Active Position Adopted under Full Deep Monitor Control'],
    };
    st.book.push(rec);
    changed = true;
    synced.push(rec);
    _logEvent('position-sync', `🔒 COINDCX ACTIVE POSITION FULL CONTROL: ${sym} ${side} qty ${qty} @ ${entry} (${leverage}x) · SL ${initialSl} · TP1 ${t1} · TP2 ${t2}`);
  }

  // If authoritativeExchangeList is true, close any crypto LIVE book row that is no longer open on CoinDCX (grace 120s for newly submitted orders)
  if (opts.authoritativeExchangeList === true) {
    const flatConfirmed = Array.isArray(opts.flatConfirmedSyms) ? new Set(opts.flatConfirmedSyms) : null;
    for (const b of st.book) {
      if (b.status !== 'OPEN') continue;
      if (b.market !== 'CRYPTO' && b.execMarket !== 'FUTURES') continue;
      if (b.executionMode !== 'LIVE') continue;
      const ageMs = now - (Number(b.openedAt) || 0);
      if (ageMs < 120_000) continue;
      if (!activeSymSet.has(b.symbol) && (!flatConfirmed || flatConfirmed.has(b.symbol))) {
        b.status = 'CLOSED';
        b.closeReason = 'EXCHANGE_POSITION_CLOSED';
        b.closedAt = now;
        // v21.26.1: an exchange-side close never passes through
        // mtfAutoSuperAgentManage(), so stamp the agent lifecycle here. The
        // tick router must not fall back to a stale trail action (SL_TRAILED)
        // as the IDLE reason while the book row says EXCHANGE_POSITION_CLOSED.
        b.superAgentState = 'IDLE';
        b.superAgentIdleReason = 'EXCHANGE_POSITION_CLOSED';
        b.superAgentIdleAt = now;
        changed = true;
      }
    }
  }

  if (changed) _persistState();
  return { ok: true, activeCount: synced.length, synced };
}

/**
 * v21.23.8 UC FLIP-AND-REVERSE — reverse-entry ticket derivation (PURE).
 *
 * Jab board UC-status pakka opposite-side confirm karta hai (revByRow), to
 * reverse trade ko EK market-order ticket chahiye jo CURRENT live price ke
 * around anchored ho (purana plan entry door ho sakta hai). Priority:
 *   1. Flipped board-row ka apna plan (SL valid-side + reasonable distance)
 *   2. Synthetic protective geometry: SL = 1.2% (wahi default jo CoinDCX
 *      position-sync use karta hai) · T1 = +1.25R · T2 = +2.4R
 *
 * Board plan SL tabhi use hota hai jab wo current price ke SAHI side par ho
 * (LONG→SL neeche / SHORT→SL upar) aur 0.3%–5% distance band me ho —
 * stale/absurd plan levels kabhi reverse ticket me leak nahi hote.
 */
export function deriveUcFlipReverseTicket({ side, ltp, boardRow = null, fallbackRiskPct = 0.012 } = {}) {
  // v21.25.0 [NO SILENT LONG]: unknown side par reverse ticket bilkul nahi —
  // pehle `!== 'SHORT'` har garbage ko LONG reverse bana deta tha.
  const s = normalizeSide(side);
  if (!s) return null;
  const px = Number(ltp) || 0;
  if (!(px > 0)) return null;
  const isLong = s === 'LONG';

  const planSl = Number(boardRow?.plan?.stopLoss) || 0;
  const planEntry = Number(boardRow?.plan?.entry) || 0;
  const planT1 = Number(boardRow?.plan?.t1) || 0;
  const planT2 = Number(boardRow?.plan?.t2) || 0;

  const slValidSide = planSl > 0 && (isLong ? planSl < px : planSl > px);
  const slDistPct = slValidSide ? Math.abs(px - planSl) / px : 0;
  const slReasonable = slValidSide && slDistPct >= 0.003 && slDistPct <= 0.05;
  const riskUnit = slReasonable
    ? Math.abs(px - planSl)
    : Math.max(px * 0.004, px * (Number(fallbackRiskPct) > 0 ? Number(fallbackRiskPct) : 0.012));
  if (!(riskUnit > 0)) return null;
  const stopLoss = +(isLong ? px - riskUnit : px + riskUnit).toFixed(6);

  // T1/T2: flipped-row plan valid-side + sane R-spacing → use; warna synthetic.
  const t1PlanValid = planT1 > 0 && planEntry > 0 && (isLong ? planT1 > px : planT1 < px)
    && Math.abs(planT1 - px) >= 0.4 * riskUnit && Math.abs(planT1 - px) <= 6 * riskUnit;
  const t1 = t1PlanValid ? +planT1.toFixed(6) : +(isLong ? px + 1.25 * riskUnit : px - 1.25 * riskUnit).toFixed(6);
  const t2PlanValid = planT2 > 0 && t1PlanValid && (isLong ? planT2 > t1 : planT2 < t1)
    && Math.abs(planT2 - px) >= Math.abs(planT1 - px);
  const t2 = t2PlanValid ? +planT2.toFixed(6) : +(isLong ? px + 2.4 * riskUnit : px - 2.4 * riskUnit).toFixed(6);

  return {
    side: s,
    entry: px,
    stopLoss,
    t1,
    t2,
    riskUnit,
    src: slReasonable ? 'board-plan' : 'synthetic',
  };
}

/**
 * v21.23.8: aaj (trade-day) ek symbol par kitni UC flip-reverse entries
 * already khul chuki hain — book se derive (restart-safe, koi extra state
 * nahi). Churn guard ke liye.
 */
function _ucFlipCountToday(symbol, execMarket, now = null) {
  const st = _loadState();
  // v21.23.8 test-determinism: day-key SUNDAY tick ke `now` (jo tests fixed
  // clock dete hain) se derive hota hai — real-clock mix-up se count kabhi
  // galat nahi hota (runtime me `now` Date.now() hi hai).
  const dk = dayKeyFor(execMarket, new Date(Number(now) || Date.now()));
  let n = 0;
  for (const x of st.book) {
    if (x.flipEntry === true && String(x.symbol || '').toUpperCase() === String(symbol || '').toUpperCase() && x.dayKey === dk) n += 1;
  }
  return n;
}

/**
 * v21.23.8 UC FLIP-AND-REVERSE — purana trade band hone ke TURANT baad
 * same-symbol opposite-side reverse entry. Caller (deep monitor sweep)
 * ne close confirm kar diya hai; ye helper sirf ENTRY ka kaam karta hai.
 *
 * SAFETY (hard):
 *   • Strict traded-only: LIVE reverse order fail → paper mirror close + NO book row.
 *   • EQUITY SIM (GLOBALFUTURES) kabhi LIVE nahi — paper/SIM only.
 *   • Daily quota + notional budget + flip-churn cap (4/symbol/day) respected.
 *   • Direction lock: purana release + naya opposite-side acquire (atomic).
 */
async function _tryOpenUcFlipReverse({ b, boardRow, ltp, p, cfg, out, now }) {
  try {
    if (cfg?.ucFlipReverse === false) return null;
    if (!(Number(ltp) > 0)) return null;
    const paper = p.paper || {};
    // paper engine inject hi na ho to ZERO side-effects ke saath bail —
    // legacy test mocks (sirf close/getSummary) ke liye state kabhi mutate
    // nahi hoti.
    if (typeof paper.openPaperTrade !== 'function') return null;
    const sym = String(b.symbol || '').toUpperCase();
    const execMarket = String(b.execMarket || b.market || 'FUTURES').toUpperCase();
    const isSim = execMarket === 'GLOBALFUTURES';
    // v21.25.0 [STRICT OPPOSITE]: invalid stored side par reverse entry nahi
    // (pehle har non-LONG side ko LONG maan liya jata tha).
    const side = oppositeSideOf(b.side);
    if (!side) {
      _logEvent('flip-skip', `⛔ UC FLIP-REVERSE SKIP ${sym}: stored side "${b.side ?? ''}" invalid — reverse side derive nahi ho sakti`);
      return null;
    }
    // Reverse ka mode purane trade ke mode se hi mirror hota hai. PAPER trade
    // ke liye site-live hone se relaxed live quota / LIVE order dono galat hain.
    const priorWasLive = b.executionMode === 'LIVE' || Boolean(b.livePositionId) || Boolean(b.liveOrderId);

    // v21.24.0 PHASE 0: LIVE entries paused → protective exit ho sakta hai,
    // par naya reverse LIVE entry NAHI. Existing position management intact.
    if (cfg?.liveEntryPaused === true && priorWasLive) {
      _logEvent('flip-skip', `🔁 UC FLIP-REVERSE SKIP ${sym}: LIVE entries paused (Phase 0) — protective exit only`);
      return null;
    }

    // v21.23.14 [REVERSE-ENTRY PARITY]: a protective exit may use an
    // opposite row, but a NEW reverse position must clear the same hard
    // readiness gates as a manual/auto entry. Unverified / ensemble-warming /
    // counter-trend / vetoed rows can exit the old trade but never open one.
    const reverseReady = Boolean(
      boardRow
      && normalizeSide(boardRow.side) === side
      && boardRow.directionVerified === true
      && boardRow.ensembleSignalAvailable !== false
      && boardRow.autoEligible === true
      && boardRow.counterTrend !== true
      && boardRow.counterHtf !== true
      && !boardRow.trapVeto
      && !boardRow.zoneWallVeto
      && !boardRow.reversalRisk
      && boardRow.trigger?.opposingFlow !== true
    );
    if (!reverseReady) {
      _logEvent('flip-skip', `?? UC FLIP-REVERSE SKIP ${sym}: protective exit done, reverse entry blocked - direction/ensemble/auto readiness not verified`);
      return null;
    }

    const ticket = deriveUcFlipReverseTicket({ side, ltp, boardRow });
    if (!ticket) return null;

    // churn cap: din me sirf 4 flip-entries per symbol
    if (_ucFlipCountToday(sym, execMarket, now) >= UC_FLIP_MAX_PER_SYMBOL_PER_DAY) {
      _logEvent('flip-skip', `🔁 UC FLIP-REVERSE SKIP ${sym}: daily flip cap (${UC_FLIP_MAX_PER_SYMBOL_PER_DAY}) reached — protective exit done, reverse entry nahi`);
      return null;
    }
    // strict 1-trade-per-session: close ke baad koi aur open bacha to flip nahi
    // v21.23.18: LIVE session me PAPER test rows is lock ko nahi khaate.
    // v21.23.18 [FLIP SESSION PARITY]: yahi expression tick ke `isLiveSession`
    // se match karna chahiye. Pehle `autoSyncSiteLive !== false` akela bhi true
    // hota tha (default true), isliye PAPER mode me bhi session LIVE maana jata
    // tha -> doosra open PAPER trade 1-session lock break kar deta tha aur
    // paper notional LIVE budget se kata jata tha.
    const flipLiveSession = cfg.executionMode === 'live'
      || Boolean(cfg.autoSyncSiteLive !== false && (siteLiveForDesk(p, 'CRYPTO') || siteLiveForDesk(p, 'INDIA')));
    const otherOpen = flipLiveSession ? _openLinked().filter(isLiveSessionEntry) : _openLinked();
    if (otherOpen.length > 0) {
      _logEvent('flip-skip', `🔁 UC FLIP-REVERSE SKIP ${sym}: another trade still open — 1 session = 1 trade lock`);
      return null;
    }
    // daily quota — hard cap, counted against each row's own market day so a
    // UTC crypto session cannot be blocked/shortened by the IST rollover.
    const stq = _rollDayIfNeeded();
    const flipQuota = Number(cfg.maxTradesPerDay) || 0;
    const flipQuotaUnlimited = !(flipQuota > 0);
    const flipDayCount = stq.book.filter(b => isSessionQuotaEntry(b, flipLiveSession))
      .filter(b => b.dayKey === dayKeyFor(b.market, new Date(now))).length;
    if (!flipQuotaUnlimited && flipDayCount >= flipQuota) {
      _logEvent('flip-skip', `🔁 UC FLIP-REVERSE SKIP ${sym}: daily quota ${flipDayCount}/${flipQuota} done`);
      return null;
    }

    const fxRate = clampN(p.fx ?? cfg.inrPerUsdt, 40, 150, 84);
    const isUsd = execMarket === 'FUTURES' || execMarket === 'GLOBALFUTURES' || execMarket === 'CRYPTO';
    const entry = ticket.entry;
    const riskPerUnit = ticket.riskUnit;

    // v21.24.0 PHASE 0 risk caps — normal entry path ke SAME contract se.
    const effectiveWalletINR = Number(p.walletEquityINR) > 0 ? Number(p.walletEquityINR) : Number(cfg.walletAmountINR) || 10000;
    const riskCaps = computeEffectiveRiskCaps(cfg, effectiveWalletINR);
    const dailyLossCapINR = riskCaps.dailyLossCapINR;
    if (dailyLossCapINR != null) {
      const realized = _dailyRealizedPnlForMarket(execMarket === 'INDIA' ? 'INDIA' : 'CRYPTO', flipLiveSession, now);
      if (realized <= -dailyLossCapINR) {
        _logEvent('flip-skip', `🔁 UC FLIP-REVERSE SKIP ${sym}: daily loss stop hit (${realized.toFixed(2)} <= -${dailyLossCapINR})`);
        return null;
      }
    }

    // qty: risk-based sizing (wahi math jo normal entry path use karta hai)
    const riskBudget = isUsd ? riskCaps.effectiveRiskINR / fxRate : riskCaps.effectiveRiskINR;
    let qty = isUsd ? Math.floor((riskBudget / riskPerUnit) * 10000) / 10000 : Math.floor(riskBudget / riskPerUnit);
    const notionalCapINR = Math.min(cfg.maxNotionalPerTradeINR, cfg.maxPositionsINR - _openNotionalINR(flipLiveSession));
    const capQty = isUsd ? (notionalCapINR / fxRate) / entry : notionalCapINR / entry;
    if (qty > capQty) qty = isUsd ? Math.floor(capQty * 10000) / 10000 : Math.floor(capQty);
    const minQty = isUsd ? 0.0001 : 1;
    if (!(qty >= minQty)) {
      _logEvent('flip-skip', `🔁 UC FLIP-REVERSE SKIP ${sym}: qty too small after caps (risk ${riskPerUnit.toFixed(4)})`);
      return null;
    }

    const leverage = isSim ? 1 : riskCaps.effectiveLeverage;
    const w95 = computeWallet95Deployment({ walletINR: effectiveWalletINR, leverage, fxRate, deployPct: riskCaps.effectiveWalletDeployPct, cfg });
    const feeBePrice = feeBreakevenFloor({ entry, side, market: execMarket });

    // v21.23.7 ENTRY-STAMP parity: vol class + TP1 partial % flip entry par bhi
    const entryAtrPct = Number(boardRow?.context?.atrPct) > 0
      ? Number(boardRow.context.atrPct)
      : (Number(b.atrPct) > 0 ? Number(b.atrPct) : null);
    const entryVolClass = entryAtrPct != null ? classifyVolatility(entryAtrPct) : (b.volClass || VOL_CLASS.NORMAL);
    const entryT1ClosePct = tp1ClosePctFor(entryVolClass);

    const res = paper.openPaperTrade?.({
      symbol: sym, direction: side,
      entry, qty, stopLoss: ticket.stopLoss, target1: ticket.t1, target2: ticket.t2,
      market: execMarket, leverage,
      feeBreakevenPrice: feeBePrice,
      t1ClosePct: entryT1ClosePct,
      atrPct: entryAtrPct,
      source: 'uc-flip-reverse',
      sourceMeta: {
        flippedFrom: `${sym} ${b.side}`, flipCloseReason: b.closeReason || null,
        score: boardRow?.superScore ?? b.score ?? null, tier: boardRow?.tier ?? b.tier ?? null,
        leverage, walletINR: effectiveWalletINR,
        walletDeployPct: w95.walletDeployPct, deployedWalletINR: w95.deployedWalletINR,
        feeBreakevenPrice: feeBePrice,
      },
      label: `UC FLIP-REVERSE · ${boardRow?.tier ?? b.tier ?? 'FLIP'} ${boardRow?.superScore ?? b.score ?? '—'} · ${side} (was ${b.side}) · ${isUsd ? (isSim ? 'USDC' : 'USDT') : '₹'}`,
    });
    if (!res || res.error || res.ok === false) {
      _logEvent('flip-skip', `🔁 UC FLIP-REVERSE ${sym}: paper open failed — ${res?.error || 'unavailable'}`);
      return null;
    }

    // LIVE reverse order — sirf REAL desks (FUTURES perps / INDIA);
    // EQUITY SIM desk paper/SIM-only hai (CoinDCX par listed hi nahi).
    let liveOrderResult = null;
    // [PAPER-LIVE-LEAK FIX] Site live credentials hone se PAPER trade ka
    // reverse LIVE order ban jata tha (live reject → paper mirror rollback).
    // Reverse ka mode purane trade ke mode se hi mirror hoga: PAPER close →
    // PAPER reverse, LIVE close → LIVE reverse (jab live session active ho).
    const wantLiveOrder = !isSim && priorWasLive
      && (cfg.executionMode === 'live' || Boolean(siteLiveForDesk(p, b.market) && cfg.autoSyncSiteLive !== false));
    if (wantLiveOrder) {
      if (typeof p.liveExecute !== 'function') {
        _voidRollbackPaperTrade(paper, res, p.quotes);
        _stampLiveAttemptFailure(sym, 'flip-reverse: live handler unavailable', now);
        _logEvent('flip-skip', `🔁 UC FLIP-REVERSE ${sym}: live handler unavailable — no untraded reverse entry`);
        return null;
      }
      try {
        liveOrderResult = await p.liveExecute({
          symbol: sym, market: execMarket, side,
          entry, stopLoss: ticket.stopLoss, target1: ticket.t1, target2: ticket.t2,
          qty, leverage,
          walletINR: effectiveWalletINR,
          walletDeployPct: w95.walletDeployPct,
          deployedWalletINR: w95.deployedWalletINR,
          deployedWalletUSDT: w95.deployedWalletUSDT,
          buyingPowerINR: w95.buyingPowerINR,
          buyingPowerUSDT: w95.buyingPowerUSDT,
          row: boardRow,
        });
        if (!liveOrderResult?.ok) {
          _voidRollbackPaperTrade(paper, res, p.quotes);
          if (liveOrderResult?.inFlight !== true) _stampLiveAttemptFailure(sym, `flip-reverse: ${liveOrderResult?.error || liveOrderResult?.reason || 'not filled'}`, now);
          _logEvent('flip-skip', `🔁 UC FLIP-REVERSE ${sym}: live order not executed — ${liveOrderResult?.error || liveOrderResult?.reason || 'not filled'}`);
          return null;
        }
      } catch (e) {
        _voidRollbackPaperTrade(paper, res, p.quotes);
        _stampLiveAttemptFailure(sym, `flip-reverse error: ${e?.message || e}`, now);
        _logEvent('flip-skip', `🔁 UC FLIP-REVERSE ${sym}: live order error — ${e?.message || e}`);
        return null;
      }
    }

    const finalQty = Number(liveOrderResult?.filled?.qty) > 0 ? Number(liveOrderResult.filled.qty) : qty;
    const finalEntry = Number(liveOrderResult?.filled?.price) > 0 ? Number(liveOrderResult.filled.price) : entry;
    const finalSl = Number(liveOrderResult?.filled?.stopLoss) > 0 ? Number(liveOrderResult.filled.stopLoss) : ticket.stopLoss;
    const finalT1 = Number(liveOrderResult?.filled?.t1) > 0 ? Number(liveOrderResult.filled.t1) : ticket.t1;
    const finalT2 = Number(liveOrderResult?.filled?.t2) > 0 ? Number(liveOrderResult.filled.t2) : ticket.t2;
    const finalRiskPerUnit = Math.max(finalEntry * 0.004, Math.abs(finalEntry - finalSl));

    const rec = {
      paperId: res?.trade?.id ?? null,
      liveOrderId: liveOrderResult?.orderId ?? liveOrderResult?.filled?.orderId ?? null,
      livePositionId: liveOrderResult?.position?.exchangePositionId ?? liveOrderResult?.position?.id ?? null,
      executionMode: liveOrderResult?.ok ? 'LIVE' : 'PAPER',
      traded: true,
      fullControl: Boolean(liveOrderResult?.ok),
      openedInLiveMode: Boolean(wantLiveOrder),
      // v21.25.1: quota provenance — sirf AUTO engine ki entries quota count
      // karti hain; manual board clicks `openedBy:'MANUAL'` rehte hain.
      openedBy: 'AUTO',
      autoTrade: true,
      symbol: sym, market: b.market, execMarket, ccy: isSim ? 'USDC' : (isUsd ? 'USDT' : 'INR'),
      fxUsed: isUsd ? fxRate : null,
      side,
      score: boardRow?.superScore ?? b.score ?? null,
      tier: boardRow?.tier ?? b.tier ?? 'FLIP',
      mode: b.mode || cfg.mode || 'INTRADAY', holdMin: b.holdMin || cfg.holdMin || null,
      entry: finalEntry, stopLoss: finalSl, initialStopLoss: finalSl, trailedStopLoss: finalSl, peakPrice: finalEntry,
      t1: finalT1, t2: finalT2, qty: finalQty, originalQty: finalQty,
      lastExchangeTp: liveOrderResult?.ok ? finalT2 : null,
      // v21.24.0 STOP-INTEGRITY anchor: entry-arming ne yahi SL exchange par
      // arm kiya tha — 3s divergence check isi ke against compare karta hai.
      lastExchangeSl: liveOrderResult?.ok ? finalSl : null,
      slSyncPending: false,
      tpSyncPending: false,
      leverage, walletINR: Math.round(effectiveWalletINR),
      walletDeployPct: w95.walletDeployPct,
      deployedWalletINR: w95.deployedWalletINR,
      deployedWalletUSDT: w95.deployedWalletUSDT,
      buyingPowerINR: w95.buyingPowerINR,
      buyingPowerUSDT: w95.buyingPowerUSDT,
      feeBreakevenPrice: feeBePrice,
      deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
      deepMonitorLabel: 'Stage 0 · UC Flip-Reverse Entry (SL Auto-Trail Ready)',
      // v21.26.0: the reverse trade gets its OWN tick agent lifecycle.
      superAgentState: 'ARMED',
      superAgentIdleReason: null,
      superAgentTickCount: 0,
      superAgentLastTickAt: null,
      atrPct: entryAtrPct, volClass: entryVolClass, momentumState: null, t1ClosePct: entryT1ClosePct,
      trendStatus: `🔁 UC FLIP ${b.side}→${side} · ${side === 'SHORT' ? 'BEARISH' : 'BULLISH'} REVERSE LIVE WATCH`,
      marginINR: +(finalQty * finalEntry * (isUsd ? fxRate : 1) / leverage).toFixed(2),
      marginUsdt: isUsd ? +(finalQty * finalEntry / leverage).toFixed(4) : null,
      riskINR: +(finalQty * finalRiskPerUnit * (isUsd ? fxRate : 1)).toFixed(2),
      riskUsdt: isUsd ? +(finalQty * finalRiskPerUnit).toFixed(4) : null,
      notional: +(finalQty * finalEntry * (isUsd ? fxRate : 1)).toFixed(2),
      notionalUsdt: isUsd ? +(finalQty * finalEntry).toFixed(4) : null,
      flipEntry: true,
      flippedFrom: String(b.side || ''),
      openedAt: now, dayKey: dayKeyFor(execMarket, new Date(now)),
      status: 'OPEN', closeReason: null, closedAt: null, pnl: null,
      drivers: [`UC FLIP-REVERSE: board ${side} PAKKA (${boardRow?.triggerFired ? 'trigger FIRED' : `score ${boardRow?.superScore ?? '—'}`}) — ${b.side} trade ${b.closeReason || 'closed'} hua, reverse entry open`],
    };
    const stx = _loadState();
    stx.book.push(rec);
    stx.dayCount += 1;
    stx.perSymbolLast[sym] = now;
    _persistState();
    // v21.26.0: reverse row's tick agent gets the same board snapshot the
    // forward entry gets — flip detection never waits for a board rebuild.
    if (boardRow) _rememberBoardRow(sym, boardRow, now);
    // Direction lock atomic flip: purana release (paper _closePart ne already
    // kiya hoga — idempotent) + naya opposite-side acquire (LIVE adopted rows
    // ke liye yahi authoritative release hai).
    releaseDirectionLock(sym, { clearCooldown: true });
    acquireDirectionLock({ symbol: sym, side, source: 'uc-flip-reverse', now });
    out.opened.push(rec);
    _logEvent('flip-reverse', `🔁 UC FLIP-REVERSE ${sym}: ${b.side} → ${side} @ ${finalEntry} · SL ${finalSl} · T1 ${finalT1} · T2 ${finalT2} · qty ${finalQty} (${rec.executionMode}) — purana trade '${b.closeReason}' pe band hua (minimal-loss protective)`);
    if (typeof p.notify === 'function') {
      try {
        await p.notify(`🔁 MTF AUTO UC FLIP-REVERSE: ${sym} ${b.side}→${side} @ ${finalEntry} | SL ${finalSl} | T1 ${finalT1} | T2 ${finalT2} | (${rec.executionMode}) — board ${side} PAKKA, purana trade minimal-loss close`);
      } catch { /* non-fatal */ }
    }
    return rec;
  } catch (e) {
    _logEvent('flip-skip', `🔁 UC FLIP-REVERSE ${b?.symbol || '?'}: error — ${e?.message || e}`);
    return null;
  }
}

// ---------------- TICK ----------------
/**
 * One auto-link tick. PURE-ish: sab IO (boards, paper engine, quotes)
 * caller se aata hai — isliye hermetic tests possible hain.
 *
 * @param {object} p
 *  boards      { INDIA?: dualBoardPayload, CRYPTO?: dualBoardPayload }
 *  paper       { openPaperTrade, closePaperTrade, getPaperSummary } — injected
 *  quotes      latest quotes map (closePaperTrade ko chahiye)
 *  killSwitch  global kill switch (true → no-op)
 *  fx          live USDINR (crypto ₹↔USDT sizing ke liye; cfg override)
 *  usdtQuotes  map base→USDT price (crypto coverage gate — no quote, no entry)
 *  now         epoch ms (tests)
 *  notify      optional (text) => void  (telegram)
 */
export async function mtfAutoTick(p = {}) {
  const cfg = loadMtfAutoConfig();
  const now = Number(p.now) || Date.now();
  const isRuntimeLock = p.now == null;
  const out = { at: now, opened: [], closed: [], skipped: [], shadow: [], candidates: 0, considered: 0 };

  if (isRuntimeLock && _mtfAutoTickInFlight) {
    out.skipped.push('mtf-auto tick already in-flight (single-trade session mutex)');
    out.inFlight = true;
    return out;
  }
  if (isRuntimeLock) _mtfAutoTickInFlight = true;

  try {
  // Sync real CoinDCX active positions into _state.book under Full Control if callback provided
  if (typeof p.syncLivePositions === 'function') {
    try { await p.syncLivePositions(); } catch { /* non-fatal */ }
  }
  purgeUntradedBookEntries();

  if (!cfg.enabled && _openLinked().length === 0) { out.skipped.push('auto-link OFF'); return out; }
  if (p.killSwitch) { out.skipped.push('global kill-switch ON'); return out; }

  const paper = p.paper || {};
  const summary = typeof paper.getPaperSummary === 'function' ? paper.getPaperSummary() : { open: [] };
  // v21.22.0 USER SPEC:
  // "ab sirf auto trade button activate hone par Strong trade ko verfied signal lagna chahiye
  //  long or short accurately aur 1 session me ek hi trade aur full amount of wallet ka
  //  ye trade hone ke baad then next trade ek sath 2 trades mat lagao"
  // v21.23.18: session type yahan (openSymbols se PEHLE) compute hota hai —
  // LIVE session me sirf LIVE rows symbol-lock karte hain, PAPER test row
  // same symbol ki real ELITE entry ko block nahi karegi.
  const isLiveSession = cfg.executionMode === 'live'
    || Boolean(cfg.autoSyncSiteLive !== false && (siteLiveForDesk(p, 'CRYPTO') || siteLiveForDesk(p, 'INDIA')));
  const openSymbols = new Set();
  if (isLiveSession) {
    for (const b of _openLinked().filter(isLiveSessionEntry)) {
      if (b.symbol) openSymbols.add(String(b.symbol).toUpperCase());
    }
  } else {
    for (const t of summary?.open || []) openSymbols.add(String(t.symbol || '').toUpperCase());
    for (const b of _openLinked()) {
      if (b.symbol) openSymbols.add(String(b.symbol).toUpperCase());
    }
  }
  // Session-scoped open book: LIVE session me paper test rows gates se bahar.
  const sessionOpen = () => {
    const open = _openLinked();
    return isLiveSession ? open.filter(isLiveSessionEntry) : open;
  };

  // ---------- 0) IMMEDIATE BOOK RECONCILE (SL/T2/manual closes) ----------
  // v21.17.0 DEEP AUDIT: pehle ye check `ageMs < holdMin` ke BAAD tha — agar
  // paper trade 5 min me SL_HIT / T2_HIT se band ho gaya to `b.status` poore
  // 45-120m holdMin tak 'OPEN' rehta tha (notional budget + open slot locked,
  // aur baad me real closeReason/pnl kho kar 'PAPER_ENGINE_CLOSED' lagta tha).
  for (const b of _openLinked()) {
    if (b.paperId == null) continue;
    // If this is a LIVE trade on CoinDCX, never close it just because paper summary doesn't have it
    if (b.executionMode === 'LIVE') continue;
    const live = (summary.open || []).find(t => t.id === b.paperId);
    if (!live) {
      const closedRow = (summary.closedToday || []).find(t => t.id === b.paperId);
      b.status = 'CLOSED';
      b.closeReason = closedRow?.closeReason || 'PAPER_ENGINE_CLOSED';
      b.closedAt = closedRow?.closedAt || now;
      b.pnl = closedRow?.realizedPnl ?? b.pnl ?? null;
    }
  }

  // ---------- 0b) v21.22.0 ACTIVE-TRADE DEEP MONITOR + DYNAMIC TRAILING SL + REVERSAL PROFIT-BOOK SWEEP ----------
  // User spec #3: "Jab Auto Trade Lagta hai tho Vo Trade Symbol or Stock jo bhi hai Usko Deep monitor
  // se analysis rakna alag se aur isse Realtime Monitoring TP1 or Tp2 hit hone tak kyun jab trade
  // lagne par ek ek baar Reversal bhi hota hai condition jab sl Trail aisa kuch karke karke sl hit
  // bachne aur hogye utna profit book kar lena chahiye aisa super intelligence banaoye sab Automated
  // hona chahiye accurately Trend follow karo bearish or bullish realtime."
  if ((cfg.feeAwareReversalExit !== false || cfg.deepMonitorEnabled !== false) && (typeof paper.closePaperTrade === 'function' || typeof p.liveClose === 'function')) {
    let deepMonDecisionCount = 0;
    for (const b of _openLinked()) {
      // v21.26.0 AI SUPER AGENT single-owner guard: the tick agent may already
      // be closing/flipping this exact row. Never let the 15s sweep fire a
      // second close on the same exchange position.
      const saKey = `${String(b.market || '').toUpperCase()}|${String(b.symbol || '').toUpperCase()}`;
      if (_superAgentExitLocks.has(saKey)
        || (Number(b.superAgentExitPendingAt) > 0 && now - Number(b.superAgentExitPendingAt) < 120_000)) {
        out.skipped.push(`${b.symbol}: super-agent exit in flight`);
        continue;
      }
      const mktBoard = p.boards?.[b.market];
      const allBoardRows = [
        ...(mktBoard?.rows || []),
        ...(mktBoard?.metalsRows || []),
        ...(mktBoard?.equitySimRows || []),
      ];
      let boardRow = allBoardRows.find(r => normalizeLinkSymbol(r?.symbol, b.market) === b.symbol);
      // [TOP-6 FLIP-BLINDSPOT] Top-6 rotation ke baad 120s snapshot expire ho
      // jata tha — open trade ka symbol board se bahar reh jaye to opposite
      // signal kabhi evaluate hi nahi hota tha. Open trade ke liye fresh row
      // build karo (60s sweep me max 1 open trade — cost bounded), taaki
      // confirmed flip ka protective exit SILENT dead na ho.
      if (!boardRow && typeof p.buildDualRow === 'function') {
        try {
          const fresh = await p.buildDualRow({
            symbol: String(b.symbol || '').toUpperCase(),
            market: String(b.market || b.execMarket || 'CRYPTO').toUpperCase(),
            modeId: String(b.mode || cfg.mode || 'INTRADAY').toUpperCase(),
            holdMin: b.holdMin || cfg.holdMin || null,
            fx: p.fx ?? cfg.inrPerUsdt,
          });
          if (fresh?.ok) boardRow = fresh;
        } catch { /* non-fatal — snapshot fallback below */ }
      }
      // v21.23.10 [BOARD-ROTATION CACHE]: row milte hi snapshot yaad rakho;
      // row na mile (top-6 rotation) to ≤120s purana snapshot fallback.
      if (boardRow) _rememberBoardRow(b.symbol, boardRow, now);
      const effRow = boardRow || _snapshotRowFor(b.symbol, now);
      const livePaper = (summary.open || []).find(t => t.id === b.paperId);
      const rawQuote = (() => {
        if (b.ccy === 'USDT' && p.usdtQuotes) {
          const u = p.usdtQuotes instanceof Map ? p.usdtQuotes.get(b.symbol) : p.usdtQuotes[b.symbol];
          if (Number(u) > 0) return Number(u);
        }
        const qObj = p.quotes?.[`${b.execMarket || b.market}|${b.symbol}`] ?? (b.ccy === 'USDT' ? null : p.quotes?.[b.symbol]);
        const qPrice = typeof qObj === 'object' ? Number(qObj?.price ?? qObj?.ltp) : Number(qObj);
        if (Number(qPrice) > 0) return qPrice;
        return Number(boardRow?.ltp) > 0 ? Number(boardRow.ltp) : null;
      })();
      if (!(rawQuote > 0)) continue;
      // v21.22.0 CROSS-CURRENCY FIREWALL: Never allow a Spot INR quote (~100x USDT) or stale corrupt tick
      // to evaluate against a USDT entry price (prevents instant false SL/TP2 auto-close).
      if (Number(b.entry) > 0) {
        const priceRatio = rawQuote / Number(b.entry);
        if (priceRatio <= 0.35 || priceRatio >= 2.85) continue;
      }

      const oppSide = oppositeSideOf(b.side);
      const revByRow = Boolean(
        oppSide && effRow && (
          (normalizeSide(effRow.side) === oppSide && (effRow.triggerFired || Number(effRow.superScore) >= 65))
          || (effRow.context?.dir != null && ((b.side === 'LONG' && effRow.context.dir < 0 && effRow.triggerDir < 0) || (b.side === 'SHORT' && effRow.context.dir > 0 && effRow.triggerDir > 0)))
        )
      );

      const effectiveCurSl = (() => {
        const s1 = Number(b.trailedStopLoss ?? b.stopLoss) || 0;
        const s2 = Number(livePaper?.stopLoss) || 0;
        if (s1 > 0 && s2 > 0) return b.side === 'SHORT' ? Math.min(s1, s2) : Math.max(s1, s2);
        return s1 || s2;
      })();

      // Run Deep Monitor (5-stage dynamic SL trail + TP1/TP2 tracker + peak-giveback & trend-flip reversal guard)
      const deepCandles = closedCandlesFor(b.symbol, b.execMarket || b.market, { now });
      const deepEval = evaluateActiveTradeDeepMonitor({
        ...b,
        stopLoss: effectiveCurSl,
        t1Hit: Boolean(livePaper?.t1Hit || b.t1Hit),
        qty: Number(livePaper?.qty ?? b.qty ?? 1),
      }, {
        ltp: rawQuote,
        boardRow: effRow,
        closedCandles: deepCandles,
        reversalConfirmed: revByRow,
        proExitPolicy: cfg.proExitPolicy !== false,
        now,
      });
      stampTp1ConfirmHold(b, deepEval, { now, closedCandles: deepCandles });
      deepMonDecisionCount += 1;

      // Persist updated peakPrice, trailedStopLoss, stage, and live telemetry on the linked book record
      b.ltp = rawQuote;
      b.peakPrice = deepEval.peakPrice;
      b.currentR = deepEval.currentR;
      b.peakR = deepEval.peakR;
      b.t1Hit = deepEval.tp1Hit;
      // v21.29.0 [R8 STICKY TP2]: persist the touch. Deriving it from the
      // current LTP alone loses the fact after a pullback, which would make a
      // runner trail exit impossible on later ticks.
      b.t2Hit = Boolean(deepEval.tp2Hit || b.t2Hit);
      b.deepMonitorStage = deepEval.stageCode;
      b.deepMonitorLabel = deepEval.stageLabel;
      b.trendStatus = deepEval.trendStatus;
      // v21.23.7 VOL-ADAPTIVE STAMPS: live ATR% vol-class + momentum state ko
      // book record pe persist karo — 3s fast loop (jo boardRow nahi dekh
      // sakta) inhi stamps se SAME vol regime trail karta hai.
      b.atrPct = deepEval.atrPct ?? b.atrPct ?? null;
      b.volClass = deepEval.volClass || b.volClass || null;
      b.momentumState = deepEval.momentumState || b.momentumState || null;
      b.t1ClosePct = deepEval.t1ClosePct || b.t1ClosePct || 0.5;
      // TP1 se PEHLE vol-class shift hui ho to paper engine ka TP1 partial %
      // live-update karo (HIGH vol me runner bada — user spec item 6).
      if (deepEval.tp1Hit !== true && livePaper?.id != null
        && Math.abs((livePaper.t1ClosePct ?? 0.5) - deepEval.t1ClosePct) > 1e-6
        && typeof paper.updatePaperTradeT1ClosePct === 'function') {
        try {
          paper.updatePaperTradeT1ClosePct(livePaper.id, deepEval.t1ClosePct);
          livePaper.t1ClosePct = deepEval.t1ClosePct;
        } catch { /* non-fatal */ }
      }
      const isLiveTpRow = b.executionMode === 'LIVE' && !(b.market === 'INDIA' || b.execMarket === 'INDIA');
      // v21.28.0 [F2]: book the LIVE TP1 fraction BEFORE the SL moves to BE.
      // Flag-gated (default off); failure never unbooks or fabricates an exit.
      const liveTp1Partial = await _tryLiveTp1Partial({ b, deepEval, cfg, p, livePaper, paper, now });
      if (liveTp1Partial.booked) {
        _logEvent('live-tp1', `💰 LIVE TP1 PARTIAL ${b.symbol} (${b.side}): ${liveTp1Partial.res?.requestedQty ?? b.t1PartialQty} qty reduced @ ${rawQuote} (${Math.round((deepEval.t1ClosePct || 0.5) * 100)}%) [${deepEval.stageLabel}]`);
      } else if (liveTp1Partial.attempted && liveTp1Partial.error) {
        _logEvent('live-tp1-error', `⚠️ LIVE TP1 PARTIAL ${b.symbol} (${b.side}) not booked — ${liveTp1Partial.error}`);
      }
      if (deepEval.slTrailed && deepEval.trailedStopLoss > 0) {
        const prevSl = b.trailedStopLoss ?? b.stopLoss;
        b.trailedStopLoss = deepEval.trailedStopLoss;
        b.stopLoss = deepEval.trailedStopLoss;
        if (livePaper) livePaper.stopLoss = deepEval.trailedStopLoss;
        if (isLiveTpRow && typeof p.liveUpdateSl === 'function') {
          const lastSyncSl = Number(b.lastExchangeSl) || 0;
          const slDeltaPct = lastSyncSl > 0 ? Math.abs(deepEval.trailedStopLoss - lastSyncSl) / lastSyncSl : 1;
          const slRetryAt = Number(b.slNextRetryAt) || 0;
          if (slRetryAt > now) {
            // v21.28.0 [F5 RETRY SPACING]: last push was accepted but the
            // read-back stayed unverified. Do not stack another create_tpsl
            // inside the cooldown — book SL already carries the new level.
            b.slSyncPending = true;
          } else if (slDeltaPct >= 0.0005) {
            try {
              const slRes = await p.liveUpdateSl({ ...b, stopLoss: deepEval.trailedStopLoss, takeProfit: b.t2 });
              if (slRes?.ok) {
                b.lastExchangeSl = deepEval.trailedStopLoss;
                // This call carried takeProfit too — the target is now armed.
                if (Number(b.t2) > 0) b.lastExchangeTp = b.t2;
                b.tpSyncPending = false;
                b.slSyncPending = false;
                b.slNextRetryAt = 0;
                b.slLastSyncError = null;
              } else {
                // v21.24.0 STOP-INTEGRITY: exchange ne SL accept nahi kiya —
                // retry flag ON rakho. Warna next trail transition na aane par
                // book tighter SL CLAIM karta rahega jabki exchange purane
                // (wider) SL par khada hoga — exactly XRP divergence.
                b.slSyncPending = true;
                b.slNextRetryAt = now + (Number(slRes?.retryAfterMs) > 0 ? Number(slRes.retryAfterMs) : 60_000);
                b.slLastSyncError = String(slRes?.error || slRes?.readBackError || 'exchange SL unverified').slice(0, 180);
              }
            } catch (e) {
              b.slSyncPending = true;
              b.slNextRetryAt = now + 60_000;
              b.slLastSyncError = String(e?.message || e).slice(0, 180);
            }
          }
        }
        _logEvent('sl-trail', `🛡️ DEEP MONITOR SL TRAILED ${b.symbol} (${b.side}): SL ${prevSl} → ${deepEval.trailedStopLoss} [${deepEval.stageLabel}] @ LTP ${rawQuote} (${deepEval.currentR >= 0 ? '+' : ''}${deepEval.currentR}R)`);
      } else if (b.slSyncPending && isLiveTpRow && typeof p.liveUpdateSl === 'function') {
        // v21.24.0 STOP-INTEGRITY RETRY: pichhla SL sync fail hua tha (ya
        // process restart se pehle land nahi hua) — exchange confirm hone tak
        // retry, silently stale stop kabhi nahi. v21.28.0: read-back-unverified
        // pushes get 60s spacing so create_tpsl never stacks.
        if (!(Number(b.slNextRetryAt) > now)) {
          try {
            const slRes = await p.liveUpdateSl({
              ...b,
              stopLoss: b.trailedStopLoss ?? b.stopLoss,
              takeProfit: b.t2,
            });
            if (slRes?.ok) {
              const syncedSl = b.trailedStopLoss ?? b.stopLoss;
              if (Number(syncedSl) > 0) b.lastExchangeSl = syncedSl;
              b.slSyncPending = false;
              b.slNextRetryAt = 0;
              b.slLastSyncError = null;
              _logEvent('sl-sync', `🛡️ SL SYNC RECOVERED ${b.symbol} (${b.side}): exchange SL re-armed at ${syncedSl}`);
            } else {
              b.slNextRetryAt = now + (Number(slRes?.retryAfterMs) > 0 ? Number(slRes.retryAfterMs) : 60_000);
              b.slLastSyncError = String(slRes?.error || slRes?.readBackError || 'exchange SL unverified').slice(0, 180);
            }
          } catch (e) {
            b.slNextRetryAt = now + 60_000;
            b.slLastSyncError = String(e?.message || e).slice(0, 180);
          }
        }
      }

      // v21.24.0 SMART TRAIL v2 telemetry + ROLLING TP2 (enforce only moves the target).
      b.smartTrail = deepEval.smartTrail || null;
      if (deepEval.t2Extended && Number(deepEval.t2) > 0) {
        const prevT2 = b.t2;
        b.t2 = deepEval.t2;
        b.t2Extensions = deepEval.t2Extensions;
        b.lastTpExtendAt = now;
        if (isLiveTpRow) b.tpSyncPending = true;
        if (livePaper?.id != null && typeof paper.updatePaperTradeTarget2 === 'function') {
          try { paper.updatePaperTradeTarget2(livePaper.id, deepEval.t2); } catch { /* non-fatal */ }
        }
        if (isLiveTpRow && typeof p.liveUpdateSl === 'function') {
          try {
            const tpRes = await p.liveUpdateSl({ ...b, stopLoss: b.trailedStopLoss ?? b.stopLoss, takeProfit: b.t2 });
            if (tpRes?.ok) {
              b.lastExchangeTp = b.t2;
              b.tpSyncPending = false;
              // The same call also re-armed the SL — record it so the next tick
              // does not issue a redundant SL sync.
              if (Number(b.trailedStopLoss ?? b.stopLoss) > 0) b.lastExchangeSl = b.trailedStopLoss ?? b.stopLoss;
            }
          } catch { /* non-fatal — pending retry below / 3s loop re-pushes TP */ }
        }
        _logEvent('tp-extend', `🎯 SMART TRAIL v2 ROLLING TP2 ${b.symbol} (${b.side}): T2 ${prevT2} → ${b.t2} [#${b.t2Extensions}] @ LTP ${rawQuote} (${deepEval.currentR >= 0 ? '+' : ''}${deepEval.currentR}R · SL ${b.trailedStopLoss ?? b.stopLoss} locked)`);
      } else if (b.tpSyncPending && isLiveTpRow && typeof p.liveUpdateSl === 'function') {
        // A previous extension failed (or the 3s loop was unavailable). Retry
        // until the exchange confirms — never leave a stale native TP armed.
        try {
          const tpRes = await p.liveUpdateSl({ ...b, stopLoss: b.trailedStopLoss ?? b.stopLoss, takeProfit: b.t2 });
          if (tpRes?.ok) {
            b.lastExchangeTp = b.t2;
            b.tpSyncPending = false;
            if (Number(b.trailedStopLoss ?? b.stopLoss) > 0) b.lastExchangeSl = b.trailedStopLoss ?? b.stopLoss;
            _logEvent('tp-sync', `🎯 SMART TRAIL v2 TP SYNC RECOVERED ${b.symbol} (${b.side}): exchange TP re-armed at ${b.t2} [#${b.t2Extensions || 0}]`);
          }
        } catch { /* non-fatal — next tick retries */ }
      }

      const revEval = revByRow ? evaluateFeeAwareReversalExit({
        side: b.side,
        entry: b.entry,
        ltp: rawQuote,
        stopLoss: livePaper?.stopLoss ?? b.stopLoss,
        target1: b.t1,
        target2: b.t2,
        tp1Hit: Boolean(livePaper?.t1Hit || b.t1Hit),
        bookedPnl: Number(livePaper?.realizedPnl ?? b.bookedPnl ?? 0),
        qty: Number(livePaper?.qty ?? b.qty ?? 1),
        market: b.execMarket || b.market,
        reversalConfirmed: true,
        reversalReasons: [`board flipped ${oppSide} (${effRow?.superScore ?? '—'}${effRow?.__snapshot ? ' · snap' : ''})`],
      }) : null;

      // v21.22.0 CONCRETE PREMATURE-CLOSE FIREWALL ON LIVE POSITIONS:
      // 1. On LIVE CoinDCX positions, native exchange TP/SL orders guard initial Stop-Loss.
      //    Never software-close a LIVE position in the first 90s of opening (unless TP2 hit),
      //    and never software-close a LIVE position on a minor negative wobble (`!feeCovered` and `currentR > -1.02`).
      // 2. For reversal profit-booking on LIVE positions, require net favorable price move >= 0.20%
      //    (>= +2.0% ROE at 10x) so round-trip CoinDCX taker fees + GST (~₹50) are 100% covered!
      const isLivePos = b.executionMode === 'LIVE';
      const tradeAgeMs = Math.max(0, now - (Number(b.openedAt) || now));
      const isRuntimeClock = p.now == null;
      const movePctFromEntry = Number(b.entry) > 0 ? Math.abs(rawQuote - Number(b.entry)) / Number(b.entry) : 0;
      const liveFeeSafeProfitMove = !isLivePos || movePctFromEntry >= 0.0020 || deepEval.tp2Hit;
      const hasProgressedIntoProfitStage = deepEval.peakR >= 0.35 || (b.deepMonitorStage && b.deepMonitorStage !== 'STAGE_0_INITIAL_GUARD');
      const allowDefensiveSlClose = !isLivePos
        ? deepEval.shouldExitDefensiveSl
        : (deepEval.shouldExitDefensiveSl && deepEval.currentR <= -1.02 && (!isRuntimeClock || tradeAgeMs >= 90_000));
      const allowLiveExitAfterGrace = !isLivePos
        || !isRuntimeClock
        || tradeAgeMs >= 90_000
        || (deepEval.feeCovered && liveFeeSafeProfitMove && hasProgressedIntoProfitStage)
        || (deepEval.tp2Hit && movePctFromEntry >= 0.0040);

      const shouldExitByReversalOrTrail = Boolean(
        allowLiveExitAfterGrace && (
          ((revEval?.shouldExit && revEval?.feeCovered) && liveFeeSafeProfitMove)
          || (deepEval.shouldBookProfitNow && liveFeeSafeProfitMove)
          || allowDefensiveSlClose
        )
      );

      // v21.23.8 UC FLIP-AND-REVERSE (user: "UC ne LONG se SHORT pakka hone pe
      // update karta hai status tab minimal loss ke sath vo long trade close karke
      // IMMEDIATELY wahi trade short me lagna chahiye"): revByRow = UC-status ka
      // PAKKA flip (board side === oppSide && triggerFired/score>=65) — wahi
      // v21.23.6 TRUE-flip definition. Ab loss/fee-not-covered territory me
      // fee-guard HOLD nahi — MINIMAL-LOSS protective exit + turant reverse entry.
      // "Thoda pullback" (board same-side) kabhi flip nahi hota — pullback trades
      // SL-trail/vol-adaptive profile ke saath SAFALTA se chalte hain (TP1/TP2 tak).
      const ucFlipConfirmed = revByRow;
      const ucFlipAgeOk = !isRuntimeClock || tradeAgeMs >= (isLivePos ? UC_FLIP_MIN_AGE_MS_LIVE : UC_FLIP_MIN_AGE_MS_PAPER);
      const ucFlipProtectiveExit = Boolean(
        ucFlipConfirmed
        && cfg.ucFlipReverse !== false
        && ucFlipAgeOk
        && !deepEval.tp2Hit
        && !shouldExitByReversalOrTrail
      );
      const shouldExitNow = shouldExitByReversalOrTrail || ucFlipProtectiveExit;

      if (shouldExitNow) {
        // v21.23.10 [LIVE-CLOSE-VERDICT]: exchange close ka verdict CHECK hota
        // hai. closeCoinDcxActivePosition FAILURE par {ok:false} deta hai
        // (throw kabhi nahi) — pehle wo verdict ignore hota tha + `|| LIVE`
        // clause book row ko CLOSED book kar deta tha jabki exchange par
        // leveraged position ABHI BHI KHULA tha (user "trade band ho gaya"
        // samajh baithta, sync usi ko naye row me re-adopt karta — fabricated
        // close record + churn). Ab {ok:false} = row OPEN + syncError stamp +
        // agle tick retry. undefined/legacy stub contract permissive rehta hai.
        let liveCloseFailed = null;
        let liveClosePnl = null;
        if (b.executionMode === 'LIVE' && typeof p.liveClose === 'function') {
          try {
            const lc = await p.liveClose(b);
            const lcPnl = Number(lc?.realizedPnl ?? lc?.pnl);
            if (lc?.ok !== false && Number.isFinite(lcPnl)) liveClosePnl = lcPnl;
            // v21.23.12 [NULL-VERDICT HONESTY]: routes ka wrapper `.catch(() => null)`
            // hai — closeCoinDcxActivePosition kabhi throw nahi karta, par
            // AGAR wrapper me kuch bhi throw hua to null aata tha aur null
            // falsy hone par row CLOSED ho jaata tha jabki exchange position
            // khuli ho sakti thi (fabricated-CLOSE trap ek refactor door tha).
            // undefined = documented legacy permissive stub contract (S3 pin)
            // — PERMISSIVE rehta hai; null = wrapper catch → FAIL.
            if (lc === null) liveCloseFailed = 'liveClose wrapper threw / returned null — treated as FAILED (exchange state unknown)';
            else if (lc && lc.ok === false) liveCloseFailed = lc.error || lc.reason || 'exchange close failed';
          } catch { /* non-fatal — legacy permissive close, sync re-adopts */ }
        }
        if (liveCloseFailed) {
          b.syncError = String(liveCloseFailed).slice(0, 200);
          _logEvent('live-close-failed', `⚠️ LIVE close FAILED ${b.symbol} — book row OPEN raha (exchange par position abhi bhi hai): ${b.syncError} — next tick retry`);
          continue;
        }
        const closeReason = ucFlipProtectiveExit
          ? 'UC_FLIP_MINIMAL_LOSS_EXIT'
          : (revEval?.shouldExit ? revEval.stage : (deepEval.exitReason || 'DEEP_MONITOR_PROFIT_BOOK'));
        const r = paper.closePaperTrade(b.paperId, {
          ...(p.quotes || {}),
          [b.symbol]: { price: rawQuote },
          [`${b.execMarket || b.market}|${b.symbol}`]: { price: rawQuote },
        }, closeReason);
        // v21.23.12 [PAPER-MIRROR VOID]: LIVE row CLOSED par mirror close FAIL
        // (r not ok) hone par paper row OPEN reh jaati thi → wahi trade dobara
        // paper-side SL/T2 se book hota (double-booked track-record poison —
        // v21.23.10 voidPaperTrade cure ka yahi missing twin). Mirror ab VOID.
        if (b.executionMode === 'LIVE' && b.paperId && r && r.ok === false && typeof paper.voidPaperTrade === 'function') {
          try {
            paper.voidPaperTrade(b.paperId);
            _logEvent('paper-mirror-voided', `⚠️ LIVE close ${b.symbol} — paper-mirror close failed (${String(r.error || r.reason || '').slice(0, 80)}), mirror VOID kiya gaya (double-book cure)`);
          } catch { /* best-effort */ }
        }
        if (r?.ok || b.executionMode === 'LIVE') {
          const ccyPrefix = (b.ccy === 'USDT' || b.ccy === 'USDC') ? '$' : '?';
          b.status = 'CLOSED';
          b.closeReason = closeReason;
          b.closedAt = now;
          const estimatedPnl = r?.trade?.realizedPnl ?? revEval?.netTotalPnl ?? deepEval.grossPnl;
          if (b.executionMode === 'LIVE' && liveClosePnl != null) {
            b.pnl = liveClosePnl;
            b.pnlVerified = true;
            b.pnlSource = 'EXCHANGE';
          } else if (b.executionMode === 'LIVE') {
            // Exchange close response carried no realized P&L. Keep the honest
            // estimate but never present it as verified exchange truth.
            b.pnl = estimatedPnl;
            b.pnlVerified = false;
            b.pnlSource = 'ESTIMATE';
          } else {
            b.pnl = estimatedPnl;
            b.pnlVerified = true;
            b.pnlSource = 'PAPER';
          }
          out.closed.push({
            symbol: b.symbol,
            market: b.market,
            reason: b.closeReason,
            pnl: b.pnl,
            pnlVerified: b.pnlVerified,
            feeCovered: Boolean(revEval?.feeCovered || deepEval.feeCovered),
            feeBePrice: revEval?.feeBePrice ?? deepEval.feeBreakevenPrice,
            trailedStopLoss: b.trailedStopLoss ?? b.stopLoss,
          });
          _logEvent(ucFlipProtectiveExit ? 'flip-exit' : 'reversal-exit', ucFlipProtectiveExit
            ? `🔁 UC FLIP MINIMAL-LOSS EXIT ${b.symbol} ${b.side} @ ${rawQuote} — board ${oppSide} PAKKA hone par full SL (-1R) se pehle bacha liya (R ${deepEval.currentR})`
            : `REVERSAL FEE-SAFE EXIT ${b.symbol} @ ${rawQuote} (reason ${b.closeReason} · fee floor ${deepEval.feeBreakevenPrice}) — pnl ${ccyPrefix}${b.pnl ?? '—'}${b.pnlVerified === false ? ' (ESTIMATE - exchange P&L not reported)' : ''}`);
          if (typeof p.notify === 'function') {
            try {
              const exitMsg = ucFlipProtectiveExit
                ? `🔁 MTF AUTO UC FLIP: ${b.symbol} ${b.side} closed @ ${rawQuote} MINIMAL LOSS (${deepEval.currentR}R) — board ${oppSide} PAKKA, reverse entry opening...`
                : `🛡️ MTF AUTO Deep Monitor Exit: ${b.symbol} ${b.side} closed @ ${rawQuote} (${b.closeReason}) — net pnl ${ccyPrefix}${b.pnl ?? '—'}${b.pnlVerified === false ? ' (estimate)' : ''}`;
              await p.notify(exitMsg);
            } catch { /* non-fatal */ }
          }
          // v21.23.8: UC-confirmed flip ke baad IMMEDIATE same-symbol reverse
          // entry (minimal-loss close + reverse = ek atomic smart move). TP2
          // complete hua ho to flip NAHI — "TP1/TP2 tak full trade complete"
          // ho chuka hai, naya signal normal entry path se aayega.
          if (ucFlipConfirmed && cfg.ucFlipReverse !== false && !deepEval.tp2Hit) {
            await _tryOpenUcFlipReverse({
              b, boardRow: effRow, ltp: rawQuote, p, cfg, out, now,
            });
          }
        }
      } else if (revByRow && revEval && !revEval.feeCovered && !(cfg.ucFlipReverse !== false && ucFlipAgeOk)) {
        _logEvent('reversal-hold', `REVERSAL FEE-GUARD HOLD ${b.symbol}: ltp ${rawQuote} has not cleared fee-breakeven ${revEval.feeBePrice} — holding to prevent fee loss (SL tightened to ${b.trailedStopLoss ?? b.stopLoss})`);
      }
    }
    if (deepMonDecisionCount > 0) {
      _stampDeepMonitorHeartbeat({ source: 'auto-tick-15s', now, count: deepMonDecisionCount });
    }
    _persistState();
  }

  // ---------- 1) TIME-STOP sweep on LINKED trades ----------
  if (cfg.timeStopEnabled && typeof paper.closePaperTrade === 'function') {
    for (const b of _openLinked()) {
      // v21.22.0: Never time-stop a LIVE CoinDCX position by timer (let Deep Monitor TP1/TP2/Trail control it)
      if (b.executionMode === 'LIVE') continue;
      if (!b.holdMin || !b.openedAt) continue;
      const ageMs = now - b.openedAt;
      if (ageMs < b.holdMin * 60_000 + TIME_STOP_GRACE_MS) continue;
      const timeStopReason = `TIME_STOP ${b.holdMin}m`;
      const r = paper.closePaperTrade(b.paperId, p.quotes, timeStopReason);
      if (r?.ok) {
        const ccyPrefix = b.ccy === 'USDT' ? '$' : '₹';
        b.status = 'CLOSED';
        b.closeReason = timeStopReason;
        b.closedAt = now;
        b.pnl = r.trade?.realizedPnl ?? null;
        out.closed.push({ symbol: b.symbol, market: b.market, reason: b.closeReason, pnl: b.pnl });
        _logEvent('time-exit', `TIME-STOP ${b.symbol} after ${Math.round(ageMs / 60000)}m (window ${b.holdMin}m) — pnl ${ccyPrefix}${b.pnl ?? '—'}`);
        if (typeof p.notify === 'function') { try { await p.notify(`⏱ MTF AUTO time-stop: ${b.symbol} ${b.side} closed at ${b.holdMin}m window — pnl ${ccyPrefix}${b.pnl ?? '—'}`); } catch { /* non-fatal */ } }
      }
    }
    _persistState();
  }

  // ---------- 1b) v21.24.0 PHASE 0 LIVE ENTRY PAUSE ----------
  // Existing OPEN positions upar 0b/1 me already manage ho chuke (deep monitor,
  // trailing SL, exchange SL sync, time-stop). Pause sirf NAYE entries rokta
  // hai — executionMode ko paper karne se live position ka management bhi
  // badal jata, isliye alag explicit switch.
  if (cfg.liveEntryPaused === true && isLiveSession) {
    out.skipped.push('LIVE entries paused (Phase 0 safety) — existing positions still deep-monitored + SL-managed');
    const stp = _loadState();
    stp.lastTick = { at: now, opened: out.opened.length, closed: out.closed.length, skipped: out.skipped.slice(0, 4) };
    _persistState();
    return out;
  }

  // ---------- 2) NEW ENTRIES per desk (STRICT 1-TRADE-PER-SESSION FULL-WALLET LOCK) ----------
  if (!cfg.enabled) {
    out.skipped.push('auto-link OFF');
    const stf = _loadState();
    stf.lastTick = { at: now, opened: out.opened.length, closed: out.closed.length, skipped: out.skipped.slice(0, 4) };
    _persistState();
    return out;
  }

  // ---------- 2a) v21.29.0 [R2 LIVE ARM RISK GATE] ----------
  // New LIVE entries require the four money caps (per-trade %, leverage,
  // wallet deploy %, daily loss %). A config that intentionally runs without
  // them must carry the persisted typed acknowledgement. This gate is applied
  // PER ROW at the actual live-order decision below — paper/SIM rows in a
  // mixed session (e.g. India live + crypto paper, or EQUITY SIM) keep
  // working. Existing LIVE positions above were already managed.
  const liveArm = isLiveSession ? evaluateLiveArmRisk(cfg) : null;
  const lossPause = isLiveSession
    ? evaluateConsecutiveLossPause({
      closedRows: _loadState().book,
      liveOnly: true,
      pauseAfter: cfg.consecutiveLossPauseAfter,
      pauseMin: cfg.consecutiveLossPauseMin,
      now,
    })
    : null;

  // v21.22.0 USER SPEC:
  // "ab sirf auto trade button activate hone par Strong trade ko verfied signal lagna chahiye
  //  long or short accurately aur 1 session me ek hi trade aur full amount of wallet ka
  //  ye trade hone ke baad then next trade ek sath 2 trades mat lagao"
  // (isLiveSession upar compute hota hai — openSymbols ko bhi scope karta hai.)
  const currentOpenInSession = sessionOpen();
  if (isLiveSession && currentOpenInSession.length >= 1) {
    const act = currentOpenInSession[0];
    out.skipped.push(`1 session = 1 trade lock: ${act?.symbol || 'trade'} (${act?.side || ''}) already active — next trade only after current trade finishes`);
    const stf = _loadState();
    stf.lastTick = { at: now, opened: out.opened.length, closed: out.closed.length, skipped: out.skipped.slice(0, 4) };
    _persistState();
    return out;
  }

  // v21.23.6 USER SPEC: successful close ke BAAD LIVE re-entry pe 5-minute
  // PROFIT-COOLDOWN — "jab trade successful close hone LIVE Auto trade 5 min
  // ka cooldown lagake then phir ELITE top trade verify karke trade lagana
  // chahiye". Cooldown ke BAAD elite-gate (neeche) hi entry allow karta hai.
  const postSuccessCooldownMs = Math.max(0, Number(cfg.postSuccessCooldownMin ?? 5)) * 60_000;
  if (isLiveSession && postSuccessCooldownMs > 0) {
    const lastSuccessAt = _lastProfitCloseAt(isLiveSession);
    if (lastSuccessAt && now - lastSuccessAt < postSuccessCooldownMs) {
      const leftMin = +((postSuccessCooldownMs - (now - lastSuccessAt)) / 60_000).toFixed(1);
      out.skipped.push(`post-success cooldown: ${leftMin}m left (last profitable close ${Math.round((now - lastSuccessAt) / 60_000)}m ago — re-entry ELITE-verified only after cooldown)`);
      const stf = _loadState();
      stf.lastTick = { at: now, opened: out.opened.length, closed: out.closed.length, skipped: out.skipped.slice(0, 4) };
      _persistState();
      return out;
    }
  }

  for (const market of ['INDIA', 'CRYPTO']) {
    if (out.opened.length >= 1) break;
    if (isLiveSession && sessionOpen().length >= 1) break;
    const deskOn = market === 'INDIA' ? cfg.desks.india : cfg.desks.crypto;
    if (!deskOn) { out.skipped.push(`${market} desk off`); continue; }
    // market gate
    if (market === 'INDIA' && !(isNseMarketOpen() && freshEntriesAllowedFor('INDIA'))) { out.skipped.push('INDIA: NSE closed / past 15:00 cutoff'); continue; }
    const board = p.boards?.[market];
    if (!board?.ok || !Array.isArray(board.rows)) { out.skipped.push(`${market}: board unavailable`); continue; }

    _rollDayIfNeeded();
    const stDay = _loadState(); // day counters (rolled above)
    // v21.23.18: LIVE session me day quota sirf LIVE rows ka — PAPER test
    // trades real live quota ko consume nahi karte.
    // v21.25.1: PAPER session me bhi sirf AUTO-opened rows quota count karti
    // hain — manual 🧪 PAPER test clicks auto engine ko din bhar block nahi
    // kar sakte.
    const dayRows = stDay.book.filter(b => isSessionQuotaEntry(b, isLiveSession));
    // budget / quota gates (market-wise counters use the SAME day bucket)
    const deskDay = dayKeyFor(market === 'INDIA' ? 'INDIA' : 'CRYPTO');
    const dayCountForDesk = dayRows.filter(b => b.market === market && b.dayKey === deskDay).length;
    // The global counter must respect each desk's own session boundary:
    // INDIA rolls at IST midnight, CRYPTO/FUTURES at UTC midnight. A single
    // st.dayCount rolled only at IST midnight let crypto reset its desk bucket
    // at UTC midnight while the global cap stayed stuck for another 5.5h (and
    // vice versa). Count rows against their own market's current day instead.
    const dayCountAllDesks = dayRows.filter(b => b.dayKey === dayKeyFor(b.market, new Date(now))).length;
    const openForDesk = sessionOpen().filter(b => b.market === market).length;
    const isLiveExecActive = isLiveSession;
    const effectiveMaxOpenPositions = isLiveExecActive ? 1 : cfg.maxOpenPositions;
    const effectiveMaxTradesPerDay = Number(cfg.maxTradesPerDay) || 0;
    const quotaUnlimited = !(effectiveMaxTradesPerDay > 0);
    if (!quotaUnlimited && dayCountAllDesks >= effectiveMaxTradesPerDay) { out.skipped.push(`${market}: daily quota ${dayCountAllDesks}/${effectiveMaxTradesPerDay} done`); continue; }
    if (!quotaUnlimited && dayCountForDesk >= effectiveMaxTradesPerDay) { out.skipped.push(`${market}: desk quota done`); continue; }
    if (openForDesk >= effectiveMaxOpenPositions || sessionOpen().length >= effectiveMaxOpenPositions) { out.skipped.push(`${market}: max open positions (${openForDesk}/${effectiveMaxOpenPositions})`); continue; }
    if (_openNotionalINR(isLiveSession) >= cfg.maxPositionsINR) { out.skipped.push(`${market}: notional budget full (₹${Math.round(_openNotionalINR(isLiveSession))}/${cfg.maxPositionsINR})`); continue; }
    // v21.24.0 PHASE 0 daily-loss circuit breaker — desk ke apne day key par,
    // realized CLOSED pnl se. Cap hit → us desk ke naye entries band (existing
    // positions ka management upar already chal chuka).
    const dayWalletINR = Number(p.walletEquityINR) > 0 ? Number(p.walletEquityINR) : Number(cfg.walletAmountINR) || 10000;
    const dayCaps = computeEffectiveRiskCaps(cfg, dayWalletINR);
    if (dayCaps.dailyLossCapINR != null) {
      const realizedToday = _dailyRealizedPnlForMarket(market, isLiveSession, now);
      if (realizedToday <= -dayCaps.dailyLossCapINR) {
        out.skipped.push(`${market}: daily loss stop hit (${realizedToday.toFixed(2)} <= -${dayCaps.dailyLossCapINR}) — no new entries today`);
        continue;
      }
    }

    // v21.23.8 USER SPEC: "sirf FUTURES USDT & EQUITY SIM aur GOLD & SILVER
    // me hi trade lagna chahiye" — crypto-desk auto-pool ab teen ALLOWED
    // domain ka hai: FUTURES USDT perps (board.rows) + GOLD/SILVER XAU/XAG
    // perps (metalsRows) + EQUITY SIM US-desk rows (equitySimRows → paper
    // GLOBALFUTURES/USDC sim entries — CoinDCX par listed nahi, SIM only).
    // CoinDCX SPOT (SYM-INR) is pool me KABHI tha hi nahi (execMarket hamesha
    // FUTURES/GLOBALFUTURES/INDIA), aur v21.23.8 ne executeSignal ko SPOT
    // FULL-STOP gate diya hai — spot ka koi auto path bachta hi nahi.
    const poolRows = market === 'CRYPTO'
      ? [
          ...(board.rows || []),
          ...(Array.isArray(board.metalsRows)
            ? board.metalsRows.filter(m => !(board.rows || []).some(r => r?.symbol === m?.symbol))
            : []),
          ...(Array.isArray(board.equitySimRows)
            ? board.equitySimRows.filter(m =>
                !(board.rows || []).some(r => r?.symbol === m?.symbol)
                && !(Array.isArray(board.metalsRows) ? board.metalsRows : []).some(r => r?.symbol === m?.symbol))
            : []),
        ]
      : board.rows;
    // When 0 positions are currently open in Live Auto mode, bypass stale symbol cooldown so user's Live Auto click always fires
    const effectiveLastEntryAt = (isLiveExecActive && sessionOpen().length === 0) ? {} : stDay.perSymbolLast;
    // v21.23.10 [THRASH-CURE]: failed-LIVE-attempt per-symbol ESCALATING backoff
    // (5m→10m→20m→…cap 4h) — success-cooldown bypass isse affect NAHI hota
    // (user ka "Live Auto click always fires" intent intact), par ek REJECTED
    // attempt (creds/arming/exchange error) ab symbol ko cooldown me daalta
    // hai — pehle teen loops same reject har ~10s dohrate the.
    const failMap = stDay.failedLiveAttempts || {};
    const picks = dualAutoCandidates(poolRows, cfg, { openSymbols, lastEntryAt: effectiveLastEntryAt, now }).map(r => {
      const f = failMap[String(r?.symbol || '').toUpperCase()];
      if (!f) return r;
      const leftMs = _liveFailBackoffMs(f.count) - (now - Number(f.at || 0));
      if (leftMs > 0) return { ...r, autoPickBlockers: [...r.autoPickBlockers, `live-attempt backoff (${Math.ceil(leftMs / 60_000)}m left · #${f.count})`] };
      return r;
    });
    out.considered += picks.length;
    let eligible = picks.filter(r =>
      r.autoPickBlockers.length === 0
      && (r.side === 'LONG' || r.side === 'SHORT')
      && r.ensembleSignalAvailable !== false
      && r.directionVerified !== false
      // v21.26.0 [DIRECTION-PARITY]: board-vs-MTF side conflict primary lane
      // me bhi hard-block (fallback path me pehle se tha; ye gap tha).
      && !r.boardSideConflict
      && !r.reversalRisk
      && !r.trigger?.reversalRisk
      && !r.trigger?.opposingFlow
      && !r.context?.exhausted
      && (r.ollamaTrio == null || r.ollamaTrio.approvedCount >= 2)
      && !r.trapVeto
      && !r.zoneWallVeto
      && !r.counterTrend
    );
    // In Live Auto mode, v21.23.6: ELITE/STRONG (or superScore >= 80) verified
    // signals are now REQUIRED — not just prioritized. "then phir auto trade
    // signals me elite top trade verify karke trade lagna chahiye" — weaker
    // eligible rows ka LIVE entry path khatam (the 1051 fallback bhi tier
    // ELITE/STRONG/>=80 enforce karta hai, so no weaker path survives).
    if (isLiveExecActive) {
      const strongVerified = eligible.filter(r =>
        r.tier === 'ELITE' || r.tier === 'STRONG' || Number(r.superScore) >= 80
      );
      eligible = strongVerified;
      eligible.sort((a, b) =>
        ((b.directionVerified === true ? 1 : 0) - (a.directionVerified === true ? 1 : 0))
        || (((b.ollamaTrio?.approvedCount ?? 3) >= 3 ? 1 : 0) - ((a.ollamaTrio?.approvedCount ?? 3) >= 3 ? 1 : 0))
        || (((b.earlyIgnition || b.trigger?.pullbackReclaim) ? 1 : 0) - ((a.earlyIgnition || a.trigger?.pullbackReclaim) ? 1 : 0))
        || ((Number(b.superScore) || 0) - (Number(a.superScore) || 0))
      );
    }
    // v21.22.0 ANTI-LATE-ENTRY FIX: Never bypass `triggerFired` or `postPeakTrap`!
    // Even in Live Auto mode when 0 trades are open, require `r.triggerFired === true`,
    // `!r.trigger?.overextended`, and `!r.trigger?.postPeakTrap` so Auto-Trade NEVER enters
    // after the trend wave has already completed ("trend moment ke baad trade na lage").
    if (eligible.length === 0 && isLiveExecActive && sessionOpen().length === 0) {
      eligible = picks.filter(r =>
        (r.side === 'LONG' || r.side === 'SHORT')
        && r.ensembleSignalAvailable !== false
        && r.directionVerified === true
        && r.triggerFired === true
        // v21.23.10 [THRASH-CURE HOLE #2]: ye fallback autoPickBlockers BYPASS
        // karta tha — dualAutoCandidates ke cooldown/already-open blockers aur
        // (naya) live-attempt backoff dono is second-chance path se sidhe
        // skip ho jaate the → backoff ke baad bhi har 10s re-attempt is
        // fallback se hota tha. "MUST NOT bypass blockers" doctrine ab yahan
        // bhi apply (P0-3 note ka completion).
        && (r.autoPickBlockers || []).length === 0
        // P0-3 FIX: fallback MUST NOT bypass quality blockers (cost≥0.5R, netRR<0, grade C,
        // winProb NO-EDGE, direction conflict, SVA FLIP, AI council hard disagree).
        && (r.autoBlockers || []).length === 0
        && !r.boardSideConflict
        && (r.tier === 'ELITE' || r.tier === 'STRONG' || Number(r.superScore) >= 80)
        && !r.reversalRisk
        && !r.trigger?.reversalRisk
        && !r.trigger?.postPeakTrap
        && !r.trigger?.overextended
        && !r.trigger?.opposingFlow
        && !r.context?.exhausted
        && (r.ollamaTrio == null || r.ollamaTrio.approvedCount >= 2)
        && !r.trapVeto
        && !r.zoneWallVeto
        && !r.counterTrend
        && r.dualAligned !== false
        && (r.tfFit === 'GOOD' || r.tfFit === 'OK' || r.tfFit == null)
        && Number(r.superScore) >= Math.max(75, Number(cfg.minScore) || 75)
        && Number(r.plan?.entry) > 0
        && Number(r.plan?.stopLoss) > 0
      ).sort((a, b) => (Number(b.superScore) || 0) - (Number(a.superScore) || 0)).slice(0, 1);
    }
    out.candidates += eligible.length;

    // v21.23.18 [WHY-NO-TRADE VISIBILITY]: jab koi row eligible na ho to
    // generic silence ki jagah exact near-miss reasons lastTick me daalo —
    // UI status line "ELITE signal hai par trigger/direction pending" clearly
    // dikha sake. LIVE me sirf ELITE/STRONG + trigger-fired hi count hota hai.
    if (eligible.length === 0) {
      const near = picks
        .filter(r => (r.side === 'LONG' || r.side === 'SHORT'))
        .sort((a, b) => (Number(b.superScore) || 0) - (Number(a.superScore) || 0))
        .slice(0, 3)
        .map(r => {
          const why = [
            ...(r.autoPickBlockers || []),
            ...(r.autoBlockers || []),
          ].filter(Boolean).slice(0, 2);
          if (why.length === 0) {
            why.push(
              `${r.tier || 'ROW'} ${r.superScore ?? '—'}`,
              `trigger ${r.triggerFired === true ? 'fired' : 'pending'}`,
              `direction ${r.directionVerified === true ? 'verified' : 'pending'}`,
            );
          }
          return `${r.symbol}: ${why.join(', ')}`;
        });
      out.skipped.push(`${market}: no ELITE/STRONG trigger-fired candidate${near.length ? ` — ${near.join(' | ')}` : ' (board has no directional row)'}`);
      continue;
    }

    // v21.30.0 [S4 PERP COVERAGE]: enrich crypto/FUTURES candidates with
    // funding / top-trader L/S / basis BEFORE the guard ladder. The batch has
    // a hard 1.5s deadline; missing data is reported, never fabricated. The
    // guard reads `row.fundingBps8h` etc., which board rows did not populate.
    const perpBases = [...new Set(eligible
      .filter(r => {
        if (market === 'INDIA') return false;
        return String(r.market || '').toUpperCase() !== 'GLOBALFUTURES';
      })
      .map(r => normalizeLinkSymbol(r.symbol, market))
      .filter(Boolean))].slice(0, 24);
    let perpIntelMap = p.perpIntel instanceof Map ? p.perpIntel : null;
    if (!perpIntelMap && perpBases.length > 0 && perpIntelEnabled()) {
      perpIntelMap = await getPerpIntelFor(perpBases, 1500).catch(() => new Map());
    }
    out.perpCoverage = {
      candidates: perpBases.length,
      enriched: 0,
      unavailable: 0,
      requested: Boolean(perpIntelMap),
      byField: { funding: 0, positioning: 0, basis: 0 },
    };

    let openedThisDesk = 0;
    for (const row of eligible) { // v21.22.0: strictly 1 trade at a time per session — never open 2 trades simultaneously!
      if (openedThisDesk >= 1 || out.opened.length >= 1) break;
      if (!quotaUnlimited && dayCountAllDesks + openedThisDesk >= effectiveMaxTradesPerDay) break;
      if (sessionOpen().length >= effectiveMaxOpenPositions) break;
      const sym = normalizeLinkSymbol(row.symbol, market);
      if (!sym || openSymbols.has(sym)) { out.skipped.push(`${sym}: already open`); continue; }
      // v21.30.0 [S4 PERP ENRICHMENT] — add the missing positioning fields
      // without mutating the cached board row. `dataStatus` makes coverage
      // explicit so a shadow veto can be distinguished from missing data.
      const rowDesk = String(row.market || '').toUpperCase();
      const isPerpRow = market !== 'INDIA' && rowDesk !== 'GLOBALFUTURES';
      const perpIntel = isPerpRow && perpIntelMap ? perpIntelMap.get(String(sym).toUpperCase()) : null;
      const perpOk = perpIntel?.ok === true;
      if (isPerpRow && perpIntelMap) {
        if (perpOk) out.perpCoverage.enriched += 1;
        else out.perpCoverage.unavailable += 1;
      }
      if (perpOk) {
        if (perpIntel.fundingBps8h != null) out.perpCoverage.byField.funding += 1;
        if (perpIntel.topLongShortRatio != null) out.perpCoverage.byField.positioning += 1;
        if (perpIntel.basisPct != null) out.perpCoverage.byField.basis += 1;
      }
      const guardRow = {
        ...row,
        ...(perpOk ? {
          fundingBps8h: perpIntel.fundingBps8h ?? null,
          longShortRatio: perpIntel.topLongShortRatio ?? null,
          basisPct: perpIntel.basisPct ?? null,
          perpIntelAt: perpIntel.at ?? null,
          dataStatus: {
            ...(row.dataStatus && typeof row.dataStatus === 'object' ? row.dataStatus : {}),
            perp: 'ok',
            funding: perpIntel.fundingBps8h != null ? 'ok' : 'missing',
            positioning: perpIntel.topLongShortRatio != null ? 'ok' : 'missing',
            basis: perpIntel.basisPct != null ? 'ok' : 'missing',
          },
        } : {
          dataStatus: {
            ...(row.dataStatus && typeof row.dataStatus === 'object' ? row.dataStatus : {}),
            perp: isPerpRow ? (perpIntelMap ? 'unavailable' : 'not-requested') : 'not-applicable',
          },
        }),
      };
      const dirLock = checkDirectionLock(sym, row.side, { now });
      if (dirLock && !dirLock.allowed) {
        out.skipped.push(`${sym}: ${dirLock.reason}`);
        continue;
      }
      const entry = Number(row.plan?.entry);
      const sl = Number(row.plan?.stopLoss);
      const t1 = Number(row.plan?.t1);
      const t2 = Number(row.plan?.t2);
      const riskPerUnit = Math.abs(entry - sl);
      if (!(entry > 0) || !(riskPerUnit > 0) || !(t1 > 0) || !(t2 > 0)) { out.skipped.push(`${sym}: incomplete ticket`); continue; }

      // ---------- v21.29.0 [R4/R5/R6/R7/R9 ENTRY GUARDS] ----------
      // Shadow modes only observe; enforce modes block. The decision is
      // recorded in state.shadowStats so R11 can gate a later flip.
      const guardDesk = market === 'INDIA'
        ? 'INDIA'
        : (String(row.market || '').toUpperCase() === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : 'FUTURES');
      const guardState = _loadState();
      // ---------- v21.30.0 [SIGNAL TIMING + DIRECTION] ----------
      // The board row is a snapshot; price may have already reversed or run
      // past the entry. Block only clear contradictions (fail-open on missing
      // data). This runs BEFORE the R3-R9 guards so a stale/reversal signal
      // never even reaches the sizing stage.
      const timingMode = entryTimingGuardMode();
      const timingQuote = (() => {
        if (market === 'CRYPTO' && p.usdtQuotes) {
          const q = p.usdtQuotes instanceof Map ? p.usdtQuotes.get(sym) : p.usdtQuotes[sym];
          if (Number(q) > 0) return Number(q);
        }
        const qObj = p.quotes?.[`${String(row.market || '').toUpperCase()}|${sym}`] ?? p.quotes?.[sym];
        const qPrice = typeof qObj === 'object' ? Number(qObj?.price ?? qObj?.ltp) : Number(qObj);
        if (Number(qPrice) > 0) return qPrice;
        return Number(row.ltp) > 0 ? Number(row.ltp) : null;
      })();
      const timingEval = evaluateEntryTiming({
        row, side: row.side, livePrice: timingQuote, now,
      });
      if (timingMode !== 'off' && timingEval.ok !== true) {
        for (const reason of timingEval.blockers) {
          recordShadowDecision(guardState.shadowStats, {
            filter: 'entryTiming', mode: timingMode, wouldBlock: true,
            reason, symbol: sym, market: guardDesk, at: now,
          });
        }
        if (timingMode === 'shadow') {
          out.shadow.push({
            symbol: sym, market: guardDesk,
            warnings: timingEval.blockers.map(reason => ({ filter: 'entryTiming', mode: timingMode, wouldBlock: true, reason })),
          });
          _logEvent('entry-timing-shadow', `${sym}: would-block — ${timingEval.blockers.join(' | ')}`);
        } else {
          const why = timingEval.blockers.join(' | ');
          out.skipped.push(`${sym}: entry timing blocked — ${why}`);
          _logEvent('entry-timing-block', `${sym}: ${why}`);
          continue;
        }
      }
      const guardEval = evaluateEntryGuards({
        cfg,
        row: { ...guardRow, execMarket: guardDesk },
        openRows: _openLinked(),
        closedRows: guardState.book,
        now,
        desk: guardDesk,
        eventCheck: eventGuardCheck({ symbol: sym, desk: guardDesk, now }),
      });
      for (const f of Object.values(guardEval.filters)) {
        recordShadowDecision(guardState.shadowStats, {
          filter: f.filter, mode: f.mode, wouldBlock: f.wouldBlock,
          reason: f.reason, symbol: sym, market: guardDesk, at: now,
        });
      }
      if (guardEval.shadowWarnings.length > 0) {
        out.shadow.push({
          symbol: sym, market: guardDesk,
          warnings: guardEval.shadowWarnings,
        });
        _logEvent('guard-shadow', `${sym}: shadow would-block — ${guardEval.shadowWarnings.map(w => `${w.filter}: ${w.reason}`).join(' | ')}`);
      }
      if (guardEval.blocked) {
        const why = guardEval.blockers.map(b => `${b.filter}: ${b.reason}`).join(' | ');
        out.skipped.push(`${sym}: entry guard blocked — ${why}`);
        _logEvent('guard-block', `${sym}: entry blocked — ${why}`);
        continue;
      }

      // ---- v21.17.0 USDT DOMAIN (crypto rows) ----
      // Board ka crypto ticket USDT me hai (Binance chain). Paper engine ka
      // execution domain bhi USDT hona chahiye — isliye crypto auto-linked
      // trades `market:'FUTURES'` (USDT-perp paper) me khulte hain, jo
      // watcher ke qualified `FUTURES|SYM` USDT quote se manage hote hain
      // (INR quote se false SL kabhi nahi).
      const isUsd = market === 'CRYPTO';
      // v21.23.8: per-ROW exec market — EQUITY SIM rows (GLOBALFUTURES) ab
      // pool me hain: wo USDC paper/SIM me khulte hain (live impossible —
      // CoinDCX par US equities listed nahi); baaki crypto rows FUTURES USDT.
      const rowExecMarket = isUsd
        ? (String(row.market || '').toUpperCase() === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : 'FUTURES')
        : 'INDIA';
      const isSimRow = rowExecMarket === 'GLOBALFUTURES';
      const execMarket = rowExecMarket;
      // live fx (caller) > config; clamp safety ke liye
      const fxRate = clampN(p.fx ?? cfg.inrPerUsdt, 40, 150, 84);
      if (isUsd && !isSimRow && p.usdtQuotes) {
        const q = p.usdtQuotes instanceof Map ? p.usdtQuotes.get(sym) : p.usdtQuotes[sym];
        if (!(Number(q) > 0)) { out.skipped.push(`${sym}: no live USDT perp quote (feed coverage)`); continue; }
        // Real-time Pre-Execution Anti-Reversal & Anti-Chase Guard:
        // 1) If live price has already moved >= 15% of risk distance against signal (toward SL), block entry!
        // 2) If live price has already run >= 35% of risk distance past entry (late chase after wave), block entry!
        const livePx = Number(q);
        const adverseTick = row.side === 'LONG'
          ? (livePx < entry - 0.15 * riskPerUnit)
          : (livePx > entry + 0.15 * riskPerUnit);
        if (adverseTick) {
          out.skipped.push(`${sym}: live price (${livePx}) reversing against ${row.side} entry (${entry}) — anti-reversal guard blocked entry`);
          continue;
        }
        const chasedTick = row.side === 'LONG'
          ? (livePx > entry + 0.35 * riskPerUnit)
          : (livePx < entry - 0.35 * riskPerUnit);
        if (chasedTick) {
          out.skipped.push(`${sym}: live price (${livePx}) already ran past ${row.side} entry (${entry}) — anti-late-chase guard blocked entry`);
          continue;
        }
      }
      // v21.23.8 EQUITY SIM quote gate: GLOBALFUTURES rows ke paas CoinDCX perp
      // quote nahi hota — board row ka live ltp (Yahoo/global-rt 5s cache) hi
      // anti-reversal/anti-chase truth hai. No ltp → koi entry nahi.
      if (isUsd && isSimRow) {
        const livePx = Number(row.ltp) || 0;
        if (!(livePx > 0)) { out.skipped.push(`${sym}: no live USDC sim quote (equity-sim feed coverage)`); continue; }
        const adverseTick = row.side === 'LONG'
          ? (livePx < entry - 0.15 * riskPerUnit)
          : (livePx > entry + 0.15 * riskPerUnit);
        if (adverseTick) {
          out.skipped.push(`${sym}: sim price (${livePx}) reversing against ${row.side} entry (${entry}) — anti-reversal guard blocked entry`);
          continue;
        }
        const chasedTick = row.side === 'LONG'
          ? (livePx > entry + 0.35 * riskPerUnit)
          : (livePx < entry - 0.35 * riskPerUnit);
        if (chasedTick) {
          out.skipped.push(`${sym}: sim price (${livePx}) already ran past ${row.side} entry (${entry}) — anti-late-chase guard blocked entry`);
          continue;
        }
      }

      // v21.18.0 + v21.22.0 WALLET-AMOUNT LEVERAGE (< ₹10,000 → 10x, ≥ ₹10,000 → 5x)
      // + v21.24.0 PHASE 0 EFFECTIVE RISK CAPS (pct-based risk, leverage cap,
      // wallet-deploy cap) — same helper as UC flip-reverse + status.
      const effectiveWalletINR = Number(p.walletEquityINR) > 0 ? Number(p.walletEquityINR) : Number(cfg.walletAmountINR) || 10000;
      const riskCaps = computeEffectiveRiskCaps(cfg, effectiveWalletINR);

      // qty: risk-based (₹ → USDT risk for usd desks), rounded, notional-capped
      const riskBudget = isUsd ? riskCaps.effectiveRiskINR / fxRate : riskCaps.effectiveRiskINR; // USDT | INR
      const rawQty = riskBudget / riskPerUnit;
      let qty = isUsd ? Math.floor(rawQty * 10000) / 10000 : Math.floor(rawQty);
      const notionalCapINR = Math.min(cfg.maxNotionalPerTradeINR, cfg.maxPositionsINR - _openNotionalINR(isLiveSession));
      const capQty = isUsd ? (notionalCapINR / fxRate) / entry : notionalCapINR / entry;
      if (qty > capQty) qty = isUsd ? Math.floor(capQty * 10000) / 10000 : Math.floor(capQty);
      const minQty = isUsd ? 0.0001 : 1;
      if (!(qty >= minQty)) { out.skipped.push(`${sym}: qty too small after caps (SL ${riskPerUnit.toFixed(4)})`); continue; }

      const leverage = riskCaps.effectiveLeverage;
      // v21.29.0 [R2 RISK-SIZING LABELS] — explain WHY this size. Does not
      // change the legacy qty math above; the labels are the audit surface.
      const riskSizing = computeRiskBasedSizing({
        walletINR: effectiveWalletINR,
        riskPerTradeINR: riskCaps.effectiveRiskINR,
        riskPerTradePct: riskCaps.activeRiskPct,
        entry,
        stopLoss: sl,
        maxNotionalINR: notionalCapINR,
        leverage,
        fxRate: isUsd ? fxRate : 1,
      });
      const w95 = computeWallet95Deployment({
        walletINR: effectiveWalletINR,
        leverage,
        fxRate,
        deployPct: riskCaps.effectiveWalletDeployPct,
        cfg,
      });
      const feeBePrice = feeBreakevenFloor({ entry, side: row.side, market: execMarket });
      const isEliteOrStrong = row.tier === 'ELITE' || row.tier === 'STRONG' || row.tier === 'ACTION' || Number(row.superScore) >= (Number(cfg.minScore) || 75);
      // v21.23.8: EQUITY SIM (GLOBALFUTURES) rows KABHI live order nahi lagati
      // — CoinDCX par US equities listed nahi, SIM/paper-only desk hai.
      // v21.24.0: liveEntryPaused ek DEFENCE-IN-DEPTH guard hai (primary pause
      // upar section 2 se pehle return karta hai).
      const wantLiveOrder = cfg.liveEntryPaused !== true && !isSimRow &&
        Boolean(siteLiveForDesk(p, row.market)) &&
        (cfg.executionMode === 'live' || cfg.autoSyncSiteLive !== false) &&
        isEliteOrStrong;

      // In strict live-only mode, only ELITE/STRONG rows auto-place
      if (cfg.executionMode === 'live' && !isEliteOrStrong) {
        out.skipped.push(`${sym}: live mode requires ELITE/STRONG tier (got ${row.tier} ${row.superScore})`);
        continue;
      }
      // v21.23.18 [NO SILENT PAPER FALLBACK IN STRICT LIVE]: user ne LIVE mode
      // ON kiya hai par is desk ka site-live arm nahi hai (e.g. INDIA typed-
      // LIVE arming pending) — aise me PAPER row kholna "trade lag gaya" ka
      // fake signal deta hai jabki exchange par kuch nahi jaata. Explicit skip
      // + reason do, taaki user desk LIVE arm kare ya PAPER mode chune.
      // EQUITY SIM exempt hai — wo design se paper/SIM-only desk hai.
      if (cfg.executionMode === 'live' && !isSimRow && !wantLiveOrder) {
        out.skipped.push(`${sym}: LIVE mode ON but ${row.market} desk site-live not armed — paper fallback skipped (desk LIVE arm karo ya PAPER mode chuno)`);
        continue;
      }

      // v21.29.0 [R2] — the actual live-order decision is gated here. These
      // checks never block a paper/SIM row (`wantLiveOrder` false).
      if (wantLiveOrder && liveArm && !liveArm.ok) {
        out.skipped.push(`${sym}: LIVE arm blocked — ${liveArm.blockers[0] || 'missing risk caps'}`);
        _logEvent('risk-arm-block', `${sym}: LIVE order blocked — missing caps: ${liveArm.missing.map(m => m.key).join(', ') || 'unknown'}`);
        continue;
      }
      if (wantLiveOrder && lossPause?.blocked) {
        out.skipped.push(`${sym}: ${lossPause.reason}`);
        _logEvent('loss-streak-pause', `${sym}: ${lossPause.reason}`);
        continue;
      }

      // v21.23.7 ENTRY-STAMP: volatility class entry-time board context se —
      // deep monitor + paper engine TP1-partial inhi se chalenge (LIVE ATR%
      // 15s tick pe refresh hoti rehti hai). HIGH vol 40% / EXTREME 35%
      // partial (runner bada), LOW/NORMAL 50% (as-is).
      const entryAtrPct = Number(row.context?.atrPct) > 0 ? Number(row.context.atrPct) : null;
      const entryVolClass = entryAtrPct != null ? classifyVolatility(entryAtrPct) : (row.context?.volClass || VOL_CLASS.NORMAL);
      const entryT1ClosePct = tp1ClosePctFor(entryVolClass);

      const res = paper.openPaperTrade?.({
        symbol: sym,
        direction: row.side,
        entry, qty, stopLoss: sl, target1: t1, target2: t2,
        market: execMarket,
        leverage,
        feeBreakevenPrice: feeBePrice,
        t1ClosePct: entryT1ClosePct,
        atrPct: entryAtrPct,
        // v21.17.0 / v21.22.0 AUDIT: kis board row / score / mode / leverage / 100% wallet se link hua
        source: 'mtf-auto',
        sourceMeta: {
          score: row.superScore, tier: row.tier, mode: row.mode, holdMin: row.holdMin,
          superSymbol: row.symbol, leverage, walletINR: effectiveWalletINR,
          walletDeployPct: w95.walletDeployPct, deployedWalletINR: w95.deployedWalletINR,
          buyingPowerINR: w95.buyingPowerINR, feeBreakevenPrice: feeBePrice,
        },
        label: `MTF AUTO · ${row.tier} ${row.superScore} · ${leverage}x (${w95.walletDeployPct}% Wallet) · ${row.label} ${row.holdMin}m · ${isUsd ? 'USDT' : '₹'}`,
      });
      if (!res || res.error || res.ok === false) {
        out.skipped.push(`${sym}: ${res?.error || 'openPaperTrade unavailable'}`);
        continue;
      }

      // v21.22.0 STRICT TRADED-ONLY GUARD ("entry without traded bhi isme add ho rahe hai inko bhi theek kardo"):
      // When wantLiveOrder is true, execute the LIVE order using 100% of the fetched CoinDCX Wallet.
      // If liveExecute is absent or the live order does NOT fill, roll back the paper trade immediately
      // and DO NOT push any untraded entry into _state.book or Deep Monitor!
      let liveOrderResult = null;
      let finalQty = qty;
      let finalEntry = entry;
      let finalSl = sl;
      let finalT1 = t1;
      let finalT2 = t2;
      if (wantLiveOrder) {
        if (typeof p.liveExecute !== 'function') {
          _voidRollbackPaperTrade(paper, res, p.quotes);
          _stampLiveAttemptFailure(sym, 'live execution handler unavailable', now);
          out.skipped.push(`${sym}: live execution handler unavailable — skipped to prevent untraded entry`);
          continue;
        }
        try {
          const marginUsdtVal = isUsd && effectiveWalletINR > 0
            ? Math.min(+((qty * entry) / leverage).toFixed(4), w95.exchangeSafeInitialMarginUSDT)
            : (isUsd ? +((qty * entry) / leverage).toFixed(4) : null);

          liveOrderResult = await p.liveExecute({
            symbol: sym, market: execMarket, side: row.side,
            entry, stopLoss: sl, target1: t1, target2: t2,
            qty, leverage, marginUSDT: marginUsdtVal,
            walletINR: effectiveWalletINR,
            walletDeployPct: w95.walletDeployPct,
            deployedWalletINR: w95.deployedWalletINR,
            deployedWalletUSDT: w95.deployedWalletUSDT,
            buyingPowerINR: w95.buyingPowerINR,
            buyingPowerUSDT: w95.buyingPowerUSDT,
            row,
          });
          if (!liveOrderResult?.ok) {
            _voidRollbackPaperTrade(paper, res, p.quotes);
            const errReason = liveOrderResult?.error || liveOrderResult?.reason || 'order not filled';
            // v21.23.10 [THRASH-CURE]: in-flight transient lock backoff nahi
            // lagata (doosra concurrent attempt hi tha); baaki har reject
            // escalating per-symbol backoff stamp karta hai.
            if (liveOrderResult?.inFlight !== true) _stampLiveAttemptFailure(sym, errReason, now);
            _logEvent('live-skip', `LIVE ORDER NOT EXECUTED on ${sym} (no untraded entry added): ${errReason}`);
            out.skipped.push(`${sym}: live order not executed (${errReason})`);
            continue;
          }
          if (Number(liveOrderResult?.filled?.qty) > 0) finalQty = Number(liveOrderResult.filled.qty);
          if (Number(liveOrderResult?.filled?.price) > 0) finalEntry = Number(liveOrderResult.filled.price);
          if (Number(liveOrderResult?.filled?.stopLoss) > 0) finalSl = Number(liveOrderResult.filled.stopLoss);
          if (Number(liveOrderResult?.filled?.t1) > 0) finalT1 = Number(liveOrderResult.filled.t1);
          if (Number(liveOrderResult?.filled?.t2) > 0) finalT2 = Number(liveOrderResult.filled.t2);
          _logEvent('live-entry', `LIVE ORDER PLACED ${sym} ${row.side} @ ${finalEntry} · ${leverage}x leverage · ${w95.walletDeployPct}% Wallet (₹${w95.deployedWalletINR} / ₹${Math.round(effectiveWalletINR)}) · qty ${finalQty}`);
        } catch (e) {
          _voidRollbackPaperTrade(paper, res, p.quotes);
          _stampLiveAttemptFailure(sym, e?.message || 'live order error', now);
          const errMsg = e?.message || 'error';
          _logEvent('live-skip', `LIVE ORDER exception on ${sym} (no untraded entry added): ${errMsg}`);
          out.skipped.push(`${sym}: live order error (${errMsg})`);
          continue;
        }
      }

      const finalRiskPerUnit = Math.max(finalEntry * 0.004, Math.abs(finalEntry - finalSl));
      const finalDeployedINR = Number(liveOrderResult?.filled?.walletDeployINR) > 0
        ? Number(liveOrderResult.filled.walletDeployINR)
        : w95.deployedWalletINR;
      const finalBuyingPowerINR = Number(liveOrderResult?.filled?.buyingPowerINR) > 0
        ? Number(liveOrderResult.filled.buyingPowerINR)
        : w95.buyingPowerINR;

      const rec = {
        paperId: res?.trade?.id ?? null,
        liveOrderId: liveOrderResult?.orderId ?? liveOrderResult?.filled?.orderId ?? null,
        livePositionId: liveOrderResult?.position?.exchangePositionId ?? liveOrderResult?.position?.id ?? null,
        executionMode: liveOrderResult?.ok ? 'LIVE' : 'PAPER',
        traded: true,
        fullControl: Boolean(liveOrderResult?.ok),
        openedInLiveMode: Boolean(wantLiveOrder),
        // v21.25.1: auto-engine entry — daily quota counts this row.
        openedBy: 'AUTO',
        autoTrade: true,
        symbol: sym, market, execMarket, ccy: isSimRow ? 'USDC' : (isUsd ? 'USDT' : 'INR'), fxUsed: isUsd ? fxRate : null,
        side: row.side,
        orderSide: row.side === 'LONG' ? 'buy' : 'sell',
        directionCertificate: buildDirectionCertificate({
          symbol: sym,
          market,
          side: row.side,
          entry: finalEntry,
          stopLoss: finalSl,
          t1: finalT1,
          t2: finalT2,
          requireTargets: true,
          directionVerified: row.directionVerified === true,
          source: 'mtf-auto-entry',
        }),
        score: row.superScore, tier: row.tier, mode: row.mode, holdMin: row.holdMin,
        entry: finalEntry, stopLoss: finalSl, initialStopLoss: finalSl, trailedStopLoss: finalSl, peakPrice: finalEntry,
        t1: finalT1, t2: finalT2, qty: finalQty, originalQty: finalQty,
        // Entry-armed exchange TP (createFuturesTpsl gets target2). Kept as the
        // "last confirmed" marker so rolling-TP2 retries can compare against it.
        lastExchangeTp: liveOrderResult?.ok ? finalT2 : null,
        // v21.24.0 STOP-INTEGRITY anchor (entry-arming armed yahi SL).
        lastExchangeSl: liveOrderResult?.ok ? finalSl : null,
        slSyncPending: false,
        tpSyncPending: false,
        leverage, walletINR: Math.round(effectiveWalletINR),
        walletDeployPct: w95.walletDeployPct,
        deployedWalletINR: finalDeployedINR,
        deployedWalletUSDT: w95.deployedWalletUSDT,
        buyingPowerINR: finalBuyingPowerINR,
        buyingPowerUSDT: w95.buyingPowerUSDT,
        feeBreakevenPrice: feeBreakevenFloor({ entry: finalEntry, side: row.side, market: execMarket }),
        deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
        deepMonitorLabel: 'Stage 0 · Initial SL Guard',
        // v21.26.0 AI SUPER AGENT: every AUTO entry starts a dedicated
        // tick-driven lifecycle (ARMED → MONITORING → TP1_SECURED → IDLE).
        superAgentState: 'ARMED',
        superAgentIdleReason: null,
        superAgentTickCount: 0,
        superAgentLastTickAt: null,
        // v21.23.7 ENTRY-STAMP: vol class + TP1 partial pct — 15s deep tick
        // LIVE boardRow se refresh karta hai; 3s fast loop inhi se padhta hai.
        atrPct: entryAtrPct,
        volClass: entryVolClass,
        momentumState: null,
        t1ClosePct: entryT1ClosePct,
        trendStatus: `📡 ${row.side === 'SHORT' ? 'BEARISH' : 'BULLISH'} LIVE WATCH (+0.00R)`,
        marginINR: +(finalQty * finalEntry * (isUsd ? fxRate : 1) / leverage).toFixed(2),
        marginUsdt: isUsd ? +(finalQty * finalEntry / leverage).toFixed(4) : null,
        riskINR: +(finalQty * finalRiskPerUnit * (isUsd ? fxRate : 1)).toFixed(2),
        riskUsdt: isUsd ? +(finalQty * finalRiskPerUnit).toFixed(4) : null,
        notional: +(finalQty * finalEntry * (isUsd ? fxRate : 1)).toFixed(2),   // INR budget ke liye
        notionalUsdt: isUsd ? +(finalQty * finalEntry).toFixed(4) : null,
        openedAt: now, dayKey: dayKeyFor(execMarket),
        status: 'OPEN', closeReason: null, closedAt: null, pnl: null,
        drivers: row.drivers?.slice(0, 3) || [],
        // v21.29.0 [R2] audit labels — planned vs final live qty + the cap
        // that actually bound the size (risk-budget or notional-cap).
        riskSizing: {
          ...riskSizing,
          plannedQty: riskSizing.qty,
          finalQty: finalQty,
          labels: [
            ...(Array.isArray(riskSizing.labels) ? riskSizing.labels : []),
            `final qty ${finalQty}${isUsd ? ' USDT' : ''}`,
          ],
        },
      };
      const stx = _loadState();
      stx.book.push(rec);
      stx.dayCount += 1;
      stx.perSymbolLast[sym] = now;
      _persistState();
      // v21.26.0: board row snapshot available to the tick agent from second
      // zero (flip detection never waits for the next 15s/60s rebuild).
      _rememberBoardRow(sym, row, now);
      acquireDirectionLock({ symbol: sym, side: row.side, source: 'mtf-auto', now });
      openSymbols.add(sym);
      out.opened.push(rec);
      openedThisDesk += 1;
      _logEvent('entry', `OPEN ${sym} ${row.side} @ ${finalEntry} · SL ${sl} · T1 ${t1} · T2 ${t2} · qty ${finalQty} · ${w95.walletDeployPct}% Wallet (₹${w95.deployedWalletINR} @ ${leverage}x) — score ${row.superScore} (${row.tier})`, { mode: row.mode, blockers: [] });
      if (typeof p.notify === 'function') {
        try { await p.notify(`🚀 MTF AUTO entry (${rec.executionMode}): ${sym} ${row.side} @ ${finalEntry} | SL ${sl} | T1 ${t1} | T2 ${t2} | ${w95.walletDeployPct}% Wallet ₹${w95.deployedWalletINR} (${leverage}x) | score ${row.superScore} ${row.tier}`); } catch { /* non-fatal */ }
      }
    }
  }

  const stf = _loadState();
  stf.lastTick = { at: now, opened: out.opened.length, closed: out.closed.length, skipped: out.skipped.slice(0, 4) };
  _persistState();
  return out;
  } finally {
    if (isRuntimeLock) _mtfAutoTickInFlight = false;
  }
}

/**
 * v21.22.0: Returns realtime Deep Monitor snapshots for all genuinely ACTIVE traded positions
 * (used by mtfAutoStatus, SIGNAL RECHECK — 15s LIVE WATCH, MTFDualBoardPanel, and Telegram Bot).
 * Strictly filters out any untraded fallback entries ("entry without traded").
 */
// ------------------------------------------------------------
// v21.28.0 [F9] DEEP-MONITOR HEARTBEAT + PROTECTION / LADDER TELEMETRY
// ------------------------------------------------------------
// Audit finding F9: the UI could show a "monitoring" trade while the 3s/15s
// decision lane was dead (no fresh decision), and a LIVE position's exchange
// stop could be missing/diverged without any visible badge. These helpers are
// pure/observational — they NEVER move a stop, open, close or size a trade.
export const DEEP_MONITOR_STALE_MS = 10_000;
const DEEP_MONITOR_HB_SOURCES_MAX = 8;
const DEEP_MONITOR_PROTECTION_TOL_PCT = 0.0005;

function _freshDeepMonitorHb() {
  return { lastDecisionAt: 0, decisions: 0, lastSource: null, lastCount: 0, sources: {} };
}
let _deepMonitorHb = _freshDeepMonitorHb();

/** Record that a REAL monitor lane (3s fast loop, 15s auto tick, or the
 *  per-trade super agent) evaluated the active book. Status/UI polling must
 *  never call this — otherwise a dead lane would keep looking fresh. */
export function _stampDeepMonitorHeartbeat({ source = 'unknown', now = Date.now(), count = 0 } = {}) {
  const at = Number(now) > 0 ? Number(now) : Date.now();
  const src = String(source || 'unknown').slice(0, 40);
  _deepMonitorHb.lastDecisionAt = at;
  _deepMonitorHb.decisions = (Number(_deepMonitorHb.decisions) || 0) + 1;
  _deepMonitorHb.lastSource = src;
  _deepMonitorHb.lastCount = Math.max(0, Number(count) || 0);
  const prev = _deepMonitorHb.sources[src];
  _deepMonitorHb.sources[src] = {
    count: (Number(prev?.count) || 0) + 1,
    lastAt: at,
    lastCount: _deepMonitorHb.lastCount,
  };
  const keys = Object.keys(_deepMonitorHb.sources);
  if (keys.length > DEEP_MONITOR_HB_SOURCES_MAX) {
    for (const k of keys) {
      if (k !== src) { delete _deepMonitorHb.sources[k]; break; }
    }
  }
  return _deepMonitorHeartbeat({ now: at });
}

/** Honest heartbeat snapshot. `stale:null` means "never stamped" (unknown),
 *  not "healthy". A lane is stale after DEEP_MONITOR_STALE_MS without a pass. */
export function _deepMonitorHeartbeat({ now = Date.now() } = {}) {
  const at = Number(now) > 0 ? Number(now) : Date.now();
  const last = Number(_deepMonitorHb.lastDecisionAt) || 0;
  const ageMs = last > 0 ? Math.max(0, at - last) : null;
  return {
    lastDecisionAt: last > 0 ? last : null,
    ageMs,
    staleAfterMs: DEEP_MONITOR_STALE_MS,
    stale: last > 0 ? ageMs > DEEP_MONITOR_STALE_MS : null,
    decisions: Number(_deepMonitorHb.decisions) || 0,
    lastSource: _deepMonitorHb.lastSource || null,
    lastCount: Number(_deepMonitorHb.lastCount) || 0,
    sources: Object.entries(_deepMonitorHb.sources).map(([source, v]) => ({
      source,
      count: Number(v?.count) || 0,
      lastAt: Number(v?.lastAt) || null,
      lastCount: Number(v?.lastCount) || 0,
      ageMs: Number(v?.lastAt) > 0 ? Math.max(0, at - Number(v.lastAt)) : null,
    })),
    checkedAt: at,
  };
}

/** Exchange-vs-book stop protection badge for one active trade.
 *  PAPER         — paper mirror owns the SL (no exchange native stop)
 *  BROKER        — India broker venue (not verifiable through CoinDCX)
 *  PROTECTED     — LIVE CoinDCX SL verified at the exchange and matching book
 *  SYNC_PENDING  — a push/retry is in flight (never claim protection yet)
 *  UNVERIFIED    — LIVE but no exchange SL read-back on record
 *  DIVERGED      — exchange SL differs from the book SL (drift detected) */
export function _deepMonitorProtection(b = {}, mon = {}) {
  const mode = String(b.executionMode || 'PAPER').toUpperCase();
  const isIndia = String(b.market || '').toUpperCase() === 'INDIA'
    || String(b.execMarket || '').toUpperCase() === 'INDIA';
  const bookSl = Number(mon.trailedStopLoss ?? mon.stopLoss ?? b.trailedStopLoss ?? b.stopLoss) || 0;
  const exchangeSl = Number(b.lastExchangeSl) || 0;
  const pending = b.slSyncPending === true;
  const base = {
    executionMode: mode,
    bookSl: bookSl || null,
    exchangeSl: exchangeSl || null,
    slSyncPending: pending,
    lastError: b.slLastSyncError || null,
    diffPct: bookSl > 0 && exchangeSl > 0
      ? +((Math.abs(bookSl - exchangeSl) / exchangeSl) * 100).toFixed(3)
      : null,
  };
  if (mode !== 'LIVE') {
    return { ...base, state: 'PAPER', label: '🧪 PAPER SL', tone: 'info', venue: 'paper', reason: 'paper mirror manages SL/TP' };
  }
  if (isIndia) {
    return { ...base, state: 'BROKER', label: '🏦 BROKER SL', tone: 'info', venue: 'broker', reason: 'India broker-side protection — not verifiable through CoinDCX' };
  }
  if (pending) {
    return { ...base, state: 'SYNC_PENDING', label: '⏳ SL SYNC PENDING', tone: 'warn', venue: 'coindcx', reason: b.slLastSyncError || 'exchange SL push/retry in flight' };
  }
  if (!(exchangeSl > 0)) {
    return { ...base, state: 'UNVERIFIED', label: '❓ SL UNVERIFIED', tone: 'danger', venue: 'coindcx', reason: 'no exchange SL read-back on record' };
  }
  if (bookSl > 0 && Math.abs(bookSl - exchangeSl) / exchangeSl >= DEEP_MONITOR_PROTECTION_TOL_PCT) {
    return { ...base, state: 'DIVERGED', label: '⚠️ SL DIVERGED', tone: 'danger', venue: 'coindcx', reason: `book SL ${bookSl} ≠ exchange SL ${exchangeSl}` };
  }
  return { ...base, state: 'PROTECTED', label: '🛡️ PROTECTED', tone: 'ok', venue: 'coindcx', reason: 'exchange SL verified and matching book' };
}

/** Visual exit-ladder rung tracker. Pre-TP1 the initial SL is the only stop;
 *  after TP1 the stop moves to fee-BE(+buffer); at >=80% to TP2 it moves to
 *  TP1; TP2 touch is the full-close rung. V3 close-confirmation appears as a
 *  WAITING rung instead of pretending TP1 is locked. */
export function _ladderTracker(_b = {}, mon = {}) {
  const tp1Touched = Boolean(mon.tp1Hit ?? _b.t1Hit);
  const tp1Ladder = Boolean(mon.tp1LadderActive);
  const tp2Approach = Boolean(mon.tp2Approach);
  const tp2Hit = Boolean(mon.tp2Hit);
  const v3Enforce = mon.exitPolicyV3?.applied === true;
  const awaitingClose = v3Enforce && tp1Touched && !tp1Ladder;
  const initialSl = Number(mon.initialStopLoss ?? mon.previousStopLoss ?? _b.initialStopLoss ?? _b.stopLoss) || null;
  const t1 = Number(mon.t1 ?? _b.t1) || null;
  const t2 = Number(mon.t2 ?? _b.t2) || null;
  const liveSl = Number(mon.trailedStopLoss ?? _b.trailedStopLoss ?? _b.stopLoss) || null;

  let rung = 'INITIAL_SL';
  if (tp2Hit) rung = 'TP2_EXIT';
  else if (tp2Approach && tp1Ladder) rung = 'TP1_LOCK';
  else if (tp1Ladder) rung = 'FEE_BE';
  else if (awaitingClose) rung = 'TP1_CONFIRM';

  const steps = [
    {
      key: 'INITIAL_SL', label: 'Initial SL', price: initialSl,
      state: rung === 'INITIAL_SL' ? 'ACTIVE' : 'DONE',
    },
    {
      key: 'FEE_BE', label: v3Enforce ? 'TP1 → fee-BE+buffer' : 'TP1 → fee-BE',
      price: t1, stop: tp1Ladder ? liveSl : null,
      state: tp1Ladder ? (rung === 'FEE_BE' ? 'ACTIVE' : 'DONE') : (awaitingClose ? 'WAITING' : 'PENDING'),
    },
    {
      key: 'TP1_LOCK', label: 'TP2 ≥80% → SL at TP1',
      price: t2, stop: tp2Approach && tp1Ladder ? t1 : null,
      state: tp2Approach && tp1Ladder ? (rung === 'TP1_LOCK' ? 'ACTIVE' : 'DONE') : 'PENDING',
    },
    {
      key: 'TP2_EXIT', label: 'TP2 → full close',
      price: t2,
      state: tp2Hit ? 'ACTIVE' : 'PENDING',
    },
  ];
  if (awaitingClose) {
    steps.splice(1, 0, {
      key: 'TP1_CONFIRM', label: 'TP1 close-confirm', price: t1,
      state: 'WAITING',
    });
  }
  const progressPct = tp2Hit
    ? 100
    : Math.max(0, Math.min(100, Number(mon.tp2ProgressPct) || 0));
  return {
    rung,
    progressPct: +progressPct.toFixed(1),
    activeStep: rung,
    awaitingTp1Confirm: awaitingClose,
    steps,
    note: awaitingClose
      ? 'V3 enforce: wick TP1 cannot move the stop until a closed bar confirms'
      : null,
  };
}

/** Read-only "what will the monitor do next" preview. Direction is never
 *  changed here — this is pure UI/audit text derived from the same decision. */
export function _nextActionPreview(_b = {}, mon = {}, protection = null) {
  const px = (v) => (Number(v) > 0 ? Number(v) : null);
  if (mon.directionBlocked) {
    return {
      code: 'DIRECTION_BLOCKED', label: '⛔ DIRECTION BLOCKED', urgency: 'critical',
      detail: mon.directionCertificate?.reasons?.[0] || 'direction certificate blocked — no trail / no exit',
    };
  }
  if (mon.tp2Hit) {
    return { code: 'TP2_EXIT', label: '🏆 TP2 HIT → FULL CLOSE', urgency: 'critical', detail: `Close entire position at ${px(mon.t2) ?? 'TP2'}` };
  }
  if (mon.shouldClose) {
    return { code: 'PROTECTIVE_EXIT', label: '🛡️ PROTECTIVE EXIT', urgency: 'critical', detail: mon.exitReason || 'deep-monitor protective exit armed' };
  }
  if (mon.tp1Hit && !mon.tp1LadderActive && mon.exitPolicyV3?.applied === true) {
    return { code: 'AWAIT_TP1_CLOSE', label: '⏳ TP1 TOUCHED — AWAIT CLOSED BAR', urgency: 'warn', detail: `Wick TP1 at ${px(mon.t1) ?? '—'}: stop stays at initial SL until a closed bar confirms` };
  }
  if (mon.tp1LadderActive && mon.tp2Approach) {
    return { code: 'SL_AT_TP1', label: `🔒 NEXT: SL → TP1 ${px(mon.t1) ?? '—'}`, urgency: 'ok', detail: 'TP2 approach ≥80% — runner stop locks at TP1' };
  }
  if (mon.tp1LadderActive) {
    return {
      code: 'SL_AT_FEE_BE', label: `🔒 NEXT: SL → ${protection?.state === 'PROTECTED' ? 'exchange ' : ''}${px(mon.trailedStopLoss) ?? 'fee-BE'}`,
      urgency: protection && protection.state !== 'PROTECTED' && protection.venue === 'coindcx' ? 'warn' : 'ok',
      detail: `TP1 secured — stop at fee-BE${mon.exitPolicyV3?.applied ? '+buffer' : ''} · runner → TP2 ${px(mon.t2) ?? '—'}`,
    };
  }
  const dist = Number(mon.distToTp1Pct);
  return {
    code: 'HOLD_INITIAL_SL',
    label: `🛡️ HOLD · INITIAL SL ${px(mon.initialStopLoss) ?? '—'}`,
    urgency: protection && ['UNVERIFIED', 'DIVERGED', 'SYNC_PENDING'].includes(protection.state) ? 'warn' : 'neutral',
    detail: Number.isFinite(dist)
      ? `No stop move before TP1 · TP1 ${px(mon.t1) ?? '—'} (${Math.abs(dist)}% ${dist >= 0 ? 'away' : 'beyond'})`
      : 'No stop move before TP1 (target unavailable)',
  };
}

export function getActiveAutoTradesDeepMonitor(liveQuotes = {}, opts = {}) {
  const cfg = loadMtfAutoConfig();
  const hbNow = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const open = _openLinked().filter(b => isGenuinelyTradedEntry(b, cfg));
  const allowTpExtension = opts.allowTpExtension !== false;
  let bookUpdated = false;
  const rows = open.map((b) => {
    const entryPx = Number(b.entry) || 0;
    const quoteRaw = liveQuotes?.[`${b.execMarket || b.market}|${b.symbol}`] ?? liveQuotes?.[b.symbol];
    const quotePx = typeof quoteRaw === 'object' ? Number(quoteRaw?.price ?? quoteRaw?.ltp) : Number(quoteRaw);
    const hasFreshQuote = quotePx > 0 && (!(entryPx > 0) || (quotePx / entryPx >= 0.35 && quotePx / entryPx <= 2.85));
    const qRaw = quoteRaw ?? b.ltp ?? b.entry;
    const rawLtp = typeof qRaw === 'object' ? Number(qRaw?.price ?? qRaw?.ltp ?? b.entry) : Number(qRaw || b.entry);
    const ltp = (rawLtp > 0 && (!(entryPx > 0) || (rawLtp / entryPx >= 0.35 && rawLtp / entryPx <= 2.85)))
      ? rawLtp
      : (Number(b.ltp) > 0 ? Number(b.ltp) : entryPx);
    // [FAST-LOOP FLIP VISIBILITY] 3s status loop ko latest known board row do —
    // warna woh reversal-aware trendStatus ko price-only "LIVE WATCH" se
    // overwrite kar deta hai (flip hua tha, UI par normal pullback dikhta tha).
    const hbCandles = closedCandlesFor(b.symbol, b.execMarket || b.market, { now: hbNow });
    const mon = evaluateActiveTradeDeepMonitor(b, {
      ltp,
      boardRow: _snapshotRowFor(b.symbol, hbNow),
      closedCandles: hbCandles,
      // A fallback/stale book LTP may keep SL telemetry alive, but it must
      // NEVER move TP2 - only a real, sanity-checked quote can extend.
      allowTpExtension: allowTpExtension && hasFreshQuote,
      proExitPolicy: cfg.proExitPolicy !== false,
      now: hbNow,
    });
    stampTp1ConfirmHold(b, mon, { now: hbNow, closedCandles: hbCandles });
    // v21.22.0 ULTRA-FAST REALTIME SL RATCHET PERSISTENCE:
    // Persist peakPrice and ratcheted trailedStopLoss directly onto `_state.book`
    // so SL never regresses backward on pullbacks between background ticks.
    if (ltp > 0) {
      b.ltp = ltp;
      if (mon.peakPrice > 0 && mon.peakPrice !== b.peakPrice) {
        b.peakPrice = mon.peakPrice;
        bookUpdated = true;
      }
      if (mon.slTrailed && mon.trailedStopLoss > 0) {
        b.trailedStopLoss = mon.trailedStopLoss;
        b.stopLoss = mon.trailedStopLoss;
        b.lastSlTrailAt = hbNow;
        bookUpdated = true;
      }
      if (mon.tp1Hit && !b.t1Hit) {
        b.t1Hit = true;
        bookUpdated = true;
      }
      // v21.24.0 ROLLING TP2 (3s status loop): persist so the next tick starts from the new target.
      if (mon.t2Extended && mon.t2 > 0) {
        b.t2 = mon.t2;
        b.t2Extensions = mon.t2Extensions;
        b.lastTpExtendAt = hbNow;
        // LIVE exchange TP must be re-armed. Keep this pending until the 3s/15s
        // loop gets an explicit {ok:true} from the exchange — a failed call must
        // not leave the native TP stranded at the old target. INDIA rows have no
        // CoinDCX native TP, so they never enter the retry path.
        if (b.executionMode === 'LIVE' && !(b.market === 'INDIA' || b.execMarket === 'INDIA')) b.tpSyncPending = true;
        bookUpdated = true;
      }
      b.smartTrail = mon.smartTrail || null;
      b.currentR = mon.currentR;
      b.peakR = mon.peakR;
      b.deepMonitorStage = mon.stageCode;
      b.deepMonitorLabel = mon.stageLabel;
      b.trendStatus = mon.trendStatus;
    }
    const deployPct = b.walletDeployPct || (cfg.walletDeployPct ?? 100);
    const protection = _deepMonitorProtection(b, mon);
    const ladder = _ladderTracker(b, mon);
    const nextAction = _nextActionPreview(b, mon, protection);
    return {
      ...mon,
      // v21.28.0 [F9]: per-row decision stamp + protection/ladder/next action.
      decisionAt: hbNow,
      protection,
      ladder,
      nextAction,
      originalQty: Number(b.originalQty) > 0 ? Number(b.originalQty) : (Number(b.qty) > 0 ? Number(b.qty) : null),
      qtyAfterTp1: b.qtyAfterTp1 != null && Number.isFinite(Number(b.qtyAfterTp1)) ? Number(b.qtyAfterTp1) : null,
      t1PartialBooked: b.t1PartialBooked === true,
      paperId: b.paperId,
      liveOrderId: b.liveOrderId,
      livePositionId: b.livePositionId ?? null,
      traded: true,
      fullControl: Boolean(b.fullControl || b.executionMode === 'LIVE' || b.livePositionId),
      executionMode: b.executionMode || 'PAPER',
      leverage: b.leverage || 10,
      walletINR: b.walletINR || 10000,
      walletDeployPct: deployPct,
      deployedWalletINR: b.deployedWalletINR || Math.round((b.walletINR || 10000) * (deployPct / 100)),
      buyingPowerINR: b.buyingPowerINR || Math.round((b.walletINR || 10000) * (deployPct / 100) * (b.leverage || 10)),
      score: b.score,
      tier: b.tier,
      mode: b.mode,
      holdMin: b.holdMin,
      openedAt: b.openedAt,
      // Rolling-TP2 sync state: routes' 3s loop retries the exchange update
      // until this clears (never trusts a failed call).
      tpSyncPending: b.tpSyncPending === true,
      lastExchangeTp: b.lastExchangeTp ?? null,
      // v21.24.0 STOP-INTEGRITY: boot/restart ke baad bhi routes ka 3s loop
      // book-vs-exchange SL divergence detect kar sake — `lastExchangeSl`
      // missing ho to `initialStopLoss` hi exchange anchor maana jata hai.
      slSyncPending: b.slSyncPending === true,
      lastExchangeSl: b.lastExchangeSl ?? null,
      initialStopLoss: b.initialStopLoss ?? b.stopLoss ?? null,
    };
  });
  if (bookUpdated) _persistState();
  if (opts.stampHeartbeat === true) {
    _stampDeepMonitorHeartbeat({
      source: opts.source || 'deep-monitor',
      now: hbNow,
      count: rows.length,
    });
  }
  const protectionCounts = rows.reduce((acc, r) => {
    const st = r?.protection?.state || 'UNKNOWN';
    acc[st] = (Number(acc[st]) || 0) + 1;
    return acc;
  }, {});
  return {
    activeCount: rows.length,
    trailingActiveCount: rows.filter(r => r.slTrailed || r.stageCode !== 'STAGE_0_INITIAL_GUARD').length,
    tp1LockedCount: rows.filter(r => r.tp1Hit).length,
    reversalAlertCount: rows.filter(r => r.reversalDetected).length,
    directionBlockedCount: rows.filter(r => r.directionBlocked === true || r.directionCertificate?.ok === false).length,
    directionIntegrity: summarizeBoardDirectionIntegrity(rows),
    protectionCounts,
    guards: mtfAutoGuardTelemetry(cfg),
    heartbeat: _deepMonitorHeartbeat({ now: hbNow }),
    trades: rows,
    checkedAt: hbNow,
  };
}

// ---------------- status / views ----------------
export function mtfAutoStatus(liveQuotes = {}, opts = {}) {
  const cfg = loadMtfAutoConfig();
  const st = _loadState();
  const open = _openLinked();
  const w95 = computeWallet95Deployment({ walletINR: cfg.walletAmountINR, deployPct: cfg.walletDeployPct ?? 100, cfg });
  // v21.24.0 PHASE 0 WALLET HONESTY: entry path actual live wallet
  // (liveCtx.walletEquityINR) se size karta hai — status bhi wahi wallet use
  // kare, warna ₹10,000 configured par ₹100 risk dikhta tha jabki real wallet
  // ~₹1,385 thi (actual risk budget ₹13.85). Caller wallet na de to
  // configured value hi fallback hai (paper/offline status).
  const effectiveWalletINR = Number(opts?.walletINR) > 0
    ? Number(opts.walletINR)
    : (Number(cfg.walletAmountINR) > 0 ? Number(cfg.walletAmountINR) : 10000);
  // v21.24.0 PHASE 0 — effective caps (configured values status me as-is
  // rehte hain for backward compatibility; UI/audit effective values padhte hain).
  const riskCaps = computeEffectiveRiskCaps(cfg, effectiveWalletINR);
  const effective95 = computeWallet95Deployment({
    walletINR: effectiveWalletINR,
    leverage: riskCaps.effectiveLeverage,
    deployPct: riskCaps.effectiveWalletDeployPct,
    cfg,
  });
  // Extension needs a real quote snapshot. Calls without quotes (toggle,
  // preview, session-lock checks) must not move a live target off stale LTP.
  const deepMonitor = getActiveAutoTradesDeepMonitor(liveQuotes, {
    allowTpExtension: Boolean(liveQuotes && Object.keys(liveQuotes).length),
  });
  // v21.25.1 [QUOTA HONESTY]: status ka displayed count wahi rows count kare
  // jo tick ka quota gate karta hai — manual PAPER test rows isme nahi aate.
  const _quotaLiveSession = String(cfg.executionMode || '').toLowerCase() === 'live';
  const _quotaDayKeyNow = new Date();
  const dayQuotaCount = st.book
    .filter(b => isSessionQuotaEntry(b, _quotaLiveSession))
    .filter(b => b.dayKey === dayKeyFor(b.market, _quotaDayKeyNow))
    .length;
  // v21.29.0 [R2] — live-arm blockers + loss-streak pause are part of the
  // status contract so the UI never has to guess why LIVE is not entering.
  const riskArmState = mtfAutoRiskArmState(cfg);
  return {
    ok: true,
    // Persistence provenance — 'false' means config/state came from defaults
    // (or the local disk), NOT from a durable restore.
    bootedAt: _bootedAt,
    restoredFromDurable: _restoredFromDurable,
    restoredConfigFromDurable: _restoredConfigFromDurable,
    restoredStateFromDurable: _restoredStateFromDurable,
    configSavedAt: _cfgSavedAt,
    stateSavedAt: st.updatedAt,
    enabled: cfg.enabled,
    liveEntryPaused: cfg.liveEntryPaused === true,
    entryPauseReason: cfg.liveEntryPaused === true
      ? 'Phase 0 safety: naye LIVE/UC-flip entries paused; existing positions ka deep monitor + SL management chalu hai'
      : null,
    mode: cfg.mode,
    holdMin: cfg.holdMin,
    minScore: cfg.minScore,
    riskPerTradeINR: cfg.riskPerTradeINR,
    riskCaps,
    effectiveWalletDeployPct: riskCaps.effectiveWalletDeployPct,
    effectiveWallet95Deployment: effective95,
    maxPositionsINR: cfg.maxPositionsINR,
    maxNotionalPerTradeINR: cfg.maxNotionalPerTradeINR,
    maxTradesPerDay: cfg.maxTradesPerDay,
    quotaUnlimited: Number(cfg.maxTradesPerDay) === 0,
    proExitPolicy: cfg.proExitPolicy !== false,
    maxOpenPositions: cfg.maxOpenPositions,
    cooldownMin: cfg.cooldownMin,
    desks: cfg.desks,
    timeStopEnabled: cfg.timeStopEnabled,
    inrPerUsdt: cfg.inrPerUsdt,
    executionMode: cfg.executionMode || 'paper',
    autoSyncSiteLive: cfg.autoSyncSiteLive !== false,
    walletAmountINR: cfg.walletAmountINR,
    // v21.24.0 WALLET HONESTY: caps/effective95 jis wallet par bane hain.
    // Live status me ye actual CoinDCX equity hai (configured ₹10,000 nahi).
    effectiveWalletINR: +effectiveWalletINR.toFixed(2),
    walletDeployPct: cfg.walletDeployPct ?? 100,
    wallet95Deployment: w95,
    wallet100Deployment: w95,
    belowTenKLeverage: cfg.belowTenKLeverage,
    aboveTenKLeverage: cfg.aboveTenKLeverage,
    activeLeverage: riskCaps.effectiveLeverage,
    feeAwareReversalExit: cfg.feeAwareReversalExit !== false,
    deepMonitorEnabled: cfg.deepMonitorEnabled !== false,
    // v21.26.0 per-trade AI SUPER AGENT config (runtime telemetry is injected
    // by routes.js from autoTradeSuperAgent.js — mtfAutoLink stays decoupled).
    superAgentEnabled: cfg.superAgentEnabled !== false,
    superAgentMinimalLossExit: cfg.superAgentMinimalLossExit !== false,
    superAgentMinLossR: clampN(cfg.superAgentMinLossR, -0.90, -0.10, -0.35),
    // v21.29.0 [R2 RISK ARM]
    liveArm: riskArmState.liveArm,
    liveArmBlocked: riskArmState.liveArmBlocked,
    liveArmBlockers: riskArmState.liveArmBlockers,
    consecutiveLoss: riskArmState.consecutiveLoss,
    riskArmPreset: { ...riskArmState.liveArm.preset },
    riskArmPresetOnly: true,
    ackPhrase: riskArmState.ackPhrase,
    // v21.29.0 [R3–R11] — modes + shadow evidence + calibration buckets.
    guards: mtfAutoGuardTelemetry(cfg),
    deepMonitor,
    directionIntegrity: deepMonitor.directionIntegrity,
    ccyMode: 'crypto rows USDT (paper = FUTURES desk domain) · india rows ₹',
    day: st.day,
    dayCount: st.dayCount,
    dayQuotaCount,
    quotaScope: _quotaLiveSession ? 'LIVE rows only' : 'auto-engine rows only (manual PAPER excluded)',
    openCount: open.length,
    openNotionalINR: Math.round(_openNotionalINR()),
    book: st.book.filter(b => b.closeReason !== 'PURGED_UNTRADED_ENTRY').slice(-30).reverse(),
    events: st.events.slice(-40).reverse(),
    lastTick: st.lastTick,
    paperOnly: cfg.executionMode !== 'live',
    note: cfg.liveEntryPaused === true
      ? `⏸ PHASE 0 LIVE ENTRIES PAUSED — naye LIVE/UC-flip entries band; existing positions ka deep monitor, trailing SL aur exchange SL sync chalu hai. Effective caps: ${riskCaps.activeRiskPct || '—'}% risk/trade · ${riskCaps.effectiveWalletDeployPct}% wallet deploy · ${riskCaps.effectiveLeverage}x max leverage.`
      : cfg.executionMode === 'live'
        ? `LIVE AUTO MODE ACTIVE — ${riskCaps.effectiveWalletDeployPct}% CoinDCX Wallet Deployment + ${riskCaps.effectiveLeverage}x leverage (wallet-tier: < ₹10,000 → 10x · ≥ ₹10,000 → 5x) + Full CoinDCX Active Position Control (TP1/TP2 Trailing SL + UC Flip-Reverse + Vol-Adaptive Reversal Profit Book). Trade allowlist: FUTURES USDT + GOLD/SILVER (XAU/XAG) + EQUITY SIM — CoinDCX SPOT FULL STOP.`
        : 'MTF AUTO-LINK PAPER mode me hai (Live Mode activate karne par ELITE/STRONG trades full-wallet deployment + wallet-tier leverage ke saath auto lagte hain; Full CoinDCX Active Position Control + TP1/TP2 Trailing SL + UC Flip-Reverse + Vol-Adaptive Reversal Profit Book). Trade allowlist: FUTURES USDT + GOLD/SILVER (XAU/XAG) + EQUITY SIM — CoinDCX SPOT FULL STOP.',
  };
}

// ============================================================
// v21.26.0 AI SUPER INTELLIGENCE — TICK-DRIVEN PER-TRADE AGENT
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "jab bhi AUTO trade lagta hai, us trade ke liye
// ek AI super intelligence agent immediately active ho — WebSocket realtime
// price par TP1/TP2 monitor kare, highest profit trail kare, trade clearly
// against ho to bahut hi kam loss me close kare, aur market pakka opposite
// move kare to purana trade band karke immediately naya trade live direction
// me laga de. TP2 hit + close ke baad agent wapas IDLE ho jaye."
//
// WHY A SEPARATE TICK ENTRY-POINT (not another loop):
//   • The 3s fast-SL loop and 15s deep tick remain BACKSTOPS. This function is
//     called directly from liveFeed.subscribe() — the same event-loop turn as
//     the WebSocket tick — so TP1/TP2/minimal-loss reaction does not wait for
//     a poll boundary.
//   • It is deliberately PURE-ish like mtfAutoTick: boards, paper engine,
//     quotes and live handlers are injected by routes.js (hermetic tests).
//   • All existing safety gates stay authoritative: direction certificate,
//     trigger/ensemble/auto readiness for NEW reverse entries, 1-trade-session
//     lock, daily quota, cooldowns, fee/age guards and budget caps.
//
// HONEST LATENCY: no 1ms feed is fabricated. The handler runs synchronously
// inside setTick()'s subscriber loop; actual market latency is the upstream
// WebSocket source's latency (Binance perps sub-second; CoinDCX book ~1s).
// ============================================================

const SUPER_AGENT_PAPER_SL_MIN_MS = 1_500;
const SUPER_AGENT_EXCHANGE_SYNC_MIN_MS = 2_000;
const SUPER_AGENT_PERSIST_MIN_MS = 8_000;
const SUPER_AGENT_LOG_MIN_MS = 4_000;
const SUPER_AGENT_MAX_ACTIONS = 12;

function _superAgentKeyOf(b) {
  return `${String(b?.market || '').toUpperCase()}|${String(b?.symbol || '').toUpperCase()}`;
}

function _superAgentRtFor(b) {
  const key = _superAgentKeyOf(b);
  let rt = _superAgentRuntime.get(key);
  if (!rt) {
    rt = {
      lastPaperSlAt: 0, lastExchangeAt: 0, lastLogAt: 0, lastPersistAt: 0,
      actions: [], lastAction: null, lastActionAt: 0,
    };
    _superAgentRuntime.set(key, rt);
  }
  if (_superAgentRuntime.size > 64) {
    const first = _superAgentRuntime.keys().next().value;
    if (first !== undefined && first !== key) _superAgentRuntime.delete(first);
  }
  return rt;
}

/** Persistence is intentionally throttled: a stage-5 chandelier trail can
 *  improve on every new high, and a Binance symbol can tick 20×/s. Disk writes
 *  happen at most once per SUPER_AGENT_PERSIST_MIN_MS unless an exit/TP event
 *  forces one. */
function _superAgentPersist(force = false) {
  const now = Date.now();
  if (!force && now - _superAgentLastPersistAt < SUPER_AGENT_PERSIST_MIN_MS) return false;
  _superAgentLastPersistAt = now;
  _persistState();
  return true;
}

function _superAgentPushAction(b, kind, text, now) {
  const rt = _superAgentRtFor(b);
  const at = Number(now) || Date.now();
  rt.lastAction = kind;
  rt.lastActionAt = at;
  rt.actions.push({ at, kind, text: String(text || '').slice(0, 240) });
  if (rt.actions.length > SUPER_AGENT_MAX_ACTIONS) rt.actions = rt.actions.slice(-SUPER_AGENT_MAX_ACTIONS);
  b.superAgentLastAction = kind;
  b.superAgentLastActionAt = at;
  b.superAgentActions = rt.actions.slice(-6);
}

function _superAgentMirror(summary, paperId) {
  if (!summary || !Array.isArray(summary.open) || paperId == null) return null;
  return summary.open.find(t => t && String(t.id) === String(paperId)) || null;
}

/**
 * The dedicated per-trade agent's single entry point.
 *
 * @param {object} input
 *  symbol, market        book identity (market: CRYPTO | INDIA)
 *  ltp                   WebSocket tick price (already domain-checked below)
 *  velocityAdverse       agent-computed: rapid consecutive adverse ticks
 *  velocityPct           adverse move % over the agent's rolling window
 *  tickAgeMs             age of the upstream tick (freshness honesty)
 *  p                     injected deps (paper, quotes, getBoardRow, liveClose,
 *                        liveUpdateSl, liveExecute, getLiveCtx, fx, notify…)
 *  now                   epoch ms (tests / backtests)
 *  isRuntimeClock        false in tests to bypass real-clock grace windows
 */
export async function mtfAutoSuperAgentManage(input = {}) {
  const cfg = loadMtfAutoConfig();
  const now = Number(input.now) || Date.now();
  const sym = normalizeLinkSymbol(input.symbol, input.market);
  const marketFilter = String(input.market || '').toUpperCase();
  const baseOut = { ok: true, symbol: sym || null, market: marketFilter || null, state: 'IDLE' };
  if (!sym) return { ...baseOut, ok: false, skipped: 'invalid symbol' };

  const st = _loadState();
  const b = st.book.find(row => row && row.status === 'OPEN'
    && isGenuinelyTradedEntry(row, cfg)
    && normalizeLinkSymbol(row.symbol, row.market) === sym
    && (!marketFilter || String(row.market || '').toUpperCase() === marketFilter)
    // ONLY true AUTO-engine rows. Manual board clicks keep the classic deep
    // monitor; they never inherit the agent's minimal-loss policy silently.
    && (row.autoTrade === true || row.openedBy === 'AUTO' || row.flipEntry === true));
  if (!b) return { ...baseOut, skipped: 'no auto trade' };

  const side = normalizeSide(b.side);
  if (!side) {
    b.superAgentState = 'PAUSED';
    b.superAgentIdleReason = 'INVALID_SIDE';
    return { ...baseOut, ok: false, skipped: 'invalid side', state: 'PAUSED' };
  }
  const ltp = Number(input.ltp) || 0;
  if (!(ltp > 0)) return { ...baseOut, ok: false, state: b.superAgentState || 'ARMED', skipped: 'no live price' };
  const entry = Number(b.entry) || 0;
  // CROSS-CURRENCY / CORRUPT-TICK FIREWALL (same band as the 15s monitor).
  if (entry > 0) {
    const ratio = ltp / entry;
    if (ratio <= 0.35 || ratio >= 2.85) {
      return { ...baseOut, ok: false, state: b.superAgentState || 'ARMED', skipped: 'price domain mismatch', priceRatio: +ratio.toFixed(4) };
    }
  }
  if (input.p?.killSwitch === true) {
    b.superAgentState = 'PAUSED';
    b.superAgentIdleReason = 'KILL_SWITCH';
    return { ...baseOut, ok: false, state: 'PAUSED', skipped: 'kill switch' };
  }

  const isLivePos = String(b.executionMode || '').toUpperCase() === 'LIVE';
  let pp = input.p || {};
  const paper = pp.paper || {};

  let summary = null;
  try { summary = typeof paper.getPaperSummary === 'function' ? paper.getPaperSummary() : null; } catch { summary = null; }
  let livePaper = _superAgentMirror(summary, b.paperId);

  // PAPER mirror vanished → the real engine already closed it (TP2/SL/EOD/
  // manual). Reconcile the book row honestly instead of managing a ghost.
  // LIVE mirrors are NOT reconciled this way: a paper-mirror SL is not proof
  // that the leveraged exchange position is closed.
  if (!isLivePos && summary && Array.isArray(summary.open) && b.paperId != null && !livePaper) {
    const closed = (summary.closedToday || []).find(t => String(t.id) === String(b.paperId));
    b.status = 'CLOSED';
    b.closeReason = closed?.closeReason || 'PAPER_ENGINE_CLOSED';
    b.closedAt = Number(closed?.closedAt) || now;
    b.pnl = closed?.realizedPnl ?? b.pnl ?? null;
    b.pnlVerified = true;
    b.pnlSource = 'PAPER';
    b.superAgentState = 'IDLE';
    b.superAgentIdleReason = b.closeReason;
    b.superAgentIdleAt = now;
    _superAgentPushAction(b, 'IDLE', `paper engine closed ${b.closeReason}`, now);
    _superAgentPersist(true);
    return { ...baseOut, ok: true, skipped: 'paper engine already closed', action: b.closeReason, closed: true, state: 'IDLE', idleReason: b.closeReason };
  }

  let effRow = null;
  if (typeof pp.getBoardRow === 'function') {
    try { effRow = pp.getBoardRow(sym, b.market) || null; } catch { effRow = null; }
  }
  // Freshest row wins; <=120s last-seen snapshot keeps flip detection alive
  // when the symbol rotates out of the top-6 board trim.
  if (effRow) _rememberBoardRow(b.symbol, effRow, now);
  effRow = effRow || _snapshotRowFor(b.symbol, now);

  const s1 = Number(b.trailedStopLoss ?? b.stopLoss) || 0;
  const s2 = Number(livePaper?.stopLoss) || 0;
  const effectiveCurSl = (s1 > 0 && s2 > 0)
    ? (side === 'SHORT' ? Math.min(s1, s2) : Math.max(s1, s2))
    : (s1 || s2);

  const oppSide = oppositeSideOf(b.side);
  const revByRow = Boolean(
    oppSide && effRow && (
      (normalizeSide(effRow.side) === oppSide && (effRow.triggerFired || Number(effRow.superScore) >= 65))
      || (effRow.context?.dir != null && ((side === 'LONG' && effRow.context.dir < 0 && effRow.triggerDir < 0) || (side === 'SHORT' && effRow.context.dir > 0 && effRow.triggerDir > 0)))
    )
  );

  const saCandles = closedCandlesFor(b.symbol, b.execMarket || b.market, { now });
  const deepEval = evaluateActiveTradeDeepMonitor({
    ...b,
    side,
    stopLoss: effectiveCurSl,
    t1Hit: Boolean(livePaper?.t1Hit || b.t1Hit),
    qty: Number(livePaper?.qty ?? b.qty ?? 1),
  }, {
    ltp,
    boardRow: effRow,
    closedCandles: saCandles,
    reversalConfirmed: revByRow,
    proExitPolicy: cfg.proExitPolicy !== false,
    now,
  });
  stampTp1ConfirmHold(b, deepEval, { now, closedCandles: saCandles });
  // v21.28.0 [F9]: a real per-trade monitor decision just ran — heartbeat is
  // stamped even when the direction certificate blocks any action.
  _stampDeepMonitorHeartbeat({ source: 'super-agent', now, count: 1 });

  if (deepEval.directionBlocked) {
    b.superAgentState = 'PAUSED';
    b.superAgentIdleReason = 'DIRECTION_BLOCKED';
    b.superAgentLastTickAt = now;
    b.superAgentLastPrice = ltp;
    b.superAgentTickCount = (Number(b.superAgentTickCount) || 0) + 1;
    b.trendStatus = deepEval.trendStatus;
    return { ...baseOut, ok: false, state: 'PAUSED', skipped: 'direction blocked', trendStatus: deepEval.trendStatus };
  }

  const rt = _superAgentRtFor(b);
  const prevStage = b.deepMonitorStage;
  const tradeAgeMs = Math.max(0, now - (Number(b.openedAt) || now));
  const isRuntimeClock = input.isRuntimeClock !== false;
  const tickAgeMs = Number(input.tickAgeMs);
  const tickFresh = !(Number.isFinite(tickAgeMs) && tickAgeMs > 5_000);

  // ---- stamp the deep-monitor result on the book row (single source of truth) ----
  b.ltp = ltp;
  b.peakPrice = deepEval.peakPrice;
  b.currentR = deepEval.currentR;
  b.peakR = deepEval.peakR;
  b.t1Hit = Boolean(deepEval.tp1Hit || b.t1Hit);
  // v21.29.0 [R8 STICKY TP2]: same one-way latch as TP1 — a later pullback
  // must not erase "TP2 was touched" or the runner trail can never exit.
  b.t2Hit = Boolean(deepEval.tp2Hit || b.t2Hit);
  b.deepMonitorStage = deepEval.stageCode;
  b.deepMonitorLabel = deepEval.stageLabel;
  b.trendStatus = deepEval.trendStatus;
  b.atrPct = deepEval.atrPct ?? b.atrPct ?? null;
  b.volClass = deepEval.volClass || b.volClass || null;
  b.momentumState = deepEval.momentumState || b.momentumState || null;
  b.t1ClosePct = deepEval.t1ClosePct || b.t1ClosePct || 0.5;
  b.smartTrail = deepEval.smartTrail || null;
  b.superAgentLastTickAt = now;
  b.superAgentLastPrice = ltp;
  b.superAgentTickCount = (Number(b.superAgentTickCount) || 0) + 1;
  b.superAgentVelocityPct = Number(input.velocityPct) || 0;
  b.superAgentVelocityAdverse = Boolean(input.velocityAdverse);
  b.superAgentAdverseConfirmed = Boolean(revByRow || input.velocityAdverse);
  b.superAgentMinLossR = clampN(cfg.superAgentMinLossR, -0.90, -0.10, -0.35);

  // ---- TP1 partial: book it on THIS tick (no 3s sweep wait) ----
  let tp1Booked = false;
  // v21.28.0 [F2 LIVE TP1 PARTIAL] — reduce the REAL CoinDCX position first;
  // the paper mirror books only after the exchange accepts. Live India rows
  // (and flag-off) keep the legacy paper-only mirror path below.
  const liveTp1Attempt = await _tryLiveTp1Partial({ b, deepEval, cfg, p: pp, livePaper, paper, now });
  const liveTp1FlagOn = cfg.liveTp1Partial === true && isLivePos;
  if (liveTp1Attempt.booked) {
    tp1Booked = true;
    b.t1Hit = true;
    b.t1BookedAt = now;
    b.superAgentState = 'TP1_SECURED';
    b.superAgentTp1At = now;
    _superAgentPushAction(b, 'TP1_PARTIAL_BOOKED', `LIVE TP1 ${deepEval.t1} touched @ ${ltp} — ${liveTp1Attempt.res?.requestedQty ?? b.t1PartialQty} qty reduced`, now);
    _logEvent('live-tp1', `💰 LIVE TP1 PARTIAL ${b.symbol} (${b.side}) @ ${ltp} — ${liveTp1Attempt.res?.requestedQty ?? b.t1PartialQty} qty reduced (SL ${deepEval.trailedStopLoss ?? b.stopLoss} locked)`);
    _superAgentPersist(true);
    if (typeof pp.notify === 'function') {
      try {
        Promise.resolve(pp.notify(`🎯 LIVE TP1 PARTIAL: ${b.symbol} ${b.side} @ ${ltp} — ${liveTp1Attempt.res?.requestedQty ?? b.t1PartialQty} qty reduced · runner → T2 ${b.t2}`))
          .catch(() => { /* non-fatal */ });
      } catch { /* non-fatal */ }
    }
    livePaper = _superAgentMirror(typeof paper.getPaperSummary === 'function' ? paper.getPaperSummary() : summary, b.paperId) || livePaper;
  }
  // Mirror booking is allowed unless a LIVE partial was actually attempted and
  // failed (requirement: reduce fail ⇒ no paper-mirror book).
  const allowLegacyTp1Mirror = !liveTp1FlagOn || !liveTp1Attempt.attempted
    || liveTp1Attempt.reason === 'already-booked';
  if (deepEval.tp1Hit && livePaper && livePaper.t1Hit !== true && allowLegacyTp1Mirror) {
    // Volatility can shift between entry and TP1. Refresh the paper mirror's
    // vol-aware partial % first so this tick books the SAME size the deep
    // monitor would (HIGH 40% / EXTREME 35% keep the runner bigger).
    if (typeof paper.updatePaperTradeT1ClosePct === 'function' && Number(deepEval.t1ClosePct) > 0) {
      try { paper.updatePaperTradeT1ClosePct(livePaper.id, deepEval.t1ClosePct); } catch { /* non-fatal */ }
    }
    let bookRes = null;
    if (typeof paper.bookPaperT1Partial === 'function') {
      try { bookRes = paper.bookPaperT1Partial(livePaper.id, ltp); } catch (e) { bookRes = { ok: false, error: e?.message || 'book failed' }; }
    } else if (typeof paper.evaluatePaper === 'function') {
      // Legacy/fake-paper fallback. Real routes inject bookPaperT1Partial.
      try {
        paper.evaluatePaper({
          [b.symbol]: { price: ltp, src: 'super-agent' },
          [`${b.execMarket || b.market}|${b.symbol}`]: { price: ltp, src: 'super-agent' },
        }, []);
        bookRes = { ok: true, fallback: true };
      } catch { bookRes = { ok: false, error: 'evaluatePaper fallback failed' }; }
    }
    if (bookRes?.ok) {
      tp1Booked = true;
      b.t1Hit = true;
      b.t1BookedAt = now;
      b.bookedPnl = Number(bookRes.trade?.realizedPnl ?? livePaper.realizedPnl ?? b.bookedPnl ?? 0);
      b.superAgentState = 'TP1_SECURED';
      b.superAgentTp1At = now;
      _superAgentPushAction(b, 'TP1_PARTIAL_BOOKED', `TP1 ${deepEval.t1} touched @ ${ltp} — ${bookRes.note || 'partial booked'}`, now);
      _logEvent('super-tp1', `🎯 SUPER AGENT TP1 ${b.symbol} ${b.side} @ ${ltp} — ${bookRes.note || 'partial booked'} (SL ${b.trailedStopLoss ?? b.stopLoss} locked)`);
      _superAgentPersist(true);
      if (typeof pp.notify === 'function') {
        // Fire-and-forget: Telegram latency must never delay the exit ladder
        // that runs a few lines below on this same tick.
        try {
          Promise.resolve(pp.notify(`🎯 SUPER AGENT TP1: ${b.symbol} ${b.side} @ ${ltp} — ${bookRes.note || 'partial booked'} · runner → T2 ${b.t2}`))
            .catch(() => { /* non-fatal */ });
        } catch { /* non-fatal */ }
      }
      livePaper = _superAgentMirror(typeof paper.getPaperSummary === 'function' ? paper.getPaperSummary() : summary, b.paperId) || livePaper;
    }
  }

  // ---- exit decision ladder (TP2 → confirmed flip → minimal loss → fee-safe exit) ----
  const revEval = revByRow ? evaluateFeeAwareReversalExit({
    side: b.side,
    entry: b.entry,
    ltp,
    stopLoss: livePaper?.stopLoss ?? b.stopLoss,
    target1: b.t1,
    target2: b.t2,
    tp1Hit: Boolean(livePaper?.t1Hit || b.t1Hit),
    bookedPnl: Number(livePaper?.realizedPnl ?? b.bookedPnl ?? 0),
    qty: Number(livePaper?.qty ?? b.qty ?? 1),
    market: b.execMarket || b.market,
    reversalConfirmed: true,
    reversalReasons: [`board flipped ${oppSide} (${effRow?.superScore ?? '—'}${effRow?.__snapshot ? ' · snap' : ''})`],
  }) : null;

  const movePctFromEntry = entry > 0 ? Math.abs(ltp - entry) / entry : 0;
  const liveFeeSafeProfitMove = !isLivePos || movePctFromEntry >= 0.0020 || deepEval.tp2Hit;
  const hasProgressedIntoProfitStage = deepEval.peakR >= 0.35 || (b.deepMonitorStage && b.deepMonitorStage !== 'STAGE_0_INITIAL_GUARD');
  const allowDefensiveSlClose = !isLivePos
    ? deepEval.shouldExitDefensiveSl
    : (deepEval.shouldExitDefensiveSl && deepEval.currentR <= -1.02 && (!isRuntimeClock || tradeAgeMs >= 90_000));
  const allowLiveExitAfterGrace = !isLivePos
    || !isRuntimeClock
    || tradeAgeMs >= 90_000
    || (deepEval.feeCovered && liveFeeSafeProfitMove && hasProgressedIntoProfitStage)
    || (deepEval.tp2Hit && movePctFromEntry >= 0.0040);

  const shouldExitByReversalOrTrail = Boolean(
    allowLiveExitAfterGrace && (
      ((revEval?.shouldExit && revEval?.feeCovered) && liveFeeSafeProfitMove)
      || (deepEval.shouldBookProfitNow && liveFeeSafeProfitMove)
      || allowDefensiveSlClose
    )
  );

  const ucFlipAgeOk = !isRuntimeClock || tradeAgeMs >= (isLivePos ? UC_FLIP_MIN_AGE_MS_LIVE : UC_FLIP_MIN_AGE_MS_PAPER);
  const ucFlipConfirmed = revByRow;
  const ucFlipProtectiveExit = Boolean(
    ucFlipConfirmed
    && cfg.ucFlipReverse !== false
    && ucFlipAgeOk
    && !deepEval.tp2Hit
    && !shouldExitByReversalOrTrail
  );

  // MINIMAL-LOSS PROTECTION: only on CONFIRMED adverse direction (board flip
  // or the agent's tick-velocity confirmation) AND after the age guard. A
  // normal pullback never qualifies — that is the whipsaw firewall.
  const minLossR = clampN(cfg.superAgentMinLossR, -0.90, -0.10, -0.35);
  const superAgentAgeOk = !isRuntimeClock || tradeAgeMs >= (isLivePos ? Math.max(UC_FLIP_MIN_AGE_MS_LIVE, 60_000) : UC_FLIP_MIN_AGE_MS_PAPER);
  const adverseConfirmed = Boolean(ucFlipConfirmed || (input.velocityAdverse === true && tickFresh));
  const superAgentMinimalLossExit = Boolean(
    cfg.superAgentEnabled !== false
    && cfg.superAgentMinimalLossExit !== false
    && !deepEval.tp2Hit
    && superAgentAgeOk
    && adverseConfirmed
    && deepEval.currentR <= minLossR
  );

  let exitReason = null;
  let flipWanted = false;
  if (deepEval.tp2Hit) {
    exitReason = 'TP2_TARGET_HIT_FULL_PROFIT';
    flipWanted = false;
  } else if (ucFlipProtectiveExit) {
    exitReason = 'UC_FLIP_MINIMAL_LOSS_EXIT';
    flipWanted = true;
  } else if (superAgentMinimalLossExit) {
    exitReason = 'SUPER_AGENT_MINIMAL_LOSS_EXIT';
    flipWanted = Boolean(ucFlipConfirmed);
  } else if (shouldExitByReversalOrTrail) {
    exitReason = revEval?.shouldExit ? revEval.stage : (deepEval.exitReason || 'DEEP_MONITOR_PROFIT_BOOK');
    flipWanted = Boolean(ucFlipConfirmed && cfg.ucFlipReverse !== false && !deepEval.tp2Hit);
  }

  // ---- LIVE context is expensive (wallet snapshot); only fetch when an
  // action actually needs the exchange handlers. Routes caches it 15s.
  const needsLiveCtx = isLivePos && (
    Boolean(exitReason)
    || deepEval.slTrailed
    || b.slSyncPending
    || b.tpSyncPending
    || deepEval.t2Extended
  );
  if (needsLiveCtx && typeof pp.getLiveCtx === 'function'
    && (typeof pp.liveClose !== 'function' || typeof pp.liveUpdateSl !== 'function')) {
    try {
      const lc = await pp.getLiveCtx();
      if (lc && typeof lc === 'object') pp = { ...pp, ...lc };
    } catch { /* keep injected handlers */ }
    if (b.status !== 'OPEN') return { ...baseOut, ok: true, skipped: 'trade closed during context refresh', state: 'IDLE' };
  }

  if (exitReason) {
    const key = _superAgentKeyOf(b);
    if (_superAgentExitLocks.has(key)) return { ...baseOut, skipped: 'exit already in flight', state: b.superAgentState };
    _superAgentExitLocks.add(key);
    b.superAgentExitPendingAt = now;
    try {
      if (b.status !== 'OPEN') return { ...baseOut, ok: true, skipped: 'trade already closed', state: b.superAgentState };
      let liveClosePnl = null;
      if (isLivePos && typeof pp.liveClose === 'function') {
        let lc = null;
        try { lc = await pp.liveClose(b); } catch { lc = null; }
        if (lc === null) {
          b.syncError = 'super-agent liveClose returned null — exchange state unknown';
          _logEvent('live-close-failed', `⚠️ SUPER AGENT LIVE close FAILED ${b.symbol} — row OPEN, next tick retries`);
          return { ...baseOut, ok: false, state: b.superAgentState, skipped: 'live close failed', error: b.syncError };
        }
        if (lc && lc.ok === false) {
          b.syncError = String(lc.error || lc.reason || 'exchange close failed').slice(0, 200);
          _logEvent('live-close-failed', `⚠️ SUPER AGENT LIVE close FAILED ${b.symbol} — ${b.syncError} (row OPEN, retry)`);
          return { ...baseOut, ok: false, state: b.superAgentState, skipped: 'live close failed', error: b.syncError };
        }
        const lcPnl = Number(lc?.realizedPnl ?? lc?.pnl);
        if (Number.isFinite(lcPnl)) liveClosePnl = lcPnl;
      }

      const closeQuotes = {
        ...(pp.quotes || {}),
        [b.symbol]: { price: ltp, src: 'super-agent' },
        [`${b.execMarket || b.market}|${b.symbol}`]: { price: ltp, src: 'super-agent' },
      };
      let r = null;
      if (b.paperId != null && typeof paper.closePaperTrade === 'function') {
        try { r = paper.closePaperTrade(b.paperId, closeQuotes, exitReason); } catch { r = null; }
      }
      if (isLivePos && b.paperId && r && r.ok === false && typeof paper.voidPaperTrade === 'function') {
        try { paper.voidPaperTrade(b.paperId); } catch { /* best-effort */ }
      }
      if (r?.ok || isLivePos || b.paperId == null) {
        b.status = 'CLOSED';
        b.closeReason = exitReason;
        b.closedAt = now;
        const estimatedPnl = r?.trade?.realizedPnl ?? revEval?.netTotalPnl ?? deepEval.grossPnl;
        if (isLivePos && liveClosePnl != null) {
          b.pnl = liveClosePnl;
          b.pnlVerified = true;
          b.pnlSource = 'EXCHANGE';
        } else if (isLivePos) {
          b.pnl = estimatedPnl;
          b.pnlVerified = false;
          b.pnlSource = 'ESTIMATE';
        } else {
          b.pnl = estimatedPnl;
          b.pnlVerified = true;
          b.pnlSource = 'PAPER';
        }
        b.superAgentState = flipWanted ? 'FLIPPED' : 'IDLE';
        b.superAgentIdleReason = flipWanted ? `FLIPPED:${exitReason}` : exitReason;
        b.superAgentIdleAt = now;
        _superAgentPushAction(b, exitReason, `closed @ ${ltp} (${deepEval.currentR}R) — ${b.superAgentIdleReason}`, now);
        _logEvent('super-exit', `🤖 SUPER AGENT EXIT ${b.symbol} ${b.side} @ ${ltp} — ${exitReason} (${deepEval.currentR}R · state ${b.superAgentState})`);
        _superAgentPersist(true);

        let reverseRec = null;
        if (flipWanted && cfg.ucFlipReverse !== false) {
          const saOut = { opened: [], closed: [], skipped: [] };
          reverseRec = await _tryOpenUcFlipReverse({ b, boardRow: effRow, ltp, p: pp, cfg, out: saOut, now });
          if (reverseRec) {
            b.superAgentIdleReason = 'FLIPPED_REVERSE_ENTRY';
            _superAgentPersist(true);
          }
        }
        if (typeof pp.notify === 'function') {
          // Fire-and-forget: the exit is already committed; a slow Telegram
          // send must not hold the per-trade handler/lock.
          try {
            const msg = exitReason === 'TP2_TARGET_HIT_FULL_PROFIT'
              ? `✅ SUPER AGENT TP2: ${b.symbol} ${b.side} @ ${ltp} — full profit booked, agent IDLE`
              : reverseRec
                ? `🔁 SUPER AGENT FLIP: ${b.symbol} ${b.side}→${reverseRec.side} @ ${ltp} — minimal loss close + immediate reverse entry`
                : `🛡️ SUPER AGENT ${exitReason}: ${b.symbol} ${b.side} @ ${ltp} (${deepEval.currentR}R) — agent IDLE`;
            Promise.resolve(pp.notify(msg)).catch(() => { /* non-fatal */ });
          } catch { /* non-fatal */ }
        }
        return {
          ...baseOut,
          ok: true,
          side: b.side,
          state: b.superAgentState,
          idleReason: b.superAgentIdleReason,
          action: exitReason,
          closed: true,
          flipped: Boolean(reverseRec),
          reverseSymbol: reverseRec?.symbol || null,
          reverseSide: reverseRec?.side || null,
          currentR: deepEval.currentR,
          peakR: deepEval.peakR,
          ltp,
        };
      }
      b.syncError = `paper close failed: ${String(r?.error || 'unknown').slice(0, 120)}`;
      return { ...baseOut, ok: false, state: b.superAgentState, skipped: 'paper close failed', error: b.syncError };
    } finally {
      _superAgentExitLocks.delete(key);
      b.superAgentExitPendingAt = 0;
    }
  }

  // ---- HOLD / TRAIL path ----
  let trailAction = null;
  // Rolling TP2 first so the same throttled exchange call carries the new TP.
  if (deepEval.t2Extended && Number(deepEval.t2) > 0 && Number(deepEval.t2) !== Number(b.t2)) {
    const prevT2 = b.t2;
    b.t2 = deepEval.t2;
    b.t2Extensions = deepEval.t2Extensions;
    b.lastTpExtendAt = now;
    if (livePaper?.id != null && typeof paper.updatePaperTradeTarget2 === 'function') {
      try { paper.updatePaperTradeTarget2(livePaper.id, deepEval.t2); } catch { /* non-fatal */ }
    }
    if (isLivePos) b.tpSyncPending = true;
    trailAction = 'TP2_EXTENDED';
    _superAgentPushAction(b, 'TP2_EXTENDED', `T2 ${prevT2} → ${b.t2} [#${b.t2Extensions}] @ ${ltp}`, now);
    _logEvent('super-tp-extend', `🎯 SUPER AGENT ROLLING TP2 ${b.symbol} (${b.side}): T2 ${prevT2} → ${b.t2} [#${b.t2Extensions}] @ ${ltp}`);
    _superAgentPersist(true);
  }

  if (deepEval.slTrailed && deepEval.trailedStopLoss > 0) {
    const prevSl = b.trailedStopLoss ?? b.stopLoss;
    b.trailedStopLoss = deepEval.trailedStopLoss;
    b.stopLoss = deepEval.trailedStopLoss;
    if (livePaper) livePaper.stopLoss = deepEval.trailedStopLoss;
    trailAction = trailAction || 'SL_TRAILED';
    // PAPER engine SL write — throttled by time OR a meaningful move.
    if (!isLivePos && livePaper?.id != null && typeof paper.updatePaperTradeStopLoss === 'function') {
      const deltaPct = Number(prevSl) > 0 ? Math.abs(deepEval.trailedStopLoss - Number(prevSl)) / Number(prevSl) : 1;
      if (now - rt.lastPaperSlAt >= SUPER_AGENT_PAPER_SL_MIN_MS || deltaPct >= 0.002) {
        rt.lastPaperSlAt = now;
        try { paper.updatePaperTradeStopLoss(livePaper.id, deepEval.trailedStopLoss, b.execMarket || b.market || null); } catch { /* non-fatal */ }
      }
    }
  } else if (!isLivePos && livePaper?.id != null && Number(b.trailedStopLoss) > 0
    && Math.abs(Number(b.trailedStopLoss) - Number(livePaper.stopLoss || 0)) > 1e-9
    && now - rt.lastPaperSlAt >= SUPER_AGENT_PAPER_SL_MIN_MS
    && typeof paper.updatePaperTradeStopLoss === 'function') {
    // Restart/divergence repair: book row and paper mirror must agree.
    rt.lastPaperSlAt = now;
    try { paper.updatePaperTradeStopLoss(livePaper.id, b.trailedStopLoss, b.execMarket || b.market || null); } catch { /* non-fatal */ }
  }

  // LIVE exchange SL/TP sync — throttled to ~2s (the 3s backstop uses 4.5s).
  // v21.28.0 [F5]: an accepted push with an unverified read-back sets a 60s
  // cooldown — retrying every tick would stack create_tpsl orders.
  if (isLivePos && typeof pp.liveUpdateSl === 'function'
    && (deepEval.slTrailed || b.slSyncPending || b.tpSyncPending || trailAction === 'TP2_EXTENDED')
    && !(Number(b.slNextRetryAt) > now)
    && now - rt.lastExchangeAt >= SUPER_AGENT_EXCHANGE_SYNC_MIN_MS) {
    rt.lastExchangeAt = now;
    try {
      const slRes = await pp.liveUpdateSl({
        ...b,
        stopLoss: Number(b.trailedStopLoss ?? b.stopLoss) || 0,
        takeProfit: Number(b.t2) || 0,
      });
      if (slRes?.ok) {
        if (Number(b.trailedStopLoss ?? b.stopLoss) > 0) b.lastExchangeSl = Number(b.trailedStopLoss ?? b.stopLoss);
        if (Number(b.t2) > 0) b.lastExchangeTp = Number(b.t2);
        b.slSyncPending = false;
        b.tpSyncPending = false;
        b.slNextRetryAt = 0;
        b.slLastSyncError = null;
      } else {
        // Never claim a tighter stop than the exchange actually accepted.
        b.slSyncPending = true;
        b.slNextRetryAt = now + (Number(slRes?.retryAfterMs) > 0 ? Number(slRes.retryAfterMs) : 60_000);
        b.slLastSyncError = String(slRes?.error || slRes?.readBackError || 'exchange SL unverified').slice(0, 180);
      }
    } catch (e) {
      b.slSyncPending = true;
      b.slNextRetryAt = now + 60_000;
      b.slLastSyncError = String(e?.message || e).slice(0, 180);
    }
  }

  // ---- state machine + telemetry ----
  if (b.t1Hit || tp1Booked) b.superAgentState = 'TP1_SECURED';
  else if (b.superAgentState !== 'MONITORING') b.superAgentState = 'MONITORING';
  b.superAgentLastTickAt = now;

  if (prevStage && deepEval.stageCode !== prevStage && now - rt.lastLogAt >= SUPER_AGENT_LOG_MIN_MS) {
    rt.lastLogAt = now;
    _logEvent('super-stage', `🤖 SUPER AGENT ${b.symbol} ${b.side}: ${deepEval.stageCode} @ ${ltp} (${deepEval.currentR}R) — ${deepEval.stageLabel}`);
  }
  _superAgentPersist(false);

  return {
    ...baseOut,
    ok: true,
    side: b.side,
    state: b.superAgentState,
    action: tp1Booked ? 'TP1_PARTIAL_BOOKED' : trailAction,
    closed: false,
    currentR: deepEval.currentR,
    peakR: deepEval.peakR,
    ltp,
    tp1Hit: Boolean(b.t1Hit),
    tp2Hit: Boolean(deepEval.tp2Hit),
    adverseConfirmed,
    velocityPct: Number(input.velocityPct) || 0,
  };
}

/**
 * Open AUTO-engine rows for the tick router. Deliberately does NOT run the
 * deep monitor / persist — it is a cheap read called on every registry sync.
 */
export function getAutoTradeSuperAgentOpenTrades() {
  const cfg = loadMtfAutoConfig();
  const st = _loadState();
  return st.book
    .filter(b => b && b.status === 'OPEN' && isGenuinelyTradedEntry(b, cfg))
    .filter(b => b.autoTrade === true || b.openedBy === 'AUTO' || b.flipEntry === true)
    .map(b => ({
      symbol: String(b.symbol || '').toUpperCase(),
      market: String(b.market || '').toUpperCase(),
      execMarket: String(b.execMarket || b.market || 'FUTURES').toUpperCase(),
      side: normalizeSide(b.side) || String(b.side || '').toUpperCase(),
      entry: Number(b.entry) || 0,
      t1: Number(b.t1) || 0,
      t2: Number(b.t2) || 0,
      stopLoss: Number(b.trailedStopLoss ?? b.stopLoss) || 0,
      initialStopLoss: Number(b.initialStopLoss ?? b.stopLoss) || 0,
      directionVerified: b.directionVerified === true,
      executionMode: b.executionMode || 'PAPER',
      paperId: b.paperId ?? null,
      openedAt: Number(b.openedAt) || 0,
      holdMin: Number(b.holdMin) || null,
      superAgentState: b.superAgentState || 'ARMED',
      superAgentIdleReason: b.superAgentIdleReason || null,
      ltp: Number(b.ltp) || 0,
      currentR: Number(b.currentR) || 0,
      peakR: Number(b.peakR) || 0,
      atrPct: Number(b.atrPct) || null,
    }));
}

/**
 * Latest CLOSED row for a symbol/market. Shared by the IDLE stamp and the tick
 * router's close-reason lookup.
 */
function _latestClosedBookRow(st, symbol, market = null) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  let target = null;
  for (const b of st.book) {
    if (!b || String(b.symbol || '').toUpperCase() !== sym) continue;
    if (market && String(b.market || '').toUpperCase() !== String(market).toUpperCase()) continue;
    if (b.status !== 'CLOSED') continue;
    if (!target || Number(b.closedAt || b.openedAt || 0) >= Number(target.closedAt || target.openedAt || 0)) target = b;
  }
  return target;
}

/**
 * v21.26.1: the tick router's IDLE telemetry needs the REAL close reason for
 * closes that happened outside mtfAutoSuperAgentManage (exchange SL/TP fill,
 * manual close). Without this, `lastAction` (often SL_TRAILED) was logged as
 * the reason while the book row correctly said EXCHANGE_POSITION_CLOSED.
 */
export function getAutoTradeSuperAgentCloseReason(symbol, market = null) {
  const target = _latestClosedBookRow(_loadState(), symbol, market);
  if (!target) return null;
  return target.closeReason || target.superAgentIdleReason || null;
}

/**
 * Called by the tick router when a trade disappears from the open book. Stamps
 * the CLOSED row so the UI/API can show "agent returned to IDLE" even when the
 * close came from the paper engine / exchange sync (not from the agent itself).
 */
export function markAutoTradeSuperAgentIdle({ symbol, market = null, reason = 'TRADE_CLOSED', state = 'IDLE', at = Date.now() } = {}) {
  const target = _latestClosedBookRow(_loadState(), symbol, market);
  if (!target) return false;
  // Never clobber a precise reason already stamped by the close path
  // (e.g. EXCHANGE_POSITION_CLOSED) with the router's generic fallback.
  const nextReason = target.superAgentIdleReason || reason;
  if (target.superAgentState === state && target.superAgentIdleReason === nextReason) return true;
  target.superAgentState = state;
  target.superAgentIdleReason = nextReason;
  target.superAgentIdleAt = Number(at) || Date.now();
  _superAgentPersist(true);
  return true;
}

/**
 * v21.22.0: Registers a direct live MTF Dual Board order (/api/ai/mtf-dual/live)
 * into the Auto-Trade Deep Monitor book so 15s Signal Recheck & Deep Monitor
 * track its SL trailing, TP1/TP2 progress, and reversal profit-booking in real time.
 */
export function recordLiveMtfBoardTrade(item = {}) {
  const cfg = loadMtfAutoConfig();
  _rollDayIfNeeded();
  const st = _loadState();
  const sym = normalizeLinkSymbol(item.symbol, item.market || 'CRYPTO');
  if (!sym) return null;
  const isPaperExec = String(item.executionMode || 'LIVE').toUpperCase() === 'PAPER';
  const execMode = isPaperExec ? 'PAPER' : 'LIVE';
  // v21.23.13 [SIDE HONESTY — "pakka LONG/SHORT" doctrine]: deep-monitor rows
  // pe silent `|| 'LONG'` default = wrong-side book-keeping ka vector (ek
  // missing side poora SHORT trade LONG ki tarah manage hota — SL polarity
  // inverted). v21.25.0: shared strict vocabulary + unknown pe LOUD THROW.
  const sideNorm = normalizeSide(item.side);
  if (!sideNorm) {
    throw new Error(`recordLiveMtfBoardTrade: invalid side "${item.side}" for ${sym} - LONG/SHORT (ya BUY/SELL) required; silent default v21.23.13 se mana hai (direction-honesty)`);
  }
  const directionCertificate = buildDirectionCertificate({
    symbol: sym,
    market: item.market || 'CRYPTO',
    side: sideNorm,
    activePos: item.activePos ?? item.positionAmt,
    entry: item.entry,
    stopLoss: item.stopLoss,
    t1: item.t1,
    t2: item.t2,
    requireTargets: false,
    directionVerified: item.directionVerified === true,
    source: 'record-live-board-trade',
  });
  const rawBookMarket = String(item.market || 'CRYPTO').toUpperCase();
  const isSimBook = rawBookMarket === 'GLOBALFUTURES' || rawBookMarket === 'EQUITY_SIM';
  const isUsdBook = !isSimBook && rawBookMarket !== 'INDIA';
  const bookMarket = isSimBook ? 'GLOBALFUTURES' : isUsdBook ? 'CRYPTO' : 'INDIA';
  const execMarket = isSimBook ? 'GLOBALFUTURES' : isUsdBook ? 'FUTURES' : 'INDIA';
  const bookCcy = isSimBook ? 'USDC' : isUsdBook ? 'USDT' : 'INR';
  const now = Date.now();
  const existing = st.book.find(b => b.status === 'OPEN' && b.symbol === sym && b.market === bookMarket);
  if (existing) {
    // v21.23.12 [RE-ANCHOR LIFECYCLE RESET]: existing OPEN row par re-anchor
    // sirf LEVELS (entry/SL/T1/T2/qty) update karta tha — side/peakPrice/
    // t1Hit/openedAt/deepMonitorStage/stage-label PURANE row ke rehte the.
    // Do money-class failure: (a) stale t1Hit=true + purana peakPrice →
    // naye LIVE entry par deep monitor turant Stage-4/5 lock → entry ke
    // kuch second baad hi software market-close (fee-loss churn), aur purana
    // openedAt 90s LIVE close-grace firewall ko disarm karta tha; (b) side
    // flip (purana row LONG, naya order SHORT) → SHORT exchange position
    // LONG ki tarah manage hoti — SL-hit logic inverted, wrong-side SL push.
    // Ab naye order ke saath poori lifecycle fresh re-anchors hoti hai.
    //
    // v21.25.3 [RE-ANCHOR MONEY BOOKKEEPING]: levels update hone ke baad
    // derived money fields (risk/notional/margin/dayKey/fee-floor) purane
    // lifecycle ke rehte the. Isse Phase-0 audit stale risk dikhata tha,
    // open-notional budget under-count hota tha (naya bada order cap se
    // bahar), aur fee-aware reversal purane entry ka fee floor use karta
    // tha. Ab har derived field naye entry/qty/SL/fx/leverage se recompute
    // hota hai — naye-row path ke SAME contract se.
    const fxRate = clampN(item.fx ?? cfg.inrPerUsdt, 40, 150, 102);
    const walletINR = Number(item.walletINR) > 0
      ? Number(item.walletINR)
      : (Number(existing.walletINR) > 0 ? Number(existing.walletINR) : (Number(cfg.walletAmountINR) || 10000));
    const leverage = Number(item.leverage) > 0
      ? Number(item.leverage)
      : (Number(existing.leverage) > 0 ? Number(existing.leverage) : computeMtfWalletLeverage(walletINR, cfg));
    const w95 = computeWallet95Deployment({
      walletINR,
      leverage,
      fxRate,
      deployPct: cfg.walletDeployPct ?? 100,
      cfg,
    });
    const deployedWalletINR = Number(item.deployedWalletINR) > 0
      ? Number(item.deployedWalletINR)
      : w95.deployedWalletINR;
    const buyingPowerINR = Number(item.buyingPowerINR) > 0
      ? Number(item.buyingPowerINR)
      : w95.buyingPowerINR;

    existing.executionMode = execMode;
    existing.traded = true;
    existing.fullControl = true;
    existing.side = sideNorm;
    // v21.23.14 [SIM DESK HONESTY]: re-anchored rows must also update their
    // execution domain; a GLOBALFUTURES equity paper row used to keep the old
    // CRYPTO/FUTURES/USDT mapping and lose its quote on the next tick.
    existing.market = bookMarket;
    existing.execMarket = execMarket;
    existing.ccy = bookCcy;
    existing.fxUsed = isUsdBook ? fxRate : null;
    existing.peakPrice = Number(item.entry) > 0 ? Number(item.entry) : (Number(existing.entry) > 0 ? Number(existing.entry) : null);
    existing.t1Hit = false;
    // v21.28.0 [F2]: new lifecycle = fresh TP1 partial latch/telemetry.
    existing.t1PartialBooked = false;
    existing.t1PartialBookedAt = null;
    existing.t1PartialQty = null;
    existing.t1PartialOrderId = null;
    existing.t1PartialVerified = null;
    existing.t1PartialVerifyPending = false;
    existing.t1PartialNextRetryAt = 0;
    existing.t1PartialLastError = null;
    existing.t1PartialAmbiguous = false;
    existing.qtyAfterTp1 = null;
    existing.openedAt = now;
    existing.deepMonitorStage = 'STAGE_0_INITIAL_GUARD';
    existing.deepMonitorLabel = isPaperExec ? 'Stage 0 · Paper Direction Test · SL Auto-Trail Ready' : 'Stage 0 · Initial SL Guard (Full Control)';
    // v21.26.0: re-anchored lifecycle = fresh agent lifecycle.
    existing.superAgentState = 'ARMED';
    existing.superAgentIdleReason = null;
    existing.superAgentTickCount = 0;
    existing.superAgentLastTickAt = null;
    existing.superAgentActions = [];
    existing.superAgentExitPendingAt = 0;
    existing.trendStatus = `📡 ${sideNorm === 'SHORT' ? 'BEARISH' : 'BULLISH'} LIVE WATCH (+0.00R)`;
    existing.closeReason = null;
    existing.closedAt = null;
    existing.pnl = null;
    existing.syncError = null;
    // New lifecycle = new quota provenance. A manual click re-anchoring an
    // AUTO row must not keep eating the auto-engine daily quota.
    existing.openedBy = item.openedBy || 'MANUAL';
    existing.autoTrade = item.autoTrade === true;
    existing.autoEngine = item.autoEngine === true;
    if (Number(item.superScore)) existing.score = Number(item.superScore);
    if (item.tier) existing.tier = item.tier;
    if (Number(item.holdMin) > 0) existing.holdMin = Number(item.holdMin);
    if (item.mode) existing.mode = item.mode;
    // Mode provenance: never carry the previous lifecycle's mirror/order ids
    // into the new one. A PAPER re-anchor used to keep liveOrderId/livePositionId
    // (isLiveSessionEntry then treated the practice row as real money); a LIVE
    // re-anchor could keep a closed paper mirror id. Both are cleared here and
    // only the current mode's ids are stamped.
    if (isPaperExec) {
      existing.openedInLiveMode = false;
      existing.paperId = item.paperId ?? `PAPER_${sym}_${now}`;
      existing.liveOrderId = null;
      existing.livePositionId = null;
    } else {
      existing.openedInLiveMode = true;
      existing.paperId = item.paperId ?? null;
      existing.liveOrderId = item.orderId ?? null;
      existing.livePositionId = item.positionId ?? null;
    }
    existing.activePos = item.activePos ?? item.positionAmt ?? null;
    if (Number(item.entry) > 0) existing.entry = Number(item.entry);
    if (Number(item.qty) > 0) {
      existing.qty = Number(item.qty);
      existing.originalQty = Number(item.qty);
    }
    if (Number(item.stopLoss) > 0) {
      existing.stopLoss = Number(item.stopLoss);
      existing.initialStopLoss = Number(item.stopLoss);
      existing.trailedStopLoss = Number(item.stopLoss);
    } else {
      // No fresh SL supplied: the re-anchored lifecycle must still start from
      // a coherent guard, not a stale trailed level from the old trade.
      existing.initialStopLoss = existing.stopLoss;
      existing.trailedStopLoss = existing.stopLoss;
    }
    if (Number(item.t1) > 0) existing.t1 = Number(item.t1);
    if (Number(item.t2) > 0) existing.t2 = Number(item.t2);
    // The re-anchored order carries its own native TP/SL. Reset rolling-TP2
    // and sync state so a stale "pending" flag from the previous lifecycle
    // cannot re-arm an old target/stop on the new position.
    existing.tpSyncPending = false;
    existing.slSyncPending = false;
    existing.lastExchangeTp = execMode === 'LIVE' && Number(existing.t2) > 0 ? Number(existing.t2) : null;
    existing.lastExchangeSl = execMode === 'LIVE' && Number(existing.stopLoss) > 0 ? Number(existing.stopLoss) : null;
    existing.t2Extensions = 0;
    existing.lastTpExtendAt = null;
    existing.bookedPnl = 0;
    existing.smartTrail = null;
    // Re-anchor is a fresh manual/auto order, not a UC flip-reverse row.
    existing.flipEntry = false;
    existing.flippedFrom = null;
    existing.leverage = leverage;
    existing.walletINR = Math.round(w95.walletTotalINR);
    existing.walletDeployPct = w95.walletDeployPct;
    existing.deployedWalletINR = +deployedWalletINR.toFixed(2);
    existing.deployedWalletUSDT = isUsdBook ? +(deployedWalletINR / fxRate).toFixed(4) : w95.deployedWalletUSDT;
    existing.buyingPowerINR = +buyingPowerINR.toFixed(2);
    existing.buyingPowerUSDT = isUsdBook ? +(buyingPowerINR / fxRate).toFixed(4) : w95.buyingPowerUSDT;
    existing.orderSide = sideNorm === 'LONG' ? 'buy' : 'sell';

    const nextEntry = Number(existing.entry) || 0;
    const nextQty = Number(existing.qty) || 0;
    const nextSl = Number(existing.stopLoss) || 0;
    const riskPerUnit = Math.abs(nextEntry - nextSl);
    existing.marginINR = +(nextQty * nextEntry * (isUsdBook ? fxRate : 1) / leverage).toFixed(2);
    existing.marginUsdt = isUsdBook ? +(nextQty * nextEntry / leverage).toFixed(4) : null;
    existing.riskINR = +(nextQty * riskPerUnit * (isUsdBook ? fxRate : 1)).toFixed(2);
    existing.riskUsdt = isUsdBook ? +(nextQty * riskPerUnit).toFixed(4) : null;
    existing.notional = +(nextQty * nextEntry * (isUsdBook ? fxRate : 1)).toFixed(2);
    existing.notionalUsdt = isUsdBook ? +(nextQty * nextEntry).toFixed(4) : null;
    existing.feeBreakevenPrice = feeBreakevenFloor({ entry: nextEntry, side: sideNorm, market: execMarket });
    existing.dayKey = dayKeyFor(execMarket, new Date(now));

    existing.directionCertificate = buildDirectionCertificate({
      symbol: sym,
      market: bookMarket,
      side: sideNorm,
      activePos: item.activePos ?? item.positionAmt,
      entry: existing.entry,
      stopLoss: existing.initialStopLoss ?? existing.stopLoss,
      t1: existing.t1,
      t2: existing.t2,
      requireTargets: false,
      directionVerified: item.directionVerified === true,
      source: 'record-live-board-trade',
    });
    // A real LIVE re-anchor is a fresh execution — count it exactly like the
    // new-row path. PAPER practice clicks never consume the quota.
    if (!isPaperExec) st.dayCount += 1;
    st.perSymbolLast[sym] = now;
    _persistState();
    return existing;
  }
  const entry = Number(item.entry) || 0;
  const sl = Number(item.stopLoss) || 0;
  const t1 = Number(item.t1) || 0;
  const t2 = Number(item.t2) || 0;
  const qty = Number(item.qty) || 1;
  const fxRate = clampN(item.fx ?? cfg.inrPerUsdt, 40, 150, 102);
  const leverage = Number(item.leverage) || computeMtfWalletLeverage(item.walletINR || cfg.walletAmountINR, cfg);
  const w95 = computeWallet95Deployment({
    walletINR: item.walletINR || cfg.walletAmountINR,
    leverage,
    fxRate,
    deployPct: cfg.walletDeployPct ?? 100,
    cfg,
  });
  const feeBePrice = feeBreakevenFloor({ entry, side: sideNorm, market: execMarket });
  const riskPerUnit = Math.abs(entry - sl);
  const rec = {
    paperId: item.paperId ?? (isPaperExec ? `PAPER_${sym}_${now}` : null),
    liveOrderId: item.orderId ?? null,
    livePositionId: item.positionId ?? null,
    executionMode: execMode,
    traded: true,
    fullControl: true,
    openedInLiveMode: !isPaperExec,
    // v21.25.1: manual board click provenance — PAPER clicks practice hain,
    // auto quota consume nahi karte. Caller explicit `openedBy:'AUTO'` bhej
    // sakta hai (e.g. future auto path reusing this recorder).
    openedBy: item.openedBy || 'MANUAL',
    autoTrade: item.autoTrade === true,
    symbol: sym,
    market: bookMarket,
    execMarket,
    ccy: bookCcy,
    fxUsed: isUsdBook ? fxRate : null,
    side: sideNorm,
    orderSide: sideNorm === 'LONG' ? 'buy' : 'sell',
    activePos: item.activePos ?? item.positionAmt ?? null,
    directionCertificate,
    score: item.superScore ?? 85,
    tier: item.tier || 'ELITE',
    mode: item.mode || cfg.mode || 'INTRADAY',
    holdMin: Number(item.holdMin) || cfg.holdMin || 45,
    entry,
    stopLoss: sl,
    initialStopLoss: sl,
    trailedStopLoss: sl,
    peakPrice: entry,
    t1,
    t2,
    lastExchangeTp: execMode === 'LIVE' && t2 > 0 ? t2 : null,
    lastExchangeSl: execMode === 'LIVE' && sl > 0 ? sl : null,
    slSyncPending: false,
    tpSyncPending: false,
    qty,
    leverage,
    walletINR: Math.round(w95.walletTotalINR),
    walletDeployPct: w95.walletDeployPct,
    deployedWalletINR: w95.deployedWalletINR,
    deployedWalletUSDT: w95.deployedWalletUSDT,
    buyingPowerINR: w95.buyingPowerINR,
    buyingPowerUSDT: w95.buyingPowerUSDT,
    feeBreakevenPrice: feeBePrice,
    deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
    deepMonitorLabel: isPaperExec ? 'Stage 0 · Paper Direction Test · SL Auto-Trail Ready' : 'Stage 0 · Initial SL Guard (Full Control)',
    trendStatus: `📡 ${sideNorm === 'SHORT' ? 'BEARISH' : 'BULLISH'} LIVE WATCH (+0.00R)`,
    marginINR: +(qty * entry * (isUsdBook ? fxRate : 1) / leverage).toFixed(2),
    marginUsdt: isUsdBook ? +(qty * entry / leverage).toFixed(4) : null,
    riskINR: +(qty * riskPerUnit * (isUsdBook ? fxRate : 1)).toFixed(2),
    riskUsdt: isUsdBook ? +(qty * riskPerUnit).toFixed(4) : null,
    notional: +(qty * entry * (isUsdBook ? fxRate : 1)).toFixed(2),
    notionalUsdt: isUsdBook ? +(qty * entry).toFixed(4) : null,
    openedAt: now,
    dayKey: dayKeyFor(execMarket),
    status: 'OPEN',
    closeReason: null,
    closedAt: null,
    pnl: null,
    drivers: [isPaperExec ? 'Paper Direction Follow-Through Test + Ultra-Fast SL Trail' : 'Direct Live Order (100% Wallet + Full Position Control)'],
  };
  st.book.push(rec);
  // v21.23.13 [PAPER-QUOTA POISONING CURE]: manual PAPER board clicks auto
  // engine ka daily trade-quota (dayCount) consume karte the — 5 paper test
  // clicks = paper-mode quota (5) khatam = AUTO engine baaki din structurally
  // dead, jabki ek bhi AUTO trade nahi hua tha ('auto trade lag hi nahi raha'
  // complaint ka ek seedha vector). Ab quota sirf REAL executions khate hain:
  // manual LIVE click (real-money budget) + mtfAutoTick ki apni entry path
  // (wahan apna stx.dayCount += 1 hai). Manual PAPER click = practice,
  // budget nahi.
  if (!isPaperExec) st.dayCount += 1;
  st.perSymbolLast[sym] = now;
  _persistState();
  _logEvent(
    isPaperExec ? 'paper-entry' : 'live-entry',
    `${execMode} ORDER REGISTERED IN DEEP MONITOR: ${sym} ${rec.side} @ ${entry} · SL ${sl} · T1 ${t1} · T2 ${t2} · ${leverage}x (${w95.walletDeployPct}% Wallet ₹${w95.deployedWalletINR})`
  );
  return rec;
}

export function recordPaperMtfBoardTrade(item = {}) {
  return recordLiveMtfBoardTrade({ ...item, executionMode: 'PAPER' });
}

/** Test/auth hook — full reset (config bhi). */
export function __resetMtfAutoForTests(seed = null) {
  _cfg = null;
  _state = null;
  _mtfAutoTickInFlight = false;
  _bootedAt = Date.now();
  _deepMonitorHb = _freshDeepMonitorHb();
  _restoredFromDurable = false;
  _restoredConfigFromDurable = false;
  _restoredStateFromDurable = false;
  _cfgSavedAt = null;
  _bootPersistenceReady = true;
  if (_bootPersistenceTimer) { clearTimeout(_bootPersistenceTimer); _bootPersistenceTimer = null; }
  _lastBoardRowSeenMap.clear(); // v21.23.10: board-rotation snapshot cache bhi module state hai
  _superAgentExitLocks.clear();
  _superAgentRuntime.clear();
  _superAgentLastPersistAt = 0;
  __resetDirectionLocksForTests();
  try { fs.unlinkSync(CFG_FILE()); } catch { /* absent */ }
  try { fs.unlinkSync(STATE_FILE()); } catch { /* absent */ }
  if (seed?.config) {
    // v21.29.0 [R2 TEST FIXTURE]: suites that seed `executionMode:'live'` are
    // explicitly testing live execution, so they also imply the operator's
    // typed risk acknowledgement unless the test says otherwise (pass
    // riskCapsAcknowledged:false to test the blocker itself). Production is
    // never affected — this helper is test-only.
    const seeded = { ...MTF_AUTO_DEFAULTS, ...seed.config, desks: { ...MTF_AUTO_DEFAULTS.desks, ...(seed.config.desks || {}) } };
    if (String(seeded.executionMode || '').toLowerCase() === 'live') {
      if (seed.config.riskCapsAcknowledged === undefined) {
        seeded.riskCapsAcknowledged = true;
        seeded.riskCapsAckPhrase = RISK_ACK_PHRASE;
        seeded.riskCapsAckAt = seeded.riskCapsAckAt || Date.now();
      } else if (seed.config.riskCapsAcknowledged === true && !seeded.riskCapsAckPhrase) {
        seeded.riskCapsAckPhrase = RISK_ACK_PHRASE;
      }
    }
    _cfg = _sanitizeCfg(seeded);
    _save(CFG_FILE(), _cfg);
  }
  if (seed?.state) { _state = { day: seed.state.day ?? null, dayCount: seed.state.dayCount ?? 0, perSymbolLast: seed.state.perSymbolLast || {}, failedLiveAttempts: seed.state.failedLiveAttempts || {}, shadowStats: seed.state.shadowStats || {}, book: seed.state.book || [], events: [], lastTick: null }; _save(STATE_FILE(), _state); }
}
