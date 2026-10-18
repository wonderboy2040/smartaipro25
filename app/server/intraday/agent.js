// ============================================================
// intraday/agent — PRO TRADER MCP AGENT (v1)
// ------------------------------------------------------------
// World-class intraday desk-trader agent with REAL tool access:
//   • 8 intraday-specialized MCP tools (live signals, deep setup
//     scan, quotes, regime, track-record, paper positions,
//     news, position sizing)
//   • ReAct loop — up to 6 tool rounds (vs 2 in generic chat)
//   • Live context auto-injection (regime + IST phase + market
//     status) so the agent never reasons on stale assumptions
//   • Multi-provider fallback: Gemini → Groq → Cerebras
//
// Registered by routes.js as POST /api/intraday-agent
// deps injected from server/index.js via registerIntradayRoutes:
//   { KEYS, OPENAI_COMPAT, fetchGrowwNseQuote, getLastScan,
//     triggerScan, getTrackRecord, getPaperSummary,
//     analyzeSymbol, getMarketRegime }
// ============================================================
import { istMinutes as _istMinutes, marketPhase, getISTParts, isNseMarketOpen } from './time.js';
// v10.8 PRO #3: persistent chat memory — the desk remembers past turns
import { rememberChat, memoryContextFor } from '../ai/agentMemory.js';
// v10.10 SUPER-INTEL FALLBACK — engine-down ≠ data-down: deterministic
// full-ticket answers from the same tools the LLM loop would call.
import { buildDeterministicIntradayAnswer } from '../ai/superIntelFallback.js';

// v13.2 A5: MCP governance — rate-limit + audit-log every tool call
import { withMcpAudit } from '../ai/mcpAudit.js';
// v18.7 ENGINE SENTINEL — health-aware provider chain (cooldown
// fast-fail, auto half-open recovery, honest status line, keyless
// local ollama engine when installed).
import { engineSkip, engineTrack, engineOk, engineStatusLine, ollamaProbe, ollamaCompatCfg } from '../ai/llmSentinel.js';

const MAX_TOOL_ROUNDS = 6;
const PER_ROUND_TIMEOUT_MS = 30000;
// v18.8: the local ollama engine gets a CPU-realistic per-round budget
// (a CPU-only llama3.1:8b can take 30-90s per round; 30s made it fail).
const OLLAMA_ROUND_TIMEOUT_MS = 120000;

