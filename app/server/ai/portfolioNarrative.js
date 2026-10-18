// ============================================================
// server/ai/portfolioNarrative.js — ACCURACY-PLAN PHASE 4
// ------------------------------------------------------------
// The PORTFOLIO AI OVERLAY — the portfolio tab was rule-based only
// (portfolioAnalytics/portfolioInsights/portfolioMonitor are pure
// client quant); this module adds the AI layer with the repo's own
// "quant-computes, LLM-narrates" discipline:
//   • portfolioRedFlags (PURE) — the MacroRegime cross-check:
//     market concentration vs the live regime (India/crypto split
//     against NIFTY/BTC regime seats), the health-grade concentration
//     risk, and the "your top holding's AI signal just flipped
//     bearish" nudge (top holdings' fresh ensemble views injected).
//   • buildPortfolioNarration — the LLM prompt that explains the
//     client's OWN computed insights + diff-worthy moves + the red
//     flags in plain Hinglish (what changed, why it matters, one
//     actionable step — never a buy/sell call on savings).
//   • buildPortfolioDigestText — the /portfolio Telegram digest.
// Route: POST /api/ai/portfolio-narrative (ai/routes.js).
// Telegram: /portfolio command (webhook.js) — the two-way query
// surface the plan asked for (bot ab portfolio pe bhi jawab deta hai).
// ============================================================
import { askLLM } from '../intraday/agent.js';
import { buildRegime as _buildRegime } from './signals.js';

// ---------------- the red-flag engine (PURE) ----------------
/**
 * Concentration × regime × AI-view cross-checks. ALL inputs are plain
 * objects — injectable for tests; the route passes live regime objects
 * and top-holding ensemble views.
 * @param {{ marketSplit?: {india?: number, usa?: number, crypto?: number}, health?: {grade?: string}, topWeight?: number, holdings?: Array<{label: string, group: string, weightPct?: number}> }} payload the client's computed insights echo
 * @param {{ regimes?: {INDIA?: object|null, CRYPTO?: object|null}, aiViews?: Record<string, {side?: string, confidence?: number, grade?: string}|null> }} ctx injected regime + per-symbol fresh ensemble views
 * @returns {{level: 'high'|'warn', code: string, title: string, detail: string}[]}
 */
