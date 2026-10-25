// ============================================================
// server/ai/probrain.js — v6.12 PRO TRADER BRAIN
// ------------------------------------------------------------
// The quality/honesty layer that sits ON TOP of the model-vote
// consensus. It does NOT vote — it GRADES the consensus like a
// prop-desk risk manager would:
//
//   1. sessionPhase   — NSE intraday session awareness (no entries
//                       in the opening noise, none after 15:15)
//   2. mtfAnalysis    — multi-timeframe alignment: a tradeable
//                       intraday signal must agree with the higher
//                       timeframe trend
//   3. regimeGate     — tightened market-regime alignment (BTC
//                       ±0.75% gate for alts, NIFTY ±0.35%) +
//                       daily-trend (EMA20/50) confirmation
//   4. extensionGuard — never chase blow-off moves (+8% crypto /
//                       +5% India day) or exhausted RSI
//   5. structureStop  — SL behind the last swing level, not a
//                       blind fixed-ATR line
//   6. qualityVerdict — blends all of the above into ONE honest
//                       quality object: quorum, MTF, regime,
//                       extension, session + the confidence and
//                       grade adjustments they justify
//
// Everything is PURE (no fetch, no clock-reading except the
// explicitly-passed `now`) so tests can pin every rule.
// ============================================================
import { ensureAscending } from './lib/candles.js'; // v21.23.12 [L2.5]: structureStop mirror-guard
import { normalizeSide } from './directionCertificate.js'; // v21.25.0: no silent-LONG side guessing

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ------------------------------------------------------------
// 1. SESSION PHASE (India intraday desk)
// ------------------------------------------------------------
// A pro intraday desk does NOT treat 9:15-9:30 and 15:15-15:30 as
// normal trading windows. The first 15 minutes are opening
// auction noise (spreads wide, ranges fake); the last 15 are
// square-off territory where fresh entries have no time to work.
export const NSE_PHASES = {
  PRE_OPEN: 'PRE_OPEN',       // before 09:15 — no fresh intraday entries
  OPENING: 'OPENING',         // 09:15-09:30 — opening noise, entries blocked
  MORNING: 'MORNING',         // 09:30-10:30 — prime window
  MIDDAY: 'MIDDAY',           // 10:30-13:30 — chop zone, prefer reversals at levels
  AFTERNOON: 'AFTERNOON',     // 13:30-14:30 — trend resumes
  POWER: 'POWER',             // 14:30-15:15 — second prime window
  NO_NEW_ENTRIES: 'NO_NEW_ENTRIES', // 15:15-15:30 — square-off only
  CLOSED: 'CLOSED',           // evenings / weekends / holidays
};

const NSE_PHASE_META = {
  PRE_OPEN: { tradeable: false, note: 'Pre-open — order book adhura hai, entries nahi' },
  OPENING: { tradeable: false, note: 'Opening 15-min noise — spreads wide, fake moves' },
  MORNING: { tradeable: true, note: 'Morning prime window — best liquidity' },
  MIDDAY: { tradeable: true, note: 'Midday chop — level-based entries only' },
  AFTERNOON: { tradeable: true, note: 'Afternoon session — trend continuation window' },
  POWER: { tradeable: true, note: 'Power hour — momentum flows' },
  NO_NEW_ENTRIES: { tradeable: false, note: '15:15+ — sirf square-off, fresh entry ka time nahi' },
  CLOSED: { tradeable: false, note: 'NSE band hai — stale prices pe entry = gap risk' },
};

/** IST minutes-of-day for a Date. `now` injectable for tests. */
function istMinutes(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  // IST = UTC+5:30 — derive from UTC parts, timezone-agnostic
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (utcMin + 330) % (24 * 60);
}

