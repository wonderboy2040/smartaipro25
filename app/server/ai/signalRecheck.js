// ============================================================
// server/ai/signalRecheck.js — v20.7.5 THE 15-SECOND SIGNAL RECHECK
// ------------------------------------------------------------
// THE USER'S ASK (verbatim intent): "AI ko sabhi trading 80+
// signals — Strong or Action signals — ko every 15 sec recheck
// karte rehna chahiye." The boards refresh on a 60s cadence and
// the STRONG-signal telegram scan runs ~30s — between those
// beats, a STRONG/ACTION signal could hit its stop, flip its
// committee side, or decay a whole grade with NOTHING watching.
//
// THE LOOP (every 15s, AI_SIGNAL_RECHECK=off to disable):
//   1. Read the CACHED boards (warmOnly — never triggers a cold
//      universe scan; a stopped board is simply a paused watch).
//   2. Watchlist = every STRONG + ACTION signal (the "80+ AI
//      score" tier and the tradeable tier below it) across all
//      four desks: CRYPTO · FUTURES · INDIA · GLOBALFUTURES.
//   3. Per-symbol LIVE price recheck: tick store first (free,
//      freshest), then each market's own cached batch chain.
//      → SL-through = INVALIDATED · deep adverse drift =
//      WEAKENING · T1/T2 touch = TARGET_1/TARGET_2 (freshness
//      only — the executors own the fills).
//   4. Staggered ENSEMBLE RE-VOTE: every 4th tick (~60s per
//      symbol, max 3 symbols/tick to bound cost) the cached
//      deep path re-votes the committee — side FLIP and grade
//      transitions are caught against the board snapshot.
//   5. Transition EVENTS (NEW · INVALIDATED · FLIPPED · DEMOTED
//      · PROMOTED · TARGET · RECOVERED · EXPIRED) land on the
//      row's event log AND on Telegram (deduped 30 min per
//      symbol+event — the insta-push pattern).
//   6. GET /api/ai/signal-recheck serves the live watchlist for
//      the frontend panel (15s poll parity with this loop).
//
// PURITY: everything price/transition-shaped is pure and
// injected (boards, LTP resolver, deep re-vote, telegram send) —
// unit-testable without a single live fetch (test/
// signalRecheck.test.ts). The module imports NOTHING from the
// server runtime except the pure liveInvalidationCheck — no
// import cycles by construction.
// ============================================================
import { liveInvalidationCheck } from './superIntel.js';
import { getActiveAutoTradesDeepMonitor } from './mtfAutoLink.js';

export const RECHECK_TICK_MS = 15_000;
export const RECHECK_GRADES = ['STRONG', 'ACTION'];
/** Staggered deep re-vote cadence: every Nth 15s tick (~60s/symbol). */
export const DEEP_REVOTE_EVERY_N_TICKS = 4;
/** Max symbols sent through the cached deep path per tick (cost bound). */
export const DEEP_REVOTE_BATCH = 3;
/** Telegram dedupe per symbol+event (matches the STRONG alerter). */
export const EVENT_COOLD_MS = 30 * 60_000;
/** A row that left the board is kept EXPIRED for this long, then dropped. */
export const EXPIRED_KEEP_MS = 5 * 60_000;
/** Live-tick staleness ceiling — older than this is not a "live" price. */
export const TICK_STALE_MS = 45_000;
/** ADRIFT threshold: price this many ATRs against the signal = WEAKENING. */
export const ADVERSE_ATR_X = 0.75;

const GRADE_RANK = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };
const _num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

export function recheckEnabled() {
  return String(process.env.AI_SIGNAL_RECHECK || '').toLowerCase() !== 'off';
}

// ---------------- pure: watchlist selection ----------------
/**
 * STRONG + ACTION rows from the cached boards → the watch map
 * ("MKT:SYM" → row). STRONG wins when both grades somehow appear
 * for one symbol (board + fresh deep re-vote racing).
 * @param {Array<{market: string, signals: Array}>} boards
 * @returns {Map<string, object>}
 */
