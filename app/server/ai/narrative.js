// ============================================================
// server/ai/narrative.js — EXPLAIN TICKER (v6.11)
// ------------------------------------------------------------
// Glama-inspired (tv-mcp "explain_ticker" — narrative regime
// interpretation): turns the deep-scan indicator stack into a
// Hinglish story a human can read in 10 seconds. Not a NEW
// opinion — a TRANSLATION of what the 10 models already see:
//
//   trend  → EMA stack + ADX ("trend hai ya chop")
//   momo   → RSI + MACD ("engine me aag hai ya thandi hui")
//   vol    → ATR% + BB position ("kitna hil raha hai")
//   struct → 52w position ("kahan khada hai chart")
//   flow   → VWAP distance + relative volume ("aaj ka mood")
//
// Plus a "kya dekhna hai" line — the ONE thing that would change
// the story (invalidation-first thinking). Honest: missing fields
// are skipped, never invented.
// ============================================================

const r1 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);

/**
 * @param {{symbol, market, side, confidence, ltp, changePct, grade}} signal
 * @param {Record<string, number|null>} ind indicator snapshot (ctx.ind)
 * @returns {{title, story: string[], watch: string} | null}
 */
export function explainTicker(signal, ind = {}) {
  if (!signal || !ind) return null;
  const _s = r1(signal.ltp);
  const ltp = Number(signal.ltp) > 0 ? Number(signal.ltp) : null;
  if (!ltp) return null;

  const ema20 = r1(ind.ema20), ema50 = r1(ind.ema50);
  const rsi = r1(ind.rsi), macd = r1(ind.macd), macdSig = r1(ind.macdSignal);
  const atr = Number(ind.atr) > 0 ? Number(ind.atr) : null;
  const atrPct = atr && ltp ? Math.round((atr / ltp) * 1000) / 10 : null;
  const adx = r1(ind.adx), vwap = r1(ind.vwap);
  const bbU = r1(ind.bbUpper), bbL = r1(ind.bbLower);
  const relVol = r1(ind.relVolume);
  const hi52 = Number(ind.high52w) > 0 ? Number(ind.high52w) : null;
  const lo52 = Number(ind.low52w) > 0 ? Number(ind.low52w) : null;
  const pos52 = (hi52 && lo52 && hi52 > lo52) ? Math.round(((ltp - lo52) / (hi52 - lo52)) * 1000) / 10 : null;
  const chg = r1(signal.changePct);
  const side = signal.side === 'LONG' ? 'bullish' : signal.side === 'SHORT' ? 'bearish' : 'neutral';
  const isCrypto = signal.market === 'CRYPTO' || signal.market === 'FUTURES';

  const story = [];

  // --- trend ---
  if (ema20 && ema50) {
    if (ltp > ema20 && ema20 > ema50) story.push(`Trend UP hai — price EMA20 (${ema20}) ke upar aur EMA20 > EMA50 (${ema50}), yaani stack sahi order me hai.`);
    else if (ltp < ema20 && ema20 < ema50) story.push(`Trend DOWN hai — price EMA20 (${ema20}) ke neeche aur EMA20 < EMA50 (${ema50}), sellers control me hain.`);
    else story.push(`Trend MIXED — price EMA20 (${ema20}) aur EMA50 (${ema50}) ke beech phas gaya hai: pullback ya breakdown, abhi decide nahi hua.`);
  }
  if (adx != null) {
    story.push(adx > 25
      ? `ADX ${adx} — trend me taqat hai, sidha chal raha hai (chop nahi).`
      : adx > 20 ? `ADX ${adx} — trend ban raha hai, thoda kamzor abhi.`
      : `ADX ${adx} — koi trend nahi, range/chop regime hai (breakout ke baad hi kuch hoga).`);
  }

  // --- momentum ---
  if (rsi != null) {
    const z = isCrypto ? `crypto me ye level aur bhi sharp hota hai` : `book me rotation possible`;
    story.push(rsi > 70 ? `RSI ${rsi} — overbought. ${z}.`
      : rsi >= 55 ? `RSI ${rsi} — momentum bullish zone me hai, buyers paas hain.`
      : rsi >= 45 ? `RSI ${rsi} — momentum neutral, dono taraf khula.`
      : rsi >= 30 ? `RSI ${rsi} — momentum weak, sellers halka upar hain.`
      : `RSI ${rsi} — oversold. Bounce ke chances ban jaate hain.`);
  }
  if (macd != null && macdSig != null) {
    story.push(macd > macdSig
      ? `MACD signal line ke upar cross karke hai — short-term momentum turn hua.`
      : `MACD signal line ke neeche hai — momentum thanda pada hai.`);
  }

  // --- volatility ---
  if (atrPct != null) {
    story.push(atrPct >= 3
      ? `Volatility HIGH (ATR ${atrPct}%/bar) — stop chhota rakhne par noise hi kaat dega, size kam karo.`
      : atrPct >= 1.2 ? `Volatility normal (ATR ${atrPct}%/bar) — standard stops chaleinge.`
      : `Volatility LOW (ATR ${atrPct}%/bar) — squeeze; move aane wala ho sakta hai.`);
  }
  if (bbU && bbL && ltp) {
    const bw = ((bbU - bbL) / ltp) * 100;
    const near = ltp > bbU ? 'upper band se UPAR' : ltp < bbL ? 'lower band se NEECHE' : 'bands ke andar';
    story.push(bw < 5
      ? `Bollinger squeeze (${bw.toFixed(1)}% width, price ${near}) — breakout ka fuel collect ho raha hai.`
      : `Price Bollinger ${near} hai (width ${bw.toFixed(1)}%).`);
  }

  // --- structure + flow ---
  if (pos52 != null) {
    story.push(pos52 >= 70 ? `52-week range me ${pos52}% upar — strength zone, yahan se breakouts continuation hote hain.`
      : pos52 <= 30 ? `52-week range me sirf ${pos52}% upar — deep side me, recovery trade hi meaning hai.`
      : `52-week range ka beech me (${pos52}%) hai — swing range trade zone.`);
  }
  if (vwap && ltp) {
    const vd = Math.round(((ltp - vwap) / vwap) * 1000) / 10;
    story.push(vd > 0 ? `Aaj VWAP (${vwap}) se +${vd}% upar — intraday buyers haq me.`
      : `Aaj VWAP (${vwap}) se ${vd}% neeche — intraday sellers haq me.`);
  }
  if (relVol != null) {
    story.push(relVol >= 2 ? `Volume ${relVol}× average — aaj move me participation asli hai (whale-ish).`
      : relVol >= 1.2 ? `Volume ${relVol}× average — thoda zyada participation, healthy.`
      : `Volume ${relVol}× average — patla tape, move par bharosa kam.`);
  }
  if (chg != null && chg !== 0) {
    story.push(`Aaj ${chg > 0 ? '+' : ''}${chg}% ${chg > 0 ? 'green' : 'red'} hai.`);
  }

  if (story.length === 0) return null;

  // --- the watch line (invalidation-first) ---
  const watchBits = [];
  if (ema20 && ltp) watchBits.push(side === 'bullish' || side === 'neutral' ? `EMA20 ${ema20} ke neeche close` : `EMA20 ${ema20} ke upar close`);
  if (rsi != null) watchBits.push(rsi > 65 ? 'RSI cool-off < 60' : rsi < 35 ? 'RSI recovery > 45' : `RSI ${rsi > 50 ? 60 : 40} side cross`);
  const watch = watchBits.length
    ? `Kya dekhna hai: ${watchBits.slice(0, 2).join(' ya ')} — story wahin badal jaayegi.`
    : 'Kya dekhna hai: naya data aane do.';

  const title = `${signal.symbol} — ${side.toUpperCase()} ${signal.confidence != null ? `· consensus ${signal.confidence}%` : ''}`.trim();

  return {
    title,
    story: story.slice(0, 7),
    watch,
    asOf: Date.now(),
  };
}

export const __testables = { r1 };