export function sessionPhase(market, now = Date.now()) {
  const mkt = String(market || 'INDIA').toUpperCase();
  // v21.8.0: 24/7 venues — GLOBALFUTURES (USDC equity perps trade 24/7;
  // pehle NSE phases milte the = latent bug) + METALS (B-XAU/B-XAG_USDT
  // commodity perps). Weekend note honestly warns thin liquidity.
  if (mkt === 'CRYPTO' || mkt === 'FUTURES' || mkt === 'GLOBALFUTURES' || mkt === 'METALS') {
    // 24/7 venues: always tradeable, but weekend liquidity honestly noted
    const d = now instanceof Date ? now : new Date(now);
    const day = d.getUTCDay(); // 0 Sun .. 6 Sat
    const weekend = day === 0 || day === 6;
    return {
      phase: 'OPEN', tradeable: true, note: weekend
        ? 'Weekend — thin liquidity, spreads wide, size chhota rakho'
        : '24/7 market open',
    };
  }
  const d = now instanceof Date ? now : new Date(now);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) {
    return { phase: NSE_PHASES.CLOSED, ...NSE_PHASE_META.CLOSED };
  }
  const m = istMinutes(now);
  if (m == null) return { phase: NSE_PHASES.CLOSED, ...NSE_PHASE_META.CLOSED };
  let phase;
  if (m < 555) phase = NSE_PHASES.PRE_OPEN;              // < 09:15
  else if (m < 570) phase = NSE_PHASES.OPENING;           // 09:15-09:30
  else if (m < 630) phase = NSE_PHASES.MORNING;           // 09:30-10:30
  else if (m < 810) phase = NSE_PHASES.MIDDAY;            // 10:30-13:30
  else if (m < 870) phase = NSE_PHASES.AFTERNOON;         // 13:30-14:30
  else if (m < 915) phase = NSE_PHASES.POWER;             // 14:30-15:15
  else if (m < 930) phase = NSE_PHASES.NO_NEW_ENTRIES;    // 15:15-15:30
  else phase = NSE_PHASES.CLOSED;                          // > 15:30
  return { phase, ...NSE_PHASE_META[phase] };
}