export function selectWatchlist(boards) {
  const out = new Map();
  for (const b of (Array.isArray(boards) ? boards : [])) {
    const mkt = String(b?.market || '').toUpperCase();
    if (!mkt) continue;
    for (const s of (Array.isArray(b?.signals) ? b.signals : [])) {
      if (!s?.symbol) continue;
      const grade = String(s.grade || '').toUpperCase();
      if (!RECHECK_GRADES.includes(grade)) continue;
      // FLAT / dir-less rows carry no thesis to recheck.
      if (!s.side || s.side === 'FLAT') continue;
      const key = `${mkt}:${s.symbol}`;
      const row = {
        market: mkt,
        symbol: s.symbol,
        side: s.side,
        grade,
        confidence: _num(s.confidence),
        aiScore: _num(s.superIntel?.aiScore),
        entry: _num(s.plan?.entry),
        stopLoss: _num(s.plan?.stopLoss),
        target1: _num(s.plan?.target1),
        target2: _num(s.plan?.target2),
        atr: _num(s.plan?.atrUsed),
        boardAt: _num(s.generatedAt) || null,
      };
      const prev = out.get(key);
      if (!prev || (grade === 'STRONG' && prev.grade !== 'STRONG')) out.set(key, row);
    }
  }
  return out;
}

// ---------------- pure: one 15s price recheck ----------------
/**
 * Price-level verdict for one watched row against a live LTP.
 * SL-through = INVALIDATED (the plan is dead, do not enter);
 * >0.75 ATR adverse drift = WEAKENING (thesis under water);
 * T1/T2 touches = TARGET_1/TARGET_2 (opportunity freshness —
 * the executors own fills). Pure; never throws.
 * @returns {{state: string, reason: string, ltp: number|null, movePct: number|null}}
 */
export function recheckRow(row, liveLtp) {
  const px = _num(liveLtp);
  if (!row || !(px > 0)) return { state: 'PENDING', reason: 'live price unavailable', ltp: null, movePct: null };
  const long = String(row.side || 'LONG').toUpperCase() !== 'SHORT';

  // 1) the canonical SL check (superIntel's exported copy — the SAME
  //    rule the frontend mirror runs on every SSE tick)
  const inv = liveInvalidationCheck({
    side: row.side, liveLtp: px, stopLoss: row.stopLoss,
    entryZoneLow: null, entryZoneHigh: null, atr: row.atr,
  });
  if (inv?.status === 'invalidated') {
    return { state: 'INVALIDATED', reason: 'live price through stop-loss — signal stale, entry mat lo', ltp: px, movePct: _movePct(row, px, long) };
  }

  // 2) target touches (opportunity freshness)
  const t1 = _num(row.target1), t2 = _num(row.target2);
  if (t2 != null && t2 > 0 && (long ? px >= t2 : px <= t2)) {
    return { state: 'TARGET_2', reason: 'T2 already touched — runner book / trail zone', ltp: px, movePct: _movePct(row, px, long) };
  }
  if (t1 != null && t1 > 0 && (long ? px >= t1 : px <= t1)) {
    return { state: 'TARGET_1', reason: 'T1 touched — 40% book + SL breakeven zone', ltp: px, movePct: _movePct(row, px, long) };
  }

  // 3) adverse drift (not yet SL, but the thesis is under water)
  const atr = (_num(row.atr) > 0 ? _num(row.atr) : (_num(row.entry) > 0 ? _num(row.entry) * 0.012 : null));
  const entry = _num(row.entry);
  if (atr != null && atr > 0 && entry != null && entry > 0) {
    const adverse = long ? (entry - px) : (px - entry);
    if (adverse > ADVERSE_ATR_X * atr) {
      return { state: 'WEAKENING', reason: `price ${Math.round(adverse / atr * 100) / 100}×ATR against the signal — recheck before entry`, ltp: px, movePct: _movePct(row, px, long) };
    }
  }

  return { state: 'OK', reason: '', ltp: px, movePct: _movePct(row, px, long) };
}

function _movePct(row, px, long) {
  const entry = _num(row.entry);
  if (!(entry > 0)) return null;
  const pct = ((px - entry) / entry) * 100 * (long ? 1 : -1);
  return Math.round(pct * 100) / 100;
}

// ---------------- pure: committee transitions ----------------
/**
 * Board/deep consensus transition between two snapshots.
 * @returns {'NEW'|'DROPPED'|'FLIPPED'|'PROMOTED'|'DEMOTED'|null}
 */
export function detectTransition(prev, next) {
  const p = prev && prev.side ? prev : null;
  const n = next && next.side ? next : null;
  if (!p) return n ? 'NEW' : null;
  if (!n) return 'DROPPED';
  if (p.side !== 'FLAT' && n.side !== 'FLAT' && p.side !== n.side) return 'FLIPPED';
  const pr = GRADE_RANK[p.grade] ?? 0, nr = GRADE_RANK[n.grade] ?? 0;
  if (nr > pr) return 'PROMOTED';
  if (nr < pr) return 'DEMOTED';
  return null;
}

