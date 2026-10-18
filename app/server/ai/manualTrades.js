// ============================================================
// server/ai/manualTrades.js — v10.16 SECTION 2: MANUAL TRADE TRACKER
// ------------------------------------------------------------
// THE GAP (superintelligence plan v2): a user takes a REAL trade off a
// signal card ("Maine ye trade liya hai") and the site immediately
// forgets it. Paper trades are tracked; agent trades are tracked; the
// user's OWN trades — the ones with real money on the line — had zero
// support. This module gives every manual entry the SAME intelligence
// the desk gives its own positions:
//
//   • the ORIGINATING SIGNAL SNAPSHOT is frozen at entry — the plan
//     (entry/SL/T1/T2), the 14-model vote breakdown, the regime label,
//     and the AI score. "Trend change" is measured AGAINST this
//     baseline; without it there is nothing to compare to.
//   • LIVE tracking: LTP (5s via the live tick store / cached quotes),
//     P&L in ₹/USDT and %, distance to SL and each target, time in
//     trade.
//   • LIVE CONVICTION BAR: reuses positionConviction.js — the ensemble
//     re-votes the symbol each ~30s (the cached getDeepSignal path,
//     zero new upstream calls) and the state banner escalates:
//       THESIS INTACT (green)  → ensemble still backs the original side
//       WEAKENING    (amber)   → conviction decaying, consider tightening
//       EXIT NOW     (red)     → ensemble FLIPPED to the opposite side
//       TARGET HIT   (blue)    → price reached T1/T2
//   • TELEGRAM: conviction flip = immediate highest-priority push with
//     the WHY (which models flipped, current vs entry score); SL
//     approach (within 0.3 ATR); each target hit; stagnant check-ins.
//     Commands: /manual (live list), /manualclose <id>.
//
// Instrument coverage: India equity + F&O options (BS-repriced premium,
// same as the paper desk), crypto spot/perps (live tick store), global
// equity SIM — because it keys off the signal snapshot every card
// already produces.
//
// Persistence: server/data/manual-trades.json (atomic writes, debounced,
// mirrored to the GitHub backup branch — the paper-desk pattern).
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
// v12.7 (recheck R3-HIGH-1): manual-trade state rides the ENCRYPTED durable
// channel (AES-256-GCM envelope) — the plaintext scheduleBackup push put
// holdings on a public repo branch. Boot restore added at the same time:
// the plaintext remote existed but was NEVER read back — restarts lost
// the manual tracker silently (recheck R3: "dead weight + data loss").
import { restoreBackup, backupConfigured } from '../intraday/backup.js';
import { durablePut, decryptJSON } from '../mcp/durable.js';
import { getTick } from '../liveFeed.js';
import { bsPrice, yearsToExpiry } from './lib/blackScholes.js';
import { sideOf, classifyConviction, quorumOfSignal } from './positionConviction.js';
// v12.8 REVERSAL AI — the ₹ loss-cap advisory banner reads the same
// clamped config the futures-desk engine uses (60s TTL cache inside).
// v12.9: full ENGINE connection — manual trades now ACTIVATE a reversal
// cycle at the ₹ thresholds (loss-cap cut plan / ₹ target BOOK plan,
// exact flip levels stamped), advance on close, and auto-link the
// follow-up entry as the next cycle leg.
import { loadReversalConfig, priceLevelsForLeg } from './reversalEngine.js';
// v13.1 SIGNAL VERIFICATION AGENT — every manual trade is stamped with
// the SVA verdict it was opened under (the XRP-class lesson: the
// signal's own warnings existed, nobody aggregated them into a final
// call at the point of entry).
import { verifySignal, verificationWire } from './signalVerifier.js';

const FILE = 'manual-trades.json';
const MAX_TRADES = 300;
const RISK_FREE = 0.065; // matches optionsDesk.js / paperTrading.js

// ---------------- v18.6.3 REALTIME NEVER STOPS ----------------
// THE BUG: ltpForManualTrade() reads the liveFeed tick store, and the
// tick store only stays fresh while browser SSE clients subscribe the
// symbols (the streams are refcounted — zero clients → pollers park).
// The user's workflow (trade on the CoinDCX site in another browser
// tab → the app tab goes hidden → SSE parks 30s later) drained the
// tick store, and with ZERO browser connections the monitor's 5s LTP
// sweep got null for every crypto trade — "trade open hai par
// realtime prices fetch nahi ho rahe".
// THE FIX: while ANY manual trade is open, the monitor ITSELF holds
// the upstream subscriptions for those symbols (one service-level
// refcount per stream + per-symbol ensures, exactly the /api/stream
// contract). Prices, P&L, the reversal engine and the telegram alerts
// all stay live even if every browser disconnects.
let _subHold = null; // { crypto:Set, india:Set, cxrt:Set, clients:{crypto,india,cxrt} }

function _splitOpenTradeSyms(open) {
  const crypto = new Set(), india = new Set(), fut = new Set(), glob = new Set();
  for (const t of open || []) {
    const sym = String(t.symbol || '').trim().toUpperCase();
    if (!sym) continue;
    if (t.market === 'FUTURES') fut.add(sym);
    else if (t.market === 'GLOBALFUTURES') glob.add(sym);
    else if (t.market === 'CRYPTO') crypto.add(sym);
    else if (t.market === 'INDIA' && t.assetKind !== 'OPTION') india.add(sym);
  }
  return { crypto, india, fut, glob };
}

/** Pure diff — test-exported. Returns per-domain add/del lists. */
export function tradeSubDiff(prev, want) {
  const p = prev || { crypto: [], india: [], fut: [], glob: [] };
  const out = {};
  for (const dom of ['crypto', 'india', 'fut', 'glob']) {
    const prevSet = new Set(p[dom] || []);
    const wantSet = new Set((want || {})[dom] || []);
    const add = [...wantSet].filter(s => !prevSet.has(s));
    const del = [...prevSet].filter(s => !wantSet.has(s));
    if (add.length || del.length) out[dom] = { add, del };
  }
  return out;
}

function _syncTradeSubscriptions(open, deps) {
  const { ensureSubs, releaseSubs, clientUp, clientDown } = deps || {};
  if (typeof ensureSubs !== 'function' || typeof releaseSubs !== 'function') return;
  const want = _splitOpenTradeSyms(open);
  const _wantCx = { fut: want.fut, glob: want.glob };
  const wantCxAny = want.fut.size > 0 || want.glob.size > 0;

  // First open trade → start holding (clientUp per stream so the
  // pollers actually RUN while zero browser SSE clients exist).
  if (!_subHold && (want.crypto.size || want.india.size || wantCxAny)) {
    _subHold = { crypto: new Set(), india: new Set(), fut: new Set(), glob: new Set(), clients: { crypto: false, india: false, cxrt: false } };
  }
  if (!_subHold) return; // nothing open, nothing held — idle

  if (want.crypto.size > 0 && !_subHold.clients.crypto) { _subHold.clients.crypto = true; try { clientUp?.('crypto'); } catch { /* best-effort */ } }
  if (want.india.size > 0 && !_subHold.clients.india) { _subHold.clients.india = true; try { clientUp?.('india'); } catch { /* best-effort */ } }
  if (wantCxAny && !_subHold.clients.cxrt) { _subHold.clients.cxrt = true; try { clientUp?.('cxrt'); } catch { /* best-effort */ } }

  const patch = tradeSubDiff(
    { crypto: [..._subHold.crypto], india: [..._subHold.india], fut: [..._subHold.fut], glob: [..._subHold.glob] },
    { crypto: [...want.crypto], india: [...want.india], fut: [...want.fut], glob: [...want.glob] },
  );
  // apply adds/removes through the injected stream APIs (refcounted,
  // idempotent server-side — a browser SSE holding the same symbol
  // just bumps the count, releases never yank it from under them).
  // The patch IS the release path — deleted symbols release exactly
  // once (no double-decrement).
  try {
    if (patch.crypto) {
      if (patch.crypto.add.length) ensureSubs({ crypto: patch.crypto.add });
      if (patch.crypto.del.length) releaseSubs({ crypto: patch.crypto.del });
    }
    if (patch.india) {
      if (patch.india.add.length) ensureSubs({ india: patch.india.add });
      if (patch.india.del.length) releaseSubs({ india: patch.india.del });
    }
    if (patch.fut || patch.glob) {
      const futAdd = patch.fut?.add || [], futDel = patch.fut?.del || [];
      const globAdd = patch.glob?.add || [], globDel = patch.glob?.del || [];
      if (futAdd.length || globAdd.length) ensureSubs({ fut: futAdd, glob: globAdd });
      if (futDel.length || globDel.length) releaseSubs({ fut: futDel, glob: globDel });
    }
  } catch { /* one bad release must never kill the LTP sweep */ }

  for (const s of want.crypto) _subHold.crypto.add(s);
  for (const s of want.india) _subHold.india.add(s);
  for (const s of want.fut) _subHold.fut.add(s);
  for (const s of want.glob) _subHold.glob.add(s);
  for (const s of patch.crypto?.del || []) _subHold.crypto.delete(s);
  for (const s of patch.india?.del || []) _subHold.india.delete(s);
  for (const s of patch.fut?.del || []) _subHold.fut.delete(s);
  for (const s of patch.glob?.del || []) _subHold.glob.delete(s);

  // Last open trade gone → drop the service-level stream refcounts
  // (symbol releases already happened via the patch above; idle
  // streams park and cost zero).
  if (!want.crypto.size && !want.india.size && !wantCxAny) {
    try {
      if (_subHold.clients.crypto) clientDown?.('crypto');
      if (_subHold.clients.india) clientDown?.('india');
      if (_subHold.clients.cxrt) clientDown?.('cxrt');
    } catch { /* best-effort */ }
    _subHold = null;
  } else {
    // per-stream clientDown when a domain empties (keep others alive)
    if (_subHold.clients.crypto && _subHold.crypto.size === 0) { _subHold.clients.crypto = false; try { clientDown?.('crypto'); } catch { /* stale journal row — skip */ } }
    if (_subHold.clients.india && _subHold.india.size === 0) { _subHold.clients.india = false; try { clientDown?.('india'); } catch { /* stale journal row — skip */ } }
    if (_subHold.clients.cxrt && _subHold.fut.size === 0 && _subHold.glob.size === 0) { _subHold.clients.cxrt = false; try { clientDown?.('cxrt'); } catch { /* stale journal row — skip */ } }
  }
}

