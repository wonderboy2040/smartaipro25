// ============================================================
// server/ai/reversalEngine.js — v12.8 SUPERINTELLIGENCE
// REVERSAL RECOVERY ENGINE ("Reversal AI")
// ------------------------------------------------------------
// USER SPEC (2026-09-23, XRP-USDT story): "long trade liya, thoda
// up hua, phir reversal down — balance negative ja raha tha. Aisa
// condition me opposite SHORT laga ke profit book kar sakte hai?
// Long me minimal loss accept (₹100-150) karke close, phir SHORT
// me ₹500+ profit book, phir reversal LONG pe wapas long laga ke
// profit book."
//
// The engine turns a FAILED signal into a NET-POSITIVE CYCLE:
//
//   LEG-1  LONG  @entry → P&L ≤ −₹150 (loss cap)  → CUT (minimal
//          loss accepted — capital protection is unconditional)
//          ↓ ensemble confirms the reversal (or is silent)
//   LEG-2  SHORT @current → P&L ≥ +₹500 (target)  → BOOKED
//          ↓ WAITING window (45m) — ensemble flips LONG again
//   LEG-3  LONG  @reversal → P&L ≥ +₹500          → BOOKED
//          ↓ maxLegs reached → CYCLE END, net +₹850
//
// DISCIPLINE (the v12.7 lesson — blind flips whipsaw):
//   • OPT-IN: default OFF. When ON it manages OPEN FUTURES-desk
//     positions (agent + manual + signal sources) — the user's
//     visible ₹ thresholds, their explicit switch.
//   • Guards: maxLegs per cycle, cooldown between legs, hard
//     cycle-stop (net −₹cycleStop ends the cycle, no more legs),
//     one-per-pair, daily trade/loss caps, max-open, kill-switch
//     (blocks NEW legs; closing still allowed — it REDUCES risk).
//   • Ensemble gate: a loss-cap CUT always fires (it is a stop),
//     but the FLIP is skipped when the live ensemble still
//     STRONGLY backs the original side (pullback ≠ reversal).
//     Missing ensemble data never blocks capital protection.
//   • LIVE honesty (v7.0.2 rule): a LIVE leg closes only through
//     the exchange (exitFuturesPosition); no id/creds → journal
//     WATCH_ERROR + retry next pass — never a fake paper close.
//   • ₹ thresholds are stamped as PRICE levels (sl/tp) on every
//     reversal leg, and armed NATIVELY on the exchange
//     (createFuturesTpsl) — the ₹ discipline survives a dead
//     server (Render free tier sleeps between ticks).
//
// Where it runs: futures.js watchFuturesPositions calls
// evaluateReversalForPosition() per open position + 
// processReversalWaiting() per pass (both INSIDE the journal
// lock — the engine mutates the SAME fresh journal the watcher
// saves). All futures-desk functions are INJECTED (deps) so this
// module has zero import cycles and is pure-testable.
// ============================================================
import crypto from 'node:crypto';
import { loadJSON } from '../lib/store.js';
import { pushEntry, todayIST, dailyStats, loadConfig } from './coindcxOrders.js';
import { settlePositionOutcome } from './ledger.js';
import { pRound } from './lib/priceRound.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const _num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };
const inrOfUsdt = (usdt, usdInr) => r2((Number(usdt) || 0) * (Number(usdInr) > 0 ? Number(usdInr) : 84));

const AGENT_CONFIG_FILE = 'ai-agent-config.json'; // owned by agent.js — mirrored read (loadProTraderConfig pattern)
const CFG_TTL_MS = 60_000; // PUT → engine sees it within 60s (force-bypassed on the config route)
let _cfgCache = { at: 0, cfg: null };

// ---------------- config ----------------
// v12.9 USER SPEC: "koi threshold tweak cap nahi — editable manually
// hamare hisaab se" — the clamp table is GONE. The engine now respects
// the user's numbers VERBATIM; the only validation left is sanity
// (finite + positive; maxLegs an integer ≥1). Defaults stay ₹150/₹500/3
// legs when nothing is saved.

/** Clamped reversal config off the shared agent config file (PURE —
 *  `saved` injectable for tests). Mirrors agent.js AGENT_DEFAULTS —
 *  change both together (the loadProTraderConfig convention). */
