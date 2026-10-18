// ============================================================
// server/ai/boardAccountability.js — v20.2
// ------------------------------------------------------------
// THE HONESTY GAP FIX: the AI Superintelligence board
// (/api/ai/signals — the cards the user actually sees) never fed
// the signal Track Record. Only the legacy v4 scanner
// (/api/intraday-scanner — no longer polled by any frontend)
// called recordSignals(), so TrackRecordPanel claimed "har
// published signal track hota hai" while board signals were
// never tracked at all.
//
// This module maps the ensemble wire-signal shape (buildSignal /
// buildTradePlan) onto trackRecord's legacy row shape and records
// every ACTIONABLE board signal (STRONG + ACTION grades with a
// valid plan) — same watcher then follows them to T1/T2/SL/EOD.
//
// Safety properties:
//   • recordSignals is idempotent per (symbol, dayKey) — a 60s
//     board refresh only updates confidence/lastPrice (v18.9
//     LEVEL FREEZE), so hooking the route poll is safe.
//   • INDIA + CRYPTO only. FUTURES/GLOBALFUTURES plans are
//     USDT/USDC-denominated while the intraday watcher's crypto
//     quote feed is INR — tracking those rows would evaluate
//     USDT levels against INR prices (unit mismatch → instant
//     fake SL_HIT). Skipped EXPLICITLY, never silently.
//   • Telegram alerts are NOT duplicated here: the insta-push
//     sink (telegramPush.js) already pushes board STRONG
//     signals every ~30s (CRYPTO + INDIA + FUTURES after v20.2).
//   • Hooked at the ROUTE layer (/api/ai/signals) — never inside
//     getSignals() — so warmOnly calls, tests and internal
//     agent paths stay side-effect free (same pattern as the
//     v18.5 setScanSymbols wiring).
//   • Flag: AI_BOARD_ACCOUNTABILITY=off disables (default on).
// ============================================================
import { recordSignals } from '../intraday/trackRecord.js';
// v21.13: dynamic committee counts — the legacy hardcoded "10-model"
// string survived every committee expansion (13 → 16 + 4 mesh shadow).
import { committeeInfo } from './committee.js';

const ENABLED = String(process.env.AI_BOARD_ACCOUNTABILITY || '').toLowerCase() !== 'off';

// v21.13: build the row's pipeline label from the LIVE committee counts
// (16 voting + 4 mesh shadow today — never a stale hardcoded number).
function _committeeLabel() {
  try {
    const ci = committeeInfo();
    return `AI-BOARD ensemble (${ci.voting}-model committee${ci.shadow > 0 ? ` + ${ci.shadow} mesh shadow` : ''})`;
  } catch {
    return 'AI-BOARD ensemble';
  }
}

// The watcher's quote routing: INDIA → Groww INR, CRYPTO → CoinDCX INR
// spot. v21.3.0: FUTURES → CoinDCX USDT perp RT (+Binance-fut fallback),
// GLOBALFUTURES → the USDC quote chain — stream.js now routes each
// market to its OWN price domain, so the old unit-mismatch block
// (USDT/USDC plans vs INR watcher quotes) is GONE. The exact desks the
// user trades finally feed the board Track Record (Issue-3: futures
// board had ZERO outcome feedback — wrong-direction signals never self-
// corrected).
const TRACKABLE_MARKETS = new Set(['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES']);

// The board's own "ACTIONABLE" bar (DeskStatsStrip) — STRONG + ACTION.
// WATCH/NEUTRAL rows are display context, not published trade signals;
// recording them would burn MAX_PER_DAY slots on non-trades.
const TRACKED_GRADES = new Set(['STRONG', 'ACTION']);

export function boardAccountabilityEnabled() { return ENABLED; }

/** Map one ensemble wire signal → trackRecord's legacy row shape.
 *  Returns null when the signal is not accountability-worthy. */
