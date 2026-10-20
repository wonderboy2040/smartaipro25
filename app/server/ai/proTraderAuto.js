// ============================================================
//  SUPERINTELLIGENCE ADVANCE AI PRO TRADER AUTO (SAPTA)
//  v18.6 — auto-trade engine driven by the USER's open browser.
//
//  USER SPEC (exact):
//   * Auto trades ONLY when: AI score >= 75, confidence >= 65,
//     verified score >= 90 (SVA CONFIRM, finalCall matches side)
//     — LONG or SHORT both allowed.
//   * Executes INSIDE the user's already-open logged-in browser
//     tabs (CoinDCX + Dhan) via the CDP browserAgent:
//     search symbol -> set entry price -> apply leverage ->
//     place trade -> monitor from backend.
//   * Continuous data analysis for REVERSAL; close the trade
//     ONLY when reversal is CONFIRMED SURE (2 consecutive
//     confirmations; SL closes immediately).
//
//  Safety:
//   * OFF by default. Paper mode default. LIVE requires typed
//     phrase "LIVE". Global kill-switch (ai-trading-config.json)
//     always respected. Nothing auto-deletes; every action
//     journaled + screenshot on every browser order.
//   * Pure gate/reversal functions are exported for tests.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { loadJSON, saveJSON, DATA_DIR } from '../lib/store.js';
import {
  browserConnect, browserStatus, cxPairUrl,
  cxEnsureTradePage, cxSelectPair, cxPlaceOrder, cxClosePosition, cxReadPositions,
  dhanEnsurePage, dhanSelectScrip, dhanPlaceOrder, dhanClosePosition, dhanReadPositions,
} from './browserAgent.js';
import { getTick } from '../liveFeed.js';
import { fetchCoinDcxTickers } from '../cryptoStream.js';
// v18.9: shared NSE holiday calendar (pure module — no cycle)
import { isNseHoliday } from '../intraday/time.js';
// v20.9.0 (H1 — audit): SAPTA ab SHARED HARD RISK GATE se guzarta hai
// (wahi jo Bot Lab use karta hai) + event-day guard + cost-aware ranking.
import { hardGateCheck, currentLossStreak, drawdownFromPeakPct as _drawdownFromPeakPct } from '../risk/hardGate.js';
import { eventGuardCheck } from './eventGuard.js';
import { estimateRoundTripCost } from './tradingCosts.js';
import { walletLeverageForEquityINR, feeBreakevenFloor } from '../exec/sizing.js';
import { acquireDirectionLock, checkDirectionLock } from './directionLock.js';

export const PROTRADER_TICK_SEC = 30;
const CFG_FILE = 'protrader-auto-config.json';
const JOURNAL_FILE = 'protrader-auto-journal.json';
const TRADING_CFG_FILE = 'ai-trading-config.json';
const LOG_MAX = 300;
const REVERSAL_CONFIRM_NEEDED = 2; // "confirm sure hoke close" — consecutive ticks
// v20.7.10: PLACED (unfilled limit) rows itne minute baad UNFILLED me
// retire hote hain — warna maxConcurrent slots permanently block ho jate
// the (positionManager ka entryLimitTtlSec=180s SAPTA ke liye kabhi lagta
// hi nahi tha). 15 min = pullback-limit plans ko reasonable fill window.
const PLACED_TTL_MIN = 15;

export const PROTRADER_DEFAULTS = {
  enabled: false,
  mode: 'paper',                 // 'paper' | 'live'
  // ---- USER SPEC GATES ----
  minAiScore: 75,
  minConfidence: 65,
  // v20.8.5: 90 → 70. SVA-v1 ki 10-check weighted scoring (weights sum
  // 100) realistically 80-88 tak hi pahunchti hai ek ACHHE signal par
  // bhi — MTF WARN −6, entryBand WARN −3, perpCrowd WARN −3 akele
  // 12 point kha jaate hain. SVA ka apna CONFIRM verdict score ≥ 68 +
  // zero core-fails + finalCall===side maangta hai — wahi asli pro
  // gate hai. Purana 90 bar SAPTA ko effectively DEAD rakhta tha
  // (candidates panel me har signal 'verified:8x<90' pe mar jata tha).
  // 70 = CONFIRM floor (68) + chhota buffer. requireVerifyConfirm ab
  // bhi CONFIRM + finalCall match enforce karta hai.
  minVerifiedScore: 70,
  requireVerifyConfirm: true,    // SVA action must be CONFIRM + finalCall === side
  // ---- desks ----
  desks: { crypto: true, india: true },
  // v19.0 USER SPEC: "Coindcx tab me auto trading sirf Global Futures
  // USDT & Equity SIM USDC me — Spot me nahi". SAPTA's crypto desk
  // therefore trades the CoinDCX FUTURES board (B-{SYM}_USDT,
  // USDT-margined) by default. 'spot' restores the legacy v18.6
  // {SYM}INR spot flow (explicit user opt-in via config).
  cryptoProduct: 'futures',          // 'futures' (default) | 'spot' (legacy)
  // ---- sizing ----
  stakeINR: 500,                 // per trade (crypto total / india order value)
  cryptoLeverage: 3,
  indiaProduct: 'MTF',           // 'MTF' | 'INTRADAY' | 'DELIVERY' (leverage = MTF)
  // ---- caps ----
  maxConcurrent: 3,
  maxTradesPerDay: 6,
  cooldownMin: 30,               // per symbol
  // ---- v20.9.0 (H1 — audit): HARD RISK GATE caps ----
  // Pehle SAPTA ke paas SIRF maxConcurrent/maxTradesPerDay/cooldown/
  // killSwitch the — koi daily-loss halt, drawdown stop ya loss-streak
  // pause NAHI tha (botRisk wale saare gates bypass). Ab shared
  // hardGate.js (server/risk/) se wahi checks SAPTA pe bhi lagte hain.
  maxDailyLossINR: null,          // null → 3 × stakeINR (order-of-magnitude brake)
  maxConsecutiveLosses: 3,        // aaj 3 loss pe tilde → din bhar pause
  maxDrawdownKillPct: 10,         // cumulative realized PnL ke PEAK se
  // ---- reversal exit ----
  minReversalConf: 65,           // ensemble deep side flipped + conf >= this
  minMtfAgreePct: 62,            // MTF-6 consensus flipped + agreement >= this
  slImmediate: true,             // plan SL hit -> close now (no double-confirm)
  // ---- v20.8.5 TP PROFIT-BOOKING EXITS (user spec: "auto profit TP 1 or
  // TP 2 pe profit book karke exit") ----
  // TP1 hit: PAPER me tp1ClosePct% partial book + SL breakeven-lock;
  // LIVE me (CDP full-close only hai — partial qty input ka reliable
  // primitive nahi) SL breakeven-lock + honest alert, runner TP2 tak.
  // TP2 hit: FULL close — "profit booked, exit".
  tpExitsEnabled: true,
  tp1ClosePct: 50,               // % of position booked at TP1 (paper partial)
  tp1BreakevenLock: true,        // TP1 ke baad SL -> entry (runner risk-free)
  // ---- misc ----
  monitorEveryTicks: 1,
};

const CLAMPS = {
  minAiScore: [50, 95], minConfidence: [50, 95], minVerifiedScore: [50, 100],
  // v20.9.0 (H1 — audit "Clamps tighten"): stakeINR max 100000 → ab
  // 5000 (real comfort default) aur cryptoLeverage max 10 → 5 jab tak
  // live track-record nahi banta. Upper env se override ho sakta hai
  // (SAPTA_MAX_STAKE_INR / SAPTA_MAX_LEVERAGE) — explicit opt-in,
  // config file me nahi (ek jagah sahi rakhne ke liye).
  stakeINR: [100, 5000], cryptoLeverage: [1, 5], maxConcurrent: [1, 10],
  maxTradesPerDay: [1, 50], cooldownMin: [5, 720], minReversalConf: [50, 95],
  minMtfAgreePct: [50, 95], tp1ClosePct: [10, 90],
  maxConsecutiveLosses: [1, 10], maxDrawdownKillPct: [1, 50],
};

/** v20.9.0 (H1): env-overridable clamp CEILINGS (explicit opt-in).
 *  SAPTA_MAX_STAKE_INR=20000 → stakeINR clamp [100, 20000]. */
function clampCeilings() {
  const c = { stake: 5000, leverage: 5 };
  const st = Number(process.env.SAPTA_MAX_STAKE_INR);
  const lv = Number(process.env.SAPTA_MAX_LEVERAGE);
  if (Number.isFinite(st) && st >= 100 && st <= 100000) c.stake = st;
  if (Number.isFinite(lv) && lv >= 1 && lv <= 10) c.leverage = lv;
  return c;
}

// ---------------- config / journal ----------------
export function loadProTraderConfig() {
  const saved = loadJSON(CFG_FILE, {}) || {};
  const cfg = { ...PROTRADER_DEFAULTS, ...(saved.config || saved) };
  if (saved && !saved.config) saveProTraderConfig(cfg);
  // v20.9.0 (H1): clamp ceilings ek baar resolve (env override ke saath)
  const CEIL = clampCeilings();
  for (const [k, [lo, hi]] of Object.entries(CLAMPS)) {
    const max = k === 'stakeINR' ? CEIL.stake : k === 'cryptoLeverage' ? CEIL.leverage : hi;
    // v20.9.1 [M]: hand-edited NON-NUMERIC value (NaN/'abc') pehle AS-IS
    // pass hota tha — Math.floor(NaN/entry) < 1 FALSE hai, NaN qty order
    // path tak ja sakti thi. Ab non-finite → DEFAULT restore (fail-safe).
    if (Number.isFinite(Number(cfg[k]))) cfg[k] = Math.min(max, Math.max(lo, Number(cfg[k])));
    else cfg[k] = PROTRADER_DEFAULTS[k];
  }
  // v20.9.0 (H1): saved 100000-stake configs ek baar honest 5000 pe uthte
  // hain (purana loose clamp tha); user FIR se badhana chahe to env ceiling
  // ke saath kar sakta hai (upar dekho — explicit opt-in).
  if (!cfg.__migrations?.v20_9_0 && Number(cfg.stakeINR) > CEIL.stake) {
    cfg.stakeINR = CEIL.stake;
    cfg.__migrations = { ...(cfg.__migrations || {}), v20_9_0: true };
  } else if (!cfg.__migrations?.v20_9_0) {
    cfg.__migrations = { ...(cfg.__migrations || {}), v20_9_0: true };
  }
  // v20.9.0 (H1): maxDailyLossINR null → 3 × stake (order-of-magnitude
  // brake — ₹500 stake pe ₹1500 aaj ka max loss, phir entries band).
  if (!(Number(cfg.maxDailyLossINR) > 0)) cfg.maxDailyLossINR = Math.round(3 * Number(cfg.stakeINR || 500));
  if (!['paper', 'live'].includes(cfg.mode)) cfg.mode = 'paper';
  if (!['MTF', 'INTRADAY', 'DELIVERY', 'MARKET'].includes(cfg.indiaProduct)) cfg.indiaProduct = 'MTF';
  // v19.0 migration (USER SPEC, spot-off): a saved config without
  // cryptoProduct rises to the new default 'futures' — ONCE (stamp).
  // A user who deliberately sets 'spot' afterwards keeps it.
  if (!cfg.__migrations?.v19_0 || cfg.cryptoProduct == null) {
    if (cfg.cryptoProduct == null) cfg.cryptoProduct = 'futures';
    cfg.__migrations = { ...(cfg.__migrations || {}), v19_0: true };
  }
  // v20.8.5 migration: purane default 90 wale saved configs (jo kabhi
  // user ne manually set kiye hi nahi the — DEFAULT the) ek baar 70 pe
  // uthte hain. User baad me khud 90 set kare to __migrations stamp ke
  // baad wale saves kabhi touch nahi hote.
  if (!cfg.__migrations?.v20_8_5 && Number(cfg.minVerifiedScore) === 90) {
    cfg.minVerifiedScore = 70;
    cfg.__migrations = { ...(cfg.__migrations || {}), v20_8_5: true };
  } else if (!cfg.__migrations?.v20_8_5) {
    cfg.__migrations = { ...(cfg.__migrations || {}), v20_8_5: true };
  }
  // v21.0.5 migration (USER SPEC, spot desk removed): the SPOT desk is
  // GONE from the CoinDCX tab and the UI toggle with it — a legacy saved
  // 'spot' product would keep SAPTA on an invisible desk forever. One
  // time, any explicit 'spot' rises to 'futures' (v19.0 stamp add kiya
  // tha sirf null ke liye; ye stamp naye hai — dono idempotent hain).
  if (cfg.cryptoProduct === 'spot' && !cfg.__migrations?.v21_0_5) {
    cfg.cryptoProduct = 'futures';
    cfg.__migrations = { ...(cfg.__migrations || {}), v21_0_5: true };
  }
  if (cfg.cryptoProduct !== 'spot') cfg.cryptoProduct = 'futures';
  cfg.enabled = Boolean(cfg.enabled);
  cfg.desks = { ...PROTRADER_DEFAULTS.desks, ...(cfg.desks || {}) };
  return cfg;
}

