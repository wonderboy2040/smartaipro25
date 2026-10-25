// ============================================================
// server/ai/signalMemory.js — v12.4 SIGNAL CONTINUITY ENGINE
// ------------------------------------------------------------
// The WLD incident class: a LONG signal card → user enters → the
// board flips SHORT within minutes → the symbol later vanishes from
// the board entirely (consensus FLAT / fell out of the top-N cut) —
// and the user is left staring at a negative position with ZERO
// context about what the AI thinks NOW or how OLD the signal was.
//
// This module closes all three gaps at the SOURCE:
//
//  1. CONTINUITY (age + flips): every board/deep observation of a
//     (market, symbol) is remembered — when this DIRECTION first
//     appeared (firstSeenAt), when last confirmed (lastSeenAt), how
//     many side-flips happened in 24h. The card can finally say
//     "⏱ 12m ka signal hai" vs "⏱ 40s FRESH (unstable)".
//
//  2. TRUST GUARDS (pro-trader entry discipline):
//     • OVERBOUGHT/OVERSOLD HARD GUARD — RSI ≥ 70 kills a LONG card's
//       ACTION/STRONG badge (cap WATCH); RSI ≤ 30 does the same to a
//       SHORT. Extreme (≥78 / ≤22) cuts confidence harder. The same
//       guard runs on the DEEP path the LIVE execution gate reads —
//       so a live LONG on an overbought perp is rejected at gate 5.
//     • FLIP COOLDOWN — a signal whose side JUST flipped (< 5 min)
//       cannot wear ACTION/STRONG either (whipsaw protection: the
//       "board pe LONG dikha, entry ke turant baad SHORT" trap);
//       5-10 min after a flip takes a small confidence haircut.
//
//  3. PERSISTENCE (holding pin): open journal positions + manual
//     trades are read; symbols with money on the line are PINNED on
//     the board (never vanish) with the AI's CURRENT view stamped on
//     the card — "🎯 HOLDING LONG @ 0.4385 · AI abhi neutral hai".
//
// Design rules: never throws (guards degrade honestly), bounded
// memory (400 records LRU), file persistence is debounced + optional
// (read-only FS ⇒ memory-only), no imports from signals.js (cycles).
//
// v12.5 CHASE GUARD (see entryTiming.js — the "long bola tho short
// chala gaya" fix): the RSI-only OB/OS guard misses the vertical
// run (RSI 63 on a +6% leg is still a top-tick entry). The
// structural read — ATR-distance from the mean + the one-way candle
// run — is now applied with the same discipline ladder (HARD →
// WATCH cap + conf cap; SOFT → haircut), on BOTH the board and the
// deep path the execution gate reads.
// ============================================================
import {
  loadJSON, saveJSON,
} from '../lib/store.js';
import { normalizeSide } from './directionCertificate.js'; // v21.25.0: strict side
import {
  entryTimingRead, CHASE_HARD_CONF_CAP, CHASE_SOFT_CONF_PENALTY,
  QUALITY_PULLBACK_CONF_BOOST, QUALITY_EXTENDED_CONF_PENALTY,
} from './entryTiming.js';

// ---------------- knobs (exported for tests) ----------------
export const OB_RSI = 70;          // LONG suppressed at/above
export const OS_RSI = 30;          // SHORT suppressed at/below
export const OB_RSI_EXTREME = 78;  // harsher confidence cut
export const OS_RSI_EXTREME = 22;
// v21.13 TUNING: 5min/10min + the 60s board cache meant the card kept
// showing the OLD side for up to 6 minutes into a genuine reversal (the
// "late on reversals" half of the opposite-direction complaint). 2min
// hard / 5min soft keeps the anti-whipsaw floor while flipping fast
// enough to matter intraday (tape-MTF + strict-agreement already guard
// the quality side).
export const FLIP_COOLDOWN_MS = 2 * 60_000;   // fresh flip → WATCH cap (was 5min)
export const FLIP_SOFT_MS = 5 * 60_000;      // fresh-ish flip → conf haircut (was 10min)
export const FLIP_SOFT_CONF_PENALTY = 8;
export const OB_OS_CONF_CAP = 50;             // conf floor when OB/OS tripped
export const OB_OS_EXTREME_CONF_CAP = 42;
export const FLIP_CONF_CAP = 52;
export const MAX_MEMORY_RECORDS = 400;        // LRU bound
export const HOLDING_VIEW_STALE_MS = 15 * 60_000; // pinned card AI-view age cap
export const MEMORY_FILE = 'ai-signal-memory.json';

