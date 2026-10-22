// ============================================================
// server/ai/boardAiConfirm.js — v21.14.0 (Issue-5 lineage)
// ------------------------------------------------------------
// JEV (TypeSafe cloud) ko SUPERINTELLIGENCE SIGNAL BOARD se combine
// karta hai. (v21.14: Laya local provider permanently removed — ab
// sirf jev hi confirm layer ka provider hai.)
//
// THE LAYER (non-invasive, additive):
//   • Board compute ke final phase me (UCV ke baad, rank se pehle) top-N
//     STRONG/ACTION 75+ signals provider ko jaate hain:
//       snap.proposed = enter_long | enter_short (signal side)
//       criteria     = { enter_long, enter_short, wait }
//   • Verdict per provider (jevEngine.decide ka honest output):
//       AGREE     — provider ne SIDDA usi side ka entry approve kiya
//       DISAGREE  — provider ne ULTA side chuna (decide 'disagreed_side')
//       NEUTRAL   — wait / below-threshold / error / breaker (abstain)
//   • Board effects (NEVER flips side / sizing / SL — ground rules):
//       AGREE      → aiScore +3 (CONFIRMED stamp)
//       DISAGREE   → aiScore −8 + STRONG→ACTION demote (CONFLICT)
//       else       → NEUTRAL stamp only
//   • CONFLICT signals TOP-5 me entry nahi le sakte.
//
// COST CONTROL: provider cache payload-key pe (bucketed LTP — 0.25%
// granularity, isliye 60s board cycles mostly CACHE HIT), + 5-min per
// (symbol, side) memo, + single-flight, + soft 4.5s deadline (unresolved
// verdicts agle cycle me stamp hote hain — council "warming" pattern).
//
// v21.5.0 SWRV (stale-while-revalidate): memo expire hone par bhi board
// cycle ko block NAHI karte — 2×TTL (10 min) tak ka purana verdict
// turant stamp hota hai (0-latency) aur fresh verdict background me
// aata hai (agle cycle ke liye). Confirm layer sirf score ± karta hai
// isliye 5-min-stale verdict acceptable hai; AI_CONFIRM_SWRV=0 se off.
//
// SAFETY: AI kabhi side/sizing/SL nahi badalta — sirf score/grade
// pe confirm ya demote karta hai. Hard risk (kill switch, risk caps)
// isse UPAR hi hai. Env: AI_BOARD_CONFIRM=off disables everything.
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProviders, providerHealth } from '../bots/aiProviders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.SMARTAI_DATA_DIR
  ? path.resolve(process.env.SMARTAI_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

// -------- config (env-tunable, safe defaults) --------
const MODE = String(process.env.AI_BOARD_CONFIRM ?? 'auto').toLowerCase(); // 'off' | 'auto' | 'on'
const CONFIRM_N = (() => {
  const n = Number.parseInt(String(process.env.AI_BOARD_CONFIRM_N ?? ''), 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(12, n)) : 6;
})();
const MIN_SCORE = (() => {
  const n = Number.parseFloat(String(process.env.AI_BOARD_CONFIRM_MIN_SCORE ?? ''), 10);
  return Number.isFinite(n) ? Math.max(50, Math.min(95, n)) : 75;
})();
let MEMO_TTL_MS = 5 * 60_000;                 // v21.5.0: test-tunable
// SWRV serve cap = 2×TTL (test-TTL shrink ke saath scale hota hai)
const staleMaxMs = () => Math.max(2 * MEMO_TTL_MS, MEMO_TTL_MS + 1_000);
const SWRV = String(process.env.AI_CONFIRM_SWRV ?? '1') !== '0';
const DEADLINE_MS = 4_500;
const _memo = new Map();      // `${mkt}:${sym}:${side}` → { at, promise, verdict }
const _inflight = new Map();  // key → running promise

// -------- provider registry (lazy singleton, 10-min re-read) --------
let _providers = null;
let _providersAt = 0;
function _getProviders() {
  if (_providers && Date.now() - _providersAt < 10 * 60_000) return _providers;
  try {
    _providers = buildProviders(process.env, { stateDir: STATE_DIR });
  } catch {
    _providers = { jev: null };
  }
  _providersAt = Date.now();
  return _providers;
}

/** Is the layer enabled + at least one provider configured? */
export function boardAiConfirmActive() {
  if (MODE === 'off') return false;
  const p = _getProviders();
  return !!p.jev;
}

/** Health surface for /api/health + OpsHealthStrip. */
export function boardAiConfirmStatus() {
  const p = _getProviders();
  const configured = ['jev'].filter((n) => p[n]);
  return {
    mode: MODE,
    active: MODE !== 'off' && configured.length > 0,
    providers: configured,
    n: CONFIRM_N,
    minScore: MIN_SCORE,
    health: providerHealth(p),
  };
}

// -------- context builder (cache-friendly: bucketed ltp) --------
const MARKET_LABEL = {
  INDIA: 'NSE India intraday (INR)',
  CRYPTO: 'CoinDCX crypto spot (INR)',
  FUTURES: 'CoinDCX GLOBAL FUTURES (USDT perpetual)',
  GLOBALFUTURES: 'CoinDCX USDC equity perpetual (24/7)',
};

/** Round the LTP to ~0.25% granularity so repeated board cycles hit the
 *  provider's payload cache instead of re-billing on every tick. */
function _bucketPrice(ltp) {
  const n = Number(ltp);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  const q = n * 0.0025;
  const b = Math.round(n / q) * q;
  return b >= 100 ? b.toFixed(1) : b >= 1 ? b.toFixed(2) : b.toFixed(5);
}

function _ctxFor(sig, mkt) {
  const side = sig?.side === 'SHORT' ? 'SHORT' : sig?.side === 'LONG' ? 'LONG' : null;
  const plan = sig?.plan || null;
  const lines = [];
  lines.push(`Desk: ${MARKET_LABEL[mkt] || String(mkt)}`);
  lines.push(`Symbol: ${sig?.symbol}`);
  if (side) lines.push(`Signal side: ${side} (ensemble committee)`);
  const score = Number(sig?.superIntel?.aiScore ?? sig?.score);
  if (Number.isFinite(score)) lines.push(`Committee AI score: ${Math.round(score)}/100${sig?.grade ? `, grade ${sig.grade}` : ''}`);
  lines.push(`Last price: ${_bucketPrice(sig?.ltp ?? plan?.entry)}`);
  if (Number.isFinite(Number(sig?.changePct))) lines.push(`24h change: ${Number(sig.changePct) >= 0 ? '+' : ''}${Number(sig.changePct).toFixed(2)}%`);
  // indicators off the wire votes? keep to safe optional fields:
  const q = sig?.quality || {};
  if (q?.mtf?.available) {
    lines.push(`MTF (1m..1d): ${q.mtf.phase}${q.mtf.agreementPct != null ? `, ${q.mtf.agreementPct}% agreement` : ''}${q.mtf.aligned === true ? ', side-aligned' : q.mtf.aligned === false ? ', side ke AGAINST' : ''}`);
  }
  if (q?.regime?.counterTrend) lines.push('Regime: counter-trend (BTC/market against the side)');
  if (sig?.mtf?.phase) lines.push(`Live tape phase: ${sig.mtf.phase}`);
  if (plan && Number(plan.entry) > 0) {
    lines.push(`Plan: entry ${_bucketPrice(plan.entry)}, stop ${_bucketPrice(plan.stopLoss)}, T1 ${_bucketPrice(plan.target1)}, T2 ${_bucketPrice(plan.target2)}${plan.rewardRisk ? `, R:R 1:${plan.rewardRisk}` : ''}`);
  }
  const band = sig?.entryQuality?.band;
  if (band) lines.push(`Entry quality: ${band}`);
  if (sig?.event) lines.push(`Event risk: ${sig.event.label} in ${Math.round(sig.event.inMin)} min`);
  return lines;
}

const CONFIRM_PROMPT = {
  instructions: 'You are the final AI confirmation layer for a trade signal. Judge ONLY whether this trade should be taken now. A 4h/1d trend against the side, choppy range, overextension, or imminent event risk = wait. Aligned higher-timeframe trend with a sane stop = take.',
  criteria: {
    enter_long: 'Take the LONG entry now',
    enter_short: 'Take the SHORT entry now',
    wait: 'Stand aside — conditions do not justify this entry',
  },
};

// ------------------------------------------------------------
// v21.11.0 — DECISION TRANSPARENCY (jev)
// ------------------------------------------------------------
// User report tha ki board pe "🤖 AI ○" ka direction samaj nahi aata.
// Root cause: ye layer provider ke FULL verdict (action/probs/confidence/
// note) ko sirf 'AGREE'|'DISAGREE'|'NEUTRAL' 3-string me collapse karta
// tha — direction kabhi wire tak nahi pahunchti thi. Ab provider ka
// DECISION object (picked side + probs + note + latency) aiConfirm.detail
// me travel karta hai:
//   • AGREE    + picked LONG  → "Jev ✓ LONG"
//   • DISAGREE + picked SHORT → "Jev ✗ SHORT 68%" (ulta side + conviction)
//   • NEUTRAL  + picked SHORT → "Jev ○ SHORT-lean 29%" (below-threshold lean)
//   • NEUTRAL  + note         → "Jev ○ slow / wait / breaker / down" (honest)
// v21.14: Laya provider removed — detail ab sirf { jev } hai.
// ------------------------------------------------------------

/** Human-readable short reason for a NEUTRAL verdict (the ○ bucket). */
function _neutralReason(note) {
  const n = String(note || '');
  if (!n) return 'wait';
  if (n === 'deadline') return 'slow';                       // soft deadline race lost
  if (n === 'breaker_open') return 'breaker';
  if (n === 'no_api_key') return 'no-key';
  if (n === 'no_answer' || n === 'no_probability') return 'no-ans';
  if (n === 'timeout') return 'timeout';
  if (n === 'network_error') return 'net-err';
  if (n.startsWith('http_')) return 'down';
  if (n.startsWith('below_threshold')) return 'below-thr';
  if (n === 'error') return 'err';
  return n.length <= 10 ? n : 'wait';
}

/** Normalize a provider verdict into the wire decision object. */
function _toDecision(x, proposed) {
  const opposite = proposed === 'enter_long' ? 'enter_short' : 'enter_long';
  // legacy/plain-string shape (old memo, timeout race, raw string) —
  // direction unknown, honest 'wait' reason
  if (x == null || typeof x === 'string') {
    return { v: x === 'AGREE' || x === 'DISAGREE' ? x : 'NEUTRAL', picked: null, pLong: null, pShort: null, pWait: null, confidence: null, note: null, latencyMs: null, cached: null, reason: x === 'AGREE' || x === 'DISAGREE' ? 'wait' : _neutralReason(null) };
  }
  const probs = (x.probs && typeof x.probs === 'object') ? x.probs : null;
  const pOf = (k) => (probs && Number.isFinite(Number(probs[k])) ? Number(probs[k]) : null);
  const note = x.note != null ? String(x.note) : null;
  const base = {
    pLong: pOf('enter_long'), pShort: pOf('enter_short'), pWait: pOf('wait'),
    confidence: Number.isFinite(Number(x.confidence)) ? Number(x.confidence) : null,
    note,
    latencyMs: Number.isFinite(Number(x.latencyMs)) ? Number(x.latencyMs) : null,
    cached: x.cached === true ? true : x.cached === false ? false : null,
  };
  if (x.v === 'AGREE' || x.v === 'DISAGREE' || x.v === 'NEUTRAL') {
    // already-classified decision object (memo round-trip / race re-normalize)
    // — flattened fields (pLong/pShort/pWait) jevEngine probs se saath me
    // merge: race-path pe _confirmOneProvider ka output dobara yahan aata
    // hai, usme probs nahi hoti (flattened hoti hai) — ?? chain dono cover
    // karti hai. v21.11.0 fix: phele yahan flattened values DROP ho rahi
    // thi (pLong null) aur UI me direction ke saath % nahi dikhta tha.
    return {
      v: x.v,
      picked: x.picked ?? null,
      pLong: x.pLong ?? pOf('enter_long'),
      pShort: x.pShort ?? pOf('enter_short'),
      pWait: x.pWait ?? pOf('wait'),
      confidence: base.confidence,
      note: x.note ?? note,
      latencyMs: base.latencyMs,
      cached: base.cached,
      reason: x.reason || (x.v === 'NEUTRAL' ? _neutralReason(x.note ?? note) : 'wait'),
    };
  }
  // raw jevEngine verdict → classify (v21.3.0 mapping, direction preserved)
  if (x.action === proposed) {
    return { ...base, v: 'AGREE', picked: x.action, reason: 'wait' };
  }
  if (note === 'disagreed_side') {
    // provider ne ULTA side chuna — side-flip banned isliye action 'wait'
    // tha, par RAW choice + probs ab wire pe jaate hain
    return { ...base, v: 'DISAGREE', picked: x.picked && x.picked !== 'wait' ? x.picked : opposite, reason: 'ulta' };
  }
  const picked = (x.picked === 'enter_long' || x.picked === 'enter_short') ? x.picked : null;
  return { ...base, v: 'NEUTRAL', picked, reason: _neutralReason(note) };
}

/** One provider's confirm verdict for one signal. Pure mapping off
 *  jevEngine.decide()'s honest output — v21.11: decision OBJECT return
 *  (direction + probs + note preserved), string nahi. */
async function _confirmOneProvider(provider, sig, mkt) {
  const proposed = sig?.side === 'SHORT' ? 'enter_short' : sig?.side === 'LONG' ? 'enter_long' : null;
  if (!proposed) return { v: 'NEUTRAL', picked: null, pLong: null, pShort: null, pWait: null, confidence: null, note: 'no_side', latencyMs: null, cached: null, reason: 'wait' };
  const snap = { proposed, contextLines: _ctxFor(sig, mkt), features: {} };
  const v = await provider(snap, CONFIRM_PROMPT);
  return _toDecision(v, proposed);
}

/** Confirm one signal with all configured providers (memo + inflight).
 * v21.5.0: SWRV — fresh memo → instant; expired par verdict 2×TTL andar
 * hai to stale copy turant + background refresh (next cycle fresh). */
function _wireConfirm(sig, mkt, key) {
  const p = _getProviders();
  const names = ['jev'].filter((n) => p[n]);
  const promise = (async () => {
    const parts = {};
    await Promise.allSettled(names.map(async (n) => {
      try {
        // per-provider deadline (decide has its own timeout; belt+braces)
        // race-ab resolution bhi decision object hai (reason 'slow') —
        // UI "Jev ○ slow" dikhata hai, direction unknown honest
        const raced = await Promise.race([
          _confirmOneProvider(p[n], sig, mkt),
          new Promise((res) => { const t = setTimeout(() => res({ v: 'NEUTRAL', note: 'deadline' }), 5000); if (t.unref) t.unref(); }),
        ]);
        parts[n] = _toDecision(raced, sig?.side === 'SHORT' ? 'enter_short' : 'enter_long');
      } catch { parts[n] = { v: 'NEUTRAL', picked: null, pLong: null, pShort: null, pWait: null, confidence: null, note: 'error', latencyMs: null, cached: null, reason: 'err' }; }
    }));
    const agrees = names.filter((n) => parts[n]?.v === 'AGREE');
    const disagrees = names.filter((n) => parts[n]?.v === 'DISAGREE');
    let verdict = 'NEUTRAL';
    if (disagrees.length > 0) verdict = 'CONFLICT';
    else if (agrees.length === names.length && names.length > 0) verdict = 'CONFIRMED';
    return { jev: parts.jev ?? null, verdict, at: Date.now() };
  })();
  const entry = { at: Date.now(), promise, verdict: null };
  promise.then((v) => { entry.verdict = v; }).catch(() => { /* verdict stays null */ });
  _memo.set(key, entry);
  _inflight.set(key, promise);
  promise.finally(() => _inflight.delete(key)).catch(() => {});
  // memo bounded — Map insertion-order se oldest 40 drop (long session
  // memory growth ban; SWRV stale entries bhi isi cap me rehte hain)
  if (_memo.size > 200) {
    const it = _memo.keys();
    for (let i = 0; i < 40; i++) { const k = it.next().value; if (k === undefined) break; _memo.delete(k); }
  }
  return promise;
}

function _confirmSignal(sig, mkt) {
  const key = `${String(mkt).toUpperCase()}:${sig.symbol}:${sig.side}`;
  const hit = _memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.promise;
  const running = _inflight.get(key);
  if (running) return running;
  // v21.5.0 SWRV: thaka hua verdict abhi bhi 2×TTL ke andar hai — board
  // cycle ko TURANT serve karo, fresh verdict background me. (Ye path sirf
  // confirm-layer ke liye hai — Bot Lab entries apna purana blocking flow
  // use karti hain, wahan latency budget alag hai.)
  if (hit && hit.verdict && SWRV && Date.now() - hit.at < staleMaxMs()) {
    try { _wireConfirm(sig, mkt, key).catch(() => {}); } catch { /* never fatal */ }
    return Promise.resolve({ ...hit.verdict, stale: true });
  }
  return _wireConfirm(sig, mkt, key);
}

/**
 * Confirm the top signals of a board/picks payload with Jev.
 * MUTATES: sets `sig.aiConfirm` and adjusts aiScore/grade per verdict.
 * Soft-deadline: unresolved signals stay unstamped this cycle (the memo
 * resolves in the background and stamps the NEXT cycle).
 *
 * @param {Array} signals board signals ya expert picks
 * @param {string} mkt market key
 * @param {object} [opts] { scoreOf } — expert picks use their own score
 * @returns {{ stamped:number, confirmed:number, conflicted:number, providers:string[] }|null}
 */
export async function confirmBoardSignals(signals, mkt, opts = {}) {
  if (MODE === 'off') return null;
  const p = _getProviders();
  const names = ['jev'].filter((n) => p[n]);
  if (names.length === 0) return null;
  const scoreOf = typeof opts.scoreOf === 'function'
    ? opts.scoreOf
    : (s) => Number(s?.superIntel?.aiScore ?? s?.score);
  const gradeOf = (s) => String(s?.grade || '').toUpperCase();

  const eligible = (Array.isArray(signals) ? signals : [])
    .filter(s => s && (s.side === 'LONG' || s.side === 'SHORT'))
    .filter(s => {
      const g = gradeOf(s);
      const sc = scoreOf(s);
      // board signals: STRONG/ACTION + min score; expert picks: score gate alone
      const gradeOk = (s?.superIntel ? (g === 'STRONG' || g === 'ACTION') : true);
      return gradeOk && Number.isFinite(sc) && sc >= MIN_SCORE;
    })
    .sort((a, b) => (scoreOf(b) || 0) - (scoreOf(a) || 0))
    .slice(0, CONFIRM_N);

  if (eligible.length === 0) return { stamped: 0, confirmed: 0, conflicted: 0, providers: names };

  const jobs = eligible.map(async (s) => {
    try {
      const c = await _confirmSignal(s, mkt);
      // legacy string (jev) + full decision object detail me — UI ab
      // provider ka picked side + conviction dikha sakta hai
      s.aiConfirm = {
        jev: c.jev?.v ?? null,
        verdict: c.verdict,
        at: c.at,
        stale: !!c.stale,
        detail: { jev: c.jev },
      };
    } catch { /* never breaks the board */ }
  });
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise((res) => { const t = setTimeout(res, DEADLINE_MS); if (t.unref) t.unref(); }),
  ]);

  let confirmed = 0, conflicted = 0, staleServed = 0;
  for (const s of eligible) {
    const v = s?.aiConfirm?.verdict;
    if (!v) continue;
    if (s?.aiConfirm?.stale) staleServed++;
    if (v === 'CONFIRMED') {
      confirmed++;
      // +3 on the displayed aiScore (rank recompute happens after us)
      if (s.superIntel && Number.isFinite(Number(s.superIntel.aiScore))) {
        s.superIntel.aiScore = Math.min(97, Math.round(Number(s.superIntel.aiScore) + 3));
      } else if (Number.isFinite(Number(s.score))) {
        // v21.4.1 [B6]: chop-capped expert pick (cap 78) ka +2 bump use 79 se
        // upar nahi le ja sakta — 80+ STRONG badge bar crossed na ho jaye.
        const _bump = s.__chopCapped ? Math.max(0, 79 - Number(s.score)) : 2;
        s.score = Math.min(99, Math.round(Number(s.score) + _bump));
      }
    } else if (v === 'CONFLICT') {
      conflicted++;
      s.aiConflict = true;
      if (s.superIntel && Number.isFinite(Number(s.superIntel.aiScore))) {
        s.superIntel.aiScore = Math.max(45, Math.round(Number(s.superIntel.aiScore) - 8));
      } else if (Number.isFinite(Number(s.score))) {
        s.score = Math.max(40, Math.round(Number(s.score) - 8));
      }
      // STRONG → ACTION demote (grade WATCH nahi — AI sirf entry-confirm
      // layer hai; committee ka directional view board context me rehta hai)
      if (String(s.grade || '').toUpperCase() === 'STRONG') {
        s.grade = 'ACTION';
        s.executable = false; // v21.4.1: demote ke baad kabhi executable nahi
        s.summary = `${s.summary || ''} · AI-CONFLICT (Jev ulta)`;
        // summary me provider kaunsi side pe ulta tha — user ko board
        // text me hi direction dikhe
        try {
          const flipBits = ['jev']
          .filter((n) => s.aiConfirm?.detail?.[n]?.v === 'DISAGREE')
          .map((n) => {
            const d = s.aiConfirm.detail[n];
            const p = d.picked === 'enter_short' ? d.pShort : d.picked === 'enter_long' ? d.pLong : null;
            return `Jev ${d.picked === 'enter_short' ? 'SHORT' : 'LONG'}${p != null ? ` ${Math.round(p * 100)}%` : ''}`;
          })
          .join(' + ');
        if (flipBits) s.summary = `${s.summary || ''} [${flipBits}]`;
      } catch { /* cosmetic — never fatal */ }
      }
      // v20.9.3 parity: winProb should read the SAME capped score the card shows
      try {
        if (s.superIntel?.winProb && typeof s.superIntel.winProb.pWin === 'number') {
          s.superIntel.winProb = null; // recompute is deep-path only — honest drop
        }
      } catch { /* noop */ }
    }
  }
  return {
    stamped: eligible.filter(s => s?.aiConfirm?.verdict).length,
    confirmed, conflicted,
    stale: staleServed,
    providers: names,
  };
}

/** Test hooks. */
export function __resetBoardAiConfirmForTests() {
  _memo.clear();
  _inflight.clear();
  _providers = null;
  _providersAt = 0;
  MEMO_TTL_MS = 5 * 60_000;
}
/** v21.11: decision-normalizer direct test access (badge mapping lock). */
export function __toDecisionForTests(x, proposed) {
  return _toDecision(x, proposed);
}
/** v21.5.0: SWRV tests — TTL shrink + memo peek + reset. */
export function __setMemoTtlForTests(ms) {
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 0) MEMO_TTL_MS = n;
}
export function __memoPeekForTests() {
  return _memo;
}
export function __setProvidersForTests(p) {
  _providers = p || { jev: null };
  _providersAt = Date.now();
}
