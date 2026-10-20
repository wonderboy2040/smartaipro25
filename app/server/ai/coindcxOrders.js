// ============================================================
// server/ai/coindcxOrders.js — LIVE order execution + safety core
// ------------------------------------------------------------
// Executes REAL CoinDCX spot orders — but ONLY through the gauntlet:
//
//   1. MODE GATE      paper (default) | live (typed confirmation)
//   2. KILL SWITCH    one click → all auto/execution disabled
//   3. SIGNAL GATE    fresh server-side STRONG consensus
//                     (re-run, ≤ 90s old, conf + agreement gates)
//   4. RISK GATE      max order ₹ · daily trade cap · daily loss cap
//                     · one open position per pair
//   5. VENUE GATE     CoinDCX only — India stays signals-only
//
// Every decision (approve/reject/execute) lands in a durable audit
// journal. SL/TP from the signal plan are tracked server-side (NSE
// spot has no native stops) and closed by the position watcher.
// ============================================================
import crypto from 'node:crypto';
import { coindcxPrivate, coindcxConnected } from '../mcp/coindcx.js';
import { dhanConnected } from './dhan.js';
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';
import { fetchCoinDcxTickers, lastTickerSource } from '../cryptoStream.js';
import { computeTrailSl } from './ensemble.js';
import { pRound } from './lib/priceRound.js';
import { validateTick, wickJournalEntry } from './wickFilter.js';
import { recordExecution, settlePositionOutcome, markPartialOutcome, __setLedgerForTests } from './ledger.js';
// v20.9.1 [H1]: 200-wrapped rejection detector — futures desk me v20.7.12
// se tha, spot desk me KAHIN wired nahi tha (HTTP 200 + {code:4xx} body
// pe coindcxPrivate throw nahi karta → close/partial/entry "success" book
// hote the jabki exchange ne reject kar diya tha). Hoisted fn decl — cycle safe.
import { coindcxRespError } from './futures.js';

const CONFIG_FILE = 'ai-trading-config.json';
const JOURNAL_FILE = 'ai-trading-journal.json';
const MAX_JOURNAL = 500;
const CLOSED_POSITION_TTL = 90 * 24 * 3600_000; // v7.0.2: closed positions pruned after 90d

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ---------------- config (durable-backed) ----------------
export const DEFAULT_CONFIG = {
  mode: 'paper',                // 'paper' | 'live'  (crypto CoinDCX)
  indiaMode: 'paper',           // 'paper' | 'live'  (India Dhan) — v6.5
  minConfidence: 75,            // STRONG gate (ensemble must also agree)
  minAgreement: 0.70,
  maxOrderINR: 1000,            // per-order cap (₹) — crypto
  indiaMaxOrderINR: 5000,       // per-order cap (₹) — India equity — v6.5
  dailyMaxTrades: 3,
  dailyMaxLossINR: 500,         // realized+paper loss cap per day
  onePositionPerPair: true,
  // v6.7 CONCENTRATION GUARD — total open positions across BOTH desks
  // (crypto + India, paper + live). Prop-desk style: no more than N
  // simultaneous exposures no matter how good the signals look.
  maxOpenPositions: 5,
  allowAuto: false,             // auto-execute STRONG signals (no click)
  killSwitch: false,
  liveConfirmedAt: null,
  indiaLiveConfirmedAt: null,   // v6.5 — India arming is separate
  // v6.6 CRYPTO LEVERAGE — CoinDCX margin. This is BOTH the default AND
  // the hard ceiling for any request (server clamps, never trusts the
  // client). 1 = spot only. Liquidation-vs-SL sanity is enforced on
  // every leveraged execution (see ensemble.maxSaneLeverage).
  cryptoLeverage: 3,
  // v6.5 TRAILING SL — winners run, stops ratchet (never loosen)
  trailEnabled: true,
  trailArmR: 1.0,               // arm once profit ≥ 1× initial risk
  trailOffsetR: 1.0,            // trail SL = peak − 1× initial risk
};

export function loadConfig() {
  return { ...DEFAULT_CONFIG, ...loadJSON(CONFIG_FILE, {}) };
}
export function saveConfig(cfg) {
  saveJSON(CONFIG_FILE, cfg);
  try { durablePut(CONFIG_FILE, cfg); } catch { /* best-effort */ }
  return cfg;
}

export function updateConfig(patch = {}) {
  const cfg = loadConfig();
  const next = { ...cfg };
  const numeric = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 100) / 100)) : undefined;
  };
  if (patch.mode === 'paper') { next.mode = 'paper'; }
  if (patch.mode === 'live') {
    // LIVE requires an explicit typed confirmation phrase.
    const phrase = String(patch.liveConfirmPhrase || '').trim().toUpperCase();
    if (phrase !== 'LIVE') {
      const err = new Error('Enabling LIVE mode requires liveConfirmPhrase="LIVE" (typed confirmation)');
      err.status = 400;
      throw err;
    }
    if (!coindcxConnected()) {
      const err = new Error('CoinDCX not connected — connect an API key with trade permission first');
      err.status = 400;
      throw err;
    }
    next.mode = 'live';
    next.liveConfirmedAt = Date.now();
  }
  if (patch.minConfidence != null) { const v = numeric(patch.minConfidence, 50, 95); if (v != null) next.minConfidence = v; }
  if (patch.minAgreement != null) { const v = numeric(patch.minAgreement, 0.5, 0.95); if (v != null) next.minAgreement = v; }
  if (patch.maxOrderINR != null) { const v = numeric(patch.maxOrderINR, 100, 1_000_000); if (v != null) next.maxOrderINR = v; }
  if (patch.dailyMaxTrades != null) { const v = numeric(patch.dailyMaxTrades, 1, 50); if (v != null) next.dailyMaxTrades = v; }
  if (patch.dailyMaxLossINR != null) { const v = numeric(patch.dailyMaxLossINR, 50, 1_000_000); if (v != null) next.dailyMaxLossINR = v; }
  if (patch.maxRiskPct != null) { const v = numeric(patch.maxRiskPct, 1, 20); if (v != null) next.maxRiskPct = v; }
  if (patch.trailEnabled != null) next.trailEnabled = !!patch.trailEnabled;
  if (patch.trailArmR != null) { const v = numeric(patch.trailArmR, 0.5, 3); if (v != null) next.trailArmR = v; }
  if (patch.trailOffsetR != null) { const v = numeric(patch.trailOffsetR, 0.5, 2); if (v != null) next.trailOffsetR = v; }
  if (patch.indiaMode === 'paper') { next.indiaMode = 'paper'; }
  if (patch.indiaMode === 'live') {
    // India LIVE has its own typed confirmation (independent of crypto).
    const phrase = String(patch.liveConfirmPhrase || '').trim().toUpperCase();
    if (phrase !== 'LIVE') {
      const err = new Error('Enabling India LIVE mode requires liveConfirmPhrase="LIVE" (typed confirmation)');
      err.status = 400;
      throw err;
    }
    if (!dhanConnected()) {
      const err = new Error('Dhan not connected — connect Client ID + Access Token first (Execution Console)');
      err.status = 400;
      throw err;
    }
    next.indiaMode = 'live';
    next.indiaLiveConfirmedAt = Date.now();
  }
  if (patch.indiaMaxOrderINR != null) { const v = numeric(patch.indiaMaxOrderINR, 100, 500_000); if (v != null) next.indiaMaxOrderINR = v; }
  if (patch.cryptoLeverage != null) { const v = numeric(patch.cryptoLeverage, 1, 10); if (v != null) next.cryptoLeverage = Math.round(v); }
  if (patch.maxOpenPositions != null) { const v = numeric(patch.maxOpenPositions, 1, 20); if (v != null) next.maxOpenPositions = Math.round(v); }
  if (patch.onePositionPerPair != null) next.onePositionPerPair = !!patch.onePositionPerPair;
  if (patch.allowAuto != null) next.allowAuto = !!patch.allowAuto;
  if (patch.killSwitch != null) {
    next.killSwitch = !!patch.killSwitch;
    if (next.killSwitch) { next.allowAuto = false; next.mode = 'paper'; next.indiaMode = 'paper'; }
  }
  return saveConfig(next);
}

// ---------------- journal (durable-backed audit trail) ----------------
export function loadJournal() {
  return loadJSON(JOURNAL_FILE, { entries: [], positions: [] });
}
export function saveJournal(j) {
  if (j.entries.length > MAX_JOURNAL) j.entries = j.entries.slice(-MAX_JOURNAL);
  // v7.0.2: CLOSED positions pruned after 90d — the journal used to keep
  // every closed position forever (multi-MB reload on every route hit;
  // the tamper-evident LEDGER remains the permanent track record).
  if (Array.isArray(j.positions)) {
    const cutoff = Date.now() - CLOSED_POSITION_TTL;
    const keep = j.positions.filter(p => p.status !== 'CLOSED' || (p.closedAt || p.openedAt || 0) >= cutoff);
    if (keep.length !== j.positions.length) j.positions = keep;
  }
  saveJSON(JOURNAL_FILE, j);
  try { durablePut(JOURNAL_FILE, j); } catch { /* best-effort */ }
  return j;
}

// ---------------- journal lock (serialize ALL writers) ----------------
// Every journal mutation path (executeSignal / watchPositions /
// closePosition) does load → await network → mutate → save. Node is
// single-threaded but the awaits yield to concurrent writers: two
// overlapping writers hold independent deep copies and the LAST save
// silently reverts the other (double market-sells of the same position,
// lost closures, live orders with no journal record). All mutating
// sections run through this promise queue; anything read BEFORE taking
// the lock must be re-loaded inside it.
let _journalChain = Promise.resolve();
export function withJournalLock(fn) {
  const run = _journalChain.then(fn);
  _journalChain = run.then(() => {}, () => {}); // chain never rejects
  return run;
}

function pushEntry(j, entry) {
  j.entries.push({ id: crypto.randomUUID(), ts: Date.now(), ...entry });
}
// v6.5: shared with indiaOrders.js (same journal, same lock, same stamps)
export { pushEntry, todayIST };

// ---------------- v10.17: CLEAR CLOSED POSITIONS ----------------
// The Execution Console's 🧹 CLEAR CLOSED button. Purges CLOSED rows
// from the journal's positions array (they were already TTL-pruned
// after 90d — this is the user's ON-DEMAND version of that sweep).
// SAFETY: only status === 'CLOSED' rows go — OPEN/UNKNOWN positions
// are structurally untouched. The tamper-evident LEDGER keeps the
// permanent per-order audit trail, and a HOUSEKEEP journal entry
// stamps the sweep itself (count + day) so the action is auditable.
export function clearClosedPositions() {
  return withJournalLock(() => {
    const j = loadJournal();
    const positions = Array.isArray(j.positions) ? j.positions : [];
    const keep = positions.filter(p => p.status !== 'CLOSED');
    const removed = positions.length - keep.length;
    if (removed > 0) {
      j.positions = keep;
      pushEntry(j, {
        kind: 'HOUSEKEEP',
        day: todayIST(),
        status: 'CLOSED_SWEEP',
        note: `clear-closed sweep: ${removed} CLOSED position row(s) removed from the console view (ledger audit trail intact)`,
        removed,
      });
      saveJournal(j);
    }
    return { ok: true, removed, kept: keep.length };
  });
}