export function loadReversalConfig(saved, { force = false } = {}) {
  if (!force && _cfgCache.cfg && Date.now() - _cfgCache.at < CFG_TTL_MS) return _cfgCache.cfg;
  const src = saved != null ? saved : (loadJSON(AGENT_CONFIG_FILE, {}) || {});
  const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const cfg = {
    enabled: src.reversalEnabled === true,
    // v13.1 OPT-IN auto-cut: loss-cap crossing pe the sweep CLOSES the
    // manual leg itself (default OFF — v12.7's "never auto-close a
    // manual trade" stays the shipped behavior until the user turns
    // this on from the Reversal panel).
    autoCut: src.reversalAutoCut === true,
    lossCapINR: Math.round(pos(src.reversalLossCapINR, 150) * 100) / 100,
    profitTargetINR: Math.round(pos(src.reversalProfitTargetINR, 500) * 100) / 100,
    maxLegs: Math.max(1, Math.round(pos(src.reversalMaxLegs, 3))),
    cooldownMs: Math.round(pos(src.reversalCooldownMin, 3) * 60_000),
    cooldownMin: Math.round(pos(src.reversalCooldownMin, 3) * 100) / 100,
    cycleStopINR: Math.round(pos(src.reversalCycleStopINR, 2 * pos(src.reversalLossCapINR, 150)) * 100) / 100,
    reentryWindowMs: Math.round(pos(src.reversalReentryWindowMin, 45) * 60_000),
    reentryWindowMin: Math.round(pos(src.reversalReentryWindowMin, 45) * 100) / 100,
    minReentryConf: Math.round(pos(src.reversalMinReentryConf, 60) * 100) / 100,
    requireEnsembleConfirm: src.reversalRequireEnsembleConfirm !== false,
  };
  if (saved == null) _cfgCache = { at: Date.now(), cfg };
  return cfg;
}

// ---------------- pure leg math ----------------

/** Live ₹ P&L of one open leg — unrealized + already-booked partial
 *  legs (bookedPnlUSDT carries the partial-TP twins). PURE. */
export function reversalLegPnlINR({ p, price, usdInr }) {
  if (!p || !(Number(price) > 0) || !(Number(p.entryPrice) > 0)) return null;
  const long = p.side === 'LONG';
  const qty = Number(p.qty) || 0;
  if (!(qty > 0)) return null;
  const pnlUSDT = (long ? price - p.entryPrice : p.entryPrice - price) * qty;
  return inrOfUsdt(pnlUSDT + (Number(p.bookedPnlUSDT) || 0), usdInr);
}

/** ₹-threshold trigger for a leg's live P&L. PURE. */
export function reversalTriggerOf({ pnlINR, cfg }) {
  if (pnlINR == null || !cfg) return null;
  if (pnlINR <= -Math.abs(cfg.lossCapINR)) return 'LOSS_CAP';
  if (pnlINR >= Math.abs(cfg.profitTargetINR)) return 'PROFIT_TARGET';
  return null;
}

/** ₹ thresholds → PRICE levels for a new leg (also armed natively on
 *  the exchange — the discipline survives a sleeping server). PURE. */
export function priceLevelsForLeg({ side, entry, qty, lossCapINR, profitTargetINR, usdInr }) {
  const q = Number(qty), e = Number(entry);
  if (!(q > 0) || !(e > 0)) return { sl: null, tp: null };
  const fx = Number(usdInr) > 0 ? Number(usdInr) : 84;
  const lossDist = Math.abs(lossCapINR) / fx / q;
  const gainDist = Math.abs(profitTargetINR) / fx / q;
  const long = String(side).toUpperCase() !== 'SHORT';
  return {
    sl: pRound(long ? e - lossDist : e + lossDist),
    tp: pRound(long ? e + gainDist : e - gainDist),
  };
}

// ---------------- pure cycle math ----------------

/** All legs of a cycle off the journal (root + reversal legs, openedAt
 *  order). PURE. */
export function cycleLegsOf(j, cycleId) {
  return (j?.positions || [])
    .filter(p => p?.reversal?.cycleId === cycleId)
    .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
}

/** Cycle summary: legs, net ₹, open leg, state. PURE. */
export function cycleSummary(j, cycleId) {
  const legs = cycleLegsOf(j, cycleId);
  if (legs.length === 0) return null;
  const closed = legs.filter(l => l.status === 'CLOSED');
  const open = legs.find(l => l.status === 'OPEN' || l.status === 'UNKNOWN') || null;
  const netINR = r2(closed.reduce((s, l) => s + (Number(l.pnlINR) || 0), 0));
  const lastLeg = legs[legs.length - 1];
  const ended = legs.some(l => l.reversal?.cycleEnd);
  const lastClosedAt = closed.length > 0 ? Math.max(...closed.map(l => l.closedAt || 0)) : null;
  return {
    cycleId, pair: lastLeg.pair || lastLeg.symbol, mode: lastLeg.mode || 'paper',
    legs: legs.map(l => ({
      leg: l.reversal?.leg ?? null, side: l.side, qty: l.qty, entryPrice: l.entryPrice,
      status: l.status, closePrice: l.closePrice ?? null, pnlINR: l.status === 'CLOSED' ? (l.pnlINR ?? null) : null,
      closeReason: l.closeReason ?? null, openedAt: l.openedAt, closedAt: l.closedAt ?? null,
      exchangePositionId: l.exchangePositionId ?? null,
    })),
    legCount: legs.length, openLeg: open ? { leg: open.reversal?.leg ?? null, side: open.side, qty: open.qty, entryPrice: open.entryPrice } : null,
    netINR, state: ended ? 'ENDED' : open ? 'ACTIVE' : 'WAITING',
    cycleEnd: legs.map(l => l.reversal?.cycleEnd).find(Boolean) || null,
    lastClosedAt, rootId: legs[0].reversal?.rootId ?? legs[0].id,
  };
}

// ---------------- the decision brain (PURE) ----------------