// v10.3.1 TOOL TIMEOUT — user-reported: "ASK AI theek se kaam nahi
// kar raha". A cold NSE scan (full universe + AI consensus) takes
// 30-90s; the OLD unbounded tool await blew straight through the
// 90s frontend gate and the chain (Gemini→Groq→Cerebras) re-paid it
// on EVERY retry. Every tool call is now bounded at 20s and degrades
// to an honest `error` payload the model can answer around — the
// crypto desk never hit this because its Binance ticker feed is one
// cheap HTTP call.
const TOOL_TIMEOUT_MS = 20000;
function withToolTimeout(toolPromise, name) {
  // executeAgentTool never rejects (its own try/catch), but belt-and-
  // suspenders: a rejection AFTER the race resolves must not surface
  // as an unhandled rejection.
  const safe = Promise.resolve(toolPromise).catch(e => ({ error: `Tool ${name} failed: ${e?.message || e}` }));
  return Promise.race([
    safe,
    new Promise(resolve => {
      const t = setTimeout(() => resolve({
        error: `${name} timeout (${TOOL_TIMEOUT_MS / 1000}s) — live data fetch slow hai. Jo context available hai usse jawab do aur saaf batao ki ye number fresh nahi hai.`,
      }), TOOL_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

// ------------------------------------------------------------
// 1. TOOL DEFINITIONS (OpenAI function-calling format —
//    converted to Gemini format on the fly)
// ------------------------------------------------------------
export const PRO_TRADER_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_live_intraday_signals',
      description: 'Live top high-conviction NSE intraday setups from the quant scanner (EMA/VWAP/RSI/ADX/ORB-15/pivot scoring + AI consensus). The ensemble committee includes the MTF tape seat (5m/15m/1h confluence) and, when enabled, the V2 accuracy seats — SentimentPulse (news/F&G sentiment), InstFlow (FII/DII flows) — plus per-stock REAL option-chain reads (PCR/max-pain/OI) on the top F&O names, and mesh-backed seats in SHADOW mode (InstFlowPro/TechConsensus/FundaProPlus — journaled context votes at weight 0). Each setup includes direction, confidence, entry zone, stop-loss, target1/target2, R:R, qty per ₹1L, trend strength, and engine reasons. Use this FIRST when the user asks for setups, briefing, or market overview.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_setup',
      description: 'Deep single-symbol quant scan for any NSE stock: EMA stack, VWAP distance, RSI, MACD, ADX trend strength, ORB-15 status, gap analysis, pivot levels, relative volume — plus a complete trade plan (entry zone, structural stop, T1/T2 R-multiples, trailing SL, qty per lakh). Use when the user asks about a SPECIFIC stock.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'NSE symbol, e.g. RELIANCE, TATAMOTORS, HDFCBANK' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_intraday_quote',
      description: 'Real-time NSE live quote (LTP, day change %, day high/low, volume) for a single symbol from the Groww feed.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'NSE symbol, e.g. RELIANCE' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market_regime',
      description: 'Current NIFTY market regime (BULLISH/BEARISH/NEUTRAL), India VIX level, NIFTY VWAP distance — determines whether counter-trend trades deserve a penalty. Use before recommending counter-regime setups.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_track_record',
      description: 'Signal accountability: win-rate, average R-multiple, resolved/tracked counts, disciplined P&L per ₹1L over the last N days, plus open (unresolved) signals and recent history. Use when the user asks "kaisa chal raha hai" or for performance review.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Lookback days (default 7, max 90)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_paper_positions',
      description: 'Open virtual (paper) intraday positions with entry, qty, stop-loss, live P&L, plus today closed trades and stats. Use when the user asks about open positions or daily P&L.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_market_news',
      description: 'Live financial news search (Tavily). Use for sector news, stock-specific catalysts, FII/DII flows, or any "why is X moving" question.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, e.g. "IT sector news today" or "RELIANCE latest"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_detailed_signal_analysis',
      description: 'Full v4 dual-expert analysis for one live signal: quality grade (A+/A/B), trade-type classification (SCALP/MOMENTUM/SWING), entry-quality score 1-10, the complete Gemini+Groq AI reasoning chain, explicit risk factors, AI-adjusted stop/entry levels, and per-model verdicts. Use when the user asks WHY a setup is good, wants deep analysis of a signal, or asks about risk.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'NSE symbol from the live signals, e.g. RELIANCE' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_position_size',
      description: 'Position-sizing calculator: given entry, stop-loss, capital and risk %, returns exact quantity, capital deployed, risk amount and R-multiple targets. ALWAYS use before recommending a trade size.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'number', description: 'Entry price' },
          stopLoss: { type: 'number', description: 'Stop-loss price' },
          capital: { type: 'number', description: 'Trading capital in INR (default 100000)' },
          riskPercent: { type: 'number', description: 'Risk per trade as % of capital (default 1)' },
        },
        required: ['entry', 'stopLoss'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_model_consensus',
      description: 'PER-MODEL VOTE BREAKDOWN for one NSE symbol from the 14-model superintelligence ensemble (TrendMatrix, MomentumQuant, VolatilityScope, VolumeFlow, PatternNeural, SRMatrix, OptionsFlow real chain, MacroRegime, SmartMoneyICT, IntradayTape/MTF, AI Council + V2 seats): every model\'s direction, confidence and reason + the weighted consensus side/confidence/agreement + SVA verifier verdict + LLM second opinion when borderline. Falls back to the scanner\'s quant+AI verdicts when the deep ensemble is cold. Use for "consensus kya bol raha hai", "kaun se models agree", "signal ka reason kya hai".',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'NSE symbol, e.g. RELIANCE, TCS' },
        },
        required: ['symbol'],
      },
    },
  },
];

