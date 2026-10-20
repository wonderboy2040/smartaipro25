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
import { dualAutoCandidates } from './mtfDualBoard.js';
import { SUPER_TIERS } from './superIntel.js';
import { walletLeverageForEquityINR, feeBreakevenFloor, evaluateFeeAwareReversalExit } from '../exec/sizing.js';
// v21.23.1: `releaseDirectionLock` yahan se HATA diya — release ab DO authoritative
// jagah se hota hai: (1) paperTrading.js `_closePart` central close hook (har paper
// trade close pe immediate, symbol-flat check ke saath), (2) routes.js 60s watcher
// `reconcileDirectionLocks()` sweep (ALL books — live/journal/SAPTA — se flat detect).
import { acquireDirectionLock, checkDirectionLock, __resetDirectionLocksForTests } from './directionLock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// v21.16.0 FIX (pro-level recheck): paths LAZY resolve hote hain + test ke
// liye env override (MTF_AUTO_DATA_DIR). Pehle module-scope constant paths
// the — vitest suite REAL server/data/ me config/state likh deti thi aur
// boot ke waqt user ka saved auto-config uda sakti thi. Ab: runtime data
// kabhi test se touch nahi hota; suite apna tmp dir set karti hai.
const _dataDir = () => process.env.MTF_AUTO_DATA_DIR || DATA_DIR;
const CFG_FILE = () => path.join(_dataDir(), 'mtf-auto-config.json');
const STATE_FILE = () => path.join(_dataDir(), 'mtf-auto-state.json');

export const MTF_AUTO_TICK_SEC = 60;
const MAX_EVENTS = 200;
const TIME_STOP_GRACE_MS = 4 * 60_000; // watcher ko SL/T1/T2 ka mauka do

export const MTF_AUTO_DEFAULTS = {
  enabled: false,                  // opt-in — default OFF (paper only)
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
  // v21.23.6 USER SPEC: "jab trade successful close hone LIVE Auto trade 5 min ka
  // cooldown lagake then phir auto trade signals me ELITE top trade verify karke
  // trade lagna chahiye" — successful close ke baad LIVE re-entry sirf
  // 5-minute cooldown ke BAAD, elite-verified signal pe.
  postSuccessCooldownMin: 5,
};
const CLAMPS = {
  minScore: [Number(SUPER_TIERS.ACTION), 95],
  riskPerTradeINR: [100, 25000],
  maxPositionsINR: [1000, 1000000],
  maxNotionalPerTradeINR: [1000, 500000],
  maxTradesPerDay: [1, 25],
  maxOpenPositions: [1, 10],        // paper engine ka apna 10-open guard bhi hai
  cooldownMin: [5, 720],
  inrPerUsdt: [40, 150],
  walletAmountINR: [500, 10000000],
  walletDeployPct: [10, 100],
  belowTenKLeverage: [1, 20],
  aboveTenKLeverage: [1, 20],
  postSuccessCooldownMin: [0, 120],   // v21.23.6: 0 = cooldown OFF; max 2h
};
const MODES = new Set(['INTRADAY', 'SWING', 'SCALP']);

let _cfg = null;
let _state = null;
let _mtfAutoTickInFlight = false;