/**
 * The per-leg decision. Guards are evaluated so that a CUT is
 * unconditional (capital protection) but a FLIP can be vetoed.
 * @returns {{action:'HOLD'|'CLOSE_LOSS_CAP'|'CLOSE_TARGET', flipSide:'LONG'|'SHORT'|null, blocked:string|null, pnlINR:number|null, reasons:string[]}}
 */
export function reversalDecision({ p, price, usdInr, cfg, cycle, now = Date.now(), ensemble }) {
  const reasons = [];
  const pnlINR = reversalLegPnlINR({ p, price, usdInr });
  const trig = reversalTriggerOf({ pnlINR, cfg });
  if (!trig) return { action: 'HOLD', flipSide: null, blocked: null, pnlINR, reasons };
  const _legNo = p.reversal?.leg ?? 1;
  const opposite = p.side === 'LONG' ? 'SHORT' : 'LONG';

  if (trig === 'PROFIT_TARGET') {
    reasons.push(`+₹${r2(pnlINR)} ≥ target ₹${cfg.profitTargetINR} — BOOK karo`);
    reasons.push('re-entry (koi bhi side) WAITING window me ensemble confirmation ke baad hi — profit ke baad kabhi instant flip nahi');
    return { action: 'CLOSE_TARGET', flipSide: null, blocked: null, pnlINR, reasons };
  }

  // ---- LOSS CAP: the cut always happens; the flip is guarded ----
  reasons.push(`−₹${r2(Math.abs(pnlINR))} ≥ loss cap ₹${cfg.lossCapINR} — LEG CUT (minimal loss accept)`);
  let blocked = null;
  if (cycle && cycle.legCount >= cfg.maxLegs) {
    blocked = 'maxLegs';
    reasons.push(`flip NAHI — cycle ${cfg.maxLegs}-leg budget khatam (maxLegs guard)`);
  } else if (cycle && cycle.lastLegOpenedAt && now - cycle.lastLegOpenedAt < cfg.cooldownMs) {
    blocked = 'cooldown';
    reasons.push(`flip NAHI abhi — leg cooldown ${Math.ceil((cfg.cooldownMs - (now - cycle.lastLegOpenedAt)) / 60000)}m bacha hai (whipsaw guard)`);
  } else if (cycle) {
    const netAfter = r2((Number(cycle.netINR) || 0) + (Number(pnlINR) || 0));
    if (netAfter <= -Math.abs(cfg.cycleStopINR)) {
      blocked = 'cycle-stop';
      reasons.push(`flip NAHI — cycle net −₹${r2(Math.abs(netAfter))} ≤ cycle-stop ₹${cfg.cycleStopINR} (cycle band — aage naya signal naya cycle)`);
    }
  }
  if (!blocked && cfg.requireEnsembleConfirm && ensemble && ensemble.side === p.side && (Number(ensemble.confidence) || 0) >= 65) {
    blocked = 'ensemble-still-original';
    reasons.push(`flip NAHI — ensemble abhi bhi ${ensemble.side} side par strong hai (${ensemble.confidence}% conf) — pullback ho sakta hai, reversal nahi. Cut hoga, ulta entry WAITING window me milegi.`);
  }
  // missing/FLAT ensemble never blocks the flip — loss-cap discipline
  // is price-based; a dead feed must not disable capital recovery.
  return { action: 'CLOSE_LOSS_CAP', flipSide: blocked ? null : opposite, blocked, pnlINR, reasons };
}

/**
 * Post-close WAITING-window decision — re-entry only on a CONFIRMED
 * reversal (ensemble flipped opposite to the just-closed leg, conf
 * bar met, cooldown served, legs remaining, window alive). PURE.
 * @returns {{action:'ENTER'|'WAIT'|'END', side?:string, reason:string}}
 */
export function reentryDecision({ waiting, cycle, cfg, now = Date.now(), ensemble }) {
  if (!waiting) return { action: 'WAIT', reason: 'no window' };
  if (now > waiting.until) return { action: 'END', reason: `re-entry window (${cfg.reentryWindowMin}m) expire — cycle profit ke saath band` };
  const legCount = cycle?.legCount ?? waiting.legCount;
  if (legCount >= cfg.maxLegs) return { action: 'END', reason: `maxLegs (${cfg.maxLegs}) reached — cycle band` };
  if (waiting.lastCloseAt && now - waiting.lastCloseAt < cfg.cooldownMs) {
    return { action: 'WAIT', reason: `leg cooldown ${Math.ceil((cfg.cooldownMs - (now - waiting.lastCloseAt)) / 60000)}m` };
  }
  // v20.9.0 FIX (L4/eslint no-constant-binary-expression — REAL BUG):
  // `Number(x) ?? y` kabhi y use NAHI karta — Number(undefined) = NaN
  // hota hai, null nahi. Matlab cycle.netINR missing hone par cycle-stop
  // check (NaN <= -x = false) KABHI fire nahi hota tha. Honest nullish
  // chain ab finite-check ke saath.
  const _numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const cycleNet = _numOrNull(cycle?.netINR) ?? _numOrNull(waiting.netINR) ?? 0;
  if (cycleNet <= -Math.abs(cfg.cycleStopINR)) {
    return { action: 'END', reason: `cycle-stop (−₹${Math.abs(cycleNet)}) — cycle band` };
  }
  const side = ensemble?.side;
  if (!ensemble || (side !== 'LONG' && side !== 'SHORT')) return { action: 'WAIT', reason: `ensemble FLAT/gayab — confirm ka intezaar (${Math.ceil((waiting.until - now) / 60000)}m window bacha)` };
  if (side === waiting.closedSide) return { action: 'WAIT', reason: `ensemble abhi ${side} (closed leg ki taraf) — reversal confirm NAHI, profit already booked` };
  const conf = Number(ensemble.confidence) || 0;
  if (conf < cfg.minReentryConf) return { action: 'WAIT', reason: `ensemble ${side} par ${conf}% < bar ${cfg.minReentryConf}% — strong confirm ka intezaar` };
  return { action: 'ENTER', side, reason: `REVERSAL CONFIRMED — ensemble ${side} ${conf}% (closed ${waiting.closedSide} ke ulta)` };
}

