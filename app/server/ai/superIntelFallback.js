// ============================================================
// server/ai/superIntelFallback.js — v10.10 SUPER-INTELLIGENCE
// DETERMINISTIC DESK ANSWERS
// ------------------------------------------------------------
// THE "ENGINES UNAVAILABLE" KILLER (the fix behind the SOL
// "[object Object]" report):
//
// Both desk agents (crypto CoinDCX tab + India intraday tab)
// used to die with `ok:false "Agent engines unavailable"` the
// moment Gemini→Groq→Cerebras were all down — and the frontend
// rendered that object as "[object Object]". But the agent's
// TOOLS are pure compute (no LLM anywhere): the 14-model
// ensemble, superIntel blueprints, funding, sizing, journal —
// all live regardless of the language engines.
//
// So when the LLM chain fails, we detect the question's intent
// and compose the FULL-TICKET answer deterministically from the
// SAME tools the LLM would have called:
//   • coin deep-dive  → analyze_coin + funding + sizing →
//                       exact entry zone / SL / T1-T2 / LEVERAGE
//                       ladder / liquidation / staged exits
//   • desk briefing   → top signals + regime
//   • wallet / P&L / risk / positions → tool output, formatted
//
// PURITY: this module never calls an LLM, never invents numbers
// (every figure comes off a tool result or it is omitted), and
// never throws — a crash here just falls back to the honest
// engines-unavailable path. Engine badge in the UI:
//   `super-intel-deterministic`.
// ============================================================

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const sgn = (v) => (v == null ? '?' : `${v > 0 ? '+' : ''}${v}`);

/** INR grouping (1,23,456 — Indian style) / plain for USDT. */
function fmt(n, cur = '') {
  const v = num(n);
  if (v == null) return '?';
  if (Math.abs(v) >= 1000 && cur === '₹') return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  return `${cur}${v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 10 ? 4 : 2 })}`;
}

// ------------------------------------------------------------
// 1. INTENT DETECTION (Hinglish-aware, keyword + symbol match)
// ------------------------------------------------------------
const CRYPTO_ALIASES = {
  BTC: ['btc', 'bitcoin'], ETH: ['eth', 'ethereum', 'ether'], BNB: ['bnb'],
  SOL: ['sol', 'solana'], XRP: ['xrp', 'ripple'], DOGE: ['doge', 'dogecoin'],
  ADA: ['ada', 'cardano'], AVAX: ['avax', 'avalanche'], LINK: ['link', 'chainlink'],
  DOT: ['dot', 'polkadot'], TRX: ['trx', 'tron'], MATIC: ['matic', 'polygon'],
  // commonly asked extras that analyze_coin can still deep-scan
  LTC: ['ltc', 'litecoin'], SHIB: ['shib', 'shiba'], PEPE: ['pepe'],
  ATOM: ['atom', 'cosmos'], NEAR: ['near'], ARB: ['arb', 'arbitrum'],
  OP: ['op'], SUI: ['sui'], APT: ['apt'], INJ: ['inj'], TIA: ['tia'],
  WIF: ['wif'], TRUMP: ['trump'], BONK: ['bonk'], FIL: ['fil'],
  ETC: ['etc'], UNI: ['uni', 'uniswap'], AAVE: ['aave'], XLM: ['xlm'],
};
const GLOBAL_TICKERS = new Set([
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'MU', 'AMD', 'INTC',
  'AVGO', 'QCOM', 'TXN', 'SMCI', 'PLTR', 'COIN', 'NFLX', 'ORCL', 'ADBE', 'UBER', 'SPACEX',
]);
const GLOBAL_NAME_HINTS = {
  APPLE: 'AAPL', MICROSOFT: 'MSFT', GOOGLE: 'GOOGL', ALPHABET: 'GOOGL', AMAZON: 'AMZN',
  NVIDIA: 'NVDA', TESLA: 'TSLA', META: 'META', MICRON: 'MU', INTEL: 'INTC', BROADCOM: 'AVGO',
  QUALCOMM: 'QCOM', PALANTIR: 'PLTR', COINBASE: 'COIN', NETFLIX: 'NFLX', ORACLE: 'ORCL',
  ADOBE: 'ADBE', UBER: 'UBER', SPACEX: 'SPACEX', AMD: 'AMD',
};