/** Price-state transition for event purposes (INVALIDATED/TARGET are
 *  sticky-worthy; OK-after-bad = RECOVERED). */
export function priceStateTransition(prevState, nextState) {
  if (prevState === nextState) return null;
  if (nextState === 'INVALIDATED' || nextState === 'FLIPPED') return nextState;
  if (nextState === 'TARGET_1' || nextState === 'TARGET_2') return nextState;
  if ((prevState === 'WEAKENING' || prevState === 'INVALIDATED') && nextState === 'OK') return 'RECOVERED';
  return null;
}

// ---------------- pure: event message ----------------
const _evEmoji = {
  NEW: '🆕', INVALIDATED: '🚨', FLIPPED: '🔄', DEMOTED: '⚠️',
  PROMOTED: '📈', TARGET_1: '🎯', TARGET_2: '🏆', RECOVERED: '✅',
  // v20.9.2 UCV-A1 (ultrafast chart verification transitions)
  UC_REJECTED: '⚡', UC_CONFIRMED: '🛡',
};
const _evLabel = {
  NEW: 'NEW SIGNAL UNDER 15s WATCH',
  INVALIDATED: 'SIGNAL INVALIDATED — SL THROUGH',
  FLIPPED: 'SIGNAL FLIPPED — OPPOSITE SIDE',
  DEMOTED: 'SIGNAL WEAKENING — GRADE DOWN',
  PROMOTED: 'SIGNAL STRENGTHENING — GRADE UP',
  TARGET_1: 'T1 TOUCHED',
  TARGET_2: 'T2 TOUCHED',
  RECOVERED: 'SIGNAL RECOVERED',
  // v20.9.2 UCV-A1 — the realtime ultrafast chart re-checked the
  // direction (the "pakka long jayega?" answer flipped states).
  UC_REJECTED: 'ULTRAFAST CHART REJECTED THE DIRECTION',
  UC_CONFIRMED: 'ULTRAFAST CHART CONFIRMED THE DIRECTION',
};

export function formatRecheckEvent(type, row, detail = {}) {
  const desk = row.market === 'INDIA' ? '🇮🇳 NSE' : row.market === 'FUTURES' ? '🛡 B-USDT Perps'
    : row.market === 'GLOBALFUTURES' ? '🌍 Global SIM' : '₿ Crypto';
  const px = _num(detail.ltp ?? row.ltp);
  const pxLine = px != null && detail.cur ? ` · live ${detail.cur}${px}` : '';
  const gradeLine = detail.grade != null ? ` · ${detail.grade}` : '';
  const why = detail.reason ? `\n${detail.reason}` : '';
  return [
    `${_evEmoji[type] || '🔔'} <b>${_evLabel[type] || 'SIGNAL RECHECK'}</b>`,
    `${desk} · <b>${row.symbol}</b> ${detail.side || row.side}${gradeLine}${pxLine}`,
    `15s recheck loop watch me hai — board refresh se pehle hi pakda gaya.`,
    ...(type === 'INVALIDATED' ? ['Plan stale hai — is signal par entry MAT karo.'] : []),
    ...(type === 'FLIPPED' ? ['Committee ab opposite side vote kar rahi hai — purana plan invalid.'] : []),
    // v20.9.2: the UCV-A1 transition lines — the direct answer to
    // "ye signal pakka apni direction me jayega?"
    ...(type === 'UC_REJECTED' ? [detail.ucAnswer || 'Realtime 1m ultrafast chart signal ke against chal raha hai — ye entry ulta direction me ja sakti hai, trade mat karo.'] : []),
    ...(type === 'UC_CONFIRMED' ? [detail.ucAnswer || 'Realtime 1m ultrafast chart direction confirm kar raha hai.'] : []),
  ].filter(Boolean).join('\n') + why;
}

// ---------------- the loop ----------------
const _state = {
  timer: null,
  ticking: false,
  tickN: 0,
  deps: null,       // { getSignals, getDeepSignal, depsForSignals, send, fetchLtp }
  rows: new Map(),  // "MKT:SYM" → live row (watch + runtime fields)
  events: [],       // last 30 loop-level events (panel feed)
  status: { started: false, startedAt: null, lastTickAt: null, ticks: 0, checks: 0, events: 0, lastError: null, boardsSeen: 0 },
};
const _pushedAt = new Map(); // "MKT:SYM:EVENT" → ts (telegram dedupe)