/** v18.6.3 test hook — current held subscription state. */
export function __tradeSubHoldForTests() { return _subHold ? { ..._subHold, crypto: new Set(_subHold.crypto), india: new Set(_subHold.india), fut: new Set(_subHold.fut), glob: new Set(_subHold.glob) } : null; }

// ---------------- store (paper-desk pattern: debounce + backup) ----------------
let _state = loadJSON(FILE, { trades: [], nextId: 1 });
let _saveTimer = null;

function _persist() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    // v18.6.4: strip dunder runtime state (__ltp/__conviction/…) from
    // BOTH the disk file and the encrypted mirror — a restored days-old
    // __ltp served stale prices until the first sweep, and __conviction.at
    // mis-drove the 90s freshness gate after a restart.
    const clean = _serializableForDisk(_state);
    saveJSON(FILE, clean);
    try { durablePut(FILE, clean); } catch { /* backup optional */ }
  }, 1000);
  if (typeof _saveTimer.unref === 'function') _saveTimer.unref();
}

/** v18.6.4: strip `__`-prefixed runtime fields from every trade row
 *  (PURE — the in-memory state keeps its live dunder fields). */
function _serializableForDisk(state) {
  const trades = (state?.trades || []).map((t) => {
    const out = {};
    for (const [k, v] of Object.entries(t || {})) {
      if (k.startsWith('__')) continue;
      out[k] = v;
    }
    return out;
  });
  return { ...state, trades, nextId: state?.nextId };
}

/** v9.1-parity: synchronous flush for graceful shutdown.
 *  v12.7 (recheck R3-#4): also re-arms the encrypted durable push so the
 *  remote copy rides index.js's flushBackupNow() in the same shutdown. */
export function flushManualState() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const clean = _serializableForDisk(_state);
  saveJSON(FILE, clean);
  try { durablePut(FILE, clean); } catch { /* backup optional */ }
}

/** v12.7: boot restore (paper-desk parity) — pull the last remote backup
 *  (encrypted envelope OR legacy plaintext) when the local state came up
 *  empty, so a Render restart no longer wipes the manual tracker. */
let _manualBootRestoring = false;
async function _bootRestore() {
  if (_manualBootRestoring) return;
  _manualBootRestoring = true;
  try {
    const remote = await restoreBackup(FILE);
    const remoteState = remote && remote.alg === 'aes-256-gcm' ? decryptJSON(remote) : remote;
    const remoteTrades = Array.isArray(remoteState?.trades) ? remoteState.trades : [];
    if (remoteTrades.length > ((_state.trades || []).length)
      && Number.isFinite(remoteState?.nextId)) {
      _state = { ...remoteState, trades: remoteTrades };
      saveJSON(FILE, _state);
      console.log(`[manual-trades] boot-restore: recovered ${remoteTrades.length} trades from remote backup`);
    }
  } catch (e) {
    console.warn('[manual-trades] boot-restore failed:', e?.message || e);
  } finally {
    _manualBootRestoring = false;
  }
}
// fire-and-forget at module eval (best-effort; never blocks the route
// mount — the first write merges whatever landed)
if ((_state.trades || []).length === 0 && backupConfigured()) {
  _bootRestore().catch(() => {});
}

export function __resetManualStoreForTests() {
  _state = { trades: [], nextId: 1 };
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
}

// ---------------- pure helpers (tested) ----------------
const _num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const _r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * Entry-price sanity vs live LTP — a typo here silently corrupts every
 * downstream P&L number, so we WARN (never block: a genuine fill can be
 * legitimately away from LTP). PURE.
 * @returns {{warn:boolean, deviationPct:number|null}}
 */
export function validateEntryVsLtp({ entryPrice, ltp, tolerancePct = 15 }) {
  const e = _num(entryPrice);
  const l = _num(ltp);
  if (!(e > 0) || !(l > 0)) return { warn: false, deviationPct: null };
  const dev = Math.abs(e - l) / l * 100;
  return { warn: dev > tolerancePct, deviationPct: Math.round(dev * 10) / 10 };
}

/**
 * Live P&L of one manual trade. PURE. Direction-aware; option trades
 * multiply by lotSize (qty is LOTS there — same convention as the F&O
 * paper cards); crypto markets report USDT alongside INR.
 * @returns {{pnlINR:number, pnlPct:number, pnlUSDT:number|null, currency:'INR'|'USDT'}}
 */