// ---------------- waiting windows (in-memory, journal self-heal) ----------------
// pair → { cycleId, pair, closedSide, lastCloseAt, until, legCount, netINR, qty, leverage, mode, rootId }
const _waiting = new Map();

/** Rebuild waiting windows off the journal (boot + every pass —
 *  restart-safe: a deploy mid-window does not orphan the cycle). */
export function reviveWaitingFromJournal(j, cfg, now = Date.now()) {
  let revived = 0;
  const seen = new Set();
  for (const p of (j?.positions || [])) {
    const rv = p?.reversal;
    if (!rv?.cycleId) continue;
    if (p.status === 'OPEN' || p.status === 'UNKNOWN') { seen.add(rv.cycleId); continue; }
    if (rv.cycleEnd) { seen.add(rv.cycleId); continue; }
    const c = cycleSummary(j, rv.cycleId);
    if (!c || c.openLeg || c.legCount >= cfg.maxLegs) { seen.add(rv.cycleId); continue; }
    if (!c.lastClosedAt || now - c.lastClosedAt > cfg.reentryWindowMs) { seen.add(rv.cycleId); continue; }
    if (c.netINR <= -Math.abs(cfg.cycleStopINR)) { seen.add(rv.cycleId); continue; }
    const lastLeg = cycleLegsOf(j, rv.cycleId).filter(l => l.status === 'CLOSED').pop();
    if (!lastLeg) continue;
    const key = p.pair;
    const w = {
      cycleId: rv.cycleId, pair: p.pair, closedSide: lastLeg.side,
      lastCloseAt: c.lastClosedAt, until: c.lastClosedAt + cfg.reentryWindowMs,
      legCount: c.legCount, netINR: c.netINR, qty: lastLeg.qty, leverage: lastLeg.leverage || 1,
      mode: lastLeg.mode || 'paper', rootId: c.rootId,
    };
    const cur = _waiting.get(key);
    if (!cur || cur.cycleId !== w.cycleId) { _waiting.set(key, w); revived++; }
    seen.add(rv.cycleId);
  }
  // drop windows whose cycle ended / opened a leg / vanished
  for (const [key, w] of [..._waiting]) if (!seen.has(w.cycleId)) _waiting.delete(key);
  return revived;
}

/** The LIVE waiting map (tests read AND stage windows through it — a
 *  copy would silently swallow every staged mutation). */
export function __waitingStateForTests() { return _waiting; }
export function __resetReversalForTests() { _waiting.clear(); _cfgCache = { at: 0, cfg: null }; }

// ---------------- leg actions (journal-mutating, deps injected) ----------------

/** Close one leg at `price`. LIVE → exchange exit only (v7.0.2
 *  honesty); PAPER → simulated. Returns {ok, pnlINR} or {ok:false,
 *  error} (watcher retries next pass). */
async function closeLeg(j, p, price, { reason, exitFuturesPosition, coindcxConnected }) {
  if (p.mode === 'live') {
    if (!p.exchangePositionId || !coindcxConnected()) {
      pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `REVERSAL close BLOCKED (no exchange position id / CoinDCX disconnected) — retry next pass: ${reason}` });
      return { ok: false, error: 'live close blocked (no id/creds)' };
    }
    try {
      const xr = await exitFuturesPosition(p.exchangePositionId);
      // v20.9.1 [H1]: wrapped rejection resolve hota hai throw nahi —
      // verdict check ke bina fake CLOSE + fabricated PnL cycle me ghusti.
      if (!xr?.ok) throw new Error(xr?.error || 'wrapped rejection (200 body me error)');
    }
    catch (e) {
      pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'FUTURES', reason: `REVERSAL exit failed: ${String(e?.message || e).slice(0, 160)}` });
      return { ok: false, error: String(e?.message || e).slice(0, 140) };
    }
  }
  const long = p.side === 'LONG';
  const pnlUSDT = (long ? price - p.entryPrice : p.entryPrice - price) * p.qty;
  const usdInr = await _fx();
  p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = price;
  p.pnlUSDT = r2(pnlUSDT + (Number(p.bookedPnlUSDT) || 0));
  p.pnlINR = inrOfUsdt(p.pnlUSDT, usdInr);
  p.closeReason = reason;
  try { settlePositionOutcome(p, reason); } catch { /* best-effort */ }
  pushEntry(j, {
    kind: 'CLOSE', day: todayIST(), pair: p.pair, market: 'FUTURES', mode: p.mode, source: p.source,
    qty: p.qty, entryPrice: p.entryPrice, closePrice: price, pnlUSDT: p.pnlUSDT, pnlINR: p.pnlINR,
    reason, reversal: { cycleId: p.reversal?.cycleId, leg: p.reversal?.leg },
  });
  return { ok: true, pnlINR: p.pnlINR, pnlUSDT: p.pnlUSDT };
}