function todayIST() {
  // Daily caps reset at IST midnight REGARDLESS of the server's TZ
  // (Render is UTC, but docker/self-host deployments may not be — the
  // offset-arithmetic trick double-corrects on non-UTC servers).
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

function dailyStats(j) {
  const day = todayIST();
  // v6.11: NOTIFIED (alert-only) entries are NOT trades — they must not
  // consume the daily trade budget. REJECTED likewise never counted.
  // v12.1: FAILED now joins them — journal-proven (2026-09-18): three
  // `[422] market is required` rejections burned the ENTIRE daily cap,
  // so the agent stood down for the day on orders that never executed.
  // An order the exchange refused is not a trade; only entries that
  // actually reached the book (FILLED/SUBMITTED/SUBMITTED_UNKNOWN)
  // consume the budget.
  // v20.2 SIM DESK SEPARATION: GLOBALFUTURES = the USDC equity SIM desk
  // (no real listing). Its entries no longer consume the REAL desks'
  // daily trade/loss budget, and its P&L reports separately (sim*) —
  // simulated results must never masquerade as (or block) real trading.
  const isSim = (e) => String(e.market || 'CRYPTO') === 'GLOBALFUTURES';
  const realOrder = (e) => e.day === day && e.kind === 'ORDER'
    && e.status !== 'REJECTED' && e.status !== 'NOTIFIED' && e.status !== 'FAILED';
  const trades = j.entries.filter(e => realOrder(e) && !isSim(e));
  const simTrades = j.entries.filter(e => realOrder(e) && isSim(e));
  // v7.0 PRO TRADER: PARTIAL_TP legs are REALIZED P&L the moment they
  // fill — they count toward the daily loss cap immediately (no
  // double-count: CLOSE entries carry only the final remaining leg).
  const closedToday = j.entries.filter(e => e.day === day && (e.kind === 'CLOSE' || e.kind === 'PARTIAL_TP'));
  const realized = closedToday.filter(e => !isSim(e)).reduce((a, e) => a + (e.pnlINR || 0), 0);
  const simRealized = closedToday.filter(e => isSim(e)).reduce((a, e) => a + (e.pnlINR || 0), 0);
  return {
    day, tradesCount: trades.length, realizedPnlINR: r2(realized),
    simTradesCount: simTrades.length, simRealizedPnlINR: r2(simRealized),
  };
}

/** v6.11 test hook: daily stats with the NOTIFIED exclusion verified. */
export function dailyStatsExport(j) { return dailyStats(j); }

export function getRiskState() {
  const cfg = loadConfig();
  const j = loadJournal();
  const stats = dailyStats(j);
  return {
    config: cfg,
    stats,
    openPositions: j.positions.filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length,
    blocked: {
      killSwitch: cfg.killSwitch,
      dailyTrades: stats.tradesCount >= cfg.dailyMaxTrades,
      dailyLoss: stats.realizedPnlINR <= -cfg.dailyMaxLossINR,
      notConnected: !coindcxConnected(),
      // v6.7: concentration — too many simultaneous exposures
      maxOpenPositions: j.positions.filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length >= (cfg.maxOpenPositions || 5),
    },
  };
}

// ---------------- qty precision ----------------
const FALLBACK_PRECISION = { BTC: 6, ETH: 5, BNB: 4, SOL: 3, XRP: 1, DOGE: 0, ADA: 1, AVAX: 2, LINK: 2, DOT: 2, TRX: 1, MATIC: 1 };
let _productsCache = null, _productsAt = 0;
async function getPairMeta(pair) {
  if (!_productsCache || Date.now() - _productsAt > 6 * 3600_000) {
    try {
      const r = await fetch('https://api.coindcx.com/exchange/v1/products_details', { signal: AbortSignal.timeout(8000) });
      if (ok(r)) {
        const list = await r.json();
        _productsCache = Array.isArray(list) ? list : null;
        _productsAt = Date.now();
      }
    } catch { /* keep null → fallback precision */ }
  }
  const base = pair.replace('INR', '').replace('USDT', '');
  if (Array.isArray(_productsCache)) {
    const p = _productsCache.find(x => x && (x.pair === pair || x.symbol === pair));
    if (p) {
      return {
        base,
        qtyPrecision: Number(p.precision ?? p.quantity_precision) || (FALLBACK_PRECISION[base] ?? 4),
        minQty: Number(p.min_quantity || p.min_qty || 0) || 0,
        minNotional: Number(p.min_notional || p.min_total || 0) || 0,
      };
    }
  }
  return { base, qtyPrecision: FALLBACK_PRECISION[base] ?? 4, minQty: 0, minNotional: 0 };
}
function ok(r) { return r && r.ok; }

// ---------------- v18.9 OFFICIAL-PRICE GATE + FEE HONESTY ----------------
/** v18.9 Taker fee % per side for realized-P&L honesty (env-tunable,
 *  0 = off). CoinDCX charges ~0.1-0.5%/side — the old GROSS pnl
 *  (exit−entry)×qty systematically overstated every booked close, the
 *  daily realized number AND the ₹ daily-loss cap. Fees are now
 *  deducted at booking: (entry+exit)×qty×fee% (both-side turnover for
 *  the closed slice). */
const CRYPTO_TAKER_FEE_PCT = (() => {
  const n = Number(process.env.AI_COINDCX_FEE_PCT);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.10; // 0.10%/side default
})();
function cryptoLegFeesINR(entryPrice, exitPrice, qty) {
  try {
    const e = Number(entryPrice), x = Number(exitPrice), q = Number(qty);
    if (![e, x, q].every(Number.isFinite) || e <= 0 || x <= 0 || q <= 0) return 0;
    return r2((e + x) * q * (CRYPTO_TAKER_FEE_PCT / 100));
  } catch { return 0; }
}

/** v18.9 OFFICIAL-PRICE GATE — synthetic (Binance×fx) and 3-min
 *  deep-stale ticker legs must NEVER trigger a live stop/target close.
 *  Failure case (journal-proven class): fx fallback 84 while the real
 *  USDINR ≈ 88 → synthetic INR price ~4.6% BELOW the venue → a LONG's
 *  `price <= sl` fires falsely → REAL market sell executes + the loss
 *  is booked at the synthetic price (corrupting pnlINR + the daily
 *  cap). Returns a Map(pair→price) of OFFICIAL CoinDCX rows only, or
 *  null when no official price exists. (lastTickerSource may be
 *  undefined under partial test mocks — degraded to row-filtering.) */
function officialPriceMap(tickers) {
  if (!Array.isArray(tickers) || tickers.length === 0) return null;
  let src = null;
  try { src = typeof lastTickerSource === 'function' ? String(lastTickerSource()) : null; } catch { src = null; }
  // whole-batch degraded legs: never tradable
  if (src === 'binance-fx-synth' || src === 'coindcx-rest-deep-stale') return null;
  const rows = tickers.filter(t => t && !t.__synthetic
    && Number.isFinite(parseFloat(t.last_price)) && parseFloat(t.last_price) > 0);
  if (rows.length === 0) return null;
  return new Map(rows.map(t => [t.market, parseFloat(t.last_price)]));
}

/** v18.9 AMBIGUITY CLASSIFIER — a timeout/abort/network failure means
 *  the order MAY have reached CoinDCX and filled (re-sending the same
 *  market sell = DOUBLE SELL); a definitive HTTP rejection ([4xx]/[5xx]
 *  body) did NOT move coins and is safe to retry next tick. */
function isAmbiguousTransportError(e) {
  const s = String(e?.message || e || '');
  return /timeout|abort|network|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|terminated/i.test(s);
}
// v20.3: shared with the futures desk (its partial-TP market order had
// the same ambiguous-retry double-sell class the spot desk fixed in v18.9).
export { isAmbiguousTransportError };

// v20.3 PAPER-FILL REALISM (exit side): the v20.2 slip applied to ENTRY
// only — every paper EXIT still filled at mid, flattering each exit leg
// by ~7bps (a LONG exits by selling into the bid). Live fills keep the
// exchange's real fill price (reconciled).
function paperSlipBps() {
  const n = Number(process.env.AI_COINDCX_SLIP_BPS);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 7;
}
function paperExitPrice(price, side, slipBps) {
  if (!(slipBps > 0)) return price;
  return r2(side === 'LONG' ? price * (1 - slipBps / 10000) : price * (1 + slipBps / 10000));
}

export async function roundQty(pair, qty) {
  const meta = await getPairMeta(pair);
  const q = Math.floor(Number(qty) * 10 ** meta.qtyPrecision) / 10 ** meta.qtyPrecision;
  return { qty: q, meta };
}

// ---------------- v6.6: CoinDCX margin (leverage) helpers ----------------
// Margin orders live on a SEPARATE API family from spot:
//   create  POST /exchange/v1/margin/orders               { side, pair: "B-BTC_INR", leverage, margin: {...} }
//   exit    POST /exchange/v1/margin/orders/exit_positions { positions: [{ pair, side }] }
// Spot pairs are "BTCINR"; margin pairs are "B-BTC_INR". The active-pairs
// list is fetched (signed, 6h cache) when available to confirm the pair is
// margin-enabled and learn its leverage limits; the B-<BASE>_INR naming is
// CoinDCX's stable convention, so a failed/unreachable list falls back to it.
let _marginPairsCache = null, _marginPairsAt = 0;
async function getMarginPairName(pair, creds) {
  const spotBase = String(pair).replace('INR', '').replace('USDT', '');
  // v18.9 FIX: the module's OWN contract (comment above) says margin
  // pairs are "B-BTC_INR" (underscore) — the old `B-${spotBase}INR`
  // fallback sent a MALFORMED pair whenever the active_pairs list was
  // unreachable (boot, outage, cold cache): every leveraged SL/liq/manual
  // exit then failed and retried forever. Convention now matches.
  const conventional = `B-${spotBase}_INR`;
  if (!_marginPairsCache || Date.now() - _marginPairsAt > 6 * 3600_000) {
    try {
      const resp = await coindcxPrivate('/exchange/v1/margin/active_pairs', creds.apiKey, creds.secret, {});
      const list = Array.isArray(resp) ? resp : (Array.isArray(resp?.pairs) ? resp.pairs : null);
      if (list) { _marginPairsCache = list; _marginPairsAt = Date.now(); }
    } catch { /* convention fallback below */ }
  }
  if (Array.isArray(_marginPairsCache)) {
    const hit = _marginPairsCache.find(p => p && (p.pair === conventional || p.pair === pair || p.instrument === conventional));
    if (hit) return { pair: String(hit.pair || conventional), listed: true };
    // v7.0.2: base-token scan used substring match — a short base like "B"
    // or "T" substring-matched nearly every margin pair and could route a
    // LIVE order to the WRONG instrument. Exact-convention match only.
    const byBase = _marginPairsCache.find(p => p && (() => {
      const name = String(p.pair || p.instrument || '');
      return name === conventional || name.split('_')[0] === `B-${spotBase}` || name.replace('_', '') === conventional.replace('_', '');
    })());
    if (byBase) return { pair: String(byBase.pair || byBase.instrument), listed: true };
  }
  return { pair: conventional, listed: false };
}

function marginOrderBody({ marginPair, side, qty, leverage, marginINR }) {
  // v21.23.10 [SIDE-VOCAB]: v21.23.9 ne futuresOrderBody me 'SELL'!=='SHORT'
  // silent-LONG-default fix kiya tha — yahan SPOT margin body me WAHI hazard
  // zinda tha ('SELL' → buy!). Dual-vocabulary map + unknown-side LOUD throw.
  const s = String(side || '').toUpperCase();
  const long = s === 'LONG' || s === 'BUY';
  if (!long && s !== 'SHORT' && s !== 'SELL') {
    throw new Error(`marginOrderBody: invalid side "${side}" (LONG/BUY or SHORT/SELL required)`);
  }
  return {
    side: long ? 'buy' : 'sell',
    pair: marginPair,
    order_type: 'market_order',
    total_quantity: String(qty),
    leverage: Math.max(1, Math.floor(leverage)),
    margin: {
      margin_amount_short: long ? 0 : marginINR,
      margin_currency_short: 'INR',
      margin_amount_long: long ? marginINR : 0,
      margin_currency_long: 'INR',
      margin_amount_needed: marginINR,
    },
    hidden: true,
    post_only: false,
    time_in_force: 'good_till_cancel',
  };
}

function marginExitBody({ marginPair, side }) {
  // exit_positions keys off the POSITION's side (the side it was opened with)
  return { positions: [{ pair: marginPair, side: String(side).toLowerCase() === 'short' ? 'sell' : 'buy' }] };
}

// ---------------- THE EXECUTION GAUNTLET ----------------
/**
 * v21.23.8 SPOT FULL STOP — CoinDCX spot (SYM-INR) trading ka ek-matra
 * policy switch (user: "coindcx spot trade... spot ko full stop kardo —
 * sirf futures USDT & equity sim aur gold & silver me hi trade lagna
 * chahiye").
 *
 *   • RUNTIME (npm start / serve): DEFAULT-ON — executeSignal ka har
 *     mode (live/notify/paper) reject ho jata hai.
 *   • AI_SPOT_FULL_STOP=0: operator ka EXPLICIT opt-in — purana spot
 *     gauntlet wapas live ho jata hai (migration/emergency ke liye).
 *   • AI_SPOT_FULL_STOP=1: hamesha ON (explicit).
 *   • NODE_ENV=test (default): off — purane hermetic gauntlet locks
 *     (aiOrders.test.ts) apna contract padhte rahein; full-stop ke apne
 *     locks ucFlipReverse21238.test.ts me env=1 ke saath hain.
 */
export function spotTradeFullStop() {
  const v = String(process.env.AI_SPOT_FULL_STOP ?? '').trim().toLowerCase();
  if (v === '0') return false;
  if (v === '1') return true;
  return String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'test';
}

/**
 * executeSignal({ symbol, side, mode, qtyINR, leverage, getFreshSignal, wantAuto })
 *
 * v6.6 LEVERAGE: `qtyINR` is the MARGIN (₹ you commit). With leverage L
 * the notional = margin × L and the qty/₹-risk scale with it. The
 * effective L is clamped server-side to [1, config.cryptoLeverage] — a
 * client payload can never widen it. L=1 keeps the battle-tested spot
 * path; L>1 routes LIVE orders through the CoinDCX margin API.
 *
 * getFreshSignal(symbol) MUST return a signal from a fresh ensemble
 * run (injected by routes.js to avoid circular imports) — client
 * payloads are never trusted for the trade decision.
 */
export async function executeSignal(opts) {
  const {
    symbol, side, mode, qtyINR, leverage, getFreshSignal, wantAuto = false, source = 'manual',
    sendTelegram,
  } = opts || {};
  const cfg = loadConfig();
  const pair = `${String(symbol || '').toUpperCase()}INR`;
  // v6.11: NOTIFY mode (glama mukul8896 3-mode execution) — full gauntlet,
  // alert-only output. Paper-grade gates (alert-grade info, not money).
  const wantMode = mode === 'live' ? 'live' : mode === 'notify' ? 'notify' : 'paper';
  const day = todayIST();
  const entry = { kind: 'ORDER', day, symbol: pair, side, mode: wantMode, source };

  // Rejections are journal writes too — run them under the lock so they
  // can never clobber a concurrent watcher/manual-close save.
  const reject = (reason, error, extra = {}) => withJournalLock(() => {
    const j = loadJournal();
    // v21.23.12 [REJECT-DEDUP — spot/crypto side]: indiaOrders (v21.23.10
    // fix-20) ka dedup yahan nahi tha — persistent reject-condition (spot
    // full-stop ON / wallet short / leverage gate) har tick nayi REJECTED
    // row mint karta tha (~2,880/day; 500-entry window ~4h me displacement).
    // Same scan-20 + __repeatCount + 5-min window dedup, all callers
    // (manual clicks, telegram approvals, agent loop) covered.
    const _entries = Array.isArray(j.entries) ? j.entries : [];
    for (let k = _entries.length - 1, n = 0; k >= 0 && n < 20; k--, n++) {
      const e = _entries[k];
      if (!e || e.status !== 'REJECTED') continue;
      if (String(e.symbol) !== String(pair) || String(e.reason) !== String(reason)) continue;
      if (Date.now() - Number(e.ts || 0) >= 5 * 60_000) break;
      e.__repeatCount = (Number(e.__repeatCount) || 1) + 1;
      e.ts = Date.now();
      return saveJournal(j);
    }
    pushEntry(j, { ...entry, status: 'REJECTED', reason, ...extra });
    saveJournal(j);
  }).then(() => ({ ok: false, error: error || reason }));

  // --- gate 0: v21.23.8 SPOT FULL STOP (user: "coindcx spot ko full stop
  // kardo — sirf FUTURES USDT & EQUITY SIM & GOLD & SILVER me hi trade
  // lagna chahiye") ---
  // executeSignal = CoinDCX SPOT (SYM-INR) ka EK-MATRA order path — legacy
  // 90s auto-executor, manual /api/ai/execute, telegram-approval aur
  // superagent spot loop SAB isi gauntlet se guzarte hain. Runtime par ye
  // gate DEFAULT-ON hai: koi bhi mode (live/notify/paper) spot entry pass
  // NAHI ho sakta. AI_SPOT_FULL_STOP=0 explicit operator opt-in se hi off
  // hota hai. NODE_ENV=test me default off hai taaki hermetic gauntlet
  // locks (aiOrders.test.ts) apne purane contract padhte rahein — spot
  // full-stop ke apne dedicated locks ucFlipReverse21238.test.ts me hain
  // (env=1 ke saath).
  if (spotTradeFullStop()) {
    return reject(
      'SPOT FULL STOP (v21.23.8) — CoinDCX spot trading disabled: sirf FUTURES USDT + GOLD/SILVER (XAU/XAG) + EQUITY SIM me hi trade hota hai',
      'SPOT FULL STOP — CoinDCX spot band hai (v21.23.8). FUTURES USDT / GOLD & SILVER / EQUITY SIM desks use karo.',
    );
  }

  // --- gate 1: kill switch ---
  if (cfg.killSwitch) {
    return reject('Kill switch ON — execution disabled');
  }
  // v21.1.0 (Phase-2 audit fix #4): EXEC-RECONCILER KILL — L1/L2/L3 kill
  // (UI /api/exec/kill ya kill-flag file se) pehle sirf /api/exec/enter
  // rokta tha; AI-desk gauntlet sirf apne CONFIG killSwitch dekhta tha.
  // Ab reconciler ka kill-level bhi LIVE entries rokta hai (paper/notify
  // untouched — practice flow me exec stack involved hi nahi hai).
  // Defensive import: reconciler na ho (single-node local/tests) to koi
  // gate nahi — isKilled() unarmed default false hai.
  if (wantMode === 'live') {
    try {
      const { isKilled, killLevel, killReason } = await import('../exec/reconciler.js');
      if (typeof isKilled === 'function' && isKilled()) {
        return reject(`Exec kill L${killLevel()} ACTIVE (${killReason() || 'no reason'}) — live entries blocked`);
      }
    } catch { /* reconciler unavailable — single-node local, no exec stack */ }
  }
  // v21.1.0 (Phase-4): GO-LIVE GATE — LIVE sirf tab jab PAPER track-record
  // qualify kare (min trades / +expectancy / DD limit — strategyGuard.js).
  // VITEST me enforce off hai (dedicated gate tests override karte hain).
  if (wantMode === 'live') {
    try {
      const { goLiveGateBlocked } = await import('./strategyGuard.js');
      const g = goLiveGateBlocked();
      if (g.blocked) return reject(g.reason, g.reason, { goLiveGate: g.readiness?.stats });
    } catch { /* guard unavailable — never break the flow */ }
  }
  // v21.1.0 (Phase-4): PER-STRATEGY KILL RULE — rolling 30-trade expectancy
  // negative → us strategy ki LIVE entries reject (auto-resume on recovery).
  // v21.1.1 [audit A1]: block ab LIVE-only. Pehle sab modes (paper bhi)
  // block hote the — par settled trades sirf PASS hone wali entries se hi
  // window me aate hain, to negative window kabhi update hi nahi hota tha
  // = PERMANENT deadlock (recovery sirf 400-entry prune ya env override se).
  // Paper continue karta hai → window refresh → expectancy recover → auto
  // resume (jaisa UI/reason text ka promise hai).
  if (wantMode === 'live') {
    try {
      const { strategyGuardBlocked } = await import('./strategyGuard.js');
      const g = strategyGuardBlocked(source, 'CRYPTO');
      if (g.blocked) return reject(g.reason, g.reason, { strategyPaused: true });
    } catch { /* guard unavailable — never break the flow */ }
  }

  // --- gate 2: auto-mode policy ---
  if (wantAuto && !cfg.allowAuto) {
    return { ok: false, error: 'Auto-execution is OFF (enable it in Risk settings)' };
  }
  if (wantAuto && cfg.mode !== 'live') {
    return { ok: false, error: 'Auto-execution only runs in LIVE mode' };
  }

  // --- gate 3: MODE gate (live) ---
  // A LIVE order additionally requires the account to be ARMED for live
  // (typed "LIVE" confirmation in Risk settings). The request body's
  // mode field alone must NEVER be enough to move real money — the UI
  // toggle is not an enforcement layer.
  if (wantMode === 'live' && cfg.mode !== 'live') {
    return reject('LIVE mode is not enabled — type LIVE in Risk settings first');
  }

  // --- gate 4: connection (live) ---
  if (wantMode === 'live' && !coindcxConnected()) {
    return reject('CoinDCX not connected');
  }

  // --- gate 5: fresh STRONG signal (server-side, never client-trusted) ---
  // v11.5: the gauntlet's mode flows into the fresh-signal source —
  // paper/notify may fall back to the 60s board cache when the deep path
  // is down; LIVE keeps the strict fresh-deep-run contract.
  const signal = await getFreshSignal(pair, { mode: wantMode });
  if (!signal) {
    return reject('No fresh ensemble signal available for this pair');
  }
  const gates = { minConfidence: cfg.minConfidence, minAgreement: cfg.minAgreement };
  const { evaluateExecutionGate, buildTradePlan, fitPlanToRiskCap, maxSaneLeverage } = await import('./ensemble.js');

  // PAPER/NOTIFY practice fallback: the FRESH consensus can be FLAT/planless
  // or can have DECAYED below the ACTION floor. V21.23.2 SIGNAL-DIRECTION
  // INVERSION FIX: v21.13 ka silent FLIP-REALIGN HATA DIYA — pehle fresh
  // consensus ka flipped side (clicked card ke OPPOSITE) trade khul jaata
  // tha (user ko signal LONG dikhta, trade SHORT khulta — "long trade signal
  // ka short jaa raha hai") aur ye evaluateExecutionGate ke anti-flip veto
  // ko bypass karta tha (gate REALIGNED side pe match hota tha). Ab
  // direction conflict = honest REJECT — LIVE ka "kabhi silent flip nahi"
  // invariant ab HAR mode me hai. FLAT/planless (direction-less) pehle
  // jaisa requested side pe synth hota hai. LIVE is branch me nahi aata.
  let effectiveSignal = signal;
  let synthNote = null;
  // v12.7 (recheck R1-#9): an ABSENT side no longer silently defaults
  // LONG — an unspecified request inherits the fresh signal's side (the
  // client always sends side; a missing side is a malformed call, and
  // minting a LONG from nothing was a free directional bias).
  const _reqRaw = String(side || '').toUpperCase();
  const reqSide = _reqRaw === 'SHORT' || _reqRaw === 'LONG' ? _reqRaw
    : (signal.side === 'SHORT' || signal.side === 'LONG' ? signal.side : 'LONG');
  const sideConflict = signal.side !== 'FLAT' && signal.side !== reqSide;
  const belowFloor = signal.grade !== 'STRONG' && signal.grade !== 'ACTION';
  if (sideConflict) {
    // v21.23.2: clicked/signal side ke OPPOSITE trade KABHI nahi khulta.
    // Stale-card flip ka honest answer BLOCK hai — silent inversion nahi
    // (user complaint: "long trade signal ka short jaa raha hai / short ka
    // long"). Journal me flip document hota hai; engine track-record pe
    // stale-side SL ka blame bhi nahi jata.
    return reject(
      `Direction conflict: fresh consensus ${signal.side} hai, ${reqSide} signal/card pe trade maara tha — signal FLIP ho gaya (whipsaw window). Entry BLOCKED — silent auto-flip kabhi nahi hota. Naya ${signal.side} card refresh karke confirm karo.`,
      `Signal flip: fresh consensus ${signal.side} ≠ requested ${reqSide} — trade blocked (no auto-flip)`,
      { flippedFrom: reqSide, flippedTo: signal.side },
    );
  }
  if (wantMode !== 'live' && (signal.side === 'FLAT' || !signal.plan)) {
    // FLAT/planless (direction-less) → REQUESTED side pe practice plan synth
    // (a direction-less fresh view never mints a side; side caller ki hai).
    const synthPlan = buildTradePlan(
      { side: reqSide, dir: reqSide === 'LONG' ? 1 : -1 },
      { ltp: signal.ltp, ind: {} }, 'CRYPTO',
    );
    if (synthPlan && signal.ltp > 0) {
      effectiveSignal = { ...signal, side: reqSide, plan: synthPlan };
      synthNote = `practice plan @ live price (fresh consensus: ${signal.side} ${signal.confidence}% — direction-less, requested side pe synth)`;
    }
  }
  // v9.0.2: honest disclosure when the fresh consensus matched the request
  // but sat below the paper floor — the trade opens AND the toast says so.
  const floorNote = (wantMode !== 'live' && !synthNote && (belowFloor || (Number(signal.confidence) || 0) < 55))
    ? `practice floor relaxed (fresh ${signal.grade ?? '—'} · ${signal.confidence ?? 0}% — journaled)` : null;

  // PAPER = practice money (relaxed gate, 10-min freshness); LIVE = the full
  // STRONG gauntlet (90s freshness, confidence + agreement + risk caps).
  // v6.4 RISK AUTO-FIT: a structural ATR stop a hair over the cap
  // (5.04% vs 5%) used to hard-REJECT even the PAPER button. Now the
  // stop is FITTED to the cap and targets re-derived — PAPER always
  // fits; LIVE fits only mild overshoot (≤ 1.5× cap) because a
  // wildly-wide ATR stop clamped tight is noise-suicide and belongs
  // in an honest REJECT. The gate below stays as the final safety net.
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
    } // else: leave the plan as-is — the gate rejects with the honest reason
  }
  const verdict = evaluateExecutionGate(effectiveSignal, {
    // v21.23.2: gate ab HAMESHA effective (conflict-free) side pe hota hai —
    // REALIGN branch hat chuka hai, isliye evaluateExecutionGate ka anti-flip
    // veto (fresh ≠ requested → reject) ab kabhi bypass nahi hota.
    side: wantMode === 'live' ? (side || effectiveSignal.side) : (effectiveSignal.side || side), gates,
    requireStrong: wantMode === 'live',
    maxAgeMs: wantMode === 'live' ? 90_000 : 600_000,
    maxRiskPct: cfg.maxRiskPct || 5,
    practice: wantMode !== 'live', // v9.0.2: paper/notify practice — floor relaxed, honesty journaled
  });
  if (!verdict.ok) {
    const hint = (Number(effectiveSignal?.plan?.riskPct) > riskCap)
      ? ` — widen "Max stop %" (currently ${riskCap}%) in Risk settings or skip this volatile pair`
      : '';
    return reject(verdict.reason, `Signal gate: ${verdict.reason}${hint}`, {
      signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
    });
  }

  // v6.11 NOTIFY: the signal passed the gauntlet — send the Telegram
  // alert under the lock (audit trail in the journal, NO position).
  // Position-creation caps (daily trades / loss / one-per-pair /
  // concentration) deliberately DON'T block a notification — "cap hit
  // + STRONG signal aaya" is exactly the moment an alert earns its keep.
  if (wantMode === 'notify') {
    return withJournalLock(async () => {
      const j = loadJournal();
      const stats = dailyStats(j);
      const plan = effectiveSignal.plan;
      const price = Number(effectiveSignal.ltp) > 0 ? Number(effectiveSignal.ltp) : null;
      const capsNote = `trades ${stats.tradesCount}/${cfg.dailyMaxTrades} · realized ₹${r2(stats.realizedPnlINR)}`;
      const lines = [
        `🔔 <b>SmartAI NOTIFY</b> — ${pair} ${effectiveSignal.side}`,
        `<b>${signal.grade || '—'}</b> · conf ${signal.confidence ?? '—'}% · agreement ${Math.round((signal.agreement ?? 0) * 100)}%`,
        plan ? `Entry ${pRound(plan.entry)} · SL ${pRound(plan.stopLoss)} · T1 ${pRound(plan.target1)} · T2 ${pRound(plan.target2)} · risk ${r2(plan.riskPct)}%` : 'plan nahi bana',
        `Book: ${capsNote}`,
        [synthNote, fitNote, floorNote].filter(Boolean).join(' · ') || undefined,
        '— notify-only: koi order place NAHI hua.',
      ].filter(Boolean);
      let telegramSent = false;
      if (typeof sendTelegram === 'function') {
        try { telegramSent = !!(await sendTelegram(lines.join('\n'))).ok; } catch { /* alert best-effort */ }
      }
      pushEntry(j, {
        ...entry, status: 'NOTIFIED', ...(price ? { price: pRound(price) } : {}),
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [synthNote, fitNote, floorNote, verdict.reason].filter(Boolean).join(' · ') || 'gauntlet pass',
        telegramSent,
      });
      saveJournal(j);
      return {
        ok: true, mode: 'notify', notified: true, telegramSent,
        alert: { pair, side: effectiveSignal.side, grade: signal.grade, confidence: signal.confidence,
          plan: plan ? { entry: pRound(plan.entry), stopLoss: pRound(plan.stopLoss), target2: pRound(plan.target2) } : null,
          caps: capsNote },
        note: telegramSent ? 'Telegram alert bhej diya (journal AUDIT: NOTIFIED). Koi position nahi bani.'
          : 'Gauntlet pass + journal AUDIT likha, par Telegram configured nahi — Alerts & AI Keys me token/chat-id daalo.',
      };
    });
  }

  // --- sizing (exchange minimums included when products metadata is
  // reachable — rejecting locally is a clean REJECT instead of a FAILED
  // live round-trip that burns a daily-cap slot) ---
  const price = effectiveSignal.ltp;
  if (!(price > 0)) {
    return { ok: false, error: 'No live price for sizing' };
  }
  // v6.6: qtyINR = the MARGIN you commit. Leverage multiplies the notional.
  const levCap = Number(cfg.cryptoLeverage) >= 1 ? Math.floor(Number(cfg.cryptoLeverage)) : 1;
  let lev = Math.max(1, Math.floor(Number(leverage) || 1));
  if (lev > levCap) lev = levCap; // server-side clamp — client can never widen
  const marginBudget = Math.min(Number(qtyINR) > 0 ? Number(qtyINR) : cfg.maxOrderINR, cfg.maxOrderINR);
  if (marginBudget < 100) {
    return { ok: false, error: `Order size ₹${marginBudget} below the ₹100 minimum` };
  }
  // LEVERAGE SANITY (v6.6 accuracy gate): if the liquidation estimate sits
  // INSIDE the stop-loss the SL is dead code — the exchange liquidates
  // first. PAPER auto-reduces the leverage to the largest sane value
  // (practice must never dead-end); LIVE rejects honestly — a leveraged
  // real order whose plan cannot execute belongs in a REJECT, not a hope.
  const slDistPct = Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price)) / price * 100;
  const saneLev = maxSaneLeverage(slDistPct, levCap);
  let levNote = null;
  if (lev > 1 && lev > saneLev) {
    if (wantMode === 'paper') {
      levNote = `leverage auto-reduced ${lev}x → ${saneLev}x (liquidation est. would fire before the ${r2(slDistPct)}% SL)`;
      lev = saneLev;
    } else {
      return reject(`leverage ${lev}x puts liquidation (~${r2(95 / lev)}% away) inside the ${r2(slDistPct)}% stop — reduce leverage to ≤${saneLev}x`, `Leverage gate: ${lev}x liquidates before the SL — use ≤ ${saneLev}x or widen "Max stop %"`);
    }
  }
  const notionalBudget = marginBudget * lev;
  const rawQty = notionalBudget / price;
  const { qty, meta } = await roundQty(pair, rawQty);
  if (!(qty > 0)) {
    return { ok: false, error: `Quantity rounds to 0 at ${pair} precision (${meta.qtyPrecision}dp) — increase order size` };
  }
  const notional = qty * price;
  const marginUsed = r2(notional / lev);
  if (meta.minQty > 0 && qty < meta.minQty) {
    return { ok: false, error: `Quantity ${qty} is below the exchange minimum (${meta.minQty}) for ${pair}` };
  }
  if (meta.minNotional > 0 && notional < meta.minNotional) {
    return { ok: false, error: `Order ₹${Math.round(notional)} is below the exchange minimum (₹${meta.minNotional}) for ${pair}` };
  }
  // v6.6 liquidation estimate stored on the position (paper watcher simulates
  // liquidation at this level; live positions carry it for display + watch)
  const liquidation = lev > 1 && effectiveSignal.plan?.stopLoss != null
    ? pRound(effectiveSignal.side !== 'SHORT' ? price * (1 - 0.95 / lev) : price * (1 + 0.95 / lev))
    : null;

  // --- FINAL MUTATION — under the journal lock with a FRESH copy ---
  // The caps + one-per-pair checks live HERE (not before the signal run,
  // which can take seconds) so a fill that lands while another writer
  // mutated the journal can never stack onto a breached day/pair state.
  // The LIVE order send is also inside the lock: a concurrent manual
  // close of the same pair cannot interleave with the send.
  return withJournalLock(async () => {
    const j = loadJournal(); // fresh copy under the lock
    const stats = dailyStats(j);
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
    if (cfg.onePositionPerPair && j.positions.some(p => p.pair === pair && (p.status === 'OPEN' || p.status === 'UNKNOWN'))) {
      // v7.0.2: UNKNOWN counts as open (consistent with the futures desk +
      // concentration guard) — an unreconciled fill must not stack a second
      // live order on the same pair.
      pushEntry(j, { ...entry, status: 'REJECTED', reason: 'Position already open for this pair' });
      saveJournal(j);
      return { ok: false, error: `An open position already exists for ${pair} (one-per-pair rule)` };
    }
    // v6.7 CONCENTRATION GUARD — the whole book (both desks) at once.
    // one-per-pair stops SAME-symbol stacking; this stops 8 different
    // symbols all bleeding simultaneously on a choppy day.
    const openCount = j.positions.filter(p => p.status === 'OPEN' || p.status === 'UNKNOWN').length;
    if (openCount >= (cfg.maxOpenPositions || 5)) {
      pushEntry(j, { ...entry, status: 'REJECTED', reason: `Max open positions (${cfg.maxOpenPositions || 5}) hit` });
      saveJournal(j);
      return { ok: false, error: `Concentration guard: ${openCount} positions already open (max ${cfg.maxOpenPositions || 5}) — close some first or raise the cap in Risk settings` };
    }

    // --- paper execution ---
    if (wantMode === 'paper') {
      // v20.2 PAPER-FILL REALISM: practice fills now take adverse slippage
      // (default 7bps, AI_COINDCX_SLIP_BPS, 0=off) so paper P&L is not
      // systematically flattered by mid-price fills. LIVE fills keep the
      // exchange's real fill price (reconciled). 7bps ≈ liquid-pair market
      // order cost on CoinDCX spot.
      const slipBps = paperSlipBps();
      const slipNote = slipBps > 0 ? `fill +${slipBps}bps slippage (practice realism)` : null;
      const fillPrice = slipBps > 0
        ? r2(effectiveSignal.side === 'SHORT' ? price * (1 - slipBps / 10000) : price * (1 + slipBps / 10000))
        : price;
      // v6.7: stamp the execution into the tamper-evident ledger
      // v20.2: relaxed = the practice entry ran against a flipped/sub-floor
      // consensus (synthNote/floorNote) — excluded from calibration corpus.
      let ledgerEntryId = null;
      try {
        const rec = recordExecution(signal, { mode: 'paper', market: 'CRYPTO', source, ...(synthNote || floorNote ? { relaxed: true } : {}) });
        ledgerEntryId = rec?.id || null;
      } catch { /* best-effort */ }
      const position = {
        id: crypto.randomUUID(), pair, side: effectiveSignal.side, mode: 'paper', market: 'CRYPTO', source,
        qty, entryPrice: fillPrice, notionalINR: r2(qty * fillPrice),
        ...(ledgerEntryId ? { ledgerEntryId } : {}),
        ...(lev > 1 ? { leverage: lev, marginINR: marginUsed, liquidation } : {}),
        sl: effectiveSignal.plan?.stopLoss ?? null, tp: effectiveSignal.plan?.target1 ?? null, tp2: effectiveSignal.plan?.target2 ?? null,
        initialRisk: pRound(Math.abs(fillPrice - (effectiveSignal.plan?.stopLoss ?? fillPrice))),
        peakPrice: pRound(fillPrice),
        signal: { grade: signal.grade, confidence: signal.confidence, agreement: signal.agreement, summary: synthNote || signal.summary },
        openedAt: Date.now(), status: 'OPEN',
      };
      j.positions.push(position);
      pushEntry(j, {
        ...entry, status: 'FILLED', qty, price: pRound(fillPrice), notionalINR: r2(qty * fillPrice),
        ...(lev > 1 ? { leverage: lev, marginINR: marginUsed } : {}),
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [verdict.reason, synthNote, fitNote, levNote, floorNote, slipNote].filter(Boolean).join(' · '),
      });
      saveJournal(j);
      return { ok: true, mode: 'paper', position, filled: { qty, price: pRound(fillPrice), notionalINR: r2(qty * fillPrice), ...(lev > 1 ? { leverage: lev, marginINR: marginUsed } : {}) }, ...{ fitted: [synthNote, fitNote, levNote, floorNote, slipNote].filter(Boolean).join(' · ') || undefined } };
    }

    // --- LIVE execution: signed order to CoinDCX ---
    // v6.6: leverage > 1 → the MARGIN API (pair "B-BTC_INR", margin block,
    // exit via /margin/orders/exit_positions). Leverage 1 keeps the
    // battle-tested spot path untouched.
    try {
      const creds = loadCredsForOrder();
      if (!creds?.apiKey || !creds?.secret) return { ok: false, error: 'CoinDCX credentials unreadable' };
      let orderId = null;
      let marginPairUsed = null;
      if (lev > 1) {
        const mp = await getMarginPairName(pair, creds);
        marginPairUsed = mp.pair;
        const body = marginOrderBody({ marginPair: mp.pair, side: effectiveSignal.side, qty, leverage: lev, marginINR: marginUsed });
        const resp = await coindcxPrivate('/exchange/v1/margin/orders', creds.apiKey, creds.secret, body);
        // v20.9.1 [H1]: 200-wrapped rejection pe throw — warna FAILED
        // journal ke bajaye OPEN position book hota tha.
        const merr = coindcxRespError(resp);
        if (merr) throw new Error(merr);
        orderId = resp?.orders?.[0]?.id || resp?.order?.id || null;
      } else {
        // v12.1 LIVE-FIX (journal-proven 2026-09-18: every live spot order
        // died with CoinDCX `[422] market is required`): the SPOT
        // /orders/create contract wants the pair in the `market` field
        // (BTCINR) — `pair` is the MARGIN/futures vocabulary, spot ignores
        // it — and the spot order_type vocabulary is `market_order`/
        // `limit_order` (same as the margin API), not bare `market`.
        const body = {
          side: effectiveSignal.side === 'SHORT' ? 'sell' : 'buy',
          market: pair,
          order_type: 'market_order',
          total_quantity: String(qty),
          hidden: true,
        };
        const resp = await coindcxPrivate('/exchange/v1/orders/create', creds.apiKey, creds.secret, body);
        // v20.9.1 [H1]: 200-wrapped rejection ({code:4xx,message} body with
        // HTTP 200) pehle silently pass hota tha — orderId:null ke saath
        // OPEN/UNKNOWN position book hoti thi jabki order gaya hi nahi.
        const werr = coindcxRespError(resp);
        if (werr) throw new Error(werr);
        orderId = resp?.orders?.[0]?.id || resp?.order?.id || null;
      }
      // CoinDCX market orders report avg fill in list/status — entry price
      // starts at the signal LTP and the watcher reconciles UNKNOWN/
      // fill data on its next pass (see reconcileLivePosition). Margin
      // positions skip that reconciliation (different orders API) — the
      // watcher still enforces SL/TP/liquidation via exit_positions.
      const position = {
        id: crypto.randomUUID(), pair, side: effectiveSignal.side, mode: 'live', market: 'CRYPTO', source, exchangeOrderId: orderId,
        qty, entryPrice: price, notionalINR: r2(notional),
        // v6.7: live executions land in the ledger too — the tamper-
        // evident trail covers REAL money decisions, not just paper
        ledgerEntryId: (() => { try { return recordExecution(signal, { mode: 'live', market: 'CRYPTO', source })?.id || null; } catch { return null; } })(),
        ...(lev > 1 ? { leverage: lev, marginINR: marginUsed, liquidation, ...(marginPairUsed ? { marginPair: marginPairUsed } : {}) } : {}),
        sl: effectiveSignal.plan?.stopLoss ?? null, tp: effectiveSignal.plan?.target1 ?? null, tp2: effectiveSignal.plan?.target2 ?? null,
        initialRisk: pRound(Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price))),
        peakPrice: pRound(price),
        signal: { grade: signal.grade, confidence: signal.confidence, agreement: signal.agreement, summary: signal.summary },
        openedAt: Date.now(),
        // margin create responses always carry an id when accepted; no-id
        // margin fills go UNKNOWN-free (watcher retry loop would never
        // resolve them through the SPOT orders API anyway)
        status: orderId ? 'OPEN' : (lev > 1 ? 'OPEN' : 'UNKNOWN'),
      };
      j.positions.push(position);
      pushEntry(j, {
        ...entry, status: orderId ? 'SUBMITTED' : 'SUBMITTED_UNKNOWN', qty, price: pRound(price),
        notionalINR: r2(notional), exchangeOrderId: orderId,
        ...(lev > 1 ? { leverage: lev, marginINR: marginUsed } : {}),
        signal: { grade: signal.grade, conf: signal.confidence, agreement: signal.agreement },
        reason: [verdict.reason, fitNote, levNote].filter(Boolean).join(' · '),
      });
      saveJournal(j);
      return { ok: true, mode: 'live', orderId, position, filled: { qty, price: pRound(price), notionalINR: r2(notional), ...(lev > 1 ? { leverage: lev, marginINR: marginUsed } : {}) }, ...{ fitted: [fitNote, levNote].filter(Boolean).join(' · ') || undefined } };
    } catch (e) {
      // v21.1.0 AMBIGUOUS-ENTRY GUARD (Phase-2 order-exec audit fix #2):
      // timeout/abort/network failure means the order MAY have filled on the
      // exchange. Pehle ye plain FAILED journal karta tha with NO position row —
      // one-per-pair guard kuch nahi dekhta tha aur 30s agent tick usi pair pe
      // SECOND live order laga sakta tha jiska pehla order actually fill ho
      // chuka tha. Ab ambiguous failure ek UNKNOWN position row book karta
      // hai (no order id → 3-min watcher human-surface path + concentration
      // slot) jo duplicate re-entry ko BLOCK karta hai jab tak resolve na ho.
      if (isAmbiguousTransportError(e)) {
        const position = {
          id: crypto.randomUUID(), pair, side: effectiveSignal.side, mode: 'live', market: 'CRYPTO', source,
          exchangeOrderId: null,
          qty, entryPrice: price, notionalINR: r2(notional),
          ...(lev > 1 ? { leverage: lev, marginINR: marginUsed } : {}),
          sl: effectiveSignal.plan?.stopLoss ?? null, tp: effectiveSignal.plan?.target1 ?? null,
          initialRisk: pRound(Math.abs(price - (effectiveSignal.plan?.stopLoss ?? price))),
          peakPrice: pRound(price),
          signal: { grade: signal.grade, confidence: signal.confidence, agreement: signal.agreement, summary: signal.summary },
          openedAt: Date.now(), unknownSince: Date.now(), ambiguousEntry: true,
          status: 'UNKNOWN',
        };
        j.positions.push(position);
        pushEntry(j, {
          ...entry, status: 'SUBMITTED_UNKNOWN', qty, price: pRound(price), notionalINR: r2(notional),
          reason: `AMBIGUOUS ENTRY (${String(e?.message || e).slice(0, 120)}) — UNKNOWN row booked: one-per-pair duplicate re-entry BLOCKED, watcher will surface for manual verify`,
        });
        saveJournal(j);
        return { ok: false, ambiguous: true, error: `CoinDCX order AMBIGUOUS (network/timeout — order MAY have filled): ${e?.message || e}. UNKNOWN position booked for ${pair}; duplicate re-entry blocked — verify on the exchange app.` };
      }
      pushEntry(j, { ...entry, status: 'FAILED', reason: String(e?.message || e).slice(0, 200) });
      saveJournal(j);
      return { ok: false, error: `CoinDCX order failed: ${e?.message || e}` };
    }
  });
}

