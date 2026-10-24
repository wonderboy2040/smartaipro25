// ============================================================
// intraday/trackRecord — signal accountability engine
// ------------------------------------------------------------
// Every published scanner signal is PERSISTED and then tracked to
// its outcome against live prices (via the stream.js watcher):
//   OPEN → (SL first) SL_HIT
//   OPEN → (T1) PARTIAL: book 50% at T1, trail rest to breakeven
//          → then BE_TRAIL_EXIT | T2_HIT | SL_HIT(breakeven floor)
//   15:25 IST / market close → EOD_EXIT at last price
//
// P&L model mirrors the site's own execution discipline:
//   qty = qtyPerLakh (1% risk sizing per ₹1L capital)
//   disciplined pnl = 50%×(T1−entry) + 50%×(exit−entry)  [if T1 hit]
//                   = 100%×(exit−entry)                   [otherwise]
//   rMultiple = pnl / (qty × riskPerShare)
//
// Persistence: server/data/tracked-signals.json (atomic writes,
// survives restarts). Stale OPEN rows from previous days are
// reconciled on boot.
// ============================================================
import { loadJSON, saveJSON } from './store.js';
import { istDayKey, istMinutes, isNseMarketOpen, dayKeyFor } from './time.js';
import { isCryptoSymbolBase, intradayDirectionGateConfig, INTRADAY_NO_EDGE_CAP } from './engine.js';
// v10.3.1: encrypted durable mirror (paper-trades already had the raw
// scheduleBackup; the track record now rides the same encrypted
// durableBootRestore path as the trading journal) — a Render spin-down
// can no longer reset the accountability history to zero.
import { durablePut } from '../mcp/durable.js';

const FILE = 'tracked-signals.json';
const MAX_ROWS = 1200;         // v21.3.0: 800 → 1200 (FUTURES + GLOBALFUTURES desks ab track hote hain)
const MAX_PER_DAY = 80;        // v21.3.0: 40 → 80 open-row cap across desks (per-day OPEN+PARTIAL)
const EOD_SQOFF_MIN = 15 * 60 + 25; // 15:25 IST — reconcile & close

const _marketOf = (rowOrSig) => {
  const m = String(rowOrSig?.market || '').toUpperCase();
  if (m === 'CRYPTO') return 'CRYPTO';
  // v21.3.0: FUTURES (USDT perps) / GLOBALFUTURES (USDC equity perps) —
  // board-accountability rows ab in desks se bhi aate hain; unka quote
  // routing (USDT/USDC) INR-crypto se ALAG hai, isliye verbatim market.
  if (m === 'FUTURES' || m === 'GLOBALFUTURES') return m;
  if (m === 'INDIA') return 'INDIA';
  // Legacy rows / engine payloads without the field: base-symbol heuristic.
  return isCryptoSymbolBase(rowOrSig?.symbol) ? 'CRYPTO' : 'INDIA';
};

let _state = loadJSON(FILE, { signals: [] });
let _saveTimer = null;
// v20.3: cross-source flip cooldown — "symbol|dayKey" → last flip ts.
// Bounded: flip keys are day-scoped; anything over 500 keys is a runaway
// (historically impossible — 40 rows/day cap) and gets swept.
const _flipGuard = new Map();

/** v10.3.1: durable boot-restore hook — _state was loaded at module-eval
 * time (before the pre-listen durable restore rehydrated the disk file).
 * Re-read so the accountability history survives Render spin-downs. */
export function __reloadTrackRecordForBoot() { _state = loadJSON(FILE, { signals: [] }); }

function _persist() {
  // Debounced write (max one write/sec under bursty updates).
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveJSON(FILE, _state);
    try { durablePut(FILE, _state); } catch { /* durable optional */ }
  }, 1000);
  if (typeof _saveTimer.unref === 'function') _saveTimer.unref();
}

/** v20.3: test reset for the cross-source flip guard (module state). */
export function __resetFlipGuardForTests() { _flipGuard.clear(); }

/** v9.1: synchronous flush for graceful shutdown (see flushPaperState). */
export function flushTrackRecordState() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  saveJSON(FILE, _state);
}

function _id(symbol, market = 'INDIA') { return `${symbol}:${market}:${dayKeyFor(market)}`; } // v21.4.1 [B4]: market-qualified — CRYPTO aur FUTURES ek hi base (BTC…) pe alag desks hain

/** v21.4.1 [B5]: sub-cent price rounding — toFixed(2) SHIB/PEPE/BONK-class
 * (aur micro USDT perp) levels ko 0 bana deta tha: exit 0.000170 → 0.00 →
 * _computePnl full-qty LOSS book karta tha (fake −₹25,000 disciplined PnL
 * on a ₹1,000-risk trade). |x| ≥ 1 → 2dp (pehle jaisa); sub-1 → 4
 * significant digits (0.000166 round-trip safe). Kabhi 0 nahi banta jab
 * input khud non-zero hai. */
function _pxRound(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1) return +n.toFixed(2);
  const r = +n.toPrecision(4);
  return (r === 0 && n !== 0) ? n : r;
}

