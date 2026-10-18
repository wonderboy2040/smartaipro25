// ============================================================
// server/ai/cryptoAgent.js — CRYPTO DESK MCP AGENT (v1)
// ------------------------------------------------------------
// The CoinDCX tab's conversational AI — the exact pattern of the
// proven intraday ProTraderAgent, mirrored for the crypto desk:
//   • 8 crypto-specialized MCP tools (live signals, deep coin
//     scan, wallet, positions, regime, track-record, sizing,
//     agent status) — ALL wiring to existing compute, zero new
//     data-fetch logic
//   • ReAct loop — up to 6 tool rounds
//   • Multi-provider fallback: Gemini → Groq → Cerebras
//   • FULL-TICKET answer discipline (Part 2): every buy/sell
//     recommendation must carry symbol/direction/entry zone/SL/
//     T1/T2/size/confidence+voters/time-window — an incomplete
//     ticket is REJECTED, the missing piece is asked for.
//
// Registered by routes.js as POST /api/crypto-agent.
// ============================================================
import { getSignals, getDeepSignal, buildRegime } from './signals.js';
import { walletSnapshot, fetchUsdInr } from './futures.js';
import { getPositionsWithPnl, loadConfig as _loadConfig, getRiskState, loadJournal, todayIST } from './coindcxOrders.js';
import { trustReport, governance } from './trust.js';
import { maxSaneLeverage } from './ensemble.js';
import { loadAgentConfig, agentStatus } from './agent.js';
import { coindcxConnected } from '../mcp/coindcx.js';
import { sentimentStatus } from './sentiment.js';
// v10.8 PRO #3: persistent chat memory — the desk remembers past turns
import { rememberChat, memoryContextFor } from './agentMemory.js';
// v10.10 SUPER-INTEL FALLBACK — engine-down ≠ data-down: deterministic
// full-ticket answers from the same tools the LLM loop would call.
import { buildDeterministicCryptoAnswer } from './superIntelFallback.js';
// v12.0 PRO TRADER UPGRADE — perp positioning intelligence engine
// (funding/OI/top-trader L-S/taker flow) for the two new pro tools.
import { getPerpIntel, perpIntelWire, perpIntelEnabled } from './perpIntel.js';
// v13.1 SIGNAL VERIFICATION AGENT — the pro-trader final-verdict layer
import { verifySignal } from './signalVerifier.js';
// v13.2 A5: MCP governance — every tool call is rate-limited + audit-logged
import { withMcpAudit } from './mcpAudit.js';
// v18.7 ENGINE SENTINEL — health-aware provider chain: cooldown
// fast-fail, auto half-open recovery, honest status line, and the
// keyless LOCAL ollama engine when installed.
import { engineSkip, engineTrack, engineOk, engineStatusLine, ollamaProbe, ollamaCompatCfg } from './llmSentinel.js';