export function saveProTraderConfig(cfg) {
  saveJSON(CFG_FILE, { config: cfg, savedAt: Date.now() });
}

export function updateProTraderConfig(patch = {}) {
  const cfg = loadProTraderConfig();
  const next = { ...cfg };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in PROTRADER_DEFAULTS) && k !== 'enabled' && k !== 'mode') continue;
    if (k === 'mode') continue; // start/stop own mode; typed LIVE phrase required
    if (k === 'enabled') continue; // start/stop own enabled
    if (typeof PROTRADER_DEFAULTS[k] === 'boolean') next[k] = Boolean(v);
    else if (typeof PROTRADER_DEFAULTS[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) next[k] = n; }
    else if (k === 'desks' || k === 'indiaProduct') next[k] = v;
    else if (k === 'cryptoProduct') {
      // v21.0.6 [audit m3]: SPOT desk v21.0.5 me REMOVE ho chuka hai —
      // manual config API se bhi 'spot' accept nahi hota (SAPTA mara hua
      // desk pe phase na ho). Legacy saved 'spot' v21_0_5 migration me
      // 'futures' ban chuka hai; yahan explicit 'spot' → 'futures' normalize.
      next[k] = 'futures';
    }
  }
  const CEIL = clampCeilings();
  for (const [k, [lo, hi]] of Object.entries(CLAMPS)) {
    const max = k === 'stakeINR' ? CEIL.stake : k === 'cryptoLeverage' ? CEIL.leverage : hi;
    if (Number.isFinite(Number(next[k]))) next[k] = Math.min(max, Math.max(lo, Number(next[k])));
  }
  if (!(Number(next.maxDailyLossINR) > 0)) next.maxDailyLossINR = Math.round(3 * Number(next.stakeINR || 500));
  saveProTraderConfig(next);
  return next;
}

let _jCache = null;
let _jMtime = -1;
let _jSize = -1;
function _journal() {
  // v20.7.4 FIX: pehle har _trades() call readFileSync + JSON.parse
  // kar raha tha (ek tick me 4-6 baar — 400-trade journal MB-scale
  // ho sakta hai) — event-loop freeze ka contributor. Ab mtime-checked
  // cache: statSync (microseconds) se file badli ya nahi verify hota,
  // sirf badle par re-read hota hai (external writes — tests / dusra
  // process — turant dikhte hain, TTL race nahi).
  const p = path.join(DATA_DIR, JOURNAL_FILE);
  try {
    // v20.7.10 FIX (same-ms rewrite race): mtimeMs akela kaafi nahi — do
    // alag writes ek hi millisecond me land kar sakti hain (fast SSD /
    // tests) aur tab stale cache purana journal serve karta tha (external
    // journal reset ke baad bhi purani rows ke cooldowns entries ko
    // block karte the). Ab mtime + SIZE dono compare — same-ms me bhi
    // content-length badla to re-read hota hai (journal append hamesha
    // badhta hai; overwrite bhi length badalta hai — realistic collision
    // practically impossible).
    const st = fs.statSync(p);
    if (_jCache && st.mtimeMs === _jMtime && st.size === _jSize) return _jCache;
    _jCache = loadJSON(JOURNAL_FILE, { trades: [] }) || { trades: [] };
    _jMtime = st.mtimeMs;
    _jSize = st.size;
  } catch {
    // file abhi nahi bani — fallback load (JSON.parse + merge) ek hi baar
    if (!_jCache) _jCache = loadJSON(JOURNAL_FILE, { trades: [] }) || { trades: [] };
    _jMtime = -1;
    _jSize = -1;
  }
  return _jCache;
}
function _saveJournal(j) {
  _jCache = j;
  saveJSON(JOURNAL_FILE, j);
  // v20.7.12 [H3-2]: mtime ke saath SIZE bhi update karo — v20.7.4 ka
  // mtime+size cache _saveJournal ke baad DEFEAT ho jata tha (sirf _jMtime
  // set hota tha, _jSize purana reh jata tha) → har monitor-pass ka
  // _updTrade ek FULL sync re-read + re-parse trigger karta tha (N trades
  // per tick = N parses — the very freeze class the cache targets).
  try {
    const st = fs.statSync(path.join(DATA_DIR, JOURNAL_FILE));
    _jMtime = st.mtimeMs;
    _jSize = st.size;
  } catch { _jMtime = -1; _jSize = -1; }
}
function _trades() { return _journal().trades || []; }

// ---------------- IST clock ----------------
export function istNow() {
  const now = new Date();
  return new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60_000);
}
export function indiaMarketOpen(nowIst = istNow()) {
  const m = nowIst.getHours() * 60 + nowIst.getMinutes();
  if (nowIst.getDay() !== 0 && nowIst.getDay() !== 6 && m >= 9 * 60 + 30 && m <= 15 * 60) {
    // v18.9: weekday NSE holidays (Republic Day / Diwali / …) — the browser
    // agent used to try trading a closed market and burn attempts on
    // broker rejects. Shares the intraday/time.js calendar.
    try { return !isNseHoliday(nowIst); } catch { return true; } // fail-open (old behavior)
  }
  return false;
}
function indiaSquareOffDue(nowIst = istNow()) {
  return nowIst.getDay() >= 1 && nowIst.getDay() <= 5 && (nowIst.getHours() * 60 + nowIst.getMinutes()) >= 15 * 60 + 15;
}

// ---------------- PURE: the USER-SPEC gate ----------------
export function proTraderGate(sig, cfg = PROTRADER_DEFAULTS) {
  const reasons = [];
  if (!sig) { reasons.push('no-signal'); return { pass: false, reasons }; }
  const ai = Number(sig?.superIntel?.aiScore ?? 0);
  const conf = Number(sig?.confidence ?? 0);
  const verify = sig?.verify || {};
  const vScore = Number(verify.score ?? 0);
  const side = sig?.side;

  if (!['LONG', 'SHORT'].includes(side)) reasons.push('side:' + (side || 'FLAT'));
  if (sig?.grade !== 'STRONG') reasons.push('grade:' + (sig?.grade || 'NONE'));
  if (!sig?.plan?.entry) reasons.push('no-plan-entry');
  if (ai < cfg.minAiScore) reasons.push(`aiScore:${ai}<${cfg.minAiScore}`);
  if (conf < cfg.minConfidence) reasons.push(`conf:${conf}<${cfg.minConfidence}`);
  if (vScore < cfg.minVerifiedScore) reasons.push(`verified:${vScore}<${cfg.minVerifiedScore}`);
  if (cfg.requireVerifyConfirm) {
    if (verify.action !== 'CONFIRM') reasons.push('verify:' + (verify.action || 'NONE'));
    if (verify.finalCall !== side) reasons.push(`finalCall:${verify.finalCall || '?'}!=${side}`);
  }
  // v20.9.2 UCV-A1 GATE — the realtime ultrafast chart verdict. A
  // REJECTED direction (signal LONG but the 1m tape actively DOWN —
  // the user's exact "long bola par short gaya" mismatch class) must
  // NEVER become an auto-entry. PENDING/CONFIRMED pass (the 80+
  // recheck loop re-stamps verdicts every board cycle, and the signal
  // itself was already demoted to WATCH if the micro chart rejected
  // it — this gate is the second, execution-side lock).
  const uc = sig?.ultrafast || null;
  if (uc?.verdict === 'REJECTED') {
    reasons.push(`ultrafast:REJECTED(micro ${uc.microDirection} ${uc.score ?? '?'}/100)`);
  }
  // v18.6.4: `executable` sirf CRYPTO/FUTURES/GLOBALFUTURES seats set hota
  // hai (ensemble.js) — INDIA STRONG signals pe ye hamesha false tha, is
  // liye India desk kabhi trade hi nahi kar pata tha. INDIA ke liye gate
  // grade STRONG + plan + side (upar enforce) par chalta hai.
  if (sig?.executable === false && String(sig?.market || '').toUpperCase() !== 'INDIA') reasons.push('not-executable');
  // v21.23.10 [V21.23.4 PARITY]: dataDegraded signals (FRESH-TAPE-ABSENT /
  // INTRADAY-TF-THIN) agent.js Engine A/C + indiaAgent dono me blocked hain
  // — SAPTA gate me ye check KABHI tha hi nahi (grep-verified) → banned
  // 29%-WR degenerate class ek engine par blocked, dusre par TRADABLE.
  if (sig?.dataDegraded) reasons.push('data-degraded:' + sig.dataDegraded);
  if (sig?.symbol && (side === 'LONG' || side === 'SHORT')) {
    const dirLock = checkDirectionLock(sig.symbol, side);
    if (dirLock && !dirLock.allowed) reasons.push(`direction-lock:${dirLock.lockedSide}`);
  }
  return { pass: reasons.length === 0, reasons, score: { ai, conf, verified: vScore } };
}

// ---------------- v20.9.0 PURE: SAPTA HARD RISK GATE (H1) ----------------
/** Journal se aaj ka risk-state (PURE — tests direct rows de sakte hain):
 *  • dailyPnl      aaj ke CLOSED trades ka net P&L + open positions ka
 *                  unrealized (lastPnlINR) — dono milake
 *  • lossStreak     aaj ke closed trades ka trailing loss-streak
 *  • peakCum/cum    cumulative realized PnL ka peak/current (drawdown
 *                  basis — start-se nahi, PEAK se)
 */
export function saptaRiskState(trades, { day, now: _now = Date.now(), cumStats = null } = {}) {
  const list = Array.isArray(trades) ? trades : [];
  const todayKey = day || _todayIST();
  const closedToday = list.filter((t) => t?.day === todayKey && t?.status === 'CLOSED');
  const realizedToday = closedToday.reduce((a, t) => a + (Number(t.closed?.pnlINR) || 0), 0);
  // v20.9.1 [M]: UNFILLED rows ka lastPnlINR stale/meaningless hai (fill
  // hua hi nahi) — daily-loss me uska inclusion jhootha halt kar sakta tha.
  const openUnreal = list
    .filter((t) => ['MONITORING', 'PLACED', 'CLOSE_UNKNOWN'].includes(t?.status))
    .reduce((a, t) => a + (Number(t.lastPnlINR) || 0), 0);
  // cumulative realized PnL curve (all time) → peak/current
  // v20.9.1 [M]: 400-row journal TRIM ke baad cum-curve reset ho jata tha
  // — historical peak gaya aur maxDrawdownKillPct purane peaks ke against
  // kabhi arm nahi karta tha. cumStats seed (_saveTrade ka running fold)
  // wahi memory zinda rakhta hai.
  const closedAll = list.filter((t) => t?.status === 'CLOSED');
  let cum = Number(cumStats?.cum) || 0;
  let peak = Math.max(Number(cumStats?.peak) || 0, 0);
  const byClose = [...closedAll].sort((a, b) => (a.closed?.ts || 0) - (b.closed?.ts || 0));
  for (const t of byClose) { cum += Number(t.closed?.pnlINR) || 0; if (cum > peak) peak = cum; }
  const streak = currentLossStreak({
    settled: closedToday.map((t) => ({ closedTs: t.closed?.ts || 0, pnl: Number(t.closed?.pnlINR) })),
    sinceTs: 0,
  });
  return {
    dailyPnl: Math.round(realizedToday + openUnreal),
    realizedToday: Math.round(realizedToday),
    openUnreal: Math.round(openUnreal),
    lossStreak: streak,
    peakCum: Math.round(peak),
    cum: Math.round(cum),
    openCount: list.filter((t) => ['MONITORING', 'PLACED', 'CLOSE_UNKNOWN'].includes(t?.status)).length,
    tradesToday: list.filter((t) => t?.day === todayKey && !['FAILED', 'UNFILLED'].includes(t?.status)).length,
  };
}

/** SAPTA ka shared-gate verdict (PURE — hardGateCheck wrapper).
 *  max_open / trades/day / kill_switch tick loop pehle hi check karta
 *  hai — yahan WOHI bhi pass hote hain taaki gate ek hi jagah ho
 *  (audit A1 "SAPTA aur Bot Lab dono ek hi gate se guzarte hain").
 *  Drawdown SAPTA ka cumulative-realized-PnL curve pe hota hai (koi
 *  equity account nahi) — isliye wahi reason yahan compute hota hai,
 *  hardGate ke baki saare checks shared chipkaaye gaye. */