/** Extract the asked symbol from free text. Longest alias wins. */
export function detectSymbolInText(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  let best = null; let bestLen = 0;
  for (const [sym, aliases] of Object.entries(CRYPTO_ALIASES)) {
    for (const a of aliases) {
      if (new RegExp(`\\s${a}\\s`).test(t) && a.length > bestLen) { best = { symbol: sym, market: 'CRYPTO' }; bestLen = a.length; }
    }
  }
  const words = t.trim().split(/\s+/);
  for (const w of words) {
    const up = w.toUpperCase();
    if (GLOBAL_TICKERS.has(up) && up.length > bestLen) { best = { symbol: up, market: 'GLOBALFUTURES' }; bestLen = up.length; }
    else if (GLOBAL_NAME_HINTS[up] && up.length >= 4 && up.length > bestLen) { best = { symbol: GLOBAL_NAME_HINTS[up], market: 'GLOBALFUTURES' }; bestLen = up.length; }
  }
  return best;
}

/**
 * Intent classifier. Priority: risk > pnl > wallet > positions >
 * briefing > coin (symbol present = coin deep-dive default).
 */
export function detectDeskIntent(text, opts = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (/kill.?switch|loss cap|blocker|risk (status|check|kaisa|kya)/i.test(t)) return { kind: 'risk' };
  if (/p&l|pnl|profit(\/|\s+or\s+)?loss|win.?rate|kitna (profit|loss|kamaya|gaya)/i.test(t)) return { kind: 'pnl' };
  if (/wallet|balance|capital|margin|deployable|kitna (paisa|paise)/i.test(t)) return { kind: 'wallet' };
  if (/positions?|holdings?|open trades?|kya khol/i.test(t)) return { kind: 'positions' };
  if (/brief|desk (overview|briefing|status)|kya (buy|trade|kharid|karu|lu)\b|top (picks?|setups?|signals?)|market (kaisa|kya|overview|haal)|overview|aaj ka/i.test(t)) return { kind: 'briefing' };
  const sym = opts.detectSymbol ? opts.detectSymbol(t) : detectSymbolInText(t);
  if (sym) {
    return {
      kind: 'coin', symbol: sym.symbol, market: sym.market,
      futures: /futures?|perp|leverage|margin|marg/i.test(t),
    };
  }
  return null;
}

// ------------------------------------------------------------
// 2. TICKET COMPOSERS — pure formatting over tool results
// ------------------------------------------------------------
const INTRO = '⚡ SUPER-INTEL DETERMINISTIC MODE — AI language engines abhi offline hain, par ye answer live desk tools + 14-model ensemble ke EXACT compute se bana hai (zero LLM guessing, har number traceable). Engine auto-retry chalu hai (sentinel half-open) — wapas aate hi prose richer ho jayegi, numbers same rahenge.';

function voteLine(s) {
  const voters = s.voters ?? s.totalModels;
  return `Consensus: **${s.side}** · grade **${s.grade ?? '—'}** · confidence **${s.confidence}%** · ${voters ?? '?'}/${s.totalModels ?? '?'} models${s.agreement != null ? ` (agreement ${Math.round(s.agreement * 100)}%)` : ''}`;
}

function scoreLine(s) {
  if (s.aiScore == null) return '';
  return `SuperIntel AI Score: **${s.aiScore}/100**${s.tier ? ` (tier ${s.tier})` : ''}`;
}

/** Flatten the live signal's quality flags — mtf/session arrive as
 *  OBJECTS ({phase, aligned} / {tradeable}); never print them raw
 *  (a raw object is exactly how "[object Object]" comes back). */