// ---------------- live-fill reconciliation ----------------
/**
 * Resolves a live position whose create response carried no orderId/
 * fill data (status UNKNOWN) by asking the exchange what happened to the
 * order. Best-effort — any parse/network failure returns null and the
 * watcher retries on its next pass. Defensive about CoinDCX's response
 * shapes (object | array | {orders:[...]}, average_price | avg_price,
 * filled_quantity | quantity).
 */
function mapOrderToPositionState(o) {
  const st = String(o?.status || '').toLowerCase();
  const avg = Number(o?.average_price ?? o?.avg_price ?? o?.averagePrice ?? NaN);
  const filled = Number(o?.filled_quantity ?? o?.filledQuantity ?? o?.quantity ?? NaN);
  const dead = ['cancelled', 'canceled', 'rejected', 'expired'];
  const alive = ['open', 'partially', 'filled', 'complete', 'init', 'active'];
  return {
    status: dead.some(d => st.includes(d)) ? 'CANCELLED'
      : alive.some(l => st.includes(l)) ? 'OPEN' : 'UNKNOWN',
    entryPrice: Number.isFinite(avg) && avg > 0 ? avg : null,
    qty: Number.isFinite(filled) && filled > 0 ? filled : null,
    raw: st || 'unknown',
  };
}