export function trackedSymbolsForToday() {
  return _state.signals
    .filter(s => !s.excluded && s.status === 'OPEN' && s.dayKey === dayKeyFor(_marketOf(s)))
    .map(s => s.symbol);
}

// Which symbols does the watcher need quotes for? OPEN tracked
// signals only (paper trades are handled by their own module).
export function watcherSymbols() {
  return [...new Set(trackedSymbolsForToday())];
}

// 2026-09 multi-market: same watch set, classified per market so the
// watcher routes INDIA → Groww and CRYPTO → CoinDCX.
// v21.3.0: FUTURES → CoinDCX USDT perp RT (+Binance fallback);
// GLOBALFUTURES → the global USDC quote chain. (Issue-3: FUTURES board
// signals pehle kabhi track hi nahi hote the — the exact desk the user
// complained about had ZERO outcome feedback.)
export function watcherSymbolsByMarket() {
  const india = [];
  const crypto = [];
  const futures = [];
  const global = [];
  for (const s of _state.signals) {
    if (s.excluded) continue;
    if (s.status !== 'OPEN' && s.status !== 'PARTIAL') continue;
    if (s.dayKey !== dayKeyFor(_marketOf(s))) continue; // stale rows handled by reconcile
    const m = _marketOf(s);
    if (m === 'FUTURES') futures.push(s.symbol);
    else if (m === 'GLOBALFUTURES') global.push(s.symbol);
    else (m === 'CRYPTO' ? crypto : india).push(s.symbol);
  }
  return { india: [...new Set(india)], crypto: [...new Set(crypto)], futures: [...new Set(futures)], global: [...new Set(global)] };
}

// ------------------------------------------------------------
// Record the LATEST scan's published signals.
//  • brand-new symbol → open a tracked row
//  • same symbol, same direction → refresh levels/confidence only
//  • same symbol, direction FLIPPED → close old row (FLIP) + open new
// Signals published after 15:00 (no-fresh-entry window) are tracked
// for accountability but flagged `lateEntry`.
// ------------------------------------------------------------
export function recordSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const today = istDayKey();
  const events = [];
  if (_state.dayKey !== today) _state.dayKey = today;
  // v20.3: flip-guard sweep (day-scoped keys; >500 = runaway, reset).
  if (_flipGuard.size > 500) _flipGuard.clear();

  const todayRows = _state.signals.filter(s => s.dayKey === dayKeyFor(_marketOf(s)));
  // v11.4 recheck: count OPEN *and* PARTIAL — a PARTIAL row is still one
  // live tracked trade and must consume a MAX_PER_DAY slot (previously
  // uncapped once every row had booked T1).
  if (todayRows.filter(s => s.status === 'OPEN' || s.status === 'PARTIAL').length >= MAX_PER_DAY) return [];

  for (const sig of signals) {
    const market = _marketOf(sig);
    const sigDay = dayKeyFor(market);
    // v11.4 recheck: dedup must match PARTIAL rows too — once a row booked
    // T1 it escaped the OPEN-only lookup and the next scan opened a SECOND
    // row with the SAME id (symbol:dayKey), double-counting the trade.
    // v21.4.1 [B4]: dedup ab MARKET-scoped bhi hai — CRYPTO (INR spot) aur
    // FUTURES (USDT perp) dono boards same base symbols (BTC/ETH/SOL…)
    // scan karte hain aur dono same UTC dayKey use karte hain. Purana
    // symbol+dayKey dedup: (a) same-direction pe doosre desk ki row ko
    // "refresh" me swallow kar leta tha (futures outcome feedback ZERO),
    // (b) opposite-direction pe doosre desk ke USDT price pe INR row
    // FLIP-close kar deta tha (domain-mix → catastrophic fake PnL).
    const existing = _state.signals.find(
      s => s.symbol === sig.symbol && s.dayKey === sigDay
        && (s.status === 'OPEN' || s.status === 'PARTIAL') && _marketOf(s) === market
    );
    if (existing) {
      if (existing.direction !== sig.direction) {
        // v20.3 FLIP-COOLDOWN: the legacy scanner (60s cache) AND the AI
        // board (30s client cadence) both feed this book. When the two
        // systems DISAGREE on direction, the old code flip-closed +
        // re-opened the row every cycle — the row's plan churned all day
        // (40/day cap burn, journal noise, whichever system polled last
        // "owned" the trade). A genuine flip still goes through (once per
        // symbol per 30 min); the churn between polls does not.
        // v21.4.1 [B4]: flip-guard key bhi market-scoped (cross-desk
        // disagreement genuine flips ko mute nahi karti).
        const flipKey = `${market}|${sig.symbol}|${sigDay}`;
        const lastFlip = _flipGuard.get(flipKey) || 0;
        if (Date.now() - lastFlip > 30 * 60_000) {
          _flipGuard.set(flipKey, Date.now());
          _closeRow(existing, sig.ltp, 'FLIP', events);
          _openRow(sig, sigDay, events, true);
        } else {
          // Flip suppressed (30m churn guard). The existing row is still the
          // OLD direction — copying the opposite signal's dirScore/quality/
          // edge telemetry onto it would label a LONG row with SHORT scores.
          // Confidence is a live field (the legacy contract refreshes it), but
          // direction telemetry waits for an actual flip.
          if (sig.confidence != null) existing.confidence = sig.confidence;
          if (Number(sig.ltp) > 0) existing.lastPrice = sig.ltp;
        }
      } else if (existing.status === 'PARTIAL') {
        // T1 already booked against the OLD levels — refreshing entry/target1
        // would rewrite booked P&L retroactively. Live fields only.
        _refreshRowTelemetry(existing, sig);
      } else {
        // v18.9 LEVEL FREEZE — an OPEN row's entry/SL/targets were set at
        // publish time; refreshing them mid-life rewrote the P&L basis AFTER
        // the fact (a 14:00 refresh that lifted `entry` above the current
        // price made the very next tick book an SL_HIT that never happened
        // at the original plan — win-rate/avgR measured the LAST refresh,
        // not the published signal). Only live fields refresh now.
        _refreshRowTelemetry(existing, sig);
        existing.qtyPerLakh = sig.qtyPerLakh ?? existing.qtyPerLakh;
      }
    } else {
      _openRow(sig, sigDay, events, false);
    }
  }

  // Trim history.
  if (_state.signals.length > MAX_ROWS) {
    _state.signals = _state.signals
      .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0))
      .slice(_state.signals.length - MAX_ROWS);
  }
  _persist();
  return events; // [{type:'OPEN'|'FLIP', ...}] for stream broadcast
}

