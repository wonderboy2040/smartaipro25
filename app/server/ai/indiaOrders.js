// ============================================================
// server/ai/indiaOrders.js — INDIA (Dhan) EXECUTION GAUNTLET
// ------------------------------------------------------------
// v6.5 — the India twin of coindcxOrders.js. Same journal, same
// lock, same daily caps — different venue and clock:
//
//   1. KILL SWITCH      shared (one switch, both venues)
//   2. MODE GATE        indiaMode paper|live (typed LIVE, separate
//                       from crypto arming)
//   3. MARKET GATE      NSE open + LIVE entry window 09:30–15:00 IST
//   4. SIGNAL GATE      fresh server-side ensemble (deep run),
//                       STRONG for LIVE, relaxed for PAPER
//   5. RISK GATE        shared daily trades/loss caps, one position
//                       per symbol, ₹ cap per order, risk auto-fit
//   6. VENUE GATE       Dhan HQ v2 (market entry + protective
//                       STOP_LOSS_MARKET at the broker)
//
// The watcher enforces the intraday discipline the slip teaches:
// trailing SL ratchet + SQUARE-OFF AT 15:15 IST. The broker-side SL
// order is the belt; the watcher is the suspenders (site-down
// protection vs. TP2/target exits the broker can't know).
// ============================================================
import crypto from 'node:crypto';
import { isNseOpen } from './data.js';
import { dhanConnected, dhanPlaceOrder, dhanCancelOrder, dhanOrderStatus, dhanPositions } from './dhan.js';
import { fetchTVIndiaBatch } from './data.js';
import { fetchGrowwNseQuote } from './growwQuote.js';
import { computeTrailSl, evaluateExecutionGate, buildTradePlan, fitPlanToRiskCap } from './ensemble.js';
import { normalizeSide } from './directionCertificate.js';
import {
  loadConfig, loadJournal, saveJournal, withJournalLock, pushEntry, todayIST, dailyStats,
} from './coindcxOrders.js';
import { recordExecution, settlePositionOutcome } from './ledger.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** v21.23.12 [CLOSE FILL-VERIFY — LIVE closes par entry-path parity]:
 *  Dhan ack TRANSIT ke saath aata hai aur async-REJECT ho sakta hai
 *  (v18.9 entry-path comment + 3× poll ka asli kaaran). Pehle HAR live
 *  close orderId ko FILLED maan liya jaata tha → journal full win book
 *  + protective SL-M CANCEL + row CLOSED — broker reject hone par REAL
 *  shares SL ke BINA naked reh jaate the (agli square-off tak). Ab
 *  entry-path jaisa 3× poll (300/600/600ms): TRADED/FILLED/COMPLETE →
 *  filled=true; REJECT/TRANSIT-stuck → false (caller row OPEN rakhta
 *  hai + honest retry, SL-M kabhi nahi kholta). */
async function _dhanVerifyFill(orderId, _label = 'close') {
  if (!orderId) return false;
  for (let i = 0; i < 3; i++) {
    await new Promise(res => setTimeout(res, i === 0 ? 300 : 600));
    const st = await dhanOrderStatus(orderId).catch(() => null);
    const os = String(st?.orderStatus || '').toUpperCase();
    if (!os) continue;
    if (os.includes('TRADED') || os.includes('FILLED') || os.includes('COMPLETE')) return true;
    if (os.includes('REJECT')) return false;
  }
  return false;
}

// ---------------- IST clock helpers ----------------
export function istHM(now = new Date()) {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const [h, m] = f.split(':').map(Number);
    return (h * 60) + m; // minutes since IST midnight
  } catch { // rough UTC+5:30 fallback (non-Intl environments)
    return (((now.getUTCHours() + 5) * 60) + now.getUTCMinutes() + 30) % 1440;
  }
}
export const IST_SQUAREOFF = 15 * 60 + 15;  // 15:15 — intraday discipline
export const IST_ENTRY_LAST = 15 * 60;             // 15:00 — LIVE entries stop
export const IST_ENTRY_FIRST = 9 * 60 + 30;        // 09:30 — opening chop avoided

/**
 * executeIndiaSignal({ symbol, side, mode, qtyINR, getFreshIndiaSignal })
 * getFreshIndiaSignal(symbol) MUST return a fresh deep-run India signal
 * (injected by routes.js — client payloads are never trusted).
 */