function qualityLine(q) {
  if (!q) return '';
  const veto = typeof q.veto === 'string' ? q.veto : q.veto ? 'yes' : 'none';
  const mtf = q.mtf && typeof q.mtf === 'object'
    ? `${q.mtf.phase ?? '?'}${q.mtf.aligned != null && !/align/i.test(String(q.mtf.phase ?? '')) ? (q.mtf.aligned ? ' aligned' : ' misaligned') : ''}`
    : String(q.mtf ?? '—');
  const sess = q.session && typeof q.session === 'object'
    ? (q.session.tradeable ? 'tradeable' : 'gated')
    : String(q.session ?? '—');
  return `🧪 Quality: veto ${veto} · MTF ${mtf} · session ${sess}`;
}

/** aiNote may arrive as a string OR {note: '...'} — always a string out. */
function noteText(s) {
  const n = s.aiNote;
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (typeof n === 'object' && typeof n.note === 'string') return n.note;
  return '';
}

/** The FULL-TICKET composer — the exact-answer machine. */
function coinTicket(s, opts = {}) {
  const futures = !!opts.futures;
  const cur = futures ? '$' : '₹';
  const p = s.plan || {};
  const bp = s.blueprint || {};
  // entry zone: blueprint zone → live ATR band from stop distance →
  // entry point fallback (a collapsed "x – x" zone is noise, widen it)
  const long = String(s.side || 'LONG').toUpperCase() !== 'SHORT';
  const rdist = p.entry != null && p.stopLoss != null ? Math.abs(p.entry - p.stopLoss) : null;
  let zone = bp.entryZone;
  if (!zone && p.entry != null && rdist > 0) zone = long ? [p.entry - 0.35 * rdist, p.entry + 0.1 * rdist] : [p.entry - 0.1 * rdist, p.entry + 0.35 * rdist];
  if (zone && zone[0] != null && zone[0] === zone[1] && rdist > 0) zone = long ? [zone[0] - 0.35 * rdist, zone[1] + 0.1 * rdist] : [zone[0] - 0.1 * rdist, zone[1] + 0.35 * rdist];
  const L = [];
  const N = () => `${L.length + 1}.`;
  L.push(`${N()} **${s.symbol} ${s.side}** — ${futures ? 'FUTURES (USDT perp)' : 'SPOT (INR)'}${opts.sim ? ' · SIM desk — execution paper/notify only' : ''}`);
  L.push(`${N()} Entry zone: **${zone && zone[0] != null ? `${fmt(zone[0], cur)} – ${fmt(zone[1], cur)}` : '?'}**${bp.entryTiming?.note ? ` · ${bp.entryTiming.note}` : ''}`);
  L.push(`${N()} Stop-loss: **${fmt(p.stopLoss, cur)}**${p.riskPct != null ? ` (${r2(p.riskPct)}% risk distance${p.planStyle ? `, ${p.planStyle}` : ''})` : ''}`);
  const r1 = p.stopLoss != null && p.entry != null && Math.abs(p.entry - p.stopLoss) > 0
    ? Math.abs((p.target1 - p.entry) / (p.entry - p.stopLoss)) : null;
  L.push(`${N()} Targets: **T1 ${fmt(p.target1, cur)}**${r1 ? ` (+${r2(r1)}R)` : ''} · **T2 ${fmt(p.target2, cur)}**${p.rewardRisk ? ` (R:R ${p.rewardRisk})` : ''}${bp.targets?.t3 != null ? ` · T3 ${fmt(bp.targets.t3, cur)} (runner)` : ''}`);
  // LEVERAGE — the exact-number ask. Futures blueprint carries the
  // liquidation-aware ladder; spot is honest cash 1×. Missing blueprint
  // numbers fall back to the sizing tool's max-sane (never "null×").
  const lev = bp.leverage != null ? bp.leverage
    : futures ? (bp.maxSaneLeverage ?? opts.size?.maxSaneLeverage ?? 1) : 1;
  const saneMax = bp.maxSaneLeverage ?? opts.size?.maxSaneLeverage ?? null;
  if (futures || (bp.leverage != null && bp.leverage > 1)) {
    L.push(`${N()} Leverage: **${lev}×**${saneMax != null ? ` (max sane ${saneMax}×` : ''}${bp.liquidation ? `, liquidation ≈ ${fmt(bp.liquidation, cur)})` : saneMax != null ? ')' : ''}${bp.leverageNote ? ` — ${bp.leverageNote}` : ''}`);
  } else {
    L.push(`${N()} Leverage: SPOT 1× cash — koi liquidation risk nahi (futures/leverage chahiye to poocho, perp ticket dunga)`);
  }
  if (opts.size) {
    const sz = opts.size;
    L.push(`${N()} Position size (default ₹1,000 capital @1.5% risk): qty **${sz.recommendedQty}**${sz.riskAmount != null ? ` · risk ${fmt(sz.riskAmount, '₹')}` : ''}${sz.stopDistancePct != null ? ` · stop distance ${sz.stopDistancePct}%` : ''}${sz.maxSaneLeverage ? ` · futures max sane ${sz.maxSaneLeverage}×` : ''} · capital apna batao to exact qty recalibrate ho jayega`);
  }
  if (bp.exitPlan?.length) L.push(`${N()} Staged exits (40/40/20): ${bp.exitPlan.map(e => e.action).join(' · ')}`);
  if (bp.exitBy) L.push(`${N()} Time-window: exit-by **${bp.exitBy}**`);
  if (opts.funding && !opts.funding.error) {
    const f = opts.funding;
    L.push(`${N()} Funding: **${f.fundingRate8h != null ? `${(f.fundingRate8h * 100).toFixed(4)}%` : '?'} / 8h**${f.fundingBps8h != null ? ` (${f.fundingBps8h} bps)` : ''}${f.approxDailyCarryPct != null ? ` · daily carry ≈ ${f.approxDailyCarryPct}%` : ''}${f.interpretation ? ` — ${f.interpretation}` : ''}`);
  }
  if (bp.invalidation) L.push(`${N()} Invalidation: ${bp.invalidation}`);
  return L.join('\n');
}