export function mapBoardSignalToTracked(s, mkt) {
  if (!s || typeof s !== 'object') return null;
  const plan = s.plan;
  const side = s.side;
  const grade = String(s.grade || '').toUpperCase();
  if (!plan || typeof plan !== 'object') return null;
  if (side !== 'LONG' && side !== 'SHORT') return null; // FLAT/absent → not a signal
  if (!TRACKED_GRADES.has(grade)) return null;
  const entry = Number(plan.entry);
  const stopLoss = Number(plan.stopLoss);
  const target1 = Number(plan.target1);
  const target2 = Number(plan.target2);
  const ltp = Number(s.ltp) || entry;
  if (!(entry > 0) || !(stopLoss > 0) || !(target1 > 0) || !(target2 > 0)) return null;
  // Wrong-side plan (LONG stop above entry etc.) — buildTradePlan already
  // guards this; belt-and-braces so a bad row can never enter the ledger.
  const long = side === 'LONG';
  if (long ? (stopLoss >= entry || target1 <= entry) : (stopLoss <= entry || target1 >= entry)) return null;

  // qty semantics — the EXACT legacy engine formula (engine.js ~653):
  // 1% risk per ₹1L = ₹1000; cap the position at 25% of capital.
  const effRisk = Math.abs(entry - stopLoss);
  const qtyRisk = effRisk > 0 ? 1000 / effRisk : 0;
  const qtyCap = 25000 / entry;
  const qtyRaw = Math.max(0, Math.min(qtyRisk, qtyCap));
  const isCrypto = mkt !== 'INDIA';
  const qtyPerLakh = isCrypto ? Math.max(0.0001, +qtyRaw.toFixed(4)) : Math.floor(qtyRaw);

  // WHY-reasons: the top weighted votes ON THE SIGNAL'S SIDE — the
  // closest equivalent of the legacy scanner's per-signal reasons.
  const reasons = (Array.isArray(s.votes) ? s.votes : [])
    .filter(v => v && (long ? v.dir > 0 : v.dir < 0) && Array.isArray(v.reasons) && v.reasons.length)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 3)
    .flatMap(v => v.reasons.slice(0, 1));

  return {
    symbol: s.symbol,
    market: mkt,
    exchange: isCrypto ? 'COINDCX' : 'NSE',
    direction: side,
    entry, stopLoss, target1, target2,
    qtyPerLakh,
    confidence: Math.round(Number(s.confidence) || 0),
    // Legacy rows surface these in TrackRecordPanel history; board rows
    // identify their pipeline so a user can tell scanner vs board rows.
    aiModel: _committeeLabel(), // v21.13: dynamic — live committee counts, never a stale hardcoded number
    aiNote: String(s.summary || s.aiNote || '').slice(0, 90),
    counterTrend: !!(s.quality?.regime?.counterTrend),
    trendStrength: String(s.superIntel?.tier || s.entryQuality?.band || ''),
    ltp,
    changePct: Number(s.changePct) || 0,
    // carried for any future alert path; TrackRecord ignores extras.
    rr: Number(plan.rewardRisk) || 0,
    reasons,
    source: 'AI-BOARD',
  };
}

/** Wire a computed board payload into the track record. Called ONLY
 *  from the /api/ai/signals route (see routes.js). Never throws. */
export function wireBoardAccountability(market, board) {
  const mkt = String(market || '').toUpperCase();
  const out = { enabled: ENABLED, market: mkt, tracked: 0 };
  if (!ENABLED) return out;
  if (!TRACKABLE_MARKETS.has(mkt)) {
    out.skipped = 'market not trackable';
    return out;
  }
  const signals = Array.isArray(board?.signals) ? board.signals : [];
  if (!signals.length) return out;

  const mapped = [];
  for (const s of signals) {
    const row = mapBoardSignalToTracked(s, mkt);
    if (row) mapped.push(row);
  }
  if (!mapped.length) return out;

  try {
    recordSignals(mapped);
    out.tracked = mapped.length;
  } catch (e) {
    console.warn('[board-accountability]', e?.message || e);
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}