export function manualPnlOf(trade, ltp, { usdInr = 84 } = {}) {
  const entry = _num(trade?.entryPrice);
  const px = _num(ltp);
  const isUsd = trade?.market === 'FUTURES' || trade?.market === 'GLOBALFUTURES';
  const dir = sideOf(trade?.side) === 'SELL' ? -1 : 1;
  if (!(entry > 0) || !(px > 0)) {
    return { pnlINR: 0, pnlPct: 0, pnlUSDT: isUsd ? 0 : null, currency: isUsd ? 'USDT' : 'INR' };
  }
  const lots = _num(trade?.lotSize) || 1; // equity/crypto: lotSize absent → 1
  const qty = _num(trade?.qty) || 0;
  const mult = qty * lots;
  const pnlPct = ((px - entry) / entry) * 100 * dir;
  const pnlNative = (px - entry) * mult * dir; // INR (India) or USDT (perps)
  const fx = isUsd ? (_num(usdInr) || 84) : 1;
  return {
    pnlINR: Math.round(pnlNative * fx * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    pnlUSDT: isUsd ? Math.round(pnlNative * 1000) / 1000 : null,
    currency: isUsd ? 'USDT' : 'INR',
  };
}

/**
 * Distance to SL / T1 / T2 in % of price (direction-aware). PURE.
 * v18.6.4: OPTION trades return {} — their frozen plan levels are
 * UNDERLYING-spot domain, comparing them against the BS premium is
 * apples-vs-oranges (the distance % was meaningless). Conviction
 * tracking + ₹ P&L remain the option domain.
 */
export function manualLevelDistances(trade, ltp) {
  if (trade?.assetKind === 'OPTION') return {};
  const entry = _num(trade?.entryPrice);
  const px = _num(ltp);
  if (!(entry > 0) || !(px > 0)) return {};
  const dir = sideOf(trade?.side) === 'SELL' ? -1 : 1;
  const pctTo = (level) => {
    const lv = _num(level);
    if (!(lv > 0)) return null;
    // signed distance FROM price TO level, in the trade's favor-frame:
    // negative = level is BEHIND the position (adverse), positive = ahead
    return Math.round((((lv - px) / px) * 100) * dir * 10) / 10;
  };
  const o = trade?.origin?.plan || trade?.plan || {};
  return { sl: pctTo(o.stopLoss ?? o.sl), t1: pctTo(o.target1 ?? o.t1), t2: pctTo(o.target2 ?? o.t2) };
}

// ---------------- v12.0 PRO TRADER: R-multiple + MFE/MAE + exit quality ----------------
/** The trade's 1R risk in % of entry (from the frozen origin plan). PURE.
 *  v18.6.4: OPTION → null (premium has no plan-SL R-domain; the old
 *  math returned 16,133% "1R" nonsense against the underlying level). */
export function manualRiskPct(trade) {
  if (trade?.assetKind === 'OPTION') return null;
  const entry = _num(trade?.entryPrice);
  const o = trade?.origin?.plan || trade?.plan || {};
  const sl = _num(o.stopLoss ?? o.sl);
  if (!(entry > 0) || !(sl > 0)) return null;
  const dir = sideOf(trade?.side) === 'SELL' ? -1 : 1;
  // SL must be on the ADVERSE side to mean anything; |dir| keeps it a risk
  const dist = Math.abs(entry - sl) / entry * 100;
  if (!Number.isFinite(dist) || dist <= 0) return null;
  // signed sanity: an SL on the PROFIT side is not a stop — refuse it
  const adverse = (sl - entry) * dir < 0;
  return adverse ? _r2(dist) : null;
}

/**
 * v12.0: update the trade's MAX FAVORABLE / MAX ADVERSE EXCURSION from a
 * fresh LTP (mutates the dunder excursion fields — same pattern as __ltp).
 * PURE-input math; the monitor loop + the tracker route both feed it.
 * @returns the trade (chainable)
 */
export function updateExcursion(trade, ltp) {
  const t = trade;
  const px = _num(ltp);
  if (!t || !(px > 0)) return t;
  const entry = _num(t.entryPrice);
  if (!(entry > 0)) return t;
  const dir = sideOf(t.side) === 'SELL' ? -1 : 1;
  const movePct = ((px - entry) / entry) * 100 * dir; // + = favorable
  if (t.__mfePct == null || movePct > t.__mfePct) t.__mfePct = _r2(movePct);
  if (t.__maePct == null || movePct < t.__maePct) t.__maePct = _r2(movePct);
  const risk = manualRiskPct(t);
  if (risk != null && risk > 0) {
    const rNow = _r2(movePct / risk);
    if (t.__peakR == null || rNow > t.__peakR) t.__peakR = rNow;
    if (t.__troughR == null || rNow < t.__troughR) t.__troughR = rNow;
  }
  t.__excAt = Date.now();
  return t;
}

/**
 * v12.0: the R-multiple view block for one trade. PURE.
 * rNow / rPeak (MFE in R) / rTrough (MAE in R) / capturePct (how much of
 * the peak excursion the current price still holds).
 */
export function manualRStats(trade, ltp) {
  const entry = _num(trade?.entryPrice);
  const px = _num(ltp);
  const risk = manualRiskPct(trade);
  const out = { riskPct: risk, rNow: null, rPeak: null, rTrough: null, mfePct: null, maePct: null, capturePct: null };
  if (risk == null || risk <= 0) return out;
  if (entry > 0 && px > 0) {
    const dir = sideOf(trade?.side) === 'SELL' ? -1 : 1;
    out.rNow = _r2((((px - entry) / entry) * 100 * dir) / risk);
  } else if (trade?.status === 'CLOSED' && _num(trade?.exitPrice) > 0) {
    const dir = sideOf(trade?.side) === 'SELL' ? -1 : 1;
    out.rNow = _r2((((_num(trade.exitPrice) - entry) / entry) * 100 * dir) / risk);
  }
  out.rPeak = trade?.__peakR ?? null;
  out.rTrough = trade?.__troughR ?? null;
  out.mfePct = trade?.__mfePct ?? null;
  out.maePct = trade?.__maePct ?? null;
  if (out.rPeak != null && out.rPeak > 0 && out.rNow != null) {
    out.capturePct = _r2(Math.max(0, Math.min(100, (out.rNow / out.rPeak) * 100)));
  }
  return out;
}

/**
 * v12.0: exit-quality verdict — did the trader actually CAPTURE the move?
 * PURE. The four honest grades:
 *   CLEAN_WIN    — winner that kept ≥60% of its peak excursion
 *   GAVE_BACK    — was ≥1R in profit, closed with <30% of the peak
 *   CUT_WINNER   — closed green but at <40% of a ≥1.5R peak (early cut)
 *   DISCIPLINED_LOSS / OVERSHOOT_LOSS — did the stop do its job (≤1R) or
 *   did the exit slip past the planned risk (>1R)?
 */
export function exitQualityOf({ rFinal, rPeak }) {
  const r = _num(rFinal);
  const pk = _num(rPeak);
  if (r == null) return 'UNKNOWN';
  if (r > 0) {
    // severity order: GAVE_BACK (kept <30% of a ≥1R peak) is worse than
    // CUT_WINNER (<40% of a ≥1.5R peak) — the harsher label wins.
    if (pk != null && pk >= 1 && r < 0.3 * pk) return 'GAVE_BACK';
    if (pk != null && pk >= 1.5 && r < 0.4 * pk) return 'CUT_WINNER';
    return 'CLEAN_WIN';
  }
  return r >= -1.05 ? 'DISCIPLINED_LOSS' : 'OVERSHOOT_LOSS';
}

/**
 * v12.0: aggregate performance stats over CLOSED manual trades — the
 * tracker's own track-record (win rate in R terms, avg R, capture
 * efficiency, hold times). PURE over the trade list.
 */
export function manualStats(trades) {
  const closed = (Array.isArray(trades) ? trades : (_state.trades || [])).filter(t => t?.status === 'CLOSED');
  const rows = closed.map(t => {
    const rs = manualRStats(t, null); // exitPrice branch inside
    return { t, r: rs.rNow, peak: rs.rPeak, holdMin: t.closedAt && t.openedAt ? Math.round((t.closedAt - t.openedAt) / 60000) : null };
  });
  const withR = rows.filter(x => x.r != null);
  const wins = withR.filter(x => x.r > 0);
  const holds = rows.map(x => x.holdMin).filter(v => v != null);
  const caps = rows.filter(x => x.peak != null && x.peak > 0 && x.r != null && x.r > 0)
    .map(x => Math.max(0, Math.min(100, (x.r / x.peak) * 100)));
  const quals = rows.map(x => exitQualityOf({ rFinal: x.r, rPeak: x.peak }));
  return {
    closed: closed.length,
    closedWithR: withR.length,
    wins: wins.length,
    losses: withR.length - wins.length,
    winRate: withR.length > 0 ? _r2((wins.length / withR.length) * 100) : null,
    avgR: withR.length > 0 ? _r2(withR.reduce((a, x) => a + x.r, 0) / withR.length) : null,
    bestR: withR.length > 0 ? _r2(Math.max(...withR.map(x => x.r))) : null,
    worstR: withR.length > 0 ? _r2(Math.min(...withR.map(x => x.r))) : null,
    avgHoldMin: holds.length > 0 ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null,
    // capture efficiency: winners kept this % of their peak excursion on avg
    avgCapturePct: caps.length > 0 ? _r2(caps.reduce((a, b) => a + b, 0) / caps.length) : null,
    gaveBack: quals.filter(q => q === 'GAVE_BACK' || q === 'CUT_WINNER').length,
    disciplinedLosses: quals.filter(q => q === 'DISCIPLINED_LOSS').length,
    overshootLosses: quals.filter(q => q === 'OVERSHOOT_LOSS').length,
    note: withR.length === 0
      ? 'R-multiple stats origin-plan ke stop-loss par depend karte hain — bina SL ke trades count nahi hote (honest).'
      : `Win-rate R>0 terms me · capture = winners ne apne peak excursion ka kitna % rakha. n=${withR.length}.`,
  };
}

/**
 * The STATE BANNER for one manual trade (escalating urgency). PURE.
 * Priority: EXIT NOW (conviction flip — thesis invalidated) >
 * TARGET HIT > WEAKENING > THESIS INTACT. UNKNOWN conviction (data
 * missing) is honest: banner falls back to price-only judgment.
 * @param {object} a { convictionState, ltp, trade }
 * @returns {'THESIS_INTACT'|'WEAKENING'|'EXIT_NOW'|'TARGET_HIT'|'STALE'}
 */
export function stateOfManualTrade({ convictionState, ltp, trade, reversal }) {
  const px = _num(ltp);
  const o = trade?.origin?.plan || trade?.plan || {};
  const dir = sideOf(trade?.side) === 'SELL' ? -1 : 1;
  // v18.6.4: OPTION trades SKIP the level-reached check — plan targets
  // are underlying-spot domain, premium LTP against them instant
  // false TARGET_HIT (a ₹150 premium vs a ₹24,650 target). Conviction
  // + ₹ states remain the option truth.
  if (px > 0 && trade?.assetKind !== 'OPTION') {
    const t1 = _num(o.target1 ?? o.t1);
    const t2 = _num(o.target2 ?? o.t2);
    const reached = (lv) => lv > 0 && ((px - lv) * dir >= 0);
    if (reached(t1) || reached(t2)) return 'TARGET_HIT';
  }
  // v12.9 REVERSAL AI (engine-connected): the ₹ states of the ACTIVE
  // cycle win over the conviction states — a reversal plan in flight is
  // the loudest thing that can be said about this trade.
  if (reversal?.enabled) {
    if (reversal.state === 'PROFIT_TARGET') return 'REVERSAL_BOOK';
    if (reversal.pnlINR != null && reversal.pnlINR <= -Math.abs(_num(reversal.lossCapINR) || 150)) return 'LOSS_CAP';
  }
  if (convictionState === 'FLIPPED') return 'EXIT_NOW';
  if (convictionState === 'WEAKENING') return 'WEAKENING';
  if (convictionState === 'UNKNOWN' || convictionState == null) return 'STALE';
  return 'THESIS_INTACT';
}

// ---------------- v12.9 REVERSAL ENGINE CONNECTION (manual cycles) ----------------
// User spec: "isko Superintelligence Reversal AI Engine se connect karo —
// jo bhi trade long/short reversal me jata hai to ye ACTIVATE hona
// chahiye." The engine watches every OPEN manual trade against the SAME
// ₹ thresholds the futures-desk cycles use, stamps a MANUAL cycle with
// the exact actionable plan (flip qty/SL/TP derived from the ₹ numbers),
// and Telegram-pushes on every threshold crossing. The site never
// auto-closes a manual trade (v12.7 rule) — the plan is the activation.

/**
 * Activate/advance the ₹ reversal cycle on ONE open manual trade.
 * Price-based (rides the 5s LTP sweep — capital protection is a stop,
 * it must not wait for the 30s conviction pass). Stamps t.reversal on
 * every THRESHOLD CROSSING (the flip plan carries exact levels); the
 * in-band state is 'ACTIVE' (cycle tracked, thresholds armed).
 * @returns {{from:string|null, to:string, trade:object, cycleId:string, leg:number, pnlINR:number, price:number, flip:object|null}|null} the transition, or null when nothing changed.
 */
export function activateReversalOnManualTrade(t, price, { usdInr = 84, cfg } = {}) {
  if (!cfg?.enabled || t?.status !== 'OPEN') return null;
  if (t.assetKind === 'OPTION') return null; // premium/IV domain — conviction tracking only
  const px = _num(price);
  if (!(px > 0)) return null;
  const pnl = manualPnlOf(t, px, { usdInr });
  const pnlINR = _num(pnl.pnlINR);
  if (pnlINR == null) return null;
  let to = null;
  if (pnlINR <= -Math.abs(cfg.lossCapINR)) to = 'LOSS_CAP';
  else if (pnlINR >= Math.abs(cfg.profitTargetINR)) to = 'PROFIT_TARGET';
  const from = t.reversal?.state || null;
  const cycleId = t.reversal?.cycleId || `mrv-${t.symbol}-${t.id}`;
  const leg = t.reversal?.leg || 1;
  if (to == null) {
    // in-band: a live cycle degrades to ACTIVE (plan preserved, no push);
    // no cycle yet → nothing to stamp (thresholds only arm on a crossing)
    if (t.reversal && from !== 'ACTIVE') {
      t.reversal = { ...t.reversal, state: 'ACTIVE', pnlINR: Math.round(pnlINR * 100) / 100 };
      return { from, to: 'ACTIVE', trade: t, cycleId, leg, pnlINR, price: px, flip: t.reversal.flip || null };
    }
    return null;
  }
  if (from === to) return null; // already in this state — quiet
  const opposite = t.side === 'BUY' ? 'SHORT' : 'LONG';
  // the exact flip plan — ₹ thresholds → price levels at the LIVE price
  // (the same math the futures-desk engine stamps on its legs)
  // v20.7.3 FIX: priceLevelsForLeg divides ₹ thresholds by USDINR — correct
  // for USDT-margined perps, but India equities / crypto-spot prices are in
  // INR, so the same division made the printed flip SL/TP ~84× too tight.
  // INR-domain trades must pass fx = 1 (mirrors manualPnlOf's `fx` logic).
  const _flipIsUsd = t.market === 'FUTURES' || t.market === 'GLOBALFUTURES';
  const { sl, tp } = priceLevelsForLeg({
    side: opposite, entry: px, qty: t.qty,
    lossCapINR: cfg.lossCapINR, profitTargetINR: cfg.profitTargetINR,
    usdInr: _flipIsUsd ? usdInr : 1,
  });
  t.reversal = {
    ...(t.reversal || {}),
    cycleId, leg, engine: 'v12.9',
    state: to,
    activatedAt: Date.now(),
    lossCapINR: cfg.lossCapINR, profitTargetINR: cfg.profitTargetINR,
    pnlINR: Math.round(pnlINR * 100) / 100,
    ...(to === 'LOSS_CAP' ? {
      flip: { side: opposite, qty: t.qty, entry: px, sl, tp },
    } : {}),
  };
  return { from, to, trade: t, cycleId, leg, pnlINR, price: px, flip: t.reversal.flip || null };
}

/** The activation telegram text — the full actionable plan in the
 *  trade's NATIVE currency (USDT perps show $ P&L, never a ₹-converted
 *  price amount; the ₹ numbers stay on the user's own thresholds). */
export function reversalActivationText(tr, { usdInr = 84 } = {}) {
  const t = tr.trade;
  const isUsd = t.market === 'FUTURES' || t.market === 'GLOBALFUTURES';
  const pnlNative = isUsd
    ? `$${Math.round(Math.abs(tr.pnlINR / (usdInr || 84)) * 100) / 100}`
    : `₹${Math.round(Math.abs(tr.pnlINR))}`;
  const side = t.side === 'BUY' ? 'LONG' : 'SHORT';
  if (tr.to === 'PROFIT_TARGET') {
    return [
      `✅ <b>REVERSAL AI — ₹ TARGET hit (MANUAL cycle ACTIVE)</b>`,
      `<b>${t.symbol}</b> ${side} @ ${_fmtPx(t.entryPrice, t.market)} → live <b>${_fmtPx(tr.price, t.market)}</b> · P&L <b>+${pnlNative}</b> (target ₹${tr.trade.reversal.profitTargetINR})`,
      `BOOK karo — profit realized karo.`,
      `Re-entry window: price wapas ulat jaye to ensemble confirm hone par opp <b>${side === 'LONG' ? 'SHORT' : 'LONG'}</b> entry ka plan milega.`,
      `<i>Cycle ${tr.cycleId} · leg ${tr.leg}. (Manual trade — execute aap karo.)</i>`,
    ].join('\n');
  }
  const f = tr.flip || {};
  const fSide = f.side || (side === 'LONG' ? 'SHORT' : 'LONG');
  return [
    `🛑 <b>REVERSAL AI — LOSS-CAP hit (MANUAL cycle ACTIVATED)</b>`,
    `<b>${t.symbol}</b> ${side} @ ${_fmtPx(t.entryPrice, t.market)} → live <b>${_fmtPx(tr.price, t.market)}</b> · P&L <b>−${pnlNative}</b> (cap ₹${tr.trade.reversal.lossCapINR})`,
    `Reversal plan (₹-cycle):`,
    `• 1) Ye position CLOSE karo — minimal loss accept`,
    `• 2) FLIP <b>${fSide}</b> qty ${f.qty ?? t.qty} @ ~${_fmtPx(tr.price, t.market)}${f.sl != null ? ` · SL ${_fmtPx(f.sl, t.market)} (₹${tr.trade.reversal.lossCapINR}) / TP ${_fmtPx(f.tp, t.market)} (₹${tr.trade.reversal.profitTargetINR})` : ''}`,
    `• 3) +₹${tr.trade.reversal.profitTargetINR} target pe profit BOOK karo`,
    `<i>Cycle ${tr.cycleId} · leg ${tr.leg}. (Manual trade — execute aap karo.)</i>`,
  ].join('\n');
}

/** All MANUAL reversal cycles (the /api/ai/reversal board's manual
 *  section): trades grouped by t.reversal.cycleId, legs in openedAt
 *  order, live ₹ P&L off the monitor's own 5s-fresh __ltp. PURE. */
export function manualReversalCycles(trades, { usdInr = 84, now = Date.now() } = {}) {
  const byCycle = new Map();
  for (const t of (trades || [])) {
    const rv = t?.reversal;
    if (!rv?.cycleId) continue;
    if (!byCycle.has(rv.cycleId)) byCycle.set(rv.cycleId, []);
    byCycle.get(rv.cycleId).push(t);
  }
  let windowMs = 45 * 60_000, maxLegs = 3;
  try {
    const rcfg = loadReversalConfig();
    windowMs = rcfg.reentryWindowMs; maxLegs = rcfg.maxLegs;
  } catch { /* defaults */ }
  const cycles = [];
  for (const [cycleId, list] of byCycle) {
    list.sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
    const openT = list.find(x => x.status === 'OPEN') || null;
    const closed = list.filter(x => x.status === 'CLOSED');
    const netINR = Math.round(closed.reduce((s, x) => s + (_num(x.exitPnlINR) || 0), 0) * 100) / 100;
    const lastClosedAt = closed.length ? Math.max(...closed.map(x => x.closedAt || 0)) : null;
    let state = 'ENDED';
    if (openT) state = 'ACTIVE';
    else if (lastClosedAt != null && now - lastClosedAt < windowMs && list.length < maxLegs) state = 'WAITING';
    const legs = list.map(x => ({
      leg: x.reversal?.leg ?? null,
      side: x.side === 'BUY' ? 'LONG' : 'SHORT',
      qty: x.qty, entryPrice: x.entryPrice,
      status: x.status,
      closePrice: x.exitPrice ?? null,
      pnlINR: x.status === 'CLOSED' ? (_num(x.exitPnlINR) ?? null) : null,
      closeReason: x.closeReason ?? null,
      openedAt: x.openedAt, closedAt: x.closedAt ?? null,
    }));
    let live = null;
    if (openT) {
      const px = _num(openT.__ltp);
      if (px > 0) {
        live = {
          leg: openT.reversal?.leg ?? null,
          side: openT.side === 'BUY' ? 'LONG' : 'SHORT',
          price: px,
          pnlINR: manualPnlOf(openT, px, { usdInr }).pnlINR,
          state: openT.reversal?.state || 'ACTIVE',
        };
      }
    }
    cycles.push({
      cycleId, pair: list[0].symbol, mode: 'manual', legs, legCount: list.length,
      openLeg: openT ? { leg: openT.reversal?.leg ?? null, side: openT.side === 'BUY' ? 'LONG' : 'SHORT', qty: openT.qty, entryPrice: openT.entryPrice } : null,
      netINR, state, lastClosedAt, live,
      plan: openT?.reversal?.flip || [...list].reverse().find(x => x.reversal?.flip)?.reversal?.flip || null,
    });
  }
  const rank = (c) => c.state === 'ACTIVE' ? 0 : c.state === 'WAITING' ? 1 : 2;
  cycles.sort((a, b) => rank(a) - rank(b) || (b.lastClosedAt || 0) - (a.lastClosedAt || 0));
  return cycles;
}

/**
 * Conviction of a manual trade from a FRESH deep signal — the same
 * classifier the auto-agents use, pointed at the trade's side + entry
 * snapshot score. PURE.
 */
export function manualConvictionOf(trade, freshSignal, threshold) {
  return classifyConviction({
    posSide: sideOf(trade?.side),
    curSide: freshSignal?.side ? sideOf(freshSignal.side) : null,
    curScore: _num(freshSignal?.superIntel?.aiScore ?? freshSignal?.confidence),
    entryScore: _num(trade?.origin?.aiScore ?? trade?.origin?.score),
    quorumMet: quorumOfSignal(freshSignal),
    threshold,
  });
}

/**
 * The "WHY" for a conviction push — which named models switched sides
 * vs the frozen entry votes, and the score move. PURE (judgment aid,
 * not a command: "so you can judge rather than obey").
 * @returns {{flipped:string[], abstainedNew:string[], entryScore:number|null, curScore:number|null}}
 */
export function flipSummary(trade, freshSignal) {
  const posSide = sideOf(trade?.side);
  const entryVotes = Array.isArray(trade?.origin?.votes) ? trade.origin.votes : [];
  const curVotes = Array.isArray(freshSignal?.votes) ? freshSignal.votes : [];
  const curById = new Map(curVotes.map(v => [v.id, v]));
  const flipped = [];
  const abstainedNew = [];
  for (const ev of entryVotes) {
    const dirNum = Number(ev.dir) || 0;
    if (dirNum === 0) continue; // was already abstaining at entry
    const votedSide = dirNum > 0 ? 'BUY' : 'SELL';
    if (votedSide !== posSide) continue; // it OPPOSED the entry — not "our" model
    const cv = curById.get(ev.id);
    if (!cv) continue;
    const curDir = Number(cv.dir) || 0;
    if (curDir !== 0 && (curDir > 0 ? 'BUY' : 'SELL') !== posSide) flipped.push(cv.name || ev.name || ev.id);
    else if (curDir === 0) abstainedNew.push(cv.name || ev.name || ev.id);
  }
  return {
    flipped,
    abstainedNew,
    entryScore: _num(trade?.origin?.aiScore),
    curScore: _num(freshSignal?.superIntel?.aiScore ?? freshSignal?.confidence),
  };
}

/** Level-touch-compatible rows (the telegramPush detectLevelTouches
 *  shape) so SL/T1/T2 touches reuse the SAME 5s pipeline. PURE.
 *
 *  Contract notes (v10.16 wiring): detectLevelTouches requires
 *  `status === 'OPEN'` and LONG/SHORT sides — sideOf's BUY/SELL is
 *  translated here, or a BUY trade would be level-checked INVERTED.
 *  P&L: INR-domain markets (India equity + CoinDCX INR spot) carry
 *  native ₹ uP&L; USDT/USDC-domain rows stay null — the push omits
 *  the number rather than showing a fixed-fx guess (the monitor's own
 *  pushes carry the exact $ P&L). */
export function manualTradesToPositionRows(trades) {
  const out = [];
  for (const t of (trades || [])) {
    if (t?.status === 'CLOSED') continue;
    // v18.6.4: OPTION trades level-logic (telegramPush
    // detectLevelTouches) me NAHI jaate — unka plan levels underlying
    // domain ke hain, premium LTP se compare karke false SL/TP pushes
    // jaate the. Options conviction-only track hote hain.
    if (t?.assetKind === 'OPTION') continue;
    const o = t?.origin?.plan || t?.plan || {};
    const entry = _num(t.entryPrice);
    if (!(entry > 0)) continue;
    const ltp = _num(t.__ltp);
    const mkt = String(t.market || 'INDIA').toUpperCase();
    const inrDomain = mkt === 'INDIA' || mkt === 'CRYPTO';
    out.push({
      id: `MAN-${t.id}`,
      pair: String(t.symbol || '?'),
      symbol: String(t.symbol || '?'),
      side: sideOf(t.side) === 'SELL' ? 'SHORT' : 'LONG',
      status: 'OPEN',
      market: mkt,
      entryPrice: entry,
      sl: _num(o.stopLoss ?? o.sl) ?? null,
      tp: _num(o.target1 ?? o.t1) ?? null,
      tp2: _num(o.target2 ?? o.t2) ?? null,
      tp1Hit: false,
      tp2Hit: false,
      ltp,
      qty: _num(t.qty) || 0,
      liquidation: null,
      leverage: 1,
      unrealizedPnlINR: ltp != null && inrDomain ? manualPnlOf(t, ltp).pnlINR : null,
      manual: true,
    });
  }
  return out;
}

// ---------------- CRUD ----------------
/**
 * Record a manual trade. The ORIGINATING SIGNAL SNAPSHOT is frozen
 * verbatim (plan, votes, regime, aiScore) — the baseline every later
 * "trend change" is measured against.
 * @param {object} input { market, symbol, side, entryPrice, qty, lots?,
 *   lotSize?, strike?, expiry?, optType?, iv?, entryTime?, ltp?, signal? }
 */
export function recordManualTrade(input = {}) {
  const market = ['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES'].includes(String(input.market || '').toUpperCase())
    ? String(input.market).toUpperCase() : 'INDIA';
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const side = sideOf(input.side);
  const entryPrice = _num(input.entryPrice);
  const qty = _num(input.qty);
  const assetKind = input.strike != null || input.optType ? 'OPTION' : null;
  // v18.6.4: widened (BRK.B-style dots, FUT perp names, 20 chars)
  if (!/^[A-Z0-9&._-]{2,20}$/.test(symbol)) return { ok: false, error: 'symbol invalid' };
  if (!side) return { ok: false, error: 'side must be BUY/LONG or SELL/SHORT' };
  if (!(entryPrice > 0)) return { ok: false, error: 'entryPrice must be > 0' };
  if (!(qty > 0)) return { ok: false, error: 'qty must be > 0' };
  if (assetKind === 'OPTION') {
    const strike = _num(input.strike);
    const optType = String(input.optType || '').toUpperCase();
    if (!(strike > 0) || !['CE', 'PE'].includes(optType)) {
      return { ok: false, error: 'F&O trades need strike + optType (CE/PE)' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.expiry || ''))) {
      return { ok: false, error: 'F&O trades need expiry (YYYY-MM-DD)' };
    }
  }
  const ltp = _num(input.ltp);
  const check = validateEntryVsLtp({ entryPrice, ltp: ltp ?? null });
  if (check.warn) {
    // honest warn — recorded anyway (a real fill can be legitimately off)
    console.warn(`[manual-trades] entry ${entryPrice} is ${check.deviationPct}% away from live ${ltp} (${symbol}) — recorded with warning`);
  }
  // v12.9 REVERSAL auto-link: a NEW trade on a symbol with a recently-
  // closed reversal cycle (inside the re-entry window, legs remaining)
  // becomes the NEXT LEG of that cycle — following the engine's plan
  // paints the full cycle on the Reversal board automatically.
  let revLink = null;
  try {
    const rcfg = loadReversalConfig();
    if (rcfg.enabled) {
      const prior = [..._state.trades]
        .filter(x => x.symbol === symbol && x.status === 'CLOSED' && x.reversal?.cycleId)
        .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))[0];
      if (prior && Date.now() - (prior.closedAt || 0) < rcfg.reentryWindowMs
        && (prior.reversal.leg || 1) < rcfg.maxLegs) {
        revLink = {
          cycleId: prior.reversal.cycleId,
          leg: (prior.reversal.leg || 1) + 1,
          rootId: prior.reversal.rootId ?? prior.id,
          engine: 'v12.9', linkedAt: Date.now(),
        };
      }
    }
  } catch { /* link is best-effort — never blocks a record */ }
  const sig = input.signal || {};
  const plan = sig.plan || input.plan || null;
  // v13.1 SVA stamp — the pro-trader verdict FROZEN at open time. The
  // trade ticket forever answers "kya verifier ne mana kiya tha?".
  // input.verify (the wire payload the UI passes) wins when present;
  // otherwise the full signal re-verifies here (deep payloads already
  // carry s.verify — the recompute is the belt+suspenders path for
  // board-shaped partial signals).
  let verifyStamp = null;
  try {
    verifyStamp = sig.verify?.agent === 'SVA-v1'
      ? verificationWire(sig.verify)
      : (input.verify?.agent === 'SVA-v1' ? verificationWire(input.verify) : null);
    if (!verifyStamp && sig.side) verifyStamp = verificationWire(verifySignal(sig));
  } catch { /* stamp is context, never a blocker */ }
  const t = {
    id: _state.nextId++,
    createdAt: Date.now(),
    openedAt: _num(input.entryTime) > 0 ? Number(input.entryTime) : Date.now(),
    entryTime: _num(input.entryTime) > 0 ? Number(input.entryTime) : Date.now(),
    market, symbol, side,
    assetKind,
    entryPrice,
    qty: assetKind === 'OPTION' ? Math.max(1, Math.floor(qty)) : Math.round(qty * 1e4) / 1e4,
    ...(assetKind === 'OPTION' ? {
      strike: _num(input.strike),
      expiry: String(input.expiry),
      optType: String(input.optType).toUpperCase(),
      iv: _num(input.iv) ?? 13,
      lotSize: _num(input.lotSize) || 75,
      underlying: String(input.underlying || symbol),
    } : {}),
    status: 'OPEN',
    lastState: null,
    // v12.9: the reversal-cycle link (leg > 1 when following the plan)
    ...(revLink ? { reversal: revLink } : {}),
    // ---- THE SNAPSHOT (Section 2B: the baseline) ----
    origin: {
      aiScore: _num(sig.superIntel?.aiScore) ?? _num(sig.confidence) ?? null,
      confidence: _num(sig.confidence) ?? null,
      agreement: _num(sig.agreement) ?? null,
      voters: _num(sig.voters ?? sig.participating) ?? null,
      grade: sig.grade || null,
      regime: sig.regime || sig.quality?.regime?.label || null,
      side: sig.side || side,
      symbol, market,
      generatedAt: sig.generatedAt || Date.now(),
      plan: plan ? {
        entry: _num(plan.entry),
        stopLoss: _num(plan.stopLoss ?? plan.sl),
        target1: _num(plan.target1 ?? plan.t1),
        target2: _num(plan.target2 ?? plan.t2),
        riskPct: _num(plan.riskPct),
        atr: _num(plan.atrUsed ?? plan.atr),
      } : null,
      votes: (Array.isArray(sig.votes) ? sig.votes : []).map(v => ({
        id: v.id, name: v.name, dir: Number(v.dir) || 0, conf: _num(v.conf),
      })),
      summary: sig.summary || null,
    },
    ...(input.note ? { note: String(input.note).slice(0, 200) } : {}),
    ...(verifyStamp ? { verify: verifyStamp } : {}),
    ...(check.warn ? { entryWarn: `entry ${check.deviationPct}% off live ${ltp}` } : {}),
  };
  _state.trades.push(t);
  if (_state.trades.length > MAX_TRADES) _state.trades.splice(0, _state.trades.length - MAX_TRADES);
  _persist();
  return { ok: true, trade: t, warn: check.warn ? `Entry price is ${check.deviationPct}% away from live LTP ${ltp} — typo check karo (recorded anyway).` : null };
}