async function reconcileLivePosition(p) {
  const creds = loadCredsForOrder();
  if (!creds || !p?.exchangeOrderId) return null;
  const id = String(p.exchangeOrderId);
  const find = (resp) => {
    if (Array.isArray(resp)) return resp.find(o => String(o?.id) === id) || null;
    if (Array.isArray(resp?.orders)) return resp.orders.find(o => String(o?.id) === id) || null;
    return resp && String(resp.id) === id ? resp : null;
  };
  try {
    const resp = await coindcxPrivate('/exchange/v1/orders/status', creds.apiKey, creds.secret, { id });
    const order = find(resp);
    if (order) return mapOrderToPositionState(order);
  } catch { /* fall through to the list endpoint */ }
  try {
    // v11.2 FIX: /exchange/v1/orders/list 404s (endpoint removed from the
    // CoinDCX API — verified against docs.coindcx.com 2026-09-17). The
    // live board is /exchange/v1/orders/active_orders (page/size/statuses).
    // Still-open orders are the reconciliation case that matters here;
    // terminal states stay covered by the primary orders/status call above.
    const resp = await coindcxPrivate('/exchange/v1/orders/active_orders', creds.apiKey, creds.secret, {
      page: '1', size: '50', statuses: ['open', 'partially_filled'],
    });
    const order = find(resp);
    if (order) return mapOrderToPositionState(order);
  } catch { /* give up this pass — retry on the next tick */ }
  return null;
}