export function proTraderHardGate({ trades, cumStats = null, cfg = PROTRADER_DEFAULTS, day = null, now = Date.now(), eventBlocked = false, eventLabel = null, scanAgeSec = null, killSwitch = false }) {
  const s = saptaRiskState(trades, { day, now, cumStats });
  const verdict = hardGateCheck({
    killSwitch,
    dailyPnl: s.dailyPnl,
    maxDailyLoss: Number(cfg.maxDailyLossINR) > 0 ? Number(cfg.maxDailyLossINR) : 3 * (Number(cfg.stakeINR) || 500),
    openCount: s.openCount, maxOpen: Number(cfg.maxConcurrent),
    lossStreak: s.lossStreak, maxConsecutiveLosses: Number(cfg.maxConsecutiveLosses),
    eventBlocked, eventLabel,
    scanAgeSec, maxScanAgeSec: PROTRADER_TICK_SEC * 3,
  });
  // drawdown on the cumulative REALIZED PnL curve, from its PEAK —
  // "jitna upar gaya usi se kitna gir gaya" (give-back rule). Rule sirf
  // TAB arm hota hai jab peak >= ek stake ka meaningful profit cushion
  // bana ho (chhote early profits pe 10% noise-trigger hypersensitive
  // hota); pre-profit phase me daily-loss + loss-streak rules own karte
  // hain.
  const armed = s.peakCum >= (Number(cfg.stakeINR) || 500);
  const ddPct = armed
    ? ((s.peakCum - s.cum) / s.peakCum) * 100
    : 0;
  if (ddPct >= Number(cfg.maxDrawdownKillPct)) {
    verdict.reasons.push(`max_drawdown_kill(${ddPct.toFixed(2)}% from peak)`);
    verdict.ok = false;
  }
  return { ...verdict, state: s, drawdownPct: Math.round(ddPct * 100) / 100 };
}

// ---------------- PURE: candidate selection ----------------
/** v20.9.0 (C7 — cost-aware ranking): net expected R after friction.
 *  reward/risk plan distances se, fees estimateRoundTripCost se
 *  (India = india cost stack, crypto/futures = taker). Break-even-ke-
 *  baad ka jo bachta hai wahi rank banata hai — sirf raw aiScore nahi
 *  (audit: "signals ko net expected R (fees+slippage ke baad) se rank
 *  karo, raw score se nahi"). */
export function netExpectedROf(sig, stakeINR = 500) {
  const entry = Number(sig?.plan?.entry);
  const sl = Number(sig?.plan?.stopLoss);
  const tp = Number(sig?.plan?.target1 ?? sig?.plan?.target);
  if (![entry, sl, tp].every((x) => Number.isFinite(x) && x > 0) || entry === sl) return null;
  const market = sig?.market === 'INDIA' ? 'INDIA' : (sig?.market === 'FUTURES' ? 'FUTURES' : 'CRYPTO');
  // v20.9.0 FIX (debug-verified): tradingCosts 'india' instrument ko
  // NAHI pehchanta — asli keys 'equity-intraday'|'equity-futures'|
  // 'options' hain. 'india' bhejne par cost NULL aata tha aur fees=0
  // (FREE!) assume hota tha — INDIA candidates ko galat fayda milta tha.
  const instrumentType = market === 'INDIA' ? 'equity-intraday' : 'crypto';
  const qty = stakeINR / entry;
  const cost = estimateRoundTripCost({ qty, entryPrice: entry, exitPrice: tp, instrumentType });
  // FAIL-CLOSED ranking: uncomputable cost = netR null (rank LAST),
  // kabhi fees=0 (free trade) nahi.
  if (cost?.total == null || !Number.isFinite(Number(cost.total))) return null;
  const reward = Math.abs(tp - entry) * qty;
  const risk = Math.abs(entry - sl) * qty;
  const fees = Number(cost.total);
  if (!(risk > 0)) return null;
  return (reward - fees) / (risk + fees);
}

export function pickProTraderCandidate(signals, cfg, { existingSymbols = [], cooldowns = {}, now = Date.now() } = {}) {
  const evaluated = [];
  for (const s of signals || []) {
    const g = proTraderGate(s, cfg);
    evaluated.push({ symbol: s?.symbol, side: s?.side, ai: g.score?.ai, conf: g.score?.conf, verified: g.score?.verified, pass: g.pass, reasons: g.reasons });
    if (!g.pass) continue;
    if ((existingSymbols || []).includes(s.symbol)) { evaluated[evaluated.length - 1].skip = 'already-open'; continue; }
    const until = cooldowns[s.symbol] || 0;
    if (now < until) { evaluated[evaluated.length - 1].skip = 'cooldown'; continue; }
  }
  const ok = (signals || []).filter((s) => evaluated.find((e) => e.symbol === s.symbol && e.pass && !e.skip));
  // v20.9.0 (C7): net-expected-R pe rank (friction ke BAAD) — tie
  // pe aiScore. NaN netR (plan/cost unknown) sabse neeche.
  ok.sort((a, b) => {
    const ra = netExpectedROf(a, Number(cfg.stakeINR) || 500);
    const rb = netExpectedROf(b, Number(cfg.stakeINR) || 500);
    const na = ra == null || !Number.isFinite(ra) ? -Infinity : ra;
    const nb = rb == null || !Number.isFinite(rb) ? -Infinity : rb;
    if (nb !== na) return nb - na;
    return (Number(b?.superIntel?.aiScore) || 0) - (Number(a?.superIntel?.aiScore) || 0);
  });
  return { best: ok[0] || null, evaluated: evaluated.slice(0, 8) };
}

// ---------------- PURE: reversal decision ----------------
// Inputs per tick; streak tracked by caller on the trade record.
export function proTraderReversalCheck({ trade, ltp, deepSide, deepConf, mtfConsensus, mtfAgreePct, cfg = PROTRADER_DEFAULTS }) {
  const reasons = [];
  const side = trade.side;
  const _entry = Number(trade.entryPrice);
  const sl = Number(trade.sl || trade.signal?.sl || 0);
  const p = Number(ltp);
  if (!Number.isFinite(p) || p <= 0) return { hit: false, reasons: ['no-ltp'], wantClose: false };

  // 1) SL breach — the SURE case, closes immediately.
  if (cfg.slImmediate && sl > 0) {
    if (side === 'LONG' && p <= sl) reasons.push(`SL-hit:${p}<=${sl}`);
    if (side === 'SHORT' && p >= sl) reasons.push(`SL-hit:${p}>=${sl}`);
  }
  // 2) Ensemble deep flip.
  if (deepSide && deepSide !== side && side !== 'FLAT' && Number(deepConf) >= cfg.minReversalConf) {
    reasons.push(`ensemble-flip:${deepSide}@${deepConf}`);
  }
  // 3) MTF-6 consensus flip with strong agreement.
  if (mtfConsensus === 'BULLISH' && side === 'SHORT') reasons.push(`mtf-flip:BULLISH@${mtfAgreePct ?? 0}%`);
  if (mtfConsensus === 'BEARISH' && side === 'LONG') reasons.push(`mtf-flip:BEARISH@${mtfAgreePct ?? 0}%`);
  const mtfFlip = reasons.some((r) => r.startsWith('mtf-flip:'));
  if (mtfFlip && Number(mtfAgreePct || 0) < cfg.minMtfAgreePct) {
    // weak agreement — not "sure", drop it
    const idx = reasons.findIndex((r) => r.startsWith('mtf-flip:'));
    if (idx >= 0) reasons.splice(idx, 1);
  }
  const slHit = reasons.some((r) => r.startsWith('SL-hit:'));
  const hard = reasons.length > 0 && (slHit || reasons.length >= 2); // SL alone OR 2+ independent signals
  const feeBePrice = _entry > 0 ? feeBreakevenFloor({ entry: _entry, side, market: trade?.market || 'FUTURES' }) : null;
  const feeCovered = feeBePrice != null ? (side === 'LONG' ? p >= feeBePrice : p <= feeBePrice) : true;
  return { hit: reasons.length > 0, reasons, wantClose: hard, immediate: slHit, feeBePrice, feeCovered };
}

// ---------------- PURE: v20.8.5 TP PROFIT-BOOKING check ----------------
// User spec: "auto profit TP 1 or TP 2 pe profit book karke exit".
//   • TP1 hit (tiered plan)  → partial book + SL breakeven-lock (runner)
//   • TP2 hit                → FULL close — profit booked, exit
//   • single-target plan (tp1 only, tp2 absent) → TP1 = FULL exit
//   • gap past BOTH in one pass → TP2 wins (full book at the better price)
// PURE — no journal/market side effects; the monitor owns the booking.
export function proTraderTpCheck({ trade, ltp, cfg = PROTRADER_DEFAULTS }) {
  const out = { enabled: Boolean(cfg.tpExitsEnabled), tp1: false, tpFull: false, fullWhy: null, tp1Price: null, tp2Price: null };
  if (!out.enabled) return out;
  const side = String(trade?.side || '').toUpperCase();
  const p = Number(ltp);
  if ((side !== 'LONG' && side !== 'SHORT') || !Number.isFinite(p) || p <= 0) return out;
  const t1 = Number(trade?.tp) > 0 ? Number(trade.tp) : 0;
  const t2 = Number(trade?.tp2) > 0 ? Number(trade.tp2) : 0;
  out.tp1Price = t1 > 0 ? t1 : null;
  out.tp2Price = t2 > 0 ? t2 : null;
  if (t1 <= 0 && t2 <= 0) return out; // plan without targets — reversal/SL own the exit
  const crossed = (lvl) => (side === 'LONG' ? p >= lvl : p <= lvl);
  const hit1 = t1 > 0 && !trade?.tp1Hit && crossed(t1);
  const hit2 = t2 > 0 && crossed(t2);
  const singleTarget = t1 > 0 && t2 <= 0;
  if (hit2) { out.tpFull = true; out.fullWhy = 'TP2 TARGET'; return out; }
  if (hit1 && singleTarget) { out.tpFull = true; out.fullWhy = 'TP1 TARGET (single-target plan)'; return out; }
  if (hit1) { out.tp1 = true; }
  return out;
}

/** v20.8.5: SL ko entry (breakeven) pe ratchet — sirf favorable direction
 * me. LONG: sl sirf UPAR jalta hai; SHORT: sirf NEECHE. Return: changed? */
export function proTraderLockBreakeven(trade) {
  const side = String(trade?.side || '').toUpperCase();
  const entry = Number(trade?.entryPrice);
  const prev = Number(trade?.sl) || 0;
  if (!Number.isFinite(entry) || entry <= 0) return false;
  if (side === 'LONG' && prev < entry) { trade.sl = entry; return true; }
  if (side === 'SHORT' && (prev === 0 || prev > entry)) { trade.sl = entry; return true; }
  return false;
}

// ---------------- engine state ----------------
const _s = {
  running: false,
  startedAt: null,
  mode: 'paper',
  lastTickAt: 0,
  lastBrowserCheckAt: 0,
  lastScan: null,          // { at, candidates: evaluated[], bestSymbol }
  log: [],
  busyPlacing: false,
  _ticking: false,        // v18.6.4 re-entrancy guard — overlapped ticks double-click the browser
  _overlapLogAt: 0,       // v20.7.4 — overlap skip-log throttle (5 min)
  _noBrowserLogAt: 0,
  _lastStatusBroadcast: 0,
};

function _log(level, text) {
  const line = { ts: Date.now(), level, text: String(text).slice(0, 300) };
  _s.log.push(line);
  if (_s.log.length > LOG_MAX) _s.log.splice(0, _s.log.length - LOG_MAX);
  _broadcast('log', line);
}

// ---------------- SSE stream (positionsStream pattern) ----------------
const _clients = new Set();
function _broadcast(event, data) {
  if (_clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // v20.7.12 [H3-3]: BACKPRESSURE GUARD — pehle `res.write` ka return
  // value ignore hota tha: ek stalled client (phone sleep / zero-window
  // TCP) har 3s status broadcast + log lines (120 log rows + position
  // snapshots) INDEFINITELY memory me buffer karta tha. Ab 128KB
  // writableLength cap pe client disconnect (positionsStream/index.js
  // ka hi pattern). Slight overrun allowed — RTT jitter safe.
  for (const c of _clients) {
    try {
      const ok = c.res.write(payload);
      if (!ok && c.res.socket && c.res.socket.writableLength > 128 * 1024) {
        try { _clients.delete(c); c.res.destroy(); } catch { /* noop */ }
      }
    } catch { try { c.res.destroy(); } catch { /* feed down → fallback */ } }
  }
}
let _keepAlive = null;
export function proTraderStreamHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const client = { req, res };
  _clients.add(client);
  res.write(`event: status\ndata: ${JSON.stringify(proTraderStatusView())}\n\n`);
  if (!_keepAlive) {
    _keepAlive = setInterval(() => {
      for (const c of _clients) { try { c.res.write(`event: ping\ndata: { /* positions read best-effort */ }\n\n`); } catch { /* positions read best-effort */ } }
    }, 15_000);
    if (_keepAlive.unref) _keepAlive.unref();
  }
  req.on('close', () => {
    _clients.delete(client);
    // v20.7.12 [H3-3]: last client gaya → keepalive teardown (pehle ye
    // interval process-lifetime tak chalta rehta tha — unref'd no-op,
    // par ab clean). Next connect pe dobara ban jata hai.
    if (_clients.size === 0 && _keepAlive) {
      clearInterval(_keepAlive);
      _keepAlive = null;
    }
  });
}
function _broadcastStatusThrottled() {
  if (Date.now() - _s._lastStatusBroadcast < 3000) return;
  _s._lastStatusBroadcast = Date.now();
  _broadcast('status', proTraderStatusView());
}

