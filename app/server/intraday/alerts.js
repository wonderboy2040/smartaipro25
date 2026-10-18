// ============================================================
// intraday/alerts — Telegram alert engine (signals + OUTCOMES)
// ------------------------------------------------------------
// Layer 1 (existing): new / reversed high-confidence setups pushed
//   after every scan cycle. Per-symbol 30-min cooldown, direction
//   flip always alerts, confidence upgrade needs +2 pts, cap 20/day.
// Layer 2 (new, 2026 v3): OUTCOME alerts — SL hit / T1 hit / T2 hit /
//   breakeven-trail exit on TRACKED signals, plus paper-trade
//   closures. Dispatched by the outcome watcher in stream.js.
// ============================================================
import { istDayKey } from './time.js';

const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const ALERT_MAX_PER_DAY = 20;
const ALERT_CONF_UPGRADE = 2;

const _intradayAlerts = {
  enabled: true,
  sentBySymbol: new Map(),   // symbol → { dir, conf, ts }
  dayKey: '',                // YYYY-MM-DD (IST)
  sentToday: 0,
};

export function alertsStatus() {
  return {
    enabled: _intradayAlerts.enabled,
    cooldownMinutes: ALERT_COOLDOWN_MS / 60000,
    maxPerDay: ALERT_MAX_PER_DAY,
    sentToday: _intradayAlerts.sentToday,
    trackedSymbols: _intradayAlerts.sentBySymbol.size,
  };
}

export function setAlertsEnabled(enabled) {
  _intradayAlerts.enabled = !!enabled;
  return _intradayAlerts.enabled;
}

function _resetDailyCounter() {
  const today = istDayKey();
  if (_intradayAlerts.dayKey !== today) {
    _intradayAlerts.dayKey = today;
    _intradayAlerts.sentToday = 0;
    // v11.4 recheck: sentBySymbol persisted across days, so a symbol
    // alerted Monday never re-qualified on Tuesday (isNew false, isFlip
    // false, isUpgrade needs ≥+2 conf) — the alert engine went quieter
    // every day it stayed up. The documented semantics are a per-symbol
    // cooldown + same-day dedup; a new trading day starts fresh.
    _intradayAlerts.sentBySymbol.clear();
  }
}

// Raw Telegram send — injected so this module has no TG dependency.
function makeSender(sendTelegramRaw, _escapeHtml) {
  return async function send(html) {
    try { return await sendTelegramRaw(html); } catch { return false; }
  };
}