function signalTicket(sig, cur = '₹', futures = false) {
  const p = sig.plan || {};
  return `- **${sig.symbol} ${sig.side}** ${futures ? '(perp)' : '(spot)'} · conf ${sig.confidence}%${sig.aiScore != null ? ` · AI ${sig.aiScore}/100` : ''}`
    + (p.entry != null ? `\n  Entry ${fmt(p.entry, cur)} · SL ${fmt(p.stopLoss, cur)} · T1 ${fmt(p.target1, cur)} · T2 ${fmt(p.target2, cur)}${p.rewardRisk ? ` · R:R ${p.rewardRisk}` : ''}` : '');
}

/** Readable "key: value" lines from a tool result object (wallet /
 *  pnl / risk / positions) — nested objects indent, arrays become
 *  numbered compact lines. Never throws, depth-capped at 2. */
export function kvLines(obj, depth = 0, maxLen = 1800) {
  const out = [];
  const push = (s) => { if (out.join('\n').length < maxLen) out.push(s); };
  const pretty = (v) => {
    if (v == null) return '—';
    if (typeof v === 'number') return v.toLocaleString('en-IN', { maximumFractionDigits: 4 });
    if (typeof v === 'boolean') return v ? '✅' : '⛔';
    if (typeof v === 'string') return v.length > 90 ? `${v.slice(0, 90)}…` : v;
    return JSON.stringify(v);
  };
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const label = String(k).replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).toLowerCase();
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1) {
        push(`${'· '.repeat(depth + 1)}**${label}:**`);
        for (const [k2, v2] of Object.entries(v).slice(0, 10)) push(kvLines({ [k2]: v2 }, depth + 1, maxLen - out.join('\n').length).trim());
      } else if (Array.isArray(v)) {
        push(`${'· '.repeat(depth + 1)}**${label}:** ${v.length} item${v.length === 1 ? '' : 's'}`);
        v.slice(0, 4).forEach((item, i) => {
          if (item && typeof item === 'object') push(`  ${i + 1}. ${Object.entries(item).slice(0, 7).map(([k2, v2]) => `${k2} ${pretty(v2)}`).join(' · ')}`);
          else push(`  ${i + 1}. ${pretty(item)}`);
        });
      } else {
        push(`${'· '.repeat(depth + 1)}**${label}:** ${pretty(v)}`);
      }
    }
  } else if (Array.isArray(obj)) {
    obj.slice(0, 6).forEach((item, i) => {
      if (item && typeof item === 'object') push(`${i + 1}. ${Object.entries(item).slice(0, 7).map(([k2, v2]) => `${k2} ${pretty(v2)}`).join(' · ')}`);
      else push(`${i + 1}. ${pretty(item)}`);
    });
  } else if (obj != null) {
    push(pretty(obj));
  }
  return out.join('\n') || '(empty)';
}