// ------------------------------------------------------------
// v21.23.15 DIRECTION REPORT — score telemetry + hit-rate buckets.
// Engine payloads carry dirScore (directional evidence), qualityScore
// (confirmation), edgeMargin (|LONG-SHORT| dirScore) and the gate modes.
// Board-accountability rows (ensemble, not engine) legitimately lack these
// fields, so every consumer below tolerates missing metadata instead of
// dropping the row.
// ------------------------------------------------------------
function _numOrNull(x) {
  // IMPORTANT: Number(null) === 0 — a missing score/PnL must stay null, not
  // silently become a real zero (it would count open rows as breakeven and
  // missing margins as "<12"). Number('   ') is also 0, so trim strings first.
  if (x == null) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Engine payload → persisted row fields. Nested `marginGate`/`staleGuard`
// objects are flattened so old reports stay queryable with plain JSON.
function _directionTelemetry(sig) {
  const mg = sig?.marginGate && typeof sig.marginGate === 'object' ? sig.marginGate : {};
  const sg = sig?.staleGuard && typeof sig.staleGuard === 'object' ? sig.staleGuard : {};
  return {
    dirScore: _numOrNull(sig?.dirScore ?? sig?.directionScore),
    qualityScore: _numOrNull(sig?.qualityScore),
    edgeMargin: _numOrNull(sig?.edgeMargin),
    marginGateMode: mg.mode || null,
    marginMin: _numOrNull(mg.min),
    marginPass: typeof mg.pass === 'boolean' ? mg.pass : null,
    marginWouldBlock: typeof mg.wouldBlock === 'boolean' ? mg.wouldBlock : null,
    marginCapped: typeof mg.capped === 'boolean' ? mg.capped : null,
    staleGuardMode: sg.mode || null,
    staleMaxPct: _numOrNull(sg.maxPct),
    staleDetected: typeof sg.detected === 'boolean' ? sg.detected : null,
    ltpTvDivPct: _numOrNull(sg.ltpTvDivPct),
    staleCapped: typeof sg.capped === 'boolean' ? sg.capped : null,
    // null = the source did not carry a tie flag (board row). A false default
    // here would overwrite engine telemetry on a same-direction board refresh.
    directionalTie: typeof sig?.directionalTie === 'boolean' ? sig.directionalTie : null,
  };
}

// Live refreshes (same-direction scans) keep the ORIGINAL entry plan frozen
// but should keep confidence + direction telemetry current. Board-accountability
// rows do not carry engine scores — merging only PRESENT values prevents a
// board refresh from wiping the engine telemetry captured at open time.
function _refreshRowTelemetry(row, sig) {
  if (sig?.confidence != null) row.confidence = sig.confidence;
  if (Number(sig?.ltp) > 0) row.lastPrice = sig.ltp;
  for (const [key, value] of Object.entries(_directionTelemetry(sig))) {
    if (value != null) row[key] = value;
  }
}

function _openRow(sig, today, events, isFlip) {
  const market = _marketOf(sig);
  // v21.23.15: a same-day re-entry after SL/FLIP is a NEW trade — give it a
  // unique row id. The old symbol:market:dayKey id repeated across every
  // re-entry (23 duplicate-id groups in the live ledger), which makes any
  // id-keyed consumer ambiguous. First row keeps the legacy id verbatim.
  let id = _id(sig.symbol, market);
  if (_state.signals.some(s => s.id === id)) {
    let n = 2;
    while (_state.signals.some(s => s.id === `${id}#${n}`)) n++;
    id = `${id}#${n}`;
  }
  const row = {
    id,
    symbol: sig.symbol, exchange: sig.exchange || (market === 'CRYPTO' ? 'BINANCE' : 'NSE'),
    market,
    direction: sig.direction,
    entry: sig.entry, stopLoss: sig.stopLoss,
    target1: sig.target1, target2: sig.target2,
    qtyPerLakh: sig.qtyPerLakh || 0,
    risk: _pxRound(Math.abs(sig.entry - sig.stopLoss)) ?? 0, // v21.4.1 [B5]: sub-cent safe
    confidence: sig.confidence, quantConfidence: sig.quantConfidence,
    ..._directionTelemetry(sig),
    aiModel: sig.aiModel || '', aiNote: sig.aiNote || '',
    counterTrend: !!sig.counterTrend,
    trendStrength: sig.trendStrength || '',
    dayKey: today,
    openedAt: Date.now(),
    lastPrice: sig.ltp,
    status: 'OPEN',          // OPEN | PARTIAL | SL_HIT | T2_HIT | BE_TRAIL_EXIT | EOD_EXIT | FLIP
    t1Hit: false,
    events: [{ ts: Date.now(), type: 'OPEN', price: sig.ltp }],
    exitPrice: null, closedAt: null,
    realizedPnlPerLakh: null, disciplinedPnlPerLakh: null, rMultiple: null,
    // CRYPTO/FUTURES/GLOBALFUTURES 24/7 hain — 15:00 IST fresh-entry cutoff
    // sirf NSE ke liye hai (v21.4.1 [B5]: pehle sirf CRYPTO exempt tha —
    // FUTURES/GLOBALFUTURES perp desks ko galat lateEntry mil raha tha).
    lateEntry: (market === 'CRYPTO' || market === 'FUTURES' || market === 'GLOBALFUTURES') ? false : istMinutes() >= 15 * 60,
  };
  _state.signals.push(row);
  events.push({ type: isFlip ? 'FLIP' : 'OPEN', symbol: row.symbol, direction: row.direction, price: row.entry, confidence: row.confidence, market });
  return row;
}

function _closeRow(row, exitPrice, reason, events) {
  row.status = reason;
  row.exitPrice = _pxRound(exitPrice); // v21.4.1 [B5]: sub-cent exit 0.00 → fake full-loss ban
  row.closedAt = Date.now();
  row.lastPrice = row.exitPrice;
  row.events.push({ ts: Date.now(), type: reason, price: row.exitPrice });
  _computePnl(row);
  events.push({
    type: reason, symbol: row.symbol, direction: row.direction,
    price: row.exitPrice, pnl: row.disciplinedPnlPerLakh,
    rMultiple: row.rMultiple, qty: row.qtyPerLakh,
  });
}

// Disciplined P&L per ₹1L (matches the published execution rules).
function _computePnl(row) {
  const qty = row.qtyPerLakh || 0;
  if (!qty || row.exitPrice == null) return;
  const sign = row.direction === 'LONG' ? 1 : -1;
  const entry = row.entry, exit = row.exitPrice;
  let pnl;
  if (row.t1Hit) {
    // 50% booked at T1; remainder exited at `exit` (breakeven trail / T2 / EOD).
    pnl = 0.5 * qty * (row.target1 - entry) * sign + 0.5 * qty * (exit - entry) * sign;
  } else {
    pnl = qty * (exit - entry) * sign;
  }
  row.disciplinedPnlPerLakh = +pnl.toFixed(2);
  row.realizedPnlPerLakh = +(qty * (exit - entry) * sign).toFixed(2);
  row.rMultiple = row.risk > 0 ? +(pnl / (qty * row.risk)).toFixed(2) : null;
}

// ------------------------------------------------------------
// Live evaluation — called by the watcher with fresh quotes.
// LONG: SL at ltp<=stopLoss, T1 at ltp>=target1, T2 at ltp>=target2.
// After T1: trail stop = entry (breakeven); if ltp <= entry → out.
// NOTE: uses LTP (not day high/low) because the swing stop sits
// below the day low by construction — dayLow would false-trigger.
// ------------------------------------------------------------
export function evaluateTracked(quotes, events, mktQuotes = null) {
  const m = istMinutes();

  // v11.4 recheck: RUNTIME reconcile — reconcileStale used to run at BOOT
  // ONLY, so on a long-lived process every row that crossed its day
  // boundary while still OPEN/PARTIAL (crypto at UTC midnight — the common
  // case for a 24/7 market; NSE rows left open when quotes stopped) turned
  // into a permanent zombie: skipped by this loop, never counted, and
  // `openCount` grew forever. The loop below is ≤ MAX_ROWS (800) string
  // compares — cheap enough for every watcher tick, idempotent.
  reconcileStale(events);

  for (const row of _state.signals) {
    if (row.status !== 'OPEN' && row.status !== 'PARTIAL') continue;
    const market = _marketOf(row);
    // Per-market day key: IST for NSE, UTC for crypto. Stale rows are
    // handled by reconcile — never mid-session here.
    if (row.dayKey !== dayKeyFor(market)) continue;
    // v21.4.1 [B7]: market-qualified quote lookup — stream watcher ab per-desk
    // keys (`FUTURES|BTC`) bhi bhejta hai. CRYPTO (INR spot) aur FUTURES
    // (USDT perp) dono tracked rows same base symbol pe ho sakti hain;
    // plain-key map first-write-wins INR de deta tha → futures row pe fake
    // SL_HIT (8.6M vs 102k domain mix). Qualified key first, legacy plain
    // key fallback (purane callers/tests).
    const q = (mktQuotes && mktQuotes[`${market}|${row.symbol}`]) || quotes[row.symbol];
    const price = q?.price;
    if (!(price > 0)) continue;
    row.lastPrice = _pxRound(price);

    const isLong = row.direction === 'LONG';
    const hitSL = isLong ? price <= row.stopLoss : price >= row.stopLoss;
    const hitT1 = !row.t1Hit && (isLong ? price >= row.target1 : price <= row.target1);
    const hitT2 = isLong ? price >= row.target2 : price <= row.target2;

    if (row.status === 'OPEN') {
      // v21.13 SL GAP-THROUGH PARITY (paperTrading v20.9.1 [H3] jaisa):
      // fill at the TRADED price, not the trigger level — a tick that
      // gapped straight through the stop gets the honest worst-side fill
      // the market order would actually receive. hitSL already guarantees
      // price is at/beyond the stop, so this is always worse-or-equal.
      if (hitSL) { _closeRow(row, price, 'SL_HIT', events); continue; }
      if (hitT2) { row.t1Hit = true; _closeRow(row, row.target2, 'T2_HIT', events); continue; }
      if (hitT1) {
        row.t1Hit = true; row.status = 'PARTIAL';
        row.events.push({ ts: Date.now(), type: 'T1_HIT', price: row.target1 });
        events.push({ type: 'T1_HIT', symbol: row.symbol, direction: row.direction, price: row.target1, note: 'Book 50% • trail SL to entry', market });
        continue;
      }
    } else if (row.status === 'PARTIAL') {
      // Trail at breakeven once T1 booked.
      // v11.4 recheck: the original-SL check used to run FIRST — a tick
      // that gapped straight through entry to ≤ stopLoss closed the
      // remainder at the ORIGINAL SL (a full-risk loss on the runner)
      // instead of the documented breakeven floor. For a long, any price
      // ≤ stopLoss is also ≤ entry, so the BE trail subsumes it; T2 stays
      // first so a gap UP still books the win.
      if (hitT2) { _closeRow(row, row.target2, 'T2_HIT', events); continue; }
      const hitTrail = isLong ? price <= row.entry : price >= row.entry;
      // v21.13.x recheck (B2): BE_TRAIL_EXIT fills at the TRADED price
      // (worst-side), not exactly at entry — a tick that gaps THROUGH
      // breakeven books the runner at the honest fill the market order
      // would receive (paperTrading v20.9.1 [H3] ka exact mirror; SL_HIT
      // ne v21.13 me yahi fix liya tha — accounting ab dono engines me
      // identical hai, gap-downs-through-entry score as small losses,
      // not fake breakevens).
      if (hitTrail) {
        const beFill = isLong ? Math.min(price, row.entry) : Math.max(price, row.entry);
        _closeRow(row, beFill, 'BE_TRAIL_EXIT', events);
        continue;
      }
    }

    // EOD square-off for anything still open — NSE ONLY (crypto/futures/
    // global perps 24/7 hain aur UTC day boundary par reconcile se roll
    // hote hain).
    const afterEod = market === 'INDIA' && (m >= EOD_SQOFF_MIN || !isNseMarketOpen());
    if (afterEod) { _closeRow(row, price, 'EOD_EXIT', events); }
  }
  if (events.length) _persist();
}

// Close stale OPEN rows from previous sessions (server restart etc.).
// CRYPTO rows roll at the UTC day boundary (the natural crypto session).
export function reconcileStale(events = []) {
  let changed = false;
  for (const row of _state.signals) {
    if (row.dayKey !== dayKeyFor(_marketOf(row)) && (row.status === 'OPEN' || row.status === 'PARTIAL')) {
      _closeRow(row, row.lastPrice || row.entry, 'EOD_EXIT', events);
      changed = true;
    }
  }
  if (changed) _persist();
  return changed;
}

// ------------------------------------------------------------
// Stats for the UI: win-rate, avg R, disciplined P&L — last N days.
// ------------------------------------------------------------
export function getTrackRecord(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = _state.signals
    .filter(s => !s.excluded && (s.openedAt || 0) >= cutoff && s.status !== 'FLIP' && s.status !== 'OPEN' && s.status !== 'PARTIAL')
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  const open = _state.signals.filter(s => !s.excluded && (s.status === 'OPEN' || s.status === 'PARTIAL'));
  // v21.23.15: rows explicitly marked excluded (hard-vetoed reference signal /
  // proven duplicate) stay in the JSON for audit but never enter the ledger.
  const excludedCount = _state.signals.filter(s => s.excluded).length;

  let wins = 0, losses = 0, rSum = 0, rCount = 0, pnlSum = 0;
  const byStatus = { T2_HIT: 0, BE_TRAIL_EXIT: 0, SL_HIT: 0, EOD_EXIT: 0 };
  for (const r of rows) {
    if (byStatus[r.status] != null) byStatus[r.status]++;
    const pnl = r.disciplinedPnlPerLakh;
    if (pnl != null) {
      pnlSum += pnl;
      if (pnl > 0) wins++; else if (pnl < 0) losses++;
    }
    if (r.rMultiple != null) { rSum += r.rMultiple; rCount++; }
  }
  const resolved = wins + losses;
  return {
    days,
    totalTracked: _state.signals.filter(s => !s.excluded).length,
    openCount: open.length,
    excludedCount,
    resolved,
    wins, losses,
    winRate: resolved > 0 ? +((wins / resolved) * 100).toFixed(1) : null,
    avgR: rCount > 0 ? +(rSum / rCount).toFixed(2) : null,
    disciplinedPnlPerLakh: +pnlSum.toFixed(2),
    byStatus,
    open: open.map(s => ({
      symbol: s.symbol, market: s.market, direction: s.direction, entry: s.entry,
      stopLoss: s.stopLoss, target1: s.target1, target2: s.target2,
      status: s.status, lastPrice: s.lastPrice, confidence: s.confidence,
      openedAt: s.openedAt, t1Hit: s.t1Hit,
    })),
    history: rows.slice(0, 40).map(s => ({
      symbol: s.symbol, market: s.market, direction: s.direction, dayKey: s.dayKey,
      entry: s.entry, exitPrice: s.exitPrice, status: s.status,
      confidence: s.confidence, t1Hit: s.t1Hit,
      pnl: s.disciplinedPnlPerLakh, rMultiple: s.rMultiple,
      openedAt: s.openedAt, closedAt: s.closedAt,
    })),
  };
}

// ------------------------------------------------------------
// v21.23.15 DIRECTION REPORT — full-state aggregation (NOT the trimmed
// 40-row history). Answers "is the DIRECTION read actually right, per
// desk / side / confidence / edge margin?" Rows are the same settled
// ledger as getTrackRecord (FLIP churn excluded); open rows count in `n`
// but never in win-rate denominators.
// MFE/MAE are not stored on tracked rows, so excursion stats are omitted
// rather than invented — add forward MFE/MAE tracking before reporting them.
// ------------------------------------------------------------
const _REPORT_MARKETS = ['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES'];
const _CONF_BUCKETS = [
  { label: 'missing', test: (c) => c == null },
  { label: '<60', test: (c) => c != null && c < 60 },
  { label: '60-69', test: (c) => c != null && c >= 60 && c < 70 },
  { label: '70-79', test: (c) => c != null && c >= 70 && c < 80 },
  { label: '80-89', test: (c) => c != null && c >= 80 && c < 90 },
  { label: '90+', test: (c) => c != null && c >= 90 },
];
const _MARGIN_BUCKETS = [
  { label: 'n/a', test: (m) => m == null },
  { label: '<12', test: (m) => m != null && m < 12 },
  { label: '12-19', test: (m) => m != null && m >= 12 && m < 20 },
  { label: '20-29', test: (m) => m != null && m >= 20 && m < 30 },
  { label: '30+', test: (m) => m != null && m >= 30 },
];

const _confOf = (r) => _numOrNull(r?.confidence) ?? _numOrNull(r?.quantConfidence);
const _dirScoreOf = (r) => _numOrNull(r?.dirScore) ?? _numOrNull(r?.directionScore);

function _directionStats(rows) {
  let wins = 0, losses = 0, breakeven = 0, open = 0;
  let rSum = 0, rCount = 0, pnlSum = 0;
  let dirSum = 0, dirCount = 0, qSum = 0, qCount = 0, marginSum = 0, marginCount = 0;
  let confSum = 0, confCount = 0;
  for (const r of rows) {
    if (r.status === 'OPEN' || r.status === 'PARTIAL') open++;
    const pnl = _numOrNull(r.disciplinedPnlPerLakh);
    if (pnl != null) {
      pnlSum += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
      else breakeven++;
    }
    if (r.rMultiple != null && Number.isFinite(Number(r.rMultiple))) {
      rSum += Number(r.rMultiple); rCount++;
    }
    const ds = _dirScoreOf(r);
    if (ds != null) { dirSum += ds; dirCount++; }
    const qs = _numOrNull(r.qualityScore);
    if (qs != null) { qSum += qs; qCount++; }
    const em = _numOrNull(r.edgeMargin);
    if (em != null) { marginSum += em; marginCount++; }
    const conf = _confOf(r);
    if (conf != null) { confSum += conf; confCount++; }
  }
  const resolved = wins + losses;
  return {
    n: rows.length,
    open,
    resolved,
    wins, losses, breakeven,
    winRate: resolved > 0 ? +((wins / resolved) * 100).toFixed(1) : null,
    avgR: rCount > 0 ? +(rSum / rCount).toFixed(2) : null,
    disciplinedPnlPerLakh: +pnlSum.toFixed(2),
    avgConfidence: confCount > 0 ? +(confSum / confCount).toFixed(1) : null,
    avgDirScore: dirCount > 0 ? +(dirSum / dirCount).toFixed(1) : null,
    avgQualityScore: qCount > 0 ? +(qSum / qCount).toFixed(1) : null,
    avgEdgeMargin: marginCount > 0 ? +(marginSum / marginCount).toFixed(1) : null,
    // Tracked rows do not store excursions today. Null is honest — never 0.
    mfe: null,
    mae: null,
  };
}

// v21.23.17 GATE PROMOTION READINESS — the shadow gates stay the default
// until the DIRECTION REPORT proves the cohort they would block actually
// underperforms the cohort they keep. This is deliberately a cohort
// comparison (not a per-trade "would have won" simulation): the persisted
// telemetry is honest about which side of the threshold each row was on.
//   • blocked: resolved rows the gate would suppress (margin < min, stale)
//   • kept:    resolved rows the gate would allow
// Promotion requires BOTH sides to have enough settled outcomes, the
// blocked cohort to be at/below a coin-flip win rate, and a material
// (>=8pp) underperformance gap. Until then: COLLECTING / KEEP_SHADOW.
const GATE_PROMOTION_CRITERIA = Object.freeze({
  minBlockedResolved: 10,
  minKeptResolved: 20,
  maxBlockedWinRate: 50,
  minWinRateGap: 8,
});

function _gateCohort(rows, test) {
  const s = _directionStats(rows.filter(test));
  return {
    n: s.n,
    resolved: s.resolved,
    wins: s.wins,
    losses: s.losses,
    winRate: s.winRate,
    avgConfidence: s.avgConfidence,
  };
}

function _gateReadiness({ rows, mode, blockedTest, keptTest, thresholdLabel, thresholdValue, envFlag }) {
  const blocked = _gateCohort(rows, blockedTest);
  const kept = _gateCohort(rows, keptTest);
  const enough = blocked.resolved >= GATE_PROMOTION_CRITERIA.minBlockedResolved
    && kept.resolved >= GATE_PROMOTION_CRITERIA.minKeptResolved;
  const winRateGapPp = blocked.winRate != null && kept.winRate != null
    ? +(kept.winRate - blocked.winRate).toFixed(1)
    : null;
  const promote = enough
    && blocked.winRate != null
    && blocked.winRate <= GATE_PROMOTION_CRITERIA.maxBlockedWinRate
    && winRateGapPp != null
    && winRateGapPp >= GATE_PROMOTION_CRITERIA.minWinRateGap;
  const status = mode === 'enforce'
    ? 'ENFORCED'
    : !enough ? 'COLLECTING' : promote ? 'PROMOTE_READY' : 'KEEP_SHADOW';
  const missing = {
    blockedResolved: Math.max(0, GATE_PROMOTION_CRITERIA.minBlockedResolved - blocked.resolved),
    keptResolved: Math.max(0, GATE_PROMOTION_CRITERIA.minKeptResolved - kept.resolved),
  };
  const nextStep = status === 'ENFORCED'
    ? `${envFlag} is enforced — take the cohorts above as historical evidence, not a running A/B.`
    : status === 'PROMOTE_READY'
      ? `Set ${envFlag}=enforce on Render (the blocked cohort underperforms by ${winRateGapPp}pp).`
      : status === 'COLLECTING'
        ? `Collect ${missing.blockedResolved} more resolved blocked + ${missing.keptResolved} more resolved kept rows, then re-check /api/ai/direction-report.`
        : `Keep ${envFlag}=${mode} — the blocked cohort is not underperforming enough yet (gap ${winRateGapPp ?? 'n/a'}pp).`;
  return {
    mode,
    status,
    recommended: status === 'PROMOTE_READY',
    threshold: { label: thresholdLabel, value: thresholdValue },
    blocked,
    kept,
    winRateGapPp,
    missing,
    criteria: { ...GATE_PROMOTION_CRITERIA },
    nextStep,
  };
}

/**
 * Direction-accuracy report over the FULL tracked-signals state.
 * @param {number} days lookback (1..365, default 30)
 * @param {string} tab  ALL | INDIA | CRYPTO | FUTURES | GLOBALFUTURES
 */
export function getDirectionReport(days = 30, tab = 'ALL') {
  const rawDays = Number(days);
  const windowDays = Number.isFinite(rawDays) ? Math.max(1, Math.min(365, rawDays)) : 30;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const tabNorm = String(tab || 'ALL').trim().toUpperCase();
  const wantMarket = _REPORT_MARKETS.includes(tabNorm) ? tabNorm : 'ALL';

  const allRowsAll = _state.signals.filter(s => !s.excluded && s.status !== 'FLIP');
  // Tab-scoped provenance: a CRYPTO tab must not report INDIA's all-time /
  // outside-window / excluded counts as its own.
  const allRows = wantMarket === 'ALL'
    ? allRowsAll
    : allRowsAll.filter(s => _marketOf(s) === wantMarket);
  const windowRows = allRows.filter(s => (s.openedAt || 0) >= cutoff);
  const rows = windowRows;
  const excludedCount = _state.signals.filter(s =>
    s.excluded && (wantMarket === 'ALL' || _marketOf(s) === wantMarket)
  ).length;

  const byStatus = { OPEN: 0, PARTIAL: 0, T2_HIT: 0, BE_TRAIL_EXIT: 0, SL_HIT: 0, EOD_EXIT: 0 };
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const byMarket = _REPORT_MARKETS
    .map(market => {
      const mr = rows.filter(s => _marketOf(s) === market);
      if (!mr.length) return null;
      return {
        market,
        ..._directionStats(mr),
        LONG: _directionStats(mr.filter(s => s.direction === 'LONG')),
        SHORT: _directionStats(mr.filter(s => s.direction === 'SHORT')),
      };
    })
    .filter(Boolean);

  const sideStats = (side) => _directionStats(rows.filter(s => s.direction === side));

  const confidenceBuckets = _CONF_BUCKETS.map(({ label, test }) => {
    const br = rows.filter(s => test(_confOf(s)));
    return { bucket: label, ..._directionStats(br) };
  });
  const marginBuckets = _MARGIN_BUCKETS.map(({ label, test }) => {
    const br = rows.filter(s => test(_numOrNull(s.edgeMargin)));
    return { bucket: label, ..._directionStats(br) };
  });

  // Direction telemetry coverage — board rows legitimately lack engine
  // scores; the report must show how much of the sample is engine-tagged.
  let withDirScore = 0, withEdgeMargin = 0, directionalTies = 0;
  let marginWouldBlock = 0, marginCapped = 0, staleDetected = 0, staleCapped = 0;
  const marginGateModes = { off: 0, shadow: 0, enforce: 0, missing: 0 };
  for (const r of rows) {
    if (_dirScoreOf(r) != null) withDirScore++;
    if (_numOrNull(r.edgeMargin) != null) withEdgeMargin++;
    if (r.directionalTie === true) directionalTies++;
    const mg = String(r.marginGateMode || '').toLowerCase();
    marginGateModes[mg === 'off' || mg === 'shadow' || mg === 'enforce' ? mg : 'missing']++;
    if (r.marginWouldBlock === true) marginWouldBlock++;
    if (r.marginCapped === true) marginCapped++;
    if (r.staleDetected === true) staleDetected++;
    if (r.staleCapped === true) staleCapped++;
  }

  // v21.23.17: promotion readiness for the shadow-by-default direction
  // gates. Both cohorts are measured on settled outcomes only; null
  // telemetry (board rows / no TV reference) never counts as a clean row.
  const gateCfg = intradayDirectionGateConfig();
  const gateReadiness = {
    config: {
      marginGate: gateCfg.marginGate,
      minMargin: gateCfg.minMargin,
      staleGuard: gateCfg.staleGuard,
      staleMaxPct: gateCfg.staleMaxPct,
      noEdgeCap: INTRADAY_NO_EDGE_CAP,
    },
    margin: _gateReadiness({
      rows,
      mode: gateCfg.marginGate,
      blockedTest: r => {
        const m = _numOrNull(r.edgeMargin);
        return m != null && m < gateCfg.minMargin;
      },
      keptTest: r => {
        const m = _numOrNull(r.edgeMargin);
        return m != null && m >= gateCfg.minMargin;
      },
      thresholdLabel: 'edgeMargin',
      thresholdValue: gateCfg.minMargin,
      envFlag: 'INTRADAY_MARGIN_GATE',
    }),
    stale: _gateReadiness({
      rows,
      mode: gateCfg.staleGuard,
      blockedTest: r => r.staleDetected === true,
      // A false staleDetected with no TV reference is NOT clean evidence.
      keptTest: r => r.staleDetected === false && _numOrNull(r.ltpTvDivPct) != null,
      thresholdLabel: 'abs(ltpTvDivPct) >',
      thresholdValue: gateCfg.staleMaxPct,
      envFlag: 'INTRADAY_STALE_GUARD',
    }),
  };

  return {
    ok: true,
    days: windowDays,
    tab: wantMarket,
    generatedAt: Date.now(),
    note: 'Win-rate = settled outcomes only (pnl>0 vs pnl<0). FLIP churn and excluded rows are absent. MFE/MAE are not tracked, so their fields are null (never invented).',
    totals: {
      ..._directionStats(rows),
      trackedAllTime: allRows.length,
      outsideWindow: allRows.length - windowRows.length,
      excludedCount,
    },
    byStatus,
    byMarket,
    bySide: { LONG: sideStats('LONG'), SHORT: sideStats('SHORT') },
    confidenceBuckets,
    marginBuckets,
    telemetry: {
      withDirScore,
      missingDirScore: rows.length - withDirScore,
      withEdgeMargin,
      directionalTies,
      marginGateModes,
      marginWouldBlock,
      marginCapped,
      staleGuard: { detected: staleDetected, capped: staleCapped },
    },
    gateReadiness,
  };
}

// Boot-time reconciliation (called once from routes.js init).
export function initTrackRecord() {
  const events = [];
  reconcileStale(events);
  return events;
}
