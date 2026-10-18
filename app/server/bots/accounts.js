// ============================================================
// server/bots/accounts.js — Jev Bot Lab v20.8.0
// ------------------------------------------------------------
// Plan §9: bot-wise VIRTUAL accounts. India bots INR me, crypto
// bots USDT me — alag equity/P&L/risk counters per bot, so one
// strategy ka drawdown doosre ka nahi hota. Persisted through
// botState (atomic) and reset-able per paper-trading session.
// ============================================================
import { loadBotState, saveBotState } from './botState.js';
import { istDate } from './core/engine.js';

export const ACCOUNT_DEFAULTS = {
  orb_in: { currency: 'INR', startingEquity: 500000 },
  lvl_in: { currency: 'INR', startingEquity: 500000 },
  orb_crypto_utc: { currency: 'USDT', startingEquity: 10000 },
  orb_crypto_london: { currency: 'USDT', startingEquity: 10000 },
  orb_crypto_ny: { currency: 'USDT', startingEquity: 10000 },
  lvl: { currency: 'USDT', startingEquity: 10000 },
  ensemble: { currency: 'USDT', startingEquity: 10000 },
};

/** Blank account for a bot id (falls back to USDT 10k). */
export function blankAccount(botId) {
  const meta = ACCOUNT_DEFAULTS[botId] || { currency: 'USDT', startingEquity: 10000 };
  return {
    bot: botId,
    currency: meta.currency,
    startingEquity: meta.startingEquity,
    equity: meta.startingEquity,
    realizedPnl: 0,
    todayPnl: { gross: 0, net: 0 },
    feesPaid: 0,
    tradesToday: 0,
    lastTradeTs: null,
    wins: 0, losses: 0,
    rSum: 0, rCount: 0,
    peakEquity: meta.startingEquity,
    maxDrawdownPct: 0,
    // v20.9.1 [H3]: today's trailing loss-streak — events-window scan
    // (400-line cap) busy din pe settle rows kho deta tha; ab account
    // me hi maintain hota hai (applyTrade), day rollover me reset.
    lossStreakToday: 0,
    day: null,
    updatedAt: null,
  };
}

/** Load-or-init + day rollover (today counters reset each IST day —
 * v20.8.1 FIX: was UTC (toISOString), which flips at 05:30 IST and
 * misassigns late-evening P&L to the wrong trading day). */
export function loadAccount(stateDir, botId, { now = new Date(), dayKey = null } = {}) {
  const st = loadBotState(stateDir, botId);
  const day = dayKey || istDate(now.getTime()) || now.toISOString().slice(0, 10);
  let acc = st?.account;
  if (!acc || acc.bot !== botId) acc = blankAccount(botId);
  if (acc.day !== day) {
    acc = { ...acc, day, todayPnl: { gross: 0, net: 0 }, tradesToday: 0, lossStreakToday: 0 };
  }
  return acc;
}

/** v20.8.1 FIX (H2): saveAccount used to write a state file containing
 * ONLY {account} — silently destroying the sibling `arm` (set via
 * /api/bots/arm) and `backtest.pWin` on every settle-save. Merge with
 * the existing state first. */
export function saveAccount(stateDir, acc) {
  const st = loadBotState(stateDir, acc.bot) || {};
  saveBotState(stateDir, acc.bot, { ...st, account: acc });
}

/** Record a settled trade on the account (gross/net split, R stats). */
export function applyTrade(acc, t, { now = new Date() } = {}) {
  const gross = Number(t.grossPnl) || 0;
  const net = Number(t.netPnl) || 0;
  const fees = Number(t.fees) || 0;
  const next = {
    ...acc,
    equity: acc.equity + net,
    realizedPnl: (acc.realizedPnl || 0) + net,
    todayPnl: {
      gross: (acc.todayPnl?.gross || 0) + gross,
      net: (acc.todayPnl?.net || 0) + net,
    },
    feesPaid: (acc.feesPaid || 0) + fees,
    tradesToday: (acc.tradesToday || 0) + 1,
    lastTradeTs: now.getTime(),
    // v20.8.1 FIX (L): breakeven trades (net === 0) are no longer
    // counted as losses — wins+losses+breakevens === trades now.
    wins: acc.wins + (net > 0 ? 1 : 0),
    losses: acc.losses + (net < 0 ? 1 : 0),
    breakevens: (acc.breakevens || 0) + (net === 0 ? 1 : 0),
    rSum: (acc.rSum || 0) + (Number(t.rNet) || 0),
    // v20.8.4 FIX (L — avgR dilution): rCount incremented even when rNet
    // was null (no-SL settle), dragging avgR toward 0. Count only real R's.
    rCount: (acc.rCount || 0) + (t.rNet != null && Number.isFinite(Number(t.rNet)) ? 1 : 0),
    // v20.9.1 [H3]: trailing loss-streak (net<0 → ++, warna reset) —
    // max_consecutive_losses gate ka reliable source (events window cap
    // se pehle ye busy din pe silently 0 ho jata tha).
    lossStreakToday: net < 0 ? (acc.lossStreakToday || 0) + 1 : 0,
  };
  // v20.8.1 FIX (M): negative-equity guard — never silently clamped
  // (honesty), but flagged so consumers can alert.
  next.belowZero = next.equity <= 0;
  next.peakEquity = Math.max(acc.peakEquity || next.equity, next.equity);
  const dd = next.peakEquity > 0 ? ((next.peakEquity - next.equity) / next.peakEquity) * 100 : 0;
  next.maxDrawdownPct = Math.max(acc.maxDrawdownPct || 0, dd);
  next.updatedAt = now.toISOString();
  return next;
}

/** Derive dashboard card stats (win rate, avg R, PF-lite). */
export function accountStats(acc) {
  const n = acc.rCount || 0;
  const avgR = n ? (acc.rSum || 0) / n : null;
  // v20.9.0 FIX (L3 — denominator mismatch): winRate = wins / rCount
  // tha — `wins` har net>0 trade ginta hai, `rCount` sirf valid-R wale.
  // No-SL settles (rNet null) wale winning trades winRate ko >100% tak
  // le ja sakte the. Honest denominator: wins + losses + breakevens
  // (applyTrade in teeno ko maintain karta hai; legacy states jahan
  // breakevens missing hai wahan rCount fallback).
  const denom = (acc.wins || 0) + (acc.losses || 0) + (acc.breakevens || 0);
  const winRate = denom > 0 ? (acc.wins || 0) / denom : (n ? (acc.wins || 0) / n : null);
  return {
    equity: acc.equity, currency: acc.currency,
    startingEquity: acc.startingEquity,
    totalReturnPct: acc.startingEquity > 0 ? ((acc.equity - acc.startingEquity) / acc.startingEquity) * 100 : null,
    todayPnl: acc.todayPnl, feesPaid: acc.feesPaid,
    winRate, avgR, trades: n,
    maxDrawdownPct: acc.maxDrawdownPct,
  };
}