/** Raw list (open first, newest first). */
export function listManualTrades({ status } = {}) {
  const trades = [...(_state.trades || [])];
  trades.sort((a, b) => (a.status === b.status ? (b.createdAt || 0) - (a.createdAt || 0) : a.status === 'OPEN' ? -1 : 1));
  return status ? trades.filter(t => t.status === status) : trades;
}

export function getManualTrade(id) {
  const n = Number(id);
  return _state.trades.find(t => t.id === n) || null;
}

/** Close a manual trade at the given price (or live when omitted).
 *  v18.6.4 staleness + FX honesty: a live close now needs a FRESH
 *  __ltp (≤60s, stamped by the monitor/route sweep) — a days-old
 *  restored __ltp used to price exits at stale levels. The ₹/$ P&L
 *  uses the CALLER'S live usdInr (route threads it) instead of the
 *  hardcoded 84. */
export function closeManualTrade(id, { exitPrice, reason, usdInr } = {}) {
  const t = getManualTrade(id);
  if (!t) return { ok: false, error: 'trade not found' };
  if (t.status === 'CLOSED') return { ok: false, error: 'already closed' };
  let px = _num(exitPrice);
  if (!(px > 0)) {
    const ltp = _num(t.__ltp);
    const ltpAt = Number(t.__ltpAt) || 0;
    if (ltp > 0 && Date.now() - ltpAt <= 60_000) px = ltp;
    else if (ltp > 0) {
      return { ok: false, error: `live LTP ${Math.round((Date.now() - ltpAt) / 1000)}s purana hai — price type karo (stale close se P&L galat ho jata)` };
    }
  }
  if (!(px > 0)) return { ok: false, error: 'exit price unavailable — live LTP pass karo ya price type karo' };
  const pnl = manualPnlOf(t, px, { usdInr: _num(usdInr) ?? undefined });
  // v12.0: freeze the final excursion + R + exit-quality verdict — the
  // tracker's own report card ("peak 2.1R tha, 0.6R pe cut kiya").
  updateExcursion(t, px);
  const rFinal = manualRStats(t, px);
  t.exitR = rFinal.rNow;
  t.exitPeakR = rFinal.rPeak;
  t.exitQuality = exitQualityOf({ rFinal: rFinal.rNow, rPeak: rFinal.rPeak });
  t.status = 'CLOSED';
  t.closedAt = Date.now();
  t.exitPrice = px;
  t.closeReason = String(reason || 'manual').slice(0, 60);
  t.exitPnlINR = pnl.pnlINR;
  t.exitPnlPct = pnl.pnlPct;
  // v12.9 REVERSAL cycle advance — closing a reversal-active trade is
  // the leg's CUT/BOOK; the closeReason carries the cycle context and
  // the record keeps the plan for the board's WAITING state.
  if (t.reversal?.cycleId) {
    const rv = t.reversal;
    const st = rv.state || 'ACTIVE';
    t.reversal = {
      ...rv, closedAt: Date.now(), closedState: st,
      followUp: st === 'LOSS_CAP' ? 'FLIP' : st === 'PROFIT_TARGET' ? 'REVERSAL_WATCH' : null,
    };
    if (!reason || !String(reason).toUpperCase().startsWith('REVERSAL')) {
      const tag = st === 'LOSS_CAP' ? `REVERSAL leg-${rv.leg || 1} CUT (loss-cap ₹${rv.lossCapINR ?? ''})`
        : st === 'PROFIT_TARGET' ? `REVERSAL leg-${rv.leg || 1} BOOKED (₹ target)`
        : `REVERSAL leg-${rv.leg || 1} closed`;
      t.closeReason = `${tag} · ${String(reason || 'manual').slice(0, 30)}`.slice(0, 60);
    }
  }
  _persist();
  return { ok: true, trade: t, pnl, r: rFinal };
}