// ---------------- lifecycle ----------------
export function proTraderStart({ mode, liveConfirmPhrase } = {}) {
  const cfg = loadProTraderConfig();
  if (mode !== 'live' && mode !== 'paper') return { ok: false, error: 'mode must be paper or live' };
  if (mode === 'live') {
    if (liveConfirmPhrase !== 'LIVE') return { ok: false, error: 'LIVE mode ke liye liveConfirmPhrase "LIVE" chahiye' };
    const tcfg = loadJSON(TRADING_CFG_FILE, {}) || {};
    if (tcfg.killSwitch) return { ok: false, error: 'global kill-switch ON hai — pehle usse hatao' };
  }
  // v20.8.5: HONEST already-running — pehle enabled+running same-mode pe
  // START dbane par generic "start" dikhta tha; user ko laga naya chalu
  // hua jabki wo pehle se ON tha ("already tick" confusion). Ab seedha
  // batao + startedAt preserve.
  const already = Boolean(cfg.enabled) && _s.running && cfg.mode === mode;
  cfg.enabled = true;
  cfg.mode = mode;
  saveProTraderConfig(cfg);
  _s.running = true; if (!already || !_s.startedAt) _s.startedAt = Date.now(); _s.mode = mode;
  if (already) {
    _log('info', `PRO TRADER AUTO pehle se ON hai (${mode.toUpperCase()}, since ${new Date(_s.startedAt).toLocaleString('en-IN')}) — gates: AI>=${cfg.minAiScore} conf>=${cfg.minConfidence} verified>=${cfg.minVerifiedScore} · TP exits ${cfg.tpExitsEnabled ? `ON (T1 ${cfg.tp1ClosePct}%+BE / T2 full)` : 'OFF'}`);
  } else {
    _log('entry', `PRO TRADER AUTO START (${mode.toUpperCase()}) — gates: AI>=${cfg.minAiScore} conf>=${cfg.minConfidence} verified>=${cfg.minVerifiedScore} · TP exits ${cfg.tpExitsEnabled ? `ON (T1 ${cfg.tp1ClosePct}%+BE / T2 full)` : 'OFF'}`);
  }
  _broadcast('status', proTraderStatusView());
  return { ok: true, mode, alreadyRunning: already, startedAt: _s.startedAt };
}

export function proTraderStop() {
  const cfg = loadProTraderConfig();
  cfg.enabled = false; saveProTraderConfig(cfg);
  _s.running = false;
  _log('exit', 'PRO TRADER AUTO STOP — open positions monitoring band (manual close karo)');
  _broadcast('status', proTraderStatusView());
  return { ok: true };
}

// ---------------- browser health ----------------
async function _refreshBrowser(force = false) {
  if (!force && Date.now() - _s.lastBrowserCheckAt < 60_000) return browserStatus();
  _s.lastBrowserCheckAt = Date.now();
  try { await browserConnect({}); } catch { /* status records error */ }
  return browserStatus();
}

// ---------------- execution ----------------
/** v19.0: the trade pair. FUTURES → B-{SYM}_USDT (CoinDCX USDT-margined
 * perps — the user-spec auto-trading scope). CRYPTO (legacy spot) →
 * {SYM}INR. INDIA → scrip as-is. */
function _pairOf(symbol, market) {
  if (market === 'INDIA') return String(symbol);
  if (market === 'FUTURES') return `B-${String(symbol).toUpperCase()}_USDT`;
  return `${String(symbol).toUpperCase()}INR`;
}

/** v19.0: USDT-INR fx for futures sizing/P&L (USDTINR spot ticker,
 * honest fallback 84 when the feed is down — stamped on the trade so
 * the close math uses the SAME rate, never a mix). */
async function _usdInr() {
  try {
    const t = await fetchCoinDcxTickers();
    const usdt = (Array.isArray(t) ? t : []).find((x) => String(x?.symbol || x?.pair || '').toUpperCase().replace(/[^A-Z]/g, '') === 'USDTINR');
    const px = Number(usdt?.last_price ?? usdt?.p ?? usdt?.price);
    if (Number.isFinite(px) && px > 50 && px < 200) return Math.round(px * 100) / 100;
  } catch { /* feed down → fallback */ }
  return 84;
}

async function _placeBrowserCrypto(sig, cfg, fxPre = null) {
  const pair = _pairOf(sig.symbol, sig.market);
  const isFut = sig.market === 'FUTURES';
  // v19.0: futures desk → the B-{SYM}_USDT trade page (USDT-margined —
  // margin is NATIVE on the futures page, so the spot 'margin trade'
  // tab toggle is skipped). Prices are USDT → stake converts ₹→USDT.
  // fxPre: the SAME rate _tryEntry stamped on the journal row (one fetch,
  // one truth — pass null to fetch fresh on standalone calls).
  // v20.7.4 FIX: futures URL ab OFFICIAL futures desk hai —
  // https://coindcx.com/futures/B-{SYM}_USDT (user-verified live).
  // Purana /trade/{pair} spot URL galag page kholta tha jahan futures
  // search box milta hi nahi tha ("select-pair: search box nahi mila").
  const fx = isFut ? (Number(fxPre) > 50 ? Number(fxPre) : await _usdInr()) : 1;
  const total = isFut ? Math.round((Number(cfg.stakeINR) / fx) * 1e6) / 1e6 : Number(cfg.stakeINR);
  const page = await cxEnsureTradePage(cxPairUrl(pair, isFut ? 'futures' : 'spot'));
  const pick = await cxSelectPair(page, pair);
  if (!pick?.ok) return { ok: false, stage: 'select-pair', detail: pick };
  const useMargin = !isFut && Number(cfg.cryptoLeverage) > 1; // futures page: leverage native, no margin-tab toggle
  const order = await cxPlaceOrder(page, {
    side: sig.side, price: sig.plan.entry, totalINR: total, leverage: cfg.cryptoLeverage, useMargin,
    // v20.7.7: direct qty belt-and-suspenders — market-fallback fire hone
    // par in-page total/price math ke saath-saath exact qty bhi available
    // rehta hai (form default-qty ka koi chance hi nahi).
    qty: total / Math.max(1e-8, Number(sig.plan.entry) || 1),
    // v20.7.10 (i): live board tick — market-fallback me conservative
    // sizing max(live, plan) ke liye (notional kabhi TOTAL se upar nahi).
    livePrice: Number(sig.ltp) > 0 ? Number(sig.ltp) : null,
  });
  return { ok: order?.ok, stage: 'place-order', detail: order, steps: [pick, order], fx, total, product: isFut ? 'futures' : 'spot' };
}

async function _placeBrowserIndia(sig, cfg) {
  const page = await dhanEnsurePage();
  const pick = await dhanSelectScrip(page, sig.symbol);
  if (!pick?.ok) return { ok: false, stage: 'select-scrip', detail: pick };
  const entry = Math.max(0.05, Number(sig.plan.entry) || 1);
  // v18.6.4 qty affordability: Math.max(1, floor(stake/entry)) ek ₹500
  // stake ko ₹4000 scrip par 8x oversized order bana deta tha. Stake ek
  // pura share nahi khareed sakta → honest skip (small-cap filter).
  const qty = Math.floor(Number(cfg.stakeINR) / entry);
  // v20.9.1 [M]: NaN qty guard — NaN < 1 FALSE hota hai, !(qty >= 1) hi
  // non-numeric stake ko rokta hai (browser field me 'NaN' type hota).
  if (!(qty >= 1)) {
    return { ok: false, stage: 'qty', detail: { error: `stake ₹${cfg.stakeINR} me ${sig.symbol} @ ₹${entry} ka 1 share nahi aata — entry skip (sizing protect)` } };
  }
  const order = await dhanPlaceOrder(page, {
    side: sig.side, price: sig.plan.entry, quantity: qty, product: cfg.indiaProduct,
  });
  return { ok: order?.ok, stage: 'place-order', detail: order, steps: [pick, order], qty };
}