// ------------------------------------------------------------
// 2. MULTI-TIMEFRAME (MTF) ALIGNMENT
// ------------------------------------------------------------
// The daily scanner tells us the higher-timeframe (HTF) trend;
// the intraday (LTF) indicators tell us the timing. A pro only
// takes continuation entries when both agree, and only treats a
// counter-HTF signal as a genuine reversal when LTF momentum is
// strong (≥ 60 conf equivalent).
//
// Input shapes are deliberately forgiving: whichever fields are
// null are skipped and honestly reported as unavailable.
export function mtfAnalysis({ htf, ltf, side, ltfLabel = '15m' }) {
  // v21.25.0 [NO SILENT LONG]: unknown side pehle LONG maan liya jaata tha.
  const _side = normalizeSide(side);
  if (!_side) {
    return {
      available: false, phase: 'INVALID_SIDE', aligned: null, score: 50,
      facts: {}, ltfDir: 0, againstTapeStrength: 0,
      reasons: [`side "${String(side ?? '')}" invalid — direction certificate blocks MTF analysis (LONG/SHORT required)`],
    };
  }
  const want = _side === 'SHORT' ? -1 : 1;
  const reasons = [];
  const facts = {};

  // v9.3 LATENT-BUG FIX: the LTF arrives in TWO shapes — the flat legacy
  // shape ({ema20, ema50, macdHist, rsi} — what the unit tests and the
  // TV rows carry) and the computeIndicatorsFromCandles shape
  // ({macd: {hist, histSlope}}) — which is what the BOARD actually passes.
  // The old `ltf?.macdHist` reads silently missed the candle shape, so
  // the MACD leg of this analysis was DEAD in production (only the
  // EMA20/50 line ever fired). Normalize both shapes ONCE here.
  const ltfMacdHist = ltf?.macdHist != null
    ? ltf.macdHist
    : (Number.isFinite(ltf?.macd?.hist) ? ltf.macd.hist : null);

  // --- HTF (daily) trend read ---
  let htfDir = 0;
  if (htf?.ema20 != null && htf?.ema50 != null) {
    if (htf.ema20 > htf.ema50) { htfDir = 1; reasons.push(`HTF daily: EMA20 > EMA50 (uptrend)`); }
    else if (htf.ema20 < htf.ema50) { htfDir = -1; reasons.push(`HTF daily: EMA20 < EMA50 (downtrend)`); }
    else { reasons.push('HTF daily: EMA20 = EMA50 (flat)'); }
    facts.htfTrend = htfDir > 0 ? 'UP' : htfDir < 0 ? 'DOWN' : 'FLAT';
  }
  if (htf?.rsi != null) {
    if (htf.rsi >= 55) htfDir = htfDir >= 0 ? 1 : htfDir;
    else if (htf.rsi <= 45) htfDir = htfDir <= 0 ? -1 : htfDir;
    reasons.push(`HTF daily RSI ${r1(htf.rsi)}`);
  }

  // --- LTF (intraday) trend read ---
  let ltfDir = 0;
  if (ltf?.ema20 != null && ltf?.ema50 != null) {
    if (ltf.ema20 > ltf.ema50) ltfDir = 1;
    else if (ltf.ema20 < ltf.ema50) ltfDir = -1;
    const t = ltfDir > 0 ? 'bullish' : ltfDir < 0 ? 'bearish' : 'flat';
    reasons.push(`LTF ${ltfLabel}: EMA20 ${ltfDir > 0 ? '>' : ltfDir < 0 ? '<' : '='} EMA50 (${t})`);
  }
  // v21.19.0 LTF LIVE BREAKDOWN/BREAKOUT: when live price has crossed both EMA10
  // and EMA20 with matching MACD histogram, slow EMA50 lag must not hide the reversal.
  if (ltf?.ltp != null && ltf?.ema10 != null && ltf?.ema20 != null && ltfMacdHist != null) {
    if (ltf.ltp < ltf.ema10 && ltf.ltp < ltf.ema20 && ltfMacdHist < 0) {
      ltfDir = -1;
      reasons.push(`LTF ${ltfLabel}: price < EMA10 & EMA20 + MACD− (active bearish reversal)`);
    } else if (ltf.ltp > ltf.ema10 && ltf.ltp > ltf.ema20 && ltfMacdHist > 0) {
      ltfDir = 1;
      reasons.push(`LTF ${ltfLabel}: price > EMA10 & EMA20 + MACD+ (active bullish reversal)`);
    }
  }
  if (ltfMacdHist != null) {
    if (ltfMacdHist > 0 && ltfDir >= 0) { ltfDir = Math.max(ltfDir, 1); reasons.push(`LTF ${ltfLabel} MACD histogram positive`); }
    else if (ltfMacdHist < 0 && ltfDir <= 0) { ltfDir = Math.min(ltfDir, -1); reasons.push(`LTF ${ltfLabel} MACD histogram negative`); }
  }
  if (ltf?.rsi != null) {
    // LTF RSI exhaustion against the trade side is a timing warning
    if (want > 0 && ltf.rsi > 72) reasons.push(`LTF RSI ${r1(ltf.rsi)} — overbought, entry thodi extended`);
    else if (want < 0 && ltf.rsi < 28) reasons.push(`LTF RSI ${r1(ltf.rsi)} — oversold, entry thodi extended`);
  }

  const available = (htf?.ema20 != null || htf?.rsi != null) && (ltf?.ema20 != null || ltfMacdHist != null);
  let aligned = null; // null = not enough data — honest skip
  let phase = 'UNAVAILABLE';
  if (available) {
    if (htfDir === 0) { aligned = null; phase = 'HTF_FLAT'; reasons.push('HTF trend flat — dono side equally risky'); }
    else if (htfDir === want && ltfDir === want) { aligned = true; phase = 'ALIGNED'; }
    else if (htfDir === want && ltfDir === 0) { aligned = true; phase = 'HTF_TREND_LTF_WAIT'; reasons.push('HTF ke saath hai, LTF abhi wait kar raha (pullback window)'); }
    else if (htfDir !== want && ltfDir === want) {
      aligned = false; phase = 'COUNTER_HTF';
      reasons.push(`⚠ ${want > 0 ? 'LONG' : 'SHORT'} daily trend ke AGAINST hai — counter-trend trade, sirf strong reversal setup pe`);
    } else if (ltfDir === 0) { aligned = false; phase = 'CONFUSED'; reasons.push('dono timeframe mixed — skip better hai'); }
    else { aligned = false; phase = 'MISALIGNED'; reasons.push('MTF conflict — HTF aur LTF alag direction bol rahe hain'); }
  } else {
    reasons.push('LTF/HTF candles unavailable — MTF check skip (honest degrade)');
  }

  // v9.3 COUNTER-TAPE STRENGTH: when the signal fights the LTF tape,
  // how hard is the tape actually PUSHING? RSI in the momentum zone
  // against the trade + MACD agreeing = a DRIVING tape (shorting into
  // that is the exact screenshot bug — the stock keeps climbing). A
  // stalling tape (RSI mid-zone / MACD flat) is only a mild conflict —
  // the reversal case stays practiceable at ACTION.
  let againstTapeStrength = 0; // 0 = mild/stalling, 1 = driving hard
  if (phase === 'MISALIGNED' && ltfDir !== 0 && ltfDir === -want) {
    const rsiAgainst = want > 0
      ? (ltf?.rsi != null && ltf.rsi < 45)
      : (ltf?.rsi != null && ltf.rsi > 55);
    const macdAgainst = want > 0 ? (ltfMacdHist ?? 0) < 0 : (ltfMacdHist ?? 0) > 0;
    if (rsiAgainst && macdAgainst) againstTapeStrength = 1;
  }

  // score: 0 (worst) .. 100 (best) — null-data = 50 neutral
  const score = aligned == null ? 50 : aligned ? 100 : 10;
  return { available, phase, aligned, score, facts, reasons, ltfDir, againstTapeStrength };
}