const MAX_TOOL_ROUNDS = 6;
const PER_ROUND_TIMEOUT_MS = 30000;
// v18.8: the local ollama engine gets a CPU-realistic per-round budget.
const OLLAMA_ROUND_TIMEOUT_MS = 120000;
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ------------------------------------------------------------
// 1. TOOL DEFINITIONS (OpenAI function-calling format)
// ------------------------------------------------------------
export const CRYPTO_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_live_crypto_signals',
      description: 'Live top high-conviction CoinDCX spot + futures + global equity SIM setups from the 14-model superintelligence ensemble (superIntel AI Score ranking). Each setup carries side, confidence, AI score, entry/SL/T1/T2, R:R, leverage view and model votes. Use this FIRST for desk briefings, "kya buy karu", or market overview questions.',
      parameters: {
        type: 'object',
        properties: {
          market: { type: 'string', description: 'Which desk: "SPOT" (CoinDCX INR spot), "FUTURES" (USDT perpetuals) or "GLOBAL" (Apple/Google/NVIDIA/Tesla/SPACEX equity SIM desk). Default returns all three.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_global_stock',
      description: 'Deep single-stock ensemble scan on the GLOBAL equity SIM desk (AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META, SPACEX-sim): all model votes, consensus side + confidence + agreement, complete trade plan (entry, ATR-based SL, T1/T2, R:R), superIntel AI score. Execution on this desk is PAPER/NOTIFY only (CoinDCX par ye equities listed nahi). Use when the user asks about a specific global company — "Apple kaisa lag raha hai", "NVDA pe view".',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker: AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META, SPACEX' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_coin',
      description: 'Deep single-coin ensemble scan: all model votes (trend/momentum/volume/SMC/tape/AI Council...), consensus side + confidence + agreement, complete trade plan (entry, ATR-based SL, T1/T2, R:R), superIntel AI score, quality flags and the staged-exit blueprint. Use when the user asks about a SPECIFIC coin.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Coin base symbol, e.g. BTC, SOL, ETH' },
          market: { type: 'string', description: '"SPOT" or "FUTURES" (default SPOT)' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_wallet',
      description: 'Live CoinDCX wallet snapshot: spot INR + futures USDT balances, deployable margin, equity in INR, USDINR rate used. Use when the user asks about capital, margin or "kitna paisa hai".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_open_positions',
      description: 'Open spot + futures positions with entry, qty, leverage, live P&L (INR + USDT), SL/TP state, age and exit stage. Use for position reviews and risk checks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market_regime',
      description: 'Crypto market regime: BTC 24h change + trend read, risk-on/off label, plus the Fear&Greed index and perp funding bias from the sentiment desk. Use before recommending counter-regime trades.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_track_record',
      description: 'Engine accountability from the tamper-evident ledger: calibration buckets (claimed confidence vs actual win-rate), Brier score, monthly trend, per-model governance verdicts. Use when the user asks "engine kitna accurate hai" or performance review.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_position_size',
      description: 'Position-sizing calculator for crypto: entry + stop-loss + capital + risk% → exact qty, capital deployed, risk amount, R-multiple targets AND the max SANE leverage for that stop distance (liquidation stays outside the SL). ALWAYS use before recommending a size or leverage.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'number', description: 'Entry price' },
          stopLoss: { type: 'number', description: 'Stop-loss price' },
          capital: { type: 'number', description: 'Capital to deploy (INR for spot / USDT for futures, default 1000)' },
          riskPercent: { type: 'number', description: 'Risk per trade as % of capital (default 1.5, max 5)' },
        },
        required: ['entry', 'stopLoss'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agent_status',
      description: 'The auto-trade agent state: enabled, mode (paper/notify/live), today\u2019s trades count, rolling win-rate, open agent positions with their dynamic time-exit windows, and current blockers (why it is/isn\u2019t entering). Use for "agent kya kar raha hai" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_funding_rate',
      description: 'Per-symbol perpetual funding rate (8h, Binance fapi public — the honest cross-exchange reference since CoinDCX does not publish a public funding endpoint). Positive = longs pay shorts (crowded longs), negative = shorts pay longs (squeeze fuel). Use before ANY perp hold > 1 day — funding is a real carrying cost.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Coin base symbol, e.g. BTC, SOL, ETH' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_perp_intel',
      description: 'v12.0 PERP POSITIONING INTELLIGENCE for one symbol: funding + open-interest 24h change (new longs vs new shorts vs squeeze vs unwind — the classic OI×price 2×2), top-trader long/short ratio, taker buy/sell aggression, and the derived positioning read (BULLISH/BEARISH/NEUTRAL + crowding flags). Binance fapi public reference. Use BEFORE any futures entry — positioning against you = fuel missing.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Coin base symbol, e.g. BTC, SOL, DOGE' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_win_probability',
      description: 'v12.0 WIN-PROBABILITY engine answer for one symbol: the calibrated P(win) (ledger outcomes + AI score + funding/positioning + MTF), the R:R breakeven P(need), EDGE points, expected value in R-multiples, and the verdict (EDGE / FAIR / NO-EDGE). Use it when the user asks "kitni probability hai", "pakka hai?", "should I take this trade" — and ALWAYS cite P(win) + EV in any full ticket.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Coin base symbol, e.g. BTC, SOL, ETH' },
          market: { type: 'string', description: '"SPOT" (default) or "FUTURES"' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_risk_status',
      description: 'Risk governance state: kill-switch, daily trade cap usage, daily loss cap usage, open position count vs max, and the exact blockers list (why execution is disabled). Use before recommending new entries when the user has had a losing day.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pnl',
      description: 'P&L summary: realized (booked CLOSE/PARTIAL_TP legs from the trade journal) over a period (today | 7d | 30d | all) PLUS live unrealized across open positions (INR + USDT). Use for "kitna profit/loss ho raha hai" questions.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', description: '"today" (default), "7d", "30d" or "all"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'backtest_custom_strategy',
      description: 'STRATEGY LAB (v10.8): describe a strategy idea in plain English (e.g. "buy when RSI crosses above 30 and volume is 2x average, exit at 2R or 48 bars") — an LLM compiles it into a bounded rule set, which is validated against a strict whitelist and replayed walk-forward on historical candles (crypto 1h / India daily). Returns the exact rules that ran + win-rate, avg R, profit factor, max DD, exit reasons. Use when the user asks to test a strategy idea or says "backtest this".',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The strategy idea in natural language (entry conditions, exit conditions, stop/target style, max hold)' },
          market: { type: 'string', description: '"SPOT"/"FUTURES" → CRYPTO universe, "INDIA" → NSE daily candles. Default CRYPTO.' },
          symbols: { type: 'array', items: { type: 'string' }, description: 'Optional 1-6 symbols (e.g. ["BTC","SOL"]). Defaults to the desk universe.' },
        },
        required: ['description'],
      },
    },
  },
  // accuracy-plan Phase 3.3: TOOL PARITY with the intraday Pro Trader
  // agent — the crypto desk gets the SAME live news search (Tavily)
  // the India desk has: "why is BTC moving" / regulation catalysts /
  // altcoin news all ground the answer in real headlines instead of
  // guesses.
  {
    type: 'function',
    function: {
      name: 'search_market_news',
      description: 'Live financial news search (Tavily). Use for crypto market catalysts, regulation news, coin-specific headlines ("why is X pumping"), macro/Fed/ETF flows, or any "why is this moving" question.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, e.g. "Bitcoin ETF flows today" or "SOL network upgrade news"' },
        },
        required: ['query'],
      },
    },
  },
  // v13.1 — THE SECOND-OPINION AGENT: the user asks "XRP long ya
  // short?" and this tool returns the SVA-v1 pro-trader verdict —
  // the 10-point checklist + FINAL call with score. The LLM then
  // frames the answer around this verdict (it may NOT override the
  // finalCall without stating the verifier's verdict too).
  {
    type: 'function',
    function: {
      name: 'verify_signal',
      description: 'SIGNAL VERIFICATION AGENT (SVA-v1) + ULTRAFAST CHART AGENT (UCV-A1) — the senior pro-trader second opinion AND the realtime ultrafast chart direction check. SVA runs a 10-point weighted checklist (committee quorum, chase/ATR-extension, RSI extremes, MTF confluence, ledger win-edge P(win)-P(need), plan R:R, regime alignment, entry band, perp crowd/funding, side stability) and returns the FINAL call: CONFIRM LONG/SHORT (full risk), CAUTION (half risk), FLIP to the OPPOSITE side (top-chase/overbought trap), or STAND_ASIDE (no trade). UCV-A1 reads the REALTIME ultrafast 1m chart (fast EMA stack, HH/HL structure, volume pressure, wicks, RSI(7), 5m confirm, live tick velocity, acceleration) and answers "ye LONG pakka long jayega? ye SHORT pakka short jayega?" — CONFIRMED (tape with the signal) / PENDING (neutral) / REJECTED (tape AGAINST — the signal can go the OPPOSITE way, avoid). Use for EVERY "long ya short?" / "should I take this?" / "ye signal sahi hai?" / "pakka long jayega?" question — and ALWAYS cite BOTH verdicts + scores in the answer.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Coin symbol, e.g. XRP, BTC, SOL, DOGE' },
          market: { type: 'string', description: '"SPOT" (CoinDCX INR spot) or "FUTURES" (USDT perp) — default FUTURES' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_model_consensus',
      description: 'PER-MODEL VOTE BREAKDOWN for one symbol — the "why did this signal fire" answer. Lists every ensemble model\'s individual vote (TrendMatrix, MomentumQuant, VolatilityScope, VolumeFlow, PatternNeural, SRMatrix, OptionsFlow, MacroRegime, SmartMoneyICT, IntradayTape/MTF, AI Council + V2 seats) with direction, confidence and reason, the weighted consensus side/confidence/agreement, the meta-ensemble ML stamp when active, and the SVA + LLM verifier verdicts. Use for "consensus kya bol raha hai", "kaun se models agree kar rahe hain", "signal ka reason kya hai" — a lighter, vote-focused read than analyze_coin.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Coin symbol, e.g. XRP, BTC, SOL' },
          market: { type: 'string', description: '"SPOT" (CoinDCX INR spot) or "FUTURES" (USDT perp) — default FUTURES' },
        },
        required: ['symbol'],
      },
    },
  },
];