// ---------------- position watcher (SL/TP enforcement) ----------------
/**
 * Runs under the journal lock. First reconciles UNKNOWN live positions
 * (so real exchange fills get SL/TP enforcement and true entry prices),
 * then checks every OPEN position against live CoinDCX tickers:
 *   • price ≤ SL (LONG) / ≥ SL (SHORT) → close, record loss
 *   • price ≥ TP2 → close (runner), record win
 *   • TP1 → alert only (let winners run to TP2)
 * Live positions close via market order; paper closes simulated.
 * Watch errors are PERSISTED (a failing stop-loss must never be
 * indistinguishable from a healthy position) and alerted on Telegram.
 * Returns the list of closures for logging/alerting.
 */
export async function watchPositions({ sendTelegram } = {}) {
  // v18.9 SINGLE-FLIGHT + LOCK DIET:
  //  * overlapping 60s interval ticks used to QUEUE unboundedly behind
  //    the journal lock when a pass ran long (feed outage + slow
  //    telegram = 60-120s holds) — a tick that lands mid-pass now joins
  //    that pass instead of stacking another.
  //  * the upstream ticker batch (8s timeout) + official-source gate now
  //    run BEFORE the lock; telegram sends run AFTER it. The lock covers
  //    journal mutation + the exchange close calls that must interleave
  //    with it — nothing else.
  if (_watchInflight) return _watchInflight;
  const pass = (async () => {
    const peek = loadJournal();
    const needCrypto = (peek.positions || []).some(p => p.status === 'OPEN' && p.market === 'CRYPTO');
    let tickers = [];
    if (needCrypto) { try { tickers = await fetchCoinDcxTickers(); } catch { tickers = []; } }
    const tradable = needCrypto ? officialPriceMap(tickers) : null;
    const { closures, watchErrors } = await withJournalLock(async () => {
      const j = loadJournal();
    const closures = [];
    const watchErrors = [];
    let dirty = false;
    const cfg = loadConfig();
    const pro = loadProTraderConfig(); // v7.0 partial-TP settings

    // --- reconcile UNKNOWN live positions ---
    for (const p of j.positions) {
      if (p.status !== 'UNKNOWN' || p.mode !== 'live') continue;
      // v21.1.1 [audit B11]: reconcile READ-ONLY hai (orders/status +
      // active_orders) — kill switch ke under bhi chalta rahe warna UNKNOWN
      // rows resolve hi nahi hote (pehle `break` tha — unblock kabhi nahi).
      if (!p.exchangeOrderId) {
        // v7.0.2: live UNKNOWN with NO order id used to be a silent
        // permanent dead zone — never reconciled, never SL/TP-watched,
        // never alerted. Surface it ONCE (~3 min in) so a human can close
        // it on the exchange; it still occupies a concentration slot.
        p.unknownSince = p.unknownSince || Date.now();
        const ageMin = (Date.now() - p.unknownSince) / 60_000;
        if (ageMin >= 3 && !p.unknownAlerted) {
          p.unknownAlerted = true;
          dirty = true;
          pushEntry(j, {
            kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair,
            reason: `UNKNOWN live position (no exchange order id) — ${Math.round(ageMin)}min se unresolved. Exchange app me check karke manually close karo — SL/TP is NOT being enforced on it.`,
          });
          watchErrors.push({ pair: p.pair, reason: 'UNKNOWN live position — no order id, manual close needed' });
        }
        continue;
      }
      const rec = await reconcileLivePosition(p).catch(() => null);
      if (!rec) continue;
      if (rec.status === 'OPEN') {
        if (rec.entryPrice != null && rec.entryPrice !== p.entryPrice) p.entryPrice = rec.entryPrice;
        if (rec.qty != null && rec.qty !== p.qty) p.qty = rec.qty;
        p.status = 'OPEN';
        p.reconciledAt = Date.now();
        dirty = true;
        pushEntry(j, {
          kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair,
          reason: `Order ${p.exchangeOrderId} reconciled: ${rec.raw} @ ${rec.entryPrice ?? p.entryPrice} — position now tracked`,
        });
      } else if (rec.status === 'CANCELLED') {
        p.status = 'CANCELLED';
        p.closedAt = Date.now();
        p.closeReason = `Exchange reports order ${rec.raw}`;
        dirty = true;
        pushEntry(j, {
          kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair,
          reason: `Order ${p.exchangeOrderId} ${rec.raw} — live position reconciled to CANCELLED (no coins moved)`,
        });
        watchErrors.push({ pair: p.pair, reason: `order ${rec.raw}` });
      }
      // rec.status UNKNOWN → keep trying next pass
    }

    const open = j.positions.filter(p => p.status === 'OPEN');
    // v6.8: India positions → watchIndiaPositions (Dhan); FUTURES →
    // watchFuturesPositions (futures.js); THIS watcher stays SPOT-crypto
    // only (spot tickers don't price "B-BTC_USDT" rows — the filter made
    // them look stuck-open with no LTP).
    const openCrypto = open.filter(p => p.market === 'CRYPTO');
    if (openCrypto.length > 0) {
      // v18.9: byPair is the OFFICIAL-PRICE map (synthetic + deep-stale
      // legs rejected) — a live SL/TP decision must never ride a
      // Binance×fx approximation or a 3-min-old cached print.
      const byPair = tradable;

      // v18.9 FEED-DEGRADED ALARM — the old code silently `continue`d
      // every position when the feed came back empty/degraded: a dead
      // stop-loss was indistinguishable from a healthy one exactly in
      // the catastrophic case. One throttled journal + telegram alarm
      // per hour (the philosophy this file already promises at line ~790).
      if (!byPair) {
        const gateDay = todayIST();
        if (_lastFeedGateDay !== gateDay || Date.now() - _lastFeedGateAt > 3600_000) {
          _lastFeedGateDay = gateDay; _lastFeedGateAt = Date.now();
          let src = null;
          try { src = typeof lastTickerSource === 'function' ? String(lastTickerSource()) : null; } catch { /* partial mock */ }
          pushEntry(j, {
            kind: 'WATCH_ERROR', day: gateDay, pair: 'ALL',
            reason: `PRICE FEED degraded (${src || 'unreachable'}) — koi OFFICIAL CoinDCX price nahi (synthetic/stale legs SL/TP trigger nahi kar sakte). LIVE stops SUSPENDED is pass — feed restore hote hi resume. False stop-out protect.`,
          });
          dirty = true;
          watchErrors.push({ pair: 'ALL', reason: `official price feed degraded (${src || 'down'}) — SL/TP checks suspended this pass` });
        }
      } else {
        const missing = openCrypto.filter(p => !byPair.has(p.pair)).map(p => p.pair);
        if (missing.length > 0 && Date.now() - _lastFeedGapAt > 1800_000) {
          _lastFeedGapAt = Date.now();
          pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: missing[0], reason: `no official ticker for ${missing.join(', ')} — un pairs ki SL/TP check is pass skip (partial feed outage)` });
          dirty = true;
          watchErrors.push({ pair: missing[0], reason: `no official price (${missing.length} pair) — checks skipped` });
        }
      }

      // v10.6 CROSS-EXCHANGE VALIDATION (Pro Upgrade #3): a single bad
      // print must not trigger a false stop-out. Every DISTINCT base
      // in the open book is validated once per pass against Binance
      // (validator, never a trading feed). A fresh cross-venue gap →
      // this pass SKIPS all SL/TP/trailing/liq checks for that base
      // (the wick gets a chance to revert); a confirmed-reverted wick
      // closes the episode and lands in the journal (auditable);
      // a sustained gap is accepted as a real move.
      const wickVerdicts = new Map(); // base → verdict|null
      for (const p of openCrypto) {
        const base = String(p.pair || '').replace(/INR$/, '');
        if (!base || wickVerdicts.has(base)) continue;
        // v18.9: no official price map → no wick validation either (the
        // loop used to crash on the null map exactly when the feed was
        // degraded — the pass then aborted before the feed alarm landed).
        if (!byPair) break;
        wickVerdicts.set(base, await validateTick({ market: 'CRYPTO', base, price: byPair.get(p.pair) }).catch(() => null));
      }
      for (const [base, wv] of wickVerdicts.entries()) {
        if (wv?.episode === 'wick') {
          const entry = wickJournalEntry({ market: 'CRYPTO', base, pair: `${base}INR`, verdict: wv });
          entry.day = todayIST();
          pushEntry(j, entry);
          dirty = true;
        }
      }

      for (const p of openCrypto) {
        const price = byPair ? byPair.get(p.pair) : undefined;
        if (!(price > 0)) continue;
        // v18.9 AMBIGUITY COOLDOWN — a close attempt that died ambiguously
        // (timeout/network) MAY have filled on the exchange; re-sending the
        // same market sell every 60s could double-sell. 5-minute defer with
        // the honest journal note (definitive [4xx] rejections keep the
        // 60s retry — those moved no coins).
        if (p.closeRetryAfter && Date.now() < p.closeRetryAfter) continue;
        // v21.1.1 [audit B11]: KILL = NO NEW ENTRIES — EXITS AB ENFORCED.
        // v18.9 ka behavior (kill ON → live SL/TP closes suspend, position
        // manual control me) DANGEROUS inconsistency thi: futures desk kill
        // ke under bhi SL/TP enforce karta tha, aur panic-me-kill dabane
        // wala trader apne STOP LOSSES disarm karna nahi chahta — wo bot
        // rokna chahta hai. Ab dono desks same semantics: entries block,
        // exits (SL/TP/liq) chalte hain. Ek-baar journal note per position.
        if (p.mode === 'live' && cfg.killSwitch) {
          const kd = todayIST();
          if (p._killExitsNoteDay !== kd) {
            p._killExitsNoteDay = kd;
            dirty = true;
            pushEntry(j, {
              kind: 'WATCH_ERROR', day: kd, pair: p.pair,
              reason: 'KILL SWITCH ON — naye entries blocked hai; is LIVE position ke SL/TP exits AB NORMAL ENFORCE honge (v21.1.1 fix — pehle suspend hote the, jo dangerous tha).',
            });
          }
          // NO continue — watcher exits proceed under kill
        }
        const _wv = wickVerdicts.get(String(p.pair || '').replace(/INR$/, ''));
        if (_wv?.action === 'SUPPRESS') {
          // fresh cross-venue deviation — do not act on this print
          // (checked again next pass; reverts → wick episode closes,
          // persists → accepted as a real move).
          continue;
        }

        // v6.6 LEVERAGE: liquidation check comes FIRST — if the price is
        // beyond the liquidation estimate the position is gone at the
        // exchange (or would be, on paper) regardless of where the SL sits.
        // Paper closes AT the liquidation price (honest simulation: loss
        // ≈ the whole margin); live positions close via exit_positions.
        if (p.leverage > 1 && p.liquidation != null && p.liquidation > 0) {
          const long = p.side === 'LONG';
          if (long ? price <= p.liquidation : price >= p.liquidation) {
            let closed = false;
            if (p.mode === 'live' && coindcxConnected()) {
              try {
                const creds = loadCredsForOrder();
                if (creds) {
                  const mp = await getMarginPairName(p.pair, creds);
                  // v20.9.3 FIX (H1): CoinDCX wraps rejections inside HTTP 200
                  // ({code:4xx,message}) — the ONLY money call-site still not
                  // verdict-checked. The old code booked p.status='CLOSED' +
                  // 'LIQUIDATED (est.)' + full-loss PnL even when the exchange
                  // REJECTED the margin exit → real leveraged position left
                  // open on the exchange with no stop and no retry. Throw so
                  // the catch below records WATCH_ERROR and the watcher retries
                  // (same discipline as the SL/TP margin exit above).
                  const resp = await coindcxPrivate('/exchange/v1/margin/orders/exit_positions', creds.apiKey, creds.secret, marginExitBody({ marginPair: mp.pair, side: p.side }));
                  const lerr = coindcxRespError(resp);
                  if (lerr) throw new Error(lerr);
                  closed = true;
                }
              } catch (e) {
                pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `margin exit failed: ${String(e?.message || e).slice(0, 160)}` });
                dirty = true;
                watchErrors.push({ pair: p.pair, reason: String(e?.message || e).slice(0, 120) });
              }
            } else if (p.mode !== 'live') {
              closed = true; // paper liquidation always executes
            } else {
              // v7.0.2 CRITICAL FIX: LIVE but CoinDCX creds gone — the old
              // code paper-simulated the close while the real leveraged
              // position kept bleeding with no stop. Persist + retry instead.
              pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: 'LIVE liq-exit BLOCKED (CoinDCX disconnected) — NOT paper-closing, will retry' });
              dirty = true;
              watchErrors.push({ pair: p.pair, reason: 'live liq-exit blocked (creds) — retrying' });
            }
            if (closed) {
              const liqPrice = p.liquidation;
              // v18.9: fees booked on the liquidation slice too (honest loss)
              const feesINR = cryptoLegFeesINR(p.entryPrice, liqPrice, p.qty);
              const pnlINR = (p.side === 'LONG' ? liqPrice - p.entryPrice : p.entryPrice - liqPrice) * p.qty - feesINR;
              p.status = 'CLOSED';
              p.closedAt = Date.now();
              p.closePrice = liqPrice;
              p.pnlINR = r2(pnlINR);
              p.feesINR = feesINR;
              p.closeReason = 'LIQUIDATED (est.)';
              settlePositionOutcome(p, 'LIQUIDATED (est.)'); // v6.7 ledger
              dirty = true;
              pushEntry(j, {
                kind: 'CLOSE', day: todayIST(), pair: p.pair, mode: p.mode, source: p.source,
                qty: p.qty, entryPrice: p.entryPrice, closePrice: liqPrice, pnlINR: r2(pnlINR), feesINR,
                reason: `LIQUIDATED (est. @ ${p.leverage}x — price crossed the liquidation estimate)`,
              });
              closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: 'LIQUIDATED (est.)' });
            }
            continue; // position resolved (or exit failed + persisted) — next position
          }
        }

        // v6.5 TRAILING SL — track the peak, ratchet the stop (never loosen).
        // The initial risk R is frozen at open; once profit ≥ armR×R the SL
        // locks to breakeven, then trails peak − offsetR×R. Every move lands
        // in the journal as a TRAIL entry (audit trail, same as orders).
        if (cfg.trailEnabled && p.sl != null && p.sl > 0) {
          const long = p.side === 'LONG';
          const prevPeak = Number(p.peakPrice);
          const peak = long
            ? Math.max(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price)
            : Math.min(Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : price, price);
          // v18.1 FIX: compute BEFORE assigning — peakMoved tells us whether
          // anything actually changed this pass.
          const newPeak = pRound(peak);
          const peakMoved = p.peakPrice !== newPeak;
          if (peakMoved) p.peakPrice = newPeak;
          const risk = Number(p.initialRisk) > 0 ? Number(p.initialRisk) : Math.abs(p.entryPrice - p.sl);
          let trailLanded = false;
          if (risk > 0) {
            const trail = computeTrailSl({
              side: p.side, entryPrice: p.entryPrice, peakPrice: peak, currentSl: p.sl,
              initialRisk: risk, price, armR: cfg.trailArmR, offsetR: cfg.trailOffsetR,
            });
            if (trail) {
              pushEntry(j, {
                kind: 'TRAIL', day: todayIST(), pair: p.pair, market: 'CRYPTO',
                reason: `SL ${trail.stage}: ${p.sl} → ${trail.sl} (peak ${pRound(peak)})`,
                from: p.sl, to: trail.sl,
              });
              p.sl = trail.sl;
              p.trailing = trail.stage;
              trailLanded = true;
            }
          }
          // v18.1 FIX: dirty ONLY when the peak actually moved or a trail
          // landed. The old unconditional dirty=true re-persisted the whole
          // journal on EVERY 60s watch pass for every open position — even
          // with zero price movement: pure disk churn + backup-window noise.
          // An idle position now costs zero I/O.
          if (peakMoved || trailLanded) dirty = true;
        }

        const long = p.side === 'LONG';

        // ---- v7.0 PRO TRADER: 3-tier partial take-profit ----
        // T1 → close tp1ClosePct% of the ORIGINAL qty + SL → breakeven;
        // T2 → close tp2ClosePct% of the ORIGINAL qty + SL → T1 (profit
        // lock); the remaining runner trails until time-exit/SL/TP2.
        // Scoped to AGENT-sourced positions — the manual desk keeps the
        // classic full-exit behavior (no silent behavior change for a
        // human's click). All legs run through the SAME gauntlet money
        // paths (market sell/buy); failures persist + retry next tick.
        if (pro.partialTpEnabled && p.source === 'agent' && !p.partialTpOff && !(Number(p.leverage) > 1)) {
          // v18.9: MARGIN positions are excluded from partial TP — the old
          // leg opened an OPPOSITE-SIDE margin position (CoinDCX margin is
          // per-side; a partial "close" via an opposite order nets a NEW
          // untracked position that the later exit_positions full-exit
          // leaves behind with margin locked). Leveraged books exit via
          // exit_positions only (full-exit discipline).
          const t1 = Number(p.tp) > 0 ? Number(p.tp) : null;
          const t2 = Number(p.tp2) > 0 ? Number(p.tp2) : null;
          const hit = (lvl) => lvl != null && (long ? price >= lvl : price <= lvl);
          const partialNotes = [];

          // T1 leg (v21.1.0: ambiguous-partial 5-min hold bhi yahan gate karta
          // hai — futures desk ka partialRetryAfter pattern, spot pe port)
          if (!p.tp1Hit && hit(t1) && !(p.partialRetryAfter && Date.now() < p.partialRetryAfter)) {
            const leg = await partialCloseSpotLeg(j, p, price, { stage: 'T1', pct: pro.tp1ClosePct });
            if (leg.ok) {
              if (pro.breakEvenAfterTp1 && p.status !== 'CLOSED') {
                const prevSl = p.sl;
                p.sl = ratchetSl(p.side, p.sl, p.entryPrice);
                if (prevSl !== p.sl) {
                  pushEntry(j, {
                    kind: 'TRAIL', day: todayIST(), pair: p.pair, market: 'CRYPTO',
                    reason: `BREAKEVEN LOCK (T1 hit): SL ₹${r2(prevSl)} → ₹${r2(p.sl)} — runner ab risk-free`,
                    from: prevSl, to: p.sl,
                  });
                }
              }
              partialNotes.push(`T1 ${leg.closedQty} @ ${pRound(price)} → +₹${r2(leg.legPnlINR)} · SL→${pro.breakEvenAfterTp1 ? 'breakeven' : 'unchanged'}`);
            } else {
              pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `T1 partial close failed: ${String(leg.error || '').slice(0, 160)}` });
              watchErrors.push({ pair: p.pair, reason: `T1 partial failed: ${String(leg.error || '').slice(0, 120)}` });
            }
            dirty = true;
          }

          // T2 leg (fires the same pass when price gapped past both)
          if (p.tp1Hit && !p.tp2Hit && hit(t2) && p.status === 'OPEN' && !(p.partialRetryAfter && Date.now() < p.partialRetryAfter)) {
            const leg = await partialCloseSpotLeg(j, p, price, { stage: 'T2', pct: pro.tp2ClosePct });
            if (leg.ok) {
              if (t1 != null && p.status !== 'CLOSED') {
                const prevSl = p.sl;
                p.sl = ratchetSl(p.side, p.sl, t1);
                if (prevSl !== p.sl) {
                  pushEntry(j, {
                    kind: 'TRAIL', day: todayIST(), pair: p.pair, market: 'CRYPTO',
                    reason: `PROFIT LOCK (T2 hit): SL ₹${r2(prevSl)} → T1 ₹${r2(p.sl)}`,
                    from: prevSl, to: p.sl,
                  });
                }
              }
              partialNotes.push(`T2 ${leg.closedQty} @ ${pRound(price)} → +₹${r2(leg.legPnlINR)} · SL→T1`);
            } else {
              pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `T2 partial close failed: ${String(leg.error || '').slice(0, 160)}` });
              watchErrors.push({ pair: p.pair, reason: `T2 partial failed: ${String(leg.error || '').slice(0, 120)}` });
            }
            dirty = true;
          }

          if (partialNotes.length > 0) {
            closures.push({
              pair: p.pair, mode: p.mode, pnlINR: null, partial: true,
              reason: `PARTIAL TP — ${partialNotes.join(' · ')}`,
            });
          }
          if (p.status !== 'OPEN') continue; // partials closed the whole book
        }

        let close = null;
        if (p.sl != null && (long ? price <= p.sl : price >= p.sl)) close = { reason: 'STOP-LOSS hit', price, kind: 'SL' };
        else if (p.tp2 != null && !p.tp2Hit && (long ? price >= p.tp2 : price <= p.tp2)) close = { reason: 'TARGET-2 hit', price, kind: 'TP2' };
        if (!close) continue;

        // v21.1.1 [audit B3]: DUST GUARD HOISTED — pehle yahan order-placement ke
        // BAAD aata tha: sub-minQty book pe market-sell pehle FIRE hoti thi, phir
        // check. Exchange ne accept kiya to journal row hamesha OPEN reh jaati
        // (har 60s pe re-sell fail = WATCH_ERROR spam); reject kiya to catch-block
        // wala spam — guard apne hi purpose tak kabhi pahunchta hi nahi tha.
        // Ab pehle check, phir order.
        if (p.mode === 'live' && !(p.leverage > 1)) {
          const dustMeta = await getPairMeta(p.pair).catch(() => null);
          if (dustMeta && dustMeta.minQty > 0 && p.qty > 0 && p.qty < dustMeta.minQty) {
            if (!p.dustBelowMin) {
              p.dustBelowMin = true;
              dirty = true;
              pushEntry(j, {
                kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair,
                reason: `DUST GUARD — remaining ${p.qty} is below the exchange minimum ${dustMeta.minQty}: market-sell reject loop se bachne ke liye auto-close skip. Exchange app me manually dispose karo.`,
              });
              watchErrors.push({ pair: p.pair, reason: `qty below exchange minimum (${p.qty} < ${dustMeta.minQty}) — manual disposal needed` });
            }
            continue;
          }
        }

        let closed = false;
        if (p.mode === 'live' && coindcxConnected()) {
          try {
            const creds = loadCredsForOrder();
            if (creds) {
              if (p.leverage > 1) {
                // v6.6: margin positions exit through the margin API
                const mp = await getMarginPairName(p.pair, creds);
                const mresp = await coindcxPrivate('/exchange/v1/margin/orders/exit_positions', creds.apiKey, creds.secret, marginExitBody({ marginPair: mp.pair, side: p.side }));
                // v20.9.1 [H1]: wrapped rejection = stop nahi laga, position
                // exchange pe OPEN hai — closed=true banana fake CLOSE hota.
                const merr = coindcxRespError(mresp);
                if (merr) throw new Error(merr);
              } else {
                // v12.1 LIVE-FIX: `market` (not `pair`) + `market_order` —
                // the spot order contract (see the entry-path note).
                const sresp = await coindcxPrivate('/exchange/v1/orders/create', creds.apiKey, creds.secret, {
                  side: long ? 'sell' : 'buy',
                  market: p.pair,
                  order_type: 'market_order',
                  total_quantity: String(p.qty),
                  hidden: true,
                });
                // v20.9.1 [H1]: 200-wrapped rejection pehle closed=true book
                // kar deta tha — journal CLOSED + PnL + daily-cap update,
                // jabki real coins/position exchange pe stop-less khule the.
                const serr = coindcxRespError(sresp);
                if (serr) throw new Error(serr);
              }
              closed = true;
            }
          } catch (e) {
            // Close failed — keep position open, try again next tick.
            // Persist the failure: a dead stop-loss must never look healthy.
            // v18.9: AMBIGUOUS (timeout/network) failures defer the re-send
            // 5 minutes — the order MAY have filled; a 60s re-send could
            // double-sell the same book.
            const ambiguous = isAmbiguousTransportError(e);
            if (ambiguous) p.closeRetryAfter = Date.now() + 5 * 60_000;
            pushEntry(j, {
              kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair,
              reason: (ambiguous ? 'CLOSE TIMEOUT/NETWORK — order MAY have executed on the exchange; re-send deferred 5 min (double-sell protect). ' : '') + String(e?.message || e).slice(0, 160),
            });
            dirty = true;
            watchErrors.push({ pair: p.pair, reason: String(e?.message || e).slice(0, 120) + (ambiguous ? ' (defer 5m)' : '') });
            continue;
          }
        } else if (p.mode !== 'live') {
          closed = true; // paper close is always executable
        } else {
          // v7.0.2 CRITICAL FIX: LIVE position + creds revoked/missing —
          // the old code booked a fake CLOSE at the ticker price while the
          // real exchange position stayed open with NO stop. Persist + retry.
          pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `LIVE ${close.kind} close BLOCKED (CoinDCX disconnected) — NOT paper-closing, will retry` });
          dirty = true;
          watchErrors.push({ pair: p.pair, reason: `live ${close.kind} close blocked (creds) — retrying` });
          continue;
        }
        if (!closed) continue;

        // v18.9 FEE HONESTY — booked P&L is NET of both-side taker fees
        // (AI_COINDCX_FEE_PCT, default 0.10%/side): the daily-loss cap and
        // the track record were systematically overstated on gross math.
        // v20.3: paper closes fill ADVERSELY (exit-side slippage) — the
        // trigger level still decides WHEN to close, the fill price is
        // what a market order would actually get. LIVE keeps the
        // exchange's reconciled price.
        const exitPx = p.mode === 'paper' ? paperExitPrice(price, p.side, paperSlipBps()) : price;
        const feesINR = cryptoLegFeesINR(p.entryPrice, exitPx, p.qty);
        const pnlINR = (long ? exitPx - p.entryPrice : p.entryPrice - exitPx) * p.qty - feesINR;
        p.status = 'CLOSED';
        p.closedAt = Date.now();
        p.closePrice = exitPx;
        p.pnlINR = r2(pnlINR);
        p.feesINR = feesINR;
        p.closeReason = close.reason;
        settlePositionOutcome(p, close.reason); // v6.7 ledger
        dirty = true;
        pushEntry(j, {
          kind: 'CLOSE', day: todayIST(), pair: p.pair, mode: p.mode, source: p.source,
          qty: p.qty, entryPrice: p.entryPrice, closePrice: exitPx, pnlINR: r2(pnlINR), feesINR, reason: close.reason,
          ...(p.mode === 'paper' ? { slipNote: `exit -${paperSlipBps()}bps slippage (practice realism)` } : {}),
        });
        closures.push({ pair: p.pair, mode: p.mode, pnlINR: p.pnlINR, reason: close.reason });
      }
    }

    if (dirty) saveJournal(j); // WATCH_ERROR entries + reconciliations persist too
    return { closures, watchErrors };
    }); // withJournalLock

    // v18.9: telegram sends run OUTSIDE the journal lock (up to 30s of
    // awaited I/O no longer starves executeSignal / panic closes).
    if (typeof sendTelegram === 'function') {
      const fullClosures = closures.filter(c => !c.partial);
      const partialClosures = closures.filter(c => c.partial);
      if (fullClosures.length > 0) {
        try {
          await sendTelegram(`🤖 <b>AI Trading</b> — position closed\n${fullClosures.map(c => `• ${c.pair} (${c.mode}) — ${c.reason}: ₹${c.pnlINR > 0 ? '+' : ''}${c.pnlINR}`).join('\n')}`);
        } catch { /* best-effort */ }
      }
      if (partialClosures.length > 0) {
        try {
          await sendTelegram(`🤖 <b>PRO TRADER — partial take-profit booked</b>\n${partialClosures.map(c => `• ${c.reason}`).join('\n')}`);
        } catch { /* best-effort */ }
      }
      if (watchErrors.length > 0) {
        // v21.1.1 [audit B10]: per-pair 30-min throttle — persistent failures
        // (bad keys, dust loop, below-min) pehle har 60s ek Telegram bhejte the
        // → channel mute ka guaranteed raasta. Same pair+reason class ab
        // 30 min me sirf ek baar alert hota hai; WATCH_ERROR journal entries
        // pura audit trail rakhte hain.
        const now = Date.now();
        const fresh = watchErrors.filter(w => {
          const key = `${w.pair}::${String(w.reason).split('(')[0].slice(0, 60)}`;
          const last = _watchErrAlerts.get(key) || 0;
          if (now - last < 30 * 60_000) return false;
          _watchErrAlerts.set(key, now);
          return true;
        });
        if (_watchErrAlerts.size > 200) { // bounded
          for (const k of _watchErrAlerts.keys()) { _watchErrAlerts.delete(k); if (_watchErrAlerts.size <= 100) break; }
        }
        if (fresh.length > 0) {
          try {
            await sendTelegram(`🤖 ⚠️ <b>AI Trading</b> — close/reconcile FAILED (will retry)
${fresh.map(c => `• ${c.pair} — ${c.reason}`).join('\n')}\nCheck CoinDCX keys/balance — SL/TP cannot execute while this fails.`);
          } catch { /* best-effort */ }
        }
      }
    }
    return closures;
  })();
  _watchInflight = pass;
  try { return await pass; } finally { _watchInflight = null; }
}
// v18.9 single-flight + feed-gate throttle state
let _watchInflight = null;
// v21.1.1 [audit B10]: per-pair watch-error telegram throttle (pair::reason → last alert ts)
const _watchErrAlerts = new Map();
let _lastFeedGateDay = null, _lastFeedGateAt = 0, _lastFeedGapAt = 0;