const clampN = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function _save(file, obj) {
  try {
    fs.mkdirSync(_dataDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch { /* non-fatal — state stays in memory */ }
}

export function loadMtfAutoConfig() {
  if (_cfg) return _cfg;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')); } catch { raw = {}; }
  _cfg = _sanitizeCfg({ ...MTF_AUTO_DEFAULTS, ...raw, desks: { ...MTF_AUTO_DEFAULTS.desks, ...(raw.desks || {}) } });
  return _cfg;
}

function _sanitizeCfg(cfg) {
  const out = { ...cfg };
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
  out.feeAwareReversalExit = cfg.feeAwareReversalExit !== false;
  out.deepMonitorEnabled = cfg.deepMonitorEnabled !== false;
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
 * Monitors any active auto-trade from Entry until TP1 or TP2 hits:
 *   • Stage 0: Initial Guard (SL at initial stopLoss)
 *   • Stage 1 (+0.35R): Risk Halved — SL trailed to -0.45R
 *   • Stage 2 (+0.55R): Fee-Free Breakeven Lock — SL trailed above round-trip fee floor (ZERO LOSS)
 *   • Stage 3 (+0.80R): Pre-TP1 Profit Ratchet — SL trailed to +0.45R net profit
 *   • Stage 4 (>= +1.00R / TP1 Hit): TP1 60% Booked + Runner SL trailed to +0.65R floor
 *     (peakR−0.45R ratchet) targeting TP2 — v21.23.6: 0.32R→0.45R giveback room
 *   • Stage 5 (>= +1.40R -> TP2): Runner SL trailed to TP1 (+1.0R) + 0.50R chandelier until
 *     TP2 (2.0R) full exit — v21.23.6: 0.30R→0.50R (normal pullbacks ab runner nahi maarte)
 *   • Reversal Guard v21.23.6: book ONLY on a CONFIRMED flip (board side actually flipped +
 *     trigger fired / superScore >= 65) or a DEEP giveback (>=45% of peak AND >=0.28R absolute).
 *     Risk hints (reversalRisk / context.exhausted / opposingFlow) — jo strong trends me
 *     ROUTINELY fire hote the aur +0.12R pe trade band kar dete the jabki trend jaari rehta
 *     tha — ab SIRF SL profit-lock tighten karte hain, trade band NAHI hota.
 */
export function evaluateActiveTradeDeepMonitor(trade = {}, liveCtx = {}) {
  const side = String(trade.side || trade.direction || 'LONG').toUpperCase();
  const isLong = side !== 'SHORT';
  const entry = Number(trade.entry ?? trade.entryPrice) || 0;
  const initialSl = Number(trade.initialStopLoss ?? trade.stopLoss ?? trade.sl) || 0;
  const currentSl = Number(trade.trailedStopLoss ?? trade.stopLoss ?? trade.sl) || initialSl;
  const t1 = Number(trade.t1 ?? trade.target1 ?? trade.tp) || 0;
  const t2 = Number(trade.t2 ?? trade.target2 ?? trade.tp2) || 0;
  const ltp = Number(liveCtx.ltp ?? trade.ltp ?? entry) || entry;
  const qty = Number(trade.qty) || 1;
  const market = String(trade.execMarket || trade.market || 'FUTURES').toUpperCase();
  const ccy = trade.ccy || (market === 'INDIA' ? 'INR' : 'USDT');
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
  const tp2Touched = Boolean(t2 > 0 && (isLong ? ltp >= t2 : ltp <= t2));

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
  } else if (peakR >= 1.4 || (tp1Touched && peakR >= 1.25)) {
    stageCode = 'STAGE_5_RUNNER_TO_TP2';
    stageLabel = 'Stage 5 · TP1 Locked + Structure Trail → TP2';
    // v21.23.6: 0.30R → 0.50R chandelier — strong-trend pullbacks (NORMAL hai)
    // ab trail-stop se runner ko maar nahi dete; floor TP1 (>= +1.0R) pe hai hi.
    const chandelierTrail = isLong ? peakPrice - 0.50 * risk : peakPrice + 0.50 * risk;
    candidateSl = tightenSl(candidateSl, tightenSl(t1 > 0 ? t1 : priceAtR(1.0), chandelierTrail));
  } else if (tp1Touched || peakR >= 1.0) {
    stageCode = 'STAGE_4_TP1_LOCKED';
    // v21.23.6: giveback room 0.32R → 0.45R (floor +0.65R as-is) — TP1 ke
    // baad ka normal pullback ab SL trigger nahi karta, runner TP2 tak zinda.
    const lockR = Math.max(0.65, +(peakR - 0.45).toFixed(2));
    stageLabel = `Stage 4 · TP1 Hit (60% Booked) · SL Auto-Trailed +${lockR}R`;
    candidateSl = tightenSl(candidateSl, priceAtR(lockR));
  } else if (peakR >= 0.80) {
    stageCode = 'STAGE_3_PROFIT_RATCHET';
    const lockR = Math.max(0.45, +(peakR - 0.32).toFixed(2));
    stageLabel = `Stage 3 · Pre-TP1 Profit Ratchet (+${lockR}R Locked)`;
    candidateSl = tightenSl(candidateSl, priceAtR(lockR));
  } else if (peakR >= 0.50) {
    stageCode = 'STAGE_2_BREAKEVEN_PLUS';
    const lockR = Math.max(0.15, +((peakR - 0.35) * 0.65).toFixed(2));
    stageLabel = `Stage 2 · Fee-Protected Breakeven + Auto-Trail (+${lockR}R Zero-Loss)`;
    const bePlus = isLong ? Math.max(feeFloor, priceAtR(lockR)) : Math.min(feeFloor, priceAtR(lockR));
    candidateSl = tightenSl(candidateSl, bePlus);
  } else if (peakR >= 0.30) {
    stageCode = 'STAGE_1_RISK_HALVED';
    const lockR = peakR >= 0.42 && peakCoveredFee ? 0.05 : Math.max(-0.45, +(peakR - 0.80).toFixed(2));
    stageLabel = peakR >= 0.42 && peakCoveredFee
      ? 'Stage 1 · Early Breakeven Shield (Zero-Loss Lock)'
      : 'Stage 1 · Early Profit Shield (Risk Cut 50%+)';
    const shieldPx = peakR >= 0.42 && peakCoveredFee
      ? (isLong ? Math.max(feeFloor, priceAtR(0.05)) : Math.min(feeFloor, priceAtR(0.05)))
      : priceAtR(lockR);
    candidateSl = tightenSl(candidateSl, shieldPx);
  } else if (peakR >= 0.18) {
    stageCode = 'STAGE_1_EARLY_SHIELD';
    stageLabel = 'Stage 1 · Ultra-Fast Micro-Shield (Risk Cut 35%)';
    candidateSl = tightenSl(candidateSl, priceAtR(-0.65));
  }

  // Realtime Trend & Reversal Detection (Bullish <-> Bearish)
  const boardRow = liveCtx.boardRow || null;
  const oppSide = isLong ? 'SHORT' : 'LONG';
  const boardFlipped = Boolean(
    boardRow && (
      (String(boardRow.side || '').toUpperCase() === oppSide && (boardRow.triggerFired || Number(boardRow.superScore) >= 65))
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
  // v21.23.6 PULLBACK TOLERANCE: strong trend me chhote pullbacks NORMAL hai —
  // "ek ek baar thoda pull back bhi hota hai". Book sirf DEEP giveback pe:
  // >=45% of peak AND >=0.28R absolute (pehle 38% tha bina absolute floor ke —
  // har normal pullback trade band kar deta tha).
  const peakPullbackReversal = peakR >= 0.50 && peakGivebackRatio >= 0.45 && givebackR >= 0.28 && feeCovered;
  const trailedSlHit = candidateSl > 0 && (isLong ? ltp <= candidateSl : ltp >= candidateSl);
  const slImproved = candidateSl > 0 && currentSl > 0 && Math.abs(candidateSl - currentSl) > 1e-7 && (isLong ? candidateSl > currentSl : candidateSl < currentSl);

  // If mild reversal signal appears before feeCovered (either explicit boardFlipped, or giveback after peakR >= 0.45),
  // defensively tighten SL to -0.35R to prevent full SL hit
  if ((boardFlipped || reversalRiskHint || peakGivebackRatio >= 0.45) && !feeCovered && currentR > -0.30) {
    candidateSl = tightenSl(candidateSl, priceAtR(-0.35));
    stageLabel = `${stageLabel} · Defensive Reversal Tighten`;
  }
  // v21.23.6 REVERSAL-RISK PROFIT-LOCK (tighten ONLY — trade band NAHI hota):
  // exhaustion/opposing-flow hint ke saath profit me ho to SL ko peak−0.50R
  // (min +0.15R) pe lock karo — giveback protection WITHOUT closing a
  // potentially-still-strong trend. tightenSl monotonic hai — stage locks
  // isse loose nahi hote.
  if (reversalRiskHint && feeCovered && peakR >= 0.45) {
    const hintLockR = Math.max(0.15, +(peakR - 0.50).toFixed(2));
    candidateSl = tightenSl(candidateSl, priceAtR(hintLockR));
    stageLabel = `${stageLabel} · Reversal-Risk Profit-Lock`;
  }

  const reversalConfirmed = Boolean(boardFlipped || peakPullbackReversal || liveCtx.reversalConfirmed);
  const shouldBookProfitNow = Boolean(
    tp2Touched
    || (reversalConfirmed && feeCovered && currentR >= 0.12)
    || (trailedSlHit && feeCovered && peakR >= 0.50)
  );
  const shouldExitDefensiveSl = Boolean(trailedSlHit && !shouldBookProfitNow);

  const exitReason = tp2Touched
    ? 'TP2_TARGET_HIT_FULL_PROFIT'
    : (reversalConfirmed && feeCovered && currentR >= 0.12)
      ? (tp1Touched ? 'T1_BOOKED_REVERSAL_PROFIT_LOCK' : 'PRE_T1_REVERSAL_PROFIT_BOOKED')
      : (trailedSlHit && feeCovered)
        ? 'TRAILED_SL_PROFIT_BOOKED'
        : shouldExitDefensiveSl
          ? 'TRAILED_SL_PROTECTIVE_EXIT'
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
    trendStatus,
    reversalDetected: reversalConfirmed,
    shouldBookProfitNow,
    shouldExitDefensiveSl,
    shouldClose: shouldBookProfitNow || shouldExitDefensiveSl,
    exitReason,
    checkedAt: Date.now(),
  };
}

export function updateMtfAutoConfig(patch = {}) {
  const next = _sanitizeCfg({ ...loadMtfAutoConfig(), ...patch, desks: { ...loadMtfAutoConfig().desks, ...(patch.desks || {}) } });
  _cfg = next;
  _save(CFG_FILE(), next);
  _logEvent('config', `config updated — ${JSON.stringify({ enabled: next.enabled, mode: next.mode, minScore: next.minScore, riskPerTradeINR: next.riskPerTradeINR, maxPositionsINR: next.maxPositionsINR, maxTradesPerDay: next.maxTradesPerDay })}`);
  return next;
}

export function setMtfAutoEnabled(enabled) {
  return updateMtfAutoConfig({ enabled: Boolean(enabled) });
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
    book: Array.isArray(raw.book) ? raw.book.slice(-100) : [],
    events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
    lastTick: raw.lastTick || null,
  };
  return _state;
}
function _persistState() { _save(STATE_FILE(), _loadState()); }

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
    st.day = key;
    st.dayCount = 0;
    st.perSymbolLast = {};
    _persistState();
  }
  return st;
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
function _openNotionalINR() {
  return _openLinked().reduce((a, b) => a + (Number(b.notional) || 0), 0);
}
/**
 * v21.23.6: last SUCCESSFUL close epoch (persisted book se — restart-safe).
 * Successful = net pnl > 0 YA exchange ne position band ki jab wo >=0.5R
 * profit stage me thi (native TP/trailed-SL fills jahan row pnl null rehta
 * hai — EXCHANGE_POSITION_CLOSED). PURGED rows kabhi count nahi hote.
 */
function _lastProfitCloseAt() {
  const st = _loadState();
  let at = 0;
  for (const b of st.book) {
    if (b.status !== 'CLOSED' || !Number(b.closedAt)) continue;
    const reason = String(b.closeReason || '');
    const success = Number(b.pnl) > 0
      || reason.includes('PROFIT')
      || (reason === 'EXCHANGE_POSITION_CLOSED' && Number(b.peakR) >= 0.5);
    if (success) at = Math.max(at, Number(b.closedAt));
  }
  return at;
}
function _paperOpenSymbols(paperSummary) {
  const set = new Set();
  for (const t of paperSummary?.open || []) set.add(String(t.symbol || '').toUpperCase());
  return set;
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
    const side = String(pos.side || (Number(pos.activePos) < 0 ? 'SHORT' : 'LONG')).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const isLong = side !== 'SHORT';
    const leverage = Math.max(1, Number(pos.leverage) || computeMtfWalletLeverage(cfg.walletAmountINR, cfg));
    const ltp = Number(pos.ltp ?? pos.markPrice ?? entry) || entry;
    const defaultRiskPct = 0.012; // 1.2% protective stop if position had no SL set
    const initialSl = Number(pos.stopLoss ?? pos.sl) > 0
      ? Number(pos.stopLoss ?? pos.sl)
      : +(isLong ? entry * (1 - defaultRiskPct) : entry * (1 + defaultRiskPct)).toFixed(6);
    const riskUnit = Math.max(entry * 0.004, Math.abs(entry - initialSl));
    const t1 = Number(pos.t1 ?? pos.tp1 ?? pos.tp) > 0
      ? Number(pos.t1 ?? pos.tp1 ?? pos.tp)
      : +(isLong ? entry + 1.25 * riskUnit : entry - 1.25 * riskUnit).toFixed(6);
    const t2 = Number(pos.t2 ?? pos.tp2 ?? pos.tp) > 0
      ? Number(pos.t2 ?? pos.tp2 ?? pos.tp)
      : +(isLong ? entry + 2.4 * riskUnit : entry - 2.4 * riskUnit).toFixed(6);

    const existing = st.book.find(b => b.status === 'OPEN' && b.symbol === sym);
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
      existing.entry = entry;
      existing.leverage = leverage;
      if (ltp > 0) existing.ltp = ltp;
      if (!(existing.stopLoss > 0)) existing.stopLoss = initialSl;
      if (!(existing.initialStopLoss > 0)) existing.initialStopLoss = initialSl;
      if (!(existing.trailedStopLoss > 0)) existing.trailedStopLoss = existing.stopLoss;
      if (!(existing.t1 > 0)) existing.t1 = t1;
      if (!(existing.t2 > 0)) existing.t2 = t2;
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
      qty,
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
        changed = true;
      }
    }
  }

  if (changed) _persistState();
  return { ok: true, activeCount: synced.length, synced };
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
  const out = { at: now, opened: [], closed: [], skipped: [], candidates: 0, considered: 0 };

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
  const openSymbols = _paperOpenSymbols(summary);
  for (const b of _openLinked()) {
    if (b.symbol) openSymbols.add(String(b.symbol).toUpperCase());
  }

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
    for (const b of _openLinked()) {
      const mktBoard = p.boards?.[b.market];
      const allBoardRows = [
        ...(mktBoard?.rows || []),
        ...(mktBoard?.metalsRows || []),
        ...(mktBoard?.equitySimRows || []),
      ];
      const boardRow = allBoardRows.find(r => normalizeLinkSymbol(r?.symbol, b.market) === b.symbol);
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

      const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
      const revByRow = Boolean(
        boardRow && (
          (String(boardRow.side || '').toUpperCase() === oppSide && (boardRow.triggerFired || Number(boardRow.superScore) >= 65))
          || (boardRow.context?.dir != null && ((b.side === 'LONG' && boardRow.context.dir < 0 && boardRow.triggerDir < 0) || (b.side === 'SHORT' && boardRow.context.dir > 0 && boardRow.triggerDir > 0)))
        )
      );

      const effectiveCurSl = (() => {
        const s1 = Number(b.trailedStopLoss ?? b.stopLoss) || 0;
        const s2 = Number(livePaper?.stopLoss) || 0;
        if (s1 > 0 && s2 > 0) return b.side === 'SHORT' ? Math.min(s1, s2) : Math.max(s1, s2);
        return s1 || s2;
      })();

      // Run Deep Monitor (5-stage dynamic SL trail + TP1/TP2 tracker + peak-giveback & trend-flip reversal guard)
      const deepEval = evaluateActiveTradeDeepMonitor({
        ...b,
        stopLoss: effectiveCurSl,
        t1Hit: Boolean(livePaper?.t1Hit || b.t1Hit),
        qty: Number(livePaper?.qty ?? b.qty ?? 1),
      }, {
        ltp: rawQuote,
        boardRow,
        reversalConfirmed: revByRow,
      });

      // Persist updated peakPrice, trailedStopLoss, stage, and live telemetry on the linked book record
      b.ltp = rawQuote;
      b.peakPrice = deepEval.peakPrice;
      b.currentR = deepEval.currentR;
      b.peakR = deepEval.peakR;
      b.t1Hit = deepEval.tp1Hit;
      b.deepMonitorStage = deepEval.stageCode;
      b.deepMonitorLabel = deepEval.stageLabel;
      b.trendStatus = deepEval.trendStatus;
      if (deepEval.slTrailed && deepEval.trailedStopLoss > 0) {
        const prevSl = b.trailedStopLoss ?? b.stopLoss;
        b.trailedStopLoss = deepEval.trailedStopLoss;
        b.stopLoss = deepEval.trailedStopLoss;
        if (livePaper) livePaper.stopLoss = deepEval.trailedStopLoss;
        if (b.executionMode === 'LIVE' && typeof p.liveUpdateSl === 'function') {
          const lastSyncSl = Number(b.lastExchangeSl) || 0;
          const slDeltaPct = lastSyncSl > 0 ? Math.abs(deepEval.trailedStopLoss - lastSyncSl) / lastSyncSl : 1;
          if (slDeltaPct >= 0.0005) {
            try {
              const slRes = await p.liveUpdateSl({ ...b, stopLoss: deepEval.trailedStopLoss, takeProfit: b.t2 });
              if (slRes?.ok) b.lastExchangeSl = deepEval.trailedStopLoss;
            } catch { /* non-fatal */ }
          }
        }
        _logEvent('sl-trail', `🛡️ DEEP MONITOR SL TRAILED ${b.symbol} (${b.side}): SL ${prevSl} → ${deepEval.trailedStopLoss} [${deepEval.stageLabel}] @ LTP ${rawQuote} (${deepEval.currentR >= 0 ? '+' : ''}${deepEval.currentR}R)`);
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
        reversalReasons: [`board flipped ${oppSide} (${boardRow?.superScore ?? '—'})`],
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

      if (shouldExitByReversalOrTrail) {
        if (b.executionMode === 'LIVE' && typeof p.liveClose === 'function') {
          try { await p.liveClose(b); } catch { /* non-fatal */ }
        }
        const r = paper.closePaperTrade(b.paperId, {
          ...(p.quotes || {}),
          [b.symbol]: { price: rawQuote },
          [`${b.execMarket || b.market}|${b.symbol}`]: { price: rawQuote },
        });
        if (r?.ok || b.executionMode === 'LIVE') {
          const ccyPrefix = b.ccy === 'USDT' ? '$' : '₹';
          b.status = 'CLOSED';
          b.closeReason = revEval?.shouldExit ? revEval.stage : (deepEval.exitReason || 'DEEP_MONITOR_PROFIT_BOOK');
          b.closedAt = now;
          b.pnl = r?.trade?.realizedPnl ?? revEval?.netTotalPnl ?? deepEval.grossPnl;
          out.closed.push({
            symbol: b.symbol,
            market: b.market,
            reason: b.closeReason,
            pnl: b.pnl,
            feeCovered: Boolean(revEval?.feeCovered || deepEval.feeCovered),
            feeBePrice: revEval?.feeBePrice ?? deepEval.feeBreakevenPrice,
            trailedStopLoss: b.trailedStopLoss ?? b.stopLoss,
          });
          _logEvent('reversal-exit', `REVERSAL FEE-SAFE EXIT ${b.symbol} @ ${rawQuote} (reason ${b.closeReason} · fee floor ${deepEval.feeBreakevenPrice}) — pnl ${ccyPrefix}${b.pnl ?? '—'} (ZERO LOSS)`);
          if (typeof p.notify === 'function') {
            try { await p.notify(`🛡️ MTF AUTO Deep Monitor Exit: ${b.symbol} ${b.side} closed @ ${rawQuote} (${b.closeReason}) — net pnl ${ccyPrefix}${b.pnl ?? '—'}`); } catch { /* non-fatal */ }
          }
        }
      } else if (revByRow && revEval && !revEval.feeCovered) {
        _logEvent('reversal-hold', `REVERSAL FEE-GUARD HOLD ${b.symbol}: ltp ${rawQuote} has not cleared fee-breakeven ${revEval.feeBePrice} — holding to prevent fee loss (SL tightened to ${b.trailedStopLoss ?? b.stopLoss})`);
      }
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
      const r = paper.closePaperTrade(b.paperId, p.quotes);
      if (r?.ok) {
        const ccyPrefix = b.ccy === 'USDT' ? '$' : '₹';
        b.status = 'CLOSED';
        b.closeReason = `TIME_STOP ${b.holdMin}m`;
        b.closedAt = now;
        b.pnl = r.trade?.realizedPnl ?? null;
        out.closed.push({ symbol: b.symbol, market: b.market, reason: b.closeReason, pnl: b.pnl });
        _logEvent('time-exit', `TIME-STOP ${b.symbol} after ${Math.round(ageMs / 60000)}m (window ${b.holdMin}m) — pnl ${ccyPrefix}${b.pnl ?? '—'}`);
        if (typeof p.notify === 'function') { try { await p.notify(`⏱ MTF AUTO time-stop: ${b.symbol} ${b.side} closed at ${b.holdMin}m window — pnl ${ccyPrefix}${b.pnl ?? '—'}`); } catch { /* non-fatal */ } }
      }
    }
    _persistState();
  }

  // ---------- 2) NEW ENTRIES per desk (STRICT 1-TRADE-PER-SESSION FULL-WALLET LOCK) ----------
  if (!cfg.enabled) {
    out.skipped.push('auto-link OFF');
    const stf = _loadState();
    stf.lastTick = { at: now, opened: out.opened.length, closed: out.closed.length, skipped: out.skipped.slice(0, 4) };
    _persistState();
    return out;
  }

  // v21.22.0 USER SPEC:
  // "ab sirf auto trade button activate hone par Strong trade ko verfied signal lagna chahiye
  //  long or short accurately aur 1 session me ek hi trade aur full amount of wallet ka
  //  ye trade hone ke baad then next trade ek sath 2 trades mat lagao"
  const isLiveSession = cfg.executionMode === 'live' || Boolean(p.siteLiveActive && cfg.autoSyncSiteLive !== false);
  const currentOpenInSession = _openLinked();
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
    const lastSuccessAt = _lastProfitCloseAt();
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
    if (isLiveSession && _openLinked().length >= 1) break;
    const deskOn = market === 'INDIA' ? cfg.desks.india : cfg.desks.crypto;
    if (!deskOn) { out.skipped.push(`${market} desk off`); continue; }
    // market gate
    if (market === 'INDIA' && !(isNseMarketOpen() && freshEntriesAllowedFor('INDIA'))) { out.skipped.push('INDIA: NSE closed / past 15:00 cutoff'); continue; }
    const board = p.boards?.[market];
    if (!board?.ok || !Array.isArray(board.rows)) { out.skipped.push(`${market}: board unavailable`); continue; }

    _rollDayIfNeeded();
    const stDay = _loadState(); // day counters (rolled above)
    // budget / quota gates (market-wise counters use the SAME day bucket)
    const deskDay = dayKeyFor(market === 'INDIA' ? 'INDIA' : 'CRYPTO');
    const dayCountForDesk = stDay.book.filter(b => b.market === market && b.dayKey === deskDay).length;
    const openForDesk = _openLinked().filter(b => b.market === market).length;
    const isLiveExecActive = isLiveSession;
    const effectiveMaxOpenPositions = isLiveExecActive ? 1 : cfg.maxOpenPositions;
    const effectiveMaxTradesPerDay = (isLiveExecActive && openForDesk === 0) ? Math.max(cfg.maxTradesPerDay, 15) : cfg.maxTradesPerDay;
    if (stDay.dayCount >= effectiveMaxTradesPerDay) { out.skipped.push(`${market}: daily quota ${stDay.dayCount}/${cfg.maxTradesPerDay} done`); continue; }
    if (dayCountForDesk >= effectiveMaxTradesPerDay) { out.skipped.push(`${market}: desk quota done`); continue; }
    if (openForDesk >= effectiveMaxOpenPositions || _openLinked().length >= effectiveMaxOpenPositions) { out.skipped.push(`${market}: max open positions (${openForDesk}/${effectiveMaxOpenPositions})`); continue; }
    if (_openNotionalINR() >= cfg.maxPositionsINR) { out.skipped.push(`${market}: notional budget full (₹${Math.round(_openNotionalINR())}/${cfg.maxPositionsINR})`); continue; }

    const poolRows = market === 'CRYPTO' && Array.isArray(board.metalsRows)
      ? [...board.rows, ...board.metalsRows.filter(m => !board.rows.some(r => r?.symbol === m?.symbol))]
      : board.rows;
    // When 0 positions are currently open in Live Auto mode, bypass stale symbol cooldown so user's Live Auto click always fires
    const effectiveLastEntryAt = (isLiveExecActive && _openLinked().length === 0) ? {} : stDay.perSymbolLast;
    const picks = dualAutoCandidates(poolRows, cfg, { openSymbols, lastEntryAt: effectiveLastEntryAt, now });
    out.considered += picks.length;
    let eligible = picks.filter(r =>
      r.autoPickBlockers.length === 0
      && (r.side === 'LONG' || r.side === 'SHORT')
      && r.directionVerified !== false
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
    if (eligible.length === 0 && isLiveExecActive && _openLinked().length === 0) {
      eligible = picks.filter(r =>
        (r.side === 'LONG' || r.side === 'SHORT')
        && r.directionVerified === true
        && r.triggerFired === true
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

    let openedThisDesk = 0;
    for (const row of eligible) { // v21.22.0: strictly 1 trade at a time per session — never open 2 trades simultaneously!
      if (openedThisDesk >= 1 || out.opened.length >= 1) break;
      if (stDay.dayCount >= effectiveMaxTradesPerDay) break;
      if (_openLinked().length >= effectiveMaxOpenPositions) break;
      const sym = normalizeLinkSymbol(row.symbol, market);
      if (!sym || openSymbols.has(sym)) { out.skipped.push(`${sym}: already open`); continue; }
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

      // ---- v21.17.0 USDT DOMAIN (crypto rows) ----
      // Board ka crypto ticket USDT me hai (Binance chain). Paper engine ka
      // execution domain bhi USDT hona chahiye — isliye crypto auto-linked
      // trades `market:'FUTURES'` (USDT-perp paper) me khulte hain, jo
      // watcher ke qualified `FUTURES|SYM` USDT quote se manage hote hain
      // (INR quote se false SL kabhi nahi).
      const isUsd = market === 'CRYPTO';
      // live fx (caller) > config; clamp safety ke liye
      const fxRate = clampN(p.fx ?? cfg.inrPerUsdt, 40, 150, 84);
      const execMarket = isUsd ? 'FUTURES' : 'INDIA';
      if (isUsd && p.usdtQuotes) {
        const q = p.usdtQuotes instanceof Map ? p.usdtQuotes.get(sym) : p.usdtQuotes[sym];
        if (!(Number(q) > 0)) { out.skipped.push(`${sym}: no live USDT perp quote (feed coverage)`); continue; }
        // Real-time Pre-Execution Anti-Reversal & Anti-Chase Guard:
        // 1) If live price has already moved >= 25% of risk distance against signal (toward SL), block entry!
        // 2) If live price has already run >= 55% of risk distance past entry (late chase after wave), block entry!
        const livePx = Number(q);
        const adverseTick = row.side === 'LONG'
          ? (livePx < entry - 0.25 * riskPerUnit)
          : (livePx > entry + 0.25 * riskPerUnit);
        if (adverseTick) {
          out.skipped.push(`${sym}: live price (${livePx}) reversing against ${row.side} entry (${entry}) — anti-reversal guard blocked entry`);
          continue;
        }
        const chasedTick = row.side === 'LONG'
          ? (livePx > entry + 0.55 * riskPerUnit)
          : (livePx < entry - 0.55 * riskPerUnit);
        if (chasedTick) {
          out.skipped.push(`${sym}: live price (${livePx}) already ran past ${row.side} entry (${entry}) — anti-late-chase guard blocked entry`);
          continue;
        }
      }

      // qty: risk-based (₹ → USDT risk for usd desks), rounded, notional-capped
      const riskBudget = isUsd ? cfg.riskPerTradeINR / fxRate : cfg.riskPerTradeINR; // USDT | INR
      const rawQty = riskBudget / riskPerUnit;
      let qty = isUsd ? Math.floor(rawQty * 10000) / 10000 : Math.floor(rawQty);
      const notionalCapINR = Math.min(cfg.maxNotionalPerTradeINR, cfg.maxPositionsINR - _openNotionalINR());
      const capQty = isUsd ? (notionalCapINR / fxRate) / entry : notionalCapINR / entry;
      if (qty > capQty) qty = isUsd ? Math.floor(capQty * 10000) / 10000 : Math.floor(capQty);
      const minQty = isUsd ? 0.0001 : 1;
      if (!(qty >= minQty)) { out.skipped.push(`${sym}: qty too small after caps (SL ${riskPerUnit.toFixed(4)})`); continue; }

      // v21.18.0 + v21.22.0 WALLET-AMOUNT LEVERAGE (< ₹10,000 → 10x, ≥ ₹10,000 → 5x)
      // + 100% COINDCX WALLET DEPLOYMENT + LIVE MODE AUTO-ORDER:
      const effectiveWalletINR = Number(p.walletEquityINR) > 0 ? Number(p.walletEquityINR) : Number(cfg.walletAmountINR) || 10000;
      const leverage = computeMtfWalletLeverage(effectiveWalletINR, cfg);
      const w95 = computeWallet95Deployment({
        walletINR: effectiveWalletINR,
        leverage,
        fxRate,
        deployPct: cfg.walletDeployPct ?? 100,
        cfg,
      });
      const feeBePrice = feeBreakevenFloor({ entry, side: row.side, market: execMarket });
      const isEliteOrStrong = row.tier === 'ELITE' || row.tier === 'STRONG' || row.tier === 'ACTION' || Number(row.superScore) >= (Number(cfg.minScore) || 75);
      const wantLiveOrder = (cfg.executionMode === 'live' || Boolean(p.siteLiveActive && cfg.autoSyncSiteLive !== false)) && isEliteOrStrong;

      // In strict live-only mode, only ELITE/STRONG rows auto-place
      if (cfg.executionMode === 'live' && !isEliteOrStrong) {
        out.skipped.push(`${sym}: live mode requires ELITE/STRONG tier (got ${row.tier} ${row.superScore})`);
        continue;
      }

      const res = paper.openPaperTrade?.({
        symbol: sym,
        direction: row.side,
        entry, qty, stopLoss: sl, target1: t1, target2: t2,
        market: execMarket,
        leverage,
        feeBreakevenPrice: feeBePrice,
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
          if (res?.trade?.id != null && typeof paper.closePaperTrade === 'function') {
            try { paper.closePaperTrade(res.trade.id, p.quotes); } catch { /* ignore */ }
          }
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
            if (res?.trade?.id != null && typeof paper.closePaperTrade === 'function') {
              try { paper.closePaperTrade(res.trade.id, p.quotes); } catch { /* ignore */ }
            }
            const errReason = liveOrderResult?.error || liveOrderResult?.reason || 'order not filled';
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
          if (res?.trade?.id != null && typeof paper.closePaperTrade === 'function') {
            try { paper.closePaperTrade(res.trade.id, p.quotes); } catch { /* ignore */ }
          }
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
        symbol: sym, market, execMarket, ccy: isUsd ? 'USDT' : 'INR', fxUsed: isUsd ? fxRate : null,
        side: row.side,
        score: row.superScore, tier: row.tier, mode: row.mode, holdMin: row.holdMin,
        entry: finalEntry, stopLoss: finalSl, initialStopLoss: finalSl, trailedStopLoss: finalSl, peakPrice: finalEntry,
        t1: finalT1, t2: finalT2, qty: finalQty,
        leverage, walletINR: Math.round(effectiveWalletINR),
        walletDeployPct: w95.walletDeployPct,
        deployedWalletINR: finalDeployedINR,
        deployedWalletUSDT: w95.deployedWalletUSDT,
        buyingPowerINR: finalBuyingPowerINR,
        buyingPowerUSDT: w95.buyingPowerUSDT,
        feeBreakevenPrice: feeBreakevenFloor({ entry: finalEntry, side: row.side, market: execMarket }),
        deepMonitorStage: 'STAGE_0_INITIAL_GUARD',
        deepMonitorLabel: 'Stage 0 · Initial SL Guard',
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
      };
      const stx = _loadState();
      stx.book.push(rec);
      stx.dayCount += 1;
      stx.perSymbolLast[sym] = now;
      _persistState();
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
export function getActiveAutoTradesDeepMonitor(liveQuotes = {}) {
  const cfg = loadMtfAutoConfig();
  const open = _openLinked().filter(b => isGenuinelyTradedEntry(b, cfg));
  let bookUpdated = false;
  const rows = open.map((b) => {
    const qRaw = liveQuotes?.[`${b.execMarket || b.market}|${b.symbol}`] ?? liveQuotes?.[b.symbol] ?? b.ltp ?? b.entry;
    const rawLtp = typeof qRaw === 'object' ? Number(qRaw?.price ?? qRaw?.ltp ?? b.entry) : Number(qRaw || b.entry);
    const entryPx = Number(b.entry) || 0;
    const ltp = (rawLtp > 0 && (!(entryPx > 0) || (rawLtp / entryPx >= 0.35 && rawLtp / entryPx <= 2.85)))
      ? rawLtp
      : (Number(b.ltp) > 0 ? Number(b.ltp) : entryPx);
    const mon = evaluateActiveTradeDeepMonitor(b, { ltp });
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
        b.lastSlTrailAt = Date.now();
        bookUpdated = true;
      }
      if (mon.tp1Hit && !b.t1Hit) {
        b.t1Hit = true;
        bookUpdated = true;
      }
      b.currentR = mon.currentR;
      b.peakR = mon.peakR;
      b.deepMonitorStage = mon.stageCode;
      b.deepMonitorLabel = mon.stageLabel;
      b.trendStatus = mon.trendStatus;
    }
    const deployPct = b.walletDeployPct || (cfg.walletDeployPct ?? 100);
    return {
      ...mon,
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
    };
  });
  if (bookUpdated) _persistState();
  return {
    activeCount: rows.length,
    trailingActiveCount: rows.filter(r => r.slTrailed || r.stageCode !== 'STAGE_0_INITIAL_GUARD').length,
    tp1LockedCount: rows.filter(r => r.tp1Hit).length,
    reversalAlertCount: rows.filter(r => r.reversalDetected).length,
    trades: rows,
    checkedAt: Date.now(),
  };
}

// ---------------- status / views ----------------
export function mtfAutoStatus(liveQuotes = {}) {
  const cfg = loadMtfAutoConfig();
  const st = _loadState();
  const open = _openLinked();
  const w95 = computeWallet95Deployment({ walletINR: cfg.walletAmountINR, deployPct: cfg.walletDeployPct ?? 100, cfg });
  const deepMonitor = getActiveAutoTradesDeepMonitor(liveQuotes);
  return {
    ok: true,
    enabled: cfg.enabled,
    mode: cfg.mode,
    holdMin: cfg.holdMin,
    minScore: cfg.minScore,
    riskPerTradeINR: cfg.riskPerTradeINR,
    maxPositionsINR: cfg.maxPositionsINR,
    maxNotionalPerTradeINR: cfg.maxNotionalPerTradeINR,
    maxTradesPerDay: cfg.maxTradesPerDay,
    maxOpenPositions: cfg.maxOpenPositions,
    cooldownMin: cfg.cooldownMin,
    desks: cfg.desks,
    timeStopEnabled: cfg.timeStopEnabled,
    inrPerUsdt: cfg.inrPerUsdt,
    executionMode: cfg.executionMode || 'paper',
    autoSyncSiteLive: cfg.autoSyncSiteLive !== false,
    walletAmountINR: cfg.walletAmountINR,
    walletDeployPct: cfg.walletDeployPct ?? 100,
    wallet95Deployment: w95,
    wallet100Deployment: w95,
    belowTenKLeverage: cfg.belowTenKLeverage,
    aboveTenKLeverage: cfg.aboveTenKLeverage,
    activeLeverage: computeMtfWalletLeverage(cfg.walletAmountINR, cfg),
    feeAwareReversalExit: cfg.feeAwareReversalExit !== false,
    deepMonitorEnabled: cfg.deepMonitorEnabled !== false,
    deepMonitor,
    ccyMode: 'crypto rows USDT (paper = FUTURES desk domain) · india rows ₹',
    day: st.day,
    dayCount: st.dayCount,
    openCount: open.length,
    openNotionalINR: Math.round(_openNotionalINR()),
    book: st.book.filter(b => b.closeReason !== 'PURGED_UNTRADED_ENTRY').slice(-30).reverse(),
    events: st.events.slice(-40).reverse(),
    lastTick: st.lastTick,
    paperOnly: cfg.executionMode !== 'live',
    note: cfg.executionMode === 'live'
      ? `LIVE AUTO MODE ACTIVE — 100% CoinDCX Wallet Deployment + ${computeMtfWalletLeverage(cfg.walletAmountINR, cfg)}x leverage (Wallet < ₹10,000 → 10x · ≥ ₹10,000 → 5x) + Full CoinDCX Active Position Control (TP1/TP2 Trailing SL + Reversal Profit Book).`
      : 'MTF AUTO-LINK PAPER mode me hai (Live Mode activate karne par ELITE/STRONG trades 100% CoinDCX Wallet + <₹10k=10x / ≥₹10k=5x leverage ke saath auto lagte hain; Full CoinDCX Active Position Control + TP1/TP2 Trailing SL + Reversal Profit Book).',
  };
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
  const existing = st.book.find(b => b.status === 'OPEN' && b.symbol === sym);
  if (existing) {
    existing.executionMode = execMode;
    existing.traded = true;
    existing.fullControl = true;
    if (isPaperExec) {
      existing.openedInLiveMode = false;
      existing.paperId = item.paperId ?? existing.paperId ?? `PAPER_${sym}_${Date.now()}`;
    } else {
      existing.openedInLiveMode = true;
    }
    if (item.orderId) existing.liveOrderId = item.orderId;
    if (item.positionId) existing.livePositionId = item.positionId;
    if (Number(item.entry) > 0) existing.entry = Number(item.entry);
    if (Number(item.qty) > 0) existing.qty = Number(item.qty);
    if (Number(item.stopLoss) > 0) {
      existing.stopLoss = Number(item.stopLoss);
      existing.initialStopLoss = Number(item.stopLoss);
      existing.trailedStopLoss = Number(item.stopLoss);
    }
    if (Number(item.t1) > 0) existing.t1 = Number(item.t1);
    if (Number(item.t2) > 0) existing.t2 = Number(item.t2);
    if (Number(item.leverage) > 0) existing.leverage = Number(item.leverage);
    if (Number(item.walletINR) > 0) existing.walletINR = Math.round(Number(item.walletINR));
    if (Number(item.deployedWalletINR) > 0) existing.deployedWalletINR = Number(item.deployedWalletINR);
    if (Number(item.buyingPowerINR) > 0) existing.buyingPowerINR = Number(item.buyingPowerINR);
    _persistState();
    return existing;
  }
  const entry = Number(item.entry) || 0;
  const sl = Number(item.stopLoss) || 0;
  const t1 = Number(item.t1) || 0;
  const t2 = Number(item.t2) || 0;
  const qty = Number(item.qty) || 1;
  const isUsd = String(item.market || 'CRYPTO').toUpperCase() !== 'INDIA';
  const fxRate = clampN(item.fx ?? cfg.inrPerUsdt, 40, 150, 102);
  const leverage = Number(item.leverage) || computeMtfWalletLeverage(item.walletINR || cfg.walletAmountINR, cfg);
  const w95 = computeWallet95Deployment({
    walletINR: item.walletINR || cfg.walletAmountINR,
    leverage,
    fxRate,
    deployPct: cfg.walletDeployPct ?? 100,
    cfg,
  });
  const execMarket = isUsd ? 'FUTURES' : 'INDIA';
  const feeBePrice = feeBreakevenFloor({ entry, side: item.side || 'LONG', market: execMarket });
  const riskPerUnit = Math.abs(entry - sl);
  const now = Date.now();
  const rec = {
    paperId: item.paperId ?? (isPaperExec ? `PAPER_${sym}_${now}` : null),
    liveOrderId: item.orderId ?? null,
    livePositionId: item.positionId ?? null,
    executionMode: execMode,
    traded: true,
    fullControl: true,
    openedInLiveMode: !isPaperExec,
    symbol: sym,
    market: isUsd ? 'CRYPTO' : 'INDIA',
    execMarket,
    ccy: isUsd ? 'USDT' : 'INR',
    fxUsed: isUsd ? fxRate : null,
    side: item.side || 'LONG',
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
    trendStatus: `📡 ${item.side === 'SHORT' ? 'BEARISH' : 'BULLISH'} LIVE WATCH (+0.00R)`,
    marginINR: +(qty * entry * (isUsd ? fxRate : 1) / leverage).toFixed(2),
    marginUsdt: isUsd ? +(qty * entry / leverage).toFixed(4) : null,
    riskINR: +(qty * riskPerUnit * (isUsd ? fxRate : 1)).toFixed(2),
    riskUsdt: isUsd ? +(qty * riskPerUnit).toFixed(4) : null,
    notional: +(qty * entry * (isUsd ? fxRate : 1)).toFixed(2),
    notionalUsdt: isUsd ? +(qty * entry).toFixed(4) : null,
    openedAt: now,
    dayKey: dayKeyFor(execMarket),
    status: 'OPEN',
    closeReason: null,
    closedAt: null,
    pnl: null,
    drivers: [isPaperExec ? 'Paper Direction Follow-Through Test + Ultra-Fast SL Trail' : 'Direct Live Order (100% Wallet + Full Position Control)'],
  };
  st.book.push(rec);
  st.dayCount += 1;
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
  __resetDirectionLocksForTests();
  try { fs.unlinkSync(CFG_FILE()); } catch { /* absent */ }
  try { fs.unlinkSync(STATE_FILE()); } catch { /* absent */ }
  if (seed?.config) { _cfg = _sanitizeCfg({ ...MTF_AUTO_DEFAULTS, ...seed.config, desks: { ...MTF_AUTO_DEFAULTS.desks, ...(seed.config.desks || {}) } }); _save(CFG_FILE(), _cfg); }
  if (seed?.state) { _state = { day: seed.state.day ?? null, dayCount: seed.state.dayCount ?? 0, perSymbolLast: seed.state.perSymbolLast || {}, book: seed.state.book || [], events: [], lastTick: null }; _save(STATE_FILE(), _state); }
}