export function __rowsForTests() { return _state.rows; }
export function __eventsForTests() { return _state.events; }
export function __pushedAtForTests() { return _pushedAt; }

export function __resetSignalRecheckForTests() {
  if (_state.timer) { clearInterval(_state.timer); _state.timer = null; }
  _state.ticking = false;
  _state.tickN = 0;
  _state.rows.clear();
  _state.events.length = 0;
  _pushedAt.clear();
  Object.assign(_state.status, {
    started: false, startedAt: null, lastTickAt: null, ticks: 0, checks: 0, events: 0, lastError: null, boardsSeen: 0,
  });
}

function _recordEvent(type, row, detail) {
  const ev = {
    at: Date.now(), type, market: row.market, symbol: row.symbol,
    side: detail.side || row.side, grade: detail.grade || row.grade || null,
    ltp: _num(detail.ltp ?? row.ltp), reason: detail.reason || '',
  };
  _state.events.unshift(ev);
  if (_state.events.length > 30) _state.events.length = 30;
  const r = _state.rows.get(`${row.market}:${row.symbol}`);
  if (r) {
    r.events = r.events || [];
    r.events.unshift({ at: ev.at, type, note: ev.reason || ev.type });
    if (r.events.length > 5) r.events.length = 5;
  }
  _state.status.events++;
}

async function _pushEvent(type, row, detail) {
  const send = _state.deps?.send;
  if (typeof send !== 'function') return false;
  const key = `${row.market}:${row.symbol}:${type}`;
  const now = Date.now();
  if (now - (_pushedAt.get(key) || 0) < EVENT_COOLD_MS) return false;
  _pushedAt.set(key, now);
  if (_pushedAt.size > 200) {
    for (const [k, ts] of _pushedAt) if (now - ts > EVENT_COOLD_MS) _pushedAt.delete(k);
  }
  try {
    const r = await send(formatRecheckEvent(type, row, detail));
    return !!(r && r.ok !== false);
  } catch { return false; }
}

/** Merge the fresh board watchlist into the live row store (pure-ish:
 *  mutates _state.rows — extracted for testability via __rowsForTests). */
export function mergeWatchlist(watch) {
  const now = Date.now();
  const seen = new Set();
  for (const [key, w] of watch) {
    seen.add(key);
    const prev = _state.rows.get(key);
    if (!prev) {
      _state.rows.set(key, {
        ...w, firstSeenAt: now, lastCheckAt: null, lastDeepAt: null, checks: 0,
        ltp: null, ltpAt: null, ltpSrc: null, state: 'PENDING', reason: '', movePct: null, events: [],
      });
      _recordEvent('NEW', w, { side: w.side, grade: w.grade, ltp: w.entry, reason: `${w.grade} grade board pe detect hua — 15s watch shuru` });
      continue;
    }
    // Board refreshed the row — update the thesis fields but KEEP the
    // runtime fields (checks/ltp/events are the recheck loop's own).
    const tr = detectTransition({ side: prev.side, grade: prev.grade }, { side: w.side, grade: w.grade });
    // v20.9.4 FIX (L): prevGrade PEHLE capture karo — Object.assign neeche
    // prev.grade ko mutate kar deta tha, isliye reason hamesha "STRONG →
    // STRONG" jaisa tautological render hota tha (event log + TG push
    // dono me dead info).
    const prevGrade = prev.grade;
    const prevSideR = prev.side;
    // v20.9.3 FIX (L): side-flip pe stale UC verdict RESET — warna panel
    // naye side pe PURANE side ka verdict dikhata tha (LONG REJECTED →
    // SHORT row pe bhi "REJECTED" jabki SHORT ka verdict CONFIRMED ho
    // sakta hai) agle deep re-vote (~60s+) tak.
    const sideFlipped = prev.side !== w.side;
    Object.assign(prev, {
      side: w.side, grade: w.grade, confidence: w.confidence, aiScore: w.aiScore,
      entry: w.entry, stopLoss: w.stopLoss, target1: w.target1, target2: w.target2,
      atr: w.atr, boardAt: w.boardAt,
      ...(sideFlipped ? { ultrafastVerdict: null, ultrafastAnswer: null } : {}),
    });
    if (prev.state === 'EXPIRED') prev.state = 'PENDING';
    if (tr === 'FLIPPED' || tr === 'PROMOTED' || tr === 'DEMOTED') {
      _recordEvent(tr, prev, { side: w.side, grade: w.grade, ltp: prev.ltp, reason: `board refresh: ${prevSideR} ${prevGrade} → ${w.side} ${w.grade}` });
    }
  }
  // Rows the boards no longer publish: EXPIRED (kept for context, then dropped).
  for (const [key, row] of [..._state.rows]) {
    if (seen.has(key)) continue;
    if (row.state !== 'EXPIRED') {
      row.state = 'EXPIRED';
      row.reason = 'signal board se utar gaya (grade/consensus changed)';
      _recordEvent('DROPPED', row, { reason: 'board refresh pe signal nahi mila' });
    }
    // v20.7.5.1 fix: expiredAt is stamped on the FIRST expired pass — the
    // original order deleted the row immediately (Date.now() - 0 > keep).
    if (!row.expiredAt) row.expiredAt = now;
    else if (Date.now() - row.expiredAt > EXPIRED_KEEP_MS) _state.rows.delete(key);
  }
}