const GRADE_RANK = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };

// ---------------- the continuity store ----------------
/** @type {Map<string, object>} `${MARKET}:${SYMBOL}` → record */
const _mem = new Map();
let _loaded = false;
let _saveTimer = null;

function _key(market, symbol) {
  return `${String(market || '').toUpperCase()}:${String(symbol || '').toUpperCase()}`;
}

function _loadFromDisk() {
  if (_loaded) return;
  _loaded = true;
  try {
    const disk = loadJSON(MEMORY_FILE, { records: {} });
    const records = disk?.records;
    if (records && typeof records === 'object' && !Array.isArray(records)) {
      // prune anything older than 48h on boot — flips24h only needs 24h
      const cutoff = Date.now() - 48 * 3600_000;
      for (const [k, v] of Object.entries(records)) {
        if (v && typeof v === 'object' && (Number(v.lastSeenAt) || 0) >= cutoff) _mem.set(k, v);
      }
    }
  } catch { /* memory-only mode */ }
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      // bounded serialization: newest 400 by lastSeenAt
      const entries = [..._mem.entries()]
        .sort((a, b) => (Number(b[1]?.lastSeenAt) || 0) - (Number(a[1]?.lastSeenAt) || 0))
        .slice(0, MAX_MEMORY_RECORDS);
      saveJSON(MEMORY_FILE, { at: Date.now(), records: Object.fromEntries(entries) });
    } catch { /* best-effort persistence */ }
  }, 3000);
  _saveTimer.unref?.();
}

function _prune() {
  if (_mem.size <= MAX_MEMORY_RECORDS) return;
  const entries = [..._mem.entries()]
    .sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
  const drop = _mem.size - MAX_MEMORY_RECORDS;
  for (let i = 0; i < drop; i++) _mem.delete(entries[i][0]);
}

/**
 * Record one observation of a symbol's consensus view. Side may be
 * 'LONG' | 'SHORT' | 'FLAT' (FLAT clears the current side but keeps
 * the last directional view for pinned cards / continuity).
 * @returns the CURRENT (post-update) record — a plain object.
 */
export function remember(market, symbol, { side, confidence, grade, ltp } = {}) {
  _loadFromDisk();
  const key = _key(market, symbol);
  const now = Date.now();
  const rec = _mem.get(key) || {
    side: null, firstSeenAt: null, lastSeenAt: null,
    lastConf: null, lastGrade: null, lastLtp: null,
    prevSide: null, flippedAt: null, flips: [],
    lastDirSide: null, lastDirSeenAt: null, lastDirGrade: null, lastDirConf: null,
  };
  const normalizedSide = normalizeSide(side);
  // The flip baseline is the last DIRECTIONAL side (rec.side is null
  // while FLAT — a FLAT gap must not turn the NEXT directional view
  // into a "flip from null"; LONG→FLAT→LONG resumes, LONG→FLAT→SHORT
  // genuinely flips from LONG).
  const wasSide = rec.side || rec.lastDirSide || null;

  if (normalizedSide) {
    if (wasSide !== normalizedSide) {
      // first sighting of THIS direction (a genuine flip, or the
      // symbol's first-ever directional view — only a REAL flip from
      // another side is counted in the history)
      rec.firstSeenAt = now;
      if (wasSide != null) {
        rec.prevSide = wasSide;
        rec.flippedAt = now;
        rec.flips = [
          ...(Array.isArray(rec.flips) ? rec.flips : []),
          { at: now, from: wasSide, to: normalizedSide },
        ].filter(f => now - (Number(f?.at) || 0) < 24 * 3600_000).slice(-20);
      }
    }
    rec.side = normalizedSide;
    rec.lastDirSide = normalizedSide;
    rec.lastDirSeenAt = now;
    rec.lastDirGrade = grade ?? rec.lastDirGrade ?? null;
    rec.lastDirConf = Number.isFinite(Number(confidence)) ? Number(confidence) : rec.lastDirConf ?? null;
  } else {
    // FLAT: the direction is over, but the last directional view
    // (side/grade/when) is preserved for pinned holding cards.
    rec.side = null;
    rec.firstSeenAt = null;
  }
  rec.lastSeenAt = now;
  if (grade != null) rec.lastGrade = grade;
  if (Number.isFinite(Number(confidence))) rec.lastConf = Number(confidence);
  if (Number(ltp) > 0) rec.lastLtp = Number(ltp);

  _mem.set(key, rec);
  _prune();
  _scheduleSave();
  return { ...rec, flips: [...(rec.flips || [])] };
}