// ---------------- live view (LTP resolution) ----------------
function _tickKeyFor(market, symbol) {
  if (market === 'FUTURES') return `FUT_${symbol}`;
  if (market === 'GLOBALFUTURES') return `GLOB_${symbol}`;
  return `IN_${symbol}`;
}

/**
 * Resolve the live LTP for one open manual trade. Injected fetchers keep
 * this PURE-testable: crypto/global read the in-memory tick store (free);
 * India equities use the cached TV batch; OPTION trades re-price the
 * premium via Black-Scholes on the live underlying spot (entry IV held
 * fixed — the same basis as the F&O paper cards).
 */
export async function ltpForManualTrade(t, { fetchIndiaQuotes, fetchIndexSpot } = {}) {
  if (!t || t.status === 'CLOSED') return null;
  if (t.assetKind === 'OPTION') {
    try {
      if (typeof fetchIndexSpot === 'function') {
        const spot = _num((await fetchIndexSpot(t.underlying || t.symbol))?.price);
        if (spot > 0) {
          const T = Math.max(0, yearsToExpiry(`${t.expiry}T15:30:00+05:30`));
          const sigma = Math.min(0.60, Math.max(0.06, (_num(t.iv) || 13) / 100));
          const intrinsic = t.optType === 'CE'
            ? Math.max(0, spot - t.strike)
            : Math.max(0, t.strike - spot);
          const prem = T > 0
            ? Math.max(0.05, bsPrice(spot, t.strike, T, RISK_FREE, sigma, t.optType))
            : intrinsic;
          return Math.round(prem * 100) / 100;
        }
      }
    } catch { /* fall through */ }
    return null;
  }
  // crypto / global / india: live tick store first (free, 5s fresh)
  const tick = getTick(_tickKeyFor(t.market, t.symbol));
  const px = _num(tick?.price);
  if (px > 0) return px;
  // India fallback: the cached TV batch (Yahoo) — only when injected
  if (t.market === 'INDIA' && typeof fetchIndiaQuotes === 'function') {
    try {
      const q = await fetchIndiaQuotes([t.symbol]);
      const px2 = _num(q?.[t.symbol]?.price);
      if (px2 > 0) return px2;
    } catch { /* honest null */ }
  }
  return null;
}