export function portfolioRedFlags(payload = {}, ctx = {}) {
  const flags = [];
  const split = payload.marketSplit || {};
  const regimes = ctx.regimes || {};
  const aiViews = ctx.aiViews || {};
  const grade = String(payload.health?.grade || '');

  // 1) MARKET CONCENTRATION × MACRO REGIME (the plan's item 3: "agar
  //    portfolio kisi sector me heavy hai aur model usko bearish bata
  //    raha hai, red-flag alert surface karo")
  const regimeOf = (r) => {
    if (!r || typeof r !== 'object') return null;
    const label = String(r.label || r.regime || '').toUpperCase();
    if (!label) return null;
    return label.includes('BEAR') ? 'BEARISH' : label.includes('BULL') ? 'BULLISH' : 'NEUTRAL';
  };
  const indiaRegime = regimeOf(regimes.INDIA);
  const cryptoRegime = regimeOf(regimes.CRYPTO);
  if ((Number(split.india) || 0) >= 50 && indiaRegime === 'BEARISH') {
    flags.push({
      level: 'warn', code: 'INDIA_BEAR_REGIME',
      title: `India exposure ${Math.round(Number(split.india))}% in a BEARISH NIFTY regime`,
      detail: 'MacroRegime seat abhi India market ko bearish dekh raha hai aur portfolio ka aadha se zyada wahan hai — rebalancing ka sochna (savings pe kabhi bhi force-sell nahi).',
    });
  }
  if ((Number(split.crypto) || 0) >= 35 && cryptoRegime === 'BEARISH') {
    flags.push({
      level: 'warn', code: 'CRYPTO_BEAR_REGIME',
      title: `Crypto exposure ${Math.round(Number(split.crypto))}% in a BEARISH BTC regime`,
      detail: 'BTC regime gate bearish hai — crypto allocation size down karne ya hedge sochne ka zaman hai.',
    });
  }

  // 2) HEALTH-GRADE concentration risk (the quant layer already graded
  //    it — the overlay makes it loud)
  if (grade === 'EGG-IN-ONE-BASKET' || grade === 'CONCENTRATED') {
    flags.push({
      level: grade === 'EGG-IN-ONE-BASKET' ? 'high' : 'warn',
      code: `GRADE_${grade.replace(/-/g, '_')}`,
      title: `Concentration: ${grade} (top holding ${(Number(payload.topWeight) || 0).toFixed(1)}%)`,
      detail: 'Single point of failure — ek holding ka ek bura din poora portfolio ghumane ke liye kaafi hai.',
    });
  }

  // 3) TOP HOLDINGS × FRESH ENSEMBLE VIEW (the plan's item 4: "your
  //    top holding's AI signal just flipped bearish" nudge)
  for (const h of (payload.holdings || [])) {
    const w = Number(h?.weightPct) || 0;
    if (w < 10) continue; // only meaningful holdings
    const v = aiViews[String(h.label || '').toUpperCase()];
    if (!v) continue;
    const side = String(v.side || '').toUpperCase();
    if (side === 'SHORT' || side === 'FLIP') {
      flags.push({
        level: w >= 20 ? 'high' : 'warn',
        code: 'HOLDING_AI_BEARISH',
        title: `${h.label} (${w.toFixed(1)}% of portfolio) — AI view abhi ${side === 'FLIP' ? 'FLIPPED' : 'BEARISH'} (${v.confidence ?? '?'}% conf)`,
        detail: `Ensemble ka fresh ${v.grade || 'VIEW'} signal is holding pe ${side} hai. Ye SELL call nahi hai — bas wo seat jo aapka portfolio 24x7 dekhta hai, ulta mood me hai. Rebalance window socho.`,
      });
    }
  }
  // high-severity first, then warn — stable order
  const rank = (f) => (f.level === 'high' ? 0 : 1);
  return flags.sort((a, b) => rank(a) - rank(b));
}

// ---------------- the narration prompt ----------------
/**
 * The LLM narration input — the client's own quant numbers + the red
 * flags, told to explain (not to recompute or to sell).
 * @returns {string} the full prompt for askLLM.
 */
export function buildPortfolioNarration({ insights = {}, redFlags = [], holdings = [], totalValueINR = 0, usdInr = 84 } = {}) {
  const top = (holdings || []).slice(0, 8).map(h =>
    `${h.label} (${h.group}): ${typeof h.weightPct === 'number' ? h.weightPct.toFixed(1) : '?'}% · P&L ${typeof h.plPct === 'number' ? (h.plPct >= 0 ? '+' : '') + h.plPct.toFixed(1) : '?'}%`
  ).join('\n') || '(no holdings passed)';
  const flagTxt = (redFlags || []).map(f => `[${f.level.toUpperCase()}] ${f.title} — ${f.detail}`).join('\n') || 'No red flags — portfolio quant health clean hai.';
  const split = insights.marketSplit || {};
  return `You are a plain-speaking portfolio coach for an Indian retail investor. You will be given the QUANT snapshot of their live portfolio (already computed — never recompute or contradict these numbers) and the RED FLAGS the risk engine raised. Explain in natural Hinglish (Roman script):

1. Kya chal raha hai — aaj ke winners/losers ka mood, one line each for the top 2-3.
2. Concentration + diversification ka simple matlab (top-1/top-3 weights, market split ${Math.round(Number(split.india) || 0)}% India / ${Math.round(Number(split.usa) || 0)}% US / ${Math.round(Number(split.crypto) || 0)}% crypto).
3. Red flags ko samjhao — kya mean karte hain aur kyun matter karte hain.
4. ONE actionable step (rebalance idea / review note — NEVER a buy/sell call on savings, never "bech do"; ye long-term portfolio hai, intraday desk nahi).

Portfolio value: ₹${Math.round(Number(totalValueINR) || 0).toLocaleString('en-IN')} (USD/INR ≈ ${usdInr}).
Health grade: ${insights.health?.grade || '—'} · Diversification score: ${insights.diversificationScore ?? '—'}/100.

TOP HOLDINGS:
${top}

RED FLAGS (the risk engine's own output — narrate these, do not invent new ones):
${flagTxt}

Style: 6-10 lines max, bullets chahiye to use karo, numbers quote karo EXACTLY as given. End with: "Ye coaching hai, not a trade call."`;
}