// ------------------------------------------------------------
// 3. REGIME GATE (tightened)
// ------------------------------------------------------------
// v6.11 audit: the old ±1.5% BTC band let "BTC -1.4%" read as
// NEUTRAL while every alt went LONG — alts correlate ~0.8 with
// BTC, so that is a counter-trend board. Pro thresholds:
//   CRYPTO  BTC 24h ±0.75% directional, ±2.5% strong · BTC daily
//           EMA trend as tie-break
//   INDIA   NIFTY ±0.35% directional · VIX > 18 = risk penalty
//           · NIFTY daily EMA trend tie-break
export function regimeGate({ market, side, regime }) {
  // v21.25.0 [NO SILENT LONG]: invalid side = gate skipped, no direction guess.
  const _side = normalizeSide(side);
  if (!_side) {
    return { aligned: null, counterTrend: false, penaltyPct: 0, regimeDir: 0, reasons: [`side "${String(side ?? '')}" invalid — regime gate skipped (direction certificate)`] };
  }
  const want = _side === 'SHORT' ? -1 : 1;
  const mkt = String(market || 'INDIA').toUpperCase();
  const reasons = [];
  const isCrypto = mkt === 'CRYPTO' || mkt === 'FUTURES';
  const chg = isCrypto ? Number(regime?.btcChange) : Number(regime?.niftyChange);
  const trend = isCrypto ? regime?.btcTrend : regime?.niftyTrend; // 'UP'|'DOWN'|null
  const soft = isCrypto ? 0.75 : 0.35;
  const hard = isCrypto ? 2.5 : 1.0;

  let regimeDir = 0;
  if (Number.isFinite(chg)) {
    if (chg >= hard) regimeDir = 1;
    else if (chg <= -hard) regimeDir = -1;
    else if (chg >= soft) regimeDir = 1;
    else if (chg <= -soft) regimeDir = -1;
    reasons.push(`${isCrypto ? 'BTC' : 'NIFTY'} ${chg >= 0 ? '+' : ''}${r2(chg)}% (24h)`);
  } else {
    reasons.push(`${isCrypto ? 'BTC' : 'NIFTY'} regime data nahi mila`);
  }
  // daily EMA trend tie-break (only when day-change is quiet)
  if (regimeDir === 0 && (trend === 'UP' || trend === 'DOWN')) {
    regimeDir = trend === 'UP' ? 1 : -1;
    reasons.push(`${isCrypto ? 'BTC' : 'NIFTY'} daily EMA trend ${trend}`);
  }

  let aligned = null; // unknown regime = no reward, no penalty
  if (regimeDir !== 0) aligned = regimeDir === want;
  const counterTrend = aligned === false;
  let penaltyPct = 0;
  if (counterTrend) {
    // counter-regime: harder penalty when the regime is STRONG
    const strong = Number.isFinite(chg) && Math.abs(chg) >= hard;
    penaltyPct = strong ? 18 : 10;
    reasons.push(`⚠ ${isCrypto ? 'BTC' : 'NIFTY'} regime ke against trade — penalty -${penaltyPct}% conf`);
  } else if (aligned === true) {
    reasons.push(`${isCrypto ? 'BTC' : 'NIFTY'} regime se ALIGNED`);
  }

  // India VIX risk overlay
  if (!isCrypto && Number.isFinite(Number(regime?.indiaVix))) {
    const vix = Number(regime.indiaVix);
    if (vix > 18) { penaltyPct += 8; reasons.push(`India VIX ${r1(vix)} elevated — chop/whipsaw risk, conf -8%`); }
    else if (vix < 12) reasons.push(`India VIX ${r1(vix)} calm — clean tape`);
  }

  return { aligned, counterTrend, penaltyPct: Math.round(penaltyPct), regimeDir, reasons };
}