/** One loop tick. Exported for tests (called by the interval in prod). */
export async function recheckTick(now = Date.now()) {
  const deps = _state.deps;
  if (_state.ticking || !deps?.getSignals) return;
  _state.ticking = true;
  try {
    // 1) cached boards — warmOnly NEVER cold-scans (cheap by contract)
    const markets = ['CRYPTO', 'FUTURES', 'INDIA', 'GLOBALFUTURES'];
    const boards = await Promise.all(markets.map(async (mkt) => {
      const b = await deps.getSignals(mkt, deps.depsForSignals ? deps.depsForSignals() : {}, { warmOnly: true }).catch(() => null);
      return { market: mkt, signals: Array.isArray(b?.signals) ? b.signals : [] };
    }));
    _state.status.boardsSeen = boards.reduce((a, b) => a + b.signals.length, 0);

    // 2) Trigger 15s Auto-Trade Deep Monitor callback (sync active CoinDCX positions + dynamic SL trail + reversal profit book)
    if (typeof deps.onAutoTradeDeepTick === 'function') {
      try { await deps.onAutoTradeDeepTick(now); } catch { /* non-fatal */ }
    }

    // 2b) watchlist merge (NEW / board-side transitions / EXPIRED)
    const watch = selectWatchlist(boards);
    // v21.22.0: Merge MTF Dual-Timeframe Signal Board ELITE / STRONG / ACTION (75+) setups
    // into the 15s Signal Recheck Live Watchlist so every MTF Dual Board signal across
    // Crypto, Gold (XAU), Silver (XAG), Equity SIM, and India NSE is live-monitored every 15s!
    if (typeof deps.getMtfDualBoards === 'function') {
      try {
        const mtfBoards = await deps.getMtfDualBoards();
        for (const mb of (Array.isArray(mtfBoards) ? mtfBoards : [])) {
          const allMtfRows = [
            ...(Array.isArray(mb?.rows) ? mb.rows : []),
            ...(Array.isArray(mb?.metalsRows) ? mb.metalsRows : []),
            ...(Array.isArray(mb?.equitySimRows) ? mb.equitySimRows : []),
          ];
          for (const mr of allMtfRows) {
            if (!mr?.ok || !mr?.symbol || !(mr.side === 'LONG' || mr.side === 'SHORT')) continue;
            const tier = String(mr.tier || '').toUpperCase();
            const score = _num(mr.superScore) ?? 0;
            if (!(tier === 'ELITE' || tier === 'STRONG' || tier === 'ACTION' || score >= 75)) continue;
            if (mr.trapVeto || mr.zoneWallVeto || mr.reversalRisk) continue;
            const mktKey = (mr.assetClass === 'EQUITY_SIM' || mr.market === 'GLOBALFUTURES')
              ? 'GLOBALFUTURES'
              : (mr.market === 'INDIA' && mr.assetClass !== 'METALS' && mr.quoteCcy === 'INR')
                ? 'INDIA'
                : 'FUTURES';
            const symUp = String(mr.symbol).toUpperCase();
            const wKey = `${mktKey}:${symUp}`;
            const mappedGrade = (tier === 'ELITE' || tier === 'STRONG' || score >= 80) ? 'STRONG' : 'ACTION';
            const prev = watch.get(wKey);
            if (!prev || (mappedGrade === 'STRONG' && prev.grade !== 'STRONG') || (score > (prev.aiScore || 0))) {
              watch.set(wKey, {
                market: mktKey,
                symbol: symUp,
                side: mr.side,
                grade: mappedGrade,
                confidence: _num(mr.winRatePct ?? mr.superScore),
                aiScore: score,
                entry: _num(mr.plan?.entry),
                stopLoss: _num(mr.plan?.stopLoss),
                target1: _num(mr.plan?.t1),
                target2: _num(mr.plan?.t2),
                atr: null,
                boardAt: _num(mr.asOf) || now,
                fromMtfDualBoard: true,
              });
            }
          }
          _state.status.boardsSeen += allMtfRows.length;
        }
      } catch { /* non-fatal */ }
    }
    // v21.22.0: Pin any OPEN Active Traded Auto-Trade into the 15s Live Watch so active auto-trades
    // are ALWAYS deep-monitored every 15s until TP1 or TP2 hits!
    const activeAutoSnap = (() => {
      try { return getActiveAutoTradesDeepMonitor(); } catch { return { trades: [] }; }
    })();
    for (const at of (activeAutoSnap.trades || [])) {
      if (!at?.symbol || at.traded === false) continue;
      const mktKey = at.market === 'INDIA' ? 'INDIA' : 'FUTURES';
      const wKey = `${mktKey}:${at.symbol}`;
      if (!watch.has(wKey)) {
        watch.set(wKey, {
          market: mktKey,
          symbol: at.symbol,
          side: at.side,
          grade: at.tier || 'STRONG',
          confidence: at.score || 85,
          aiScore: at.score || 85,
          entry: at.entry,
          stopLoss: at.trailedStopLoss || at.initialStopLoss,
          target1: at.t1,
          target2: at.t2,
          atr: null,
          boardAt: at.openedAt || now,
          isAutoTrade: true,
        });
      } else {
        const ex = watch.get(wKey);
        ex.isAutoTrade = true;
        ex.stopLoss = at.trailedStopLoss || ex.stopLoss;
      }
    }
    mergeWatchlist(watch);

    // 3) live LTP sweep + price-state recheck (per market batch)
    const byMarket = new Map();
    for (const row of _state.rows.values()) {
      if (row.state === 'EXPIRED') continue;
      if (!byMarket.has(row.market)) byMarket.set(row.market, []);
      byMarket.get(row.market).push(row);
    }
    const curOf = (m) => m === 'FUTURES' ? 'USDT' : m === 'GLOBALFUTURES' ? 'USDC' : '₹';
    for (const [mkt, rows] of byMarket) {
      let quotes = new Map();
      if (typeof deps.fetchLtp === 'function') {
        try { quotes = await deps.fetchLtp(mkt, rows.map(r => r.symbol)) || new Map(); } catch { quotes = new Map(); }
      }
      for (const row of rows) {
        const q = quotes.get(row.symbol);
        const rc = recheckRow(row, _num(q?.price));
        row.checks++;
        _state.status.checks++;
        const hadLtp = row.ltp != null;
        row.ltp = rc.ltp ?? row.ltp;
        row.movePct = rc.movePct;
        if (rc.ltp != null) { row.ltpAt = now; row.ltpSrc = q?.src || null; }
        const prevPriceState = row.state;
        row.state = rc.state;
        row.reason = rc.reason;
        row.lastCheckAt = now;
        const ev = priceStateTransition(prevPriceState, rc.state);
        if (ev && hadLtp) {
          _recordEvent(ev, row, { ltp: rc.ltp, reason: rc.reason, cur: curOf(mkt) });
          _pushEvent(ev, row, { ltp: rc.ltp, reason: rc.reason, grade: row.grade, cur: curOf(mkt) }).catch(() => {});
        }
      }
    }

    // 4) staggered deep re-vote — the ensemble re-checks its own call
    //    (cached path: ~zero new upstream I/O; catches FLIP/grade drift)
    _state.tickN++;
    if (_state.tickN % DEEP_REVOTE_EVERY_N_TICKS === 0 && typeof deps.getDeepSignal === 'function') {
      const due = [..._state.rows.values()]
        .filter(r => r.state !== 'EXPIRED')
        .sort((a, b) => (a.lastDeepAt || 0) - (b.lastDeepAt || 0))
        .slice(0, DEEP_REVOTE_BATCH);
      for (const row of due) {
        try {
          const deep = await deps.getDeepSignal(row.symbol, row.market, deps.depsForSignals ? deps.depsForSignals() : {});
          row.lastDeepAt = now;
          if (deep?.ok && deep.signal && deep.signal.side && deep.signal.side !== 'FLAT') {
            const s = deep.signal;
            const tr = detectTransition({ side: row.side, grade: row.grade }, { side: s.side, grade: s.grade });
            const prevSide = row.side;
            const prevGrade2 = row.grade; // v20.9.4 [L]: assign se PEHLE capture
            row.side = s.side;
            row.grade = s.grade;
            row.confidence = _num(s.confidence) ?? row.confidence;
            row.aiScore = _num(s.superIntel?.aiScore) ?? row.aiScore;
            // v20.9.2 UCV-A1 — the deep re-vote rides the ultrafast
            // verdict (attached by the deep path); a transition to
            // REJECTED/CONFIRMED raises the event. This is the 15s-loop
            // arm of the "80+ signals recheck" ask.
            const ucV = s.ultrafast?.verdict || null;
            const prevUc = row.ultrafastVerdict || null;
            if (ucV && ucV !== prevUc) {
              row.ultrafastVerdict = ucV;
              row.ultrafastAnswer = s.ultrafast?.answer || null;
              if (ucV === 'REJECTED' || (ucV === 'CONFIRMED' && prevUc === 'REJECTED')) {
                const evType = ucV === 'REJECTED' ? 'UC_REJECTED' : 'UC_CONFIRMED';
                const ucDetail = {
                  side: s.side, grade: s.grade, ltp: row.ltp, cur: curOf(row.market),
                  reason: s.ultrafast?.detail || '',
                  ucAnswer: s.ultrafast?.answer || '',
                };
                _recordEvent(evType, row, ucDetail);
                _pushEvent(evType, row, ucDetail).catch(() => {});
              }
            }
            if (_num(s.plan?.entry) != null) {
              row.entry = _num(s.plan.entry);
              row.stopLoss = _num(s.plan.stopLoss);
              row.target1 = _num(s.plan.target1);
              row.target2 = _num(s.plan.target2);
              row.atr = _num(s.plan.atrUsed) ?? row.atr;
            }
            if (tr === 'FLIPPED' || tr === 'PROMOTED' || tr === 'DEMOTED') {
              _recordEvent(tr, row, {
                side: s.side, grade: s.grade, ltp: row.ltp,
                // v20.9.4 [L]: prevGrade bhi — warna "LONG STRONG → SHORT
                // STRONG" me pehla grade naye grade se replace hota tha.
                reason: `ensemble re-vote: ${prevSide} ${prevGrade2} → ${s.side} ${s.grade} (conf ${s.confidence}%)`,
              });
              _pushEvent(tr, row, { side: s.side, grade: s.grade, ltp: row.ltp, cur: curOf(row.market) }).catch(() => {});
            }
          }
        } catch { /* one symbol's re-vote never kills the tick */ }
      }
    }

    _state.status.ticks++;
    _state.status.lastTickAt = now;
    _state.status.lastError = null;
  } catch (e) {
    _state.status.lastError = String(e?.message || e).slice(0, 160);
  } finally {
    _state.ticking = false;
  }
}