/** Read API — snapshot of a symbol's continuity (computed ages included). */
export function continuityOf(market, symbol) {
  _loadFromDisk();
  const rec = _mem.get(_key(market, symbol));
  if (!rec) return null;
  const now = Date.now();
  return {
    ...rec,
    flips: [...(rec.flips || [])],
    ageMs: rec.side && rec.firstSeenAt ? now - rec.firstSeenAt : null,
    flipAgeMs: rec.flippedAt ? now - rec.flippedAt : null,
    flips24h: (rec.flips || []).filter(f => now - (Number(f?.at) || 0) < 24 * 3600_000).length,
    lastDirAgeMs: rec.lastDirSeenAt ? now - rec.lastDirSeenAt : null,
  };
}

/** Reset hook for tests (clears memory + pending save). */
export function __resetSignalMemoryForTests() {
  _mem.clear();
  _loaded = true; // tests that DO want disk use the store mock
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
}

// ---------------- symbol normalization ----------------
/**
 * Normalize any pair/symbol spelling to the board's base key.
 * "B-WLD_USDT" → WLD · "WLDINR" → WLD · "WLD-USDT" → WLD · "NVDA-USD" → NVDA.
 */
export function normSym(s) {
  return String(s || '').toUpperCase()
    .replace(/^B-/, '')
    .replace(/_USDT$/, '')
    .replace(/-USDT$/, '')
    .replace(/-USD$/, '')
    .replace(/INR$/, '')
    .replace(/USDT$/, '');
}

// ---------------- the trust guards ----------------
/**
 * Apply the v12.4 SIGNAL TRUST GUARDS to a finalized consensus and
 * remember the observation. PURE-ish: touches only this module's
 * store; NEVER throws; NEVER changes side/ltp (plans stay valid).
 *
 * @param {object} p { market, symbol, consensus, ctx, ltf }
 *   ltf: the LTF indicator set ({@ltfInd}) — RSI preferred from the
 *   trading timeframe, ctx.ind.rsi (daily TV) as the fallback.
 * @returns the (possibly new) consensus object with signalAge /
 *   obOs / freshFlip attached and grade/confidence disciplined.
 */