function loadCredsForOrder() {
  const c = loadJSON('mcp-coindcx.json', {});
  return c?.apiKey && c?.secret ? { apiKey: c.apiKey, secret: c.secret } : null;
}

// ---------------- v7.0 PRO TRADER: partial take-profit config ----------------
// agent.js OWNS 'ai-agent-config.json' (it also statically imports THIS
// module — a static back-import would be circular, so the pro-trader
// block is read directly from the same durable file. Defaults mirror
// AGENT_DEFAULTS in agent.js — change both together).
const AGENT_CONFIG_FILE_MIRROR = 'ai-agent-config.json';
export function loadProTraderConfig() {
  const saved = loadJSON(AGENT_CONFIG_FILE_MIRROR, {}) || {};
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  // v7.0.2: same T1+T2 ≤ 90 invariant agent.js enforces — a hand-edited /
  // legacy config with a bigger split would try to close more than 100%
  // of the position (live: net-short flip on the exchange).
  const tp1 = Math.max(10, Math.min(80, n(saved.tp1ClosePct, 40)));
  let tp2 = Math.max(10, Math.min(80, n(saved.tp2ClosePct, 40)));
  if (tp1 + tp2 > 90) { const over = tp1 + tp2 - 90; tp2 = Math.max(10, tp2 - over); }
  return {
    partialTpEnabled: saved.partialTpEnabled !== false,   // default ON
    tp1ClosePct: tp1,
    tp2ClosePct: tp2,
    breakEvenAfterTp1: saved.breakEvenAfterTp1 !== false, // default ON
  };
}