// Gemini tool format (type: "function" → functionDeclarations)
function geminiTools() {
  return [{
    functionDeclarations: PRO_TRADER_AGENT_TOOLS.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}

// ------------------------------------------------------------
// 2. SYSTEM PROMPT — world-class NSE intraday desk persona
//    (perf = self-calibration stats — injected when available)
// ------------------------------------------------------------
export function buildProTraderSystemPrompt(ctx, perf = null) {
  const { istTime, phase, marketOpen, weekday } = ctx;
  let perfBlock = '';
  if (perf && perf.totalTracked > 0) {
    const wr = perf.winRate != null ? `${perf.winRate.toFixed(1)}%` : 'n/a';
    const avgR = perf.avgR != null ? `${perf.avgR >= 0 ? '+' : ''}${perf.avgR.toFixed(2)}R` : 'n/a';
    const calib = perf.winRate != null && perf.resolved >= 10
      ? perf.winRate >= 60 ? 'Your edge is live — trade your full playbook.'
        : perf.winRate >= 50 ? 'Edge is moderate — be more selective, demand A/A+ grades only.'
          : 'Edge is currently WEAK — trade smaller, skip marginal setups, wait for A+ setups only.'
      : 'Not enough resolved signals yet — trade conservative size.';
    perfBlock = `
YOUR LIVE TRACK RECORD (self-calibration — let this discipline you):
- Last ${perf.days} days: ${perf.totalTracked} tracked, ${perf.resolved} resolved | Win-rate: ${wr} | Avg: ${avgR} | Disciplined P&L/₹1L: ₹${perf.disciplinedPnlPerLakh?.toFixed(0) ?? 0}
- WIN-RATE TARGET: maintain >60%. If below, tighten selectivity — only A/A+ graded setups, skip everything marginal.
- Calibration: ${calib}
- If win-rate is weak, PRIORITIZE capital protection over opportunity.`;
  }
  return `You are "PRO TRADER" — an elite world-class NSE/BSE intraday desk trader with 15+ years of experience trading Indian markets. You are the head of a proprietary intraday trading desk running the v4 DUAL-AI EXPERT stack (Gemini + Groq structured consensus verification).

CURRENT SESSION CONTEXT (auto-injected, always trust this over assumptions):
- IST time: ${istTime} (${weekday}) | Session phase: ${phase} | NSE market: ${marketOpen ? 'OPEN' : 'CLOSED'}
${perfBlock}
${fullTicketRules()}

STATISTICAL EDGE AWARENESS (v4):
- The engine grades setups A+ / A / B. A+ (confidence ≥88, RR ≥1.8, volume ≥1.5x, ADX ≥25, VWAP-aligned, regime-aligned) is the highest-probability class.
- B-grade = WATCH ONLY — do NOT recommend entries on B-grade setups.
- Dual-AI consensus REJECTS any setup where either expert votes AVOID or they disagree on direction — a signal that survives is already doubly vetted.
- Dead zone 14:30–15:00 IST: fresh setups are statistically weak — no new entries recommended there.

CORE METHODOLOGY (your trading edge — v4 + the accuracy-plan seats):
- EMA10/20 stack + VWAP bias + Supertrend(7) alignment defines directional control
- SMA50 multi-timeframe confluence = higher-conviction trend trades
- Relative volume ≥1.2x minimum for ANY signal; ≥1.5x for A+ grade
- ADX ≥22 required for trend trades; ADX <18 = range regime, avoid breakout chasing
- ORB-15 (opening range breakout) is highest-probability in first 90 minutes
- NIFTY/VIX regime gates everything: counter-regime setups are penalized -10 and rarely survive
- MTF TAPE CONFLUENCE: the 5m/15m/1h tape seat is the entry-timing voice — a setup whose timeframes conflict (agreement <2/3) is penalized and can never be STRONG; mention timeframe alignment when you see it
- SENTIMENT + FLOWS (V2 seats, when live): SentimentPulse (news/F&G/funding) and InstFlow (FII/DII + depth imbalance) vote in the committee — their contrarian extremes are context, and when they DISAGREE with a technical setup, say so honestly
- STOCK OPTION CHAINS: top F&O names carry real PCR/max-pain/OI reads — extreme PCR is contrarian, OI walls act as magnets
- MESH SHADOW SEATS (InstFlowPro/TechConsensus/FundaProPlus): context-only reads at weight 0 until edge-proven — never cite them as the deciding conviction
- RSI 52-68 sweet zone for longs, 32-48 for shorts; >78/<22 = exhaustion, do not chase
- Minimum 1:1.5 R:R for high-conviction trades (A grade floor)

RISK DISCIPLINE (NON-NEGOTIABLE — you never break these):
1. Max 1% capital risk per trade (per ₹1,00,000 → max ₹1,000 risk)
2. No fresh entries after 15:00 IST (and none in the 14:30-15:00 dead zone)
3. Strict square-off by 15:10 IST — NEVER carry intraday positions overnight
4. T1 hit → book 50%, move SL to breakeven
5. Minimum 1:1.5 R:R or skip the trade
6. Max 2-3 concurrent positions; same-sector concentration capped

HOW YOU WORK (agentic protocol):
- ALWAYS call tools for live data — NEVER guess or hallucinate prices, levels, or news
- For any stock-specific question → call analyze_setup (and search_market_news if a catalyst might explain the move)
- For "kya karu" / briefing questions → get_live_intraday_signals + get_market_regime first
- For "why" / deep-analysis / risk questions about a live signal → get_detailed_signal_analysis
- Before recommending size → calculate_position_size
- If your own track-record shows weak win-rate in a regime, say so honestly (call get_track_record when asked about performance)

RESPONSE STYLE (user is Indian retail trader, speaks Hinglish):
- Reply in natural Hinglish (Roman script) — technical terms English me
- Be DIRECT like a real desk trader — no disclaimers-stacking, no waffle
- Structure trade plans clearly: Direction / Grade / Entry zone / SL / T1 / T2 / Qty / R:R
- Give honest NO-TRADE calls when setups are weak — a pro's best trade is often skipping
- Keep answers tight and actionable; bullets > paragraphs
- End with the key risk note (one line)
- NEVER promise profits; always note intraday risk briefly`;
}

// ------------------------------------------------------------
// 2. FULL-TICKET ANSWER DISCIPLINE (shared rule block — the crypto
//    desk agent server/ai/cryptoAgent.js carries the identical text;
//    both files intentionally duplicate it so each agent stays a
//    self-contained drop-in with zero cross-desk imports).
// ------------------------------------------------------------
function fullTicketRules() {
  return `FULL-TICKET ANSWER DISCIPLINE (non-negotiable):
Jab bhi buy/sell recommend karo, HAMESHA yeh poora ticket do:
 - Symbol + Direction (LONG/SHORT)
 - Entry zone (exact price range)
 - Stop-loss (exact price + one-line WHY it's there — structure/ATR/volatility)
 - Target 1, Target 2 (with R-multiples)
 - Position size (qty or % of capital, from the risk% — call calculate_position_size first)
 - Confidence / AI Score + kitne models voted vs agreed (honesty: thin committee = say so, demand more conviction)
 - Time-window (setup kab tak valid / exit-by — intraday ke liye 15:10 IST square-off + dead-zone note)
Kabhi bhi bina in sab ke sirf "BUY kar do" mat bolo — an INCOMPLETE TICKET is always rejected: instead, missing piece clearly maango (e.g. "capital batao to exact qty dunga").`;
}

// ------------------------------------------------------------
// 2b. SHARED PLAIN LLM CALL — provider chain (Gemini → Groq →
//     Cerebras), no tools. Used by committee / briefing / journal
//     modules so every AI feature shares ONE fallback chain.
// ------------------------------------------------------------
export async function askLLM(systemPrompt, userPrompt, deps, opts = {}) {
  const { KEYS, OPENAI_COMPAT } = deps || {};
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 3000;
  const timeout = opts.timeout ?? 30000;
  // eslint-disable-next-line no-control-regex -- INTENTIONAL: strips control chars before they reach external LLM APIs
  const clean = (t) => String(t || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();

  // Gemini
  if (KEYS?.gemini) {
    for (const model of ['gemini-3.5-flash', 'gemini-2.5-flash']) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEYS.gemini}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
          }),
          signal: AbortSignal.timeout(timeout),
        });
        if (r.status === 404 || r.status === 400) continue;
        if (!r.ok) throw new Error(`gemini ${r.status}`);
        const j = await r.json();
        const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
        if (clean(text)) return { text: clean(text), engine: model };
      } catch (e) { /* try next */ }
    }
  }

  // OpenAI-compatible chain
  for (const provider of ['groq', 'cerebras']) {
    if (!KEYS?.[provider] || !OPENAI_COMPAT?.[provider]) continue;
    const cfg = OPENAI_COMPAT[provider];
    const models = provider === 'groq' ? [cfg.defModel, 'llama-3.3-70b-versatile'] : [cfg.defModel];
    for (const model of models) {
      try {
        const r = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS[provider]}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature, max_completion_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(timeout),
        });
        if ([400, 404, 422].includes(r.status)) continue;
        if (!r.ok) throw new Error(`${provider} ${r.status}`);
        const j = await r.json();
        const text = j?.choices?.[0]?.message?.content || '';
        if (clean(text)) return { text: clean(text), engine: `${provider}:${model}` };
      } catch (e) { /* try next */ }
    }
  }

  return null;
}