export function applySignalTrustGuards({ market, symbol, consensus, ctx, ltf } = {}) {
  try {
    if (!consensus || typeof consensus !== 'object') return consensus || null;
    const side = normalizeSide(consensus.side);

    // RSI: LTF (trading timeframe) first — it is what the entry rides on.
    const rsiCandidates = [ltf?.rsi, ctx?.__ltfInd?.rsi, ctx?.ind?.rsi];
    let rsi = null;
    for (const r of rsiCandidates) {
      const n = Number(r);
      if (Number.isFinite(n) && n >= 0 && n <= 100) { rsi = n; break; }
    }

    // 1. remember the observation (both directional and FLAT views —
    //    a FLAT after a LONG is exactly when the pinned card must say
    //    "AI abhi neutral hai").
    const rec = remember(market, symbol, {
      side: consensus.side, confidence: consensus.confidence, grade: consensus.grade, ltp: ctx?.ltp,
    });
    if (!side) return consensus; // FLAT — guards below are entry discipline

    const now = Date.now();
    const out = { ...consensus };
    const notes = [];

    // ---- OVERBOUGHT / OVERSOLD hard guard ----
    let obOs = null;
    if (side === 'LONG' && rsi != null && rsi >= OB_RSI) {
      const extreme = rsi >= OB_RSI_EXTREME;
      obOs = { tag: 'OVERBOUGHT', rsi: Math.round(rsi * 10) / 10, extreme };
    } else if (side === 'SHORT' && rsi != null && rsi <= OS_RSI) {
      const extreme = rsi <= OS_RSI_EXTREME;
      obOs = { tag: 'OVERSOLD', rsi: Math.round(rsi * 10) / 10, extreme };
    }
    if (obOs) {
      const cap = obOs.extreme ? OB_OS_EXTREME_CONF_CAP : OB_OS_CONF_CAP;
      out.confidence = Math.min(Number(out.confidence) || 0, cap);
      if ((GRADE_RANK[out.grade] ?? 0) > GRADE_RANK.WATCH) out.grade = 'WATCH';
      out.obOs = obOs;
      notes.push(`⛔ ${obOs.tag} RSI ${obOs.rsi} — ${side} entry suppressed (chase hi hota hai ye)`);
    }

    // ---- v12.5 CHASE GUARD (structural extension) ----
    // Catches what RSI alone misses: a +6% vertical run printing RSI
    // 63 (under the OB/OS bar) is STILL a top-tick LONG. Distance
    // from the mean in ATR units + the one-way candle run decide.
    // Same rules as OB/OS: never flips the side, never touches ltp
    // — the ENTRY is suppressed (grade/conf), the card stays honest.
    const timing = entryTimingRead({
      side,
      ltp: ctx?.ltp ?? ltf?.ltp,
      ema20: ltf?.ema20 ?? ctx?.ind?.ema20,
      // v21.13 SESSION-VWAP ANCHOR FIX (India): pehle ltf.vwap (candle
      // series ka MONTH-anchored VWAP) padha jata tha — production me
      // trending days pe extension ko massively overstate karta tha
      // (session-mean pe entry ko "4×ATR chase" declare kar ke GOOD
      // entries suppress — the tape seat ka documented note yahi kehta
      // hai: "the month-anchored candle VWAP is not a session anchor").
      // India ka intraday anchor = TV row ka SESSION VWAP (ctx.__tv.vwap).
      vwap: String(market || '').toUpperCase() === 'INDIA'
        ? (ctx?.__tv?.vwap ?? ltf?.vwap)
        : ltf?.vwap,
      atr: ltf?.atr ?? ctx?.ind?.atr,
      rsi,
      candles: ctx?.candles,
      market,
    });
    if (timing && (timing.severity || timing.extAtr != null || timing.runBars > 0)) {
      out.chasing = timing;
      if (timing.severity === 'HARD') {
        out.confidence = Math.min(Number(out.confidence) || 0, CHASE_HARD_CONF_CAP);
        if ((GRADE_RANK[out.grade] ?? 0) > GRADE_RANK.WATCH) out.grade = 'WATCH';
        notes.push(`🚀 CHASING — ${timing.reason} — ${side} entry suppressed (pullback ka wait karo)`);
      } else if (timing.severity === 'SOFT') {
        out.confidence = Math.max(5, (Number(out.confidence) || 0) - CHASE_SOFT_CONF_PENALTY);
        notes.push(`🚀 extended — ${timing.reason}`);
      }
      // ---- v12.6 ENTRY-QUALITY BANDS (the positive side) ----
      // PULLBACK: conf boost (the entry zone the board should RANK top).
      // EXTENDED: light haircut. Never touches side/ltp; only fires when
      // the timing read actually computed an extension.
      if (timing.quality === 'PULLBACK') {
        out.entryQuality = { band: 'PULLBACK', extAtr: timing.extAtr, ref: timing.ref, note: timing.qualityNote };
        out.confidence = Math.min(100, (Number(out.confidence) || 0) + QUALITY_PULLBACK_CONF_BOOST);
        notes.push(`🌊 PULLBACK — ${timing.qualityNote}`);
      } else if (timing.quality === 'EXTENDED') {
        out.entryQuality = { band: 'EXTENDED', extAtr: timing.extAtr, ref: timing.ref, note: timing.qualityNote };
        out.confidence = Math.max(5, (Number(out.confidence) || 0) - QUALITY_EXTENDED_CONF_PENALTY);
        notes.push(`📐 extended — ${timing.qualityNote}`);
      }
    }

    // ---- FLIP COOLDOWN (anti-whipsaw) ----
    const flipAgeMs = rec.flippedAt ? now - rec.flippedAt : null;
    let freshFlip = null;
    if (flipAgeMs != null && rec.prevSide && flipAgeMs >= 0) {
      if (flipAgeMs < FLIP_COOLDOWN_MS) {
        freshFlip = { from: rec.prevSide, to: side, ageSec: Math.round(flipAgeMs / 1000) };
        out.freshFlip = freshFlip;
        out.confidence = Math.min(Number(out.confidence) || 0, FLIP_CONF_CAP);
        if ((GRADE_RANK[out.grade] ?? 0) > GRADE_RANK.WATCH) out.grade = 'WATCH';
        notes.push(`🔄 signal ${Math.round(flipAgeMs / 60000)}m pehle FLIP hua (${freshFlip.from}→${freshFlip.to}) — unstable, wait for confirmation`);
      } else if (flipAgeMs < FLIP_SOFT_MS) {
        out.confidence = Math.max(5, (Number(out.confidence) || 0) - FLIP_SOFT_CONF_PENALTY);
        notes.push(`🔄 flip ${Math.round(flipAgeMs / 60000)}m pehle — light haircut`);
      }
    }

    // ---- AGE attach (the user's "kitna purana signal hai") ----
    const flips24h = (rec.flips || []).filter(f => now - (Number(f?.at) || 0) < 24 * 3600_000).length;
    out.signalAge = {
      firstSeenAt: rec.firstSeenAt ?? now,
      lastSeenAt: rec.lastSeenAt ?? now,
      ageMs: rec.firstSeenAt ? now - rec.firstSeenAt : 0,
      flips24h,
    };

    if (notes.length > 0) out.summary = `${consensus.summary} · ${notes.join(' · ')}`;
    return out;
  } catch {
    return consensus; // guards NEVER break the signal
  }
}