let _fxFn = null; // usdInr resolver injected per pass (falls back to 84)
async function _fx() { try { return _fxFn ? await _fxFn() : 84; } catch { return 84; } }

/** Open the next cycle leg (flip or confirmed re-entry). Sizing =
 *  the just-closed leg's qty/leverage (notional roughly constant);
 *  ₹ thresholds stamped as sl/tp + armed natively when LIVE. */
async function openReversalLeg(j, { pair, side, qty, leverage, price, cycleId, leg, mode, rootId, parentPositionId, cfg, deps }) {
  const { createFuturesOrder, createFuturesTpsl, roundFuturesQty, coindcxConnected, listFuturesPositions } = deps;
  const q = roundFuturesQty(pair, Number(qty));
  if (!(q > 0)) return { ok: false, error: 'qty instrument-precision pe 0 round ho gaya — flip skip' };
  const cfgO = loadConfig();
  const stats = dailyStats(j);
  if (stats.tradesCount >= (cfgO.dailyMaxTrades || 5)) return { ok: false, error: `daily trade cap (${cfgO.dailyMaxTrades}) — cycle roka` };
  if (stats.realizedPnlINR <= -(cfgO.dailyMaxLossINR || 2000)) return { ok: false, error: `daily loss cap (₹${cfgO.dailyMaxLossINR}) — cycle roka` };
  if (j.positions.some(p => p.pair === pair && (p.status === 'OPEN' || p.status === 'UNKNOWN'))) {
    return { ok: false, error: `${pair} pe already open position (one-per-pair)` };
  }
  const openCount = j.positions.filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length;
  if (openCount >= (cfgO.maxOpenPositions || 5)) return { ok: false, error: `max open positions (${cfgO.maxOpenPositions})` };

  const usdInr = await _fx();
  const { sl, tp } = priceLevelsForLeg({ side, entry: price, qty: q, lossCapINR: cfg.lossCapINR, profitTargetINR: cfg.profitTargetINR, usdInr });
  const notionalUSDT = r2(q * price);

  let exchangePositionId = null;
  let liveNote = null;
  if (mode === 'live' && coindcxConnected()) {
    try {
      const r = await createFuturesOrder({ pair, side, qty: q, leverage: Math.max(1, Math.floor(Number(leverage) || 1)) });
      // v20.9.1 [H2]: wrapped rejection ({orderId:null, error}) pehle
      // phantom OPEN leg book karta tha — closeLeg baad me us fake leg ka
      // PnL daily-cap/cycle-stop math me daal deta tha.
      if (!r?.orderId || r?.error) {
        pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair, market: 'FUTURES', reason: `REVERSAL leg OPEN rejected by exchange: ${String(r?.error || 'no order id in 200 body').slice(0, 160)}` });
        return { ok: false, error: `exchange rejected leg: ${String(r?.error || 'no order id').slice(0, 140)}` };
      }
      // v20.9.4 FIX (H1 — LIVE reversal legs un-closable/unprotected):
      // pehle ORDER id ko hi exchangePositionId bana dete the — jabki
      // exitFuturesPosition/createFuturesTpsl dono POSITION id (row.id
      // from listFuturesPositions) maangte hain. Result: (1) native ₹-SL/TP
      // galat id pe arm hota (silent fail — {ok:false} throw nahi karta),
      // (2) closeLeg/watcher exits galat id pe /positions/exit maarte →
      // 200-wrapped rejection → verdict-check fake-close nahi karta (sahi
      // hai) par har watcher pass pe RETRY — LIVE leveraged leg ka KOI
      // working stop nahi. Watcher ka adopt-pass bhi fix nahi karta (field
      // non-null hai). Ab executeFuturesSignal jaisa hi poll: REAL position
      // row (pair + activePos!==0) se row.id resolve karo; na mile to
      // null chhodo taaki watcher ka adopt-late pass id de sake.
      const orderId = String(r.orderId);
      liveNote = `LIVE fill (order ${orderId})`;
      try {
        let resolvedPosId = null;
        for (let i = 0; i < 3 && !resolvedPosId; i++) {
          if (i > 0) await new Promise((res) => { const t = setTimeout(res, 1200); t.unref?.(); });
          const positions = typeof listFuturesPositions === 'function' ? await listFuturesPositions().catch(() => []) : [];
          const row = (positions || []).find((x) => String(x.pair || '').toUpperCase() === String(pair).toUpperCase() && Number(x.activePos) !== 0);
          if (row?.id) resolvedPosId = String(row.id);
        }
        if (resolvedPosId) {
          exchangePositionId = resolvedPosId;
          liveNote = `LIVE fill (position ${resolvedPosId} · order ${orderId})`;
        } else {
          // unresolved → exchangePositionId null hi rehne do (watcher
          // adopt-late pass id dega — exit paths tab arm hongi)
          liveNote = `LIVE fill (order ${orderId} · position id pending — watcher adopt karega)`;
        }
      } catch { /* resolve best-effort — null → watcher adopts */ }
    } catch (e) {
      pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair, market: 'FUTURES', reason: `REVERSAL leg OPEN failed: ${String(e?.message || e).slice(0, 160)}` });
      return { ok: false, error: `exchange open failed: ${String(e?.message || e).slice(0, 140)}` };
    }
  }

  const position = {
    id: crypto.randomUUID(), pair, symbol: baseOfPair(pair), market: 'FUTURES', side, mode, source: 'reversal',
    qty: q, entryPrice: price, notionalUSDT, notionalINR: inrOfUsdt(notionalUSDT, usdInr),
    marginUSDT: r2(notionalUSDT / Math.max(1, Math.floor(Number(leverage) || 1))),
    leverage: Math.max(1, Math.floor(Number(leverage) || 1)),
    sl, tp, tp2: null,
    initialRisk: sl != null ? pRound(Math.abs(price - sl)) : null,
    peakPrice: pRound(price),
    signal: { grade: 'REVERSAL', confidence: null, agreement: null, summary: `Reversal Recovery leg-${leg} — cycle ${cycleId}` },
    openedAt: Date.now(), status: 'OPEN',
    reversal: { cycleId, leg, rootId, engine: 'v12.8', ...(parentPositionId ? { parentPositionId } : {}) },
    ...(exchangePositionId ? { exchangePositionId } : {}),
  };
  j.positions.push(position);
  pushEntry(j, {
    kind: 'ORDER', day: todayIST(), status: 'FILLED', pair, market: 'FUTURES', mode, source: 'reversal',
    qty: q, price: pRound(price), notionalUSDT, leverage: position.leverage,
    signal: { grade: 'REVERSAL', conf: null },
    reason: `REVERSAL leg-${leg} ${side} — cycle ${cycleId} (₹ loss-cap ${cfg.lossCapINR} · ₹ target ${cfg.profitTargetINR} levels pe stamp)${liveNote ? ` · ${liveNote}` : ''}`,
    reversal: { cycleId, leg },
  });
  // native ₹-levels on the exchange — discipline survives server death
  // v20.9.4 FIX (H1 follow-up): pehle sirf THROWS catch hote the —
  // createFuturesTpsl ka {ok:false, error} return SILENTLY drop hota tha
  // (native SL kabhi arm nahi hua par journal me kuch nahi likha). Ab
  // verdict check + WATCH_ERROR entry — user/exchange dono ko pata chale.
  if (mode === 'live' && exchangePositionId && coindcxConnected() && sl != null) {
    try {
      const tpslR = await createFuturesTpsl({ positionId: exchangePositionId, stopLoss: sl, takeProfit: tp });
      if (tpslR && tpslR.ok === false) {
        pushEntry(j, {
          kind: 'WATCH_ERROR', day: todayIST(), pair, market: 'FUTURES',
          reason: `REVERSAL leg native TP/SL arm FAIL (position ${exchangePositionId}): ${String(tpslR.error || 'unknown').slice(0, 140)} — watcher ₹-checks guard rahenge, exchange-side SL manually verify karo`,
        });
      }
    } catch (e) {
      pushEntry(j, {
        kind: 'WATCH_ERROR', day: todayIST(), pair, market: 'FUTURES',
        reason: `REVERSAL leg native TP/SL arm THREW (position ${exchangePositionId}): ${String(e?.message || e).slice(0, 140)} — watcher ₹-checks guard rahenge`,
      });
    }
  }
  return { ok: true, position };
}