// ------------------------------------------------------------
// 3. TOOL EXECUTION — wired to the live intraday stack
// ------------------------------------------------------------
async function executeAgentTool(name, args, deps) {
  const {
    KEYS, getLastScan, triggerScan, fetchGrowwNseQuote,
    getTrackRecord, getPaperSummary, analyzeSymbol, getMarketRegime,
    getDeepSignal,
  } = deps;

  try {
    switch (name) {
      case 'get_live_intraday_signals': {
        // v10.3.1 STALE-WHILE-REVALIDATE: the first question of every
        // boot used to BLOCK on a full cold scan (universe fetch + AI
        // consensus = 30-90s+) and die at the 90s frontend gate. Now a
        // cached scan is served INSTANTLY with its age attached (the
        // system prompt already forces honest asOf language), while a
        // refresh runs in the background for the NEXT question. Only
        // a boot with zero scan history still blocks.
        let scan = getLastScan?.();
        const hasScan = !!(scan && Array.isArray(scan.signals) && scan.signals.length > 0);
        const ageMs = scan?.asOf ? Date.now() - new Date(scan.asOf).getTime() : Infinity;
        if (!hasScan) {
          scan = (await triggerScan?.()) || scan;
        } else if (ageMs > 3 * 60 * 1000) {
          Promise.resolve(triggerScan?.()).catch(() => {}); // background revalidate
        }
        if (!scan) return { error: 'Scanner data unavailable — market band ho sakta hai (09:15-15:30 IST Mon-Fri).' };
        return {
          marketOpen: scan.marketOpen,
          asOf: scan.asOf,
          regime: scan.marketRegime,
          aiConsensus: scan.aiConsensus,
          freshEntriesAllowed: scan.freshEntriesAllowed,
          signals: (scan.signals || []).map(s => ({
            symbol: s.symbol, direction: s.direction, confidence: s.confidence,
            grade: s.grade ?? 'B', tradeType: s.tradeType ?? null,
            ltp: s.ltp, changePct: s.changePct,
            entryZone: [s.entryZoneLow ?? s.entry, s.entryZoneHigh ?? s.entry],
            stopLoss: s.stopLoss, target1: s.target1, target2: s.target2,
            rr: s.rr, effRR: s.effRR, qtyPerLakh: s.qtyPerLakh,
            trendStrength: s.trendStrength, rsi: s.rsi, adx: s.adx,
            volumeRatio: s.volumeRatio, vwapDist: s.vwapDist,
            counterTrend: s.counterTrend, aiNote: s.aiNote,
            reasons: s.reasons,
          })),
        };
      }

      case 'get_model_consensus': {
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9&-]/g, '');
        if (!symbol) return { error: 'symbol required (e.g. RELIANCE)' };
        // PRIMARY: the 14-model deep ensemble (per-model votes).
        let d = null;
        try { d = await getDeepSignal?.(symbol); } catch { /* cold */ }
        if (d?.ok && d.signal) {
          const s = d.signal;
          const votes = Array.isArray(s.votes) ? s.votes : [];
          const bull = votes.filter(v => v.dir > 0);
          const bear = votes.filter(v => v.dir < 0);
          return {
            symbol, market: 'INDIA', source: 'superintelligence deep ensemble',
            consensus: {
              side: s.side, grade: s.grade, confidence: s.confidence,
              agreement: s.agreement, voters: s.voters ?? votes.filter(v => v.dir !== 0).length,
              totalSeats: s.totalModels ?? votes.length,
            },
            tally: { bull: bull.length, bear: bear.length, abstain: votes.length - bull.length - bear.length },
            perModel: votes.map(v => ({
              model: v.name || v.id, dir: v.dir > 0 ? 'BULL' : v.dir < 0 ? 'BEAR' : 'ABSTAIN',
              conf: v.conf, weight: v.weight,
              reason: Array.isArray(v.reasons) ? v.reasons[0] : (v.reason || null),
            })),
            metaEnsemble: s.meta ?? null,
            verifier: s.verify ? { finalCall: s.verify.finalCall, action: s.verify.action, score: s.verify.score } : null,
            llmSecondOpinion: s.verify?.llm ?? null,
          };
        }
        // FALLBACK: scanner cache (quant + AI verdicts, no per-model votes).
        const scan = getLastScan?.();
        const s2 = scan?.signals?.find(x => x.symbol === symbol);
        if (!s2) return { error: `No consensus data for ${symbol} — deep ensemble cold + scanner cache me nahi (market band?).` };
        return {
          symbol, market: 'INDIA', source: 'scanner fallback (deep ensemble unavailable)',
          consensus: { direction: s2.direction, grade: s2.grade ?? 'B', quantConfidence: s2.quantConfidence, aiConfidence: s2.aiConfidence },
          aiNote: s2.aiNote ?? null,
          geminiVerdict: s2.geminiVerdict ?? null,
          groqVerdict: s2.groqVerdict ?? null,
          reasons: s2.reasons || [],
          note: 'Per-model vote breakdown available sirf deep ensemble se — ye scanner summary hai.',
        };
      }

      case 'get_detailed_signal_analysis': {
        const symbol = String(args.symbol || '').trim().toUpperCase();
        if (!symbol) return { error: 'symbol required' };
        let scan = getLastScan?.();
        if (!scan || !scan.signals?.length) scan = (await triggerScan?.()) || scan;
        const s = scan?.signals?.find(x => x.symbol === symbol);
        if (!s) {
          return { error: `No live signal for ${symbol} — scanner cache me nahi hai (filtered out / market band).` };
        }
        return {
          symbol: s.symbol, direction: s.direction, grade: s.grade ?? 'B',
          confidence: s.confidence, quantConfidence: s.quantConfidence,
          aiConfidence: s.aiConfidence, aiModel: s.aiModel, aiNote: s.aiNote,
          tradeType: s.tradeType ?? null, entryQuality: s.entryQuality ?? null,
          aiReasoning: s.aiReasoning || 'AI reasoning unavailable for this signal.',
          riskFactors: s.riskFactors || [],
          geminiVerdict: s.geminiVerdict ?? null,
          groqVerdict: s.groqVerdict ?? null,
          entry: s.entry, stopLoss: s.stopLoss, target1: s.target1, target2: s.target2,
          aiAdjustedSL: s.aiAdjustedSL ?? null, aiAdjustedEntry: s.aiAdjustedEntry ?? null,
          rr: s.rr, effRR: s.effRR, adx: s.adx, rsi: s.rsi, volumeRatio: s.volumeRatio,
          counterTrend: !!s.counterTrend, reasons: s.reasons || [],
        };
      }

      case 'analyze_setup': {
        const symbol = String(args.symbol || '').trim().toUpperCase();
        if (!symbol) return { error: 'symbol required' };
        const r = await analyzeSymbol(symbol);
        if (!r) return { error: `No live data for ${symbol} — verify the NSE symbol.` };
        return {
          symbol: r.symbol, ltp: r.ltp, changePct: r.changePct, direction: r.direction,
          quantConfidence: r.quantConfidence, entry: r.entry, entryZone: [r.entryZoneLow, r.entryZoneHigh],
          stopLoss: r.stopLoss, target1: r.target1, target2: r.target2,
          trailingSL: r.trailingSL, rr: r.rr, effRR: r.effRR, qtyPerLakh: r.qtyPerLakh,
          trendStrength: r.trendStrength, rsi: r.rsi, adx: r.adx, vwap: r.vwap,
          vwapDist: r.vwapDist, volumeRatio: r.volumeRatio, gapPct: r.gapPct,
          orbMode: r.orbMode, counterTrend: r.counterTrend, reasons: r.reasons,
          freshEntriesAllowed: r.freshEntriesAllowed,
        };
      }

      case 'get_intraday_quote': {
        const symbol = String(args.symbol || '').trim().toUpperCase();
        if (!symbol) return { error: 'symbol required' };
        if (typeof fetchGrowwNseQuote !== 'function') return { error: 'quote feed unavailable' };
        const q = await fetchGrowwNseQuote(symbol);
        if (!q || !(q.price > 0)) return { error: `No live quote for ${symbol}.` };
        return { symbol, ltp: q.price, changePct: q.change, high: q.high, low: q.low, volume: q.volume };
      }

      case 'get_market_regime': {
        const regime = await getMarketRegime?.();
        if (!regime) return { error: 'regime data unavailable' };
        return regime;
      }

      case 'get_track_record': {
        const days = Math.max(1, Math.min(90, parseInt(args.days, 10) || 7));
        const tr = getTrackRecord?.(days);
        if (!tr) return { error: 'track record unavailable' };
        return {
          days: tr.days, totalTracked: tr.totalTracked, resolved: tr.resolved,
          wins: tr.wins, losses: tr.losses, winRate: tr.winRate, avgR: tr.avgR,
          disciplinedPnlPerLakh: tr.disciplinedPnlPerLakh,
          openCount: tr.openCount,
          recentHistory: (tr.history || []).slice(0, 10).map(h => ({
            symbol: h.symbol, direction: h.direction, dayKey: h.dayKey,
            status: h.status, confidence: h.confidence, rMultiple: h.rMultiple, pnl: h.pnl,
          })),
        };
      }

      case 'get_paper_positions': {
        const ps = getPaperSummary?.();
        if (!ps) return { error: 'paper trading unavailable' };
        return {
          stats: ps.stats,
          open: (ps.open || []).map(p => ({
            symbol: p.symbol, direction: p.direction, entry: p.entry, qty: p.remainingQty,
            stopLoss: p.stopLoss, target1: p.target1, lastPrice: p.lastPrice,
            unrealizedPnl: p.unrealizedPnl, t1Hit: p.t1Hit,
          })),
          closedToday: (ps.closedToday || []).map(p => ({
            symbol: p.symbol, direction: p.direction, realizedPnl: p.realizedPnl,
            closeReason: p.closeReason,
          })),
        };
      }

      case 'search_market_news': {
        const query = String(args.query || '').trim();
        if (!query) return { error: 'query required' };
        const tavilyKey = KEYS?.tavily;
        if (!tavilyKey) return { error: 'News search not configured (no Tavily key on server).' };
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: `${query} India stock market latest`,
            search_depth: 'basic', include_answer: true, max_results: 4, topic: 'finance',
          }),
          signal: AbortSignal.timeout(9000),
        });
        if (!res.ok) return { error: `news search failed (${res.status})` };
        const d = await res.json();
        return {
          query,
          aiSummary: d.answer || 'No summary',
          results: (d.results || []).slice(0, 3).map(r => ({
            title: r.title, content: (r.content || '').substring(0, 200), url: r.url,
          })),
        };
      }

      case 'calculate_position_size': {
        const entry = parseFloat(args.entry);
        const stopLoss = parseFloat(args.stopLoss);
        if (!(entry > 0) || !(stopLoss > 0) || entry === stopLoss) {
          return { error: 'valid entry and stopLoss required' };
        }
        const capital = parseFloat(args.capital) > 0 ? parseFloat(args.capital) : 100000;
        const riskPercent = parseFloat(args.riskPercent) > 0 && parseFloat(args.riskPercent) <= 5
          ? parseFloat(args.riskPercent) : 1;
        const riskPerShare = Math.abs(entry - stopLoss);
        const riskAmount = (capital * riskPercent) / 100;
        const riskOnlyQty = Math.floor(riskAmount / riskPerShare);
        // v20.9.1 [H3]: 25% capital-deployment cap ab ENFORCED hai — pehle
        // sirf `note` me likha tha (tight stop pe recommendedQty = 100%
        // capital tak ja sakta tha, jabki scanner ka apna qtyPerLakh
        // hard-cap karta hai — do sizing sources disagree karte the).
        const capQty = Math.floor((capital * 0.25) / entry);
        const qty = Math.max(0, Math.min(riskOnlyQty, capQty));
        const capitalDeployed = +(qty * entry).toFixed(0);
        const t1 = +(entry + 1.6 * riskPerShare * (stopLoss < entry ? 1 : -1)).toFixed(2);
        const t2 = +(entry + 2.6 * riskPerShare * (stopLoss < entry ? 1 : -1)).toFixed(2);
        return {
          entry, stopLoss, capital, riskPercent,
          riskPerShare: +riskPerShare.toFixed(2),
          riskAmount: +riskAmount.toFixed(0),
          recommendedQty: qty,
          ...(riskOnlyQty > capQty ? { riskOnlyQty, cappedBy: '25% capital-deployment rule' } : {}),
          capitalDeployed,
          capitalUsedPct: +((capitalDeployed / capital) * 100).toFixed(1),
          target1_1_6R: t1, target2_2_6R: t2,
          note: riskOnlyQty > capQty
            ? `Risk-based qty ${riskOnlyQty} would deploy >25% of capital — capped to ${capQty} (25% capital-deployment rule).`
            : 'Within 25% capital-deployment cap.',
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: `Tool ${name} failed: ${err?.message || err}` };
  }
}