// ---------------- holding positions (pinning source) ----------------
/**
 * Open positions for a market from BOTH stores (direct file reads —
 * no import cycles with the order modules):
 *   • ai-trading-journal.json positions[] (auto + desk trades —
 *     status OPEN/UNKNOWN, market field: INDIA/CRYPTO/FUTURES/GLOBALFUTURES)
 *   • manual-trades.json trades[] (the "Maine ye trade liya" tracker)
 * @returns [{ symbol, side, entryPrice, qty, mode, source, openedAt, via }]
 */
export function holdingPositions(market) {
  const mkt = String(market || '').toUpperCase();
  const out = [];
  const push = (p, via) => {
    if (!p) return;
    // v21.25.0 [NO SILENT LONG]: unknown side pehle LONG pin ho jaata tha.
    // Ab invalid side = koi holding card nahi (guess nahi).
    const side = normalizeSide(p.side);
    if (!side) return;
    const symbol = normSym(p.symbol || p.pair || '');
    if (!symbol) return;
    out.push({
      symbol,
      side,
      entryPrice: Number(p.entryPrice) > 0 ? Number(p.entryPrice) : null,
      qty: Number(p.qty) || 0,
      mode: p.mode || null,
      source: p.source || null,
      openedAt: Number(p.openedAt) || Number(p.entryTime) || null,
      via,
    });
  };
  try {
    const j = loadJSON('ai-trading-journal.json', { entries: [], positions: [] });
    for (const p of (Array.isArray(j.positions) ? j.positions : [])) {
      if (p?.status !== 'OPEN' && p?.status !== 'UNKNOWN') continue;
      if (String(p.market || '').toUpperCase() !== mkt) continue;
      push(p, 'journal');
    }
  } catch { /* journal unreadable — pinning degrades */ }
  try {
    const mt = loadJSON('manual-trades.json', { trades: [] });
    for (const t of (Array.isArray(mt.trades) ? mt.trades : [])) {
      if (!t || t.status === 'CLOSED') continue;
      if (String(t.market || '').toUpperCase() !== mkt) continue;
      push({
        symbol: t.symbol, pair: t.symbol,
        side: t.side,
        entryPrice: t.entryPrice, qty: t.qty, mode: 'manual', source: 'manual',
        openedAt: t.entryTime || t.createdAt || null,
      }, 'manual');
    }
  } catch { /* manual tracker unreadable — pinning degrades */ }
  return out;
}

/**
 * Build the PINNED board card for an open position whose symbol fell
 * out of the board (consensus FLAT / below the top-N cut / wick-suppressed).
 * Honest by construction: grade never above WATCH, no plan, no votes,
 * executable=false. v12.7 (recheck R1-#4): the card's TOP-LEVEL side is
 * now the POSITION's side (it used to headline the AI's current view —
 * a held LONG rendered under a SHORT-labeled card, which the user
 * fairly read as "direction galat"). The AI's CURRENT view rides the
 * new `aiView` sub-chip ("AI abhi SHORT dekh raha hai") + the summary.
 */