// ------------------------------------------------------------
// 4. EXTENSION GUARD (never chase a blow-off)
// ------------------------------------------------------------
// A +15% daily candle (DOT today) is not an entry, it is an exit
// forming. RSI continuation-side exhaustion is the same disease.
// VETO means: the signal may still display, but grade caps at
// WATCH and the ticket button says WHY.
export function extensionGuard({ market, side, changePct, rsi, adx }) {
  // v21.25.0 [NO SILENT LONG]: invalid side = hard veto (never act unknown).
  const _side = normalizeSide(side);
  if (!_side) {
    return { veto: true, downgrade: true, reasons: [`side "${String(side ?? '')}" invalid — direction certificate blocks this signal`] };
  }
  const want = _side === 'SHORT' ? -1 : 1;
  const mkt = String(market || 'INDIA').toUpperCase();
  const isCrypto = mkt === 'CRYPTO' || mkt === 'FUTURES';
  const dayLimit = isCrypto ? 8 : 5;      // % day-move beyond which we stop chasing
  const rsiExt = isCrypto ? 78 : 75;
  const reasons = [];
  let veto = false, downgrade = false;

  const chg = Number(changePct);
  if (Number.isFinite(chg)) {
    // chasing the SAME direction as a big day-move = late entry
    if (chg >= dayLimit && want > 0) { veto = true; reasons.push(`⚠ +${r1(chg)}% already up — blow-off chase, pullback ka wait karo`); }
    else if (chg <= -dayLimit && want < 0) { veto = true; reasons.push(`⚠ ${r1(chg)}% already down — capitulation chase, bounce risk`); }
    else if (Math.abs(chg) >= dayLimit * 0.6) { downgrade = true; reasons.push(`|day move| ${r1(Math.abs(chg))}% — entry thoda extended`); }
  }
  const r = Number(rsi);
  if (Number.isFinite(r)) {
    if (r >= rsiExt && want > 0) { veto = true; reasons.push(`⚠ RSI ${r1(r)} exhaustion — continuation entry late hai`); }
    else if (r <= 100 - rsiExt && want < 0) { veto = true; reasons.push(`⚠ RSI ${r1(r)} oversold exhaustion — bounce fuel ready`); }
  }
  const a = Number(adx?.adx ?? adx);
  if (Number.isFinite(a) && a < 18) { downgrade = true; reasons.push(`ADX ${r1(a)} < 18 — trend weak, breakout fail hone ka risk`); }

  return { veto, downgrade, reasons };
}