// ------------------------------------------------------------
// 3. PUBLIC ENTRY — one call per desk, tool-runner injected
// ------------------------------------------------------------
/**
 * Build the deterministic answer for the CRYPTO desk.
 * @param {string[]} messages  chat history (user/assistant)
 * @param {object} deps        agent deps (KEYS etc.)
 * @param {Function} runTool   (name, args) => Promise<result> — the
 *                             SAME executeCryptoTool the LLM loop uses
 * @param {object[]} toolTrace shared trace array (tool chips in UI)
 * @returns {Promise<{text:string}|null>} null = intent not actionable
 */
export async function buildDeterministicCryptoAnswer(messages, deps, runTool, toolTrace) {
  const lastUser = [...(messages || [])].reverse().find(m => m?.role === 'user');
  const q = String(lastUser?.content || '');
  const intent = detectDeskIntent(q);
  if (!intent) return null;
  const trace = (name) => { toolTrace.push({ tool: name, ts: Date.now() }); };

  try {
    // ---- COIN DEEP-DIVE (the SOL case) ----
    if (intent.kind === 'coin') {
      trace(intent.market === 'GLOBALFUTURES' ? 'analyze_global_stock' : 'analyze_coin');
      const isGlobal = intent.market === 'GLOBALFUTURES';
      const s = await runTool(isGlobal ? 'analyze_global_stock' : 'analyze_coin', { symbol: intent.symbol, market: intent.futures ? 'FUTURES' : 'CRYPTO' }, deps);
      if (!s || s.error) {
        return { text: `${INTRO}\n\n⚠️ ${isGlobal ? intent.symbol : intent.symbol} scan nahi ho paya: ${s?.error || 'feed down'}.\nSymbol check karo (BTC/ETH/SOL/...) ya thodi der baad try karo — feed 2-min cache me refresh hota hai.` };
      }
      let size = null; let funding = null;
      if (s.plan?.entry != null && s.plan?.stopLoss != null) {
        trace('calculate_position_size');
        size = await runTool('calculate_position_size', { entry: s.plan.entry, stopLoss: s.plan.stopLoss, capital: 1000, riskPercent: 1.5 }, deps).catch(() => null);
      }
      if (intent.futures && !isGlobal) {
        trace('get_funding_rate');
        funding = await runTool('get_funding_rate', { symbol: intent.symbol }, deps).catch(() => null);
      }
      const head = [
        `🔍 **${s.symbol} — DEEP DIVE** (${isGlobal ? 'GLOBAL equity SIM' : intent.futures ? 'FUTURES USDT perp' : 'SPOT'})`,
        `LTP **${fmt(s.ltp, isGlobal ? '$' : intent.futures ? '$' : '₹')}**${s.changePct != null ? ` · 24h ${sgn(r2(s.changePct))}%` : ''}`,
        voteLine(s),
        scoreLine(s),
      ].filter(Boolean);
      const votes = (s.votes || []).slice(0, 6)
        .map(v => `${v.dir === 'BULL' ? '🟢' : v.dir === 'BEAR' ? '🔴' : '⚪'} ${v.model} ${v.conf}%${v.why?.length ? ` — ${v.why.join('; ')}` : ''}`)
        .join('\n');
      const bullN = (s.votes || []).filter(v => v.dir === 'BULL').length;
      const bearN = (s.votes || []).filter(v => v.dir === 'BEAR').length;
      const parts = [
        INTRO, '', head.join('\n'),
      ];
      // honest thin-conviction call — a NEUTRAL/low-conf setup must NOT
      // read like a green signal (the full-ticket rules demand honesty)
      const thin = (num(s.confidence) ?? 0) < 55 || /^(NEUTRAL|WEAK|WATCH)$/i.test(String(s.grade ?? ''));
      if (thin) {
        parts.push(`🟡 **Conviction thin hai** — grade ${s.grade ?? '?'} / confidence ${s.confidence ?? '?'}%. Ye WATCH-grade hai: levels upar ticket me hain par aggressive entry avoid karo, confirmation ka wait karo.`);
      }
      parts.push('', '📋 **FULL TICKET (exact numbers):**', coinTicket(s, { futures: intent.futures, size, funding, sim: isGlobal }));
      if (votes) parts.push('', `🗳️ **Model votes** (${bullN}🟢 / ${bearN}🔴 of ${s.totalModels ?? (s.votes || []).length}):`, votes);
      const note = noteText(s);
      if (note) parts.push('', `📌 ${note}`);
      const qline = qualityLine(s.quality);
      if (qline) parts.push('', qline);
      parts.push('', '⚠️ Key risk: SL break = pick cancel, averaging nahi. Ye deterministic ticket hai — capital/leverage apne risk appetite ke hisaab se adjust karo.');
      return { text: parts.join('\n') };
    }

    // ---- DESK BRIEFING ----
    if (intent.kind === 'briefing') {
      trace('get_live_crypto_signals');
      const b = await runTool('get_live_crypto_signals', {}, deps);
      // shape: { SPOT: [...], FUTURES: [...], GLOBAL: [...] } — merge,
      // dedupe by symbol (SPOT wins), grade/aiScore sort.
      const bySym = new Map();
      for (const [label, list] of Object.entries(b || {})) {
        if (!Array.isArray(list)) continue;
        for (const s of list) {
          if (!s || s.error || bySym.has(s.symbol)) continue;
          bySym.set(s.symbol, { ...s, _futures: label === 'FUTURES', _global: label === 'GLOBAL' });
        }
      }
      const rows = [...bySym.values()]
        .sort((a, c) => (c.aiScore ?? c.confidence ?? 0) - (a.aiScore ?? a.confidence ?? 0))
        .slice(0, 3);
      if (!rows.length) return { text: `${INTRO}\n\nBoard abhi khali/flat hai — koi qualifying setup nahi (sab watch-grade). Ye honest NO-TRADE hai.` };
      trace('get_market_regime');
      const reg = await runTool('get_market_regime', {}, deps).catch(() => null);
      const parts = [
        INTRO, '',
        `📋 **DESK BRIEFING**${reg ? ` — regime ${reg.regime}${reg.btcChangePct24h != null ? ` (BTC ${sgn(r2(reg.btcChangePct24h))}% 24h)` : ''}${reg.fearGreed?.value ? ` · F&G ${reg.fearGreed.value}` : ''}` : ''}`,
        '',
        ...rows.map(s => signalTicket(s, s._global || s._futures ? '$' : '₹', s._futures)),
        '',
        'Coin ka full ticket chahiye to naam poocho (e.g. "SOL ka deep analysis").',
      ];
      return { text: parts.join('\n') };
    }

    // ---- WALLET / PNL / RISK / POSITIONS ----
    const simple = {
      wallet: { tool: 'get_wallet', title: '💰 WALLET' },
      pnl: { tool: 'get_pnl', title: '📈 P&L' },
      risk: { tool: 'get_risk_status', title: '🛑 RISK STATUS' },
      positions: { tool: 'get_open_positions', title: '📝 OPEN POSITIONS' },
    }[intent.kind];
    if (simple) {
      trace(simple.tool);
      const d = await runTool(simple.tool, intent.kind === 'pnl' ? { period: 'today' } : {}, deps);
      return { text: `${INTRO}\n\n${simple.title}\n${kvLines(d)}\n\nDetail me koi specific cheez poochho — exact numbers bata dunga.` };
    }
  } catch {
    return null; // tool crash → honest failure path (never fake numbers)
  }
  return null;
}