// ASYNC by contract: callers chain `.catch()` on the return value, so EVERY
// code path (including the early exits below) MUST resolve to a Promise.
// A plain `return;` here previously yielded `undefined`, and
// `dispatchIntradayAlerts(...).catch(...)` in routes.js threw
// `TypeError: Cannot read properties of undefined (reading 'catch')`
// SYNCHRONOUSLY — collapsing the whole /api/intraday-scanner response to
// "Scanner temporarily unavailable" on every cooldown-window re-scan.
export async function dispatchIntradayAlerts(signals, deps) {
  const { sendTelegramRaw, escapeHtml } = deps || {};
  if (!signals?.length) return;
  if (!_intradayAlerts.enabled || typeof sendTelegramRaw !== 'function') return;
  _resetDailyCounter();
  if (_intradayAlerts.sentToday >= ALERT_MAX_PER_DAY) return;

  const now = Date.now();
  const fresh = [];
  for (const s of signals) {
    const prev = _intradayAlerts.sentBySymbol.get(s.symbol);
    const isFlip = prev && prev.dir !== s.direction;
    const isNew = !prev;
    const isUpgrade = prev && prev.dir === s.direction
      && now - prev.ts >= ALERT_COOLDOWN_MS
      && s.confidence >= prev.conf + ALERT_CONF_UPGRADE;
    if (isNew || isFlip || isUpgrade) {
      fresh.push({ s, isNew, isFlip });
      if (_intradayAlerts.sentToday + fresh.length > ALERT_MAX_PER_DAY) break;
    }
  }
  if (fresh.length === 0) return;

  const esc = escapeHtml || (x => String(x));
  const fmtINR = n => `₹${(+n).toFixed(2)}`;
  const isCryptoScan = signals.some(s => String(s.market || '').toUpperCase() === 'CRYPTO');
  let msg = `<b>⚡ SUPER INTELLIGENCE ALGO ALERT</b>\n<b>${isCryptoScan ? 'CRYPTO 24/7 Deep Scan' : 'NSE + BSE Deep Scan'}</b> • MCP AI Consensus\n<code>━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  for (const { s, isFlip } of fresh) {
    const arrow = s.direction === 'LONG' ? '🟢' : '🔴';
    msg += `\n${arrow} <b>${esc(s.symbol)}</b> (${s.exchange}) — <b>${s.direction}</b>${isFlip ? ' ⚠️ REVERSAL' : ''}\n`;
    msg += `Confidence: <b>${s.confidence}%</b> | LTP ${fmtINR(s.ltp)} (${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%)\n`;
    msg += `Entry zone ${fmtINR(s.entryZoneLow ?? s.entry)}–${fmtINR(s.entryZoneHigh ?? s.entry)} (trig ${fmtINR(s.entry)}) | SL ${fmtINR(s.stopLoss)} | T1 ${fmtINR(s.target1)} | T2 ${fmtINR(s.target2)}\n`;
    const isCryptoSig = String(s.market || '').toUpperCase() === 'CRYPTO';
    msg += `RR 1:${s.rr.toFixed(2)} • Qty/₹1L ${s.qtyPerLakh ?? '—'} • ${s.trendStrength || ''} trend • VWAP ${fmtINR(s.vwap)} • RSI ${s.rsi} • Vol ${s.volumeRatio.toFixed(1)}x • Exit ${s.sqOffBy || (isCryptoSig ? '24/7' : '15:10 IST')}\n`;
    if (s.counterTrend) msg += `⚠️ Counter-regime setup (${isCryptoSig ? 'BTC' : 'NIFTY'} filter penalty applied)\n`;
    // WHY-REASONING — top 2 engine reasons so the trader knows the
    // setup ka logic, sirf levels nahi (Pro Trader Agent style).
    if (Array.isArray(s.reasons) && s.reasons.length > 0) {
      msg += `💡 Why: ${esc(s.reasons.slice(0, 2).join(' • ').slice(0, 90))}\n`;
    }
    if (s.aiModel) msg += `🤖 AI: ${esc(String(s.aiModel).slice(0, 40))}${s.aiNote ? ` — ${esc(String(s.aiNote).slice(0, 60))}` : ''}\n`;
  }
  msg += `\n<code>━━━━━━━━━━━━━━━━━━━━━</code>\n⏰ ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST • Auto-generated — not investment advice.`;

  const send = makeSender(sendTelegramRaw, esc);
  return send(msg).then(ok => {
    if (ok) {
      for (const { s } of fresh) {
        _intradayAlerts.sentBySymbol.set(s.symbol, { dir: s.direction, conf: s.confidence, ts: now });
      }
      _intradayAlerts.sentToday += fresh.length;
      console.log(`⚡ Intraday alerts: pushed ${fresh.length} setup(s) to Telegram (${_intradayAlerts.sentToday}/${ALERT_MAX_PER_DAY} today)`);
    }
    return ok;
  });
}

// ------------------------------------------------------------
// OUTCOME alerts — SL/T1/T2/trail/EOD events on tracked signals
// and paper-trade closures. Separate daily budget (12/day) so
// outcome pushes never starve new-signal pushes.
// ------------------------------------------------------------
const OUTCOME_MAX_PER_DAY = 12;
const _outcomeAlerts = { dayKey: '', sentToday: 0 };

export async function dispatchOutcomeAlert(event, deps) {
  const { sendTelegramRaw, escapeHtml } = deps || {};
  if (typeof sendTelegramRaw !== 'function') return false;
  const today = istDayKey();
  if (_outcomeAlerts.dayKey !== today) { _outcomeAlerts.dayKey = today; _outcomeAlerts.sentToday = 0; }
  if (_outcomeAlerts.sentToday >= OUTCOME_MAX_PER_DAY) return false;

  const esc = escapeHtml || (x => String(x));
  const fmtINR = n => `₹${(+n).toFixed(2)}`;
  const icon = { T1_HIT: '🎯', T2_HIT: '🏆', SL_HIT: '🛑', BE_TRAIL_EXIT: '🔒', EOD_EXIT: '🌙', PAPER_CLOSE: '📝', FLIP: '🔄', CIRCUIT_RISK: '🚨' }[event.type] || 'ℹ️';
  const label = {
    T1_HIT: 'TARGET 1 HIT — book 50%, trail SL to entry',
    T2_HIT: 'TARGET 2 HIT — full target achieved',
    SL_HIT: 'STOP LOSS HIT — exit taken',
    BE_TRAIL_EXIT: 'BREAKEVEN TRAIL EXIT — remaining qty out at entry',
    EOD_EXIT: 'EOD SQUARE-OFF — position closed at market',
    PAPER_CLOSE: 'PAPER TRADE CLOSED',
    FLIP: 'SIGNAL REVERSED — direction flipped',
    CIRCUIT_RISK: 'CIRCUIT-LIMIT RISK — adverse price band approaching',
  }[event.type] || event.type;

  // event.pnl is the SIGNED P&L per ₹1L capital (watcher computes it).
  // v11.1 GAP 3: pnlNet (post-cost) takes the headline when present;
  // gross stays visible as the secondary figure.
  const pnl = event.pnl != null ? +event.pnl : null;
  const pnlNet = event.pnlNet != null ? +event.pnlNet : null;
  let msg = `${icon} <b>OUTCOME — ${esc(event.symbol)}</b>\n${label}\n`;
  if (event.type === 'CIRCUIT_RISK') {
    // v11.1 GAP 2: the URGENT distinct alert — a position nearing an
    // adverse circuit is NOT an SL-approach warning: if the stock
    // freezes at the band, the EXIT itself stops filling.
    if (event.price != null) msg += `Price: <b>${fmtINR(event.price)}</b>${event.frozen ? ' — <b>FROZEN AT CIRCUIT</b>' : ` · ${event.band} circuit ${event.distPct != null ? event.distPct.toFixed(1) + '%' : ''} door`}\n`;
    if (event.note) msg += `${esc(event.note)}\n`;
  } else {
    if (event.price != null) msg += `Price: <b>${fmtINR(event.price)}</b>\n`;
    if (pnlNet != null) {
      msg += `P&L (net of costs): <b>${pnlNet >= 0 ? '+' : '−'}₹${Math.abs(pnlNet).toFixed(2)}</b> (gross ${pnl != null ? `${pnl >= 0 ? '+' : '−'}₹${Math.abs(pnl).toFixed(2)}` : '—'})\n`;
    } else if (pnl != null) {
      msg += `P&L (per ₹1L capital): <b>${pnl >= 0 ? '+' : '−'}₹${Math.abs(pnl).toFixed(2)}</b>\n`;
    }
    if (event.note) msg += `${esc(event.note)}\n`;
  }
  msg += `\n⏰ ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST • Auto-tracked — not investment advice.`;

  try {
    const ok = await sendTelegramRaw(msg);
    if (ok) _outcomeAlerts.sentToday++;
    return ok;
  } catch { return false; }
}