// ------------------------------------------------------------
// 5. STRUCTURE STOP
// ------------------------------------------------------------
// Fixed-ATR stops sit in no-man's land when a fresh swing just
// formed. A pro puts the stop BEHIND the structure: the last
// swing low (LONG) / high (SHORT), padded by noise, and never
// wider than the risk cap allows.
export function structureStop({ candles: candlesIn, side, ltp, atr, maxAtrMult = 2.2, noisePad = 0.12 }) {
  // v21.23.12 [L2.5 SEAT GUARD]: trailing-window swing scan — mirrored
  // input LONG swing-high / SHORT swing-low ulti padhta tha. ensureAscending.
  const candles = ensureAscending(candlesIn);
  // v21.25.0 [NO SILENT LONG]: invalid side = no stop (caller must refuse).
  const _side = normalizeSide(side);
  if (!_side) return null;
  const want = _side === 'SHORT' ? -1 : 1;
  const long = want > 0;
  const a = Number(atr);
  if (!(ltp > 0) || !Number.isFinite(a) || !(a > 0)) return null;
  if (!Array.isArray(candles) || candles.length < 12) return null;

  // last swing low/high over the trailing window (fractal ±2)
  const n = candles.length;
  const win = candles.slice(Math.max(0, n - 40));
  const strength = 2;
  let structLevel = null, structIdx = -1;
  for (let j = win.length - 1 - strength; j >= strength; j--) {
    let isPivot = true;
    for (let k = j - strength; k <= j + strength; k++) {
      if (k === j || k < 0 || k >= win.length) continue;
      if (long && win[k].low <= win[j].low) { isPivot = false; break; }
      if (!long && win[k].high >= win[j].high) { isPivot = false; break; }
    }
    if (isPivot) { structLevel = long ? win[j].low : win[j].high; structIdx = j; break; }
  }
  if (structLevel == null) return null;
  const pad = a * noisePad;
  const structural = long ? structLevel - pad : structLevel + pad;
  const atrStop = long ? ltp - 1.4 * a : ltp + 1.4 * a;

  // v6.12.1 CRITICAL FIX (full-code recheck): the stop must sit on
  // the CORRECT side of the entry price — LONG: below, SHORT: above.
  // When price has already broken the last swing (e.g. a dip-buy
  // BELOW the most recent pivot low), the "structure stop" lands on
  // the wrong side and stops the trade out INSTANTLY on entry (the
  // distance-only sanity checks below could not catch this). Reject
  // the structure and let the plain ATR stop stand.
  if ((long && structural >= ltp) || (!long && structural <= ltp)) {
    return {
      sl: null, structural: null, rejected: true,
      reasons: [`swing ${long ? 'low' : 'high'} @ ${r2(structLevel)} price ke ${long ? 'upar' : 'niche'} hai — structure already broken, ATR stop use hoga`],
    };
  }

  // choose the stop: structural when sane (within maxAtrMult × ATR),
  // else the ATR stop stands and we say so
  const maxDist = maxAtrMult * a;
  const structDist = Math.abs(ltp - structural);
  const atrDist = Math.abs(ltp - atrStop);
  if (structDist > maxDist || structDist < 0.35 * a) {
    return {
      sl: null, structural: null, rejected: true,
      reasons: [`swing ${long ? 'low' : 'high'} @ ${r2(structLevel)} ${structDist > maxDist ? 'too far (>' + maxAtrMult + ' ATR)' : 'too tight (<0.35 ATR — noise ke andar)'} — ATR stop use hoga`],
    };
  }
  // tighter of (structure, ATR) for LONG is the HIGHER stop? No —
  // for LONG, a HIGHER stop = tighter (less risk). Structure below
  // ATR stop = wider = use ATR (tighter). Pick the tighter one
  // that is still structurally valid.
  const sl = long ? Math.max(structural, atrStop) : Math.min(structural, atrStop);
  return {
    sl: r2(sl), structural: r2(structLevel), atrStop: r2(atrStop),
    barsAgo: win.length - 1 - structIdx,
    style: Math.abs(sl - structural) < 1e-9 ? 'swing-structure' : 'atr-tightened',
    reasons: [`swing ${long ? 'low' : 'high'} @ ${r2(structLevel)} ke piche SL ${r2(sl)} (${Math.abs(ltp - sl) < atrDist ? 'tighter than' : 'wider than'} ATR stop)`],
  };
}