/**
 * Build the LIVE monitor view for the UI: per trade — LTP, P&L (₹/USDT
 * + %), level distances, conviction state + delta, the state banner.
 * Conviction comes from the caller (the monitor loop or an on-demand
 * deep re-vote) so this stays cheap per request.
 */
export function manualTradeView(t, { ltp, usdInr, conviction } = {}) {
  // v18.6.4: stamp the LTP's OWN clock — the close-at-live path (and
  // the stale chip) judges freshness from __ltpAt, not blind trust.
  if (_num(ltp) > 0 && t && t.status !== 'CLOSED') { t.__ltp = _num(ltp); t.__ltpAt = Date.now(); }
  const pnl = manualPnlOf(t, ltp, { usdInr });
  const dist = manualLevelDistances(t, ltp);
  // v12.9: the ₹ reversal states ride the engine connection — LIVE
  // pnlINR vs thresholds (LOSS_CAP / REVERSAL_BOOK banners) + the
  // stamped cycle context (cycleId/leg/flip plan) for the plan line.
  let reversal = null;
  try {
    const rcfg = loadReversalConfig();
    if (rcfg.enabled && pnl.pnlINR != null) {
      const liveState = pnl.pnlINR <= -Math.abs(rcfg.lossCapINR) ? 'LOSS_CAP'
        : pnl.pnlINR >= Math.abs(rcfg.profitTargetINR) ? 'PROFIT_TARGET'
        : (t.reversal?.state === 'PROFIT_TARGET' ? 'PROFIT_TARGET' : (t.reversal?.state || null));
      reversal = {
        enabled: true, lossCapINR: rcfg.lossCapINR, profitTargetINR: rcfg.profitTargetINR,
        pnlINR: pnl.pnlINR, state: liveState,
        ...(t.reversal?.cycleId ? { cycleId: t.reversal.cycleId, leg: t.reversal.leg ?? null } : {}),
        ...(t.reversal?.flip ? { flip: t.reversal.flip } : {}),
      };
    }
  } catch { /* banner only when the config is readable */ }
  const banner = stateOfManualTrade({ convictionState: conviction?.state, ltp, trade: t, reversal });
  const ageMin = t.openedAt ? Math.round((Date.now() - t.openedAt) / 60000) : null;
  // v12.0: the R-multiple view (rNow / peak MFE / trough MAE / capture)
  const r = manualRStats(t, ltp);
  return {
    ...t,
    __ltp: ltp,
    __view: {
      ltp, ageMin,
      pnl,
      distances: dist,
      r,
      ...(t.status === 'CLOSED' ? { exitQuality: exitQualityOf({ rFinal: r.rNow, rPeak: r.rPeak }) } : {}),
      conviction: conviction ? {
        state: conviction.state, delta: conviction.delta ?? null,
        currentScore: conviction.currentScore ?? null,
        entryScore: conviction.entryScore ?? _num(t.origin?.aiScore),
        // v11.5: the vote's own stamp — the UI can show how old the read
        // is (the last-known fallback serves convictions older than 90s).
        at: conviction.at ?? null,
      } : { state: null, delta: null, currentScore: null, entryScore: _num(t.origin?.aiScore) },
      banner,
    },
  };
}

// ============================================================
// THE MONITOR — 5s live tracking + ~30s conviction re-vote + telegram
// ------------------------------------------------------------
// Only runs while (a) open manual trades exist AND (b) telegram is
// configured; otherwise it parks at a 60s idle poll (free). The
// conviction re-vote rides getDeepSignal()'s 30s cache — zero new
// upstream calls (the auto-agents' cost contract, kept).
// ============================================================
const MONITOR_ACTIVE_MS = 5_000;
const MONITOR_IDLE_MS = 60_000;
const CONVICTION_EVERY_MS = 30_000;
const SL_ALERT_COOLDOWN_MS = 5 * 60_000;   // re-nudge at most every 5m while inside the zone
const STAGNANT_EVERY_MS = 45 * 60_000;     // time-based check-in on quiet trades

let _mon = null;      // { timer, deps, send, ticking, lastTickAt, status }
const _alerts = new Map(); // `${kind}:${id}` -> last push epoch

function _monStatus() {
  return {
    ok: true,
    running: !!(_mon?.timer),
    openTrades: (_state.trades || []).filter(t => t.status === 'OPEN').length,
    lastTickAt: _mon?.lastTickAt || null,
    lastPushAt: _mon?.status?.lastPushAt || null,
    pushes: _mon?.status?.pushes || 0,
    lastError: _mon?.status?.lastError || null,
  };
}
export function manualMonitorStatus() { return _monStatus(); }

function _curOf(market) { return market === 'FUTURES' || market === 'GLOBALFUTURES' ? '$' : '₹'; }
function _fmtPx(v, market) {
  const n = _num(v);
  if (n == null) return '—';
  // v12.9: precision-aware — XRP-style sub-$1 levels (the reversal FLIP
  // plans) used to collapse to "$0.5"; 4-6 decimals below $1 keep the
  // actual SL/TP level readable on telegram.
  const dp = n >= 1000 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  const s = n >= 1000 ? Math.round(n).toLocaleString('en-IN') : String(Number(n.toFixed(dp)));
  return `${_curOf(market)}${s}`;
}

/** Cooldown-guarded push (the insta-push pattern, self-contained).
 *  Guards: _mon may be null when alerts are evaluated outside the
 *  monitor (tests / future callers) — never crash on bookkeeping.
 *  v10.18 (deep-recheck #3): the FULL cooldown arms only on a
 *  successful send — one transient Telegram blip used to suppress
 *  the EXIT-NOW push for its whole window (30 min). A failed send
 *  reserves a short 30s failure-retry hold instead, so the next
 *  30s conviction sweep re-attempts. The return is now honest too
 *  (false when nothing went out — callers journal what actually left). */
const ALERT_FAIL_RETRY_MS = 30_000;
// v18.6.4: per-entry cooldown records — the old global cutoff (now -
// CURRENT cooldown) used to delete a 6h-cooldown 't1' entry with a
// 5-min 'sl' pass, and the autocut path (cooldownMs=0) wiped the WHOLE
// map once size>200 → duplicate EXIT-NOW/target pushes. Each entry now
// remembers its own cooldown and is pruned only when ITS window ended.
async function _push(kind, id, text, cooldownMs, send) {
  const key = `${kind}:${id}`;
  const now = Date.now();
  const last = _alerts.get(key);
  if (last && now - last.ts < Math.max(cooldownMs, last.cool || 0)) return false;
  // reserve with the failure-retry window (blocks concurrent double-send)
  _alerts.set(key, { ts: now - cooldownMs + ALERT_FAIL_RETRY_MS, cool: cooldownMs });
  if (_alerts.size > 200) { // same hygiene as telegramPush — per-entry prune
    for (const [k, e] of _alerts) {
      if (now - (e?.ts || 0) > (e?.cool || 0) + 60_000) _alerts.delete(k);
    }
  }
  const r = typeof send === 'function'
    ? await send(text).catch(() => ({ ok: false }))
    : { ok: false };
  if (r?.ok !== false) {
    _alerts.set(key, { ts: now, cool: cooldownMs }); // the full cooldown — it actually went out
    if (_mon) {
      _mon.status.pushes++;
      _mon.status.lastPushAt = now;
    }
    return true;
  }
  return false;
}

/**
 * The alert evaluation for ONE trade — PURE-ish (send injected), tested
 * through the loop. Exported for tests.
 */