function geminiTools() {
  return [{
    functionDeclarations: CRYPTO_AGENT_TOOLS.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}

// ------------------------------------------------------------
// 2. SYSTEM PROMPT — CoinDCX desk persona + FULL-TICKET format
// ------------------------------------------------------------
export function buildCryptoSystemPrompt(ctx) {
  const { utcTime, btcRegime, fng, funding, connected, aiOnline } = ctx;
  return `You are "CRYPTO DESK PRO" — an elite crypto trading desk head (15+ years, CoinDCX India + global perps) running the superintelligence ensemble: 14 core models (trend/momentum/volatility/volume/pattern/SR/options/regime/SMC/MTF-tape/AI-Council) + the V2 accuracy seats when enabled (SentimentPulse news+Fear&Greed+funding sentiment, InstFlow orderbook depth imbalance, FundaCheck valuation) + mesh-backed seats in SHADOW mode (InstFlowPro, TechConsensus, FundaProPlus, CryptoOnChainPro — journaled votes at weight 0 until settled outcomes prove their edge; treat their reads as CONTEXT, not conviction). The AI Council (LLM) verification layer sits on top.

CURRENT DESK CONTEXT (auto-injected, always trust this over assumptions):
- UTC time: ${utcTime} (crypto trades 24/7 — no market-closed excuses)
- BTC regime: ${btcRegime} | Sentiment: ${fng} | Perp funding: ${funding}
- CoinDCX API: ${connected ? 'CONNECTED (live wallet/positions available)' : 'NOT CONNECTED (paper-context only — say so if asked to trade)'} | AI Council: ${aiOnline ? 'online' : 'offline'}

HOW YOU WORK (agentic protocol):
- ALWAYS call tools for live data — NEVER guess or hallucinate prices, levels or P&L
- Briefings / "kya buy karu" → get_live_crypto_signals + get_market_regime first
- Specific coin → analyze_coin (add get_market_regime if counter-trend)
- Global stock (Apple/NVIDIA/Tesla/SpaceX…) → analyze_global_stock — ye SIM desk hai: signals REAL Yahoo data par, execution PAPER/NOTIFY only
- Before ANY size or leverage recommendation → calculate_position_size (it returns the max SANE leverage)
- Perp hold > 1 day → get_funding_rate (funding is a real carrying cost)
- ANY futures entry → get_perp_intel first (positioning check: OI build direction, taker aggression, crowding) — positioning AGAINST the signal = fuel missing, size down or skip
- "kitni probability hai / pakka hai / should I take this" → get_win_probability (P(win) vs breakeven + EV in R) — cite BOTH numbers in the answer
- "why is X moving" / regulation / ETF flows / catalyst news → search_market_news (real headlines, never guesses)
- "X long ya short?" / "ye signal pakka hai?" / "le lu isko?" → verify_signal FIRST — the SVA pro-trader verdict (final call + score + checklist) is the desk's official answer; frame the reply around it, never override it silently
- Risk / "kitna bura gaya" / losing day → get_risk_status (kill-switch + caps + blockers)
- P&L questions → get_pnl (period: today/7d/30d/all)
- Track-record / accuracy questions → get_track_record
- "Agent kya kar raha hai" → get_agent_status
- Strategy idea / "backtest this" → backtest_custom_strategy (describe the idea in plain English — the lab compiles + replays it honestly)

${fullTicketRules()}

RISK DISCIPLINE (NON-NEGOTIABLE):
1. Max 1-2% capital risk per trade (stop-distance based, never "feel" based)
2. Leverage only up to calculate_position_size's max-sane number — above it, liquidation sits INSIDE the stop and the plan is fiction
3. Funding-fighting continuation calls get penalized — a crowded-long perp chart is not a long signal
4. Never recommend an entry |r|>0.7-correlated with the user's OPEN positions (same bet twice) — check get_open_positions
5. Stablecoin/inactive coins: honest NO-TRADE call, no setups manufactured

RESPONSE STYLE (user is an Indian crypto trader, speaks Hinglish):
- Natural Hinglish (Roman script), technical terms in English
- DIRECT desk-trader tone — no disclaimer-stacking, no waffle
- Bullets > paragraphs; every level an exact number, never "around"
- Honest NO-TRADE calls when conviction is thin — the best trade is often skipping
- End with the one-line key risk note`;
}

/** Part 2 — the strict FULL-TICKET format, shared by both desk agents. */
function fullTicketRules() {
  return `FULL-TICKET ANSWER DISCIPLINE (non-negotiable):
Jab bhi buy/sell recommend karo, HAMESHA yeh poora ticket do:
 - Symbol + Direction (LONG/SHORT)
 - Entry zone (exact price range)
 - Stop-loss (exact price + one-line WHY it's there — structure/ATR/volatility)
 - Target 1, Target 2 (with R-multiples)
 - Position size (qty or % of capital, from the risk% — call calculate_position_size first)
 - Confidence / AI Score + kitne models voted vs agreed (honesty: thin committee = say so, demand more conviction)
 - P(win) vs breakeven (P(need)) + EV in R (get_win_probability / the signal's winProb) — a NO-EDGE verdict means the honest call is SKIP
 - Time-window (setup kab tak valid / exit-by — futures ke liye funding + max-hold dono bolo)
Kabhi bhi bina in sab ke sirf "BUY kar do" mat bolo — an INCOMPLETE TICKET is always rejected: instead, missing piece clearly maango (e.g. "capital batao to exact qty dunga"). Spot vs FUTURES hamesha label karo — INR spot prices and USDT perp prices are different books.`;
}

// ------------------------------------------------------------
// 3. TOOL EXECUTION — wired to the live crypto stack
// ------------------------------------------------------------
async function executeCryptoTool(name, args, deps) {
  const { KEYS } = deps || {};
  try {
    switch (name) {
      case 'get_live_crypto_signals': {
        const want = String(args.market || '').toUpperCase();
        const markets = want === 'SPOT' ? ['CRYPTO'] : want === 'FUTURES' ? ['FUTURES'] : want === 'GLOBAL' ? ['GLOBALFUTURES'] : ['CRYPTO', 'FUTURES', 'GLOBALFUTURES'];
        const out = {};
        for (const m of markets) {
          const b = await getSignals(m, deps, { limit: 8 }).catch(() => null);
          const label = m === 'CRYPTO' ? 'SPOT' : m === 'FUTURES' ? 'FUTURES' : 'GLOBAL';
          if (!b?.ok) { out[label] = { error: 'board unavailable (feeds unreachable — retry in a minute)' }; continue; }
          out[label] = (b.signals || []).slice(0, 5).map(s => ({
            symbol: s.symbol, side: s.side, grade: s.grade, confidence: s.confidence,
            aiScore: s.superIntel?.aiScore ?? null, ltp: s.ltp, changePct: s.changePct,
            winProb: s.superIntel?.winProb ? {
              pWin: s.superIntel.winProb.pWin, pNeed: s.superIntel.winProb.pNeed,
              edgePts: s.superIntel.winProb.edgePts, evRealisticR: s.superIntel.winProb.evRealisticR,
              verdict: s.superIntel.winProb.verdict,
            } : null,
            voters: s.voters ?? s.participating ?? null, totalModels: s.totalModels ?? null,
            agreement: s.agreement, plan: s.plan ? {
              entry: s.plan.entry, stopLoss: s.plan.stopLoss,
              target1: s.plan.target1, target2: s.plan.target2, riskPct: s.plan.riskPct, rewardRisk: s.plan.rewardRisk,
            } : null,
            aiNote: s.aiNote?.note ?? null,
          }));
        }
        return out;
      }

      case 'analyze_global_stock': {
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) return { error: 'symbol required (AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META, SPACEX)' };
        const d = await getDeepSignal(symbol, 'GLOBALFUTURES', deps, {}).catch(() => null);
        if (!d?.ok) return { error: `No data for ${symbol} — check the ticker (AAPL/MSFT/GOOGL/AMZN/NVDA/TSLA/META/SPACEX) or the Yahoo feed is down.` };
        const s = d.signal || d;
        return {
          symbol, market: 'GLOBALFUTURES (SIM desk — signals real, execution paper/notify only)',
          side: s.side, grade: s.grade, confidence: s.confidence, agreement: s.agreement,
          voters: s.voters ?? s.participating ?? null, totalModels: s.totalModels ?? null,
          ltp: s.ltp, changePct: s.changePct,
          aiScore: s.superIntel?.aiScore ?? null, tier: s.superIntel?.tier ?? null,
          drivers: s.superIntel?.drivers ?? null,
          plan: s.plan ? {
            entry: s.plan.entry, stopLoss: s.plan.stopLoss, target1: s.plan.target1, target2: s.plan.target2,
            riskPct: s.plan.riskPct, rewardRisk: s.plan.rewardRisk, planStyle: s.plan.planStyle,
          } : null,
          votes: (s.votes || []).map(v => ({ model: v.name, dir: v.dir > 0 ? 'BULL' : v.dir < 0 ? 'BEAR' : 'NEUTRAL', conf: v.conf, why: (v.reasons || []).slice(0, 2) })),
          note: 'Prices are USD (Yahoo). Trading on this desk = PAPER/NOTIFY only — CoinDCX par equity contracts listed nahi hain.',
        };
      }

      case 'analyze_coin': {
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) return { error: 'symbol required (e.g. BTC, SOL)' };
        const market = String(args.market || '').toUpperCase() === 'FUTURES' ? 'FUTURES' : 'CRYPTO';
        const d = await getDeepSignal(symbol, market, deps, {}).catch(() => null);
        if (!d?.ok) return { error: `No data for ${symbol} — check the symbol (BTC/ETH/SOL...) or the feed is down.` };
        const s = d.signal || d;
        return {
          symbol, market,
          side: s.side, grade: s.grade, confidence: s.confidence, agreement: s.agreement,
          voters: s.voters ?? s.participating ?? null, totalModels: s.totalModels ?? null,
          ltp: s.ltp, changePct: s.changePct,
          aiScore: s.superIntel?.aiScore ?? null, tier: s.superIntel?.tier ?? null,
          drivers: s.superIntel?.drivers ?? null,
          plan: s.plan ? {
            entry: s.plan.entry, stopLoss: s.plan.stopLoss, target1: s.plan.target1, target2: s.plan.target2,
            riskPct: s.plan.riskPct, rewardRisk: s.plan.rewardRisk, planStyle: s.plan.planStyle,
          } : null,
          quality: s.quality ? { veto: s.quality.veto, mtf: s.quality.mtf, session: s.quality.session, stopStyle: s.quality.stopStyle } : null,
          blueprint: s.superIntel?.blueprint ?? null,
          winProb: s.superIntel?.winProb ?? null,
          perp: s.superIntel?.perp ?? null,
          votes: (s.votes || []).map(v => ({ model: v.name, dir: v.dir > 0 ? 'BULL' : v.dir < 0 ? 'BEAR' : 'NEUTRAL', conf: v.conf, why: (v.reasons || []).slice(0, 2) })),
          aiNote: s.aiNote || null,
        };
      }

      case 'get_wallet': {
        if (!coindcxConnected()) {
          return { connected: false, note: 'CoinDCX API not connected — live wallet unavailable. Practice-context: paper equity default ₹10,000.', usdInr: await fetchUsdInr().catch(() => 84) };
        }
        const w = await walletSnapshot().catch(e => ({ error: String(e?.message || e) }));
        if (w?.error) return { error: w.error };
        // v11.4 recheck: this tool read w.spotINR / w.futuresUSDT /
        // w.marginUsedUSDT — keys walletSnapshot never returns (the real
        // shape is nested: spot.inr{total,free,locked}, futures.usdt{...}).
        // Balances were ALWAYS null even with CoinDCX fully connected.
        return {
          connected: true, equityINR: w.equityINR, usdInr: w.usdInr, fxStale: w.fxStale ?? null,
          spot: {
            balanceINR: w.spot?.inr?.total ?? null,
            freeINR: w.spot?.inr?.free ?? null,
            balanceUSDT: w.spot?.usdt?.total ?? null,
            deployableINR: w.deployableSpotINR ?? null,
          },
          futures: {
            balanceUSDT: w.futures?.usdt?.total ?? null,
            freeUSDT: w.futures?.usdt?.free ?? null,
            marginUsedUSDT: w.futures?.usdt?.locked ?? null,
            deployableUSDT: w.deployableFuturesUSDT ?? null,
            balanceINR: w.futures?.inr?.total ?? null,
            freeINR: w.futures?.inr?.free ?? null,
            marginUsedINR: w.futures?.inr?.locked ?? null,
            deployableINR: w.deployableFuturesINR ?? null,
            deployableCombinedUSDT: w.deployableFuturesCombinedUSDT ?? w.deployableFuturesUSDT ?? null,
            marginCurrency: w.futuresMarginCurrency ?? 'USDT',
          },
          fetchedAt: w.fetchedAt ?? null,
        };
      }

      case 'get_open_positions': {
        const p = await getPositionsWithPnl().catch(() => null);
        if (!p) return { error: 'positions unavailable (CoinDCX API down?)' };
        return {
          count: (p.positions || []).length,
          positions: (p.positions || []).map(x => ({
            pair: x.pair, market: x.market, side: x.side, qty: x.qty ?? null,
            entryPrice: x.entryPrice, lastPrice: x.lastPrice ?? null,
            pnlINR: x.pnlINR ?? null, pnlPct: x.pnlPct ?? null,
            leverage: x.leverage ?? null, marginUSDT: x.marginUSDT ?? null,
            sl: x.sl ?? null, tp2: x.tp2 ?? null, ageMin: x.openedAt ? Math.round((Date.now() - x.openedAt) / 60000) : null,
            source: x.source ?? null, exitStage: x.exitStage ?? null, bookedPnlINR: x.bookedPnlINR ?? null,
          })),
        };
      }

      case 'get_market_regime': {
        const reg = await buildRegime('CRYPTO').catch(() => ({}));
        const sent = sentimentStatus().markets?.CRYPTO || null;
        const btc = reg?.btcChange;
        const label = btc == null ? 'UNKNOWN' : btc > 0.75 ? 'RISK-ON' : btc < -0.75 ? 'RISK-OFF' : 'NEUTRAL';
        return {
          btcChangePct24h: btc ?? null,
          btcTrend: reg?.btcTrend ?? null,
          regime: label,
          fearGreed: sent ? { value: sent.fng, label: sent.fngLabel, compositeScore: sent.score } : 'unreachable',
          fundingBias: sent?.fundingBps8h != null ? `${sent.fundingBps8h} bps/8h ${sent.fundingBps8h > 10 ? '(crowded longs)' : sent.fundingBps8h < -3 ? '(shorts paying — squeeze fuel)' : '(balanced)'}` : 'unreachable',
          note: 'Regime gates every alt call — counter-regime trades need the FULL ticket with extra conviction.',
        };
      }

      case 'get_track_record': {
        const t = trustReport();
        const g = governance();
        return {
          settledSignals: t.settled,
          sufficient: t.sufficient,
          brier: t.brier, brierVerdict: t.brierVerdict,
          overall: t.overall ?? null,
          calibration: (t.calibration || []).map(c => ({ bucket: c.bucket, claimed: c.claimed, actual: c.winRate, n: c.n })),
          monthly: t.monthly ?? [],
          modelGovernance: (g.models || []).slice(0, 8).map(m => ({ model: m.model, n: m.n, hitRate: m.hitRate, verdict: m.verdict })),
          note: t.note,
        };
      }

      case 'calculate_position_size': {
        const entry = parseFloat(args.entry);
        const stopLoss = parseFloat(args.stopLoss);
        if (!(entry > 0) || !(stopLoss > 0) || entry === stopLoss) {
          return { error: 'valid entry and stopLoss required (both > 0, different)' };
        }
        const capital = parseFloat(args.capital) > 0 ? parseFloat(args.capital) : 1000;
        const riskPercent = parseFloat(args.riskPercent) > 0 && parseFloat(args.riskPercent) <= 5 ? parseFloat(args.riskPercent) : 1.5;
        const riskPerUnit = Math.abs(entry - stopLoss);
        const stopDistPct = (riskPerUnit / entry) * 100;
        const riskAmount = (capital * riskPercent) / 100;
        const qty = riskAmount / riskPerUnit;
        const long = stopLoss < entry;
        const t1 = entry + 1 * riskPerUnit * (long ? 1 : -1);
        const t2 = entry + 2 * riskPerUnit * (long ? 1 : -1);
        // ensemble.js's sanity: liquidation must sit OUTSIDE the stop
        const maxLev = maxSaneLeverage(stopDistPct, 10);
        return {
          entry, stopLoss, capital, riskPercent,
          stopDistancePct: r2(stopDistPct),
          riskAmount: r2(riskAmount),
          recommendedQty: Math.round(qty * 1e6) / 1e6,
          capitalDeployed: r2(qty * entry),
          target1_1R: r2(t1), target2_2R: r2(t2),
          maxSaneLeverage: maxLev,
          warning: `Liquidation ${maxLev}x leverage ke andar stop ke BAHAR rehti hai — ${maxLev}x se upar plan fiction hai.`,
          note: `Risk ₹${r2(riskAmount)} (${riskPercent}% of ${capital}) at ${r2(stopDistPct)}% stop distance.`,
        };
      }

      case 'get_agent_status': {
        const cfg = loadAgentConfig();
        const st = await agentStatus(null).catch(() => null);
        if (!st) return { error: 'agent status unavailable' };
        return {
          enabled: cfg.enabled, mode: cfg.mode,
          todayTrades: st.today?.tradesCount ?? 0, maxTrades: st.today?.maxTrades ?? null,
          realizedPnlINR: st.today?.realizedPnlINR ?? null,
          rollingWinRate: st.accuracy?.rollingWinRate ?? null,
          rollingWindow: st.accuracy?.rollingWindow ?? null,
          correlationGuard: st.accuracy?.correlationGuard ?? null,
          dynamicTimeExit: st.accuracy?.dynamicTimeExit ?? null,
          openAgentPositions: (st.openPositions || []).map(p => ({
            pair: p.pair, side: p.side, ageMin: p.ageMin, maxHoldMin: p.maxHoldMin,
            bookedPnlINR: p.bookedPnlINR, exitStage: p.exitStage,
          })),
          blockers: (st.blockers || []).map(b => b.text),
        };
      }

      case 'get_funding_rate': {
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) return { error: 'symbol required (e.g. BTC, SOL)' };
        // CoinDCX publishes no public funding endpoint — Binance fapi's
        // perp premiumIndex is the honest cross-exchange reference.
        try {
          const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}USDT`, {
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) return { error: `funding data unavailable (fapi ${r.status})` };
          const j = await r.json();
          const rate8h = parseFloat(j?.lastFundingRate);
          if (!Number.isFinite(rate8h)) return { error: 'funding data unavailable (no lastFundingRate)' };
          const bps8h = rate8h * 10000;
          const dailyPct = rate8h * 3 * 100; // 3 x 8h settlements/day
          const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
          return {
            symbol, markPrice: j?.markPrice != null ? Number(j.markPrice) : null,
            fundingRate8h: rate8h,
            fundingBps8h: r2(bps8h),
            approxDailyCarryPct: r4(dailyPct),
            interpretation: bps8h > 10
              ? 'crowded longs — LONG side pays the carry, thoda sweat + trend-check before holding longs overnight'
              : bps8h < -3
                ? 'shorts paying — squeeze fuel, short-side carry cost + bounce risk'
                : 'balanced funding — carry is not a factor',
            note: 'Binance fapi reference rate (CoinDCX par no public funding endpoint). Positive = longs pay shorts.',
          };
        } catch (e) {
          return { error: `funding fetch failed: ${e?.message || e}` };
        }
      }

      case 'get_perp_intel': {
        // v12.0: the full derivatives-positioning read for one perp.
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) return { error: 'symbol required (e.g. BTC, SOL, DOGE)' };
        if (!perpIntelEnabled()) return { error: 'perp intel disabled (AI_DISABLE_PERP_INTEL)' };
        const intel = await getPerpIntel(symbol).catch(e => ({ ok: false, reason: String(e?.message || e) }));
        if (!intel?.ok) return { error: `perp intel unavailable: ${intel?.reason || 'network'}` };
        const wire = perpIntelWire(intel) || {};
        return {
          symbol, pair: wire.pair,
          markPrice: wire.markPrice,
          fundingBps8h: wire.fundingBps8h,
          openInterest: wire.openInterest,
          oiValueUSDT: wire.oiValueUSDT,
          oiChangePct24h: wire.oiChangePct24h,
          priceChange24hPct: wire.change24hPct,
          topLongShortRatio: wire.topLongShortRatio,
          takerRatio24h: wire.takerRatio24h,
          positioning: wire.read,
          note: 'Binance fapi public reference (CoinDCX par public positioning endpoint nahi hai). OI↑P↑=new longs · OI↑P↓=new shorts · OI↓P↑=short squeeze · OI↓P↓=long unwind.',
        };
      }

      case 'get_win_probability': {
        // v12.0: the calibrated P(win) answer for one symbol — runs the
        // live single-symbol ensemble (same as analyze_coin) and reads
        // the superIntel winProb block off it.
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) return { error: 'symbol required (e.g. BTC, SOL, ETH)' };
        const market = String(args.market || '').toUpperCase() === 'FUTURES' ? 'FUTURES' : 'CRYPTO';
        const d = await getDeepSignal(symbol, market, deps, {}).catch(() => null);
        if (!d?.ok) return { error: `No data for ${symbol} — feed down ya symbol galat.` };
        const s = d.signal || d;
        const wp = s.superIntel?.winProb ?? null;
        if (!wp) return { error: 'win probability not computed (signal neutral / engine degraded)' };
        return {
          symbol, market, side: s.side, grade: s.grade,
          aiScore: s.superIntel?.aiScore ?? null,
          pWin: wp.pWin, pWinBand: wp.pWinBand, pNeed: wp.pNeed,
          edgePts: wp.edgePts, evR: wp.evR, evRealisticR: wp.evRealisticR,
          verdict: wp.verdict, calibrated: wp.calibrated,
          drivers: wp.drivers, note: wp.note,
          plan: s.plan ? { entry: s.plan.entry, stopLoss: s.plan.stopLoss, target1: s.plan.target1, target2: s.plan.target2, rewardRisk: s.plan.rewardRisk } : null,
        };
      }

      case 'get_risk_status': {
        const rs = getRiskState();
        const cfg = rs.config || {};
        return {
          killSwitch: rs.blocked.killSwitch,
          mode: cfg.mode ?? null,
          allowAuto: cfg.allowAuto ?? null,
          dailyTrades: `${rs.stats.tradesCount}/${cfg.dailyMaxTrades}`,
          dailyLoss: `${rs.blocked.dailyLoss ? 'AT CAP' : 'ok'} (realized today ₹${rs.stats.realizedPnlINR}, cap ₹${cfg.dailyMaxLossINR})`,
          openPositions: `${rs.openPositions}/${cfg.maxOpenPositions || 5}`,
          connected: rs.blocked.notConnected ? 'NO (CoinDCX API not connected — paper context only)' : 'yes',
          blockers: Object.entries(rs.blocked).filter(([, v]) => v).map(([k]) => ({
            killSwitch: '🛑 Kill switch ON — execution disabled (Risk settings)',
            dailyTrades: `📊 Daily trade cap hit (${rs.stats.tradesCount}/${cfg.dailyMaxTrades})`,
            dailyLoss: `📉 Daily loss cap hit (₹${rs.stats.realizedPnlINR} realized today)`,
            notConnected: '🔌 CoinDCX API not connected',
            maxOpenPositions: '🎯 Max simultaneous open positions reached',
          }[k] || k)),
          verdict: Object.values(rs.blocked).some(Boolean)
            ? 'BLOCKED — pehle yeh blockers resolve karo (kill-switch off / caps reset kal / connect API)'
            : 'CLEAR — execution guards pass, discipline ke saath trade karo',
        };
      }

      case 'get_pnl': {
        const period = String(args.period || 'today').trim().toLowerCase();
        const j = loadJournal();
        const now = Date.now();
        const daysBack = period === '7d' ? 7 : period === '30d' ? 30 : period === 'all' ? 3650 : 1;
        const since = now - daysBack * 24 * 3600_000;
        // realized = booked CLOSE + PARTIAL_TP legs (NOTIFIED/REJECTED never count)
        const closed = (j.entries || []).filter(e =>
          (e.kind === 'CLOSE' || e.kind === 'PARTIAL_TP')
          && (e.ts || 0) >= since && (period === 'today' ? e.day === todayIST() : true));
        const realized = closed.reduce((a, e) => a + (e.pnlINR || 0), 0);
        const wins = closed.filter(e => (e.pnlINR || 0) > 0).length;
        const losses = closed.filter(e => (e.pnlINR || 0) < 0).length;
        // live unrealized across open positions
        const p = await getPositionsWithPnl().catch(() => null);
        const positions = p?.positions || [];
        const unrealizedINR = positions.reduce((a, x) => a + (x.pnlINR || 0), 0);
        return {
          period,
          realizedPnlINR: r2(realized),
          closedLegs: closed.length, wins, losses,
          winRate: closed.length ? r2((wins / closed.length) * 100) : null,
          unrealizedPnlINR: r2(unrealizedINR),
          openPositions: positions.length,
          openDetail: positions.map(x => ({
            pair: x.pair, market: x.market, side: x.side,
            pnlINR: x.pnlINR ?? null, pnlPct: x.pnlPct ?? null,
            bookedPnlINR: x.bookedPnlINR ?? null, exitStage: x.exitStage ?? null,
          })),
          totalPnlINR: r2(realized + unrealizedINR),
          note: period === 'today'
            ? 'Realized = booked CLOSE/PARTIAL_TP legs today (IST); unrealized = live open positions.'
            : `Realized over the last ${period === 'all' ? 'all-time' : daysBack + ' days'}; unrealized = live open positions.`,
        };
      }

      case 'backtest_custom_strategy': {
        // v10.8 PRO #2: NL → bounded rules → walk-forward replay
        const { runCustomStrategyBacktest } = await import('./strategyLab.js');
        const description = String(args.description || '').trim();
        if (description.length < 8) return { error: 'description too short — batao entry/exit idea kya hai' };
        const market = String(args.market || '').toUpperCase() === 'INDIA' ? 'INDIA' : 'CRYPTO';
        const symbols = Array.isArray(args.symbols)
          ? args.symbols.map(s => String(s).toUpperCase().replace(/[^A-Z0-9-]/g, '')).filter(Boolean).slice(0, 6)
          : undefined;
        const out = await runCustomStrategyBacktest({ description, market, symbols, deps }).catch(e => ({ ok: false, error: String(e?.message || e) }));
        if (!out?.ok && out?.stage === 'compile') return { error: `strategy compile failed: ${out.error}` };
        if (!out?.ok) return { error: out?.error || 'strategy lab run failed — historical data unavailable, retry in a minute' };
        return {
          strategyName: out.rules?.name ?? 'custom strategy',
          market: out.market,
          rules: out.rules,
          symbolsTested: out.scannedSymbols,
          stats: out.stats,
          exitDist: out.exitDist,
          perSymbol: (out.perSymbol || []).map(p => ({ symbol: p.symbol, ok: p.ok, trades: p.stats?.trades ?? 0, winRate: p.stats?.winRate ?? null, avgR: p.stats?.avgR ?? null })),
          recentTrades: (out.trades || []).slice(0, 8).map(t => ({ symbol: t.symbol, side: t.side, r: t.r, reason: t.reason, holdBars: t.holdBars })),
          disclaimer: out.disclaimer,
        };
      }

      // accuracy-plan Phase 3.3: the parity news tool — same Tavily
      // search the intraday agent has (crypto flavor of the query).
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
            query: `${query} crypto market latest`,
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

      // v13.1 SVA-v1 — the SIGNAL VERIFICATION AGENT tool: the live
      // deep signal for the symbol goes through the 10-point pro
      // checklist and the FINAL call (CONFIRM/CAUTION/FLIP/STAND_ASIDE)
      // comes back with the full audit trail. "XRP long ya short?"
      // gets a deterministic, auditable answer — not an LLM vibe.
      case 'verify_signal': {
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) return { error: 'symbol required (e.g. XRP, BTC)' };
        const market = String(args.market || 'FUTURES').toUpperCase() === 'SPOT' ? 'CRYPTO' : 'FUTURES';
        const d = await getDeepSignal(symbol, market, deps, {}).catch(() => null);
        if (!d?.ok || !d.signal) return { error: `No live signal for ${symbol} (feed down ya symbol galat) — thodi der baad try karo.` };
        const s = d.signal;
        // deep path already stamps built.verify — recompute only when
        // an older board-shaped payload slipped through (belt+suspenders).
        const v = s.verify?.agent === 'SVA-v1' ? s.verify : verifySignal(s);
        // v20.9.2 UCV-A1 — the realtime ultrafast chart verdict rides the
        // deep path (full 9-check micro-structure analysis). The agent
        // answer to "ye LONG pakka long jayega?" cites BOTH layers.
        const uc = s.ultrafast?.agent === 'UCV-A1' ? s.ultrafast : null;
        return {
          symbol, market,
          signalSays: { side: s.side, grade: s.grade, confidence: s.confidence, aiScore: s.superIntel?.aiScore ?? null },
          ULTRAFAST_CHART_VERDICT: uc ? {
            verdict: uc.verdict,            // ← CONFIRMED | PENDING | REJECTED (the "pakka" answer)
            microDirection: uc.microDirection, // the realtime 1m chart's OWN direction
            score: uc.score,                // |micro| 0-100 — how hard the tape moves
            answer: uc.answer,
            detail: uc.detail || null,
            checks: uc.checks || null,
          } : null,
          VERIFIER_VERDICT: {
            finalCall: v.finalCall,          // ← THE answer: LONG / SHORT / NO_TRADE
            action: v.action,                // CONFIRM | CAUTION | FLIP | STAND_ASIDE
            score: v.score, flipScore: v.flipScore ?? null, proVeto: v.veto,
            sizeHint: v.sizeHint === 1 ? 'full risk' : v.sizeHint === 0.5 ? 'half risk' : 'NO entry',
            verdict: v.verdict, proNote: v.proNote,
          },
          checklist: v.checklist,
          ltp: s.ltp,
          plan: s.plan ? { entry: s.plan.entry, stopLoss: s.plan.stopLoss, target1: s.plan.target1, target2: s.plan.target2, rewardRisk: s.plan.rewardRisk } : null,
          note: 'SVA-v1 pro checklist + UCV-A1 realtime ultrafast chart verdict — deterministic layers over the 14-model ensemble. Verdicts ko cite karo; LLM apni marzi se FLIP/CONFIRM override mat karo (agar manna ho to verifier ka verdict bhi bolo). ULTRAFAST REJECTED ho to direction ULTA ja sakti hai — trade avoid bolo.',
        };
      }

      case 'get_model_consensus': {
        const symbol = String(args.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol) return { error: 'symbol required (e.g. XRP, BTC)' };
        const market = String(args.market || 'FUTURES').toUpperCase() === 'SPOT' ? 'CRYPTO' : 'FUTURES';
        const d = await getDeepSignal(symbol, market, deps, {}).catch(() => null);
        if (!d?.ok || !d.signal) return { error: `No live ensemble run for ${symbol} (feed down ya symbol galat).` };
        const s = d.signal;
        const votes = Array.isArray(s.votes) ? s.votes : [];
        const bull = votes.filter(v => v.dir > 0);
        const bear = votes.filter(v => v.dir < 0);
        const flat = votes.filter(v => v.dir === 0);
        return {
          symbol, market,
          consensus: {
            side: s.side, grade: s.grade, confidence: s.confidence,
            agreement: s.agreement, voters: s.voters ?? votes.filter(v => v.dir !== 0).length,
            totalSeats: s.totalModels ?? votes.length,
            weighted: s.aiNote?.note ?? null,
          },
          tally: { bull: bull.length, bear: bear.length, abstain: flat.length },
          perModel: votes.map(v => ({
            model: v.name || v.id, dir: v.dir > 0 ? 'BULL' : v.dir < 0 ? 'BEAR' : 'ABSTAIN',
            conf: v.conf, weight: v.weight,
            reason: Array.isArray(v.reasons) ? v.reasons[0] : (v.reason || null),
          })),
          metaEnsemble: s.meta ?? null,
          verifier: s.verify ? { finalCall: s.verify.finalCall, action: s.verify.action, score: s.verify.score } : null,
          llmSecondOpinion: s.verify?.llm ?? null,
          note: 'Vote breakdown from the live deep ensemble run. Weighted consensus ≠ raw tally — model weights + regime tilt + quorum caps shape the final side. Verdicts cite karke explain karo.',
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
// 4. AGENTIC LOOP — Gemini → Groq → Cerebras (intraday pattern)
// ------------------------------------------------------------
async function runGeminiAgent({ systemPrompt, messages, deps, toolTrace }) {
  const { KEYS } = deps;
  if (!KEYS?.gemini) return null;
  const models = ['gemini-3.5-flash', 'gemini-2.5-flash'];
  let lastErr = null;
  for (const model of models) {
    try {
      return await _runGeminiLoop(model, { systemPrompt, messages, deps, toolTrace });
    } catch (e) {
      lastErr = e;
      if (!/\b(404|400)\b/.test(String(e?.message))) break;
    }
  }
  throw lastErr || new Error('gemini failed');
}

async function _runGeminiLoop(model, { systemPrompt, messages, deps, toolTrace }) {
  const { KEYS } = deps;
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));

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

    const parts = data.candidates?.[0]?.content?.parts || [];
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    if (fnCalls.length === 0) break;

    contents.push({ role: 'model', parts: parts.map(p => p.functionCall ? { functionCall: p.functionCall } : { text: p.text }).filter(p => p.functionCall || p.text) });
    const responseParts = [];
    for (const fn of fnCalls) {
      toolTrace.push({ tool: fn.name, ts: Date.now() });
      const result = await executeCryptoTool(fn.name, fn.args || {}, deps);
      responseParts.push({ functionResponse: { name: fn.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
    payload.contents = contents.map(c => ({ ...c, parts: [...c.parts] }));
  }

  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n').trim();
  if (!text) throw new Error('gemini empty response');
  return { text, engine: model };
}

async function runOpenAICompatAgent({ systemPrompt, messages, deps, toolTrace, provider, cfgOverride = null }) {
  const { KEYS, OPENAI_COMPAT } = deps;
  // v18.7: cfgOverride lets the keyless LOCAL ollama engine ride the
  // exact same loop (its cfg is not in OPENAI_COMPAT; auth is inert).
  const cfg = cfgOverride || OPENAI_COMPAT?.[provider];
  if (!cfg || !KEYS?.[provider]) return null;
  const modelChain = provider === 'groq' ? [cfg.defModel, 'llama-3.3-70b-versatile'] : [cfg.defModel];
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
    ...messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: String(m.content || '') })),
  ];

  let data = null;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const body = { model, messages: reqMessages, temperature: 0.4, max_completion_tokens: 4000 };
    // v11.4 recheck: tools were sent on round 0 ONLY — after the first tool
    // call the request carried role:'tool' messages with NO tools declaration,
    // so the model could never emit another tool call (and several OpenAI-
    // compat providers 400 on tool-messages without tools). The documented
    // "up to 6 tool rounds" was impossible on the Groq/Cerebras chain.
    body.tools = CRYPTO_AGENT_TOOLS;

    // v18.8: provider-aware round budget — the local ollama engine on a
    // CPU-only box can take 30-90s per tool round (the old shared 30s
    // bound made a WORKING local engine time out every round). Cloud
    // engines keep the tight 30s.
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
    for (const tc of toolCalls) {
      let parsed = {};
      try { parsed = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep {} */ }
      toolTrace.push({ tool: tc.function?.name, ts: Date.now() });
      const result = await withMcpAudit('crypto', tc.function?.name, parsed, () => executeCryptoTool(tc.function?.name, parsed, deps));
      reqMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: JSON.stringify(result) });
    }
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${provider} empty response`);
  return { text, engine: `${provider}:${model}` };
}

// ------------------------------------------------------------
// 5. PUBLIC ENTRY — runCryptoAgent(messages, deps)
// ------------------------------------------------------------
export async function runCryptoAgent(messages, deps) {
  const d = deps || {};
  // Live desk context for the system prompt (all best-effort — a dead
  // feed must never block the chat, it just shows as UNKNOWN).
  const [reg, sent] = await Promise.all([
    buildRegime('CRYPTO').catch(() => ({})),
    Promise.resolve(sentimentStatus().markets?.CRYPTO || null),
  ]);
  const now = new Date();
  const ctx = {
    utcTime: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`,
    btcRegime: reg?.btcChange != null ? `BTC ${reg.btcChange > 0 ? '+' : ''}${reg.btcChange}% 24h (${reg.btcChange > 0.75 ? 'RISK-ON' : reg.btcChange < -0.75 ? 'RISK-OFF' : 'NEUTRAL'})` : 'UNKNOWN',
    fng: sent?.fng != null ? `Fear&Greed ${sent.fng} (${sent.fngLabel || '?'})` : 'unreachable',
    funding: sent?.fundingBps8h != null ? `${sent.fundingBps8h} bps/8h` : 'unreachable',
    connected: coindcxConnected(),
    // v18.7: EVERY configured cloud engine counts (was gemini/groq/
    // cerebras only — a saved openrouter key still showed offline).
    aiOnline: !!(d.KEYS?.gemini || d.KEYS?.groq || d.KEYS?.cerebras || d.KEYS?.openrouter || d.KEYS?.huggingface || d.KEYS?.nvidia),
  };

  // v10.8 PRO #3: persistent memory — recent turns + recurring focus
  // feed the system prompt (null on a fresh install = zero bloat).
  const memBlock = memoryContextFor('crypto');
  const systemPrompt = buildCryptoSystemPrompt(ctx) + (memBlock ? `\n\nDESK MEMORY — past conversations with this user:\n${memBlock}` : '');
  const toolTrace = [];

  // v18.7 ENGINE SENTINEL CHAIN — three upgrades over the old fixed
  // Gemini→Groq→Cerebras ladder:
  //   1. EXTENDED  — openrouter / huggingface / nvidia ride after
  //      cerebras (any saved key = another live engine).
  //   2. HEALTH-AWARE — providers in cooldown are skipped FAST (no
  //      repeated 30s hangs on every chat while an engine is down);
  //      cooldown expiry auto-retries it (half-open) — engines come
  //      back WITHOUT a restart.
  //   3. LOCAL — a keyless Ollama install (127.0.0.1:11434) joins the
  //      chain as the last engine, so the desk keeps LLM prose even
  //      with every cloud provider down.
  const cloudProviders = ['groq', 'cerebras', 'openrouter', 'huggingface', 'nvidia'];
  const steps = [];
  if (d.KEYS?.gemini) steps.push({ provider: 'gemini', run: () => runGeminiAgent({ systemPrompt, messages, deps: d, toolTrace }) });
  for (const p of cloudProviders) {
    if (d.KEYS?.[p] && d.OPENAI_COMPAT?.[p]) steps.push({ provider: p, run: () => runOpenAICompatAgent({ systemPrompt, messages, deps: d, toolTrace, provider: p }) });
  }
  if (await ollamaProbe().catch(() => false)) {
    steps.push({
      provider: 'ollama',
      run: () => runOpenAICompatAgent({ systemPrompt, messages, deps: { ...d, KEYS: { ...d.KEYS, ollama: 'local' } }, toolTrace, provider: 'ollama', cfgOverride: ollamaCompatCfg() }),
    });
  }
  const chain = steps.filter(s => !engineSkip(s.provider));

  const errors = [];
  for (const step of chain) {
    try {
      const result = await step.run();
      if (result) {
        engineOk(step.provider);
        // v10.8 PRO #3: record the answered turn — next session's prompt
        // carries this continuity (best-effort, never blocks the reply).
        const lastUser = [...(messages || [])].reverse().find(m => m?.role === 'user')?.content || '';
        rememberChat('crypto', { q: lastUser, a: result.text });
        return {
          ok: true,
          text: result.text,
          engine: result.engine,
          toolsUsed: [...new Set(toolTrace.map(t => t.tool))],
          toolCalls: toolTrace.length,
          session: ctx,
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
  // but the question is still actionable from pure tool compute
  // (analyze_coin / signals / sizing / funding need NO LLM). The user
  // gets the exact-number FULL TICKET instead of "engines unavailable"
  // — the fix behind the SOL "[object Object]" report.
  const det = await buildDeterministicCryptoAnswer(
    messages, deps, executeCryptoTool, toolTrace,
  ).catch(() => null);
  if (det?.text) {
    const lastUser = [...(messages || [])].reverse().find(m => m?.role === 'user')?.content || '';
    rememberChat('crypto', { q: lastUser, a: det.text });
    // v18.7: the deterministic answer now carries WHY the engines are
    // offline + what fixes it (add key / RECHECK) — the status line is
    // honest per-engine, never guesses.
    const engineNote = `\n\n🔌 ENGINE STATUS — ${engineStatusLine(d.KEYS)}`;
    return {
      ok: true,
      text: det.text + engineNote,
      engine: 'super-intel-deterministic',
      toolsUsed: [...new Set(toolTrace.map(t => t.tool))],
      toolCalls: toolTrace.length,
      session: ctx,
      degraded: true,
    };
  }

  return {
    ok: false,
    error: `Agent engines unavailable: ${errors.join(' | ') || 'no AI keys configured'} — deterministic desk answers abhi bhi available hain: coin deep-dive ("SOL ka deep analysis"), desk briefing, wallet, P&L, risk status poocho.`,
    toolsUsed: [...new Set(toolTrace.map(t => t.tool))],
    session: ctx,
  };
}

// test hooks
export const __internals = { executeCryptoTool, buildCryptoSystemPrompt, fullTicketRules };