const baseOfPair = (pair) => String(pair || '').replace(/^B-/, '').replace(/_USDT$/, '').toUpperCase();

/** Stamp cycle END on the last closed leg (journal-persisted so the
 *  view + revival logic agree after restarts). */
function stampCycleEnd(j, cycleId, { reason, netINR }) {
  const legs = cycleLegsOf(j, cycleId).filter(l => l.status === 'CLOSED');
  const last = legs[legs.length - 1];
  if (!last || last.reversal?.cycleEnd) return;
  last.reversal.cycleEnd = { at: Date.now(), reason, netINR: r2(netINR) };
  pushEntry(j, {
    kind: 'REVERSAL', day: todayIST(), pair: last.pair, market: 'FUTURES', mode: last.mode, source: 'reversal',
    reason: `CYCLE END ${cycleId} — net ₹${r2(netINR)} · ${reason}`,
    pnlINR: r2(netINR), reversal: { cycleId },
  });
}

// ---------------- the watcher hooks ----------------

const MANAGED_SOURCES = new Set(['agent', 'manual', 'signal', 'reversal', 'order-console', undefined, '']);

function _ensembleOf(deep) {
  if (!deep?.ok || !deep?.signal) return null;
  const s = deep.signal;
  const side = String(s.side || '').toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') return { side: 'FLAT', confidence: Number(s.confidence) || 0 };
  return { side, confidence: Number(s.confidence) || 0 };
}