export async function evaluateManualTradeAlerts(t, { send, conviction, freshSignal, usdInr, reversal }) {
  const pushed = [];
  const ltp = _num(t.__ltp);
  const plan = t.origin?.plan || {};
  const o = plan.entry ?? t.entryPrice;
  const dir = sideOf(t.side) === 'SELL' ? -1 : 1;
  const banner = stateOfManualTrade({ convictionState: conviction?.state, ltp, trade: t, reversal });
  const pnl = manualPnlOf(t, ltp, { usdInr });
  const dist = manualLevelDistances(t, ltp);
  const why = freshSignal ? flipSummary(t, freshSignal) : null;

  // ---- 0) v12.9 REVERSAL — the ₹ states of the engine-connected
  //      cycle (LOSS_CAP plan / ₹ target BOOK). The activation push
  //      fired on the crossing (5s sweep); THIS is the periodic
  //      reminder while the state persists (15m cooldown). ----
  if (banner === 'LOSS_CAP' || banner === 'REVERSAL_BOOK') {
    const opposite = t.side === 'BUY' ? 'SHORT' : 'LONG';
    const cap = _num(reversal?.lossCapINR) || 150;
    const tgt = _num(reversal?.profitTargetINR) || 500;
    const f = reversal?.flip || null;
    const pnlTxt = pnl.currency === 'USDT'
      ? `${pnl.pnlUSDT != null ? `${pnl.pnlUSDT >= 0 ? '+' : '−'}$${Math.abs(pnl.pnlUSDT)}` : '—'}`
      : `${pnl.pnlINR >= 0 ? '+' : '−'}₹${Math.abs(Math.round(pnl.pnlINR))}`;
    const text = banner === 'REVERSAL_BOOK'
      ? [
        `✅ <b>REVERSAL AI — ₹ TARGET hit (cycle ${reversal?.cycleId || '—'} · leg ${reversal?.leg || 1})</b>`,
        `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${_fmtPx(o, t.market)} → live <b>${_fmtPx(ltp, t.market)}</b> · P&L <b>${pnlTxt}</b> (target ₹${tgt})`,
        `BOOK karo — profit realized karo. Reversal-window me opp side confirm hone par next leg ka plan milega.`,
        `<i>/manualclose ${t.id} se close. (Manual cycle — execute aap karo.)</i>`,
      ].join('\n')
      : [
        `🛑 <b>REVERSAL AI — LOSS-CAP hit (cycle ${reversal?.cycleId || '—'} · leg ${reversal?.leg || 1} ACTIVATED)</b>`,
        `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${_fmtPx(o, t.market)} → live <b>${_fmtPx(ltp, t.market)}</b> · P&L <b>${pnlTxt}</b> (cap ₹${cap})`,
        `Reversal plan (₹-cycle):`,
        `• 1) Ye position CLOSE karo — minimal loss accept`,
        `• 2) Opposite <b>${f?.side || opposite}</b> entry${f ? ` qty ${f.qty} @ ~${_fmtPx(f.entry ?? ltp, t.market)} · SL ${_fmtPx(f.sl, t.market)} (₹${cap}) / TP ${_fmtPx(f.tp, t.market)} (₹${tgt})` : ' — reversal ko ride karo'}`,
        `• 3) +₹${tgt} target pe profit BOOK karo`,
        `<i>/manualclose ${t.id} se close. (Manual cycle — execute aap karo.)</i>`,
      ].join('\n');
    if (await _push(banner === 'REVERSAL_BOOK' ? 'book' : 'losscap', t.id, text, 15 * 60_000, send)) pushed.push(banner === 'REVERSAL_BOOK' ? 'book' : 'losscap');
  }

  // ---- 1) EXIT NOW — conviction flip: IMMEDIATE, highest priority ----
  if (banner === 'EXIT_NOW') {
    const whyLines = [];
    if (why) {
      if (why.flipped.length > 0) whyLines.push(`${why.flipped.length} models flipped: ${why.flipped.slice(0, 5).join(', ')}${why.flipped.length > 5 ? '…' : ''}`);
      if (why.abstainedNew.length > 0) whyLines.push(`${why.abstainedNew.length} models ab abstain kar rahe (data missing)`);
      if (why.entryScore != null && why.curScore != null) whyLines.push(`AI score: entry ${why.entryScore} → ab ${why.curScore} (opposite side)`);
    }
    const text = [
      `🚨 <b>MANUAL TRADE — EXIT NOW</b>`,
      `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${_fmtPx(o, t.market)} → live <b>${_fmtPx(ltp, t.market)}</b> (${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct}%)`,
      `Ensemble ab <b>${conviction?.side === 'BUY' ? 'LONG' : 'SHORT'}</b> side par hai — thesis invalid ho chuki hai.`,
      ...whyLines.map(l => `• ${l}`),
      plan.stopLoss ? `SL ${_fmtPx(plan.stopLoss, t.market)} hai${dist.sl != null ? ` (${Math.abs(dist.sl)}% away)` : ''} — judge karo, obey mat karo.` : '',
      `<i>/manualclose ${t.id} se site se close kar sakte ho.</i>`,
    ].filter(Boolean).join('\n');
    if (await _push('flip', t.id, text, 30 * 60_000, send)) pushed.push('flip');
  }

  // ---- 2) SL approach — within 0.3×ATR (or 0.5% of entry when ATR
  //      unknown — labeled honestly as a proxy). v18.6.4: OPTION trades
  //      skip — plan.atr underlying-domain hai, premium ke against
  //      galat scale pe fire karta tha. ----
  if (ltp > 0 && plan.stopLoss > 0 && banner !== 'EXIT_NOW' && t.assetKind !== 'OPTION') {
    const atr = _num(plan.atr) || (o > 0 ? o * 0.005 : null); // proxy when ATR missing
    if (atr > 0) {
      const distAbs = Math.abs(ltp - plan.stopLoss);
      if (distAbs <= atr * 0.3) {
        const text = [
          `⚠️ <b>MANUAL TRADE — SL approach</b>`,
          `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${_fmtPx(o, t.market)} → live ${_fmtPx(ltp, t.market)}`,
          `SL ${_fmtPx(plan.stopLoss, t.market)} sirf ${Math.round(distAbs / atr * 100) / 100}×ATR away hai (${Math.abs(dist.sl ?? 0)}%)`,
          `P&L: ${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct}% (${pnl.currency === 'USDT' ? `$${pnl.pnlUSDT}` : `₹${pnl.pnlINR}`})`,
        ].join('\n');
        if (await _push('sl', t.id, text, SL_ALERT_COOLDOWN_MS, send)) pushed.push('sl');
      }
    }
  }

  // ---- 3) target hits (once each). v18.6.4: OPTION skip (premium vs
  //      underlying levels = false hits) ----
  if (ltp > 0 && t.assetKind !== 'OPTION') {
    for (const [lvKey, lv] of [['t1', plan.target1], ['t2', plan.target2]]) {
      if (!(lv > 0)) continue;
      if ((ltp - lv) * dir >= 0) {
        const text = [
          `🎯 <b>MANUAL TRADE — ${lvKey.toUpperCase()} HIT</b>`,
          `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${_fmtPx(o, t.market)} → live <b>${_fmtPx(ltp, t.market)}</b>`,
          `${lvKey.toUpperCase()} ${_fmtPx(lv, t.market)} touch ho gaya · P&L: ${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct}% (${pnl.currency === 'USDT' ? `$${pnl.pnlUSDT}` : `₹${pnl.pnlINR}`})`,
          `Runner ka SL breakeven shift karna mat bhoolna.`,
        ].join('\n');
        if (await _push(lvKey, t.id, text, 6 * 60 * 60_000, send)) pushed.push(lvKey);
      }
    }
  }

  // ---- 4) stagnant check-in — quiet trade, time-based nudge ----
  const ageMin = t.openedAt ? (Date.now() - t.openedAt) / 60000 : 0;
  if (ageMin > 0 && banner === 'THESIS_INTACT' && Math.abs(pnl.pnlPct) < 0.6) {
    const nth = Math.floor(ageMin / (STAGNANT_EVERY_MS / 60000));
    if (nth > 0) {
      const text = [
        `⏱ <b>MANUAL TRADE — check-in</b> (${Math.round(ageMin)}m in)`,
        `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} @ ${_fmtPx(o, t.market)} → live ${_fmtPx(ltp, t.market)} (${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct}%)`,
        `Thesis intact hai lekin trade stagnant hai — ${plan.target1 ? `T1 ${_fmtPx(plan.target1, t.market)}` : 'target'} ${dist.t1 != null ? `${Math.abs(dist.t1)}% away` : ''}.`,
      ].filter(Boolean).join('\n');
      if (await _push(`stag${nth}`, t.id, text, STAGNANT_EVERY_MS * 2, send)) pushed.push('stag');
    }
  }
  return pushed;
}

/**
 * v11.5: on a failed/thrown deep re-vote, KEEP the last-known conviction
 * (any real state — HOLDING/STRENGTHENING/WEAKENING/FLIPPED) with its
 * ORIGINAL `at` stamp — age-honest, and the route's 90s freshness check
 * keeps retrying the deep path so the data self-heals when upstream
 * recovers. UNKNOWN only when the trade never had a successful vote at
 * all (the honest STALE banner). Prevents the monitor from repeatedly
 * wiping GOOD data on transient upstream failures.
 */
function _preserveConvictionOnDeepFailure(prev, now) {
  if (prev && prev.state && prev.state !== 'UNKNOWN') return prev;
  return { state: 'UNKNOWN', delta: null, currentScore: null, side: null, at: now };
}

/**
 * v11.5 (route-level twin): the /api/manual-trades view builder's
 * last-known fallback — when the on-demand deep re-vote fails AND no
 * fresh conviction exists, the trade's last REAL vote beats a dead
 * "STALE — conviction data missing" bar. Returns null when the trade
 * never had a usable vote (honest STALE). PURE.
 */
export function lastKnownConvictionForView(trade) {
  const c = trade?.__conviction;
  return (c && c.state && c.state !== 'UNKNOWN') ? c : null;
}