function _todayIST() { const d = istNow(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

/** v20.9.0 (E — ops alert): hard-gate block telegram alert, DIN me ek
 *  baar (har 30s tick pe spam nahi — monitoring chalta rehta hai). */
let _hgAlertDay = null;
function _hardGateAlertOnce(cfg, why, sendTelegram) {
  const day = _todayIST();
  if (_hgAlertDay === day) return;
  _hgAlertDay = day;
  _log('warn', `RISK HALT (aaj ke liye) — ${why}. Naye entries block; open positions manage honge.`);
  try { sendTelegram?.(`[PRO TRADER AUTO] 🛑 RISK HALT — ${why}. Aaj ke naye entries block ho gaye (open positions manage hote rahenge). Config review karo.`); } catch { /* close attempt best-effort */ }
}

async function _tryEntry(deps, cfg, sig, sendTelegram) {
  if (_s.busyPlacing) return { ok: false, error: 'busy' };
  _s.busyPlacing = true;
  try {
    const g = proTraderGate(sig, cfg);
    // v19.0: FUTURES is a first-class market here (B-{SYM}_USDT pair,
    // USDT prices, fx-converted sizing) — only INDIA routes to Dhan.
    const market = sig.market === 'INDIA' ? 'INDIA' : (sig.market === 'FUTURES' ? 'FUTURES' : 'CRYPTO');
    // ---- v20.9.0 (H1 — THE SHARED HARD GATE): order place karne se
    // PEHLE. Pehle SAPTA koi bhi daily-loss/drawdown/streak/event-day
    // rule enforce NAHI karta tha — sirf maxConcurrent + trades/day +
    // cooldown. Ab wahi shared hardGate jo Bot Lab use karta hai.
    // (kill-switch tick me pehle hi check hota hai; yahan bhi pass kiya
    // — defense in depth.)
    let eventBlocked = false, eventLabel = null;
    try {
      // v20.9.1 [L]: FUTURES signals ab 'FUTURES' desk key pe scope hote
      // hain (pehle sab non-INDIA 'CRYPTO' — earnings scoping galat desk
      // key ke niche evaluate hoti thi).
      const eg = eventGuardCheck({ symbol: sig.symbol, desk: market === 'INDIA' ? 'INDIA' : (market === 'FUTURES' ? 'FUTURES' : 'CRYPTO') });
      if (eg?.blocked) { eventBlocked = true; eventLabel = eg.label || eg.event || 'blackout'; }
    } catch { /* guard failure must not fake a veto */ }
    const hg = proTraderHardGate({
      trades: _trades(), cumStats: _journal()?.cumStats || null, cfg, day: _todayIST(), now: Date.now(),
      eventBlocked, eventLabel,
      // v20.9.1 [M]: stale_feed gate pehle VESTIGIAL tha — _s.lastScan.at
      // USI tick me stamp hota hai (hamesha ~0s). Ab candidate signal ki
      // APNI age (generatedAt → board generatedAt → lastScan fallback).
      scanAgeSec: (() => {
        const sigAge = Number(sig?.generatedAt) > 0 ? (Date.now() - Number(sig.generatedAt)) / 1000 : null;
        if (sigAge != null) return sigAge;
        const bGen = Number(_s.lastScan?.boards?.[market]?.generatedAt);
        if (Number(bGen) > 0) return (Date.now() - bGen) / 1000;
        return _s.lastScan?.at ? (Date.now() - _s.lastScan.at) / 1000 : null;
      })(),
    });
    if (!hg.ok) {
      const why = hg.reasons.join('; ');
      _hardGateAlertOnce(cfg, why, sendTelegram);
      _log('skip', `HARD GATE ${sig.symbol} entry block — ${why}`);
      return { ok: false, error: `hard_gate: ${why}`, hardGate: hg };
    }
    // ---- v20.9.3 FIX (H2): CROSS-ENGINE LOCK. The auto-agent (agent.js)
    // trades the SHARED ai-trading-journal.json while SAPTA trades this
    // journal — disjoint books, koi mutual lock nahi tha. Dono engines
    // the same board ko 30s cadence pe scan karte hain with overlapping
    // qualifiers (agent STRONG/75+, SAPTA STRONG+SVA-CONFIRM — the SAME
    // signal passes both) → API order + browser order on the same pair
    // within seconds → exchange nets them into ONE ~2× position; jab ek
    // engine ka exit fire hota hai wo merged position doosre ke neeche
    // close kar deta hai (cross-engine CLOSE_UNKNOWN storms). Ab order
    // se PEHLE shared journal ka OPEN/UNKNOWN check (fresh read at the
    // order moment — TOCTOU-safe).
    try {
      const sharedJ = loadJSON('ai-trading-journal.json', { entries: [], positions: [] });
      const lockPair = _pairOf(sig.symbol, market);
      const clash = (sharedJ?.positions || []).find((p) =>
        (p.status === 'OPEN' || p.status === 'UNKNOWN')
        && String(p.pair || '').toUpperCase() === String(lockPair).toUpperCase());
      if (clash) {
        _log('skip', `CROSS-ENGINE LOCK ${sig.symbol} — auto-agent (shared journal) me ${lockPair} pe OPEN/UNKNOWN position already hai. Double-order avoid.`);
        return { ok: false, error: `cross-engine lock: auto-agent already on ${lockPair}` };
      }
    } catch { /* shared journal read best-effort — read failure pe entry block NAHI karte */ }
    // v20.9.0: fx fetched ONCE here (the record and the browser order
    // share the SAME rate — never a mix of two fetches).
    const fxPre = market === 'FUTURES' ? await _usdInr() : null;
    if (market === 'INDIA' && !indiaMarketOpen()) return { ok: false, error: 'NSE band hai (9:30-15:00 IST entry window)' };
    // v18.6.4 sizing protect (BOTH modes): stake ek pura share nahi
    // khareedta → skip (paper me bhi 8x oversize lie journal hota tha).
    // v20.9.1 [M]: !(... >= 1) — NaN < 1 FALSE hota hai (non-numeric
    // stake ke liye floor NaN deta hai).
    if (market === 'INDIA' && !(Math.floor(Number(cfg.stakeINR) / Math.max(0.05, Number(sig.plan.entry) || 1)) >= 1)) {
      return { ok: false, error: `sizing skip: stake ₹${cfg.stakeINR} me ${sig.symbol} @ ${sig.plan.entry} ka 1 share nahi aata` };
    }
    const browser = browserStatus();
    if (cfg.mode === 'live' && !browser.tabs?.[market === 'INDIA' ? 'dhan' : 'coindcx']?.found) {
      if (Date.now() - _s._noBrowserLogAt > 10 * 60_000) {
        _s._noBrowserLogAt = Date.now();
        _log('error', `BROWSER TAB missing (${market}) — Start-AutoBrowser.bat chalao aur ${market === 'INDIA' ? 'dhan.co' : 'coindcx.com'} login karke tab khula rakho`);
      }
      return { ok: false, error: 'browser tab not available' };
    }

    const trade = {
      id: `PTA-${Date.now().toString(36).toUpperCase()}`,
      ts: Date.now(), day: _todayIST(),
      market, symbol: sig.symbol, pair: _pairOf(sig.symbol, market), side: sig.side,
      entryPrice: Number(sig.plan.entry), sl: Number(sig.plan.stopLoss || 0),
      tp: Number(sig.plan.target1 || 0), tp2: Number(sig.plan.target2 || 0),
      stakeINR: Number(cfg.stakeINR), leverage: market === 'INDIA' ? (cfg.indiaProduct === 'MTF' ? 'MTF' : 1) : Number(cfg.cryptoLeverage),
      // v19.0: futures prices are USDT — stamp the entry fx so qty math
      // and the CLOSE P&L use the SAME rate (never a mix of two days').
      fxAtEntry: market === 'FUTURES' ? (Number(fxPre) || 84) : null,
      // v18.6.4 P&L-basis: the browser order actually enters qty =
      // stake/entry (crypto amount field) ya floor(stake/entry) (India) —
      // the position NOTIONAL is ≈ stake. Journal P&L = qty × Δprice
      // (no ×leverage guess); ROE (margin lens) = move% × leverage.
      // v19.0 FUTURES: stake converts to USDT first (qty = USDT/price);
      // the journal's ₹ P&L multiplies ΔUSDT × qty × fxAtEntry.
      qtyEstimate: market === 'INDIA'
        ? Math.max(1, Math.floor(Number(cfg.stakeINR) / Math.max(0.05, Number(sig.plan.entry) || 1)))
        : market === 'FUTURES'
          ? Math.round((Number(cfg.stakeINR) / (Number(fxPre) || 84)) / Math.max(1e-8, Number(sig.plan.entry) || 1) * 1e6) / 1e6
          : Math.round((Number(cfg.stakeINR) / Math.max(1e-8, Number(sig.plan.entry) || 1)) * 1e6) / 1e6,
      product: market === 'INDIA' ? cfg.indiaProduct : null,
      pnlBasis: 'notional',
      mode: cfg.mode, source: 'protrader-auto',
      signal: {
        aiScore: g.score.ai, conf: g.score.conf, verified: g.score.verified,
        verifyAction: sig.verify?.action, finalCall: sig.verify?.finalCall,
        grade: sig.grade, entry: sig.plan.entry, sl: sig.plan.stopLoss, tp1: sig.plan.target1, tp2: sig.plan.target2,
        mtfConsensus: sig?.mtf?.consensus || null, mtfAgreePct: sig?.mtf?.agreementPct ?? null,
      },
      browser: { actions: [], shots: [] },
      status: cfg.mode === 'paper' ? 'MONITORING' : 'PLACED',
      confirmStreak: 0, lastLtp: Number(sig.ltp || sig.plan.entry), lastCheckAt: Date.now(),
      reversalReasons: [],
    };

    if (cfg.mode === 'paper') {
      trade.browser.actions.push('PAPER-SIM: browser click nahi hua — journal entry only (limit @ entry)');
    } else {
      let r;
      try {
        r = market === 'INDIA' ? await _placeBrowserIndia(sig, cfg) : await _placeBrowserCrypto(sig, cfg, fxPre);
      } catch (e) {
        // v20.7.10 CRITICAL FIX: CDP throw (Runtime.evaluate timeout / ws
        // drop) ke baad bhi in-page script CHAL CHUKA hota hai — buy click
        // land kar sakta hai jab Node ne wait chhod di. Pehle ye throw
        // proTraderTick ke .catch me sirf 'entry skip' log hota tha: NO
        // journal row, NO FAILED cooldown → agla tick wahi STRONG signal
        // DUBARA entry → duplicate position. Ab AMBIGUOUS FAILED row
        // journal hota hai (cooldown lagta hai) + telegram warn.
        const err = String(e?.message || e);
        trade.status = 'FAILED'; trade.error = `AMBIGUOUS (order MAY be live at broker): ${err.slice(0, 200)}`;
        _saveTrade(trade);
        _log('error', `ENTRY AMBIGUOUS ${sig.symbol} ${sig.side} — order broker pe LAG bhi sakta hai (${err.slice(0, 140)}). Broker panel manually verify karo!`);
        try { sendTelegram?.(`[PRO TRADER AUTO] ⚠️ ENTRY AMBIGUOUS ${sig.symbol} ${sig.side} — CDP error ke baad order lag bhi sakta hai. Broker panel me verify karo: ${err.slice(0, 120)}`); } catch { /* positions read best-effort */ }
        return { ok: false, error: trade.error, trade };
      }
      trade.browser.actions.push(...(r.steps || []).map((s) => ({ ok: s?.ok, stage: s?.stage || 'step', steps: s?.detail?.steps || s?.picked || s?.error || null })));
      for (const s of r.steps || []) if (s?.shot) trade.browser.shots.push(s.shot);
      if (s_shot(r)) trade.browser.shots.push(s_shot(r));
      if (!r.ok) {
        // v20.7.6: place-order fail par page ke visible inputs ka dump
        // (browserAgent diagnostics) bhi error me pack hota hai — agla
        // UI break LOG se hi diagnosable ("price input" wale errors ka
        // root-cause loop khatam).
        const diag = r.detail?.inputs ? ` | inputs: ${String(r.detail.inputs).slice(0, 220)}` : '';
        trade.status = 'FAILED'; trade.error = `${r.stage}: ${r.detail?.error || r.detail?.pageError || 'unknown'}${diag}`;
        _saveTrade(trade);
        _log('error', `ENTRY FAILED ${sig.symbol} ${sig.side} — ${trade.error}`);
        return { ok: false, error: trade.error, trade };
      }
      trade.status = 'PLACED';
      _log('entry', `ORDER PLACED ${sig.symbol} ${sig.side} @ ${sig.plan.entry} (browser) — fill verify agla tick`);
    }
    _saveTrade(trade);
    // v21.23.1 FIX: SAPTA ab entry par cross-engine direction lock ACQUIRE karta hai.
    // Pehle proTraderGate sirf CHECK karta tha (L337) — SAPTA ki trades doosre engines
    // (agent / MTF auto / india-agent) ko direction-lock me dikhti hi nahi thi, isliye
    // koi bhi engine usi symbol par opposite side trade khol sakta tha. Ab entry ke saath
    // lock lagta hai; close hone par routes.js 60s sweeper (`reconcileDirectionLocks`) release
    // karta hai — post-entry flip cooldown preserved.
    if (trade.status === 'MONITORING' || trade.status === 'PLACED') {
      acquireDirectionLock({ symbol: trade.symbol, side: trade.side, source: 'protrader-auto', cooldownMin: 240 });
    }
    _log('entry', `NEW TRADE ${sig.symbol} ${sig.side} | AI ${g.score.ai} conf ${g.score.conf} verified ${g.score.verified} | entry ${sig.plan.entry} SL ${sig.plan.stopLoss} | mode ${cfg.mode}`);
    return { ok: true, trade };
  } finally { _s.busyPlacing = false; }
}
function s_shot(r) { return r?.detail?.shot || null; }

function _saveTrade(trade) {
  const j = _journal();
  const i = (j.trades || []).findIndex((t) => t.id === trade.id);
  if (i >= 0) j.trades[i] = trade; else j.trades.push(trade);
  if (j.trades.length > 400) {
    // v20.9.1 [M]: trimmed rows ka realized-PnL running cumStats me FOLD —
    // warna 400+ trades ke baad cum-curve 0 se restart hota tha aur
    // drawdown-kill ka historical peak gayab ho jata tha.
    const drop = j.trades.splice(0, j.trades.length - 400);
    const prev = { cum: Number(j.cumStats?.cum) || 0, peak: Number(j.cumStats?.peak) || 0 };
    const byClose = drop.filter((t) => t?.status === 'CLOSED').sort((a, b) => (a.closed?.ts || 0) - (b.closed?.ts || 0));
    let cum = prev.cum, peak = prev.peak;
    for (const t of byClose) { cum += Number(t.closed?.pnlINR) || 0; if (cum > peak) peak = cum; }
    j.cumStats = { cum, peak };
  }
  _saveJournal(j);
}
function _updTrade(id, patch) {
  const j = _journal();
  const t = (j.trades || []).find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  _saveJournal(j);
  return t;
}

// ---------------- monitoring + reversal exit ----------------
// v18.6.4: LTP for monitoring no longer depends on the symbol staying in
// the board's top-N. Chain: fresh liveFeed tick (≤30s) → CoinDCX ticker
// batch (internally cached) → board signal → last-known. Returns
// { ltp, stale } — stale:true means the number is last-known (monitor
// still runs, journal honestly flags it).
async function _monitorLtpOf(t, boards, deps) {
  // v19.0: FUTURES rows price in USDT from the FUTURES feed (a spot
  // INR ticker / spot board is meaningless for a B-{SYM}_USDT row).
  const market = t.market === 'INDIA' ? 'INDIA' : (t.market === 'FUTURES' ? 'FUTURES' : 'CRYPTO');
  // deps-injectable (tests stub these; production uses the real store/tickers)
  const tickFn = typeof deps?.getTick === 'function' ? deps.getTick : getTick;
  const tickersFn = typeof deps?.fetchCoinDcxTickers === 'function' ? deps.fetchCoinDcxTickers : fetchCoinDcxTickers;
  try {
    // v20.7.10 CRITICAL FIX: FUTURES rows ka tick store key FUT_<base>
    // (USDT domain) hai — IN_<base> = spot INR (~84x off). Pehle ye line
    // SAB markets pe chalti thi: B-ETH_USDT SHORT ko ₹2.5L spot price
    // milta → instant BOGUS SL-hit close of a healthy position (aur
    // PnL/ROE ~84x inflated). Ab futures FUT_ se, spot/india IN_ se.
    const tickKey = market === 'FUTURES' ? `FUT_${t.symbol}` : `IN_${t.symbol}`;
    const tick = tickFn(tickKey);
    if (tick?.price > 0 && Date.now() - (tick.time || 0) < 30_000) {
      return { ltp: Number(tick.price), stale: false };
    }
  } catch { /* store read — never fatal */ }
  if (market === 'FUTURES') {
    try {
      // deps-injectable like the spot ticker above (tests stub it; the
      // real path uses futures.js's cached REST feed)
      let rows = [];
      if (typeof deps?.fetchFuturesPrices === 'function') {
        rows = await Promise.resolve(deps.fetchFuturesPrices({})).catch(() => []);
      } else {
        const { fetchFuturesPrices } = await import('./futures.js');
        rows = await fetchFuturesPrices({ maxAgeMs: 30_000 }).catch(() => []);
      }
      const row = (rows || []).find((r) => r?.base === String(t.symbol).toUpperCase());
      const px = Number(row?.last);
      // v20.7.10: futures.js ka leg-4 deep-stale serve (PRICES_DEEP_STALE_MS
      // = 3 min tak) fetchFuturesPrices(maxAgeMs) ko IGNORE karta hai — row.ts
      // age check ke bina 3-min-purana price bhi 'fresh' flag ho raha tha
      // (SL/reversal decisions + journal ltpStale lie). Ab >45s = stale:true
      // (monitor chalta rehta hai, journal honestly flag karta hai).
      const rowAgeMs = Number(row?.ts) > 0 ? Date.now() - Number(row.ts) : Infinity;
      if (px > 0) return { ltp: px, stale: rowAgeMs > 45_000 };
    } catch { /* honest degrade */ }
  } else if (market !== 'INDIA') {
    try {
      const rows = await tickersFn();
      const row = (rows || []).find((r) => String(r?.market || '') === `${t.symbol}INR`);
      const px = Number(row?.last_price);
      if (px > 0) return { ltp: px, stale: false };
    } catch { /* honest degrade */ }
  }
  const boardSig = ((boards[market] || {}).signals || []).find((s) => s?.symbol === t.symbol);
  const bl = Number(boardSig?.ltp);
  if (bl > 0) return { ltp: bl, stale: false };
  const last = Number(t.lastLtp);
  if (last > 0) return { ltp: last, stale: true };
  return { ltp: Number(t.entryPrice), stale: true };
}

async function _monitorPositions(deps, cfg, sendTelegram) {
  // v18.6.4: CLOSE_UNKNOWN rows stay in the loop — the close RE-ATTEMPTS
  // every tick (max 8) + alerts until the broker position is really gone.
  // v20.7.12 [H3-5]: UNFILLED rows bhi loop me hain — LATE-FILL adoption
  // ke liye (resting GTC order baad me fill ho sakta hai; row UNFILLED
  // rehne par wo position UNMONITORED chalti thi — ab positions table me
  // row dikhi turant MONITORING me wapas aa jati hai + alert).
  const open = _trades().filter((t) => ['MONITORING', 'PLACED', 'CLOSE_UNKNOWN', 'UNFILLED'].includes(t.status));
  if (open.length === 0) return;
  const boards = _s.lastScan?.boards || {};
  // v20.9.3 FIX (H2): desk-aware positions read. INDIA live trades read the
  // DHAN positions panel (dhanReadPositions); crypto/futures read the
  // CoinDCX one. Pehle dono fill-verify blocks `market !== 'INDIA'` pe
  // hard-gated the jabki PLACED→UNFILLED TTL SAB markets pe lagta tha —
  // ek FILLED live India position 15 min me UNFILLED me retire ho jaati
  // thi (SL/TP/reversal/EOD monitoring SAB band, journal jhooth bolta
  // "fill verify nahi hua", symbol re-entry-block). Ab INDIA bhi verify
  // + adopt hota hai.
  const _readPositionsFor = async (market) => {
    try {
      return market === 'INDIA' ? await dhanReadPositions() : await cxReadPositions();
    } catch { return null; }
  };
  for (const t of open) {
    try {
      const market = t.market === 'INDIA' ? 'INDIA' : (t.market === 'FUTURES' ? 'FUTURES' : 'CRYPTO');

      // ---- v20.7.12 [H3-5]: UNFILLED late-fill adoption — sirf yahi check,
      // reversal/LTP logic NAHI (position abhi unknown hai; galat SL-close
      // ka risk). Row dikhi → MONITORING (managed again); nahi → sirf
      // re-check timestamp aage badhao. ----
      if (t.status === 'UNFILLED') {
        if (t.mode === 'live'
          && Date.now() - (t.fillCheckedAt || t.closed?.ts || 0) > 90_000) {
          try {
            const read = await _readPositionsFor(market);
            if (read?.ok) {
              const found = (read.positions || []).some((p) => String(p.text || '').toUpperCase().includes(String(t.pair).toUpperCase()));
              if (found) {
                _updTrade(t.id, { status: 'MONITORING', fillCheckedAt: Date.now(), fillAdoptedAt: Date.now() });
                _log('warn', `LATE FILL ADOPTED ${t.symbol} — UNFILLED retire hone ke BAAD position table me dikhi (resting GTC order fill hua). Row MONITORING me wapas.`);
                try { sendTelegram?.(`[PRO TRADER AUTO] ⚠️ ${t.symbol} ka "unfilled" order LATE FILL ho gaya — engine ne row wapas MONITORING me adopt kar li hai (SL/reversal monitoring live).`); } catch { /* best-effort */ }
              } else {
                _updTrade(t.id, { fillCheckedAt: Date.now() });
              }
            }
          } catch { /* positions read best-effort */ }
        }
        continue;
      }

      // ---- CLOSE_UNKNOWN: the broker close did not verify — re-attempt ----
      if (t.status === 'CLOSE_UNKNOWN') {
        const attempts = (t.closeAttempts || 0) + 1;
        if (attempts > 8) {
          _updTrade(t.id, { status: 'CLOSE_FAILED', closeAttempts: attempts });
          _log('error', `CLOSE FAILED ${t.symbol} — 8 attempts ke baad bhi verify nahi hua. BROKER PANEL me manually check/close karo!`);
          try { sendTelegram?.(`[PRO TRADER AUTO] ⚠️ ${t.symbol} ${t.side} CLOSE FAILED — 8 attempts. Broker app me manually close karo aur verify karo.`); } catch { /* best-effort */ }
          continue;
        }
        _log('warn', `CLOSE RETRY ${t.symbol} (attempt ${attempts}/8) — broker position abhi bhi dikha/dhang se verify nahi hua`);
        await _closeTrade(t, `${t.closed?.reason || 're-close'} (RETRY ${attempts}/8)`, cfg, sendTelegram, null);
        continue;
      }

      // ---- PLACED fill verification (live only): read the positions
      //      table (CoinDCX desk ya Dhan desk — v20.9.3) — row mila →
      //      MONITORING (fill confirmed); 10 min tak nahi mila → honest
      //      telegram nudge. ----
      if (t.status === 'PLACED' && t.mode === 'live'
        && Date.now() - (t.ts || 0) > 60_000 && Date.now() - (t.fillCheckedAt || 0) > 90_000) {
        try {
          const read = await _readPositionsFor(market);
          if (read?.ok) {
            const found = (read.positions || []).some((p) => String(p.text || '').toUpperCase().includes(String(t.pair).toUpperCase()));
            if (found) {
              _updTrade(t.id, { fillCheckedAt: Date.now(), status: 'MONITORING' });
              _log('info', `FILL CONFIRMED ${t.symbol} — positions table me row mil gayi`);
            } else {
              _updTrade(t.id, { fillCheckedAt: Date.now() });
              if (Date.now() - (t.ts || 0) > 10 * 60_000 && !t.fillAlertedAt) {
                _updTrade(t.id, { fillAlertedAt: Date.now() });
                _log('warn', `FILL UNVERIFIED ${t.symbol} — 10 min se positions table me row nahi mili (order maybe unfilled/cancelled)`);
                try { sendTelegram?.(`[PRO TRADER AUTO] ⚠️ ${t.symbol} order FILL verify nahi hua (10 min, positions me row nahi). Exchange app me order status check karo.`); } catch { /* positions read best-effort */ }
              }
            }
          }
        } catch { /* positions read best-effort */ }
      }

      // ---- v20.7.10: PLACED TTL — resting limit order jo KABHI fill nahi
      //      hua wo hamesha 'open' set me rehta tha → maxConcurrent slots
      //      PERMANENTLY block (3 pullback-limit = engine band). Ab
      //      PLACED_TTL_MIN (15 min) baad bhi positions me nahi mila to
      //      row UNFILLED me retire (slot free + honest alert; broker pe
      //      resting order hai to manually cancel karo — CDP cancel
      //      primitive abhi nahi hai, journal lie nahi karta).
      //      v20.9.3 FIX (H2): INDIA live pe TTL tabhi lagta hai jab ek
      //      VERIFIED positions-read (fillCheckedAt) ho chuka ho jo row
      //      NAHI mili — warna ek filled position ko 15 min pe blind-retire
      //      kar dete. Read hi nahi ho paya (Dhan tab down) to 3× TTL
      //      upper-bound se retire with honest reason (slot hamesha
      //      block nahi reh sakta). ----
      const placedAgeMs = Date.now() - (t.ts || 0);
      const indiaLiveNeedsCheck = market === 'INDIA' && t.mode === 'live';
      if (t.status === 'PLACED' && placedAgeMs > PLACED_TTL_MIN * 60_000
        && (!indiaLiveNeedsCheck || t.fillCheckedAt || placedAgeMs > PLACED_TTL_MIN * 3 * 60_000)) {
        const ttlWhy = indiaLiveNeedsCheck && !t.fillCheckedAt
          ? `PLACED TTL ${PLACED_TTL_MIN * 3}min — Dhan positions read hi nahi ho payi (tab available nahi) — slot free`
          : `PLACED TTL ${PLACED_TTL_MIN}min — fill verify nahi hua (slot free)`;
        _updTrade(t.id, {
          status: 'UNFILLED',
          closed: { ts: Date.now(), reason: ttlWhy, exitPrice: null, pnlINR: null },
        });
        _log('warn', `PLACED EXPIRED ${t.symbol} — ${ttlWhy}. Agar broker pe resting order hai to manually cancel karo.`);
        try { sendTelegram?.(`[PRO TRADER AUTO] ⚠️ ${t.symbol} ${t.side} limit order FILL verify nahi ho paya — slot free kiya. Broker pe resting order hai to manually cancel karo.`); } catch { /* best-effort */ }
        continue;
      }

      // ---- EOD squareoff: INTRADAY products only (MTF/DELIVERY hold
      //      overnight — reversal/SL monitoring continues next session). ----
      const product = t.product || cfg.indiaProduct;
      if (t.market === 'INDIA' && indiaSquareOffDue() && product === 'INTRADAY') {
        await _closeTrade(t, 'EOD-SQUAREOFF (15:15 IST, INTRADAY)', cfg, sendTelegram, null);
        continue;
      }

      // ---- LTP: independent of board top-N (see _monitorLtpOf) ----
      const { ltp, stale } = await _monitorLtpOf(t, boards, deps);

      // ---- v20.8.5 TP PROFIT-BOOKING (user spec: "auto profit TP 1 or
      //      TP 2 pe profit book karke exit"). Pehle TP check hota hai —
      //      profit-book SL-breach se pehle aata hai; TP1 partial ke baad
      //      runner wahi reversal/SL protection me rehta hai. ----
      if (cfg.tpExitsEnabled) {
        const tp = proTraderTpCheck({ trade: t, ltp, cfg });
        if (tp.tpFull) {
          await _closeTrade(t, `${tp.fullWhy} HIT — profit booked (FULL EXIT)`, cfg, sendTelegram, ltp);
          continue;
        }
        if (tp.tp1) {
          // PAPER: honest partial — tp1ClosePct% qty book + BE-lock.
          // LIVE: CDP close FULL-position-only hai (qty input primitive
          // nahi) — partial book nahi hota; BE-lock + honest alert, runner
          // TP2/SL/reversal pe exit. Journal kabhi jhooth nahi bolta.
          if (t.mode !== 'live') {
            const leg = _bookTp1Paper(t, ltp, cfg);
            if (leg.ok) {
              _updTrade(t.id, {
                qtyEstimate: t.qtyEstimate, bookedPnlINR: t.bookedPnlINR,
                tp1Hit: true, tp1At: t.tp1At, tp1Px: t.tp1Px, sl: t.sl,
              });
              _log('exit', `TP1 PARTIAL BOOKED ${t.symbol} — ${leg.closeQty} @ ${ltp} → +₹${leg.legPnl} · ${cfg.tp1BreakevenLock ? 'SL → breakeven (runner risk-free) · ' : ''}runner TP2 ${t.tp2 || '—'} pe full exit`);
              try { sendTelegram?.(`[PRO TRADER AUTO] 💰 TP1 HIT ${t.symbol} — ${leg.closeQty} booked @ ${ltp} (+₹${leg.legPnl})${cfg.tp1BreakevenLock ? ', SL breakeven-lock' : ''}. Runner TP2 ${t.tp2 || '—'} tak.`); } catch { /* tick overlap skip — already logged */ }
            } else {
              // qty split nahi ho sakti (too small) — full exit at TP1
              await _closeTrade(t, 'TP1 TARGET HIT — qty too small to split, FULL EXIT (profit booked)', cfg, sendTelegram, ltp);
              continue;
            }
          } else {
            t.tp1Hit = true; t.tp1At = Date.now(); t.tp1Px = Number(ltp);
            const locked = cfg.tp1BreakevenLock ? proTraderLockBreakeven(t) : false;
            _updTrade(t.id, { tp1Hit: true, tp1At: t.tp1At, tp1Px: t.tp1Px, ...(locked ? { sl: t.sl } : {}) });
            _log('exit', `TP1 HIT ${t.symbol} (LIVE) — browser partial-close supported nahi: SL breakeven-lock${locked ? ` (${t.sl})` : ''} lagaya, runner TP2 ${t.tp2 || '—'} pe FULL exit`);
            try { sendTelegram?.(`[PRO TRADER AUTO] 💰 TP1 HIT ${t.symbol} (LIVE) — partial browser-close supported nahi: SL breakeven-lock lagaya, runner TP2 ${t.tp2 || '—'} pe full exit hoga.`); } catch { /* boards scan best-effort — logged downstream */ }
          }
        }
      }

      const boardSig = ((boards[market] || {}).signals || []).find((s) => s?.symbol === t.symbol);
      const deepSide = boardSig?.side || null;
      const deepConf = Number(boardSig?.confidence || 0);
      const mtfCons = boardSig?.mtf?.consensus || null;
      const mtfAgree = boardSig?.mtf?.agreementPct ?? null;
      const rc = proTraderReversalCheck({ trade: t, ltp, deepSide, deepConf, mtfConsensus: mtfCons, mtfAgreePct: mtfAgree, cfg });

      const pnl = _pnlOf(t, ltp);
      const roePct = _roePctOf(t, ltp);
      const patch = { lastLtp: ltp, ltpStale: Boolean(stale), lastCheckAt: Date.now(), lastPnlINR: pnl, lastRoePct: roePct, reversalReasons: rc.reasons };
      if (!rc.hit) { patch.confirmStreak = 0; _updTrade(t.id, patch); continue; }

      if (rc.immediate || rc.wantClose) {
        t.confirmStreak = (t.confirmStreak || 0) + 1;
        patch.confirmStreak = t.confirmStreak;
        const need = rc.immediate ? 1 : REVERSAL_CONFIRM_NEEDED;
        if (t.confirmStreak >= need) {
          await _closeTrade(t, `REVERSAL CONFIRMED [${rc.reasons.join(' + ')}] (streak ${t.confirmStreak}/${need})`, cfg, sendTelegram, ltp);
        } else {
          _updTrade(t.id, patch);
          _log('info', `REVERSAL watch ${t.symbol} — signal mila (streak ${t.confirmStreak}/${need}): ${rc.reasons.join(', ')}`);
        }
      } else {
        // v20.9.1 [H3]: "2 CONSECUTIVE confirmations" spec — weak rc.hit
        // tick (hit=true par immediate/wantClose NAHI) streak me count
        // nahi hota; pehle streak zinda reh jata tha (strong → weak →
        // strong = 2/2 close — non-consecutive whipsaw window).
        patch.confirmStreak = 0;
        _updTrade(t.id, patch);
      }
    } catch (e) {
      _log('error', `monitor ${t.symbol}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
}

// v18.6.4: journal P&L is NOTIONAL-based — the browser order enters
// qty = stake/entry, so position notional ≈ stake and P&L = qty × Δprice.
// (Pehle ye stake × move% × leverage tha — leverage slider DOM me
// best-effort cosmetic hai, isliye ×3 default journal ko overstate karta
// tha. ROE margin-lens ab alag field hai.)
function _pnlOf(t, ltp) {
  const p = Number(ltp); const e = Number(t.entryPrice);
  if (!Number.isFinite(p) || !Number.isFinite(e) || p <= 0 || e <= 0) return null;
  const dir = t.side === 'LONG' ? 1 : -1;
  const qty = Number(t.qtyEstimate) > 0 ? Number(t.qtyEstimate) : (Number(t.stakeINR) || 0) / e;
  // v19.0: FUTURES rows price in USDT → ΔUSDT × qty needs the entry fx
  // stamp to speak INR (the journal's ₹ basis). Legacy CRYPTO/INDIA rows
  // have no stamp → exact old math (zero regression).
  const fx = t.market === 'FUTURES' ? (Number(t.fxAtEntry) > 50 ? Number(t.fxAtEntry) : 84) : 1;
  return Math.round((p - e) * qty * dir * fx);
}

/** v20.8.5: PAPER TP1 partial book — tp1ClosePct% of the CURRENT book at
 * the live LTP, booked P&L accumulates in t.bookedPnlINR, qtyEstimate
 * shrinks, SL ratchets to breakeven. MUTATES t (monitor persists via
 * _updTrade). Returns { ok, closeQty, legPnl } | { ok:false, why }. */
function _bookTp1Paper(t, ltp, cfg) {
  const origQty = Number(t.qtyEstimate) > 0 ? Number(t.qtyEstimate) : null;
  if (!origQty) return { ok: false, why: 'no-qty' };
  const pct = Math.min(90, Math.max(10, Number(cfg.tp1ClosePct) || 50));
  const closeQty = Math.round(origQty * (pct / 100) * 1e6) / 1e6;
  const remQty = Math.round((origQty - closeQty) * 1e6) / 1e6;
  if (!(closeQty > 0) || !(remQty > 0)) return { ok: false, why: 'qty-too-small' };
  const dir = t.side === 'LONG' ? 1 : -1;
  const fx = t.market === 'FUTURES' ? (Number(t.fxAtEntry) > 50 ? Number(t.fxAtEntry) : 84) : 1;
  const legPnl = Math.round((Number(ltp) - Number(t.entryPrice)) * closeQty * dir * fx);
  t.qtyEstimate = remQty;
  t.bookedPnlINR = Math.round((Number(t.bookedPnlINR) || 0) + legPnl);
  t.tp1Hit = true; t.tp1At = Date.now(); t.tp1Px = Number(ltp);
  if (cfg.tp1BreakevenLock !== false) proTraderLockBreakeven(t);
  return { ok: true, closeQty, legPnl };
}

/** ROE % (margin lens): move% × leverage — display-only, never the
 *  journal's ₹ basis (crypto margin rows only). */
function _roePctOf(t, ltp) {
  const p = Number(ltp); const e = Number(t.entryPrice);
  if (!Number.isFinite(p) || !Number.isFinite(e) || p <= 0 || e <= 0) return null;
  const dir = t.side === 'LONG' ? 1 : -1;
  const lev = t.market === 'INDIA' ? 1 : Math.max(1, Number(t.leverage) || 1);
  return Math.round(((p - e) / e) * 100 * dir * lev * 100) / 100;
}

// v18.6.4 — close is now HONEST at every layer:
//   * INDIA: real dhanClosePosition DOM close (was a no-op {ok:true}!
//     journal CLOSED likh deta tha jabki broker pe position chalti rehti thi)
//   * CRYPTO: cxClosePosition + VERIFY via cxReadPositions — row abhi
//     bhi dikhi → CLOSE_UNKNOWN (retry loop upar)
//   * failure → CLOSE_UNKNOWN, trade monitored rehta hai + telegram alert
async function _closeTrade(t, reason, cfg, sendTelegram, ltpOverride) {
  t.browser ??= { actions: [], shots: [] };
  const exitPrice = Number(ltpOverride || t.lastLtp || t.entryPrice);
  let closeOk = true; let closeDetail = null; let verify = null;
  // v20.7.10 CRITICAL FIX: close TRADE ke mode pe gate hota hai, ENGINE ke
  // current config pe NAHI. Pehle cfg.mode dekhta tha — user live positions
  // khule rakh ke SAPTA ko paper me restart karta → broker close SKIP,
  // closeOk=true, row CLOSED — live position abandoned with a green
  // journal. Fill-verify (upar) pehle se t.mode use karta hai; ab close
  // bhi wahi. (Entry-time stamp t.mode = cfg.mode hota hai — line ~468.)
  if (t.mode === 'live') {
    try {
      const r = t.market === 'INDIA'
        ? await dhanClosePosition(t.symbol, t.side)
        : await cxClosePosition(t.pair, t.side);
      closeOk = Boolean(r?.ok);
      closeDetail = r;
      if (r?.shot) t.browser.shots.push(r.shot);
      // crypto: verify the row actually left the positions table
      if (closeOk && t.market !== 'INDIA') {
        try {
          const read = await cxReadPositions();
          if (read?.ok && Array.isArray(read.positions)) {
            const still = read.positions.some((p) => String(p.text || '').toUpperCase().includes(String(t.pair).toUpperCase()));
            if (still) { closeOk = false; verify = 'row-still-present'; }
            else verify = 'row-gone';
          } else {
            verify = 'unread'; // positions read failed — trust the close, journal honestly
          }
        } catch { verify = 'unread'; }
      }
    } catch (e) { closeOk = false; closeDetail = { error: String(e?.message || e) }; verify = 'exception'; }
  }
  // v20.8.5: TOTAL P&L = final leg + TP1 pe book kiye gaye legs (ek
  // TP1-partial ke baad reversal/SL/TP2 se hone wale har close ke liye
  // honest total — 'profit book karke exit' ka hisaab poora).
  const pnl = _pnlOf(t, exitPrice);
  const booked = Math.round(Number(t.bookedPnlINR) || 0);
  const totalPnl = pnl != null ? Math.round(pnl + booked) : (booked !== 0 ? booked : null);
  if (closeOk) {
    _updTrade(t.id, {
      status: 'CLOSED',
      closed: { ts: Date.now(), reason, exitPrice, pnlINR: totalPnl, ...(booked !== 0 ? { bookedPnlINR: booked, finalLegPnlINR: pnl } : {}), closeDetail: closeDetail ? { ok: true, steps: closeDetail.steps || closeDetail.error || null } : null, verify },
    });
    _log('exit', `CLOSE ${t.symbol} ${t.side} @ ~${exitPrice} — ${reason} | PnL ~${totalPnl ?? '?'} INR${booked !== 0 ? ` (final ${pnl ?? '?'} + TP1-booked ${booked})` : ''}${verify === 'unread' ? ' · positions read nahi hua — verify nahi' : ''}`);
    try { sendTelegram?.(`[PRO TRADER AUTO] CLOSE ${t.symbol} ${t.side} @ ~${exitPrice} — ${reason} — PnL ~${totalPnl ?? '?'} INR${booked !== 0 ? ` (incl. TP1-booked ₹${booked})` : ''}`); } catch { /* reconnect probe best-effort */ }
  } else {
    // v18.6.4: NEVER journal a close that did not happen — the trade
    // stays in CLOSE_UNKNOWN, the monitor re-attempts + alerts.
    const attempts = (t.closeAttempts || 0) + 1;
    _updTrade(t.id, {
      status: 'CLOSE_UNKNOWN', closeAttempts: attempts,
      closed: { ts: Date.now(), reason, exitPrice, pnlINR: totalPnl, ...(booked !== 0 ? { bookedPnlINR: booked } : {}), closeDetail: closeDetail ? { ok: false, steps: closeDetail.steps || closeDetail.error || null } : null, verify },
    });
    _log('error', `CLOSE UNVERIFIED ${t.symbol} — attempt ${attempts}/8 RE-ATTEMPT hoga — ${reason}${verify ? ` (${verify})` : ''}`);
    try { sendTelegram?.(`[PRO TRADER AUTO] ⚠️ ${t.symbol} ${t.side} CLOSE verify NAHI hua (attempt ${attempts}/8) — ${reason}. Engine RETRY karega, par broker panel me bhi check karo.`); } catch { /* boards scan best-effort */ }
  }
}

// ---------------- the tick ----------------
export async function proTraderTick(deps = {}, sendTelegram) {
  // v18.6.4 re-entrancy guard: ek tick me board compute + CDP browser
  // waits (select-pair 20s + place-order 30s + per-position close 25s)
  // 30s se aage nikal sakte hain — overlapped ticks double browser
  // clicks + journal read-modify-write races karte the.
  // v20.7.4: skip-log ab 5-min throttled — har tick repeat hone wale
  // "tick overlap" lines console flood kar rahe the.
  if (_s._ticking) {
    if (Date.now() - (_s._overlapLogAt || 0) > 5 * 60_000) {
      _s._overlapLogAt = Date.now();
      _log('skip', 'tick overlap — previous tick abhi bhi chal raha hai (browser CDP wait). Skip.');
    }
    return { ok: true, overlapped: true };
  }
  _s._ticking = true;
  try {
    const cfg = loadProTraderConfig();
    _s.lastTickAt = Date.now();
    _s.running = Boolean(cfg.enabled);
    _s.mode = cfg.mode;
    if (!cfg.enabled) { _broadcastStatusThrottled(); return { ok: true, idle: true }; }

    // global kill-switch always wins
    const tcfg = loadJSON(TRADING_CFG_FILE, {}) || {};
    if (tcfg.killSwitch) { _log('skip', 'global kill-switch ON — trades skip'); _broadcastStatusThrottled(); return { ok: true, killed: true }; }

    await _refreshBrowser().catch(() => {});

    // ---- scan boards (in-process, 60s-cached by signals.js) ----
    // v19.0: cryptoProduct 'futures' (default) → the CoinDCX FUTURES
    // board (B-{SYM}_USDT, USDT-margined — user-spec scope); 'spot'
    // restores the legacy CRYPTO/INR board.
    const { getSignals } = await import('./signals.js');
    const cryptoBoardKey = cfg.cryptoProduct === 'spot' ? 'CRYPTO' : 'FUTURES';
    const boards = {};
    if (cfg.desks.crypto) boards[cryptoBoardKey] = await getSignals(cryptoBoardKey, deps, { limit: 20 }).catch(() => null);
    if (cfg.desks.india) boards.INDIA = await getSignals('INDIA', deps, { limit: 20 }).catch(() => null);

    const all = [
      ...(boards[cryptoBoardKey]?.signals || []).map((s) => ({ ...s, market: cryptoBoardKey })),
      ...(boards.INDIA?.signals || []).map((s) => ({ ...s, market: 'INDIA' })),
    ];
    // v20.7.12 [H3-5]: NOTE — ye entry-cap 'open' set me UNFILLED NAHI hai
    // (PLACED TTL ka purana purpose: slot FREE karna). UNFILLED sirf
    // _monitorPositions me adopt-check ke liye aata hai, aur blockedSymbols
    // (neeche) re-entry rokta hai — slot free + symbol safe-blocked, dono.
    const open = _trades().filter((t) => ['MONITORING', 'PLACED', 'CLOSE_UNKNOWN'].includes(t.status));
    // v20.7.10: CLOSE_FAILED wale symbols RE-ENTRY BLOCK — broker pe
    // position abhi bhi khuli ho sakti hai (8 close attempts fail hue
    // the). Pehle cooldown ke baad doosri position khul sakti thi (double
    // exposure, ek journal row me). Ab jab tak journal me FAILED-close
    // row hai, symbol blocked — manually clear karo (journal edit) tab
    // naya entry.
    // v20.7.12 [H3-5]: UNFILLED bhi block — PLACED TTL ne slot free kiya
    // tha par broker pe resting GTC order abhi ZINDA ho sakta hai; usi
    // symbol pe naya entry + late fill = DOUBLE EXPOSURE. Jab tak row
    // UNFILLED hai (ya late-fill adopt ho ke MONITORING bani — tab to open
    // set me hai hi) symbol block. Manually clear (journal edit) tab
    // naya entry — alert message pehle se keh raha hai.
    const blockedSymbols = new Set(_trades().filter((t) => ['CLOSE_FAILED', 'UNFILLED'].includes(t.status)).map((t) => t.symbol));
    const cooldowns = {};
    for (const t of _trades()) {
      const closedAt = t.closed?.ts || 0;
      cooldowns[t.symbol] = Math.max(cooldowns[t.symbol] || 0, closedAt + cfg.cooldownMin * 60_000);
      // v20.7.4 FIX: browser-stage FAILED entry bhi symbol ko cool down
      // karo (min(cooldownMin,10) min) — warna wahi signal HAR 30s tick pe
      // fail hota rehta tha (user log: ENTRY FAILED ETH LONG har tick,
      // tick-overlap skip spam ka doosra root cause).
      if (t.status === 'FAILED' && t.ts) {
        cooldowns[t.symbol] = Math.max(cooldowns[t.symbol] || 0, t.ts + Math.min(cfg.cooldownMin, 10) * 60_000);
      }
    }
    const { best, evaluated } = pickProTraderCandidate(all, cfg, {
      existingSymbols: [...open.map((t) => t.symbol), ...blockedSymbols], cooldowns, now: Date.now(),
    });
    _s.lastScan = { at: Date.now(), candidates: evaluated, bestSymbol: best?.symbol || null, boards };

    // ---- caps ----
    const today = _todayIST();
    // v20.7.10: UNFILLED bhi daily cap me count NAHI hota (order fill hi
    // nahi hua tha — trade hua hi nahi; sirf slot-block tha jo ab free hai).
    const todayCount = _trades().filter((t) => t.day === today && !['FAILED', 'UNFILLED'].includes(t.status)).length;
    // v20.7.10: reconciler KILL-SWITCH (Telegram /halt → L1/L2/L3) + RAM
    // governor RED gate ab SAPTA entries ko bhi rokte hain. index.js ka
    // v20.6 comment claim karta tha ki "proTraderAuto reads" — par tick me
    // KAHIN reference nahi tha (sirf positionManager padhta tha).
    // Safety: isKilled() sirf EXPLICIT kill pe true (un-armed reconciler
    // kabhi block nahi karta); ramCanEnter() un-armed = true (no gate).
    // Monitoring/closes kabhi block NAHI hote — sirf NAYE entries.
    try {
      const rec = await import('../exec/reconciler.js');
      if (rec?.isKilled?.()) {
        _log('skip', `reconciler KILL L${rec.killLevel?.()} ON (${rec.killReason?.() || 'manual'}) — naye entries skip, monitoring chalu`);
        _broadcastStatusThrottled();
        await _monitorPositions(deps, cfg, sendTelegram);
        return { ok: true, killed: true };
      }
      // v20.9.4 FIX (H3): LEADER LEASE — reconciler.js ka documented claim
      // ("execution sirf ek node — SMARTAI_EXEC_NODE") pehle sirf
      // /api/exec/enter canEnterNew() enforce karta tha; SAPTA loop har
      // node pe apna node-local journal padta tha → dono nodes up ho to
      // same board pe duplicate browser/LIVE entries. Non-leader node ab
      // entries nahi karega — monitoring/closes hamesha chalte hain.
      if (typeof rec?.isLeader === 'function' && !rec.isLeader()) {
        _log('skip', 'leader lease — ye node non-leader hai, SAPTA naye entries skip (monitoring chalu)');
        _broadcastStatusThrottled();
        await _monitorPositions(deps, cfg, sendTelegram);
        return { ok: true, nonLeader: true };
      }
    } catch { /* reconciler unavailable — no gate */ }
    try {
      const { ramCanEnter } = await import('./ramGovernor.js');
      if (typeof ramCanEnter === 'function' && !ramCanEnter()) {
        _log('skip', 'RAM governor RED — naye entries block (positions manage hote rahenge)');
        _broadcastStatusThrottled();
        await _monitorPositions(deps, cfg, sendTelegram);
        return { ok: true, ramBlocked: true };
      }
    } catch { /* ramGovernor unavailable — no gate */ }
    if (best && open.length < cfg.maxConcurrent && todayCount < cfg.maxTradesPerDay && !_s.busyPlacing) {
      const r = await _tryEntry(deps, cfg, best, sendTelegram).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!r?.ok && r?.error && r.error !== 'busy' && !String(r.error).includes('browser tab')) {
        _log('skip', `entry skip ${best.symbol}: ${String(r.error).slice(0, 140)}`);
      }
    }

    await _monitorPositions(deps, cfg, sendTelegram);
    _broadcastStatusThrottled();
    return { ok: true };
  } finally {
    _s._ticking = false;
  }
}

// ---------------- status view ----------------
export function proTraderStatusView() {
  const cfg = loadProTraderConfig();
  const trades = _trades();
  const open = trades.filter((t) => ['MONITORING', 'PLACED', 'CLOSE_UNKNOWN'].includes(t.status));
  const today = _todayIST();
  const todayTrades = trades.filter((t) => t.day === today && !['FAILED', 'UNFILLED'].includes(t.status));
  const closedToday = trades.filter((t) => t.day === today && t.closed && t.status === 'CLOSED');
  const browser = browserStatus();
  return {
    ok: true,
    engine: 'SAPTA v18.6.4 — Superintelligence Advance AI Pro Trader Auto',
    running: Boolean(cfg.enabled && _s.running),
    mode: cfg.mode,
    startedAt: _s.startedAt,
    lastTickAt: _s.lastTickAt || null,
    lastTickAgeSec: _s.lastTickAt ? Math.max(0, Math.round((Date.now() - _s.lastTickAt) / 1000)) : null,
    nextScanInSec: Math.max(0, PROTRADER_TICK_SEC - Math.round((Date.now() - _s.lastTickAt) / 1000)),
    gates: { minAiScore: cfg.minAiScore, minConfidence: cfg.minConfidence, minVerifiedScore: cfg.minVerifiedScore, requireVerifyConfirm: cfg.requireVerifyConfirm, reversalConfirmTicks: REVERSAL_CONFIRM_NEEDED, tpExits: { enabled: Boolean(cfg.tpExitsEnabled), tp1ClosePct: cfg.tp1ClosePct, tp1BreakevenLock: cfg.tp1BreakevenLock !== false },
      // v20.9.0 (B2 — provisional label): v20.8.5 ka 70 threshold GUT
      // call tha (90 reachable nahi tha). Calibration ledger data
      // Jama karta hai; threshold tab tak provisional hai jab tak
      // walk-forward OOS validate na ho. Saved user value kabhi
      // overwrite nahi hota.
      provisionalThreshold: true,
      // v20.9.0 (H1): hard-gate caps ab status me dikhte hain
      hardGate: { maxDailyLossINR: Number(cfg.maxDailyLossINR) > 0 ? Number(cfg.maxDailyLossINR) : 3 * (Number(cfg.stakeINR) || 500), maxConsecutiveLosses: cfg.maxConsecutiveLosses, maxDrawdownKillPct: cfg.maxDrawdownKillPct },
      ranking: 'netExpectedR', },
    config: cfg,
    browser: { connected: browser.connected, browser: browser.browser, host: browser.host, port: browser.port, portsTried: browser.portsTried, tabs: browser.tabs, lastError: browser.lastError, hint: browser.hint },
    candidates: (_s.lastScan?.candidates || []).slice(0, 6),
    positions: open.map((t) => ({
      id: t.id, market: t.market, symbol: t.symbol, side: t.side, entryPrice: t.entryPrice, sl: t.sl, tp: t.tp, tp2: t.tp2 ?? null,
      tp1Hit: Boolean(t.tp1Hit), tp2Hit: Boolean(t.tp2Hit), tp1Px: t.tp1Px ?? null, bookedPnlINR: Number(t.bookedPnlINR) || 0,
      lastLtp: t.lastLtp, ltpStale: Boolean(t.ltpStale), lastPnlINR: t.lastPnlINR ?? null, lastRoePct: t.lastRoePct ?? null,
      pnlBasis: t.pnlBasis || 'notional', qtyEstimate: t.qtyEstimate ?? null, product: t.product ?? null,
      leverage: t.leverage, mode: t.mode, status: t.status,
      closeAttempts: t.closeAttempts || 0,
      confirmStreak: t.confirmStreak || 0, reversalReasons: t.reversalReasons || [], lastCheckAt: t.lastCheckAt,
      signal: t.signal,
    })),
    today: { trades: todayTrades.length, cap: cfg.maxTradesPerDay, closed: closedToday.length, pnlINR: closedToday.reduce((a, t) => a + (Number(t.closed?.pnlINR) || 0), 0) },
    log: _s.log.slice(-120),
    shotsDir: 'server/data/protrader-shots',
  };
}

// ---------------- browser test (DOM health probe) ----------------
export async function proTraderBrowserTest() {
  const r = await browserConnect({ probe: true, force: true }).catch((e) => ({ connected: false, error: String(e?.message || e) }));
  const cx = r?.tabs?.coindcx?.found ? 'found' : 'missing';
  const dh = r?.tabs?.dhan?.found ? 'found' : 'missing';
  // v18.6.2: reason + fix hint log me hi dikhao — user ko batana KYU fail hua.
  const why = String(r?.lastError || r?.error || r?.tabs?.coindcx?.hint || r?.tabs?.dhan?.hint || '').trim();
  _log('info', `BROWSER HEALTH: connected=${r.connected} coindcx=${cx} dhan=${dh}${why ? ` — ${why.slice(0, 200)}` : ''}`);
  return r;
}

// ---------------- dry run: what WOULD the agent do now ----------------
export async function proTraderTestRun(deps = {}) {
  const cfg = loadProTraderConfig();
  const { getSignals } = await import('./signals.js');
  const boards = {};
  boards[cfg.cryptoProduct === 'spot' ? 'CRYPTO' : 'FUTURES'] = await getSignals(cfg.cryptoProduct === 'spot' ? 'CRYPTO' : 'FUTURES', deps, { limit: 20 }).catch(() => null);
  boards.INDIA = await getSignals('INDIA', deps, { limit: 20 }).catch(() => null);
  const all = [
    ...((boards[cfg.cryptoProduct === 'spot' ? 'CRYPTO' : 'FUTURES']?.signals) || []).map((s) => ({ ...s, market: cfg.cryptoProduct === 'spot' ? 'CRYPTO' : 'FUTURES' })),
    ...(boards.INDIA?.signals || []).map((s) => ({ ...s, market: 'INDIA' })),
  ];
  const open = _trades().filter((t) => ['MONITORING', 'PLACED'].includes(t.status));
  const { best, evaluated } = pickProTraderCandidate(all, cfg, { existingSymbols: open.map((t) => t.symbol), cooldowns: {}, now: Date.now() });
  const plan = best ? {
    market: best.market, symbol: best.symbol, side: best.side,
    entry: best.plan.entry, sl: best.plan.stopLoss, tp1: best.plan.target1,
    scores: { ai: best.superIntel?.aiScore, conf: best.confidence, verified: best.verify?.score, verifyAction: best.verify?.action, finalCall: best.verify?.finalCall },
    browserFlow: best.market === 'INDIA'
      ? [`dhan.co me "${best.symbol}" search`, `LIMIT price ${best.plan.entry}`, `qty = floor(${cfg.stakeINR}/${best.plan.entry})`, `product ${cfg.indiaProduct}`, `${best.side === 'LONG' ? 'BUY' : 'SELL'} click + confirm`]
      : best.market === 'FUTURES'
        ? [`coindcx.com/futures/B-${best.symbol}_USDT page`, `LIMIT price ${best.plan.entry} (read-back verify)`, `amount = ${cfg.stakeINR}₹ / fx / price`, `qty verify + ${best.side === 'LONG' ? 'BUY' : 'SELL'} click`]
        : [`coindcx.com me ${best.symbol}INR search`, useMarginText(cfg), `LIMIT price ${best.plan.entry}`, `total ${cfg.stakeINR} INR`, `${best.side === 'LONG' ? 'BUY' : 'SELL'} click + confirm`],
    liveWouldClick: cfg.mode === 'live' && cfg.enabled,
  } : null;
  return { ok: true, dryRun: true, plan, evaluated: evaluated.slice(0, 10) };
}
function useMarginText(cfg) { return Number(cfg.cryptoLeverage) > 1 ? `Margin tab + leverage ~${cfg.cryptoLeverage}x` : 'Spot order (no leverage)'; }

export function proTraderWalletLeverage(walletINR) { return walletLeverageForEquityINR(walletINR); }

// v21.23.1: test seam — `_tryEntry` internal hai; direction-lock acquire wiring
// regression tests isse direct call kar sakein (paper mode → no browser touch).
export const __internals = { _tryEntry };