/**
 * ONE open FUTURES position's reversal evaluation. Called from
 * watchFuturesPositions inside the journal lock. Returns
 * { dirty, closed?, opened?, telegram? } — the watcher saves the
 * journal + relays the telegram (engine copy is self-contained).
 */
export async function evaluateReversalForPosition(j, p, price, ctx = {}) {
  const { cfg, usdInr, getDeepSignal, deps, sendTelegram } = ctx;
  if (!cfg?.enabled) return { dirty: false };
  if (!MANAGED_SOURCES.has(String(p.source || ''))) return { dirty: false };
  if (p.status !== 'OPEN' && p.status !== 'UNKNOWN') return { dirty: false };
  let dirty = false;

  // attach a cycle to any managed position that lacks one (leg 1)
  if (!p.reversal?.cycleId) {
    p.reversal = { cycleId: `rv-${p.pair}-${String(p.id).slice(0, 8)}`, leg: 1, rootId: p.id, engine: 'v12.8' };
    dirty = true;
  }
  _fxFn = () => Promise.resolve(usdInr);

  const cycle = { ...cycleSummary(j, p.reversal.cycleId), lastLegOpenedAt: Math.max(...cycleLegsOf(j, p.reversal.cycleId).map(l => l.openedAt || 0)) };
  const dec = reversalDecision({ p, price, usdInr, cfg, cycle, now: Date.now(), ensemble: null });
  if (dec.action === 'HOLD') return { dirty };

  // ensemble read ONLY on a trigger (lock-friendly: 30s-cached path)
  let ensemble = null;
  if (typeof getDeepSignal === 'function') {
    try { ensemble = _ensembleOf(await getDeepSignal(baseOfPair(p.pair))); } catch { ensemble = null; }
  }
  const dec2 = reversalDecision({ p, price, usdInr, cfg, cycle, now: Date.now(), ensemble });

  const legNo = p.reversal.leg;
  const close = await closeLeg(j, p, price, {
    reason: dec2.action === 'CLOSE_TARGET'
      ? `REVERSAL target +₹${r2(dec2.pnlINR)} BOOKED (leg-${legNo} ${p.side})`
      : `REVERSAL loss-cap −₹${r2(Math.abs(dec2.pnlINR))} CUT (leg-${legNo} ${p.side})`,
    exitFuturesPosition: deps.exitFuturesPosition, coindcxConnected: deps.coindcxConnected,
  });
  if (!close.ok) return { dirty: true };
  dirty = true;

  const c2 = cycleSummary(j, p.reversal.cycleId);
  const waitingBase = {
    cycleId: p.reversal.cycleId, pair: p.pair, closedSide: p.side, lastCloseAt: Date.now(),
    until: Date.now() + cfg.reentryWindowMs, legCount: c2?.legCount ?? legNo,
    netINR: c2?.netINR ?? close.pnlINR, qty: p.qty, leverage: p.leverage || 1,
    mode: p.mode, rootId: p.reversal.rootId,
  };

  let opened = null;
  if (dec2.action === 'CLOSE_LOSS_CAP' && dec2.flipSide) {
    // IMMEDIATE flip (user spec: cut → ulta side same qty)
    const op = await openReversalLeg(j, {
      pair: p.pair, side: dec2.flipSide, qty: p.qty, leverage: p.leverage || 1, price,
      cycleId: p.reversal.cycleId, leg: legNo + 1, mode: p.mode, rootId: p.reversal.rootId,
      parentPositionId: p.id, cfg, deps,
    });
    if (op.ok) {
      opened = op.position;
      _waiting.delete(p.pair); // cycle is ACTIVE again — window dropped
    } else {
      _waiting.set(p.pair, waitingBase); // flip blocked (caps/pair) → window me confirm ka intezaar
    }
  } else {
    _waiting.set(p.pair, waitingBase);
    if (dec2.action === 'CLOSE_LOSS_CAP' && dec2.blocked) {
      // cut done, flip vetoed (guards/ensemble) — window watches for a confirmed side
    }
  }

  const lines = [
    `🔄 <b>REVERSAL AI — ${p.pair} leg-${legNo} ${p.side} CUT</b>`,
    dec2.action === 'CLOSE_TARGET'
      ? `✅ Target BOOKED: <b>+₹${r2(dec2.pnlINR)}</b> (target ₹${cfg.profitTargetINR})`
      : `🛑 Loss-cap: <b>−₹${r2(Math.abs(dec2.pnlINR))}</b> (cap ₹${cfg.lossCapINR}) — minimal loss accept`,
    ...dec2.reasons.slice(1).map(r => `• ${r}`),
  ];
  if (opened) {
    lines.push(`➡️ <b>FLIP: leg-${legNo + 1} ${opened.side}</b> qty ${opened.qty} @ ${pRound(price)} — ₹-levels SL ${opened.sl} / TP ${opened.tp}${p.mode === 'live' ? ' (exchange pe native TP/SL armed)' : ''}`);
  } else {
    lines.push(`⏳ WAITING window ${cfg.reentryWindowMin}m — ensemble reversal confirm hone pe next leg khulegi.`);
  }
  if (c2) lines.push(`Cycle net: <b>₹${r2(c2.netINR)}</b> · legs ${c2.legCount}/${cfg.maxLegs}`);
  if (typeof sendTelegram === 'function') { try { await sendTelegram(lines.join('\n')); } catch { /* best-effort */ } }

  return { dirty, closed: { pair: p.pair, mode: p.mode, pnlINR: close.pnlINR, reason: p.closeReason, reversal: true }, opened };
}