/** SL ratchet — a stop may only tighten, never loosen (LONG: max, SHORT: min).
 *  v7.0 breakeven/T1 locks ride the same never-loosen rule as the ATR trail.
 *  v21.23.12 [v21.23.9 DOCTRINE SWEEP]: `side === 'LONG'` binary me koi
 *  bhi non-LONG/SHORT vocabulary (BUY) ULTA (SHORT) ratchet le jaata tha —
 *  ek BUY-vocab long position ka SL WIDEN ho sakta tha. Honest alias map;
 *  unknown → current hi rehta hai jab tak valid SL ho (fail-honest —
 *  unknown side par SL KABHI move nahi hota), initial set (current>0
 *  nahi) unknown par bhi refuse hota hai (galat-side SL arm nahi). */
export function ratchetSl(side, currentSl, candidate) {
  if (!(candidate > 0)) return currentSl;
  if (!(currentSl > 0)) {
    const _LONG = { LONG: true, BUY: true, SHORT: false, SELL: false }[String(side || '').toUpperCase()];
    return _LONG == null ? currentSl : candidate; // unknown vocab → no initial arm (honest)
  }
  const _LONG = { LONG: true, BUY: true, SHORT: false, SELL: false }[String(side || '').toUpperCase()];
  if (_LONG == null) return currentSl;
  return _LONG ? Math.max(currentSl, candidate) : Math.min(currentSl, candidate);
}

/** v7.0: the exit stage shown in the UI + journal stamps. */
export function exitStageOf(p) {
  if (p.status === 'OPEN' || p.status === 'UNKNOWN') {
    if (p.tp2Hit) return 'RUNNER';
    if (p.tp1Hit) return 'T1_HIT';
    return 'ENTRY';
  }
  return 'CLOSED';
}

// ---------------- v7.0 PRO TRADER: partial close leg (spot desk) ----------------
/**
 * Books ONE partial take-profit leg on an agent position:
 *   • qty  = pct% of the ORIGINAL entry qty (frozen at the first leg)
 *   • LIVE: opposite-side market order for that fraction (spot API
 *     supports partial quantity; margin positions go through an
 *     opposite margin order — exit_positions is full-exit only)
 *   • PAPER: simulated (always executable)
 *   • journals a PARTIAL_TP entry + stamps the tamper-evident ledger leg
 *   • edge cases: qty rounds to 0 → partials disabled for the position
 *     (honest fallback to the classic full-exit); remaining rounds to 0
 *     → the whole remaining book closes as the final leg.
 * Returns { ok, closedQty, legPnlINR, error?, disabled? }.
 */