/**
 * The narration runner — quant-computes, LLM-narrates. Falls back to a
 * deterministic text when no LLM key is configured (honest degrade).
 * @returns {Promise<{ok: boolean, narrative: string, source: string}>}
 */
export async function narratePortfolio(args, deps = {}) {
  const prompt = buildPortfolioNarration(args);
  const llm = deps.askLLM || askLLM;
  try {
    const out = await llm('You are a precise portfolio coach. Numbers are ground truth — never invent or alter them.', prompt, { KEYS: deps.KEYS });
    const text = String(out || '').trim();
    if (text) return { ok: true, narrative: text, source: 'llm' };
  } catch { /* fall through to the deterministic text */ }
  const { redFlags = [], insights = {} } = args;
  const lines = [
    `🧠 Portfolio X-Ray — coaching mode (LLM offline, quant summary):`,
    `Health: ${insights.health?.grade || '—'} · Diversification ${insights.diversificationScore ?? '—'}/100.`,
    ...(redFlags.length ? redFlags.map(f => `${f.level === 'high' ? '🔴' : '🟠'} ${f.title}`) : ['✅ Koi red flag nahi — concentration aur regime cross-check dono clean.']),
    'Ye coaching hai, not a trade call.',
  ];
  return { ok: true, narrative: lines.join('\n'), source: 'quant-fallback' };
}

// ---------------- the /portfolio Telegram digest ----------------
/**
 * Server-side portfolio digest for the Telegram /portfolio command —
 * net-worth by class + the same red-flag engine over the server's own
 * asset snapshot + live regimes (two-way: user asks, bot answers).
 * @returns {Promise<string>} telegram-ready HTML text.
 */
export async function buildPortfolioDigestText({ netWorth, topHoldings = [], regimes = {}, aiViews = {} } = {}) {
  const nw = netWorth || {};
  const catLines = (nw.categories || []).slice(0, 5).map(c =>
    `• ${c.category}: ₹${Math.round(Number(c.valueINR) || 0).toLocaleString('en-IN')}${c.pct != null ? ` (${c.pct}%)` : ''}`
  ).join('\n') || '• (sync pehle karo — assets snapshot empty hai)';
  // netWorthSnapshot has no marketSplit — derive a digest-level split
  // from the top holdings' weights by group (top-6 coverage is enough
  // for the regime cross-check; the site overlay carries the exact one).
  const split = nw.marketSplit && typeof nw.marketSplit === 'object' ? nw.marketSplit : (() => {
    const sum = { india: 0, usa: 0, crypto: 0 };
    for (const h of topHoldings) {
      const g = ['india', 'usa', 'crypto'].includes(h?.group) ? h.group : 'crypto';
      sum[g] += Number(h?.weightPct) || 0;
    }
    return sum;
  })();
  const flags = portfolioRedFlags({
    marketSplit: split,
    health: { grade: nw.healthGrade },
    topWeight: nw.topWeight,
    holdings: topHoldings,
  }, { regimes, aiViews });
  const flagLines = flags.length
    ? flags.map(f => `${f.level === 'high' ? '🔴' : '🟠'} <b>${f.title}</b>\n<i>${f.detail}</i>`).join('\n')
    : '✅ Red flags: koi nahi — concentration × regime × AI-view cross-checks clean.';
  return [
    `💼 <b>PORTFOLIO DIGEST</b>`,
    `Net worth: <b>₹${Math.round(Number(nw.totalValueINR) || 0).toLocaleString('en-IN')}</b> · ${nw.holdingCount ?? 0} holdings · ${nw.valuedCount ?? 0} valued`,
    ``,
    catLines,
    ``,
    flagLines,
    ``,
    `<i>Site ke Portfolio tab pe full X-Ray + AI explain hai. Ye digest hai, not a trade call.</i>`,
  ].join('\n');
}
