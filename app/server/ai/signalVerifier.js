// ============================================================
// server/ai/signalVerifier.js — SIGNAL VERIFICATION AGENT (SVA-v1)
// ------------------------------------------------------------
// v13.1 — the "senior pro trader" that re-checks every ensemble
// signal BEFORE the user acts on it, and gives the FINAL call:
// LONG / SHORT / NO_TRADE.
//
// WHY: the live XRP case (24 Sep 2026). The ensemble printed a LONG
// (aiScore 57 · conf 48 · grade WATCH) on a symbol whose own summary
// said "⛔ OVERBOUGHT RSI 70 · 🚀 CHASING — 2.31×ATR above EMA20 —
// LONG entry suppressed". The user took the LONG anyway from the tab,
// price mean-reverted −5.52% and the ₹150 loss-cap advisory ballooned
// to a −₹2,250 exit. The information to reject that entry ALL existed
// on the signal — it just wasn't aggregated into ONE final verdict.
//
// WHAT THIS MODULE DOES (PURE — numbers in, verdict out):
//   • Runs a 10-point weighted pro-trader checklist on the WIRE
//     signal: quorum, chase-extension, RSI extremes, MTF confluence,
//     ledger-calibrated win-edge, R:R, regime alignment, entry band,
//     perp crowd (futures), side stability.
//   • Emits ONE final call + action:
//       CONFIRM      same side — full risk (score ≥ 68, no veto)
//       CAUTION      same side — half risk (score 40–68)
//       FLIP         OPPOSITE side (mean-reversion case ≥ 60)
//       STAND_ASIDE  no trade (weak + no flip case)
//   • FLIP logic mirrors what actually burned the XRP trade: RSI-70
//     overbought + HARD chase + thin quorum = top-tick entry → the
//     pro move is the reversal/SHORT, not the chase.
//   • proNote — the Hinglish one-paragraph "why", checklist attached
//     so every verdict is auditable, never a black box.
//
// Where it runs:
//   • signals.js — every directional board signal + deep signal
//     (attached as s.verify — rides the existing wire payload).
//   • cryptoAgent.js — the verify_signal MCP tool (17th tool): the
//     desk agent answers "XRP long ya short?" with the SVA verdict.
//   • manualTrades.js — recordManualTrade() stamps t.verify at open
//     (the trade ticket carries the verdict it was opened under).
// PURITY: verifySignal() never throws on partial input — missing
// fields score their neutral band, never silently zero.
// ============================================================

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// ---------------- the checklist (weights sum = 100) ----------------
// Each check: { id, weight, status: PASS=1 | WARN=0.5 | FAIL=0 }
// Weights mirror what the replay engine + ledger actually measured:
// chase entries ranked 29% win-rate (heaviest), thin quorum and
// missing edge are the next burn sources.
const CHECKS = [
  { id: 'quorum', name: 'Committee quorum', weight: 14 },
  { id: 'chase', name: 'Chase / extension', weight: 16 },
  { id: 'rsiExtreme', name: 'RSI extreme vs side', weight: 12 },
  { id: 'mtf', name: 'MTF confluence', weight: 12 },
  { id: 'winEdge', name: 'Ledger win-edge (P(win)−P(need))', weight: 14 },
  { id: 'rr', name: 'Plan R:R', weight: 8 },
  { id: 'regime', name: 'Regime alignment', weight: 8 },
  { id: 'entryBand', name: 'Entry band', weight: 6 },
  { id: 'perpCrowd', name: 'Perp crowd / funding', weight: 6 },
  { id: 'stability', name: 'Side stability', weight: 4 },
];

const STATUS_PTS = { PASS: 1, WARN: 0.5, FAIL: 0 };

/**
 * The pro-trader verification verdict for ONE wire signal. PURE.
 * @param {object} sig — the wire signal (buildSignal output, post
 *   superIntel/winProb attach). Partial input is fine — every missing
 *   field scores its neutral band.
 * @param {object} [opts] { now?: number }
 * @returns {{
 *   agent: string, symbol: string, market: string, side: string,
 *   finalCall: 'LONG'|'SHORT'|'NO_TRADE',
 *   action: 'CONFIRM'|'CAUTION'|'FLIP'|'STAND_ASIDE',
 *   score: number, flipScore: number|null, veto: boolean,
 *   verdict: string, proNote: string, sizeHint: number,
 *   checklist: Array<{id:string,name:string,status:string,weight:number,points:number,detail:string}>,
 *   checkedAt: number,
 * }}
 */