async function _monitorTick() {
  if (!_mon || _mon.ticking) return;
  _mon.ticking = true;
  let nextDelay = MONITOR_IDLE_MS;
  try {
    const open = (_state.trades || []).filter(t => t.status === 'OPEN');
    // v18.6.3 REALTIME NEVER STOPS: hold the upstream subscriptions for
    // OPEN trades FIRST — even when the browser's SSE disconnects/parks
    // (app tab hidden while the user trades on the exchange site), the
    // tick store keeps landing fresh LTPs for the sweep below. Runs
    // BEFORE the idle early-return so the last close releases subs.
    _syncTradeSubscriptions(open, _mon.deps || {});
    if (open.length === 0) { _mon.lastTickAt = Date.now(); return; }
    nextDelay = MONITOR_ACTIVE_MS;
    // v10.16 wiring fix: the injected deps live on _mon.deps — reading
    // them off _mon directly left getDeepSignal/fetchers undefined and
    // the conviction re-vote (and with it EVERY alert) silently dead.
    const { getDeepSignal, depsForSignals, fetchIndiaQuotes, fetchIndexSpot, usdInrOf } = _mon.deps || {};
    const { send } = _mon;
    const usdInr = typeof usdInrOf === 'function' ? (_num(await usdInrOf()) || 84) : 84;
    // 1) LTP sweep (tick store first — free; injected fetchers fallback)
    //    v12.0: every sweep also updates the trade's MFE/MAE excursion
    //    (peak R / trough R) — the exit-quality report card's raw feed.
    //    v18.6.4: PARALLEL sweep (N trades × 8-12s sequential fallback
    //    used to stretch the "5s" cadence with many open trades).
    await Promise.all(open.map(async (t) => {
      const px = await ltpForManualTrade(t, { fetchIndiaQuotes, fetchIndexSpot });
      if (px > 0) { t.__ltp = px; t.__ltpAt = Date.now(); updateExcursion(t, px); }
    }));
    // 1b) v12.9 REVERSAL ENGINE — price-based activation on EVERY 5s
    //     sweep (capital protection is a stop; it must not wait for the
    //     30s conviction pass). Threshold crossings stamp the MANUAL
    //     cycle + push the actionable plan (native-currency P&L, exact
    //     flip SL/TP levels). The 15m 'losscap'/'book' cooldowns make
    //     the later conviction-pass reminders exactly that — reminders.
    let _revCfg = null;
    try { _revCfg = loadReversalConfig(); } catch { _revCfg = null; }
    if (_revCfg?.enabled) {
      for (const t of open) {
        const px = _num(t.__ltp);
        if (!(px > 0)) continue;
        try {
          const tr = activateReversalOnManualTrade(t, px, { usdInr, cfg: _revCfg });
          if (tr) {
            _persist();
            if ((tr.to === 'LOSS_CAP' || tr.to === 'PROFIT_TARGET') && typeof send === 'function') {
              await _push(tr.to === 'LOSS_CAP' ? 'losscap' : 'book', t.id, reversalActivationText(tr, { usdInr }), 15 * 60_000, send);
            }
            // v13.1 REVERSAL AUTO-CUT (OPT-IN — reversalAutoCut in the
            // agent config, default OFF): the live XRP case crossed its
            // ₹150 loss-cap and bled to −₹2,250 because the plan was
            // advisory-only ("execute aap karo") and the push went
            // unread for 44 minutes. With autoCut ON the sweep CLOSES
            // the leg AT the crossing price (the flip plan survives on
            // the trade record + the Reversal board) — the cap actually
            // caps. v12.7's "never auto-close" rule stays the default.
            if (tr.to === 'LOSS_CAP' && _revCfg.autoCut) {
              try {
                const cut = closeManualTrade(t.id, {
                  exitPrice: px,
                  reason: `REVERSAL AUTO-CUT (loss-cap ₹${_revCfg.lossCapINR})`,
                });
                if (cut?.ok && typeof send === 'function') {
                  const pnlN = t.market === 'FUTURES' || t.market === 'GLOBALFUTURES'
                    ? `$${Math.round(Math.abs(_num(cut.trade?.exitPnlINR) || 0) / (usdInr || 84) * 100) / 100}`
                    : `₹${Math.round(Math.abs(_num(cut.trade?.exitPnlINR) || 0))}`;
                  await _push('autocut', t.id, [
                    `✂️ <b>REVERSAL AUTO-CUT executed</b>`,
                    `<b>${t.symbol}</b> ${t.side === 'BUY' ? 'LONG' : 'SHORT'} closed @ <b>${_fmtPx(px, t.market)}</b> · loss <b>−${pnlN}</b> (cap ₹${_revCfg.lossCapINR})`,
                    `Flip plan board pe live hai: <b>${t.reversal?.flip?.side || 'opposite'}</b> @ ~${_fmtPx(px, t.market)} — SVA verify kake lo.`,
                    `<i>reversalAutoCut ON hai — manual trades ab cap-cross pe khud cut hote hain.</i>`,
                  ].join('\n'), 0, send);
                }
              } catch (e) {
                _mon.status.lastError = String(e?.message || e).slice(0, 140);
              }
            }
          }
        } catch { /* one trade's reversal pass never kills the sweep */ }
      }
    }
    // 2) conviction re-vote (30s throttle per trade; cached deep path)
    //    v12.8: the ₹ loss-cap advisory rides the same 30s sweep — the
    //    reversal config is 60s-cached, so this adds zero I/O per tick.
    for (const t of open) {
      const now = Date.now();
      if (now - (t.__convictionAt || 0) < CONVICTION_EVERY_MS) continue;
      t.__convictionAt = now;
      if (typeof getDeepSignal !== 'function') continue;
      try {
        const deep = await getDeepSignal(t.symbol, t.market === 'GLOBALFUTURES' ? 'GLOBALFUTURES' : t.market, depsForSignals ? depsForSignals() : {});
        if (deep?.ok && deep.signal) {
          const c = manualConvictionOf(t, deep.signal);
          t.__conviction = { ...c, side: sideOf(deep.signal.side), at: now };
          let reversal = null;
          if (_revCfg?.enabled) {
            const pnlNow = manualPnlOf(t, t.__ltp, { usdInr });
            if (pnlNow.pnlINR != null) {
              const liveState = pnlNow.pnlINR <= -Math.abs(_revCfg.lossCapINR) ? 'LOSS_CAP'
                : pnlNow.pnlINR >= Math.abs(_revCfg.profitTargetINR) ? 'PROFIT_TARGET'
                : (t.reversal?.state === 'PROFIT_TARGET' ? 'PROFIT_TARGET' : (t.reversal?.state || null));
              reversal = { enabled: true, lossCapINR: _revCfg.lossCapINR, profitTargetINR: _revCfg.profitTargetINR, pnlINR: pnlNow.pnlINR, state: liveState, ...(t.reversal?.flip ? { flip: t.reversal.flip } : {}), ...(t.reversal?.cycleId ? { cycleId: t.reversal.cycleId, leg: t.reversal.leg ?? null } : {}) };
            }
          }
          await evaluateManualTradeAlerts(t, { send, conviction: t.__conviction, freshSignal: deep.signal, usdInr, ...(reversal ? { reversal } : {}) });
          if (t.lastState !== c.state) { t.lastState = c.state; _persist(); }
        } else {
          // v11.5: transient deep failure — PRESERVE the last-known
          // conviction instead of wiping to UNKNOWN on every tick. A
          // 5-min-old THESIS_INTACT read beats a dead STALE bar; the
          // vote's own `at` stamp keeps the age honest. UNKNOWN only
          // when this trade NEVER had a successful vote.
          t.__conviction = _preserveConvictionOnDeepFailure(t.__conviction, now);
        }
      } catch (e) {
        _mon.status.lastError = String(e?.message || e).slice(0, 140);
        // a THROWN deep call degrades exactly like an ok:false one —
        // last-known conviction preserved, UNKNOWN only if never voted.
        t.__conviction = _preserveConvictionOnDeepFailure(t.__conviction, now);
      }
    }
    _mon.lastTickAt = Date.now();
  } catch (e) {
    if (_mon) _mon.status.lastError = String(e?.message || e).slice(0, 140);
  } finally {
    if (_mon && !_mon.stopped) {
      _mon.ticking = false;
      _mon.timer = setTimeout(_monitorTick, nextDelay);
      if (typeof _mon.timer.unref === 'function') _mon.timer.unref();
    }
  }
}

/**
 * Boot the manual-trade monitor (idempotent — same contract as
 * startInstaPushSink). Called from ai/routes.js registration.
 * @param {object} deps { getDeepSignal, depsForSignals, send, fetchIndiaQuotes, fetchIndexSpot, usdInrOf }
 */
export function startManualTradeMonitor(deps = {}) {
  if (_mon && _mon.timer) return;
  _mon = {
    timer: null, ticking: false, lastTickAt: null, stopped: false,
    deps,
    send: deps.send || (async () => ({ ok: false, error: 'no sender' })),
    status: { pushes: 0, lastPushAt: null, lastError: null },
  };
  _mon.timer = setTimeout(_monitorTick, 8_000);
  if (typeof _mon.timer.unref === 'function') _mon.timer.unref();
  console.log(`[manual-trades] monitor armed (5s LTP · 30s conviction re-vote · telegram on flip/SL/target) — ${(_state.trades || []).filter(t => t.status === 'OPEN').length} open`);
}

export function stopManualTradeMonitor() {
  if (_mon?.timer) { clearTimeout(_mon.timer); _mon.timer = null; }
  // v18.6.4: a stopped monitor stays stopped — an in-flight tick's
  // finally used to resurrect the loop (and re-hold subs) after stop.
  if (_mon) _mon.stopped = true;
  // v18.6.3: a stopped monitor must not keep the upstream pollers hot —
  // release everything it was holding (idempotent server-side).
  if (_subHold && _mon?.deps) {
    const { releaseSubs, clientDown } = _mon.deps || {};
    try {
      if (typeof releaseSubs === 'function') {
        if (_subHold.crypto.size) releaseSubs({ crypto: [..._subHold.crypto] });
        if (_subHold.india.size) releaseSubs({ india: [..._subHold.india] });
        if (_subHold.fut.size || _subHold.glob.size) releaseSubs({ fut: [..._subHold.fut], glob: [..._subHold.glob] });
      }
      if (typeof clientDown === 'function') {
        if (_subHold.clients.crypto) clientDown('crypto');
        if (_subHold.clients.india) clientDown('india');
        if (_subHold.clients.cxrt) clientDown('cxrt');
      }
    } catch { /* best-effort on stop */ }
  }
  _subHold = null;
}

export async function __monitorTickForTests() { await _monitorTick(); }
export function __monitorStateForTests() { return { alerts: _alerts, mon: _mon }; }
export function __setManualStateForTests(trades, nextId) {
  _state = { trades: trades || [], nextId: nextId || (trades?.length || 0) + 1 };
}