// ------------------------------------------------------------
// 4. AGENTIC LOOP — provider chain with fallback
// ------------------------------------------------------------
async function runGeminiAgent({ systemPrompt, messages, deps, toolTrace }) {
  const { KEYS } = deps;
  if (!KEYS?.gemini) return null;

  // Model chain matches aiVerifySignals + /api/chat/mcp convention.
  const models = ['gemini-3.5-flash', 'gemini-2.5-flash'];
  let lastErr = null;
  for (const model of models) {
    try {
      return await _runGeminiLoop(model, { systemPrompt, messages, deps, toolTrace });
    } catch (e) {
      lastErr = e;
      // 404/400 → model unavailable, try next; other errors bubble per-provider.
      if (!/\b(404|400)\b/.test(String(e?.message))) break;
    }
  }
  throw lastErr || new Error('gemini failed');
}

async function _runGeminiLoop(model, { systemPrompt, messages, deps, toolTrace }) {
  const { KEYS } = deps;
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));

  const payload = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: geminiTools(),
    generationConfig: { temperature: 0.4, maxOutputTokens: 4000 },
  };

  let data = null;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEYS.gemini}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PER_ROUND_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    data = await res.json();

    // Collect ALL function calls in this turn.
    const parts = data.candidates?.[0]?.content?.parts || [];
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    if (fnCalls.length === 0) break;

    contents.push({ role: 'model', parts: parts.map(p => p.functionCall ? { functionCall: p.functionCall } : { text: p.text }).filter(p => p.functionCall || p.text) });
    // v10.3.1: parallel + timeout-bounded tool execution (the old
    // sequential unbounded loop is what froze Ask-AI on cold scans).
    const responseParts = await Promise.all(fnCalls.map(async fn => {
      toolTrace.push({ tool: fn.name, ts: Date.now() });
      const result = await withToolTimeout(withMcpAudit('intraday', fn.name, fn.args || {}, () => executeAgentTool(fn.name, fn.args || {}, deps)), fn.name);
      return { functionResponse: { name: fn.name, response: { result } } };
    }));
    contents.push({ role: 'user', parts: responseParts });
    payload.contents = contents.map(c => ({ ...c, parts: [...c.parts] }));
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text).filter(Boolean).join('\n').trim();
  if (!text) throw new Error('gemini empty response');
  return { text, engine: model };
}