/**
 * Boot the 15s recheck loop (idempotent). Injected deps keep this
 * pure-testable AND cycle-free:
 *   getSignals(mkt, deps, { warmOnly: true })  cached board read
 *   getDeepSignal(sym, mkt, deps)             cached ensemble re-vote
 *   depsForSignals()                          the routes' dep bag
 *   send(text) → { ok }                       telegram (optional)
 *   fetchLtp(mkt, symbols) → Map<sym, {price, src}>
 */
export function startSignalRecheckLoop(deps = {}) {
  if (_state.deps == null && deps) _state.deps = deps;
  else if (deps) _state.deps = { ..._state.deps, ...deps };
  if (_state.timer) return;
  if (!recheckEnabled()) { _state.status.enabled = false; return; }
  _state.status.started = true;
  _state.status.startedAt = Date.now();
  _state.timer = setInterval(() => { recheckTick().catch(() => {}); }, RECHECK_TICK_MS);
  if (typeof _state.timer.unref === 'function') _state.timer.unref();
  console.log(`[signal-recheck] 15s STRONG/ACTION recheck loop armed (ticks ${RECHECK_TICK_MS / 1000}s · deep re-vote every ${DEEP_REVOTE_EVERY_N_TICKS}th tick ×${DEEP_REVOTE_BATCH})`);
}