async function partialCloseSpotLeg(j, p, price, { stage, pct }) {
  try {
    const long = p.side === 'LONG';
    const originalQty = Number(p.originalQty) > 0 ? Number(p.originalQty) : Number(p.qty);
    // v20.9.1 [H3]: reconcile/manual-partial ne p.qty shrink ki ho to
    // ORIGINAL ka pct over-close karta — cap: pct% of original, par current se zyada nahi.
    const { qty: partialQty, meta } = await roundQty(p.pair, Math.min((originalQty * pct) / 100, Number(p.qty)));

    // too small to slice at exchange precision → tiered exits are not
    // possible for this position: disable them (legacy behavior resumes)
    if (!(partialQty > 0)) {
      p.partialTpOff = true;
      pushEntry(j, {
        kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair,
        reason: `partial TP disabled for this position — ${pct}% of ${originalQty} rounds to 0 at ${p.pair} precision (classic full TP2 exit applies)`,
      });
      return { ok: false, disabled: true, error: 'qty rounds to 0' };
    }
    // v18.9 EXCHANGE-MINIMUM GUARD — a leg below minQty would 422 every
    // 60s forever (WATCH_ERROR + telegram spam, no exit ever happens).
    // Same honest disable as the rounds-to-0 case: the full TP2/SL exit
    // (whole remaining book ≥ min) takes over.
    if (meta.minQty > 0 && partialQty < meta.minQty) {
      p.partialTpOff = true;
      pushEntry(j, {
        kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair,
        reason: `partial TP disabled — ${pct}% of ${originalQty} = ${partialQty} is below the exchange minimum ${meta.minQty} (classic full TP2 exit applies)`,
      });
      return { ok: false, disabled: true, error: `leg ${partialQty} below exchange minimum ${meta.minQty}` };
    }

    // LIVE: sell/buy the fraction on the exchange first — only book
    // the journal when real coins moved (paper books immediately).
    if (p.mode === 'live') {
      if (!coindcxConnected()) {
        // v20.9.1 [H2]: LIVE + disconnected pe paper-book KABHI NAHI —
        // phantom T1 latch + BE-lock + bookedPnl exchange-unchanged.
        pushEntry(j, { kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, reason: `LIVE ${stage} partial BLOCKED (CoinDCX disconnected) — NOT paper-booking the leg, will retry` });
        return { ok: false, error: 'LIVE partial blocked (no CoinDCX connection) — retrying next pass' };
      }
      const creds = loadCredsForOrder();
      if (!creds) return { ok: false, error: 'CoinDCX credentials unreadable' };
      if (p.leverage > 1) {
        // margin positions: opposite-side margin order for the fraction
        const mp = await getMarginPairName(p.pair, creds);
        const marginINR = r2((partialQty * price) / p.leverage);
        const body = marginOrderBody({
          marginPair: mp.pair, side: long ? 'SHORT' : 'LONG',
          qty: partialQty, leverage: p.leverage, marginINR,
        });
        const mresp = await coindcxPrivate('/exchange/v1/margin/orders', creds.apiKey, creds.secret, body);
        // v20.9.1 [H1]: wrapped rejection = fraction move nahi hua — leg book nahi hoga.
        const merr = coindcxRespError(mresp);
        if (merr) throw new Error(merr);
      } else {
        // v12.1 LIVE-FIX: `market` (not `pair`) + `market_order` — the
        // spot order contract (see the entry-path note).
        const sresp = await coindcxPrivate('/exchange/v1/orders/create', creds.apiKey, creds.secret, {
          side: long ? 'sell' : 'buy',
          market: p.pair,
          order_type: 'market_order',
          total_quantity: String(partialQty),
          hidden: true,
        });
        // v20.9.1 [H1]: 200-wrapped rejection ({code,message} with HTTP 200)
        // pehle leg book hota tha — tp1Hit latch + SL breakeven-lock +
        // phantom bookedPnl, sab exchange-unchanged.
        const serr = coindcxRespError(sresp);
        if (serr) throw new Error(serr);
      }
    }

    // ---- book the leg (both desks reach here once coins/qty are real) ----
    // v18.9 FEE HONESTY — the leg's booked P&L is NET of both-side taker
    // fees on the closed slice (entry-side share + exit-side turnover).
    // v20.3: paper partial legs ALSO fill adversely (exit-side slippage),
    // same realism as the entry + the full close.
    const exitPx = p.mode === 'paper' ? paperExitPrice(price, p.side, paperSlipBps()) : price;
    const legFeesINR = cryptoLegFeesINR(p.entryPrice, exitPx, partialQty);
    const legPnlINR = (long ? exitPx - p.entryPrice : p.entryPrice - exitPx) * partialQty - legFeesINR;
    p.originalQty = originalQty;
    // remaining qty rounds at the INSTRUMENT precision (r2 would eat
    // sub-0.01 runners alive: 0.006 → 0.01)
    p.qty = Math.floor((Number(p.qty) - partialQty) * 10 ** meta.qtyPrecision) / 10 ** meta.qtyPrecision;
    p.bookedPnlINR = r2((Number(p.bookedPnlINR) || 0) + legPnlINR);
    p.feesINR = r2((Number(p.feesINR) || 0) + legFeesINR);
    if (stage === 'T1') p.tp1Hit = true;
    if (stage === 'T2') p.tp2Hit = true;
    p.exitStage = exitStageOf(p);

    // remaining book too small to keep? → this leg closes the position
    if (!(Number(p.qty) > 0)) {
      p.status = 'CLOSED';
      p.closedAt = Date.now();
      p.closePrice = exitPx;
      p.pnlINR = 0; // fully realized via partial legs (bookedPnlINR carries it)
      p.closeReason = `PARTIAL TP (${stage}) closed the full book`;
      try { settlePositionOutcome(p, p.closeReason); } catch { /* best-effort */ }
      pushEntry(j, {
        kind: 'CLOSE', day: todayIST(), pair: p.pair, mode: p.mode, source: p.source,
        qty: 0, entryPrice: p.entryPrice, closePrice: exitPx, pnlINR: 0,
        reason: `${stage} leg closed the full remaining book (qty too small to split)`,
      });
    }

    pushEntry(j, {
      kind: 'PARTIAL_TP', day: todayIST(), pair: p.pair, mode: p.mode, market: 'CRYPTO',
      source: p.source, stage,
      qty: partialQty, price: pRound(exitPx), pnlINR: r2(legPnlINR), feesINR: legFeesINR,
      remainingQty: p.qty, bookedPnlINR: p.bookedPnlINR, exitStage: p.exitStage,
      reason: `${stage} partial: closed ${pct}% (${partialQty} of ${originalQty}) @ ${pRound(exitPx)} — booked ₹${r2(legPnlINR)} (net of ₹${legFeesINR} fees) · remaining ${p.qty}`,
      ...(p.mode === 'paper' ? { slipNote: `exit -${paperSlipBps()}bps slippage (practice realism)` } : {}),
    });
    try { markPartialOutcome(p.ledgerEntryId, { stage, qty: partialQty, price: exitPx, pnlINR: legPnlINR }); } catch { /* best-effort */ }

    return { ok: true, closedQty: partialQty, legPnlINR: r2(legPnlINR), remainingQty: p.qty };
  } catch (e) {
    // v21.1.0 AMBIGUOUS-PARTIAL GUARD (Phase-2 audit fix #5): timeout/abort/
    // network failure on the LIVE partial market order means the leg MAY have
    // filled — 60s watcher pe re-send DOUBLE-SELL karta tha (tp1Hit latch bhi
    // nahi laga kyunki leg fail hua). Futures desk ka v20.3 pattern port:
    // 5-minute hold + honest journal note; definitive [4xx] rejections
    // (jinhone coins move nahi kiye) next-tick retry rakhte hain.
    if (p.mode === 'live' && isAmbiguousTransportError(e)) {
      p.partialRetryAfter = Date.now() + 5 * 60_000;
      try {
        pushEntry(j, {
          kind: 'WATCH_ERROR', day: todayIST(), pair: p.pair, market: 'CRYPTO',
          reason: `partial ${stage} order AMBIGUOUS (${String(e?.message || e).slice(0, 120)}) — 5 min retry hold (double-sell guard; verify fill on exchange)`,
        });
      } catch { /* best-effort journal */ }
    }
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------- manual close + cancel ----------------
export async function closePosition(positionId) {
  // Under the journal lock: a watcher pass closing the same position at
  // the same moment must not double-sell it (both writers re-load the
  // journal inside the lock; the loser sees status CLOSED and no-ops).
  return withJournalLock(async () => {
    const j = loadJournal();
    const p = j.positions.find(x => x.id === positionId || x.exchangeOrderId === positionId);
    if (!p || (p.status !== 'OPEN' && p.status !== 'UNKNOWN')) return { ok: false, error: 'Position not found / already closed' };
    const tickers = await fetchCoinDcxTickers().catch(() => []);
    // v18.9: MANUAL closes ride the SAME official-price gate — a panic
    // close during a synthetic/degraded feed would book the P&L (and hit
    // the daily-loss cap) at a Binance×fx-84 approximation.
    const tradable = officialPriceMap(tickers);
    const row = tradable ? [...tradable.entries()].find(([m]) => m === p.pair) : null;
    const ltp = row ? row[1] : null;
    // v7.0.2: no live price → HONEST reject. The old `|| p.entryPrice`
    // booked a fake ₹0-P&L close (and silently understated the daily-loss
    // cap) exactly when users panic-close during a feed outage.
    if (!(ltp > 0)) {
      return { ok: false, error: `No official live price for ${p.pair} (feed degraded/synthetic ya down) — thodi der baad try karo (honest close, no fake P&L)` };
    }
    // v7.0.2: LIVE + creds revoked → reject honestly; NEVER book a paper
    // close for a live position (the real coins are still on the exchange).
    if (p.mode === 'live' && !coindcxConnected()) {
      return { ok: false, error: 'LIVE position but CoinDCX keys missing/revoked — exchange par position abhi bhi OPEN hai. Keys wapas connect karke close karo.' };
    }
    if (p.mode === 'live' && coindcxConnected()) {
      try {
        const creds = loadCredsForOrder();
        if (p.leverage > 1) {
          // v6.6: margin positions close through the margin exit API
          const mp = await getMarginPairName(p.pair, creds);
          const mresp = await coindcxPrivate('/exchange/v1/margin/orders/exit_positions', creds.apiKey, creds.secret, marginExitBody({ marginPair: mp.pair, side: p.side }));
          // v20.9.1 [H1]: wrapped rejection = close hua hi nahi — {ok:false} honest return.
          const merr = coindcxRespError(mresp);
          if (merr) return { ok: false, error: `Exchange close failed: ${merr}` };
        } else {
          // v12.1 LIVE-FIX: `market` (not `pair`) + `market_order` — the
          // spot order contract (see the entry-path note).
          const sresp = await coindcxPrivate('/exchange/v1/orders/create', creds.apiKey, creds.secret, {
            side: p.side === 'LONG' ? 'sell' : 'buy',
            market: p.pair, order_type: 'market_order', total_quantity: String(p.qty), hidden: true,
          });
          // v20.9.1 [H1]: 200-wrapped rejection pehle {ok:true} deta tha —
          // user ko lagta close ho gaya, coins exchange pe hi the.
          const serr = coindcxRespError(sresp);
          if (serr) return { ok: false, error: `Exchange close failed: ${serr}` };
        }
      } catch (e) {
        return { ok: false, error: `Exchange close failed: ${e?.message || e}` };
      }
    }
    const long = p.side === 'LONG';
    // v18.9 FEE HONESTY — manual close books NET of both-side taker fees.
    // v20.3: paper manual closes fill adversely too (same realism).
    const exitPx = p.mode === 'paper' ? paperExitPrice(ltp, p.side, paperSlipBps()) : ltp;
    const feesINR = cryptoLegFeesINR(p.entryPrice, exitPx, p.qty);
    const pnlINR = (long ? exitPx - p.entryPrice : p.entryPrice - exitPx) * p.qty - feesINR;
    p.status = 'CLOSED';
    p.closedAt = Date.now();
    p.closePrice = exitPx;
    p.pnlINR = r2(pnlINR);
    p.feesINR = feesINR;
    p.closeReason = 'Manual close';
    settlePositionOutcome(p, 'Manual close'); // v6.7 ledger
    pushEntry(j, { kind: 'CLOSE', day: todayIST(), pair: p.pair, mode: p.mode, source: p.source, qty: p.qty, entryPrice: p.entryPrice, closePrice: exitPx, pnlINR: r2(pnlINR), feesINR, reason: 'Manual close' });
    saveJournal(j);
    return { ok: true, position: p };
  });
}

export async function listExchangeOrders(statuses = ['open']) {
  if (!coindcxConnected()) return { ok: false, orders: [] };
  const creds = loadCredsForOrder();
  try {
    const resp = await coindcxPrivate('/exchange/v1/orders/active_orders', creds.apiKey, creds.secret, {
      page: '1', size: '50', statuses,
    });
    return { ok: true, orders: Array.isArray(resp) ? resp : (resp?.orders || []) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 150), orders: [] };
  }
}

export async function cancelExchangeOrder(orderId) {
  const creds = loadCredsForOrder();
  if (!creds) return { ok: false, error: 'CoinDCX not connected' };
  try {
    // v20.9.3 FIX (M): verdict-check the 200-wrapped rejection — the old
    // code returned ok:true while the resting limit order stayed live and
    // fillable (panic-cancel flow reported success on failure).
    const resp = await coindcxPrivate('/exchange/v1/orders/cancel', creds.apiKey, creds.secret, { id: String(orderId) });
    const err = coindcxRespError(resp);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

export async function cancelAllExchangeOrders() {
  const creds = loadCredsForOrder();
  if (!creds) return { ok: false, error: 'CoinDCX not connected' };
  try {
    // v20.9.3 FIX (M): same verdict-check as cancelExchangeOrder.
    const resp = await coindcxPrivate('/exchange/v1/orders/cancel_all', creds.apiKey, creds.secret, {});
    const err = coindcxRespError(resp);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

// ---------------- positions with live uPnL ----------------
// v7.0.1 REALTIME PRICE FALLBACK: when the CoinDCX public ticker is
// unreachable (Cloudflare block / geo / outage) open positions used to
// freeze at entryPrice — "realtime price fetch nahi ho raha". Now any
// pair the primary feed misses is priced from the TradingView Binance
// feed (USD domain) — spot pairs converted via the live USD/INR rate,
// futures used natively (USDT perp ≈ Binance spot). A `priceSource`
// tag rides along so the UI can show exactly where the tick came from.
export async function getPositionsWithPnl() {
  const j = loadJournal();
  const tickers = await fetchCoinDcxTickers().catch(() => []);
  const byPair = new Map((Array.isArray(tickers) ? tickers : []).map(t => [t.market, parseFloat(t.last_price)]));
  // v6.5: India positions are priced from the TV India scanner (same
  // source the signals use). One batch request for all open symbols.
  const indiaSyms = [...new Set(j.positions.filter(p => p.market === 'INDIA' && p.status === 'OPEN').map(p => p.symbol))];
  const indiaLtp = new Map();
  const indiaSrc = new Map();
  if (indiaSyms.length > 0) {
    const { fetchTVIndiaBatch } = await import('./data.js');
    const rows = await fetchTVIndiaBatch(indiaSyms).catch(() => ({}));
    for (const s of indiaSyms) if (rows[s]?.ltp > 0) { indiaLtp.set(s, rows[s].ltp); indiaSrc.set(s, 'tv-india'); }
    // v7.0.1: Yahoo fallback for India symbols the TV scanner missed
    // (scanner down / symbol not on the sheet) — keeps positions live.
    const miss = indiaSyms.filter(s => !indiaLtp.has(s));
    if (miss.length > 0) {
      await Promise.allSettled(miss.map(async (sym) => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.NS?interval=1d&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) SmartAI/7.0' },
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) return;
          const meta = (await r.json())?.chart?.result?.[0]?.meta;
          const price = Number(meta?.regularMarketPrice);
          if (price > 0) { indiaLtp.set(sym, price); indiaSrc.set(sym, 'yahoo'); }
        } catch { /* skip */ }
      }));
    }
  }
  // v6.8: futures positions priced from the futures RT feed (USDT domain)
  const futPairs = [...new Set(j.positions.filter(p => p.market === 'FUTURES' && p.status === 'OPEN').map(p => p.pair))];
  const futLtp = new Map();
  let futUsdInr = null;
  if (futPairs.length > 0) {
    const { fetchFuturesPrices, fetchUsdInr } = await import('./futures.js');
    const [rows, usdInr] = await Promise.all([
      fetchFuturesPrices().catch(() => []),
      fetchUsdInr().catch(() => 84),
    ]);
    futUsdInr = usdInr;
    for (const r of (Array.isArray(rows) ? rows : [])) if (r.last > 0) futLtp.set(r.pair, r.last);
  }
  // v10.4: GLOBAL EQUITY FUTURES positions priced from the desk's own
  // feed (Yahoo quotes / SPACEX synthetic) — same USD-domain math as
  // futures, so the LTP + uPnL stream stays live on this desk too.
  const globalSyms = [...new Set(j.positions.filter(p => p.market === 'GLOBALFUTURES' && p.status === 'OPEN').map(p => p.symbol))];
  let globalLtp = new Map();
  let globalUsdInr = null;
  if (globalSyms.length > 0) {
    const { fetchGlobalLtpMap } = await import('./globalFutures.js');
    const { fetchUsdInr } = await import('./futures.js');
    const [q, fx] = await Promise.all([
      fetchGlobalLtpMap().catch(() => new Map()),
      fetchUsdInr().catch(() => 84),
    ]);
    globalUsdInr = fx;
    globalLtp = q;
  }
  // v7.0.1: TV-Binance fallback for CRYPTO spot pairs the CoinDCX
  // ticker map missed (CF-block) — priced in ₹ via the live USD/INR.
  const cryptoOpen = j.positions.filter(p => p.status === 'OPEN' && p.market !== 'INDIA' && p.market !== 'FUTURES' && p.market !== 'GLOBALFUTURES');
  const cryptoMiss = cryptoOpen.filter(p => !byPair.has(p.pair)).map(p => String(p.pair || '').replace(/INR$/, '').replace(/^B-/, '').replace(/_USDT$/, ''));
  const tvUsd = new Map();
  let spotUsdInr = null;
  if (cryptoMiss.length > 0) {
    const { fetchTVCryptoBatch } = await import('./data.js');
    const { fetchUsdInr } = await import('./futures.js');
    const [rows, usdInr] = await Promise.all([
      fetchTVCryptoBatch([...new Set(cryptoMiss)]).catch(() => ({})),
      fetchUsdInr().catch(() => 84),
    ]);
    spotUsdInr = usdInr;
    for (const [base, row] of Object.entries(rows || {})) if (row?.usdPrice > 0) tvUsd.set(base, row.usdPrice);
  }
  // v7.0.1: futures fallback bases the RT feed missed → TV-Binance USD
  const futMiss = j.positions.filter(p => p.status === 'OPEN' && p.market === 'FUTURES' && !futLtp.has(p.pair))
    .map(p => String(p.pair || '').replace(/^B-/, '').replace(/_USDT$/, ''));
  if (futMiss.length > 0 && [...new Set(futMiss)].some(b => !tvUsd.has(b))) {
    const { fetchTVCryptoBatch } = await import('./data.js');
    const missing = [...new Set(futMiss)].filter(b => !tvUsd.has(b));
    const rows = await fetchTVCryptoBatch(missing).catch(() => ({}));
    for (const [base, row] of Object.entries(rows || {})) if (row?.usdPrice > 0) tvUsd.set(base, row.usdPrice);
  }
  const tvInrPrice = (pair) => {
    const base = String(pair || '').replace(/INR$/, '').replace(/^B-/, '').replace(/_USDT$/, '');
    const usd = tvUsd.get(base);
    return usd != null && (spotUsdInr || futUsdInr) ? usd * (spotUsdInr || futUsdInr || 84) : null;
  };
  // v7.0.1: futures fallback stays in the USDT domain (perp ≈ Binance
  // spot USD) — multiplying by USD/₹ here would corrupt the P&L math.
  const tvUsdPrice = (pair) => {
    const base = String(pair || '').replace(/^B-/, '').replace(/_USDT$/, '');
    return tvUsd.get(base) ?? null;
  };
  const stats = dailyStats(j);
  return {
    positions: j.positions.slice().reverse().map(p => {
      let ltp;
      let priceSource = null;
      let upnl = null;
      if (p.market === 'INDIA') {
        ltp = indiaLtp.get(p.symbol) ?? p.entryPrice;
        priceSource = indiaLtp.has(p.symbol) ? (indiaSrc.get(p.symbol) || 'tv-india') : 'entry-fallback';
      } else if (p.market === 'FUTURES') {
        ltp = futLtp.get(p.pair) ?? tvUsdPrice(p.pair) ?? p.entryPrice;
        priceSource = futLtp.has(p.pair) ? 'futures-rt' : (tvUsdPrice(p.pair) != null ? 'tv-usd-fallback' : 'entry-fallback');
      } else if (p.market === 'GLOBALFUTURES') {
        const q = globalLtp.get(p.symbol);
        ltp = q?.price ?? p.entryPrice;
        // v10.7: 'coindcx-gf-rt' = the app-parity CoinDCX Global Futures
        // RT feed (live USDC perp LTP); 'yahoo' = fallback spot quote.
        priceSource = q ? (q.sim ? 'global-sim' : q.source === 'coindcx-usdc' ? 'coindcx-gf-rt' : 'yahoo') : 'entry-fallback';
      } else {
        ltp = byPair.get(p.pair) ?? tvInrPrice(p.pair) ?? p.entryPrice;
        priceSource = byPair.has(p.pair) ? 'coindcx' : (tvInrPrice(p.pair) != null ? 'tv-usd-fallback' : 'entry-fallback');
      }
      const long = p.side === 'LONG';
      // v7.0: positions with booked partial-TP legs show the HONEST
      // unrealized P&L = remaining-leg uPnL + already-booked legs
      const booked = Number(p.bookedPnlINR) || 0;
      if (p.status === 'OPEN') {
        if (p.market === 'FUTURES') {
          const pnlUSDT = (long ? ltp - p.entryPrice : p.entryPrice - ltp) * p.qty;
          upnl = r2(pnlUSDT * (futUsdInr || 84) + booked);
          return {
            ...p, ltp: r2(ltp), unrealizedPnlINR: upnl, priceSource,
            unrealizedPnlUSDT: r2(pnlUSDT + (Number(p.bookedPnlUSDT) || 0)), usdInr: r2(futUsdInr || 84),
            marginUSDT: p.marginUSDT ?? null,
            exitStage: exitStageOf(p),
          };
        }
        if (p.market === 'GLOBALFUTURES') {
          // v10.4: USD domain (futures math, yahoo/sim feed)
          const pnlUSD = (long ? ltp - p.entryPrice : p.entryPrice - ltp) * p.qty;
          upnl = r2(pnlUSD * (globalUsdInr || 84) + booked);
          return {
            ...p, ltp: r2(ltp), unrealizedPnlINR: upnl, priceSource,
            unrealizedPnlUSDT: r2(pnlUSD + (Number(p.bookedPnlUSDT) || 0)), usdInr: r2(globalUsdInr || 84),
            marginUSDT: p.marginUSDT ?? null,
            exitStage: exitStageOf(p),
          };
        }
        upnl = r2((long ? ltp - p.entryPrice : p.entryPrice - ltp) * p.qty + booked);
      } else {
        // closed: final leg + booked legs = the position's true total
        upnl = r2((Number(p.pnlINR) || 0) + booked);
      }
      return { ...p, ltp: r2(ltp), unrealizedPnlINR: upnl, priceSource, exitStage: exitStageOf(p) };
    }),
    stats,
    entries: j.entries.slice(-60).reverse(),
  };
}

// ---------------- test hooks ----------------
export function __resetForTests() {
  saveConfig({ ...DEFAULT_CONFIG });
  saveJournal({ entries: [], positions: [] });
  _productsCache = null;
  _marginPairsCache = null;
  _marginPairsAt = 0;
  // v18.9: watcher single-flight + feed-gate throttle state resets too
  _watchInflight = null;
  _watchErrAlerts.clear();
  _lastFeedGateDay = null; _lastFeedGateAt = 0; _lastFeedGapAt = 0;
  // v6.7: the signal ledger resets with the journal (same test hygiene)
  try { __setLedgerForTests(null); } catch { /* best-effort */ }
}
export function __setJournalForTests(j) { saveJournal(j); }
export function __setConfigForTests(cfg) { saveConfig(cfg); }
export { dailyStats };