/**
 * Build the deterministic answer for the INDIA INTRADAY desk.
 * @param {string[]} messages  chat history
 * @param {object} deps        agent deps (with getLastScan/triggerScan/analyzeSymbol...)
 * @param {Function} runTool   (name, args) => Promise<result> — the SAME executeAgentTool
 * @param {object[]} toolTrace shared trace array
 */
export async function buildDeterministicIntradayAnswer(messages, deps, runTool, toolTrace) {
  const lastUser = [...(messages || [])].reverse().find(m => m?.role === 'user');
  const q = String(lastUser?.content || '');
  if (!q.trim()) return null;
  const trace = (name) => { toolTrace.push({ tool: name, ts: Date.now() }); };

  // NSE symbol detection — two guards against Hinglish false-positives:
  //   1. the message must carry a connector/finance word (ka/kaisa/analysis/entry...)
  //   2. the caps token must not be a common Hindi/finance word itself
  const sym = (() => {
    if (/risk|kill/i.test(q)) return null;
    if (!/\b(ka|kii|kaisa|kaisi|kya|hai|karo|karu|lu|batao|bata|dikhao|de|do|dena|analysis|setup|entry|exit|sl|trade|buy|sell|pe|me|par|kaisan|chahiye|milega)\b/i.test(q)) return null;
    const EXCLUDE = new Set(['SL', 'TP', 'P&L', 'PNL', 'INR', 'NSE', 'BANK', 'NIFTY', 'AISA', 'KAISA', 'KAISI', 'KARU', 'KARO', 'KYA', 'HAI', 'DEEP', 'AI', 'MCP', 'TOP', 'SETUPS', 'SETUP', 'AAJ', 'KAUNSE', 'HAIN', 'BATAO', 'BATA', 'DIKHAO', 'LU', 'LI', 'PE', 'ME', 'PAR', 'ENTRY', 'EXIT', 'TRADE', 'BUY', 'SELL', 'DO', 'DE', 'ABHI', 'CHAL', 'SCALP', 'MOMENTUM', 'KISKI', 'ISKI', 'USKI', 'KA', 'KI', 'KO', 'KAR', 'HONA', 'ANALYSIS', 'KAUNSA', 'KAUNSI']);
    return (q.toUpperCase().match(/\b[A-Z]{2,12}(?:-[A-Z]+)?\b/g) || []).find(w => !EXCLUDE.has(w)) || null;
  })();
  const wantsBriefing = /brief|kya (buy|karu|lu|trade)|top (picks?|setups?|signals?)|market (kaisa|kya|overview)|aaj ka|scanner|signals?\b/i.test(q);
  try {
    if (sym && !wantsBriefing) {
      trace('analyze_setup');
      const s = await runTool('analyze_setup', { symbol: sym }, deps);
      if (s && !s.error) {
        const r = num(s.rr); const er = num(s.effRR);
        const parts = [
          INTRO, '',
          `🔍 **${s.symbol} — NSE INTRADAY SETUP**`,
          `LTP **₹${fmt(s.ltp)}**${s.changePct != null ? ` · ${sgn(r2(s.changePct))}%` : ''} · Direction **${s.direction}** · quant confidence **${s.quantConfidence ?? '?'}%**`,
          '',
          '📋 **FULL TICKET (exact numbers):**',
          `1. **${s.symbol} ${s.direction}** — intraday MIS`,
          `2. Entry zone: **${s.entryZone?.[0] != null ? `${fmt(s.entryZone[0], '₹')} – ${fmt(s.entryZone[1], '₹')}` : fmt(s.entry, '₹')}**`,
          `3. Stop-loss: **${fmt(s.stopLoss, '₹')}** (structure/ATR based${s.trailingSL ? `, trailing ${fmt(s.trailingSL, '₹')}` : ''})`,
          `4. Targets: **T1 ${fmt(s.target1, '₹')}** · **T2 ${fmt(s.target2, '₹')}**${r ? ` · R:R ${r}` : ''}${er ? ` (eff ${er})` : ''}`,
          `5. Position size: **${s.qtyPerLakh != null ? `${s.qtyPerLakh} qty/lakh` : '?'}** (per ₹1,00,000 capital — apne capital par scale karo)`,
          `6. Leverage: MIS 1× plan — broker-side ~5× margin broker par depend`,
          s.freshEntriesAllowed === false ? '7. ⛔ Fresh entries CLOSED (time-window/session gate)' : '7. ✅ Fresh entries allowed abhi',
        ];
        if (s.rsi != null || s.adx != null) parts.push('', `📊 RSI ${s.rsi ?? '—'} · ADX ${s.adx ?? '—'} · vol×${s.volumeRatio ?? '—'} · VWAP dist ${s.vwapDist ?? '—'}%`);
        if (s.counterTrend) parts.push('', '⚠️ Counter-trend setup — size aadha rakho ya skip.');
        if (Array.isArray(s.reasons) && s.reasons.length) parts.push('', `Why: ${s.reasons.slice(0, 3).join(' · ')}`);
        parts.push('', '⚠️ Intraday = aaj ka kaam: 15:15 IST tak square-off, SL break = pick cancel.');
        return { text: parts.join('\n') };
      }
      // fall through to briefing if the symbol has no live data
    }
    if (wantsBriefing || sym) {
      trace('get_live_intraday_signals');
      const b = await runTool('get_live_intraday_signals', {}, deps);
      const rows = (b?.signals || []).slice(0, 3);
      if (!rows.length) return { text: `${INTRO}\n\n${b?.marketOpen === false ? 'Market band hai (NSE 09:15–15:30 IST Mon–Fri).' : 'Scanner me abhi koi qualifying setup nahi — honest NO-TRADE window.'}` };
      const parts = [
        INTRO, '',
        `📋 **INTRADAY DESK BRIEFING**${b.marketOpen === false ? ' (market band — last scan)' : ''}${b.asOf ? ` · as of ${new Date(b.asOf).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST` : ''}`,
        '',
        ...rows.map(s => `- **${s.symbol} ${s.direction}** · conf ${s.confidence}%${s.grade ? ` · grade ${s.grade}` : ''}\n  Entry ${s.entryZone ? `${fmt(s.entryZone[0], '₹')} – ${fmt(s.entryZone[1], '₹')}` : fmt(s.entry, '₹')} · SL ${fmt(s.stopLoss, '₹')} · T1 ${fmt(s.target1, '₹')} · T2 ${fmt(s.target2, '₹')}${s.rr ? ` · R:R ${s.rr}` : ''}`),
        '',
        'Kisi symbol ka poora ticket poocho (e.g. "RELIANCE ka analysis").',
      ];
      return { text: parts.join('\n') };
    }
  } catch {
    return null;
  }
  return null;
}