/** The panel/API view — the watchlist with runtime state + loop health. */
export function signalRecheckStatus() {
  const now = Date.now();
  const liveQuotesFromRows = {};
  for (const r of _state.rows.values()) {
    if (r?.symbol && Number(r?.ltp) > 0) {
      liveQuotesFromRows[r.symbol] = r.ltp;
      liveQuotesFromRows[`${r.market}|${r.symbol}`] = r.ltp;
    }
  }
  const autoTradeDeepMonitor = (() => {
    try { return getActiveAutoTradesDeepMonitor(liveQuotesFromRows); } catch { return { activeCount: 0, trailingActiveCount: 0, tp1LockedCount: 0, reversalAlertCount: 0, trades: [], checkedAt: now }; }
  })();
  const autoMap = new Map((autoTradeDeepMonitor.trades || []).map(t => [String(t.symbol || '').toUpperCase(), t]));

  const rows = [..._state.rows.values()].map(r => {
    const autoMon = autoMap.get(String(r.symbol || '').toUpperCase()) || null;
    return {
      market: r.market, symbol: r.symbol, side: r.side, grade: r.grade,
      confidence: r.confidence ?? null, aiScore: r.aiScore ?? null,
      entry: r.entry ?? null, stopLoss: autoMon?.trailedStopLoss ?? r.stopLoss ?? null,
      target1: r.target1 ?? null, target2: r.target2 ?? null,
      ltp: r.ltp ?? autoMon?.ltp ?? null, ltpAt: r.ltpAt ?? null, ltpAgeS: r.ltpAt ? Math.max(0, Math.round((now - r.ltpAt) / 1000)) : null,
      ltpSrc: r.ltpSrc || null, movePct: r.movePct ?? null,
      state: r.state, reason: r.reason || '',
      // v20.9.2 UCV-A1 — the realtime ultrafast chart verdict on the row
      ultrafast: r.ultrafastVerdict || null,
      ultrafastAnswer: r.ultrafastAnswer || null,
      checks: r.checks || 0,
      firstSeenAt: r.firstSeenAt ?? null, lastCheckAt: r.lastCheckAt ?? null,
      lastCheckAgeS: r.lastCheckAt ? Math.max(0, Math.round((now - r.lastCheckAt) / 1000)) : null,
      lastDeepAt: r.lastDeepAt ?? null,
      events: r.events || [],
      isAutoTrade: Boolean(r.isAutoTrade || autoMon),
      autoTradeMonitor: autoMon,
    };
  });
  // panel ordering: Active Auto-Trades first, then problems, then by grade, then by recency
  const stateRank = { INVALIDATED: 0, FLIPPED: 0, WEAKENING: 1, TARGET_2: 2, TARGET_1: 2, PENDING: 3, OK: 4, EXPIRED: 5 };
  rows.sort((a, b) => (b.isAutoTrade ? 1 : 0) - (a.isAutoTrade ? 1 : 0)
    || (stateRank[a.state] ?? 3) - (stateRank[b.state] ?? 3)
    || (b.grade === 'STRONG' ? 1 : 0) - (a.grade === 'STRONG' ? 1 : 0)
    || (b.lastCheckAt || 0) - (a.lastCheckAt || 0));
  return {
    ok: true,
    enabled: recheckEnabled(),
    started: _state.status.started,
    tickMs: RECHECK_TICK_MS,
    startedAt: _state.status.startedAt,
    lastTickAt: _state.status.lastTickAt,
    nextTickIn: _state.status.lastTickAt ? Math.max(0, RECHECK_TICK_MS - (now - _state.status.lastTickAt)) : null,
    ticks: _state.status.ticks,
    checks: _state.status.checks,
    events: _state.status.events,
    boardsSeen: _state.status.boardsSeen,
    watched: rows.filter(r => r.state !== 'EXPIRED').length,
    lastError: _state.status.lastError,
    eventsFeed: _state.events.slice(0, 12),
    autoTradeDeepMonitor,
    rows,
    note: 'Har STRONG/ACTION signal + Active Auto-Trade har 15s me live-price recheck aur Deep Monitor hota hai (Dynamic SL Trail · Reversal Profit-Book · T1/T2 touch) aur ~60s me committee re-vote. Events Telegram par bhi jate hain.',
  };
}

/** Live LTP resolver wired in routes.js (kept HERE so tests can import
 *  the pure selection/recheck logic without the server runtime). */
export function buildTickStoreResolver({ getTick, staleMs = TICK_STALE_MS } = {}) {
  if (typeof getTick !== 'function') return () => null;
  return (market, symbol) => {
    const k = market === 'FUTURES' ? `FUT_${symbol}` : market === 'GLOBALFUTURES' ? `GLOB_${symbol}` : `IN_${symbol}`;
    const t = getTick(k);
    const px = _num(t?.price);
    if (px != null && px > 0 && Date.now() - (t.time || 0) < staleMs) return { price: px, src: 'tick' };
    return null;
  };
}