export function buildHoldingCard(h, market) {
  const mkt = String(market || '').toUpperCase();
  const cont = continuityOf(mkt, h.symbol);
  const now = Date.now();
  const viewFresh = cont && cont.lastSeenAt && (now - cont.lastSeenAt) < HOLDING_VIEW_STALE_MS;
  const viewSide = viewFresh ? (cont.side || cont.lastDirSide) : (cont?.lastDirSide || null);
  // v12.7: the POSITION side headlines — the card is the position's
  // context, not a fresh trade call. The AI's live view (which can be
  // the OPPOSITE side) moved to `aiView` + summary so a held LONG can
  // never render as a SHORT card again.
  const side = h.side;
  const grade = viewFresh && cont.lastGrade && (GRADE_RANK[cont.lastGrade] ?? 0) > GRADE_RANK.WATCH
    ? 'WATCH' : 'NEUTRAL';
  const viewNote = viewFresh
    ? (cont.side
      ? `AI view: ${cont.lastGrade || '—'} ${cont.side} · conf ${cont.lastConf ?? '—'}%`
      : `AI abhi NEUTRAL hai (last directional view: ${cont.lastDirSide || '—'}${cont.lastDirSeenAt ? ` ${Math.round((now - cont.lastDirSeenAt) / 60000)}m pehle` : ''})`)
    : 'AI view stale (symbol board scan se bahar) — Monitor panel me position dekho';
  const ageMin = h.openedAt ? Math.max(0, Math.round((now - h.openedAt) / 60000)) : null;
  return {
    symbol: h.symbol,
    market: mkt,
    side,
    // v12.7: the AI's CURRENT directional view (position-opposite reads
    // possible) — rendered as a sub-chip, never as the card's side.
    ...(viewSide ? { aiView: { side: viewSide, grade: cont?.lastGrade || null, conf: Number.isFinite(Number(cont?.lastConf)) ? Number(cont.lastConf) : null, fresh: !!viewFresh } } : {}),
    grade,
    confidence: viewFresh && Number.isFinite(Number(cont?.lastConf)) ? Math.min(Number(cont.lastConf), 55) : 0,
    agreement: 0,
    participation: 0,
    participating: 0,
    voters: 0,
    totalModels: 0,
    ltp: (viewFresh && Number(cont?.lastLtp) > 0 ? Number(cont.lastLtp) : null) ?? h.entryPrice ?? null,
    changePct: null,
    plan: null,
    quality: null,
    votes: [],
    abstentions: [],
    summary: `🎯 OPEN POSITION PIN (aapki ${h.side} position) — board se nikal gaya tha, position open hai isliye pinned · ${viewNote}${ageMin != null ? ` · position ${ageMin}m purani` : ''}`,
    aiNote: null,
    executable: false,
    generatedAt: now,
    holding: {
      side: h.side, entryPrice: h.entryPrice, qty: h.qty, mode: h.mode,
      source: h.source, openedAt: h.openedAt, via: h.via,
      ...(h.openedAt ? { ageMs: now - h.openedAt } : {}),
    },
    holdingOnly: true,
  };
}

/**
 * Pin open positions onto a FINAL board signals array (mutates):
 *   • existing cards for held symbols get a `holding` stamp (badge)
 *   • held symbols missing from the board get a pinned card appended
 * @param {object[]} signals the final board array
 * @param {string} market board market
 * @param {object} opts { maxPinned = 4 } bound on appended cards
 */
export function pinHoldingOnBoard(signals, market, opts = {}) {
  if (!Array.isArray(signals)) return;
  const mkt = String(market || '').toUpperCase();
  const maxPinned = Number(opts.maxPinned) > 0 ? Number(opts.maxPinned) : 4;
  const holding = holdingPositions(mkt);
  if (holding.length === 0) return;
  const keyOf = (s) => normSym(s?.symbol || '');
  const onBoard = new Map(signals.map(s => [keyOf(s), s]).filter(([k]) => k));
  const now = Date.now();
  let pinned = 0;
  for (const h of holding) {
    const existing = onBoard.get(h.symbol);
    if (existing) {
      existing.holding = {
        side: h.side, entryPrice: h.entryPrice, qty: h.qty, mode: h.mode,
        source: h.source, openedAt: h.openedAt, via: h.via,
        ...(h.openedAt ? { ageMs: now - h.openedAt } : {}),
      };
      continue;
    }
    if (pinned >= maxPinned) continue;
    signals.push(buildHoldingCard(h, mkt));
    pinned += 1;
  }
}