export async function executeIndiaSignal(opts) {
  const { symbol, side, mode, qtyINR, getFreshIndiaSignal, source = 'manual', sendTelegram } = opts || {};
  const cfg = loadConfig();
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  // v6.11: NOTIFY mode — full gauntlet, Telegram alert, no order/position.
  const wantMode = mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper';
  const day = todayIST();
  const entry = { kind: 'ORDER', day, pair: sym, symbol: sym, market: 'INDIA', side, mode: wantMode, source };

  const reject = (reason, error, extra = {}) => withJournalLock(() => {
    const j = loadJournal();
    // v21.23.10 [REJECT-DEDUP]: identical consecutive reject (same symbol +
    // reason) 5-min window me dubara journal me NAHI likha jata — pehle
    // engine ke bina-backoff retries 500-entry journal window ko ~70 min
    // me reject-spam se bhar dete the (genuine entries displaced). Repeat
    // count + fresh ts update-in-place, nayi row nahi.
    // v21.23.12 [DEDUP SCAN-20]: pehle sirf LAST journal entry check hoti
    // thi — ek bhi interleaved entry (doosre symbol ka reject / WATCH_ERROR)
    // chain tod deti thi aur duplicate REJECTED phir se likha jaata tha.
    // Ab last 20 entries scan (time-ordered — window se purani pe break).
    const _entries = Array.isArray(j.entries) ? j.entries : [];
    for (let k = _entries.length - 1, n = 0; k >= 0 && n < 20; k--, n++) {
      const e = _entries[k];
      if (!e || e.status !== 'REJECTED') continue;
      if (String(e.symbol) !== String(sym) || String(e.reason) !== String(reason)) continue;
      if (Date.now() - Number(e.ts || 0) >= 5 * 60_000) break;
      e.__repeatCount = (Number(e.__repeatCount) || 1) + 1;
      e.ts = Date.now();
      return saveJournal(j);
    }
    pushEntry(j, { ...entry, status: 'REJECTED', reason, ...extra });
    saveJournal(j);
  }).then(() => ({ ok: false, error: error || reason }));

  // --- gate 1: kill switch (shared) ---
  if (cfg.killSwitch) return reject('Kill switch ON — execution disabled');

  // --- gate 2: India mode (live) ---
  if (wantMode === 'live' && cfg.indiaMode !== 'live') {
    return reject('India LIVE mode is not enabled — type LIVE in the console first (India arming is separate from crypto)');
  }
  if (wantMode === 'live' && !dhanConnected()) {
    return reject('Dhan not connected — Client ID + Access Token required');
  }

  // --- gate 3: market clock (LIVE only; paper practice anytime) ---
  if (wantMode === 'live') {
    if (!isNseOpen()) return reject('NSE is closed — India LIVE orders only fire 09:15–15:30 IST on trading days');
    const mins = istHM();
    if (mins < IST_ENTRY_FIRST) return reject('Before 09:30 IST — opening chop window, LIVE entries blocked');
    if (mins > IST_ENTRY_LAST) return reject('After 15:00 IST — too late for a fresh intraday LIVE entry (square-off 15:15)');
    // v21.1.1 [audit A6/D1]: Phase-4 gates ab India LIVE path me bhi wired —
    // pehle sirf crypto desks (executeSignal/executeFuturesSignal) pe the,
    // jabki StrategyHealthPanel "enforced on both desks" claim karta tha.
    // India LIVE Dhan order mode-gate + risk-caps se guzar ke seedha ja sakta
    // tha bina paper track-record gate aur per-strategy kill rule ke.
    try {
      const { goLiveGateBlocked, strategyGuardBlocked } = await import('./strategyGuard.js');
      const g = goLiveGateBlocked();
      if (g?.blocked) return reject(g.reason, undefined, { goLiveGate: true });
      const sg = strategyGuardBlocked(source, 'INDIA');
      if (sg?.blocked) return reject(sg.reason, undefined, { strategyPaused: true });
    } catch { /* guard module absent — fail-open (test env) */ }
  }

  // --- gate 4: fresh server-side India signal ---
  const signal = await getFreshIndiaSignal(sym);
  if (!signal) return reject('No fresh ensemble signal available for this symbol');

  // PAPER/NOTIFY practice fallback — same honesty as the crypto path. v21.23.2
  // SIGNAL-DIRECTION INVERSION FIX: v21.13 ka silent FLIP-REALIGN HATA DIYA.
  // Pehle fresh consensus ka flipped side (clicked card ke OPPOSITE) trade
  // khul jaata tha — user ko signal LONG dikhta tha aur trade SHORT khulta
  // tha ("long trade signal ka short jaa raha hai"). Ye evaluateExecutionGate
  // ke anti-flip veto ko bhi bypass karta tha (gate REALIGNED side pe match
  // hota tha, veto kabhi fire nahi hota tha). Ab direction conflict = honest
  // REJECT — LIVE ka "kabhi silent flip nahi" invariant ab HAR mode me hai.
  // FLAT/planless (direction-less) case pehle jaisa requested side pe synth
  // hota hai (koi conflict nahi — engine ne direction nahi diya).
  let effectiveSignal = signal;
  let synthNote = null;
  // v12.7 (recheck R1-#9): an ABSENT side no longer silently defaults
  // LONG — an unspecified request inherits the fresh signal's side (the
  // client always sends side; a missing side is a malformed call, and
  // minting a LONG from nothing was a free directional bias).
  const reqSide = normalizeSide(side) ?? normalizeSide(signal.side);
  if (!reqSide) {
    return reject(
      `Direction unresolved: requested side "${String(side ?? '')}" invalid aur fresh signal side "${String(signal.side ?? '')}" bhi LONG/SHORT nahi — entry blocked (no silent LONG).`,
      `Direction unresolved: requested "${String(side ?? '')}" / signal "${String(signal.side ?? '')}" — no silent side`,
    );
  }
  const sideConflict = signal.side !== 'FLAT' && signal.side !== reqSide;
  const belowFloor = signal.grade !== 'STRONG' && signal.grade !== 'ACTION';
  if (sideConflict) {
    // v21.23.2: clicked/signal side ke OPPOSITE trade KABHI nahi khulta.
    // (a) user ke saath honest — ulti direction trade nahi;
    // (b) engine ke saath honest — journal me flip document hota hai,
    //     stale-side trade ka SL engine ke track-record pe nahi jata.
    return reject(
      `Direction conflict: fresh consensus ${signal.side} hai, ${reqSide} signal/card pe trade maara tha — signal FLIP ho gaya (whipsaw window). Entry BLOCKED — silent auto-flip kabhi nahi hota. Naya ${signal.side} card refresh karke confirm karo.`,
      `Signal flip: fresh consensus ${signal.side} ≠ requested ${reqSide} — trade blocked (no auto-flip)`,
      { flippedFrom: reqSide, flippedTo: signal.side },
    );
  }
  if (wantMode !== 'live' && (signal.side === 'FLAT' || !signal.plan)) {
    // FLAT/planless (direction-less) → REQUESTED side pe practice plan synth
    // (engine ne koi direction nahi di — side caller ki hai, conflict nahi).
    const synthPlan = buildTradePlan({ side: reqSide, dir: reqSide === 'LONG' ? 1 : -1 }, { ltp: signal.ltp, ind: {} }, 'INDIA');
    if (synthPlan && signal.ltp > 0) {
      effectiveSignal = { ...signal, side: reqSide, plan: synthPlan };
      synthNote = `practice plan @ live price (fresh consensus: ${signal.side} ${signal.confidence}% — direction-less, requested side pe synth)`;
    }
  }
  const floorNote = (wantMode !== 'live' && !synthNote && (belowFloor || (Number(signal.confidence) || 0) < 55))
    ? `practice floor relaxed (fresh ${signal.grade ?? '—'} · ${signal.confidence ?? 0}% — journaled)` : null;

  // --- gate 5: risk auto-fit (shared policy with crypto) ---
  const riskCap = Number(cfg.maxRiskPct) > 0 ? Number(cfg.maxRiskPct) : 5;
  let fitNote = null;
  const planRiskPct = Number(effectiveSignal?.plan?.riskPct);
  if (Number.isFinite(planRiskPct) && planRiskPct > riskCap) {
    if (wantMode !== 'live' || planRiskPct <= riskCap * 1.5) {
      const fitted = fitPlanToRiskCap(effectiveSignal, riskCap);
      if (fitted.note) {
        effectiveSignal = fitted.signal;
        fitNote = fitted.note;
      }
    }
  }

  const verdict = evaluateExecutionGate(effectiveSignal, {
    // v21.23.2: gate ab HAMESHA effective (conflict-free) side pe hota hai —
    // REALIGN branch hat chuka hai, isliye evaluateExecutionGate ka anti-flip
    // veto (fresh ≠ requested → reject) ab kabhi bypass nahi hota.
    side: wantMode === 'live' ? (side || effectiveSignal.side) : (effectiveSignal.side || side),
    gates: { minConfidence: cfg.minConfidence, minAgreement: cfg.minAgreement },
    requireStrong: wantMode === 'live',
    maxAgeMs: wantMode === 'live' ? 90_000 : 600_000,
    maxRiskPct: cfg.maxRiskPct || 5,
    venue: 'INDIA',
    // v21.23.15: India auto-agent entries must not execute a fresh
    // WATCH/NEUTRAL downgrade; manual paper clicks keep the relaxed floor.
    practice: wantMode !== 'live' && source !== 'india-agent',
  });
  if (!verdict.ok) {
    const hint = (Number(effectiveSignal?.plan?.riskPct) > riskCap)
      ? ` — widen "Max stop %" (currently ${riskCap}%) in Risk settings`
      : '';
    return reject(verdict.reason, `Signal gate: ${verdict.reason}${hint}`, {
      signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
    });
  }

  // v6.11 NOTIFY: gauntlet pass — Telegram alert + journal audit, NO order.
  // Position-creation caps deliberately don't block a notification.
  if (wantMode === 'notify') {
    const alertPrice = Number(effectiveSignal.ltp) > 0 ? Number(effectiveSignal.ltp) : null;
    return withJournalLock(async () => {
      const j = loadJournal();
      const stats = dailyStats(j, 'INDIA');
      const plan = effectiveSignal.plan;
      const capsNote = `trades ${stats.tradesCount}/${cfg.dailyMaxTrades} · realized ₹${r2(stats.realizedPnlINR)} · NSE ${isNseOpen() ? 'OPEN' : 'CLOSED'}`;
      const lines = [
        `🔔 <b>SmartAI NOTIFY (India)</b> — ${sym} ${effectiveSignal.side}`,
        `<b>${signal.grade || '—'}</b> · conf ${signal.confidence ?? '—'}% · agreement ${Math.round((signal.agreement ?? 0) * 100)}%`,
        plan ? `Entry ${r2(plan.entry)} · SL ${r2(plan.stopLoss)} · T1 ${r2(plan.target1)} · T2 ${r2(plan.target2)} · risk ${r2(plan.riskPct)}%` : 'plan nahi bana',
        `Book: ${capsNote}`,
        [synthNote, fitNote, floorNote].filter(Boolean).join(' · ') || undefined,
        '— notify-only: koi order place NAHI hua.',
      ].filter(Boolean);
      let telegramSent = false;
      if (typeof sendTelegram === 'function') {
        try { telegramSent = !!(await sendTelegram(lines.join('\n'))).ok; } catch { /* best-effort */ }
      }
      pushEntry(j, {
        ...entry, status: 'NOTIFIED', ...(alertPrice ? { price: r2(alertPrice) } : {}),
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [synthNote, fitNote, floorNote, verdict.reason].filter(Boolean).join(' · ') || 'gauntlet pass',
        telegramSent,
      });
      saveJournal(j);
      return {
        ok: true, mode: 'notify', notified: true, telegramSent,
        alert: { pair: sym, side: effectiveSignal.side, grade: signal.grade, confidence: signal.confidence,
          plan: plan ? { entry: r2(plan.entry), stopLoss: r2(plan.stopLoss), target2: r2(plan.target2) } : null,
          caps: capsNote },
        note: telegramSent ? 'Telegram alert bhej diya (journal AUDIT: NOTIFIED). Koi order nahi laga.'
          : 'Gauntlet pass + journal AUDIT likha, par Telegram configured nahi — Alerts & AI Keys me token daalo.',
      };
    });
  }

  // --- sizing: whole shares, capped budget ---
  const price = Number(effectiveSignal.ltp);
  if (!(price > 0)) return { ok: false, error: 'No live price for sizing' };
  const budget = Math.min(Number(qtyINR) > 0 ? Number(qtyINR) : (cfg.indiaMaxOrderINR || 5000), cfg.indiaMaxOrderINR || 5000);
  if (budget < 100) return { ok: false, error: `Order size ₹${budget} below the ₹100 minimum` };
  let qty = Math.floor(budget / price);
  // v6.5 PRACTICE FALLBACK: many NIFTY names cost more than the budget
  // (MARUTI ₹12k, ULTRACEMCO ₹11k…). PAPER must never dead-end on share
  // price — it opens a 1-share practice position with an honest note.
  // LIVE honestly rejects: real money needs a real budget.
  let smallNote = null;
  if (qty < 1) {
    if (wantMode === 'paper') {
      qty = 1;
      smallNote = `practice 1-share position (₹${r2(price)}/share > budget ₹${budget} — raise "India Max ₹" for full sizing)`;
    } else {
      return { ok: false, error: `₹${budget} buys 0 shares of ${sym} @ ₹${r2(price)} — increase India Max ₹ in Risk settings` };
    }
  }
  const notional = qty * price;

  // --- FINAL MUTATION under the journal lock, FRESH caps re-check ---
  return withJournalLock(async () => {
    const j = loadJournal();
    const stats = dailyStats(j, 'INDIA');
    if (stats.tradesCount >= cfg.dailyMaxTrades) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Daily trade cap (${cfg.dailyMaxTrades}) hit` });
      saveJournal(j);
      return { ok: false, error: `Daily trade cap (${cfg.dailyMaxTrades}) reached — resets at IST midnight` };
    }
    if (stats.realizedPnlINR <= -cfg.dailyMaxLossINR) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Daily loss cap (₹${cfg.dailyMaxLossINR}) hit` });
      saveJournal(j);
      return { ok: false, error: `Daily loss cap (₹${cfg.dailyMaxLossINR}) breached — trading paused for today` };
    }
    // v18.9: UNKNOWN counts as open for the one-per-symbol rule (same as
    // the crypto desk) — an unreconciled fill must not stack a second
    // LIVE order on the same symbol.
    if (j.positions.some(p => p.market === 'INDIA' && p.symbol === sym && (p.status === 'OPEN' || p.status === 'UNKNOWN'))) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: 'India position already open for this symbol' });
      saveJournal(j);
      return { ok: false, error: `An open India position already exists for ${sym} (one-per-symbol rule)` };
    }
    // v6.7 CONCENTRATION GUARD — shared book across BOTH desks
    const openCount = j.positions.filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length;
    if (openCount >= (cfg.maxOpenPositions || 5)) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Max open positions (${cfg.maxOpenPositions || 5}) hit` });
      saveJournal(j);
      return { ok: false, error: `Concentration guard: ${openCount} positions already open across both desks (max ${cfg.maxOpenPositions || 5}) — close some first or raise the cap in Risk settings` };
    }

    // --- paper execution ---
    if (wantMode === 'paper') {
      // v6.7: stamp into the tamper-evident ledger
      let ledgerEntryId = null;
      try {
        // v20.3: relaxed stamp parity — the spot desk's corpus-hygiene
        // filter now applies to the India paper desk too (synth/floor
        // practice entries stay OUT of calibration).
        const rec = recordExecution(signal, {
          mode: 'paper', market: 'INDIA', source,
          ...(synthNote || floorNote ? { relaxed: true } : {}),
        });
        ledgerEntryId = rec?.id || null;
      } catch { /* best-effort */ }
      const position = {
        id: crypto.randomUUID(), pair: sym, symbol: sym, side: effectiveSignal.side, mode: 'paper', market: 'INDIA', source,
        qty, originalQty: qty, exitStage: 'ENTRY', // v10.3 agent PRO-exit tiers (harmless on manual)
        entryPrice: price, notionalINR: r2(notional),
        ...(ledgerEntryId ? { ledgerEntryId } : {}),
        sl: effectiveSignal.plan?.stopLoss ?? null, tp: effectiveSignal.plan?.target1 ?? null, tp2: effectiveSignal.plan?.target2 ?? null,
        initialRisk: r2(Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price))),
        peakPrice: r2(price),
        signal: { grade: signal.grade, confidence: signal.confidence, agreement: signal.agreement, summary: synthNote || signal.summary },
        openedAt: Date.now(), status: 'OPEN',
      };
      j.positions.push(position);
      pushEntry(j, {
        ...entry, status: 'FILLED', qty, price: r2(price), notionalINR: r2(notional),
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [verdict.reason, synthNote, fitNote, smallNote, floorNote].filter(Boolean).join(' · '),
      });
      saveJournal(j);
      return { ok: true, mode: 'paper', position, filled: { qty, price: r2(price), notionalINR: r2(notional) }, ...{ fitted: [synthNote, fitNote, smallNote, floorNote].filter(Boolean).join(' · ') || undefined } };
    }

    // --- LIVE: market entry + protective broker SL (SL-M at the plan stop) ---
    try {
      const entryOrder = await dhanPlaceOrder({ symbol: sym, side: effectiveSignal.side, quantity: qty, kind: 'ENTRY' });
      // v18.9 FILL VERIFICATION — the old code assumed orderId ⇒ filled and
      // booked the PRE-order TV LTP as entryPrice. A margin/circuit reject
      // or partial fill after a TRANSIT reply left the journal carrying a
      // phantom OPEN position with a made-up basis (every downstream P&L,
      // cap and close report wrong; a later "close" SELL would be a naked
      // order). Poll the broker 3× (500ms apart) for the real state.
      let fill = null;
      if (entryOrder.orderId) {
        for (let i = 0; i < 3 && !fill; i++) {
          await new Promise(res => setTimeout(res, i === 0 ? 300 : 600));
          const st = await dhanOrderStatus(entryOrder.orderId).catch(() => null);
          const os = String(st?.orderStatus || '').toUpperCase();
          if (!os) continue;
          if (os.includes('TRADED') || os.includes('FILLED') || os.includes('COMPLETE')) { fill = st; break; }
          if (os.includes('REJECT')) { fill = { orderStatus: 'REJECTED' }; break; }
          // TRANSIT/PENDING → keep polling
        }
      }
      if (fill && /REJECT/i.test(String(fill.orderStatus || ''))) {
        pushEntry(j, { ...entry, status: 'FAILED', exchangeOrderId: entryOrder.orderId, reason: `Dhan entry REJECTED: ${String(fill.rejectedReason || fill.orderStatus || '').slice(0, 120)} — no position booked` });
        saveJournal(j);
        return { ok: false, error: `Dhan entry order REJECTED (${String(fill.rejectedReason || fill.orderStatus || 'broker reject').slice(0, 120)}) — koi position book nahi hui` };
      }
      // real average fill price when the broker reports it (slippage truth)
      const fillPx = Number(fill?.averageTradedPrice ?? fill?.averagePrice ?? fill?.avgTradedPrice ?? NaN);
      const entryPriceBooked = Number.isFinite(fillPx) && fillPx > 0 ? r2(fillPx) : price;
      let slOrderId = null;
      if (entryOrder.orderId && effectiveSignal.plan?.stopLoss > 0) {
        try {
          const slOrder = await dhanPlaceOrder({
            symbol: sym, side: effectiveSignal.side, quantity: qty, kind: 'SL',
            triggerPrice: effectiveSignal.plan.stopLoss,
          });
          slOrderId = slOrder.orderId || null;
        } catch { /* protective SL failed → watcher still guards; journal it below */ }
      }
      const position = {
        id: crypto.randomUUID(), pair: sym, symbol: sym, side: effectiveSignal.side, mode: 'live', market: 'INDIA', source,
        exchangeOrderId: entryOrder.orderId, slOrderId,
        securityId: entryOrder.securityId || null,
        qty, originalQty: qty, exitStage: 'ENTRY', // v10.3 agent PRO-exit tiers (harmless on manual)
        entryPrice: entryPriceBooked, notionalINR: r2(entryPriceBooked * qty),
        // v6.7: live executions are part of the tamper-evident trail too
        ledgerEntryId: (() => { try { return recordExecution(signal, { mode: 'live', market: 'INDIA', source })?.id || null; } catch { return null; } })(),
        sl: effectiveSignal.plan?.stopLoss ?? null, tp: effectiveSignal.plan?.target1 ?? null, tp2: effectiveSignal.plan?.target2 ?? null,
        initialRisk: r2(Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price))),
        peakPrice: r2(price),
        signal: { grade: signal.grade, confidence: signal.confidence, agreement: signal.agreement, summary: signal.summary },
        openedAt: Date.now(), status: entryOrder.orderId ? 'OPEN' : 'UNKNOWN',
        ...(fill ? { fillVerified: true, fillStatus: String(fill.orderStatus || '').slice(0, 24) } : {}),
      };
      j.positions.push(position);
      pushEntry(j, {
        ...entry, status: entryOrder.orderId ? 'SUBMITTED' : 'SUBMITTED_UNKNOWN',
        qty, price: r2(entryPriceBooked), notionalINR: r2(entryPriceBooked * qty),
        exchangeOrderId: entryOrder.orderId, slOrderId,
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [verdict.reason, fitNote,
          fill ? `fill verified @ ₹${entryPriceBooked}${Number.isFinite(fillPx) && fillPx > 0 ? ' (broker average)' : ' (signal LTP — broker avg nahi mila)'}` : 'fill PENDING (TRANSIT) — watcher verify karega',
          slOrderId ? `broker SL-M armed @ ₹${effectiveSignal.plan?.stopLoss}` : 'broker SL placement failed — watcher guarding only'].filter(Boolean).join(' · '),
      });
      saveJournal(j);
      return {
        ok: true, mode: 'live', orderId: entryOrder.orderId, slOrderId, position,
        filled: { qty, price: r2(entryPriceBooked), notionalINR: r2(entryPriceBooked * qty) },
        ...(fitNote ? { fitted: fitNote } : {}),
      };
    } catch (e) {
      pushEntry(j, { ...entry, status: 'FAILED', reason: String(e?.message || e).slice(0, 200) });
      saveJournal(j);
      return { ok: false, error: `Dhan order failed: ${e?.message || e}` };
    }
  });
}

// ---------------- India watcher: trailing + SL/TP + 15:15 square-off ----------------
/**
 * Runs under the journal lock (every 60s from routes.js — only while
 * NSE is open; outside hours nothing can move but the square-off pass
 * which routes runs once at 15:16). Closes via Dhan MARKET order for
 * live positions, simulated for paper. Cancels the leftover broker SL
 * when closing for a non-SL reason (TP2 / square-off / manual).
 */
export async function watchIndiaPositions({ sendTelegram } = {}) {
  return withJournalLock(async () => {
    const j = loadJournal();
    const cfg = loadConfig();
    // v18.9: the emptiness check covers ALL open/unknown INDIA rows — a
    // watcher pass with ONLY a live-UNKNOWN row still runs (alert + stale
    // reconcile) instead of early-returning before the v18.9 guards.
    const anyRows = j.positions.filter(p => p.market === 'INDIA' && (p.status === 'OPEN' || p.status === 'UNKNOWN'));
    if (anyRows.length === 0) return [];
    const open = anyRows.filter(p => p.status === 'OPEN' || (p.status === 'UNKNOWN' && p.mode !== 'live'));
    const closures = [];
    let dirty = false;

    // ---- v18.9 DAY-ROLLOVER RECONCILE ----
    // If the app (or the quote feed) was down through the 15:15–15:30
    // square-off window, INDIA positions survived into the NEXT session:
    // the old code managed them against FRESH next-day prices — a tripped
    // stop then fired a market order on a broker-auto-squared MIS position
    // (an unintended naked intraday order + phantom P&L). Positions whose
    // openedAt day ≠ today are force-reconciled INSTEAD of managed:
    //   LIVE   → verify against the broker's day positions (dhanPositions);
    //            gone → CLOSED (broker square-off, last-known price);
    //            still there (CNC carry) → carriedOvernight flag + alert,
    //            never auto-traded.
    //   PAPER  → STALE_SQOFF close at last-known price (honest note).
    const today = todayIST();
    const stale = j.positions.filter(p => p.market === 'INDIA' && (p.status === 'OPEN' || p.status === 'UNKNOWN')
      && p.openedAt && new Date(p.openedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) !== today);
    if (stale.length > 0) {
      let brokerMap = null;
      const anyLive = stale.some(p => p.mode === 'live' && dhanConnected());
      if (anyLive) {
        try {
          const resp = await dhanPositions();
          const arr = Array.isArray(resp) ? resp : (Array.isArray(resp?.positions) ? resp.positions : []);
          brokerMap = new Map(arr.map(x => [String(x?.securityId ?? x?.symbolId ?? ''), Number(x?.netQty ?? x?.qty ?? 0)]).filter(([k]) => k && k !== 'undefined'));
        } catch { brokerMap = null; /* honest degrade below */ }
      }
      for (const p of stale) {
        const lastPx = Number(p.peakPrice) > 0 ? Number(p.peakPrice) : Number(p.entryPrice);
        if (p.mode === 'live' && brokerMap) {
          const key = String(p.securityId || '');
          const netQty = key ? brokerMap.get(key) : undefined;
          if (netQty == null || Math.abs(Number(netQty) || 0) < Math.max(1, Math.floor(p.qty * 0.5))) {
            // broker does not hold it → the MIS was auto-squared
            const pnlINR = (p.side === 'LONG' ? lastPx - p.entryPrice : p.entryPrice - lastPx) * p.qty;
            p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = lastPx;
            p.pnlINR = r2(pnlINR); p.closeReason = 'MISSED_SQOFF (broker auto-square assumed — app was down at EOD)';
            settlePositionOutcome(p, p.closeReason);
            pushEntry(j, { kind: 'CLOSE', day: today, pair: p.pair, symbol: p.symbol, market: 'INDIA', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: lastPx, pnlINR: r2(pnlINR), reason: p.closeReason });
            closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: 'MISSED_SQOFF (reconciled)' });
            dirty = true;
          } else {
            p.carriedOvernight = true;
            pushEntry(j, { kind: 'WATCH_ERROR', day: today, pair: p.pair, symbol: p.symbol, market: 'INDIA', reason: `OVERNIGHT CARRY detected (broker abhi bhi position hold karta hai) — auto-trade band for this row, manually manage karo.` });
            dirty = true;
          }
        } else if (p.mode === 'live') {
          pushEntry(j, { kind: 'WATCH_ERROR', day: today, pair: p.pair, symbol: p.symbol, market: 'INDIA', reason: 'STALE LIVE position (previous session, broker verify nahi ho paya) — auto-management band, manually check karo.' });
          p.carriedOvernight = true;
          dirty = true;
        } else {
          const pnlINR = (p.side === 'LONG' ? lastPx - p.entryPrice : p.entryPrice - lastPx) * p.qty;
          p.status = 'CLOSED'; p.closedAt = Date.now(); p.closePrice = lastPx;
          p.pnlINR = r2(pnlINR); p.closeReason = 'STALE_SQOFF (day rollover — feed was down at EOD)';
          settlePositionOutcome(p, p.closeReason);
          pushEntry(j, { kind: 'CLOSE', day: today, pair: p.pair, symbol: p.symbol, market: 'INDIA', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: lastPx, pnlINR: r2(pnlINR), reason: p.closeReason });
          closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: 'STALE_SQOFF (reconciled)' });
          dirty = true;
        }
      }
      if (dirty) saveJournal(j);
      // stale rows are reconciled — the normal pass below only manages TODAY's rows
    }
    const liveOpen = open.filter(p => !p.carriedOvernight && !(p.status === 'UNKNOWN' && p.mode === 'live'));
    const openToday = liveOpen.filter(p => !stale.includes(p));
    // v18.9: today's LIVE-UNKNOWN (fill never verified) — never auto-managed
    // (a close SELL on an unfilled position = naked order), but surfaced
    // once per row like the crypto desk does. Scans ALL open/unknown INDIA
    // rows (the `open` set above deliberately excludes live-UNKNOWN).
    for (const p of j.positions) {
      if (p.market === 'INDIA' && p.status === 'UNKNOWN' && p.mode === 'live' && !stale.includes(p) && !p.unknownAlerted) {
        p.unknownAlerted = true; dirty = true;
        pushEntry(j, { kind: 'WATCH_ERROR', day: today, pair: p.pair, symbol: p.symbol, market: 'INDIA', reason: 'UNKNOWN live India position (fill verify nahi hua) — auto-management band, broker app me order status check karo.' });
      }
    }
    if (dirty) saveJournal(j);
    if (openToday.length === 0) return closures;

    // prices: one TV batch for all open India symbols
    const rows = await fetchTVIndiaBatch([...new Set(openToday.map(p => p.symbol))]).catch(() => ({}));
    const ltpOf = (sym) => {
      const v = Number(rows[sym]?.ltp);
      return Number.isFinite(v) && v > 0 ? v : null;
    };

    const mins = istHM();
    const squareOffNow = mins >= IST_SQUAREOFF;

    for (const p of openToday) {
      const price = ltpOf(p.symbol);
      if (price == null) continue;
      const long = p.side === 'LONG';

      // v6.5 trailing ratchet — same math as the crypto watcher
      if (cfg.trailEnabled && p.sl != null && p.sl > 0) {
        const prevPeak = Number(p.peakPrice);
        const peak = long
          ? Math.max(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price)
          : Math.min(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price);
        p.peakPrice = r2(peak);
        const risk = Number(p.initialRisk) > 0 ? Number(p.initialRisk) : Math.abs(p.entryPrice - p.sl);
        if (risk > 0) {
          const trail = computeTrailSl({
            side: p.side, entryPrice: p.entryPrice, peakPrice: peak, currentSl: p.sl,
            initialRisk: risk, price, armR: cfg.trailArmR, offsetR: cfg.trailOffsetR,
          });
          if (trail) {
            // live positions: the broker SL-M follows the trail (cancel +
            // replace) — awaited INSIDE the lock so no journal write can
            // escape the mutex discipline.
            // v18.9: p.slOrderId is cleared the moment the cancel is ISSUED —
            // a failed replace used to leave the journal claiming an armed
            // broker SL that was actually cancelled (server dies in that
            // window → live position with NO broker stop at all).
            if (p.mode === 'live' && p.slOrderId) {
              await dhanCancelOrder(p.slOrderId).catch(() => { /* best-effort */ });
              p.slOrderId = null; // honest: broker SL offline until replace lands
            }
            if (p.mode === 'live' && trail.sl > 0) {
              try {
                const o = await dhanPlaceOrder({ symbol: p.symbol, side: p.side, quantity: p.qty, kind: 'SL', triggerPrice: trail.sl });
                if (o?.orderId) p.slOrderId = o.orderId;
              } catch { /* watcher still guards even if broker SL replace failed */ }
            }
            pushEntry(j, {
              kind: 'TRAIL', day: todayIST(), pair: p.pair, symbol: p.symbol, market: 'INDIA',
              reason: `SL ${trail.stage}: ₹${p.sl} → ₹${trail.sl} (peak ₹${r2(peak)})`, from: p.sl, to: trail.sl,
            });
            p.sl = trail.sl;
            p.trailing = trail.stage;
          }
        }
        dirty = true;
      }

      let close = null;
      if (squareOffNow) close = { reason: 'Intraday square-off 15:15 IST', price, kind: 'TIME' };
      else if (p.sl != null && (long ? price <= p.sl : price >= p.sl)) close = { reason: 'STOP-LOSS hit', price, kind: 'SL' };
      else if (p.tp2 != null && (long ? price >= p.tp2 : price <= p.tp2)) close = { reason: 'TARGET-2 hit', price, kind: 'TP2' };
      if (!close) continue;

      let closed = false;
      if (p.mode === 'live' && dhanConnected()) {
        try {
          const exit = await dhanPlaceOrder({ symbol: p.symbol, side: long ? 'SELL' : 'BUY', quantity: p.qty, kind: 'ENTRY' });
          // v21.23.12 [CLOSE FILL-VERIFY]: orderId ≠ filled (Dhan TRANSIT ack +
          // async-reject). Unverified close = row OPEN + next-tick retry; SL-M
          // cancel sirf VERIFIED fill ke baad (naked-shares disease).
          closed = await _dhanVerifyFill(exit?.orderId, `watcher-close:${p.symbol}`);
          if (!closed) {
            pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, symbol: p.symbol, market: 'INDIA', reason: `LIVE close UNVERIFIED (${close.kind}/${close.reason}) — broker TRANSIT/REJECT; position OPEN + SL-M armed, next tick retry` });
            dirty = true;
            continue;
          }
        } catch (e) {
          pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, symbol: p.symbol, market: 'INDIA', reason: String(e?.message || e).slice(0, 200) });
          dirty = true;
          continue; // retry next tick
        }
      } else {
        closed = true; // paper close always executable
      }
      if (!closed) continue;

      // non-SL closes: the protective broker SL order must not linger
      if (p.mode === 'live' && p.slOrderId && close.kind !== 'SL') {
        dhanCancelOrder(p.slOrderId).catch(() => { /* best-effort */ });
      }

      const pnlINR = (long ? price - p.entryPrice : p.entryPrice - price) * p.qty;
      p.status = 'CLOSED';
      p.closedAt = Date.now();
      p.closePrice = price;
      p.pnlINR = r2(pnlINR);
      p.closeReason = close.reason;
      settlePositionOutcome(p, close.reason); // v6.7 ledger
      dirty = true;
      pushEntry(j, {
        kind: 'CLOSE', day: todayIST(), pair: p.pair, symbol: p.symbol, market: 'INDIA', mode: p.mode, source: p.source,
        qty: p.qty, entryPrice: p.entryPrice, closePrice: price, pnlINR: r2(pnlINR), reason: close.reason,
      });
      closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: close.reason });
    }

    if (dirty) saveJournal(j);
    if (typeof sendTelegram === 'function' && closures.length > 0) {
      try {
        await sendTelegram(`🇮🇳 <b>AI Trading India</b> — position closed\n${closures.map(c => `• ${c.pair} (${c.mode}) — ${c.reason}: ₹${c.pnlINR > 0 ? '+' : ''}${c.pnlINR}`).join('\n')}`);
      } catch { /* best-effort */ }
    }
    return closures;
  });
}

// ---------------- manual close ----------------
// v10.3: opts { qty, reason } — a qty BELOW the remaining position is a
// PARTIAL close (agent PRO-exit T1/T2 legs): the leg books immediately
// (kind PARTIAL_TP, counts in daily realized P&L exactly like the crypto
// desk), the position stays OPEN for the runner, and on LIVE the
// protective broker SL is cancel+replaced to the remainder. Callers not
// passing opts get the original full-close behaviour 1:1.
export async function closeIndiaPosition(positionId, opts = {}) {
  const { qty: wantQty, reason = 'Manual close' } = opts || {};
  return withJournalLock(async () => {
    const j = loadJournal();
    const p = j.positions.find(x => x.id === positionId || x.exchangeOrderId === positionId);
    if (!p || p.market !== 'INDIA' || (p.status !== 'OPEN' && p.status !== 'UNKNOWN')) {
      return { ok: false, error: 'India position not found / already closed' };
    }
    // v21.23.15 FIX (TITAN fill gap): the TV scanner can lag the real tape
    // by a minute or more. A Groww-triggered T1 (4306.6) was journaled at
    // the stale TV close (4325.8) - a 19-point paper-fill error. Groww
    // realtime is now the PRIMARY fill reference; TV is the fallback.
    const [rows, growwQuote] = await Promise.all([
      fetchTVIndiaBatch([p.symbol]).catch(() => ({})),
      fetchGrowwNseQuote(p.symbol).catch(() => null),
    ]);
    const gwLtp = Number(growwQuote?.price);
    const tvLtp = Number(rows[p.symbol]?.ltp);
    const price = Number.isFinite(gwLtp) && gwLtp > 0
      ? gwLtp
      : (Number.isFinite(tvLtp) && tvLtp > 0 ? tvLtp : null);
    // v7.0.2: no live price → HONEST reject (the old `|| p.entryPrice`
    // booked a fake ₹0-P&L close and understated the daily-loss cap).
    if (price == null) {
      return { ok: false, error: `No live price for ${p.symbol} — thodi der baad try karo (honest close, no fake P&L)` };
    }
    const long = p.side === 'LONG';
    const closeQty = Number.isFinite(Number(wantQty)) && Number(wantQty) >= 1
      ? Math.min(Math.floor(Number(wantQty)), p.qty)
      : p.qty;

    // ---- v10.3 PARTIAL leg (qty < remaining) ----
    if (closeQty < p.qty) {
      if (p.mode === 'live' && dhanConnected()) {
        try {
          const exit = await dhanPlaceOrder({ symbol: p.symbol, side: long ? 'SELL' : 'BUY', quantity: closeQty, kind: 'ENTRY' });
          if (!exit.orderId) return { ok: false, error: 'Dhan partial close failed: no orderId returned' };
          // v21.23.12 [CLOSE FILL-VERIFY]: partial leg bhi verified — unverified
          // par qty/pnl book + SL cancel+replace KABHI nahi.
          const partFilled = await _dhanVerifyFill(exit.orderId, `partial-close:${p.symbol}`);
          if (!partFilled) {
            return { ok: false, error: `Dhan partial close UNVERIFIED (${exit.orderId}) — position as-is rakha gaya, SL intact, dobara try karo` };
          }
          // the protective SL must follow the REMAINING qty (cancel + replace)
          if (p.slOrderId) { await dhanCancelOrder(p.slOrderId).catch(() => { /* best-effort */ }); p.slOrderId = null; }
          if (p.sl > 0) {
            try {
              const o = await dhanPlaceOrder({ symbol: p.symbol, side: p.side, quantity: p.qty - closeQty, kind: 'SL', triggerPrice: p.sl });
              if (o?.orderId) p.slOrderId = o.orderId;
            } catch { /* watcher still guards the remainder */ }
          }
        } catch (e) {
          return { ok: false, error: `Dhan partial close failed: ${e?.message || e}` };
        }
      }
      const legPnl = (long ? price - p.entryPrice : p.entryPrice - price) * closeQty;
      p.qty -= closeQty;
      p.bookedPnlINR = r2((p.bookedPnlINR || 0) + legPnl);
      pushEntry(j, {
        kind: 'PARTIAL_TP', day: todayIST(), pair: p.pair, symbol: p.symbol, market: 'INDIA', mode: p.mode, source: p.source,
        qty: closeQty, entryPrice: p.entryPrice, closePrice: price, pnlINR: r2(legPnl), reason,
      });
      saveJournal(j);
      return { ok: true, partial: true, position: p, leg: { qty: closeQty, price: r2(price), pnlINR: r2(legPnl) } };
    }

    // ---- full close (original path; reason threaded through) ----
    if (p.mode === 'live' && dhanConnected()) {
      try {
        const exit = await dhanPlaceOrder({ symbol: p.symbol, side: long ? 'SELL' : 'BUY', quantity: p.qty, kind: 'ENTRY' });
        if (!exit.orderId) return { ok: false, error: 'Dhan close failed: no orderId returned' };
        // v21.23.12 [CLOSE FILL-VERIFY]: full close bhi entry-path jaisa
        // verified — unverified par row CLOSED + SL-M cancel KABHI nahi.
        const fullFilled = await _dhanVerifyFill(exit.orderId, `manual-close:${p.symbol}`);
        if (!fullFilled) {
          return { ok: false, error: `Dhan close UNVERIFIED (${exit.orderId} — broker TRANSIT/REJECT) — position OPEN rakha gaya, SL-M armed; dobara try karo (naked-close kabhi nahi)` };
        }
      } catch (e) {
        return { ok: false, error: `Dhan close failed: ${e?.message || e}` };
      }
      if (p.slOrderId) dhanCancelOrder(p.slOrderId).catch(() => { /* best-effort */ });
    }
    const pnlINR = (long ? price - p.entryPrice : p.entryPrice - price) * p.qty;
    p.status = 'CLOSED';
    p.closedAt = Date.now();
    p.closePrice = price;
    p.pnlINR = r2(pnlINR);
    p.closeReason = reason;
    settlePositionOutcome(p, reason); // v6.7 ledger
    pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, symbol: p.symbol, market: 'INDIA', mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: price, pnlINR: r2(pnlINR), reason });
    saveJournal(j);
    return { ok: true, position: p };
  });
}