// ------------------------------------------------------------
// 6. QUALITY VERDICT — the synthesis
// ------------------------------------------------------------
// Called by signals.js AFTER the vote consensus exists. Returns
// the honest quality object that ships on every signal + the
// confidence/grade adjustments.
export function qualityVerdict({
  market, side, _consensus, votes, ltp, changePct, rsi, adx, atr,
  candles, regime, htf, ltf, ltfLabel, now,
  // v21.4.1 [B2]: quorumExempt — callers jo apna MULTI-FACTOR composite
  // score pass karte hain (expert picks ka 8-factor envelope) ek
  // synthetic single vote ke sath. Board ka quorum ladder (≤1 voter →
  // confAdj −25 + gradeCap WATCH) 12-model committee ke liye hai — ek
  // composite-factors caller pe ye HAR pick ko blanket −25 de deta tha
  // aur EXPERT_MIN_STRONG=80 unreachable ho jaata tha (sab picks WATCH).
  // Exempt callers ko sirf wahi ladders milti hain jo unke liye meant
  // hain: regime / extension / MTF / counter-tape / session / structure.
  quorumExempt = false,
}) {
  const mkt = String(market || 'INDIA').toUpperCase();
  const reasons = [];
  const flags = {};

  // --- quorum (the fake-consensus killer) ---
  const voters = (votes || []).filter(v => v && v.dir !== 0 && (v.conf || 0) > 0).length;
  const total = (votes || []).length || 9;
  flags.quorum = { voters, total, ...(quorumExempt ? { exempt: true } : {}) };
  if (quorumExempt) reasons.push('expert composite (multi-factor score) — board quorum ladder N/A');
  else if (voters <= 1) reasons.push(`⚠ sirf ${voters} model vote kar raha hai — consensus NAHI, single-factor signal`);
  else if (voters === 2) reasons.push(`⚠ ${voters} models voting — weak quorum`);
  else reasons.push(`${voters}/${total} models voting — quorum OK`);

  // --- regime ---
  const rg = regimeGate({ market: mkt, side, regime });
  flags.regime = { aligned: rg.aligned, counterTrend: rg.counterTrend, penaltyPct: rg.penaltyPct };
  reasons.push(...rg.reasons);

  // --- extension ---
  const ext = extensionGuard({ market: mkt, side, changePct, rsi, adx });
  flags.extension = { veto: ext.veto, downgrade: ext.downgrade };
  reasons.push(...ext.reasons);

  // --- MTF ---
  const mtf = mtfAnalysis({ htf, ltf, side, ltfLabel });
  flags.mtf = { phase: mtf.phase, aligned: mtf.aligned, available: mtf.available };
  reasons.push(...mtf.reasons);

  // --- session ---
  const ses = sessionPhase(mkt, now);
  flags.session = { phase: ses.phase, tradeable: ses.tradeable };
  if (!ses.tradeable && mkt === 'INDIA') reasons.push(`⏰ ${ses.note}`);

  // --- structure stop (advisory — signals.js applies it to the plan) ---
  let stop = null;
  if (Array.isArray(candles) && candles.length >= 12) {
    stop = structureStop({ candles, side, ltp, atr });
    if (stop && !stop.rejected) reasons.push(`🔒 ${stop.reasons[0]}`);
  }

  // --- confidence adjustments (applied by caller) ---
  let confAdj = 0;
  if (rg.penaltyPct) confAdj -= rg.penaltyPct;
  if (mtf.aligned === true) { confAdj += 6; }
  else if (mtf.aligned === false) { confAdj -= 12; }
  // v9.3 COUNTER-TAPE (the intraday "wrong trend" fix): a signal that
  // fights the LIVE tape pays harder than a generic MTF conflict —
  // a DRIVING tape (RSI momentum zone + MACD against the trade) is the
  // exact screenshot bug (STRONG SHORT while the 15m tape rips up).
  if (mtf.phase === 'MISALIGNED') {
    flags.counterTape = { strong: mtf.againstTapeStrength === 1, ltfDir: mtf.ltfDir ?? 0 };
    confAdj -= mtf.againstTapeStrength === 1 ? 6 : 0; // extra on top of the -12 above
    reasons.push(mtf.againstTapeStrength === 1
      ? '🛑 COUNTER-TAPE hard: 15m tape momentum ke against trade — STRONG/ACTION banned, tape roll hone do (sirf WATCH)'
      : '⚠ counter-tape: 15m tape against hai par stall ho raha hai — ACTION max (STRONG banned)');
  }
  if (voters === 2 && !quorumExempt) confAdj -= 6;
  else if (voters <= 1 && !quorumExempt) confAdj -= 25;

  // --- grade caps (the honesty ladder) ---
  // extension veto or single-voter quorum or untradeable session or
  // hard counter-MTF → never above WATCH
  let gradeCap = 'STRONG';
  if (ext.veto) { gradeCap = 'WATCH'; flags.veto = 'extension'; }
  else if (voters <= 1 && !quorumExempt) { gradeCap = 'WATCH'; flags.veto = 'quorum'; }
  if (gradeCap === 'STRONG') {
    // v6.12: 2 voters = watchlist note, not a trade (quorum cap 54
    // already keeps confidence under the ACTION line — cap it here too
    // so the grade ladder and the caps table always agree)
    if (voters === 2) gradeCap = 'WATCH';
    if (!ses.tradeable && mkt === 'INDIA') gradeCap = 'WATCH';
    if (mtf.phase === 'COUNTER_HTF' && voters < 5) gradeCap = 'WATCH';
    if (ext.downgrade && gradeCap === 'STRONG') gradeCap = 'ACTION';
    // v6.12.1 FIX (recheck H-1): the STRONG guard is REQUIRED — without
    // it this line re-RAISED a WATCH cap (set above by voters===2 /
    // session / counter-HTF) back to ACTION, leaking 2-voter counter-
    // regime signals into paper/notify eligibility.
    if (rg.counterTrend && rg.penaltyPct >= 15 && voters < 5 && gradeCap === 'STRONG') gradeCap = 'ACTION';
  }
  // v9.3 COUNTER-TAPE caps: an intraday trade against the live 15m
  // tape can NEVER wear STRONG (the badge that gates auto-exec + the
  // user's trust); a stalling tape allows ACTION practice, a DRIVING
  // tape is WATCH-only. Caps only ever TIGHTEN (never re-raise).
  if (mtf.phase === 'MISALIGNED') {
    const capRank = { NEUTRAL: 0, WATCH: 1, ACTION: 2, STRONG: 3 };
    const tapeCap = mtf.againstTapeStrength === 1 ? 'WATCH' : 'ACTION';
    if (capRank[tapeCap] < capRank[gradeCap]) {
      gradeCap = tapeCap;
      if (mtf.againstTapeStrength === 1) flags.veto = flags.veto || 'counter-tape';
    }
  }

  return { flags, reasons, confAdj, gradeCap, regime: rg, mtf, extension: ext, session: ses, stop };
}