async function runOpenAICompatAgent({ systemPrompt, messages, deps, toolTrace, provider, cfgOverride = null }) {
  const { KEYS, OPENAI_COMPAT } = deps;
  // v18.7: cfgOverride lets the keyless LOCAL ollama engine ride the
  // exact same loop (auth header is inert for ollama).
  const cfg = cfgOverride || OPENAI_COMPAT?.[provider];
  if (!cfg || !KEYS?.[provider]) return null;

  const modelChain = provider === 'groq'
    ? [cfg.defModel, 'llama-3.3-70b-versatile']
    : [cfg.defModel];
  let lastErr = null;
  for (const model of modelChain) {
    try {
      return await _runOpenAICompatLoop(model, cfg, { systemPrompt, messages, deps, toolTrace, provider });
    } catch (e) {
      lastErr = e;
      if (!/\b(404|400|422)\b/.test(String(e?.message))) break;
    }
  }
  throw lastErr || new Error(`${provider} failed`);
}

async function _runOpenAICompatLoop(model, cfg, { systemPrompt, messages, deps, toolTrace, provider }) {
  const { KEYS } = deps;
  if (!KEYS?.[provider]) return null;
  const reqMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    })),
  ];

  let data = null;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const body = {
      model,
      messages: reqMessages,
      temperature: 0.4,
      max_completion_tokens: 4000,
    };
    if (round === 0) body.tools = PRO_TRADER_AGENT_TOOLS;

    // v18.8: provider-aware round budget — local ollama (CPU) gets the
    // long budget; cloud engines keep the tight 30s.
    const roundTimeout = provider === 'ollama' ? OLLAMA_ROUND_TIMEOUT_MS : PER_ROUND_TIMEOUT_MS;
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS[provider]}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(roundTimeout),
    });
    if (!res.ok) throw new Error(`${provider} ${res.status}`);
    data = await res.json();

    const choice = data.choices?.[0];
    const toolCalls = choice?.message?.tool_calls || [];
    if (toolCalls.length === 0) break;

    reqMessages.push(choice.message);
    // v10.3.1: parallel + timeout-bounded tool execution (same fix as
    // the Gemini loop — sequential unbounded awaits froze Ask-AI).
    const toolMsgs = await Promise.all(toolCalls.map(async tc => {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep {} */ }
      toolTrace.push({ tool: tc.function?.name, ts: Date.now() });
      const result = await withToolTimeout(withMcpAudit('intraday', tc.function?.name, args, () => executeAgentTool(tc.function?.name, args, deps)), tc.function?.name);
      return {
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function?.name,
        content: JSON.stringify(result),
      };
    }));
    reqMessages.push(...toolMsgs);
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${provider} empty response`);
  return { text, engine: `${provider}:${model}` };
}

// ------------------------------------------------------------
// 5. PUBLIC ENTRY — runProTraderAgent(messages, deps)
//    Now SELF-CALIBRATING: live track-record stats are fetched and
//    injected into the system prompt so the agent trades with the
//    discipline its own scorecard demands.
// ------------------------------------------------------------
export async function runProTraderAgent(messages, deps) {
  const { hour, minute, weekday } = getISTParts();
  const ctx = {
    istTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`,
    weekday,
    phase: marketPhase(),
    marketOpen: isNseMarketOpen(),
  };
  // SELF-CALIBRATION — last 7 days of accountability stats.
  let perf = null;
  try {
    const tr = deps?.getTrackRecord?.(7);
    if (tr && tr.totalTracked > 0) {
      perf = {
        days: tr.days, totalTracked: tr.totalTracked, resolved: tr.resolved,
        winRate: tr.winRate, avgR: tr.avgR,
        disciplinedPnlPerLakh: tr.disciplinedPnlPerLakh,
      };
    }
  } catch { /* calibration optional */ }

  // v10.8 PRO #3: persistent chat memory — recent turns + recurring
  // focus feed the system prompt (null on fresh install = zero bloat).
  const memBlock = memoryContextFor('protrade');
  const systemPrompt = buildProTraderSystemPrompt(ctx, perf) + (memBlock ? `\n\nDESK MEMORY — past conversations with this user:\n${memBlock}` : '');
  const toolTrace = [];

  // v18.7 ENGINE SENTINEL CHAIN — EXTENDED (openrouter / huggingface /
  // nvidia after cerebras), HEALTH-AWARE (cooldown providers skipped
  // fast; expiry auto-retries — half-open), and LOCAL (keyless ollama
  // joins last). Same pattern as the crypto desk agent.
  const cloudProviders = ['groq', 'cerebras', 'openrouter', 'huggingface', 'nvidia'];
  const steps = [];
  if (deps?.KEYS?.gemini) steps.push({ provider: 'gemini', run: () => runGeminiAgent({ systemPrompt, messages, deps, toolTrace }) });
  for (const p of cloudProviders) {
    if (deps?.KEYS?.[p] && deps?.OPENAI_COMPAT?.[p]) steps.push({ provider: p, run: () => runOpenAICompatAgent({ systemPrompt, messages, deps, toolTrace, provider: p }) });
  }
  if (await ollamaProbe().catch(() => false)) {
    steps.push({
      provider: 'ollama',
      run: () => runOpenAICompatAgent({ systemPrompt, messages, deps: { ...deps, KEYS: { ...deps?.KEYS, ollama: 'local' } }, toolTrace, provider: 'ollama', cfgOverride: ollamaCompatCfg() }),
    });
  }
  const chain = steps.filter(s => !engineSkip(s.provider));

  const errors = [];
  for (const step of chain) {
    try {
      const result = await step.run();
      if (result) {
        engineOk(step.provider);
        // v10.8 PRO #3: record the answered turn for next-session
        // continuity (best-effort, never blocks the reply).
        const lastUser = [...(messages || [])].reverse().find(m => m?.role === 'user')?.content || '';
        rememberChat('protrade', { q: lastUser, a: result.text });
        return {
          ok: true,
          text: result.text,
          engine: result.engine,
          toolsUsed: [...new Set(toolTrace.map(t => t.tool))],
          toolCalls: toolTrace.length,
          session: ctx,
          calibration: perf,
        };
      }
      engineTrack(step.provider, new Error('empty response'));
      errors.push(`${step.provider} empty response`);
    } catch (e) {
      engineTrack(step.provider, e);
      errors.push(`${e?.message || e}`);
    }
  }

  // v10.10 SUPER-INTEL DETERMINISTIC FALLBACK — all LLM engines down,
  // but analyze_setup / scanner / sizing need NO LLM. The India tab
  // gets the exact-number FULL TICKET instead of "engines unavailable"
  // — the fix behind the "[object Object]" report on this tab.
  const det = await buildDeterministicIntradayAnswer(
    messages, deps, executeAgentTool, toolTrace,
  ).catch(() => null);
  if (det?.text) {
    const lastUser = [...(messages || [])].reverse().find(m => m?.role === 'user')?.content || '';
    rememberChat('protrade', { q: lastUser, a: det.text });
    // v18.7: WHY offline + what fixes it (per-engine honest status).
    const engineNote = `\n\n🔌 ENGINE STATUS — ${engineStatusLine(deps?.KEYS)}`;
    return {
      ok: true,
      text: det.text + engineNote,
      engine: 'super-intel-deterministic',
      toolsUsed: [...new Set(toolTrace.map(t => t.tool))],
      toolCalls: toolTrace.length,
      session: ctx,
      calibration: perf,
      degraded: true,
    };
  }

  return {
    ok: false,
    error: `Agent engines unavailable: ${errors.join(' | ') || 'no AI keys configured'} — deterministic desk answers abhi bhi available hain: kisi NSE symbol ka analysis (e.g. "RELIANCE ka analysis") ya "top setups" poocho.`,
    toolsUsed: [...new Set(toolTrace.map(t => t.tool))],
    session: ctx,
  };
}

// For tests / route registration helper
export const __internals = { executeAgentTool, buildProTraderSystemPrompt, withToolTimeout, TOOL_TIMEOUT_MS };