/**
 * WAITING windows pass (re-entry / expiry). Called by the watcher
 * AFTER the per-position loop. LIVE legs only open when the
 * kill-switch is off (closing stays allowed elsewhere). */
export async function processReversalWaiting(j, byPair, ctx = {}) {
  const { cfg, getDeepSignal, deps, sendTelegram } = ctx;
  if (!cfg?.enabled) return { dirty: false };
  reviveWaitingFromJournal(j, cfg);
  if (_waiting.size === 0) return { dirty: false };
  let dirty = false;
  const cfgO = loadConfig();

  for (const [pair, w] of [..._waiting]) {
    const c = cycleSummary(j, w.cycleId);
    if (!c || c.openLeg || c.legCount >= cfg.maxLegs) { _waiting.delete(pair); continue; }

    let ensemble = null;
    if (typeof getDeepSignal === 'function') {
      try { ensemble = _ensembleOf(await getDeepSignal(baseOfPair(pair))); } catch { ensemble = null; }
    }
    const dec = reentryDecision({ waiting: w, cycle: c, cfg, now: Date.now(), ensemble });

    if (dec.action === 'WAIT') continue;

    if (dec.action === 'END') {
      stampCycleEnd(j, w.cycleId, { reason: dec.reason, netINR: c.netINR });
      _waiting.delete(pair);
      dirty = true;
      if (typeof sendTelegram === 'function') {
        try {
          await sendTelegram([
            `🏁 <b>REVERSAL AI — CYCLE END ${w.pair}</b>`,
            `Net cycle P&L: <b>₹${r2(c.netINR)}</b> (${c.legCount} legs)`,
            `• ${dec.reason}`,
          ].join('\n'));
        } catch { /* best-effort */ }
      }
      continue;
    }

    // ENTER — confirmed reversal leg
    const price = byPair.get(pair);
    if (!(price > 0)) continue;
    if (cfgO.killSwitch) continue; // no NEW legs under kill-switch (windows keep ticking)
    const op = await openReversalLeg(j, {
      pair, side: dec.side, qty: w.qty, leverage: w.leverage || 1, price,
      cycleId: w.cycleId, leg: (c.legCount || 0) + 1, mode: w.mode, rootId: w.rootId,
      parentPositionId: c.rootId, cfg, deps,
    });
    if (op.ok) {
      _waiting.delete(pair);
      dirty = true;
      if (typeof sendTelegram === 'function') {
        try {
          await sendTelegram([
            `🔄 <b>REVERSAL AI — re-entry ${pair}</b>`,
            `➡️ leg-${(c.legCount || 0) + 1} <b>${dec.side}</b> qty ${op.position.qty} @ ${pRound(price)}`,
            `• ${dec.reason}`,
            `• ₹-levels: SL ${op.position.sl} / TP ${op.position.tp}`,
            `Cycle net ab tak: ₹${r2(c.netINR)}`,
          ].join('\n'));
        } catch { /* best-effort */ }
      }
    }
  }
  return { dirty };
}

// ---------------- UI view ----------------

/** The /api/ai/reversal payload — config echo + all known cycles
 *  (open-first) with live-leg P&L when a price map is given. */
export function reversalCyclesView(j, { usdInr = 84, byPair } = {}) {
  const cfg = loadReversalConfig();
  const seen = new Map();
  for (const p of (j?.positions || [])) {
    const cid = p?.reversal?.cycleId;
    if (!cid || seen.has(cid)) continue;
    seen.set(cid, cycleSummary(j, cid));
  }
  const cycles = [...seen.values()].filter(Boolean).map(c => {
    let live = null;
    const openPos = (j?.positions || []).find(p => p.reversal?.cycleId === c.cycleId && (p.status === 'OPEN' || p.status === 'UNKNOWN'));
    if (openPos && byPair) {
      const price = byPair.get(openPos.pair);
      if (price > 0) live = { leg: openPos.reversal?.leg ?? null, side: openPos.side, price: pRound(price), pnlINR: reversalLegPnlINR({ p: openPos, price, usdInr }) };
    }
    return { ...c, live };
  });
  cycles.sort((a, b) => {
    const rank = (c) => c.state === 'ACTIVE' ? 0 : c.state === 'WAITING' ? 1 : 2;
    return rank(a) - rank(b) || (b.lastClosedAt || 0) - (a.lastClosedAt || 0);
  });
  return { ok: true, config: cfg, cycles: cycles.slice(0, 40), activeCycles: cycles.filter(c => c.state !== 'ENDED').length };
}