export function verifySignal(sig, { now = Date.now() } = {}) {
  const side = String(sig?.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
  const market = String(sig?.market || 'CRYPTO').toUpperCase();
  const symbol = String(sig?.symbol || '?').toUpperCase();

  const voters = num(sig?.voters ?? sig?.participating);
  const totalModels = num(sig?.totalModels);
  const quorum = voters != null && totalModels > 0 ? voters / totalModels : null;
  const chaseSev = sig?.chasing?.severity || null; // 'HARD' | 'SOFT' | null
  const obOs = sig?.obOs || null; // { tag: 'OVERBOUGHT'|'OVERSOLD', rsi, extreme }
  const mtfAg = num(sig?.mtf?.agreement); // 0..1
  const edgePts = num(sig?.superIntel?.winProb?.edgePts);
  const rr = num(sig?.plan?.rewardRisk);
  const counterTrend = !!(sig?.quality?.regime?.counterTrend);
  const band = sig?.entryQuality?.band || null; // 'PULLBACK' | 'EXTENDED'
  const perp = sig?.superIntel?.perp || null;
  const fundingBps = num(perp?.fundingBps8h ?? sig?.superIntel?.winProb?.fundingBps8h);
  const posScore = num(perp?.positioningScore ?? perp?.read?.score); // 0-100 LONG-aligned
  const freshFlip = !!sig?.freshFlip;

  // -------- individual checks (status + human detail) --------
  const mk = (id, status, detail) => ({ id, status, detail });

  const quorumC = (() => {
    if (quorum == null) return mk('quorum', 'WARN', 'quorum data missing — neutral band');
    if (quorum >= 0.5) return mk('quorum', 'PASS', `${Math.round(quorum * 100)}% models voting — healthy committee`);
    if (quorum >= 0.35) return mk('quorum', 'WARN', `${Math.round(quorum * 100)}% quorum — thin-ish committee`);
    return mk('quorum', 'FAIL', `${Math.round(quorum * 100)}% quorum (${voters ?? '?'}/${totalModels ?? '?'}) — too few models actually voting`);
  })();

  const chaseC = (() => {
    const extAtr = num(sig?.chasing?.extAtr);
    if (!chaseSev) return mk('chase', 'PASS', 'no structural extension — entry location sane');
    if (chaseSev === 'HARD') return mk('chase', 'FAIL', `HARD chase${extAtr != null ? ` — ${extAtr}×ATR from mean` : ''}: move already ho chuka, top-tick entry risk`);
    return mk('chase', 'WARN', `SOFT extension${extAtr != null ? ` — ${extAtr}×ATR from mean` : ''}: retrace entry better`);
  })();

  const rsiC = (() => {
    if (!obOs) return mk('rsiExtreme', 'PASS', 'RSI in tradeable band');
    const badSide = (side === 'LONG' && obOs.tag === 'OVERBOUGHT') || (side === 'SHORT' && obOs.tag === 'OVERSOLD');
    if (!badSide) return mk('rsiExtreme', 'PASS', `${obOs.tag} RSI ${Math.round(obOs.rsi)} — FAVOURS ${opposite}, not against ${side}`);
    return mk('rsiExtreme', 'FAIL', `${obOs.tag} RSI ${Math.round(obOs.rsi)} against a ${side} entry${obOs.extreme ? ' (EXTREME)' : ''} — mean-reversion risk`);
  })();

  const mtfC = (() => {
    if (mtfAg == null) return mk('mtf', 'WARN', 'MTF wire unavailable this cycle');
    if (mtfAg >= 0.67) return mk('mtf', 'PASS', `5m/15m/1h ${Math.round(mtfAg * 100)}% aligned with ${side}`);
    if (mtfAg >= 0.4) return mk('mtf', 'WARN', `MTF ${Math.round(mtfAg * 100)}% — partially aligned`);
    return mk('mtf', 'FAIL', `MTF only ${Math.round(mtfAg * 100)}% aligned — timeframes disagree on ${side}`);
  })();

  const edgeC = (() => {
    if (edgePts == null) return mk('winEdge', 'WARN', 'win-prob not computed this cycle');
    if (edgePts >= 5) return mk('winEdge', 'PASS', `+${r1(edgePts)}pt edge over breakeven (P(win) > P(need))`);
    if (edgePts >= 0) return mk('winEdge', 'WARN', `+${r1(edgePts)}pt edge — positive but thin`);
    return mk('winEdge', 'FAIL', `${r1(edgePts)}pt edge — P(win) below breakeven, negative EV`);
  })();

  const rrC = (() => {
    if (rr == null) return mk('rr', 'WARN', 'plan R:R missing');
    if (rr >= 1.5) return mk('rr', 'PASS', `R:R ${r1(rr)} — reward dominates risk`);
    if (rr >= 1) return mk('rr', 'WARN', `R:R ${r1(rr)} — tight, target must execute fast`);
    return mk('rr', 'FAIL', `R:R ${r1(rr)} — risk bigger than reward`);
  })();

  const regimeC = counterTrend
    ? mk('regime', 'FAIL', 'signal fights the macro regime — counter-trend entries underperform')
    : mk('regime', 'PASS', 'regime-aligned (or regime neutral)');

  const bandC = (() => {
    if (band === 'PULLBACK') return mk('entryBand', 'PASS', 'pullback-in-trend zone — achhi entry location');
    if (band === 'EXTENDED') return mk('entryBand', 'WARN', 'extended band — stretched vs mean');
    return mk('entryBand', 'WARN', 'no entry-band read this cycle');
  })();

  const perpC = (() => {
    if (market !== 'FUTURES') return mk('perpCrowd', 'PASS', 'spot desk — no perp crowd read');
    // positioningScore is LONG-aligned 0-100; opposes a SHORT when high,
    // opposes a LONG when low.
    if (posScore != null) {
      const opposes = side === 'LONG' ? posScore <= 35 : posScore >= 65;
      const supports = side === 'LONG' ? posScore >= 65 : posScore <= 35;
      if (opposes) return mk('perpCrowd', 'WARN', `perp positioning (score ${Math.round(posScore)}) leans ${opposite} — crowd against this entry`);
      if (supports) return mk('perpCrowd', 'PASS', `perp positioning (score ${Math.round(posScore)}) supports ${side}`);
      return mk('perpCrowd', 'WARN', `perp positioning neutral (score ${Math.round(posScore)})`);
    }
    if (fundingBps != null) {
      // heavy positive funding hurts LONGs (longs pay), favors shorts.
      const opposes = side === 'LONG' ? fundingBps >= 8 : fundingBps <= -8;
      return mk('perpCrowd', opposes ? 'WARN' : 'PASS', `funding ${r1(fundingBps)}bps/8h ${opposes ? '— expensive side of the trade' : '— no drag'}`);
    }
    return mk('perpCrowd', 'WARN', 'perp intel unavailable this cycle');
  })();

  const stabC = freshFlip
    ? mk('stability', 'WARN', 'side JUST flipped (<5m) — whipsaw window')
    : mk('stability', 'PASS', 'side stable');

  const raw = [quorumC, chaseC, rsiC, mtfC, edgeC, rrC, regimeC, bandC, perpC, stabC];
  const byId = new Map(raw.map(c => [c.id, c]));
  const checklist = CHECKS.map(({ id, name, weight }) => {
    const c = byId.get(id) || { status: 'WARN', detail: '—' };
    return { id, name, status: c.status, weight, points: Math.round(weight * STATUS_PTS[c.status] * 10) / 10, detail: c.detail };
  });
  const score = Math.round(checklist.reduce((s, c) => s + c.points, 0));

  // -------- hard veto: the exact XRP-class burn combination --------
  // chase HARD + RSI extreme against the side = the "top pe LONG"
  // entry the trust guards already suppress. Also veto when chase HARD
  // rides a FAIL-level quorum (a stretched move confirmed by almost
  // nobody).
  const hardVeto = (chaseSev === 'HARD' && rsiC.status === 'FAIL')
    || (chaseSev === 'HARD' && quorumC.status === 'FAIL');

  // -------- the OPPOSITE-side (flip) case --------
  // Mean-reversion strength: what would make a pro take the OTHER
  // side instead. RSI extreme against the entry side is the strongest
  // single flip signal; HARD chase next; negative edge and broken MTF
  // support it.
  let flipScore = 30;
  if (rsiC.status === 'FAIL') flipScore += 25;
  if (chaseSev === 'HARD') flipScore += 22;
  if (chaseSev === 'SOFT') flipScore += 8;
  if (quorumC.status === 'FAIL') flipScore += 10;
  if (edgePts != null && edgePts < 0) flipScore += 8;
  if (mtfAg != null && mtfAg < 0.4) flipScore += 5;
  flipScore = Math.min(95, flipScore);

  // -------- verdict ladder --------
  // Hard rules a senior trader would never break:
  //   • a CORE check FAIL (quorum / chase / RSI-extreme / edge / R:R /
  //     regime) blocks FULL-risk CONFIRM — the signal may still trade
  //     at half size (CAUTION), mirroring the site's own trust guards.
  //   • hardVeto OR score < 40 OR a NEGATIVE-EV plan (edge FAIL + R:R
  //     FAIL — P(win) below breakeven on a sub-1 reward:risk) → no
  //     trade in the signal's direction at ANY size.
  //   • FLIP only when the opposite-side case is genuinely strong
  //     (flipScore ≥ 60) — never a manufactured reversal.
  const CORE_IDS = new Set(['quorum', 'chase', 'rsiExtreme', 'winEdge', 'rr', 'regime']);
  const coreFails = checklist.filter(c => CORE_IDS.has(c.id) && c.status === 'FAIL').length;
  const negEvPlan = edgeC.status === 'FAIL' && rrC.status === 'FAIL';
  let action, finalCall;
  if (hardVeto || score < 40 || negEvPlan) {
    if (flipScore >= 60) { action = 'FLIP'; finalCall = opposite; }
    else { action = 'STAND_ASIDE'; finalCall = 'NO_TRADE'; }
  } else if (score >= 68 && coreFails === 0) {
    action = 'CONFIRM'; finalCall = side;
  } else {
    action = 'CAUTION'; finalCall = side;
  }
  const sizeHint = action === 'CONFIRM' ? 1 : action === 'CAUTION' ? 0.5 : 0;

  // -------- the verdict lines (Hinglish — the desk's language) --------
  const fails = checklist.filter(c => c.status === 'FAIL').map(c => c.name);
  const warns = checklist.filter(c => c.status === 'WARN').length;
  let verdict;
  if (action === 'CONFIRM') {
    verdict = `✅ VERIFIED ${side} — pro checklist clean (${score}/100${fails.length === 0 && warns === 0 ? ', ALL PASS' : `, ${fails.length} fail · ${warns} warn`})`;
  } else if (action === 'CAUTION') {
    verdict = `⚠️ CAUTION ${side} — setup theek hai par edge thin hai (${score}/100${coreFails > 0 ? ` · ${coreFails} core fail` : ''}) — aadha risk lo ya pullback ka wait karo`;
  } else if (action === 'FLIP') {
    verdict = `🔄 FLIP → ${opposite} — ye ${side} entry top-chase/overbought trap hai (${score}/100); pro move reversal side hai`;
  } else {
    verdict = `⛔ STAND ASIDE — ${side} case weak (${score}/100${negEvPlan ? ' · NEGATIVE-EV plan (edge + R:R dono fail)' : fails.length ? ` · ${fails.slice(0, 3).join(', ')} fail` : ''}) — trade hi mat lo`;
  }

  const proBits = [];
  if (chaseSev) proBits.push(chaseSev === 'HARD' ? 'HARD chase (move already extended)' : 'soft extension');
  if (obOs) proBits.push(`${obOs.tag} RSI ${Math.round(obOs.rsi)}`);
  if (quorum != null) proBits.push(`${Math.round(quorum * 100)}% quorum`);
  if (mtfAg != null) proBits.push(`MTF ${Math.round(mtfAg * 100)}%`);
  if (edgePts != null) proBits.push(`${edgePts >= 0 ? '+' : ''}${r1(edgePts)}pt edge`);
  if (rr != null) proBits.push(`R:R ${r1(rr)}`);
  const proNote = [
    `🛡 SVA-v1 final: ${finalCall === 'NO_TRADE' ? 'NO TRADE' : finalCall}${action !== 'CONFIRM' ? ` (vs signal ${side})` : ''} · score ${score}/100${hardVeto ? ' · PRO VETO (chase+extreme combo)' : ''}.`,
    proBits.length ? `Read: ${proBits.join(' · ')}.` : null,
    action === 'FLIP'
      ? `Pro logic: entry-side extremes (RSI/ATR-extension) mean-revert more often than they trend — flip ${opposite} with tight SL, ya pullback wait karo.`
      : action === 'STAND_ASIDE'
        ? 'Ye setup board pe dikhta hai par pro trader isse skip karega — capital bachao, next setup aayega.'
        : action === 'CAUTION'
          ? 'Direction ok, execution risky — size aadha rakho, entry retrace pe lo.'
          : 'Setup clean hai — full plan (entry/SL/T1/T2 + sizing) valid.',
  ].filter(Boolean).join(' ');

  return {
    agent: 'SVA-v1',
    symbol, market, side,
    finalCall, action, score,
    flipScore: action === 'FLIP' || flipScore >= 50 ? flipScore : null,
    veto: hardVeto,
    verdict, proNote, sizeHint,
    checklist,
    checkedAt: now,
  };
}

/** Compact wire payload — trims the checklist details to keep the
 *  board response lean (the deep path / agent tool returns FULL).
 *  IDEMPOTENT: an already-compact payload (no checklist array) passes
 *  through untouched — so re-wiring a wire stamp never strips its
 *  fails/warns. */
export function verificationWire(v) {
  if (!v || !v.agent) return null;
  if (!Array.isArray(v.checklist)) return v;
  return {
    agent: v.agent,
    action: v.action,
    finalCall: v.finalCall,
    score: v.score,
    veto: !!v.veto,
    sizeHint: v.sizeHint,
    verdict: v.verdict,
    ...(v.flipScore != null ? { flipScore: v.flipScore } : {}),
    fails: (v.checklist || []).filter(c => c.status === 'FAIL').map(c => c.id),
    warns: (v.checklist || []).filter(c => c.status === 'WARN').length,
  };
}
